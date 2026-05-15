// tests/license/test-activate-via-worker.mjs
//
// End-to-end test of the human-key activation flow in bin/ghost.js.
// Spins up the mock activation server (signs real tokens with the actual
// private key at ~/.ghost-signing/private.pem), points GHOST_ACTIVATION_ENDPOINT
// at it, runs `ghost --activate <human-key>` as a subprocess, and verifies:
//
//   1. Success path: server returns a real signed token, CLI verifies it
//      locally, license gets saved to a temp configstore.
//   2. license_not_found: CLI shows the right error and exits 2.
//   3. license_revoked: CLI shows the right error.
//   4. bound_elsewhere: CLI shows "bound to different machine" with the
//      server-provided detail string.
//   5. rate_limit_exceeded: CLI shows the rate-limit message.
//   6. unreachable: server is down, CLI shows "could not reach".
//
// Subprocess uses a temporary XDG_CONFIG_HOME so we don't trash EJ's real
// license between test runs.
//
// Run: node tests/license/test-activate-via-worker.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer } from './mock-activation-server.mjs';

const REPO_ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const GHOST_BIN = path.join(REPO_ROOT, 'bin', 'ghost.js');

const PASS = (name) => console.log(`  ✓ ${name}`);
const FAIL = (name, why) => { console.error(`  ✗ ${name}: ${why}`); process.exitCode = 1; };

function makeTmpConfigHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-activate-test-'));
}

function runGhost(args, { configHome, endpoint }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      GHOST_ACTIVATION_ENDPOINT: endpoint,
      // Suppress the npm/yarn update-notifier prompts during tests
      NO_UPDATE_NOTIFIER: '1',
    };
    const proc = spawn('node', [GHOST_BIN, ...args], { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
  });
}

// Build a fresh valid human key for testing — use the format module directly.
async function freshHumanKey() {
  const { _ALPHABET } = await import('../../src/license/format.js');
  // Use the generator to mint a real key with valid checksum
  const { generateKey } = await import('../../src/license/format.js');
  return generateKey('PRO');
}

console.log('\n── /activate human-key path tests ──');

// Test 1: success path
{
  const mock = await startMockServer({ scenario: 'success' });
  const configHome = makeTmpConfigHome();
  const humanKey = await freshHumanKey();
  const { code, stdout, stderr } = await runGhost(['--activate', humanKey], {
    configHome,
    endpoint: mock.url,
  });
  await mock.close();
  if (code !== 0) {
    FAIL('success: exit code', `expected 0, got ${code}. stderr: ${stderr.slice(0, 300)}`);
  } else if (!/License activated/.test(stdout) || !/mock-test@example\.com/.test(stdout)) {
    FAIL('success: output', `missing activation confirmation. stdout: ${stdout.slice(0, 300)}`);
  } else {
    PASS('success path: server signs token, CLI verifies + saves');
  }
  // Verify the license actually landed in the temp configstore
  const storeFile = path.join(configHome, 'configstore', 'ghost-architect.json');
  if (fs.existsSync(storeFile)) {
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    if (stored.license && typeof stored.license.token === 'string') {
      PASS('success path: license token persisted in configstore');
    } else {
      FAIL('success path: configstore', 'license.token missing from store');
    }
  } else {
    FAIL('success path: configstore', `${storeFile} not created`);
  }
  fs.rmSync(configHome, { recursive: true, force: true });
}

// Test 2: license_not_found
{
  const mock = await startMockServer({ scenario: 'not_found' });
  const configHome = makeTmpConfigHome();
  const humanKey = await freshHumanKey();
  const { code, stderr } = await runGhost(['--activate', humanKey], {
    configHome,
    endpoint: mock.url,
  });
  await mock.close();
  if (code !== 2) {
    FAIL('not_found: exit code', `expected 2, got ${code}`);
  } else if (!/License key not found/.test(stderr)) {
    FAIL('not_found: message', `missing 'License key not found'. stderr: ${stderr.slice(0, 200)}`);
  } else {
    PASS('not_found: clear error + exit 2');
  }
  fs.rmSync(configHome, { recursive: true, force: true });
}

