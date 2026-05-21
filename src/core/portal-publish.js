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

import { Octokit } from 'octokit';
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
  return new Octokit({ auth: cfg.token });
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

async function getFileContent(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  } catch { return null; }
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
  recon:         { label: 'Recon',              order: 4 },
  audit:         { label: 'Inheritance Audit',  order: 5 },
  inheritance:   { label: 'Inheritance Audit',  order: 5 },
  'prompt-triage':{ label: 'Prompt Triage',     order: 6 },
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
// Read the current manifest, add or replace the entry for this scan, recompute
// mode summaries, and push the updated manifest back. Last-write-wins for
// concurrent scans; this is fine because manual conflict resolution is rare
// at this scale.

async function updateManifest(octokit, owner, repo, newEntry) {
  const existing = await getFileContent(octokit, owner, repo, 'manifest.json') || {
    schema: 1,
    portal: getPortalConfig()?.slug || 'ejwisner',
    generatedAt: new Date().toISOString(),
    totalReports: 0,
    modeSummary: {},
    reports: [],
  };

  // Replace by id if present; otherwise prepend.
  const idx = (existing.reports || []).findIndex(r => r.id === newEntry.id);
  if (idx >= 0) {
    existing.reports[idx] = newEntry;
  } else {
    existing.reports = [newEntry, ...(existing.reports || [])];
  }

  // Sort: newest first by generatedIso.
  existing.reports.sort((a, b) => new Date(b.generatedIso) - new Date(a.generatedIso));

  // Recompute mode summary from the current reports list.
  const modeSummary = {};
  for (const [modeKey, info] of Object.entries(MODE_LABELS)) {
    if (modeKey === 'inheritance') continue;
    const matching = existing.reports.filter(r => r.mode === modeKey);
    modeSummary[modeKey] = {
      label:         info.label,
      order:         info.order,
      count:         matching.length,
      lastGenerated: matching.length > 0 ? matching[0].generatedIso : null,
    };
  }

  existing.generatedAt  = new Date().toISOString();
  existing.totalReports = existing.reports.length;
  existing.modeSummary  = modeSummary;

  await upsertFile(
    octokit, owner, repo,
    'manifest.json',
    JSON.stringify(existing, null, 2),
    `portal: update manifest (${newEntry.id})`,
  );
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
 */
export async function publishToPortal({
  baseName, mode, label,
  txtPath, mdPath, pdfPath, findingsJsonPath,
  reportText, scanIso,
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
  await updateManifest(octokit, owner, repo, entry);

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
 */
export async function publishDashboardToPortal({
  txtPath, mdPath, pdfPath, dashboardJsonPath, dashboardSidecar, scanIso,
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
    // For the dashboard, severityCounts holds the open-finding rollup so the
    // existing portal renderer can show it the same way it shows per-scan
    // severity. There's no per-severity tracking in the dashboard data model
    // yet, so all open findings land in 'medium' as a placeholder. (Future
    // improvement: tag each remaining finding with its actual severity.)
    severityCounts: {
      critical: 0,
      high:     0,
      medium:   ag.totalRemaining || 0,
      low:      0,
      info:     0,
    },
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

  await updateManifest(octokit, owner, repo, entry);

  return { ok: true, baseName, entry };
}
