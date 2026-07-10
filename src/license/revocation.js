// src/license/revocation.js
//
// Revocation check for an installed license.
//
// The signed token proves WE minted it. It says nothing about whether the
// subscription behind it is still alive. Stripe's customer.subscription.deleted
// webhook flips the KV record to status='revoked', but before this module
// existed the CLI never asked, so a cancelled license kept working offline
// until its token's `expires` date (up to a year).
//
// ── Policy: fail open, cache revoked ───────────────────────────────────────
//
// A network error, a timeout, a 5xx, a 404, a corporate proxy, an air-gapped
// Enterprise box: ALL of these mean "keep working". Ghost Watcher is documented
// as advisory and must never block a commit, and a worker outage must never
// break a paying customer's CI.
//
// But an explicit status='revoked' is STICKY. Once the worker has said it, we
// persist it locally and honor it on every subsequent run, network or no
// network. So a cancelled customer would have had to firewall
// license.ghostarchitect.dev BEFORE their first post-cancellation run. After
// that, going offline does not restore access.
//
// The asymmetry is the whole point. Reachability decides nothing on its own;
// it only ever decides whether we get to LEARN something new.

import { getRevocationCache, saveRevocationCache } from './store.js';

// Same override convention as the activation/revoke endpoints in bin/ghost.js.
const VERIFY_URL =
  process.env.GHOST_LICENSE_VERIFY_URL
  || 'https://license.ghostarchitect.dev/verify';

// How long a non-revoked verdict stays fresh. A cancelled customer keeps
// working for at most this long past their cancellation. One day is short
// enough to close the leak and long enough that a normal user hits the network
// once a day, not once a scan.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Hard ceiling on the probe. This sits in front of every gated run, including
// a CI watcher on a cold runner. Three seconds, then we give up and fail open.
const TIMEOUT_MS = 3000;

/**
 * Verdicts:
 *   'revoked'  — worker said so, or a previous run cached it. BLOCK.
 *   'active'   — worker said the license is pending/activated. ALLOW.
 *   'unknown'  — never reached the worker and have no cached verdict. ALLOW.
 */

function cacheIsFresh(entry, licenseId) {
  if (!entry || entry.license_id !== licenseId) return false;
  const checkedMs = Date.parse(entry.checked_at || '');
  if (!Number.isFinite(checkedMs)) return false;
  // A clock that jumped backwards makes `age` negative. Treat that as stale
  // rather than eternally-fresh: the rollback check in validator.js already
  // handles deliberate tampering, and a stale read here is the safe direction.
  const age = Date.now() - checkedMs;
  return age >= 0 && age < CACHE_TTL_MS;
}

/**
 * Ask the license worker whether this license is still good.
 *
 * @param {string} licenseId  — the `lid` claim from the verified token payload
 * @param {object} opts       — { force?: boolean } skip the cache TTL
 * @returns {Promise<'revoked'|'active'|'unknown'>}
 */
/**
 * Cache-only sticky check: has this license already been seen revoked?
 * No TTL, no network, no env-var bypass — the synchronous companion to
 * checkRevocation for call sites that must stay offline-cheap (the validator's
 * grace/expired branches consult it so a revoked license does not keep full
 * paid access through its grace window, Audit 7 finding 3.16).
 */
export function hasCachedRevokedVerdict(licenseId) {
  if (!licenseId) return false;
  const cached = getRevocationCache();
  return !!(cached && cached.license_id === licenseId && cached.status === 'revoked');
}

export async function checkRevocation(licenseId, opts = {}) {
  if (!licenseId) return 'unknown';

  const cached = getRevocationCache();

  // GHOST_LICENSE_VERIFY_FORCE=1 bypasses the TTL AND the sticky-revoked
  // short-circuit, re-probing the worker every run. Exists for two reasons:
  // verifying a revocation end-to-end without waiting out the 24h cache, and
  // letting support tell a customer "run this once" when a resubscribe needs
  // to take effect immediately. That second reason is precisely the sticky
  // case, so force MUST be allowed to skip it: a fresh worker verdict
  // overwrites the cache below, clearing the sticky flag on a resubscribe.
  // Force never fails open, though: every did-not-learn-anything path in this
  // function falls back to the cached revoked verdict, so pulling the
  // ethernet cable with force set does not resurrect a revoked license.
  const force = opts.force || process.env.GHOST_LICENSE_VERIFY_FORCE === '1';
  const stickyRevoked = !!(cached && cached.license_id === licenseId && cached.status === 'revoked');

  // Sticky revocation. Checked before the TTL and before the network: once
  // revoked, always revoked, until a fresh activation rewrites the record or
  // a forced probe brings back a fresh non-revoked worker verdict.
  if (stickyRevoked && !force) {
    return 'revoked';
  }

  if (!force && cacheIsFresh(cached, licenseId)) {
    return cached.status === 'revoked' ? 'revoked' : 'active';
  }

  // Explicit opt-out for offline/air-gapped installs and for tests. A cached
  // revoked verdict still blocks: the opt-out skips the probe, it does not
  // grant amnesty.
  if (process.env.GHOST_NO_LICENSE_VERIFY === '1') {
    return stickyRevoked ? 'revoked' : 'unknown';
  }

  let status;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(VERIFY_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ licenseId }),
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Any non-200 is "we did not learn anything". Notably a 404
    // (license_not_found) must NOT be read as revoked: an admin-issued key that
    // was never written to KV, or a KV read hiccup, would lock out a paying
    // customer. Only an explicit revoked status blocks. When the probe was
    // FORCED past a sticky revoked verdict, "learned nothing" keeps the sticky
    // verdict; only an explicit non-revoked worker answer clears it.
    if (!res.ok) return stickyRevoked ? 'revoked' : 'unknown';

    const body = await res.json();
    if (!body || body.ok !== true || typeof body.status !== 'string') {
      return stickyRevoked ? 'revoked' : 'unknown';
    }
    status = body.status;
  } catch {
    // Network down, DNS failure, timeout, proxy, TLS error, malformed JSON.
    // Fail open for the never-revoked case; fall back to the sticky verdict
    // otherwise, so a previously revoked license does not get resurrected by
    // pulling the ethernet cable (with or without force).
    return stickyRevoked ? 'revoked' : 'unknown';
  }

  // Persist whatever the worker told us, including 'activated'/'pending', so
  // the TTL keeps us off the network for the next 24 hours.
  try {
    saveRevocationCache({ licenseId, status });
  } catch {
    // Cache write is best-effort. A read-only home directory must not turn a
    // successful verification into a failure.
  }

  return status === 'revoked' ? 'revoked' : 'active';
}
