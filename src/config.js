import Configstore from 'configstore';
import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { getContextCap } from './loader/contextCap.js';
import { MODEL_RATES, getPricing } from './core/estimator.js';

// ── Configstore path resolution (Linux sudo/root hardening) ──────────────────
// configstore@6 resolves to ${XDG_CONFIG_HOME || ~/.config}/configstore/<name>.json
// via os.homedir()/env at import time. Under `sudo` on Linux, HOME=/root, so
// `sudo ghost --reconfigure` would write settings to /root/.config/... while a
// normal relaunch (as the user) reads ~/.config/... and finds nothing. When we
// are root via sudo we redirect to the invoking user's REAL home so settings
// land where the normal relaunch looks. macOS, Windows, and non-sudo runs are
// unchanged (resolveConfigstorePath returns undefined).
const CONFIGSTORE_NAME = 'ghost-architect';

// ── Selectable scan models ─────────────────────────────────────────────────
//
// The wizard picker used to be a hardcoded two-entry list (sonnet-4-6,
// opus-4-7) while MODEL_RATES priced nine models. Everything newer than
// opus-4-7 (Sonnet 5, Opus 4.8, Fable 5) was priced, supported, and completely
// unreachable from the UI. Listing the ids here and validating them against
// MODEL_RATES means a model can never again be priced-but-unpickable, and a
// typo'd id fails loudly at startup instead of silently falling back to Sonnet
// pricing in every cost estimate.
//
// Order is the menu order. Index 0 is the default.
//
// Blurbs may be a string or a function of the current date, so time-scoped
// copy (introductory pricing windows) expires on its own instead of going
// stale in a shipped binary.
const SELECTABLE_MODELS = [
  ['claude-sonnet-4-6', 'recommended, best balance of speed and depth'],
  ['claude-sonnet-5',   (now) => now < new Date('2026-09-01T00:00:00Z')
    ? 'newer Sonnet, introductory pricing through Aug 31 2026'
    : 'newer Sonnet'],
  ['claude-opus-4-8',   'more capable, slower, costlier'],
  ['claude-fable-5',    'deepest synthesis, highest cost'],
];

// Validate at module load (fail loudly on a typo'd id), but build the priced
// labels at CALL time via getPricing(): estimator pricing is date-aware
// (Sonnet 5 flips from $2/$10 to $3/$15 on Sep 1 2026), and a label built once
// from raw MODEL_RATES would keep quoting the intro price after the estimator
// started billing the standard one — a silent misquote on the exact surface
// this picker exists to make honest (Audit 7, finding 2.1).
for (const [value] of SELECTABLE_MODELS) {
  if (!MODEL_RATES[value]) {
    throw new Error(
      `config.js: model "${value}" is offered in the picker but has no entry in ` +
      `MODEL_RATES (src/core/estimator.js). Cost estimates would silently fall ` +
      `back to Sonnet pricing. Add the rate or remove the choice.`
    );
  }
}

// Shared with bin/ghost.js's "Change scan model" reconfigure item so the wizard
// and the reconfigure menu can never offer different models. Returns a fresh
// copy: inquirer mutates choice objects.
export function getModelChoices() {
  const now = new Date();
  return SELECTABLE_MODELS.map(([value, blurb]) => {
    // Show the real per-million rates so the buyer sees the cost delta at the
    // moment they choose, not after the scan. Batch mode halves both figures.
    const rate  = getPricing(value, now);
    const price = `$${rate.inputPerM.toFixed(0)}/$${rate.outputPerM.toFixed(0)} per Mtok`;
    const text  = typeof blurb === 'function' ? blurb(now) : blurb;
    return { name: `${value} (${text}) ${price}`, value };
  });
}

function isLinuxSudoRoot() {
  return process.platform === 'linux'
    && typeof process.getuid === 'function'
    && process.getuid() === 0
    && !!process.env.SUDO_USER;
}

// Resolve a username's home WITHOUT trusting $HOME (sudo rewrites it to /root).
// getent respects NSS/LDAP; /etc/passwd is the local fallback. null = unknown.
function resolveUserHome(username) {
  try {
    const out = execFileSync('getent', ['passwd', username], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const home = out.split('\n')[0]?.split(':')[5];
    if (home && home.trim()) return home.trim();
  } catch { /* getent absent or user unknown */ }
  try {
    for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const f = line.split(':');
      if (f[0] === username && f[5] && f[5].trim()) return f[5].trim();
    }
  } catch { /* unreadable */ }
  return null;
}

// Absolute configstore path this process should use, or undefined to let
// configstore use its own default resolution.
function resolveConfigstorePath() {
  if (isLinuxSudoRoot()) {
    const realHome = resolveUserHome(process.env.SUDO_USER);
    if (realHome) {
      // Deliberately ~/.config: the invoking user's own XDG_CONFIG_HOME is not
      // visible under sudo, and root's XDG_CONFIG_HOME points at root's dir.
      return path.join(realHome, '.config', 'configstore', `${CONFIGSTORE_NAME}.json`);
    }
  }
  return undefined;
}

