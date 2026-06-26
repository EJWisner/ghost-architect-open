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
import { extractFindings } from '../utils/finding-parser.js';
import { normalizeCandidateToFinding, extractCandidates } from '../core/conflict.js';
import { narrateReport } from '../core/agent/narrator.js';
import { fromPOI, fromConflict } from '../../lib/ghostBriefAdapter.js';
import { pingWatcherRun } from '../telemetry/pulse.js';
import { buildSystemBlast } from '../../prompts/index.js';
import { buildSystemConflict, buildConflictPrompt } from '../../prompts/conflict.js';
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
async function upsertPortalFile(octokit, owner, repo, filePath, content, message) {
  // Get existing sha for conditional update
  let sha = null;
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    sha = data.sha;
  } catch { /* file does not exist yet — create it */ }

  const encoded = Buffer.isBuffer(content)
    ? content.toString('base64')
    : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2)).toString('base64');

  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo,
    path: filePath,
    message,
    content: encoded,
    ...(sha ? { sha } : {}),
  });
}

// ── PR comment ────────────────────────────────────────────────────────────────

/**
 * Post a Ghost Watcher summary comment on the PR that triggered this run.
 * Uses GITHUB_TOKEN (provided automatically by GitHub Actions).
 * No-ops gracefully if PR context is not available.
 */
