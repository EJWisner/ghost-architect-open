#!/usr/bin/env node

import { createRequire } from 'module';
import chalk from 'chalk';
import gradient from 'gradient-string';
import figlet from 'figlet';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { isConfigured, runSetupWizard, reconfigure, usingEnvKey, resolveApiKey, getConfig, secureConfigFile, getModelChoices } from '../src/config.js';
import { loadCodebase, loadFromPath, setScanOptions } from '../src/loader/index.js';
import { runChatMode } from '../src/modes/chat.js';
import { runQuestionMode, retrieveQuestionBatchResult } from '../src/modes/question.js';
import { runPOIMode } from '../src/modes/poi.js';
import { runBlastMode, retrieveBlastBatchResult } from '../src/modes/blast.js';
import Anthropic from '@anthropic-ai/sdk';
import { getPendingBatches, findPendingBatch, updatePendingBatch, removePendingBatch } from '../src/lib/batch-store.js';
import { formatClockTime } from '../src/lib/transport-meta.js';
import { runReconMode } from '../src/modes/recon.js';
import { runAuditMode } from '../src/modes/audit/index.js';
import { pingModeUsage } from '../src/telemetry/pulse.js';
import { CONTEXT_CAP } from '../src/loader/contextCap.js';
import { listPresets } from '../src/loader/excludes.js';
import fs, { realpathSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { SYM, IS_WINDOWS } from '../src/cli/symbols.js';
// Override Inquirer Unicode symbols on Windows
if (process.platform === 'win32') {
  process.env.FORCE_STDIN_TTY = '1';
}
const inquirerTheme = process.platform === 'win32' ? {
  icon: { cursor: '>' }
} : {};

import { runCompareMode } from '../src/modes/compare.js';
import { runConflictMode, runSavedFixForecast } from '../src/modes/conflict.js';
import { runPromptTriageMode } from '../src/modes/prompt-triage.js';
import { runCommitForecastMode } from '../src/modes/commit-forecast.js';
import { listModelsForPicker } from '../src/prompt-pack/models.js';
import { backChoice, isBack, isBackKeyword } from '../src/cli/prompt-helpers.js';
import { showFriendlyError } from '../src/utils/errors.js';
import { printUpgradeLine } from '../src/cli/upgrade-line.js';

// VERSION is read dynamically from package.json so `npm version` bumps both.
const _require = createRequire(import.meta.url);
const VERSION   = _require('../package.json').version;
const COPYRIGHT = 'Copyright © 2026 Ghost Architect™. All rights reserved.';

// ── CLI argument parsing ────────────────────────────────────────────────────
// Supports:
//   --max-context N             override context cap (clamped to the maximum)
//   --exclude "glob"            exclude paths matching glob (repeatable)
//   --exclude-presets a,b       apply named exclusion preset(s), comma-separated
//   --skip-redaction            continue past a redaction failure instead of
//                               the fail-closed abort (secrets may leak)
//   --help / -h                 print usage and exit
//   --version / -v              print version and exit
function parseArgs(argv) {
  const out = {
    maxContext: null,
    excludes: [],
    presets: [],
    listSessions: false,
    reconfigure: false,
    skipRedaction: false,
    stream: false,
    batch: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--version' || a === '-v') { out.version = true; continue; }
    if (a === '--max-context') {
      const v = argv[++i];
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(chalk.red(`${SYM.cross} --max-context requires a positive integer (got: ${v})`));
        process.exit(2);
      }
      out.maxContext = n;
      continue;
    }
    if (a.startsWith('--max-context=')) {
      const v = a.slice('--max-context='.length);
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(chalk.red(`${SYM.cross} --max-context requires a positive integer (got: ${v})`));
        process.exit(2);
      }
      out.maxContext = n;
      continue;
    }
    if (a === '--exclude') { out.excludes.push(argv[++i] || ''); continue; }
    if (a.startsWith('--exclude=')) { out.excludes.push(a.slice('--exclude='.length)); continue; }
    if (a === '--exclude-presets') {
      const v = argv[++i] || '';
      out.presets.push(...v.split(',').map(s => s.trim()).filter(Boolean));
      continue;
    }
    if (a.startsWith('--exclude-presets=')) {
      const v = a.slice('--exclude-presets='.length);
      out.presets.push(...v.split(',').map(s => s.trim()).filter(Boolean));
      continue;
    }
    // Transport selection — skip the streaming-vs-batch menu and force a choice.
    if (a === '--stream')           { out.stream = true; continue; }
    if (a === '--batch')            { out.batch = true; continue; }
    if (a === '--recover-session')          { out.recoverSession = argv[++i] || ''; continue; }
    if (a.startsWith('--recover-session=')) { out.recoverSession = a.slice('--recover-session='.length); continue; }
    if (a === '--list-sessions')            { out.listSessions = true; continue; }
    if (a === '--sessions-dir')          { out.sessionsDir = argv[++i] || ''; continue; }
    if (a.startsWith('--sessions-dir=')) { out.sessionsDir = a.slice('--sessions-dir='.length); continue; }
    if (a === '--reconfigure')      { out.reconfigure = true; continue; }
    // Escape hatch: bypass the fail-closed redaction abort.
    if (a === '--skip-redaction')   { out.skipRedaction = true; continue; }

    // Commit Forecast non-interactive flags
    if (a === '--baseline')              { out.cfBaseline = argv[++i] || ''; continue; }
    if (a.startsWith('--baseline='))     { out.cfBaseline = a.slice('--baseline='.length); continue; }
    if (a === '--proposed')              { out.cfProposed = argv[++i] || ''; continue; }
    if (a.startsWith('--proposed='))     { out.cfProposed = a.slice('--proposed='.length); continue; }
    if (a === '--modes')                 { out.cfModes = argv[++i] || ''; continue; }
    if (a.startsWith('--modes='))        { out.cfModes = a.slice('--modes='.length); continue; }
    if (a === '--no-verify')             { out.cfNoVerify = true; continue; }
    // Unknown arg — warn but don't crash, preserves interactive usage.
    if (a.startsWith('-')) {
      console.error(chalk.yellow(`⚠ Unknown flag: ${a} (ignored)`));
    }
  }
  return out;
}

function printUsage() {
  const presets = listPresets().join(', ') || '(none)';
  console.log(`
Ghost Architect™: AI-powered codebase archaeology (v${VERSION}, Ghost Open™)
Free for one person. Runs on your own Anthropic API key.

Usage:
  ghost [options]

Options:
  --max-context N          Override context cap in tokens. Clamped to the
                           maximum of ${CONTEXT_CAP.toLocaleString()}.
  --exclude "glob"         Exclude files matching glob pattern (repeatable).
                           Example: --exclude "seeds/**" --exclude "*.fixture.js"
  --exclude-presets a,b    Apply named exclusion preset(s), comma-separated.
                           Available presets: ${presets}

Commit Forecast™ (non-interactive / CI mode):
  --baseline <path>        Path to the baseline codebase directory.
  --proposed <path>        Path to the folder of proposed (changed) files.
  --modes <list>           Comma-separated analysis modes to run.
                           Valid values: blast, conflict, both
                           Example: --modes=blast,conflict  or  --modes=conflict
                           Unknown mode values exit with an error.
  --no-verify              Skip conflict candidate verification step.

  When ALL of --baseline, --proposed, and --modes are present, Commit Forecast™
  runs fully non-interactive. Any missing required flag drops back to the
  interactive prompt flow.

Ghost Brief™:
  --brief                  Convert scan findings into a validated,
                           blast-radius-aware Claude Code prompt pack.
                           Writes ghost-brief.json to the current directory.
                           Requires an existing scan output file.
  --input=<path>           Input findings JSON file (default: ghost-report.json)
  --output=<path>          Output path for ghost-brief.json
                           (default: ghost-brief.json in current directory)

Transport (streaming vs batch):
  --stream                 Run scans live (streaming) and skip the transport menu.
  --batch                  Submit scans to the half-price Message Batches API and
                           skip the transport menu. Retrieve results later.
                           Supported by Blast Radius™ and Question only. Other
                           modes run streaming and print a notice.
  ghost batch-status       List batches you submitted and whether each is ready.
  ghost batch-retrieve <id>
                           Pull a finished batch and produce the same report,
                           sidecar, and PDF a streaming run would have.

Session recovery:
  --recover-session <label>
                           Force-recover a scan for <label> from its checkpoint
                           sidecar on the next run, even if a main session file
                           exists. Use when the saved session is stale or bad.
  --list-sessions          List resumable scan sessions (label, pass progress,
                           started timestamp) from both session locations.
                           Then exit.
  --sessions-dir <path>    Relocate the resume-checkpoint directory for this run
                           (default: ~/Ghost Architect Reports/sessions). Useful
                           when the default location is read-only or unsuitable.

Misc:
  --reconfigure            Open the Reconfigure menu (API key, scan model)
                           without entering the main interactive menu. Then exit.
  --skip-redaction         If secret redaction fails on a file, continue the
                           scan instead of aborting. WARNING: secrets in the
                           affected files may be sent to the API unredacted.
  --version, -v            Print version and exit.
  --help, -h               Print this help and exit.

When flags are omitted, Ghost runs interactively and uses your configured defaults.
`);
}

