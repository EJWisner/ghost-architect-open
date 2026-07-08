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
import { parseRepo } from './team-sync.js';
import { PRICING } from '../constants/pricing.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

// Shared content encoder for GitHub API file writes.
// Buffer → raw bytes; string → UTF-8; object → JSON.stringify then UTF-8.
function encodeFileContent(content) {
  if (Buffer.isBuffer(content)) return content.toString('base64');
  if (typeof content === 'string') return Buffer.from(content, 'utf8').toString('base64');
  return Buffer.from(JSON.stringify(content, null, 2), 'utf8').toString('base64');
}

// ── Octokit helpers ───────────────────────────────────────────────────────────

function getOctokit(entry) {
  return createOctokit({ auth: entry.token });
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
  const encoded = encodeFileContent(content);
  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo, path: filePath, message, content: encoded,
    ...(sha ? { sha } : {}),
  });
}

async function getFileParsed(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  } catch { return null; }
}

// Fetch parsed content and its SHA together in a single request. The SHA is
// required for a compare-and-swap write: it must correspond to the exact
// content we read, which a separate getFileParsed + getFileSha pair cannot
// guarantee. Returns { content: null, sha: null } when the file is absent.
async function getFileWithSha(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    return {
      content: JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')),
      sha: data.sha,
    };
  } catch { return { content: null, sha: null }; }
}

// Read-modify-write an org file with bounded SHA-conflict retry.
// Uses getFileWithSha so the sha always corresponds to the content we read --
// a separate getFileParsed + getFileSha pair cannot guarantee this (see above comment).
// applyFn receives the current parsed content and returns the new content to write.
// Returns the written content. Throws on non-conflict errors or after maxAttempts.
async function mutateOrgFile(octokit, owner, repo, filePath, applyFn, message, maxAttempts = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { content, sha } = await getFileWithSha(octokit, owner, repo, filePath);
    const next = applyFn(content);
    try {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner, repo, path: filePath, message,
        content: encodeFileContent(next),
        ...(sha ? { sha } : {}),
      });
      return next;
    } catch (err) {
      const isConflict = err?.status === 409 || err?.status === 422 ||
        (typeof err?.message === 'string' && err.message.includes('does not match'));
      if (!isConflict || attempt === maxAttempts) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
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
      `  Ghost Enterprise starts at $${PRICING.ENTERPRISE.monthly}/mo`
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
  return await getFileParsed(octokit, owner, repo, 'org/config.json');
}

/**
 * Save org config to sync repo. Admin only.
 */
export async function saveOrgConfig(config, workspace) {
  // TOCTOU prevention: re-check (and await) admin status as the very first
  // operation, before any other async work. isAdmin() is async, so admin
  // rights could be revoked during the await gap of any earlier call; gating
  // here ensures the privilege is confirmed immediately prior to the write.
  if (!await isAdmin(workspace)) throw new Error('Only admins can save org config.');
  const entry = resolveSyncEntry(workspace);
  if (!entry) throw new Error('No team sync configured.');
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  await mutateOrgFile(octokit, owner, repo, 'org/config.json',
    () => ({ ...config, updatedAt: new Date().toISOString(), updatedBy: getSeatId() }),
    'enterprise: update org config');
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
  const data = await getFileParsed(octokit, owner, repo, 'org/seats.json');
  return data?.seats || [];
}

