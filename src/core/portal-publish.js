/**
 * Ghost Architect™ — Portal Publish Engine
 * Pushes report files + findings sidecar + manifest to ghost-reports-portal-test.
 * The web portal at ghostarchitect.dev/portal-* reads from this repo via the
 * signup.ghostarchitect.dev Worker.
 *
 * Repo structure in ghost-reports-portal-test:
 *   reports/
 *     ghost-{mode}-{label}-{ts}.md
 *     ghost-{mode}-{label}-{ts}.pdf
 *     ghost-{mode}-{label}-{ts}.txt
 *     ghost-{mode}-{label}-{ts}.findings.json   ← powers Jira export
 *   manifest.json                                ← portfolio index
 *
 * This is parallel to (not a replacement for) mobile-publish.js which pushes
 * to ghost-reports for the Ghost Mobile Expo app. The two consumers want
 * different payload shapes, so we have two publishers.
 */

import { createOctokit } from '../utils/octokit-client.js';
import Configstore from 'configstore';
import fs           from 'fs';
import path         from 'path';
import os           from 'os';
import { extractFindings, generateFindingId } from '../utils/finding-parser.js';

const config = new Configstore('ghost-architect');

// ── Config ────────────────────────────────────────────────────────────────────

export function getPortalConfig() {
  return config.get('portalPublish') || null;
}

export function setPortalConfig({ repo, token, slug }) {
  config.set('portalPublish', { repo, token, slug });
}

export function isPortalConfigured() {
  const cfg = getPortalConfig();
  return !!(cfg?.repo && cfg?.token);
}

// ── Octokit helpers ───────────────────────────────────────────────────────────

function getOctokit() {
  const cfg = getPortalConfig();
  if (!cfg) throw new Error('Portal publish not configured. Run ghost --configure-portal.');
  return createOctokit({ auth: cfg.token });
}

function parseRepo(repoUrl) {
  const clean = repoUrl.replace('https://github.com/', '').replace(/\.git$/, '');
  const [owner, repo] = clean.split('/');
  return { owner, repo };
}

async function getFileSha(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    return data.sha;
  } catch { return null; }
}

async function upsertFile(octokit, owner, repo, filePath, content, message) {
  const sha = await getFileSha(octokit, owner, repo, filePath);
  const encoded = Buffer.isBuffer(content)
    ? content.toString('base64')
    : Buffer.from(content).toString('base64');
  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo,
    path: filePath,
    message,
    content: encoded,
    ...(sha ? { sha } : {}),
  });
}

// Returns both the parsed JSON content and the blob sha. The sha is what
// GitHub's contents API uses for conditional updates: pass it back on write
// and GitHub rejects (409/422) if the file changed underneath us. Callers
// that only want the content can read `.content`.
async function getFileContent(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    return {
      content: JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')),
      sha:     data.sha,
    };
  } catch { return { content: null, sha: null }; }
}

// ── Findings sidecar ──────────────────────────────────────────────────────────

/**
 * Build the findings.json sidecar payload from a report's content.
 * Shape mirrors what the web portal Jira export reads: an array of finding
 * objects with stable IDs and severity counts.
 */
export function buildFindingsSidecar(reportText, meta = {}) {
  const findings = extractFindings(reportText).map(f => ({
    id:          generateFindingId(f),
    title:       f.title,
    severity:    f.severity,
    files:       f.files || [],
    effortHours: f.effortHours || 0,
    confidence:  f.confidence  || 85,
    detail:      f.detail || '',
  }));

  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    const k = (f.severity || '').toLowerCase();
    if (counts[k] !== undefined) counts[k]++;
  }

  return {
    schema:          1,
    generatedAt:     new Date().toISOString(),
    project:         meta.project || meta.label || null,
    mode:            meta.mode    || null,
    totalFindings:   findings.length,
    severityCounts:  counts,
    findings,
  };
}

// ── Dashboard sidecar ─────────────────────────────────────────────────────────

