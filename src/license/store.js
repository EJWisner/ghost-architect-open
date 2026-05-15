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

// Persist updated last_seen_utc — called after every successful validation.
// Only writes if the new value is strictly newer than what's stored, so this
// is monotonic-ratchet-safe even if called repeatedly.
export function updateLastSeenUtc(newIso) {
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
