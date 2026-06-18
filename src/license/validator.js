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
      let message;
      if (clockResult.reason === 'clock_rollback') {
        message = 'Local clock appears to be behind the last validated time. Please correct your clock and try again.';
      } else if (clockResult.reason === 'clock_offline_grace_exceeded') {
        message = `Ghost has been unable to reach a network time server for too many consecutive runs and can no longer verify your clock offline. Connect to the internet once and try again. (${clockResult.detail || ''})`;
      } else {
        message = `Local clock differs significantly from network time. Please correct your clock and try again. (${clockResult.detail || ''})`;
      }
      return { state: 'tampered', payload, message };
    }
  }
  const nowMs = clockResult.nowMs;

  // (5) Persist updated last_seen_utc — monotonic ratchet.
  //
  // A failure here (disk full, read-only filesystem, EACCES) must NOT abort
  // validation or be mistaken for tampering. The ratchet write is best-effort
  // bookkeeping: skipping it only means the next run reads a slightly older
  // last_seen_utc, which is harmless because a stale value is never NEWER than
  // "now" and so can never trip the rollback check. Letting the write throw,
  // by contrast, would propagate up and lock the user out of every gated mode
  // with a confusing error after a single transient disk hiccup. Log to stderr
  // and continue with the valid state already computed above.
  if (clockResult.newLastSeenMs) {
    try {
      const persisted = updateLastSeenUtc(isoNoMicro(clockResult.newLastSeenMs));
      if (!persisted) {
        // updateLastSeenUtc returns false only when the timestamp it was handed
        // failed canonical-UTC validation. That is not a transient disk hiccup;
        // it means the value derived from the clock check is malformed, so the
        // ratchet write was refused. updateLastSeenUtc already logged the
        // specifics to stderr; note the validation failure here too and continue
        // with the valid state computed above (a refused write is harmless to
        // the rollback check, which a stale value can never trip).
        process.stderr.write(
          'ghost: warning: license last-seen timestamp failed validation and was not persisted. Continuing.\n'
        );
      }
    } catch (e) {
      process.stderr.write(
        `ghost: warning: could not persist license last-seen timestamp (${e.message}). Continuing.\n`
      );
    }
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
