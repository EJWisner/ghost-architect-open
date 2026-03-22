import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import AdmZip from 'adm-zip';
import { Octokit } from 'octokit';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { getConfig } from '../config.js';

const IGNORED_DIRS = ['node_modules', '.git', 'vendor', 'dist', 'build', '.next', '__pycache__', '.cache'];
const CODE_EXTENSIONS = [
  '.php', '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.java', '.go',
  '.cs', '.cpp', '.c', '.h', '.vue', '.svelte', '.sql', '.xml', '.json',
  '.yaml', '.yml', '.env.example', '.sh', '.bash', '.md'
];

export async function loadCodebase(method) {
  switch (method) {
    case 'files': return await loadFromFiles();
    case 'zip':   return await loadFromZip();
    case 'github': return await loadFromGitHub();
  }
}

async function loadFromFiles() {
  const { dirPath } = await inquirer.prompt([{
    type: 'input',
    name: 'dirPath',
    message: chalk.cyan('Path to codebase directory:'),
    validate: (v) => fs.existsSync(v) ? true : 'Directory not found'
  }]);

  const spinner = ora('Scanning files...').start();
  const files = await glob(`${dirPath}/**/*`, {
    nodir: true,
    ignore: IGNORED_DIRS.map(d => `**/${d}/**`)
  });

  const codeFiles = files.filter(f => CODE_EXTENSIONS.includes(path.extname(f).toLowerCase()));
  spinner.succeed(`Found ${codeFiles.length} code files`);

  return await readFiles(codeFiles, dirPath);
}

async function loadFromZip() {
  const { zipPath } = await inquirer.prompt([{
    type: 'input',
    name: 'zipPath',
    message: chalk.cyan('Path to ZIP file:'),
    validate: (v) => fs.existsSync(v) ? true : 'File not found'
  }]);

  const spinner = ora('Extracting ZIP...').start();
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  const fileMap = {};
  let count = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (!CODE_EXTENSIONS.includes(ext)) continue;
    const ignored = IGNORED_DIRS.some(d => entry.entryName.includes(`/${d}/`) || entry.entryName.startsWith(`${d}/`));
    if (ignored) continue;

    try {
      const content = entry.getData().toString('utf8');
      fileMap[entry.entryName] = content;
      count++;
    } catch {}
  }

  spinner.succeed(`Extracted ${count} code files from ZIP`);
  return buildContext(fileMap);
}

async function loadFromGitHub() {
  const config = getConfig();
  const githubToken = config.get('githubToken');

  const { repoUrl } = await inquirer.prompt([{
    type: 'input',
    name: 'repoUrl',
    message: chalk.cyan('GitHub repo URL or owner/repo:'),
    validate: (v) => v.length > 0 ? true : 'Required'
  }]);

  // Parse owner/repo from URL or shorthand
  let owner, repo;
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/\s]+)/);
  if (match) {
    owner = match[1];
    repo = match[2].replace(/\.git$/, '');
  } else if (repoUrl.includes('/')) {
    [owner, repo] = repoUrl.split('/');
  } else {
    console.log(chalk.red('Could not parse repo. Use format: owner/repo or full GitHub URL'));
    return null;
  }

  const spinner = ora(`Fetching ${owner}/${repo}...`).start();

  try {
    const octokit = new Octokit({ auth: githubToken || undefined });
    const fileMap = {};

    // Get default branch
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    const branch = repoData.default_branch;

    // Get tree recursively
    const { data: tree } = await octokit.rest.git.getTree({
      owner, repo,
      tree_sha: branch,
      recursive: 'true'
    });

    const codeFiles = tree.tree.filter(item => {
      if (item.type !== 'blob') return false;
      const ext = path.extname(item.path).toLowerCase();
      if (!CODE_EXTENSIONS.includes(ext)) return false;
      return !IGNORED_DIRS.some(d => item.path.includes(`${d}/`));
    });

    spinner.text = `Fetching ${codeFiles.length} files...`;

    // Fetch files (cap at 200 for API limits)
    const filesToFetch = codeFiles.slice(0, 200);
    let fetched = 0;

    for (const file of filesToFetch) {
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path: file.path });
        if (data.content) {
          const content = Buffer.from(data.content, 'base64').toString('utf8');
          fileMap[file.path] = content;
          fetched++;
        }
      } catch {}
    }

    spinner.succeed(`Processed ${fetched} files from ${owner}/${repo}`);
    if (codeFiles.length > 200) {
      console.log(chalk.yellow(`  ⚠ Large repo — analyzed first 200 code files (${codeFiles.length} total)`));
    }

    return buildContext(fileMap);
  } catch (err) {
    spinner.fail('GitHub fetch failed.');
    if (err.message.includes('401') || err.message.includes('403') || err.message.includes('Not Found')) {
      console.log('');
      console.log(chalk.yellow('  ⚠  This repository is private or requires authentication.'));
      console.log('');
      console.log(chalk.white('  To access private repositories:'));
      console.log(chalk.gray('  1. Go to github.com/settings/tokens'));
      console.log(chalk.gray('  2. Click "Generate new token (classic)"'));
      console.log(chalk.gray('  3. Select the "repo" scope'));
      console.log(chalk.gray('  4. Copy the token (starts with ghp_)'));
      console.log(chalk.gray('  5. Return to Ghost and select "Reconfigure Ghost Architect"'));
      console.log(chalk.gray('  6. Enter your token when prompted'));
      console.log('');
      console.log(chalk.gray('  Alternative: Download the repo as a ZIP and use "ZIP file" instead.'));
      console.log('');
    } else if (err.message.includes('rate') || err.message.includes('429')) {
      console.log('');
      console.log(chalk.yellow('  ⚠  GitHub API rate limit reached.'));
      console.log(chalk.gray('  Add a GitHub token in Reconfigure to increase your limit from 60 to 5,000 requests/hour.'));
      console.log(chalk.gray('  Alternative: Download the repo as a ZIP and use "ZIP file" instead.'));
      console.log('');
    } else {
      console.log(chalk.gray(`  Details: ${err.message}`));
    }
    return null;
  }
}

async function readFiles(filePaths, basePath) {
  const fileMap = {};
  for (const filePath of filePaths) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const relativePath = path.relative(basePath, filePath);
      fileMap[relativePath] = content;
    } catch {}
  }
  return buildContext(fileMap);
}

function buildContext(fileMap) {
  const config = getConfig();
  const maxTokens = config.get('maxTokensContext') || 50000;

  let context = '';
  let fileIndex = [];
  let approxTokens = 0;

  for (const [filePath, content] of Object.entries(fileMap)) {
    const approxFileTokens = Math.ceil(content.length / 4);
    if (approxTokens + approxFileTokens > maxTokens) continue;

    context += `\n\n=== FILE: ${filePath} ===\n${content}`;
    fileIndex.push(filePath);
    approxTokens += approxFileTokens;
  }

  const totalFiles = Object.keys(fileMap).length;
  const loadedFiles = fileIndex.length;

  if (loadedFiles < totalFiles) {
    console.log(chalk.yellow(`  ⚠ Context limit: processed ${loadedFiles} of ${totalFiles} files (~${approxTokens.toLocaleString()} tokens)`));
  } else {
    console.log(chalk.green(`  ✓ Processed ${loadedFiles} files (~${approxTokens.toLocaleString()} tokens)`));
  }

  return { context, fileIndex, totalFiles, loadedFiles, fileMap };
}
