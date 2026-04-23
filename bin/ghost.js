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
import { TIER_CAPS, getTierCap } from '../src/loader/tierCaps.js';
import { listPresets } from '../src/loader/excludes.js';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };
if (process.platform === 'win32') {
  process.env.FORCE_STDIN_TTY = '1';
}
const inquirerTheme = process.platform === 'win32' ? { icon: { cursor: '>' } } : {};

import { runConflictMode } from '../src/modes/conflict.js';
import { SessionCostTracker } from '../src/estimator.js';

function showUpgradePrompt(feature) {
  console.log('\n' + boxen(
    chalk.yellow.bold('⬆  Ghost Pro Feature') + '\n\n' +
    chalk.white(feature + ' is available in Ghost Pro.\n') +
    chalk.gray('Full PDF, markdown, multipass, project intelligence.\n') +
    chalk.gray('Know what you are inheriting before you commit.\n\n') +
    chalk.cyan('ghostarchitect.dev'),
    { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
  ));
}

const VERSION      = '4.9.0';
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

async function selectInputMethod() {
  const choices = [
    { name: IS_WINDOWS ? '[DIR] Local directory' : '📁  Local directory', value: 'files' },
    { name: IS_WINDOWS ? '[ZIP] ZIP file' : '🗜   ZIP file', value: 'zip' },
    { name: IS_WINDOWS ? '[GIT] GitHub repository' : '🐙  GitHub repository', value: 'github' },
    new inquirer.Separator(),
    { name: (IS_WINDOWS ? '[PRO] Project Dashboard  ' : '⬆   Project Dashboard  ') + (IS_WINDOWS ? '' : chalk.gray('— Ghost Pro feature')), value: 'dashboard_locked' },
    { name: (IS_WINDOWS ? '[PRO] Compare Reports  ' : '⬆   Compare Reports  ') + (IS_WINDOWS ? '' : chalk.gray('— Ghost Pro feature')), value: 'compare_locked' },
    new inquirer.Separator(),
  ];

  if (!usingEnvKey()) {
    choices.push({ name: IS_WINDOWS ? '[CFG] Reconfigure Ghost Architect' : '⚙   Reconfigure Ghost Architect', value: 'reconfigure' });
  }
  choices.push({ name: IS_WINDOWS ? '[EXIT] Exit' : '🚪  Exit', value: 'exit' });

  const { method } = await inquirer.prompt([{
    type: 'list',
    name: 'method',
    message: chalk.cyan('Load project from:'),
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
      { name: (IS_WINDOWS ? '[PRO] Compare Reports  ' : '⬆   Compare Reports  ') + (IS_WINDOWS ? '' : chalk.gray('— Ghost Pro feature')), value: 'compare_locked' },
      { name: (IS_WINDOWS ? '[PRO] Project Dashboard  ' : '⬆   Project Dashboard  ') + (IS_WINDOWS ? '' : chalk.gray('— Ghost Pro feature')), value: 'dashboard_locked' },
      new inquirer.Separator(),
      { name: IS_WINDOWS ? '[RLD] New Scan  — scan a different directory' : '🔄  New Scan  — scan a different directory', value: 'reload' },
      { name: IS_WINDOWS ? '[EXIT] Exit' : '🚪  Exit', value: 'exit' },
    ]
  }]);

  return mode;
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  // Non-interactive scan mode for Claude Code plugin
  if (process.argv.includes("--scan")) {
    const dirPath = process.cwd();
    console.log(`Ghost Architect scanning: ${dirPath}`);
    const codebaseContext = await loadFromPath(dirPath);
    if (codebaseContext) await runPOIMode(codebaseContext, { nonInteractive: true });
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

      if (method === 'dashboard_locked' || method === 'compare_locked') {
        showUpgradePrompt(method === 'dashboard_locked' ? 'Project Dashboard' : 'Compare Reports');
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

    switch (mode) {
      case 'chat':      await runChatMode(codebaseContext);     break;
      case 'poi':       await runPOIMode(codebaseContext);      break;
      case 'blast':     await runBlastMode(codebaseContext);    break;
      case 'conflict':  await runConflictMode(codebaseContext); break;
      case 'compare_locked':   showUpgradePrompt('Compare Reports');   break;
      case 'dashboard_locked': showUpgradePrompt('Project Dashboard'); break;
    }
  }
}

main().catch(err => {
  console.error(chalk.red('\n' + SYM.cross + ' Fatal error:'), err.message);
  process.exit(1);
});
