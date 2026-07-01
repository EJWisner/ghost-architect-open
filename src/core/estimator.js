/**
 * Ghost Architect — Core Estimator
 * Pure cost calculation. No Chalk. No console output. Returns data.
 *
 * SINGLE SOURCE OF TRUTH for model pricing across the entire codebase.
 * Modes (poi, blast, conflict, prompt-triage, chat, recon) and detector
 * infrastructure (llmAuditClient) all import pricing from here. Do NOT
 * duplicate pricing tables elsewhere — keep this file canonical.
 */

// Per-million-token rates in USD. Update when Anthropic announces new
// rates or new models. Sources verified May 10, 2026:
//   - Opus 4.7 / 4.6 / 4.5: $5 in / $25 out (Anthropic dropped Opus pricing
//     67% on Nov 24, 2025 with Opus 4.5; subsequent Opus models keep that)
//   - Opus 4 / 4.1: $15 in / $75 out (legacy, kept for back-compat with
//     callers that pin to those IDs)
//   - Sonnet 4.6 / 4.5: $3 in / $15 out
//   - Haiku 4.5: $1 in / $5 out
const PRICING = {
  // Current Opus generation (post Nov 2025 67% price drop)
  'claude-opus-4-8':   { label: 'Claude Opus 4.8',   inputPerM:  5.00, outputPerM: 25.00 },
  'claude-opus-4-7':   { label: 'Claude Opus 4.7',   inputPerM:  5.00, outputPerM: 25.00 },
  'claude-opus-4-6':   { label: 'Claude Opus 4.6',   inputPerM:  5.00, outputPerM: 25.00 },
  'claude-opus-4-5':   { label: 'Claude Opus 4.5',   inputPerM:  5.00, outputPerM: 25.00 },
  'claude-opus-5':     { label: 'Claude Opus 5',     inputPerM:  5.00, outputPerM: 25.00 },
  // Legacy Opus pricing
  'claude-opus-4-1':   { label: 'Claude Opus 4.1',   inputPerM: 15.00, outputPerM: 75.00 },
  'claude-opus-4':     { label: 'Claude Opus 4',     inputPerM: 15.00, outputPerM: 75.00 },
  // NOTE: claude-sonnet-5 introductory pricing ($2/$10) expires Aug 31, 2026.
  // Update to standard pricing ($3/$15) after that date.
  // Sonnet
  'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', inputPerM:  3.00, outputPerM: 15.00 },
  // Sonnet 5 (launched June 2026 — introductory pricing through Aug 31, 2026)
  'claude-sonnet-5':   { label: 'Claude Sonnet 5',   inputPerM:  2.00, outputPerM: 10.00 },
  'claude-sonnet-4-5': { label: 'Claude Sonnet 4.5', inputPerM:  3.00, outputPerM: 15.00 },
  // Fable (Mythos-class, generally available)
  'claude-fable-5':    { label: 'Claude Fable 5',    inputPerM: 10.00, outputPerM: 50.00 },
  // Haiku
  'claude-haiku-4-5':  { label: 'Claude Haiku 4.5',  inputPerM:  1.00, outputPerM:  5.00 },
};

// Per-mode output token estimates and human-readable labels for the cost
// estimator panel. The label appears as 'Mode    : <label>' in the cost
// estimate UI. If a mode is missing from this dict, estimateCost falls back
// to the raw mode key (e.g., 'conflict') instead of a properly-cased label,
// AND uses 800 tokens as a default — so missing entries cause both a UX
// degradation and an inaccurate estimate. Keep this in sync with src/modes/.
const MODE_OUTPUT_ESTIMATES = {
  poi:           { tokens: 1800, label: 'Points of Interest Scan' },
  blast:         { tokens: 1200, label: 'Blast Radius Analysis'   },
  conflict:      { tokens: 1500, label: 'Conflict Detection'      },
  chat:          { tokens: 600,  label: 'Chat (per exchange)'     },
  question:      { tokens: 1200, label: 'Question'                },
  recon:         { tokens: 800,  label: 'Recon (sizing only)'     },
  'prompt-triage': { tokens: 400, label: 'Prompt Triage Audit'    },
  audit:         { tokens: 1500, label: 'Inheritance Audit'       },
  forecast:                { tokens: 1400, label: 'Commit Forecast'  },
  'fix-forecast-combined': { tokens: 1600, label: 'Fix Forecast'     },
};

