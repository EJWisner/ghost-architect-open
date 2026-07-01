/**
 * Ghost Architect — interactive batch submission helpers.
 *
 * deriveRepoName() resolves a repository name for pending-batch records using
 * whatever source signal codebaseContext carries, in priority order:
 *   1. owner/repo  — a GitHub load already parsed them.
 *   2. basePath    — a directory load; read git origin in that directory.
 *   3. zipPath     — a ZIP load; use the archive filename (no git context).
 *   4. cwd git origin — last-ditch, when context carries no source signal.
 *   5. cwd basename — final fallback so this never throws.
 *
 * Parsing of git origin URLs reuses parseRepo() from team-sync.js (handles
 * https, SSH git@, Enterprise subpaths, trailing .git) — the same parser Ghost
 * Watcher / team-sync use.
 */

import { execFileSync } from 'child_process';
import path from 'path';
import { parseRepo } from '../core/team-sync.js';
import { submitBatch } from '../modes/watcher-batch.js';
// @ghost-verified: transport-meta.js exists and exports formatClockTime -- see src/lib/transport-meta.js
import { formatClockTime } from './transport-meta.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a pending-batch label date like "Jun 26 2026 9:14am". Shared by every
 * mode's batch-submit path so the configstore label format stays consistent.
 */
export function formatBatchLabelDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()} ${formatClockTime(iso)}`;
}

/**
 * Submit a batch from an interactive CLI context, suppressing the watcher-branded
 * progress lines submitBatch() prints. submitBatch lives in the Ghost Watcher
 * module and assumes a CI context, so it logs "Ghost Watcher: ..." lines that
 * are confusing in the interactive flow (where the mode drives its own spinner
 * + messaging). We cannot edit watcher-batch.js, so we filter its console output
 * for the duration of the call only — any line NOT prefixed "Ghost Watcher:"
 * passes through untouched, and the originals are always restored in finally.
 *
 * @param {object|string} clientOrKey  SDK client or bare API key
 * @param {Array}  requests
 * @param {object} [opts]              forwarded to submitBatch
 * @returns {Promise<string>} the batch id
 */
export async function submitBatchInteractive(clientOrKey, requests, opts) {
  const origLog = console.log;
  const origWarn = console.warn;
  const isWatcherLine = (args) =>
    typeof args[0] === 'string' && args[0].startsWith('Ghost Watcher:');
  console.log  = (...args) => { if (!isWatcherLine(args)) origLog(...args); };
  console.warn = (...args) => { if (!isWatcherLine(args)) origWarn(...args); };
  try {
    return await submitBatch(clientOrKey, requests, opts);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

// Read `git remote get-url origin` (optionally in `dir`) and parse out the repo
// name. Returns null on any failure — no git, no origin, or an unparseable URL.
// Uses execFileSync (arg array, no shell) so paths with spaces are safe.
function repoNameFromGit(dir) {
  try {
    const args = dir
      ? ['-C', dir, 'remote', 'get-url', 'origin']
      : ['remote', 'get-url', 'origin'];
    const url = execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (url) {
      const { repo } = parseRepo(url);
      if (repo) return repo;
    }
  } catch { /* no git / no origin / unparseable — fall through */ }
  return null;
}

/**
 * Resolve the repository name for a scan, using the source signal that the
 * loader attached to codebaseContext (owner/repo, basePath, or zipPath).
 * Always returns a non-empty string; never throws.
 */
export function deriveRepoName(codebaseContext = {}) {
  const ctx = codebaseContext || {};

  // 1. GitHub load — owner/repo already parsed by the loader.
  if (ctx.owner && ctx.repo) return ctx.repo;

  // 2. Directory load — run git against the scanned directory itself.
  if (ctx.basePath) {
    const name = repoNameFromGit(ctx.basePath);
    if (name) return name;
  }

  // 3. ZIP load — no git context; use the archive filename without extension.
  if (ctx.zipPath) {
    const base = path.basename(ctx.zipPath, path.extname(ctx.zipPath));
    if (base) return base;
  }

  // 4. Fallback — git origin from the current working directory.
  const cwdName = repoNameFromGit();
  if (cwdName) return cwdName;

  // 5. Last resort — the cwd basename.
  return path.basename(process.cwd()) || 'project';
}
