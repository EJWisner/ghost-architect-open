// src/loader/tierCaps.js
// Tier-gated context limits for Ghost Architect.
// Each branch (ghost-open, main/Pro, ghost-team) sets its own TIER constant
// in bin/ghost.js. Enterprise tier is detected at runtime via repo name check.

import chalk from 'chalk';

export const TIER_CAPS = {
  open: 50000,
  // Trial behaves like Pro for mode access but shares Open's context cap.
  // Must exist explicitly: getActiveTier() can return 'trial', and without this
  // key getTierCap()/resolveContextCap() fall back to Open's 50K implicitly —
  // correct value, but only by accident. Make it intentional.
  trial: 50000,
  pro: 100000,
  team: 150000,
  enterprise: 200000,
  // Max tiers share the context cap of their base tier (the Max upgrade adds
  // Ghost Brief / Unified Brief / co-engagement, not context). These keys must
  // exist explicitly: getActiveTier() returns the raw license tier string
  // ('pro-max', etc.), so without them getTierCap() falls back to Open's 50K
  // and silently under-caps paying Max customers.
  'pro-max': 100000,
  'team-max': 150000,
  'enterprise-max': 200000,
};

const UPGRADE_HINTS = {
  open: 'Upgrade to Pro for 100K, Team for 150K, or Enterprise for 200K.',
  trial: 'Upgrade to Ghost Pro for 100K token context and unlimited scans',
  pro: 'Upgrade to Team for 150K or Enterprise for 200K.',
  team: 'Upgrade to Enterprise for 200K.',
  enterprise: null,
  'pro-max': 'Upgrade to Team for 150K or Enterprise for 200K.',
  'team-max': 'Upgrade to Enterprise for 200K.',
  'enterprise-max': null,
};

/**
 * Resolve the effective context cap for this run.
 *
 * @param {string} tier - 'open' | 'pro' | 'pro-max' | 'team' | 'team-max' | 'enterprise' | 'enterprise-max'
 * @param {number|null|undefined} userRequested - value from --max-context, or null/undefined
 * @param {'cli'|'config'|'default'} [source='cli'] - where userRequested came from.
 *   'cli' = --max-context flag (the visible user action).
 *   'config' = configstore.maxTokensContext (saved settings, often leftover
 *              from a prior `ghost reconfigure` on a higher tier).
 *   'default' = the hardcoded 50000 fallback.
 *   Used to phrase the over-cap warning so it names the actual provenance
 *   rather than always pointing at --max-context. See
 *   TODO-architect-open-clamp-message-misleading.md for context.
 * @returns {{ effective: number, clamped: boolean, tierCap: number, tier: string }}
 */
export function resolveContextCap(tier, userRequested, source = 'default') {
  const normalizedTier = (tier || 'open').toLowerCase();
  const tierCap = TIER_CAPS[normalizedTier] ?? TIER_CAPS.open;

  if (userRequested == null) {
    return { effective: tierCap, clamped: false, tierCap, tier: normalizedTier };
  }

  if (typeof userRequested !== 'number' || !Number.isFinite(userRequested) || userRequested <= 0) {
    console.warn(chalk.yellow(`⚠ Invalid --max-context value. Using tier default: ${tierCap.toLocaleString()} tokens.`));
    return { effective: tierCap, clamped: false, tierCap, tier: normalizedTier };
  }

  if (userRequested > tierCap) {
    const hint = UPGRADE_HINTS[normalizedTier];
    // Branch the warning by source so the user knows where the request came from.
    // Prior wording ("--max-context X exceeds...") was misleading when the value
    // came from configstore (a prior `ghost reconfigure` from a higher tier) and
    // the user never passed a flag — they'd see a warning naming a CLI surface
    // they hadn't touched. Filed under TODO-architect-open-clamp-message-misleading.md.
    let msg;
    if (source === 'config') {
      msg = `⚠ Context cap clamped from ${userRequested.toLocaleString()} (from saved settings) to ${tierCap.toLocaleString()} on the ${normalizedTier} tier. Run \`ghost --reconfigure\` to update your default.`;
    } else {
      // 'cli' (the common case) or 'default' fallback — both reference --max-context
      // as the visible source. 'default' is a defensive case that shouldn't occur in
      // practice (default = 50000 = Open's cap, never exceeds), but the wording is
      // safe if it ever does.
      msg = `⚠ --max-context ${userRequested.toLocaleString()} exceeds your tier limit (${tierCap.toLocaleString()}). Clamping to ${tierCap.toLocaleString()}.`;
    }
    console.warn(chalk.yellow(msg));
    if (hint) console.warn(chalk.gray(`  ${hint}`));
    return { effective: tierCap, clamped: true, tierCap, tier: normalizedTier };
  }

  return { effective: userRequested, clamped: false, tierCap, tier: normalizedTier };
}

/**
 * Get the tier cap without applying any user override.
 * Used when we just want to know the ceiling.
 */
export function getTierCap(tier) {
  const normalizedTier = (tier || 'open').toLowerCase();
  return TIER_CAPS[normalizedTier] ?? TIER_CAPS.open;
}
