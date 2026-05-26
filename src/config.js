import Configstore from 'configstore';
import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';

const config = new Configstore('ghost-architect');

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

  config.set('anthropicApiKey', answers.anthropicApiKey);
  config.set('defaultModel', answers.defaultModel);
  config.set('maxTokensContext', answers.maxTokensContext);
  config.set('rateJunior', answers.rateJunior || 85);
  config.set('rateMid', answers.rateMid || 125);
  config.set('rateSenior', answers.rateSenior || 200);
  if (answers.githubToken) config.set('githubToken', answers.githubToken);

  // Note: the inline "Set up Ghost Team shared sync repo?" prompt that lived
  // here in Team v6.0.1 was removed during v7 unification. The unified
  // codebase ships to all tiers, including 3,000+ Open users who have no
  // Ghost Team license and would find an unsolicited team-sync prompt
  // confusing. Team customers use the standalone `ghost --configure-team`
  // command (configureTeamSync below) instead.
  // See TODO-architect-inline-teamsync-prompt-removed.md for rationale.

  console.log('\n' + chalk.green('Configuration saved.\n'));
}

export async function reconfigure() {
  console.log(chalk.yellow('\nReconfiguring Ghost Architect...\n'));
  await runSetupWizard();
}

export async function configureTeamSync() {
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
}
