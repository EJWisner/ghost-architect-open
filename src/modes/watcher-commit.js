/**
 * Ghost Watcher™ — watcher-commit mode
 * Headless CI pipeline. Triggered by `ghost --watcher-commit` inside GitHub Actions.
 *
 * Pipeline:
 *   1. Read ghost-watcher.yaml from repo root
 *   2. Identify changed files via git diff
 *   3. Load codebase context
 *   4. Run Blast Radius on changed files
 *   5. Run Conflict Detection on changed files
 *   6. Generate Ghost Brief prompt pack
 *   7. Push results to portal repo (ghost-reports)
 *   8. Post PR comment (if pr_comment: true)
 *   9. Exit 0 always — Ghost Watcher never blocks a commit
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import YAML from 'yaml';
import Anthropic from '@anthropic-ai/sdk';
import { createOctokit } from '../utils/octokit-client.js';
import { getPortalConfig, isPortalConfigured } from '../core/portal-publish.js';
import { loadProfile, getBranding, mergeRates } from '../profile/index.js';
import { getDefaultProfileSlug, getConfig, resolveApiKey } from '../config.js';
import { loadFromPath, setScanOptions } from '../loader/index.js';
import { extractFindings, generateFindingId, similarFinding } from '../utils/finding-parser.js';
import { normalizeCandidateToFinding, extractCandidates } from '../core/conflict.js';
import { narrateReportSync } from '../core/agent/narrator.js';
import { fromPOI, fromConflict } from '../../lib/ghostBriefAdapter.js';
import { partitionFindings } from '../watch/ghost-verified.js';
import { pingWatcherRun } from '../telemetry/pulse.js';
import { requireTier } from '../license/tier-gates.js';
import { verifyConflicts } from '../core/agent/verifier.js';
// @ghost-verified: watcher-commit.js imports from both src/estimator.js (CLI display layer) and src/core/estimator.js (pricing logic) intentionally -- these are separate modules with different responsibilities
import { getPricing } from '../core/estimator.js';
import { BATCH_DISCOUNT } from '../lib/cost-estimator.js';
import { buildSystemBlast } from '../../prompts/index.js';
import { buildSystemConflict, buildConflictPrompt } from '../../prompts/index.js';
import { getSamplingParams, modelRejectsTemperature } from '../utils/sampling-params.js';
import {
  submitBatch,
  preflightBatchCheck,
  pollBatch,
  storePendingBatch,
  retrievePendingBatches,
  clearPendingBatch,
  incrementIncompleteRuns,
  resetIncompleteRuns,
  getPendingState,
  markSetupWarningSent,
  BatchTimeoutError,
  BatchAllFailedError,
} from './watcher-batch.js';

// ── Constants ────────────────────────────────────────────────────────────────

const WATCH_CONFIG_FILE = 'ghost-watcher.yaml';
const WATCH_SCHEMA_VERSION = '1.0';

// ── HTML escaping (email templates) ─────────────────────────────────────────────
// Minimal escaper for interpolating user/model-generated content (finding titles,
// detail text, file paths, repo names) into notification email HTML. Escapes the
// five characters that matter for safe HTML and attribute interpolation.
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Markdown escaping (PR comments) ─────────────────────────────────────────────
// Escaper for interpolating user/model-generated content (finding titles,
// severities, branch names, actor names) into GitHub PR-comment markdown.
// Neutralizes markdown control characters, HTML angle brackets, newlines, and
// @-mention triggers so crafted finding titles or fork branch names cannot
// inject markup or notify arbitrary users.
function escapeMarkdown(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/\n/g, ' ')
    .replace(/#/g, '\\#')
    .replace(/@/g, '\\@');
}

// ── Config reader ─────────────────────────────────────────────────────────────

/**
 * Read and validate ghost-watcher.yaml from the repo root.
 * Throws with a clear message if the file is missing or malformed.
 */
export function readWatchConfig(repoRoot = process.cwd()) {
  const configPath = path.join(repoRoot, WATCH_CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Ghost Watcher: ${WATCH_CONFIG_FILE} not found in ${repoRoot}.\n` +
      `Run 'ghost' and select Ghost Watcher > Enable Watch to set up.`
    );
  }

  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Ghost Watcher: failed to parse ${WATCH_CONFIG_FILE}: ${err.message}`);
  }

  const cfg = raw?.ghost_watcher;
  if (!cfg) {
    throw new Error(`Ghost Watcher: ${WATCH_CONFIG_FILE} must have a top-level 'ghost_watcher:' key.`);
  }

  if (cfg.enabled === false) {
    throw new Error(`Ghost Watcher: Watch is disabled in ${WATCH_CONFIG_FILE}. Set enabled: true to activate.`);
  }

  return cfg;
}

/**
 * Opt-in iteration-limit predicate (Step 1c of runWatchCommit).
 *
 * The limit fires ONLY when iterations.max is explicitly set in
 * ghost-watcher.yaml. Absent (undefined) or null means no limit, so Watch runs
 * on every push. An explicit number fires only when runNumber is strictly
 * GREATER than the limit (at-limit is allowed, over-limit skips).
 *
 * Pure and exported so it can be unit-tested directly.
 *
 * @param {object} watchConfig  parsed ghost_watcher config
 * @param {number} runNumber    GITHUB_RUN_NUMBER for this PR
 * @returns {boolean} true if this run should be skipped
 */
export function shouldSkipForIterationLimit(watchConfig, runNumber) {
  const maxIterations = watchConfig?.iterations?.max;
  return maxIterations != null && runNumber > maxIterations;
}

// ── Git diff ──────────────────────────────────────────────────────────────────

/**
 * Identify changed files for this CI event.
 *
 * GitHub Actions sets GITHUB_EVENT_NAME:
 *   push            — diff HEAD~1..HEAD
 *   pull_request    — diff origin/<base>...HEAD (full PR diff)
 *
 * Returns an array of relative file paths that exist on disk (deleted
 * files are excluded — nothing to analyze).
 */
export function getChangedFiles(repoRoot = process.cwd()) {
  const eventName = process.env.GITHUB_EVENT_NAME || 'push';
  const baseRef   = process.env.GITHUB_BASE_REF;   // set on pull_request events

  let diffCmd;
  if (eventName === 'pull_request' && baseRef) {
    diffCmd = `git diff origin/${baseRef}...HEAD --name-only`;
  } else {
    // push event or fallback
    diffCmd = `git diff HEAD~1 HEAD --name-only`;
  }

  let output;
  try {
    output = execSync(diffCmd, { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    // On the very first commit HEAD~1 does not exist — fall back to all tracked files
    try {
      output = execSync('git diff --cached --name-only', { cwd: repoRoot, encoding: 'utf8' });
    } catch {
      return [];
    }
  }

  const allChanged = output
    .split('\n')
    .map(f => f.trim())
    .filter(Boolean);

  // Filter to files that actually exist (skip deleted files)
  return allChanged.filter(f => fs.existsSync(path.join(repoRoot, f)));
}

// ── Developer identity ────────────────────────────────────────────────────────

/**
 * Resolve developer identity from environment or git config.
 * Identity matched on email for platform-agnostic team routing.
 */
export function resolveDeveloperIdentity() {
  // Explicit override via env — useful for bot commits or shared CI
  const envId = process.env.GHOST_DEVELOPER_ID;
  if (envId) {
    const [name, email] = envId.split('|').map(s => s.trim());
    return { name: name || envId, email: email || envId };
  }

  try {
    const name  = execSync('git config user.name',  { encoding: 'utf8' }).trim();
    const email = execSync('git config user.email', { encoding: 'utf8' }).trim();
    if (name && name !== 'unknown') return { name, email };
  } catch { /* fall through to GitHub env */ }

  // GitHub Actions fallback — git config not set on ephemeral runners
  const actor = process.env.GITHUB_ACTOR;
  if (actor) {
    return { name: actor, email: `${actor}@users.noreply.github.com` };
  }

  return { name: 'unknown', email: 'unknown' };
}

// ── Portal repo push ──────────────────────────────────────────────────────────

/**
 * Slugify an email for use as a directory name.
 * ed@acme.com -> ed-at-acme-com
 */
function emailToSlug(email) {
  return (email || 'unknown')
    .replace('@', '-at-')
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase();
}

/**
 * Push a Watch result JSON to the portal repo via GitHub API.
 * Uses upsertFile pattern from portal-publish.js.
 *
 * Path: projects/<projectSlug>/scans/watch/<developerSlug>/<filename>
 */
async function upsertPortalFile(octokit, owner, repo, filePath, content, message, maxAttempts = 4) {
  // Encode content once -- only the sha re-fetch and PUT repeat on conflict.
  const encoded = Buffer.isBuffer(content)
    ? content.toString('base64')
    : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2)).toString('base64');
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Re-fetch the current sha on every attempt so a stale sha never blocks the write.
    let sha = null;
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
      sha = data.sha;
    } catch (e) {
      // Only a true 404 means the file does not exist yet -- re-throw everything else
      // (auth, rate-limit, network) so we do not blindly attempt a create over an existing file.
      if (e?.status !== 404) throw e;
    }
    try {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner, repo,
        path: filePath,
        message,
        content: encoded,
        ...(sha ? { sha } : {}),
      });
      return;
    } catch (err) {
      const isConflict = err?.status === 409 || err?.status === 422 ||
        (typeof err?.message === 'string' && err.message.includes('does not match'));
      if (!isConflict || attempt === maxAttempts) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// ── PR comment ────────────────────────────────────────────────────────────────

/**
 * Post a Ghost Watcher summary comment on the PR that triggered this run.
 * Uses GITHUB_TOKEN (provided automatically by GitHub Actions).
 * No-ops gracefully if PR context is not available.
 */
// Render the "Reviewed · Expected Behavior" section listing findings the dev
// team marked @ghost-verified. Returns '' when there are none so callers can
// append unconditionally. Each line carries severity, title, primary file, and
// the optional reason captured after the marker.
function buildVerifiedSection(verifiedFindings) {
  if (!Array.isArray(verifiedFindings) || verifiedFindings.length === 0) return '';
  const n = verifiedFindings.length;
  let s = `### ✅ ${n} Reviewed · Expected Behavior\n\n`;
  s += `These findings were marked \`@ghost-verified\` by the development team and confirmed as expected behavior. No action required.\n\n`;
  for (const f of verifiedFindings) {
    const file = Array.isArray(f.files) && f.files.length > 0 ? f.files[0] : null;
    let line = `  - **${escapeMarkdown(f.severity || 'INFO')}:** ${escapeMarkdown(f.title || 'Untitled finding')}`;
    if (file) line += ` -- \`${escapeMarkdown(file)}\``;
    if (f.verifiedReason) line += ` _(${escapeMarkdown(f.verifiedReason)})_`;
    s += line + `\n`;
  }
  s += `\n`;
  return s;
}

async function postPRComment({ findings, verifiedFindings = [], blastFileCount, briefPromptCount, portalUrl, clean = false, scanFailed = false, incompleteScans = [] }) {
  const prToken = process.env.GHOST_PR_TOKEN || process.env.GITHUB_TOKEN;
  if (!prToken) return;

  // GitHub Actions sets GITHUB_REPOSITORY and GITHUB_REF for PR events
  const repository = process.env.GITHUB_REPOSITORY; // owner/repo
  const sha        = process.env.GITHUB_SHA         || 'unknown';
  const refName    = process.env.GITHUB_REF_NAME    || process.env.GITHUB_HEAD_REF || 'unknown';
  const actor      = process.env.GITHUB_ACTOR       || 'unknown';

  if (!repository) return; // not running in GitHub Actions

  // Extract PR number from GITHUB_REF (refs/pull/123/merge)
  const prMatch = (process.env.GITHUB_REF || '').match(/refs\/pull\/(\d+)\//);
  if (!prMatch) return; // push event, not a PR — no comment to post

  // No scan actually completed — surface an explicit error, never a clean
  // result. A caught "non-fatal" submission failure leaves findings empty for a
  // reason that is NOT "clean"; treating it as clean is a false green signal.
  if (scanFailed) {
    try {
      const octokit = createOctokit({ auth: prToken });
      const [owner, repo] = repository.split('/');
      const prNumber = parseInt(prMatch[1], 10);
      const shortSha = sha.slice(0, 7);
      const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const body = [
        `## 👻 Ghost Watcher™ -- Commit Analysis`,
        ``,
        `**Branch:** \`${escapeMarkdown(refName)}\``,
        `**Commit:** \`${shortSha}\` · ${escapeMarkdown(actor)} · ${date}`,
        ``,
        `⚠️ **Ghost Watcher could not complete this scan.**`,
        ``,
        `Results are unavailable. Do not treat this as a clean result.`,
      ].join('\n');
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    } catch (err) {
      console.error(`Ghost Watcher: error-state PR comment failed (non-fatal): ${err.message}`);
    }
    return;
  }

  // Zero findings — post clean green comment and return
  if (clean) {
    try {
      const octokit = createOctokit({ auth: prToken });
      const [owner, repo] = repository.split('/');
      const prNumber = parseInt(prMatch[1], 10);
      const shortSha = sha.slice(0, 7);
      const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const cleanTail = incompleteScans.length === 0
        ? [
            `✅ **No findings detected.**`,
            ``,
            `Blast Radius: no affected files outside the changed set`,
            `Conflict Detection: no conflicts found`,
            `Ghost Brief: not needed`,
            ``,
            `**Safe to merge.**`,
          ]
        : [
            `⚠️ **No findings from the scans that completed, but this run is incomplete.**`,
            ``,
            `Did not complete: ${incompleteScans.join(', ')}.`,
            ``,
            `Do not treat this as a full clean result. Re-run after resolving the issue above.`,
          ];
      const body = [
        `## 👻 Ghost Watcher™ -- Commit Analysis`,
        ``,
        `**Branch:** \`${escapeMarkdown(refName)}\``,
        `**Commit:** \`${shortSha}\` · ${escapeMarkdown(actor)} · ${date}`,
        ``,
        ...cleanTail,
      ].join('\n');
      const verifiedSection = buildVerifiedSection(verifiedFindings);
      const finalBody = verifiedSection ? `${body}\n\n${verifiedSection}` : body;
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: finalBody });
    } catch (err) {
      console.error(`Ghost Watcher: clean PR comment failed (non-fatal): ${err.message}`);
    }
    return;
  }

  const prNumber = parseInt(prMatch[1], 10);
  const [owner, repo] = repository.split('/');

  // Blast Radius findings are impact observations (files that import from
  // modules this commit touched), not defects. Separate them from the
  // action-required findings so a reviewer never reads "exposed" as "broken".
  // They render in their own "No Action Required" section at the bottom.
  const blastRadiusFindings = findings.filter(f => f.source_mode === 'blast');
  const actionFindings      = findings.filter(f => f.source_mode !== 'blast');

  // Severity breakdown (action-required findings only; blast observations do
  // not carry an action-required severity into the summary or phases).
  const critical = actionFindings.filter(f => f.severity === 'CRITICAL').length;
  const high     = actionFindings.filter(f => f.severity === 'HIGH').length;
  const medium   = actionFindings.filter(f => f.severity === 'MEDIUM').length;
  const low      = actionFindings.filter(f => f.severity === 'LOW').length;
  const total    = actionFindings.length;

  // Severity summary line
  const parts = [];
  if (critical) parts.push(`${critical} critical`);
  if (high)     parts.push(`${high} high`);
  if (medium)   parts.push(`${medium} medium`);
  if (low)      parts.push(`${low} low`);
  const severitySummary = parts.length ? parts.join(' · ') : 'none';

  // Phase grouping for the comment body
  const phase1 = actionFindings.filter(f => ['CRITICAL', 'HIGH'].includes(f.severity));
  const phase2 = actionFindings.filter(f => ['MEDIUM', 'LOW'].includes(f.severity));

  const shortSha = sha.slice(0, 7);
  const date     = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  let body = `## 👻 Ghost Watcher™ -- Commit Analysis\n\n`;
  body    += `**Branch:** \`${escapeMarkdown(refName)}\`\n`;
  body    += `**Commit:** \`${shortSha}\` · ${escapeMarkdown(actor)} · ${date}\n\n`;
  body    += `**Findings:** ${total} (${severitySummary})\n`;
  body    += `**Blast radius:** ${blastFileCount} file${blastFileCount === 1 ? '' : 's'} affected\n`;
  body    += `**Ghost Brief:** ${briefPromptCount} prompt${briefPromptCount === 1 ? '' : 's'} ready\n\n`;

  if (incompleteScans.length > 0) {
    body  += `> ⚠️ This run is incomplete: ${incompleteScans.join(', ')} did not complete. Findings below may be partial.\n\n`;
  }

  if (phase1.length > 0) {
    body += `### PHASE 1 -- Fix first (surgical)\n`;
    for (const f of phase1) {
      body += `  - **${escapeMarkdown(f.severity)}:** ${escapeMarkdown(f.title)}\n`;
    }
    body += `  → Prompts ready in Ghost Portal\n\n`;
  }

  if (phase2.length > 0) {
    body += `### PHASE 2 -- Fix second (moderate)\n`;
    for (const f of phase2) {
      body += `  - **${escapeMarkdown(f.severity)}:** ${escapeMarkdown(f.title)}\n`;
    }
    body += `  → Prompts ready in Ghost Portal\n\n`;
  }

  if (total === 0 && blastRadiusFindings.length === 0) {
    body += `No findings detected for this commit.\n\n`;
  }

  if (portalUrl) {
    body += `[Open Ghost Portal to copy prompts into your AI coding tool.](${portalUrl})\n`;
  }

  // Group 2: Blast Radius Observations -- impact map, no action required. Kept
  // visually distinct from the action-required findings above so stakeholders
  // do not mistake "exposed" for "broken".
  if (blastRadiusFindings.length > 0) {
    body += `\n### 🔍 ${blastRadiusFindings.length} · Blast Radius Observations -- No Action Required\n`;
    body += `These files import from modules touched by this commit. No issues were identified -- review if making further changes to these areas.\n\n`;
    for (const f of blastRadiusFindings) {
      body += `  - ${escapeMarkdown(f.title)}\n`;
    }
    body += `\n`;
  }

  body += buildVerifiedSection(verifiedFindings);

  try {
    const octokit = createOctokit({ auth: prToken });
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  } catch (err) {
    // Non-fatal — never block the pipeline over a comment failure
    console.error(`Ghost Watcher: PR comment failed (non-fatal): ${err.message}`);
  }
}