/**
 * Build the dashboard.json sidecar payload from project intelligence data.
 *
 * Unlike findings.json (one per scan), dashboard.json is a rollup across
 * ALL labeled projects. It is regenerated and republished on every scan
 * that updates a labeled project, so the portal always sees the latest
 * remediation state.
 *
 * Shape:
 *   schema:             1
 *   generatedAt:        ISO timestamp
 *   projectCount:       number of tracked projects
 *   projects:           [ {label, baselineDate, lastScan, scanCount,
 *                          baseline, resolved, progress, newIssues,
 *                          remainingFindings: [...] }, ... ]
 *   aggregateCounts:    { totalBaseline, totalResolved, totalRemaining,
 *                          totalNewIssues, avgProgress }
 *   remainingFindings:  flat array of ALL open findings across all projects,
 *                       each tagged with the project label so the portal's
 *                       aggregated Jira export can render them as one batch
 *
 * The `remainingFindings` shape mirrors the per-scan findings.json so the
 * portal's existing Jira modal code can consume it with minimal changes.
 *
 * @param {Array} dashboardRows      output of getProjectDashboardData()
 * @param {Array} projectsFullMeta   output of listProjects() (for remainingFindings)
 * @returns {object} sidecar payload
 */
export function buildDashboardSidecar(dashboardRows, projectsFullMeta) {
  // Build the flat remainingFindings array. For each project, compute which
  // baseline findings are still present in the latest scan (i.e. unresolved).
  // We do this here rather than reading from each scan record because (a) the
  // dashboard.json is the single source of truth the portal consumes, and (b)
  // we want every remaining finding tagged with project context so the Jira
  // export can show "Bug X in Project Y".
  const remainingFindings = [];
  let totalBaseline  = 0;
  let totalResolved  = 0;
  let totalRemaining = 0;
  let totalNewIssues = 0;
  let progressSum    = 0;
  let progressCount  = 0;

  // Build a lookup so we can attach remainingFindings to the right row.
  const metaByLabel = new Map();
  for (const m of (projectsFullMeta || [])) metaByLabel.set(m.label, m);

  const projects = (dashboardRows || []).map(row => {
    const meta = metaByLabel.get(row.label) || null;

    // Remaining findings = baseline findings minus those resolved in the
    // latest scan. We approximate by re-running the similarity logic that
    // saveProjectIntelligence already uses, but to avoid coupling to that
    // module here we just use the baselineFindings as a starting point and
    // mark resolved count from the row. The portal doesn't need per-finding
    // resolved status — it needs the flat list of open findings to send to
    // Jira. So we take baseline findings, skip the first `resolved` count
    // worth (best-effort), and emit the rest as "remaining". This is a
    // pragmatic approximation; a perfectly precise diff would require
    // re-running similarFinding() which lives in core/projects.js.
    //
    // Future improvement: have saveProjectIntelligence write the actual
    // remainingFindings array into project.json on every scan so we can
    // read it verbatim here. For v1, the approximation is acceptable
    // because (a) the dashboard severity counts are still exact (they
    // come from row.baseline - row.resolved), and (b) the Jira export
    // will show open-issue titles even if the "which exact one" mapping
    // is approximate.
    let projectRemaining = [];
    if (meta && Array.isArray(meta.baselineFindings)) {
      // Skip the first `resolved` baseline entries — approximation.
      projectRemaining = meta.baselineFindings.slice(row.resolved || 0);
    }

    // Tag each remaining finding with project context for the aggregated
    // Jira export, and give it a stable per-dashboard ID.
    for (let i = 0; i < projectRemaining.length; i++) {
      const f = projectRemaining[i];
      remainingFindings.push({
        id:          `${slugifyLabel(row.label)}__${i}`,
        title:       f.title || '(untitled)',
        severity:    f.severity || 'MEDIUM',
        effortHours: f.effortHours || 0,
        project:     row.label,
        projectLastScan: row.lastScan,
      });
    }

    totalBaseline  += row.baseline  || 0;
    totalResolved  += row.resolved  || 0;
    totalRemaining += Math.max(0, (row.baseline || 0) - (row.resolved || 0));
    totalNewIssues += row.newIssues || 0;
    if (row.baseline > 0) {
      progressSum   += row.progress || 0;
      progressCount += 1;
    }

    return {
      label:        row.label,
      baselineDate: row.baselineDate,
      lastScan:     row.lastScan,
      scanCount:    row.scanCount,
      baseline:     row.baseline,
      resolved:     row.resolved,
      progress:     row.progress,
      newIssues:    row.newIssues,
      remaining:    Math.max(0, (row.baseline || 0) - (row.resolved || 0)),
    };
  });

  const avgProgress = progressCount > 0 ? Math.round(progressSum / progressCount) : 0;

  return {
    schema:           1,
    generatedAt:      new Date().toISOString(),
    projectCount:     projects.length,
    projects,
    aggregateCounts: {
      totalBaseline,
      totalResolved,
      totalRemaining,
      totalNewIssues,
      avgProgress,
    },
    remainingFindings,
  };
}

