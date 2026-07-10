// src/license/store.js
//
// Read/write license data via the existing `configstore` package.
//
// The license lives under the `license` key in the same configstore file
// that already holds the Anthropic API key and other Ghost config:
//   ~/.config/configstore/ghost-architect.json
//
// Shape:
//   license: {
//     token:                  string  — signed token blob
//     last_seen_utc:          ISO-8601 UTC — monotonic clock ratchet
//     activated_at:           ISO-8601 UTC
//     fingerprint_at_activation: [hash, hash, hash, hash]
//   }
//
// All fields optional; absence of `token` means no license is installed.

import { getConfig } from '../config.js';

const KEY = 'license';

function read() {
  const cfg = getConfig();
  return cfg.get(KEY) || null;
}

function write(value) {
  const cfg = getConfig();
  if (value === null || value === undefined) {
    cfg.delete(KEY);
  } else {
    cfg.set(KEY, value);
  }
}

export function getLicenseRecord() {
  return read();
}

export function hasLicense() {
  if (process.env.GHOST_LICENSE_KEY) return true;  // CI env var fallback
  const r = read();
  return !!(r && r.token);
}

export function getToken() {
  if (process.env.GHOST_LICENSE_KEY) return process.env.GHOST_LICENSE_KEY;  // CI env var fallback
  const r = read();
  return r ? r.token || null : null;
}

export function getLastSeenUtc() {
  const r = read();
  return r ? r.last_seen_utc || null : null;
}

export function getActivatedAt() {
  const r = read();
  return r ? r.activated_at || null : null;
}

export function getFingerprintAtActivation() {
  const r = read();
  return r && Array.isArray(r.fingerprint_at_activation) ? r.fingerprint_at_activation : null;
}

// ── Revocation cache ───────────────────────────────────────────────────────
//
// Shape: revocation: { license_id, status, checked_at }
//
// Lives inside the `license` record so that saveActivation() (which rewrites
// the whole record) drops it. That is deliberate: re-activating with a fresh
// key must not inherit the old key's revoked verdict.
//
// STANDALONE FALLBACK (Audit 8, finding 3.10): an env-var license
// (GHOST_LICENSE_KEY on a CI runner) has no installed record, so the
// record-attached write silently no-oped. That meant the 24h TTL never
// applied on CI (a network probe on every gated run) and a revoked verdict
// never became sticky on the exact surface the revocation check targets.
// When no record exists, the cache persists under its own configstore key.
// Safety is preserved: the cache is keyed by license_id and every reader
// checks `cached.license_id === licenseId`, so a different key never
// inherits a stale verdict, mirroring what saveActivation's record rewrite
// guarantees on the installed path.
const REVOCATION_STANDALONE_KEY = 'revocationCacheStandalone';

export function getRevocationCache() {
  const r = read();
  if (r && r.revocation && typeof r.revocation === 'object') return r.revocation;
  const standalone = getConfig().get(REVOCATION_STANDALONE_KEY);
  return standalone && typeof standalone === 'object' ? standalone : null;
}

