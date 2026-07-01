/**
 * Ghost Architect — Core Project Intelligence
 * Pure project management logic. No Chalk. No Inquirer. Returns data.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractFindings as extractFindingsFromReport } from '../utils/finding-parser.js';

const PROJECTS_DIR = path.join(os.homedir(), 'Ghost Architect Reports', 'projects');

// ── Directory helpers ─────────────────────────────────────────────────────────

export function ensureProjectsDir() {
  if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

function projectDir(label) {
  const safe = slugify(label);
  const dir  = path.join(PROJECTS_DIR, safe);
  if (!dir.startsWith(PROJECTS_DIR)) {
    throw new Error('Invalid project label - path traversal detected: ' + label);
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadProjectMeta(label) {
  const file = path.join(projectDir(label), 'project.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function saveProjectMeta(label, meta) {
  ensureProjectsDir();
  fs.writeFileSync(path.join(projectDir(label), 'project.json'), JSON.stringify(meta, null, 2));
}

// ── Public: list projects ─────────────────────────────────────────────────────

export function listProjects() {
  ensureProjectsDir();
  return fs.readdirSync(PROJECTS_DIR)
    .filter(f => fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory())
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f, 'project.json'), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.lastScan) - new Date(a.lastScan));
}

// ── Fuzzy matching ────────────────────────────────────────────────────────────

export function slugify(s) {
  return s.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
}

export function fuzzyMatch(input, existing) {
  const inputSlug = slugify(input);
  const exact = existing.find(p => slugify(p.label) === inputSlug);
  if (exact) return exact;
  const sub = existing.find(p =>
    slugify(p.label).includes(inputSlug) || inputSlug.includes(slugify(p.label))
  );
  if (sub) return sub;
  const inputWords = new Set(inputSlug.split('-').filter(w => w.length > 2));
  for (const p of existing) {
    const pWords  = new Set(slugify(p.label).split('-').filter(w => w.length > 2));
    const overlap = [...inputWords].filter(w => pWords.has(w)).length;
    if (inputWords.size > 0 && overlap / inputWords.size >= 0.6) return p;
  }
  return null;
}

// ── Finding extraction ────────────────────────────────────────────────────────
// Delegates to the canonical extractFindings() in src/utils/finding-parser.js.
// The local implementation that used to live here had its own brittle regex
// approach (\*?\*? inline encoding) and a 'severity: UNKNOWN' default that
// dominated the project intelligence rollup whenever the regex failed to
// match — the root cause of the 71% UNKNOWN severity issue documented in
// TODO-architect-projects-severity-extraction.md. Replacing this local
// parser with the canonical one eliminates the UNKNOWN string at its source,
// adds files/detail/id fields the downstream consumers (mobile-publish,
// portal-publish) already know how to use, and ensures any future parser
// improvement applies uniformly to project intelligence.
//
// See finding-parser.js header comment for the pre-strip architecture
// rationale. The 'Finding 16' note there documents this exact consolidation
// pattern applied previously to multipass.js, analyst/index.js, and
// pdf-generator.js — core/projects.js was the last holdout.

export { extractFindingsFromReport };

function similarFinding(a, b) {
  const norm = s => s.toLowerCase().replace(/^\d+\.\s+/, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const na = norm(a.title), nb = norm(b.title);
  if (na === nb) return true;
  const wa = new Set(na.split(' ').filter(w => w.length > 3));
  const wb = new Set(nb.split(' ').filter(w => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return false;
  const intersection = [...wa].filter(w => wb.has(w)).length;
  // Symmetric: use min(|wa|, |wb|) as denominator so similarFinding(a, b) === similarFinding(b, a).
  // The previous wa.size-only denominator made matching depend on argument order, producing
  // user-visible "math doesn't add up" between the resolved/remaining filters (baseline-anchored)
  // and the newIssues filter (current-anchored). See TODO-projects-similar-finding-asymmetry.md.
  return intersection / Math.min(wa.size, wb.size) >= 0.6;
}

// ── Project intelligence ──────────────────────────────────────────────────────

/**
 * Save project intelligence for a scan.
 * Returns an object describing what happened: { type: 'baseline'|'comparison', ...data }
 */
