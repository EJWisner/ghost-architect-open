// src/freemium.js — Ghost Open v6.0.0 freemium gate.
//
// Open is free for the first FOUR saved reports (bumped from 2 → 4 per
// D1 locked 2026-05-23). After that, scans that produce a saved report
// (POI, Blast, Conflict, Prompt Triage) are blocked behind a paywall
// directing users to ghostarchitect.dev/pricing. Inheritance Audit is
// always paywalled — it's a Pro-tier deliverable.
//
// As of v7-unified Phase 1 (2026-05-23): the gate DECISION moved to
// src/license/tier-gates.js's requireTier() so all tiers share one
// policy module. This file keeps the disk I/O (scan count storage) and
// the two renderers (renderAuditPaywall, renderQuotaPaywall). Paywall
// copy is server-driven via PAYWALL_PROMO_TEXT in the signup worker;
// freemium.js owns the box structure and static body text, the worker
// owns the promo line. bin/ghost.js calls requireTier() for the verdict
// and then dispatches to the appropriate renderer here based on the
// verdict's paywall.kind ('audit' | 'quota').
//
// `shouldBlockMode()` is kept for backward compatibility with any caller
// outside bin/ghost.js, but bin/ghost.js no longer calls it. New callers
// should use requireTier() instead.
//
// Non-counting modes — Question and Recon — remain free forever for Open.
// Question is single-shot Q&A with an optional save; Recon is sizing without
// analysis. Neither competes with the paid product. Chat (multi-turn
// conversation) moved to Pro+ in Cycle 14 — it's gated at dispatch in
// bin/ghost.js via requireTier('mode:chat') and is not Open-reachable.
//
// State is stored in configstore under key 'ghostOpenScanCount'. The counter
// is bumped in src/reports.js's saveReport() AFTER a successful save, so a
// crashed scan doesn't burn a credit. The counter is intentionally local-
// only (no server sync) — Open is an honor-system free tier; we don't want
// to track usage server-side for privacy reasons.
//
// Paywall promo copy is server-driven via PAYWALL_PROMO_TEXT in
// signup-worker; fetched alongside the welcome banner promo on each CLI
// invocation. Empty string in the worker = no promo block rendered. EJ
// edits the worker constant and redeploys to change paywall messaging
// without a CLI republish.

import { getConfig } from './config.js';
import chalk from 'chalk';
import boxen from 'boxen';
// FORECAST_QUOTA is owned by tier-gates.js (the policy source of truth).
// Imported here so renderForecastPaywall copy stays in sync without duplicating
// the constant. tier-gates never imports freemium — no circular dependency.
import { SCAN_QUOTA } from './license/tier-gates.js';
import { FORECAST_QUOTA } from './license/tier-gates.js';
import { FIX_FORECAST_QUOTA } from './license/tier-gates.js';
// Pricing is owned by src/constants/pricing.js (the single source of truth for
// tier prices and the free-trial CTA). Imported here so every paywall renderer
// quotes prices from one place instead of hardcoding them per renderer.
import { PRICING } from './constants/pricing.js';

const COUNT_KEY = 'ghostOpenScanCount';
// Separate counter for Commit Forecast. Isolated from ghostOpenScanCount
// because Forecast is the only mode designed to run many times per
// developer per day — a shared counter would drain the 4-scan quota in
// minutes. Open gets FORECAST_QUOTA free Forecasts total (per-install,
// same honor-system contract as the main quota). Pro+ see no gate at all;
// tier-gates.js handles that distinction. Counter is bumped in
// src/modes/commit-forecast.js after a successful run.
const FORECAST_COUNT_KEY = 'ghostOpenForecastCount';
// FORECAST_QUOTA imported from tier-gates.js above — do not re-declare here.

// Modes whose successful saved-report runs count toward the free quota.
// Question (single-shot Q&A — separate Open-tier free mode), Recon (no
// save), and Audit (always paywalled separately) are intentionally excluded.
// Chat is excluded because Cycle 14 moved it to Pro+ — it's gated at
// dispatch and never reaches saveReport on an Open license.
const COUNTED_PREFIXES = new Set([
  'ghost-poi',
  'ghost-blast',
  'ghost-conflict',
  'ghost-prompt-triage',
  // Commit Forecast has its own separate counter (FORECAST_COUNT_KEY) because
  // it is designed to run many times per day and would drain the shared quota
  // in minutes. Open gets 1 free Forecast; Pro+ are unlimited. The counter is
  // bumped in src/modes/commit-forecast.js after a successful forecast run,
  // not in saveReport, because Forecast output is not a "saved report" in the
  // traditional sense — it's an ephemeral analysis artifact.
]);

