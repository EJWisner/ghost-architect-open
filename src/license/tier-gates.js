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
// and Recon free across all tiers. Chat is Pro-gated (blocked on Open); Audit
// is available to paid tiers AND to the Pro Max trial (see the trial note
// below).
//
// Cycle 14 (2026-05-25): Question mode added as the Open-tier Q&A
// surface; Chat moved to Pro+ as the multi-turn conversational surface.
// The two modes share underlying analyst/index.js streamChat machinery
// but present as separate products at the menu level.
//
// Trial tier is a Pro Max evaluation: it mirrors Pro Max for mode access,
// including Audit and Ghost Brief, with no scan quota, and runs at Pro Max's
// 100K token context cap (see src/loader/tierCaps.js). The PDF watermark
// (feature:pdf-watermark-free below) is the SOLE trial differentiator, so a
// user who accepts the "free 7-day Ghost Pro Max trial" CTA can actually run
// every mode that CTA implies instead of hitting the same paywall again.
const TIER_POLICY = {
  // Modes
  'mode:question':         { open: true,              trial: true,  pro: true,  'pro-max': true,  team: true,  'team-max': true,  enterprise: true,  'enterprise-max': true  },
  'mode:chat':             { open: false,              trial: true,  pro: true,  'pro-max': true,  team: true,  'team-max': true,  enterprise: true,  'enterprise-max': true  },
  'mode:recon':            { open: true,               trial: true,  pro: true,  'pro-max': true,  team: true,  'team-max': true,  enterprise: true,  'enterprise-max': true  },
  'mode:poi':              { open: 'quota',            trial: true,  pro: true,  'pro-max': true,  team: true,  'team-max': true,  enterprise: true,  'enterprise-max': true  },
  'mode:blast':            { open: 'quota',            trial: true,  pro: true,  'pro-max': true,  team: true,  'team-max': true,  enterprise: true,  'enterprise-max': true  },
  'mode:conflict':         { open: 'quota',            trial: true,  pro: true,  'pro-max': true,  team: true,  'team-max': true,  enterprise: true,  'enterprise-max': true  },
  'mode:prompt-triage':    { open: 'quota',            trial: true,  pro: true,  'pro-max': true,  team: true,  'team-max': true,  enterprise: true,  'enterprise-max': true  },
  'mode:audit':            { open: false,              trial: true,  pro: true,  'pro-max': true,  team: true,  'team-max': true,  enterprise: true,  'enterprise-max': true  },
  // Ghost Watcher: Team plan and above. Declared here rather than as a literal
  // tier array in bin/ghost.js, which carried TWO independent copies of the same
  // list (the headless --watcher-commit path and the Enable Watch menu path).
  // Two hand-maintained copies of an entitlement list is precisely the drift
  // class that shipped an entitlement bug before. Both now derive from
  // allowedTiers('mode:watch').
  //
  // trial is deliberately false: a 7-day trial should not wire a persistent CI
  // hook into a customer repo that outlives the trial.
  'mode:watch':            { open: false,              trial: false, pro: false, 'pro-max': false, team: true,  'team-max': true,  enterprise: true,  'enterprise-max': true  },
  // Ghost Brief artifact: Max tiers only (pro-max, team-max, enterprise-max).
  // Non-Max paid tiers (pro, team, enterprise) are blocked.
  'mode:ghost-brief':      { open: false,              trial: true,  pro: false, 'pro-max': true,  team: false, 'team-max': true,  enterprise: false, 'enterprise-max': true  },
  // Executive Brief artifact: same Max-tier policy as Ghost Brief (menu labels
  // both "Pro Max or higher"). Declared here so a dispatch-level requireTier()
  // check enforces it even when the menu's disabled-state is bypassed.
  'mode:executive-brief':  { open: false,              trial: true,  pro: false, 'pro-max': true,  team: false, 'team-max': true,  enterprise: false, 'enterprise-max': true  },
  // Commit Forecast: Open gets 'forecast-quota' — a separate 1-run quota managed
  // by src/freemium.js's getForecastCount/incrementForecastCount (isolated from
  // ghostOpenScanCount so daily pro-tier usage patterns don't burn the shared
  // 4-scan quota in minutes). bin/ghost.js checks tier first, then dispatches to
  // renderForecastPaywall when the quota is exhausted. Pro+ are unlimited.
  'mode:commit-forecast':  { open: 'forecast-quota',     trial: true,  pro: true,  'pro-max': true,  team: true,  'team-max': true,  enterprise: true,  'enterprise-max': true  },
  // Corrected-file forecast: Open gets 'fix-forecast-quota' — a separate 1-run
  // quota managed by src/freemium.js's getFixForecastCount/incrementFixForecastCount.
  // Isolated from both SCAN_QUOTA and FORECAST_QUOTA because this is a distinct
  // surface (post-scan fix evaluation vs pre-commit impact analysis).
  'mode:fix-forecast':     { open: 'fix-forecast-quota', trial: true,  pro: true,  'pro-max': true,  team: true,  'team-max': true,  enterprise: true,  'enterprise-max': true  },

  // Features — consulted as soft-gate callout sites (D3 once-per-session
  // suppression). Not yet wired at every site; this is the registry for
  // Phase 2/3 to adopt. Verdict semantics same as modes.
  'feature:profiles':           { open: false, trial: true,  pro: true, 'pro-max': true, team: true, 'team-max': true, enterprise: true, 'enterprise-max': true },
  'feature:project-tracking':   { open: false, trial: true,  pro: true, 'pro-max': true, team: true, 'team-max': true, enterprise: true, 'enterprise-max': true },
  'feature:ghost-partner-pdf':  { open: false, trial: true,  pro: true, 'pro-max': true, team: true, 'team-max': true, enterprise: true, 'enterprise-max': true },
  // verifier-fallback: when a conflict-detection candidate has no usable file
  // references, quickVerify() can fall back to loading ~5K tokens of project
  // context to still produce a verdict. Costs ~5K extra tokens per ambiguous
  // verification. Open gets the cheaper INSUFFICIENT verdict instead; trial+
  // get the fallback. See TODO-verifier-agent-stage3-evaluate.md (closed
  // 2026-05-25 via Cycle 13 Block 2).
  'feature:verifier-fallback':  { open: false, trial: true,  pro: true, 'pro-max': true, team: true, 'team-max': true, enterprise: true, 'enterprise-max': true },
  // pdf-watermark-free: trial gets watermarked PDFs, others get clean PDFs.
  // Open gets clean PDFs too — the freemium gate is quota-based, not
  // watermark-based. Trial is the only "watermarked" tier.
  'feature:pdf-watermark-free': { open: true,  trial: false, pro: true, 'pro-max': true, team: true, 'team-max': true, enterprise: true, 'enterprise-max': true },
};

