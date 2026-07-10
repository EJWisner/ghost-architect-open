import fs from 'fs';
import path from 'path';
import os from 'os';
import { glob } from 'glob';
import AdmZip from 'adm-zip';
import { createOctokit } from '../utils/octokit-client.js';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { getConfig } from '../config.js';
import { resolveContextCap } from './tierCaps.js';
import { resolveExcludePatterns, isExcluded, filterPaths } from './excludes.js';
import { redactContent, showRedactionSummary } from '../redactor.js';
import { isBackKeyword } from '../cli/prompt-helpers.js';
import { expandTilde } from '../utils/paths.js';
import { CODE_EXTENSIONS } from '../constants/code-extensions.js';
import { SYM } from '../cli/symbols.js';

// Scan-time options set by bin/ghost.js from CLI flags / prompts.
// Read by buildContext and the three loader entry points.
let SCAN_OPTIONS = {
  tier: 'open',
  maxContextOverride: null,   // number | null
  ignoreSavedContext: false,  // boolean — when true, buildContext ignores the saved configstore maxTokensContext and falls back to the full tier cap (set by the CI guard)
  excludePresets: [],         // string[]
  excludePatterns: [],        // string[]
  skipRedaction: false,       // boolean — Pro+ escape hatch for the fail-closed redaction abort
};

/**
 * Called from bin/ghost.js to seed tier + flag values before a scan runs.
 * Safe to call multiple times; last call wins.
 */
export function setScanOptions(opts = {}) {
  SCAN_OPTIONS = {
    tier: opts.tier || SCAN_OPTIONS.tier || 'open',
    maxContextOverride: opts.maxContextOverride ?? null,
    ignoreSavedContext: opts.ignoreSavedContext === true,
    excludePresets: Array.isArray(opts.excludePresets) ? opts.excludePresets : [],
    excludePatterns: Array.isArray(opts.excludePatterns) ? opts.excludePatterns : [],
    skipRedaction: opts.skipRedaction === true,
  };
}

// Tiers that may use --skip-redaction. The flag is a deliberate "expose secrets
// to finish the scan" escape hatch, so it is gated to paid tiers only; Open
// always fails closed. Trial mirrors Pro for feature access, so it is included.
const SKIP_REDACTION_TIERS = new Set([
  'trial', 'pro', 'pro-max', 'team', 'team-max', 'enterprise', 'enterprise-max',
]);
function canSkipRedaction(tier) {
  return SKIP_REDACTION_TIERS.has(tier);
}

// Write redaction-failure details to the debug directory for post-mortem
// diagnosis. Mirrors the .debug convention used by src/core/multipass.js.
// Never throws — diagnostics must never break (or block) the scan path.
function writeRedactionFailureLog(failedRules, { continued }) {
  try {
    const debugDir = path.join(os.homedir(), 'Ghost Architect Reports', '.debug');
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filepath = path.join(debugDir, `redaction-failure-${ts}.log`);
    const lines = [];
    lines.push('Redaction failure report');
    lines.push(`Timestamp:    ${new Date().toISOString()}`);
    lines.push(`Tier:         ${SCAN_OPTIONS.tier}`);
    lines.push(`Outcome:      ${continued
      ? 'scan CONTINUED via --skip-redaction (secrets may be exposed)'
      : 'scan ABORTED (fail-closed — codebase NOT sent to API)'}`);
    lines.push(`Failed rules: ${failedRules.length}`);
    lines.push('');
    for (const f of failedRules) {
      lines.push(`• Rule:  ${f.rule}`);
      if (f.file)      lines.push(`  File:  ${f.file}`);
      if (f.errorType) lines.push(`  Type:  ${f.errorType}`);
      lines.push(`  Error: ${f.error}`);
      if (f.snippet != null) {
        lines.push('  Snippet (first 200 chars of triggering content):');
        lines.push(`    ${String(f.snippet).replace(/\n/g, '\\n')}`);
      }
      lines.push('');
    }
    fs.writeFileSync(filepath, lines.join('\n'), 'utf8');
    return filepath;
  } catch (writeErr) {
    // File write failed -- fall back to stderr so diagnostic details are never
    // silently lost even when the debug directory is unwritable.
    process.stderr.write(
      `[Ghost] Redaction failure log could not be written ` +
      `(${writeErr.message}). Failures:\n` +
      failedRules.map(f => `  - ${f.rule}: ${f.file || '<unknown file>'}`).join('\n') +
      '\n'
    );
    return null; // never let logging break the scan
  }
}

export function getScanOptions() {
  return { ...SCAN_OPTIONS };
}

// Default exclusions applied automatically to every scan.
// Users do not need to pass --exclude flags for these; they are always
// skipped (dependency dirs, build output, lock files, and similar).
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
  // Static / binary asset bundles (images, fonts, compiled front-end output).
  // Commonly vendored or compiled and rarely carry reviewable source signal.
  // Any real code kept under assets/ is skipped too as a result.
  'assets',
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