// ── Banner ──────────────────────────────────────────────────────────────────

function printBanner(opts = {}) {
  // opts.skipClear leaves the screen intact — used on the post-setup call so the
  // setup confirmation the user just saw is not wiped.
  if (!opts.skipClear) console.clear();
  const title = figlet.textSync('GHOST', { font: 'Doom', horizontalLayout: 'default' });
  const ghostGradient = gradient(['#00ffff', '#0088ff', '#004488']);
  console.log(ghostGradient(title));

  console.log(
    chalk.gray('  ') +
    chalk.cyan.bold('ARCHITECT') +
    chalk.gray('  -  AI-powered codebase archaeology') +
    chalk.gray(`  v${VERSION}  [Ghost Open™]\n`)
  );

  // Copyright line
  console.log(chalk.gray(`  ${COPYRIGHT}\n`));

  // Env var notice
  if (usingEnvKey()) {
    console.log(chalk.gray('  ') + chalk.green(IS_WINDOWS ? '[KEY] Using ANTHROPIC_API_KEY from environment' : '⚡ Using ANTHROPIC_API_KEY from environment') + '\n');
  }
}

// ── Input method selector ───────────────────────────────────────────────────
//
// Grouped by what the user is analyzing, not just where the input comes from.
// Prompt Triage was previously stacked alongside Local/ZIP/GitHub which made
// it look like just another way to load a code project — users couldn't find
// it because they were looking in the mode menu (Question/POI/Blast/Conflict/
// Recon) instead. Now the menu is grouped by analysis target with named
// separators so Prompt Triage is visually distinct from code-loading options.
//
// Compare Reports lives under the 'Other' separator alongside
// Reconfigure/Exit: it operates on saved reports, not an analysis target, so
// it belongs out of the Code/Prompt analysis groups.

async function selectInputMethod() {

  const codeAnalysisGroupLabel    = IS_WINDOWS ? '── Code analysis ──'   : '─── Code analysis ──────';
  const promptAnalysisGroupLabel  = IS_WINDOWS ? '── Prompt analysis ──' : '─── Prompt analysis ────';
  const otherGroupLabel           = IS_WINDOWS ? '── Other ──'           : '─── Other ──────────────';

  const choices = [
    new inquirer.Separator(codeAnalysisGroupLabel),
    { name: IS_WINDOWS ? '[DIR] Local directory' : '📁  Local directory', value: 'files' },
    { name: IS_WINDOWS ? '[ZIP] ZIP file' : '🗜   ZIP file', value: 'zip' },
    { name: IS_WINDOWS ? '[GIT] GitHub repository' : '🐙  GitHub repository', value: 'github' },

    new inquirer.Separator(promptAnalysisGroupLabel),
    { name: (IS_WINDOWS ? '[PRT] Prompt Triage' : '🧪  Prompt Triage') + chalk.gray('         - audit a folder of LLM prompts for defects'), value: 'prompt-triage' },

    new inquirer.Separator(otherGroupLabel),
    { name: (IS_WINDOWS ? '[CMP] Compare Reports  ' : '🔍  Compare Reports  ') + (IS_WINDOWS ? '' : chalk.gray('- Before/after diff of two saved reports')), value: 'compare' },
  ];

  // Always offer Reconfigure. Even when the API key comes from the environment,
  // this menu still manages the scan model and the full setup wizard. The
  // API-key row itself is disabled inside the submenu when usingEnvKey() is
  // true.
  choices.push({ name: IS_WINDOWS ? '[CFG] Reconfigure Ghost Architect™' : '⚙   Reconfigure Ghost Architect™', value: 'reconfigure' });
  // Universal escape: top-level menu uses a single "← Exit Ghost" choice
  // (no separate Back vs Exit). Returning BACK_VALUE here means the same
  // thing as selecting Exit at the top level — there is no higher level
  // to back out to. Main loop catches isBack(method) and runs confirmExit().
  choices.push(new inquirer.Separator());
  choices.push(backChoice(IS_WINDOWS ? '[EXIT] Exit Ghost' : '🚪  Exit Ghost'));

  const { method } = await inquirer.prompt([{
    type: 'list',
    name: 'method',
    message: chalk.cyan('What do you want to analyze?'),
    theme: inquirerTheme,
    choices
  }]);
  return method;
}


// ── Mode selector ───────────────────────────────────────────────────────────

async function selectMode(codebaseContext) {
  console.log('\n' + boxen(
    chalk.green.bold(SYM.check + ' Project processed') + '\n' +
    chalk.gray(`${codebaseContext.loadedFiles} files | ${codebaseContext.fileIndex.slice(0, 3).join(', ')}${codebaseContext.fileIndex.length > 3 ? '...' : ''}`),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderColor: 'green', borderStyle: 'round' }
  ));

  // Question (one-shot Q&A) and Chat (multi-turn) are distinct choices.
  const choices = [
    { name: (IS_WINDOWS ? '[ASK] Ask a Question  ' : '❓  Ask a Question  ') + chalk.gray('- Single Q&A, save the answer if you like'), value: 'question' },
    { name: (IS_WINDOWS ? '[CHT] Chat  ' : '💬  Chat  ') + chalk.gray('- Ongoing conversation about this project'), value: 'chat' },
  ];
  choices.push(
    { name: (IS_WINDOWS ? '[POI] Points of Interest Scan  ' : '🗺   Points of Interest Scan  ') + chalk.gray('- Auto-map red flags, landmarks, dead zones, fault lines'), value: 'poi' },
    { name: (IS_WINDOWS ? '[BLT] Blast Radius Analysis  ' : '💥  Blast Radius Analysis  ') + chalk.gray('- Impact map + rollback plan'), value: 'blast' },
    { name: (IS_WINDOWS ? '[CNF] Conflict Detection  ' : '⚡  Conflict Detection  ') + chalk.gray('- Find contract mismatches, schema conflicts, config errors'), value: 'conflict' },
    { name: (IS_WINDOWS ? '[FXF] Fix Forecast        ' : '🩹  Fix Forecast        ') + chalk.gray('- Forecast fix impact from a saved conflict scan'), value: 'fix-forecast' },
    { name: (IS_WINDOWS ? '[FCT] Commit Forecast  ' : '🔮  Commit Forecast  ') + chalk.gray('- Forecast blast + conflict impact before you push'), value: 'commit-forecast' },
    {
      name: IS_WINDOWS
        ? '[GBR] Ghost Brief™     - Generate AI remediation prompt pack'
        : '📋  Ghost Brief™     ' + chalk.gray('- Generate AI remediation prompt pack'),
      value: 'ghost-brief',
    },
    {
      name: IS_WINDOWS
        ? '[EXB] Executive Brief  - One-page business intelligence report'
        : '📊  Executive Brief  ' + chalk.gray('- One-page business intelligence report'),
      value: 'executive-brief',
    },
    new inquirer.Separator(IS_WINDOWS ? '── Other ──' : '─── Other ───────────────────────────────────────'),
    { name: (IS_WINDOWS ? '[REC] Recon  ' : '🔍  Recon  ') + chalk.gray('- Sizing & engagement plan, no analysis'), value: 'recon' },
    { name: (IS_WINDOWS ? '[AUD] Inheritance Audit  ' : '📋  Inheritance Audit  ') + chalk.gray('- Deal-grade audit for buyers, PE diligence, fractional CTOs'), value: 'audit' },
    { name: (IS_WINDOWS ? '[CMP] Compare Reports  ' : '🔍  Compare Reports  ') + (IS_WINDOWS ? '' : chalk.gray('- Before/after diff of two saved reports')), value: 'compare' },
    new inquirer.Separator(),
    // "New Scan" is the explicit back-out here — returns to selectInputMethod
    // with codebase context cleared. Labeled by intent ("scan a different
    // directory") rather than the abstract "Back" because the user has a
    // loaded codebase context and the natural next-thing-up is to load a
    // different one, not to abandon work entirely.
    { name: IS_WINDOWS ? '[RLD] New Scan  - scan a different directory' : '🔄  New Scan  - scan a different directory', value: 'reload' },
    // Universal escape: "Exit Ghost" with confirm-exit, consistent with
    // top-level menu. Caller checks isBack(mode) and runs confirmExit().
    backChoice(IS_WINDOWS ? '[EXIT] Exit Ghost' : '🚪  Exit Ghost'),
  );

  // Inject pending-batch rows ABOVE the main mode list. Each batch submitted via
  // the transport menu but not yet retrieved gets a row (selectable "READY" once
  // ended, grayed "checking..." while in progress). No pending batches → no
  // injection → the menu renders exactly as before.
  const pendingChoices = await buildPendingBatchChoices();
  if (pendingChoices.length > 0) {
    choices.unshift(...pendingChoices, new inquirer.Separator());
  }

  const { mode } = await inquirer.prompt([{
    type: 'list',
    name: 'mode',
    message: chalk.cyan(`\nReady to analyze ${codebaseContext.loadedFiles} files. What would you like Ghost to do?`),
    theme: inquirerTheme,
    choices,
  }]);

  return mode;
}

