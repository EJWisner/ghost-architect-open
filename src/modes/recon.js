/**
 * Ghost Architect — Recon-only mode (Open tier)
 *
 * Sizing-and-scope only. Runs the planner once, produces a saved markdown
 * report describing what a full scan would surface, then exits without
 * spending any analysis-pass budget. Useful for:
 *
 *   - Quick checks during scoping ("how big is this codebase actually,
 *     and what would Ghost surface?")
 *   - Pre-commit / pre-PR sanity sweep on inherited code
 *   - Sales conversations where you want to demonstrate Ghost's value
 *     without committing to a full scan
 *
 * Cost: one planner call (~$0.05). No scan passes.
 *
 * Ghost Open v5.0.0: no project labels, no profile awareness. Reports
 * always save as ghost-recon.{txt,md,pdf} and overwrite the prior run.
 */

import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import { runRecon } from '../core/agent/planner.js';
import { saveReport } from '../reports.js';
import { showFriendlyError } from '../utils/errors.js';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓' };

export async function runReconMode(codebaseContext) {
  const fileMap = codebaseContext.fileMap || {};

  console.log('\n' + boxen(
    chalk.cyan.bold('🔍  RECON — SIZING ONLY') + '\n' +
    chalk.gray('Sizing this codebase and producing an engagement plan.') + '\n' +
    chalk.gray('No analysis passes — single planner call only (~$0.05).'),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  let spinner = null;
  try {
    spinner = ora({ text: chalk.cyan('Ghost is sizing up your codebase...'), color: 'cyan' }).start();

    const plan = await runRecon(fileMap, 'recon', {});

    spinner.succeed(chalk.green('  Recon complete'));
    spinner = null;
    console.log('');

    // Render the recon plan as a markdown report.
    const markdown = renderReconMarkdown(plan);

    // Print a short summary to the terminal so the user sees the headline
    // numbers before deciding whether to save.
    console.log(boxen(
      chalk.cyan.bold('📋 RECON SUMMARY') + '\n\n' +
      chalk.white(plan.planSummary || plan.sizingSummary || '') + '\n\n' +
      chalk.gray('Total files: ')         + chalk.bold(String(plan.totalFiles)) + '   ' +
      chalk.gray('Estimated passes: ')    + chalk.bold(String(plan.estimatedPasses)) + '   ' +
      chalk.gray('Full-scan cost: ')      + chalk.bold('~$' + plan.totalEstCost) + '   ' +
      chalk.gray('Full-scan time: ')      + chalk.bold('~' + plan.estMinutes + ' min') +
      (plan.highRiskAreas?.length
        ? '\n\n' + chalk.yellow.bold('⚠  High-risk areas surfaced:') + '\n' +
          plan.highRiskAreas.slice(0, 5).map(r => chalk.yellow(`   • ${r}`)).join('\n')
        : '') +
      (plan.warningFlags?.length
        ? '\n\n' + chalk.yellow.bold('!  Warnings:') + '\n' +
          plan.warningFlags.map(w => chalk.yellow(`   ${w}`)).join('\n')
        : ''),
      { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
    ));
    console.log('');

    const { doSave } = await inquirer.prompt([{
      type: 'confirm', name: 'doSave',
      message: chalk.cyan('Save recon report to ~/Ghost Architect Reports/?'),
      default: true,
    }]);

    if (!doSave) {
      console.log(chalk.gray('\n  Recon report not saved.\n'));
      return;
    }

    const meta = {
      filesAnalyzed:  `${codebaseContext.loadedFiles} of ${codebaseContext.totalFiles}`,
      totalFiles:     codebaseContext.totalFiles,
      cost:           '0.0500',  // single planner call, fixed estimate
      findingCount:   0,         // recon doesn't produce findings
      reportKind:     'recon',
    };

    // Ghost Open v5.0.0: null label → overwrites ghost-recon.{txt,md,pdf}
    const saved = await saveReport(markdown, 'ghost-recon', null, meta);
    console.log(chalk.green(`\n${SYM.check} Recon report saved to ~/Ghost Architect Reports/`));
    console.log(chalk.gray(`  📄 ${saved.txtFile}`));
    console.log(chalk.gray(`  📋 ${saved.mdFile}`));
    if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
    console.log('');

  } catch (err) {
    if (spinner) { spinner.stop(); spinner = null; }
    showFriendlyError(err);
  }
}

// ── Markdown rendering ───────────────────────────────────────────────────────

function renderReconMarkdown(plan) {
  const lines = [];

  // Note: saveReport renders the metadata header. This body provides the content.

  lines.push('## Executive Summary (Recon Only)');
  lines.push('');
  const exec = plan.engagementPerspective || plan.planSummary
    || `This recon report sizes the ${plan.totalFiles}-file codebase and identifies the areas a full pre-engagement scan would prioritize.`;
  lines.push(exec.trim());
  lines.push('');

  lines.push('## Codebase Sizing');
  lines.push('');
  if (plan.sizingSummary) {
    lines.push(plan.sizingSummary.trim());
    lines.push('');
  }
  lines.push(`- **Total files:** ${plan.totalFiles}`);
  lines.push(`- **Estimated full-scan passes:** ${plan.estimatedPasses}`);
  lines.push(`- **Estimated full-scan cost:** $${plan.totalEstCost}`);
  lines.push(`- **Estimated full-scan time:** ~${plan.estMinutes} minutes`);
  if (plan.proposedStartingPoint) {
    lines.push(`- **Recommended starting point:** \`${plan.proposedStartingPoint}\``);
  }
  if (plan.confidenceNote) {
    lines.push(`- **Estimate confidence:** ${plan.confidenceNote}`);
  }
  lines.push('');

  if (plan.highRiskAreas?.length) {
    lines.push('## High-Risk Areas Detected');
    lines.push('');
    lines.push('A full scan would prioritize these files based on filename pattern matching and structural signals. The list is indicative, not exhaustive.');
    lines.push('');
    for (const area of plan.highRiskAreas) {
      lines.push(`- \`${area}\``);
    }
    lines.push('');
  }

  if (plan.warningFlags?.length) {
    lines.push('## Pre-Scan Warnings');
    lines.push('');
    for (const warn of plan.warningFlags) {
      lines.push(`- ${warn}`);
    }
    lines.push('');
  }

  lines.push('## What This Report Is Not');
  lines.push('');
  lines.push(
    `This is a sizing and scope assessment, not a vulnerability audit or a remediation plan. ` +
    `A full Points of Interest, Blast Radius, or Conflict Detection scan would surface specific ` +
    `findings categorized by severity, produce a remediation plan with line-item cost estimates, ` +
    `and verify each finding against the actual source code.`
  );
  lines.push('');
  lines.push(`Run a Points of Interest, Blast Radius, or Conflict Detection scan from Ghost's main menu to commission the full analysis.`);
  lines.push('');

  return lines.join('\n');
}