async function postPRComment({ findings, blastFileCount, briefPromptCount, portalUrl, clean = false }) {
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

  // Zero findings — post clean green comment and return
  if (clean) {
    try {
      const octokit = createOctokit({ auth: prToken });
      const [owner, repo] = repository.split('/');
      const prNumber = parseInt(prMatch[1], 10);
      const shortSha = sha.slice(0, 7);
      const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const body = [
        `## 👻 Ghost Watcher™ — Commit Analysis`,
        ``,
        `**Branch:** \`${refName}\``,
        `**Commit:** \`${shortSha}\` · ${actor} · ${date}`,
        ``,
        `✅ **No findings detected.**`,
        ``,
        `Blast Radius: no affected files outside the changed set`,
        `Conflict Detection: no conflicts found`,
        `Ghost Brief: not needed`,
        ``,
        `**Safe to merge.**`,
      ].join('\n');
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    } catch (err) {
      console.error(`Ghost Watcher: clean PR comment failed (non-fatal): ${err.message}`);
    }
    return;
  }

  const prNumber = parseInt(prMatch[1], 10);
  const [owner, repo] = repository.split('/');

  // Severity breakdown
  const critical = findings.filter(f => f.severity === 'CRITICAL').length;
  const high     = findings.filter(f => f.severity === 'HIGH').length;
  const medium   = findings.filter(f => f.severity === 'MEDIUM').length;
  const low      = findings.filter(f => f.severity === 'LOW').length;
  const total    = findings.length;

  // Severity summary line
  const parts = [];
  if (critical) parts.push(`${critical} critical`);
  if (high)     parts.push(`${high} high`);
  if (medium)   parts.push(`${medium} medium`);
  if (low)      parts.push(`${low} low`);
  const severitySummary = parts.length ? parts.join(' · ') : 'none';

  // Phase grouping for the comment body
  const phase1 = findings.filter(f => ['CRITICAL', 'HIGH'].includes(f.severity));
  const phase2 = findings.filter(f => ['MEDIUM', 'LOW'].includes(f.severity));

  const shortSha = sha.slice(0, 7);
  const date     = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  let body = `## 👻 Ghost Watcher™ — Commit Analysis\n\n`;
  body    += `**Branch:** \`${refName}\`\n`;
  body    += `**Commit:** \`${shortSha}\` · ${actor} · ${date}\n\n`;
  body    += `**Findings:** ${total} (${severitySummary})\n`;
  body    += `**Blast radius:** ${blastFileCount} file${blastFileCount === 1 ? '' : 's'} affected\n`;
  body    += `**Ghost Brief:** ${briefPromptCount} prompt${briefPromptCount === 1 ? '' : 's'} ready\n\n`;

  if (phase1.length > 0) {
    body += `### PHASE 1 — Fix first (surgical)\n`;
    for (const f of phase1) {
      body += `  - **${f.severity}:** ${f.title}\n`;
    }
    body += `  → Prompts ready in Ghost Portal\n\n`;
  }

  if (phase2.length > 0) {
    body += `### PHASE 2 — Fix second (moderate)\n`;
    for (const f of phase2) {
      body += `  - **${f.severity}:** ${f.title}\n`;
    }
    body += `  → Prompts ready in Ghost Portal\n\n`;
  }

  if (total === 0) {
    body += `No findings detected for this commit.\n\n`;
  }

  if (portalUrl) {
    body += `[Open Ghost Portal to copy prompts into your AI coding tool.](${portalUrl})\n`;
  }

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

function getModel() {
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
function buildConflictPrompts(fileMap, profile) {
  let context = '';
  for (const [fp, content] of Object.entries(fileMap || {})) {
    context += `\n\n=== FILE: ${fp} ===\n${content}`;
  }
  const totalFiles = Object.keys(fileMap || {}).length;
  const systemPrompt = buildSystemConflict(profile);
  const userMessage = buildConflictPrompt({
    passNum: 1,
    totalPasses: 1,
    totalFiles,
    context,
    priorContext: '',
    forecastContext: null,
  });
  return { systemPrompt, userMessage };
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

  try {
    const rates = mergeRates(getRates(), profile);
    const projectLabel = changedFiles.length === 1
      ? changedFiles[0]
      : `change set of ${changedFiles.length} files`;

    const narratedReport = await narrateReport(
      {
        findings:      rawFindings,
        findingCount:  rawFindings.length,
        filesAnalyzed: codebaseContext?.loadedFiles || 0,
        stepCount:     1,
        auditTrail:    [],
      },
      { projectLabel, mode: 'blast', rates, profile },
      // Headless — we use the returned narrated text, not the stream.
      () => {},
    );

    return extractFindings(narratedReport || rawBlastOutput);
  } catch (err) {
    console.error(`Ghost Watcher: Blast narrator failed (non-fatal), using raw findings — ${err.message}`);
    return rawFindings;
  }
}

// A batch custom_id must match ^[a-zA-Z0-9_-]{1,64}$. Short commit SHAs are hex,
// the mode prefix and timestamp are alphanumeric/`-`, so the result always
// satisfies the pattern. We still sanitize defensively in case of a non-hex
// fallback SHA ('local'), then clamp to 64 chars.
function sanitizeCustomId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
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
    subject: `Ghost Watcher™ — Run incomplete on ${repo}`,
    html:
      `<h2 style="color:#00bfd8;">Ghost Watcher™ — Run incomplete</h2>\n` +
      `<p>Your Ghost Watcher™ run on <strong>${repo}</strong> commit <code>${shortSha}</code> did not complete before the GitHub Actions job ended.</p>\n` +
      `<p>It is likely this happened because your GitHub account has reached its monthly Actions minutes limit. Free and Pro GitHub plans include 2,000–3,000 minutes per month. A full Ghost Watcher™ scan on a large codebase can take 15–30 minutes per run.</p>\n` +
      `<p><strong>The good news</strong> — your scan is still processing on Anthropic's servers. Ghost Watcher™ will automatically retrieve and deliver your results on the next commit push. No action needed on your part.</p>\n` +
      `<p>To prevent this in the future:</p>\n` +
      `<ul>\n` +
      `  <li>Upgrade your GitHub plan for more Actions minutes</li>\n` +
      `  <li>Add <code>[ghost-skip]</code> to routine or low-priority commits to conserve minutes</li>\n` +
      `  <li>Configure Ghost Watcher™ to watch fewer branches via <code>ghost-watcher.yaml</code></li>\n` +
      `  <li>Increase <code>batch.poll_interval_seconds</code> in <code>ghost-watcher.yaml</code> to reduce Actions minutes used while polling</li>\n` +
      `</ul>\n` +
      `<p>Your results will be delivered automatically on the next push. No action required.</p>\n` +
      `<p style="color:#666;">— Ghost Watcher™ · <a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
  };
}

function emailResumeDetected({ repo, shortSha, type }) {
  return {
    subject: `Ghost Watcher™ — Resuming incomplete scan from commit ${shortSha}`,
    html:
      `<h2 style="color:#00bfd8;">Ghost Watcher™ — Resuming your scan</h2>\n` +
      `<p>Ghost Watcher™ has detected an incomplete scan from a previous run.</p>\n` +
      `<p><strong>Repository:</strong> ${repo}<br>\n` +
      `<strong>Commit:</strong> <code>${shortSha}</code><br>\n` +
      `<strong>Scan type:</strong> ${type}</p>\n` +
      `<p>Your results are being retrieved now from Anthropic's servers. You will receive another email when the analysis is complete.</p>\n` +
      `<p style="color:#666;">— Ghost Watcher™ · <a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
  };
}

function emailResumeComplete({ repo, shortSha, findingsCount, criticalCount, highCount, mediumCount, lowCount, portalSlug }) {
  return {
    subject: `Ghost Watcher™ — Results ready for commit ${shortSha}`,
    html:
      `<h2 style="color:#00bfd8;">Ghost Watcher™ — Results delivered</h2>\n` +
      `<p>Your incomplete Ghost Watcher™ scan has been successfully retrieved and delivered.</p>\n` +
      `<p><strong>Repository:</strong> ${repo}<br>\n` +
      `<strong>Commit:</strong> <code>${shortSha}</code><br>\n` +
      `<strong>Findings:</strong> ${findingsCount} total (${criticalCount} critical, ${highCount} high, ${mediumCount} medium, ${lowCount} low)</p>\n` +
      `<p>View your full results and Ghost Brief™ prompts in <a href="https://ghostarchitect.dev/portal-${portalSlug}.html">Ghost Portal</a>.</p>\n` +
      `<p style="color:#666;">— Ghost Watcher™ · <a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
  };
}