// ── Universal-escape helpers ────────────────────────────────────────────────

/**
 * Prompt the user to confirm exiting Ghost. Defaults to Yes so an
 * accidental Enter on the top-level Back/Exit choice does the natural
 * thing (exit cleanly) rather than trapping the user in a no-op loop.
 * The default of `true` matches the universal-escape TODO's specification
 * ("default Y so accidental Enter doesn't trap them").
 *
 * Returns true if the user confirms exit, false if they cancel and want
 * to stay in Ghost.
 */
async function confirmExit() {
  const { reallyExit } = await inquirer.prompt([{
    type: 'confirm',
    name: 'reallyExit',
    message: chalk.cyan('Exit Ghost?'),
    default: true,
    theme: inquirerTheme,
  }]);
  return reallyExit;
}

// ── Batch transport commands ──────────────────────────────────────────────────
//
// `ghost batch-status` and `ghost batch-retrieve <id>` complete the
// streaming-vs-batch transport feature: a scan submitted as a batch (via the
// transport menu) is checked and pulled back here. Status/results go through
// the Anthropic SDK directly; the "Premature close" drop that forced the native-fetch
// batch path only happens on constrained CI runners, and these
// commands run interactively on a developer machine.

async function runBatchStatusCommand() {
  let pending = getPendingBatches();
  if (!pending.length) {
    console.log(chalk.gray('\nNo pending batches.\n'));
    return;
  }

  // Same retention prune the menu path applies (Audit 8, quick win 8): an
  // aged-out batch is no longer retrievable server-side, so listing it as
  // "error: Not Found" forever, with a closing line telling the user to
  // check again in a few minutes, was false on both counts.
  const expiredCutoff = Date.now() - BATCH_RETENTION_DAYS * 86400 * 1000;
  const expired = pending.filter(b => {
    const t = Date.parse(b.submittedAt || '');
    return Number.isFinite(t) && t < expiredCutoff;
  });
  for (const b of expired) removePendingBatch(b.id);
  if (expired.length > 0) {
    console.log(chalk.gray(
      `\nRemoved ${expired.length} expired batch${expired.length === 1 ? '' : 'es'} ` +
      `(older than ${BATCH_RETENTION_DAYS} days, no longer retrievable).`
    ));
    pending = getPendingBatches();
    if (!pending.length) {
      console.log(chalk.gray('No pending batches.\n'));
      return;
    }
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.log(chalk.red(`\n${SYM.cross} No Anthropic API key configured: cannot check batch status.\n`));
    return;
  }
  const client = new Anthropic({ apiKey });

  const rows = [];
  let anyReady = false;
  let anyGone = false;
  for (const b of pending) {
    let status = 'unknown';
    let ready = false;
    try {
      const r = await client.messages.batches.retrieve(b.id);
      status = r.processing_status || 'unknown';
      ready = status === 'ended';
      if (ready && b.status !== 'ended') updatePendingBatch(b.id, { status: 'ended' });
    } catch (err) {
      // A 404 means the batch is gone server-side and never coming back:
      // remove it, same as the menu path, instead of keeping a permanent
      // "error: Not Found" row (Audit 8, quick win 8).
      if (err && err.status === 404) {
        removePendingBatch(b.id);
        anyGone = true;
        status = 'gone (removed from your pending list)';
      } else {
        status = 'error: ' + String(err && err.message ? err.message : err).slice(0, 30);
      }
    }
    if (ready) anyReady = true;
    rows.push({
      id:        b.id,
      mode:      b.mode || '-',
      submitted: formatClockTime(b.submittedAt) || b.submittedAt || '-',
      status,
      ready:     ready ? 'yes' : 'no',
    });
  }

  // Simple column-aligned table.
  const headers = { id: 'ID', mode: 'MODE', submitted: 'SUBMITTED', status: 'STATUS', ready: 'READY?' };
  const cols = ['id', 'mode', 'submitted', 'status', 'ready'];
  const width = {};
  for (const c of cols) {
    width[c] = headers[c].length;
    for (const r of rows) width[c] = Math.max(width[c], String(r[c]).length);
  }
  const fmtRow = (r) => cols.map(c => String(r[c]).padEnd(width[c])).join('  ');

  console.log('\n' + chalk.cyan.bold('Pending batches'));
  console.log(chalk.gray('  ' + fmtRow(headers)));
  for (const r of rows) {
    const line = '  ' + fmtRow(r);
    console.log(r.ready === 'yes' ? chalk.green(line) : chalk.white(line));
  }
  console.log('');

  if (anyReady) {
    const readyOne = rows.find(r => r.ready === 'yes');
    console.log(chalk.cyan('One or more batches are ready. Retrieve with:'));
    console.log(chalk.gray('  ghost batch-retrieve ') + chalk.cyan(readyOne.id) + '\n');
  } else if (anyGone && rows.every(r => r.status.startsWith('gone'))) {
    console.log(chalk.gray('Those batches ended without retrievable results and were removed. Re-run the scan to try again.\n'));
  } else {
    console.log(chalk.gray('No batches ready yet: check again in a few minutes.\n'));
  }
}

