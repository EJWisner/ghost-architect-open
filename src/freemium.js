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

import Configstore from 'configstore';
import chalk from 'chalk';
import boxen from 'boxen';
// FORECAST_QUOTA is owned by tier-gates.js (the policy source of truth).
// Imported here so renderForecastPaywall copy stays in sync without duplicating
// the constant. tier-gates never imports freemium — no circular dependency.
import { FORECAST_QUOTA } from './license/tier-gates.js';

const CONFIGSTORE_NAME = 'ghost-architect';
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

// Per D1 (locked 2026-05-23): bumped from 2 to 4 free saved reports. The
// SCAN_QUOTA constant in src/license/tier-gates.js MUST stay in sync with
// this value. Both live with the value 4; tier-gates is the policy source
// of truth, this is the legacy backward-compat reference used by the quota
// paywall copy below.
export const FREE_QUOTA = 4;

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

// ── Commit Forecast quota helpers ─────────────────────────────────────────────
// Isolated from the main scan counter. See FORECAST_COUNT_KEY comment above.

export function getForecastCount() {
  return getStore().get(FORECAST_COUNT_KEY) || 0;
}

export function incrementForecastCount() {
  const store = getStore();
  const current = store.get(FORECAST_COUNT_KEY) || 0;
  store.set(FORECAST_COUNT_KEY, current + 1);
}

// Test helper.
export function resetForecastCount() {
  getStore().delete(FORECAST_COUNT_KEY);
}

// Render the Commit Forecast quota-exhausted paywall for Open tier.
// paywallPromo is worker-driven; empty string = no promo block.
export function renderForecastPaywall(paywallPromo = '') {
  const lines = [
    chalk.yellow.bold(`You've used your free Commit Forecast.`),
    '',
    chalk.white('Commit Forecast is designed to run continuously — before every'),
    chalk.white('push, every review cycle, every offshore file drop.'),
    chalk.white('Upgrade to Pro, Team, or Enterprise for unlimited Commit Forecasts.'),
  ];
  if (paywallPromo) {
    lines.push('');
    lines.push(chalk.cyan.bold(paywallPromo));
  }
  lines.push('');
  lines.push(chalk.white('What Pro, Team, and Enterprise unlock:'));
  lines.push(chalk.gray('  • Unlimited Commit Forecasts'));
  lines.push(chalk.gray('  • Unlimited POI, Blast, Conflict, Prompt Triage reports'));
  lines.push(chalk.gray('  • Project tracking and history'));
  lines.push(chalk.gray('  • Inheritance Audit'));
  lines.push('');
  lines.push(chalk.white('Upgrade at ') + chalk.cyan('https://ghostarchitect.dev/pricing') + chalk.white(':'));
  lines.push(chalk.gray('  Pro        $99/mo'));
  lines.push(chalk.gray('  Team       $399/mo'));
  lines.push(chalk.gray('  Enterprise $1,200/mo'));
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
  if (count >= FREE_QUOTA) {
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
    chalk.cyan.bold('📋  Inheritance Audit — Pro feature'),
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
  lines.push(chalk.white('Upgrade to Pro for unlimited Audit + all other modes:'));
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
// (POI / Blast / Conflict / Prompt Triage) and has already used 2 free runs.
// paywallPromo is worker-driven; when empty the promo block is not rendered.
export function renderQuotaPaywall(paywallPromo = '') {
  const lines = [
    chalk.yellow.bold(`You've used your ${FREE_QUOTA} free Ghost Architect reports.`),
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
  lines.push(chalk.white('Tiers available at ') + chalk.cyan('https://ghostarchitect.dev/pricing') + chalk.white(':'));
  lines.push(chalk.gray('  Pro        $99/mo'));
  lines.push(chalk.gray('  Team       $399/mo'));
  lines.push(chalk.gray('  Enterprise $1,200/mo'));
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