const CONFIG_PATH = resolveConfigstorePath();
const config = CONFIG_PATH
  ? new Configstore(CONFIGSTORE_NAME, {}, { configPath: CONFIG_PATH })
  : new Configstore(CONFIGSTORE_NAME);

// Distinguishes a user-initiated cancellation (Ctrl+C, force-closed prompt)
// from a real system failure (read-only or full configstore directory,
// EACCES, ENOSPC, corrupted config). Exported for test coverage.
//
// Only a genuine user abort returns true. Everything else is a system error
// that must surface its real reason and exit non-zero, otherwise the tool
// lies about what went wrong and (via exit 0) tells CI/scripts that setup
// succeeded when it did not.
export function isSetupUserAbort(err) {
  if (!err) return false;
  // Modern @inquirer/prompts rejects a Ctrl+C with a named ExitPromptError.
  if (err.name === 'ExitPromptError') return true;
  // A SIGINT surfacing as a catchable error rather than a process signal.
  if (err.code === 'SIGINT' || err.signal === 'SIGINT') return true;
  // Legacy inquirer / readline abort phrasings.
  const msg = String(err.message || '');
  return /force closed the prompt|user force closed|prompt was canceled|cancell?ed by user/i.test(msg);
}

// Shared handler for an interrupted interactive setup. Branches on the cause:
//
//   - User abort (Ctrl+C, closed prompt): not a failure. Any partial progress
//     already persisted is preserved. Friendly message, exit 0.
//   - System failure (filesystem error, corrupted configstore, etc.): the user
//     needs to see what actually broke so they can fix it. Log the real error
//     details and exit 1 so automation halts instead of treating a silent
//     failure as success.
function handleSetupInterrupt(err) {
  if (isSetupUserAbort(err)) {
    console.log('\n' + chalk.yellow('Setup cancelled by user. Nothing was saved; your existing configuration is unchanged.'));
    console.log(chalk.gray('Run the command again to finish configuring Ghost Architect.\n'));
    process.exit(0);
  }

  const reason = (err && (err.message || err.code)) || 'unknown error';
  console.error('\n' + chalk.red('Setup failed: ' + reason));
  if (err && err.code) console.error(chalk.gray('  Error code: ' + err.code));
  if (err && err.stack) console.error(chalk.gray(err.stack));
  console.error(chalk.gray('\nThis is a system error, not a cancellation. Resolve the issue above, then run setup again.\n'));
  process.exit(1);
}

// Re-assert owner-only (0600) permissions on the config file. configstore
// already writes it with mode 0o600, but we re-tighten after every write as
// defense in depth: it corrects a file whose permissions were loosened by a
// manual edit or an umask-affected older install, and keeps the "owner-only
// file permissions" privacy claim true. Best-effort — a no-op / throw on
// Windows or restricted filesystems is swallowed.
export function secureConfigFile() {
  try {
    fs.chmodSync(config.path, 0o600);
  } catch (_) {
    // chmod is best-effort — non-fatal on Windows or restricted filesystems
  }
}
// Tighten on first load in case a prior write (or older install) left the file
// with looser permissions than configstore's default.
secureConfigFile();

export function getConfig() { return config; }

export function resolveApiKey() {
  return process.env.ANTHROPIC_API_KEY || config.get('anthropicApiKey') || null;
}

export function resolveGitHubToken() {
  return process.env.GITHUB_TOKEN || config.get('githubToken') || null;
}

// Configured means "the user has finished the setup wizard at least once",
// NOT "the user has an API key". A keyless-by-choice user (env-var BYOK, or
// planning to add a key later) is still configured and must not replay the
// wizard every launch. The resolveApiKey() fallback keeps pre-wizardComplete
// installs (an existing key, no flag yet) from being forced back through setup.
export function isConfigured() {
  return config.get('wizardComplete') === true || !!resolveApiKey();
}

export function usingEnvKey() { return !!process.env.ANTHROPIC_API_KEY; }