function emailSetupWarning({ repo }) {
  return {
    subject: `Ghost Watcher™ — Action required: GitHub Actions minutes insufficient`,
    html:
      `<h2 style="color:#ff5555;">Ghost Watcher™ — Action required</h2>\n` +
      `<p>Ghost Watcher™ has attempted to scan <strong>${repo}</strong> three times but has not been able to complete a full scan due to GitHub Actions minute limits.</p>\n` +
      `<p>It is likely this happened because your GitHub account's free Actions minutes are insufficient for the size of your codebase. Ghost Watcher™ requires 15–30 minutes of Actions time per scan.</p>\n` +
      `<p><strong>To resolve this, choose one of the following:</strong></p>\n` +
      `<ol>\n` +
      `  <li><strong>Upgrade your GitHub plan</strong> — Team and Enterprise plans include significantly more Actions minutes. <a href="https://github.com/pricing">View GitHub pricing</a></li>\n` +
      `  <li><strong>Increase the poll interval</strong> — In your <code>ghost-watcher.yaml</code>, set <code>batch.poll_interval_seconds: 120</code>. This reduces Actions minutes used while waiting for results, at the cost of slightly delayed delivery.</li>\n` +
      `  <li><strong>Reduce scan frequency</strong> — Add <code>[ghost-skip]</code> to commits that do not need analysis. Reserve Ghost Watcher™ for high-risk commits only.</li>\n` +
      `  <li><strong>Watch fewer branches</strong> — Edit your <code>ghost-watcher.yaml</code> to remove low-priority branches from the trigger list.</li>\n` +
      `</ol>\n` +
      `<p>Ghost Watcher™ will continue attempting to deliver results automatically. Your pending scans are safe on Anthropic's servers.</p>\n` +
      `<p style="color:#666;">— Ghost Watcher™ · <a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
  };
}

function emailCleanScan({ repo, shortSha, fileCount, portalSlug }) {
  return {
    subject: `Ghost Watcher™ — Clean scan on ${repo} commit ${shortSha}`,
    html:
      `<h2 style="color:#00e5a8;">Ghost Watcher™ — Clean scan</h2>\n` +
      `<p>Ghost Watcher™ scanned commit <code>${shortSha}</code> on <strong>${repo}</strong> and found no issues.</p>\n` +
      `<p>Your codebase is clean. No action required.</p>\n` +
      `<p><strong>Scan summary:</strong><br>\n` +
      `Files analyzed: ${fileCount}<br>\n` +
      `Blast Radius: 0 findings<br>\n` +
      `Conflict Detection: 0 findings</p>\n` +
      `<p>View your scan history in <a href="https://ghostarchitect.dev/portal-${portalSlug}.html">Ghost Portal</a>.</p>\n` +
      `<p style="color:#666;">— Ghost Watcher™ · <a href="https://ghostarchitect.dev">ghostarchitect.dev</a></p>`,
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
// completed entry. (The portal HTML has no Watch tab yet, so this is data-only —
// the rendering surface is a separate follow-up.)
//
// Path: projects/<repoSlug>/scans/watch/commits/<commitHash>.json

function repoSlugFor(repoPath) {
  return (repoPath || 'unknown-project').replace('/', '-').toLowerCase();
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

function buildSeverityCounts(findings) {
  return {
    critical: findings.filter(f => f.severity === 'CRITICAL').length,
    high:     findings.filter(f => f.severity === 'HIGH').length,
    medium:   findings.filter(f => f.severity === 'MEDIUM').length,
    low:      findings.filter(f => f.severity === 'LOW').length,
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
export async function runWatchCommit({ tier = 'team', version = '9.0.0' } = {}) {
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
  // Prevents Ghost Watcher from running indefinitely on high-commit PRs.
  // Reads max_iterations from ghost-watcher.yaml (default: 10).
  // Counts prior Watch runs for this PR by checking GITHUB_RUN_NUMBER.
  const maxIterations = watchConfig.iterations?.max ?? 10;
  const runNumber     = parseInt(process.env.GITHUB_RUN_NUMBER || '1', 10);
  if (runNumber > maxIterations) {
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

        try {
          const resumeResults = await pollBatch(anthropic, pending.batchId, {
            pollIntervalMs: 10000,
            timeoutMs: 60000,
            onProgress: (p) => console.log(`Ghost Watcher: resume check — ${p.status}`),
          });

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
          });

          // Update the PR comment on the ORIGINAL PR with the real findings.
          if (pending.prNumber) {
            const summary = `${pendingFindings.length} finding${pendingFindings.length === 1 ? '' : 's'} (${sev.critical} critical, ${sev.high} high, ${sev.medium} medium, ${sev.low} low)`;
            const body =
              `## 👻 Ghost Watcher™ — Results delivered\n\n` +
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
  if (watchConfig.scans?.blast_radius !== false || watchConfig.scans?.conflict_detection !== false) {
    const preflight = await preflightBatchCheck(anthropic, getModel());
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
  // the full tier cap on the ephemeral runner. Set in the same call as tier so
  // the flag is not clobbered by a subsequent setScanOptions.
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

  if (watchConfig.scans?.blast_radius !== false) {
    console.log('Ghost Watcher: running Blast Radius (batch)...');
    let blastBatchId = null;
    try {
      const { systemPrompt, userMessage } = buildBlastPrompts(codebaseContext, changedFiles, profile);
      blastBatchId = await submitBatch(anthropic, [{
        custom_id: sanitizeCustomId(`blast-${commitSha}-${Date.now()}`),
        params: {
          model: getModel(),
          max_tokens: 8096,
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
          `Results will be posted here automatically when complete — usually within 15 minutes.\n\n` +
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
        if (blastResults[0]?.usage) {
          const u = blastResults[0].usage;
          console.log(`Ghost Watcher: Blast Radius tokens — in ${u.input_tokens ?? 0}, out ${u.output_tokens ?? 0}`);
        }
        await clearPendingBatch(octokitPortal, portalRepoPath, blastBatchId);
        console.log(`Ghost Watcher: Blast Radius complete — ${blastFindings.length} findings\n`);
      } catch (err) {
        if (err instanceof BatchTimeoutError) {
          // Batch is already stored; the next push will resume it. Exit gracefully.
          await handleIncompleteRun({ octokitPortal, portalRepoPath, emailRecipients, repo: repoPath, shortSha: commitSha });
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
    try {
      const { systemPrompt, userMessage } = buildConflictPrompts(codebaseContext.fileMap || {}, profile);
      conflictBatchId = await submitBatch(anthropic, [{
        custom_id: sanitizeCustomId(`conflict-${commitSha}-${Date.now()}`),
        params: {
          model: getModel(),
          max_tokens: 8096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
      }]);
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
        const conflictResults = await pollBatch(anthropic, conflictBatchId, {
          pollIntervalMs, timeoutMs,
          onProgress: (p) => console.log(`Ghost Watcher: Conflict Detection — ${p.status} (${Math.round(p.elapsedMs / 1000)}s)`),
        });
        const rawConflictOutput = conflictResults[0]?.text || '';
        conflictFindings = extractCandidates([rawConflictOutput]).map(normalizeCandidateToFinding);
        await clearPendingBatch(octokitPortal, portalRepoPath, conflictBatchId);
        console.log(`Ghost Watcher: Conflict Detection complete — ${conflictFindings.length} findings\n`);
      } catch (err) {
        if (err instanceof BatchTimeoutError) {
          await handleIncompleteRun({ octokitPortal, portalRepoPath, emailRecipients, repo: repoPath, shortSha: commitSha });
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
  const allFindings = [
    ...blastFindings.map(f => ({ ...f, source_mode: 'blast' })),
    ...conflictFindings.map(f => ({ ...f, source_mode: 'conflict' })),
  ];

  console.log(`Ghost Watcher: ${allFindings.length} total findings (blast: ${blastFindings.length}, conflict: ${conflictFindings.length})\n`);

  // ── Step 8: Ghost Brief ──────────────────────────────────────────────────
  let brief           = null;
  let briefPromptCount = 0;

  if (watchConfig.scans?.ghost_brief !== false && allFindings.length > 0) {
    try {
      const { generateBrief, writeBrief } = await import('../../lib/ghostBrief.js');

      // Adapt raw findings into Ghost Brief prompt shape via the adapter.
      // Blast findings use fromPOI (same shape); conflict findings use fromConflict.
      const adaptedFindings = [
        ...fromPOI(blastFindings.map(f => ({ ...f, source_mode: 'blast' }))),
        ...fromConflict(conflictFindings),
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
  if (octokitPortal && portalOwner && portalRepoName) {
    const sevAll = buildSeverityCounts(allFindings);
    await pushWatchCommitState(octokitPortal, portalOwner, portalRepoName, repoPath, commitHashFull, {
      commitHash: commitHashFull, branch, developer: developer.name,
      timestamp: new Date().toISOString(), status: 'complete', batchId: null,
      message: 'Ghost Watcher™ analysis complete.',
      findings: allFindings, findingCount: allFindings.length,
      severity: sevAll, prompts: briefPromptCount,
    });
  }
  // A completed run resets the consecutive-incomplete-run counter.
  await resetIncompleteRuns(octokitPortal, portalRepoPath);

  // ── Step 8c: Clean scan email ─────────────────────────────────────────────
  // Zero findings across both scans — tell the customer the commit is clean.
  // Fire-and-forget; never blocks the portal push that follows.
  if (allFindings.length === 0) {
    try {
      const eClean = emailCleanScan({
        repo: repoPath,
        shortSha: commitSha,
        fileCount: codebaseContext.loadedFiles || 0,
        portalSlug: portalSlug || repoOwner,
      });
      await sendWatcherEmail(emailRecipients, eClean.subject, eClean.html);
    } catch (_) { /* email never blocks */ }
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

      // Build the Watch result payload
      const watchResult = {
        schema:      '1.0',
        generatedAt: new Date().toISOString(),
        commit:      process.env.GITHUB_SHA || 'local',
        commitShort: commitSha,
        branch,
        developer,
        projectSlug,
        findingCount: allFindings.length,
        severityCounts: {
          critical: allFindings.filter(f => f.severity === 'CRITICAL').length,
          high:     allFindings.filter(f => f.severity === 'HIGH').length,
          medium:   allFindings.filter(f => f.severity === 'MEDIUM').length,
          low:      allFindings.filter(f => f.severity === 'LOW').length,
        },
        blastFileCount,
        briefPromptCount,
        findings:    allFindings,
        brief:       brief || null,
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
      portalUrl = `https://ghostarchitect.dev/portal-${portalSlug}`;

    } catch (err) {
      console.error(`Ghost Watcher: portal push failed (non-fatal) — ${err.message}`);
    }
  } else {
    console.log('Ghost Watcher: GHOST_PORTAL_REPO or GHOST_PORTAL_TOKEN not set — skipping portal push\n');
  }

  // ── Step 10: PR comment ───────────────────────────────────────────────────
  if (watchConfig.notifications?.pr_comment !== false) {
    await postPRComment({ findings: allFindings, blastFileCount, briefPromptCount, portalUrl, clean: allFindings.length === 0 });
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log(`👻 Ghost Watcher™ complete.`);
  console.log(`   Findings: ${allFindings.length} | Brief prompts: ${briefPromptCount} | Exit: 0\n`);

  // ── Telemetry ping ────────────────────────────────────────────────────────
  // Write telemetry to temp file for CI curl step to read
  const telemetryPayload = {
    userId:    'ci',
    version,
    tier,
    timestamp: new Date().toISOString(),
    findings:  allFindings.length,
    severity: {
      critical: allFindings.filter(f => f.severity === 'CRITICAL').length,
      high:     allFindings.filter(f => f.severity === 'HIGH').length,
      medium:   allFindings.filter(f => f.severity === 'MEDIUM').length,
      low:      allFindings.filter(f => f.severity === 'LOW').length,
    },
    prompts:   briefPromptCount,
    scans: {
      blast:    watchConfig.scans?.blast_radius    !== false,
      conflict: watchConfig.scans?.conflict_detection !== false,
      brief:    watchConfig.scans?.ghost_brief     !== false,
    },
    commitHash: (process.env.GITHUB_SHA || '').slice(0, 16),
    repoHash:   process.env.GITHUB_REPOSITORY || '',
  };
  try {
    const { writeFileSync } = await import('fs');
    writeFileSync('/tmp/ghost-watcher-telemetry.json', JSON.stringify(telemetryPayload));
  } catch (_) { /* non-fatal */ }
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
        blast:    watchConfig.scans?.blast_radius    !== false,
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
