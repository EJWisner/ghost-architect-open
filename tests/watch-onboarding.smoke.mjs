/**
 * Smoke test for the Ghost Watcher™ onboarding helpers in src/watch/index.js.
 *
 * Covers two things that had zero coverage before:
 *   (a) estimateWatcherCost() must return BATCH-DISCOUNTED per-run figures.
 *       Ghost Watcher runs every scan through the Anthropic Message Batches API
 *       (half price), so the onboarding estimate the buyer sees must be halved
 *       from the streaming reference numbers. The assertions below encode the
 *       exact halved values, so removing the BATCH_DISCOUNT multiply in the
 *       source makes this test FAIL (verified by mutation check).
 *   (b) buildWatchConfig() must emit a ghost-watcher.yaml with the expected
 *       shape/keys.
 *
 * Isolation: XDG_CONFIG_HOME is redirected to a throwaway temp dir BEFORE any
 * Ghost module is imported, so this never touches the real configstore.
 *
 * Run: node tests/watch-onboarding.smoke.mjs
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
// Float-tolerant equality for currency arithmetic (0.15 + 0.80 etc. are not
// exact in IEEE-754, and the discount multiply compounds the error slightly).
function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-watch-onboarding-test-'));
process.env.XDG_CONFIG_HOME = tmpRoot;

const { estimateWatcherCost, buildWatchConfig } = await import('../src/watch/index.js');
const yaml = (await import('yaml')).default;

// ── (a) estimateWatcherCost — batch-discounted figures ─────────────────────────
console.log('\nTest: estimateWatcherCost returns batch-discounted per-run figures');

// Streaming reference (pre-discount): blast 0.15-0.30, conflict 0.80-1.50.
// Both enabled sums to streaming 0.95-1.80; batch rate = half = 0.475-0.90.
const both = estimateWatcherCost({ blastRadius: true, conflictDetection: true, commitsPerDay: 5 });

check('per-run low is the batch-halved 0.475 (streaming 0.95)', approx(both.perRun.low, 0.475));
check('per-run high is the batch-halved 0.90 (streaming 1.80)', approx(both.perRun.high, 0.90));
// Guard against a regression that drops the discount: the streaming numbers
// must NOT be what the buyer sees.
check('per-run high is NOT the full streaming 1.80', !approx(both.perRun.high, 1.80));
check('per-run low is NOT the full streaming 0.95', !approx(both.perRun.low, 0.95));

// Monthly derives from the discounted per-run: 0.90 * (5 * 30) = 135, not 270.
check('monthly high reflects the discount (135, not 270)', both.monthly.high === 135);
check('runsPerMonth = commitsPerDay * 30', both.runsPerMonth === 150);

console.log('\nTest: estimateWatcherCost halves each scan independently');
const blastOnly = estimateWatcherCost({ blastRadius: true, conflictDetection: false });
check('blast-only per-run low is halved 0.075 (streaming 0.15)', approx(blastOnly.perRun.low, 0.075));
check('blast-only per-run high is halved 0.15 (streaming 0.30)', approx(blastOnly.perRun.high, 0.15));

const conflictOnly = estimateWatcherCost({ blastRadius: false, conflictDetection: true });
check('conflict-only per-run low is halved 0.40 (streaming 0.80)', approx(conflictOnly.perRun.low, 0.40));
check('conflict-only per-run high is halved 0.75 (streaming 1.50)', approx(conflictOnly.perRun.high, 0.75));

// ── (b) buildWatchConfig — shape / keys ────────────────────────────────────────
console.log('\nTest: buildWatchConfig produces a well-formed ghost-watcher.yaml');
const cfgYaml = buildWatchConfig();
check('buildWatchConfig returns a string', typeof cfgYaml === 'string');

const parsed = yaml.parse(cfgYaml);
const gw = parsed && parsed.ghost_watcher;
check('top-level ghost_watcher key present', !!gw);
check('version is 1.0', gw && gw.version === '1.0');
check('enabled defaults true', gw && gw.enabled === true);
check('trigger.branches is an array including main', gw && Array.isArray(gw.trigger?.branches) && gw.trigger.branches.includes('main'));
check('scans block has blast_radius', gw && gw.scans && 'blast_radius' in gw.scans);
check('scans block has conflict_detection', gw && gw.scans && 'conflict_detection' in gw.scans);
check('scans block has ghost_brief', gw && gw.scans && 'ghost_brief' in gw.scans);
check('portal.token_env is GHOST_PORTAL_TOKEN', gw && gw.portal?.token_env === 'GHOST_PORTAL_TOKEN');
check('notifications.pr_comment defaults true', gw && gw.notifications?.pr_comment === true);
check('team.config is team.yaml', gw && gw.team?.config === 'team.yaml');

console.log('\nTest: buildWatchConfig honors overrides');
const custom = yaml.parse(buildWatchConfig({ branches: ['release/**'], blastRadius: false, prComment: false }));
check('override branches propagate', custom.ghost_watcher.trigger.branches.includes('release/**'));
check('blastRadius:false disables the scan', custom.ghost_watcher.scans.blast_radius === false);
check('prComment:false disables pr_comment', custom.ghost_watcher.notifications.pr_comment === false);

// Clean up.
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log('');
if (failures === 0) {
  console.log('PASSED — all assertions ok\n');
  process.exit(0);
} else {
  console.log('FAILED — ' + failures + ' assertion(s) failed\n');
  process.exit(1);
}
