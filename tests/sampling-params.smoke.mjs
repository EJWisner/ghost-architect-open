/**
 * Ghost Architect™ — sampling-params smoke test
 *
 * Guards the shared model-aware sampling-parameter filter in
 * src/utils/sampling-params.js. Newer models (Sonnet 5, Opus 4.7/4.8, and any
 * future opus-5) reject temperature/top_p/top_k with a 400, so getSamplingParams
 * returns {} for them and { temperature } for every other model. narrator.js,
 * watcher-commit.js, blast-multipass.js, and extractor.js all import this single
 * source of truth — this test exercises it directly.
 */

import { getSamplingParams, modelRejectsTemperature } from '../src/utils/sampling-params.js';

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

// ── Test 1: newer models strip sampling params (return {}) ──────────────────
console.log('Test 1: temperature stripped for models that 400 on it');
{
  check('claude-sonnet-5 @ 0.3 → {}',  getSamplingParams(0.3, 'claude-sonnet-5'),  {});
  check('claude-sonnet-5 @ 0   → {}',  getSamplingParams(0,   'claude-sonnet-5'),  {});
  check('claude-opus-4-7 @ 0   → {}',  getSamplingParams(0,   'claude-opus-4-7'),  {});
  check('claude-opus-4-8 @ 0.3 → {}',  getSamplingParams(0.3, 'claude-opus-4-8'),  {});
  check('claude-opus-5 @ 0.3   → {}',  getSamplingParams(0.3, 'claude-opus-5'),    {});
}
console.log('');

// ── Test 2: older models pass temperature through ───────────────────────────
console.log('Test 2: temperature passed through for models that accept it');
{
  check('claude-sonnet-4-6 @ 0.3 → {temperature:0.3}', getSamplingParams(0.3, 'claude-sonnet-4-6'), { temperature: 0.3 });
  check('claude-sonnet-4-6 @ 0   → {temperature:0}',   getSamplingParams(0,   'claude-sonnet-4-6'), { temperature: 0 });
  check('claude-haiku-4-5 @ 0.3  → {temperature:0.3}', getSamplingParams(0.3, 'claude-haiku-4-5'),  { temperature: 0.3 });
  check('claude-opus-4-6 @ 0     → {temperature:0}',   getSamplingParams(0,   'claude-opus-4-6'),   { temperature: 0 });
}
console.log('');

// ── Test 3: modelRejectsTemperature predicate (exact + prefix + edges) ──────
console.log('Test 3: modelRejectsTemperature predicate');
{
  check('exact claude-sonnet-5 → true',            modelRejectsTemperature('claude-sonnet-5'),         true);
  check('exact claude-opus-4-7 → true',            modelRejectsTemperature('claude-opus-4-7'),         true);
  check('prefix claude-sonnet-5-20250601 → true',  modelRejectsTemperature('claude-sonnet-5-20250601'), true);
  check('prefix claude-opus-4-8-preview → true',   modelRejectsTemperature('claude-opus-4-8-preview'),  true);
  check('claude-sonnet-4-6 → false',               modelRejectsTemperature('claude-sonnet-4-6'),       false);
  check('claude-opus-4-6 → false',                 modelRejectsTemperature('claude-opus-4-6'),         false);
  check('null → false',                            modelRejectsTemperature(null),                      false);
  check('undefined → false',                       modelRejectsTemperature(undefined),                 false);
  check('empty string → false',                    modelRejectsTemperature(''),                        false);
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
