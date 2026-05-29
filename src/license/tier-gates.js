// src/license/tier-gates.js
//
// Centralized tier policy. Every "can tier X do Y?" question routes through
// requireTier(). Caller decides what to do with the verdict (show paywall,
// degrade gracefully, etc.) — this module just answers yes/no with reason.
//
// Why a separate module: before this, the policy was scattered across
// bin/ghost.js (audit hardcoded `if (isTrialActive())`), src/freemium.js
// (scan quota + Open-only mode list), and several mode files (implicit
// assumptions about what "open" can do). Centralizing makes tier changes
// a one-file edit and surfaces every gate in a single policy table.
//
// Design:
//   - TIER_POLICY: { 'mode:foo' | 'feature:bar': { open, trial, pro, team, enterprise } }
//     Verdict values: true (allowed), false (blocked), 'quota' (allowed up
//     to SCAN_QUOTA scans, then blocked).
//   - requireTier(gateId, opts) returns { allowed, reason?, paywall?, quotaRemaining? }
//   - paywallFor(gateId, tier) returns { kind: 'audit' | 'quota', ... } so
//     callers can dispatch to the appropriate existing renderer in
//     src/freemium.js (renderAuditPaywall / renderQuotaPaywall). The
//     renderers receive a worker-driven paywallPromo string so promo
//     copy can change without a CLI republish; freemium.js owns the box
//     structure and static body text.
//
// Storage coupling: ZERO. This module is pure policy. Callers look up the
// scan count via src/freemium.js's getScanCount() and pass it in via
// opts.scansUsed. Keeps tier-gates.js unit-testable without disk I/O.
//
// Fail-closed: unknown gate IDs and unrecognized policy values both return
// allowed: false. Forces every new gate to be registered in TIER_POLICY
// rather than silently passing through.

import { getActiveTier } from './session.js';

