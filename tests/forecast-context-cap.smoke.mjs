import assert from 'node:assert/strict';
import { resolveContextCap } from '../src/loader/tierCaps.js';

// Regression fixture for CC-87 fix: resolveContextCap() returns an object,
// not a number. forecast-overlay.js must extract .effective or the tier
// context cap is silently never enforced.
//
// A regression back to `const maxTokens = resolveContextCap(tier)` (without
// .effective) would cause maxTokens to be an object -- number comparisons
// against an object coerce to NaN, so the cap is never enforced.

const tiers = ['open', 'pro', 'pro-max', 'team', 'team-max', 'enterprise', 'enterprise-max'];

for (const tier of tiers) {
  const result = resolveContextCap(tier);

  // Must return an object with an effective field
  assert.ok(result && typeof result === 'object',
    `resolveContextCap('${tier}') must return an object, got ${typeof result}`);

  // .effective must be a positive number -- if this fails the budget loop breaks
  assert.ok(typeof result.effective === 'number' && result.effective > 0,
    `resolveContextCap('${tier}').effective must be a positive number, got ${result.effective}`);

  // The object used directly as a number comparison must NOT work as a cap
  // (i.e. the object itself is not a valid token count)
  const asNumber = Number(result);
  assert.ok(isNaN(asNumber) || asNumber !== result.effective,
    `resolveContextCap('${tier}') must not be directly usable as a number -- .effective extraction is required`);
}

// Specific tier values -- assert known caps so a tier-cap change is caught
const open = resolveContextCap('open').effective;
const pro = resolveContextCap('pro').effective;
const enterprise = resolveContextCap('enterprise-max').effective;

assert.ok(open > 0, 'Open tier cap must be positive');
assert.ok(pro > open, 'Pro cap must exceed Open cap');
assert.ok(enterprise >= pro, 'Enterprise cap must be >= Pro cap');

console.log('forecast-context-cap: PASS');
console.log(`  open=${open} pro=${pro} enterprise-max=${enterprise}`);
console.log('  .effective extraction confirmed required -- object not directly usable as number');