async function runBatchRetrieveCommand(id) {
  if (!id) {
    console.log(chalk.red(`\n${SYM.cross} Usage: ghost batch-retrieve <batch-id>`));
    console.log(chalk.gray('  Run `ghost batch-status` to list pending batch ids.\n'));
    return;
  }

  const entry = findPendingBatch(id);
  if (!entry) {
    console.log(chalk.red(`\n${SYM.cross} No pending batch found with id: ${id}`));
    console.log(chalk.gray('  Run `ghost batch-status` to list pending batch ids.\n'));
    return;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.log(chalk.red(`\n${SYM.cross} No Anthropic API key configured: cannot retrieve the batch.\n`));
    return;
  }
  const client = new Anthropic({ apiKey });

  // Confirm the batch has finished before pulling results.
  let batch;
  try {
    batch = await client.messages.batches.retrieve(id);
  } catch (err) {
    console.log(chalk.red(`\n${SYM.cross} Could not check batch ${id}: ${err.message}\n`));
    return;
  }
  if (batch.processing_status !== 'ended') {
    console.log(chalk.yellow(`\n  Batch ${id} is not ready yet (status: ${batch.processing_status}).`));
    console.log(chalk.gray('  Check again later with `ghost batch-status`.\n'));
    return;
  }

  // Pull the result text for this batch's request.
  console.log(chalk.gray(`\n  Retrieving results for ${id}...`));
  let text = null;
  let batchUsage = null;
  try {
    const results = await client.messages.batches.results(id);
    for await (const item of results) {
      const matches = !entry.customId || item.custom_id === entry.customId;
      if (matches && item.result && item.result.type === 'succeeded') {
        text = item.result.message?.content?.[0]?.text ?? '';
        // Real batch usage, so the retrieve path can stamp the billed cost
        // into the saved report's meta (Audit 8, finding 2.4).
        batchUsage = item.result.message?.usage || null;
        break;
      }
    }
  } catch (err) {
    console.log(chalk.red(`\n${SYM.cross} Failed to download batch results: ${err.message}\n`));
    return;
  }

  if (text == null) {
    // Terminal state: the batch ENDED and carried no successful result, so
    // retrying can never produce one. Keeping it made it a permanent zombie:
    // it renders as a green READY row forever and re-hits the API on every
    // single menu redraw. Drop it.
    removePendingBatch(id);
    console.log(chalk.red(`\n${SYM.cross} Batch ${id} ended but no successful result was found.`));
    console.log(chalk.gray('  The request errored or expired. Removed from your pending list.'));
    console.log(chalk.gray('  Re-run the scan to try again.\n'));
    return;
  }

  // Dispatch to the mode's retrieve-replay so the output is identical to a
  // streaming run (same report files, sidecar, and PDF — only the transport
  // metadata differs).
  try {
    if (entry.mode === 'blast-radius') {
      const { saved } = await retrieveBlastBatchResult(text, entry, { batchUsage });
      removePendingBatch(id);
      console.log(chalk.green(`\n${SYM.check} Reports saved to ~/Ghost Architect Reports/`));
      console.log(chalk.gray(`  📄 ${saved.txtFile}`));
      console.log(chalk.gray(`  📋 ${saved.mdFile}`));
      if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
      console.log('');
    } else if (entry.mode === 'question') {
      const { saved } = await retrieveQuestionBatchResult(text, entry);
      removePendingBatch(id);
      console.log(chalk.green(`\n${SYM.check} Reports saved to ~/Ghost Architect Reports/`));
      console.log(chalk.gray(`  📄 ${saved.txtFile}`));
      console.log(chalk.gray(`  📋 ${saved.mdFile}`));
      if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
      console.log('');
    } else {
      console.log(chalk.yellow(`\n  Batch retrieve for mode "${entry.mode}" is not wired up in this build yet.`));
      console.log(chalk.gray('  Batch retrieve currently covers Blast Radius and Question.\n'));
    }
  } catch (err) {
    console.log(chalk.red(`\n${SYM.cross} Failed to process batch results: ${err.message}\n`));
  }
}

// Human-readable mode label for a pending-batch menu row.
function friendlyBatchModeLabel(mode) {
  switch (mode) {
    case 'blast-radius': return 'Blast Radius';
    case 'blast':        return 'Blast Radius';
    case 'question':     return 'Question';
    case 'poi':          return 'Points of Interest';
    case 'conflict':     return 'Conflict Detection';
    case 'audit':        return 'Inheritance Audit';
    case 'chat':         return 'Chat';
    case 'commit-forecast': return 'Commit Forecast';
    case 'fix-forecast':    return 'Fix Forecast';
    case 'executive-brief': return 'Executive Brief';
    default:             return mode || 'Scan';
  }
}

// Build the dynamic pending-batch rows injected at the top of the main mode
// menu. For each batch the interactive CLI submitted (tracked in configstore),
// check its status against the Anthropic Batches API and render a row:
//   - ended      → a selectable "READY" entry (value "batch:<id>")
//   - otherwise  → a grayed-out, non-selectable "checking..." entry
// Returns [] when there are no pending batches, so the menu is unchanged and no
// network call is made (spec: zero pending → zero changes).
// The Anthropic Batches API retains a batch for 29 days. Past that the id 404s
// forever, so an entry older than this can never be retrieved and is pure noise.
const BATCH_RETENTION_DAYS = 29;

// Modes with a real batch transport path. POI, Conflict and Audit are multipass
// and have no batch branch, so passing --batch to them is a no-op. Keep this in
// sync with the modes that actually read flags.batch (question.js, blast.js).
const BATCH_CAPABLE_MODES = ['question', 'blast'];

async function buildPendingBatchChoices() {
  let pending = getPendingBatches();
  if (pending.length === 0) return [];

  // Prune expired entries BEFORE spending an API call on them. Without this an
  // aged-out batch renders a perpetual "checking..." row and fires a doomed
  // retrieve on every single menu redraw.
  const expiredCutoff = Date.now() - BATCH_RETENTION_DAYS * 86400 * 1000;
  const expired = pending.filter(b => {
    const t = Date.parse(b.submittedAt || '');
    return Number.isFinite(t) && t < expiredCutoff;
  });
  for (const b of expired) removePendingBatch(b.id);
  if (expired.length > 0) {
    console.log(chalk.gray(
      `  Removed ${expired.length} expired batch${expired.length === 1 ? '' : 'es'} ` +
      `(older than ${BATCH_RETENTION_DAYS} days, no longer retrievable).`
    ));
    pending = getPendingBatches();
    if (pending.length === 0) return [];
  }

  const apiKey = resolveApiKey();
  let client = null;
  if (apiKey) {
    try { client = new Anthropic({ apiKey }); } catch { client = null; }
  }

  // Without an API key no status can ever resolve, so the rows rendered a
  // perpetual "checking..." on every menu draw with no hint that the missing
  // key was the cause (Audit 8, quick win 9). Say so once and render nothing.
  if (!client) {
    console.log(chalk.gray(
      `  ${pending.length} pending batch${pending.length === 1 ? '' : 'es'} cannot be checked: ` +
      'no Anthropic API key configured. Run ghost --reconfigure to add one.'
    ));
    return [];
  }

  console.log(chalk.gray(`  Checking ${pending.length} pending batch${pending.length === 1 ? '' : 'es'}...`));

  // Check all statuses concurrently. A failed/uncheckable status renders the
  // row as still-checking (non-selectable) rather than offering a bad retrieve.
  const checked = await Promise.all(pending.map(async (b) => {
    let status = 'unknown';
    if (client) {
      try {
        const r = await client.messages.batches.retrieve(b.id);
        status = r.processing_status || 'unknown';
      } catch (err) {
        // A 404 means the batch is gone server-side and never coming back.
        // Drop it now rather than rendering a row that re-fetches a doomed id
        // every time the menu is drawn. Any other error (network, 429, 5xx) is
        // transient: keep the entry and show it as still-checking.
        if (err && err.status === 404) {
          removePendingBatch(b.id);
          return { entry: b, status: 'gone' };
        }
        status = 'unknown';
      }
    }
    return { entry: b, status };
  }));

  const rows = [];
  for (const { entry, status } of checked) {
    const modeLabel = friendlyBatchModeLabel(entry.mode);
    const time = formatClockTime(entry.submittedAt) || entry.submittedAt || 'unknown';
    if (status === 'gone') continue;   // already pruned above, render nothing
    // IS_WINDOWS-gated icon, same convention as the rest of the menu
    // (Audit 8, quick win 10).
    const batchIcon = IS_WINDOWS ? '[BAT]' : '📬';
    if (status === 'ended') {
      rows.push({
        name: `${batchIcon} ${modeLabel} batch (submitted ${time}) - ` + chalk.green.bold('READY'),
        value: `batch:${entry.id}`,
      });
    } else {
      rows.push({
        name: chalk.gray(`${batchIcon} ${modeLabel} batch (submitted ${time})`),
        disabled: 'checking...',
      });
    }
  }
  return rows;
}

