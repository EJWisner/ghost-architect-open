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
import { promptProjectLabel } from '../projects.js';

// ── Target selection ────────────────────────────────────────────────────────
//
// pickBlastTargets returns either:
//   - a string: a single file/class/method name (free-text workflow)
//   - an array of strings: one or more selected file paths (picker workflow)
//
// The picker uses a two-step pattern that scales to large repos without
// adding any new dependencies on top of inquirer 9:
//   1. Optional filter substring (skip = show all). With ≤2000 files this is
//      cosmetic; with 10,000+ it's how a user actually narrows down.
//   2. Multi-select checkbox of files matching the filter, with a hard cap
//      so an unfiltered checkbox in a giant repo doesn't paint thousands of
//      lines of terminal output.
//
// The free-text path is preserved as a separate first-question option
// because typing a class name or method name is a legitimate workflow
// ("what's the blast radius if I rename `migrateToSecureStorage`?") and
// shouldn't be sacrificed for the picker.

const PICKER_HARD_CAP = 200; // max files shown in a single checkbox prompt

// Paths that are essentially never legitimate blast-radius targets. The user
// rarely wants to ask "what happens if I change a file inside node_modules".
// Scan-time --exclude flags are separate; this is purely a UI filter on the
// picker so the list isn't drowned in third-party dependencies. The full
// fileIndex is still passed to the model for context.
const PICKER_HIDE_PATTERNS = [
  /(?:^|\/)node_modules\//,
  /(?:^|\/)vendor\//,
  /(?:^|\/)\.git\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /(?:^|\/)\.next\//,
  /(?:^|\/)coverage\//,
  /(?:^|\/)\.cache\//,
  /\.lock$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
];

function isPickerHidden(filePath) {
  for (const re of PICKER_HIDE_PATTERNS) {
    if (re.test(filePath)) return true;
  }
  return false;
}

async function pickBlastTargets(files) {
  // Apply the picker UI filter once up front. Hidden paths (node_modules,
  // vendor, build outputs, lock files) are still in the codebase context
  // for the model, but they don't clutter the picker.
  const visibleFiles = files.filter(f => !isPickerHidden(f));
  const totalFiles = visibleFiles.length;
  const hiddenCount = files.length - visibleFiles.length;

  if (totalFiles === 0) {
    // Edge case: every file matched a hidden pattern (e.g. someone scanned
    // a folder containing only node_modules). Fall back to free-text input
    // rather than presenting an empty checkbox.
    console.log(chalk.yellow(
      `  All ${files.length} files match the picker's hidden patterns ` +
      `(node_modules, vendor, build outputs, lock files). ` +
      `Switching to free-text target entry.\n`
    ));
    const { target } = await inquirer.prompt([{
      type: 'input',
      name: 'target',
      message: chalk.cyan('Analyze impact of changing:'),
      validate: (v) => v.trim().length > 0 ? true : 'Please enter a file, class, or method name'
    }]);
    return target.trim();
  }

  const hiddenNote = hiddenCount > 0
    ? ` (${hiddenCount} dependency/build file${hiddenCount === 1 ? '' : 's'} hidden)`
    : '';

  const { mode } = await inquirer.prompt([{
    type: 'list',
    name: 'mode',
    message: chalk.cyan('How would you like to pick targets?'),
    choices: [
      { name: `Pick file(s) from the project (${totalFiles} files available${hiddenNote})`, value: 'pick' },
      { name: 'Type a custom target (class name, method name, or file path)', value: 'custom' },
    ],
  }]);

  if (mode === 'custom') {
    const { target } = await inquirer.prompt([{
      type: 'input',
      name: 'target',
      message: chalk.cyan('Analyze impact of changing:'),
      validate: (v) => v.trim().length > 0 ? true : 'Please enter a file, class, or method name'
    }]);
    return target.trim();
  }

  // Picker path. Loop so the user can refine their filter if the first
  // pass returns too many files or zero matches.
  while (true) {
    let { filter } = await inquirer.prompt([{
      type: 'input',
      name: 'filter',
      message: chalk.cyan('Filter file list (optional — substring match, leave blank for all):'),
      default: '',
    }]);
    filter = filter.trim().toLowerCase();

    let pool = filter
      ? visibleFiles.filter(f => f.toLowerCase().includes(filter))
      : visibleFiles.slice();

    if (pool.length === 0) {
      console.log(chalk.yellow(`  No files matched "${filter}". Try a different filter (or leave blank to see all).\n`));
      continue;
    }

    let truncated = false;
    if (pool.length > PICKER_HARD_CAP) {
      console.log(chalk.yellow(
        `  ${pool.length} files matched "${filter || '(all)'}". Showing the first ${PICKER_HARD_CAP}; ` +
        `refine your filter if the file you want isn't in the list.`
      ));
      pool = pool.slice(0, PICKER_HARD_CAP);
      truncated = true;
    }

    const { selected } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'selected',
      message: chalk.cyan(
        `Select file(s) to analyze${truncated ? ' (truncated list)' : ''}:` +
        chalk.gray(' (Space toggles, Enter confirms)')
      ),
      choices: pool.map(f => ({ name: f, value: f })),
      pageSize: Math.min(20, pool.length),
      validate: (arr) => arr.length > 0 ? true : 'Pick at least one file (Space toggles selection).',
    }]);

    return selected;
  }
}