// CODE_EXTENSIONS is shared with src/core/verifier.js, which scrubs fabricated
// "File.ext:42" line citations for exactly these extensions. Keeping one list
// means adding a language here cannot silently let hallucinated line numbers
// through there. See src/constants/code-extensions.js.

// Git hook scripts live in .git/hooks/ and are extensionless (pre-commit,
// post-checkout, etc.), so the CODE_EXTENSIONS filter skips them — a scan
// pointed at a hooks directory would only pick up README.md. Allowlist their
// exact basenames so they're always included regardless of extension.
const GIT_HOOKS = new Set([
  'pre-commit', 'pre-push', 'post-commit', 'post-checkout', 'post-merge',
  'post-receive', 'pre-receive', 'pre-rebase', 'applypatch-msg', 'commit-msg',
  'prepare-commit-msg', 'pre-applypatch', 'post-applypatch', 'pre-auto-gc',
  'post-rewrite', 'sendemail-validate',
]);

// Binary / non-source asset extensions (images, fonts, audio, video, compiled
// documents, archives). These never carry reviewable source signal and only
// inflate token counts, so they are excluded explicitly. This denylist is
// enforced ahead of the code allowlist, so a binary type stays excluded even if
// it is ever added to CODE_EXTENSIONS.
const IGNORED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.mov', '.webm', '.mp3', '.wav', '.ogg',
  '.pdf', '.zip', '.gz', '.tar',
]);

// A file is scanned if its extension is a known code type OR its basename is a
// known Git hook (extensionless), and never when its extension is a known
// binary asset type. Shared by all three loader paths (directory, ZIP, GitHub).
// path.basename handles the forward-slash paths used by ZIP entryName and GitHub
// tree paths on every platform.
// Dot-path contract, shared by the ZIP and GitHub loaders (Audit 7, finding
// 3.13). The directory walk's glob runs WITHOUT dot:true, so dotfiles and
// dot-directories under the scan root are never loaded there (.github/,
// .husky/, .circleci/ would token-bill CI config on every scan — see the
// comment above the glob in _loadFromDirPath), with one targeted exception:
// .env.example, which carries reviewable config-shape signal and gets its own
// dot-glob. ZIP archives and GitHub trees enumerate dot paths, so without
// this predicate the same repo produced different file sets, findings, and
// costs depending on how it was fed to Ghost. One contract, three inputs:
// dotted segments are excluded everywhere, .env.example is always allowed.
// (Scanning a dotted directory DIRECTLY, e.g. pointing Ghost at .git/hooks,
// still works on the directory path: the dotted segment is in the scan root
// there, not in the relative path this predicate sees.)
function isDotExcluded(relPath) {
  const segments = String(relPath || '').split('/').filter(Boolean);
  return segments.some((seg, i) =>
    seg.startsWith('.') && !(i === segments.length - 1 && seg === '.env.example'));
}

export function isScannablePath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  if (IGNORED_EXTENSIONS.has(ext)) return false;
  if (CODE_EXTENSIONS.includes(ext)) return true;
  // .env.example carries reviewable config-shape signal, but path.extname()
  // returns '.example' for it (not '.env.example'), so a CODE_EXTENSIONS entry
  // could never match. Match by basename suffix instead so these files load on
  // every path (directory, ZIP, GitHub).
  if (base === '.env.example' || base.endsWith('.env.example')) return true;
  return GIT_HOOKS.has(base);
}

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

// ── loadFromPath — non-interactive, takes a known directory path ──────────────
// Used by the Commit Forecast non-interactive flag path (--baseline) and by
// Ghost Watcher. Throws with a clear message if path doesn't exist or isn't a
// directory. Returns the same shape as loadFromFiles.
//
// options.tier — optional tier ('open' | 'pro' | 'team' | 'enterprise'). When
// provided, the tier-appropriate context cap is applied. Non-interactive
// callers must pass it because they never run setScanOptions through the
// interactive flow; without it the cap defaults to the Open 50K ceiling.
export async function loadFromPath(dirPath, options = {}) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Path does not exist: ${dirPath}`);
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Path is not a directory: ${dirPath}`);
  }
  return await _loadFromDirPath(dirPath, options);
}

