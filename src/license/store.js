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
  const r = read();
  return !!(r && r.token);
}

export function getToken() {
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

// Persist a freshly activated license. Used by `ghost activate`.
export function saveActivation({ token, fingerprintHashes }) {
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  write({
    token,
    last_seen_utc: nowIso,
    activated_at: nowIso,
    fingerprint_at_activation: fingerprintHashes,
  });
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
export function updateLastSeenUtc(newIso) {
  if (typeof newIso !== 'string' || !ISO_8601_UTC.test(newIso)) {
    process.stderr.write(
      `ghost: warning: refusing to persist malformed license last-seen timestamp (${JSON.stringify(newIso)}). Skipping.\n`
    );
    return;
  }
  const r = read();
  if (!r) return;
  const newMs = Date.parse(newIso);
  const oldMs = r.last_seen_utc ? Date.parse(r.last_seen_utc) : 0;
  if (newMs > oldMs) {
    r.last_seen_utc = newIso;
    write(r);
  }
}

// Wipe the license. Used by tests and by `ghost license clear`.
export function clearLicense() {
  write(null);
}