export async function runBlastMode(codebaseContext, options = {}) {
  // Ghost Partner — consultant profile (null when --profile was not passed).
  // Threaded through to the analyst (consultant lens in prompt + narrator)
  // and through saveReport meta (white-label cover + chrome in the PDF).
  const profile = options.profile || null;

  console.log('\n' + boxen(
    chalk.cyan.bold('💥 BLAST RADIUS ANALYSIS') + '\n' +
    chalk.gray('Pick one or more files to analyze, or type a class/method name.\nMulti-file selection produces ONE combined impact map.') +
    (profile ? '\n' + chalk.magenta(`👥 Ghost Partner profile: ${profile.name || profile.author || 'loaded'}`) : ''),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));

  console.log('');

  const files = codebaseContext.fileIndex;
  console.log(chalk.gray(`  Project has ${files.length} files.\n`));

  // pickBlastTargets returns either a string (custom target) or an array of
  // file paths (picker selection). The analyst handles both shapes.
  const target = await pickBlastTargets(files);
  const targetCount = Array.isArray(target) ? target.length : 1;

  // Surface what we're about to analyze so the user can sanity-check before
  // we burn API budget. Multi-file selections especially benefit from this
  // because the checkbox prompt scrolls and it's easy to miss a stray space.
  if (Array.isArray(target)) {
    console.log(chalk.gray('\n  Selected for analysis:'));
    target.forEach(f => console.log(chalk.gray(`    • ${f}`)));
    console.log('');
  }

  const model = getConfig().get('defaultModel') || 'claude-sonnet-4-5';
  showCostEstimate(codebaseContext, 'blast', model);

  // ── Agent Planner ─────────────────────────────────────────────────────────
  // The planner takes a focusAreas string. For multi-target we pass a
  // joined summary; for single target we pass it verbatim.
  const focusAreas = Array.isArray(target) ? target.join(', ') : target;
  try {
    const reconSpinner = ora({ text: chalk.gray('Ghost is sizing up your codebase...'), color: 'cyan' }).start();
    const reconPlan    = await runRecon(codebaseContext.fileMap || {}, 'blast', { focusAreas });
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

  // Smart project label prompt — same UX as POI. The project label is what
  // groups scans together on the portal and in team-sync. Without this,
  // Blast was saving under a target-derived synthetic label like
  // "change-set-4-files" which broke project grouping entirely. The
  // change-set descriptor is now folded into meta instead.
  const label = await promptProjectLabel();
  console.log('');

  const { proceed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'proceed',
    message: chalk.cyan('Proceed with analysis?'),
    default: true
  }]);
  if (!proceed) { console.log(chalk.gray('\nAnalysis cancelled.\n')); return; }

  console.log('');

  // Spinner copy reflects single vs change-set framing. We check
  // targetCount, not Array.isArray(target), because the picker always
  // returns an array — even for a single selection. "Mapping combined
  // blast radius across 1 files" was the buggy fallout from checking
  // isArray; the count is the real signal.
  const spinnerLabel = targetCount > 1
    ? `Mapping combined blast radius across ${targetCount} files`
    : `Mapping blast radius for: ${Array.isArray(target) ? target[0] : target}`;

  const spinner = ora({
    text: chalk.gray(spinnerLabel),
    color: 'cyan'
  }).start();

  let buffer = '';

  try {
    // Streaming-to-stdout was causing the report to scroll off-screen
    // before the user could read it (POI mode hit the same problem and
    // we fixed it the same way). The chunk handler still buffers the
    // text — we just don't paint it to the terminal as it arrives.
    // The spinner stays on screen the whole time and gives a clear
    // "still working" signal. The full report lives in `buffer` and
    // is what we save to disk; the user reads it from the saved files.
    const result = await runBlastRadius(
      codebaseContext,
      target,
      (chunk) => { buffer += chunk; },
      {
        onNarratorStart: () => {
          spinner.text = chalk.gray('Ghost is writing the blast radius report...');
        },
        profile,  // Ghost Partner — threads consultant lens into prompt + narrator
      }
    );

    spinner.succeed(chalk.green('Blast radius report ready'));
    console.log('');

    const inputTokens  = Math.ceil(codebaseContext.context.length / 4) + 300;
    const outputTokens = Math.ceil(result.length / 4);
    showActualCost(inputTokens, outputTokens, model);

    const { doSave } = await inquirer.prompt([{
      type: 'confirm', name: 'doSave',
      message: chalk.cyan('Save this analysis to ~/Ghost Architect Reports/?'), default: true
    }]);

    if (doSave) {
      // The saveLabel is the project label — this is what groups scans
      // across modes for the same project on the portal, in team-sync,
      // and in mobile-publish. When the user gave a label, use it. When
      // they skipped (label = null = one-time scan), fall back to the
      // target-derived synthetic label so the file is still uniquely
      // named on disk.
      const fallbackLabel = targetCount > 1
        ? `change-set-${targetCount}-files`
        : (Array.isArray(target) ? target[0] : target);
      const saveLabel = label || fallbackLabel;

      // changeSet captures what was actually analyzed — the file list or
      // free-text target — so the report header can show it even though
      // the file name now uses the project label. The narrator already
      // bakes this into the report body; meta carries it forward for
      // downstream renderers (PDF cover page, manifest entry, etc.).
      const changeSet = Array.isArray(target) ? target : [target];

      // Meta drives PDF chrome and markdown branding. The `profile` field is
      // what flips PDF rendering into white-label mode — saveReport calls
      // getBranding(meta.profile) and threads the result into the PDF
      // generator. When profile is null, default Ghost branding renders.
      const meta = {
        filesAnalyzed: codebaseContext.totalFiles
          ? `${codebaseContext.loadedFiles} of ${codebaseContext.totalFiles}`
          : `${codebaseContext.loadedFiles || 0}`,
        totalFiles: codebaseContext.totalFiles,
        profile,
        changeSet,
        targetCount,
      };

      const saved = await saveReport(buffer, 'ghost-blast', saveLabel, meta);
      console.log(chalk.green(`\n${SYM.check} Reports saved to ~/Ghost Architect Reports/`));
      console.log(chalk.gray(`  📄 ${saved.txtFile}`));
      console.log(chalk.gray(`  📋 ${saved.mdFile}`));
      if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
      console.log('');
    } else {
      // Even if the user declines to save, give them one last clear
      // signal that a report exists — it's been buffered but not
      // streamed, so they may not realize it ran at all.
      console.log(chalk.gray(`\n  (Report not saved. ${buffer.length.toLocaleString()} characters were generated.)\n`));
    }

    const { another } = await inquirer.prompt([{
      type: 'confirm', name: 'another',
      message: chalk.cyan('Analyze another target?'), default: false
    }]);
    if (another) return await runBlastMode(codebaseContext, options);

  } catch (err) {
    spinner.fail(chalk.red('Blast radius analysis failed'));
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
