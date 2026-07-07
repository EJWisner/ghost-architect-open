import Configstore from 'configstore';
import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { getTierCap } from './loader/tierCaps.js';
import { getActiveTier } from './license/session.js';

// ── Configstore path resolution (Linux sudo/root hardening) ──────────────────
// configstore@6 resolves to ${XDG_CONFIG_HOME || ~/.config}/configstore/<name>.json
// via os.homedir()/env at import time. Under `sudo` on Linux, HOME=/root, so
// `sudo ghost --activate` writes the license to /root/.config/... while a normal
// relaunch (as the user) reads ~/.config/... and finds nothing -> silent Open
// tier. When we are root via sudo we redirect to the invoking user's REAL home
// so the license lands where the normal relaunch looks. macOS, Windows, and
// non-sudo runs are unchanged (resolveConfigstorePath returns undefined).
const CONFIGSTORE_NAME = 'ghost-architect';

function isLinuxSudoRoot() {
  return process.platform === 'linux'
    && typeof process.getuid === 'function'
    && process.getuid() === 0
    && !!process.env.SUDO_USER;
}

// Root on Linux via a real root login (no sudo): no signal for which user
// should own the license, so the activate flow warns instead of guessing.
export function isLinuxRootWithoutSudoUser() {
  return process.platform === 'linux'
    && typeof process.getuid === 'function'
    && process.getuid() === 0
    && !process.env.SUDO_USER;
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

// After a root/sudo WRITE, hand the store back to the invoking user so their
// later non-root writes (the monotonic last-seen ratchet on every run, and
// `ghost --configure`) don't EACCES on a root-owned file. Must run AFTER the
// file exists (i.e., after saveActivation). sudo sets SUDO_UID / SUDO_GID.
export function reconcileSudoOwnership() {
  if (!isLinuxSudoRoot() || !CONFIG_PATH) return;
  const uid = parseInt(process.env.SUDO_UID || '', 10);
  const gid = parseInt(process.env.SUDO_GID || '', 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return;
  const configstoreDir = path.dirname(CONFIG_PATH);   // .../.config/configstore
  const dotConfigDir   = path.dirname(configstoreDir); // .../.config
  // Non-recursive: only the file, its configstore dir, and .config. If .config
  // pre-existed user-owned, chown is a harmless no-op; if root just created it,
  // this hands it back. We never recurse into .config (other apps live there).
  for (const p of [dotConfigDir, configstoreDir, CONFIG_PATH]) {
    try { fs.chownSync(p, uid, gid); } catch { /* best effort */ }
  }
}

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
function secureConfigFile() {
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

export async function resolveApiKeyEnterprise() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const { getOrgApiKey } = await import('./core/enterprise.js');
    const orgKey = await getOrgApiKey();
    if (orgKey) return orgKey;
  } catch { /* non-fatal */ }
  return config.get('anthropicApiKey') || null;
}

export function resolveGitHubToken() {
  return process.env.GITHUB_TOKEN || config.get('githubToken') || null;
}

// ── Ghost Partner default profile ─────────────────────────────────────────
// When a default profile slug is set, ghost.js loads that profile at startup
// for every scan unless the user passes --no-profile or an explicit --profile
// flag overrides it. Stored as a slug (filename without extension), not a
// full path, so moving the profiles directory doesn't break the config.
export function getDefaultProfileSlug() {
  return config.get('defaultProfileSlug') || null;
}

export function setDefaultProfileSlug(slug) {
  if (slug) { config.set('defaultProfileSlug', slug); secureConfigFile(); }
  else      config.delete('defaultProfileSlug');
}

export function isConfigured() { return !!resolveApiKey(); }

export function usingEnvKey() { return !!process.env.ANTHROPIC_API_KEY; }

export function resolveTeamSync() {
  return config.get('teamSync') || [];
}

export function getDefaultTeamSync() {
  const repos = resolveTeamSync();
  return repos.length > 0 ? repos[0] : null;
}

export function addTeamSyncRepo({ name, repo, token }) {
  const existing = resolveTeamSync();
  const idx = existing.findIndex(r => r.name === name);
  if (idx >= 0) {
    existing[idx] = { name, repo, token };
  } else {
    existing.push({ name, repo, token });
  }
  config.set('teamSync', existing);
  secureConfigFile();
}

export function removeTeamSyncRepo(name) {
  const existing = resolveTeamSync().filter(r => r.name !== name);
  config.set('teamSync', existing);
  secureConfigFile();
}

export function isTeamConfigured() {
  return resolveTeamSync().length > 0;
}

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

  // Resolve the context cap from the active tier so the wizard defaults to the
  // user's actual ceiling instead of a hardcoded 50K. getTierCap is the single
  // source of truth (src/loader/tierCaps.js); getActiveTier() === null (no
  // license = Open) resolves to the Open cap. No tier-cap numbers live here.
  const tierCap = getTierCap(getActiveTier());

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
      choices: [
        { name: 'claude-sonnet-4-6 (recommended)', value: 'claude-sonnet-4-6' },
        { name: 'claude-opus-4-7 (slower, costlier, more capable)', value: 'claude-opus-4-7' },
      ],
      default: 0
    },
    {
      type: 'number',
      name: 'maxTokensContext',
      message: chalk.cyan(`Max file context size in tokens (${tierCap.toLocaleString()} = your tier cap):`),
      default: tierCap,
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
    anthropicApiKey: answers.anthropicApiKey,
    defaultModel: answers.defaultModel,
    maxTokensContext: answers.maxTokensContext || tierCap,
    rateJunior: answers.rateJunior || 85,
    rateMid: answers.rateMid || 125,
    rateSenior: answers.rateSenior || 200,
  };
  if (answers.githubToken) block.githubToken = answers.githubToken;
  config.set(block);
  secureConfigFile();

  // Note: the inline "Set up Ghost Team shared sync repo?" prompt that lived
  // here in Team v6.0.1 was removed during v7 unification. The unified
  // codebase ships to all tiers, including 3,000+ Open users who have no
  // Ghost Team license and would find an unsolicited team-sync prompt
  // confusing. Team customers use the standalone `ghost --configure-team`
  // command (configureTeamSync below) instead.
  // See TODO-architect-inline-teamsync-prompt-removed.md for rationale.

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