// Per-tier feature matrix.
//
// Per D1 (locked 2026-05-23): scan quota for Open is 4 scans across
// {poi, blast, conflict, prompt-triage} in any combination. Question
// and Recon free across all tiers. Chat and Audit Pro-gated for
// everyone including trial (matches the existing trial-block banner in
// bin/ghost.js that this module replaces).
//
// Cycle 14 (2026-05-25): Question mode added as the Open-tier Q&A
// surface; Chat moved to Pro+ as the multi-turn conversational surface.
// The two modes share underlying analyst/index.js streamChat machinery
// but present as separate products at the menu level.
//
// Trial tier behaves like Pro for mode access (Question/POI/Blast/
// Conflict/Prompt-Triage/Recon/Chat all available, no quota). Audit
// blocked. PDF watermark + audit block are the two trial-specific
// behaviors; everything else mirrors Pro.
const TIER_POLICY = {
  // Modes
  'mode:question':         { open: true,              trial: true,  pro: true,  team: true,  enterprise: true  },
  'mode:chat':             { open: false,              trial: true,  pro: true,  team: true,  enterprise: true  },
  'mode:recon':            { open: true,               trial: true,  pro: true,  team: true,  enterprise: true  },
  'mode:poi':              { open: 'quota',            trial: true,  pro: true,  team: true,  enterprise: true  },
  'mode:blast':            { open: 'quota',            trial: true,  pro: true,  team: true,  enterprise: true  },
  'mode:conflict':         { open: 'quota',            trial: true,  pro: true,  team: true,  enterprise: true  },
  'mode:prompt-triage':    { open: 'quota',            trial: true,  pro: true,  team: true,  enterprise: true  },
  'mode:audit':            { open: false,              trial: false, pro: true,  team: true,  enterprise: true  },
  // Commit Forecast: Open gets 'forecast-quota' — a separate 1-run quota managed
  // by src/freemium.js's getForecastCount/incrementForecastCount (isolated from
  // ghostOpenScanCount so daily pro-tier usage patterns don't burn the shared
  // 4-scan quota in minutes). bin/ghost.js checks tier first, then dispatches to
  // renderForecastPaywall when the quota is exhausted. Pro+ are unlimited.
  'mode:commit-forecast':  { open: 'forecast-quota',     trial: true,  pro: true,  team: true,  enterprise: true  },
  // Corrected-file forecast: Open gets 'fix-forecast-quota' — a separate 1-run
  // quota managed by src/freemium.js's getFixForecastCount/incrementFixForecastCount.
  // Isolated from both SCAN_QUOTA and FORECAST_QUOTA because this is a distinct
  // surface (post-scan fix evaluation vs pre-commit impact analysis).
  'mode:fix-forecast':     { open: 'fix-forecast-quota', trial: true,  pro: true,  team: true,  enterprise: true  },

  // Features — consulted as soft-gate callout sites (D3 once-per-session
  // suppression). Not yet wired at every site; this is the registry for
  // Phase 2/3 to adopt. Verdict semantics same as modes.
  'feature:profiles':           { open: false, trial: true,  pro: true, team: true, enterprise: true },
  'feature:project-tracking':   { open: false, trial: true,  pro: true, team: true, enterprise: true },
  'feature:ghost-partner-pdf':  { open: false, trial: true,  pro: true, team: true, enterprise: true },
  // verifier-fallback: when a conflict-detection candidate has no usable file
  // references, quickVerify() can fall back to loading ~5K tokens of project
  // context to still produce a verdict. Costs ~5K extra tokens per ambiguous
  // verification. Open gets the cheaper INSUFFICIENT verdict instead; trial+
  // get the fallback. See TODO-verifier-agent-stage3-evaluate.md (closed
  // 2026-05-25 via Cycle 13 Block 2).
  'feature:verifier-fallback':  { open: false, trial: true,  pro: true, team: true, enterprise: true },
  // pdf-watermark-free: trial gets watermarked PDFs, others get clean PDFs.
  // Open gets clean PDFs too — the freemium gate is quota-based, not
  // watermark-based. Trial is the only "watermarked" tier.
  'feature:pdf-watermark-free': { open: true,  trial: false, pro: true, team: true, enterprise: true },
};

// Per D1: bumped from 2 to 4. The bump lives here, not in src/freemium.js's
// FREE_QUOTA constant, so the policy lookup is the single source of truth.
// src/freemium.js's FREE_QUOTA is bumped in parallel for backward compatibility
// with the existing renderQuotaPaywall copy that references it.
export const SCAN_QUOTA = 4;

// Commit Forecast quota for Open tier. One free Forecast per install.
// Isolated from SCAN_QUOTA because Forecast runs many times per day; shared
// quota would drain in minutes. freemium.js imports this constant (not the
// other way around) to avoid circular dependencies — tier-gates never imports
// freemium.
export const FORECAST_QUOTA = 1;

// Corrected-file forecast quota for Open tier. Separate from FORECAST_QUOTA
// (pre-commit Commit Forecast) because these are distinct surfaces the user
// encounters at different points in their workflow. Both default to 1 for
// Open; Pro+ are unlimited for both.
export const FIX_FORECAST_QUOTA = 1;

/**
 * Ask whether a feature/mode is allowed for the active (or specified) tier.
 *
 * @param {string} gateId  e.g. 'mode:audit', 'feature:profiles'
 * @param {object} [opts]
 * @param {string} [opts.tier]       override the session tier (testing)
 * @param {number} [opts.scansUsed]  for quota-gated modes, current count
 *                                   (caller looks this up via freemium.getScanCount)
 * @returns {{ allowed: boolean, reason?: string, paywall?: object, quotaRemaining?: number }}
 */
