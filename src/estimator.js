/**
 * Ghost Architect — Estimator (CLI layer)
 * Thin wrapper: formats and displays cost data from core/estimator.js
 */

import chalk from 'chalk';
import { estimateCost, calcActualCost, getCostFraming, SessionCostTracker as CoreTracker } from './core/estimator.js';

export { estimateCost, calcActualCost, getCostFraming } from './core/estimator.js';

export function showCostEstimate(codebaseContext, mode, model) {
  try {
    const contextLen  = codebaseContext?.context?.length || 0;
    const inputTokens = Math.ceil(contextLen / 4) + 200;
    const est         = estimateCost(inputTokens, mode, model);

    console.log('\n' + chalk.cyan.bold('💰 COST ESTIMATE'));
    console.log(chalk.gray('  Mode    : ') + chalk.white(est.modeLabel));
    console.log(chalk.gray('  Model   : ') + chalk.white(est.pricing.label));
    console.log(chalk.gray('  Input   : ') + chalk.white('~' + inputTokens.toLocaleString() + ' tokens') + chalk.gray('  ($' + est.inputCost.toFixed(4) + ')'));
    console.log(chalk.gray('  Output  : ') + chalk.white('~' + est.outputTokens.toLocaleString() + ' tokens') + chalk.gray('  ($' + est.outputCost.toFixed(4) + ')'));
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log(chalk.gray('  Est. cost this run: ') + chalk.green.bold('$' + est.totalCost.toFixed(4)));
    console.log(chalk.gray('  ' + getCostFraming(est.totalCost)));
    console.log('');
  } catch (err) {
    console.log(chalk.gray('  (cost estimate unavailable: ' + err.message + ')\n'));
  }
}

// Audit Mode sends a compact summary of analyzer outputs to the LLM,
// not the full codebase context. Realistic input is a few hundred tokens;
// output is ~1500 tokens of structured JSON roadmap. This estimator uses
// those realistic numbers rather than the full-codebase token count, so
// the user sees an accurate "~$0.02" preview rather than an inflated
// estimate based on the entire scanned codebase.
export function showAuditCostEstimate(model) {
  try {
    const inputTokens = 800;  // Analyzer-output summary + system prompt overhead
    const est = estimateCost(inputTokens, 'audit', model);

    console.log('\n' + chalk.cyan.bold('💰 COST ESTIMATE'));
    console.log(chalk.gray('  Mode    : ') + chalk.white(est.modeLabel));
    console.log(chalk.gray('  Model   : ') + chalk.white(est.pricing.label));
    console.log(chalk.gray('  Synthesis input : ') + chalk.white('~' + inputTokens.toLocaleString() + ' tokens') + chalk.gray('  ($' + est.inputCost.toFixed(4) + ')'));
    console.log(chalk.gray('  Synthesis output: ') + chalk.white('~' + est.outputTokens.toLocaleString() + ' tokens') + chalk.gray('  ($' + est.outputCost.toFixed(4) + ')'));
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log(chalk.gray('  Est. cost this audit: ') + chalk.green.bold('$' + est.totalCost.toFixed(4)));
    console.log(chalk.gray('  ' + getCostFraming(est.totalCost)));
    console.log(chalk.gray('  (Stack Reality, Key-Person Risk, and Dependency Map analyzers run locally and incur no API charges.)'));
    console.log('');
  } catch (err) {
    console.log(chalk.gray('  (cost estimate unavailable: ' + err.message + ')\n'));
  }
}

export function showActualCost(inputTokens, outputTokens, model) {
  const result = calcActualCost(inputTokens, outputTokens, model);
  console.log(
    chalk.gray('  ─ tokens used: ') +
    chalk.gray(inputTokens.toLocaleString() + ' in / ' + outputTokens.toLocaleString() + ' out') +
    chalk.gray('  │  actual cost: ') +
    chalk.green('$' + result.totalCost.toFixed(4)) +
    '\n'
  );
}

export class SessionCostTracker extends CoreTracker {
  showSummary() {
    if (this.runs.length === 0) return;
    const summary = this.getSummary();
    console.log('\n' + chalk.cyan.bold('📊 SESSION SUMMARY'));
    summary.runs.forEach((r, i) => {
      console.log(
        chalk.gray('  ' + (i + 1) + '. ' + r.mode.toUpperCase().padEnd(8)) +
        chalk.gray(' ' + (r.inputTokens + r.outputTokens).toLocaleString() + ' tokens') +
        chalk.white('  $' + r.cost.toFixed(4))
      );
    });
    console.log(chalk.gray('  ─────────────────────────'));
    console.log(chalk.gray('  Session total: ') + chalk.green.bold('$' + summary.totalCost.toFixed(4) + '\n'));
  }
}
