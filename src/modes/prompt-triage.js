/**
 * src/modes/prompt-triage.js
 *
 * Prompt Triage mode entry point. Loads a folder of prompts, runs the
 * full prompt-pack against each one, renders a markdown report, prints
 * a summary to the terminal, and saves the report to disk.
 *
 * This mode is structurally simpler than POI/Blast/Conflict. There is
 * no agent loop, no narrator/verifier, no multipass, no checkpoint
 * resume. Each prompt is independent; the prompt-pack runs in-process
 * with no LLM streaming. (Tier 2 detectors will call Claude, but per
 * detector, not per scan.)
 *
 * Public entry point: runPromptTriageMode(options).
 *
 * Options:
 *   - source:        { kind: 'localFolder', path: string }  (required)
 *   - reportsDir:    where to save the report markdown (defaults to
 *                    ~/Ghost Architect Reports/prompt-triage/)
 *   - targetModel:   model registry ID (see src/prompt-pack/models.js).
 *                    When provided, length-aware detectors use the
 *                    correct tokenizer; otherwise the heuristic is used.
 *   - tier:          'open' | 'pro' | 'team' | 'enterprise'. Controls
 *                    feature gating. Project Intelligence (label prompt,
 *                    baseline tracking, comparison, velocity) is Pro+
 *                    only. When tier is 'open' or unset, the project
 *                    label prompt is skipped and no project history is
 *                    written. The bin/ghost.js for each branch is the
 *                    single source of truth for TIER and passes it
 *                    through. Defaults to 'open' (most conservative —
 *                    fail-closed for Project Intelligence) so that any
 *                    caller that forgets to pass tier does not leak
 *                    a paid feature.
 *   - onProgress:    optional callback (file, idx, total) => void
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';

import { loadPromptSource } from '../prompt-pack/loader.js';
import { runAll, listDetectors } from '../prompt-pack/index.js';
import { renderReport } from '../prompt-pack/report.js';
import { getModel } from '../prompt-pack/models.js';
import { resetSessionUsage, getSessionUsage } from '../prompt-pack/llmAuditClient.js';
import { promptProjectLabel, handleProjectIntelligence } from '../projects.js';
import { isPortalConfigured, publishToPortal } from '../core/portal-publish.js';
import {
  estimateMultiCallCost,
  formatCost,
  formatCostRange,
  calcActualCost,
} from '../core/estimator.js';

function defaultReportsDir() {
  return path.join(os.homedir(), 'Ghost Architect Reports', 'prompt-triage');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function timestampSlug() {
  // YYYYMMDD-HHMMSS, local time, no separators that break filenames.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
    + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function severityEmoji(s) {
  switch (s) {
    case 'CRITICAL': return '🔴';
    case 'HIGH':     return '🟠';
    case 'MEDIUM':   return '🟡';
    case 'LOW':      return '🔵';
    default:         return '⚪';
  }
}

/**
 * Run the prompt-triage scan end-to-end.
 *
 * @param {Object} options
 * @returns {Promise<{ reportPath: string, totalFindings: number, scannedCount: number }>}
 */
