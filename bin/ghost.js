#!/usr/bin/env node

import chalk from 'chalk';
import gradient from 'gradient-string';
import figlet from 'figlet';
import boxen from 'boxen';
import inquirer from 'inquirer';
import Configstore from 'configstore';
import { isConfigured, runSetupWizard, reconfigure, usingEnvKey } from '../src/config.js';
import { loadCodebase, loadFromPath, setScanOptions } from '../src/loader/index.js';
import { runChatMode } from '../src/modes/chat.js';
import { runPOIMode } from '../src/modes/poi.js';
import { runBlastMode } from '../src/modes/blast.js';
import { runReconMode } from '../src/modes/recon.js';
import { runPromptTriageMode } from '../src/modes/prompt-triage.js';
import { runAuditMode } from '../src/modes/audit/index.js';
import { listModelsForPicker } from '../src/prompt-pack/models.js';
import { TIER_CAPS, getTierCap } from '../src/loader/tierCaps.js';
import { checkFirstRun, pingModeUsage } from '../src/onboarding/firstRun.js';
import { listPresets } from '../src/loader/excludes.js';
import fs from 'fs';
import path from 'path';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };
if (process.platform === 'win32') {
  process.env.FORCE_STDIN_TTY = '1';
}
const inquirerTheme = process.platform === 'win32' ? { icon: { cursor: '>' } } : {};

import { runConflictMode } from '../src/modes/conflict.js';
import { SessionCostTracker } from '../src/estimator.js';

// Ghost Open v5.0.0: Compare Reports and Project Dashboard are Pro features
// and were removed entirely from the Open menu (rather than shown as locked
// teasers). The showUpgradePrompt function that displayed them was removed
// in this version. Recon was added as a fifth mode.

const VERSION      = '5.4.2';
// TIER is branch-specific. main = Pro, ghost-team = Team, ghost-open = Open.
// When cherry-picking this file across branches, change this constant to match.
const TIER         = 'open';
const NPM_PACKAGE  = 'ghost-architect-open';
const COPYRIGHT    = 'Copyright © 2026 Ghost Architect. All rights reserved.';
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// ── Update checker ────────────────────────────────────────────────────────────

let _updateMessage = null;

async function checkForUpdate() {
  try {
    const store = new Configstore('ghost-architect');
    const lastCheck    = store.get('updateLastChecked')    || 0;
    const cachedLatest = store.get('updateLatestVersion')  || null;

    const now = Date.now();
    let latestVersion = cachedLatest;

    if (now - lastCheck > UPDATE_CHECK_INTERVAL || !cachedLatest) {
      const response = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const data = await response.json();
        latestVersion = data.version;
        store.set('updateLastChecked', now);
        store.set('updateLatestVersion', latestVersion);
      }
    }

    if (!latestVersion) return;

    const current = VERSION.split('.').map(Number);
    const latest  = latestVersion.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      if ((latest[i] || 0) > (current[i] || 0)) {
        _updateMessage = `v${latestVersion} available  →  npm install -g ${NPM_PACKAGE}@latest`;
        break;
      }
      if ((latest[i] || 0) < (current[i] || 0)) break;
    }
  } catch {
    // Fail silently — never block startup
  }
}

const updateCheckPromise = checkForUpdate();

