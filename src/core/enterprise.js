/**
 * Ghost Architect™ — Enterprise Layer
 * Org-level config, admin controls, audit logging, usage reporting,
 * and white-label support. All data stored in the shared sync repo
 * under an `org/` directory — no Ghost servers involved.
 *
 * Sync repo structure:
 *   org/
 *     config.json       ← org name, API key, logo URL, plan
 *     seats.json        ← registered seats with roles
 *     audit.json        ← scan activity log
 */

import { createOctokit } from '../utils/octokit-client.js';
import { getDefaultTeamSync, resolveTeamSync } from '../config.js';
import os from 'os';

// ── Octokit helpers ───────────────────────────────────────────────────────────

function getOctokit(entry) {
  return createOctokit({ auth: entry.token });
}

function parseRepo(repoUrl) {
  const clean = repoUrl.replace('https://github.com/', '').replace(/\.git$/, '');
  const [owner, repo] = clean.split('/');
  return { owner, repo };
}

function resolveSyncEntry(workspace) {
  if (workspace) {
    const all = resolveTeamSync();
    return all.find(r => r.name === workspace) || null;
  }
  return getDefaultTeamSync();
}

async function getFileSha(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    return data.sha;
  } catch { return null; }
}

async function upsertFile(octokit, owner, repo, filePath, content, message) {
  const sha = await getFileSha(octokit, owner, repo, filePath);
  const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo, path: filePath, message, content: encoded,
    ...(sha ? { sha } : {}),
  });
}

async function getFileContent(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  } catch { return null; }
}

// ── Seat identity ─────────────────────────────────────────────────────────────

function getSeatId() {
  return `${os.userInfo().username}@${os.hostname()}`;
}

// ── Enterprise gate ───────────────────────────────────────────────────────────

/**
 * Check if the sync repo is an Enterprise repo.
 * Enterprise repos are created and named by Ghost Architect.
 * The repo name must contain 'enterprise' — Team repos do not.
 * This is the access gate. No enterprise repo = no enterprise features.
 *
 * You control who gets an enterprise repo. Stripe payment triggers
 * you to create the repo and grant access. No server needed.
 */
export async function isEnterpriseRepo(workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) return false;
  // Check repo name contains 'enterprise'
  const repoName = entry.repo.toLowerCase();
  if (!repoName.includes('enterprise')) return false;
  // Also verify we can actually access it
  try {
    const octokit = getOctokit(entry);
    const { owner, repo } = parseRepo(entry.repo);
    await octokit.rest.repos.get({ owner, repo });
    return true;
  } catch { return false; }
}

/**
 * Assert enterprise access. Throws with a clear message if not licensed.
 * Checks ALL configured workspaces — if any is an enterprise repo, unlocks.
 */
export async function assertEnterprise(workspace) {
  // If specific workspace given, check just that one
  if (workspace) {
    const licensed = await isEnterpriseRepo(workspace);
    if (!licensed) throw new Error(
      'Ghost Enterprise requires a dedicated enterprise sync repo.\n' +
      '  Your current repo is not an enterprise repo.\n\n' +
      '  To upgrade: contact support@ghostarchitect.dev\n' +
      '  Ghost Enterprise starts at $1,200/mo'
    );
    return;
  }
  // No workspace given — check all configured workspaces
  const all = resolveTeamSync();
  for (const entry of all) {
    const repoName = entry.repo.toLowerCase();
    if (repoName.includes('enterprise')) {
      try {
        const octokit = getOctokit(entry);
        const { owner, repo } = parseRepo(entry.repo);
        await octokit.rest.repos.get({ owner, repo });
        return; // Found a valid enterprise repo — access granted
      } catch { continue; }
    }
  }
  throw new Error(
    'Ghost Enterprise requires a dedicated enterprise sync repo.\n' +
    '  None of your configured workspaces are enterprise repos.\n\n' +
    '  To upgrade: contact support@ghostarchitect.dev\n' +
    '  Ghost Enterprise starts at $1,200/mo'
  );
}

// ── Org config ────────────────────────────────────────────────────────────────

/**
 * Read org config from sync repo.
 * Returns { orgName, apiKey, logoUrl, plan } or null.
 */
export async function getOrgConfig(workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) return null;
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  return await getFileContent(octokit, owner, repo, 'org/config.json');
}

/**
 * Save org config to sync repo. Admin only.
 */
export async function saveOrgConfig(config, workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) throw new Error('No team sync configured.');
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  await upsertFile(octokit, owner, repo, 'org/config.json', {
    ...config,
    updatedAt: new Date().toISOString(),
    updatedBy: getSeatId(),
  }, 'enterprise: update org config');
}

/**
 * Get org-level Anthropic API key if set.
 * Returns the key string or null.
 */
export async function getOrgApiKey(workspace) {
  const config = await getOrgConfig(workspace);
  return config?.apiKey || null;
}

// ── Seat management ───────────────────────────────────────────────────────────

/**
 * Get all registered seats.
 * Returns array of { seatId, role, registeredAt, lastSeen }
 */
export async function getSeats(workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) return [];
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  const data = await getFileContent(octokit, owner, repo, 'org/seats.json');
  return data?.seats || [];
}

/**
 * Register this machine as a seat.
 * First seat to register becomes admin.
 */
export async function registerSeat(workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) throw new Error('No team sync configured.');
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);

  const existing = await getFileContent(octokit, owner, repo, 'org/seats.json');
  const seats = existing?.seats || [];
  const seatId = getSeatId();
  const now = new Date().toISOString();

  const existingSeat = seats.find(s => s.seatId === seatId);
  if (existingSeat) {
    // Update lastSeen
    existingSeat.lastSeen = now;
  } else {
    // First seat becomes admin
    const role = seats.length === 0 ? 'admin' : 'member';
    seats.push({ seatId, role, registeredAt: now, lastSeen: now });
  }

  await upsertFile(octokit, owner, repo, 'org/seats.json', { seats }, 'enterprise: register seat');
  return seats.find(s => s.seatId === seatId);
}

