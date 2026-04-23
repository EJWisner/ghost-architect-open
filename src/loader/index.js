import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import AdmZip from 'adm-zip';
import { Octokit } from 'octokit';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { getConfig } from '../config.js';
import { resolveContextCap } from './tierCaps.js';
import { resolveExcludePatterns, isExcluded, filterPaths } from './excludes.js';

// Scan-time options set by bin/ghost.js from CLI flags / prompts.
// Read by buildContext and the three loader entry points.
let SCAN_OPTIONS = {
  tier: 'open',
  maxContextOverride: null,   // number | null
  excludePresets: [],         // string[]
  excludePatterns: [],        // string[]
};

/**
 * Called from bin/ghost.js to seed tier + flag values before a scan runs.
 * Safe to call multiple times; last call wins.
 */
export function setScanOptions(opts = {}) {
  SCAN_OPTIONS = {
    tier: opts.tier || SCAN_OPTIONS.tier || 'open',
    maxContextOverride: opts.maxContextOverride ?? null,
    excludePresets: Array.isArray(opts.excludePresets) ? opts.excludePresets : [],
    excludePatterns: Array.isArray(opts.excludePatterns) ? opts.excludePatterns : [],
  };
}

export function getScanOptions() {
  return { ...SCAN_OPTIONS };
}

const IGNORED_DIRS = ['node_modules', '.git', 'vendor', 'dist', 'build', '.next', '__pycache__', '.cache'];
const IGNORED_FILES = ['package-lock.json', 'yarn.lock', 'composer.lock', 'package.json.lock', 'Gemfile.lock', 'poetry.lock'];
const MAX_FILE_TOKENS = 50000; // ~200KB — skip files larger than this
const CODE_EXTENSIONS = [
  '.php', '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.java', '.go',
  '.cs', '.cpp', '.c', '.h', '.vue', '.svelte', '.sql', '.xml', '.json',
  '.yaml', '.yml', '.env.example', '.sh', '.bash', '.md'
];

export async function loadCodebase(method, options) {
  // Allow callers to pass per-scan options inline as a convenience.
  if (options && typeof options === 'object') {
    setScanOptions({ ...SCAN_OPTIONS, ...options });
  }
  switch (method) {
    case 'files': return await loadFromFiles();
    case 'zip':   return await loadFromZip();
    case 'github': return await loadFromGitHub();
  }
}