// Per D1: bumped from 2 to 4. SCAN_QUOTA is the SINGLE SOURCE OF TRUTH for the
// free saved-report quota. There is no parallel constant: src/freemium.js
// imports SCAN_QUOTA directly, so both the enforcement gate here and the quota
// paywall copy in freemium.js read the same value and can never drift apart.
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
    // Fail-loud: a missing count must never silently fall through to 0, which
    // would hand an exhausted Open user unlimited scans. The caller is required
    // to pass the current count (from freemium.getScanCount()), even when 0.
    if (opts.scansUsed === undefined) {
      throw new Error(
        `requireTier('${gateId}'): opts.scansUsed is required for quota verdicts`
      );
    }
    const used = opts.scansUsed;
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
    if (opts.forecastsUsed === undefined) {
      throw new Error(
        `requireTier('${gateId}'): opts.forecastsUsed is required for forecast-quota verdicts`
      );
    }
    const used  = opts.forecastsUsed;
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
    if (opts.fixForecastsUsed === undefined) {
      throw new Error(
        `requireTier('${gateId}'): opts.fixForecastsUsed is required for fix-forecast-quota verdicts`
      );
    }
    const used  = opts.fixForecastsUsed;
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
// Display names for modes that render an upgrade paywall. Fallback strips the
// 'mode:' prefix so a new mode still renders a sensible (if plain) name.
const MODE_DISPLAY = {
  'mode:chat':            'Chat',
  'mode:ghost-brief':     'Ghost Brief™',
  'mode:executive-brief': 'Executive Brief™',
};

