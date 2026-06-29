/**
 * Smoke test for the opt-in iteration-limit guard in
 * src/modes/watcher-commit.js (Step 1c of runWatchCommit).
 *
 * The limit is opt-in: it fires ONLY when iterations.max is explicitly set in
 * ghost-watcher.yaml. Absent (undefined) or null means no limit, and Watch runs
 * on every push. An explicitly-set number fires only when the current run is
 * strictly GREATER than the limit (at-limit is allowed, over-limit skips).
 *
 * Imports the real exported predicate so this test binds to production code.
 *
 * Run: node tests/watcher-iteration-limit.smoke.mjs
 */

import { shouldSkipForIterationLimit } from '../src/modes/watcher-commit.js';

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

// ── Test 1: no iterations config at all → no limit, even at a huge run ──────
console.log('Test 1: missing iterations config (undefined) → no skip at run 999');
checkEqual('shouldSkip === false', shouldSkipForIterationLimit({}, 999), false);
console.log('');

// ── Test 2: iterations.max explicitly null → no limit ──────────────────────
console.log('Test 2: iterations.max === null → no skip at run 999');
checkEqual('shouldSkip === false', shouldSkipForIterationLimit({ iterations: { max: null } }, 999), false);
console.log('');

// ── Test 3-7: explicit numeric limit, strictly-greater semantics ───────────
console.log('Test 3: max 50, run 49 → no skip (under limit)');
checkEqual('shouldSkip === false', shouldSkipForIterationLimit({ iterations: { max: 50 } }, 49), false);
console.log('');

console.log('Test 4: max 50, run 50 → no skip (at limit, not over)');
checkEqual('shouldSkip === false', shouldSkipForIterationLimit({ iterations: { max: 50 } }, 50), false);
console.log('');

console.log('Test 5: max 50, run 51 → skip (over limit)');
checkEqual('shouldSkip === true', shouldSkipForIterationLimit({ iterations: { max: 50 } }, 51), true);
console.log('');

console.log('Test 6: max 100, run 101 → skip (over limit)');
checkEqual('shouldSkip === true', shouldSkipForIterationLimit({ iterations: { max: 100 } }, 101), true);
console.log('');

console.log('Test 7: max 1, run 1 → no skip (at limit, not over)');
checkEqual('shouldSkip === false', shouldSkipForIterationLimit({ iterations: { max: 1 } }, 1), false);
console.log('');

if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