// Mode-id-to-prefix mapping for the gate check (called from bin/ghost.js
// before mode dispatch, before the prefix is known by the mode itself).
const MODE_TO_PREFIX = {
  'poi':           'ghost-poi',
  'blast':         'ghost-blast',
  'conflict':      'ghost-conflict',
  'prompt-triage': 'ghost-prompt-triage',
};

// Per D1 (locked 2026-05-23): the free saved-report quota is 4. The value
// lives in src/license/tier-gates.js as SCAN_QUOTA (the policy source of
// truth) and is imported above; the quota paywall copy below references it.

function getStore() {
  return getConfig();
}

// Quota counters are the paywall's only enforcement surface. A configstore
// read/write failure must never open the gate. safeGetCount fails closed: an
// unreadable counter is treated as "quota exhausted" (MAX_SAFE_INTEGER) so the
// free tier blocks rather than granting unlimited scans. safeIncrementCount
// fails closed too: if the post-scan bump can't persist, the scan is blocked as
// a precaution rather than letting the counter silently stay put.
function safeGetCount(key) {
  try {
    return getStore().get(key) || 0;
  } catch (_) {
    // On read failure assume quota exhausted
    return Number.MAX_SAFE_INTEGER;
  }
}

function safeIncrementCount(key) {
  try {
    const current = getStore().get(key) || 0;
    getStore().set(key, current + 1);
  } catch (err) {
    process.stderr.write(
      '[Ghost] Quota counter write failed: ' +
      err.message + '. Scan blocked as a precaution.\n'
    );
    throw new Error(
      'Quota system error. Please contact ' +
      'support@ghostarchitect.dev if this persists.'
    );
  }
}

export function getScanCount() {
  return safeGetCount(COUNT_KEY);
}

export function incrementScanCount(prefix) {
  if (!COUNTED_PREFIXES.has(prefix)) return;
  safeIncrementCount(COUNT_KEY);
}

// Test helper. Not exposed in CLI flags — only callable from code or by
// editing the configstore file at ~/.config/configstore/ghost-architect.json
export function resetScanCount() {
  getStore().delete(COUNT_KEY);
}

// ── Commit Forecast quota helpers ─────────────────────────────────────────────
// Isolated from the main scan counter. See FORECAST_COUNT_KEY comment above.

export function getForecastCount() {
  return safeGetCount(FORECAST_COUNT_KEY);
}

export function incrementForecastCount() {
  safeIncrementCount(FORECAST_COUNT_KEY);
}

// Test helper.
export function resetForecastCount() {
  getStore().delete(FORECAST_COUNT_KEY);
}

// ── Corrected-file forecast quota helpers ─────────────────────────────────────
// Isolated from both ghostOpenScanCount and ghostOpenForecastCount.
// Corrected-file forecast is a distinct surface (post-scan fix evaluation)
// from pre-commit Commit Forecast. Each gets its own 1-run Open quota.
// Counter bumped in src/modes/fix-forecast-writer.js after full success.
const FIX_FORECAST_COUNT_KEY = 'ghostOpenFixForecastCount';
// FIX_FORECAST_QUOTA imported from tier-gates.js above — do not re-declare.

export function getFixForecastCount() {
  return safeGetCount(FIX_FORECAST_COUNT_KEY);
}

export function incrementFixForecastCount() {
  safeIncrementCount(FIX_FORECAST_COUNT_KEY);
}

// Test helper.
export function resetFixForecastCount() {
  getStore().delete(FIX_FORECAST_COUNT_KEY);
}

// ── Shared paywall CTA fragments ──────────────────────────────────────────────
// Both fragments read from PRICING (src/constants/pricing.js) so a price or
// trial change lands in one place. Each returns an array of chalk-styled lines
// spread into a renderer's `lines` array with lines.push(...).

