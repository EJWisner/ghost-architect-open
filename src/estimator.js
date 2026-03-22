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
    console.log(chalk.gray('  Input   : ') + chalk.white(`~${inputTokens.toLocaleString()} tokens`) + chalk.gray(`  ($${est.inputCost.toFixed(4)})`));
    console.log(chalk.gray('  Output  : ') + chalk.white(`~${est.outputTokens.toLocaleString()} tokens`) + chalk.gray(`  ($${est.outputCost.toFixed(4)})`));
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log(chalk.gray('  Est. cost this run: ') + chalk.green.bold(`$${est.totalCost.toFixed(4)}`));
    console.log(chalk.gray('  ' + getCostFraming(est.totalCost)));
    console.log('');
  } catch(err) {
    console.log(chalk.gray(`  (cost estimate unavailable: ${err.message})\n`));
  }
}

export function showActualCost(inputTokens, outputTokens, model) {
  const result = calcActualCost(inputTokens, outputTokens, model);
  console.log(
    chalk.gray(`  ─ tokens used: `) +
    chalk.gray(`${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out`) +
    chalk.gray(`  │  actual cost: `) +
    chalk.green(`$${result.totalCost.toFixed(4)}`) +
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
        chalk.gray(`  ${i + 1}. ${r.mode.toUpperCase().padEnd(8)}`) +
        chalk.gray(` ${(r.inputTokens + r.outputTokens).toLocaleString()} tokens`) +
        chalk.white(`  $${r.cost.toFixed(4)}`)
      );
    });
    console.log(chalk.gray('  ─────────────────────────'));
    console.log(chalk.gray('  Session total: ') + chalk.green.bold(`$${summary.totalCost.toFixed(4)}\n`));
  }
}
