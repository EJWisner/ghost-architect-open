// src/license/trial.js
//
// Trial mode: 14-day evaluation period for first-time users on a machine
// with no paid license. Trial tokens are signed with the HMAC secret baked
// into keys.js (NOT with the Ed25519 private key, which lives only on EJ's
// iMac) so the CLI can mint them locally without a server roundtrip.
//
// Tradeoff (documented in keys.js): anyone reverse-engineering the binary
// can extract the HMAC secret and mint trials of arbitrary length. Trial
// output is watermarked, audit mode is blocked for trial tier, and we
// remember per-fingerprint that a trial has been used. The bypass value is
// low enough that defending against it isn't worth the friction of an
// activation-server roundtrip for new evaluators.

import { encodeTrialToken } from './token.js';
import { currentFingerprintHashes } from './fingerprint.js';
import { saveActivation, hasLicense } from './store.js';
import { getConfig } from '../config.js';

const TRIAL_DURATION_DAYS = 14;

// Marker key in configstore. If present, this machine has already used its
// trial. We track separately from the license store so that --license-clear
// doesn't reset the trial counter.
const TRIAL_USED_KEY = 'trialUsedAt';
const TRIAL_FINGERPRINT_KEY = 'trialUsedFingerprint';

function isoNoMicro(d) {
  return new Date(d).toISOString().replace(/\.\d+Z$/, 'Z');
}

// Has this machine ever started a trial before?
// Returns null if not used, otherwise { usedAt, fingerprint }.
export function getTrialMarker() {
  const cfg = getConfig();
  const usedAt = cfg.get(TRIAL_USED_KEY);
  const fingerprint = cfg.get(TRIAL_FINGERPRINT_KEY);
  if (!usedAt) return null;
  return { usedAt, fingerprint: fingerprint || null };
}

// Mark trial as used. Writes both the timestamp and the fingerprint snapshot.
export function markTrialUsed(fingerprintHashes) {
  const cfg = getConfig();
  cfg.set(TRIAL_USED_KEY, isoNoMicro(Date.now()));
  cfg.set(TRIAL_FINGERPRINT_KEY, fingerprintHashes);
}

// Eligibility check. Returns one of:
//   { eligible: true }
//   { eligible: false, reason: 'license_already_installed' }
//   { eligible: false, reason: 'trial_already_used', usedAt, fingerprintMatch }
//
// "Trial already used" is a soft check — we look at both the timestamp marker
// and whether the fingerprint matches. If the marker exists but the current
// fingerprint is totally different (3-of-4 no match), the user may have
// reformatted/cleared configstore on the same machine but on a different
// machine identity — we still refuse because someone with admin access to
// configstore can always wipe both license and trial markers, and at that
// point bypass is by-design accessible.
export function checkEligibility() {
  if (hasLicense()) {
    return { eligible: false, reason: 'license_already_installed' };
  }
  const marker = getTrialMarker();
  if (marker) {
    return {
      eligible: false,
      reason: 'trial_already_used',
      usedAt: marker.usedAt,
      fingerprint: marker.fingerprint,
    };
  }
  return { eligible: true };
}

// Mint and install a fresh trial token. Throws if the user isn't eligible.
// Returns the parsed { token, payload } so caller can display details.
export function startTrial() {
  const elig = checkEligibility();
  if (!elig.eligible) {
    const msg = elig.reason === 'license_already_installed'
      ? 'A license is already installed. Trial mode is only for first-time users.'
      : `Trial has already been used on this machine (${elig.usedAt.slice(0, 10)}). Purchase at ghostarchitect.dev/pro.`;
    throw new Error(msg);
  }

  const fp = currentFingerprintHashes();
  const now = new Date();
  const expires = new Date(now.getTime() + TRIAL_DURATION_DAYS * 86400 * 1000);
  // Trial has no grace period — when it expires, it stops. Set grace_until
  // and hard_stop equal to expires so the validator's grace/expired states
  // are not reachable for trial tokens. Validator will jump straight to
  // hard_stop the moment expires passes.
  const payload = {
    lid: 'TRIAL' + Math.random().toString(36).slice(2, 10).toUpperCase(),
    tier: 'trial',
    customer: 'trial@local',
    issued: isoNoMicro(now),
    expires: isoNoMicro(expires),
    grace_until: isoNoMicro(expires),
    hard_stop: isoNoMicro(expires),
    fingerprint: fp,
  };

  const token = encodeTrialToken(payload);

  // Install the token in the same store that holds paid licenses, then
  // mark this machine as having used its trial.
  saveActivation({ token, fingerprintHashes: fp });
  markTrialUsed(fp);

  return { token, payload };
}

// Has the active license (from store) the trial tier? Cheap inline check
// used by the PDF generator and audit-mode block. Doesn't re-verify the
// signature — assumes the validator has already done that this run.
export function isActiveTrial(payload) {
  return !!(payload && payload.tier === 'trial');
}

export { TRIAL_DURATION_DAYS };
