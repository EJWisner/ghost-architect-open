import Configstore from 'configstore';
import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';

const config = new Configstore('ghost-architect');

export function getConfig() { return config; }

export function resolveApiKey() {
  return process.env.ANTHROPIC_API_KEY || config.get('anthropicApiKey') || null;
}

export function resolveGitHubToken() {
  return process.env.GITHUB_TOKEN || config.get('githubToken') || null;
}

export function isConfigured() { return !!resolveApiKey(); }

export function usingEnvKey() { return !!process.env.ANTHROPIC_API_KEY; }

export async function runSetupWizard() {
  console.log('\n' + boxen(
    chalk.cyan.bold('⚙  GHOST ARCHITECT — FIRST RUN SETUP') + '\n\n' +
    chalk.gray('Let\'s configure your environment.\n') +
    chalk.gray('Your API key is stored locally and never transmitted\nexcept directly to Anthropic\'s API.'),
    { padding: 1, borderColor: 'cyan', borderStyle: 'double' }
  ));

  console.log('');

  console.log(boxen(
    chalk.white.bold('🔒  Privacy notice') + '\n\n' +
    chalk.gray('Your code never leaves the analysis moment.\n\n') +
    chalk.gray('When you load a codebase, it passes through Claude\'s\n') +
    chalk.gray('analysis filter and is immediately discarded. It is\n') +
    chalk.gray('never stored on any server, never retained between\n') +
    chalk.gray('sessions, and never used to train AI models.\n\n') +
    chalk.gray('The only things stored locally on your machine are:\n') +
    chalk.gray('  • Your API key (encrypted in your config file)\n') +
    chalk.gray('  • Your preferences (model, context size)\n') +
    chalk.gray('  • Any reports YOU choose to save\n\n') +
    chalk.green('Ghost Architect is safe for proprietary and\nclient codebases.'),
    { padding: 1, borderColor: 'green', borderStyle: 'round' }
  ));

  console.log('');

  const answers = await inquirer.prompt([
    {
      type: 'password',
      name: 'anthropicApiKey',
      message: chalk.cyan('Anthropic API Key') + chalk.gray(' (from console.anthropic.com):'),
      mask: '●',
      validate: (val) => val.startsWith('sk-ant-') ? true : 'Key should start with sk-ant-'
    },
    {
      type: 'list',
      name: 'needsGithubToken',
      message: chalk.cyan('Do you need to access private GitHub repositories?'),
      choices: [
        { name: 'Yes — I will be analyzing private repos', value: true },
        { name: 'No — public repos and ZIP files only', value: false },
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
      mask: '●',
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
        { name: 'claude-sonnet-4-5 (recommended — best balance)', value: 'claude-sonnet-4-5' },
        { name: 'claude-opus-4-5 (most powerful — slower/costlier)', value: 'claude-opus-4-5' },
      ],
      default: 0
    },
    {
      type: 'number',
      name: 'maxTokensContext',
      message: chalk.cyan('Max file context size') + chalk.gray(' (tokens — 50000 recommended):'),
      default: 50000,
    },
    {
      type: 'number',
      name: 'rateJunior',
      message: chalk.cyan('Junior developer hourly rate') + chalk.gray(' ($/hr, for LOW complexity fixes):'),
      default: 85,
    },
    {
      type: 'number',
      name: 'rateMid',
      message: chalk.cyan('Mid-level developer hourly rate') + chalk.gray(' ($/hr, for MEDIUM complexity fixes):'),
      default: 125,
    },
    {
      type: 'number',
      name: 'rateSenior',
      message: chalk.cyan('Senior/Architect hourly rate') + chalk.gray(' ($/hr, for HIGH/CRITICAL complexity fixes):'),
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

  console.log('\n' + chalk.green('✓ Configuration saved.\n'));
}

export async function reconfigure() {
  console.log(chalk.yellow('\nReconfiguring Ghost Architect...\n'));
  await runSetupWizard();
}
