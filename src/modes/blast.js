import { showFriendlyError } from '../utils/errors.js';
const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import { runBlastRadius } from '../analyst/index.js';
import { showCostEstimate, showActualCost } from '../estimator.js';
import { getConfig } from '../config.js';
import { saveReport } from '../reports.js';
import { runRecon, formatPlanForDisplay } from '../core/agent/planner.js';

export async function runBlastMode(codebaseContext) {
  console.log('\n' + boxen(
    chalk.cyan.bold('💥 BLAST RADIUS ANALYSIS') + '\n' +
    chalk.gray('Enter a file path, class name, or method name to\nanalyze the impact of changing it.'),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));

  console.log('');

  const MAX_SHOW = 15;
  const files = codebaseContext.fileIndex;
  console.log(chalk.gray(`Sample files from this project (${files.length} total):`));
  files.slice(0, MAX_SHOW).forEach(f => console.log(chalk.gray(`  • ${f}`)));
  if (files.length > MAX_SHOW) {
    console.log(chalk.gray(`  ... and ${files.length - MAX_SHOW} more`));
  }
  console.log('');
  console.log(chalk.gray('  Tip: Enter a filename, class name, or method name from the list above.'));
  console.log('');

  const { target } = await inquirer.prompt([{
    type: 'input',
    name: 'target',
    message: chalk.cyan('Analyze impact of changing:'),
    validate: (v) => v.trim().length > 0 ? true : 'Please enter a file, class, or method name'
  }]);

  const model = getConfig().get('defaultModel') || 'claude-sonnet-4-5';
  showCostEstimate(codebaseContext, 'blast', model);

  // ── Agent Planner ─────────────────────────────────────────────────────────
  try {
    const reconSpinner = ora({ text: chalk.gray('Ghost is sizing up your codebase...'), color: 'cyan' }).start();
    const reconPlan    = await runRecon(codebaseContext.fileMap || {}, 'blast', { focusAreas: target });
    reconSpinner.stop();
    const display = formatPlanForDisplay(reconPlan);

    console.log('\n' + boxen(
      chalk.cyan.bold('🔍 ANALYSIS PLAN') + '\n\n' +
      chalk.white(display.summary || '') + '\n\n' +
      chalk.gray('Files:   ') + chalk.bold(String(display.stats.files)) + '   ' +
      chalk.gray('Est. cost: ') + chalk.bold(display.stats.cost) + '   ' +
      chalk.gray('Est. time: ') + chalk.bold(display.stats.time) +
      (display.risks.length > 0
        ? '\n\n' + chalk.yellow.bold('⚠  High-risk areas:') + '\n' +
          display.risks.slice(0, 4).map(r => chalk.yellow(`   • ${r}`)).join('\n')
        : '') +
      (display.warnings.length > 0
        ? '\n\n' + chalk.yellow.bold('!  Warnings:') + '\n' +
          display.warnings.map(w => chalk.yellow(`   ${w}`)).join('\n')
        : ''),
      { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
    ));
    console.log('');
  } catch {
    console.log(chalk.gray('  (Recon unavailable — proceeding with standard analysis)\n'));
  }

  const { proceed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'proceed',
    message: chalk.cyan('Proceed with analysis?'),
    default: true
  }]);
  if (!proceed) { console.log(chalk.gray('\nAnalysis cancelled.\n')); return; }

  console.log('');

  const spinner = ora({
    text: chalk.gray(`Mapping blast radius for: ${target}`),
    color: 'cyan'
  }).start();

  let buffer  = '';
  let started = false;

  try {
    const result = await runBlastRadius(
      codebaseContext,
      target.trim(),
      (chunk) => {
        if (!started) { spinner.stop(); started = true; console.log(''); }
        buffer += chunk;
        process.stdout.write(colorizeOutput(chunk));
      },
      {
        onNarratorStart: () => {
          spinner.stop();
          console.log(chalk.gray('\n  Ghost is writing the blast radius report...\n'));
        },
      }
    );

    console.log('\n');

    const inputTokens  = Math.ceil(codebaseContext.context.length / 4) + 300;
    const outputTokens = Math.ceil(result.length / 4);
    showActualCost(inputTokens, outputTokens, model);

    const { another } = await inquirer.prompt([{
      type: 'confirm', name: 'another',
      message: chalk.cyan('Analyze another target?'), default: false
    }]);
    if (another) return await runBlastMode(codebaseContext);

    const { doSave } = await inquirer.prompt([{
      type: 'confirm', name: 'doSave',
      message: chalk.cyan('Save this analysis to ~/Ghost Architect Reports/?'), default: true
    }]);

    if (doSave) {
      const saved = await saveReport(buffer, 'ghost-blast', target.trim());
      console.log(chalk.green(`\n${SYM.check} Reports saved to ~/Ghost Architect Reports/`));
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
    .replace(/💥 DIRECT DEPENDENCIES/g, chalk.red.bold('💥 DIRECT DEPENDENCIES'))
    .replace(/🌊 RIPPLE EFFECTS/g, chalk.yellow.bold('🌊 RIPPLE EFFECTS'))
    .replace(/🧨 DANGER ZONES/g, chalk.red.bold('🧨 DANGER ZONES'))
    .replace(/✅ SAFE ZONES/g, chalk.green.bold('✅ SAFE ZONES'))
    .replace(/⚠️ BEFORE YOU TOUCH IT/g, chalk.yellow.bold('⚠️  BEFORE YOU TOUCH IT'))
    .replace(/🛠️ REMEDIATION PLAN/g, chalk.cyan.bold('🛠️  REMEDIATION PLAN'))
    .replace(/\bCRITICAL\b/g, chalk.bgRed.white.bold(' CRITICAL '))
    .replace(/\bHIGH\b/g, chalk.red.bold('HIGH'))
    .replace(/\bMEDIUM\b/g, chalk.yellow.bold('MEDIUM'))
    .replace(/\bLOW\b/g, chalk.green.bold('LOW'))
    .replace(/Estimated effort:/g, chalk.cyan('Estimated effort:'))
    .replace(/Recommended approach:/g, chalk.green.bold('Recommended approach:'))
    .replace(/Testing requirements:/g, chalk.yellow('Testing requirements:'))
    .replace(/Rollback plan:/g, chalk.yellow('Rollback plan:'));
}