/**
 * Register this machine as a seat.
 *
 * ADMIN SEMANTICS: the first seat to successfully WRITE seats.json becomes
 * admin — it is the writer that observes an empty seat list, not merely the
 * first to start. Concurrent first-time inits race on this write: two machines
 * fetch the same empty state, both try to write, and GitHub rejects the loser
 * with a 409 SHA mismatch. The loser refetches, sees the winner already present,
 * and registers itself as a member. In the rare case a stale read produces two
 * admins, resolve it manually with `ghost enterprise promote`.
 *
 * COMPARE-AND-SWAP CONTRACT:
 *   1. Read seats.json content together with its blob SHA (getFileWithSha) so
 *      the write targets the exact revision the seat list was derived from.
 *   2. Stamp our seat record with a fresh per-attempt write-nonce. The nonce is
 *      an independent confirmation token: it survives in the persisted content
 *      only if OUR write is the revision that landed.
 *   3. Write with that SHA. GitHub rejects a stale SHA with 409 (another machine
 *      wrote first); on 409 we refetch and retry, up to MAX_ATTEMPTS.
 *   4. The write returns the NEW blob SHA. Refetch seats.json immediately and
 *      compare its blob SHA to the one our write returned. If they match, no
 *      concurrent writer landed after us and the registration is confirmed. If
 *      they differ, someone wrote between our write and this read — the SHA
 *      comparison detects the clobber that a plain content read (which never
 *      passes the written SHA) would miss — so we loop and re-register against
 *      the new state. The write-nonce is cross-checked as a belt-and-suspenders
 *      guard in case the blob SHAs coincide.
 *
 * Verifying by SHA (not just "is my seatId present?") is what closes the race:
 * a concurrent writer could preserve our seatId while clobbering our update, and
 * only the SHA/nonce identity proves the revision we read back is the one we wrote.
 */
export async function registerSeat(workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) throw new Error('No team sync configured.');
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  const seatId = getSeatId();

  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Read content and SHA together so the CAS write targets the exact
    // revision we based our seat list on.
    const { content: existing, sha } = await getFileWithSha(octokit, owner, repo, 'org/seats.json');
    const seats = existing?.seats || [];
    const now = new Date().toISOString();

    // Per-attempt confirmation token stamped onto our seat record. It only
    // remains in the persisted content if OUR write is the one that landed.
    const writeNonce = randomUUID();

    const existingSeat = seats.find(s => s.seatId === seatId);
    if (existingSeat) {
      // Update lastSeen
      existingSeat.lastSeen = now;
      existingSeat.writeNonce = writeNonce;
    } else {
      // First writer of an empty list becomes admin
      const role = seats.length === 0 ? 'admin' : 'member';
      seats.push({ seatId, role, registeredAt: now, lastSeen: now, writeNonce });
    }

    let writeSha = null;
    try {
      const encoded = Buffer.from(JSON.stringify({ seats }, null, 2)).toString('base64');
      const writeResult = await octokit.rest.repos.createOrUpdateFileContents({
        owner, repo, path: 'org/seats.json', message: 'enterprise: register seat',
        content: encoded, ...(sha ? { sha } : {}),
      });
      // The write returns the new blob SHA of seats.json.
      writeSha = writeResult?.data?.content?.sha || null;
    } catch (err) {
      lastErr = err;
      // 409 = SHA mismatch: another machine wrote first. Refetch and retry.
      if (err.status === 409 && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }

    // Verify the write persisted by SHA, not merely by seatId presence. Refetch
    // seats.json and compare its blob SHA to the SHA our write returned. If they
    // match, no concurrent writer landed after us. If they differ, someone wrote
    // between our write and this read and may have clobbered our registration —
    // loop and re-register against the new state. The write-nonce is the
    // belt-and-suspenders cross-check should the blob SHAs ever coincide.
    const { content: after, sha: afterSha } = await getFileWithSha(octokit, owner, repo, 'org/seats.json');
    const confirmed = (after?.seats || []).find(s => s.seatId === seatId);
    const shaMatches = writeSha && afterSha && writeSha === afterSha;
    const nonceMatches = confirmed?.writeNonce === writeNonce;
    // BOTH checks must pass to confirm the write. A concurrent writer can
    // preserve our seatId while clobbering our update: the nonce alone could
    // coincide across blobs, and the SHA alone proves only that the blob we
    // read back is the one we wrote (not that it still carries our record).
    // Requiring shaMatches AND nonceMatches together is what proves the
    // revision we read back is exactly the one we wrote, with our record intact.
    if (confirmed && shaMatches && nonceMatches) return confirmed;

    lastErr = new Error('Seat registration did not persist (concurrent writer detected); retrying.');
  }

  throw lastErr || new Error('Failed to register seat after retries.');
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
  // TOCTOU prevention: await admin status as the very first operation, before
  // any other async work. isAdmin() is async, and admin rights could be revoked
  // during an unguarded await gap; confirming it here keeps the check and the
  // privileged write tight against each other.
  if (!await isAdmin(workspace)) throw new Error('Only admins can promote seats.');
  const entry = resolveSyncEntry(workspace);
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  await mutateOrgFile(octokit, owner, repo, 'org/seats.json',
    (c) => {
      const seats = c?.seats || [];
      const seat = seats.find(s => s.seatId === targetSeatId);
      if (!seat) throw new Error(`Seat not found: ${targetSeatId}`);
      seat.role = 'admin';
      return { seats };
    },
    `enterprise: promote ${targetSeatId} to admin`);
}

