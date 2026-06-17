/**
 * Smoke test for paid-tier integration failure surfacing in src/reports.js.
 *
 * Team-sync, mobile-publish, and portal-publish each race a push against a
 * timeout. The loser's rejection used to be swallowed in a bare `catch {}` —
 * the CLI printed "Report saved" while the sync never happened. saveReport now
 * flips a per-integration failed flag in the catch block, prints a yellow
 * warning naming the timeout duration and concrete next steps, and appends the
 * sanitized error to ~/Ghost Architect Reports/.debug/integration-failures.log.
 *
 * To trigger a real failure deterministically and OFFLINE, this test seeds a
 * configstore teamSync entry whose repo URL is malformed. pushReport() calls
 * parseRepo() before any network I/O, parseRepo() throws on the bad URL, and
 * the rejection propagates into saveReport's team-sync catch — no network call
 * is ever made. Each case runs in a child process with a fresh empty HOME so
 * the host machine's config and reports directory can't leak in.
 *
 * Run: node tests/reports-integration-failure-warning.smoke.mjs
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const reportsPath = path.join(repoRoot, 'src', 'reports.js');

let failures = 0;

function checkContains(label, value, substring) {
  if (typeof value === 'string' && value.includes(substring)) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected to contain: ' + JSON.stringify(substring));
    console.log('       got:                 ' + JSON.stringify(value));
    failures++;
  }
}

function checkTrue(label, cond) {
  if (cond) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    failures++;
  }
}

function childScript() {
  return `
import { saveReport } from ${JSON.stringify(reportsPath)};
const r = await saveReport('Sample report body.\\nNo findings.', 'ghost-poi', 'Demo Project', {});
process.stdout.write('SAVED=' + (r && r.filename ? 'true' : 'false') + '\\n');
`;
}

function runChild() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-reports-test-'));

  // Seed a configstore teamSync entry with a malformed repo so pushReport's
  // parseRepo() throws synchronously — a deterministic, offline failure.
  const csDir = path.join(tmpHome, '.config', 'configstore');
  fs.mkdirSync(csDir, { recursive: true });
  fs.writeFileSync(
    path.join(csDir, 'ghost-architect.json'),
    JSON.stringify({
      teamSync: [{ name: 'test', repo: 'not-a-valid-url', token: 'ghp_FAKESECRETTOKENVALUE0000000000000000' }],
    })
  );

  const scriptFile = path.join(tmpHome, 'child.mjs');
  fs.writeFileSync(scriptFile, childScript());

  const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
  delete env.XDG_CONFIG_HOME;
  delete env.ANTHROPIC_API_KEY;

  const res = spawnSync(process.execPath, [scriptFile], { env, encoding: 'utf8' });

  const debugLog = path.join(tmpHome, 'Ghost Architect Reports', '.debug', 'integration-failures.log');
  const logExists = fs.existsSync(debugLog);
  const logBody = logExists ? fs.readFileSync(debugLog, 'utf8') : '';

  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status, logExists, logBody };
}

console.log('Test: team-sync failure surfaces a warning and is logged to .debug/');
{
  const { stdout, logExists, logBody } = runChild();

  // The local save still succeeds — the failure is non-fatal.
  checkContains('report still saved locally', stdout, 'SAVED=true');

  // The warning must reach the user with the timeout duration and next steps.
  checkContains('warns the user team sync did not complete', stdout, 'Team sync did not complete');
  checkContains('names the 60s timeout duration', stdout, '60s');
  checkContains('gives concrete next steps', stdout, 'Re-run the scan or check your GitHub token');
  checkContains('points at the debug log', stdout, 'integration-failures.log');

  // The error is logged for post-mortem diagnosis.
  checkTrue('debug log file was written', logExists);
  checkContains('log records the team-sync failure', logBody, 'team-sync FAILED');
  checkContains('log records the timeout context', logBody, 'timeout 60s');
}
console.log('');

if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