// ── _loadFromDirPath — shared implementation used by both interactive and non-interactive paths ──
async function _loadFromDirPath(dirPath, options = {}) {
  // Honor an explicitly passed tier so non-interactive callers (e.g. Ghost
  // Watcher) get the tier-appropriate context cap. resolveContextCap is the
  // single cap resolver (invoked downstream in buildContext); seeding the tier
  // here routes it through that resolver instead of the Open 50K default.
  if (options.tier) {
    setScanOptions({ ...getScanOptions(), tier: options.tier });
  }

  const spinner = ora('Scanning files...').start();

  // Step 1: get ALL files (no exclusions yet) so we can report a default-excluded count.
  //
  // glob() does not enumerate dot-prefixed entries unless `dot: true`, so the
  // directory walker never even offered `.env.example` to isScannablePath(): the
  // allowlist entry was reachable on the ZIP and GitHub paths (which enumerate
  // archive/tree entries directly) and dead here. Rather than flip `dot: true`
  // globally, which would sweep .github/, .husky/, .circleci/ and friends into
  // every scan and quietly raise everyone's token bill, glob the dot-named
  // allowlist entries explicitly and merge.
  const allFiles = await glob(`${dirPath}/**/*`, { nodir: true });
  const dotAllowlisted = await glob(`${dirPath}/**/.env.example`, { nodir: true, dot: true });
  const allCodeFiles = [...new Set([...allFiles, ...dotAllowlisted])].filter(f => isScannablePath(f));

  // Step 2: apply default IGNORED_DIRS + IGNORED_FILES exclusions.
  const beforeDefaults = allCodeFiles.length;
  let codeFiles = allCodeFiles.filter(f => {
    const rel = path.relative(dirPath, f);
    const segments = rel.split(path.sep);
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
    if (IGNORED_FILES.includes(path.basename(f))) return false;
    return true;
  });
  const defaultExcluded = beforeDefaults - codeFiles.length;
  if (defaultExcluded > 0) {
    console.log(chalk.gray(`  ${SYM.info}  Default excludes: skipped ${defaultExcluded} file(s) (node_modules, vendor, build artifacts, lock files, etc.)`));
  }

  const patterns = resolveExcludePatterns(SCAN_OPTIONS.excludePresets, SCAN_OPTIONS.excludePatterns);
  if (patterns.length > 0) {
    const { kept, excluded } = filterPaths(codeFiles, dirPath, patterns);
    codeFiles = kept;
    if (excluded > 0) {
      console.log(chalk.gray(`  ${SYM.info}  Exclusions: skipped ${excluded} file(s) matching ${patterns.length} pattern(s)`));
    }
  }

  spinner.succeed(`Found ${codeFiles.length} code files`);

  const result = await readFiles(codeFiles, dirPath);
  if (result) result.basePath = dirPath;
  return result;
}

async function loadFromFiles() {
  // Retry loop — re-prompt on bad path instead of exiting to main menu
  let dirPath;
  while (true) {
    const answer = await inquirer.prompt([{
      type: 'input',
      name: 'dirPath',
      message: chalk.cyan("Path to codebase directory (or 'back' to cancel):"),
    }]);
    // Expand a leading ~ before any existsSync/statSync check — a path typed
    // into the prompt is not shell-expanded. 'back' and '' pass through
    // unchanged, so the escape/required checks below still work.
    const trimmed = expandTilde(answer.dirPath.trim());
    // Universal-escape: 'back' keyword returns null so the main loop's
    // `if (!codebaseContext) continue;` re-enters selectInputMethod.
    if (isBackKeyword(trimmed)) {
      console.log(chalk.gray('  Cancelled.\n'));
      return null;
    }
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

  return await _loadFromDirPath(dirPath);
}

// Interactive entry: prompt for the path, then delegate. The split mirrors
// loadFromPath / _loadFromDirPath, and exists for the same reason: the loading
// logic is worth testing and an inquirer prompt is not callable from a test.
async function loadFromZip() {
  const { zipPath } = await inquirer.prompt([{
    type: 'input',
    name: 'zipPath',
    message: chalk.cyan("Path to ZIP file (or 'back' to cancel):"),
    validate: (v) => {
      // Expand a leading ~ before the existsSync check — the prompt value is
      // not shell-expanded.
      const p = expandTilde(v.trim());
      // Universal-escape: allow 'back' through validation; the
      // post-prompt isBackKeyword() check below routes the cancellation.
      if (p.toLowerCase() === 'back') return true;
      return fs.existsSync(p) ? true : 'File not found';
    },
    // inquirer's validate can't mutate the answer, so expand here too: this
    // is what persists into zipPath and reaches AdmZip below.
    filter: (v) => expandTilde(v.trim())
  }]);

  // Universal-escape: 'back' keyword — return null so main loop re-prompts.
  if (isBackKeyword(zipPath)) {
    console.log(chalk.gray('  Cancelled.\n'));
    return null;
  }

  return await loadFromZipPath(zipPath);
}

// ── loadFromZipPath — non-interactive, takes a known .zip path ────────────────
// Same contract as loadFromPath: returns the codebase context, throws nothing
// the interactive path would not throw.
export async function loadFromZipPath(zipPath) {
  const spinner = ora('Extracting ZIP...').start();
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  const fileMap = {};
  let count = 0;

  const zipExcludePatterns = resolveExcludePatterns(SCAN_OPTIONS.excludePresets, SCAN_OPTIONS.excludePatterns);
  let zipExcludedCount = 0;
  let zipDefaultExcluded = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!isScannablePath(entry.entryName)) continue;
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
    if (ignored) { zipDefaultExcluded++; continue; }
    // Dot-path parity with the directory walk (see isDotExcluded).
    if (isDotExcluded(entry.entryName)) { zipDefaultExcluded++; continue; }
    const filename = path.basename(entry.entryName);
    if (IGNORED_FILES.includes(filename)) { zipDefaultExcluded++; continue; }

    if (zipExcludePatterns.length > 0 && isExcluded(entry.entryName, zipExcludePatterns)) {
      zipExcludedCount++;
      continue;
    }

    try {
      const content = entry.getData().toString('utf8');
      const estTokens = Math.ceil(content.length / 4);
      if (estTokens > MAX_FILE_TOKENS) {
        console.log(chalk.gray(`  ${SYM.warn} Skipped ${filename}: too large (${Math.round(estTokens/1000)}k tokens)`));
        continue;
      }
      // Same minified-bundle filter the directory walk applies. Without it, a
      // ZIP scan of the same repo loaded jquery.min.js and friends straight
      // into paid context, so cost and noise differed by input method
      // (Audit 7, finding 3.12).
      if (isMinified(entry.entryName, content)) {
        console.log(chalk.gray(`  ${SYM.warn} Skipped ${filename}: minified/bundled file`));
        continue;
      }
      fileMap[entry.entryName] = content;
      count++;
    } catch {}
  }

  if (zipDefaultExcluded > 0) {
    console.log(chalk.gray(`  ${SYM.info}  Default excludes: skipped ${zipDefaultExcluded} file(s) (node_modules, vendor, build artifacts, lock files, etc.)`));
  }
  if (zipExcludedCount > 0) {
    console.log(chalk.gray(`  ${SYM.info}  Exclusions: skipped ${zipExcludedCount} file(s) inside ZIP`));
  }

  spinner.succeed(`Extracted ${count} code files from ZIP`);
  // Attach the source ZIP path so callers can identify the source (buildContext
  // returns null on a fail-closed redaction abort, hence the guard — same
  // pattern as basePath in _loadFromDirPath).
  const result = buildContext(fileMap);
  if (result) result.zipPath = zipPath;
  return result;
}