/**
 * Remove a seat. Admin only.
 */
export async function removeSeat(targetSeatId, workspace) {
  // TOCTOU prevention: await admin status as the very first operation, before
  // any other async work. isAdmin() is async, and admin rights could be revoked
  // during an unguarded await gap; confirming it here keeps the check and the
  // privileged write tight against each other.
  if (!await isAdmin(workspace)) throw new Error('Only admins can remove seats.');
  const entry = resolveSyncEntry(workspace);
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  await mutateOrgFile(octokit, owner, repo, 'org/seats.json',
    (c) => ({ seats: (c?.seats || []).filter(s => s.seatId !== targetSeatId) }),
    `enterprise: remove ${targetSeatId}`);
}

// ── Audit log ─────────────────────────────────────────────────────────────────

// Intentional fail-safe design: audit logging must NEVER break a scan.
// appendAuditEvent() swallows all exceptions so that a sync-repo outage,
// auth lapse, or rate-limit can't crash the user's run. The trade-off is
// that a swallowed failure leaves a gap in the compliance audit trail with
// no signal to the admin. To keep that gap observable without changing the
// fail-safe contract:
//   - When GHOST_DEBUG=1 is set, each failure writes a single-line warning
//     to stderr so developers and smoke tests can see what went wrong.
//   - A consecutive-failure counter (reset on every successful write) emits
//     an unconditional stderr warning on the FIRST failed write — a single
//     dropped audit event is already a gap in the compliance trail, so we
//     surface it immediately rather than waiting for a sustained outage. The
//     warning includes the UTC timestamp of the failure so the admin can
//     correlate it against the scan that was dropped. The scan itself still
//     succeeds in every case.
//   - The in-memory counter resets every CLI invocation, so a failure on the
//     last scan of a run would otherwise leave no trace. To keep the signal
//     durable, the first failure also drops a .audit-failure marker file on
//     disk (cleared on the next successful write). Both the file write and the
//     removal are best-effort and swallow their own errors so the fail-safe
//     contract holds even if the reports directory is read-only.
const AUDIT_FAILURE_MARKER = path.join(
  os.homedir(), 'Ghost Architect Reports', '.audit-failure'
);

function logAuditFailure(stage, err) {
  if (process.env.GHOST_DEBUG === '1') {
    process.stderr.write(
      'Ghost audit log failure [' + stage + ']: '
      + (err?.message || String(err)) + '\n'
    );
  }
}

// Restore the consecutive-failure streak from the on-disk marker so it survives
// process boundaries. Ghost Watcher runs one process per commit; without this
// the in-memory counter would reset to 0 every run and a sustained audit-log
// outage would never accumulate past the first failure, so the escalation
// warning could never fire. Best-effort: a missing or unreadable/legacy marker
// (one without a stored count) is the normal case and starts the streak at 0.
function readAuditFailureMarker() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUDIT_FAILURE_MARKER, 'utf8'));
    const count = Number.isInteger(parsed?.consecutiveFailures) ? parsed.consecutiveFailures : 0;
    return {
      consecutiveFailures: Math.max(0, count),
      lastAuditFailureUtc: parsed?.lastAuditFailureUtc || null,
    };
  } catch {
    return { consecutiveFailures: 0, lastAuditFailureUtc: null };
  }
}

