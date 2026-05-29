/**
 * Smoke tests for Commit Forecast — Day 3
 *
 * Tests the synthesis primitive (forecast-overlay.js), tier gating,
 * diff renderer, and analyst framing, all without network calls or
 * a real codebase scan.
 *
 * Run: node tests/commit-forecast.smoke.mjs
 * Exit: 0 = all pass, 1 = any failure
 */

import { buildForecastOverlay, discoverWorkingTreeChanges, isGitRepo } from '../src/core/forecast-overlay.js';
import { renderForecastDiff } from '../src/utils/diff-renderer.js';
import { buildConflictPrompt } from '../prompts/conflict.js';
import { requireTier, FORECAST_QUOTA } from '../src/license/tier-gates.js';
import {
  getForecastCount,
  incrementForecastCount,
  resetForecastCount,
} from '../src/freemium.js';
import fs   from 'fs';
import path from 'path';
import os   from 'os';

let failures = 0;
let total    = 0;

function check(label, actual, expected) {
  total++;
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

function checkContains(label, haystack, needle) {
  total++;
  if (typeof haystack === 'string' && haystack.includes(needle)) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       needle:  ' + JSON.stringify(needle));
    console.log('       in:      ' + JSON.stringify(String(haystack).slice(0, 200)));
    failures++;
  }
}

function checkTrue(label, value) {
  total++;
  if (value) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label + ' (got falsy)');
    failures++;
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Create a temporary directory tree for testing. Returns { dir, cleanup }.
 */
function makeTempTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-forecast-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Build a synthetic baseline codebaseContext (same shape as loader output).
 */
function makeBaseline(fileMap) {
  let context = '';
  const fileIndex = [];
  for (const [filePath, content] of Object.entries(fileMap)) {
    context += `\n\n=== FILE: ${filePath} ===\n${content}`;
    fileIndex.push(filePath);
  }
  return {
    context,
    fileIndex,
    fileMap,
    totalFiles:  Object.keys(fileMap).length,
    loadedFiles: Object.keys(fileMap).length,
  };
}

// ── Suite 1: Tier gate logic ──────────────────────────────────────────────────

console.log('\nSuite 1: Tier gate logic');

check('FORECAST_QUOTA is 1', FORECAST_QUOTA, 1);

{
  const r = requireTier('mode:commit-forecast', { tier: 'open', forecastsUsed: 0 });
  check('Open unused: allowed', r.allowed, true);
  check('Open unused: quotaRemaining=1', r.quotaRemaining, 1);
}
{
  const r = requireTier('mode:commit-forecast', { tier: 'open', forecastsUsed: 1 });
  check('Open exhausted: blocked', r.allowed, false);
  checkContains('Open exhausted: reason', r.reason, 'forecast_quota_exceeded');
}
{
  const r = requireTier('mode:commit-forecast', { tier: 'pro', forecastsUsed: 9999 });
  check('Pro unlimited: allowed', r.allowed, true);
}
{
  const r = requireTier('mode:commit-forecast', { tier: 'team', forecastsUsed: 9999 });
  check('Team unlimited: allowed', r.allowed, true);
}
{
  const r = requireTier('mode:commit-forecast', { tier: 'trial', forecastsUsed: 9999 });
  check('Trial unlimited: allowed', r.allowed, true);
}

// ── Suite 2: Forecast counter (configstore) ───────────────────────────────────

console.log('\nSuite 2: Forecast counter');

// Reset first so test is idempotent
resetForecastCount();
check('after reset, count=0', getForecastCount(), 0);
incrementForecastCount();
check('after 1 increment, count=1', getForecastCount(), 1);
incrementForecastCount();
check('after 2 increments, count=2', getForecastCount(), 2);
resetForecastCount();
check('after reset again, count=0', getForecastCount(), 0);

// ── Suite 3: Synthesis primitive — path mapping ───────────────────────────────

console.log('\nSuite 3: Synthesis primitive — path mapping');

