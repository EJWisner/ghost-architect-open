/**
 * Ghost Architect™ — Mobile Publish Engine
 * Pushes structured scan data to a private GitHub reports repo.
 * The Ghost Mobile app reads from this repo to display the portfolio dashboard.
 *
 * Repo structure in ghost-reports:
 *   projects/
 *     <project-slug>/
 *       latest.json        ← always the most recent scan
 *       2026-04-15.json    ← date-stamped archive
 *   index.json             ← portfolio overview (all projects, all seats)
 *
 * Security model:
 *   - CLI uses a write PAT to push data
 *   - Mobile app uses a read-only PAT to pull data
 *   - Code never leaves the machine — only structured JSON is published
 */

import { createOctokit } from '../utils/octokit-client.js';
import Configstore from 'configstore';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractFindings } from '../utils/finding-parser.js';
import { parseRepo } from './team-sync.js';

const config = new Configstore('ghost-architect');

// Shared content encoder for GitHub API file writes.
// Buffer → raw bytes; string → UTF-8; object → JSON.stringify then UTF-8.
function encodeFileContent(content) {
  if (Buffer.isBuffer(content)) return content.toString('base64');
  if (typeof content === 'string') return Buffer.from(content, 'utf8').toString('base64');
  return Buffer.from(JSON.stringify(content, null, 2), 'utf8').toString('base64');
}

// ── Config ────────────────────────────────────────────────────────────────────

export function getPublishConfig() {
  return config.get('mobilePublish') || null;
}

export function setPublishConfig({ repo, token }) {
  config.set('mobilePublish', { repo, token });
}

export function isPublishConfigured() {
  const cfg = getPublishConfig();
  return !!(cfg?.repo && cfg?.token);
}

// ── Octokit helpers ───────────────────────────────────────────────────────────

function getOctokit() {
  const cfg = getPublishConfig();
  if (!cfg) throw new Error('Ghost Mobile publish not configured. Run ghost --configure-publish.');
  return createOctokit({ auth: cfg.token });
}

async function getFileSha(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    return data.sha;
  } catch { return null; }
}

async function upsertFile(octokit, owner, repo, filePath, content, message) {
  const sha = await getFileSha(octokit, owner, repo, filePath);
  const encoded = encodeFileContent(content);
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
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { content, sha: data.sha };
  } catch { return { content: null, sha: null }; }
}

// ── Seat identity ─────────────────────────────────────────────────────────────

function getSeatId() {
  return `${os.userInfo().username}@${os.hostname()}`;
}

// ── Finding parser ───────────────────────────────────────────────────────────

/**
 * Parse findings from report text for the mobile payload.
 * Delegates to the shared finding parser — single source of truth.
 * Maps to the Ghost Mobile Finding interface.
 */
function parseFindings(reportText) {
  if (!reportText) return [];
  const findings = extractFindings(reportText);
  return findings.map(f => ({
    title:       f.title,
    severity:    f.severity,
    files:       f.files || [],
    effort:      f.effortHours ? `${f.effortHours} hours` : null,
    cost:        null,
    description: f.detail || '',
  }));
}

/**
 * Map baseline findings to mobile Finding interface.
 * Used for resolved findings drill-down in Ghost Mobile.
 */
function mapBaselineFindings(baselineFindings) {
  if (!baselineFindings || !baselineFindings.length) return [];
  return baselineFindings.map(f => ({
    title:       f.title       || '',
    severity:    f.severity    || 'MEDIUM',
    files:       f.files       || [],
    effort:      f.effortHours ? `${f.effortHours} hours` : null,
    cost:        null,
    description: f.detail      || '',
    id:          f.id          || null,
  }));
}

// ── Publish ───────────────────────────────────────────────────────────────────

/**
 * Build the structured JSON payload from a project's scan data.
 * This is what the mobile app reads.
 */