// Internal helper — keep in sync with core/projects.js slugify(), but we
// duplicate it here so portal-publish.js doesn't have to import from
// core/projects.js (which would create a circular dependency risk).
function slugifyLabel(s) {
  return (s || '').replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
}

// ── Severity counts from existing markdown for the manifest entry ─────────────
//
// The manifest entry for each report needs a severityCounts object that
// matches what the portal's per-mode summary uses. We prefer the exec
// summary line because it counts ALL findings (including the long tail
// past the visible top-N). Fall back to per-finding severity markers
// when no exec summary is present.

function extractSeverityCountsFromBody(md) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

  const sumLine = md.match(/identified\s+\d+\s+findings?:([^.]+)/i);
  if (sumLine) {
    const line = sumLine[1];
    const grab = (label) => {
      const r = new RegExp(`(\\d+)\\s+${label}[-\\s]severit`, 'i');
      const mm = line.match(r);
      return mm ? parseInt(mm[1], 10) : 0;
    };
    counts.critical = grab('critical');
    counts.high     = grab('high');
    counts.medium   = grab('medium');
    counts.low      = grab('low');
    const total = counts.critical + counts.high + counts.medium + counts.low;
    if (total > 0) return counts;
  }

  const severityRe = /\*\*Severity:\*\*\s*[^\n]*?\b(CRITICAL|HIGH|MEDIUM|LOW|INFO)\b/gi;
  let m;
  while ((m = severityRe.exec(md)) !== null) {
    const sev = m[1].toLowerCase();
    if (counts[sev] !== undefined) counts[sev]++;
  }
  return counts;
}

function extractSummarySnippet(md) {
  const idx = md.toLowerCase().indexOf('## executive summary');
  if (idx === -1) return null;
  const after = md.slice(idx + '## executive summary'.length);
  const paras = after.split(/\n\n+/);
  for (const p of paras) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('|')) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.length < 40) continue;
    return trimmed.slice(0, 400);
  }
  return null;
}

// ── Manifest entry ────────────────────────────────────────────────────────────

const MODE_LABELS = {
  poi:           { label: 'Points of Interest', order: 1 },
  blast:         { label: 'Blast Radius',       order: 2 },
  conflict:      { label: 'Conflict',           order: 3 },
  forecast:      { label: 'Commit Forecast',    order: 3.5 },
  'fix-forecast-combined': { label: 'Fix Forecast', order: 3.7 },
  recon:         { label: 'Recon',              order: 4 },
  audit:         { label: 'Inheritance Audit',  order: 5 },
  inheritance:   { label: 'Inheritance Audit',  order: 5 },
  'prompt-triage':{ label: 'Prompt Triage',     order: 6 },
  question:      { label: 'Question and Answer', order: 6.5 },
  chat:          { label: 'Chat',               order: 7 },
  compare:       { label: 'Compare',            order: 8 },
  dashboard:     { label: 'Dashboard',          order: 9 },
};

