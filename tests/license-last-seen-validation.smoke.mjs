/**
 * Smoke test for updateLastSeenUtc() input validation.
 *
 * Background: updateLastSeenUtc() persists the monotonic clock ratchet
 * (last_seen_utc) that guards against license replay. It used to call
 * Date.parse(newIso) without first validating the string format. Date.parse
 * returns NaN for malformed input, and `NaN > oldMs` is false, so garbage was
 * silently dropped on the comparison. But Date.parse is also lenient: strings
 * like "2026-01-01" or a Unix-epoch-as-string parse to a real number and would
 * be written verbatim, poisoning the ratchet with a non-canonical value.
 *
 * The fix rejects any input that is not a canonical ISO-8601 UTC instant
 * BEFORE parsing, logs a warning to stderr, and returns without writing.
 *
 * This test stores a known-good last_seen_utc, then feeds updateLastSeenUtc a
 * series of malformed inputs and asserts none of them mutate the stored value.
 * It also asserts a well-formed newer value DOES write, so the validation does
 * not break the happy path.
 *
 * Isolation: XDG_CONFIG_HOME is redirected to a throwaway temp dir BEFORE any
 * Ghost module is imported, so this never touches the real configstore. Modules
 * are loaded via dynamic import for the same reason.
 *
 * Run: node tests/license-last-seen-validation.smoke.mjs
 */

import os from 'os';
import path from 'path';
import fs from 'fs';

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    failures++;
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-store-test-'));
process.env.XDG_CONFIG_HOME = tmpRoot;

const { saveActivation, updateLastSeenUtc, getLastSeenUtc } = await import('../src/license/store.js');
const { getConfig } = await import('../src/config.js');

// Seed a license record with a known-good baseline last_seen_utc. We set it
// directly on the config rather than via updateLastSeenUtc so the test is not
// coupled to wall-clock time (saveActivation stamps last_seen_utc with "now",
// and the monotonic ratchet would reject a baseline older than that).
const BASELINE = '2099-06-01T12:00:00Z';
saveActivation({ token: 'dummy-token', fingerprintHashes: null });
const cfg = getConfig();
const seed = cfg.get('license');
seed.last_seen_utc = BASELINE;
cfg.set('license', seed);
check('baseline last_seen_utc was seeded', getLastSeenUtc() === BASELINE);

console.log('\nTest: malformed inputs never overwrite the stored timestamp');

// Each of these is either non-canonical or non-parseable. None should write,
// regardless of whether Date.parse would coerce them, because they are not a
// canonical ISO-8601 UTC instant.
const malformed = [
  ['non-ISO string', 'not-a-date'],
  ['Unix timestamp integer', 1717243200],
  ['Unix timestamp string', '1717243200'],
  ['empty string', ''],
  ['null', null],
  ['undefined', undefined],
  ['date without time', '2026-12-31'],
  ['local-time offset (non-UTC)', '2099-01-01T00:00:00+05:00'],
  ['space instead of T', '2099-01-01 00:00:00Z'],
  ['microseconds (6 digits)', '2099-01-01T00:00:00.123456Z'],
];

for (const [label, value] of malformed) {
  updateLastSeenUtc(value);
  check(`rejected ${label} — stored value unchanged`, getLastSeenUtc() === BASELINE);
}

console.log('\nTest: a well-formed newer value still writes (happy path intact)');
const NEWER = '2099-06-02T12:00:00Z';
updateLastSeenUtc(NEWER);
check('well-formed newer value was written', getLastSeenUtc() === NEWER);

const NEWER_WITH_MS = '2099-06-03T08:30:00.250Z';
updateLastSeenUtc(NEWER_WITH_MS);
check('well-formed value with .mmm milliseconds was written', getLastSeenUtc() === NEWER_WITH_MS);

console.log('\nTest: an older well-formed value does not regress the ratchet');
updateLastSeenUtc('2026-01-01T00:00:00Z');
check('older value did not overwrite newer stored value', getLastSeenUtc() === NEWER_WITH_MS);

// Cleanup temp configstore.
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log('');
if (failures === 0) {
  console.log('PASSED — all assertions ok\n');
  process.exit(0);
} else {
  console.log('FAILED — ' + failures + ' assertion(s) failed\n');
  process.exit(1);
}