const _restoredAuditFailure = readAuditFailureMarker();
let consecutiveAuditFailures = _restoredAuditFailure.consecutiveFailures;
let lastAuditFailureUtc = _restoredAuditFailure.lastAuditFailureUtc;

// Persist the audit-failure signal across CLI invocations. Best-effort: any
// error here is swallowed so a disk problem can never break the scan. The
// running streak count is stored so the next process resumes it rather than
// restarting at zero.
function writeAuditFailureMarker(count, utc) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FAILURE_MARKER), { recursive: true });
    fs.writeFileSync(
      AUDIT_FAILURE_MARKER,
      JSON.stringify({ consecutiveFailures: count, lastAuditFailureUtc: utc, seatId: getSeatId() }) + '\n'
    );
  } catch (err) {
    logAuditFailure('marker-write', err);
  }
}

// Clear the marker after a successful write. Best-effort; a missing file is
// the normal case and is not an error.
function clearAuditFailureMarker() {
  try {
    fs.rmSync(AUDIT_FAILURE_MARKER, { force: true });
  } catch (err) {
    logAuditFailure('marker-clear', err);
  }
}

// ── Local durable audit-failure buffer ────────────────────────────────────────
//
// The previous durable record for a failed audit write lived only in
// org/audit-failures.json in the sync repo. But the outage that fails the audit
// write (repo unreachable, auth lapse) fails that write too, so the compliance
// gap could vanish without a trace. This LOCAL buffer is written first and does
// not depend on the network: on the next SUCCESSFUL audit write the buffered
// records are flushed to org/audit-failures.json in a batch and the local file
// is cleared. `ghost enterprise audit-status` reports anything still unsynced.
const LOCAL_AUDIT_FAILURES = path.join(
  os.homedir(), '.config', 'ghost-architect', 'audit-failures.json'
);

function readLocalAuditFailures() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_AUDIT_FAILURES, 'utf8'));
    return Array.isArray(parsed?.failures) ? parsed.failures : [];
  } catch {
    return [];
  }
}

function appendLocalAuditFailure(record) {
  try {
    fs.mkdirSync(path.dirname(LOCAL_AUDIT_FAILURES), { recursive: true });
    const failures = [...readLocalAuditFailures(), record].slice(-500);
    fs.writeFileSync(LOCAL_AUDIT_FAILURES, JSON.stringify({ failures }, null, 2) + '\n');
  } catch (err) {
    logAuditFailure('local-failure-write', err);
  }
}