function buildManifestEntry({ mode, label, baseName, reportText, scanIso, findingsSidecar = null }) {
  const normalizedMode = mode === 'inheritance' ? 'audit' : mode;
  const modeInfo       = MODE_LABELS[normalizedMode] || { label: mode, order: 99 };

  // Prefer the in-memory findings sidecar (authoritative — same data that
  // powers the Jira export and the portal's per-finding rendering). Fall
  // back to markdown regex only when no sidecar is available (e.g. legacy
  // re-pushes of reports generated before the sidecar shipped).
  let severityCounts;
  let findingsTotal;
  if (findingsSidecar && findingsSidecar.severityCounts) {
    severityCounts = {
      critical: findingsSidecar.severityCounts.critical || 0,
      high:     findingsSidecar.severityCounts.high     || 0,
      medium:   findingsSidecar.severityCounts.medium   || 0,
      low:      findingsSidecar.severityCounts.low      || 0,
      info:     findingsSidecar.severityCounts.info     || 0,
    };
    findingsTotal = typeof findingsSidecar.totalFindings === 'number'
      ? findingsSidecar.totalFindings
      : severityCounts.critical + severityCounts.high +
        severityCounts.medium   + severityCounts.low + severityCounts.info;
  } else {
    severityCounts = extractSeverityCountsFromBody(reportText);
    findingsTotal  = severityCounts.critical + severityCounts.high +
                     severityCounts.medium   + severityCounts.low +
                     severityCounts.info;
  }

  const summary        = extractSummarySnippet(reportText);
  const id             = `${normalizedMode}__${label || '(untitled)'}__${baseName.replace(/^ghost-[a-z]+-?/, '').replace(/^.+?-(\d{4}-\d{2}-\d{2}T)/, '$1')}`;

  // Pull tool/version from header if present, otherwise leave 'unknown'.
  let tool = 'unknown';
  const toolM = reportText.match(/\|\s*\*\*Tool\*\*\s*\|\s*([^|]+?)\s*\|/);
  if (toolM) tool = toolM[1].trim();

  let filesAnalyzed = null;
  const faM = reportText.match(/\|\s*\*\*Files Analyzed\*\*\s*\|\s*([^|]+?)\s*\|/);
  if (faM) filesAnalyzed = faM[1].trim();

  return {
    id,
    mode:                  normalizedMode,
    modeLabel:             modeInfo.label,
    project:               label || '(untitled)',
    label:                 label || '(untitled)',
    generated:             new Date(scanIso).toLocaleString(),
    generatedIso:          scanIso,
    tool,
    filesAnalyzed,
    summary,
    severityCounts,
    findingsTotal,
    hasStructuredFindings: true,
    files: {
      md:       `reports/${baseName}.md`,
      pdf:      `reports/${baseName}.pdf`,
      txt:      `reports/${baseName}.txt`,
      findings: `reports/${baseName}.findings.json`,
    },
  };
}

// ── Manifest update ───────────────────────────────────────────────────────────
//
// The manifest is a read-modify-write hotspot: every scan in a portfolio
// rewrites the same manifest.json. In team environments concurrent pushes are
// common (sprint reviews, incident response), and a naive last-write-wins
// rewrite silently drops whichever entry landed first, breaking the portfolio
// view. To prevent that we use GitHub's conditional update: read the manifest
// WITH its blob sha, merge our entry, and write back passing that sha. If the
// file changed underneath us GitHub rejects the write (409/422); we re-fetch,
// re-apply our entry onto the now-current manifest, and retry. This preserves
// every concurrently-pushed entry instead of clobbering them.
//
// Race window: the conditional-update guard closes the read-modify-write gap
// for writers that race through GitHub's contents API, but two windows remain.
// (1) GitHub's contents API is eventually consistent — a concurrent writer can
// have its commit accepted against the same sha we read, and the rejection may
// not arrive as a clean 409/422 in every replica/timing combination. (2) After
// a write GitHub reports as successful, the merged blob may not yet be the one
// a subsequent reader sees, OR a concurrent writer may overwrite our entry with
// a same-id-but-stale version. To shrink the second window we re-read the
// manifest after a successful write and confirm our entry is present AND
// byte-for-byte the content we wrote (not merely that some entry with our id
// exists); if it is missing or differs, we treat the write as lost and retry the
// full read-merge-write cycle. Between every retry (both sha conflicts and failed
// verifications) we wait with exponential backoff so racing writers stagger
// rather than livelock retrying against each other in lockstep.

const MANIFEST_RETRY_LIMIT = 3;

