/**
 * Ghost Architect Web — Core Bridge
 * Reads from ~/Ghost Architect Reports/ and wraps core logic for Next.js API routes.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export const REPORTS_DIR  = path.join(os.homedir(), 'Ghost Architect Reports');
export const PROJECTS_DIR = path.join(REPORTS_DIR, 'projects');

export interface ReportFile {
  name:        string;
  displayName: string;
  filePath:    string;
  date:        string;
  size:        number;
  type:        'poi' | 'blast' | 'conflict' | 'compare' | 'unknown';
  ext:         'md' | 'txt';
}

export function listReports(): ReportFile[] {
  if (!fs.existsSync(REPORTS_DIR)) return [];

  const all = fs.readdirSync(REPORTS_DIR)
    .filter(f => (f.endsWith('.md') || f.endsWith('.txt')) && !f.startsWith('.'))
    .map(f => {
      const full  = path.join(REPORTS_DIR, f);
      const stat  = fs.statSync(full);
      const lower = f.toLowerCase();
      let type: ReportFile['type'] = 'unknown';
      if (lower.includes('poi'))      type = 'poi';
      if (lower.includes('blast'))    type = 'blast';
      if (lower.includes('conflict')) type = 'conflict';
      if (lower.includes('compare'))  type = 'compare';

      const stem    = f.replace(/\.(md|txt)$/, '');
      const parts   = stem.split('-');
      const dateIdx = parts.findIndex(p => /^\d{4}$/.test(p));
      const slice   = dateIdx > 1 ? parts.slice(1, dateIdx) : parts.slice(1);
      let displayName = slice.join('-') || stem;

      // For compare reports, extract project name from file content
      if (type === 'compare' && displayName === 'compare') {
        try {
          const firstLines = fs.readFileSync(full, 'utf8').split('\n').slice(0, 5).join('\n');
          const m = firstLines.match(/(?:Before|After):\s+ghost-[a-z]+-([a-z0-9_-]+?)-\d{4}/i);
          if (m) displayName = 'compare-' + m[1];
        } catch {}
      }

      return { name: f, displayName, filePath: full, date: stat.mtime.toISOString(), size: stat.size, type, ext: f.endsWith('.md') ? 'md' : 'txt' as 'md' | 'txt' };
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const seen = new Map<string, ReportFile>();
  for (const r of all) {
    const key = r.name.replace(/\.(md|txt)$/, '');
    const existing = seen.get(key);
    if (!existing || r.ext === 'md') seen.set(key, r);
  }
  return Array.from(seen.values());
}

export function readReport(filename: string): string | null {
  const safe = path.basename(filename);
  const full = path.join(REPORTS_DIR, safe);
  if (!fs.existsSync(full)) return null;
  try { return fs.readFileSync(full, 'utf8'); } catch { return null; }
}

export interface ProjectSummary {
  label: string; baselineDate: string; lastScan: string; scanCount: number;
  baseline: number; resolved: number; progress: number; newIssues: number;
  scans: Array<{ date: string; findingCount: number; resolved: number; newIssues: number }>;
}

export function listProjectSummaries(): ProjectSummary[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR)
    .filter(f => fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory())
    .map(f => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f, 'project.json'), 'utf8'));
        const baseline = (meta.baselineFindings || []).length;
        const totalResolved = (meta.scans || []).reduce((s: number, sc: any) => s + (sc.resolved || 0), 0);
        const progress = baseline > 0 ? Math.round((totalResolved / baseline) * 100) : 0;
        const lastScan = (meta.scans || []).slice(-1)[0];
        const newIssues = typeof lastScan?.newIssues === 'number' ? lastScan.newIssues : 0;
        return {
          label: meta.label, baselineDate: meta.baselineDate?.slice(0, 10) || '',
          lastScan: meta.lastScan?.slice(0, 10) || '', scanCount: meta.scanCount || 1,
          baseline, resolved: totalResolved, progress: Math.min(100, progress), newIssues,
          scans: (meta.scans || []).map((sc: any) => ({
            date: sc.date?.slice(0, 10) || '', findingCount: sc.findingCount || 0,
            resolved: sc.resolved || 0, newIssues: sc.newIssues || 0,
          })),
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => new Date(b.lastScan).getTime() - new Date(a.lastScan).getTime()) as ProjectSummary[];
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000), hours = Math.floor(diff / 3600000), days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export function modeLabel(type: ReportFile['type']): string {
  switch (type) {
    case 'poi': return '🗺  Points of Interest';
    case 'blast': return '💥 Blast Radius';
    case 'conflict': return '⚡ Conflict Detection';
    case 'compare': return '🔍 Compare';
    default: return '📄 Report';
  }
}