// ── Batches API helpers ────────────────────────────────────────────────────────
//
// Ghost Watcher runs the Blast Radius and Conflict Detection scans through the
// Anthropic Message Batches API instead of streaming/non-streaming create()
// calls. Streaming drops with "Premature close" on large-context scans inside
// GitHub Actions; the Batches API processes requests asynchronously server-side
// with no open connection to hold, which eliminates the timeout entirely.
//
// The prompt *content* is identical to what runBlastRadius / runConflictScan
// build — only the transport changes. These helpers reconstruct the exact same
// system prompts and user messages so the model sees byte-identical input, then
// the raw output flows through the unchanged extractFindings / extractCandidates
// parsers and the unchanged narrator / Ghost Brief / portal / PR-comment path.

function getWatcherModel() {
  return getConfig().get('defaultModel') || 'claude-sonnet-4-6';
}

function getRates() {
  const cfg = getConfig();
  return {
    junior: cfg.get('rateJunior') || 85,
    mid:    cfg.get('rateMid')    || 125,
    senior: cfg.get('rateSenior') || 200,
  };
}

/**
 * Build the Blast Radius system prompt and user message exactly as
 * runBlastRadius() does (src/analyst/index.js), so the batch request is
 * byte-identical to the streaming path. `target` is the changed-files array;
 * Watch never runs in forecast mode, so the forecast preamble is omitted.
 */
function buildBlastPrompts(codebaseContext, target, profile) {
  const rates = mergeRates(getRates(), profile);

  const targets = Array.isArray(target)
    ? target.map(t => String(t).trim()).filter(Boolean)
    : [String(target || '').trim()].filter(Boolean);

  if (targets.length === 0) {
    throw new Error('Blast radius requires at least one target.');
  }

  const systemPrompt = buildSystemBlast(rates, profile);
  const profileReminder = profile
    ? `You are scanning on behalf of ${profile.author || 'the consultant'}. Apply their methodology as described in the CONSULTANT CONTEXT block of your system prompt — weight findings through their lens, name findings in their vocabulary, and organize the rollback plan around their priorities. Do not fabricate findings to match their priorities; apply them only where the code actually exhibits the pattern.\n\n`
    : '';

  let userMessage;
  if (targets.length === 1) {
    userMessage = `${profileReminder}Perform a blast radius analysis for: "${targets[0]}"\n\nCodebase:\n\n${codebaseContext.context}`;
  } else {
    const targetList = targets.map((t, i) => `  ${i + 1}. ${t}`).join('\n');
    userMessage =
      profileReminder +
      `Perform a blast radius analysis for the following coordinated change set ` +
      `(${targets.length} files that will be modified together as part of one engagement):\n\n` +
      targetList + '\n\n' +
      `IMPORTANT: Treat these files as a single coordinated change. Produce ONE unified ` +
      `blast radius report, not separate reports per file. The downstream impact map should ` +
      `show the COMBINED set of files, modules, and behaviors affected when ALL of these ` +
      `targets change together. Where dependencies overlap, call out the overlap explicitly ` +
      `("X depends on both A and B — touching either alone is risky; coordinating both ` +
      `lowers risk"). Produce ONE rollback plan that handles the coordinated change as a ` +
      `unit, not three separate plans. Where coordinating these changes reduces risk versus ` +
      `doing them separately, say so. Where coordinating compounds risk (e.g. all three ` +
      `touch the same shared dependency), call that out as a danger zone.\n\n` +
      `Codebase:\n\n${codebaseContext.context}`;
  }

  return { systemPrompt, userMessage };
}

/**
 * Build the Conflict Detection system prompt and single-pass user message using
 * the same builders runConflictScan() uses (prompts/conflict.js). Watch scans a
 * bounded changed-file set, so a single pass over the loaded fileMap is the
 * batch-shaped equivalent of the streaming multi-pass scan. Candidates are
 * extracted from the raw output with the unchanged extractCandidates parser.
 */
// Target max body size per conflict batch request. Staying under 900 KB
// gives headroom for the system prompt, JSON envelope, and HTTP headers,
// keeping the total POST body well under 1 MB to avoid CI network drops.
const CONFLICT_CHUNK_LIMIT_BYTES = 900 * 1024;

/**
 * Split fileMap into chunks where each chunk's serialized context stays
 * under CONFLICT_CHUNK_LIMIT_BYTES. Returns an array of context strings,
 * one per chunk.
 */
