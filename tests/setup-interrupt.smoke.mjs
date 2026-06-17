/**
 * Smoke tests for src/config.js setup-interrupt classification.
 *
 * Regression target (GB setup-interrupt): handleSetupInterrupt used to treat
 * EVERY error thrown during the first-run wizard as a benign user abort,
 * printing "Setup interrupted. No changes were lost." and exiting 0. That
 * masked real system failures, a read-only or full configstore directory
 * (EACCES / ENOSPC) silently failed to save the user's API key while telling
 * CI/scripts that setup succeeded.
 *
 * isSetupUserAbort is the pure classifier behind the fix: only a genuine user
 * cancellation returns true (-> exit 0); every system error returns false
 * (-> log details, exit 1). These tests lock that boundary in, including a
 * real read-only configstore directory simulation.
 *
 * Run: node tests/setup-interrupt.smoke.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Configstore from 'configstore';
import { isSetupUserAbort } from '../src/config.js';

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

// Test 1: genuine user-abort error shapes classify as user aborts (-> exit 0)
console.log('Test 1: user aborts are recognized');
{
  // Modern @inquirer/prompts Ctrl+C rejection.
  const exitPrompt = new Error('User force closed the prompt with 0 null');
  exitPrompt.name = 'ExitPromptError';
  check('ExitPromptError by name', isSetupUserAbort(exitPrompt), true);

  // Legacy phrasing without the special name.
  check('"force closed the prompt" message', isSetupUserAbort(new Error('force closed the prompt')), true);
  check('"cancelled by user" message', isSetupUserAbort(new Error('Operation cancelled by user')), true);
  check('"canceled by user" (US spelling)', isSetupUserAbort(new Error('canceled by user')), true);

  // A SIGINT surfacing as a catchable error rather than a process signal.
  const sigint = new Error('aborted');
  sigint.code = 'SIGINT';
  check('error with code SIGINT', isSetupUserAbort(sigint), true);

  const sigintSignal = new Error('aborted');
  sigintSignal.signal = 'SIGINT';
  check('error with signal SIGINT', isSetupUserAbort(sigintSignal), true);
}
console.log('');

// Test 2: system failures are NOT misclassified as user aborts (-> exit 1)
console.log('Test 2: system failures are not user aborts');
{
  const eacces = new Error("EACCES: permission denied, open '/etc/configstore/ghost-architect.json'");
  eacces.code = 'EACCES';
  check('EACCES filesystem error', isSetupUserAbort(eacces), false);

  const enospc = new Error('ENOSPC: no space left on device');
  enospc.code = 'ENOSPC';
  check('ENOSPC disk-full error', isSetupUserAbort(enospc), false);

  const corrupt = new SyntaxError('Unexpected token } in JSON at position 12');
  check('corrupted-config SyntaxError', isSetupUserAbort(corrupt), false);

  check('plain unknown Error', isSetupUserAbort(new Error('something weird')), false);
  check('null', isSetupUserAbort(null), false);
  check('undefined', isSetupUserAbort(undefined), false);
}
console.log('');

// Test 3: a REAL read-only configstore directory throws an error that the
// classifier treats as a system failure, not a cancellation. This is the
// exact masking scenario from the bug: config.set() inside the wizard throws
// EACCES and must NOT be swallowed as "no changes were lost / exit 0".
console.log('Test 3: read-only configstore directory -> system error');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cfg-test-'));
  const roDir = path.join(tmpDir, 'readonly');
  fs.mkdirSync(roDir);
  // Drop write permission on the directory so the atomic write fails.
  fs.chmodSync(roDir, 0o500);

  const store = new Configstore('ghost-architect-test', undefined, {
    configPath: path.join(roDir, 'ghost-architect.json'),
  });

  let thrown = null;
  let wrote = false;
  try {
    store.set('anthropicApiKey', 'sk-ant-should-not-persist');
    wrote = true;
  } catch (err) {
    thrown = err;
  } finally {
    // Restore permissions so cleanup can remove the temp tree.
    fs.chmodSync(roDir, 0o700);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (wrote) {
    // Running as root (or a filesystem that ignores mode bits) bypasses the
    // permission check. Don't fail the suite, but make the skip visible.
    console.log('  ??  SKIP: write to read-only dir unexpectedly succeeded (running as root?)');
  } else {
    check('configstore set threw on read-only dir', thrown !== null, true);
    check('thrown error is NOT a user abort', isSetupUserAbort(thrown), false);
    check('thrown error carries a filesystem code', !!(thrown && thrown.code), true);
  }
}
console.log('');

if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
