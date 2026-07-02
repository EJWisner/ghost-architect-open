import { getPricing } from '../src/core/estimator.js';
import assert from 'node:assert/strict';

// Regression fixture for the Sonnet-5 introductory-pricing auto-switch.
// Intro rate: $2/$10 through Aug 31, 2026 (UTC).
// Standard rate: $3/$15 from Sep 1, 2026 onward.

const INTRO_DATE   = new Date('2026-08-31T23:59:59Z'); // last second of intro period
const STANDARD_DATE = new Date('2026-09-01T00:00:00Z'); // first second of standard period

// During intro period -- should return $2/$10
const intro = getPricing('claude-sonnet-5', INTRO_DATE);
assert.equal(intro.inputPerM,  2.00, `Intro input price should be $2 but got $${intro.inputPerM}`);
assert.equal(intro.outputPerM, 10.00, `Intro output price should be $10 but got $${intro.outputPerM}`);

// After cutoff -- should return $3/$15
const standard = getPricing('claude-sonnet-5', STANDARD_DATE);
assert.equal(standard.inputPerM,  3.00, `Standard input price should be $3 but got $${standard.inputPerM}`);
assert.equal(standard.outputPerM, 15.00, `Standard output price should be $15 but got $${standard.outputPerM}`);

// Other models unaffected
const sonnet46 = getPricing('claude-sonnet-4-6', STANDARD_DATE);
assert.equal(sonnet46.inputPerM, 3.00, 'Sonnet 4.6 price should be unaffected by date');

console.log('estimator Sonnet-5 pricing switch: PASS');
console.log(`  Intro  (${ INTRO_DATE.toISOString() }):    $${intro.inputPerM}/$${intro.outputPerM} per M tokens`);
console.log(`  Standard (${ STANDARD_DATE.toISOString() }): $${standard.inputPerM}/$${standard.outputPerM} per M tokens`);
