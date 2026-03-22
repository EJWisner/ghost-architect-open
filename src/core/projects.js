/**
 * Ghost Architect — Core Project Intelligence
 * Pure project management logic. No Chalk. No Inquirer. Returns data.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const PROJECTS_DIR = path.join(os.homedir(), 'Ghost Architect Reports', 'projects');

// ── Directory helpers ─────────────────────────────────────────────────────────

export function ensureProjectsDir() {
  if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

function projectDir(label) {
  const safe = slugify(label);
  const dir  = path.join(PROJECTS_DIR, safe);
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

export function extractFindingsFromReport(reportText) {
  const findings  = [];
  const lines     = reportText.split('\n');
  const findingRe = /^(?:###\s+)?\d+\.\s+\*?\*?(.+?)\*?\*?$/;
  const severityRe = /\*?\*?Severity:\*?\*?\s*(CRITICAL|HIGH|MEDIUM|LOW)/i;
  const effortRe  = /Effort:\s*([\d–\-]+)\s*hours?/i;
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(findingRe);
    if (m) {
      if (current) findings.push(current);
      current = { title: m[1].replace(/\*\*/g, '').trim(), severity: 'UNKNOWN', effortHours: 0 };
    } else if (current) {
      const sm = trimmed.match(severityRe);
      if (sm) current.severity = sm[1].toUpperCase();
      const em = trimmed.match(effortRe);
      if (em) {
        const parts = em[1].split(/[–\-]/);
        current.effortHours = parseInt(parts[parts.length - 1]) || 0;
      }
    }
  }
  if (current) findings.push(current);
  return findings;
}

function similarFinding(a, b) {
  const norm = s => s.toLowerCase().replace(/^\d+\.\s+/, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const na = norm(a.title), nb = norm(b.title);
  if (na === nb) return true;
  const wa = new Set(na.split(' ').filter(w => w.length > 3));
  const wb = new Set(nb.split(' ').filter(w => w.length > 3));
  if (wa.size === 0) return false;
  return [...wa].filter(w => wb.has(w)).length / wa.size >= 0.6;
}

// ── Project intelligence ──────────────────────────────────────────────────────

/**
 * Save project intelligence for a scan.
 * Returns an object describing what happened: { type: 'baseline'|'comparison', ...data }
 */
export function saveProjectIntelligence(label, reportText, meta) {
  if (!label) return null;

  const findings   = extractFindingsFromReport(reportText);
  const existing   = loadProjectMeta(label);
  const scanDate   = new Date().toISOString();
  const scanFile   = `scan-${scanDate.slice(0,10)}-${Date.now()}.json`;

  // Save individual scan record
  const scanRecord = { date: scanDate, findings, meta, reportFile: scanFile };
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
    const resolved = p.scans?.reduce((s, sc) => s + (sc.resolved || 0), 0) || 0;
    const progress = baseline > 0 ? Math.round((resolved / baseline) * 100) : 0;
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