export function getPricing(model) {
  return PRICING[model] || PRICING['claude-sonnet-4-6'];
}

/**
 * Cost-range estimation for multi-call scans (Prompt Triage Tier 2,
 * POI verifier, Conflict). Returns a low-high band reflecting realistic
 * variance in input size. Calibrated from May 10 dogfood scan: 472 calls,
 * $18.58 actual; calibrated math estimated $17.70.
 */
export function estimateMultiCallCost({
  model,
  numCalls,
  avgInputTokens = 5000,
  avgOutputTokens = 500,
  bandPercent = 0.20,
}) {
  const pricing = getPricing(model);
  const inputCostPerCall  = (avgInputTokens  / 1_000_000) * pricing.inputPerM;
  const outputCostPerCall = (avgOutputTokens / 1_000_000) * pricing.outputPerM;
  const perCallCost = inputCostPerCall + outputCostPerCall;
  const midpoint = numCalls * perCallCost;
  const low  = midpoint * (1 - bandPercent);
  const high = midpoint * (1 + bandPercent);
  return {
    low,
    high,
    midpoint,
    perCallCost,
    numCalls,
    modelLabel: pricing.label,
    pricing,
  };
}

export function formatCost(usd) {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(2);
}

export function formatCostRange(low, high) {
  return formatCost(low) + ' – ' + formatCost(high);
}

export function estimateCost(inputTokens, mode, model) {
  const pricing      = getPricing(model);
  const outputTokens = MODE_OUTPUT_ESTIMATES[mode]?.tokens || 800;
  const inputCost    = (inputTokens  / 1_000_000) * pricing.inputPerM;
  const outputCost   = (outputTokens / 1_000_000) * pricing.outputPerM;
  const totalCost    = inputCost + outputCost;
  const modeLabel    = MODE_OUTPUT_ESTIMATES[mode]?.label || mode;
  return { inputCost, outputCost, totalCost, inputTokens, outputTokens, pricing, modeLabel };
}

export function calcActualCost(inputTokens, outputTokens, model) {
  const pricing    = getPricing(model);
  const inputCost  = (inputTokens  / 1_000_000) * pricing.inputPerM;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerM;
  const totalCost  = inputCost + outputCost;
  return { inputCost, outputCost, totalCost, inputTokens, outputTokens, pricing };
}

export function getCostFraming(totalCost) {
  if (totalCost < 0.05)  return "Less than a nickel — go for it.";
  if (totalCost < 0.25)  return "Pocket change for the insight you'll get.";
  if (totalCost < 1.00)  return "Under a dollar — reasonable for a large codebase.";
  return "Large codebase — consider raising your context limit in settings.";
}

export class SessionCostTracker {
  constructor() { this.runs = []; this.stageTotals = {}; }

  record(mode, inputTokens, outputTokens, model, stage = 'scan') {
    const pricing = getPricing(model);
    const cost = ((inputTokens  / 1_000_000) * pricing.inputPerM) +
                 ((outputTokens / 1_000_000) * pricing.outputPerM);
    this.runs.push({ mode, inputTokens, outputTokens, model, cost, stage });

    if (!this.stageTotals[stage]) {
      this.stageTotals[stage] = { inputTokens: 0, outputTokens: 0, cost: 0 };
    }
    this.stageTotals[stage].inputTokens += inputTokens;
    this.stageTotals[stage].outputTokens += outputTokens;
    this.stageTotals[stage].cost += cost;
  }

  get totalCost() {
    return this.runs.reduce((sum, r) => sum + r.cost, 0);
  }

  getSummary() {
    return {
      runs: this.runs,
      totalCost: this.totalCost,
      byStage: this.stageTotals,
    };
  }
}
