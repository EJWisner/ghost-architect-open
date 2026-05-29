/**
 * Ghost Architect™ — Commit Forecast Mode (CLI layer)
 *
 * Thin CLI wrapper around src/core/forecast-overlay.js (synthesis primitive),
 * src/analyst/index.js (Blast analysis), and src/core/conflict.js (Conflict
 * analysis). Follows the exact same layering contract as blast.js and
 * conflict.js: all prompts, spinners, and display live here; all analysis
 * logic lives in the analyst and core modules.
 *
 * TWO ENTRY SURFACES, ONE CODE PATH:
 *   1. Pre-commit: user confirms current branch, Ghost auto-discovers working-
 *      tree changes via `git diff --name-only HEAD` + untracked files, treats
 *      the working directory as the "proposed folder."
 *   2. Offline/received files: user points Ghost at an explicit folder of
 *      proposed files that mirrors the repo's relative directory structure.
 *
 * TIER GATING:
 *   Open: 1 free Commit Forecast per install (FORECAST_QUOTA). Counter is
 *   separate from the 4-scan POI/Blast/Conflict quota (see freemium.js).
 *   Pro+: unlimited.
 */

import chalk from 'chalk';
import boxen from 'boxen';
import ora   from 'ora';
import inquirer from 'inquirer';
import fs   from 'fs';
import path from 'path';
import os   from 'os';

import { showFriendlyError }   from '../utils/errors.js';
import { runBlastRadius }      from '../analyst/index.js';
import { runConflictScan, getConflictPassInfo } from '../core/conflict.js';
import { showCostEstimate, showActualCost } from '../estimator.js';
import { getConfig }           from '../config.js';
import { saveReport }          from '../reports.js';
import { requireTier }         from '../license/tier-gates.js';
import { hasShownCallout, markCalloutShown } from '../cli/session-state.js';
import { promptProjectLabel }  from '../projects.js';
import { extractFindings }     from '../utils/finding-parser.js';
import {
  buildForecastOverlay,
  discoverWorkingTreeChanges,
  isGitRepo,
} from '../core/forecast-overlay.js';
import { runMultipassBlast, getBlastPassInfo } from '../core/blast-multipass.js';
import {
  getForecastCount,
  incrementForecastCount,
  renderForecastPaywall,
} from '../freemium.js';
import { renderForecastDiff } from '../utils/diff-renderer.js';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };

// ── Tier gate check ───────────────────────────────────────────────────────────

/**
 * Returns true if the user is allowed to run a Commit Forecast.
 * Emits the paywall and returns false if they're blocked.
 * paywallPromo is the worker-driven promo string (may be empty).
 */
function checkForecastGate(tier, paywallPromo = '') {
  // Pro+ are always allowed — no counter needed.
  if (tier !== 'open') return true;

  const used   = getForecastCount();
  const result = requireTier('mode:commit-forecast', {
    tier,
    forecastsUsed: used,
  });

  if (!result.allowed) {
    renderForecastPaywall(paywallPromo);
    return false;
  }
  return true;
}

// ── Working-tree surface helpers ──────────────────────────────────────────────

/**
 * Resolve the baseline root from a codebaseContext (the directory path that
 * was loaded). We need it to know where to look for working-tree files.
 * Derived from the common prefix of fileMap keys — same logic as
 * forecast-overlay.js's resolveBaselineRoot().
 */
function resolveBaselineRoot(fileMap) {
  const keys = Object.keys(fileMap);
  if (keys.length === 0) return null;
  const segmented = keys.map(k => k.split(path.sep));
  const first = segmented[0];
  let commonLen = first.length;
  for (const segs of segmented) {
    let i = 0;
    while (i < commonLen && i < segs.length && segs[i] === first[i]) i++;
    commonLen = i;
  }
  if (commonLen === 0) return null;
  return first.slice(0, commonLen).join(path.sep) || null;
}

// ── Surface selection ─────────────────────────────────────────────────────────

