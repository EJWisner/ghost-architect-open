/**
 * Ghost Architect™ — Phase 5: Fix Forecast Artifact Writer
 *
 * Orchestrates the corrected-file generation and paired artifact writing
 * when a developer selects a finding for fix forecasting (Phase 4).
 *
 * Produces two paired artifacts, both keyed by finding id slug:
 *   ghost-fix-<slug>.txt          — human-readable fix suggestion + diff
 *   ghost-forecast-<slug>.*       — Conflict forecast of the corrected file
 *
 * ANALYSIS MODE: Conflict only on the corrected file. Blast on a single-line
 * change produces noise. TODO: consider Blast+Conflict as a configurable
 * option after we have real usage data.
 *
 * SCOPE BOUNDARIES:
 *   - Never writes to the user's codebase. Corrected content is in-memory
 *     and in a temp dir only, cleaned up in finally.
 *   - Failed-confidence path writes the fix artifact but skips the forecast.
 *   - No LLM calls in this file — LLM work is delegated to runConflictScan.
 */

import fs   from 'fs';
import os   from 'os';
import path from 'path';
import chalk from 'chalk';

import { generateCorrectedFile }  from '../utils/corrected-file-generator.js';
import { computeUnifiedDiff }     from '../utils/diff-renderer.js';
import { runConflictScan }        from '../core/conflict.js';
import { buildForecastOverlay }   from '../core/forecast-overlay.js';
import { saveReport }             from '../reports.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const REPORTS_DIR = path.join(os.homedir(), 'Ghost Architect Reports');

function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
  return REPORTS_DIR;
}

