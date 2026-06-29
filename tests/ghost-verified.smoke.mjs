/**
 * Smoke test for the @ghost-verified annotation system in
 * src/watch/ghost-verified.js.
 *
 * scanForVerified() detects the @ghost-verified marker in a file's content via
 * indexOf (ReDoS-immune) and captures an optional ":reason" suffix.
 * partitionFindings() splits merged Ghost Watcher findings into active vs
 * verified: a finding is verified when ANY of its files carries the marker;
 * findings with an empty files[] always stay active. This test locks in marker
 * detection (with/without reason, missing file, absent marker) and the
 * partition semantics (active vs verified, empty-files, any-file match).
 *
 * Run: node tests/ghost-verified.smoke.mjs
 */

import { scanForVerified, partitionFindings } from '../src/watch/ghost-verified.js';

let failures = 0;

function checkEqual(label, actual, expected) {
  if (actual === expected) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected: ' + JSON.stringify(expected));
    console.log('       got:      ' + JSON.stringify(actual));
    failures++;
  }
}

const fileMap = {
  'a.js': 'const x = 1; // @ghost-verified: intentional legacy adapter\n',
  'b.js': 'const y = 2;\n',
  'c.js': '// @ghost-verified\nfoo();\n',
  'empty.js': '',
};

// ── Test 1: scanForVerified finds marker with reason ───────────────────────
console.log('Test 1: scanForVerified finds marker with reason');
{
  const r = scanForVerified('a.js', fileMap);
  checkEqual('a.js verified', r.verified, true);
  checkEqual('a.js reason captured', r.reason, 'intentional legacy adapter');
}

// ── Test 2: scanForVerified finds bare marker (no reason) ──────────────────
console.log('Test 2: scanForVerified finds bare marker (no reason)');
{
  const r = scanForVerified('c.js', fileMap);
  checkEqual('c.js verified', r.verified, true);
  checkEqual('c.js reason null', r.reason, null);
}

// ── Test 3: scanForVerified returns false for missing file ─────────────────
console.log('Test 3: scanForVerified returns false for missing file');
{
  const r = scanForVerified('missing.js', fileMap);
  checkEqual('missing.js not verified', r.verified, false);
  checkEqual('missing.js reason null', r.reason, null);
}

// ── Test 4: scanForVerified returns false when marker absent ───────────────
console.log('Test 4: scanForVerified returns false when marker absent');
{
  const r = scanForVerified('b.js', fileMap);
  checkEqual('b.js not verified', r.verified, false);
  checkEqual('b.js reason null', r.reason, null);
}

// ── Test 5: partitionFindings correctly partitions active vs verified ──────
console.log('Test 5: partitionFindings correctly partitions active vs verified');
{
  const findings = [
    { title: 'F1', severity: 'HIGH', files: ['a.js'] },   // verified (a.js marked, reason)
    { title: 'F2', severity: 'LOW',  files: ['b.js'] },   // active (b.js unmarked)
  ];
  const { active, verified } = partitionFindings(findings, fileMap);
  checkEqual('active count', active.length, 1);
  checkEqual('verified count', verified.length, 1);
  checkEqual('active is F2', active[0].title, 'F2');
  checkEqual('verified is F1', verified[0].title, 'F1');
  checkEqual('verified flag set', verified[0].verified, true);
  checkEqual('verifiedReason threaded', verified[0].verifiedReason, 'intentional legacy adapter');
}

// ── Test 6: partitionFindings — empty files[] stays active ─────────────────
console.log('Test 6: partitionFindings — empty files[] stays active');
{
  const findings = [
    { title: 'NoFiles', severity: 'MEDIUM', files: [] },
    { title: 'MissingFilesKey', severity: 'LOW' }, // no files property at all
  ];
  const { active, verified } = partitionFindings(findings, fileMap);
  checkEqual('both stay active', active.length, 2);
  checkEqual('none verified', verified.length, 0);
}

// ── Test 7: partitionFindings — verified when ANY file matches ─────────────
console.log('Test 7: partitionFindings — verified when ANY file matches');
{
  const findings = [
    { title: 'AnyMatch', severity: 'HIGH', files: ['b.js', 'x.js', 'c.js'] }, // c.js marked (bare)
  ];
  const { active, verified } = partitionFindings(findings, fileMap);
  checkEqual('not active', active.length, 0);
  checkEqual('verified via 3rd file', verified.length, 1);
  checkEqual('bare-marker reason null', verified[0].verifiedReason, null);
}

if (failures > 0) {
  console.log(`\nFAILED — ${failures} assertion(s) failed\n`);
  process.exit(1);
} else {
  console.log('\nPASSED — all assertions ok\n');
  process.exit(0);
}