export async function configureTeamSync() {
 try {
  console.log('\n' + boxen(
      chalk.cyan.bold('GHOST TEAM SYNC SETUP') + '\n\n' +
      chalk.gray('Configure a shared GitHub repo for your team.\n') +
      chalk.gray('All seats push and pull project data to this repo.\n\n') +
      chalk.gray('You will need:\n') +
      chalk.gray('  - A private GitHub repo\n') +
      chalk.gray('  - A GitHub PAT with repo read/write access'),
      { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  const existing = resolveTeamSync();
  if (existing.length > 0) {
    console.log(chalk.gray('  Current workspaces:'));
    existing.forEach(r => console.log(chalk.gray('    - ' + r.name + ': ' + r.repo)));
    console.log('');
  }

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'syncName',
      message: chalk.cyan('Workspace name:'),
      default: 'default',
      validate: v => v.trim().length > 0 ? true : 'Name is required',
    },
    {
      type: 'input',
      name: 'syncRepo',
      message: chalk.cyan('Sync repo URL:'),
      validate: v => v.includes('github.com') ? true : 'Must be a GitHub repo URL',
    },
    {
      type: 'password',
      name: 'syncToken',
      message: chalk.cyan('GitHub PAT for sync repo:'),
      mask: '*',
      validate: v => {
        if (!v) return 'Token is required';
        if (!v.startsWith('ghp_') && !v.startsWith('github_pat_')) return 'Token should start with ghp_ or github_pat_';
        return true;
      },
    },
  ]);

  addTeamSyncRepo({
    name: answers.syncName.trim(),
    repo: answers.syncRepo.trim(),
    token: answers.syncToken,
  });

  console.log('\n' + chalk.green('Team sync configured: ' + answers.syncName.trim() + '\n'));
 } catch (err) {
  handleSetupInterrupt(err);
 }
}
