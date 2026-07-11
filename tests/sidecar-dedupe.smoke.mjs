/**
 * Smoke tests for dedupeFindingsByTitle in src/core/sidecar-pipeline.js.
 *
 * Locks in the exact-title vs fuzzy-containment overlap rules:
 *   - Narrator-polish twins collapse: the detailed copy carries files (the
 *     rendered report mandates a Files line) while the raw twin carries
 *     none. Requiring a shared path on exact titles meant the twin never
 *     collapsed, so the same finding shipped twice in the sidecar and the
 *     disclosure over-counted (Audit 10, finding 3.6).
 *   - Distinct-modules protection stands: identical generic titles citing
 *     DIFFERENT files stay separate (Audit 9, finding 3.9), and fuzzy
 *     containment still requires a genuinely shared file (Audit 8,
 *     finding 3.8).
 *
 * Run: node tests/sidecar-dedupe.smoke.mjs
 */

import { dedupeFindingsByTitle } from '../src/core/sidecar-pipeline.js';

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

console.log('Test 1: narrator-polish twin collapses (detailed has files, raw twin has none)');
{
  const out = dedupeFindingsByTitle([
    { title: 'Hardcoded database credentials in config loader', files: ['src/Config/Loader.php'], detailed: true },
    { title: 'Hardcoded database credentials in config loader', files: [], detailed: false },
  ]);
  check('collapses to one entry', out.length, 1);
  check('first occurrence (the detailed copy) wins', out[0].detailed, true);
}

console.log('Test 2: exact titles with files on only ONE side collapse in either order');
{
  const rawFirst = dedupeFindingsByTitle([
    { title: 'Unbounded queue consumer retry loop', files: [] },
    { title: 'Unbounded queue consumer retry loop', files: ['src/Queue/Consumer.php'] },
  ]);
  check('raw-first order also collapses', rawFirst.length, 1);
}

console.log('Test 3: identical generic titles in DIFFERENT modules stay distinct');
{
  const out = dedupeFindingsByTitle([
    { title: 'Missing error handling', files: ['src/Payment/Webhook.php'] },
    { title: 'Missing error handling', files: ['src/Export/Job.php'] },
  ]);
  check('distinct modules do not collapse', out.length, 2);
}

console.log('Test 4: identical titles sharing a file collapse');
{
  const out = dedupeFindingsByTitle([
    { title: 'Missing error handling', files: ['src/Payment/Webhook.php'] },
    { title: 'Missing error handling', files: ['src/Payment/Webhook.php', 'src/Api/Order.php'] },
  ]);
  check('shared file collapses', out.length, 1);
}

console.log('Test 5: both-sides-empty exact titles still collapse');
{
  const out = dedupeFindingsByTitle([
    { title: 'Dead configuration flag never read', files: [] },
    { title: 'Dead configuration flag never read', files: [] },
  ]);
  check('both empty collapses', out.length, 1);
}

console.log('Test 6: fuzzy containment still requires a shared file (one-side-empty stays strict)');
{
  const out = dedupeFindingsByTitle([
    { title: 'Missing error handling in payment webhook', files: ['src/Payment/Webhook.php'] },
    { title: 'Missing error handling', files: [] },
  ]);
  // Containment branch: "missing error handling" is contained in the longer
  // title, but one side has no files, so the strict rule keeps them apart.
  check('containment without shared file stays distinct', out.length, 2);
}

console.log('Test 7: fuzzy containment with a shared file collapses');
{
  const out = dedupeFindingsByTitle([
    { title: 'Missing error handling in payment webhook', files: ['src/Payment/Webhook.php'] },
    { title: 'Missing error handling', files: ['src/Payment/Webhook.php'] },
  ]);
  check('containment with shared file collapses', out.length, 1);
}

console.log('Test 8: short generic titles never absorb by containment');
{
  const out = dedupeFindingsByTitle([
    { title: 'Dead code', files: ['src/A.php'] },
    { title: 'Dead code in legacy import pipeline', files: ['src/A.php'] },
  ]);
  // shorter normalized title "dead code" is under the 10-char containment
  // floor, so these only collapse if titles match exactly. They don't.
  check('short-title containment floor holds', out.length, 2);
}

if (failures > 0) {
  console.error(`\nsidecar-dedupe.smoke: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nPASSED — all assertions ok');
