/**
 * Ghost Architect™ — SELF_REFUTING_RE smoke test
 *
 * Exercises the self-refuting conflict-finding filter directly. The regex is
 * defined INLINE in src/modes/watcher-commit.js (inside the Step 6 conflict
 * block of runWatchCommit), so it cannot be imported. It is REPLICATED here
 * verbatim. If you change SELF_REFUTING_RE in watcher-commit.js, change it here
 * too — these two copies MUST stay in sync.
 *
 * Filter semantics: a finding is DROPPED when SELF_REFUTING_RE.test(description)
 * is true (the model flagged a conflict then refuted itself), and KEPT when it
 * is false (a real finding). The `values match` clause carries a negative
 * lookahead so a hedged real finding ("values match ... but will conflict if X
 * changes") is kept while a bare self-refutation ("values match") is dropped.
 */

// ── REPLICATED from src/modes/watcher-commit.js (keep in sync) ──────────────
const SELF_REFUTING_RE = /no\s+(actual|real|runtime)\s+conflict|not\s+a\s+(\w+\s+){0,3}conflict|rather\s+than\s+a\s+(real|runtime)\s+conflict|no\s+issue|runtime\s+impact:\s*none|no\s+concrete\s+(runtime\s+)?(conflict|failure|impact)|no\s+active\s+\S+(\s+\S+){0,4}\s+(call\s+)?path|no\s+\S+(\s+\S+){0,3}\s+failure\s+path|consistent\b|values\s+match(?![^.]*\bconflict)|intentionally\s+different/i;

// Mirror the production filter predicate: keep when test() is false.
const isDropped = (description) => SELF_REFUTING_RE.test(description || '');

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected: ' + e);
    console.log('       actual:   ' + a);
    failures++;
  }
}

// ── SHOULD DROP — self-refuting, filter removes them (isDropped === true) ────
console.log('Test 1: self-refuting descriptions are DROPPED');
{
  const SHOULD_DROP = [
    'no actual conflict here',
    'no runtime conflict in this case',
    'this is an inconsistency rather than a real conflict',
    'rather than a runtime conflict, this is just drift',
    'Runtime impact: none',
    'Runtime impact: None — the code handles this correctly',
    'not a conflict',
    'no issue here',
    'values match',
    'intentionally different',
    'these are consistent across modules',
    'Not a concrete runtime conflict.',
    'Not a concrete conflict.',
    'No concrete runtime failure path.',
    'No active cross-file call path exists.',
    'No concrete failure path exists.',
  ];
  for (const s of SHOULD_DROP) {
    check(`drop: ${JSON.stringify(s)}`, isDropped(s), true);
  }
}
console.log('');

// ── SHOULD KEEP — real findings, filter retains them (isDropped === false) ───
console.log('Test 2: real conflict findings are KEPT');
{
  const SHOULD_KEEP = [
    'conflict exists between module A and module B',
    'values match in current impl but will conflict if X changes', // false-positive risk
    'this causes a runtime error in production',
    'inconsistency that breaks checkout flow',
    'the sort order conflict causes silent failure',
  ];
  for (const s of SHOULD_KEEP) {
    check(`keep: ${JSON.stringify(s)}`, isDropped(s), false);
  }
}
console.log('');

// ── Edge inputs never throw ─────────────────────────────────────────────────
console.log('Test 3: edge inputs are handled (kept, no throw)');
{
  check('empty string kept',  isDropped(''),        false);
  check('null kept',          isDropped(null),       false);
  check('undefined kept',     isDropped(undefined),  false);
}
console.log('');

// Summary
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
