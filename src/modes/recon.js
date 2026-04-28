/**
 * Ghost Architect — Recon-only mode
 *
 * Sizing-and-scope only. Runs the planner once, produces a saved markdown
 * report describing what a full scan would surface, then exits without
 * spending any analysis-pass budget. Useful for:
 *
 *   - Quoting an engagement before committing to a full scan
 *   - Sales conversations where the consultant wants to demonstrate
 *     pre-engagement value without burning the prospect's API budget
 *   - Quick checks during scoping calls ("how big is this codebase
 *     actually, and what would Ghost surface?")
 *
 * Cost: one planner call (~$0.05). No scan passes.
 *
 * Profile awareness: when --profile is loaded, the recon report uses
 * the consultant's voice and emphasizes their methodology's priorities.
 * The saved PDF/markdown carry full white-label branding the same way
 * POI/Blast/Conflict reports do — handled downstream by saveReport via
 * the meta.profile field.
 */

import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import { runRecon } from '../core/agent/planner.js';
import { saveReport } from '../reports.js';
import { promptProjectLabel } from '../projects.js';
import { showFriendlyError } from '../utils/errors.js';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓' };

export async function runReconMode(codebaseContext, options = {}) {
  // Ghost Partner — consultant profile (null when --profile was not passed).
  const profile = options.profile || null;

  const fileMap = codebaseContext.fileMap || {};

  console.log('\n' + boxen(
    chalk.cyan.bold('🔍  RECON — SIZING ONLY') + '\n' +
    chalk.gray('Sizing this codebase and producing an engagement plan.') + '\n' +
    chalk.gray('No analysis passes — single planner call only (~$0.05).') +
    (profile ? '\n' + chalk.magenta(`👥 Ghost Partner profile: ${profile.name || profile.author || 'loaded'}`) : ''),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  // Smart project label prompt — same as POI for consistency.
  const label = await promptProjectLabel();
  console.log('');

  let spinner = null;
  try {
    spinner = ora({ text: chalk.cyan('Ghost is sizing up your codebase...'), color: 'cyan' }).start();

    const plan = await runRecon(fileMap, 'recon', { profile });

    spinner.succeed(chalk.green('  Recon complete'));
    spinner = null;
    console.log('');

    // Render the recon plan as a markdown report. This is the artifact
    // the consultant hands to a prospect — it must read as a polished
    // engagement-ready document, not raw planner output.
    const markdown = renderReconMarkdown(plan, label, profile);

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

    // Recon reports save with the same machinery as POI/Blast/Conflict so
    // the white-label branding (cover, header, footer, accent color) flows
    // through automatically when a profile is present.
    const meta = {
      filesAnalyzed:  `${codebaseContext.loadedFiles} of ${codebaseContext.totalFiles}`,
      totalFiles:     codebaseContext.totalFiles,
      cost:           '0.0500',  // single planner call, fixed estimate
      version:        '4.7.0',
      findingCount:   0,         // recon doesn't produce findings
      critical:       0,
      high:           0,
      medium:         0,
      low:            0,
      totalHours:     null,
      totalCost:      null,
      baselineCount:  0,
      baselineDate:   null,
      resolved:       0,
      newFindings:    0,
      scans:          [],
      profile,
      reportKind:     'recon',  // hint for saveReport rendering
    };

    const saved = await saveReport(markdown, 'ghost-recon', label, meta);
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
//
// Renders the structured plan as a saved-report-friendly markdown document.
// Profile-aware: when a consultant profile is loaded, the prose paragraphs
// (engagement_perspective, methodology_note) are written in the consultant's
// voice. When no profile is loaded, the prose still works but reads as a
// neutral pre-engagement triage.

function renderReconMarkdown(plan, projectLabel, profile) {
  const consultantName = profile?.author || profile?.organization || null;
  const consultantOrg  = profile?.organization || profile?.author  || null;

  // Note: we deliberately do NOT emit a top-level H1 here. saveReport()
  // always renders a metadata header (e.g., "# OSCProfessionals —
  // Pre-Engagement Recon") before our body content. Adding a body H1
  // would result in two stacked H1s in the final saved markdown.
  // The metadata header IS the title; this body provides the content.

  const lines = [];

  // Executive recon paragraph — uses LLM-generated perspective when present,
  // falls back to plan summary, then a generic line if neither exists.
  lines.push('## Executive Summary (Recon Only)');
  lines.push('');
  const exec = plan.engagementPerspective || plan.planSummary
    || `This recon report sizes the ${plan.totalFiles}-file codebase and identifies the areas a full pre-engagement scan would prioritize.`;
  lines.push(exec.trim());
  lines.push('');

  // Sizing block — concrete numbers consultants will hand to a prospect.
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

  // High-risk areas — bulleted list of files Ghost would prioritize.
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

  // Warnings — pre-scan concerns Ghost flagged.
  if (plan.warningFlags?.length) {
    lines.push('## Pre-Scan Warnings');
    lines.push('');
    for (const warn of plan.warningFlags) {
      lines.push(`- ${warn}`);
    }
    lines.push('');
  }

  // Methodology note — only renders when a profile is loaded. Explains
  // how the consultant's lens applies to this specific codebase.
  if (profile && plan.methodologyNote) {
    lines.push('## Methodology Note');
    lines.push('');
    lines.push(plan.methodologyNote.trim());
    lines.push('');
  }

  // Closing CTA — explicit framing of what this report is and isn't.
  lines.push('## What This Report Is Not');
  lines.push('');
  if (consultantName) {
    lines.push(
      `This is a sizing and scope assessment, not a vulnerability audit or a remediation plan. ` +
      `A full Pre-Engagement Diligence scan would surface specific findings categorized by severity, ` +
      `produce a remediation plan with line-item cost estimates, and verify each finding against the ` +
      `actual source code.`
    );
    lines.push('');
    lines.push(`To commission a full scan, contact **${consultantName}**${consultantOrg && consultantOrg !== consultantName ? ` at ${consultantOrg}` : ''}.`);
  } else {
    lines.push(
      `This is a sizing and scope assessment, not a vulnerability audit or a remediation plan. ` +
      `A full Pre-Engagement Diligence scan would surface specific findings categorized by severity, ` +
      `produce a remediation plan with line-item cost estimates, and verify each finding against the ` +
      `actual source code.`
    );
    lines.push('');
    lines.push(`Run a Points of Interest, Blast Radius, or Conflict Detection scan to commission the full analysis.`);
  }
  lines.push('');

  return lines.join('\n');
}