export async function runPromptTriageMode(options = {}) {
  const source = options.source;
  if (!source) {
    throw new Error('runPromptTriageMode: options.source is required');
  }

  const reportsDir = options.reportsDir || defaultReportsDir();
  const targetModel = options.targetModel || null;
  const targetModelEntry = targetModel ? getModel(targetModel) : null;
  // Feature gating. Project Intelligence is Pro+ only. We default to 'open'
  // (fail-closed) so any caller that forgets to pass tier does not leak the
  // paid feature. The bin/ghost.js for each branch is the source of truth.
  const tier = options.tier || 'open';
  const projectIntelEnabled = tier !== 'open';

  // ── Banner ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold('Prompt Triage'));
  console.log(chalk.gray('Auditing prompts for defects (Tian et al. 2025 taxonomy).'));
  if (targetModelEntry) {
    console.log(chalk.gray('Target model: ' + targetModelEntry.displayName
      + ' (' + targetModelEntry.contextWindow.toLocaleString() + ' token window)'));
  } else if (targetModel) {
    console.log(chalk.yellow('⚠  Unknown target model "' + targetModel + '"; using heuristic token counts.'));
  } else {
    console.log(chalk.gray('Target model: (none specified, using heuristic token counts)'));
  }
  console.log('');

  // ── Load ────────────────────────────────────────────────────────────────
  const detectors = listDetectors();
  console.log(chalk.gray('Loading prompts from: ' + (source.path || source.kind)));
  let loaded;
  try {
    loaded = await loadPromptSource(source);
  } catch (err) {
    console.log(chalk.red('  ✗ Could not load prompt source: ' + err.message));
    throw err;
  }

  if (loaded.files.length === 0) {
    console.log(chalk.yellow('  ⚠ No prompt files found in this folder.'));
    console.log(chalk.gray('    Looking for: .md, .markdown, .txt, .yaml, .yml, .json'));
    console.log(chalk.gray('    Folder: ' + loaded.sourceLabel));
    return { reportPath: null, totalFindings: 0, scannedCount: 0 };
  }

  console.log(chalk.gray('  Found ' + loaded.files.length + ' prompt file'
    + (loaded.files.length === 1 ? '' : 's')
    + (loaded.stats.skipped > 0
        ? ' (' + loaded.stats.skipped + ' skipped: too large or unreadable)'
        : '')));
  console.log(chalk.gray('  Running ' + detectors.length + ' detector'
    + (detectors.length === 1 ? '' : 's')
    + ': ' + detectors.map(d => d.id).join(', ')));

  // If any registered detectors require a target model and none was
  // specified, surface a one-line note so the absence of those
  // findings is explained rather than invisible.
  if (!targetModel) {
    const requiresModel = detectors.filter(d => d.requiresTargetModel);
    if (requiresModel.length > 0) {
      console.log(chalk.gray('  Note: ' + requiresModel.length
        + ' detector' + (requiresModel.length === 1 ? '' : 's')
        + ' require a target model and will not run ('
        + requiresModel.map(d => d.id).join(', ') + ')'));
    }
  }
  console.log('');

  // ── Cost pre-flight ────────────────────────────────────
  // Tier 2 detectors send the prompt to the target model. When a target
  // model is set, estimate the cost band and ask the user to confirm
  // before any LLM calls fire. Without a target model, only Tier 1
  // detectors run — those use the free Anthropic countTokens endpoint or
  // pure regex, no charges.
  if (targetModel) {
    const tier2Count = detectors.filter(d => d.tier === 2).length;
    const numCalls = tier2Count * loaded.files.length;
    if (numCalls > 0) {
      const estimate = estimateMultiCallCost({ model: targetModel, numCalls });
      console.log(chalk.bold('Cost estimate'));
      console.log(chalk.gray('  ' + numCalls + ' LLM call' + (numCalls === 1 ? '' : 's')
        + ' against ' + estimate.modelLabel
        + ' (' + tier2Count + ' Tier 2 detector' + (tier2Count === 1 ? '' : 's')
        + ' × ' + loaded.files.length + ' prompt' + (loaded.files.length === 1 ? '' : 's') + ')'));
      console.log(chalk.gray('  Estimated cost: ')
        + chalk.bold(formatCostRange(estimate.low, estimate.high))
        + chalk.gray(' (varies with prompt size)'));
      console.log('');
      const { proceed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'proceed',
        message: 'Continue with this scan?',
        default: true,
      }]);
      if (!proceed) {
        console.log(chalk.yellow('Scan cancelled. No charges incurred.'));
        return { reportPath: null, totalFindings: 0, scannedCount: 0, cancelled: true };
      }
      console.log('');
      // Reset session usage so post-scan cost reflects only this scan,
      // not any prior scans within the same Node process.
      resetSessionUsage();
    }
  }

  // ── Project label ────────────────────────────────────────────────
  // Optional project tracking. When the user provides a label, the scan
  // will be saved to project history; subsequent scans against the same
  // label produce a baseline comparison (resolved/remaining/new findings,
  // velocity trend). Hitting Enter without a label runs the scan as a
  // one-time audit with no history. Mirrors POI/Conflict/Blast behaviour.
  //
  // GATED: Project Intelligence is Pro+ only. On Open, we skip the label
  // prompt entirely — the user runs a one-shot scan, gets a full report,
  // and no project history is written. This is consistent with how Open
  // already hides the Project Dashboard and Compare Reports menu items.
  let projectLabel = null;
  if (projectIntelEnabled) {
    projectLabel = await promptProjectLabel();
    console.log('');
  }

  // ── Scan ────────────────────────────────────────────────────────────────
  const allFindings = [];
  const scannedFilePaths = [];

  for (let i = 0; i < loaded.files.length; i++) {
    const file = loaded.files[i];
    if (typeof options.onProgress === 'function') {
      options.onProgress(file, i + 1, loaded.files.length);
    }

    const findings = await runAll(file.content, file.path, { targetModel });
    for (const f of findings) allFindings.push(f);
    scannedFilePaths.push(file.path);

    // Per-file terminal summary line.
    if (findings.length === 0) {
      console.log(chalk.green('  ✓ ') + path.basename(file.path)
        + chalk.gray(' (no findings)'));
    } else {
      const sevTally = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
      for (const f of findings) {
        if (sevTally[f.severity] !== undefined) sevTally[f.severity]++;
      }
      const sevSummary = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
        .filter(s => sevTally[s] > 0)
        .map(s => severityEmoji(s) + sevTally[s])
        .join(' ');
      console.log(chalk.yellow('  ⚠ ') + path.basename(file.path)
        + ' ' + sevSummary
        + chalk.gray(' (' + findings.length + ' finding' + (findings.length === 1 ? '' : 's') + ')'));
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold('Total: ' + allFindings.length + ' finding'
    + (allFindings.length === 1 ? '' : 's')
    + ' across ' + loaded.files.length + ' prompt'
    + (loaded.files.length === 1 ? '' : 's')));

  const markdown = renderReport({
    findings: allFindings,
    scannedFiles: scannedFilePaths,
    detectors,
    scanDate: new Date(),
    folderLabel: loaded.sourceLabel,
  });

  // Save report.
  ensureDir(reportsDir);
  const filename = 'prompt-triage-' + timestampSlug() + '.md';
  const reportPath = path.join(reportsDir, filename);
  try {
    fs.writeFileSync(reportPath, markdown, 'utf8');
    console.log('');
    console.log(chalk.gray('Report saved to: ') + reportPath);
  } catch (err) {
    console.log(chalk.red('  ✗ Could not save report: ' + err.message));
  }

  // ── Portal publish (Pro+) ─────────────────────────────────────────────
  // Push the Prompt Triage results to the web portal alongside POI/Blast/
  // Conflict/Recon/Audit. Mirror the saveReport contract: write standard-
  // naming files (ghost-prompt-triage-{label}-{ts}.{md,findings.json}) to
  // the main reports dir, build a findings.json sidecar that powers Jira
  // export, and call publishToPortal. Non-fatal on failure — the primary
  // report at prompt-triage/ is already saved.
  if (projectLabel && isPortalConfigured()) {
    try {
      const mainReportsDir = path.join(os.homedir(), 'Ghost Architect Reports');
      const safeLabel = projectLabel.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 30);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const baseName = `ghost-prompt-triage-${safeLabel}-${ts}`;

      const stdMdPath  = path.join(mainReportsDir, baseName + '.md');
      const stdTxtPath = path.join(mainReportsDir, baseName + '.txt');
      const findingsJsonPath = path.join(mainReportsDir, baseName + '.findings.json');

      fs.writeFileSync(stdMdPath,  markdown, 'utf8');
      fs.writeFileSync(stdTxtPath, markdown, 'utf8');

      // Map prompt-triage finding shape to the portal sidecar shape.
      // Prompt Triage findings carry: detector, severity, title, file,
      // detail (or message), confidence. Map to: id, title, severity,
      // files (array), effortHours, confidence, detail.
      const sidecarFindings = allFindings.map((f, i) => ({
        id:          `${(f.severity || 'INFO').toUpperCase()}:${f.file || 'unknown'}:${f.detector || ('f' + i)}`,
        title:       f.title || f.detector || 'Untitled finding',
        severity:    (f.severity || 'INFO').toUpperCase(),
        files:       f.file ? [f.file] : [],
        effortHours: 0,
        confidence:  f.confidence || 85,
        detail:      f.detail || f.message || '',
      }));
      const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      for (const f of sidecarFindings) {
        const k = (f.severity || '').toLowerCase();
        if (counts[k] !== undefined) counts[k]++;
      }
      const sidecar = {
        schema:         1,
        generatedAt:    new Date().toISOString(),
        project:        projectLabel,
        mode:           'prompt-triage',
        totalFindings:  sidecarFindings.length,
        severityCounts: counts,
        findings:       sidecarFindings,
      };
      fs.writeFileSync(findingsJsonPath, JSON.stringify(sidecar, null, 2));

      const portalTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('portal-publish timeout after 120s')), 120000)
      );
      await Promise.race([
        publishToPortal({
          baseName,
          mode:             'prompt-triage',
          label:            projectLabel,
          txtPath:          stdTxtPath,
          mdPath:           stdMdPath,
          pdfPath:          null,
          findingsJsonPath,
          reportText:       markdown,
          scanIso:          new Date().toISOString(),
        }),
        portalTimeout,
      ]);
    } catch {
      // Portal failure is non-fatal — the primary report is already saved.
    }
  }

  // ── Project intelligence ──────────────────────────────────────────────
  // When the user gave a project label, save this scan into project history
  // and (for subsequent scans) print a baseline comparison. We pass the
  // already-extracted findings via meta.findings so saveProjectIntelligence
  // doesn't try to re-parse our markdown shape (which differs from POI's).
  if (projectLabel) {
    const piFindings = allFindings.map(f => ({
      title: f.title || f.detector || 'Untitled finding',
      severity: f.severity || 'UNKNOWN',
      // Prompt Triage findings don't carry effort hours; the project
      // intelligence layer reads this for velocity rollups but treats 0
      // gracefully — it just won't show effort-based velocity.
      effortHours: 0,
    }));
    const piMeta = {
      findings: piFindings,
      filesAnalyzed: loaded.files.length + ' prompt' + (loaded.files.length === 1 ? '' : 's'),
      targetModel: targetModel || null,
      detectorsRun: detectors.length,
    };
    try {
      await handleProjectIntelligence(projectLabel, markdown, piMeta);
    } catch (err) {
      // Project intelligence is non-fatal; the scan and report are already
      // saved. Log and continue rather than tank the user's main result.
      console.log(chalk.gray('  (Project intelligence unavailable: ' + (err.message || err) + ')'));
    }
  }

  // ── Actual cost ────────────────────────────────────────────────────
  // If a target model was set, the session usage accumulator now holds the
  // sum of every Tier 2 API call made during this scan. Print the actual
  // cost so the user can compare against the pre-flight estimate. Cached
  // results don't pass through callOnce, so the totals reflect new charges
  // only — a re-run on the same prompts can show a much lower number, which
  // is correct (no money was spent re-fetching cached audits).
  if (targetModel) {
    const usage = getSessionUsage();
    if (usage.calls > 0) {
      const actual = calcActualCost(usage.input_tokens, usage.output_tokens, targetModel);
      console.log(chalk.gray('Actual cost: ')
        + chalk.bold(formatCost(actual.totalCost))
        + chalk.gray(' (' + usage.calls + ' API call' + (usage.calls === 1 ? '' : 's')
        + ', ' + usage.input_tokens.toLocaleString() + ' in / '
        + usage.output_tokens.toLocaleString() + ' out tokens)'));
    }
  }

  return {
    reportPath,
    totalFindings: allFindings.length,
    scannedCount: loaded.files.length,
  };
}
