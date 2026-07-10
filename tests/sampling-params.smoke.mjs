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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

// ── Test 4: no bare temperature literal outside sampling-params.js ──────────
// Audit 9 finding 1.1: seven call sites passed a hardcoded temperature with a
// user-selected model, so choosing Sonnet 5 / Opus 4.8 / Fable 5 returned
// HTTP 400 on Conflict Detection, multi-pass synthesis, Recon planning,
// Executive Brief, and the verifier. Every API call must route sampling
// params through getSamplingParams so the omission is model-aware. This sweep
// fails the suite if a bare `temperature: <number>` literal reappears.
// Exclusions: sampling-params.js itself, and src/prompt-pack/ (Prompt Triage
// audits OTHER people's prompt files for temperature directives; its strings
// and regexes mention the literal but never call the API with it).
console.log('Test 4: no bare temperature literal in API-calling source');
{
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const BARE_TEMPERATURE = /temperature\s*[:=]\s*[\d.]/;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'prompt-pack') continue;
        walk(full);
      } else if (entry.name.endsWith('.js') && entry.name !== 'sampling-params.js') {
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (BARE_TEMPERATURE.test(line)) {
            offenders.push(`${path.relative(repoRoot, full)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
  };
  for (const top of ['src', 'bin', 'lib']) {
    const dir = path.join(repoRoot, top);
    if (fs.existsSync(dir)) walk(dir);
  }
  check('bare temperature literals outside sampling-params.js', offenders, []);
  if (offenders.length) offenders.forEach(o => console.log('       ' + o));
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
