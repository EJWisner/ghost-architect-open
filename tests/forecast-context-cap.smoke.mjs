import assert from 'node:assert/strict';
import { resolveContextCap, CONTEXT_CAP } from '../src/loader/contextCap.js';

// Regression fixture for CC-87 fix: resolveContextCap() returns an object,
// not a number. forecast-overlay.js must extract .effective or the context
// cap is silently never enforced.
//
// A regression back to `const maxTokens = resolveContextCap(null)` (without
// .effective) would cause maxTokens to be an object -- number comparisons
// against an object coerce to NaN, so the cap is never enforced.

const result = resolveContextCap(null, 'forecast-overlay');

assert.ok(result && typeof result === 'object',
  `resolveContextCap(null) must return an object, got ${typeof result}`);

assert.ok(typeof result.effective === 'number' && result.effective > 0,
  `resolveContextCap(null).effective must be a positive number, got ${result.effective}`);

const asNumber = Number(result);
assert.ok(isNaN(asNumber) || asNumber !== result.effective,
  'resolveContextCap() must not be directly usable as a number -- .effective extraction is required');

// The forecast overlay gets the full cap, the same one every scan gets.
assert.equal(result.effective, CONTEXT_CAP, 'forecast overlay must get the full context cap');
assert.equal(CONTEXT_CAP, 200000, 'context cap is the highest former tier cap');

console.log('forecast-context-cap: PASS');
console.log(`  cap=${result.effective}`);
console.log('  .effective extraction confirmed required -- object not directly usable as number');