// ── GitHub rate-limit helpers ────────────────────────────────────────────────
// GitHub signals rate limiting two ways: a 429, or a 403 with
// x-ratelimit-remaining: 0 (primary limit) or a "rate limit" message
// (secondary/abuse limit). Both are retryable after a wait, unlike a plain
// 403 (private repo / bad permissions) which is not.
function isRateLimitError(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  if (err.status === 403) {
    const headers = err.response?.headers || {};
    if (headers['x-ratelimit-remaining'] === '0') return true;
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('rate limit') || msg.includes('secondary rate')) return true;
  }
  return false;
}

// How long to wait before retrying a rate-limited request. Prefer the
// Retry-After header (seconds), then x-ratelimit-reset (unix epoch seconds),
// then a 60s default. Capped at 300s so a far-future reset still surfaces the
// continue/stop prompt to the user instead of silently hanging.
function rateLimitWaitSeconds(err) {
  const headers = err?.response?.headers || {};
  const cap = (s) => Math.min(Math.max(s, 1), 300);

  const retryAfter = headers['retry-after'];
  if (retryAfter != null) {
    const s = parseInt(retryAfter, 10);
    if (Number.isFinite(s) && s > 0) return cap(s);
  }

  const reset = headers['x-ratelimit-reset'];
  if (reset != null) {
    const resetSec = parseInt(reset, 10);
    if (Number.isFinite(resetSec)) {
      const deltaSec = Math.ceil((resetSec * 1000 - Date.now()) / 1000);
      if (deltaSec > 0) return cap(deltaSec);
    }
  }

  return 60;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── GitHub API response-shape guard ──────────────────────────────────────────
// Octokit normally throws on HTTP errors, but a malformed/empty body or an
// unexpected error-object response can come back with the wrong shape. Accessing
// nested fields blindly (repoData.default_branch, tree.tree, item.sha) then
// throws a bare TypeError that surfaces to the user as "Cannot read properties
// of undefined". assertField() turns that into a clear, named error: which field
// was missing on which endpoint. The thrown message is plain so the catch block
// in loadFromGitHub can pattern-match it (401/403/Not Found/rate) where relevant.
function assertField(obj, field, endpoint) {
  if (obj == null || typeof obj !== 'object' || obj[field] === undefined) {
    const got = obj == null ? String(obj) : (obj.message || obj.error || 'unexpected shape');
    throw new Error(
      `GitHub API returned an unexpected response from ${endpoint}: ` +
      `missing field '${field}' (got: ${got}). The API may be returning an error ` +
      `object instead of the expected data.`
    );
  }
  return obj[field];
}

async function loadFromGitHub() {
  const config = getConfig();
  const githubToken = config.get('githubToken');

  const { repoUrl } = await inquirer.prompt([{
    type: 'input',
    name: 'repoUrl',
    message: chalk.cyan("GitHub repo URL or owner/repo (or 'back' to cancel):"),
    validate: (v) => v.length > 0 ? true : 'Required'
  }]);

  // Universal-escape: 'back' keyword — return null so main loop re-prompts.
  if (isBackKeyword(repoUrl)) {
    console.log(chalk.gray('  Cancelled.\n'));
    return null;
  }

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
    const octokit = createOctokit({ auth: auth || undefined });
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
        console.log(chalk.yellow(`  ${SYM.warn}  Configured GitHub token was rejected. Retrying anonymously for public repo access...`));
        spinner.start(`Fetching ${owner}/${repo}...`);
        ({ octokit, repoData } = await tryFetch(null));
      } else {
        throw err;
      }
    }

    const branch = assertField(repoData, 'default_branch', `GET /repos/${owner}/${repo}`);
    const fileMap = {};

    const { data: tree } = await octokit.rest.git.getTree({
      owner, repo,
      tree_sha: branch,
      recursive: 'true'
    });

    // getTree returns { tree: [...], truncated, ... }. A missing or non-array
    // `tree` means the response is not the expected shape (error object, empty
    // body) — surface that clearly instead of letting .filter throw a TypeError.
    const treeEntries = assertField(tree, 'tree', `GET /repos/${owner}/${repo}/git/trees/${branch}`);
    if (!Array.isArray(treeEntries)) {
      throw new Error(
        `GitHub API returned an unexpected response from GET /repos/${owner}/${repo}/git/trees/${branch}: ` +
        `field 'tree' is not an array. The repository may be empty or the API returned an error object.`
      );
    }

    const ghExcludePatterns = resolveExcludePatterns(SCAN_OPTIONS.excludePresets, SCAN_OPTIONS.excludePatterns);
    let ghExcludedCount = 0;
    let ghDefaultExcluded = 0;

    const codeFiles = treeEntries.filter(item => {
      if (!item || typeof item !== 'object' || typeof item.path !== 'string') return false;
      if (item.type !== 'blob') return false;
      if (!isScannablePath(item.path)) return false;
      // Dot-path parity with the directory walk (see isDotExcluded).
      if (isDotExcluded(item.path)) { ghDefaultExcluded++; return false; }
      // Apply default IGNORED_DIRS (handles single-segment + multi-segment like 'pub/static').
      const segments = item.path.split('/');
      for (const d of IGNORED_DIRS) {
        if (d.includes('/')) {
          const parts = d.split('/');
          for (let i = 0; i + parts.length <= segments.length; i++) {
            if (parts.every((p, k) => segments[i + k] === p)) { ghDefaultExcluded++; return false; }
          }
        } else if (segments.includes(d)) {
          ghDefaultExcluded++;
          return false;
        }
      }
      // Apply default IGNORED_FILES.
      if (IGNORED_FILES.includes(path.basename(item.path))) { ghDefaultExcluded++; return false; }
      // Apply user --exclude / --exclude-presets.
      if (ghExcludePatterns.length > 0 && isExcluded(item.path, ghExcludePatterns)) {
        ghExcludedCount++;
        return false;
      }
      return true;
    });

    if (ghDefaultExcluded > 0) {
      console.log(chalk.gray(`  ${SYM.info}  Default excludes: skipped ${ghDefaultExcluded} file(s) (node_modules, vendor, build artifacts, lock files, etc.)`));
    }
    if (ghExcludedCount > 0) {
      console.log(chalk.gray(`  ${SYM.info}  Exclusions: skipped ${ghExcludedCount} file(s) from remote tree`));
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
      console.log(chalk.yellow.bold(`  ${SYM.warn}  Large repo: ${filteredFiles.length} code files in your selected folders.`));
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
    const total = filesToFetch.length;
    const baseFetchText = `Fetching ${Math.min(filteredFiles.length, fetchCap)} files from ${selectedFolders.length} folder(s)...`;
    let fetched = 0;
    let stoppedEarly = false;
    let rateLimitHits = 0;

    for (let i = 0; i < total; i++) {
      const file = filesToFetch[i];
      spinner.text = baseFetchText;
      // A tree blob entry should carry a sha; if it doesn't, there's no way to
      // fetch its content. Skip it rather than passing undefined to getBlob
      // (which would otherwise produce a confusing 404/validation error).
      if (typeof file.sha !== 'string') {
        console.log(chalk.gray(`  ${SYM.warn} Skipped ${file.path}: tree entry missing a blob sha`));
        continue;
      }
      // Inner retry loop: a rate-limited file is retried after a wait; any
      // other error skips the file (preserving prior best-effort behavior).
      // After 3 cumulative rate-limit hits across the fetch, hand the user
      // the choice to keep waiting or stop and keep the partial scan.
      while (true) {
        try {
          const { data } = await octokit.rest.git.getBlob({ owner, repo, file_sha: file.sha });
          if (data.content) {
            const content = Buffer.from(data.content, 'base64').toString('utf8');
            const estTokens = Math.ceil(content.length / 4);
            if (estTokens > MAX_FILE_TOKENS) {
              console.log(chalk.gray(`  ${SYM.warn} Skipped ${file.path}: too large (${Math.round(estTokens/1000)}k tokens)`));
            } else if (isMinified(file.path, content)) {
              // Same minified-bundle filter as the directory walk and ZIP path
              // (Audit 7, finding 3.12).
              console.log(chalk.gray(`  ${SYM.warn} Skipped ${file.path}: minified/bundled file`));
            } else {
              fileMap[file.path] = content;
              fetched++;
            }
          }
          break; // fetched (or intentionally skipped) — move to next file
        } catch (err) {
          if (!isRateLimitError(err)) {
            console.log(chalk.gray(`  ${SYM.warn} Skipped ${file.path}, fetch error: ${err.message}`));
            break;
          }

          rateLimitHits++;
          if (rateLimitHits >= 3) {
            spinner.stop();
            console.log('');
            const { action } = await inquirer.prompt([{
              type: 'list',
              name: 'action',
              message: chalk.yellow(`Hit GitHub's rate limit 3 times on ${file.path} (file ${i + 1}/${total}). What now?`),
              choices: [
                { name: `Keep waiting and retrying (${fetched} files fetched so far)`, value: 'continue' },
                { name: 'Stop and analyze the files already fetched', value: 'stop' },
              ],
              default: 'continue',
            }]);
            if (action === 'stop') {
              stoppedEarly = true;
              break;
            }
            rateLimitHits = 0; // user chose to keep going — reset the counter
            spinner.start(baseFetchText);
          }

          const waitSec = rateLimitWaitSeconds(err);
          spinner.text = `Rate limit hit — waiting ${waitSec}s before continuing (file ${i + 1}/${total})`;
          await sleep(waitSec * 1000);
          // loop continues — retry the same file
        }
      }
      if (stoppedEarly) break;
    }

    spinner.succeed(`Processed ${fetched} files from ${owner}/${repo}`);
    if (stoppedEarly) {
      console.log(chalk.yellow(`  ${SYM.warn} Stopped early at the rate limit. Analyzed ${fetched} of ${total} selected file(s).`));
    } else if (filteredFiles.length > fetchCap) {
      console.log(chalk.yellow(`  ${SYM.warn} Large repo: analyzed first ${fetchCap} code files (${filteredFiles.length} total)`));
    }

    // Attach the parsed source repo identity so callers can identify the source.
    const result = buildContext(fileMap);
    if (result) { result.owner = owner; result.repo = repo; }
    return result;
  } catch (err) {
    spinner.fail('GitHub fetch failed.');
    // Classify by HTTP status first (Octokit sets err.status reliably), then
    // fall back to message-substring matching for errors that carry no status
    // (e.g. the shape-guard errors thrown above, network errors).
    const status = err?.status;
    const msg = err?.message || String(err);
    const isAuthOrNotFound =
      status === 401 || status === 403 || status === 404 ||
      msg.includes('401') || msg.includes('403') || msg.includes('Not Found');
    const isRateLimit = isRateLimitError(err) || msg.includes('rate') || msg.includes('429');
    if (isRateLimit) {
      console.log('');
      console.log(chalk.yellow(`  ${SYM.warn}  GitHub API rate limit reached.`));
      console.log(chalk.gray('  Add a GitHub token in Reconfigure to increase your limit from 60 to 5,000 requests/hour.'));
      console.log(chalk.gray('  Alternative: Download the repo as a ZIP and use "ZIP file" instead.'));
      console.log('');
    } else if (isAuthOrNotFound) {
      console.log('');
      console.log(chalk.yellow(`  ${SYM.warn}  This repository is private or requires authentication.`));
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
    } else {
      console.log(chalk.gray(`  Details: ${msg}`));
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
      `  ${SYM.info}  Loader: skipped ${skipped} minified/bundled files` +
      (truncated > 0 ? `, truncated ${truncated} oversized files` : '')
    ));
  }

  return buildContext(fileMap);
}

