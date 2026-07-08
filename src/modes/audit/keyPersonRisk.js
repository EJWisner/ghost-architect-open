// src/modes/audit/keyPersonRisk.js
//
// Key-Person Risk — Inheritance Audit analyzer #2
//
// Parses git history to estimate author concentration and bus factor.
// Deterministic, no LLM, no network calls.
//
// Approach:
//   - Shell out to `git log --numstat --pretty=format:` against
//     codebaseContext.basePath (set by the local-files loader)
//   - Parse author email + lines-added per commit
//   - Aggregate by author, compute percentages
//   - Anonymize: authors are reported as "Author A", "Author B", etc.
//   - Flag authors whose last commit is > 180 days old as likely departed
//
// Privacy:
//   Raw author emails are NEVER returned in the output. The mapping from
//   hash → display label is kept internal to this function. Buyers see
//   pseudonyms; the consultant running the audit can request raw mapping
//   via the (future) --reveal-authors flag if they have legitimate need.
//
// Graceful degradation:
//   - If basePath is missing (ZIP / GitHub source) → return empty result
//     with a clear note explaining git history wasn't available
//   - If basePath exists but isn't a git repo → same treatment
//   - If git isn't installed → same treatment
//   No failure cascades to the rest of audit-mode.

import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Days since last commit before we flag an author as "likely departed".
// Exported so report/console renderers can disclose the threshold in their
// "likely departed" copy instead of hardcoding (or omitting) the rule.
export const DEPARTED_THRESHOLD_DAYS = 180;

// Cap how many top contributors we report. Pareto says top 5 covers most
// signal; we list up to 10 in the verbose output if they exist.
const MAX_TOP_CONTRIBUTORS = 10;

// Hard cap on commits we'll parse from `git log` to avoid runaway memory
// on very large repos. 10k commits is enough for any reasonable analysis.
const MAX_COMMITS_TO_PARSE = 10000;

// Pretty-format string for `git log` — we use ASCII record separators so
// parsing is robust against authors with weird characters in names.
const LOG_FORMAT = '__GHOST_COMMIT__%H%x01%ae%x01%an%x01%aI';

// ── Helpers ────────────────────────────────────────────────────────────

function hashEmail(email) {
  // SHA-256 truncated to 12 chars. Stable across runs but not reversible.
  return crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 12);
}

function isGitRepo(basePath) {
  try {
    return fs.statSync(path.join(basePath, '.git')).isDirectory();
  } catch {
    // Could also be a bare repo or worktree (.git as a file). Check for that.
    try {
      const stats = fs.statSync(path.join(basePath, '.git'));
      return stats.isFile();
    } catch {
      return false;
    }
  }
}

// Defense-in-depth validation for the basePath handed to git via `-C`. Even
// though execFile does not spawn a shell (so classic injection is not possible),
// we reject control characters, non-strings, and relative paths so a malformed
// basePath fails loudly here instead of producing confusing git errors.
function validateBasePath(basePath) {
  if (!basePath || typeof basePath !== 'string') {
    throw new Error('Invalid basePath: must be a string');
  }
  // Reject null bytes, newlines, and control chars
  if (/[\0\n\r\x01-\x1f\x7f]/.test(basePath)) {
    throw new Error(
      'Invalid basePath: contains control characters'
    );
  }
  // Must be absolute path
  if (!path.isAbsolute(basePath)) {
    throw new Error(
      'Invalid basePath: must be an absolute path'
    );
  }
  return basePath;
}

async function runGitLog(basePath) {
  validateBasePath(basePath);
  // --numstat: per-file changed line counts
  // --pretty=format:LOG_FORMAT: machine-parseable commit headers
  // --no-merges: skip merge commits (they distort line-count attribution)
  // --max-count: hard cap commits
  const args = [
    '-C', basePath,
    'log',
    '--numstat',
    '--no-merges',
    `--max-count=${MAX_COMMITS_TO_PARSE}`,
    `--pretty=format:${LOG_FORMAT}`,
  ];
  const { stdout } = await execFileAsync('git', args, {
    maxBuffer: 64 * 1024 * 1024, // 64MB — enough for very large repos
    timeout: 30_000,             // 30s — bail out if git hangs
  });
  return stdout;
}

