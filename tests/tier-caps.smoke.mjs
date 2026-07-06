/**
 * Smoke test for tier context-cap resolution in src/loader/tierCaps.js.
 *
 * getActiveTier() (src/license/session.js) returns the RAW license tier string
 * straight from the token payload — including the Max tiers 'pro-max',
 * 'team-max', 'enterprise-max' that tier-gates.js gates on. That string is
 * passed verbatim into getTierCap(). If TIER_CAPS is missing a key, getTierCap
 * falls back to Open's 50K, which would silently under-cap a paying Max
 * customer. This test locks in the cap for all seven tiers, the Open fallback
 * for unknown tiers, and case-insensitive matching.
 *
 * Run: node tests/tier-caps.smoke.mjs
 */

import { getTierCap } from '../src/loader/tierCaps.js';

let failures = 0;

function checkEqual(label, actual, expected) {
  if (actual === expected) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected: ' + JSON.stringify(expected));
    console.log('       got:      ' + JSON.stringify(actual));
    failures++;
  }
}

// ── Test 1: all eight tiers resolve to their advertised caps ───────────────
console.log('Test 1: all eight tiers return the correct context cap');
{
  const expected = {
    open: 50000,
    trial: 100000,     // trial is a Pro Max evaluation: matches Pro Max's 100K cap (watermark is the only differentiator)
    pro: 100000,
    'pro-max': 100000,
    team: 150000,
    'team-max': 150000,
    enterprise: 200000,
    'enterprise-max': 200000,
  };
  for (const [tier, cap] of Object.entries(expected)) {
    checkEqual(`${tier} -> ${cap}`, getTierCap(tier), cap);
  }
}
console.log('');

// ── Test 2: unknown tier fails safe to Open's 50K ──────────────────────────
console.log('Test 2: unknown tier falls back to Open (50000)');
{
  checkEqual('unknown-tier -> 50000', getTierCap('unknown-tier'), 50000);
  checkEqual('empty string -> 50000', getTierCap(''), 50000);
  checkEqual('null -> 50000', getTierCap(null), 50000);
  checkEqual('undefined -> 50000', getTierCap(undefined), 50000);
}
console.log('');

// ── Test 3: tier lookup is case-insensitive ────────────────────────────────
console.log('Test 3: tier matching is case-insensitive');
{
  checkEqual('PRO-MAX -> 100000', getTierCap('PRO-MAX'), 100000);
  checkEqual('Enterprise -> 200000', getTierCap('Enterprise'), 200000);
  checkEqual('Team-Max -> 150000', getTierCap('Team-Max'), 150000);
}
console.log('');

if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
