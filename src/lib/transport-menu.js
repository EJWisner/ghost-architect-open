/**
 * Ghost Architect — Transport selection menu (streaming vs batch)
 *
 * Rendered after the codebase context loads and before a mode makes its
 * Anthropic API call. Shows a cost-aware Inquirer menu so the user can choose
 * real-time streaming or the half-price Message Batches API.
 *
 * Trigger logic (resolveTransport) decides whether to even show the menu:
 *
 *   Skip → 'streaming'  when --stream was passed.
 *   Skip → 'batch'      when --batch was passed, when running in CI, or when a
 *                       Ghost Watcher context is detected.
 *   Otherwise           render the menu and return the user's choice.
 *
 * Defaults bias toward BATCH in non-interactive contexts because those are the
 * environments (CI, Watcher) where a long-lived streaming connection is the
 * thing that drops; interactive users get a real choice with the cost framing.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { estimateTransportCost, formatMenuCost } from './cost-estimator.js';

function truthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no';
}

// Mirrors src/core/agent/loop.js's isCI(): generic CI flag plus GitHub Actions.
export function isCI() {
  return truthy(process.env.CI) || truthy(process.env.GITHUB_ACTIONS);
}

// Ghost Watcher runs headless via `--watcher-commit` inside GitHub Actions, so
// isCI() already catches it. GHOST_WATCHER is an explicit belt-and-suspenders
// signal for any future non-CI Watcher invocation.
export function isWatcherContext() {
  return truthy(process.env.GHOST_WATCHER) || truthy(process.env.GHOST_WATCHER_COMMIT);
}

/**
 * Approximate input-token count from a loaded codebase context. Mirrors the
 * ~4-chars-per-token heuristic used elsewhere in the CLI cost surfaces.
 */
export function inputTokensFromContext(codebaseContext) {
  const len = codebaseContext && codebaseContext.context ? codebaseContext.context.length : 0;
  return Math.ceil(len / 4) + 200;
}

/**
 * Render the transport menu. Returns 'streaming' | 'batch'.
 *
 * @param {object} args
 * @param {string} args.mode          mode id (blast, poi, conflict, brief, question)
 * @param {string} args.modeLabel     human label for the header ("Blast Radius")
 * @param {object} args.codebaseContext  loaded context ({ context, loadedFiles, ... })
 * @param {string} [args.model]       model id for pricing
 */
export async function showTransportMenu({ mode, modeLabel, codebaseContext, model }) {
  const inputTokens = inputTokensFromContext(codebaseContext);
  const fileCount   = (codebaseContext && (codebaseContext.loadedFiles ?? codebaseContext.totalFiles)) || 0;
  const est = estimateTransportCost({ inputTokens, mode, model });

  console.log('');
  console.log(chalk.cyan.bold(`👻 Ghost Architect™ — ${modeLabel}`));
  console.log(chalk.gray(`   Codebase loaded: ${fileCount} files (~${inputTokens.toLocaleString()} tokens)`));
  console.log('');
  console.log(chalk.white('   Estimated cost:'));
  console.log('   ' + chalk.white('• Streaming:  ') + chalk.green(formatMenuCost(est.streamingCost)) + chalk.gray('  (results in ~3 min)'));
  console.log('   ' + chalk.white('• Batch:      ') + chalk.green(formatMenuCost(est.batchCost)) + chalk.gray('  (results in ~15 min, save 50%)'));
  console.log('');

  const { transport } = await inquirer.prompt([{
    type: 'list',
    name: 'transport',
    message: chalk.cyan('How would you like to run this scan?'),
    choices: [
      { name: 'Streaming - real-time results', value: 'streaming' },
      { name: 'Batch - save 50%, retrieve when ready', value: 'batch' },
    ],
  }]);

  return transport;
}

/**
 * Decide the transport for a scan, showing the menu only when appropriate.
 *
 * @param {object} args
 * @param {object} [args.flags]  { stream, batch } from CLI parsing
 * @param {string} args.mode
 * @param {string} args.modeLabel
 * @param {object} args.codebaseContext
 * @param {string} [args.model]
 * @returns {Promise<'streaming'|'batch'>}
 */
export async function resolveTransport({ flags = {}, mode, modeLabel, codebaseContext, model }) {
  // Explicit flags win over everything.
  if (flags.stream) return 'streaming';
  if (flags.batch)  return 'batch';

  // Non-interactive contexts default to batch (durable, no long-lived stream).
  if (isCI() || isWatcherContext()) return 'batch';

  return showTransportMenu({ mode, modeLabel, codebaseContext, model });
}
