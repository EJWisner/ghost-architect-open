#!/usr/bin/env node

import chalk from 'chalk';
import gradient from 'gradient-string';
import figlet from 'figlet';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { isConfigured, runSetupWizard, reconfigure, usingEnvKey } from '../src/config.js';
import { loadCodebase, loadFromPath } from '../src/loader/index.js';
import { runChatMode } from '../src/modes/chat.js';
import { runPOIMode } from '../src/modes/poi.js';
import { runBlastMode } from '../src/modes/blast.js';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };
// Override Inquirer Unicode symbols on Windows
if (process.platform === 'win32') {
  process.env.FORCE_STDIN_TTY = '1';
}
const inquirerTheme = process.platform === 'win32' ? {
  icon: { cursor: '>' }
} : {};


import { runConflictMode } from '../src/modes/conflict.js';

import { SessionCostTracker } from '../src/estimator.js';
// Ghost Open — Pro features unavailable in this version
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


const VERSION   = '4.7.6';
const COPYRIGHT = 'Copyright © 2026 Ghost Architect. All rights reserved.';

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

  // Copyright line
  console.log(chalk.gray(`  ${COPYRIGHT}\n`));

  // Env var notice
  if (usingEnvKey()) {
    console.log(chalk.gray('  ') + chalk.green(IS_WINDOWS ? '[KEY] Using ANTHROPIC_API_KEY from environment' : '⚡ Using ANTHROPIC_API_KEY from environment') + '\n');
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
