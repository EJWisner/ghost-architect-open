/**
const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };
 * Ghost Architect — Multi-Pass Scanner (CLI layer)
 * Thin wrapper: handles all prompts and display for core/multipass.js
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  buildPasses, getPassInfo, loadSession, deleteSession,
  synthesizeFromSession, runMultiPassPOI as coreRunMultiPassPOI,
  listSessions, saveSession
} from '../core/multipass.js';

export { buildPasses, listSessions } from '../core/multipass.js';

export async function runMultiPassPOI(fileMap, projectLabel, onChunk) {
  const info = getPassInfo(fileMap);

  if (info.passes.length === 1) return null;

  // Display top files
  console.log(chalk.gray(`\n  🎯 High-priority files analyzed first:`));
  info.topFiles.forEach(f => console.log(chalk.gray(`     ${f.filePath} (score: ${f.score})`)));
  console.log('');

  // Wire up CLI callbacks
  const callbacks = {
    onChunk,

    onProgress({ type, ...data }) {
      switch (type) {
        case 'passInfo':
          console.log(chalk.cyan(`  🔄 Multi-pass: ${data.totalPasses} total passes, ${data.remaining} remaining`));
          console.log(chalk.gray(`     Full run: ~$${data.estCost} and ~${data.estMinutes} minutes\n`));
          break;
        case 'passStart':
          console.log(chalk.gray(`  Pass ${data.passNum} of ${data.totalPasses} — ${data.fileCount} files (~${data.tokens.toLocaleString()} tokens)...`));
          break;
        case 'passComplete':
          console.log(chalk.green(`  ${SYM.check} Pass ${data.passNum} complete\n`));
          break;
        case 'merging':
          console.log(chalk.gray(`  🔀 Merging batch of ${data.count} passes...`));
          break;
        case 'mergeDone':
          console.log(chalk.green(`  ${SYM.check} Batch merged\n`));
          break;
        case 'mergingFinal':
          console.log(chalk.gray(`  🔀 Merging final batch...`));
          break;
        case 'synthesizing':
          console.log(chalk.cyan(`  🧠 Synthesizing ${data.groups} groups into final report...\n`));
          break;
      }
    },

    async onPassCapPrompt({ remaining, defaultCap, estCost, estMinutes }) {
      const { passCap } = await inquirer.prompt([{
        type: 'input', name: 'passCap',
        message: chalk.cyan(`Passes to run now?`) + chalk.gray(` (max ${remaining}, Enter for ${defaultCap})`),
        default: String(defaultCap),
        validate: v => { const n = parseInt(v); return (!isNaN(n) && n >= 1 && n <= remaining) ? true : `Enter 1–${remaining}`; }
      }]);
      console.log('');
      return parseInt(passCap);
    },

    async onSessionPrompt({ session, allPassCount, pct }) {
      console.log(chalk.cyan(`📂  Saved session: ${session.projectLabel} — ${session.completedPassCount}/${allPassCount} passes (${pct}% coverage)\n`));
      const { action } = await inquirer.prompt([{
        type: 'list', name: 'action',
        message: chalk.cyan('What would you like to do?'),
        choices: [
          { name: `Continue from pass ${session.completedPassCount + 1}`, value: 'continue' },
          { name: 'Generate report from completed passes now',             value: 'report'   },
          { name: 'Start over',                                            value: 'restart'  },
        ]
      }]);
      if (action === 'report') console.log(chalk.cyan('\n  🧠 Generating report from completed passes...\n'));
      return action;
    },

    async onCompletePrompt({ coverage, remaining, passCount }) {
      console.log(chalk.cyan(`\n  ${SYM.check} ${passCount} passes complete — ${coverage}% coverage`));
      console.log(chalk.gray(`  ${remaining} passes remain. Session saved.\n`));
      const { next } = await inquirer.prompt([{
        type: 'list', name: 'next',
        message: chalk.cyan('What would you like to do?'),
        choices: [
          { name: 'Generate report from completed passes now', value: 'report' },
          { name: 'Save and exit — continue next session',     value: 'save'   },
        ]
      }]);
      if (next === 'save') {
        console.log(chalk.green(`\n  ${SYM.check} Session saved — continue from pass ${passCount + 1} next time\n`));
      }
      return next;
    },
  };

  return coreRunMultiPassPOI(fileMap, projectLabel, callbacks);
}
