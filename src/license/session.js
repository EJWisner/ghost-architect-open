// src/license/session.js
//
// Module-scoped state for the active license in this CLI process. Set by
// bin/ghost.js immediately after validateLicense() succeeds, then consulted
// downstream (e.g. by reports.js) to thread trial-state into PDF rendering
// without having to modify every mode's saveReport call signature.
//
// Single source of truth for "what tier is this run". Reset on every fresh
// CLI invocation (which is every Node process).

let activeLicense = null;

export function setActiveLicense(licenseResult) {
  activeLicense = licenseResult || null;
}

export function getActiveLicense() {
  return activeLicense;
}

export function getActiveTier() {
  if (!activeLicense || !activeLicense.payload) return null;
  return activeLicense.payload.tier || null;
}

export function isTrialActive() {
  return getActiveTier() === 'trial';
}

// Convenience: number of days until trial expires (or null if not on trial).
export function trialDaysRemaining() {
  if (!isTrialActive()) return null;
  return typeof activeLicense.daysUntilExpires === 'number'
    ? activeLicense.daysUntilExpires
    : null;
}