function clearLocalAuditFailures() {
  try {
    fs.rmSync(LOCAL_AUDIT_FAILURES, { force: true });
  } catch (err) {
    logAuditFailure('local-failure-clear', err);
  }
}

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
    await mutateOrgFile(octokit, owner, repo, 'org/audit.json',
      (c) => ({
        events: [...(c?.events || []), {
          ...event,
          seatId: getSeatId(),
          timestamp: new Date().toISOString(),
        }].slice(-1000),
      }),
      'enterprise: audit log');

    // Audit event landed — reset the consecutive-failure streak and clear the
    // on-disk marker so a future invocation doesn't re-surface a stale outage.
    consecutiveAuditFailures = 0;
    clearAuditFailureMarker();

    // Flush any LOCALLY-buffered audit failures (written while the sync repo was
    // unreachable) to the durable in-repo log now that a write has succeeded,
    // then clear the local buffer. Best-effort: if the flush itself fails the
    // local buffer is kept for the next successful write.
    const bufferedFailures = readLocalAuditFailures();
    if (bufferedFailures.length) {
      try {
        await mutateOrgFile(octokit, owner, repo, 'org/audit-failures.json',
          (c) => ({ failures: [...(c?.failures || []), ...bufferedFailures].slice(-500) }),
          'enterprise: flush buffered audit failures');
        clearLocalAuditFailures();
      } catch (flushErr) {
        logAuditFailure('audit-failure-flush', flushErr);
      }
    }

    // Heartbeat — bump this seat's lastSeen on every audit event so the
    // Seat Management view reflects real activity rather than the original
    // registration timestamp. registerSeat() handles the existing-seat
    // update path internally (updates lastSeen if already registered, adds
    // as member otherwise). Failure is non-fatal — the audit event itself
    // already landed, so this does NOT count toward the audit-failure
    // streak; we only surface it under GHOST_DEBUG.
    try {
      await registerSeat(workspace);
    } catch (err) {
      logAuditFailure('heartbeat', err);
    }
  } catch (err) {
    // Audit failure is non-fatal — never break the scan. Surface it under
    // GHOST_DEBUG, and warn unconditionally on the first failed write so a
    // single dropped audit event is observable right away (see fail-safe
    // note above).
    logAuditFailure('audit-write', err);
    consecutiveAuditFailures += 1;
    lastAuditFailureUtc = new Date().toISOString();
    // Persist the running streak on EVERY failure (not just the first) so the
    // on-disk count stays accurate for the next process to resume. The marker
    // is cleared only after a successful write (see the success path above).
    writeAuditFailureMarker(consecutiveAuditFailures, lastAuditFailureUtc);

    // Write a DURABLE failure record to the LOCAL buffer first. The previous
    // implementation wrote straight to org/audit-failures.json in the sync repo,
    // but the same outage that fails the audit write (repo unreachable) fails
    // that write too, losing the compliance gap silently. The local file does
    // not depend on the network; it is flushed to org/audit-failures.json on the
    // next successful audit write (see the success path above) and surfaced by
    // `ghost enterprise audit-status` until then.
    const failureRecord = {
      timestamp: lastAuditFailureUtc,
      event: 'audit_write_failure',
      consecutiveFailures: consecutiveAuditFailures,
      seatId: getSeatId(),
      message: err.message,
    };
    appendLocalAuditFailure(failureRecord);

    if (consecutiveAuditFailures >= 1) {
      process.stderr.write(
        'Ghost: ' + consecutiveAuditFailures + ' consecutive audit-log '
        + 'writes have failed (last failure ' + lastAuditFailureUtc + '). '
        + 'The compliance audit trail may be incomplete. '
        + 'Set GHOST_DEBUG=1 for details.\n'
      );
    }
  }
}

/**
 * Get audit log. Returns array of events.
 */
export async function getAuditLog(workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) return [];
  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  const data = await getFileParsed(octokit, owner, repo, 'org/audit.json');
  return data?.events || [];
}

/**
 * Report locally-buffered audit-write failures that have NOT yet been flushed
 * to the sync repo (they are flushed on the next successful audit write). Backs
 * the `ghost enterprise audit-status` command. Purely local — never touches the
 * network — so it works even when the sync repo is down.
 * Returns { count, failures, path }.
 */
export function getLocalAuditFailureStatus() {
  const failures = readLocalAuditFailures();
  return {
    count: failures.length,
    failures,
    path: LOCAL_AUDIT_FAILURES,
  };
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

  // Surface any DURABLE audit-write failures (org/audit-failures.json, written
  // by appendAuditEvent's failure path) so the usage report reflects gaps in the
  // compliance trail rather than silently omitting them. Best-effort: an absent
  // file (the normal case) or a read error means no gap is surfaced.
  let auditFailures = null;
  try {
    const entry = resolveSyncEntry(workspace);
    if (entry) {
      const octokit = getOctokit(entry);
      const { owner, repo } = parseRepo(entry.repo);
      const failData = await getFileParsed(octokit, owner, repo, 'org/audit-failures.json');
      const failures = failData?.failures || [];
      if (failures.length) {
        auditFailures = { count: failures.length, latest: failures[failures.length - 1] };
      }
    }
  } catch { /* best-effort */ }

  return {
    bySeat,
    byProject,
    totals: { scans: totalScans, cost: totalCost, findings: totalFindings },
    ...(auditFailures ? { auditFailures } : {}),
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
