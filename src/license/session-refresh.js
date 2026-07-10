// src/license/session-refresh.js
//
// One-call session refresh after any event that changes the active license:
// in-menu activation (Reconfigure > License key), first-run onboarding
// activation, and anywhere else a license lands or leaves mid-process.
//
// Why this exists (Audit 7, findings 1.2 + 1.3): validateLicense() used to run
// only at startup. Activating a license later in the same process saved the
// token but never re-validated, never updated the active session, and never
// re-seeded the loader's tier cap. The customer saw "License activated" while
// the banner, every tier gate, and the context cap kept treating them as Open
// until they restarted. Worse, the first-run wizard read the stale Open tier
// and persisted a 50K context cap into config for brand-new paying customers.
//
// The refresh is deliberately a single choke point: validate, set the active
// session, resolve the tier, push it into the loader. Callers that also track
// a local tier variable (bin/ghost.js's TIER) assign from the returned tier.

import { validateLicense, isBlocking } from './validator.js';
import { setActiveLicense, getActiveTier } from './session.js';
import { setScanOptions } from '../loader/index.js';

/**
 * Re-validate the installed license and propagate the result everywhere the
 * running session consults it. Returns { result, tier }.
 *
 * skipNetworkClock: the startup validation already did (or will do) the
 * network clock roundtrip; a mid-session refresh right after activation
 * should be fast and offline-safe. Revocation and expiry still apply.
 *
 * scanOptionOverrides: the CLI-derived scan options (max-context override,
 * exclude presets/patterns, redaction skip) that must survive the re-seed.
 * setScanOptions is last-write-wins, so omitting them here would silently
 * drop flags the user passed at launch.
 */
export async function refreshLicenseSession(scanOptionOverrides = {}) {
  const result = await validateLicense({ skipNetworkClock: true });

  // getActiveTier() answers "what did they buy", not "may they use it". A
  // blocking validation result (revoked, hard_stop, tampered, invalid) must
  // degrade the session to Open, mirroring the startup degrade convention in
  // renderLicenseStateAndMaybeBlock, instead of granting the payload tier.
  // tier is spread LAST so no overrides object can ever defeat the freshly
  // validated tier. With overrides last, a stray `tier` key sneaking into
  // the CLI overrides would silently resurrect the exact
  // stale-tier-after-activation bug this module exists to kill
  // (Audit 8, quick win 5).
  if (isBlocking(result.state)) {
    setActiveLicense(null);
    setScanOptions({ ...scanOptionOverrides, tier: 'open' });
    return { result, tier: 'open' };
  }

  setActiveLicense(result);
  const tier = getActiveTier() || 'open';
  setScanOptions({ ...scanOptionOverrides, tier });
  return { result, tier };
}
