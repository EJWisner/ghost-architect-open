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

// Default exclusions applied automatically to every scan.
// Users do not need to pass --exclude flags for these. To disable,
// pass --no-default-excludes (rarely needed; for cases like auditing
// a vendor folder directly).
const IGNORED_DIRS = [
  // JS/TS ecosystem
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.parcel-cache', '.turbo',
  // Version control + IDE
  '.git', '.svn', '.hg', '.idea', '.vscode',
  // PHP / Composer
  'vendor',
  // Magento / Adobe Commerce specific
  'pub/static', 'pub/media', 'var', 'generated', 'setup',
  // Python
  '__pycache__', '.venv', 'venv', '.tox', '.pytest_cache', '.mypy_cache',
  // Ruby
  '.bundle',
  // Java / Gradle
  '.gradle', 'target',
  // Coverage / test artifacts
  'coverage', '.nyc_output',
  // Misc cache
  '.cache',
];
const IGNORED_FILES = [
  // JS/TS lock files
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  // Other ecosystem lock files
  'composer.lock', 'package.json.lock', 'Gemfile.lock', 'poetry.lock',
  'Cargo.lock', 'go.sum', 'mix.lock',
  // Build/CI artifacts
  '.DS_Store', 'Thumbs.db',
];
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

  // Step 1: get ALL files (no exclusions yet) so we can report a default-excluded count.
  const allFiles = await glob(`${dirPath}/**/*`, { nodir: true });
  const allCodeFiles = allFiles.filter(f => CODE_EXTENSIONS.includes(path.extname(f).toLowerCase()));

  // Step 2: apply default IGNORED_DIRS + IGNORED_FILES exclusions.
  const beforeDefaults = allCodeFiles.length;
  let codeFiles = allCodeFiles.filter(f => {
    const rel = path.relative(dirPath, f);
    const segments = rel.split(path.sep);
    // Match any IGNORED_DIRS entry as either a path segment OR a slash-joined sub-path.
    for (const d of IGNORED_DIRS) {
      if (d.includes('/')) {
        // Multi-segment match like 'pub/static' — require the segments to appear in order.
        const parts = d.split('/');
        for (let i = 0; i + parts.length <= segments.length; i++) {
          if (parts.every((p, k) => segments[i + k] === p)) return false;
        }
      } else if (segments.includes(d)) {
        return false;
      }
    }
    if (IGNORED_FILES.includes(path.basename(f))) return false;
    return true;
  });
  const defaultExcluded = beforeDefaults - codeFiles.length;
  if (defaultExcluded > 0) {
    console.log(chalk.gray(`  ℹ  Default excludes: skipped ${defaultExcluded} file(s) (node_modules, vendor, build artifacts, lock files, etc.)`));
  }

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

  const result = await readFiles(codeFiles, dirPath);
  // Attach basePath so downstream analyzers (e.g. audit-mode's keyPersonRisk)
  // can shell out to git or read non-code files relative to the codebase root.
  if (result) result.basePath = dirPath;
  return result;
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
    // Apply default IGNORED_DIRS (handles both single-segment like 'node_modules'
    // and multi-segment like 'pub/static').
    const segments = entry.entryName.split('/');
    let ignored = false;
    for (const d of IGNORED_DIRS) {
      if (d.includes('/')) {
        const parts = d.split('/');
        for (let i = 0; i + parts.length <= segments.length; i++) {
          if (parts.every((p, k) => segments[i + k] === p)) { ignored = true; break; }
        }
      } else if (segments.includes(d)) {
        ignored = true;
      }
      if (ignored) break;
    }
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
      // Apply default IGNORED_DIRS (handles single-segment + multi-segment like 'pub/static').
      const segments = item.path.split('/');
      for (const d of IGNORED_DIRS) {
        if (d.includes('/')) {
          const parts = d.split('/');
          for (let i = 0; i + parts.length <= segments.length; i++) {
            if (parts.every((p, k) => segments[i + k] === p)) return false;
          }
        } else if (segments.includes(d)) {
          return false;
        }
      }
      // Apply default IGNORED_FILES.
      if (IGNORED_FILES.includes(path.basename(item.path))) return false;
      // Apply user --exclude / --exclude-presets.
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

    // ── File-count prompt for large repos ──────────────────────────────
    // Default cap is 200 files for fetch-time and rate-limit reasons.
    // When the user's selected folders contain more than 200 files, give
    // them an honest choice: continue with the sampled 200, or fetch all.
    // Senior users running deal-grade audits will want the full set; casual
    // exploratory users may be fine with the sample. Either way they choose,
    // not us. Mode-level cost estimates (Audit shows ~$0.02 for synthesis,
    // POI/Blast scale with input tokens) fire AFTER this, so the user
    // gets a real number based on the file count they just picked.
    const DEFAULT_FETCH_CAP = 200;
    let fetchCap = DEFAULT_FETCH_CAP;
    if (filteredFiles.length > DEFAULT_FETCH_CAP) {
      console.log('');
      console.log(chalk.yellow.bold(`  ⚠  Large repo: ${filteredFiles.length} code files in your selected folders.`));
      console.log(chalk.gray(`     Default fetch cap is ${DEFAULT_FETCH_CAP} files. Fetching all ${filteredFiles.length} will`));
      console.log(chalk.gray(`     take longer and use more GitHub API quota.`));
      console.log(chalk.gray(`     You’ll see an accurate cost estimate inside the mode, before you run`));
      console.log(chalk.gray(`     the report and incur the cost, based on what you pick.`));
      console.log('');
      const { fetchAll } = await inquirer.prompt([{
        type: 'confirm', name: 'fetchAll',
        message: chalk.cyan(`Fetch all ${filteredFiles.length} files?`),
        default: true,
      }]);
      if (fetchAll) {
        fetchCap = filteredFiles.length;
      } else {
        console.log(chalk.gray(`  Continuing with the first ${DEFAULT_FETCH_CAP} files.\n`));
      }
    }

    spinner.start(`Fetching ${Math.min(filteredFiles.length, fetchCap)} files from ${selectedFolders.length} folder(s)...`);

    const filesToFetch = filteredFiles.slice(0, fetchCap);
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
    if (filteredFiles.length > fetchCap) {
      console.log(chalk.yellow(`  ⚠ Large repo — analyzed first ${fetchCap} code files (${filteredFiles.length} total)`));
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