function parseGitLog(stdout) {
  // Returns: { authorsByHash: Map<hash, { email, name, commits, linesChanged, firstCommitAt, lastCommitAt }>, totalLinesChanged, totalCommits }
  const lines = stdout.split('\n');
  const authorsByHash = new Map();
  let currentAuthor = null;
  let currentCommitDate = null;
  let totalLinesChanged = 0;
  let totalCommits = 0;

  for (const line of lines) {
    if (line.startsWith('__GHOST_COMMIT__')) {
      // New commit header: __GHOST_COMMIT__SHA<SOH>email<SOH>name<SOH>iso-date
      const parts = line.substring('__GHOST_COMMIT__'.length).split('\x01');
      if (parts.length < 4) continue;
      const [, email, name, isoDate] = parts;

      const hash = hashEmail(email);
      currentAuthor = hash;
      currentCommitDate = isoDate;
      totalCommits++;

      if (!authorsByHash.has(hash)) {
        authorsByHash.set(hash, {
          hash,
          email,  // kept internal — never returned in output
          name,   // kept internal
          commits: 0,
          linesChanged: 0,
          firstCommitAt: isoDate,
          lastCommitAt: isoDate,
        });
      }
      const a = authorsByHash.get(hash);
      a.commits++;
      if (isoDate < a.firstCommitAt) a.firstCommitAt = isoDate;
      if (isoDate > a.lastCommitAt) a.lastCommitAt = isoDate;
      continue;
    }

    if (!currentAuthor) continue;

    // numstat line: "added\tremoved\tpath" — both can be "-" for binary files
    const numstatMatch = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!numstatMatch) continue;

    const added = numstatMatch[1] === '-' ? 0 : parseInt(numstatMatch[1], 10);
    const removed = numstatMatch[2] === '-' ? 0 : parseInt(numstatMatch[2], 10);
    const linesChanged = added + removed;
    if (linesChanged === 0) continue;

    const a = authorsByHash.get(currentAuthor);
    if (a) {
      a.linesChanged += linesChanged;
      totalLinesChanged += linesChanged;
    }
  }

  return { authorsByHash, totalLinesChanged, totalCommits };
}

function assignDisplayLabels(authorsSorted) {
  // Author A, B, C, ... Z, then AA, AB, ...
  function indexToLabel(idx) {
    const letters = [];
    let n = idx;
    while (true) {
      letters.unshift(String.fromCharCode(65 + (n % 26)));
      n = Math.floor(n / 26) - 1;
      if (n < 0) break;
    }
    return 'Author ' + letters.join('');
  }
  return authorsSorted.map((a, idx) => ({
    ...a,
    displayLabel: indexToLabel(idx),
  }));
}

function classifyConcentration(top1Pct, top3Pct, busFactor, totalAuthors) {
  if (totalAuthors === 0) return 'unknown';
  if (top1Pct >= 70 || busFactor <= 1) return 'high';
  if (top3Pct >= 80 || busFactor <= 2) return 'medium';
  return 'low';
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  return Math.floor((now - then) / (24 * 60 * 60 * 1000));
}

// ── Main analyzer ──────────────────────────────────────────────────────

