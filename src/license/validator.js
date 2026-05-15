// src/license/validator.js
//
// The license validation state machine.
//
// Called by `bin/ghost.js` early in main(), before any gated mode runs.
// Returns a structured result the caller routes on:
//
//   { state, payload, daysUntilExpires, daysUntilHardStop, message, ... }
//
// Possible states (see license-spec-PRIVATE.md for full definitions):
//   - valid       continue silently
//   - valid_warn  continue, show "expires in N days" yellow banner
//   - grace       continue, show prominent banner about grace period
//   - expired     continue, show red banner "final day"
//   - hard_stop   BLOCK gated modes
//   - invalid     BLOCK gated modes — signature/fingerprint/format broken
//   - missing     no license — caller decides whether to offer trial or activate
//   - tampered    BLOCK gated modes — clock rollback or skew detected
//
// The validator does NOT print anything itself. Caller in bin/ghost.js
// formats and displays.

import { decodeAndVerifyToken } from './token.js';
import { currentFingerprintHashes, matchesFingerprint } from './fingerprint.js';
import { validateClock } from './clock.js';
import {
  getToken,
  getLastSeenUtc,
  updateLastSeenUtc,
  hasLicense,
} from './store.js';

const MS_PER_DAY = 86400 * 1000;
const WARN_WINDOW_DAYS = 3;  // valid_warn fires when expires is <= N days away

function daysBetween(fromMs, toMs) {
  return Math.ceil((toMs - fromMs) / MS_PER_DAY);
}

function isoNoMicro(d) {
  return new Date(d).toISOString().replace(/\.\d+Z$/, 'Z');
}

// Main entry — async because clock validation may hit the network.
// Options:
//   skipNetworkClock: if true, don't hit worldtimeapi (used by `--version`,
//                     `--help`, and any non-gated command path so we don't
//                     do a 5-second network roundtrip just to print help)
export async function validateLicense({ skipNetworkClock = false } = {}) {
  // (1) Token presence
  if (!hasLicense()) {
    return { state: 'missing', message: 'No license installed.' };
  }
  const tokenString = getToken();

  // (2) Signature + shape verification
  let decoded;
  try {
    decoded = decodeAndVerifyToken(tokenString);
  } catch (e) {
    return {
      state: 'invalid',
      message: `License invalid: ${e.message}`,
    };
  }
  const payload = decoded.payload;

  // (3) Fingerprint check — if the token has one
  if (payload.fingerprint) {
    const currentHashes = currentFingerprintHashes();
    const match = matchesFingerprint(currentHashes, payload.fingerprint);
    if (!match.match) {
      return {
        state: 'invalid',
        payload,
        message: `License is bound to a different machine. Got ${match.matchCount} of 4 hardware components matching (need 3).`,
      };
    }
  }

  // (4) Clock validation — rollback + network skew
  const lastSeen = getLastSeenUtc();
  let clockResult;
  if (skipNetworkClock) {
    // Local-only check: rollback only
    const nowMs = Date.now();
    const lastSeenMs = lastSeen ? Date.parse(lastSeen) : 0;
    if (lastSeenMs && nowMs < lastSeenMs - 60 * 1000) {
      return {
        state: 'tampered',
        payload,
        message: 'Local clock appears to be behind the last validated time. Please correct your clock and try again.',
      };
    }
    clockResult = { ok: true, nowMs, newLastSeenMs: Math.max(nowMs, lastSeenMs) };
  } else {
    clockResult = await validateClock(lastSeen);
    if (!clockResult.ok) {
      return {
        state: 'tampered',
        payload,
        message: clockResult.reason === 'clock_rollback'
          ? 'Local clock appears to be behind the last validated time. Please correct your clock and try again.'
          : `Local clock differs significantly from network time. Please correct your clock and try again. (${clockResult.detail || ''})`,
      };
    }
  }
  const nowMs = clockResult.nowMs;

  // (5) Persist updated last_seen_utc — monotonic ratchet
  if (clockResult.newLastSeenMs) {
    updateLastSeenUtc(isoNoMicro(clockResult.newLastSeenMs));
  }

  // (6) Time-based state transition
  const expiresMs = Date.parse(payload.expires);
  const graceMs = Date.parse(payload.grace_until);
  const hardStopMs = Date.parse(payload.hard_stop);

  const baseResult = {
    payload,
    customer: payload.customer,
    tier: payload.tier,
    expires: payload.expires,
    grace_until: payload.grace_until,
    hard_stop: payload.hard_stop,
    daysUntilExpires: daysBetween(nowMs, expiresMs),
    daysUntilHardStop: daysBetween(nowMs, hardStopMs),
    networkOk: !!clockResult.networkOk,
  };

  if (nowMs >= hardStopMs) {
    return { ...baseResult, state: 'hard_stop',
      message: `License expired on ${payload.expires.slice(0, 10)}. Renew at ghostarchitect.dev/pricing or email support@ghostarchitect.dev.` };
  }
  if (nowMs >= graceMs) {
    return { ...baseResult, state: 'expired',
      message: `License grace period ends today. New scans will be blocked starting ${payload.hard_stop.slice(0, 10)}. Renew now.` };
  }
  if (nowMs >= expiresMs) {
    return { ...baseResult, state: 'grace',
      message: `License expired on ${payload.expires.slice(0, 10)}. Grace period through ${payload.grace_until.slice(0, 10)}. Renew now.` };
  }
  if (baseResult.daysUntilExpires <= WARN_WINDOW_DAYS) {
    return { ...baseResult, state: 'valid_warn',
      message: `License expires in ${baseResult.daysUntilExpires} day${baseResult.daysUntilExpires === 1 ? '' : 's'} (${payload.expires.slice(0, 10)}). Renew now to avoid interruption.` };
  }
  return { ...baseResult, state: 'valid' };
}

// Which states block gated modes?
const BLOCKING_STATES = new Set(['hard_stop', 'invalid', 'missing', 'tampered']);
export function isBlocking(state) {
  return BLOCKING_STATES.has(state);
}

// Which states should display a banner before continuing?
const WARNING_STATES = new Set(['valid_warn', 'grace', 'expired']);
export function isWarning(state) {
  return WARNING_STATES.has(state);
}
