/**
 * Smoke test for validateLicense() resilience to a last_seen_utc write failure.
 *
 * Background: after a successful clock check the validator persists an updated
 * last_seen_utc as a monotonic ratchet (step 5 in src/license/validator.js).
 * If that write throws (disk full, read-only filesystem, EACCES), the error
 * used to propagate out of validateLicense and lock the user out of every gated
 * mode with a confusing message after a single transient disk hiccup.
 *
 * The fix wraps the persist in a try/catch that logs to stderr and continues.
 * A failed ratchet write is harmless: the next run just reads a slightly older
 * last_seen_utc, which is never newer than "now" and so cannot trip rollback
 * detection. This test stubs the underlying store write to throw and asserts
 * the validator still returns state: valid.
 *
 * Isolation: XDG_CONFIG_HOME is redirected to a throwaway temp dir BEFORE any
 * Ghost module is imported, so this never touches the real configstore (which
 * holds the live API key and any real license). Modules are loaded via dynamic
 * import for the same reason — static imports are hoisted ahead of the env set.
 *
 * Run: node tests/license-last-seen-write-failure.smoke.mjs
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

// Redirect configstore to an isolated temp dir before importing anything that
// constructs the Configstore instance (config.js does so at module load).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-validator-test-'));
process.env.XDG_CONFIG_HOME = tmpRoot;

const { encodeTrialToken } = await import('../src/license/token.js');
const { saveActivation } = await import('../src/license/store.js');
const { getConfig } = await import('../src/config.js');
const { validateLicense } = await import('../src/license/validator.js');

// Build a valid, in-date trial token. Trial tokens are HMAC-signed with the
// secret baked into keys.js, so we can mint one here without the Ed25519
// private key. fingerprint: null means the validator skips hardware binding.
function isoPlusDays(days) {
  return new Date(Date.now() + days * 86400 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}
function isoMinusDays(days) {
  return new Date(Date.now() - days * 86400 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

const payload = {
  lid: 'TRIALWRITE1',
  tier: 'trial',
  customer: 'write-failure-test',
  issued: isoMinusDays(1),
  expires: isoPlusDays(30),
  grace_until: isoPlusDays(35),
  hard_stop: isoPlusDays(36),
  fingerprint: null,
};
const token = encodeTrialToken(payload);

// Persist the license, then set last_seen_utc into the past so the validator's
// monotonic ratchet decides it must write a newer value (newLastSeenMs truthy).
saveActivation({ token, fingerprintHashes: null });
const cfg = getConfig();
const record = cfg.get('license');
record.last_seen_utc = isoMinusDays(2);
cfg.set('license', record);

// Now make every subsequent write throw, simulating a full/read-only disk.
// updateLastSeenUtc -> store.write -> cfg.set, so this fires inside step 5.
const originalSet = cfg.set.bind(cfg);
cfg.set = () => {
  throw new Error('ENOSPC: simulated disk full');
};

console.log('\nTest: validateLicense survives a last_seen_utc write failure');
let result;
let threw = false;
try {
  // skipNetworkClock avoids the network roundtrip; the local rollback path
  // still computes newLastSeenMs and still attempts the (now-throwing) write.
  result = await validateLicense({ skipNetworkClock: true });
} catch (e) {
  threw = true;
  console.log('       validateLicense threw: ' + e.message);
}

// Restore before assertions so a failure can't leave the stub installed.
cfg.set = originalSet;

check('validateLicense did not throw on write failure', !threw);
check('returned a result object', !!result);
check("state is 'valid' despite the failed write", result && result.state === 'valid');

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