export function saveProjectIntelligence(label, reportText, meta) {
  if (!label) return null;

  // Use pre-extracted findings when the caller supplies them via meta.
  // Prompt Triage uses this path because its report shape differs from POI's
  // (different headers, severity tags, location format). POI / Blast / Conflict
  // continue using the markdown extractor — when meta.findings is undefined,
  // we fall back to extractFindingsFromReport(reportText).
  const findings   = (meta && Array.isArray(meta.findings))
    ? meta.findings
    : extractFindingsFromReport(reportText);
  const existing   = loadProjectMeta(label);
  const scanDate   = new Date().toISOString();
  const scanFile   = `scan-${scanDate.slice(0,10)}-${Date.now()}.json`;

  // Save individual scan record
  const scanRecord = {
    date:        scanDate,
    findings,
    meta,
    reportFile:  scanFile,
    findingCount: findings.length,
    resolved:    0,
    reportText:  (meta && meta.reportText)  || '',
    critical:    (meta && meta.critical)    || 0,
    high:        (meta && meta.high)        || 0,
    medium:      (meta && meta.medium)      || 0,
    low:         (meta && meta.low)         || 0,
    totalHours:  (meta && meta.totalHours)  || null,
    totalCost:   (meta && meta.totalCost)   || null,
    txtFile:     (meta && meta.txtFile)     || null,
    mdFile:      (meta && meta.mdFile)      || null,
    pdfFile:     (meta && meta.pdfFile)     || null,
    version:     (meta && meta.version)     || null,
    newFindings: (meta && meta.newFindings) || 0,
  };
  fs.writeFileSync(
    path.join(projectDir(label), scanFile),
    JSON.stringify(scanRecord, null, 2)
  );

  if (!existing) {
    // First scan — establish baseline
    const projectMeta = {
      label,
      createdAt:        scanDate,
      lastScan:         scanDate,
      baselineDate:     scanDate,
      baselineFindings: findings,
      scanCount:        1,
      scans:            [{ date: scanDate, file: scanFile, findingCount: findings.length }],
      rates:            meta.rates || null,
    };
    saveProjectMeta(label, projectMeta);
    return { type: 'baseline', findingCount: findings.length };
  }

  // Subsequent scan — compare against baseline
  const baseline  = existing.baselineFindings;
  const resolved  = baseline.filter(f => !findings.some(n => similarFinding(f, n)));
  const newIssues = findings.filter(f => !baseline.some(b => similarFinding(f, b)));
  const remaining = baseline.filter(f => findings.some(n => similarFinding(f, n)));
  const progress  = baseline.length > 0 ? Math.round((resolved.length / baseline.length) * 100) : 0;

  // Update project meta
  existing.lastScan  = scanDate;
  existing.scanCount = (existing.scanCount || 1) + 1;
  existing.scans     = existing.scans || [];
  existing.scans.push({ date: scanDate, file: scanFile, findingCount: findings.length, resolved: resolved.length, newIssues: newIssues.length });
  saveProjectMeta(label, existing);

  // Velocity trend
  let velocity = null;
  if (existing.scans.length >= 3) {
    const recent     = existing.scans.slice(-3);
    const avgResolved = Math.round(recent.reduce((s, sc) => s + (sc.resolved || 0), 0) / recent.length);
    const scansToFix  = avgResolved > 0 && remaining.length > 0 ? Math.ceil(remaining.length / avgResolved) : null;
    velocity = { avgResolved, scansToFix };
  }

  return {
    type:          'comparison',
    label,
    baselineDate:  existing.baselineDate,
    scanDate,
    baselineCount: baseline.length,
    findingCount:  findings.length,
    resolved:      resolved.length,
    remaining:     remaining.length,
    newIssues:     newIssues.length,
    newIssuesList: newIssues.slice(0, 3),
    newIssuesMore: Math.max(0, newIssues.length - 3),
    progress,
    velocity,
  };
}

// ── Dashboard data ────────────────────────────────────────────────────────────

export function getProjectDashboardData() {
  const projects = listProjects();
  return projects.map(p => {
    const baseline = (p.baselineFindings || []).length;
    const lastScan = p.scans?.[p.scans.length - 1];

    // Progress reflects the latest scan's resolved-against-baseline count,
    // not a cumulative sum across scans. Each scan's `resolved` field is
    // already computed as `baseline.filter(f => !findings.some(...))`, so
    // the latest scan's value IS the current count. Summing produced
    // values like 200% or 500% on projects with multiple scans, which
    // crashed the bar renderer when filled > 20 made empty negative.
    const resolved = lastScan?.resolved ?? 0;

    // Clamp progress to [0, 100] so a malformed scan record (e.g. resolved
    // greater than baseline due to a similarity-match flake) can never
    // produce an out-of-range value that the renderer must defend against.
    const rawProgress = baseline > 0 ? Math.round((resolved / baseline) * 100) : 0;
    const progress = Math.max(0, Math.min(100, rawProgress));

    return {
      label:       p.label,
      baselineDate: p.baselineDate?.slice(0, 10),
      lastScan:    p.lastScan?.slice(0, 10),
      scanCount:   p.scanCount,
      baseline,
      resolved,
      progress,
      newIssues:   lastScan?.newIssues || 0,
    };
  });
}
