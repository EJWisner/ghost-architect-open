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
//   - revoked     BLOCK gated modes — subscription cancelled, per the worker
//
// The validator does NOT print anything itself. Caller in bin/ghost.js
// formats and displays.

import { decodeAndVerifyToken } from './token.js';
import { currentFingerprintHashes, matchesFingerprint } from './fingerprint.js';
import { validateClock } from './clock.js';
import { checkRevocation, hasCachedRevokedVerdict } from './revocation.js';
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

// The customer/tier/expiry fields every non-error result must carry so `ghost
// --license` shows the real customer and trialDaysRemaining() has a number to
// read. Shared by the happy-path result and the valid_warn clock-degradation
// returns, which fire before the main baseResult is built and would otherwise
// omit these fields (rendering "Customer: (unknown)" for a paying customer).
function computeBaseResult(payload, nowMs, clockResult) {
  return {
    payload,
    customer: payload.customer,
    tier: payload.tier,
    expires: payload.expires,
    grace_until: payload.grace_until,
    hard_stop: payload.hard_stop,
    daysUntilExpires: daysBetween(nowMs, Date.parse(payload.expires)),
    daysUntilHardStop: daysBetween(nowMs, Date.parse(payload.hard_stop)),
    networkOk: !!(clockResult && clockResult.networkOk),
  };
}