// ── Custom-patterns extension hook (stub for v7 GA scope addition) ────────────────────────────────
// Returns profile-declared private_patterns as rule objects to append to the
// redactor's built-in rule set. Initial implementation returns an empty array;
// full feature is sequenced after Stage 3 freemium-to-requireTier conversion.
// Designed-in extension point: when implemented, this becomes a real loader
// that reads profile.private_patterns, validates regex/literal entries,
// tier-gates (Open returns []), and produces { name, regex, replacement }
// objects shaped like REDACTION_RULES.
//
// See TODO-architect-redactor-custom-patterns-v7.md for full design.
function loadCustomPatterns({ tier, profile }) {
  // Stub: no custom patterns until the feature lands.
  // Returning [] is the correct behavior for v7 GA base ship.
  return [];
}

function buildContext(fileMap) {
  const config = getConfig();
  // A saved `ghost reconfigure` preference, if any. Treated as "present" only
  // when it is a real positive number; an absent/blank/zero value must fall
  // through to the full tier cap, NOT a hardcoded 50K. The old `|| 50000`
  // collapsed "no saved preference" into Open's ceiling, so Pro/Team/Enterprise
  // with no saved value (e.g. a fresh CI runner) were silently clamped to 50K
  // even though resolveContextCap would have granted the full tier cap for a
  // null request. ignoreSavedContext (set by the CI guard) forces that null
  // path regardless of any value the runner's configstore happens to hold.
  const savedMax = config.get('maxTokensContext');
  const hasSavedMax = !SCAN_OPTIONS.ignoreSavedContext
    && typeof savedMax === 'number' && Number.isFinite(savedMax) && savedMax > 0;

  // Resolve the effective cap: tier ceiling vs. user's CLI override vs. saved config.
  // Precedence: CLI --max-context (if provided) > config.maxTokensContext > full tier cap.
  // A null userRequested makes resolveContextCap return the tier ceiling outright.
  // Tier cap always clamps the final value.
  const userRequested = SCAN_OPTIONS.maxContextOverride ?? (hasSavedMax ? savedMax : null);
  // Source distinction so the clamp warning names the actual provenance.
  // CLI: user passed --max-context. Config: value came from configstore (often
  // a prior `ghost reconfigure` from a different tier). Default: no saved value,
  // resolving to the full tier cap. See TODO-architect-open-clamp-message-misleading.md.
  const source = SCAN_OPTIONS.maxContextOverride != null
    ? 'cli'
    : (hasSavedMax ? 'config' : 'default');
  const { effective: maxTokens, clamped, tierCap, tier } = resolveContextCap(SCAN_OPTIONS.tier, userRequested, source);

  // ── Redaction ──────────────────────────────────────────────────────────────
  // Strip API keys, secrets, DB credentials, and private keys before files are
  // concatenated into the prompt context. Runs per-file so multi-pass scanners
  // (which work directly off fileMap) also see redacted content. Two-layer
  // failure model:
  //   - Rule level (inside redactContent): warn-and-continue. Each rule's
  //     try/catch lets a single rule fail without aborting the function;
  //     failedRules collects errors; partialRedaction = true is flagged.
  //   - File-loop level (this code): try/catch wraps the redactContent call
  //     itself so a thrown exception (TypeError from non-string input, OOM
  //     on huge file, etc.) becomes a failed-rule entry rather than a stack
  //     trace. Required so the fail-closed promise always presents a polite
  //     user-visible reason for the abort, never a stack trace.
  //   - Loader level (after the loop): fail-closed. If anyPartial is true,
  //     abort the scan before any API call. User's secrets are more important
  //     than completing the scan.
  //
  // Custom-patterns extension hook: profile-declared private_patterns will be
  // appended to the rule set by loadCustomPatterns(). Initial implementation
  // returns an empty array; full feature is sequenced after Stage 3 freemium-
  // to-requireTier conversion. See TODO-architect-redactor-custom-patterns-v7.md.
  // @ghost-verified: SCAN_OPTIONS.profile is intentionally undefined -- loadCustomPatterns is a stub that always returns [] until custom pattern support is implemented; the undefined profile is an accepted no-op
  const customRules = loadCustomPatterns({ tier: SCAN_OPTIONS.tier, profile: SCAN_OPTIONS.profile });

  const redactedFileMap = {};
  const allFindings     = [];
  const allFailedRules  = [];
  let   anyPartial      = false;
  for (const [filePath, content] of Object.entries(fileMap)) {
    try {
      const { redacted, findings, failedRules, partialRedaction } = redactContent(content, customRules, filePath);
      redactedFileMap[filePath] = redacted;
      if (findings.length)    allFindings.push(...findings);
      // Tag each rule failure with the file it occurred on so the abort/skip
      // message and debug log can name exactly which file tripped which rule.
      if (failedRules.length) allFailedRules.push(...failedRules.map(f => ({ ...f, file: f.file || filePath })));
      if (partialRedaction)   anyPartial = true;
    } catch (err) {
      // redactContent has internal try/catches around each rule, so a thrown
      // exception here means something more fundamental failed (TypeError,
      // OOM, etc.). Capture the file path, the exception type, and the first
      // 200 chars of the triggering content so the failure can be diagnosed
      // without re-running under a debugger. Treat as a failed-rule entry so
      // the user sees a polite, actionable abort message rather than a stack
      // trace. Fail-closed contract requires the user understand WHY the scan
      // aborted, not just that something broke.
      allFailedRules.push({
        rule: '<redactContent threw>',
        file: filePath,
        errorType: err?.constructor?.name || err?.name || 'Error',
        error: err?.message || String(err),
        snippet: typeof content === 'string' ? content.slice(0, 200) : String(content ?? '').slice(0, 200),
      });
      // Preserve the raw content so a Pro+ --skip-redaction run still includes
      // this file. Only ever reached when the user has opted into exposure; the
      // fail-closed path below returns null before this map is used.
      redactedFileMap[filePath] = typeof content === 'string' ? content : '';
      anyPartial = true;
    }
  }

  if (anyPartial) {
    // A --skip-redaction request is only honored on Pro+ tiers. Open always
    // fails closed regardless of the flag.
    const skipRequested = SCAN_OPTIONS.skipRedaction === true;
    const skipAllowed   = skipRequested && canSkipRedaction(SCAN_OPTIONS.tier);

    // Persist the full failure detail for post-mortem diagnosis whether we
    // abort or continue. Path is surfaced to the user below.
    const logPath = writeRedactionFailureLog(allFailedRules, { continued: skipAllowed });

    // Structured, actionable per-rule error so users can debug without diving
    // into the debug logs: which rule, on which file, and why.
    console.log(chalk.red(`\n  ${SYM.warn}  Redaction failed on one or more rules.`));
    for (const f of allFailedRules) {
      const where = f.file ? ` on ${f.file}` : '';
      console.log(chalk.red(`      • Redaction rule '${f.rule}' failed${where}: ${f.error}`));
    }
    if (logPath) {
      console.log(chalk.gray(`  Failure details written to ${logPath}`));
    }

    if (skipAllowed) {
      // Pro+ escape hatch: bypass the fail-closed abort and continue with the
      // best-effort redacted content. Warn prominently — secrets in the files
      // above may reach the API unredacted.
      console.log(chalk.yellow.bold(`\n  ${SYM.warn}  --skip-redaction is set: continuing WITHOUT complete redaction.`));
      console.log(chalk.yellow.bold('     SECRETS MAY BE EXPOSED to the API in the files listed above.'));
      console.log(chalk.yellow('     Proceed only if you trust this codebase. Fix the failing rule(s) to restore full protection.\n'));
      // Fall through — buildContext continues using the best-effort redactedFileMap.
    } else {
      // Fail-closed: if any redaction rule errored OR redactContent itself
      // threw, halt before sending anything to Anthropic.
      if (skipRequested) {
        // Requested but not allowed on this tier — say so explicitly.
        console.log(chalk.gray('  --skip-redaction is a Pro+ feature and was not applied on the Open tier.'));
      }
      console.log(chalk.gray('  Scan aborted to protect secrets. Investigate the failing rule(s) before re-running. Your codebase was NOT sent to the API.\n'));
      return null;
    }
  }

  if (allFindings.length > 0) {
    showRedactionSummary({
      findings:         allFindings,
      totalRedactions:  allFindings.length,
      failedRules:      [],
      partialRedaction: false,
    });
  }

  // Use the redacted fileMap going forward — modes that read .fileMap directly
  // (e.g. multi-pass POI / Conflict) need redacted content too, not just the
  // assembled .context string. Bind to a named local rather than reassigning the
  // parameter so the input vs. redacted-output distinction stays explicit.
  const activeFileMap = redactedFileMap;

  // Clear original fileMap to prevent unredacted content from remaining
  // accessible via caller references. Defense-in-depth: nothing downstream in
  // buildContext reads the raw fileMap after this point (only activeFileMap is
  // used), and the loader entry points return the redacted result rather than
  // their raw local map, so this only drops the now-unneeded raw content.
  for (const key of Object.keys(fileMap)) {
    fileMap[key] = null;
  }

  let context = '';
  let fileIndex = [];
  let approxTokens = 0;

  for (const [filePath, content] of Object.entries(activeFileMap)) {
    const approxFileTokens = Math.ceil(content.length / 4);
    if (approxTokens + approxFileTokens > maxTokens) continue;

    context += `\n\n=== FILE: ${filePath} ===\n${content}`;
    fileIndex.push(filePath);
    approxTokens += approxFileTokens;
  }

  const totalFiles = Object.keys(activeFileMap).length;
  const loadedFiles = fileIndex.length;

  // Announce the effective context cap once per scan so users understand what's in play.
  const capLabel = clamped
    ? `${maxTokens.toLocaleString()} tokens (clamped from ${userRequested.toLocaleString()} by ${tier} tier)`
    : `${maxTokens.toLocaleString()} tokens (${tier} tier, cap ${tierCap.toLocaleString()})`;
  console.log(chalk.gray(`  ${SYM.info}  Context cap: ${capLabel}`));

  if (loadedFiles < totalFiles) {
    console.log(chalk.yellow(`  ${SYM.warn} Context limit: processed ${loadedFiles} of ${totalFiles} files (~${approxTokens.toLocaleString()} tokens)`));
  } else {
    console.log(chalk.green(`  ${SYM.check} Processed ${loadedFiles} files (~${approxTokens.toLocaleString()} tokens)`));
  }

  return { context, fileIndex, totalFiles, loadedFiles, fileMap: activeFileMap };
}
