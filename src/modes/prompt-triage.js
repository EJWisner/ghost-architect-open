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
 *   - onProgress:    optional callback (file, idx, total) => void
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';

import { loadPromptSource } from '../prompt-pack/loader.js';
import { runAll, listDetectors } from '../prompt-pack/index.js';
import { redactContent } from '../redactor.js';
import { renderReport } from '../prompt-pack/report.js';
import { getModel } from '../prompt-pack/models.js';
import { resetSessionUsage, getSessionUsage } from '../prompt-pack/llmAuditClient.js';
// @ghost-verified: prompt-triage.js imports estimateMultiCallCost, formatCost, formatCostRange, calcActualCost directly from src/core/estimator.js where all four are exported -- the src/estimator.js barrel shim does not re-export these but prompt-triage.js does not use the shim
import {
  estimateMultiCallCost,
  formatCost,
  formatCostRange,
  calcActualCost,
} from '../core/estimator.js';
import { printUpgradeLine } from '../cli/upgrade-line.js';

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
    case 'LOW':      return '🟢';
    default:         return '⚪';
  }
}

// 2.15: the loader filters files that carry a prompt extension but match its
// basename allowlist (README, LICENSE, CLAUDE, ...) or config-manifest patterns
// (package.json, *_PLAN.md, ...). That filtering is silent: a legitimately
// named prompt can be dropped with no trace. We do not own the loader, so
// rather than widen its heuristic we independently discover how many files
// with a prompt extension were present but not analyzed, and let the mode
// report the count and a bounded sample so a false exclusion is visible and
// the user can rename the file. This is a reporting-only pass; it never loads
// or analyzes anything the loader chose to skip.
const PROMPT_CANDIDATE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.yaml', '.yml', '.json']);
const CANDIDATE_IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__', 'venv', '.venv',
]);