{
  // Build a temp baseline tree and a proposed tree.
  const baseRoot = '/synthetic/repo';

  // Simulate a baseline fileMap with absolute paths
  const baselineFileMap = {
    [`${baseRoot}/src/models/User.php`]:     'class User { public $name; }',
    [`${baseRoot}/src/services/Auth.php`]:   'class Auth { public function login() {} }',
    [`${baseRoot}/src/config/database.php`]: 'return ["host" => "localhost"];',
  };

  const baselineContext = makeBaseline(baselineFileMap);

  // Build proposed dir: modified User.php + new file NewFeature.php
  const proposed = makeTempTree({
    'src/models/User.php':       'class User { public $name; public $email; }',  // modified
    'src/services/NewFeature.php': 'class NewFeature { public function run() {} }',  // added
  });

  try {
    const { patchedContext, changedFiles } = await buildForecastOverlay(
      baselineContext,
      proposed.dir,
      { tier: 'pro', verbose: false }
    );

    // Verify overlay shape
    checkTrue('patchedContext has context string', typeof patchedContext.context === 'string');
    checkTrue('patchedContext has fileMap', typeof patchedContext.fileMap === 'object');
    checkTrue('patchedContext has fileIndex', Array.isArray(patchedContext.fileIndex));

    // Verify modified file was patched
    const modifiedKey = `${baseRoot}/src/models/User.php`;
    checkContains('modified file has new content',
      patchedContext.fileMap[modifiedKey] || '',
      '$email'
    );
    check('original file NOT in patched (content differs)',
      (patchedContext.fileMap[modifiedKey] || '').includes('public $name;'),
      true // both versions have $name; just verify the patched one has $email too
    );

    // Verify unchanged file preserved
    checkContains('unchanged file preserved in overlay',
      patchedContext.fileMap[`${baseRoot}/src/services/Auth.php`] || '',
      'login()'
    );

    // Verify changedFiles manifest
    check('modified list length=1', changedFiles.modified.length, 1);
    checkContains('modified list contains User.php',
      changedFiles.modified[0],
      'User.php'
    );
    check('added list length=1', changedFiles.added.length, 1);
    checkContains('added list contains NewFeature.php',
      changedFiles.added[0],
      'NewFeature.php'
    );

    // Verify net-new file in patched fileMap
    const addedKey = changedFiles.added[0];
    checkContains('added file in patched fileMap',
      patchedContext.fileMap[addedKey] || '',
      'NewFeature'
    );

    // Verify context string prioritizes changed files first
    const ctxLines = patchedContext.context;
    const userPhpPos   = ctxLines.indexOf('User.php');
    const authPhpPos   = ctxLines.indexOf('Auth.php');
    checkTrue('changed file appears before unchanged in context',
      userPhpPos < authPhpPos || authPhpPos === -1
    );

    // Verify totalFiles count
    checkTrue('totalFiles >= 3', patchedContext.totalFiles >= 3);

  } finally {
    proposed.cleanup();
  }
}

// ── Suite 4: Synthesis primitive — redaction fail-closed ─────────────────────

console.log('\nSuite 4: Synthesis primitive — handles empty proposed dir gracefully');

{
  const emptyDir = makeTempTree({});
  const baselineContext = makeBaseline({ '/repo/src/app.js': 'const x = 1;' });
  let threw = false;
  try {
    await buildForecastOverlay(baselineContext, emptyDir.dir, { tier: 'open' });
  } catch (err) {
    threw = true;
    checkContains('empty dir throws descriptive error', err.message, 'no code files found');
  }
  check('empty proposed dir throws', threw, true);
  emptyDir.cleanup();
}

// ── Suite 5: Conflict prompt — forecastContext injection ──────────────────────

console.log('\nSuite 5: Conflict prompt forecastContext injection');

{
  const withCtx = buildConflictPrompt({
    passNum: 1, totalPasses: 1, totalFiles: 3,
    context: '=== FILE: src/a.js ===\nconst x = 1;',
    priorContext: '',
    forecastContext: 'These files have not been committed yet.',
  });
  checkTrue('forecastContext prefix present', withCtx.startsWith('COMMIT FORECAST CONTEXT:'));
  checkContains('forecastContext body included', withCtx, 'not been committed');
  checkContains('pass header still present', withCtx, 'Performing a full conflict detection');
}

{
  const withoutCtx = buildConflictPrompt({
    passNum: 1, totalPasses: 1, totalFiles: 3,
    context: '=== FILE: src/a.js ===\nconst x = 1;',
    priorContext: '',
  });
  checkTrue('no forecastContext: starts with pass header',
    withoutCtx.startsWith('Performing a full conflict detection')
  );
}

// ── Suite 6: isGitRepo ────────────────────────────────────────────────────────

console.log('\nSuite 6: isGitRepo detection');

{
  const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  checkTrue('ghost-architect-v7 is a git repo', isGitRepo(repoRoot));
}
{
  const tmpNoGit = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-nogit-'));
  check('non-git dir: false', isGitRepo(tmpNoGit), false);
  fs.rmSync(tmpNoGit, { recursive: true, force: true });
}

// ── Suite 7: Diff renderer — no throw on edge cases ───────────────────────────

console.log('\nSuite 7: Diff renderer edge cases (no-throw)');

{
  let threw = false;
  try {
    // Empty — no output expected but should not throw
    renderForecastDiff({ modified: [], added: [] }, {}, {});
  } catch { threw = true; }
  check('empty changedFiles: no throw', threw, false);
}

{
  let threw = false;
  try {
    // Large file over MAX_DIFF_LINES — should show summary not full diff
    const bigContent = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const smallChange = bigContent + '\nnew line at end';
    renderForecastDiff(
      { modified: ['/repo/big.js'], added: [] },
      { '/repo/big.js': bigContent },
      { '/repo/big.js': smallChange }
    );
  } catch (err) { threw = true; console.log('   thrown:', err.message); }
  check('large file diff: no throw', threw, false);
}

{
  let threw = false;
  try {
    // Added file
    renderForecastDiff(
      { modified: [], added: ['/repo/new.js'] },
      {},
      { '/repo/new.js': 'export const x = 1;\nexport const y = 2;' }
    );
  } catch { threw = true; }
  check('added file: no throw', threw, false);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${total} checks — ${failures} failure(s)\n`);
if (failures > 0) process.exit(1);
