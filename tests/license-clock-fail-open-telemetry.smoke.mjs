/**
 * Smoke test for validateClock() fail-open telemetry, the user-facing offline
 * warning, and the consecutive-offline grace counter.
 *
 * Background: validateClock() intentionally fails open (trusts the local clock)
 * when the network time fetch fails, so an offline Pro customer is not locked
 * out. Previously this happened silently, which let an attacker block network
 * access and then roll the local clock back undetected. The fix:
 *   1. emits a telemetry event on every fail-open recording the failure
 *      timestamp, the last successful network time (if any), and the local
 *      clock value being trusted;
 *   2. writes a soft warning to stderr telling the user expiration is now
 *      based on the local clock;
 *   3. counts consecutive offline validations and stops failing open once they
 *      exceed MAX_CONSECUTIVE_OFFLINE, requiring a real network check.
 *
 * Isolation: XDG_CONFIG_HOME is redirected to a throwaway temp dir BEFORE any
 * Ghost module is imported, so this never touches the real configstore. The
 * network fetcher and telemetry sink are stubbed via the module's test seams,
 * so the test makes no real network calls.
 *
 * Run: node tests/license-clock-fail-open-telemetry.smoke.mjs
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-clock-test-'));
process.env.XDG_CONFIG_HOME = tmpRoot;

const {
  validateClock,
  _resetNetworkCache,
  _setClockTelemetrySink,
  _setNetworkTimeFetcher,
} = await import('../src/license/clock.js');

// Capture stderr so we can assert the offline warning is surfaced, while
// keeping the test output readable.
const realStderrWrite = process.stderr.write.bind(process.stderr);
let stderrBuf = '';
function captureStderr() {
  stderrBuf = '';
  process.stderr.write = (chunk, ...rest) => {
    stderrBuf += String(chunk);
    return true;
  };
}
function releaseStderr() {
  process.stderr.write = realStderrWrite;
}

// Deterministic offline machine: the fetcher always reports "no time server".
const OFFLINE = async () => null;
// Deterministic online machine: report a network time at "now" (small skew).
const ONLINE = async () => ({ ms: Date.now(), source: 'test-stub' });

console.log('\nTest: a network failure emits fail-open telemetry and fails open');

let captured = [];
_setClockTelemetrySink((event) => captured.push(event));
_setNetworkTimeFetcher(OFFLINE);
_resetNetworkCache();

captureStderr();
let result = await validateClock(null);
releaseStderr();

check('validateClock failed open (ok: true)', result.ok === true);
check('result reports networkOk: false', result.networkOk === false);
check('exactly one telemetry event emitted', captured.length === 1);

const ev = captured[0] || {};
check('telemetry event type is clock_fail_open', ev.event === 'clock_fail_open');
check('telemetry records the failure timestamp', typeof ev.failureMs === 'number' && ev.failureMs > 0);
check('telemetry records the trusted local clock value', ev.trustedLocalMs === result.nowMs);
check('telemetry records last successful network time (null on first ever offline)', ev.lastNetworkOkMs === null);
check('telemetry records consecutiveOffline = 1', ev.consecutiveOffline === 1);

console.log('\nTest: the user is warned that expiration is based on local clock');
check('stderr warning mentions offline mode',
  /Network time check skipped \(offline mode\)/.test(stderrBuf));
check('stderr warning mentions local clock',
  /License expiration is based on local clock/.test(stderrBuf));

console.log('\nTest: a successful network check resets the offline streak');
captured = [];
_setNetworkTimeFetcher(ONLINE);
_resetNetworkCache();
result = await validateClock(null);
check('validateClock ok with network', result.ok === true && result.networkOk === true);
check('consecutiveOffline reset to 0', result.consecutiveOffline === 0);
check('no telemetry emitted on the happy path', captured.length === 0);

console.log('\nTest: sustained offline exceeds the grace window and blocks');
captured = [];
_setNetworkTimeFetcher(OFFLINE);

let blocked = null;
let softOpenCount = 0;
// Loop well past any reasonable grace window. Before the limit, each call must
// fail open (ok: true); once exceeded, it must block with the dedicated reason.
for (let i = 0; i < 50; i++) {
  _resetNetworkCache();
  captureStderr();
  const r = await validateClock(null);
  releaseStderr();
  if (r.ok) {
    softOpenCount++;
  } else {
    blocked = r;
    break;
  }
}

check('the grace window allowed at least one soft fail-open before blocking', softOpenCount >= 1);
check('sustained offline eventually blocked', blocked !== null && blocked.ok === false);
check('block reason is clock_offline_grace_exceeded',
  blocked && blocked.reason === 'clock_offline_grace_exceeded');
check('block result still reports networkOk: false', blocked && blocked.networkOk === false);
check('block detail explains a network check is required',
  blocked && /network time check is now required/i.test(blocked.detail || ''));
check('telemetry fired for every offline run up to and including the block',
  captured.length === softOpenCount + 1);

console.log('\nTest: recovering the network clears the block',);
_setNetworkTimeFetcher(ONLINE);
_resetNetworkCache();
result = await validateClock(null);
check('after reconnect, validation succeeds again', result.ok === true && result.networkOk === true);
check('streak reset to 0 after reconnect', result.consecutiveOffline === 0);

// Restore defaults and clean up.
_setClockTelemetrySink(null);
_setNetworkTimeFetcher(null);
_resetNetworkCache();
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log('');
if (failures === 0) {
  console.log('PASSED — all assertions ok\n');
  process.exit(0);
} else {
  console.log('FAILED — ' + failures + ' assertion(s) failed\n');
  process.exit(1);
}
