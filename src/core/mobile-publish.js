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
import { getConfig, secureConfigFile } from '../config.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractFindings } from '../utils/finding-parser.js';
import { parseRepo } from './team-sync.js';

const config = getConfig();

// Shared content encoder for GitHub API file writes.
// Buffer → raw bytes; string → UTF-8; object → JSON.stringify then UTF-8.
function encodeFileContent(content) {
  if (Buffer.isBuffer(content)) return content.toString('base64');
  if (typeof content === 'string') return Buffer.from(content, 'utf8').toString('base64');
  return Buffer.from(JSON.stringify(content, null, 2), 'utf8').toString('base64');
}

// ── Config ────────────────────────────────────────────────────────────────────

// The GitHub PAT is stored in the OS keychain when one is reachable, and only
// falls back to the (chmod-600) configstore when it is not. keytar is loaded
// LAZILY and OPTIONALLY -- it is deliberately NOT a hard dependency, because it
// is a native, now-unmaintained module and forcing it on every `npm install -g`
// would break installs that lack build tools (or libsecret on Linux). If it is
// present and works, we get keychain security; if not, we degrade cleanly.
const KEYCHAIN_SERVICE = 'ghost-architect';
const KEYCHAIN_ACCOUNT_GITHUB = 'mobile-publish-pat';

let _keytarChecked = false;
let _keytar = null;
async function loadKeytar() {
  if (_keytarChecked) return _keytar;
  _keytarChecked = true;
  try {
    const mod = await import('keytar');
    _keytar = mod.default || mod;
  } catch {
    _keytar = null; // not installed, or native binding / libsecret unavailable
  }
  return _keytar;
}

// Config here holds only non-secret fields: { repo, inKeychain }. In keychain
// mode the token lives in the OS keychain (not in this JSON). In fallback mode
// the token is stored inline (with 0600 perms). getPublishConfig stays SYNC and
// never returns the real secret in keychain mode -- use getPublishToken() for
// the actual PAT.
export function getPublishConfig() {
  return config.get('mobilePublish') || null;
}

// Resolve the actual GitHub PAT. Async because keychain access is async.
// Returns null when nothing is stored. Also transparently MIGRATES a legacy
// plaintext token into the keychain on first use when a keychain is available,
// so existing installs are upgraded without the user re-running setup.
export async function getPublishToken() {
  const cfg = config.get('mobilePublish');
  if (!cfg) return null;

  if (cfg.inKeychain) {
    const keytar = await loadKeytar();
    if (keytar) {
      try {
        const token = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_GITHUB);
        if (token) return token;
      } catch { /* keychain unreadable -- fall through to any remnant below */ }
    }
    return cfg.token || null;
  }

  // Plaintext mode. If a keychain is now available, migrate the token into it
  // and drop the plaintext copy (best-effort; keep working either way).
  const token = cfg.token || null;
  if (token) {
    const keytar = await loadKeytar();
    if (keytar) {
      try {
        await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_GITHUB, token);
        config.set('mobilePublish', { repo: cfg.repo, inKeychain: true });
        secureConfigFile();
      } catch { /* migration best-effort; keep using the plaintext token */ }
    }
  }
  return token;
}

// Store the repo + PAT. Async: keychain writes are async. Prefers the OS
// keychain; falls back to a chmod-600 plaintext store with an explicit warning.
export async function setPublishConfig({ repo, token }) {
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_GITHUB, token);
      // Persist only the repo + a keychain sentinel; never the plaintext token.
      config.set('mobilePublish', { repo, inKeychain: true });
      secureConfigFile();
      return { secure: true };
    } catch { /* keychain write failed at runtime -- fall back below */ }
  }
  // Fallback: chmod-600 plaintext. Warn so the user knows the token is on disk.
  config.set('mobilePublish', { repo, token, inKeychain: false });
  secureConfigFile();
  console.warn(
    'Warning: OS keychain unavailable. GitHub token stored with owner-only (0600) file permissions.'
  );
  return { secure: false };
}

export function isPublishConfigured() {
  const cfg = getPublishConfig();
  // Configured when we have a repo AND a token reachable either in the keychain
  // (inKeychain flag) or inline (fallback). Stays synchronous so existing
  // callers (reports.js, poi.js) do not need to change.
  return !!(cfg?.repo && (cfg.token || cfg.inKeychain));
}

