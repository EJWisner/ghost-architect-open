// src/loader/tierCaps.js
// Tier-gated context limits for Ghost Architect.
// Each branch (ghost-open, main/Pro, ghost-team) sets its own TIER constant
// in bin/ghost.js. Enterprise tier is detected at runtime via repo name check.

import chalk from 'chalk';

export const TIER_CAPS = {
  open: 50000,
  pro: 100000,
  team: 150000,
  enterprise: 200000,
};

const UPGRADE_HINTS = {
  open: 'Upgrade to Pro for 100K, Team for 150K, or Enterprise for 200K.',
  pro: 'Upgrade to Team for 150K or Enterprise for 200K.',
  team: 'Upgrade to Enterprise for 200K.',
  enterprise: null,
};

/**
 * Resolve the effective context cap for this run.
 *
 * @param {string} tier - 'open' | 'pro' | 'team' | 'enterprise'
 * @param {number|null|undefined} userRequested - value from --max-context, or null/undefined
 * @returns {{ effective: number, clamped: boolean, tierCap: number, tier: string }}
 */
export function resolveContextCap(tier, userRequested) {
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
    console.warn(chalk.yellow(`⚠ --max-context ${userRequested.toLocaleString()} exceeds your tier limit (${tierCap.toLocaleString()}). Clamping to ${tierCap.toLocaleString()}.`));
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