// ── CLI argument parsing ────────────────────────────────────────────────────
// Supports:
//   --max-context N             override context cap (will be clamped to tier cap)
//   --exclude "glob"            exclude paths matching glob (repeatable)
//   --exclude-presets a,b       apply named exclusion preset(s), comma-separated
//   --help / -h                 print usage and exit
//   --version / -v              print version and exit
function parseArgs(argv) {
  const out = {
    maxContext: null,
    excludes: [],
    presets: [],
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
        console.error(chalk.red(`✗ --max-context requires a positive integer (got: ${v})`));
        process.exit(2);
      }
      out.maxContext = n;
      continue;
    }
    if (a.startsWith('--max-context=')) {
      const v = a.slice('--max-context='.length);
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(chalk.red(`✗ --max-context requires a positive integer (got: ${v})`));
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
Ghost Architect — AI-powered codebase archaeology (v${VERSION}, ${TIER} tier)

Usage:
  ghost [options]

Options:
  --max-context N          Override context cap in tokens. Clamped to your tier limit.
                           Tier caps: open=${TIER_CAPS.open.toLocaleString()}, pro=${TIER_CAPS.pro.toLocaleString()}, team=${TIER_CAPS.team.toLocaleString()}, enterprise=${TIER_CAPS.enterprise.toLocaleString()}
  --exclude "glob"         Exclude files matching glob pattern (repeatable).
                           Example: --exclude "seeds/**" --exclude "*.fixture.js"
  --exclude-presets a,b    Apply named exclusion preset(s), comma-separated.
                           Available presets: ${presets}
  --version, -v            Print version and exit.
  --help, -h               Print this help and exit.

When flags are omitted, Ghost runs interactively and uses your configured defaults.

Anonymous telemetry: set GHOST_NO_PING=1 to disable all phone-home pings.
`);
}

// ── Banner ──────────────────────────────────────────────────────────────────

function printBanner() {
  console.clear();
  const title = figlet.textSync('GHOST  OPEN', { font: 'Doom', horizontalLayout: 'default' });
  const ghostGradient = gradient(['#00ffff', '#0088ff', '#004488']);
  console.log(ghostGradient(title));

  console.log(
    chalk.gray('  ') +
    chalk.cyan.bold('ARCHITECT') +
    chalk.gray('  —  AI-powered codebase archaeology') +
    chalk.gray(`  v${VERSION}\n`)
  );

  console.log(chalk.gray(`  ${COPYRIGHT}\n`));

  if (usingEnvKey()) {
    console.log(chalk.gray('  ') + chalk.green(IS_WINDOWS ? '[KEY] Using ANTHROPIC_API_KEY from environment' : '⚡ Using ANTHROPIC_API_KEY from environment') + '\n');
  }

  if (_updateMessage) {
    console.log(chalk.gray('  ') + chalk.yellow('💡 ' + _updateMessage) + '\n');
  }
}

// ── Input method selector ───────────────────────────────────────────────────
//
// Grouped by what the user is analyzing, not just where the input comes from.
// Prompt Triage was previously stacked alongside Local/ZIP/GitHub which made
// it look like just another way to load a code project — users couldn't find
// it because they were looking in the mode menu (Chat/POI/Blast/Conflict/
// Recon) instead. Now the menu is grouped by analysis target with named
// separators so Prompt Triage is visually distinct from code-loading options.

async function selectInputMethod() {
  const codeAnalysisGroupLabel    = IS_WINDOWS ? '── Code analysis ──' : '─── Code analysis ──────';
  const promptAnalysisGroupLabel  = IS_WINDOWS ? '── Prompt analysis ──' : '─── Prompt analysis ────';
  const otherGroupLabel           = IS_WINDOWS ? '── Other ──' : '─── Other ──────────────';

  const choices = [
    new inquirer.Separator(codeAnalysisGroupLabel),
    { name: IS_WINDOWS ? '[DIR] Local directory' : '📁  Local directory' + chalk.gray('       — scan a code project on disk'), value: 'files' },
    { name: IS_WINDOWS ? '[ZIP] ZIP file' : '🗜   ZIP file' + chalk.gray('              — scan an archived code project'), value: 'zip' },
    { name: IS_WINDOWS ? '[GIT] GitHub repository' : '🐙  GitHub repository' + chalk.gray('     — clone & scan from GitHub'), value: 'github' },

    new inquirer.Separator(promptAnalysisGroupLabel),
    { name: (IS_WINDOWS ? '[PRT] Prompt Triage' : '🧪  Prompt Triage') + chalk.gray('         — audit a folder of LLM prompts for defects'), value: 'prompt-triage' },

    new inquirer.Separator(otherGroupLabel),
  ];

  if (!usingEnvKey()) {
    choices.push({ name: IS_WINDOWS ? '[CFG] Reconfigure Ghost Architect' : '⚙   Reconfigure Ghost Architect', value: 'reconfigure' });
  }
  choices.push({ name: IS_WINDOWS ? '[EXIT] Exit' : '🚪  Exit', value: 'exit' });

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

  const { mode } = await inquirer.prompt([{
    type: 'list',
    name: 'mode',
    message: chalk.cyan('\nWhat do you want to do?'),
    theme: inquirerTheme,
    choices: [
      { name: IS_WINDOWS ? '[CHT] Chat  ' : '💬  Chat  ' + chalk.gray('— Ask anything about this project'), value: 'chat' },
      { name: IS_WINDOWS ? '[POI] Points of Interest Scan  ' : '🗺   Points of Interest Scan  ' + chalk.gray('— Auto-map red flags, landmarks, dead zones, fault lines'), value: 'poi' },
      { name: IS_WINDOWS ? '[BLT] Blast Radius Analysis  ' : '💥  Blast Radius Analysis  ' + chalk.gray('— Impact map + rollback plan'), value: 'blast' },
      { name: IS_WINDOWS ? '[CNF] Conflict Detection  ' : '⚡  Conflict Detection  ' + chalk.gray('— Find contract mismatches, schema conflicts, config errors'), value: 'conflict' },
      { name: IS_WINDOWS ? '[REC] Recon  ' : '🔍  Recon  ' + chalk.gray('— Sizing & engagement plan, no analysis'), value: 'recon' },
      { name: IS_WINDOWS ? '[AUD] Inheritance Audit  ' : '📋  Inheritance Audit  ' + chalk.gray('— Deal-grade audit for buyers, PE, fractional CTOs (Pro)'), value: 'audit' },
      new inquirer.Separator(),
      { name: IS_WINDOWS ? '[RLD] New Scan  — scan a different directory' : '🔄  New Scan  — scan a different directory', value: 'reload' },
      { name: IS_WINDOWS ? '[EXIT] Exit' : '🚪  Exit', value: 'exit' },
    ]
  }]);

  return mode;
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  // Non-interactive scan mode for Claude Code plugin.
  // v5.4.1: this path now also fires a telemetry ping so we can see
  // Claude Code plugin usage in Pulse. Source tag forces it into the
  // 'cli-firstrun-claude-code' / 'cli-usage-claude-code' buckets.
  if (process.argv.includes("--scan")) {
    // Ping happens BEFORE the scan so even a crash during scanning
    // doesn't lose the install record. Awaited so the request actually
    // completes before process.exit() below kills the event loop.
    try {
      await checkFirstRun(VERSION, 'claude-code');
    } catch (_) {
      // Telemetry must never block real work. Swallow and continue.
    }
    const dirPath = process.cwd();
    console.log(`Ghost Architect scanning: ${dirPath}`);
    const codebaseContext = await loadFromPath(dirPath);
    if (codebaseContext) {
      // Mode-usage telemetry — Claude Code plugin invokes POI directly.
      // Awaited (not fire-and-forget) because process.exit(0) below
      // would otherwise kill the event loop before the ping lands.
      try { await pingModeUsage(VERSION, 'poi'); } catch (_) {}
      await runPOIMode(codebaseContext, { nonInteractive: true });
    }
    process.exit(0);
  }

  // Wait briefly for update check before first banner
  await Promise.race([updateCheckPromise, new Promise(r => setTimeout(r, 500))]);

  // Parse CLI flags so --help / --version / --max-context etc. are honored
  // before we print the banner or run the setup wizard.
  const argv = process.argv.slice(2);
  const cliOpts = parseArgs(argv);

  if (cliOpts.help)    { printUsage(); process.exit(0); }
  if (cliOpts.version) { console.log(`ghost-architect v${VERSION} (${TIER})`); process.exit(0); }

  // Seed the loader with this run's tier + CLI-driven options.
  // Caps get clamped; excludes get merged with presets at scan time.
  setScanOptions({
    tier: TIER,
    maxContextOverride: cliOpts.maxContext,
    excludePresets: cliOpts.presets,
    excludePatterns: cliOpts.excludes,
  });

  printBanner();

  // First-run email capture (Open only). Runs once per machine on
  // initial CLI invocation. Fully optional, graceful failure.
  // v5.4.1: now also fires anonymous ping in non-TTY contexts
  // (Docker, CI, piped scripts) with environment-tagged source.
  // See src/onboarding/firstRun.js for the full design.
  await checkFirstRun(VERSION);

  if (!isConfigured()) {
    console.log(boxen(
      chalk.yellow.bold('Welcome to Ghost Architect!') + '\n' +
      chalk.gray('Looks like this is your first time here.\nLet\'s get you set up.'),
      { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
    ));
    console.log('');
    await runSetupWizard();
    printBanner();
  }

  let codebaseContext = null;
  const session = new SessionCostTracker();

  while (true) {
    if (!codebaseContext) {
      const method = await selectInputMethod();

      if (method === 'exit') {
        session.showSummary();
        console.log(chalk.cyan('\nIntel gathered. Go make your move.\n'));
        console.log(chalk.gray(`${COPYRIGHT}\n`));
        process.exit(0);
      }

      if (method === 'reconfigure') {
        await reconfigure();
        printBanner();
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
          message: chalk.cyan('Folder containing prompt files (absolute path):'),
          theme: inquirerTheme,
          validate: (input) => {
            if (!input || !input.trim()) return 'Folder path is required.';
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
          const answer = await inquirer.prompt([{
            type: 'list',
            name: 'targetModel',
            message: chalk.cyan('Target model:'),
            choices: modelChoices,
            pageSize: 12,
            theme: inquirerTheme,
          }]);
          targetModel = answer.targetModel;
        }

        // Mode-usage telemetry. See main switch below for design notes.
        pingModeUsage(VERSION, 'prompt-triage').catch(() => {});

        try {
          await runPromptTriageMode({
            source: { kind: 'localFolder', path: folderPath.trim() },
            targetModel,
            tier: TIER,
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

    if (mode === 'exit') {
      session.showSummary();
      console.log(chalk.cyan('\nIntel gathered. Go make your move.\n'));
      console.log(chalk.gray(`${COPYRIGHT}\n`));
      process.exit(0);
    }

    if (mode === 'reload') {
      codebaseContext = null;
      printBanner();
      continue;
    }

    // Mode-usage telemetry. Anonymous, fire-and-forget, captures
    // which mode the user selected from the menu so Pulse can show
    // a "Scan Modes" breakdown across the install base. Never blocks
    // the mode dispatch itself — if the network is slow, the scan
    // still runs at full speed.
    pingModeUsage(VERSION, mode).catch(() => {});

    switch (mode) {
      case 'chat':      await runChatMode(codebaseContext);     break;
      case 'poi':       await runPOIMode(codebaseContext);      break;
      case 'blast':     await runBlastMode(codebaseContext);    break;
      case 'conflict':  await runConflictMode(codebaseContext); break;
      case 'recon':     await runReconMode(codebaseContext);    break;
      case 'audit':     await runAuditMode(codebaseContext, { tier: TIER }); break;
    }
  }
}

main().catch(err => {
  console.error(chalk.red('\n' + SYM.cross + ' Fatal error:'), err.message);
  process.exit(1);
});