// Main entry — async because clock validation may hit the network.
// Options:
//   skipNetworkClock: if true, don't hit worldtimeapi (used by `--version`,
//                     `--help`, and any non-gated command path so we don't
//                     do a 5-second network roundtrip just to print help)
//   skipRevocationCheck: if true, don't ask the license worker whether this
//                     license was cancelled. Set on `--version` / `--help`,
//                     which must stay fast and are not gated surfaces.
//                     NOT set for the headless watcher: an unattended CI run
//                     on a cancelled subscription is the exact leak this
//                     check exists to close.
export async function validateLicense({ skipNetworkClock = false, skipRevocationCheck = false } = {}) {
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
  // Skip fingerprint check in CI environments — ephemeral runners have different hardware
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  if (payload.fingerprint && !isCI) {
    const currentHashes = currentFingerprintHashes();
    const match = matchesFingerprint(currentHashes, payload.fingerprint);
    if (!match.match) {
      return {
        state: 'invalid',
        payload,
        message:
          `License is bound to a different machine. Got ${match.matchCount} of 4 hardware components matching (need 3).\n` +
          `This is normal after a new laptop, a VM refresh, or a hardware upgrade.\n` +
          `To re-bind this license to your current machine, run: ghost --activate <your license key>\n` +
          `Need help? Email support@ghostarchitect.dev`,
      };
    }
  }

  // (4) Clock validation — rollback + network skew
  const lastSeen = getLastSeenUtc();
  let clockResult;
  // Non-fatal clock complaint, surfaced only if the license is otherwise healthy.
  // Never allowed to mask an expiry state. See the fall-through note below.
  let clockWarning = null;
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
      // Only a clock ROLLBACK (local time behind the last validated time) is a
      // real tamper signal, so it stays a hard block. Network skew and
      // sustained-offline are legitimate machine states (dead CMOS battery, a
      // drifted VM, NTP not running, a long stretch with no connectivity), so
      // we degrade those to a non-blocking warning.
      if (clockResult.reason === 'clock_rollback') {
        return {
          state: 'tampered',
          payload,
          message: 'Local clock appears to be behind the last validated time. Please correct your clock and try again.',
        };
      }
      // NOTE: these two states used to `return` a valid_warn straight from here,
      // which jumped clean over the expiry state machine below. An expired (or
      // hard-stopped) license on a machine with a skewed clock therefore never
      // blocked — a dead CMOS battery was a free license. Record the warning and
      // fall through: expiry is evaluated first, and the clock warning is only
      // surfaced when the license is otherwise healthy.
      if (clockResult.reason === 'clock_offline_grace_exceeded') {
        clockWarning = 'Ghost could not verify network time for several consecutive runs. Running in offline mode. Connect to the internet to re-sync.';
      } else {
        // clock_skew: local clock differs significantly from network time.
        clockWarning =
          'Your system clock appears to be out of sync with network time. Ghost will continue but accuracy may be affected.\n' +
          'To fix: Mac: System Settings > General > Date & Time > enable Set automatically. ' +
          'Windows: Settings > Time & Language > enable Set time automatically. ' +
          'Linux: sudo ntpdate pool.ntp.org';
      }
    }
  }
  // When the clock check failed we have no trusted network time. Local time is
  // the only clock we have; use it. A user who wound their clock BACK is already
  // caught by the rollback branch above, and a user who wound it FORWARD only
  // expires themselves sooner.
  const nowMs = clockResult.ok ? clockResult.nowMs : (clockResult.nowMs || Date.now());

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
  // Only ratchet from a clock we actually trust. Persisting a skewed or
  // unverified local time would poison the rollback check on the next run.
  if (clockResult.ok && clockResult.newLastSeenMs) {
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

  const baseResult = computeBaseResult(payload, nowMs, clockResult);

  // A KNOWN-revoked license must not ride out its grace window. The grace and
  // expired states below return before the network revocation check (correct:
  // an expiring license needs no fresh probe), but they used to skip even the
  // CACHED verdict, so cancel-then-coast kept full paid access for the ~6-day
  // grace window (Audit 7, finding 3.16). Consult the sticky cache only —
  // offline-cheap, no TTL, no network — and let the standard revoked state
  // (with its resubscribe copy) win over grace/expired AND hard_stop: both
  // block, but the hard_stop copy's "run ghost --activate <your key>" hint
  // cannot work for a revoked key, so a cancelled customer past hard stop
  // was sent into a failing activation loop instead of the resubscribe path
  // (Audit 8, finding 2.8). skipRevocationCheck callers keep their
  // fully-revocation-free contract.
  const revocationApplies = !skipRevocationCheck
    && payload.lid
    && payload.tier !== 'trial';
  let knownRevoked = revocationApplies && hasCachedRevokedVerdict(payload.lid);
  // The cache only closes cancel-then-coast for customers who ran Ghost
  // between cancellation and expiry (that run cached the verdict). A customer
  // who cancelled and did NOT run Ghost until after expiry had no cached
  // verdict and coasted through the entire grace window at full paid tier
  // (Audit 8, finding 3.3). Probe the worker from expiry onward, under
  // checkRevocation's existing contract: fail-open on every network fault,
  // 24h TTL cache, ~3s ceiling. The probe deliberately has NO hard_stop
  // upper bound: past hard_stop the license blocks either way, but a
  // cancelled customer with no cached verdict used to get the hard_stop
  // copy's "ghost --activate <your key>" hint, which cannot work for a
  // revoked key, instead of the resubscribe path (Audit 9, finding 2.2).
  // On any network fault the verdict stays 'unknown' and the hard_stop
  // behavior is unchanged.
  if (!knownRevoked && revocationApplies && nowMs >= expiresMs) {
    knownRevoked = (await checkRevocation(payload.lid)) === 'revoked';
  }
  if (knownRevoked && nowMs >= expiresMs) {
    return {
      ...baseResult,
      state: 'revoked',
      message:
        'This license has been revoked, usually because the subscription was cancelled.\n' +
        'Continue free with Ghost Open, or resubscribe at ghostarchitect.dev/pricing.\n' +
        'To restore access after resubscribing, run: ghost --activate <your new key>\n' +
        'If you believe this is an error, email support@ghostarchitect.dev.',
    };
  }

  // The non-trial expiry copy below always includes the re-activation hint.
  // There is no automatic token refresh: a subscriber whose Stripe plan is
  // happily auto-billing still holds a token that ages out on a fixed date.
  // Without the hint, a PAYING customer hits "License expired. Renew at
  // /pricing" and either emails support, buys a second subscription, or
  // churns angry (Audit 7, finding 2.4). Re-activating with their existing
  // key mints a fresh token from the worker.
  const REACTIVATE_HINT = 'Already a subscriber? Run ghost --activate <your key> to restore access.';
  if (nowMs >= hardStopMs) {
    const message = payload.tier === 'trial'
      ? `Your Ghost Pro Max trial has ended. Continue free with Ghost Open, or subscribe at ghostarchitect.dev/pricing to keep scanning.`
      : `License expired on ${payload.expires.slice(0, 10)}. Renew at ghostarchitect.dev/pricing or email support@ghostarchitect.dev.\n${REACTIVATE_HINT}`;
    return { ...baseResult, state: 'hard_stop', message };
  }
  if (nowMs >= graceMs) {
    const message = payload.tier === 'trial'
      ? `Your Ghost Pro Max trial has ended. New scans stop after ${payload.hard_stop.slice(0, 10)}. Subscribe at ghostarchitect.dev/pricing to keep scanning.`
      : `License grace period ends today. New scans will be blocked starting ${payload.hard_stop.slice(0, 10)}. Renew now.\n${REACTIVATE_HINT}`;
    return { ...baseResult, state: 'expired', message };
  }
  if (nowMs >= expiresMs) {
    const message = payload.tier === 'trial'
      ? `Your Ghost Pro Max trial has ended (${payload.expires.slice(0, 10)}). Access continues through ${payload.grace_until.slice(0, 10)}. Subscribe at ghostarchitect.dev/pricing to keep scanning.`
      : `License expired on ${payload.expires.slice(0, 10)}. Grace period through ${payload.grace_until.slice(0, 10)}. Renew now.\n${REACTIVATE_HINT}`;
    return { ...baseResult, state: 'grace', message };
  }
  // (7) Revocation check — is the subscription behind this token still alive?
  //
  // Runs AFTER the expiry machine (an already-expired license needs no network
  // call) and only for real, worker-issued licenses: trial tokens are minted
  // locally and carry no `lid`, so there is nothing to ask about.
  //
  // Fail open by contract. checkRevocation() returns 'unknown' for every
  // network fault and every non-200, and only ever returns 'revoked' on an
  // explicit worker verdict or a previously cached one. See revocation.js.
  if (!skipRevocationCheck && payload.lid && payload.tier !== 'trial') {
    const verdict = await checkRevocation(payload.lid);
    if (verdict === 'revoked') {
      return {
        ...baseResult,
        state: 'revoked',
        message:
          'This license has been revoked, usually because the subscription was cancelled.\n' +
          'Continue free with Ghost Open, or resubscribe at ghostarchitect.dev/pricing.\n' +
          'To restore access after resubscribing, run: ghost --activate <your new key>\n' +
          'If you believe this is an error, email support@ghostarchitect.dev.',
      };
    }
  }

  if (baseResult.daysUntilExpires <= WARN_WINDOW_DAYS) {
    return { ...baseResult, state: 'valid_warn',
      message: `License expires in ${baseResult.daysUntilExpires} day${baseResult.daysUntilExpires === 1 ? '' : 's'} (${payload.expires.slice(0, 10)}). Renew now to avoid interruption.` };
  }
  // Healthy license, but the clock check had something to say. Surface it now
  // that we know it is not hiding an expiry.
  if (clockWarning) {
    return { ...baseResult, state: 'valid_warn', message: clockWarning };
  }
  return { ...baseResult, state: 'valid' };
}

// Which states block gated modes?
const BLOCKING_STATES = new Set(['hard_stop', 'invalid', 'missing', 'tampered', 'revoked']);
export function isBlocking(state) {
  return BLOCKING_STATES.has(state);
}

// Which states should display a banner before continuing?
const WARNING_STATES = new Set(['valid_warn', 'grace', 'expired']);
export function isWarning(state) {
  return WARNING_STATES.has(state);
}