// The free-trial call-to-action, shown first in every paywall's CTA block —
// before any --activate or /pricing reference.
function trialCtaLines() {
  return [
    chalk.green.bold(`Start a free ${PRICING.TRIAL_DAYS}-day Ghost Pro Max™ trial (no card required):`),
    chalk.cyan('  ' + PRICING.TRIAL_URL.replace(/^https?:\/\//, '')),
  ];
}

// The tier price list. Labels are padded so the price column aligns.
function tierPriceLines() {
  return [
    chalk.gray('  ' + 'Pro'.padEnd(11) + `$${PRICING.PRO.monthly}/mo`),
    chalk.gray('  ' + 'Pro Max'.padEnd(11) + `$${PRICING.PRO_MAX.monthly}/mo`),
    chalk.gray('  See all plans: ghostarchitect.dev/pricing'),
  ];
}

// Render the Commit Forecast quota-exhausted paywall for Open tier.
// paywallPromo is worker-driven; empty string = no promo block.
export function renderForecastPaywall(paywallPromo = '') {
  const lines = [
    chalk.yellow.bold(`You've used your free Commit Forecast.`),
    '',
    chalk.white('Commit Forecast is designed to run continuously: before every'),
    chalk.white('push, every review cycle, every offshore file drop.'),
    chalk.white('Upgrade to Pro, Pro Max, Team, or Enterprise for unlimited Commit Forecasts.'),
  ];
  if (paywallPromo) {
    lines.push('');
    lines.push(chalk.cyan.bold(paywallPromo));
  }
  lines.push('');
  lines.push(chalk.white('What Pro, Pro Max, Team, and Enterprise unlock:'));
  lines.push(chalk.gray('  • Unlimited Commit Forecasts'));
  lines.push(chalk.gray('  • Unlimited POI, Blast, Conflict, Prompt Triage reports'));
  lines.push(chalk.gray('  • Project tracking and history'));
  lines.push(chalk.gray('  • Inheritance Audit'));
  lines.push('');
  lines.push(...trialCtaLines());
  lines.push('');
  lines.push(chalk.white('Upgrade at ') + chalk.cyan('https://ghostarchitect.dev/pricing') + chalk.white(':'));
  lines.push(...tierPriceLines());
  lines.push('');
  lines.push(chalk.white('Have a license? Activate it:'));
  lines.push(chalk.cyan('  ghost --activate <your key here>'));
  console.log('\n' + boxen(lines.join('\n'), {
    padding: 1,
    borderColor: 'yellow',
    borderStyle: 'round',
  }));
  console.log('');
}

// Render the corrected-file forecast quota-exhausted paywall for Open tier.
// Distinct from renderForecastPaywall (pre-commit Commit Forecast) so users
// who hit both paywalls recognise them as separate surfaces.
// paywallPromo is worker-driven; empty string = no promo block rendered.
export function renderFixForecastPaywall(paywallPromo = '') {
  const lines = [
    chalk.yellow.bold(`You've used your free corrected-file forecast for this install.`),
    '',
    chalk.white(`Corrected-file forecast shows you what would happen if you applied`),
    chalk.white(`Ghost's suggested fix - without touching your code. See the impact`),
    chalk.white(`on your codebase before you ship the change.`),
    '',
    chalk.white('Upgrade to Pro, Pro Max, Team, or Enterprise for unlimited corrected-file'),
    chalk.white('forecasts on every Ghost-suggested fix you want to evaluate.'),
  ];
  if (paywallPromo) {
    lines.push('');
    lines.push(chalk.cyan.bold(paywallPromo));
  }
  lines.push('');
  lines.push(chalk.white('What Pro, Pro Max, Team, and Enterprise unlock:'));
  lines.push(chalk.gray('  • Unlimited corrected-file forecasts'));
  lines.push(chalk.gray('  • Unlimited Commit Forecasts'));
  lines.push(chalk.gray('  • Unlimited POI, Blast, Conflict, Prompt Triage reports'));
  lines.push(chalk.gray('  • Project tracking and history'));
  lines.push(chalk.gray('  • Inheritance Audit'));
  lines.push('');
  lines.push(...trialCtaLines());
  lines.push('');
  lines.push(chalk.white('Upgrade at ') + chalk.cyan('https://ghostarchitect.dev/pricing') + chalk.white(':'));
  lines.push(...tierPriceLines());
  lines.push('');
  lines.push(chalk.white('Have a license? Activate it:'));
  lines.push(chalk.cyan('  ghost --activate <your key here>'));
  console.log('\n' + boxen(lines.join('\n'), {
    padding: 1,
    borderColor: 'yellow',
    borderStyle: 'round',
  }));
  console.log('');
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
  // Non-counted modes (question, recon) are unlimited on Open. Chat moved
  // to Pro+ in Cycle 14 — dispatch gates it before reaching this function.
  const prefix = MODE_TO_PREFIX[modeId];
  if (!prefix) return { block: false };
  // Counted modes hit the quota gate.
  const count = getScanCount();
  if (count >= SCAN_QUOTA) {
    return { block: true, reason: 'quota' };
  }
  return { block: false };
}

// Render the Audit-specific paywall. Shown when user picks Audit from the
// mode menu in Open. Caller (bin/ghost.js) should `continue` the menu loop
// after this returns so the user can pick a different mode. paywallPromo
// is worker-driven; when empty the promo block is not rendered.
export function renderAuditPaywall(paywallPromo = '') {
  const lines = [
    chalk.cyan.bold('📋  Inheritance Audit - Pro feature'),
    '',
    chalk.white('The Inheritance Audit produces a deal-grade report for'),
    chalk.white('buyer diligence, fractional CTO onboarding, and'),
    chalk.white('modernization scoping.'),
  ];
  if (paywallPromo) {
    lines.push('');
    lines.push(chalk.cyan.bold(paywallPromo));
  }
  lines.push('');
  lines.push(...trialCtaLines());
  lines.push('');
  lines.push(chalk.white('Upgrade to Pro or Pro Max for unlimited Audit. Ghost Brief™ requires Pro Max.'));
  lines.push(chalk.cyan('  https://ghostarchitect.dev/pricing'));
  lines.push('');
  lines.push(chalk.white('Have a license? Activate it:'));
  lines.push(chalk.cyan('  ghost --activate <your key here>'));
  console.log('\n' + boxen(lines.join('\n'), {
    padding: 1,
    borderColor: 'cyan',
    borderStyle: 'round',
  }));
  console.log('');
}

// Render the quota-exhausted paywall. Shown when user picks a counted mode
// (POI / Blast / Conflict / Prompt Triage) and has already used 4 free scans.
// paywallPromo is worker-driven; when empty the promo block is not rendered.
export function renderQuotaPaywall(paywallPromo = '') {
  const lines = [
    chalk.yellow.bold(`You've used your ${SCAN_QUOTA} free Ghost Architect™ reports.`),
    '',
    chalk.white('Upgrade to keep going: unlimited reports, all modes'),
    chalk.white('including Inheritance Audit, hardware-bound license,'),
    chalk.white('and email support.'),
  ];
  if (paywallPromo) {
    lines.push('');
    lines.push(chalk.cyan.bold(paywallPromo));
  }
  lines.push('');
  lines.push(...trialCtaLines());
  lines.push('');
  lines.push(chalk.white('Tiers available at ') + chalk.cyan('https://ghostarchitect.dev/pricing') + chalk.white(':'));
  lines.push(...tierPriceLines());
  lines.push('');
  lines.push(chalk.white('Have a license? Activate it:'));
  lines.push(chalk.cyan('  ghost --activate <your key here>'));
  lines.push('');
  lines.push(chalk.white('Question and Recon modes remain free.'));
  console.log('\n' + boxen(lines.join('\n'), {
    padding: 1,
    borderColor: 'yellow',
    borderStyle: 'round',
  }));
  console.log('');
}

// Render the tier-upgrade paywall. Shown when a mode is TIER-blocked (not
// quota-blocked): Chat, Ghost Brief, or Executive Brief on a tier that does not
// include them. Unlike the quota paywall, this must NOT say "you've used your N
// free reports" -- these modes were never counted. modeName and requiredTier
// come from the paywall payload built in tier-gates.paywallFor().
export function renderUpgradePaywall(paywall = {}, paywallPromo = '') {
  const modeName = paywall.modeName || 'This mode';
  const requiredTier = paywall.requiredTier || 'a paid tier';
  const lines = [
    chalk.yellow.bold(`${modeName} requires ${requiredTier} or higher.`),
  ];
  if (paywallPromo) {
    lines.push('');
    lines.push(chalk.cyan.bold(paywallPromo));
  }
  lines.push('');
  lines.push(...trialCtaLines());
  lines.push('');
  lines.push(chalk.white('Or upgrade at: ') + chalk.cyan('ghostarchitect.dev/pricing'));
  lines.push('');
  lines.push(chalk.white('Have a license? Activate it:'));
  lines.push(chalk.cyan('  ghost --activate <your key here>'));
  console.log('\n' + boxen(lines.join('\n'), {
    padding: 1,
    borderColor: 'yellow',
    borderStyle: 'round',
  }));
  console.log('');
}