export function saveRevocationCache({ licenseId, status }) {
  const entry = {
    license_id: licenseId,
    status,
    checked_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  const r = read();
  if (!r) {
    // Env-var (CI) license: persist standalone so TTL + sticky-revoked hold.
    getConfig().set(REVOCATION_STANDALONE_KEY, entry);
    return;
  }
  write({ ...r, revocation: entry });
}

// Persist a freshly activated license. Used by `ghost activate`.
export function saveActivation({ token, fingerprintHashes }) {
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  write({
    token,
    last_seen_utc: nowIso,
    activated_at: nowIso,
    fingerprint_at_activation: fingerprintHashes,
  });
  // The record rewrite above drops the record-attached revocation verdict by
  // design ("re-activating must not inherit the old verdict"). The standalone
  // key must honor the same guarantee: a stale standalone 'revoked' entry for
  // the SAME license_id (cached during env-var use) survived re-activation
  // and the sticky short-circuit blocked a resubscribed customer without
  // ever probing the worker again (Audit 9, finding 3.5).
  getConfig().delete(REVOCATION_STANDALONE_KEY);
}

// Strict ISO-8601 UTC instant, matching what saveActivation/the validator emit:
//   YYYY-MM-DDTHH:MM:SSZ  (optional .mmm milliseconds before the Z)
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// Persist updated last_seen_utc — called after every successful validation.
// Only writes if the new value is strictly newer than what's stored, so this
// is monotonic-ratchet-safe even if called repeatedly.
//
// The input is validated against a strict ISO-8601 UTC pattern BEFORE parsing.
// Date.parse() returns NaN for malformed input, and `NaN > oldMs` is false, so
// a bare comparison would silently skip the write for garbage. But it would
// also accept lenient-but-non-canonical strings (e.g. "2026-01-01", local-time
// offsets) that Date.parse happily coerces, writing a non-canonical value into
// the monotonic clock ratchet that guards against license replay. Reject
// anything that is not a canonical UTC instant and refuse to write it.
//
// Returns true when the input was a valid canonical timestamp (whether or not
// the monotonic ratchet actually advanced — a valid-but-older value is still a
// success, it simply does not regress the stored value). Returns false when the
// input failed validation, so the caller can treat malformed input as a
// distinct validation failure rather than a silent no-op.
export function updateLastSeenUtc(newIso) {
  if (typeof newIso !== 'string' || !ISO_8601_UTC.test(newIso)) {
    process.stderr.write(
      `ghost: warning: refusing to persist malformed license last-seen timestamp (${JSON.stringify(newIso)}). Skipping.\n`
    );
    return false;
  }
  const newMs = Date.parse(newIso);
  // Reject timestamps more than 24 hours in the future
  // to prevent permanent ratchet lock from malformed input
  const MAX_FUTURE_MS = 86400000; // 24 hours
  if (newMs > Date.now() + MAX_FUTURE_MS) {
    process.stderr.write(
      '[Ghost] Rejected implausible future timestamp: ' +
      newIso + '\n'
    );
    return false;
  }
  // Reject timestamps more than the tolerance window behind the stored value
  // to prevent ratchet rollback attacks. The window defaults to 5 minutes so a
  // benign NTP correction or minor clock skew does not lock a valid user out;
  // GHOST_CLOCK_TOLERANCE (seconds) overrides it for tighter or looser policy.
  // Guarded parse (Audit 8, quick win 6): a non-numeric value used to yield
  // NaN, and `newMs < storedMs - NaN` is always false, so the rollback
  // rejection silently became a no-op with zero feedback. Fall back to the
  // default and say so.
  let MAX_PAST_MS = 300000; // 5 minutes default
  if (process.env.GHOST_CLOCK_TOLERANCE) {
    const parsedTolerance = Number.parseInt(process.env.GHOST_CLOCK_TOLERANCE, 10);
    if (Number.isFinite(parsedTolerance) && parsedTolerance >= 0) {
      MAX_PAST_MS = parsedTolerance * 1000;
    } else {
      process.stderr.write(
        `[Ghost] GHOST_CLOCK_TOLERANCE is not a valid number of seconds ` +
        `("${process.env.GHOST_CLOCK_TOLERANCE}"); using the 300s default.\n`
      );
    }
  }
  const stored = getLastSeenUtc();
  if (stored) {
    const storedMs = new Date(stored).getTime();
    if (newMs < storedMs - MAX_PAST_MS) {
      process.stderr.write(
        '[Ghost] Rejected past timestamp: ' + newIso +
        ' is more than ' + Math.round(MAX_PAST_MS / 1000) + 's behind stored ' +
        stored + '\n'
      );
      return false;
    }
  }
  const r = read();
  if (!r) return true;
  const oldMs = r.last_seen_utc ? Date.parse(r.last_seen_utc) : 0;
  if (newMs > oldMs) {
    r.last_seen_utc = newIso;
    write(r);
  }
  return true;
}

// Wipe the license. Used by tests and by `ghost license clear`.
export function clearLicense() {
  write(null);
  // Same guarantee as saveActivation: clearing the license must not leave a
  // stale standalone revocation verdict behind to block a future activation
  // of the same key (Audit 9, finding 3.5).
  getConfig().delete(REVOCATION_STANDALONE_KEY);
}

// ── Admin token ─────────────────────────────────────────────────────────────
//
// The Ghost license-worker admin bearer token, stored locally so an operator
// can issue licenses from this machine via `ghost --issue-license`. Lives under
// its own configstore key (separate from the customer `license` record).
// Wrapped in its own read/write pair so the key name stays in one place,
// mirroring the license helpers above.
const ADMIN_TOKEN_KEY = 'adminToken';

export function getAdminToken() {
  const v = getConfig().get(ADMIN_TOKEN_KEY);
  return (typeof v === 'string' && v.length > 0) ? v : null;
}

export function saveAdminToken(token) {
  getConfig().set(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken() {
  getConfig().delete(ADMIN_TOKEN_KEY);
}