// ── Selective Reconfigure ──────────────────────────────────────────────────
// Replaces the old "replay the entire first-run wizard" behavior. Each item is
// updated independently and every level offers Back. (An earlier version of this
// comment promised Ctrl+C recovery in a sub-option; it never worked. inquirer
// 9.3.8 re-raises SIGINT, so Ctrl+C terminates Ghost from anywhere.)
// returns to this menu (never the main menu, never an exit). No em dashes in
// any user-facing string here (colons/hyphens only).

// Anthropic API key sub-flow. A blank Enter or 'back' cancels WITHOUT touching
// the stored key (the old wizard cleared it on blank Enter).
async function reconfigureApiKey() {
  try {
    const { key } = await inquirer.prompt([{
      type: 'password', name: 'key',
      message: chalk.cyan("Enter new Anthropic API key (press Enter to keep current, type 'back' to cancel):"),
    }]);
    const val = (key || '').trim();
    if (!val || val.toLowerCase() === 'back') {
      console.log(chalk.gray('  No changes saved.'));
      return;
    }
    if (!val.startsWith('sk-ant-')) {
      console.log(chalk.yellow('  Warning: key does not start with sk-ant-. Continuing anyway.'));
    }
    // Verify against the API BEFORE saving, mirroring the GitHub-token flow
    // (Audit 7, Q8): a truncated paste used to get a confident "API key
    // saved." and fail mid-scan. GET /v1/models is authenticated and free.
    // Verification is advisory: a network fault must not block an offline
    // save, so the user still decides at the Save prompt below.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let res;
      try {
        res = await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': val, 'anthropic-version': '2023-06-01' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        console.log(chalk.green(`  ${SYM.check} Key verified against the Anthropic API.`));
      } else if (res.status === 401) {
        console.log(chalk.red(`  ${SYM.cross} The Anthropic API rejected this key (401). Saving it will fail on your next scan.`));
      } else {
        console.log(chalk.yellow(`  Could not verify the key (API returned ${res.status}). You can still save it.`));
      }
    } catch {
      console.log(chalk.yellow('  Could not verify the key (network issue). You can still save it.'));
    }
    const { decision } = await inquirer.prompt([{
      type: 'list', name: 'decision', theme: inquirerTheme,
      message: chalk.cyan('Save this key?'),
      choices: [
        { name: 'Yes', value: 'yes' },
        { name: 'No', value: 'no' },
        { name: 'Back', value: 'back' },
      ],
    }]);
    if (decision === 'yes') {
      getConfig().set('anthropicApiKey', val);
      secureConfigFile();
      console.log(chalk.green('  API key saved.'));
    } else {
      console.log(chalk.gray('  Discarded. No changes saved.'));
    }
  } catch (_) {
    // NOT a Ctrl+C handler. inquirer 9.3.8 re-raises SIGINT and no process-level
    // SIGINT handler exists, so Ctrl+C kills the process and this catch never
    // runs for it. What this DOES catch is a prompt that throws: a non-TTY
    // stdin, a validation fault, a closed stream. Returning to the menu is
    // still the right response to those.
  }
}

// The selective reconfigure menu. Returns to the caller (main menu) only on
// explicit Back, or if the menu prompt itself throws. Ctrl+C does not return
// here: inquirer 9.3.8 re-raises SIGINT and Ghost exits.
async function runSelectiveReconfigure() {
  while (true) {
    const reconfigureChoices = [
      {
        name: `Anthropic API key ${resolveApiKey() ? '(configured)' : '(not set)'}`,
        value: 'apiKey',
        // When the key comes from the environment, it cannot be changed here --
        // disable this row but keep the other rows usable.
        disabled: usingEnvKey() ? chalk.gray('(set via ANTHROPIC_API_KEY env var)') : false,
      },
      { name: `Change scan model (${getConfig().get('defaultModel') || 'claude-sonnet-4-6'})`, value: 'model' },
      { name: 'Run full setup wizard', value: 'full' },
      { name: 'Back', value: 'back' },
    ];
    let action;
    try {
      ({ action } = await inquirer.prompt([{
        type: 'list', name: 'action', theme: inquirerTheme,
        message: chalk.cyan('Reconfigure Ghost Architect™:'),
        choices: reconfigureChoices,
      }]));
    } catch (_) {
      // Not reachable via Ctrl+C (inquirer 9.3.8 re-raises SIGINT; the process
      // exits). Reachable when the prompt itself throws, e.g. a non-TTY stdin.
      return;
    }
    if (action === 'back') return;
    if (action === 'full') { await reconfigure(); return; }
    if (action === 'apiKey') { await reconfigureApiKey(); continue; }
    if (action === 'model') { await reconfigureModel(); continue; }
  }
}

// Scan-model sub-flow. Changes the default model used by every mode that does
// not prompt for one (Audit prompts separately). Choices come from config.js's
// MODEL_CHOICES, which is derived from MODEL_RATES, so this menu can never offer
// a model Ghost cannot price. Returns to the reconfigure menu on Back or on a
// prompt fault. Ctrl+C terminates Ghost (inquirer 9.3.8 re-raises SIGINT).
async function reconfigureModel() {
  try {
    const current = getConfig().get('defaultModel') || 'claude-sonnet-4-6';
    const choices = [...getModelChoices(), backChoice()];
    const currentIdx = choices.findIndex(c => c.value === current);
    const { model } = await inquirer.prompt([{
      type: 'list', name: 'model', theme: inquirerTheme,
      message: chalk.cyan('Default scan model:'),
      choices,
      default: currentIdx >= 0 ? currentIdx : 0,
    }]);
    if (isBack(model)) return;
    if (model === current) {
      console.log(chalk.gray(`  Already set to ${current}. No change.\n`));
      return;
    }
    getConfig().set('defaultModel', model);
    console.log(chalk.green(`  ${SYM.check} Default scan model set to ${model}.`));
    console.log(chalk.gray('  Pre-scan cost estimates now reflect this model\'s rates.\n'));
  } catch (_) {
    // NOT a Ctrl+C handler. inquirer 9.3.8 re-raises SIGINT and no process-level
    // SIGINT handler exists, so Ctrl+C kills the process and this catch never
    // runs for it. What this DOES catch is a prompt that throws: a non-TTY
    // stdin, a validation fault, a closed stream. Returning to the menu is
    // still the right response to those.
  }
}

