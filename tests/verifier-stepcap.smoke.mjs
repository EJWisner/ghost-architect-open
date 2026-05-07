/**
 * Smoke tests for verifier.js step_cap classification logic.
 *
 * verifyOne is async + LLM-dependent so we don't test it end-to-end here.
 * But we DO test the pure JS logic for extracting inspected file paths from
 * the audit trail, since that's where a hand-rolled template literal threw
 * a TypeError on May 7 ("(result.filesAnalyzed || []).join is not a function"
 * — filesAnalyzed is a number, not an array).
 *
 * Run: node tests/verifier-stepcap.smoke.mjs
 */

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

// Replicate the inspected-files extraction logic from verifyOne. If this
// signature changes in verifier.js, update both places.
function extractInspectedPaths(auditTrail) {
  return (auditTrail || [])
    .filter(a => a.action === 'readFile' && a.input?.path)
    .map(a => a.input.path);
}

// Test 1: typical step_cap audit trail extracts correct file paths
console.log('Test 1: typical step_cap audit trail');
{
  const trail = [
    { action: 'listDirectory', input: { path: '' } },
    { action: 'readFile', input: { path: 'pricing.js' } },
    { action: 'searchFiles', input: { query: 'tax' } },
    { action: 'readFile', input: { path: 'index.js' } },
    { action: 'finish', input: { reason: 'step_cap' } },
  ];
  check('inspected paths', extractInspectedPaths(trail), ['pricing.js', 'index.js']);
}
console.log('');

// Test 2: empty audit trail returns empty array (not crash)
console.log('Test 2: empty audit trail');
{
  check('empty array', extractInspectedPaths([]), []);
  check('null trail',  extractInspectedPaths(null), []);
  check('undef trail', extractInspectedPaths(undefined), []);
}
console.log('');

// Test 3: audit trail with no readFile actions returns empty array
console.log('Test 3: audit trail without readFile');
{
  const trail = [
    { action: 'listDirectory', input: { path: '' } },
    { action: 'searchFiles', input: { query: 'tax' } },
    { action: 'finish', input: { reason: 'step_cap' } },
  ];
  check('no readFile = empty', extractInspectedPaths(trail), []);
}
console.log('');

// Test 4: malformed entries (no input, no path) are filtered out
console.log('Test 4: malformed entries are filtered');
{
  const trail = [
    { action: 'readFile' },                    // missing input
    { action: 'readFile', input: {} },         // missing path
    { action: 'readFile', input: { path: 'good.js' } },
    { action: 'readFile', input: null },       // null input
  ];
  check('only good entry returned', extractInspectedPaths(trail), ['good.js']);
}
console.log('');

// Test 5: the EXACT bug from May 7 — joining the result must not crash
console.log('Test 5: regression — joining result must not crash');
{
  const trail = [
    { action: 'readFile', input: { path: 'a.js' } },
    { action: 'readFile', input: { path: 'b.js' } },
  ];
  const paths = extractInspectedPaths(trail);
  let joined;
  try {
    joined = paths.join(', ');
  } catch (e) {
    failures++;
    console.log('  !!  join crashed: ' + e.message);
    joined = '(crash)';
  }
  check('joined string', joined, 'a.js, b.js');
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
