#!/usr/bin/env node

import chalk from 'chalk';
import gradient from 'gradient-string';
import figlet from 'figlet';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { isConfigured, runSetupWizard, reconfigure, usingEnvKey } from '../src/config.js';
import { loadCodebase } from '../src/loader/index.js';
import { runChatMode } from '../src/modes/chat.js';
import { runPOIMode } from '../src/modes/poi.js';
import { runBlastMode } from '../src/modes/blast.js';
import { runCompareMode } from '../src/modes/compare.js';
import { runConflictMode } from '../src/modes/conflict.js';
import { showProjectDashboard } from '../src/projects.js';
import { SessionCostTracker } from '../src/estimator.js';

const VERSION   = '4.5.4';
const COPYRIGHT = 'Copyright © 2026 Ghost Architect. All rights reserved.';

// ── Banner ──────────────────────────────────────────────────────────────────

function printBanner() {
  console.clear();
  const title = figlet.textSync('GHOST', { font: 'Doom', horizontalLayout: 'default' });
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
    console.log(chalk.gray('  ') + chalk.green('⚡ Using ANTHROPIC_API_KEY from environment') + '\n');
  }
}

// ── Input method selector ───────────────────────────────────────────────────

async function selectInputMethod() {
  const choices = [
    { name: '📁  Local directory', value: 'files' },
    { name: '🗜   ZIP file', value: 'zip' },
    { name: '🐙  GitHub repository', value: 'github' },
    new inquirer.Separator(),
    { name: '📊  Project Dashboard  ' + chalk.gray('— Remediation progress across all projects'), value: 'dashboard' },
    { name: '🔍  Compare Reports  ' + chalk.gray('— Before/after diff of two saved reports'), value: 'compare' },
    new inquirer.Separator(),
  ];

  if (!usingEnvKey()) {
    choices.push({ name: '⚙   Reconfigure Ghost Architect', value: 'reconfigure' });
  }
  choices.push({ name: '🚪  Exit', value: 'exit' });

  const { method } = await inquirer.prompt([{
    type: 'list',
    name: 'method',
    message: chalk.cyan('Load project from:'),
    choices
  }]);
  return method;
}

// ── Mode selector ───────────────────────────────────────────────────────────

async function selectMode(codebaseContext) {
  console.log('\n' + boxen(
    chalk.green.bold('✓ Project processed') + '\n' +
    chalk.gray(`${codebaseContext.loadedFiles} files | ${codebaseContext.fileIndex.slice(0, 3).join(', ')}${codebaseContext.fileIndex.length > 3 ? '...' : ''}`),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderColor: 'green', borderStyle: 'round' }
  ));

  const { mode } = await inquirer.prompt([{
    type: 'list',
    name: 'mode',
    message: chalk.cyan('\nWhat do you want to do?'),
    choices: [
      { name: '💬  Chat  ' + chalk.gray('— Ask anything about this project'), value: 'chat' },
      { name: '🗺   Points of Interest Scan  ' + chalk.gray('— Auto-map red flags, landmarks, dead zones, fault lines'), value: 'poi' },
      { name: '💥  Blast Radius Analysis  ' + chalk.gray('— Impact map + rollback plan'), value: 'blast' },
      { name: '⚡  Conflict Detection  ' + chalk.gray('— Find contract mismatches, schema conflicts, config errors'), value: 'conflict' },
      { name: '🔍  Compare Reports  ' + chalk.gray('— Before/after diff of two saved reports'), value: 'compare' },
      { name: '📊  Project Dashboard  ' + chalk.gray('— Remediation progress across all projects'), value: 'dashboard' },
      new inquirer.Separator(),
      { name: '🔄  Load different project', value: 'reload' },
      { name: '🚪  Exit', value: 'exit' },
    ]
  }]);

  return mode;
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
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

      if (method === 'dashboard') {
        await showProjectDashboard();
        continue;
      }

      if (method === 'compare') {
        await runCompareMode();
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
      case 'compare':   await runCompareMode();                 break;
      case 'dashboard': await showProjectDashboard();           break;
    }
  }
}

main().catch(err => {
  console.error(chalk.red('\n✗ Fatal error:'), err.message);
  process.exit(1);
});