function chunkFileMapForConflict(fileMap) {
  const entries = Object.entries(fileMap || {});
  const chunks = [];
  let currentChunk = '';
  let currentBytes = 0;

  for (const [fp, content] of entries) {
    const entry = `\n\n=== FILE: ${fp} ===\n${content}`;
    const entryBytes = Buffer.byteLength(entry, 'utf8');

    // If a single file exceeds the limit, it gets its own chunk.
    if (currentBytes + entryBytes > CONFLICT_CHUNK_LIMIT_BYTES && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = entry;
      currentBytes = entryBytes;
    } else {
      currentChunk += entry;
      currentBytes += entryBytes;
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks.length ? chunks : [''];
}

/**
 * Build one batch request object per chunk.
 * Uses multi-pass framing when there are multiple chunks so the model
 * knows to look for cross-file conflicts that span passes.
 */
function buildConflictPrompts(fileMap, profile, commitSha) {
  const contextChunks = chunkFileMapForConflict(fileMap);
  const totalFiles    = Object.keys(fileMap || {}).length;
  const totalPasses   = contextChunks.length;
  const systemPrompt  = buildSystemConflict(profile);

  return contextChunks.map((context, i) => {
    const passNum     = i + 1;
    const userMessage = buildConflictPrompt({
      passNum,
      totalPasses,
      totalFiles,
      context,
      priorContext: '',
      forecastContext: null,
    });
    return {
      custom_id: sanitizeCustomId(`conflict-p${passNum}-${commitSha}-${Date.now()}`),
      params: {
        model: getWatcherModel(),
        max_tokens: 8096,
        ...getSamplingParams(0, getWatcherModel()),
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
    };
  });
}

// ── Blast-aware file recovery ──────────────────────────────────────────────────
//
// Raw Blast Radius batch output lists impacted files as bullets under a per-
// section header, with no `Files:` line:
//   ### From `src/reports.js`
//   - **`src/pdf-generator.js`** — imported directly for `generatePDF()`
//   - **`src/lib/transport-meta.js`** — imported for `formatTransportFooter()`
// extractFindings() therefore yields empty `files` arrays, which the Ghost Brief
// adapter's files.primary filter drops. We recover the paths straight from the
// raw text, keyed by section title (the section's own backtick file first, then
// the bullet files), and merge them into findings that arrived without files.
// Parser and narrator are untouched.

// A backtick token is a file path only if it has a dotted extension and no
// parentheses — keeps `src/pdf-generator.js`, `package.json`; rejects
// `generatePDF()` and bare symbols like `GHOST_VERSION`.
function looksLikeFilePath(token) {
  const t = token.replace(/\*+/g, '').trim();
  if (!t || /\s/.test(t) || t.includes('(') || t.includes(')')) return false;
  return /\.[A-Za-z0-9]+$/.test(t) && /^[\w./@-]+$/.test(t);
}

// Pull the file paths out of a single line's backtick tokens, in order.
function filePathsFromLine(line) {
  const out = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const file = m[1].replace(/\*+/g, '').trim();
    if (looksLikeFilePath(file)) out.push(file);
  }
  return out;
}

// Normalize a section header / finding title to a stable lookup key. Mirrors the
// trimming extractFindings applies to titles (leading "N." and the #s) so raw
// section headers and parsed finding titles collapse to the same key.
function normalizeSectionKey(title) {
  return String(title)
    .replace(/^#{2,3}\s+/, '').replace(/^\d+\.\s+/, '')
    .replace(/[`*]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Walk the raw blast text; for each ##/### section collect file paths keyed by
// normalized section title. The section header's own backtick file (e.g.
// `src/reports.js` in "### From `src/reports.js`") is seeded FIRST so it lands
// as the finding's primary file, with the bullet files following in order.
function extractBlastSectionFiles(rawBlastOutput) {
  const map = new Map();
  if (!rawBlastOutput) return map;
  let key = null, inCodeBlock = false;
  for (const raw of rawBlastOutput.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;
    if (/^#{2,3}\s+/.test(line)) {
      key = normalizeSectionKey(line);
      if (!map.has(key)) map.set(key, []);
      const bucket = map.get(key);
      // Seed the title's own file first (the changed source the section is "From").
      for (const file of filePathsFromLine(line)) {
        if (!bucket.includes(file)) bucket.push(file);
      }
      continue;
    }
    if (!key || !/^[-*]\s/.test(line)) continue;   // bullet lines only
    const bucket = map.get(key);
    for (const file of filePathsFromLine(line)) {
      if (!bucket.includes(file)) bucket.push(file);
    }
  }
  return map;
}

// Fill empty `files` arrays from the section map (never overrides files the
// narrator already produced) and recompute the id to reflect the primary file.
function enrichBlastFindingFiles(findings, sectionFiles) {
  if (!findings || !sectionFiles || sectionFiles.size === 0) return findings;
  // Index fallback: when the narrator rewords titles, the title-keyed lookup misses.
  // Fall back to position-based matching when finding count === section count
  // (count-equality gate ensures we only use index when structure is 1:1 -- no mismatch risk).
  const orderedSections = Array.from(sectionFiles.values());
  const useIndexFallback = findings.length === orderedSections.length;
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    if (f.files && f.files.length) continue;
    // Primary: title-keyed lookup
    let files = sectionFiles.get(normalizeSectionKey(f.title || ''));
    // Fallback: position-based when title lookup misses and counts match
    if ((!files || !files.length) && useIndexFallback) {
      files = orderedSections[i];
    }
    if (files && files.length) { f.files = [...files]; f.id = generateFindingId(f); }
  }
  return findings;
}

/**
 * Turn the raw Blast Radius batch output into findings, replicating Step 2 of
 * runBlastRadius() (src/analyst/index.js).
 *
 * The raw model output is in the blast system-prompt format (the 💥/🌊/🧨/✅/⚠️
 * sections, then REMEDIATION / ROLLBACK plans) — it has NO per-finding `Files:`
 * lines. Parsing it directly yields findings whose `files` arrays are empty,
 * which the Ghost Brief adapter's `files.primary.length > 0` filter then
 * discards (the "findings array is empty" failure). The narrator rewrites that
 * raw output into the canonical Ghost report — `### Finding` headers with
 * `Severity:` and `Files:` lines — which is exactly what the old streaming path
 * captured via its onChunk buffer and what extractFindings + the Brief expect.
 * So we narrate first, then parse the narrated report.
 *
 * The narrator's own LLM calls operate on the small findings/report payload (not
 * the full codebase), so they are not the large-context calls that prompted the
 * batch migration. If narration fails for any reason we fall back to the raw
 * findings so a narrator hiccup never drops the run.
 */
async function blastFindingsFromRaw(rawBlastOutput, { profile, changedFiles, codebaseContext }) {
  const rawFindings = extractFindings(rawBlastOutput, 'blast');
  if (rawFindings.length === 0) return [];

  // Recover per-section file paths from the raw bullet lines once, then enrich
  // the parsed findings BEFORE narration so the narrator receives real file
  // paths and emits `Files:` lines (which the re-parse below then captures).
  const sectionFiles = extractBlastSectionFiles(rawBlastOutput);
  enrichBlastFindingFiles(rawFindings, sectionFiles);

  try {
    const rates = mergeRates(getRates(), profile);
    const projectLabel = changedFiles.length === 1
      ? changedFiles[0]
      : `change set of ${changedFiles.length} files`;

    // narrateReportSync uses messages.create (blocking non-streaming) — no
    // streaming connection to drop, no timeout wrapper needed. CI networks
    // that caused streaming timeouts do not affect blocking create calls.
    // The outer try/catch handles any API failure with raw findings fallback.
    const narratedReport = await narrateReportSync(
      {
        findings:      rawFindings,
        findingCount:  rawFindings.length,
        filesAnalyzed: codebaseContext?.loadedFiles || 0,
        stepCount:     1,
        auditTrail:    [],
      },
      { projectLabel, mode: 'blast', rates, profile },
    );

    // Re-enrich the re-parsed result as a guarantee (covers any finding the
    // narrator rendered without a Files line).
    return enrichBlastFindingFiles(extractFindings(narratedReport || rawBlastOutput), sectionFiles);
  } catch (err) {
    console.error(`Ghost Watcher: Blast narrator failed (non-fatal), using raw findings — ${err.message}`);
    rawFindings._narratorFailed = true;
    return enrichBlastFindingFiles(rawFindings, sectionFiles);
  }
}

// A batch custom_id must match ^[a-zA-Z0-9_-]{1,64}$. Short commit SHAs are hex,
// the mode prefix and timestamp are alphanumeric/`-`, so the result always
// satisfies the pattern. We still sanitize defensively in case of a non-hex
// fallback SHA ('local'), then clamp to 64 chars.
function sanitizeCustomId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

// ── Detailed remediation prompts (Step 8e) ──────────────────────────────────
//
// After the Ghost Brief is built, Ghost Watcher generates one LLM-authored,
// developer-ready remediation prompt per finding through a single batch (one
// request per finding). The returned text replaces the templated prompt on the
// matching brief entry. Results are matched back to findings by the numeric
// index baked into the custom_id (prompt-<commitSha>-<index>).

const PROMPT_GEN_SYSTEM =
  'You are a senior software architect writing remediation prompts for developers. ' +
  'Write a detailed, actionable prompt that a developer can paste directly into Claude Code, ' +
  'Cursor, Copilot, or any AI coding tool to fix the finding. Be specific about the files, ' +
  'the problem, and the exact steps to take. No preamble. No explanation of what you are doing. ' +
  'Just the prompt the developer will use.';

// One batch request per finding. detailById supplies the raw finding detail that
// the Ghost Brief adapter does not carry onto the adapted finding.
function buildPromptGenRequests(findings, commitSha, detailById = new Map()) {
  return findings.map((f, i) => {
    const files  = (f.files?.primary || []).join(', ') || 'none listed';
    const detail = detailById.get(f.source_finding_id) || 'No detail provided';
    const userMessage =
      `Finding: ${f.title || 'Untitled'}\n` +
      `Severity: ${f.severity || 'medium'}\n` +
      `Files: ${files}\n` +
      `Detail: ${detail}\n\n` +
      `Write a developer-ready remediation prompt for this finding.`;
    return {
      custom_id: sanitizeCustomId(`prompt-${commitSha}-${i}`),
      params: {
        model: getWatcherModel(),
        max_tokens: 4096,
        ...getSamplingParams(0, getWatcherModel()),
        system: PROMPT_GEN_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
      },
    };
  });
}

// Replace each finding's prompt with the matching batch result text, matched by
// the numeric index in the result custom_id. Only successful, non-empty results
// replace the templated prompt; anything else keeps its original prompt.
// @ghost-verified: exported for unit testing -- internal callers are the prompts-resume path and Step 8e detailed prompts
export function enrichFindingsWithPrompts(findings, results) {
  if (!Array.isArray(findings) || !Array.isArray(results)) return findings;
  const textByIndex = new Map();
  for (const r of results) {
    if (r?.type !== 'succeeded') continue;
    const text = (r.text || '').trim();
    if (!text) continue;
    const idx = parseInt(String(r.custom_id || '').split('-').pop(), 10);
    if (Number.isInteger(idx)) textByIndex.set(idx, text);
  }
  findings.forEach((f, i) => {
    const text = textByIndex.get(i);
    if (text) f.prompt = text;
  });
  return findings;
}

// ── Email (fire-and-forget) ────────────────────────────────────────────────────
//
// Ghost Watcher has no SMTP/transport in-process. Like pingWatcherRun in
// telemetry/pulse.js, lifecycle emails are POSTed fire-and-forget to the
// signup.ghostarchitect.dev worker, which owns the actual send. This never
// throws and never blocks the pipeline: on any error, missing recipients, or
// GHOST_NO_PING=1 it resolves silently. Until the worker /watcher-email route
// is live the POST simply no-ops on the server side.

const WATCHER_EMAIL_ENDPOINT = 'https://signup.ghostarchitect.dev/watcher-email';

function sendWatcherEmail(recipients, subject, html) {
  return new Promise((resolve) => {
    if (process.env.GHOST_NO_PING === '1') { resolve(); return; }

    const to = Array.isArray(recipients)
      ? recipients.filter(Boolean)
      : (recipients ? [recipients] : []);
    if (to.length === 0) { resolve(); return; }

    let body;
    try {
      body = JSON.stringify({ to, subject, html, from: 'support@ghostarchitect.dev' });
    } catch { resolve(); return; }

    let url;
    try { url = new URL(WATCHER_EMAIL_ENDPOINT); } catch { resolve(); return; }

    const req = https.request(
      {
        method:   'POST',
        hostname: url.hostname,
        path:     url.pathname,
        port:     443,
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Ghost-Client': 'ghost-architect-watcher',
        },
        timeout: 8000,
      },
      (res) => { res.on('data', () => {}); res.on('end', () => resolve()); }
    );
    req.on('error',   () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── Email templates ─────────────────────────────────────────────────────────────

function emailIncompleteRun({ repo, shortSha }) {
  return {
    subject: `Ghost Watcher™ -- Run incomplete on ${repo}`,
    html:
      `<h2 style="color:#00bfd8;">Ghost Watcher™ -- Run incomplete</h2>\n` +
      `<p>Your Ghost Watcher™ run on <strong>${escapeHtml(repo)}</strong> commit <code>${escapeHtml(shortSha)}</code> did not complete before the GitHub Actions job ended.</p>\n` +
      `<p>It is likely this happened because your GitHub account has reached its monthly Actions minutes limit. Free and Pro GitHub plans include 2,000–3,000 minutes per month. A full Ghost Watcher™ scan on a large codebase can take 15–30 minutes per run.</p>\n` +
      `<p><strong>The good news</strong> -- your scan is still processing on Anthropic's servers. Ghost Watcher™ will automatically retrieve and deliver your results on the next commit push. No action needed on your part.</p>\n` +
      `<p>To prevent this in the future:</p>\n` +
      `<ul>\n` +
      `  <li>Upgrade your GitHub plan for more Actions minutes</li>\n` +
      `  <li>Add <code>[ghost-skip]</code> to routine or low-priority commits to conserve minutes</li>\n` +
      `  <li>Configure Ghost Watcher™ to watch fewer branches via <code>ghost-watcher.yaml</code></li>\n` +
      `  <li>Increase <code>batch.poll_interval_seconds</code> in <code>ghost-watcher.yaml</code> to reduce Actions minutes used while polling</li>\n` +
      `</ul>\n` +
      `<p>Your results will be delivered automatically on the next push. No action required.</p>\n` +
      `<p style="color:#666;">-- Ghost Watcher™ · <a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
  };
}

function emailResumeDetected({ repo, shortSha, type }) {
  return {
    subject: `Ghost Watcher™ -- Resuming incomplete scan from commit ${shortSha}`,
    html:
      `<h2 style="color:#00bfd8;">Ghost Watcher™ -- Resuming your scan</h2>\n` +
      `<p>Ghost Watcher™ has detected an incomplete scan from a previous run.</p>\n` +
      `<p><strong>Repository:</strong> ${escapeHtml(repo)}<br>\n` +
      `<strong>Commit:</strong> <code>${escapeHtml(shortSha)}</code><br>\n` +
      `<strong>Scan type:</strong> ${type}</p>\n` +
      `<p>Your results are being retrieved now from Anthropic's servers. You will receive another email when the analysis is complete.</p>\n` +
      `<p style="color:#666;">-- Ghost Watcher™ · <a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
  };
}

function emailResumeComplete({ repo, shortSha, findingsCount, criticalCount, highCount, mediumCount, lowCount, portalSlug }) {
  return {
    subject: `Ghost Watcher™ -- Results ready for commit ${shortSha}`,
    html:
      `<h2 style="color:#00bfd8;">Ghost Watcher™ -- Results delivered</h2>\n` +
      `<p>Your incomplete Ghost Watcher™ scan has been successfully retrieved and delivered.</p>\n` +
      `<p><strong>Repository:</strong> ${escapeHtml(repo)}<br>\n` +
      `<strong>Commit:</strong> <code>${escapeHtml(shortSha)}</code><br>\n` +
      `<strong>Findings:</strong> ${findingsCount} total (${criticalCount} critical, ${highCount} high, ${mediumCount} medium, ${lowCount} low)</p>\n` +
      `<p>View your full results and Ghost Brief™ prompts in <a href="https://ghostarchitect.dev/portal-${escapeHtml(portalSlug)}.html">Ghost Portal</a>.</p>\n` +
      `<p style="color:#666;">-- Ghost Watcher™ · <a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
  };
}

function emailSetupWarning({ repo }) {
  return {
    subject: `Ghost Watcher™ -- Action required: GitHub Actions minutes insufficient`,
    html:
      `<h2 style="color:#ff5555;">Ghost Watcher™ -- Action required</h2>\n` +
      `<p>Ghost Watcher™ has attempted to scan <strong>${escapeHtml(repo)}</strong> three times but has not been able to complete a full scan due to GitHub Actions minute limits.</p>\n` +
      `<p>It is likely this happened because your GitHub account's free Actions minutes are insufficient for the size of your codebase. Ghost Watcher™ requires 15–30 minutes of Actions time per scan.</p>\n` +
      `<p><strong>To resolve this, choose one of the following:</strong></p>\n` +
      `<ol>\n` +
      `  <li><strong>Upgrade your GitHub plan</strong> -- Team and Enterprise plans include significantly more Actions minutes. <a href="https://github.com/pricing">View GitHub pricing</a></li>\n` +
      `  <li><strong>Increase the poll interval</strong> -- In your <code>ghost-watcher.yaml</code>, set <code>batch.poll_interval_seconds: 120</code>. This reduces Actions minutes used while waiting for results, at the cost of slightly delayed delivery.</li>\n` +
      `  <li><strong>Reduce scan frequency</strong> -- Add <code>[ghost-skip]</code> to commits that do not need analysis. Reserve Ghost Watcher™ for high-risk commits only.</li>\n` +
      `  <li><strong>Watch fewer branches</strong> -- Edit your <code>ghost-watcher.yaml</code> to remove low-priority branches from the trigger list.</li>\n` +
      `</ol>\n` +
      `<p>Ghost Watcher™ will continue attempting to deliver results automatically. Your pending scans are safe on Anthropic's servers.</p>\n` +
      `<p style="color:#666;">-- Ghost Watcher™ · <a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
  };
}

function emailDegradedRun({ repo, shortSha, portalSlug }) {
  const repoDisplay = escapeHtml(repo);
  const shaDisplay  = escapeHtml(shortSha);
  const portalUrl   = portalSlug
    ? `https://ghostarchitect.dev/portal-${escapeHtml(portalSlug)}.html#watch`
    : null;
  return {
    subject: `Ghost Watcher™ -- scan needs attention (${repoDisplay} @ ${shaDisplay})`,
    html:
      `<p>Ghost Watcher™ ran on <strong>${repoDisplay}</strong> at commit ` +
      `<code>${shaDisplay}</code> but encountered an issue generating the ` +
      `full analysis (the blast narrator timed out).</p>\n` +
      `<p>Your codebase was scanned successfully. To get the complete ` +
      `analysis, please re-run the workflow manually or push a new commit.</p>\n` +
      (portalUrl
        ? `<p><a href="${portalUrl}">View partial results in Ghost Portal →</a></p>\n`
        : '') +
      `<p style="color:#888;font-size:12px;">Ghost Watcher™ · ` +
      `<a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
  };
}

function emailCleanScan({ repo, shortSha, fileCount, portalSlug }) {
  return {
    subject: `Ghost Watcher™ -- Clean scan on ${repo} commit ${shortSha}`,
    html:
      `<h2 style="color:#00e5a8;">Ghost Watcher™ -- Clean scan</h2>\n` +
      `<p>Ghost Watcher™ scanned commit <code>${escapeHtml(shortSha)}</code> on <strong>${escapeHtml(repo)}</strong> and found no issues.</p>\n` +
      `<p>Your codebase is clean. No action required.</p>\n` +
      `<p><strong>Scan summary:</strong><br>\n` +
      `Files analyzed: ${fileCount}<br>\n` +
      `Blast Radius: 0 findings<br>\n` +
      `Conflict Detection: 0 findings</p>\n` +
      `<p>View your scan history in <a href="https://ghostarchitect.dev/portal-${escapeHtml(portalSlug)}.html">Ghost Portal</a>.</p>\n` +
      `<p style="color:#666;">-- Ghost Watcher™ · <a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
  };
}

function emailFindings({ repo, shortSha, findingsCount, criticalCount, highCount, mediumCount, lowCount, findings, portalSlug, verifiedCount = 0 }) {
  const findingsHtml = (findings || []).map(f =>
    `  <li style="margin-bottom:12px;">\n` +
    `    <strong style="color:#ff5555;">[${escapeHtml(f.severity)}]</strong> ${escapeHtml(f.title)}<br>\n` +
    `    <span style="color:#666;">Files: ${(f.files || []).map(escapeHtml).join(', ') || 'none'}</span><br>\n` +
    `    <span>${escapeHtml(f.detail || '')}</span>\n` +
    `  </li>`
  ).join('\n');

  // findingsCount is the ACTIVE (needs-attention) set. verifiedCount is the
  // @ghost-verified set pulled out as expected behavior. Surface the full
  // picture so a reader is not alarmed by the total without the context that
  // some were auto-verified.
  const attentionCount = findingsCount;
  const totalCount     = findingsCount + verifiedCount;

  return {
    subject: `Ghost Watcher™: ${totalCount} findings (${verifiedCount} verified, ${attentionCount} need attention) on ${repo} commit ${shortSha}`,
    html:
      `<h2 style="color:#ff5555;">Ghost Watcher™: ${totalCount} findings</h2>\n` +
      `<p>Ghost Watcher™ scanned commit <code>${escapeHtml(shortSha)}</code> on <strong>${escapeHtml(repo)}</strong> and found ${totalCount} issues. ${verifiedCount} were automatically verified as expected patterns. ${attentionCount} require your attention.</p>\n` +
      `<p><strong>Severity summary:</strong><br>\n` +
      `Critical: ${criticalCount} | High: ${highCount} | Medium: ${mediumCount} | Low: ${lowCount}</p>\n` +
      `<ul>\n${findingsHtml}\n</ul>\n` +
      `<p>View the full report in <a href="https://ghostarchitect.dev/portal-${escapeHtml(portalSlug)}.html">Ghost Portal</a>.</p>\n` +
      `<p style="color:#666;">-- Ghost Watcher™ · <a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
  };
}

// ── Incomplete-run handling (batch timed out before the job ended) ─────────────
//
// The batch is already persisted (storePendingBatch ran at submission), so the
// next push will resume it. Here we notify the customer (EMAIL 1) and track the
// consecutive-incomplete-run count; on the 3rd consecutive incomplete run with
// no successful scan, send the one-time setup-warning email (EMAIL 4) and flag
// it so it never re-sends.
async function handleIncompleteRun({ octokitPortal, portalRepoPath, emailRecipients, repo, shortSha }) {
  // EMAIL 1 — incomplete run
  try {
    const e1 = emailIncompleteRun({ repo, shortSha });
    await sendWatcherEmail(emailRecipients, e1.subject, e1.html);
  } catch (_) { /* email never blocks */ }

  const count = await incrementIncompleteRuns(octokitPortal, portalRepoPath);
  if (count === 3) {
    const state = await getPendingState(octokitPortal, portalRepoPath);
    if (!state.hasReceivedSetupWarning) {
      try {
        const e4 = emailSetupWarning({ repo });
        await sendWatcherEmail(emailRecipients, e4.subject, e4.html);
      } catch (_) { /* email never blocks */ }
      await markSetupWarningSent(octokitPortal, portalRepoPath);
    }
  }
}

// ── Portal pending/complete commit state (data layer) ──────────────────────────
//
// When a batch is in flight the customer should see "analyzing" rather than
// silence. We push a per-commit state file to the portal data repo keyed by
// commit hash; when real results arrive the same file is overwritten with the
// completed entry. The Ghost Portal Watch tab renders these state files as
// the commits/findings/prompts view.
//
// Path: projects/<repoSlug>/scans/watch/commits/<commitHash>.json

function repoSlugFor(repoPath) {
  return (repoPath || 'unknown-project').replace('/', '-').toLowerCase();
}

// Fetch the most recent completed commit state from the portal repo so the
// resolved-tracking delta can compare prior findings against the current scan.
// Returns the parsed state JSON or null if no prior completed run exists.
async function fetchPriorCommitState(octokit, portalOwner, portalRepoName, repoPath, currentCommitHash, currentBranch) {
  if (!octokit || !portalOwner || !portalRepoName) return null;
  try {
    const dirPath = `projects/${repoSlugFor(repoPath)}/scans/watch/commits`;
    const { data: entries } = await octokit.rest.repos.getContent({
      owner: portalOwner, repo: portalRepoName, path: dirPath,
    });
    if (!Array.isArray(entries) || entries.length === 0) return null;
    // Filter to .json state files only.
    const jsonFiles = entries.filter(e => e.name.endsWith('.json') && e.type === 'file');
    if (jsonFiles.length === 0) return null;
    // Fetch all candidate state files (cap at 20 to avoid exhausting API quota
    // on large repos) and sort by their embedded timestamp field descending so
    // we always diff against the genuinely most-recent completed run, not an
    // arbitrary SHA-alphabetical entry.
    const candidates = jsonFiles.slice(-20);
    const parsed = [];
    for (const file of candidates) {
      try {
        const { data: fileData } = await octokit.rest.repos.getContent({
          owner: portalOwner, repo: portalRepoName, path: file.path,
        });
        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        const state = JSON.parse(content);
        if (state.status === 'complete' && Array.isArray(state.findings)) {
          parsed.push(state);
        }
      } catch (_) {
        // Skip unreadable or unparseable files.
      }
    }
    if (parsed.length === 0) return null;
    // Sort by timestamp descending -- newest completed run first.
    parsed.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    // Return the newest completed run that is not the current commit
    // (the current commit's state file may already exist as a pending entry).
    return parsed.find(s => s.commitHash !== currentCommitHash && s.branch === currentBranch) || null;
  } catch (_) {
    // Directory listing failed (repo not set up, permissions, etc.) -- degrade
    // gracefully. Resolved tracking is best-effort and must never block a run.
    return null;
  }
}

async function pushWatchCommitState(octokit, portalOwner, portalRepoName, repoPath, commitHash, entry) {
  if (!octokit || !portalOwner || !portalRepoName || !commitHash) return;
  try {
    const filePath = `projects/${repoSlugFor(repoPath)}/scans/watch/commits/${commitHash}.json`;
    await upsertPortalFile(
      octokit, portalOwner, portalRepoName,
      filePath,
      JSON.stringify(entry, null, 2),
      `ghost: watch commit state ${commitHash.slice(0, 7)} (${entry.status})`,
    );
  } catch (err) {
    console.error(`Ghost Watcher: portal commit-state push failed (non-fatal) — ${err.message}`);
  }
}

/**
 * Entry point for `ghost --watcher-cancelled`. Fired by the GitHub Actions
 * cancel handler (if: cancelled()). Marks the commit's portal state 'cancelled'
 * so the customer sees a terminal state instead of a stuck "Analyzing…".
 * Never throws — a cancel handler must not fail the (already-cancelling) job.
 */
export async function runWatchCancelled() {
  const portalRepoUrl = process.env.GHOST_PORTAL_REPO;
  const portalToken   = process.env.GHOST_PORTAL_TOKEN;
  const commitHash    = process.env.GITHUB_SHA;
  if (!portalRepoUrl || !portalToken || !commitHash) {
    console.log('Ghost Watcher: run cancelled — no portal config or commit hash; nothing to update.');
    return;
  }
  try {
    const octokit = createOctokit({ auth: portalToken });
    const cleanPortal = portalRepoUrl.replace('https://github.com/', '').replace(/\.git$/, '');
    const [portalOwner, portalRepoName] = cleanPortal.split('/');
    const repoPath = process.env.GITHUB_REPOSITORY || 'unknown-project';
    await pushWatchCommitState(octokit, portalOwner, portalRepoName, repoPath, commitHash, {
      commitHash: process.env.GITHUB_SHA,
      branch: process.env.GITHUB_REF_NAME || 'unknown',
      developer: process.env.GITHUB_ACTOR || 'unknown',
      timestamp: new Date().toISOString(),
      status: 'cancelled',
      batchId: null,
      message: 'Ghost Watcher™ run was cancelled.',
      findings: [],
      findingCount: 0,
      severity: { critical: 0, high: 0, medium: 0, low: 0 },
    });
    console.log('Ghost Watcher: run cancelled — portal state updated');
  } catch (err) {
    console.error(`Ghost Watcher: cancel handler failed (non-fatal) — ${err.message}`);
  }
}

function buildSeverityCounts(findings) {
  return {
    critical: findings.filter(f => f.severity === 'CRITICAL').length,
    high:     findings.filter(f => f.severity === 'HIGH').length,
    medium:   findings.filter(f => f.severity === 'MEDIUM').length,
    low:      findings.filter(f => f.severity === 'LOW').length,
  };
}

// Sum input/output tokens across a pollBatch() result array. Any missing or
// malformed usage is treated as 0 so a result without usage never yields NaN.
export function sumBatchUsage(results) {
  let inputTokens = 0, outputTokens = 0;
  for (const r of (results || [])) {
    const u = r?.usage;
    inputTokens  += Number(u?.input_tokens)  || 0;
    outputTokens += Number(u?.output_tokens) || 0;
  }
  return { inputTokens, outputTokens };
}

// Build the tokenUsage payload. The watcher runs every scan through the
// Anthropic Message Batches API, which bills at BATCH_DISCOUNT (50%) of
// standard rates. Standard per-model rates come from getPricing() (the single
// pricing source of truth); the batch rate is standard * BATCH_DISCOUNT, the
// same relationship cost-estimator.js uses. Defaults to the watcher model
// from getWatcherModel() so cost reflects the actually-configured model.
// Cost rounded to 6 dp.
export function buildTokenUsage(inputTokens, outputTokens, model) {
  const pricing = getPricing(model || getWatcherModel());
  const batchInputRate  = pricing.inputPerM  * BATCH_DISCOUNT;
  const batchOutputRate = pricing.outputPerM * BATCH_DISCOUNT;
  const inCost  = (inputTokens  / 1_000_000) * batchInputRate;
  const outCost = (outputTokens / 1_000_000) * batchOutputRate;
  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd: Math.round((inCost + outCost) * 1e6) / 1e6,
  };
}

// ── Direct PR comment (resume + immediate "analyzing" notice) ──────────────────
//
// Posts a fresh comment to a specific PR number. Used for the immediate
// "Ghost is analyzing" notice on batch submission and for resume-completion
// updates, where the PR is the ORIGINAL commit's PR (not necessarily the current
// event). The success-path summary comment continues to flow through the
// unchanged postPRComment() below.
async function postCommentToPR(repoPath, prNumber, body) {
  const prToken = process.env.GHOST_PR_TOKEN || process.env.GITHUB_TOKEN;
  if (!prToken || !repoPath || !prNumber) return;
  try {
    const octokit = createOctokit({ auth: prToken });
    const [owner, repo] = repoPath.split('/');
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  } catch (err) {
    console.error(`Ghost Watcher: PR comment failed (non-fatal): ${err.message}`);
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Entry point for `ghost --watcher-commit`.
 * Orchestrates the full Watch pipeline. Always exits 0.
 */
export async function runWatchCommit({ tier = 'open', version = '9.0.0' } = {}) {
  const repoRoot = process.cwd();

  console.log(`\n👻 Ghost Watcher™ v${version} — Commit Analysis`);
  console.log(`   Running in: ${repoRoot}\n`);

  // ── Step 1: Read config ──────────────────────────────────────────────────
  let watchConfig;
  try {
    watchConfig = readWatchConfig(repoRoot);
  } catch (err) {
    console.error(`Ghost Watcher: config error — ${err.message}`);
    process.exit(0); // advisory only — never block
  }

  // ── Step 1b: ghost-skip tag check ───────────────────────────────────────
  // If the commit message contains [ghost-skip], exit immediately.
  // Developers use this to bypass Watch on doc-only or trivial commits.
  try {
    const { execSync } = await import('child_process');
    const commitMsg = execSync('git log -1 --format=%B', { cwd: repoRoot, encoding: 'utf8' }).trim();
    if (commitMsg.includes('[ghost-skip]')) {
      console.log('Ghost Watcher: [ghost-skip] detected in commit message — skipping scan.');
      console.log('👻 Ghost Watcher™ skipped.\n');
      process.exit(0);
    }
  } catch {
    // git log failed — not fatal, continue
  }

  // ── Step 1c: Iteration limit check ──────────────────────────────────────
  // Opt-in guard against Ghost Watcher running indefinitely on high-commit PRs.
  // The limit fires ONLY when iterations.max is explicitly set in
  // ghost-watcher.yaml. If iterations.max is absent (undefined/null), no limit
  // is applied and Watch runs on every push. Counts prior Watch runs for this
  // PR by checking GITHUB_RUN_NUMBER.
  const maxIterations = watchConfig.iterations?.max;
  const runNumber     = parseInt(process.env.GITHUB_RUN_NUMBER || '1', 10);
  if (shouldSkipForIterationLimit(watchConfig, runNumber)) {
    console.log(`Ghost Watcher: iteration limit reached (run ${runNumber} of ${maxIterations} max).`);
    console.log('   Open Ghost Portal to review findings from earlier runs.');
    console.log('👻 Ghost Watcher™ skipped — iteration limit.\n');
    process.exit(0);
  }

  // ── Step 2: Changed files ────────────────────────────────────────────────
  const changedFiles = getChangedFiles(repoRoot);
  if (changedFiles.length === 0) {
    console.log('Ghost Watcher: no changed files detected. Nothing to analyze.');
    process.exit(0);
  }
  console.log(`Ghost Watcher: ${changedFiles.length} changed file(s) detected`);
  changedFiles.forEach(f => console.log(`  · ${f}`));
  console.log('');

  // ── Step 3: Developer identity ───────────────────────────────────────────
  const developer = resolveDeveloperIdentity();
  const commitSha  = (process.env.GITHUB_SHA || 'local').slice(0, 7);
  const branch     = process.env.GITHUB_REF_NAME || process.env.GITHUB_HEAD_REF || 'unknown';
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  console.log(`Ghost Watcher: developer — ${developer.name} <${developer.email}>`);
  console.log(`Ghost Watcher: commit    — ${commitSha} on ${branch}\n`);

  // ── Profile resolution ───────────────────────────────────────────────────
  // Priority: GHOST_PROFILE env var (CI override) → ghost-watcher.yaml profile
  // field → configstore default profile slug → no profile.
  let profile = null;
  try {
    const profileEnv  = process.env.GHOST_PROFILE;
    const profileYaml = watchConfig.profile || null;
    const profileSlug = profileEnv || profileYaml || getDefaultProfileSlug();
    if (profileSlug) {
      profile = await loadProfile(profileSlug);
      console.log(`Ghost Watcher: profile — ${profile?.name || profile?.author || profileSlug}\n`);
    }
  } catch (err) {
    console.log(`Ghost Watcher: profile load failed (non-fatal) — ${err.message}\n`);
  }

  // ── Batch infrastructure setup ───────────────────────────────────────────
  // Ghost Watcher submits Blast Radius and Conflict Detection as Anthropic
  // batches (async server-side processing — no long-lived connection to drop).
  const commitHashFull = process.env.GITHUB_SHA || 'local';
  const repoPath  = process.env.GITHUB_REPOSITORY || 'unknown-project';
  const repoOwner = repoPath.includes('/') ? repoPath.split('/')[0] : 'unknown';
  const prRefMatch = (process.env.GITHUB_REF || '').match(/refs\/pull\/(\d+)\//);
  const prNumber = prRefMatch ? parseInt(prRefMatch[1], 10) : null;
  const emailRecipients = watchConfig.notifications?.email || [];

  // Configurable batch settings (ghost-watcher.yaml: batch.*), validated to range.
  let pollIntervalSeconds = watchConfig.batch?.poll_interval_seconds ?? 30;
  if (!(pollIntervalSeconds >= 10 && pollIntervalSeconds <= 300)) {
    console.warn(`Ghost Watcher: batch.poll_interval_seconds ${pollIntervalSeconds} out of range (10–300) — using default 30`);
    pollIntervalSeconds = 30;
  }
  let timeoutMinutes = watchConfig.batch?.timeout_minutes ?? 90;
  if (!(timeoutMinutes >= 30 && timeoutMinutes <= 360)) {
    console.warn(`Ghost Watcher: batch.timeout_minutes ${timeoutMinutes} out of range (30–360) — using default 90`);
    timeoutMinutes = 90;
  }
  const pollIntervalMs = pollIntervalSeconds * 1000;
  const timeoutMs      = timeoutMinutes * 60 * 1000;

  // Anthropic client for direct batch submission/polling.
  let anthropic = null;
  try {
    anthropic = new Anthropic({ apiKey: resolveApiKey() });
  } catch (err) {
    console.error(`Ghost Watcher: cannot initialize Anthropic client — ${err.message}`);
    process.exit(0);
  }

  // Portal repo handle for pending-batch persistence + pending/complete state.
  // Resolved the same way Step 9 resolves it; kept separate so Step 9 is untouched.
  const earlyPortalCfg = getPortalConfig();
  const earlyPortalRepoUrl = process.env.GHOST_PORTAL_REPO
    || watchConfig.portal?.repo
    || earlyPortalCfg?.repo
    || null;
  const earlyPortalToken = process.env.GHOST_PORTAL_TOKEN
    || (watchConfig.portal?.token_env ? process.env[watchConfig.portal.token_env] : null)
    || earlyPortalCfg?.token
    || null;

  let octokitPortal = null;
  let portalOwner = null;
  let portalRepoName = null;
  let portalRepoPath = null;
  let portalSlug = null;
  if (earlyPortalRepoUrl && earlyPortalToken) {
    try {
      octokitPortal = createOctokit({ auth: earlyPortalToken });
      const cleanPortal = earlyPortalRepoUrl.replace('https://github.com/', '').replace(/\.git$/, '');
      [portalOwner, portalRepoName] = cleanPortal.split('/');
      portalRepoPath = `${portalOwner}/${portalRepoName}`;
      portalSlug = (process.env.GHOST_PORTAL_SLUG || portalOwner).toLowerCase();
    } catch (err) {
      console.error(`Ghost Watcher: portal handle init failed (non-fatal) — ${err.message}`);
      octokitPortal = null;
    }
  }

  // ── Resume incomplete batches from prior runs ────────────────────────────
  // A prior run may have submitted a batch and then hit the GitHub Actions
  // wall-clock limit before it ended. The batch kept processing on Anthropic's
  // servers; pick it up now, deliver the results, and clear it.
  const resumedFindings = [];
  if (octokitPortal && portalRepoPath) {
    const pendingBatches = await retrievePendingBatches(octokitPortal, portalRepoPath);
    if (pendingBatches.length > 0) {
      for (const pending of pendingBatches) {
        console.log(`Ghost Watcher: resuming incomplete batch ${pending.batchId} (${pending.type}) from commit ${(pending.commitHash || '').slice(0, 7)}...`);

        // EMAIL 2 — resume detected
        try {
          const e2 = emailResumeDetected({
            repo: pending.repo || repoPath,
            shortSha: (pending.commitHash || '').slice(0, 7),
            type: pending.type,
          });
          await sendWatcherEmail(pending.emailRecipients?.length ? pending.emailRecipients : emailRecipients, e2.subject, e2.html);
        } catch (_) { /* email never blocks */ }

        // ── Detailed-prompts batch resume ────────────────────────────────────
        // No raw scan to re-parse: the results ARE the prompt texts. Enrich the
        // stored findings, regenerate the brief, and push it under the ORIGINAL
        // commit (the resume branch's own Step 9 equivalent).
        if (pending.type === 'prompts') {
          try {
            const shortSha = (pending.commitHash || '').slice(0, 7);
            const promptResults = await pollBatch(anthropic, pending.batchId, {
              pollIntervalMs: 10000, timeoutMs: 60000,
              onProgress: (p) => console.log(`Ghost Watcher: prompts resume check — ${p.status}`),
            });
            const promptUsage = sumBatchUsage(promptResults);

            const enriched = enrichFindingsWithPrompts(pending.findings || [], promptResults);

            let resumeBrief = null;
            try {
              const { generateBrief } = await import('../../lib/ghostBrief.js');
              resumeBrief = generateBrief({
                findings: enriched, ghostVersion: pending.version || version,
                scanFile: `watch-${shortSha}`, codebaseRoot: repoRoot,
                tier: pending.tier || tier, profile,
              });
            } catch (e) {
              console.error(`Ghost Watcher: prompts resume brief regen failed (non-fatal) — ${e.message}`);
            }
            const promptCount = resumeBrief?.prompts?.length || 0;

            // Push the enriched brief to the portal Brief tab under the original commit.
            if (resumeBrief && octokitPortal && portalOwner && portalRepoName
                && pending.projectSlug && pending.developerEmail) {
              try {
                const basePath = `projects/${pending.projectSlug}/scans/watch/${emailToSlug(pending.developerEmail)}`;
                await upsertPortalFile(
                  octokitPortal, portalOwner, portalRepoName,
                  `${basePath}/watch-brief-${shortSha}.json`,
                  JSON.stringify(resumeBrief, null, 2),
                  `watch-brief: ${shortSha} (detailed prompts)`,
                );
              } catch (e) {
                console.error(`Ghost Watcher: prompts resume brief push failed (non-fatal) — ${e.message}`);
              }
            }

            // Refresh commit-state prompt count, reusing the stored severity so
            // the Watch tab's counts are not clobbered.
            await pushWatchCommitState(octokitPortal, portalOwner, portalRepoName, pending.repo || repoPath, pending.commitHash, {
              commitHash: pending.commitHash, branch, developer: developer.name,
              timestamp: new Date().toISOString(), status: 'complete', batchId: null,
              message: 'Ghost Watcher™ detailed remediation prompts ready.',
              findings: [], findingCount: pending.findingCount ?? (pending.findings || []).length,
              severity: pending.severity || { critical: 0, high: 0, medium: 0, low: 0 },
              prompts: promptCount,
              tokenUsage: buildTokenUsage(promptUsage.inputTokens, promptUsage.outputTokens),
            });

            if (pending.prNumber) {
              const body =
                `## 👻 Ghost Watcher™ -- Detailed prompts ready\n\n` +
                `Detailed remediation prompts for commit \`${shortSha}\` are ready ` +
                `(${promptCount} prompt${promptCount === 1 ? '' : 's'}).\n\n` +
                (portalSlug ? `[Open Ghost Portal to copy prompts into your AI coding tool.](https://ghostarchitect.dev/portal-${portalSlug}.html)\n` : '');
              await postCommentToPR(pending.repo || repoPath, pending.prNumber, body);
            }

            console.log(`Ghost Watcher: resumed prompts batch ${pending.batchId} successfully`);
            await clearPendingBatch(octokitPortal, portalRepoPath, pending.batchId);
            await resetIncompleteRuns(octokitPortal, portalRepoPath);
          } catch (err) {
            if (err instanceof BatchTimeoutError) {
              console.log(`Ghost Watcher: prompts batch ${pending.batchId} still processing, will retry next run`);
            } else {
              console.log(`Ghost Watcher: prompts resume failed for batch ${pending.batchId} — ${err.message}`);
              await clearPendingBatch(octokitPortal, portalRepoPath, pending.batchId);
            }
          }
          continue;   // skip the blast/conflict extraction path below
        }

        try {
          const resumeResults = await pollBatch(anthropic, pending.batchId, {
            pollIntervalMs: 10000,
            timeoutMs: 60000,
            onProgress: (p) => console.log(`Ghost Watcher: resume check — ${p.status}`),
          });
          const resumeUsage = sumBatchUsage(resumeResults);

          // Extract findings from the resumed result by scan type.
          const rawText = resumeResults[0]?.text || '';
          let pendingFindings = [];
          if (pending.type === 'blast') {
            pendingFindings = extractFindings(rawText).map(f => ({ ...f, source_mode: 'blast' }));
          } else if (pending.type === 'conflict') {
            pendingFindings = extractCandidates([rawText]).map(normalizeCandidateToFinding).map(f => ({ ...f, source_mode: 'conflict' }));
          }
          resumedFindings.push(...pendingFindings);

          const sev = buildSeverityCounts(pendingFindings);

          // Push resumed results to Ghost Portal under the ORIGINAL commit hash.
          await pushWatchCommitState(octokitPortal, portalOwner, portalRepoName, pending.repo || repoPath, pending.commitHash, {
            commitHash: pending.commitHash,
            branch,
            developer: developer.name,
            timestamp: new Date().toISOString(),
            status: 'complete',
            batchId: pending.batchId,
            message: `Ghost Watcher™ ${pending.type} results retrieved.`,
            findings: pendingFindings,
            findingCount: pendingFindings.length,
            severity: sev,
            prompts: 0,
            tokenUsage: buildTokenUsage(resumeUsage.inputTokens, resumeUsage.outputTokens),
          });

          // Update the PR comment on the ORIGINAL PR with the real findings.
          if (pending.prNumber) {
            const summary = `${pendingFindings.length} finding${pendingFindings.length === 1 ? '' : 's'} (${sev.critical} critical, ${sev.high} high, ${sev.medium} medium, ${sev.low} low)`;
            const body =
              `## 👻 Ghost Watcher™ -- Results delivered\n\n` +
              `The batched ${pending.type} analysis for commit \`${(pending.commitHash || '').slice(0, 7)}\` has completed.\n\n` +
              `**Findings:** ${summary}\n\n` +
              (portalSlug ? `[Open Ghost Portal to copy prompts into your AI coding tool.](https://ghostarchitect.dev/portal-${portalSlug}.html)\n` : '');
            await postCommentToPR(pending.repo || repoPath, pending.prNumber, body);
          }

          // EMAIL 3 — resume complete
          try {
            const e3 = emailResumeComplete({
              repo: pending.repo || repoPath,
              shortSha: (pending.commitHash || '').slice(0, 7),
              findingsCount: pendingFindings.length,
              criticalCount: sev.critical, highCount: sev.high, mediumCount: sev.medium, lowCount: sev.low,
              portalSlug: pending.portalSlug || portalSlug || repoOwner,
            });
            await sendWatcherEmail(pending.emailRecipients?.length ? pending.emailRecipients : emailRecipients, e3.subject, e3.html);
          } catch (_) { /* email never blocks */ }

          console.log(`Ghost Watcher: resumed batch ${pending.batchId} successfully`);
          await clearPendingBatch(octokitPortal, portalRepoPath, pending.batchId);
          // A successful retrieval counts as a completed scan — reset the counter.
          await resetIncompleteRuns(octokitPortal, portalRepoPath);

        } catch (err) {
          if (err instanceof BatchTimeoutError) {
            console.log(`Ghost Watcher: batch ${pending.batchId} still processing, will retry next run`);
          } else {
            console.log(`Ghost Watcher: resume failed for batch ${pending.batchId} — ${err.message}`);
            await clearPendingBatch(octokitPortal, portalRepoPath, pending.batchId);
          }
        }
      }
    }
  }

  // ── Batches API preflight ────────────────────────────────────────────────
  // Submit a tiny 1-token batch to confirm the POST path (network + auth +
  // endpoint) works BEFORE we attempt to upload the full ~600KB codebase
  // context. This distinguishes a network/auth failure (tiny POST also fails →
  // nothing we can submit, exit cleanly) from a payload-size failure (tiny POST
  // succeeds but the full submit drops). Resume above already ran — it only
  // does GETs, so it is unaffected by a broken submit path.
  if ((watchConfig.scans?.blast_radius !== false && watchConfig.scans?.blast_radius?.enabled !== false) || watchConfig.scans?.conflict_detection !== false) {
    const preflight = await preflightBatchCheck(anthropic, getWatcherModel());
    if (!preflight.ok) {
      console.error(`Ghost Watcher: Batches API preflight failed — ${preflight.error}`);
      console.error('Ghost Watcher: the Anthropic Batches endpoint is unreachable from this runner ' +
        '(network or auth level — check the ANTHROPIC_API_KEY secret and runner egress). ' +
        'A tiny 1-token POST could not be submitted, so the full scan would fail too. Skipping submission.');
      console.log('👻 Ghost Watcher™ — could not reach the Batches API; nothing submitted. Exit: 0\n');
      process.exit(0);
    }
    console.log('Ghost Watcher: Batches API preflight OK — POST path reachable, proceeding.\n');
  }

  // ── Step 4: Load codebase ────────────────────────────────────────────────
  console.log('Ghost Watcher: loading codebase context...');

  // In CI, ignore any saved maxTokensContext value so the context cap falls back
  // to the full tier ceiling. A developer's local `ghost reconfigure` session can
  // persist a sub-tier value (e.g. 50K) into the configstore; clearing only the
  // override is not enough, because buildContext otherwise reads that saved value
  // (or the hardcoded default) directly. ignoreSavedContext routes resolution to
  // the full tier cap on the ephemeral runner. setScanOptions does a full
  // replace, not a merge: only `tier` falls back to the prior value, so every
  // other field (including ignoreSavedContext) resets to its default when
  // omitted. That is why tier + ignoreSavedContext are passed together in this
  // one call; splitting them across two top-level calls would reset the flag.
  // (loadFromPath's own internal setScanOptions spreads ...getScanOptions(), so
  // it preserves the flag rather than clobbering it.)
  if (process.env.CI) {
    setScanOptions({ tier, maxContextOverride: null, ignoreSavedContext: true });
    console.log('Ghost Watcher: CI detected — ignoring saved context override, using full tier cap.');
  } else {
    setScanOptions({ tier });
  }
  let codebaseContext;
  try {
    codebaseContext = await loadFromPath(repoRoot, { tier });
  } catch (err) {
    console.error(`Ghost Watcher: failed to load codebase — ${err.message}`);
    process.exit(0);
  }
  console.log(`Ghost Watcher: loaded ${codebaseContext.loadedFiles} files\n`);

  // ── Step 5: Blast Radius on changed files (Batches API) ──────────────────
  // Submit the same prompt runBlastRadius builds as an async batch, then poll.
  // No streaming connection to drop — this is the fix for "Premature close".
  let blastFindings  = [];
  let blastFileCount = 0;

  // Track whether each scan ACTUALLY ran to completion (submitted and returned
  // results). A submission failure or API outage is caught as "non-fatal" and
  // leaves findings empty — without this, Step 10 would render a false "safe to
  // merge" clean signal on every commit. Set true only on the success path.
  const scanRan = { blast: false, conflict: false };

  // Running token totals across every batch in this commit run (blast, conflict,
  // detailed prompts). Treated as 0 for any result that carries no usage.
  let totalInputTokens  = 0;
  let totalOutputTokens = 0;

  // Release commits (version bumps, changelog/badge updates) don't need a
  // Blast Radius pass. Skip it when the commit message matches a configured
  // pattern. Prefer a workflow-exported env var; fall back to git, mirroring
  // the [ghost-skip] check in Step 1b (GitHub Actions does not export the
  // commit message as an env var by default).
  let commitMessage = process.env.GITHUB_COMMIT_MESSAGE || process.env.COMMIT_MESSAGE || '';
  if (!commitMessage) {
    try {
      const { execSync } = await import('child_process');
      commitMessage = execSync('git log -1 --format=%B', { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch { /* git unavailable — leave empty, no skip */ }
  }
  const blastSkipPatterns = watchConfig.scans?.blast_radius?.skip_if_message_contains || [];
  const skipBlast = blastSkipPatterns.some(p => commitMessage.toLowerCase().includes(p.toLowerCase()));
  if (skipBlast) {
    console.log('Ghost Watcher: skipping Blast Radius — commit message matches a configured skip pattern.');
  }

  if (watchConfig.scans?.blast_radius !== false && watchConfig.scans?.blast_radius?.enabled !== false && !skipBlast) {
    console.log('Ghost Watcher: running Blast Radius (batch)...');
    let blastBatchId = null;
    try {
      const { systemPrompt, userMessage } = buildBlastPrompts(codebaseContext, changedFiles, profile);
      blastBatchId = await submitBatch(anthropic, [{
        custom_id: sanitizeCustomId(`blast-${commitSha}-${Date.now()}`),
        params: {
          model: getWatcherModel(),
          max_tokens: 8096,
          ...getSamplingParams(0, getWatcherModel()),
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
      }]);
    } catch (err) {
      console.error(`Ghost Watcher: Blast Radius submission failed (non-fatal) — ${err.message}`);
    }

    if (blastBatchId) {
      // Immediate PR comment so reviewers see Ghost is working right away.
      if (prNumber && watchConfig.notifications?.pr_comment !== false) {
        await postCommentToPR(repoPath, prNumber,
          `👻 **Ghost Watcher™** is analyzing this commit using the Anthropic Batches API.\n\n` +
          `Results will be posted here automatically when complete -- usually within 15 minutes.\n\n` +
          `_Batch ID: ${blastBatchId}_`);
      }

      // Persist the batch so a future run can resume it if this job is cut short.
      await storePendingBatch(octokitPortal, portalRepoPath, blastBatchId, {
        type: 'blast', commitHash: commitHashFull, repo: repoPath, repoOwner,
        timestamp: new Date().toISOString(), emailRecipients, prNumber, portalSlug,
        pollIntervalMs, timeoutMs,
      });

      // Push PENDING state to the portal so the customer sees "analyzing".
      await pushWatchCommitState(octokitPortal, portalOwner, portalRepoName, repoPath, commitHashFull, {
        commitHash: commitHashFull, branch, developer: developer.name,
        timestamp: new Date().toISOString(), status: 'pending', batchId: blastBatchId,
        message: 'Ghost Watcher™ is analyzing this commit. Results will appear here automatically.',
        findings: [], findingCount: 0,
        severity: { critical: 0, high: 0, medium: 0, low: 0 }, prompts: 0,
      });

      try {
        const blastResults = await pollBatch(anthropic, blastBatchId, {
          pollIntervalMs, timeoutMs,
          onProgress: (p) => console.log(`Ghost Watcher: Blast Radius — ${p.status} (${Math.round(p.elapsedMs / 1000)}s)`),
        });
        const rawBlastOutput = blastResults[0]?.text || '';
        // Narrate the raw batch output before parsing — see blastFindingsFromRaw.
        // This restores the per-finding `Files:` lines the Ghost Brief needs;
        // parsing the raw output directly leaves files empty and the Brief drops
        // every finding. blastFileCount is computed from the narrated findings.
        blastFindings  = await blastFindingsFromRaw(rawBlastOutput, { profile, changedFiles, codebaseContext });
        blastFileCount = blastFindings.reduce((acc, f) => acc + (f.files?.length || 0), 0);
        const blastUsage = sumBatchUsage(blastResults);
        totalInputTokens  += blastUsage.inputTokens;
        totalOutputTokens += blastUsage.outputTokens;
        console.log(`Ghost Watcher: Blast Radius tokens — in ${blastUsage.inputTokens}, out ${blastUsage.outputTokens}`);
        await clearPendingBatch(octokitPortal, portalRepoPath, blastBatchId);
        scanRan.blast = true;
        console.log(`Ghost Watcher: Blast Radius complete — ${blastFindings.length} findings\n`);
      } catch (err) {
        if (err instanceof BatchTimeoutError) {
          // Batch is already stored; the next push will resume it. Exit gracefully.
          try {
            await handleIncompleteRun({ octokitPortal, portalRepoPath, emailRecipients, repo: repoPath, shortSha: commitSha });
          } catch (notifyErr) {
            // Incomplete-run notification is best-effort -- must never throw or it breaks the always-exit-0 contract
            console.error(`Ghost Watcher: incomplete-run notification failed (non-fatal) -- ${notifyErr.message}`);
          }
          console.log('👻 Ghost Watcher™ — run incomplete; results will be delivered on the next push. Exit: 0\n');
          process.exit(0);
        } else if (err instanceof BatchAllFailedError) {
          console.error(`Ghost Watcher: Blast Radius batch all failed (non-fatal) — ${err.message}`);
          await clearPendingBatch(octokitPortal, portalRepoPath, blastBatchId);
        } else {
          console.error(`Ghost Watcher: Blast Radius failed (non-fatal) — ${err.message}`);
          await clearPendingBatch(octokitPortal, portalRepoPath, blastBatchId);
        }
      }
    }
  }

  // ── Step 6: Conflict Detection on changed files (Batches API) ────────────
  // Same conflict prompt builders runConflictScan uses, submitted as a single
  // async batch pass. Candidates are parsed with the unchanged extractCandidates.
  let conflictFindings = [];

  if (watchConfig.scans?.conflict_detection !== false) {
    console.log('Ghost Watcher: running Conflict Detection (batch)...');
    let conflictBatchId = null;
    let conflictBatchIds = [];
    try {
      const conflictRequests = buildConflictPrompts(codebaseContext.fileMap || {}, profile, commitSha);
      const totalChunks = conflictRequests.length;
      if (totalChunks > 1) {
        console.log(`Ghost Watcher: Conflict Detection split into ${totalChunks} chunks — submitting as separate batches`);
      }
      // Submit each chunk as a separate batch POST to stay under 1 MB per request.
      // Store the first batch ID in conflictBatchId for the storePendingBatch call;
      // all batch IDs are tracked in conflictBatchIds for polling and merging.
      conflictBatchIds = [];
      for (const request of conflictRequests) {
        const batchId = await submitBatch(anthropic, [request]);
        conflictBatchIds.push(batchId);
      }
      conflictBatchId = conflictBatchIds[0];
    } catch (err) {
      console.error(`Ghost Watcher: Conflict Detection submission failed (non-fatal) — ${err.message}`);
    }

    if (conflictBatchId) {
      await storePendingBatch(octokitPortal, portalRepoPath, conflictBatchId, {
        type: 'conflict', commitHash: commitHashFull, repo: repoPath, repoOwner,
        timestamp: new Date().toISOString(), emailRecipients, prNumber, portalSlug,
        pollIntervalMs, timeoutMs,
      });

      try {
        // Poll all conflict chunk batches and merge their results.
        const allConflictResults = [];
        for (let i = 0; i < conflictBatchIds.length; i++) {
          const chunkId = conflictBatchIds[i];
          const label = conflictBatchIds.length > 1
            ? `Conflict Detection chunk ${i + 1}/${conflictBatchIds.length}`
            : 'Conflict Detection';
          const chunkResults = await pollBatch(anthropic, chunkId, {
            pollIntervalMs, timeoutMs,
            onProgress: (p) => console.log(`Ghost Watcher: ${label} — ${p.status} (${Math.round(p.elapsedMs / 1000)}s)`),
          });
          allConflictResults.push(...chunkResults);
        }
        const conflictResults = allConflictResults;
        // Collect output from all chunks — extractCandidates accepts an array
        // and joins them, so conflicts from every chunk are parsed and merged.
        const conflictOutputs = conflictResults.map(r => r.text || '');
        let conflictCandidates = extractCandidates(conflictOutputs);

        // Optional verifier pass (opt-in via scans.conflict_verify). Runs the
        // same agent verifier the interactive Conflict mode uses, in 'quick'
        // mode (single-call per candidate, headless-safe). Keep CONFIRMED +
        // POSSIBLE; drop FALSE_POSITIVE + INSUFFICIENT.
        if (watchConfig.scans?.conflict_verify === true && conflictCandidates.length > 0) {
          console.log(`Ghost Watcher: verifying ${conflictCandidates.length} conflict candidates...`);
          const vr = await verifyConflicts(conflictCandidates, codebaseContext.fileMap || {}, {}, 'quick', tier);
          conflictCandidates = [...vr.confirmed, ...vr.possible];
          console.log(`Ghost Watcher: ${vr.stats.eliminated} low-signal findings filtered, ${conflictCandidates.length} kept\n`);
        }

        // Drop self-refuting conflict findings: if the model flagged a conflict
        // and then said "no actual conflict" / "no runtime conflict" / "consistent"
        // in its own detail text, the finding is noise. Remove before surfacing.
        // The `values match` clause carries a negative lookahead so it only
        // fires for a bare self-refutation ("values match") and NOT for a real
        // finding that hedges ("values match in current impl but will conflict
        // if X changes") — the trailing `conflict` assertion keeps it.
        const SELF_REFUTING_RE = /no\s+(actual|real|runtime)\s+conflict|not\s+a\s+(\w+\s+){0,3}conflict|rather\s+than\s+a\s+(real|runtime)\s+conflict|no\s+issue|runtime\s+impact:\s*none|no\s+concrete\s+(runtime\s+)?(conflict|failure|impact)|no\s+active\s+\S+(\s+\S+){0,4}\s+(call\s+)?path|no\s+\S+(\s+\S+){0,3}\s+failure\s+path|(?<!in)consistent\b|values\s+match(?![^.]*\bconflict)|intentionally\s+different|not\s+a\s+runtime\s+failure|performance\s+issue[,\s]+not\s+a\s+correctness/i;
        conflictFindings = conflictCandidates
          .filter(c => !SELF_REFUTING_RE.test(c.description || ''))
          .map(normalizeCandidateToFinding);
        const conflictUsage = sumBatchUsage(conflictResults);
        totalInputTokens  += conflictUsage.inputTokens;
        totalOutputTokens += conflictUsage.outputTokens;
        await clearPendingBatch(octokitPortal, portalRepoPath, conflictBatchId);
        scanRan.conflict = true;
        console.log(`Ghost Watcher: Conflict Detection complete — ${conflictFindings.length} findings\n`);
      } catch (err) {
        if (err instanceof BatchTimeoutError) {
          try {
            await handleIncompleteRun({ octokitPortal, portalRepoPath, emailRecipients, repo: repoPath, shortSha: commitSha });
          } catch (notifyErr) {
            // Incomplete-run notification is best-effort -- must never throw or it breaks the always-exit-0 contract
            console.error(`Ghost Watcher: incomplete-run notification failed (non-fatal) -- ${notifyErr.message}`);
          }
          console.log('👻 Ghost Watcher™ — run incomplete; results will be delivered on the next push. Exit: 0\n');
          process.exit(0);
        } else if (err instanceof BatchAllFailedError) {
          console.error(`Ghost Watcher: Conflict Detection batch all failed (non-fatal) — ${err.message}`);
          await clearPendingBatch(octokitPortal, portalRepoPath, conflictBatchId);
        } else {
          console.error(`Ghost Watcher: Conflict Detection failed (non-fatal) — ${err.message}`);
          await clearPendingBatch(octokitPortal, portalRepoPath, conflictBatchId);
        }
      }
    }
  }

  // ── Step 7: Merge findings ───────────────────────────────────────────────
  const mergedFindings = [
    ...blastFindings.map(f => ({ ...f, source_mode: 'blast' })),
    ...conflictFindings.map(f => ({ ...f, source_mode: 'conflict' })),
  ];

  // The @ghost-verified segregation (file-level). Findings whose files carry
  // the marker are pulled out of the active set so they stop
  // nagging on every commit, but are retained in verifiedFindings for the
  // auditable "Reviewed · Expected Behavior" surface (PR comment + scan file).
  // allFindings becomes the ACTIVE set so every downstream consumer (brief,
  // detailed prompts, portal, PR comment, telemetry) uses it unchanged.
  // See src/watch/ghost-verified.js.
  const { active: allFindings, verified: verifiedFindings } =
    partitionFindings(mergedFindings, codebaseContext.fileMap);

  console.log(`Ghost Watcher: ${mergedFindings.length} total findings (blast: ${blastFindings.length}, conflict: ${conflictFindings.length})\n`);
  if (verifiedFindings.length > 0) {
    console.log(`Ghost Watcher: ${verifiedFindings.length} finding(s) marked @ghost-verified (reviewed · expected behavior)\n`);
  }

  // Hoisted so the Step 8c email gate can branch on it. The blast narrator sets
  // _narratorFailed on the raw findings when it times out; partitionFindings
  // returns a fresh `allFindings` array that may not carry the flag, so we OR
  // against blastFindings too (mirrors the portal manifest flag below).
  const narratorFailed = !!(allFindings._narratorFailed || blastFindings._narratorFailed);

  // ── Failed-scan guard ─────────────────────────────────────────────────────
  // An empty allFindings set is only a genuine "clean" result if at least one
  // scan ran AND no scan that was expected to run failed. Otherwise a config
  // typo or API outage would render a permanent false-green "safe to merge" on
  // every commit. "Expected" = enabled (and, for blast, not release-skipped).
  const blastExpected    = watchConfig.scans?.blast_radius !== false && watchConfig.scans?.blast_radius?.enabled !== false && !skipBlast;
  const conflictExpected = watchConfig.scans?.conflict_detection !== false;
  const incompleteScans  = [];
  if (blastExpected    && !scanRan.blast)    incompleteScans.push('Blast Radius');
  if (conflictExpected && !scanRan.conflict) incompleteScans.push('Conflict Detection');
  const anyScanRan = scanRan.blast || scanRan.conflict;
  // A run only produces trustworthy portal state when at least one scan ran AND
  // no expected scan failed. Anything short of that means `allFindings` may be
  // empty for reasons other than a clean codebase, so we must NOT write a
  // completed/clean state or run the resolved-tracking delta off it.
  const runComplete = anyScanRan && incompleteScans.length === 0;

  // ── Step 8: Ghost Brief (Max-tier gated) ─────────────────────────────────
  // Ghost Brief is a Max-tier artifact (pro-max / team-max / enterprise-max).
  // requireTier('mode:ghost-brief') is the single source of truth. Non-Max
  // tiers skip both the basic brief AND Step 8e: Step 8e's only output is the
  // regenerated brief, and its guard already requires a non-null `brief`, so a
  // skipped Step 8 leaves `brief` null and Step 8e never runs.
  let brief           = null;
  let briefPromptCount = 0;
  let adaptedFindings  = [];   // hoisted so Step 8e can enrich and regenerate

  const briefTierAllowed = requireTier('mode:ghost-brief', { tier }).allowed;
  const briefRequested   = watchConfig.scans?.ghost_brief !== false && allFindings.length > 0;

  if (briefRequested && !briefTierAllowed) {
    console.log('Ghost Watcher: Ghost Brief™ requires Max tier -- skipping brief generation.');
  }

  if (briefRequested && briefTierAllowed) {
    try {
      const { generateBrief, writeBrief } = await import('../../lib/ghostBrief.js');

      // Adapt raw findings into Ghost Brief prompt shape via the adapter.
      // Blast findings use fromPOI (same shape); conflict findings use fromConflict.
      // Build from allFindings (the ACTIVE set), not the raw blast/conflict
      // arrays — those still contain @ghost-verified findings, which must not
      // get Ghost Brief prompts generated for them. allFindings carries
      // source_mode tags from the merge, so split it back by source here.
      adaptedFindings = [
        ...fromPOI(allFindings.filter(f => f.source_mode === 'blast')),
        ...fromConflict(allFindings.filter(f => f.source_mode === 'conflict')),
      ].filter(f => f.files?.primary?.length > 0);

      brief = generateBrief({
        findings:      adaptedFindings,
        ghostVersion:  version,
        scanFile:      `watch-${commitSha}`,
        codebaseRoot:  repoRoot,
        tier,
        profile,
      });
      briefPromptCount = brief?.prompts?.length || 0;
      console.log(`Ghost Watcher: Ghost Brief generated — ${briefPromptCount} prompts\n`);
    } catch (err) {
      console.error(`Ghost Watcher: Ghost Brief failed (non-fatal) — ${err.message}`);
    }
  }

  // ── Step 8b: overwrite pending portal state with completed results ───────
  // The blast submit pushed a 'pending' commit-state entry; replace it with the
  // completed findings so the portal shows results instead of "analyzing". This
  // is the portal DATA layer only and is independent of Step 9's report push.
  //
  // GATED ON runComplete. If a scan submission threw (caught non-fatal above,
  // batch IDs left null), `allFindings` is [] for a failure reason, not because
  // the codebase is clean. Writing 'complete'/findings:[] here would render a
  // false green on the portal AND the resolved-tracking delta below would mark
  // every prior open finding as resolvedInCommit:<thisSha>. Never do either off
  // an empty result set — the else-branch writes an explicit 'incomplete' state.
  if (runComplete && octokitPortal && portalOwner && portalRepoName) {
    const sevAll = buildSeverityCounts(allFindings);

    // Finding lifecycle delta -- compare current findings against the most
    // recent completed run to classify each finding as new or carried-over,
    // and identify findings from the prior run that no longer appear (resolved).
    // Best-effort: if the prior state fetch fails, we degrade to no lifecycle
    // data rather than blocking the state write.
    let resolvedFindings = [];
    let newFindingIds = [];
    let priorCommitHash = null;
    try {
      const prior = await fetchPriorCommitState(octokitPortal, portalOwner, portalRepoName, repoPath, commitHashFull, branch);
      if (prior && Array.isArray(prior.findings) && prior.findings.length > 0) {
        priorCommitHash = prior.commitHash || null;
        const priorFindings = prior.findings;

        // Classify each current finding as new (no match in prior) or carried.
        for (const curr of allFindings) {
          const matched = priorFindings.some(p => similarFinding(curr, p));
          if (!matched) newFindingIds.push(curr.id);
        }

        // Classify each prior finding with no current match as resolved.
        for (const prev of priorFindings) {
          const stillActive = allFindings.some(c => similarFinding(prev, c));
          if (!stillActive) {
            resolvedFindings.push({
              id:               prev.id,
              title:            prev.title,
              severity:         prev.severity,
              files:            prev.files || [],
              resolvedInCommit: commitHashFull,
              resolvedAt:       new Date().toISOString(),
            });
          }
        }
      }
    } catch (_) {
      // Delta computation failed -- degrade gracefully, lifecycle fields stay empty.
    }

    await pushWatchCommitState(octokitPortal, portalOwner, portalRepoName, repoPath, commitHashFull, {
      commitHash: commitHashFull, branch, developer: developer.name,
      timestamp: new Date().toISOString(), status: 'complete', batchId: null,
      message: 'Ghost Watcher™ analysis complete.',
      findings: allFindings, findingCount: allFindings.length,
      severity: sevAll, prompts: briefPromptCount,
      tokenUsage: buildTokenUsage(totalInputTokens, totalOutputTokens),
      verifiedFindings, verifiedFindingCount: verifiedFindings.length,
      resolvedFindings, newFindingIds, priorCommitHash,
    });
  } else if (octokitPortal && portalOwner && portalRepoName) {
    // A scan that was expected to run did not complete (submission threw, API
    // outage, etc.). Write a NON-clean 'incomplete' state so the portal shows
    // the truth instead of a false green. Critically: findingCount 0 with EMPTY
    // resolvedFindings/newFindingIds — we never mark real open findings resolved
    // off a result set that is empty only because the scan failed.
    const failed = incompleteScans.length > 0
      ? `${incompleteScans.join(', ')} did not complete`
      : 'no scan completed';
    await pushWatchCommitState(octokitPortal, portalOwner, portalRepoName, repoPath, commitHashFull, {
      commitHash: commitHashFull, branch, developer: developer.name,
      timestamp: new Date().toISOString(), status: 'incomplete', batchId: null,
      message: `Ghost Watcher™ run incomplete: ${failed}. Prior findings left unchanged.`,
      findings: [], findingCount: 0,
      severity: { critical: 0, high: 0, medium: 0, low: 0 }, prompts: 0,
      tokenUsage: buildTokenUsage(totalInputTokens, totalOutputTokens),
      resolvedFindings: [], newFindingIds: [], priorCommitHash: null,
    });
  }
  // Only a genuinely complete run resets the consecutive-incomplete-run counter.
  // An incomplete run must leave it intact so the 3-strikes setup warning
  // (handleIncompleteRun) still fires after repeated silent failures.
  if (runComplete) {
    await resetIncompleteRuns(octokitPortal, portalRepoPath);
  }

  // ── Step 8c: Findings, degraded-run, or clean-scan email ──────────────────
  // Fire-and-forget; never blocks the portal push that follows.
  if (emailRecipients.length > 0) {
    try {
      if (narratorFailed) {
        // Blast narrator timed out — send a simple degraded-run notice instead
        // of raw unnarrated findings, which would be confusing to customers.
        const eDegraded = emailDegradedRun({
          repo:       repoPath,
          shortSha:   commitSha,
          portalSlug: portalSlug || repoOwner,
        });
        await sendWatcherEmail(emailRecipients, eDegraded.subject, eDegraded.html);
      } else if (allFindings.length > 0) {
        // One or more findings — email a summary with per-finding detail.
        const sev = buildSeverityCounts(allFindings);
        const eFindings = emailFindings({
          repo:          repoPath,
          shortSha:      commitSha,
          findingsCount: allFindings.length,
          verifiedCount: verifiedFindings.length,
          criticalCount: sev.critical,
          highCount:     sev.high,
          mediumCount:   sev.medium,
          lowCount:      sev.low,
          findings:      allFindings,
          portalSlug:    portalSlug || repoOwner,
        });
        await sendWatcherEmail(emailRecipients, eFindings.subject, eFindings.html);
      } else if (anyScanRan && incompleteScans.length === 0) {
        // ── Step 8d: Clean scan email ─────────────────────────────────────
        // Zero findings AND every expected scan completed — genuinely clean.
        const eClean = emailCleanScan({
          repo:       repoPath,
          shortSha:   commitSha,
          fileCount:  codebaseContext.loadedFiles || 0,
          portalSlug: portalSlug || repoOwner,
        });
        await sendWatcherEmail(emailRecipients, eClean.subject, eClean.html);
      } else {
        // No scan completed, or an expected scan did not. Do NOT send a clean
        // email — a failed scan must never produce a false "clean" signal.
        console.error(`Ghost Watcher: suppressing clean-scan email (${anyScanRan ? 'incomplete: ' + incompleteScans.join(', ') : 'no scan completed'}).`);
      }
    } catch (_) { /* email never blocks */ }
  }

  // ── Step 8e: Detailed remediation prompts (Batches API) ───────────────────
  // For every finding, generate an LLM-authored, developer-ready remediation
  // prompt via one batch (one request per finding). The returned text replaces
  // the templated prompt on each brief entry, then the brief is regenerated so
  // brief.prompts carries the detailed prompts. On timeout the batch is stored
  // and the next push resumes it; the basic brief still ships now via Step 9.
  if (watchConfig.scans?.detailed_prompts !== false && brief && adaptedFindings.length > 0) {
    console.log('Ghost Watcher: generating detailed remediation prompts (batch)...');

    // Detail lives on the findings; map id to detail so each request can
    // include the finding detail the Ghost Brief adapter dropped. Use
    // allFindings (active set) so we never carry detail for @ghost-verified
    // findings, which aren't in adaptedFindings anyway.
    const detailById = new Map(
      allFindings
        .filter(f => f && f.id)
        .map(f => [f.id, f.detail || ''])
    );

    let promptBatchId = null;
    try {
      const requests = buildPromptGenRequests(adaptedFindings, commitSha, detailById);
      promptBatchId = await submitBatch(anthropic, requests);
    } catch (err) {
      console.error(`Ghost Watcher: detailed prompt submission failed (non-fatal) — ${err.message}`);
    }

    if (promptBatchId) {
      await storePendingBatch(octokitPortal, portalRepoPath, promptBatchId, {
        type: 'prompts', commitHash: commitHashFull, repo: repoPath, repoOwner,
        timestamp: new Date().toISOString(), emailRecipients, prNumber, portalSlug,
        pollIntervalMs, timeoutMs,
        findings:       adaptedFindings,
        severity:       buildSeverityCounts(allFindings),
        findingCount:   allFindings.length,
        developerEmail: developer.email,
        projectSlug:    (process.env.GITHUB_REPOSITORY || 'unknown-project').replace('/', '-').toLowerCase(),
        version, tier,
      });

      try {
        const promptResults = await pollBatch(anthropic, promptBatchId, {
          pollIntervalMs, timeoutMs,
          onProgress: (p) => console.log(`Ghost Watcher: detailed prompts — ${p.status} (${Math.round(p.elapsedMs / 1000)}s)`),
        });
        const promptUsage = sumBatchUsage(promptResults);
        totalInputTokens  += promptUsage.inputTokens;
        totalOutputTokens += promptUsage.outputTokens;

        enrichFindingsWithPrompts(adaptedFindings, promptResults);

        try {
          const { generateBrief } = await import('../../lib/ghostBrief.js');
          brief = generateBrief({
            findings: adaptedFindings, ghostVersion: version,
            scanFile: `watch-${commitSha}`, codebaseRoot: repoRoot, tier, profile,
          });
          briefPromptCount = brief?.prompts?.length || 0;
        } catch (e) {
          console.error(`Ghost Watcher: brief regeneration after prompts failed (non-fatal) — ${e.message}`);
        }

        await clearPendingBatch(octokitPortal, portalRepoPath, promptBatchId);
        console.log(`Ghost Watcher: detailed prompts complete — ${briefPromptCount} prompts enriched\n`);
      } catch (err) {
        if (err instanceof BatchTimeoutError) {
          // Batch is stored; the next push resumes it and overwrites the brief
          // with the detailed prompts. Deliver the basic brief now via Step 9.
          console.log('Ghost Watcher: detailed prompts still processing; basic brief ships now, detailed prompts follow on the next push.\n');
        } else if (err instanceof BatchAllFailedError) {
          console.error(`Ghost Watcher: detailed prompts batch all failed (non-fatal) — ${err.message}`);
          await clearPendingBatch(octokitPortal, portalRepoPath, promptBatchId);
        } else {
          console.error(`Ghost Watcher: detailed prompts failed (non-fatal) — ${err.message}`);
          await clearPendingBatch(octokitPortal, portalRepoPath, promptBatchId);
        }
      }
    }
  }

  // ── Step 9: Push to portal repo ──────────────────────────────────────────
  // Resolve portal credentials: env vars take priority (CI/GitHub Actions),
  // then ghost-watcher.yaml, then the local Ghost configstore (developer machines).
  const localPortalCfg = getPortalConfig();
  const portalRepoUrl  = process.env.GHOST_PORTAL_REPO
    || watchConfig.portal?.repo
    || localPortalCfg?.repo
    || null;
  const portalToken    = process.env.GHOST_PORTAL_TOKEN
    || (watchConfig.portal?.token_env ? process.env[watchConfig.portal.token_env] : null)
    || localPortalCfg?.token
    || null;

  let portalUrl = null;

  if (portalRepoUrl && portalToken) {
    try {
      const octokit = createOctokit({ auth: portalToken });
      const clean   = portalRepoUrl.replace('https://github.com/', '').replace(/\.git$/, '');
      const [portalOwner, portalRepo] = clean.split('/');

      const devSlug     = emailToSlug(developer.email);
      const projectSlug = (process.env.GITHUB_REPOSITORY || 'unknown-project')
        .replace('/', '-').toLowerCase();
      const baseFileName = `watch-${commitSha}-${timestamp}`;
      const basePath     = `projects/${projectSlug}/scans/watch/${devSlug}`;

      // Split the same way the PR comment does: action-required findings drive
      // findingCount / severityCounts and stay in `findings`; Blast Radius impact
      // observations move to their own `blastRadiusObservations` bucket so the
      // portal can render "exposed" separately from "broken" and the finding
      // count reflects real defects, not blast noise.
      const portalActionFindings   = allFindings.filter(f => f.source_mode !== 'blast');
      const portalBlastObservations = allFindings.filter(f => f.source_mode === 'blast');

      // Build the Watch result payload
      const watchResult = {
        schema:      '1.0',
        generatedAt: new Date().toISOString(),
        commit:      process.env.GITHUB_SHA || 'local',
        commitShort: commitSha,
        branch,
        developer,
        projectSlug,
        findingCount: portalActionFindings.length,
        severityCounts: {
          critical: portalActionFindings.filter(f => f.severity === 'CRITICAL').length,
          high:     portalActionFindings.filter(f => f.severity === 'HIGH').length,
          medium:   portalActionFindings.filter(f => f.severity === 'MEDIUM').length,
          low:      portalActionFindings.filter(f => f.severity === 'LOW').length,
        },
        blastFileCount,
        briefPromptCount,
        narratorFailed,
        // Match the PR-comment truth (Step 10 passes scanFailed:!anyScanRan):
        // the sidecar must carry the same scan-failure signal so any consumer
        // reading watch-<sha>.json sees an incomplete run, not a clean one.
        scanFailed:  !anyScanRan,
        incompleteScans,
        findings:    portalActionFindings,
        blastRadiusObservations: portalBlastObservations,
        verifiedFindings,
        brief:       brief || null,
        tokenUsage:  buildTokenUsage(totalInputTokens, totalOutputTokens),
      };

      // Push findings JSON
      await upsertPortalFile(
        octokit, portalOwner, portalRepo,
        `${basePath}/${baseFileName}.json`,
        JSON.stringify(watchResult, null, 2),
        `watch: ${commitSha} — ${developer.email}`
      );
      console.log(`Ghost Watcher: results pushed to portal repo\n`);

      // Push Ghost Brief JSON separately for portal Brief tab
      if (brief) {
        await upsertPortalFile(
          octokit, portalOwner, portalRepo,
          `${basePath}/watch-brief-${commitSha}.json`,
          JSON.stringify(brief, null, 2),
          `watch-brief: ${commitSha}`
        );
      }

      // Build portal URL for PR comment
      const portalSlug = (process.env.GHOST_PORTAL_SLUG || portalOwner).toLowerCase();
      portalUrl = `https://ghostarchitect.dev/portal-${portalSlug}.html`;

    } catch (err) {
      console.error(`Ghost Watcher: portal push failed (non-fatal) — ${err.message}`);
    }
  } else {
    console.log('Ghost Watcher: GHOST_PORTAL_REPO or GHOST_PORTAL_TOKEN not set — skipping portal push\n');
  }

  // ── Step 10: PR comment ───────────────────────────────────────────────────
  if (watchConfig.notifications?.pr_comment !== false) {
    await postPRComment({ findings: allFindings, verifiedFindings, blastFileCount, briefPromptCount, portalUrl, clean: allFindings.length === 0 && anyScanRan, scanFailed: !anyScanRan, incompleteScans });
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log(`👻 Ghost Watcher™ complete.`);
  console.log(`   Findings: ${allFindings.length} | Brief prompts: ${briefPromptCount} | Exit: 0\n`);

  // ── Telemetry ping ────────────────────────────────────────────────────────
  // pingWatcherRun hashes commit SHA and repo name internally (see pulse.js);
  // never write raw identifiers to disk for a CI step to forward.
  try {
    await pingWatcherRun(version, tier, {
      findings:  allFindings.length,
      severity: {
        critical: allFindings.filter(f => f.severity === 'CRITICAL').length,
        high:     allFindings.filter(f => f.severity === 'HIGH').length,
        medium:   allFindings.filter(f => f.severity === 'MEDIUM').length,
        low:      allFindings.filter(f => f.severity === 'LOW').length,
      },
      prompts:   briefPromptCount,
      scans: {
        blast:    watchConfig.scans?.blast_radius !== false && watchConfig.scans?.blast_radius?.enabled !== false,
        conflict: watchConfig.scans?.conflict_detection !== false,
        brief:    watchConfig.scans?.ghost_brief     !== false,
      },
      commit: process.env.GITHUB_SHA || '',
      repo:   process.env.GITHUB_REPOSITORY || '',
    });
  } catch (_) { /* telemetry never blocks */ }

  // Always exit 0 — Ghost Watcher never blocks a commit
  process.exit(0);
}
