// src/freemium.js — Ghost Open v6.0.0 freemium gate.
//
// Open is free for the first two saved reports. After that, scans that
// produce a saved report (POI, Blast, Conflict, Prompt Triage) are blocked
// behind a paywall directing users to ghostarchitect.dev/pricing. Inheritance
// Audit is always paywalled — it's a Pro-tier deliverable.
//
// Non-counting modes — Chat and Recon — remain free forever. Chat is
// interactive exploration with no saved deliverable; Recon is sizing without
// analysis. Neither competes with the paid product.
//
// State is stored in configstore under key 'ghostOpenScanCount'. The counter
// is bumped in src/reports.js's saveReport() AFTER a successful save, so a
// crashed scan doesn't burn a credit. The counter is intentionally local-
// only (no server sync) — Open is an honor-system free tier; we don't want
// to track usage server-side for privacy reasons.
//
// Existing Open users get 20% off their first month on any paid tier via
// promotion code EARLY20 at Stripe checkout. The discount is presented in
// the paywall copy with limited-time framing to drive conversion urgency.
// The code itself is configured on Stripe Dashboard with duration=once.

import Configstore from 'configstore';
import chalk from 'chalk';
import boxen from 'boxen';

const CONFIGSTORE_NAME = 'ghost-architect';
const COUNT_KEY = 'ghostOpenScanCount';

// Modes whose successful saved-report runs count toward the free quota.
// Chat (no save), Recon (no save), and Audit (always paywalled separately)
// are intentionally excluded.
const COUNTED_PREFIXES = new Set([
  'ghost-poi',
  'ghost-blast',
  'ghost-conflict',
  'ghost-prompt-triage',
]);

// Mode-id-to-prefix mapping for the gate check (called from bin/ghost.js
// before mode dispatch, before the prefix is known by the mode itself).
const MODE_TO_PREFIX = {
  'poi':           'ghost-poi',
  'blast':         'ghost-blast',
  'conflict':      'ghost-conflict',
  'prompt-triage': 'ghost-prompt-triage',
};

export const FREE_QUOTA = 2;

function getStore() {
  return new Configstore(CONFIGSTORE_NAME);
}

export function getScanCount() {
  return getStore().get(COUNT_KEY) || 0;
}

export function incrementScanCount(prefix) {
  if (!COUNTED_PREFIXES.has(prefix)) return;
  const store = getStore();
  const current = store.get(COUNT_KEY) || 0;
  store.set(COUNT_KEY, current + 1);
}

// Test helper. Not exposed in CLI flags — only callable from code or by
// editing the configstore file at ~/.config/configstore/ghost-architect.json
export function resetScanCount() {
  getStore().delete(COUNT_KEY);
}

// Called from bin/ghost.js right before dispatching to a mode. Returns:
//   { block: false }            — proceed with the scan
//   { block: true, reason: 'audit' }  — Audit-specific paywall
//   { block: true, reason: 'quota' }  — quota-exhausted paywall
export function shouldBlockMode(modeId) {
  // Audit is always paywalled in Open. v6.0.0 ships subscription-only.
  // Single-run Audit is a v6.1.0 follow-up.
  if (modeId === 'audit') {
    return { block: true, reason: 'audit' };
  }
  // Non-counted modes (chat, recon) are unlimited.
  const prefix = MODE_TO_PREFIX[modeId];
  if (!prefix) return { block: false };
  // Counted modes hit the quota gate.
  const count = getScanCount();
  if (count >= FREE_QUOTA) {
    return { block: true, reason: 'quota' };
  }
  return { block: false };
}

// Render the Audit-specific paywall. Shown when user picks Audit from the
// mode menu in Open. Caller (bin/ghost.js) should `continue` the menu loop
// after this returns so the user can pick a different mode.
export function renderAuditPaywall() {
  const lines = [
    chalk.cyan.bold('📋  Inheritance Audit — Pro feature'),
    '',
    chalk.white('The Inheritance Audit produces a deal-grade report for'),
    chalk.white('buyer diligence, fractional CTO onboarding, and'),
    chalk.white('modernization scoping. It is a paid Pro+ feature.'),
    '',
    chalk.white('Upgrade to Pro for unlimited Audit + all other modes:'),
    chalk.cyan('  https://ghostarchitect.dev/pricing'),
    '',
    chalk.yellow.bold('Existing Ghost Open users:'),
    chalk.yellow('Use code ') + chalk.yellow.bold('EARLY20') +
      chalk.yellow(' at checkout for 20% off your first'),
    chalk.yellow('month on any tier (Pro, Team, or Enterprise).'),
    chalk.yellow.bold('Limited time. Limited number of discounts available.'),
  ];
  console.log('\n' + boxen(lines.join('\n'), {
    padding: 1,
    borderColor: 'cyan',
    borderStyle: 'round',
  }));
  console.log('');
}

// Render the quota-exhausted paywall. Shown when user picks a counted mode
// (POI / Blast / Conflict / Prompt Triage) and has already used 2 free runs.
export function renderQuotaPaywall() {
  const lines = [
    chalk.yellow.bold(`You've used your ${FREE_QUOTA} free Ghost Architect reports.`),
    '',
    chalk.white('Upgrade to keep going — unlimited reports, all modes'),
    chalk.white('including Inheritance Audit, hardware-bound license,'),
    chalk.white('and email support.'),
    '',
    chalk.white('Tiers available at ') + chalk.cyan('https://ghostarchitect.dev/pricing') + chalk.white(':'),
    chalk.gray('  • Pro        — $99/mo'),
    chalk.gray('  • Team       — $399/mo'),
    chalk.gray('  • Enterprise — $1,200/mo'),
    '',
    chalk.yellow.bold('Existing Ghost Open users:'),
    chalk.yellow('Use code ') + chalk.yellow.bold('EARLY20') +
      chalk.yellow(' at checkout for 20% off your first'),
    chalk.yellow('month on any tier.'),
    chalk.yellow.bold('Limited time. Limited number of discounts available.'),
    '',
    chalk.white('Chat and Recon modes remain free.'),
  ];
  console.log('\n' + boxen(lines.join('\n'), {
    padding: 1,
    borderColor: 'yellow',
    borderStyle: 'round',
  }));
  console.log('');
}
