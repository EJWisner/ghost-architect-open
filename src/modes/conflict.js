/**
 * Ghost Architect — Conflict Detection Mode (CLI layer)
 * Thin wrapper: handles all prompts and display for core/conflict.js
 */

import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import { showFriendlyError } from '../utils/errors.js';
import { runConflictScan, getConflictPassInfo } from '../core/conflict.js';
import { showCostEstimate, showActualCost } from '../estimator.js';
import { getConfig } from '../config.js';
import { saveReport } from '../reports.js';
import { runRecon, formatPlanForDisplay } from '../core/agent/planner.js';

export async function runConflictMode(codebaseContext) {
  const fileMap    = codebaseContext.fileMap || {};
  const model      = getConfig().get('defaultModel') || 'claude-sonnet-4-5';
  const info       = getConflictPassInfo(fileMap);
  const multiPass  = !info.singlePass;

  console.log('\n' + boxen(
    chalk.magenta.bold('⚡ CONFLICT DETECTION') + '\n' +
    chalk.gray(
      `Scanning ${codebaseContext.loadedFiles} files for contract conflicts,\n` +
      `schema mismatches, config key errors, and constant disagreements.`
    ) +
    (multiPass
      ? '\n' + chalk.yellow(`⚡ Large codebase — ${info.passes.length} passes required`)
      : '') + '\n' +
    chalk.gray(`Est. cost: ~$${info.estCost}  ·  Est. time: ~${info.estMinutes} min`),
    { padding: 1, borderColor: 'magenta', borderStyle: 'round' }
  ));
  console.log('');

  if (info.singlePass) {
    showCostEstimate(codebaseContext, 'poi', model);
  }

  // ── Agent Planner ─────────────────────────────────────────────────────────
  try {
    const reconSpinner = ora({ text: chalk.gray('Ghost is sizing up your codebase...'), color: 'magenta' }).start();
    const reconPlan    = await runRecon(fileMap, 'conflict', {});
    reconSpinner.stop();
    const display = formatPlanForDisplay(reconPlan);

    console.log('\n' + boxen(
      chalk.magenta.bold('🔍 ANALYSIS PLAN') + '\n\n' +
      chalk.white(display.summary || '') + '\n\n' +
      chalk.gray('Files:   ') + chalk.bold(String(display.stats.files)) + '   ' +
      chalk.gray('Passes:  ') + chalk.bold(String(display.stats.passes)) + '   ' +
      chalk.gray('Est. cost: ') + chalk.bold(display.stats.cost) + '   ' +
      chalk.gray('Est. time: ') + chalk.bold(display.stats.time) +
      (display.risks.length > 0
        ? '\n\n' + chalk.yellow.bold('⚠  High-risk areas:') + '\n' +
          display.risks.slice(0, 4).map(r => chalk.yellow(`   • ${r}`)).join('\n')
        : '') +
      (display.warnings.length > 0
        ? '\n\n' + chalk.yellow.bold('!  Warnings:') + '\n' +
          display.warnings.map(w => chalk.yellow(`   ${w}`)).join('\n')
        : '') +
      (display.entryPoint
        ? '\n\n' + chalk.gray('Starting at: ') + chalk.magenta(display.entryPoint)
        : ''),
      { padding: 1, borderColor: 'magenta', borderStyle: 'round' }
    ));
    console.log('');
  } catch {
    console.log(chalk.gray('  (Recon unavailable — proceeding with standard scan)\n'));
  }

  const { proceed } = await inquirer.prompt([{
    type: 'confirm', name: 'proceed',
    message: chalk.cyan('Run conflict detection?'), default: true
  }]);
  if (!proceed) { console.log(chalk.gray('\nCancelled.\n')); return; }

  // ── Verification cost warning — shown before scan starts ─────────────────
  // Shown here so user knows verification cost BEFORE committing to the scan.
  // Estimate: ~$0.10 per candidate for full verification, ~$0.01 for quick.
  const candidateEstimate = Math.max(5, Math.ceil(info.totalFiles * 0.15));
  const fullVerifyCost    = (candidateEstimate * 0.10).toFixed(2);
  const quickVerifyCost   = (candidateEstimate * 0.01).toFixed(2);

  console.log(chalk.gray(
    `\n  ℹ  Conflict verification runs after scanning.\n` +
    `     Est. candidates: ~${candidateEstimate} | Full verify: ~$${fullVerifyCost} | Quick verify: ~$${quickVerifyCost}\n`
  ));

  let buffer  = '';
  let started = false;
  let spinner = null;

  try {
    const callbacks = {
      onChunk(text) {
        if (!started) {
          if (spinner) spinner.stop();
          started = true;
          console.log('');
        }
        buffer += text;
        process.stdout.write(colorizeOutput(text));
      },

      onProgress({ type, ...data }) {
        switch (type) {
          case 'start':
            if (data.singlePass) {
              spinner = ora({ text: chalk.gray('Ghost is scanning for conflicts...'), color: 'magenta' }).start();
            }
            break;

          case 'passStart':
            console.log(chalk.gray(
              `\n  Pass ${data.passNum} of ${data.totalPasses} — ` +
              `${data.fileCount} files (~${data.tokens.toLocaleString()} tokens)...`
            ));
            break;

          case 'passComplete':
            console.log(chalk.green(`  ✓ Pass ${data.passNum} complete`));
            break;

          case 'resuming':
            console.log(chalk.magenta(
              `\n  ⚡ Resuming from Pass ${data.fromPass + 1} of ${data.totalPasses} — prior passes restored.\n`
            ));
            break;

          case 'candidates_found':
            if (spinner) spinner.stop();
            console.log(chalk.cyan(`\n  🔍 ${data.count} conflict candidates found — running verification...\n`));
            break;

          case 'verification_start':
            console.log(chalk.gray(`  Verifying ${data.count} candidates against codebase...`));
            break;

          case 'verifying':
            process.stdout.write(chalk.gray(`  ⟳  Verifying: ${data.title.slice(0, 60)}...\r`));
            break;

          case 'verified': {
            const icon =
              data.verdict === 'CONFIRMED'      ? chalk.red('  ✗  CONFIRMED') :
              data.verdict === 'POSSIBLE'        ? chalk.yellow('  ?  POSSIBLE ') :
              data.verdict === 'FALSE_POSITIVE'  ? chalk.green('  ✓  ELIMINATED') :
                                                   chalk.gray('  ~  UNCLEAR  ');
            console.log(`${icon}  ${chalk.gray(data.title.slice(0, 55))}`);
            break;
          }

          case 'verification_done':
            console.log('');
            console.log(
              chalk.bold('  Verification complete: ') +
              chalk.red(`${data.stats.confirmed} confirmed  `) +
              chalk.yellow(`${data.stats.possible} possible  `) +
              chalk.green(`${data.stats.falsePositives} eliminated`)
            );
            console.log('');
            break;

          case 'narrating':
            console.log(chalk.gray('  Ghost is writing the conflict report...\n'));
            break;

          case 'merging':
            console.log(chalk.gray(`\n  🔀 Merging ${data.count} passes into final report...`));
            break;

          case 'done':
            if (spinner) spinner.stop();
            console.log('\n');
            break;
        }
      },

      async onSessionPrompt({ session, totalPasses }) {
        console.log(chalk.yellow(
          `\n  ⚡ Partial conflict session found — ` +
          `${session.completedPassCount} of ${totalPasses} passes completed.\n`
        ));
        const { action } = await inquirer.prompt([{
          type: 'list', name: 'action',
          message: chalk.cyan('Resume or restart?'),
          choices: [
            { name: `Resume from Pass ${session.completedPassCount + 1}`, value: 'resume' },
            { name: 'Restart from scratch',                                value: 'restart' },
          ],
        }]);
        return action;
      },
    };

    const result = await runConflictScan(fileMap, callbacks);

    if (!result?.finalReport) return;
    buffer = result.finalReport;

    // Show verification stats summary if available
    if (result.verified && result.stats) {
      const s = result.stats;
      console.log(chalk.magenta(
        `  👻 Agent verified ${s.total} candidates — ` +
        `${s.confirmed} confirmed, ${s.possible} possible, ${s.falsePositives} false positives eliminated\n`
      ));
    }

    // Cost
    const inputTokens  = Math.ceil(codebaseContext.context.length / 4) + 200;
    const outputTokens = Math.ceil(buffer.length / 4);
    showActualCost(inputTokens, outputTokens, model);

    // Save prompt
    const { doSave } = await inquirer.prompt([{
      type: 'confirm', name: 'doSave',
      message: chalk.cyan('Save this conflict report to ~/Ghost Architect Reports/?'), default: true
    }]);

    if (doSave) {
      const meta = {
        filesAnalyzed: `${codebaseContext.loadedFiles} of ${codebaseContext.totalFiles}`,
        totalFiles: codebaseContext.totalFiles,
        cost: `$${(inputTokens * 0.000003 + outputTokens * 0.000015).toFixed(4)}`,
        version: '4.1.1',
        mode: 'conflict-detection',
        verified: result.verified || false,
        verificationStats: result.stats || null,
      };
      const saved = await saveReport(buffer, 'ghost-conflict', null, meta);
      console.log(chalk.green(`\n✓ Conflict report saved to ~/Ghost Architect Reports/`));
      console.log(chalk.gray(`  📄 ${saved.txtFile}`));
      console.log(chalk.gray(`  📋 ${saved.mdFile}`));
      if (saved.pdfFile) console.log(chalk.magenta(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
      console.log('');
    }

  } catch (err) {
    if (spinner) spinner.stop();
    showFriendlyError(err);
  }
}

function colorizeOutput(text) {
  return text
    .replace(/🔀 CONTRACT CONFLICTS/g,   chalk.blue.bold('🔀 CONTRACT CONFLICTS'))
    .replace(/🗄️ SCHEMA CONFLICTS/g,     chalk.yellow.bold('🗄️  SCHEMA CONFLICTS'))
    .replace(/⚙️ CONFIG CONFLICTS/g,      chalk.cyan.bold('⚙️  CONFIG CONFLICTS'))
    .replace(/🔢 CONSTANT CONFLICTS/g,   chalk.green.bold('🔢 CONSTANT CONFLICTS'))
    .replace(/📦 DEPENDENCY CONFLICTS/g, chalk.red.bold('📦 DEPENDENCY CONFLICTS'))
    .replace(/🧩 INTERFACE CONFLICTS/g,  chalk.magenta.bold('🧩 INTERFACE CONFLICTS'))
    .replace(/⚡ CONFLICT SUMMARY/g,     chalk.magenta.bold('⚡ CONFLICT SUMMARY'))
    .replace(/CONFIRMED/g,  chalk.red.bold('CONFIRMED'))
    .replace(/POSSIBLE/g,   chalk.yellow.bold('POSSIBLE'))
    .replace(/CRITICAL/g,   chalk.bgRed.white.bold(' CRITICAL '))
    .replace(/\bHIGH\b/g,   chalk.red.bold('HIGH'))
    .replace(/\bMEDIUM\b/g, chalk.yellow.bold('MEDIUM'))
    .replace(/\bLOW\b/g,    chalk.green.bold('LOW'))
    .replace(/Resolution:/g, chalk.green.bold('Resolution:'))
    .replace(/Impact:/g,     chalk.yellow('Impact:'))
    .replace(/Severity:/g,   chalk.cyan('Severity:'));
}