async function selectForecastSurface(codebaseContext) {
  const fileMap     = codebaseContext.fileMap || {};
  // Derive the baseline root from the fileMap key prefix. When context is
  // truncated (token cap hit), only a subset of files loaded — the common
  // prefix may resolve to a subdirectory (e.g. src/) rather than the repo
  // root. Fall back through: fileMap prefix → process.cwd() → null.
  let baseRoot = resolveBaselineRoot(fileMap);
  let hasGit   = baseRoot ? isGitRepo(baseRoot) : false;

  if (!hasGit) {
    // fileMap root didn't have git — try cwd directly (handles worktrees
    // and truncated loads where prefix resolves to a subdir).
    const cwd = process.cwd();
    if (isGitRepo(cwd)) {
      baseRoot = cwd;
      hasGit   = true;
    }
  }

  const choices = [];

  if (hasGit && baseRoot) {
    choices.push({
      name: `Pre-commit forecast  — analyze my current working-tree changes vs HEAD (${baseRoot})`,
      value: 'precommit',
    });
  }

  choices.push({
    name: 'Offline / received files  — point Ghost at a folder of proposed files',
    value: 'folder',
  });

  if (choices.length === 1) {
    // No git repo detected — skip the choice, go straight to folder mode.
    console.log(chalk.yellow('  (No git repository detected — using folder mode.)\n'));
    return { surface: 'folder', baseRoot };
  }

  const { surface } = await inquirer.prompt([{
    type: 'list',
    name: 'surface',
    message: chalk.cyan('What would you like to forecast?'),
    choices,
  }]);

  return { surface, baseRoot };
}

// ── Proposed folder input ─────────────────────────────────────────────────────

async function promptProposedFolder() {
  while (true) {
    const { folderPath } = await inquirer.prompt([{
      type: 'input',
      name: 'folderPath',
      message: chalk.cyan("Path to folder of proposed files (mirrors repo structure):"),
      validate: (v) => v.trim().length > 0 ? true : 'Path is required',
    }]);
    const trimmed = folderPath.trim();
    if (!fs.existsSync(trimmed)) {
      console.log(chalk.yellow(`  Directory not found: ${trimmed}\n`));
      continue;
    }
    if (!fs.statSync(trimmed).isDirectory()) {
      console.log(chalk.yellow(`  That path is a file, not a directory. Try again.\n`));
      continue;
    }
    return trimmed;
  }
}

// ── Diff display ──────────────────────────────────────────────────────────────

function renderChangedFilesBox(changedFiles, surface) {
  const { modified, added } = changedFiles;
  const total = modified.length + added.length;

  if (total === 0) {
    console.log(chalk.yellow('\n  No changed files detected in the proposed set.\n'));
    return false;
  }

  const lines = [
    chalk.cyan.bold(`🔮 COMMIT FORECAST — ${total} file${total === 1 ? '' : 's'} in scope`),
    chalk.gray(surface === 'precommit'
      ? 'Working-tree changes vs HEAD'
      : 'Proposed folder vs baseline'),
    '',
  ];

  if (modified.length > 0) {
    lines.push(chalk.yellow(`  Modified (${modified.length}):`));
    for (const f of modified.slice(0, 20)) {
      lines.push(chalk.gray(`    ~ ${path.basename(f)}  `) + chalk.dim(path.dirname(f)));
    }
    if (modified.length > 20) {
      lines.push(chalk.gray(`    ... and ${modified.length - 20} more`));
    }
  }

  if (added.length > 0) {
    if (modified.length > 0) lines.push('');
    lines.push(chalk.green(`  New files (${added.length}):`));
    for (const f of added.slice(0, 10)) {
      lines.push(chalk.gray(`    + ${path.basename(f)}  `) + chalk.dim(path.dirname(f)));
    }
    if (added.length > 10) {
      lines.push(chalk.gray(`    ... and ${added.length - 10} more`));
    }
  }

  console.log('\n' + boxen(lines.join('\n'), {
    padding: 1,
    borderColor: 'cyan',
    borderStyle: 'round',
  }));
  console.log('');
  return true;
}

// ── Analysis mode selection ───────────────────────────────────────────────────

async function selectAnalysisMode() {
  const { analysisMode } = await inquirer.prompt([{
    type: 'list',
    name: 'analysisMode',
    message: chalk.cyan('What do you want to forecast?'),
    choices: [
      {
        name: 'Blast Radius + Conflict  — full impact forecast (recommended)',
        value: 'both',
      },
      {
        name: 'Blast Radius only  — dependency and ripple impact',
        value: 'blast',
      },
      {
        name: 'Conflict only  — contract and schema conflicts',
        value: 'conflict',
      },
    ],
  }]);
  return analysisMode;
}
// ── Main export ───────────────────────────────────────────────────────────────

