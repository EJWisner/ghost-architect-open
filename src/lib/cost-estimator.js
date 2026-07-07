/**
 * Ghost Architect — Transport cost estimator (CLI menu layer)
 *
 * Thin wrapper over src/core/estimator.js. PRICING is the single source of
 * truth there (see that file's header); we do NOT duplicate per-million rates
 * here. What this module owns is the streaming-vs-batch framing for the
 * transport-selection menu:
 *
 *   - per-mode OUTPUT token estimates sized for the menu (the spec's numbers,
 *     which intentionally run higher than core/estimator's display-panel
 *     estimates because the menu is a cost-commitment surface, not a glance),
 *   - the batch = streaming * 0.50 relationship (Anthropic Message Batches API
 *     is half price), and
 *   - the { streamingCost, batchCost, inputTokens, outputTokens } shape the
 *     menu renders from.
 *
 * Pricing model is claude-sonnet-4-6 by default (Ghost's default runtime
 * model). Pass an explicit model to estimate against another tier.
 */

import { getPricing } from '../core/estimator.js';

// Batch API discount. Anthropic's Message Batches API processes asynchronously
// at half the per-token price of the synchronous/streaming Messages API.
export const BATCH_DISCOUNT = 0.50;

// Per-mode output-token estimates for the transport menu. These are the
// spec's v9.3.0 figures, deliberately distinct from core/estimator's
// MODE_OUTPUT_ESTIMATES (which sizes the at-a-glance cost panel). The menu is
// the point where the user commits real spend, so it estimates a fuller
// response. Keys match the mode identifiers the modes pass in.
const MENU_OUTPUT_TOKENS = {
  blast:        4000,
  'blast-radius': 4000,
  poi:          4000,
  conflict:     4000,
  brief:        6000,
  'ghost-brief': 6000,
  question:     2000,
  // These modes previously fell through to DEFAULT_OUTPUT_TOKENS (4000), which
  // silently mis-estimated their real output. MENU-scale ("fuller response")
  // values per the note above, deliberately higher than core/estimator's
  // per-call MODE_OUTPUT_ESTIMATES (which size the at-a-glance panel, not spend).
  audit:           8000,   // deal-grade report, long output
  'prompt-triage': 3000,   // per-prompt findings list
  recon:           2000,   // scoping summary, shorter output
  forecast:        4000,   // impact analysis, medium output
};

const DEFAULT_OUTPUT_TOKENS = 4000;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Output-token estimate for a mode's transport-menu cost line.
 * Falls back to DEFAULT_OUTPUT_TOKENS for an unknown mode.
 */
export function outputTokensForMode(mode) {
  return MENU_OUTPUT_TOKENS[mode] || DEFAULT_OUTPUT_TOKENS;
}

/**
 * Estimate streaming and batch cost for a scan.
 *
 * @param {object}  args
 * @param {number}  args.inputTokens   token count from the loaded context
 * @param {string}  args.mode          mode id (blast, poi, conflict, brief, question)
 * @param {string} [args.model]        model id (default claude-sonnet-4-6)
 * @param {number} [args.outputTokens] override the per-mode output estimate
 * @returns {{ streamingCost:number, batchCost:number, inputTokens:number, outputTokens:number, model:string }}
 */
export function estimateTransportCost({ inputTokens, mode, model, outputTokens } = {}) {
  const resolvedModel  = model || DEFAULT_MODEL;
  const pricing        = getPricing(resolvedModel);
  const inTokens       = Math.max(0, Math.round(inputTokens || 0));
  const outTokens      = Math.max(0, Math.round(outputTokens != null ? outputTokens : outputTokensForMode(mode)));

  const streamingCost =
    (inTokens  / 1_000_000) * pricing.inputPerM +
    (outTokens / 1_000_000) * pricing.outputPerM;
  const batchCost = streamingCost * BATCH_DISCOUNT;

  return {
    streamingCost,
    batchCost,
    inputTokens:  inTokens,
    outputTokens: outTokens,
    model:        resolvedModel,
  };
}

/**
 * Format a USD figure for the menu: always a leading tilde and two decimals,
 * e.g. 0.0423 -> "~$0.04". Per spec, no "<$0.01" collapsing — the menu shows
 * two decimal places unconditionally.
 */
export function formatMenuCost(usd) {
  const n = Number.isFinite(usd) ? usd : 0;
  return '~$' + n.toFixed(2);
}