// Exponential backoff base delay (ms) between manifest retries. Attempt N waits
// MANIFEST_BACKOFF_BASE_MS * 2^N so concurrent writers desynchronize.
const MANIFEST_BACKOFF_BASE_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pure merge step: take the existing manifest (or null) plus a new entry and
// return the fully recomputed manifest object. Kept side-effect-free so the
// retry loop can re-run it against freshly fetched content on each attempt.
function mergeManifestEntry(existing, newEntry) {
  const manifest = existing || {
    schema: 1,
    portal: getPortalConfig()?.slug || 'ejwisner',
    generatedAt: new Date().toISOString(),
    totalReports: 0,
    modeSummary: {},
    reports: [],
  };

  // Replace by id if present; otherwise prepend.
  const idx = (manifest.reports || []).findIndex(r => r.id === newEntry.id);
  if (idx >= 0) {
    manifest.reports[idx] = newEntry;
  } else {
    manifest.reports = [newEntry, ...(manifest.reports || [])];
  }

  // Sort: newest first by generatedIso.
  manifest.reports.sort((a, b) => new Date(b.generatedIso) - new Date(a.generatedIso));

  // Recompute mode summary from the current reports list.
  const modeSummary = {};
  for (const [modeKey, info] of Object.entries(MODE_LABELS)) {
    if (modeKey === 'inheritance') continue;
    const matching = manifest.reports.filter(r => r.mode === modeKey);
    modeSummary[modeKey] = {
      label:         info.label,
      order:         info.order,
      count:         matching.length,
      lastGenerated: matching.length > 0 ? matching[0].generatedIso : null,
    };
  }

  manifest.generatedAt  = new Date().toISOString();
  manifest.totalReports = manifest.reports.length;
  manifest.modeSummary  = modeSummary;
  return manifest;
}