async function loadFromFiles() {
  // Retry loop — re-prompt on bad path instead of exiting to main menu
  let dirPath;
  while (true) {
    const answer = await inquirer.prompt([{
      type: 'input',
      name: 'dirPath',
      message: chalk.cyan('Path to codebase directory:'),
    }]);
    const trimmed = answer.dirPath.trim();
    if (!trimmed) {
      console.log(chalk.yellow('  Path is required. Try again.\n'));
      continue;
    }
    if (!fs.existsSync(trimmed)) {
      console.log(chalk.yellow(`  Directory not found: ${trimmed}\n  Check the path and try again.\n`));
      continue;
    }
    if (!fs.statSync(trimmed).isDirectory()) {
      console.log(chalk.yellow(`  That path is a file, not a directory. Try again.\n`));
      continue;
    }
    dirPath = trimmed;
    break;
  }

  const spinner = ora('Scanning files...').start();
  const files = await glob(`${dirPath}/**/*`, {
    nodir: true,
    ignore: IGNORED_DIRS.map(d => `**/${d}/**`)
  });

  let codeFiles = files.filter(f => CODE_EXTENSIONS.includes(path.extname(f).toLowerCase()));

  // Apply --exclude / --exclude-presets if any were set on SCAN_OPTIONS.
  const patterns = resolveExcludePatterns(SCAN_OPTIONS.excludePresets, SCAN_OPTIONS.excludePatterns);
  if (patterns.length > 0) {
    const { kept, excluded } = filterPaths(codeFiles, dirPath, patterns);
    codeFiles = kept;
    if (excluded > 0) {
      console.log(chalk.gray(`  ℹ  Exclusions: skipped ${excluded} file(s) matching ${patterns.length} pattern(s)`));
    }
  }

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

  const zipExcludePatterns = resolveExcludePatterns(SCAN_OPTIONS.excludePresets, SCAN_OPTIONS.excludePatterns);
  let zipExcludedCount = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (!CODE_EXTENSIONS.includes(ext)) continue;
    const ignored = IGNORED_DIRS.some(d => entry.entryName.includes(`/${d}/`) || entry.entryName.startsWith(`${d}/`));
    if (ignored) continue;
    const filename = path.basename(entry.entryName);
    if (IGNORED_FILES.includes(filename)) continue;

    if (zipExcludePatterns.length > 0 && isExcluded(entry.entryName, zipExcludePatterns)) {
      zipExcludedCount++;
      continue;
    }

    try {
      const content = entry.getData().toString('utf8');
      const estTokens = Math.ceil(content.length / 4);
      if (estTokens > MAX_FILE_TOKENS) {
        console.log(chalk.gray(`  ⚠ Skipped ${filename} — too large (${Math.round(estTokens/1000)}k tokens)`));
        continue;
      }
      fileMap[entry.entryName] = content;
      count++;
    } catch {}
  }

  if (zipExcludedCount > 0) {
    console.log(chalk.gray(`  ℹ  Exclusions: skipped ${zipExcludedCount} file(s) inside ZIP`));
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

  // Helper: attempt fetch with given auth (or none)
  async function tryFetch(auth) {
    const octokit = new Octokit({ auth: auth || undefined });
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    return { octokit, repoData };
  }

  try {
    let octokit, repoData;

    // First attempt: use configured token if we have one
    try {
      ({ octokit, repoData } = await tryFetch(githubToken));
    } catch (err) {
      // If the configured token is bad (401) and we actually had one, retry anonymously.
      // Public repos work without auth — don't let a dead token block access to them.
      if (err.status === 401 && githubToken) {
        spinner.stop();
        console.log(chalk.yellow('  ⚠  Configured GitHub token was rejected — retrying anonymously for public repo access...'));
        spinner.start(`Fetching ${owner}/${repo}...`);
        ({ octokit, repoData } = await tryFetch(null));
      } else {
        throw err;
      }
    }

    const branch = repoData.default_branch;
    const fileMap = {};

    const { data: tree } = await octokit.rest.git.getTree({
      owner, repo,
      tree_sha: branch,
      recursive: 'true'
    });

    const ghExcludePatterns = resolveExcludePatterns(SCAN_OPTIONS.excludePresets, SCAN_OPTIONS.excludePatterns);
    let ghExcludedCount = 0;

    const codeFiles = tree.tree.filter(item => {
      if (item.type !== 'blob') return false;
      const ext = path.extname(item.path).toLowerCase();
      if (!CODE_EXTENSIONS.includes(ext)) return false;
      if (IGNORED_DIRS.some(d => item.path.includes(`${d}/`))) return false;
      if (ghExcludePatterns.length > 0 && isExcluded(item.path, ghExcludePatterns)) {
        ghExcludedCount++;
        return false;
      }
      return true;
    });

    if (ghExcludedCount > 0) {
      console.log(chalk.gray(`  ℹ  Exclusions: skipped ${ghExcludedCount} file(s) from remote tree`));
    }

    spinner.stop();

    const rootFolders = [...new Set(
      codeFiles
        .map(f => f.path.includes('/') ? f.path.split('/')[0] : '(root)')
        .filter(Boolean)
    )].sort();

    let selectedFolders = rootFolders;

    if (rootFolders.length > 1) {
      const { chosen } = await inquirer.prompt([{
        type: 'checkbox',
        name: 'chosen',
        message: chalk.cyan('Select folders to scan (space to toggle, enter to confirm):'),
        choices: rootFolders,
        default: rootFolders,
        validate: (v) => v.length > 0 ? true : 'Select at least one folder'
      }]);
      selectedFolders = chosen;
    }

    const filteredFiles = codeFiles.filter(f => {
      const root = f.path.includes('/') ? f.path.split('/')[0] : '(root)';
      return selectedFolders.includes(root);
    });

    spinner.start(`Fetching ${filteredFiles.length} files from ${selectedFolders.length} folder(s)...`);

    const filesToFetch = filteredFiles.slice(0, 200);
    let fetched = 0;

    for (const file of filesToFetch) {
      try {
        const { data } = await octokit.rest.git.getBlob({ owner, repo, file_sha: file.sha });
        if (data.content) {
          const content = Buffer.from(data.content, 'base64').toString('utf8');
          const estTokens = Math.ceil(content.length / 4);
          if (estTokens > MAX_FILE_TOKENS) {
            console.log(chalk.gray(`  ⚠ Skipped ${file.path} — too large (${Math.round(estTokens/1000)}k tokens)`));
            continue;
          }
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

// Max per-file size — files larger than this are truncated to prevent context overflow
const MAX_FILE_CHARS = 120000; // ~30K tokens — safe headroom under 200K limit

const MINIFIED_PATTERNS = [
  /\.min\.(js|css)$/i,
  /[-.]bundle\.(js|css)$/i,
  /[-.]vendor\.(js|css)$/i,
  /allinone\.(js|css)$/i,
  /react\.js$/i,
  /jquery\.js$/i,
];

function isMinified(filePath, content) {
  if (MINIFIED_PATTERNS.some(p => p.test(filePath))) return true;
  const firstLine = content.split('\n')[0] || '';
  if (firstLine.length > 10000) return true;
  return false;
}

async function readFiles(filePaths, basePath) {
  const fileMap  = {};
  let skipped    = 0;
  let truncated  = 0;

  for (const filePath of filePaths) {
    try {
      const content      = fs.readFileSync(filePath, 'utf8');
      const relativePath = path.relative(basePath, filePath);

      if (isMinified(relativePath, content)) {
        skipped++;
        continue;
      }

      if (content.length > MAX_FILE_CHARS) {
        fileMap[relativePath] = content.slice(0, MAX_FILE_CHARS) +
          '\n\n// [TRUNCATED: file exceeded ' + MAX_FILE_CHARS + ' char limit]';
        truncated++;
      } else {
        fileMap[relativePath] = content;
      }
    } catch {}
  }

  if (skipped > 0 || truncated > 0) {
    console.log(chalk.gray(
      `  ℹ  Loader: skipped ${skipped} minified/bundled files` +
      (truncated > 0 ? `, truncated ${truncated} oversized files` : '')
    ));
  }

  return buildContext(fileMap);
}

export async function loadFromPath(dirPath) {
  const spinner = ora('Scanning files...').start();
  const files = await glob(`${dirPath}/**/*`, {
    nodir: true,
    ignore: IGNORED_DIRS.map(d => `**/${d}/**`)
  });

  const codeFiles = files.filter(f => CODE_EXTENSIONS.includes(path.extname(f).toLowerCase()));
  spinner.succeed(`Found ${codeFiles.length} code files`);

  return await readFiles(codeFiles, dirPath);
}

function buildContext(fileMap) {
  const config = getConfig();
  const configuredMax = config.get('maxTokensContext') || 50000;

  // Resolve the effective cap: tier ceiling vs. user's CLI override vs. config default.
  // Precedence: CLI --max-context (if provided) > config.maxTokensContext > 50000 default.
  // Tier cap always clamps the final value.
  const userRequested = SCAN_OPTIONS.maxContextOverride ?? configuredMax;
  const { effective: maxTokens, clamped, tierCap, tier } = resolveContextCap(SCAN_OPTIONS.tier, userRequested);

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

  // Announce the effective context cap once per scan so users understand what's in play.
  const capLabel = clamped
    ? `${maxTokens.toLocaleString()} tokens (clamped from ${userRequested.toLocaleString()} by ${tier} tier)`
    : `${maxTokens.toLocaleString()} tokens (${tier} tier, cap ${tierCap.toLocaleString()})`;
  console.log(chalk.gray(`  ℹ  Context cap: ${capLabel}`));

  if (loadedFiles < totalFiles) {
    console.log(chalk.yellow(`  ⚠ Context limit: processed ${loadedFiles} of ${totalFiles} files (~${approxTokens.toLocaleString()} tokens)`));
  } else {
    console.log(chalk.green(`  ✓ Processed ${loadedFiles} files (~${approxTokens.toLocaleString()} tokens)`));
  }

  return { context, fileIndex, totalFiles, loadedFiles, fileMap };
}