export function requireTier(gateId, opts = {}) {
  const tier = opts.tier || getActiveTier() || 'open';
  const policy = TIER_POLICY[gateId];

  if (!policy) {
    // Fail-closed: unknown gate id = deny.
    return {
      allowed: false,
      reason: `unknown_gate:${gateId}`,
      paywall: paywallFor(gateId, tier),
    };
  }

  const verdict = policy[tier];

  if (verdict === true) {
    return { allowed: true };
  }
  if (verdict === false) {
    return {
      allowed: false,
      reason: `tier_blocked:${tier}`,
      paywall: paywallFor(gateId, tier),
    };
  }
  if (verdict === 'quota') {
    const used = opts.scansUsed ?? 0;
    if (used < SCAN_QUOTA) {
      return { allowed: true, quotaRemaining: SCAN_QUOTA - used };
    }
    return {
      allowed: false,
      reason: `quota_exceeded:${tier}:${used}/${SCAN_QUOTA}`,
      paywall: paywallFor(gateId, tier),
    };
  }
  // 'forecast-quota' is Commit Forecast's isolated quota. The caller is
  // responsible for passing opts.forecastsUsed (from freemium.getForecastCount())
  // and the limit is FORECAST_QUOTA (1 for Open). Verdict semantics mirror
  // 'quota' but use a different counter and a different paywall kind.
  if (verdict === 'forecast-quota') {
    const used  = opts.forecastsUsed ?? 0;
    const limit = FORECAST_QUOTA;
    if (used < limit) {
      return { allowed: true, quotaRemaining: limit - used };
    }
    return {
      allowed: false,
      reason: `forecast_quota_exceeded:${tier}:${used}/${limit}`,
      paywall: paywallFor(gateId, tier),
    };
  }
  // 'fix-forecast-quota' is the corrected-file forecast's isolated quota.
  // Parallel to 'forecast-quota' but uses FIX_FORECAST_QUOTA and a different
  // counter (freemium.getFixForecastCount / incrementFixForecastCount).
  // Caller passes opts.fixForecastsUsed.
  if (verdict === 'fix-forecast-quota') {
    const used  = opts.fixForecastsUsed ?? 0;
    const limit = FIX_FORECAST_QUOTA;
    if (used < limit) {
      return { allowed: true, quotaRemaining: limit - used };
    }
    return {
      allowed: false,
      reason: `fix_forecast_quota_exceeded:${tier}:${used}/${limit}`,
      paywall: paywallFor(gateId, tier),
    };
  }

  // Unrecognized verdict value — fail-closed.
  return {
    allowed: false,
    reason: `invalid_policy_value:${verdict}`,
    paywall: paywallFor(gateId, tier),
  };
}

/**
 * Paywall payload — what the caller renders when a gate blocks. Returns a
 * { kind, ... } object so the caller can dispatch to the right renderer.
 *
 * Per design decision 2a (2026-05-23): tier-gates emits an enum-like kind,
 * caller routes to existing renderAuditPaywall or renderQuotaPaywall in
 * src/freemium.js. Renderers receive a worker-driven paywallPromo string
 * so launch-time promo messaging can change without a CLI republish.
 * Full-payload rendering (kind=2b) is post-GA work if the two-renderer
 * split becomes painful.
 *
 * @param {string} gateId
 * @param {string} tier
 * @returns {{ kind: 'audit' | 'quota' | 'unknown', gateId: string, tier: string }}
 */
export function paywallFor(gateId, tier) {
  // Audit-tier-blocked → audit-specific copy (worker-driven promo + Pro feature framing).
  if (gateId === 'mode:audit') {
    return { kind: 'audit', gateId, tier };
  }
  // Quota-exhausted on any counted mode → quota paywall (you've used your N free).
  if (gateId.startsWith('mode:')) {
    return { kind: 'quota', gateId, tier };
  }
  // Feature gates currently have no rendered paywall — Phase 2/3 will wire
  // soft-gate callouts (D3) at feature sites instead of blocking. Returned
  // kind:'unknown' so a caller that mistakenly tries to render gets a
  // visible "where's the renderer" signal rather than a silent no-op.
  return { kind: 'unknown', gateId, tier };
}

// Exported for tests. Not part of the public CLI surface.
export { TIER_POLICY };