function buildPublishPayload(projectMeta, scanRecord) {
  const current  = scanRecord.findingCount ?? scanRecord.meta?.findingCount ?? 0;
  const baseline    = projectMeta.baselineCount || 0;
  const hasBaseline = baseline > 0 && baseline !== current;

  const resolved = (hasBaseline && scanRecord.resolved != null)
    ? scanRecord.resolved
    : 0;

  const progress = (hasBaseline && baseline > 0)
    ? Math.round((resolved / baseline) * 100)
    : 0;

  // Parse current findings from report text
  const currentFindings = parseFindings(scanRecord.reportText || '');

  // Baseline findings — published so mobile can show resolved drill-down
  const baselineFindings = mapBaselineFindings(projectMeta.baselineFindings || []);

  // Compute resolved and new finding lists for tappable stats
  // Resolved = in baseline but not in current (by ID or fuzzy)
  // New = in current but not in baseline
  const resolvedFindings = baselineFindings.filter(bf => {
    if (bf.id) return !currentFindings.some(cf => cf.id === bf.id);
    return !currentFindings.some(cf =>
      cf.title.toLowerCase().trim() === bf.title.toLowerCase().trim()
    );
  });

  const newFindings = currentFindings.filter(cf => {
    if (cf.id) return !baselineFindings.some(bf => bf.id === cf.id);
    return !baselineFindings.some(bf =>
      bf.title.toLowerCase().trim() === cf.title.toLowerCase().trim()
    );
  });

  // Build scan history from projectMeta.scans — real data, not empty array
  const scanHistory = (projectMeta.scans || []).slice(-20).map(s => ({
    date:          s.date,
    findingCount:  s.findingCount,
    resolved:      s.resolved      || 0,
    newIssues:     s.newIssues     || 0,
    percentComplete: baseline > 0 && s.resolved != null
      ? Math.round((s.resolved / baseline) * 100)
      : 0,
    cost:          s.cost          || null,
  }));

  return {
    project:      projectMeta.label || 'Unnamed Project',
    slug:         projectMeta.slug  || 'unnamed',
    scanDate:     scanRecord.date   || new Date().toISOString(),
    publishedAt:  new Date().toISOString(),
    publishedBy:  getSeatId(),
    version:      scanRecord.version || '4.7.0',

    summary: {
      totalFindings:  current,
      critical:       scanRecord.critical   ?? scanRecord.meta?.critical   ?? 0,
      high:           scanRecord.high       ?? scanRecord.meta?.high       ?? 0,
      medium:         scanRecord.medium     ?? scanRecord.meta?.medium     ?? 0,
      low:            scanRecord.low        ?? scanRecord.meta?.low        ?? 0,
      // Preserve null/undefined so mobile can distinguish "not parsed" from "zero".
      // Mobile should render null as "—" rather than "$0".
      estimatedHours: scanRecord.totalHours != null ? scanRecord.totalHours : (scanRecord.meta?.totalHours ?? null),
      estimatedCost:  scanRecord.totalCost  != null ? scanRecord.totalCost  : (scanRecord.meta?.totalCost  ?? null),
    },

    baseline: {
      totalFindings:   baseline,
      scanDate:        projectMeta.baselineDate || null,
      hasBaseline,
    },

    progress: {
      resolved,
      remaining:       current,
      new:             scanRecord.newFindings || 0,
      percentComplete: progress,
      hasBaseline,
    },

    reportFiles: {
      txt: scanRecord.txtFile || null,
      md:  scanRecord.mdFile  || null,
      pdf: scanRecord.pdfFile || null,
    },

    // Real scan history — populated from project.json scan records
    scanHistory,

    // Current scan findings
    findings: currentFindings,

    // Baseline findings — enables resolved drill-down in Ghost Mobile
    baselineFindings,

    // Pre-computed finding lists for tappable stats
    resolvedFindings,
    newFindings,
  };
}

/**
 * Publish the latest scan for a project to the ghost-reports repo.
 */
export async function publishProject(projectMeta, scanRecord) {
  if (!isPublishConfigured()) return { ok: false, reason: 'not_configured' };

  const cfg = getPublishConfig();
  const octokit = getOctokit();
  const { owner, repo } = parseRepo(cfg.repo);
  const slug = (projectMeta.slug || projectMeta.label || 'unnamed')
    .replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);

  const payload = buildPublishPayload(projectMeta, scanRecord);
  const dateStr = new Date().toISOString().slice(0, 10);

  await upsertFile(
    octokit, owner, repo,
    `projects/${slug}/latest.json`,
    payload,
    `publish: ${slug} latest scan`
  );

  await upsertFile(
    octokit, owner, repo,
    `projects/${slug}/${dateStr}.json`,
    payload,
    `publish: ${slug} ${dateStr}`
  );

  await updateIndex(octokit, owner, repo, slug, payload);

  return { ok: true, slug, repo: cfg.repo };
}

/**
 * Update the portfolio index.
 */
async function updateIndex(octokit, owner, repo, slug, payload) {
  const { content: existing } = await getFileContent(octokit, owner, repo, 'index.json');
  const projects = (existing && existing.projects) || [];

  const idx = projects.findIndex(p => p.slug === slug);
  const entry = {
    slug,
    project:         payload.project,
    lastScan:        payload.scanDate,
    publishedAt:     payload.publishedAt,
    publishedBy:     payload.publishedBy,
    totalFindings:   payload.summary.totalFindings,
    critical:        payload.summary.critical,
    high:            payload.summary.high,
    percentComplete: payload.progress.percentComplete,
    hasBaseline:     payload.progress.hasBaseline,
    estimatedHours:  payload.summary.estimatedHours,
    estimatedCost:   payload.summary.estimatedCost,
    newFindings:     payload.progress.new,
  };

  if (idx >= 0) {
    projects[idx] = entry;
  } else {
    projects.push(entry);
  }

  projects.sort((a, b) => new Date(b.lastScan) - new Date(a.lastScan));

  await upsertFile(
    octokit, owner, repo,
    'index.json',
    {
      updatedAt: new Date().toISOString(),
      totalProjects: projects.length,
      projects,
    },
    `publish: update portfolio index`
  );
}

export async function testPublishConnection() {
  const cfg = getPublishConfig();
  if (!cfg) return { ok: false, error: 'Not configured. Run ghost --configure-publish.' };
  try {
    const octokit = getOctokit();
    const { owner, repo } = parseRepo(cfg.repo);
    await octokit.rest.repos.get({ owner, repo });
    return { ok: true, repo: cfg.repo };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function listPublishedProjects() {
  const cfg = getPublishConfig();
  if (!cfg) return [];
  try {
    const octokit = getOctokit();
    const { owner, repo } = parseRepo(cfg.repo);
    const { content: index } = await getFileContent(octokit, owner, repo, 'index.json');
    return index?.projects || [];
  } catch { return []; }
}
