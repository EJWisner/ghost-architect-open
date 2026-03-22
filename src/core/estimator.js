/**
 * Ghost Architect — Core Estimator
 * Pure cost calculation. No Chalk. No console output. Returns data.
 */

const PRICING = {
  'claude-sonnet-4-5': { label: 'Claude Sonnet 4.5', inputPerM: 3.00,  outputPerM: 15.00 },
  'claude-opus-4-5':   { label: 'Claude Opus 4.5',   inputPerM: 15.00, outputPerM: 75.00 },
};

const MODE_OUTPUT_ESTIMATES = {
  poi:   { tokens: 1800, label: 'Points of Interest Scan' },
  blast: { tokens: 1200, label: 'Blast Radius Analysis'   },
  chat:  { tokens: 600,  label: 'Chat (per exchange)'     },
};

export function getPricing(model) {
  return PRICING[model] || PRICING['claude-sonnet-4-5'];
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
  constructor() { this.runs = []; }

  record(mode, inputTokens, outputTokens, model) {
    const pricing = getPricing(model);
    const cost = ((inputTokens  / 1_000_000) * pricing.inputPerM) +
                 ((outputTokens / 1_000_000) * pricing.outputPerM);
    this.runs.push({ mode, inputTokens, outputTokens, cost });
  }

  get totalCost() {
    return this.runs.reduce((sum, r) => sum + r.cost, 0);
  }

  getSummary() {
    return {
      runs: this.runs,
      totalCost: this.totalCost,
    };
  }
}
