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
  // Marker inside a string literal — must NOT verify (self-reference trap).
  'literal.js': "const MARKER = '@ghost-verified';\nexport { MARKER };\n",
  // Python comment opener.
  'script.py': '# @ghost-verified: reviewed by data team\nprint(1)\n',
  // SQL comment opener.
  'query.sql': '-- @ghost-verified\nSELECT 1;\n',
  // Non-source files — must NEVER verify even if they contain the marker string.
  'CHANGELOG.md': '## v9.4.7\n- Added @ghost-verified comment-context detection\n',
  'package.json': '{"description":"supports @ghost-verified annotation system"}\n',
  'ghost-watcher.yaml': 'features:\n  ghost_verified: true # @ghost-verified\n',
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

// ── Test 8: marker inside a string literal does NOT verify ─────────────────
console.log('Test 8: marker in a string literal is not a comment, does not verify');
{
  const r = scanForVerified('literal.js', fileMap);
  checkEqual('literal.js not verified', r.verified, false);
  checkEqual('literal.js reason null', r.reason, null);
}

// ── Test 9: Python # comment marker verifies ───────────────────────────────
console.log('Test 9: Python # @ghost-verified verifies');
{
  const r = scanForVerified('script.py', fileMap);
  checkEqual('script.py verified', r.verified, true);
  checkEqual('script.py reason captured', r.reason, 'reviewed by data team');
}

// ── Test 10: SQL -- comment marker verifies ────────────────────────────────
console.log('Test 10: SQL -- @ghost-verified verifies');
{
  const r = scanForVerified('query.sql', fileMap);
  checkEqual('query.sql verified', r.verified, true);
  checkEqual('query.sql reason null', r.reason, null);
}

// ── Test 11: .md files never verify ────────────────────────────────────────
console.log('Test 11: .md files containing marker text never verify');
{
  const r = scanForVerified('CHANGELOG.md', fileMap);
  checkEqual('CHANGELOG.md not verified', r.verified, false);
  checkEqual('CHANGELOG.md reason null', r.reason, null);
}

// ── Test 12: .json files never verify ──────────────────────────────────────
console.log('Test 12: .json files containing marker text never verify');
{
  const r = scanForVerified('package.json', fileMap);
  checkEqual('package.json not verified', r.verified, false);
  checkEqual('package.json reason null', r.reason, null);
}

// ── Test 13: .yaml files never verify ──────────────────────────────────────
console.log('Test 13: .yaml files containing marker text never verify');
{
  const r = scanForVerified('ghost-watcher.yaml', fileMap);
  checkEqual('ghost-watcher.yaml not verified', r.verified, false);
  checkEqual('ghost-watcher.yaml reason null', r.reason, null);
}

// ── Tests 14-16: whitespace tolerance after the comment opener ──────────────
// Regression fixtures for the v10.0.17 anchoring fix (Audit 7, Q23): the old
// implementation hardcoded exactly one space after the opener, so every
// fixture above (single space) passed while these three silently failed.
// Reverting scanForVerified to the single-space match must fail this suite.
console.log('Tests 14-16: opener whitespace tolerance (none, tab, multi-space)');
{
  const wsMap = {
    'nospace.js':  'const a = 1; //@ghost-verified: zero spaces\n',
    'tabbed.py':   '#\t@ghost-verified: tab separated\nprint(1)\n',
    'multisp.sql': '--   @ghost-verified\nSELECT 1;\n',
  };
  const r1 = scanForVerified('nospace.js', wsMap);
  checkEqual('//@ghost-verified (no space) verified', r1.verified, true);
  checkEqual('//@ghost-verified reason captured', r1.reason, 'zero spaces');
  const r2 = scanForVerified('tabbed.py', wsMap);
  checkEqual('#\\t@ghost-verified (tab) verified', r2.verified, true);
  const r3 = scanForVerified('multisp.sql', wsMap);
  checkEqual('--   @ghost-verified (multi-space) verified', r3.verified, true);
}

// ── Test 17: near-miss marker warns and does not verify ─────────────────────
console.log('Test 17: bare marker outside comment context warns, never verifies');
{
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let r;
  try {
    r = scanForVerified('nearmiss.js', {
      'nearmiss.js': 'const tag = 1;\n@ghost-verified\nfoo();\n',
    });
  } finally {
    console.warn = origWarn;
  }
  checkEqual('near-miss not verified', r.verified, false);
  checkEqual('near-miss emitted a warning', warnings.some(w => w.includes('not anchored to a comment opener')), true);
}

// ── Test 18: JSDoc continuation-line style anchors ───────────────────────────
console.log('Test 18: " * @ghost-verified" (doc-block continuation) verifies');
{
  const r = scanForVerified('jsdoc.js', {
    'jsdoc.js': '/**\n * @ghost-verified: reviewed in design doc\n */\nfunction f() {}\n',
  });
  checkEqual('jsdoc continuation verified', r.verified, true);
  checkEqual('jsdoc reason captured', r.reason, 'reviewed in design doc');
}

// ── Test 19: Swift and Kotlin files are annotatable ──────────────────────────
console.log('Test 19: Swift/Kotlin (scannable since v10.0.17) accept the annotation');
{
  const r1 = scanForVerified('App.swift', { 'App.swift': '// @ghost-verified: platform team reviewed\nlet x = 1\n' });
  checkEqual('.swift verified', r1.verified, true);
  const r2 = scanForVerified('Main.kt', { 'Main.kt': '// @ghost-verified\nval y = 2\n' });
  checkEqual('.kt verified', r2.verified, true);
}

if (failures > 0) {
  console.log(`\nFAILED — ${failures} assertion(s) failed\n`);
  process.exit(1);
} else {
  console.log('\nPASSED — all assertions ok\n');
  process.exit(0);
}
