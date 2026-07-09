/**
 * Boundary tests for the monotonic clock ratchet in updateLastSeenUtc().
 *
 * The ratchet rejects a new last_seen_utc that is:
 *   - more than MAX_PAST_MS (default 5 minutes) BEHIND the stored value
 *     (rollback defense), and
 *   - more than 24 hours in the FUTURE (implausible-clock defense).
 * Anything inside those windows is accepted (returns true), even when it is
 * older than the stored value and therefore does not advance the ratchet.
 *
 * These tests pin the exact boundaries so a future refactor cannot silently
 * loosen or tighten them:
 *   1. 59 seconds behind stored   -> accepted (inside the 5-minute window)
 *   2. 301 seconds behind stored  -> rejected (past the 5-minute window)
 *   3. 25 hours in the future     -> rejected (past the 24-hour window)
 *
 * Isolation: XDG_CONFIG_HOME is redirected to a throwaway temp dir BEFORE any
 * Ghost module is imported, so this never touches the real configstore. Modules
 * are loaded via dynamic import for the same reason.
 *
 * Run: node tests/license/test-clock-ratchet.mjs
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

// Ensure the default tolerance is in effect (no override leaking from the env).
delete process.env.GHOST_CLOCK_TOLERANCE;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-ratchet-test-'));
process.env.XDG_CONFIG_HOME = tmpRoot;

const { saveActivation, updateLastSeenUtc, getLastSeenUtc } = await import('../../src/license/store.js');
const { getConfig } = await import('../../src/config.js');

// Canonical ISO-8601 UTC instant (with .mmm) from an epoch-ms value.
const iso = (ms) => new Date(ms).toISOString();

const NOW_MS = Date.now();
// Seed a baseline last_seen_utc of "now" directly on the config so the test is
// not coupled to how saveActivation stamps the value.
const BASELINE = iso(NOW_MS);
saveActivation({ token: 'dummy-token', fingerprintHashes: null });
const cfg = getConfig();
const seed = cfg.get('license');
seed.last_seen_utc = BASELINE;
cfg.set('license', seed);
check('baseline last_seen_utc was seeded', getLastSeenUtc() === BASELINE);

console.log('\nTest 1: timestamp 59 seconds behind stored -- accepted');
const behind59 = updateLastSeenUtc(iso(NOW_MS - 59 * 1000));
check('updateLastSeenUtc returned true (inside 5-minute window)', behind59 === true);
check('stored value unchanged (older value does not advance ratchet)', getLastSeenUtc() === BASELINE);

console.log('\nTest 2: timestamp 301 seconds behind stored -- rejected');
const behind301 = updateLastSeenUtc(iso(NOW_MS - 301 * 1000));
check('updateLastSeenUtc returned false (past 5-minute window)', behind301 === false);
check('stored value unchanged after rejection', getLastSeenUtc() === BASELINE);

console.log('\nTest 3: timestamp 25 hours in the future -- rejected');
const future25h = updateLastSeenUtc(iso(NOW_MS + 25 * 60 * 60 * 1000));
check('updateLastSeenUtc returned false (past 24-hour future bound)', future25h === false);
check('stored value unchanged after rejection', getLastSeenUtc() === BASELINE);

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