// ── Octokit helpers ───────────────────────────────────────────────────────────

async function getOctokit() {
  const cfg = getPublishConfig();
  if (!cfg) throw new Error('Ghost Mobile publish not configured. Run ghost --configure-publish.');
  const token = await getPublishToken();
  if (!token) {
    throw new Error('Ghost Mobile publish token not found (keychain empty or config missing). Re-run ghost --configure-publish.');
  }
  return createOctokit({ auth: token });
}

// Wrap a single GitHub API call so a rate-limit (secondary or primary) 403
// backs off until the limit resets and retries once, instead of failing the
// publish. Non-rate-limit errors propagate unchanged.
async function withRateLimit(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 403 &&
        err.message.includes('rate limit')) {
      const reset = err.response?.headers?.[
        'x-ratelimit-reset'
      ];
      const waitMs = reset
        ? (parseInt(reset) * 1000) - Date.now() + 1000
        : 60000;
      console.warn(
        '[Ghost Mobile] GitHub rate limit hit. ' +
        'Waiting ' + Math.ceil(waitMs / 1000) +
        's before retry.'
      );
      await new Promise(r => setTimeout(r, waitMs));
      return await fn();
    }
    throw err;
  }
}

async function getFileSha(octokit, owner, repo, filePath) {
  try {
    const { data } = await withRateLimit(() => octokit.rest.repos.getContent({ owner, repo, path: filePath }));
    return data.sha;
  } catch { return null; }
}

async function upsertFile(octokit, owner, repo, filePath, content, message) {
  const sha = await getFileSha(octokit, owner, repo, filePath);
  const encoded = encodeFileContent(content);
  await withRateLimit(() => octokit.rest.repos.createOrUpdateFileContents({
    owner, repo,
    path: filePath,
    message,
    content: encoded,
    ...(sha ? { sha } : {}),
  }));
}

async function deleteFile(octokit, owner, repo, filePath, message) {
  const sha = await getFileSha(octokit, owner, repo, filePath);
  if (!sha) return; // nothing to delete
  await withRateLimit(() => octokit.rest.repos.deleteFile({
    owner, repo, path: filePath, message, sha,
  }));
}