function findUnanalyzedCandidates(root, analyzedPathSet, sampleCap = 8) {
  const names = [];
  let count = 0;
  let truncated = false;
  const MAX_WALK = 5000; // bounded so a huge tree can't stall the report pass
  let seen = 0;

  function walk(dir) {
    if (seen >= MAX_WALK) { truncated = true; return; }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= MAX_WALK) { truncated = true; return; }
      seen++;
      if (entry.isDirectory()) {
        if (CANDIDATE_IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!PROMPT_CANDIDATE_EXTENSIONS.has(ext)) continue;
      const full = path.join(dir, entry.name);
      if (analyzedPathSet.has(full)) continue; // this file was loaded and scanned
      count++;
      if (names.length < sampleCap) names.push(entry.name);
    }
  }

  walk(root);
  return { count, names, truncated };
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
  // Tier 2 deep-analysis detectors send the prompt to the Anthropic Messages
  // API (see src/prompt-pack/llmAuditClient.js), so they can only run against a
  // Claude-family target model. If the user picked a known non-Claude model
  // (GPT-5, Gemini, Llama, etc.), Tier 2 would fail not-found and fail open
  // with zero findings and no explanation. Detect that here so we can skip
  // Tier 2/3 entirely and tell the user honestly, instead of silently
  // returning an incomplete audit. Tier 1 static checks still run: they use
  // correct per-model tokenizers (exact tiktoken for OpenAI, heuristic
  // elsewhere) and never call the Anthropic API for prompt judgment.
  const tier2Disabled = !!(targetModelEntry && targetModelEntry.tier2Supported === false);

  // ── Banner ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold('Prompt Triage'));
  console.log(chalk.gray('Auditing prompts for structural defects: missing context, ambiguous instructions, brittle assumptions, token bloat.'));
  if (targetModelEntry) {
    console.log(chalk.gray('Target model: ' + targetModelEntry.displayName
      + ' (' + targetModelEntry.contextWindow.toLocaleString() + ' token window)'));
  } else if (targetModel) {
    console.log(chalk.yellow('⚠  Unknown target model "' + targetModel + '"; using heuristic token counts.'));
  } else {
    console.log(chalk.gray('Target model: (none specified, using heuristic token counts)'));
  }
  if (tier2Disabled) {
    console.log('');
    console.log(chalk.yellow('Note: Deep analysis (Tier 2) requires a Claude family target model.'));
    console.log(chalk.yellow('  ' + targetModelEntry.displayName + ' is not a Claude model, so only Tier 1 '
      + 'static checks will run against it.'));
    console.log(chalk.gray('  Re-run with a Claude target model (for example Claude Sonnet 4.6) to get '
      + 'Tier 2 deep-analysis findings.'));
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
  // 2.15: report files with a prompt extension that were present but NOT
  // analyzed, so the loader's silent basename/config filtering is visible. The
  // dominant reason a prompt-shaped file is dropped is the loader's docs/config
  // allowlist (README, LICENSE, CLAUDE, package.json, *_PLAN.md, ...); size and
  // read failures are already reported on the line above. We only run this for
  // localFolder sources, where we can re-scan the tree cheaply.
  if (source.kind === 'localFolder' && source.path) {
    try {
      const analyzedPathSet = new Set(loaded.files.map(f => f.path));
      const cand = findUnanalyzedCandidates(path.resolve(source.path), analyzedPathSet);
      if (cand.count > 0) {
        const shown = cand.names.join(', ');
        const more = cand.count > cand.names.length ? ', and more' : '';
        console.log(chalk.gray('  ' + cand.count + ' file'
          + (cand.count === 1 ? '' : 's')
          + ' with a prompt extension '
          + (cand.count === 1 ? 'was' : 'were')
          + ' present but not analyzed, filtered as likely docs or config'
          + (shown ? ' (' + shown + more + ')' : '') + '.'));
        console.log(chalk.gray('  If one of those is really a prompt, rename it so it '
          + 'is not treated as a README, license, or config file.'));
      }
    } catch {
      // Reporting-only pass; never let it break the scan.
    }
  }
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
  if (targetModel && !tier2Disabled) {
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

  // ── Scan ────────────────────────────────────────────────────────────────
  const allFindings = [];
  const scannedFilePaths = [];
  // Files that loaded fine but were dropped by the privacy redactor (throw or
  // partial redaction without GHOST_ALLOW_PARTIAL). They are NOT analyzed, so
  // they must not count toward the "prompts scanned" total. Tracked so the
  // count reflects files actually analyzed and so we can report the gap.
  let redactionSkipped = 0;

  for (let i = 0; i < loaded.files.length; i++) {
    const file = loaded.files[i];
    if (typeof options.onProgress === 'function') {
      options.onProgress(file, i + 1, loaded.files.length);
    }

    // Privacy gate: Tier 2/3 detectors send this content to the Claude API, so
    // it MUST be redacted first. A prompt file can carry API keys, DSNs, or PEM
    // blocks; sending those raw would break the "safe for proprietary codebases"
    // guarantee. Fail-closed: if redaction throws, or is only PARTIAL (oversized
    // file / regex timeout, where secrets may survive), skip the file rather than
    // risk shipping raw credentials to the API. We never fall back to raw content.
    let redactedContent;
    try {
      const redaction = redactContent(file.content, [], file.path);
      if (redaction.partialRedaction) {
        if (!process.env.GHOST_ALLOW_PARTIAL) {
          throw new Error(
            'Redaction incomplete on large file. ' +
            'Set GHOST_ALLOW_PARTIAL=1 to proceed.'
          );
        }
        console.warn(
          '[Ghost] Partial redaction: one or more ' +
          'files exceeded the size limit.'
        );
      }
      redactedContent = redaction.redacted;
      // Debug-only signal: which redaction rules fired and how many, never the
      // raw secret. Gated on GHOST_DEBUG so normal runs stay quiet.
      if (redaction.findings.length > 0 && process.env.GHOST_DEBUG === '1') {
        process.stderr.write('[prompt-triage] ' + path.basename(file.path)
          + ': redacted ' + redaction.findings.length + ' sensitive item(s) before API ('
          + redaction.findings.join(', ') + ')\n');
      }
    } catch (err) {
      console.log(chalk.red('  ✗ ' + path.basename(file.path)
        + ' skipped: redaction failed (' + (err && err.message ? err.message : String(err))
        + '); raw content was NOT sent to the API.'));
      redactionSkipped++;
      continue;
    }

    // When the target model can't run Tier 2 (non-Claude), skip Tier 2 and
    // Tier 3 so those detectors don't fire doomed Anthropic API calls that
    // fail open with zero findings. Tier 1 still runs. See tier2Disabled above.
    const findings = await runAll(redactedContent, file.path, {
      targetModel,
      skipTiers: tier2Disabled ? [2, 3] : [],
    });
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
  // Count files ACTUALLY analyzed, not files loaded. Redaction-skipped files
  // never reached a detector, so counting them here (or in the report) would
  // overstate coverage. scannedFilePaths holds exactly the analyzed set.
  const analyzedCount = scannedFilePaths.length;
  console.log(chalk.bold('Total: ' + allFindings.length + ' finding'
    + (allFindings.length === 1 ? '' : 's')
    + ' across ' + analyzedCount + ' prompt'
    + (analyzedCount === 1 ? '' : 's')));
  if (redactionSkipped > 0) {
    console.log(chalk.yellow('  ' + redactionSkipped + ' file'
      + (redactionSkipped === 1 ? ' was' : 's were')
      + ' skipped before analysis (redaction could not be completed) and '
      + (redactionSkipped === 1 ? 'is' : 'are') + ' not included in the count above.'));
  }

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
    // Prompt Triage™ saves through its own writer rather than saveReport(),
    // so it prints the upgrade line itself, once per saved report.
    printUpgradeLine();
  } catch (err) {
    console.log(chalk.red('  ✗ Could not save report: ' + err.message));
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
    // Files actually analyzed, excluding any dropped by the redactor. Reusing
    // loaded.files.length here would overstate scanned coverage.
    scannedCount: scannedFilePaths.length,
    redactionSkipped,
  };
}