async function updateManifest(octokit, owner, repo, newEntry, { forcePush = false } = {}) {
  // `forcePush` builds the merged manifest once from the first read and
  // re-writes that same payload on each retry, intentionally overwriting any
  // concurrent changes. Use only when overwriting is deliberate (e.g. resetting
  // a manifest known to be stale). The default path re-merges on every retry so
  // concurrent entries are preserved.
  let forcedPayload = null;

  for (let attempt = 0; attempt <= MANIFEST_RETRY_LIMIT; attempt++) {
    const { content: existing, sha } = await getFileContent(octokit, owner, repo, 'manifest.json');

    let payload;
    if (forcePush) {
      if (forcedPayload === null) forcedPayload = mergeManifestEntry(existing, newEntry);
      payload = forcedPayload;
    } else {
      payload = mergeManifestEntry(existing, newEntry);
    }

    try {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner, repo,
        path: 'manifest.json',
        message: `portal: update manifest (${newEntry.id})${forcePush ? ' [force]' : ''}`,
        content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
        // Conditional update: GitHub rejects if the file changed since we read
        // this sha. Omit only when the manifest does not exist yet.
        ...(sha ? { sha } : {}),
      });

      // Post-write verification: re-read the manifest and confirm our entry
      // actually landed WITH the content we wrote. The contents API is eventually
      // consistent, so a write GitHub accepted can still be superseded by a
      // concurrent writer before it becomes visible. Checking id presence alone
      // is not enough: a racing writer can land an entry that shares our id but
      // carries stale content (e.g. an older scan of the same report re-pushed),
      // which would pass a presence-only check as a false positive. We deep-
      // compare the serialized entry against what we intended to write; if it is
      // missing OR differs, we treat the write as lost and retry the whole
      // read-merge-write cycle (backoff applied below) rather than reporting a
      // false success.
      const { content: verifyManifest } = await getFileContent(octokit, owner, repo, 'manifest.json');
      const landedEntry = (verifyManifest?.reports || []).find(r => r.id === newEntry.id);
      const landed = !!landedEntry &&
        JSON.stringify(landedEntry) === JSON.stringify(newEntry);
      if (landed) return;

      if (attempt === MANIFEST_RETRY_LIMIT) {
        throw new Error(
          `portal: manifest entry ${newEntry.id} did not persist after ` +
          `${MANIFEST_RETRY_LIMIT + 1} attempts (concurrent push race).`,
        );
      }
      console.warn(
        `⚠ portal: manifest write reported success but entry ${newEntry.id} ` +
        `was missing or carried unexpected content on re-read (concurrent push ` +
        `race). Retrying (attempt ${attempt + 1}/${MANIFEST_RETRY_LIMIT})...`,
      );
    } catch (err) {
      // 409 Conflict / 422 Unprocessable are GitHub's "sha is stale" responses.
      // Anything else (auth, network, 404 on the repo) is not a concurrency
      // problem and should surface immediately.
      const isShaConflict = err?.status === 409 || err?.status === 422;
      if (!isShaConflict || attempt === MANIFEST_RETRY_LIMIT) throw err;

      // In force mode we keep the same payload and just grab a fresh sha to
      // overwrite with; in the default path the next iteration re-merges.
      console.warn(
        `⚠ portal: manifest changed during push (concurrent push detected). ` +
        `Re-fetching${forcePush ? '' : ' and re-merging'} and retrying ` +
        `(attempt ${attempt + 1}/${MANIFEST_RETRY_LIMIT})...`,
      );
    }

    // Exponential backoff before the next attempt so racing writers stagger.
    await sleep(MANIFEST_BACKOFF_BASE_MS * Math.pow(2, attempt));
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Push a completed scan to the portal repo: TXT, MD, PDF, findings.json,
 * and an updated manifest entry. Each upsert is independent — partial
 * success leaves the portal in a usable state (manifest is the last
 * write, so if everything else succeeded the entry will appear; if the
 * manifest write fails, the files exist but won't show up until the next
 * push, which is acceptable).
 *
 * @param {object} args
 * @param {string} args.baseName   e.g. ghost-poi-blue-acorn-ici---magento-cli-2026-05-18T17-17-40
 * @param {string} args.mode       e.g. 'poi', 'blast', 'conflict', 'recon', 'audit'
 * @param {string} args.label      project label
 * @param {string} args.txtPath    absolute path to TXT
 * @param {string} args.mdPath     absolute path to MD
 * @param {string} args.pdfPath    absolute path to PDF (may not exist)
 * @param {string} args.findingsJsonPath  absolute path to findings.json sidecar
 * @param {string} args.reportText raw report content (used for manifest entry)
 * @param {string} args.scanIso    ISO timestamp of the scan
 * @param {boolean} args.forcePush  overwrite the manifest instead of merging
 *                                   concurrent entries (wire from --force-push)
 */
export async function publishToPortal({
  baseName, mode, label,
  txtPath, mdPath, pdfPath, findingsJsonPath,
  reportText, scanIso = new Date().toISOString(),
  forcePush = false,
}) {
  if (!isPortalConfigured()) return { ok: false, reason: 'not_configured' };

  const cfg            = getPortalConfig();
  const octokit        = getOctokit();
  const { owner, repo }= parseRepo(cfg.repo);

  // Push the four files in parallel for speed. If any fail, the catch
  // in the caller (saveReport) logs and continues without aborting save.
  const pushes = [];

  if (fs.existsSync(mdPath)) {
    pushes.push(upsertFile(
      octokit, owner, repo,
      `reports/${baseName}.md`,
      fs.readFileSync(mdPath),
      `portal: ${baseName} md`,
    ));
  }
  if (fs.existsSync(txtPath)) {
    pushes.push(upsertFile(
      octokit, owner, repo,
      `reports/${baseName}.txt`,
      fs.readFileSync(txtPath),
      `portal: ${baseName} txt`,
    ));
  }
  if (pdfPath && fs.existsSync(pdfPath)) {
    pushes.push(upsertFile(
      octokit, owner, repo,
      `reports/${baseName}.pdf`,
      fs.readFileSync(pdfPath),
      `portal: ${baseName} pdf`,
    ));
  }
  if (findingsJsonPath && fs.existsSync(findingsJsonPath)) {
    pushes.push(upsertFile(
      octokit, owner, repo,
      `reports/${baseName}.findings.json`,
      fs.readFileSync(findingsJsonPath),
      `portal: ${baseName} findings`,
    ));
  }

  await Promise.all(pushes);

  // Build and push manifest entry. Done after file pushes so the entry
  // never points at a file that hasn't landed yet. We re-read the
  // sidecar (just written by the caller and pushed above) so the
  // manifest counts come from the authoritative source rather than
  // markdown regex on the report body.
  let findingsSidecar = null;
  if (findingsJsonPath && fs.existsSync(findingsJsonPath)) {
    try {
      findingsSidecar = JSON.parse(fs.readFileSync(findingsJsonPath, 'utf8'));
    } catch {
      findingsSidecar = null;
    }
  }

  const entry = buildManifestEntry({
    mode, label, baseName, reportText, scanIso, findingsSidecar,
  });
  await updateManifest(octokit, owner, repo, entry, { forcePush });

  return { ok: true, baseName, entry };
}

