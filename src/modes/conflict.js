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

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };

export async function runConflictMode(codebaseContext) {
  const fileMap    = codebaseContext.fileMap || {};
  const projectLabel = (codebaseContext.fileIndex?.[0] || 'project')
    .split('/').slice(0, 2).join('-')
    .replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40) || 'conflict-default';
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



  let buffer  = '';
  let started = false;
  let spinner = null;

  try {
    const callbacks = {
      // Capture the report to the buffer silently. Streaming raw markdown to
      // the terminal during narration is messy and — on Ghost Open before
      // v5.0.0 — leaked the full pre-paywall report into scrollback. The
      // 'narrating' progress event installs a spinner; that's the only
      // user-visible signal during report generation. POI mode follows the
      // same pattern.
      onChunk(text) {
        if (!started) {
          started = true;
        }
        buffer += text;
      },

      onProgress({ type, ...data }) {
        switch (type) {
          case 'start':
            if (data.singlePass) {
              spinner = ora({ text: chalk.gray('Ghost is scanning for conflicts...'), color: 'magenta' }).start();
            }
            break;

          case 'passStart':
            if (spinner) { spinner.stop(); spinner = null; }
            spinner = ora({
              text: chalk.gray(
                `  Pass ${data.passNum} of ${data.totalPasses} — ` +
                `${data.fileCount} files (~${data.tokens.toLocaleString()} tokens)...`
              ),
              color: 'magenta',
            }).start();
            break;

          case 'passComplete':
            if (spinner) {
              spinner.succeed(chalk.green(`  ${SYM.check} Pass ${data.passNum} complete`));
              spinner = null;
            }
            // Holding spinner covers the gap before the next pass starts or
            // before candidate extraction. Replaced as soon as the next event
            // fires — that's fine.
            spinner = ora({ text: chalk.gray('  Preparing next pass...'), color: 'magenta' }).start();
            break;

          case 'resuming':
            console.log(chalk.magenta(
              `\n  ⚡ Resuming from Pass ${data.fromPass + 1} of ${data.totalPasses} — prior passes restored.\n`
            ));
            break;

          case 'candidates_found':
            if (spinner) { spinner.stop(); spinner = null; }
            console.log(chalk.cyan(`\n  🔍 ${data.count} conflict candidates found — running verification...\n`));
            break;

          case 'verification_start':
            if (spinner) { spinner.stop(); spinner = null; }
            console.log(chalk.gray(`  Verifying ${data.count} candidates against codebase...`));
            break;

          case 'verifying':
            process.stdout.write(chalk.gray(`  ⟳  Verifying: ${data.title.slice(0, 60)}...\r`));
            break;

          case 'verified': {
            const icon =
              data.verdict === 'CONFIRMED'      ? chalk.red('  ' + SYM.cross + '  CONFIRMED') :
              data.verdict === 'POSSIBLE'        ? chalk.yellow('  ?  POSSIBLE ') :
              data.verdict === 'FALSE_POSITIVE'  ? chalk.green('  ' + SYM.check + '  ELIMINATED') :
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
            // Holding spinner covers the gap between verification finishing
            // and narration starting. Replaced as soon as 'narrating' fires.
            spinner = ora({ text: chalk.gray('  Preparing the conflict report...'), color: 'magenta' }).start();
            break;

          case 'narrating':
            if (spinner) { spinner.stop(); spinner = null; }
            spinner = ora({ text: chalk.magenta('  Ghost is writing the conflict report...'), color: 'magenta' }).start();
            break;

          case 'merging':
            if (spinner) { spinner.stop(); spinner = null; }
            spinner = ora({ text: chalk.gray(`  🔀 Merging ${data.count} passes into final report...`), color: 'magenta' }).start();
            break;

          case 'done':
            if (spinner) { spinner.succeed(chalk.green('  Conflict report ready')); spinner = null; }
            console.log('');
            break;
        }
      },

      async onVerifyPrompt({ count, quickCost, fullCost }) {
        console.log(chalk.cyan(
          `\n  🔍 ${count} conflict candidates found\n`
        ));
        console.log(chalk.gray(
          `     Quick verify: ~$${quickCost}  ~${Math.ceil(count * 3 / 60)} min\n` +
          `     Full verify:  ~$${fullCost}  ~${Math.ceil(count * 10 / 60)} min\n`
        ));
        const { choice } = await inquirer.prompt([{
          type: 'list', name: 'choice',
          message: chalk.cyan('Choose verification depth:'),
          choices: [
            { name: `Quick  — fast scan, surfaces candidates for review  (~$${quickCost})`, value: 'quick' },
            { name: `Full   — deep agent verification per candidate       (~$${fullCost})`,  value: 'full' },
            { name: `Skip   — no verification, surface all as manual review ($0)`,            value: 'skip' },
          ],
        }]);
        return choice;
      },

      async onSessionPrompt({ session, totalPasses }) {
        const pct = Math.round((session.completedPassCount / totalPasses) * 100);
        console.log(chalk.cyan(`\n📂  Saved session: ${session.projectLabel} — ${session.completedPassCount}/${totalPasses} passes (${pct}% coverage)\n`));
        const { action } = await inquirer.prompt([{
          type: 'list', name: 'action',
          message: chalk.cyan('What would you like to do?'),
          choices: [
            { name: `Continue from pass ${session.completedPassCount + 1}`, value: 'resume'  },
            { name: 'Generate report from completed passes now',              value: 'report'  },
            { name: 'Restart from scratch',                                   value: 'restart' },
          ],
        }]);
        if (action === 'report') console.log(chalk.cyan('\n  🧠 Generating report from completed passes...\n'));
        return action;
      },
    };

    const result = await runConflictScan(fileMap, callbacks, { projectLabel });

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
        cost: `${(inputTokens * 0.000003 + outputTokens * 0.000015).toFixed(4)}`,
        version: '4.1.1',
        mode: 'conflict-detection',
        verified: result.verified || false,
        verificationStats: result.stats || null,
      };
      // Ghost Open v5.0.0: no label, overwrites ghost-conflict.{txt,md,pdf}
      const saved = await saveReport(buffer, 'ghost-conflict', null, meta);
      console.log(chalk.green(`\n${SYM.check} Conflict report saved to ~/Ghost Architect Reports/`));
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