export async function runCommitForecastMode(codebaseContext, options = {}) {
  const profile      = options.profile || null;
  const tier         = options.tier    || 'open';
  const paywallPromo = options.paywallPromo || '';

  // NOTE: Forecast quota gate is checked at dispatch in bin/ghost.js before
  // this function is called. No need to re-check here.

  // ── Project tracking gate (D4) ──────────────────────────────────────────
  // Pro+: label prompt fires, portal publish / team-sync side effects active.
  // Open: label stays null, four labeled-save side effects short-circuit.
  const projectIntelGate    = requireTier('feature:project-tracking', { tier });
  const projectIntelEnabled = projectIntelGate.allowed;

  console.log('\n' + boxen(
    chalk.cyan.bold('🔮 COMMIT FORECAST') + '\n' +
    chalk.gray(
      'Ghost analyzes your proposed changes against the production codebase\n' +
      'and forecasts the Blast Radius and Conflict impact before you push.\n' +
      'Ghost does not apply changes. Ghost does not commit. Ghost does not push.'
    ) +
    (profile ? '\n' + chalk.magenta(`👥 Ghost Partner profile: ${profile.name || profile.author || 'loaded'}`) : ''),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  // ── Surface selection ───────────────────────────────────────────────────
  const { surface, baseRoot } = await selectForecastSurface(codebaseContext);

  let proposedDir;

  if (surface === 'precommit') {
    console.log(chalk.gray(`\n  Discovering working-tree changes in ${baseRoot}...\n`));

    const changedPaths = discoverWorkingTreeChanges(baseRoot);
    if (changedPaths.length === 0) {
      console.log(chalk.yellow(
        '  No working-tree changes detected (nothing differs from HEAD, no untracked code files).\n' +
        '  Stage some changes or switch to "Offline / received files" mode.\n'
      ));
      return;
    }
    console.log(chalk.gray(`  Found ${changedPaths.length} changed/new file(s) in working tree.\n`));

    // Build a temp directory mirroring only the changed files so buildForecastOverlay
    // sees just the proposed set, not the entire working tree. Without this,
    // passing baseRoot as proposedDir causes collectFiles() to walk all 185 files
    // and treat every one as a proposed change.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-precommit-'));
    try {
      for (const absPath of changedPaths) {
        const rel    = path.relative(baseRoot, absPath);
        const dest   = path.join(tmpDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(absPath)) {
          fs.copyFileSync(absPath, dest);
        }
      }
      proposedDir = tmpDir;
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.log(chalk.red(`\n  Failed to stage working-tree files: ${err.message}\n`));
      return;
    }
  } else {
    // Offline/folder surface: user points Ghost at an explicit folder.
    proposedDir = await promptProposedFolder();
    console.log('');
  }

  // ── Build overlay ───────────────────────────────────────────────────────
  // Track whether proposedDir is a temp dir we created (pre-commit surface)
  // so we can clean it up after the overlay is built.
  const isTempDir = surface === 'precommit';

  const overlaySpinner = ora({
    text: chalk.gray('Building forecast overlay...'),
    color: 'cyan',
  }).start();

  let patchedContext, changedFiles;
  try {
    ({ patchedContext, changedFiles } = await buildForecastOverlay(
      codebaseContext,
      proposedDir,
      { tier, profile, verbose: false }
    ));
    overlaySpinner.stop();
  } catch (err) {
    overlaySpinner.stop();
    if (isTempDir) fs.rmSync(proposedDir, { recursive: true, force: true });
    console.log(chalk.red(`\n  Forecast overlay failed: ${err.message}\n`));
    return;
  }
  // Clean up temp dir now that overlay is built — contents are in memory.
  if (isTempDir) fs.rmSync(proposedDir, { recursive: true, force: true });

  // ── Diff display ────────────────────────────────────────────────────────
  const hasChanges = renderChangedFilesBox(changedFiles, surface);
  if (!hasChanges) return;

  // Offer inline diff detail before analysis. Optional — skip if the user
  // already knows what they changed and just wants the forecast.
  const { showDiff } = await inquirer.prompt([{
    type: 'confirm',
    name: 'showDiff',
    message: chalk.cyan('Show inline diff of proposed changes before analysis?'),
    default: false,
  }]);
  if (showDiff) {
    renderForecastDiff(changedFiles, codebaseContext.fileMap || {}, patchedContext.fileMap || {});
  }

  // ── Project label (Pro+ only, D4) ───────────────────────────────────────
  // Mirrors blast.js / conflict.js pattern exactly. On Open, label stays
  // null so all four labeled-save side effects in saveReport short-circuit.
  let label = null;
  if (projectIntelEnabled) {
    label = await promptProjectLabel();
    console.log('');
  } else if (!hasShownCallout('feature:project-tracking')) {
    console.log(chalk.cyan('💡 Project tracking available on Pro. Forecasts run as one-shots on Open.'));
    console.log('');
    markCalloutShown('feature:project-tracking');
  }

  // ── Cost estimate ───────────────────────────────────────────────────────
  // Show AFTER mode selection so label matches what was picked, and so we
  // can show the conflict pass count when relevant.
  const model = getConfig().get('defaultModel') || 'claude-sonnet-4-6';

  // ── Analysis mode ───────────────────────────────────────────────────────
  const analysisMode = await selectAnalysisMode();
  console.log('');

  // Show cost estimate now that we know what was selected.
  const estBlastTokens = Math.ceil(patchedContext.context.length / 4);
  const fileMap = patchedContext.fileMap || {};
  const blastInfo = (analysisMode === 'blast' || analysisMode === 'both')
    ? getBlastPassInfo(fileMap, tier)
    : null;
  const blastMultipass = blastInfo && !blastInfo.singlePass;

  if (blastInfo) {
    if (blastMultipass) {
      console.log(chalk.cyan(
        `  Blast Radius: ~${blastInfo.passCount} passes` +
        `  ·  Est. cost: ~$${blastInfo.estCost}  ·  Est. time: ~${blastInfo.estMinutes} min`
      ));
    } else {
      showCostEstimate(patchedContext, 'blast', model);
    }
  }
  if (analysisMode === 'conflict' || analysisMode === 'both') {
    const conflictInfo = getConflictPassInfo(fileMap, tier);
    console.log(chalk.gray(
      `  Conflict: ~${conflictInfo.passes.length} pass${conflictInfo.passes.length === 1 ? '' : 'es'}` +
      `  ·  Est. cost: ~$${conflictInfo.estCost}  ·  Est. time: ~${conflictInfo.estMinutes} min`
    ));
  }
  console.log('');

  // ── Blast Radius ────────────────────────────────────────────────────────
  let blastBuffer = '';

  if (analysisMode === 'blast' || analysisMode === 'both') {
    // For Commit Forecast, the "target" is the changed file set — we pass
    // the list of modified+added files as the blast target so the analyst
    // frames the analysis as "what happens if these proposed changes land."
    const forecastTarget = [...changedFiles.modified, ...changedFiles.added];
    const targetLabel = forecastTarget.length === 1
      ? forecastTarget[0]
      : `${forecastTarget.length} proposed files`;

    const { proceed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'proceed',
      message: chalk.cyan(`Run Blast Radius forecast?${blastMultipass ? chalk.gray(` (${blastInfo.passCount} passes)`) : ''}`),
      default: true,
    }]);

    if (!proceed) {
      console.log(chalk.gray('\n  Blast Radius skipped.\n'));
    } else if (blastMultipass) {
      // ── Multi-pass Blast ────────────────────────────────────────────────
      let blastSpinner = ora({ text: chalk.gray('Starting Blast Radius forecast...'), color: 'cyan' }).start();
      try {
        blastBuffer = await runMultipassBlast(patchedContext, forecastTarget, {
          tier,
          profile,
          forecastMode: true,
          onPassStart: (passNum, total) => {
            if (blastSpinner) blastSpinner.stop();
            blastSpinner = ora({ text: chalk.gray(`  Pass ${passNum} of ${total}...`), color: 'cyan' }).start();
          },
          onPassComplete: (passNum, total) => {
            if (blastSpinner) { blastSpinner.stop(); blastSpinner = null; }
            console.log(chalk.green(`  ${SYM.check} Pass ${passNum} complete`));
          },
          onSynthesisStart: () => {
            blastSpinner = ora({ text: chalk.gray('  Synthesizing blast radius results...'), color: 'cyan' }).start();
          },
        });
        if (blastSpinner) { blastSpinner.stop(); blastSpinner = null; }
        console.log(chalk.green(`\n  ${SYM.check} Blast Radius forecast ready\n`));
      } catch (err) {
        if (blastSpinner) blastSpinner.stop();
        console.log(chalk.red('  Blast Radius forecast failed'));
        showFriendlyError(err);
      }
    } else {
      // ── Single-pass Blast ───────────────────────────────────────────────
      const blastSpinner = ora({
        text: chalk.gray(`Mapping blast radius for ${targetLabel}...`),
        color: 'cyan',
      }).start();

      try {
        await runBlastRadius(
          patchedContext,
          forecastTarget,
          (chunk) => { blastBuffer += chunk; },
          {
            onNarratorStart: () => {
              blastSpinner.text = chalk.gray('Ghost is writing the blast radius forecast...');
            },
            profile,
            forecastMode: true,
          }
        );
        blastSpinner.succeed(chalk.green('Blast Radius forecast ready'));
        console.log('');

        const inputTokens  = Math.ceil(patchedContext.context.length / 4) + 300;
        const outputTokens = Math.ceil(blastBuffer.length / 4);
        showActualCost(inputTokens, outputTokens, model);
        console.log('');
      } catch (err) {
        blastSpinner.fail(chalk.red('Blast Radius forecast failed'));
        showFriendlyError(err);
      }
    }
  } // end blast section

  // ── Conflict Detection ──────────────────────────────────────────────────
  let conflictBuffer = '';

  if (analysisMode === 'conflict' || analysisMode === 'both') {
    const info = getConflictPassInfo(fileMap, tier);

    console.log(chalk.magenta.bold('  ⚡ Running Conflict forecast on proposed changes...\n'));

    const { proceedConflict } = await inquirer.prompt([{
      type: 'confirm',
      name: 'proceedConflict',
      message: chalk.cyan('Run Conflict Detection forecast?'),
      default: true,
    }]);
    if (!proceedConflict) {
      console.log(chalk.gray('\n  Conflict Detection skipped.\n'));
    } else {
      let conflictSpinner = ora({
        text: chalk.gray('Ghost is starting the conflict forecast...'),
        color: 'magenta',
      }).start();

      try {
        const callbacks = {
          onChunk(text) { conflictBuffer += text; },

          onProgress({ type, ...data }) {
            switch (type) {
              case 'start':
                if (conflictSpinner) { conflictSpinner.stop(); conflictSpinner = null; }
                conflictSpinner = ora({ text: chalk.gray('Scanning for conflicts in proposed changes...'), color: 'magenta' }).start();
                break;
              case 'passStart':
                if (conflictSpinner) { conflictSpinner.stop(); conflictSpinner = null; }
                conflictSpinner = ora({
                  text: chalk.gray(`  Pass ${data.passNum} of ${data.totalPasses}...`),
                  color: 'magenta',
                }).start();
                break;
              case 'passComplete':
                if (conflictSpinner) { conflictSpinner.stop(); conflictSpinner = null; }
                console.log(chalk.green(`  ${SYM.check} Pass ${data.passNum} complete`));
                break;
              case 'candidates_found':
                if (conflictSpinner) conflictSpinner.stop();
                if (tier !== 'open') {
                  console.log(chalk.cyan(`\n  🔍 ${data.count} conflict candidates found — verifying...\n`));
                }
                break;
              case 'verifying':
                if (tier !== 'open') {
                  process.stdout.write(chalk.gray(`  ⟳  Verifying: ${data.title.slice(0, 60)}...\r`));
                }
                break;
              case 'verified': {
                // On Open tier, suppress per-candidate output entirely —
                // context cap means all results are UNCLEAR which is
                // confusing and not useful. Pro+ sees confirmed/possible/eliminated.
                if (tier === 'open') break;
                const icon =
                  data.verdict === 'CONFIRMED'     ? chalk.red('  ' + SYM.cross + '  CONFIRMED') :
                  data.verdict === 'POSSIBLE'       ? chalk.yellow('  ?  POSSIBLE ') :
                  data.verdict === 'FALSE_POSITIVE' ? chalk.green('  ' + SYM.check + '  ELIMINATED') :
                                                      chalk.gray('  ~  UNCLEAR  ');
                console.log(`${icon}  ${chalk.gray(data.title.slice(0, 55))}`);
                break;
              }
              case 'verification_done':
                console.log('');
                if (tier === 'open') {
                  // On Open tier we auto-skipped verification — no stats to show.
                  // The onVerifyPrompt handler already printed the explanation.
                } else {
                  console.log(
                    chalk.bold('  Verification complete: ') +
                    chalk.red(`${data.stats.confirmed} confirmed  `) +
                    chalk.yellow(`${data.stats.possible} possible  `) +
                    chalk.green(`${data.stats.falsePositives} eliminated`)
                  );
                }
                console.log('');
                if (conflictSpinner) { conflictSpinner.stop(); conflictSpinner = null; }
                conflictSpinner = ora({ text: chalk.gray('  Preparing conflict forecast...'), color: 'magenta' }).start();
                break;
              case 'narrating':
                if (conflictSpinner) { conflictSpinner.stop(); conflictSpinner = null; }
                conflictSpinner = ora({ text: chalk.gray('  Ghost is writing the conflict forecast...'), color: 'magenta' }).start();
                break;
              case 'done':
                if (conflictSpinner) { conflictSpinner.stop(); conflictSpinner = null; }
                console.log('');
                break;
            }
          },

          async onVerifyPrompt({ count, quickCost, fullCost }) {
            // On Open tier, skip verification silently — context cap means
            // results would all be UNCLEAR. No message shown.
            if (tier === 'open') return 'skip';

            console.log(chalk.cyan(`\n  🔍 ${count} conflict candidates found\n`));
            const { choice } = await inquirer.prompt([{
              type: 'list', name: 'choice',
              message: chalk.cyan('Choose verification depth:'),
              choices: [
                { name: `Quick  — fast scan (~$${quickCost})`, value: 'quick' },
                { name: `Full   — deep verification (~$${fullCost})`,  value: 'full' },
                { name: `Skip   — surface all as manual review ($0)`,  value: 'skip' },
              ],
            }]);
            return choice;
          },

          async onSessionPrompt({ session, totalPasses }) {
            const pct = Math.round((session.completedPassCount / totalPasses) * 100);
            console.log(chalk.cyan(`\n📂  Saved session: ${session.projectLabel} — ${pct}% coverage\n`));
            const { action } = await inquirer.prompt([{
              type: 'list', name: 'action',
              message: chalk.cyan('What would you like to do?'),
              choices: [
                { name: `Continue from pass ${session.completedPassCount + 1}`, value: 'resume' },
                { name: 'Generate report from completed passes',                  value: 'report' },
                { name: 'Restart from scratch',                                   value: 'restart' },
              ],
            }]);
            return action;
          },
        };

        const projectLabel = 'forecast-' + new Date().toISOString().slice(0, 10);
        const result = await runConflictScan(fileMap, callbacks, {
          projectLabel,
          profile,
          tier,
          // Thread the forecast framing into every conflict pass prompt.
          forecastContext:
            `The following files have NOT yet been committed — they are proposed changes ` +
            `overlaid on the production baseline. The codebase context already contains ` +
            `their proposed versions.\n` +
            `Changed files: ${[...changedFiles.modified, ...changedFiles.added].map(f => path.basename(f)).join(', ')}\n` +
            `Frame every conflict as "if you push now, X conflicts with Y." ` +
            `Report only conflicts that will be triggered by these proposed changes being ` +
            `present in production. Skip conflicts that exist purely in unchanged files ` +
            `unless they interact with the proposed changes.`,
        });

        if (result?.finalReport) {
          conflictBuffer = result.finalReport;
          if (conflictSpinner) { conflictSpinner.stop(); conflictSpinner = null; }
          console.log(chalk.green(`  ${SYM.check} Conflict forecast ready\n`));

          // Only show verification stats on Pro+ where verification actually ran.
          // On Open tier, verification was skipped — "0 confirmed, 0 possible,
          // 0 eliminated" is confusing when all results were UNCLEAR anyway.
          if (result.verified && result.stats && tier !== 'open') {
            const s = result.stats;
            console.log(chalk.magenta(
              `  👻 Verified ${s.total} candidates — ` +
              `${s.confirmed} confirmed, ${s.possible} possible, ${s.falsePositives} eliminated\n`
            ));
          }

          const inputTokens  = Math.ceil(patchedContext.context.length / 4) + 200;
          const outputTokens = Math.ceil(conflictBuffer.length / 4);
          showActualCost(inputTokens, outputTokens, model);
          console.log('');
        } else {
          if (conflictSpinner) conflictSpinner.stop();
        }

      } catch (err) {
        if (conflictSpinner) conflictSpinner.stop();
        showFriendlyError(err);
      }
    }
  }

  // ── Save ────────────────────────────────────────────────────────────────
  const hasBlast    = blastBuffer.length > 0;
  const hasConflict = conflictBuffer.length > 0;

  if (!hasBlast && !hasConflict) {
    // User skipped or cancelled all analysis — nothing ran, nothing to count.
    // Don't burn the quota on a no-op.
    console.log(chalk.gray('  No forecast output to save.\n'));
    return;
  }

  // Combine outputs into a single forecast report.
  const forecastReport = [
    hasBlast    ? `# BLAST RADIUS FORECAST\n\n${blastBuffer}` : '',
    hasConflict ? `# CONFLICT FORECAST\n\n${conflictBuffer}` : '',
  ].filter(Boolean).join('\n\n---\n\n');

  const { doSave } = await inquirer.prompt([{
    type: 'confirm',
    name: 'doSave',
    message: chalk.cyan('Save this forecast to ~/Ghost Architect Reports/?'),
    default: true,
  }]);

  if (doSave) {
    const parsedFindings = extractFindings(forecastReport);
    const criticalCount  = parsedFindings.filter(f => f.severity === 'CRITICAL').length;
    const highCount      = parsedFindings.filter(f => f.severity === 'HIGH').length;
    const mediumCount    = parsedFindings.filter(f => f.severity === 'MEDIUM').length;
    const lowCount       = parsedFindings.filter(f => f.severity === 'LOW').length;
    const totalHours     = parsedFindings.reduce((sum, f) => sum + (f.effortHours || 0), 0);

    const meta = {
      filesAnalyzed: `${patchedContext.loadedFiles} of ${patchedContext.totalFiles}`,
      totalFiles:    patchedContext.totalFiles,
      mode:          'commit-forecast',
      forecastSurface: surface,
      proposedDir,
      changedFiles,
      profile,
      findings:      parsedFindings,
      findingCount:  parsedFindings.length,
      critical:      criticalCount,
      high:          highCount,
      medium:        mediumCount,
      low:           lowCount,
      totalHours,
    };

    // label is null for Open (no portal side effects) or when user skipped
    // the label prompt. Non-null label (Pro+) activates portal publish,
    // team-sync, and mobile-publish via saveReport's Strategy 2 conditional.
    const saved = await saveReport(forecastReport, 'ghost-forecast', label, meta);
    console.log(chalk.green(`\n${SYM.check} Forecast saved to ~/Ghost Architect Reports/`));
    console.log(chalk.gray(`  📄 ${saved.txtFile}`));
    console.log(chalk.gray(`  📋 ${saved.mdFile}`));
    if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← review-ready PDF`));
    console.log('');
  }

  // ── Increment Open quota AFTER successful analysis ──────────────────────
  // Mirrors the saveReport pattern from POI/Blast/Conflict: counter bumps
  // after the run succeeds, not before. A crashed forecast doesn't burn the
  // credit. Here we bump after output is ready (not after save prompt) because
  // Forecast value is in the analysis itself, not the saved artifact.
  if (tier === 'open') {
    incrementForecastCount();
    const remaining = 0; // FORECAST_QUOTA - 1 = 0 after first use
    console.log(chalk.cyan(
      `💡 You've used your free Commit Forecast. Upgrade to Pro for unlimited Forecasts.\n` +
      `   https://ghostarchitect.dev/pricing`
    ));
    console.log('');
  } else if (!hasShownCallout('feature:project-tracking')) {
    // Pro+ don't need the quota callout. Soft-gate for project tracking if relevant.
    // (Forecast doesn't use project tracking in v1, so skip the callout here.)
  }

  const { again } = await inquirer.prompt([{
    type: 'confirm',
    name: 'again',
    message: chalk.cyan('Run another Commit Forecast?'),
    default: false,
  }]);
  if (again) return await runCommitForecastMode(codebaseContext, options);
}
