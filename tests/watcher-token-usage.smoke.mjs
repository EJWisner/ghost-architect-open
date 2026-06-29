/**
 * Smoke test for the Ghost Watcher™ token/cost telemetry helpers in
 * src/modes/watcher-commit.js:
 *   - buildTokenUsage(inputTokens, outputTokens) — the { inputTokens,
 *     outputTokens, estimatedCostUsd } payload attached to the portal
 *     commit-state object via pushWatchCommitState.
 *   - sumBatchUsage(results) — sums input/output tokens across a pollBatch()
 *     result array, treating missing/malformed usage as 0 so it never yields NaN.
 *
 * Cost is computed at Anthropic Message Batches API rates (50% of standard).
 * For claude-sonnet-4-6 that is $1.50/1M input and $7.50/1M output.
 *
 * Run: node tests/watcher-token-usage.smoke.mjs
 */

import { buildTokenUsage, sumBatchUsage } from '../src/modes/watcher-commit.js';

let failures = 0;

function ok(label) { console.log('  OK  ' + label); }
function bad(label, detail) {
  console.log('  !!  ' + label);
  if (detail) console.log('       ' + detail);
  failures++;
}
function assert(cond, label, detail) {
  if (cond) ok(label); else bad(label, detail);
}

console.log('\nTest 1: 1M input / 1M output → estimatedCostUsd 9.0 ($1.50 + $7.50)');
{
  const u = buildTokenUsage(1_000_000, 1_000_000);
  assert(u.inputTokens === 1_000_000, 'inputTokens echoed back', `got ${u.inputTokens}`);
  assert(u.outputTokens === 1_000_000, 'outputTokens echoed back', `got ${u.outputTokens}`);
  assert(u.estimatedCostUsd === 9.0, 'estimatedCostUsd === 9.0', `got ${u.estimatedCostUsd}`);
}

console.log('\nTest 2: 0 / 0 → estimatedCostUsd 0');
{
  const u = buildTokenUsage(0, 0);
  assert(u.inputTokens === 0, 'inputTokens 0', `got ${u.inputTokens}`);
  assert(u.outputTokens === 0, 'outputTokens 0', `got ${u.outputTokens}`);
  assert(u.estimatedCostUsd === 0, 'estimatedCostUsd 0', `got ${u.estimatedCostUsd}`);
  assert(!Number.isNaN(u.estimatedCostUsd), 'cost is not NaN');
}

console.log('\nTest 3: null/garbage usage via sumBatchUsage → all zeros, no NaN, no crash');
{
  const sNull = sumBatchUsage(null);
  assert(sNull.inputTokens === 0, 'sumBatchUsage(null) inputTokens 0', `got ${sNull.inputTokens}`);
  assert(sNull.outputTokens === 0, 'sumBatchUsage(null) outputTokens 0', `got ${sNull.outputTokens}`);

  // A result array where entries are missing usage / malformed entirely.
  const sGarbage = sumBatchUsage([{}, { usage: null }, { usage: { input_tokens: 'x' } }, null]);
  assert(sGarbage.inputTokens === 0, 'garbage entries → inputTokens 0', `got ${sGarbage.inputTokens}`);
  assert(sGarbage.outputTokens === 0, 'garbage entries → outputTokens 0', `got ${sGarbage.outputTokens}`);

  // Feeding those zeros straight into buildTokenUsage must not produce NaN.
  const u = buildTokenUsage(sNull.inputTokens, sNull.outputTokens);
  assert(u.estimatedCostUsd === 0, 'null-usage → cost 0', `got ${u.estimatedCostUsd}`);
  assert(!Number.isNaN(u.estimatedCostUsd), 'null-usage cost is not NaN');
  assert(!Number.isNaN(u.inputTokens) && !Number.isNaN(u.outputTokens), 'token counts not NaN');
}

console.log('\nTest 3b: sumBatchUsage sums real usage across multiple results');
{
  const s = sumBatchUsage([
    { usage: { input_tokens: 100, output_tokens: 10 } },
    { usage: { input_tokens: 24200, output_tokens: 8790 } },
  ]);
  assert(s.inputTokens === 24300, 'inputTokens summed', `got ${s.inputTokens}`);
  assert(s.outputTokens === 8800, 'outputTokens summed', `got ${s.outputTokens}`);
}

console.log('\nTest 4: 500K input / 200K output → 0.75 + 1.50 = 2.25');
{
  const u = buildTokenUsage(500_000, 200_000);
  assert(u.estimatedCostUsd === 2.25, 'estimatedCostUsd === 2.25', `got ${u.estimatedCostUsd}`);
}

console.log('\nTest 5: realistic 124300 input / 8800 output → 0.25245 (6 dp)');
{
  // inCost  = 124300 / 1e6 * 1.50 = 0.186450
  // outCost =   8800 / 1e6 * 7.50 = 0.066000
  // total   = 0.252450
  const u = buildTokenUsage(124_300, 8_800);
  assert(u.estimatedCostUsd === 0.25245, 'estimatedCostUsd === 0.25245', `got ${u.estimatedCostUsd}`);
  assert(u.inputTokens === 124_300, 'inputTokens echoed', `got ${u.inputTokens}`);
  assert(u.outputTokens === 8_800, 'outputTokens echoed', `got ${u.outputTokens}`);
}

console.log('\nTest 5b: cost is rounded to at most 6 decimal places');
{
  // 1 input token → 0.0000015 which rounds to 0.000002 (6 dp), never a long float tail.
  const u = buildTokenUsage(1, 0);
  const decimals = (String(u.estimatedCostUsd).split('.')[1] || '').length;
  assert(decimals <= 6, 'no more than 6 decimal places', `got ${u.estimatedCostUsd}`);
  assert(u.estimatedCostUsd === 0.000002, 'rounds 0.0000015 → 0.000002', `got ${u.estimatedCostUsd}`);
}

if (failures === 0) {
  console.log('\nPASSED — all assertions ok');
  process.exit(0);
} else {
  console.log(`\nFAILED — ${failures} assertion(s) failed`);
  process.exit(1);
}