export async function runKeyPersonRisk(codebaseContext, options = {}) {
  const basePath = codebaseContext?.basePath;

  const emptyResult = {
    totalAuthors: 0,
    topContributors: [],
    busFactorEstimate: 0,
    concentrationRisk: 'unknown',
    callouts: [],
    _stub: false,
    _gitAvailable: false,
  };

  // Bail conditions — return empty with a callout explaining why.
  if (!basePath) {
    return {
      ...emptyResult,
      callouts: ['Git history not available — codebase was loaded from ZIP or remote source. Key-person risk analysis requires a local git repository.'],
    };
  }
  if (!isGitRepo(basePath)) {
    return {
      ...emptyResult,
      callouts: [`Git history not available — ${basePath} is not a git repository.`],
    };
  }

  // Run git log.
  let stdout;
  try {
    stdout = await runGitLog(basePath);
  } catch (err) {
    return {
      ...emptyResult,
      callouts: [`Git log failed: ${err.message.slice(0, 120)}`],
    };
  }

  if (!stdout || stdout.trim() === '') {
    return {
      ...emptyResult,
      callouts: ['Git repository has no commits.'],
    };
  }

  const { authorsByHash, totalLinesChanged, totalCommits } = parseGitLog(stdout);

  if (authorsByHash.size === 0 || totalLinesChanged === 0) {
    return {
      ...emptyResult,
      callouts: ['No author activity found in git log.'],
      _gitAvailable: true,
    };
  }

  // Sort authors by lines changed (descending) and compute percentages.
  const authorsSorted = Array.from(authorsByHash.values())
    .sort((a, b) => b.linesChanged - a.linesChanged)
    .map(a => ({
      ...a,
      linesChangedPct: Math.round((a.linesChanged / totalLinesChanged) * 100),
      daysSinceLastCommit: daysSince(a.lastCommitAt),
      likelyDeparted: daysSince(a.lastCommitAt) > DEPARTED_THRESHOLD_DAYS,
    }));

  // Assign Author A/B/C labels.
  const labeledAuthors = assignDisplayLabels(authorsSorted);

  // Bus factor estimate: minimum number of authors whose combined
  // contributions exceed 80% of total lines changed.
  let busFactorEstimate = 0;
  let cumulative = 0;
  for (const a of labeledAuthors) {
    busFactorEstimate++;
    cumulative += a.linesChangedPct;
    if (cumulative >= 80) break;
  }

  const top1Pct = labeledAuthors[0]?.linesChangedPct || 0;
  const top3Pct = labeledAuthors.slice(0, 3).reduce((sum, a) => sum + a.linesChangedPct, 0);
  const top5Pct = labeledAuthors.slice(0, 5).reduce((sum, a) => sum + a.linesChangedPct, 0);

  const concentrationRisk = classifyConcentration(top1Pct, top3Pct, busFactorEstimate, labeledAuthors.length);

  // Top contributors for output. Strip internal email/name fields.
  const topContributors = labeledAuthors.slice(0, MAX_TOP_CONTRIBUTORS).map(a => ({
    displayLabel: a.displayLabel,
    linesChanged: a.linesChanged,
    linesChangedPct: a.linesChangedPct,
    commits: a.commits,
    firstCommitAt: a.firstCommitAt,
    lastCommitAt: a.lastCommitAt,
    daysSinceLastCommit: a.daysSinceLastCommit,
    likelyDeparted: a.likelyDeparted,
  }));

  // Generate human-readable callouts.
  const callouts = [];

  if (top1Pct >= 50) {
    const lead = labeledAuthors[0];
    const departedNote = lead.likelyDeparted
      ? ` whose last commit was ${lead.daysSinceLastCommit} days ago (likely departed: flagged after ${DEPARTED_THRESHOLD_DAYS} days of inactivity)`
      : '';
    callouts.push(
      `${top1Pct}% of code touched by ${lead.displayLabel}${departedNote}.`
    );
  }
  if (busFactorEstimate <= 2 && labeledAuthors.length > 2) {
    callouts.push(
      `Only ${busFactorEstimate} contributor${busFactorEstimate === 1 ? '' : 's'} account for 80% of code changes. If ${busFactorEstimate === 1 ? 'this person leaves' : 'they leave'}, this codebase becomes hard to maintain. High concentration risk.`
    );
  }
  const departedTop = labeledAuthors.slice(0, 5).filter(a => a.likelyDeparted);
  if (departedTop.length > 0) {
    callouts.push(
      `${departedTop.length} of the top 5 contributors appear to have departed (no commits in ${DEPARTED_THRESHOLD_DAYS}+ days): ${departedTop.map(a => a.displayLabel).join(', ')}.`
    );
  }
  if (concentrationRisk === 'low' && labeledAuthors.length >= 4) {
    callouts.push(
      `Healthy contributor distribution: top 3 = ${top3Pct}%, top 5 = ${top5Pct}% (of ${labeledAuthors.length} contributors). Knowledge is spread across ${busFactorEstimate} core contributor${busFactorEstimate === 1 ? '' : 's'}.`
    );
  }

  return {
    totalAuthors: labeledAuthors.length,
    totalCommits,
    totalLinesChanged,
    topContributors,
    busFactorEstimate,
    concentrationRisk,
    callouts,
    _stub: false,
    _gitAvailable: true,
  };
}