// Test 3: license_revoked
{
  const mock = await startMockServer({ scenario: 'revoked' });
  const configHome = makeTmpConfigHome();
  const humanKey = await freshHumanKey();
  const { code, stderr } = await runGhost(['--activate', humanKey], {
    configHome,
    endpoint: mock.url,
  });
  await mock.close();
  if (code !== 2 || !/revoked/i.test(stderr)) {
    FAIL('revoked', `code=${code} stderr=${stderr.slice(0, 200)}`);
  } else {
    PASS('revoked: clear error + exit 2');
  }
  fs.rmSync(configHome, { recursive: true, force: true });
}

// Test 4: bound_elsewhere
{
  const mock = await startMockServer({ scenario: 'bound_elsewhere' });
  const configHome = makeTmpConfigHome();
  const humanKey = await freshHumanKey();
  const { code, stderr } = await runGhost(['--activate', humanKey], {
    configHome,
    endpoint: mock.url,
  });
  await mock.close();
  if (code !== 2 || !/hardware components match/i.test(stderr)) {
    FAIL('bound_elsewhere', `code=${code} stderr=${stderr.slice(0, 200)}`);
  } else {
    PASS('bound_elsewhere: surfaces server detail');
  }
  fs.rmSync(configHome, { recursive: true, force: true });
}

// Test 5: rate_limit_exceeded
{
  const mock = await startMockServer({ scenario: 'rate_limit' });
  const configHome = makeTmpConfigHome();
  const humanKey = await freshHumanKey();
  const { code, stderr } = await runGhost(['--activate', humanKey], {
    configHome,
    endpoint: mock.url,
  });
  await mock.close();
  if (code !== 2 || !/Too many activation attempts/.test(stderr)) {
    FAIL('rate_limit', `code=${code} stderr=${stderr.slice(0, 200)}`);
  } else {
    PASS('rate_limit: clear retry guidance');
  }
  fs.rmSync(configHome, { recursive: true, force: true });
}

// Test 6: server unreachable
{
  // Use a port that's almost certainly closed
  const deadEndpoint = 'http://127.0.0.1:1/activate';
  const configHome = makeTmpConfigHome();
  const humanKey = await freshHumanKey();
  const { code, stderr } = await runGhost(['--activate', humanKey], {
    configHome,
    endpoint: deadEndpoint,
  });
  if (code !== 2 || !/Could not reach activation server/.test(stderr)) {
    FAIL('unreachable', `code=${code} stderr=${stderr.slice(0, 200)}`);
  } else {
    PASS('unreachable: clear connection error + exit 2');
  }
  fs.rmSync(configHome, { recursive: true, force: true });
}

// Test 7: malformed key (typo in checksum) — should NOT hit the server
{
  // Generate a valid key then corrupt the last char so checksum fails
  const humanKey = (await freshHumanKey()).slice(0, -1) + 'A';
  // Stand up a mock that would FAIL the test if hit — server should never receive this
  let serverHit = false;
  const mock = await startMockServer({ scenario: 'success' });
  // Wrap to detect server hits
  const origHandlers = mock.server.listeners('request');
  mock.server.removeAllListeners('request');
  mock.server.on('request', (req, res) => {
    serverHit = true;
    origHandlers[0](req, res);
  });

  const configHome = makeTmpConfigHome();
  const { code, stderr } = await runGhost(['--activate', humanKey], {
    configHome,
    endpoint: mock.url,
  });
  await mock.close();
  if (serverHit) {
    FAIL('typo_in_key: client-side validation', 'server was hit despite checksum failure');
  } else if (code !== 2) {
    FAIL('typo_in_key: exit code', `expected 2, got ${code}`);
  } else if (!/Checksum mismatch|signature verification|not a valid license/i.test(stderr)) {
    FAIL('typo_in_key: message', `stderr: ${stderr.slice(0, 200)}`);
  } else {
    PASS('typo in key: client-side checksum catches it, no network call');
  }
  fs.rmSync(configHome, { recursive: true, force: true });
}

console.log('');
if (process.exitCode) {
  console.log('FAIL: one or more activate-via-worker tests failed.\n');
} else {
  console.log('PASS: all activate-via-worker tests succeeded.\n');
}