export async function runSetupWizard() {
 try {
  console.log('\n' + boxen(
      chalk.cyan.bold('GHOST ARCHITECT - FIRST RUN SETUP') + '\n\n' +
      chalk.gray('Configure your environment.\n') +
      chalk.gray('Your API key is stored locally and only sent to Anthropic.'),
      { padding: 1, borderColor: 'cyan', borderStyle: 'double' }
  ));
  console.log('');

  console.log(boxen(
      chalk.white.bold('Privacy notice') + '\n\n' +
      chalk.gray('Code passes through analysis and is immediately discarded.\n') +
      chalk.gray('Never retained between sessions, never used to train models.\n\n') +
      chalk.gray('Stored locally on your machine:\n') +
      chalk.gray('  - Your API key (stored locally with owner-only file permissions)\n') +
      chalk.gray('  - Your preferences\n') +
      chalk.gray('  - Reports YOU choose to save\n\n') +
      chalk.green('Safe for proprietary and client codebases.'),
      { padding: 1, borderColor: 'green', borderStyle: 'round' }
  ));
  console.log('');

  // Default the context prompt to the full ceiling. getContextCap is the
  // single source of truth (src/loader/contextCap.js); no cap numbers live here.
  const contextCap = getContextCap();

  const answers = await inquirer.prompt([
    {
      type: 'password',
      name: 'anthropicApiKey',
      message: chalk.cyan('Anthropic API Key:'),
      mask: '*',
      // Trim the stored key so a stray leading/trailing space (common when
      // pasting a key) doesn't get persisted and later corrupt the auth header.
      filter: (val) => (val || '').trim(),
      // Non-blocking validation. A user with no key -- or a non-sk-ant- value --
      // must still be able to reach the free Recon mode, which makes no API
      // call. So we warn but never reject: an empty string and a malformed key
      // both pass through. The first real API call has its own friendly 401
      // handler that tells the user their key is missing or invalid.
      validate: (val) => {
        // Trim before the prefix check so a leading space doesn't trip it.
        const key = (val || '').trim();
        if (key.startsWith('sk-ant-')) return true;
        console.log('\n' + chalk.yellow(
          'Warning: key does not look like an Anthropic API key (should start with sk-ant-). ' +
          'You can continue, but scans requiring the API will fail until a valid key is set.'
        ));
        return true;
      }
    },
    {
      type: 'list',
      name: 'needsGithubToken',
      message: chalk.cyan('Do you need to access private GitHub repositories?'),
      choices: [
        { name: 'Yes - private repos', value: true },
        { name: 'No - public repos and ZIP files only', value: false },
      ],
      default: 1
    },
    {
      type: 'password',
      name: 'githubToken',
      message: chalk.cyan('GitHub Personal Access Token') + chalk.gray('\n') +
               chalk.gray('  Create one at: github.com/settings/tokens\n') +
               chalk.gray('  Required scope: repo (Full control of private repositories)\n') +
               chalk.gray('  Token format: ghp_xxxxxxxxxxxxxxxxxxxx\n') +
               chalk.cyan('  Token: '),
      mask: '*',
      when: (answers) => answers.needsGithubToken === true,
      validate: (val) => {
        if (!val) return 'Please enter your GitHub token or go back and select No';
        if (!val.startsWith('ghp_') && !val.startsWith('github_pat_')) {
          return 'Token should start with ghp_ or github_pat_';
        }
        return true;
      }
    },
    {
      type: 'list',
      name: 'defaultModel',
      message: chalk.cyan('Default Claude model:'),
      choices: getModelChoices(),
      default: 0
    },
    {
      type: 'number',
      name: 'maxTokensContext',
      message: chalk.cyan(`Max file context size in tokens (${contextCap.toLocaleString()} = the maximum):`),
      default: contextCap,
    },
    {
      type: 'number',
      name: 'rateJunior',
      message: chalk.cyan('Junior developer hourly rate ($/hr, LOW complexity):'),
      default: 85,
    },
    {
      type: 'number',
      name: 'rateMid',
      message: chalk.cyan('Mid-level developer hourly rate ($/hr, MEDIUM complexity):'),
      default: 125,
    },
    {
      type: 'number',
      name: 'rateSenior',
      message: chalk.cyan('Senior/Architect hourly rate ($/hr, HIGH/CRITICAL complexity):'),
      default: 200,
    },
  ]);

  // Persist the whole config block atomically, only after EVERY answer has
  // been collected. Collecting the rates in the same prompt list (rather than
  // a second inquirer.prompt call) means an interrupt at any question leaves
  // the configstore completely untouched, so modes never see a half-written
  // config where some fields are present and others absent. It also keeps the
  // "No changes were lost" cancellation message honest: nothing is written
  // until this point, so a Ctrl+C before here truly loses nothing.
  //
  // The object form of config.set persists all keys in a single file write,
  // so even a filesystem failure cannot leave a subset of fields on disk.
  const block = {
    // wizardComplete records that the user finished setup at least once. It is
    // what isConfigured() keys on, so a user who deliberately declines to set
    // an API key (BYOK via env var, or configuring one later) is not dragged
    // back through the wizard on every launch.
    wizardComplete: true,
    anthropicApiKey: answers.anthropicApiKey,
    defaultModel: answers.defaultModel,
    maxTokensContext: answers.maxTokensContext || contextCap,
    rateJunior: answers.rateJunior || 85,
    rateMid: answers.rateMid || 125,
    rateSenior: answers.rateSenior || 200,
  };
  if (answers.githubToken) block.githubToken = answers.githubToken;
  config.set(block);
  secureConfigFile();

  console.log('\n' + chalk.green('Configuration saved.\n'));
 } catch (err) {
  handleSetupInterrupt(err);
 }
}

export async function reconfigure() {
  try {
    console.log(chalk.yellow('\nReconfiguring Ghost Architect...\n'));
    await runSetupWizard();
  } catch (err) {
    handleSetupInterrupt(err);
  }
}