async function getFileContent(octokit, owner, repo, filePath) {
  try {
    const { data } = await withRateLimit(() => octokit.rest.repos.getContent({ owner, repo, path: filePath }));
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

// Name of the in-repo marker that records a publish-in-progress. Its presence
// on entry means a previous publishProject() was interrupted between writes.
const PENDING_MARKER = '_pending.json';

/**
 * Finish an interrupted publish recorded by a _pending.json marker, then clear
 * the marker. The marker carries the payload and the exact target paths, so the
 * three writes can be replayed idempotently. If the marker predates this field
 * (payload absent), there is nothing to replay — just clear the stale marker so
 * a fresh publish can proceed against consistent state.
 */
async function completeInterruptedPublish(octokit, owner, repo, marker) {
  if (marker?.payload && marker.latestPath && marker.datedPath) {
    await upsertFile(octokit, owner, repo, marker.latestPath, marker.payload,
      `publish: resume ${marker.slug} latest scan`);
    await upsertFile(octokit, owner, repo, marker.datedPath, marker.payload,
      `publish: resume ${marker.slug} ${marker.dateStr}`);
    await updateIndex(octokit, owner, repo, marker.slug, marker.payload);
  }
  await deleteFile(octokit, owner, repo, PENDING_MARKER, 'publish: clear pending marker');
}

/**
 * Force-clear a stuck _pending.json marker in the reports repo. Backs the
 * `ghost --force-clear-markers` escape hatch for when a marker somehow survives
 * the automatic stale-marker cleanup. Returns { ok, reason }.
 */
export async function clearPendingMarker() {
  if (!isPublishConfigured()) return { ok: false, reason: 'not_configured' };
  const cfg = getPublishConfig();
  const octokit = await getOctokit();
  const { owner, repo } = parseRepo(cfg.repo);
  const { content: existingMarker } = await getFileContent(octokit, owner, repo, PENDING_MARKER);
  if (!existingMarker) return { ok: true, reason: 'no_marker' };
  await deleteFile(octokit, owner, repo, PENDING_MARKER, 'publish: force-clear pending marker');
  return { ok: true, reason: 'cleared', slug: existingMarker.slug || null };
}

/**
 * Publish the latest scan for a project to the ghost-reports repo.
 *
 * The three writes (latest.json, date-stamped archive, index.json) are not a
 * single atomic transaction on GitHub, so a crash between them would leave the
 * repo inconsistent. A _pending.json marker written before the first write and
 * deleted after the last one makes the interruption recoverable: the next
 * publishProject() sees the marker, replays the recorded writes, and clears it
 * before starting the new publish.
 */
export async function publishProject(projectMeta, scanRecord) {
  if (!isPublishConfigured()) return { ok: false, reason: 'not_configured' };

  const cfg = getPublishConfig();
  const octokit = await getOctokit();
  const { owner, repo } = parseRepo(cfg.repo);

  // Recover an interrupted previous publish before starting a new one.
  const { content: existingMarker } = await getFileContent(octokit, owner, repo, PENDING_MARKER);
  if (existingMarker && existingMarker.slug) {
    // Stale-marker guard: a marker older than 1 hour is from a publish that will
    // never resume. Clear it rather than retrying recovery on every future
    // publish, which would otherwise block publishing indefinitely. A marker
    // with no startedAt is treated as stale for the same reason.
    const startedMs = existingMarker.startedAt ? new Date(existingMarker.startedAt).getTime() : 0;
    const markerAge = startedMs ? Date.now() - startedMs : Infinity;
    if (markerAge > 3600000) { // 1 hour
      try {
        await deleteFile(octokit, owner, repo, PENDING_MARKER, 'publish: clear stale pending marker');
      } catch (_) { /* best effort */ }
      console.warn(
        '[Ghost Mobile] Stale marker cleared ' +
        '(older than 1 hour).'
      );
    } else {
      console.warn(
        '[Ghost Mobile] Found incomplete previous publish ' +
        'for ' + existingMarker.slug + '. Completing it now.'
      );
      try {
        await completeInterruptedPublish(octokit, owner, repo, existingMarker);
      } catch (err) {
        // Recovery failed: clear the marker BEFORE warning so a persistently
        // failing recovery can't block every future publish forever.
        try {
          await deleteFile(octokit, owner, repo, PENDING_MARKER, 'publish: clear stale pending marker');
        } catch (_) { /* best effort */ }
        console.warn('[Ghost Mobile] Recovery failed: ' +
          (err?.message || err) + '. Stale marker cleared.');
      }
    }
  }

  const slug = (projectMeta.slug || projectMeta.label || 'unnamed')
    .replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);

  const payload = buildPublishPayload(projectMeta, scanRecord);
  const dateStr = new Date().toISOString().slice(0, 10);
  const latestPath = `projects/${slug}/latest.json`;
  const datedPath = `projects/${slug}/${dateStr}.json`;

  // Write the pending marker BEFORE the first write. It records the payload and
  // the exact paths so an interrupted run can be replayed by the next publish.
  await upsertFile(
    octokit, owner, repo,
    PENDING_MARKER,
    {
      slug,
      startedAt: new Date().toISOString(),
      files: [latestPath, datedPath, 'index.json'],
      // Extra fields (beyond the file list) let completeInterruptedPublish()
      // actually replay the writes rather than just clearing the marker.
      payload,
      dateStr,
      latestPath,
      datedPath,
    },
    `publish: begin ${slug}`
  );

  await upsertFile(
    octokit, owner, repo,
    latestPath,
    payload,
    `publish: ${slug} latest scan`
  );

  await upsertFile(
    octokit, owner, repo,
    datedPath,
    payload,
    `publish: ${slug} ${dateStr}`
  );

  await updateIndex(octokit, owner, repo, slug, payload);

  // All three writes succeeded — clear the marker.
  await deleteFile(octokit, owner, repo, PENDING_MARKER, `publish: clear pending marker for ${slug}`);

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
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(cfg.repo);
    await withRateLimit(() => octokit.rest.repos.get({ owner, repo }));
    return { ok: true, repo: cfg.repo };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function listPublishedProjects() {
  const cfg = getPublishConfig();
  if (!cfg) return [];
  try {
    const octokit = await getOctokit();
    const { owner, repo } = parseRepo(cfg.repo);
    const { content: index } = await getFileContent(octokit, owner, repo, 'index.json');
    return index?.projects || [];
  } catch { return []; }
}
