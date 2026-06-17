/**
 * Smoke tests for src/core/agent/verifier.js debug-log sanitization.
 *
 * The conflict verifier writes diagnostic JSON to ~/Ghost Architect Reports/
 * .debug/ when verification falls through to INSUFFICIENT. Those payloads
 * include candidate descriptions, file paths, and agent summaries — all of
 * which can carry user-supplied secrets or usernames. sanitizeForDebugLog()
 * redacts the common secret shapes before anything reaches disk. These tests
 * lock that in: known token formats, connection-string credentials, generic
 * secret assignments, and username-bearing paths are all redacted, while the
 * surrounding structure (and innocuous text) survives.
 *
 * Run: node tests/verifier-debug-sanitize.smoke.mjs
 */

import { sanitizeForDebugLog } from '../src/core/agent/verifier.js';

let failures = 0;

function checkNotContains(label, value, substring) {
  const s = JSON.stringify(value);
  if (!s.includes(substring)) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected NOT to contain: ' + JSON.stringify(substring));
    console.log('       got:                     ' + s);
    failures++;
  }
}

function checkContains(label, value, substring) {
  const s = JSON.stringify(value);
  if (s.includes(substring)) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected to contain: ' + JSON.stringify(substring));
    console.log('       got:                 ' + s);
    failures++;
  }
}

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

// Test 1: known API / token formats are redacted
console.log('Test 1: provider and VCS tokens are redacted');
{
  const anthropic = sanitizeForDebugLog('key is sk-ant-api03-AbCdEf012345_xyz-987');
  checkNotContains('anthropic key gone', anthropic, 'sk-ant-api03');
  checkContains('anthropic placeholder', anthropic, '<redacted-key>');

  const gh = sanitizeForDebugLog('token ghp_4k3MMrnABCDEFGHIJKLMNOPQRSTUV0123');
  checkNotContains('github pat gone', gh, 'ghp_4k3MMrn');
  checkContains('github placeholder', gh, '<redacted-key>');

  const aws = sanitizeForDebugLog('AKIAIOSFODNN7EXAMPLE in config');
  checkNotContains('aws key gone', aws, 'AKIAIOSFODNN7EXAMPLE');

  const jwt = sanitizeForDebugLog('Bearer eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NQ.SflKxwRJSM');
  checkNotContains('jwt gone', jwt, 'eyJhbGciOiJIUzI1');
}
console.log('');

// Test 2: connection-string credentials
console.log('Test 2: connection-string credentials are stripped');
{
  const conn = sanitizeForDebugLog('postgres://dbuser:s3cr3tPw@db.host:5432/app');
  checkNotContains('password gone', conn, 's3cr3tPw');
  checkNotContains('username gone', conn, 'dbuser');
  checkContains('host preserved', conn, 'db.host:5432/app');
}
console.log('');

// Test 3: generic secret assignments
console.log('Test 3: generic secret assignments redacted');
{
  check('password=',  sanitizeForDebugLog('password=hunter2'),       'password=<redacted>');
  check('api_key:',   sanitizeForDebugLog('api_key: "abc123XYZ"'),   'api_key: "<redacted>"');
  check('token =>',   sanitizeForDebugLog('token = supersecret'),    'token = <redacted>');
}
console.log('');

// Test 4: filesystem paths leaking a username
console.log('Test 4: usernames in paths are masked');
{
  const mac = sanitizeForDebugLog('/Users/ejwisner/ghost/verifier.js:42');
  checkNotContains('mac username gone', mac, 'ejwisner');
  checkContains('mac path shape kept', mac, '/Users/<user>/ghost/verifier.js:42');

  const linux = sanitizeForDebugLog('/home/derrick/code/app.php');
  checkNotContains('linux username gone', linux, 'derrick');
  checkContains('linux placeholder', linux, '/home/<user>/');

  const win = sanitizeForDebugLog('C:\\Users\\Cheryl\\repo');
  checkNotContains('windows username gone', win, 'Cheryl');
}
console.log('');

// Test 5: nested structures are walked, innocuous text survives
console.log('Test 5: nested payloads sanitized, plain text untouched');
{
  const payload = {
    candidate: {
      title: 'Schema mismatch in /Users/ejwisner/app/Model.php',
      description: 'connect with password=topsecret to verify',
      files: ['/Users/ejwisner/app/Model.php'],
      severity: 'high',
    },
    auditTrail: [{ action: 'readFile', input: 'sk-ant-api03-LEAKED012345678', count: 3 }],
  };
  const out = sanitizeForDebugLog(payload);

  checkNotContains('no username anywhere', out, 'ejwisner');
  checkNotContains('no password value', out, 'topsecret');
  checkNotContains('no leaked key', out, 'sk-ant-api03-LEAKED');
  check('non-string scalar preserved', out.auditTrail[0].count, 3);
  check('severity preserved', out.candidate.severity, 'high');
  checkContains('plain title words survive', out, 'Schema mismatch');
}
console.log('');

// Test 6: edge inputs do not throw
console.log('Test 6: edge inputs handled');
{
  check('null passthrough', sanitizeForDebugLog(null), null);
  check('number passthrough', sanitizeForDebugLog(42), 42);
  check('empty string', sanitizeForDebugLog(''), '');
}
console.log('');

if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
