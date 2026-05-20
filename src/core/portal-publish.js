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
 * Pro tier ships portal-publish but not team-sync or mobile-publish. Pro
 * users still benefit from web-portal access to their scans and the Jira
 * export buttons (findings.json sidecar drives those).
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