// Sanitize a finding id for use in a filename.
// "MEDIUM:CreateOrderApi.php:type-mismatch-order"
//   → "medium-createorderapi-php-type-mismatch-order"
function idToSlug(id) {
  return (id || 'unknown')
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

// Severity display line (plain text, no chalk — for the artifact file).
function severityDisplay(sev) {
  return (sev || 'UNKNOWN').toUpperCase();
}

const DIVIDER = '═'.repeat(59);
const RULE    = '─'.repeat(59);

// ── Fix artifact content builder ──────────────────────────────────────────────

function buildFixArtifact(finding, generateResult, generatedAt) {
  const { fix_direction, title, severity, id } = finding;
  const { correctedContent, confidence, notes } = generateResult;
  const targetFile = fix_direction.target_file;

  const lines = [
    'Ghost Architect™ — Suggested Fix',
    DIVIDER,
    '',
    `Finding:    ${id}`,
    `Title:      ${title}`,
    `Severity:   ${severityDisplay(severity)}`,
    `File:       ${targetFile}`,
    `Generated:  ${generatedAt}`,
    `Confidence: ${confidence}`,
    '',
    RULE,
    'WHY THIS FIX',
    RULE,
    '',
    fix_direction.reasoning || '(No reasoning provided.)',
    '',
  ];

  if (confidence === 'failed') {
    lines.push(
      RULE,
      'PROPOSED CHANGE  [confidence: failed — insertion point not located]',
      RULE,
      '',
      'Ghost could not locate a single insertion point in the baseline file.',
      'The fix direction is shown as-is. Apply it manually using this as a guide.',
      '',
      fix_direction.patch_instruction
        .split('\n')
        .map(l => `  ${l}`)
        .join('\n'),
      '',
    );
    if (notes) {
      lines.push(`Note: ${notes}`, '');
    }
  } else {
    // Compute unified diff between the baseline and corrected content.
    // baselineContent is the original fileMap entry (passed in via finding metadata).
    // correctedContent comes from generateCorrectedFile.
    const diffText = generateResult.unifiedDiff || '';
    lines.push(
      RULE,
      `PROPOSED CHANGE  [confidence: ${confidence}]`,
      RULE,
      '',
    );
    if (notes) {
      lines.push(`⚠  ${notes}`, '');
    }
    if (diffText) {
      lines.push(diffText);
    } else {
      lines.push(
        '(No diff could be generated — corrected content matches baseline.)',
        '',
      );
    }
  }

  lines.push(
    RULE,
    '',
    'Ghost flagged this. You decide whether to ship it.',
    '',
    DIVIDER,
  );

  return lines.join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate paired fix artifacts for a selected finding.
 *
 * @param {object} selectedFinding  Full normalized finding with fix_direction.
 * @param {object} codebaseContext  The scanned codebase context (fileMap, basePath).
 * @param {object} opts             { tier, profile, label }
 * @returns {{ fixArtifactPath: string, forecastArtifactPaths: object|null } | null}
 */
export async function runFixForecast(selectedFinding, codebaseContext, opts = {}) {
  const { tier = 'open', profile = null } = opts;
  const { fix_direction, title, id } = selectedFinding;
  const targetFile = fix_direction.target_file;
  const slug = idToSlug(id);

  console.log(chalk.cyan(`\n  Generating corrected file for: ${title}`));

  // ── Step 1: Find baseline content in fileMap ────────────────────────────────
  const fileMap = codebaseContext.fileMap || {};
  const baselineRoot = codebaseContext.basePath || '';

  // Match target_file against fileMap keys (absolute paths).
  // Strategy: find the key that ends with the target_file relative path.
  const normalizedTarget = targetFile.split(/[\\/]/).join('/');
  const baselineKey = Object.keys(fileMap).find(k => {
    const rel = path.relative(baselineRoot, k).split(path.sep).join('/');
    return rel === normalizedTarget || k.split(/[\\/]/).join('/').endsWith('/' + normalizedTarget);
  });

  if (!baselineKey) {
    console.log(chalk.yellow(
      `  ⚠  Target file not found in scanned codebase: ${targetFile}\n` +
      `     Fix artifact skipped.`
    ));
    return null;
  }

  const baselineContent = fileMap[baselineKey];

  // ── Step 2: Generate corrected file content ────────────────────────────────
  const generateResult = generateCorrectedFile(baselineContent, fix_direction);

  // Attach unified diff to result if confidence isn't failed.
  if (generateResult.confidence !== 'failed') {
    const diffText = computeUnifiedDiff(
      baselineContent,
      generateResult.correctedContent,
      targetFile,
      targetFile
    );
    generateResult.unifiedDiff = diffText;
  }

  // ── Step 3: Write the fix artifact ────────────────────────────────────────
  const dir = ensureReportsDir();
  const fixFilename = `ghost-fix-${slug}.txt`;
  const fixPath = path.join(dir, fixFilename);
  const generatedAt = new Date().toISOString();

  try {
    const content = buildFixArtifact(selectedFinding, generateResult, generatedAt);
    fs.writeFileSync(fixPath, content, 'utf8');
    console.log(chalk.green(`  ✓ Fix suggestion written:`));
    console.log(chalk.gray(`    📄 ~/Ghost Architect Reports/${fixFilename}`));
  } catch (err) {
    console.log(chalk.yellow(`  ⚠  Failed to write fix artifact: ${err.message}`));
    return null;
  }

  // ── Step 4: Failed-confidence → skip forecast ──────────────────────────────
  if (generateResult.confidence === 'failed') {
    console.log(chalk.yellow(
      `  ⚠  Forecast skipped — Ghost could not generate a corrected file\n` +
      `     with sufficient confidence. See fix artifact for manual guidance.`
    ));
    return { fixArtifactPath: fixPath, forecastArtifactPaths: null };
  }

  // ── Steps 5-7: Write corrected file to temp dir, run forecast, clean up ────
  console.log(chalk.gray(`  Running impact forecast on corrected file...`));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-fix-forecast-'));
  let forecastArtifactPaths = null;

  try {
    // Write corrected file into temp dir at the relative path.
    const destPath = path.join(tmpDir, normalizedTarget.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, generateResult.correctedContent, 'utf8');

    // Build forecast overlay.
    let patchedContext, changedFiles;
    try {
      ({ patchedContext, changedFiles } = await buildForecastOverlay(
        codebaseContext,
        tmpDir,
        { tier, profile }
      ));
    } catch (err) {
      console.log(chalk.yellow(`  ⚠  Forecast overlay failed: ${err.message}`));
      console.log(chalk.gray(`     Fix artifact was written: ~/Ghost Architect Reports/${fixFilename}`));
      return { fixArtifactPath: fixPath, forecastArtifactPaths: null };
    }

    const hasChanges = Object.keys(changedFiles.modified).length + changedFiles.added.length > 0;
    if (!hasChanges) {
      console.log(chalk.yellow(
        `  ⚠  Forecast skipped — corrected file matches baseline (no effective change detected).`
      ));
      return { fixArtifactPath: fixPath, forecastArtifactPaths: null };
    }

    // Run Conflict scan on the corrected-file overlay.
    // Conflict only — Blast on a single-line change produces noise.
    // TODO: expose Blast+Conflict as a configurable option after real usage data.
    const fileMapPatched = patchedContext.fileMap || {};
    let conflictBuffer = '';

    const callbacks = {
      async onVerifyPrompt() { return 'skip'; },  // non-interactive — skip verification
      async onSessionPrompt() { return 'report'; },
      onEvent() {},
    };

    try {
      const result = await runConflictScan(fileMapPatched, callbacks, {
        tier,
        profile,
        forecastContext:
          `This is a fix-forecast run. The corrected version of ${targetFile} ` +
          `has been overlaid on the baseline. Frame every conflict as ` +
          `"if you apply this fix, X conflicts with Y."`,
      });

      if (result?.finalReport) {
        conflictBuffer = result.finalReport;
      }
    } catch (err) {
      console.log(chalk.yellow(`  ⚠  Conflict scan failed: ${err.message}`));
      console.log(chalk.gray(`     Fix artifact was written: ~/Ghost Architect Reports/${fixFilename}`));
      return { fixArtifactPath: fixPath, forecastArtifactPaths: null };
    }

    if (!conflictBuffer) {
      console.log(chalk.gray(`  No conflicts detected in corrected file.`));
      return { fixArtifactPath: fixPath, forecastArtifactPaths: null };
    }

    // Save forecast artifacts using existing saveReport pipeline.
    const forecastMeta = {
      filesAnalyzed: `${patchedContext.loadedFiles} of ${patchedContext.totalFiles}`,
      totalFiles:    patchedContext.totalFiles,
      mode:          'fix-forecast',
      profile,
      fixForecast:   true,
      findingId:     id,
      findingTitle:  title,
      targetFile,
    };

    try {
      const saved = await saveReport(conflictBuffer, 'ghost-forecast', slug, forecastMeta);
      forecastArtifactPaths = saved;
      console.log(chalk.green(`  ✓ Forecast written:`));
      console.log(chalk.gray(`    📄 ~/Ghost Architect Reports/${path.basename(saved.txtFile)}`));
      console.log(chalk.gray(`    📋 ~/Ghost Architect Reports/${path.basename(saved.mdFile)}`));
      if (saved.pdfFile) console.log(chalk.gray(`    📑 ~/Ghost Architect Reports/${path.basename(saved.pdfFile)}`));
      if (saved.findingsFile) console.log(chalk.gray(`    🗂  ~/Ghost Architect Reports/${path.basename(saved.findingsFile)}`));
    } catch (err) {
      console.log(chalk.yellow(`  ⚠  Failed to save forecast artifacts: ${err.message}`));
    }

  } finally {
    // Always clean up temp dir — even if forecast pipeline threw.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Non-fatal — temp dir cleanup failure is cosmetic.
    }
  }

  return { fixArtifactPath: fixPath, forecastArtifactPaths };
}
