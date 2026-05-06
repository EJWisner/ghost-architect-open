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

import { loadPromptSource } from '../prompt-pack/loader.js';
import { runAll, listDetectors } from '../prompt-pack/index.js';
import { renderReport } from '../prompt-pack/report.js';
import { getModel } from '../prompt-pack/models.js';

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
  console.log('');

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

  return {
    reportPath,
    totalFindings: allFindings.length,
    scannedCount: loaded.files.length,
  };
}
