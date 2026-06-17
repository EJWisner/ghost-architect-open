import Configstore from 'configstore';
import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';

const config = new Configstore('ghost-architect');

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
  if (slug) config.set('defaultProfileSlug', slug);
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
}

export function removeTeamSyncRepo(name) {
  const existing = resolveTeamSync().filter(r => r.name !== name);
  config.set('teamSync', existing);
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
      chalk.gray('Never stored on any server, never used to train models.\n\n') +
      chalk.gray('Stored locally on your machine:\n') +
      chalk.gray('  - Your API key (encrypted in your config file)\n') +
      chalk.gray('  - Your preferences\n') +
      chalk.gray('  - Reports YOU choose to save\n\n') +
      chalk.green('Safe for proprietary and client codebases.'),
      { padding: 1, borderColor: 'green', borderStyle: 'round' }
  ));
  console.log('');

  const answers = await inquirer.prompt([
    {
      type: 'password',
      name: 'anthropicApiKey',
      message: chalk.cyan('Anthropic API Key:'),
      mask: '*',
      validate: (val) => val.startsWith('sk-ant-') ? true : 'Key should start with sk-ant-'
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
      message: chalk.cyan('Max file context size in tokens (50000 recommended):'),
      default: 50000,
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
    maxTokensContext: answers.maxTokensContext,
    rateJunior: answers.rateJunior || 85,
    rateMid: answers.rateMid || 125,
    rateSenior: answers.rateSenior || 200,
  };
  if (answers.githubToken) block.githubToken = answers.githubToken;
  config.set(block);

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