// Human labels for tiers, and the order in which we advertise the LOWEST paid
// tier that unlocks a gate. Trial and Open are never advertised as the required
// tier (trial is an evaluation, Open is the thing being upgraded from).
const TIER_DISPLAY = {
  'pro': 'Ghost Pro', 'pro-max': 'Ghost Pro Max',
  'team': 'Ghost Team', 'team-max': 'Ghost Team Max',
  'enterprise': 'Ghost Enterprise', 'enterprise-max': 'Ghost Enterprise Max',
};
const PAID_TIER_ORDER = ['pro', 'pro-max', 'team', 'team-max', 'enterprise', 'enterprise-max'];

// A Max-only gate (Ghost Brief, Executive Brief) allows exactly the three Max
// tiers and blocks their non-Max siblings. Naming only "Ghost Pro Max" (the
// lowest) reads as "Pro Max or higher", which is wrong: Team and Enterprise are
// blocked while Team Max and Enterprise Max are not. Detect that shape so the
// copy can name all three Max plans instead.
const MAX_ONLY_TIERS = ['pro-max', 'team-max', 'enterprise-max'];
const MAX_ONLY_LABEL = 'a Max plan (Pro Max, Team Max, or Enterprise Max)';

function isMaxOnlyGate(gateId) {
  const allowed = new Set(allowedTiers(gateId));
  return MAX_ONLY_TIERS.every(t => allowed.has(t)) &&
    !allowed.has('pro') && !allowed.has('team') && !allowed.has('enterprise');
}

function minRequiredTierLabel(gateId) {
  if (isMaxOnlyGate(gateId)) return MAX_ONLY_LABEL;
  const allowed = new Set(allowedTiers(gateId));
  for (const t of PAID_TIER_ORDER) {
    if (allowed.has(t)) return TIER_DISPLAY[t];
  }
  return 'a paid tier';
}

export function paywallFor(gateId, tier) {
  // Audit-tier-blocked → audit-specific copy (worker-driven promo + Pro feature framing).
  if (gateId === 'mode:audit') {
    return { kind: 'audit', gateId, tier };
  }
  if (gateId.startsWith('mode:')) {
    const verdict = (TIER_POLICY[gateId] || {})[tier];
    // A quota-family verdict on this tier means the user ran out of free runs →
    // "you've used your N free reports" quota paywall.
    if (verdict === 'quota' || verdict === 'forecast-quota' || verdict === 'fix-forecast-quota') {
      return { kind: 'quota', gateId, tier };
    }
    // A hard tier block (verdict === false, or an ineligible/unknown tier) is an
    // UPGRADE prompt, NOT a quota message. Chat and Ghost Brief on Open/pro/team
    // land here and must not read "you've used your 4 free reports" — they were
    // never quota-gated. Carry the mode name and the lowest paid tier that
    // unlocks the mode so the renderer can say exactly what to upgrade to.
    return {
      kind: 'upgrade',
      gateId,
      tier,
      modeName: MODE_DISPLAY[gateId] || gateId.replace(/^mode:/, ''),
      requiredTier: minRequiredTierLabel(gateId),
      // When true, requiredTier is already a complete phrase (a Max-plan list);
      // the renderer must NOT append " or higher", which would misrepresent the
      // gate (there is nothing "higher" than the Max tiers to upgrade to).
      requiredExact: isMaxOnlyGate(gateId),
    };
  }
  // Feature gates currently have no rendered paywall — Phase 2/3 will wire
  // soft-gate callouts (D3) at feature sites instead of blocking. Returned
  // kind:'unknown' so a caller that mistakenly tries to render gets a
  // visible "where's the renderer" signal rather than a silent no-op.
  return { kind: 'unknown', gateId, tier };
}

/**
 * Return the list of tiers explicitly allowed (verdict === true) for a gate.
 * The single source of truth for "which tiers can do X" — callers derive their
 * tier lists from this instead of hardcoding a parallel array that can drift
 * from TIER_POLICY. Quota verdicts ('quota', 'forecast-quota', etc.) are not
 * `true`, so they are excluded; this returns only the unconditionally-allowed
 * tiers. Unknown gate ids yield an empty list.
 *
 * @param {string} gateId  e.g. 'mode:ghost-brief'
 * @returns {string[]} tiers whose policy verdict is exactly true
 */
export function allowedTiers(gateId) {
  const policy = TIER_POLICY[gateId] || {};
  return Object.entries(policy)
    .filter(([, v]) => v === true)
    .map(([t]) => t);
}

// Exported for tests. Not part of the public CLI surface.
export { TIER_POLICY };