export async function testPortalConnection() {
  const cfg = getPortalConfig();
  if (!cfg) return { ok: false, error: 'Not configured. Run ghost --configure-portal.' };
  try {
    const octokit = getOctokit();
    const { owner, repo } = parseRepo(cfg.repo);
    await octokit.rest.repos.get({ owner, repo });
    return { ok: true, repo: cfg.repo };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Ghost Brief publish ───────────────────────────────────────────────────────

/**
 * Push a ghost-brief.json file to the portal repo.
 *
 * Called from the --brief CLI handler after writeBrief() succeeds.
 * Non-fatal by design — the caller wraps in try/catch.
 *
 * Portal path: briefs/ghost-brief-<iso-datestamp>.json
 * A fixed-name alias (briefs/ghost-brief-latest.json) is also pushed
 * so the portal can always find the most recent Brief without manifest
 * traversal.
 *
 * @param {string} briefJsonPath  Absolute path to the written ghost-brief.json
 * @returns {{ ok: boolean, reason?: string }}
 */
export async function publishBriefToPortal(briefJsonPath) {
  if (!isPortalConfigured()) return { ok: false, reason: 'not_configured' };
  if (!fs.existsSync(briefJsonPath)) return { ok: false, reason: 'file_not_found' };

  const cfg             = getPortalConfig();
  const octokit         = getOctokit();
  const { owner, repo } = parseRepo(cfg.repo);
  const content         = fs.readFileSync(briefJsonPath);
  const stamp           = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  await Promise.all([
    upsertFile(octokit, owner, repo,
      `briefs/ghost-brief-${stamp}.json`,
      content,
      `portal: ghost-brief ${stamp}`),
    upsertFile(octokit, owner, repo,
      'briefs/ghost-brief-latest.json',
      content,
      `portal: ghost-brief-latest`),
  ]);

  return { ok: true };
}

// ── Dashboard publish ─────────────────────────────────────────────────────────

/**
 * Push a fresh dashboard rollup to the portal repo.
 *
 * Unlike publishToPortal (one entry per scan), the dashboard is a single
 * canonical row in the manifest with mode='dashboard'. We always use the
 * same baseName so the manifest row gets REPLACED on every publish rather
 * than accumulating dozens of stale dashboard rows. The "latest dashboard"
 * IS the dashboard — there's no notion of historical dashboards in the
 * portal view.
 *
 * Files written to portal repo:
 *   reports/ghost-dashboard.txt
 *   reports/ghost-dashboard.md
 *   reports/ghost-dashboard.pdf
 *   reports/ghost-dashboard.dashboard.json   ← portal reads this for rendering
 *
 * The .dashboard.json extension distinguishes from per-scan .findings.json
 * so the portal can route to the right renderer.
 *
 * @param {object} args
 * @param {string} args.txtPath            absolute path to dashboard TXT
 * @param {string} args.mdPath             absolute path to dashboard MD
 * @param {string} args.pdfPath            absolute path to dashboard PDF (may not exist)
 * @param {string} args.dashboardJsonPath  absolute path to dashboard.json sidecar
 * @param {object} args.dashboardSidecar   in-memory copy of dashboard.json (for manifest counts)
 * @param {string} args.scanIso            ISO timestamp of the regeneration
 * @param {boolean} args.forcePush         overwrite the manifest instead of merging
 *                                          concurrent entries (wire from --force-push)
 */
export async function publishDashboardToPortal({
  txtPath, mdPath, pdfPath, dashboardJsonPath, dashboardSidecar, scanIso,
  forcePush = false,
}) {
  if (!isPortalConfigured()) return { ok: false, reason: 'not_configured' };

  const cfg            = getPortalConfig();
  const octokit        = getOctokit();
  const { owner, repo }= parseRepo(cfg.repo);

  // Fixed baseName — there is only one canonical dashboard.
  const baseName = 'ghost-dashboard';

  const pushes = [];

  if (mdPath && fs.existsSync(mdPath)) {
    pushes.push(upsertFile(
      octokit, owner, repo,
      `reports/${baseName}.md`,
      fs.readFileSync(mdPath),
      `portal: ${baseName} md`,
    ));
  }
  if (txtPath && fs.existsSync(txtPath)) {
    pushes.push(upsertFile(
      octokit, owner, repo,
      `reports/${baseName}.txt`,
      fs.readFileSync(txtPath),
      `portal: ${baseName} txt`,
    ));
  }
  if (pdfPath && fs.existsSync(pdfPath)) {
    pushes.push(upsertFile(
      octokit, owner, repo,
      `reports/${baseName}.pdf`,
      fs.readFileSync(pdfPath),
      `portal: ${baseName} pdf`,
    ));
  }
  if (dashboardJsonPath && fs.existsSync(dashboardJsonPath)) {
    pushes.push(upsertFile(
      octokit, owner, repo,
      `reports/${baseName}.dashboard.json`,
      fs.readFileSync(dashboardJsonPath),
      `portal: ${baseName} dashboard.json`,
    ));
  }

  await Promise.all(pushes);

  // Build a manifest entry for the canonical dashboard row. Fixed id so
  // it always replaces rather than accumulating.
  const ag = dashboardSidecar?.aggregateCounts || {};
  const projectCount = dashboardSidecar?.projectCount || 0;

  // Tally real per-severity counts from the sidecar's remainingFindings array.
  // Each entry already carries severity (set at the build site around line 203);
  // the prior placeholder dumped everything into 'medium' which caused the Level 1
  // portal to suppress chip display via the guard at portal-ejwisner.html:878.
  // The Level 1 guard STAYS IN PLACE as defense in depth — see
  // TODO-publisher-dashboard-severity.md. Unknown/missing severity is silently
  // dropped (not bucketed into 'medium' or 'low') so displayed counts strictly
  // reflect findings the parser successfully classified. findingsTotal below
  // still uses ag.totalRemaining, which counts everything regardless.
  const dashSev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of (dashboardSidecar?.remainingFindings || [])) {
    const k = String(f.severity || '').toLowerCase().trim();
    if (dashSev[k] !== undefined) dashSev[k]++;
  }

  const entry = {
    id:                    'dashboard__rollup__canonical',
    mode:                  'dashboard',
    modeLabel:             'Project Dashboard',
    project:               'All projects',
    label:                 'All projects',
    generated:             new Date(scanIso).toLocaleString(),
    generatedIso:          scanIso,
    tool:                  'Ghost Architect',
    filesAnalyzed:         null,
    summary:               projectCount > 0
      ? `Cross-project remediation rollup. ${projectCount} project${projectCount === 1 ? '' : 's'} tracked, ${ag.totalRemaining || 0} findings remaining of ${ag.totalBaseline || 0} baseline (${ag.avgProgress || 0}% average remediation).`
      : 'No labeled projects yet. Run a scan with a project label to start tracking remediation.',
    severityCounts:        dashSev,
    findingsTotal:         ag.totalRemaining || 0,
    hasStructuredFindings: true,
    // Custom dashboard fields the portal will look for when mode==='dashboard'.
    dashboard: {
      projectCount,
      aggregateCounts: ag,
    },
    files: {
      md:        `reports/${baseName}.md`,
      pdf:       `reports/${baseName}.pdf`,
      txt:       `reports/${baseName}.txt`,
      findings:  `reports/${baseName}.dashboard.json`,
    },
  };

  await updateManifest(octokit, owner, repo, entry, { forcePush });

  return { ok: true, baseName, entry };
}
