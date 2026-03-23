import { showFriendlyError } from '../utils/errors.js';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import { runPOIScan } from '../analyst/index.js';
import { runMultiPassPOI, buildPasses } from '../analyst/multipass.js';
import { showCostEstimate, showActualCost } from '../estimator.js';
import { getConfig } from '../config.js';
import { saveReport } from '../reports.js';
import { handleProjectIntelligence, promptProjectLabel } from '../projects.js';
import { runRecon, formatPlanForDisplay } from '../core/agent/planner.js';

export async function runPOIMode(codebaseContext) {
  const fileMap      = codebaseContext.fileMap || {};
  const passes       = Object.keys(fileMap).length > 0 ? buildPasses(fileMap) : [];
  const useMultiPass = passes.length > 1;
  const model        = getConfig().get('defaultModel') || 'claude-sonnet-4-5';
  const rates        = {
    junior: getConfig().get('rateJunior') || 85,
    mid:    getConfig().get('rateMid')    || 125,
    senior: getConfig().get('rateSenior') || 200,
  };

  console.log('\n' + boxen(
    chalk.cyan.bold('🗺  POINTS OF INTEREST SCAN') + '\n' +
    chalk.gray(`Analyzing ${codebaseContext.loadedFiles} files for red flags, landmarks,\ndead zones, fault lines, effort estimates, and remediation steps...`) +
    (useMultiPass ? '\n' + chalk.yellow(`⚡ Large codebase — multi-pass mode (${passes.length} passes required)`) : '') + '\n' +
    chalk.gray(`Rates: $${rates.junior}/hr junior · $${rates.mid}/hr mid · $${rates.senior}/hr senior`),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  if (!useMultiPass) showCostEstimate(codebaseContext, 'poi', model);

  // ── Agent Planner — recon + cost estimate before any analysis ──────────────
  let reconPlan = null;
  try {
    const reconSpinner = ora({ text: chalk.gray('Ghost is sizing up your codebase...'), color: 'cyan' }).start();
    reconPlan = await runRecon(fileMap, 'poi', {});
    reconSpinner.stop();

    const display = formatPlanForDisplay(reconPlan);

    console.log('\n' + boxen(
      chalk.cyan.bold('🔍 ANALYSIS PLAN') + '\n\n' +
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
        ? '\n\n' + chalk.gray('Starting at: ') + chalk.cyan(display.entryPoint)
        : ''),
      { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
    ));
    console.log('');
  } catch {
    // Planner failure is non-fatal — continue without it
    console.log(chalk.gray('  (Recon unavailable — proceeding with standard scan)\n'));
  }

  const { proceed } = await inquirer.prompt([{
    type: 'confirm', name: 'proceed',
    message: chalk.cyan('Proceed with scan?'), default: true
  }]);
  if (!proceed) { console.log(chalk.gray('\nScan cancelled.\n')); return; }

  // Smart project label prompt — shows existing projects, fuzzy matches, confirms
  const label = await promptProjectLabel();
  console.log('');

  let buffer  = '';
  let started = false;

  try {
    if (useMultiPass) {
      const multiResult = await runMultiPassPOI(fileMap, label || 'project', (chunk) => {
        if (!started) { started = true; console.log(''); }
        buffer += chunk;
        process.stdout.write(colorizeOutput(chunk));
      });

      if (!multiResult) {
        // fall through
      } else if (multiResult.saved) {
        console.log(chalk.cyan(`\n  Session saved — run Ghost again to continue from where you left off.\n`));
        return;
      } else if (multiResult.finalReport) {
        buffer = multiResult.finalReport;
        console.log('\n');
        console.log(chalk.cyan(
          `  ✓ Multi-pass complete — ${multiResult.passCount} passes, ` +
          `${multiResult.coverage}% of ${multiResult.totalFiles} files analyzed\n`
        ));
      }

    } else {
      const spinner = ora({ text: chalk.gray('Ghost is reading your project...'), color: 'cyan' }).start();
      await runPOIScan(codebaseContext, (chunk) => {
        if (!started) { spinner.stop(); started = true; console.log(''); }
        buffer += chunk;
        process.stdout.write(colorizeOutput(chunk));
      });
      console.log('\n');
    }

    if (!buffer) return;

    // Cost
    const inputTokens  = Math.ceil(codebaseContext.context.length / 4) + 200;
    const outputTokens = Math.ceil(buffer.length / 4);
    showActualCost(inputTokens, outputTokens, model);

    // Project Intelligence — auto-compare against baseline
    if (label) {
      const meta = {
        filesAnalyzed: `${codebaseContext.loadedFiles} of ${codebaseContext.totalFiles}`,
        rates,
      };
      await handleProjectIntelligence(label, buffer, meta);
    }

    // Save
    const { doSave } = await inquirer.prompt([{
      type: 'confirm', name: 'doSave',
      message: chalk.cyan('Save this report to ~/Ghost Architect Reports/?'), default: true
    }]);

    if (doSave) {
      const meta = {
        filesAnalyzed: `${codebaseContext.loadedFiles} of ${codebaseContext.totalFiles}`,
        totalFiles: codebaseContext.totalFiles,
        cost: `$${(inputTokens * 0.000003 + outputTokens * 0.000015).toFixed(4)}`,
        version: '3.2.1'
      };
      const saved = await saveReport(buffer, 'ghost-poi', label, meta);
      console.log(chalk.green(`\n✓ Reports saved to ~/Ghost Architect Reports/`));
      console.log(chalk.gray(`  📄 ${saved.txtFile}`));
      console.log(chalk.gray(`  📋 ${saved.mdFile}`));
      if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
      console.log('');
    }

  } catch (err) {
    showFriendlyError(err);
  }
}

function colorizeOutput(text) {
  return text
    .replace(/🔴 RED FLAGS/g, chalk.red.bold('🔴 RED FLAGS'))
    .replace(/🏛️ LANDMARKS/g, chalk.blue.bold('🏛️  LANDMARKS'))
    .replace(/⚰️ DEAD ZONES/g, chalk.gray.bold('⚰️  DEAD ZONES'))
    .replace(/⚡ FAULT LINES/g, chalk.yellow.bold('⚡ FAULT LINES'))
    .replace(/📊 REMEDIATION SUMMARY/g, chalk.cyan.bold('📊 REMEDIATION SUMMARY'))
    .replace(/CRITICAL/g, chalk.bgRed.white.bold(' CRITICAL '))
    .replace(/\bHIGH\b/g, chalk.red.bold('HIGH'))
    .replace(/\bMEDIUM\b/g, chalk.yellow.bold('MEDIUM'))
    .replace(/\bLOW\b/g, chalk.green.bold('LOW'))
    .replace(/Effort:/g, chalk.cyan('Effort:'))
    .replace(/Complexity:/g, chalk.cyan('Complexity:'))
    .replace(/Recommended fix:/g, chalk.green.bold('Recommended fix:'))
    .replace(/Fix priority:/g, chalk.yellow('Fix priority:'));
}
