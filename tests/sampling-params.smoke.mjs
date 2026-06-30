/**
 * Ghost Architect™ — getSamplingParams smoke test
 *
 * Guards the model-aware sampling-parameter filter. Newer models (Sonnet 5,
 * Opus 4.7/4.8, and any future opus-5) reject temperature/top_p/top_k with a
 * 400, so getSamplingParams returns {} for them and { temperature } for every
 * other model. The function is defined INLINE in src/core/agent/narrator.js
 * AND src/modes/watcher-commit.js (not exported), so the logic is REPLICATED
 * here verbatim. If you change either getSamplingParams, change it here too —
 * all three copies MUST stay in sync.
 */

// ── Keep in sync with getSamplingParams in src/core/agent/narrator.js ──────
// ── and src/modes/watcher-commit.js ────────────────────────────────────────
function getSamplingParams(temperature, model) {
  if (
    model.includes('sonnet-5') ||
    model.includes('opus-4-7') ||
    model.includes('opus-4-8') ||
    model.includes('opus-5')
  ) {
    return {};
  }
  return { temperature };
}
// ── end replicated block ────────────────────────────────────────────────────

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

// Summary
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