/**
 * Check if this seat is admin.
 */
export async function isAdmin(workspace) {
  const seats = await getSeats(workspace);
  const seatId = getSeatId();
  const seat = seats.find(s => s.seatId === seatId);
  return seat?.role === 'admin';
}

/**
 * Promote a seat to admin. Admin only.
 */
export async function promoteSeat(targetSeatId, workspace) {
  if (!await isAdmin(workspace)) throw new Error('Only admins can promote seats.');
  const entry = resolveSyncEntry(workspace);
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  const existing = await getFileContent(octokit, owner, repo, 'org/seats.json');
  const seats = existing?.seats || [];
  const seat = seats.find(s => s.seatId === targetSeatId);
  if (!seat) throw new Error(`Seat not found: ${targetSeatId}`);
  seat.role = 'admin';
  await upsertFile(octokit, owner, repo, 'org/seats.json', { seats }, `enterprise: promote ${targetSeatId} to admin`);
}

/**
 * Remove a seat. Admin only.
 */
export async function removeSeat(targetSeatId, workspace) {
  if (!await isAdmin(workspace)) throw new Error('Only admins can remove seats.');
  const entry = resolveSyncEntry(workspace);
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  const existing = await getFileContent(octokit, owner, repo, 'org/seats.json');
  const seats = (existing?.seats || []).filter(s => s.seatId !== targetSeatId);
  await upsertFile(octokit, owner, repo, 'org/seats.json', { seats }, `enterprise: remove ${targetSeatId}`);
}

// ── Audit log ─────────────────────────────────────────────────────────────────

/**
 * Append an audit event.
 * Called automatically after every scan push.
 */
export async function appendAuditEvent(event, workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) return;
  try {
    const octokit = getOctokit(entry);
    const { owner, repo } = parseRepo(entry.repo);
    const existing = await getFileContent(octokit, owner, repo, 'org/audit.json');
    const events = existing?.events || [];
    events.push({
      ...event,
      seatId: getSeatId(),
      timestamp: new Date().toISOString(),
    });
    // Keep last 1000 events
    const trimmed = events.slice(-1000);
    await upsertFile(octokit, owner, repo, 'org/audit.json', { events: trimmed }, 'enterprise: audit log');

    // Heartbeat — bump this seat's lastSeen on every audit event so the
    // Seat Management view reflects real activity rather than the original
    // registration timestamp. registerSeat() handles the existing-seat
    // update path internally (updates lastSeen if already registered, adds
    // as member otherwise). Failure is non-fatal — the audit event itself
    // already landed.
    try {
      await registerSeat(workspace);
    } catch { /* Heartbeat is non-fatal */ }
  } catch { /* Audit failure is non-fatal */ }
}

/**
 * Get audit log. Returns array of events.
 */
export async function getAuditLog(workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) return [];
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  const data = await getFileContent(octokit, owner, repo, 'org/audit.json');
  return data?.events || [];
}

// ── Usage reporting ───────────────────────────────────────────────────────────

/**
 * Aggregate audit log into usage report.
 * Returns { bySeat, byProject, totals }
 */
export async function getUsageReport(workspace) {
  const events = await getAuditLog(workspace);

  const bySeat = {};
  const byProject = {};
  let totalScans = 0;
  let totalCost = 0;
  let totalFindings = 0;

  for (const e of events) {
    if (e.type !== 'scan') continue;
    totalScans++;
    // Defensive number coercion. Some modes historically wrote cost as a
    // $-prefixed string like "$0.0014" instead of a raw number. Strip any
    // leading non-numeric characters and parse. If parsing fails, treat
    // as zero — never let bad data crash the aggregation.
    const eventCost = typeof e.cost === 'number'
      ? e.cost
      : (parseFloat(String(e.cost || 0).replace(/[^\d.-]/g, '')) || 0);
    const eventFindings = typeof e.findingCount === 'number' ? e.findingCount : 0;
    totalCost += eventCost;
    totalFindings += eventFindings;

    // By seat
    if (!bySeat[e.seatId]) bySeat[e.seatId] = { scans: 0, cost: 0, findings: 0, lastScan: null };
    bySeat[e.seatId].scans++;
    bySeat[e.seatId].cost += eventCost;
    bySeat[e.seatId].findings += eventFindings;
    bySeat[e.seatId].lastScan = e.timestamp;

    // By project
    const proj = e.projectLabel || 'unnamed';
    if (!byProject[proj]) byProject[proj] = { scans: 0, cost: 0, findings: 0, lastScan: null };
    byProject[proj].scans++;
    byProject[proj].cost += eventCost;
    byProject[proj].findings += eventFindings;
    byProject[proj].lastScan = e.timestamp;
  }

  return {
    bySeat,
    byProject,
    totals: { scans: totalScans, cost: totalCost, findings: totalFindings },
    generatedAt: new Date().toISOString(),
  };
}

// ── White-label ───────────────────────────────────────────────────────────────

/**
 * Get white-label config for PDF generation.
 * Returns { logoUrl, orgName, primaryColor } or null.
 */
export async function getWhiteLabelConfig(workspace) {
  const config = await getOrgConfig(workspace);
  if (!config?.whiteLabel) return null;
  return {
    logoUrl:      config.whiteLabel.logoUrl || null,
    orgName:      config.whiteLabel.orgName || config.orgName || 'Ghost Architect',
    primaryColor: config.whiteLabel.primaryColor || null,
  };
}