async function main() {
  // Parse CLI flags first so --help / --version / --max-context etc. are honored
  // before we print the banner or run the setup wizard.
  const argv = process.argv.slice(2);
  const cliOpts = parseArgs(argv);

  // Contradictory transport flags: resolveTransport checks stream first, so
  // stream wins. Say so instead of silently billing streaming rates to a user
  // who expected half-price batch (Audit 7, Q9). stderr, so stdout stays clean
  // for scriptable flags.
  if (cliOpts.stream && cliOpts.batch) {
    console.error(chalk.yellow('Both --stream and --batch were passed. Running streaming.'));
  }

  // --recover-session <label>: force session recovery from the checkpoint sidecar
  // for this project on the next scan, even if a main session file exists. Wired
  // into multipass.loadSession's forced-recovery path.
  if (cliOpts.recoverSession) {
    const { setForceRecoverSession } = await import('../src/core/multipass.js');
    setForceRecoverSession(cliOpts.recoverSession);
  }

  // --sessions-dir <path>: relocate the primary resume-checkpoint directory for
  // this run. Useful when the default Reports volume is read-only or unsuitable.
  // Must be applied before any scan begins so every session read/write uses it.
  if (cliOpts.sessionsDir) {
    const { setSessionsDir } = await import('../src/core/multipass.js');
    setSessionsDir(cliOpts.sessionsDir);
  }

  // --list-sessions: show every resumable scan session and exit. Runs after
  // --sessions-dir so a relocated directory is honored. This is the
  // display surface for listSessions' dual-directory enumeration; the function
  // previously had no caller, so a fallback-dir session was resumable by label
  // yet invisible to the user (Audit 11, finding 3.3).
  if (cliOpts.listSessions) {
    const { listSessions } = await import('../src/core/multipass.js');
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log('No resumable scan sessions found.');
    } else {
      console.log(`Resumable scan sessions (${sessions.length}):\n`);
      for (const s of sessions) {
        const label = s.projectLabel || 'default';
        const done  = s.completedPassCount || 0;
        const total = s.totalPassCount || done;
        const started = s.startedAt ? new Date(s.startedAt).toLocaleString() : 'unknown start time';
        console.log(`  ${label}`);
        console.log(`    passes complete: ${done} of ${total}, started: ${started}`);
      }
      console.log('\nRun a scan with the same project label to resume, or use --recover-session <label> to force checkpoint recovery.');
    }
    process.exit(0);
  }

  if (cliOpts.help)    { printUsage(); process.exit(0); }
  if (cliOpts.version) {
    console.log(`Ghost Architect™ v${VERSION} (Ghost Open™)`);
    process.exit(0);
  }

  // ── Batch transport subcommands ───────────────────────────────────────────
  // `ghost batch-status` and `ghost batch-retrieve <id>` are positional
  // subcommands (not flags). Handle them here, before any codebase load or
  // setup, so they work as quick standalone commands. They operate purely on
  // the local pending-batch store + the Anthropic Batches API.
  const positional = argv.filter(a => !a.startsWith('-'));
  if (positional[0] === 'batch-status') {
    await runBatchStatusCommand();
    process.exit(0);
  }
  if (positional[0] === 'batch-retrieve') {
    await runBatchRetrieveCommand(positional[1]);
    process.exit(0);
  }

  // --reconfigure routes straight into the same Reconfigure menu the
  // interactive main menu offers. Recovery copy across the CLI points here
  // (cap clamping, pending-batch API key advisories), so the flag must exist:
  // it used to print "Unknown flag: --reconfigure (ignored)" to the exact
  // customer following printed instructions (Audit 9, finding 2.1).
  if (cliOpts.reconfigure) {
    await runSelectiveReconfigure();
    console.log('');
    process.exit(0);
  }

  // Captured before runSetupWizard() flips isConfigured() to true, so the
  // post-setup banner below can skip its console.clear() and keep the
  // setup confirmation on screen.
  const firstRun = !isConfigured();
  if (firstRun) {
    console.log(boxen(
      chalk.yellow.bold('Welcome to Ghost Architect!') + '\n' +
      chalk.gray('Looks like this is your first time here.\nLet\'s get you set up.'),
      { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
    ));
    console.log('');

    await runSetupWizard();
  }

  // On first run, skip the clear so the confirmation from setup stays visible.
  printBanner({ skipClear: firstRun });

  // Seed the loader with the CLI-derived scan options. setScanOptions is
  // last-write-wins and safe to recall.
  setScanOptions({
    maxContextOverride: cliOpts.maxContext,
    excludePresets: cliOpts.presets,
    excludePatterns: cliOpts.excludes,
    skipRedaction: cliOpts.skipRedaction,
  });

  let codebaseContext = null;

  // ── Non-interactive Commit Forecast branch ────────────────────────────────
  // Fires ONLY when ALL THREE of --baseline, --proposed, --modes are present.
  // Any missing flag → fall through to the interactive while-loop below.
  if (cliOpts.cfBaseline && cliOpts.cfProposed && cliOpts.cfModes) {
    const { cfBaseline, cfProposed, cfModes } = cliOpts;

    // a. Validate paths exist and are readable directories.
    for (const [flag, p] of [['--baseline', cfBaseline], ['--proposed', cfProposed]]) {
      if (!fs.existsSync(p)) {
        console.error(chalk.red(`\n  ${SYM.cross} ${flag} path does not exist: ${p}\n`));
        process.exit(1);
      }
      if (!fs.statSync(p).isDirectory()) {
        console.error(chalk.red(`\n  ${SYM.cross} ${flag} path is not a directory: ${p}\n`));
        process.exit(1);
      }
    }

    // b. Validate --modes values.
    const VALID_CF_MODES = ['blast', 'conflict', 'both'];
    const rawModes = cfModes.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const invalidModes = rawModes.filter(m => !VALID_CF_MODES.includes(m));
    if (invalidModes.length > 0) {
      console.error(chalk.red(
        `\n  ✗ Unknown --modes value(s): ${invalidModes.join(', ')}\n` +
        `  Valid values: ${VALID_CF_MODES.join(', ')}\n`
      ));
      process.exit(1);
    }

    // c. Load baseline as codebase using the existing loader.
    try {
      codebaseContext = await loadFromPath(cfBaseline);
    } catch (err) {
      console.error(chalk.red(`\n  ${SYM.cross} Failed to load baseline: ${err.message}\n`));
      process.exit(1);
    }
    if (!codebaseContext) {
      console.error(chalk.red(`\n  ${SYM.cross} Baseline loaded no files from: ${cfBaseline}\n`));
      process.exit(1);
    }

    // d. Dispatch directly to runCommitForecastMode with all flags.
    await runCommitForecastMode(codebaseContext, {
      cfBaseline,
      cfProposed,
      cfModes,
      cfNoVerify:   cliOpts.cfNoVerify || false,
    });
    process.exit(0);
  }

  while (true) {
    if (!codebaseContext) {
      const method = await selectInputMethod();

      // Universal escape: top-level Back/Exit — confirm before leaving.
      if (isBack(method)) {
        if (await confirmExit()) {
          console.log(chalk.cyan('\nIntel gathered. Go make your move.\n'));
          console.log(chalk.gray(`${COPYRIGHT}\n`));
          process.exit(0);
        }
        continue;
      }

      if (method === 'reconfigure') {
        await runSelectiveReconfigure();
        printBanner();
        continue;
      }

      if (method === 'compare') {
        pingModeUsage(VERSION, 'compare').catch(() => {});
        await runCompareMode();
        continue;
      }

      if (method === 'prompt-triage') {
        // No default: an explicit path must be typed. v5.1.2 had `default:
        // process.cwd()` which created a UX trap — if the user hit Enter
        // without typing, Ghost would silently scan the current working
        // directory (often a code repo, not a prompts folder). Caught in
        // the v5.1.2 smoke run when /tmp/ghost-prompt-smoke-rich was typed
        // but cwd ended up being scanned anyway. Forcing the user to type
        // a path eliminates the silent-fallback failure mode.
        const { folderPath } = await inquirer.prompt([{
          type: 'input',
          name: 'folderPath',
          message: chalk.cyan("Folder containing prompt files (absolute path, or 'back' to cancel):"),
          theme: inquirerTheme,
          validate: (input) => {
            if (!input || !input.trim()) return 'Folder path is required.';
            // Universal-escape: allow 'back' through validation so the
            // post-prompt isBackKeyword() check can route the cancellation.
            if (input.trim().toLowerCase() === 'back') return true;
            const abs = path.resolve(input.trim());
            if (!fs.existsSync(abs)) return 'Folder does not exist: ' + abs;
            try {
              if (!fs.statSync(abs).isDirectory()) return 'Path is not a directory: ' + abs;
            } catch (err) {
              return 'Could not access path: ' + err.message;
            }
            return true;
          },
        }]);

        // Universal-escape: 'back' keyword — return to selectInputMethod.
        if (isBackKeyword(folderPath)) {
          continue;
        }

        // Optional target-model selection. When specified, length-aware
        // detectors use the correct tokenizer (exact for OpenAI, heuristic
        // with model-specific context-window labels for others).
        const { specifyModel } = await inquirer.prompt([{
          type: 'confirm',
          name: 'specifyModel',
          message: chalk.cyan('Specify a target model?'),
          default: false,
          theme: inquirerTheme,
        }]);
        let targetModel = null;
        if (specifyModel) {
          const modelChoices = listModelsForPicker().map(m => ({
            name: m.displayName + chalk.gray(' (' + m.family + ', '
              + m.contextWindow.toLocaleString() + ' tokens)'),
            value: m.id,
          }));
          // Universal-escape: add Back to the model picker so user isn't
          // committed to a model just because they answered "yes" to the
          // confirm above.
          modelChoices.push(new inquirer.Separator());
          modelChoices.push(backChoice('←  Back (don\'t specify a model)'));
          const answer = await inquirer.prompt([{
            type: 'list',
            name: 'targetModel',
            message: chalk.cyan('Target model:'),
            choices: modelChoices,
            pageSize: 12,
            theme: inquirerTheme,
          }]);
          // Back leaves targetModel null, same as if user had declined to specify.
          if (!isBack(answer.targetModel)) {
            targetModel = answer.targetModel;
          }
        }

        try {
          // Telemetry — fire BEFORE the run so a long Prompt Triage doesn't
          // delay the ping landing in Pulse. Fire-and-forget; if the network
          // is slow, the user shouldn't wait. Lands as `mode-prompt-triage`
          // in the dashboard's Event Sources histogram.
          pingModeUsage(VERSION, 'prompt-triage').catch(() => {});

          await runPromptTriageMode({
            source: { kind: 'localFolder', path: folderPath.trim() },
            targetModel,
          });
        } catch (err) {
          console.log(chalk.red('\n' + SYM.cross + ' Prompt Triage failed: ' + err.message + '\n'));
        }
        continue;
      }

      console.log('');
      codebaseContext = await loadCodebase(method);
      if (!codebaseContext) { codebaseContext = null; continue; }
    }

    const mode = await selectMode(codebaseContext);

    // Universal escape: Exit Ghost from mode menu — confirm before leaving.
    if (isBack(mode)) {
      if (await confirmExit()) {
        console.log(chalk.cyan('\nIntel gathered. Go make your move.\n'));
        console.log(chalk.gray(`${COPYRIGHT}\n`));
        process.exit(0);
      }
      continue;
    }

    if (mode === 'reload') {
      codebaseContext = null;
      printBanner();
      continue;
    }

    // Pending-batch retrieval — the user picked a "READY" row injected at the
    // top of the menu (value "batch:<id>"). Pull and save the finished batch
    // (same pipeline as `ghost batch-retrieve`: writes report files, confirms
    // the save, removes the entry from configstore), then loop back to the
    // menu — the retrieved batch no longer appears.
    if (typeof mode === 'string' && mode.startsWith('batch:')) {
      const batchId = mode.slice('batch:'.length);
      await runBatchRetrieveCommand(batchId);
      continue;
    }

    // --batch is only implemented by the two single-call modes. The multipass
    // modes (POI, Conflict, Audit) have no batch transport path, so the flag was
    // silently doing nothing and the user paid streaming prices believing they
    // had opted into the half-price Batches API. Say so out loud.
    // Only the API-calling scan modes get the notice. Recon makes no LLM call
    // at all, so "Running streaming at standard rates" there was false and
    // cost-alarming, and menu utility picks printed nonsense like "--batch is
    // not supported for compare" (Audit 7, Q7).
    // Every mode that is not batch-capable must tell a user who passed
    // --batch that they are streaming at standard rates. Commit Forecast,
    // Fix Forecast, and Executive Brief were missing from this list, so a
    // user expecting half-price batch on those modes paid full price with
    // zero notice (Audit 8, finding 2.1).
    const BATCH_NOTICE_MODES = ['poi', 'conflict', 'audit', 'chat', 'commit-forecast', 'fix-forecast', 'executive-brief'];
    if (cliOpts.batch && BATCH_NOTICE_MODES.includes(mode) && !BATCH_CAPABLE_MODES.includes(mode)) {
      console.log(chalk.yellow(
        `\n  Note: --batch is not supported for ${friendlyBatchModeLabel(mode)}. ` +
        `Running streaming at standard rates.`
      ));
      console.log(chalk.gray('  Batch transport is available for Blast Radius and Question.\n'));
    }

    // Mode-usage telemetry. Fire-and-forget so a slow Pulse Worker never
    // delays a scan. Lands as `mode-<name>` in the Pulse dashboard.
    pingModeUsage(VERSION, mode).catch(() => {});

    switch (mode) {
      case 'question':        await runQuestionMode(codebaseContext, { flags: { stream: cliOpts.stream, batch: cliOpts.batch } });         break;
      case 'chat':            await runChatMode(codebaseContext);             break;
      case 'poi':             await runPOIMode(codebaseContext);  break;
      case 'blast':           await runBlastMode(codebaseContext, { flags: { stream: cliOpts.stream, batch: cliOpts.batch } });  break;
      case 'conflict':        await runConflictMode(codebaseContext);  break;
      case 'fix-forecast':    await runSavedFixForecast({ codebaseContext }); break;
      case 'commit-forecast': await runCommitForecastMode(codebaseContext, {
        cfBaseline:   cliOpts.cfBaseline || null,
        cfProposed:   cliOpts.cfProposed || null,
        cfModes:      cliOpts.cfModes    || null,
        cfNoVerify:   cliOpts.cfNoVerify || false,
      }); break;
      case 'recon':           await runReconMode(codebaseContext);  break;
      case 'audit':           await runAuditMode(codebaseContext);  break;
      case 'compare':         await runCompareMode();                         break;
      case 'ghost-brief': {
        // ── Ghost Brief™ — in-menu handler ────────────────────────────────
        const REPORTS_DIR_GB = path.join(os.homedir(), 'Ghost Architect Reports');
        let inputFile = null;

        // Bug fix 1: sort by mtime (most recently modified first)
        if (fs.existsSync(REPORTS_DIR_GB)) {
          const files = fs.readdirSync(REPORTS_DIR_GB)
            .filter(f => f.endsWith('.findings.json'))
            .map(f => ({
              name: f,
              mtime: fs.statSync(path.join(REPORTS_DIR_GB, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);
          const recentFile = files[0];
          if (recentFile) inputFile = path.join(REPORTS_DIR_GB, recentFile.name);
        }

        if (!inputFile) {
          console.log(chalk.yellow('\n  No findings file found in ~/Ghost Architect Reports/'));
          console.log(chalk.gray('  Run a scan first, then select Ghost Brief™.\n'));
          break;
        }

        console.log(chalk.gray(`\n  Using findings: ${path.basename(inputFile)}`));
        const { confirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: `Generate Ghost Brief™ from ${path.basename(inputFile)}?`,
          default: true,
          theme: inquirerTheme,
        }]);

        // Bug fix 2: if user says No, offer file picker instead of bailing
        if (!confirmed) {
          const allFiles = fs.readdirSync(REPORTS_DIR_GB)
            .filter(f => f.endsWith('.findings.json'))
            .map(f => ({
              name: f,
              mtime: fs.statSync(path.join(REPORTS_DIR_GB, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 10);

          if (allFiles.length === 0) {
            console.log(chalk.yellow('\n  No findings files found. Run a scan first.\n'));
            break;
          }

          const { chosenFile } = await inquirer.prompt([{
            type: 'list',
            name: 'chosenFile',
            message: 'Choose a findings file:',
            theme: inquirerTheme,
            choices: [
              ...allFiles.map(f => ({
                name: f.name,
                value: path.join(REPORTS_DIR_GB, f.name),
              })),
              { name: '← Back to menu', value: null },
            ],
          }]);

          if (!chosenFile) break;
          inputFile = chosenFile;
        }

        const briefOutputFile = path.join(process.cwd(), 'ghost-brief.json');
        try {
          const { generateBrief, writeBrief } = await import('../lib/ghostBrief.js');
          const { fromFixForecast, fromPOI, fromConflict } = await import('../lib/ghostBriefAdapter.js');
          const briefVersion = _require('../package.json').version;

          const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
          let findings = [];
          if (raw.prompts) {
            findings = raw.prompts;
          } else if (raw.findings) {
            const scanMode = raw.scan_mode || raw.mode || 'fix-forecast';
            if (scanMode === 'poi')           findings = fromPOI(raw.findings);
            else if (scanMode === 'conflict') findings = fromConflict(raw.findings);
            else                              findings = fromFixForecast(raw.findings);
          } else {
            console.log(chalk.yellow('\n  Input file has no recognized findings structure.\n'));
            break;
          }

          const brief = generateBrief({
            findings,
            ghostVersion: briefVersion,
            scanFile:     inputFile,
            codebaseRoot: process.cwd(),
          });

          const { jsonPath, htmlPath } = writeBrief(brief, briefOutputFile);
          console.log(chalk.green(`\n  ${SYM.check} Ghost Brief™ written to: ${jsonPath}`));
          console.log(chalk.green(`  ${SYM.check} HTML report written to: ${htmlPath}`));
          console.log(chalk.gray(`    ${brief.summary.total_prompts} prompts | ${brief.summary.estimated_agent_hours}h estimated\n`));
          printUpgradeLine();
          console.log('');
        } catch (e) {
          console.error(chalk.red(`\n  Ghost Brief failed: ${e.message}\n`));
        }
        break;
      }

      case 'executive-brief': {
        // ── Executive Brief — in-menu handler ─────────────────────────────
        const REPORTS_DIR_EB = path.join(os.homedir(), 'Ghost Architect Reports');
        let ebInputFile = null;

        // Sort by mtime (most recently modified first)
        if (fs.existsSync(REPORTS_DIR_EB)) {
          const files = fs.readdirSync(REPORTS_DIR_EB)
            .filter(f => f.endsWith('.findings.json'))
            .map(f => ({
              name: f,
              mtime: fs.statSync(path.join(REPORTS_DIR_EB, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);
          const recentFile = files[0];
          if (recentFile) ebInputFile = path.join(REPORTS_DIR_EB, recentFile.name);
        }

        if (!ebInputFile) {
          console.log(chalk.yellow('\n  No findings file found in ~/Ghost Architect Reports/'));
          console.log(chalk.gray('  Run a scan first, then select Executive Brief.\n'));
          break;
        }

        console.log(chalk.gray(`\n  Using findings: ${path.basename(ebInputFile)}`));
        const { ebConfirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'ebConfirmed',
          message: `Generate Executive Brief from ${path.basename(ebInputFile)}?`,
          default: true,
          theme: inquirerTheme,
        }]);

        // If user says No, offer file picker instead of bailing
        if (!ebConfirmed) {
          const allFiles = fs.readdirSync(REPORTS_DIR_EB)
            .filter(f => f.endsWith('.findings.json'))
            .map(f => ({
              name: f,
              mtime: fs.statSync(path.join(REPORTS_DIR_EB, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 10);

          if (allFiles.length === 0) {
            console.log(chalk.yellow('\n  No findings files found. Run a scan first.\n'));
            break;
          }

          const { chosenFile } = await inquirer.prompt([{
            type: 'list',
            name: 'chosenFile',
            message: 'Choose a findings file:',
            theme: inquirerTheme,
            choices: [
              ...allFiles.map(f => ({
                name: f.name,
                value: path.join(REPORTS_DIR_EB, f.name),
              })),
              { name: '← Back to menu', value: null },
            ],
          }]);

          if (!chosenFile) break;
          ebInputFile = chosenFile;
        }

        try {
          const { runExecutiveBriefMode } = await import('../src/modes/executive-brief.js');

          const raw = JSON.parse(fs.readFileSync(ebInputFile, 'utf8'));
          // Distinguish a MALFORMED file (no findings/prompts key at all) from a
          // valid scan that simply has zero findings. Only the former is an
          // error; a clean scan (findings: []) now renders a graceful
          // "no significant findings" brief via runExecutiveBriefMode.
          if (!Array.isArray(raw.findings) && !Array.isArray(raw.prompts)) {
            console.log(chalk.yellow('\n  Input file has no recognized findings structure.\n'));
            break;
          }
          const ebFindings = raw.findings || raw.prompts || [];

          console.log(chalk.gray('  Generating Executive Brief (this calls the API once)...\n'));
          const { pdfPath } = await runExecutiveBriefMode({
            findings: ebFindings,
            scanFile: ebInputFile,
            codebaseRoot: raw.project || process.cwd(),
            anthropicClient: null,
          });

          console.log(chalk.green(`\n  ${SYM.check} Executive Brief written to: ${pdfPath}\n`));
          printUpgradeLine();
          console.log('');
        } catch (e) {
          console.error(chalk.red(`\n  Executive Brief failed: ${e.message}\n`));
        }
        break;
      }
    }
  }
}

// ── Ghost Brief ───────────────────────────────────────────────────────────
if (process.argv.includes('--brief')) {
  const { generateBrief, writeBrief } = await import('../lib/ghostBrief.js');
  const { fromFixForecast, fromPOI, fromConflict } = await import('../lib/ghostBriefAdapter.js');
  const { version } = _require('../package.json');

  const args = process.argv.slice(2);
  // Accept both `--flag=value` and space-separated `--flag value` so
  // `ghost --brief --output ./reports` works the same as `--output=./reports`.
  // Previously only the `=` form was parsed, so the space form silently fell
  // back to the default output path.
  const readFlag = (name, def) => {
    const eq = args.find(a => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('-')) {
      return args[idx + 1];
    }
    return def;
  };
  const inputFile = readFlag('--input', 'ghost-report.json');
  const outputFile = readFlag('--output', 'ghost-brief.json');

  if (!fs.existsSync(inputFile)) {
    console.error(`Ghost Brief: input file not found: ${inputFile}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } catch (e) {
    console.error(`Ghost Brief: failed to parse ${inputFile}: ${e.message}`);
    process.exit(1);
  }

  // Detect source and adapt findings
  let findings = [];
  if (raw.prompts) {
    // Already in Brief format — re-validate only
    findings = raw.prompts;
  } else if (raw.findings) {
    const mode = raw.scan_mode || raw.mode || 'fix-forecast';
    if (mode === 'fix-forecast') findings = fromFixForecast(raw.findings);
    else if (mode === 'poi') findings = fromPOI(raw.findings);
    else if (mode === 'conflict') findings = fromConflict(raw.findings);
    else findings = fromFixForecast(raw.findings); // best-effort fallback
  } else {
    console.error('Ghost Brief: input file has no recognized findings structure.');
    process.exit(1);
  }

  try {
    const brief = generateBrief({
      findings,
      ghostVersion: version,
      scanFile: inputFile,
      codebaseRoot: process.cwd(),
    });
    const { jsonPath, htmlPath } = writeBrief(brief, outputFile);
    console.log(`Ghost Brief written to: ${jsonPath}`);
    console.log(`HTML report written to: ${htmlPath}`);
    console.log(`  ${brief.summary.total_prompts} prompts | ${brief.summary.estimated_agent_hours}h estimated`);
    printUpgradeLine();

  } catch (e) {
    console.error(`Ghost Brief failed: ${e.message}`);
    process.exit(1);
  }

  process.exit(0);
}
// ── End Ghost Brief ───────────────────────────────────────────────────────

// Resolve symlinks on both sides so the `ghost` global-install symlink
// (which points at this file via realpath) is recognized as the entry
// point and triggers main(). The fallback catches edge cases where
// realpathSync throws (unusual but cheap to guard against).
const isMain = () => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
};

if (isMain()) {
  // Last-resort safety nets so an unhandled promise rejection or a throw
  // outside the main() chain still gets the friendly, support-linked message
  // instead of a raw stack trace. Registered inside the isMain() guard so
  // importing this module in tests never installs process-wide handlers.
  process.on('unhandledRejection', (reason) => {
    showFriendlyError(reason instanceof Error ? reason : new Error(String(reason)));
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    showFriendlyError(err);
    process.exit(1);
  });

  main().catch(err => {
    showFriendlyError(err);
    process.exit(1);
  });
}

