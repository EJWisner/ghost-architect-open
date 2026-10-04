/**
 * Smoke test for the finding-lifecycle delta computation (NEW / CARRIED /
 * RESOLVED) built on similarFinding().
 *
 * The two-loop delta below came from Ghost Watcher™, which is not part of
 * Ghost Open™ 12. The test stays because it pins similarFinding() from
 * src/utils/finding-parser.js on the four canonical shapes, and Compare
 * Reports classifies resolved and new findings with the same matcher. It
 * classifies each finding:
 *   - NEW      - a current finding with no match in the prior run.
 *   - CARRIED  - a current finding that matches a prior one.
 *   - RESOLVED - a prior finding with no match in the current run (fixed).
 *
 * Matching is done by similarFinding() from src/utils/finding-parser.js, which
 * matches on deterministic ID first, then normalized title, then word/file
 * overlap. This test locks in the classification for the four canonical shapes:
 * carried, resolved, new, and a mixed run containing all three.
 *
 * computeLifecycleDelta() below keeps the original two-loop structure.
 *
 * Run: node tests/finding-lifecycle.smoke.mjs
 */

import { similarFinding } from '../src/utils/finding-parser.js';

let failures = 0;

function checkEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected: ' + e);
    console.log('       got:      ' + a);
    failures++;
  }
}

// ── Delta logic: two loops over similarFinding ──────────────────────────────
// Same two-loop structure, same similarFinding calls. Returns the same
// { resolvedFindings, newFindingIds } shape the state entry is populated with.
function computeLifecycleDelta(allFindings, priorFindings, commitHashFull) {
  const resolvedFindings = [];
  const newFindingIds = [];

  // Classify each current finding as new (no match in prior) or carried.
  for (const curr of allFindings) {
    const matched = priorFindings.some(p => similarFinding(curr, p));
    if (!matched) newFindingIds.push(curr.id);
  }

  // Classify each prior finding with no current match as resolved.
  for (const prev of priorFindings) {
    const stillActive = allFindings.some(c => similarFinding(prev, c));
    if (!stillActive) {
      resolvedFindings.push({
        id:               prev.id,
        title:            prev.title,
        severity:         prev.severity,
        files:            prev.files || [],
        resolvedInCommit: commitHashFull,
        resolvedAt:       new Date().toISOString(),
      });
    }
  }

  return { resolvedFindings, newFindingIds };
}

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

// ── Case 1: exact ID match marks finding as carried ────────────────────────
console.log('Case 1: exact ID match = carried (not new, not resolved)');
{
  const prior = [
    { id: 'HIGH:foo.js:bar-baz', title: 'Bar baz conflict', severity: 'HIGH', files: ['src/foo.js'] },
  ];
  const current = [
    { id: 'HIGH:foo.js:bar-baz', title: 'Bar baz conflict', severity: 'HIGH', files: ['src/foo.js'] },
  ];
  const { resolvedFindings, newFindingIds } = computeLifecycleDelta(current, prior, COMMIT);
  checkEqual('no new findings', newFindingIds, []);
  checkEqual('no resolved findings', resolvedFindings.length, 0);
}

// ── Case 2: finding disappears = resolved ──────────────────────────────────
console.log('Case 2: finding disappears = resolved');
{
  const prior = [
    { id: 'HIGH:foo.js:bar-baz', title: 'Bar baz conflict', severity: 'HIGH', files: ['src/foo.js'] },
  ];
  const current = [];
  const { resolvedFindings, newFindingIds } = computeLifecycleDelta(current, prior, COMMIT);
  checkEqual('no new findings', newFindingIds, []);
  checkEqual('one resolved finding', resolvedFindings.length, 1);
  checkEqual('resolved id matches', resolvedFindings[0].id, 'HIGH:foo.js:bar-baz');
  checkEqual('resolvedInCommit stamped', resolvedFindings[0].resolvedInCommit, COMMIT);
}

// ── Case 3: new finding appears ────────────────────────────────────────────
console.log('Case 3: new finding appears');
{
  const prior = [];
  const current = [
    { id: 'MEDIUM:bar.js:new-issue', title: 'New issue found', severity: 'MEDIUM', files: ['src/bar.js'] },
  ];
  const { resolvedFindings, newFindingIds } = computeLifecycleDelta(current, prior, COMMIT);
  checkEqual('one new finding id', newFindingIds, ['MEDIUM:bar.js:new-issue']);
  checkEqual('no resolved findings', resolvedFindings.length, 0);
}

// ── Case 4: mixed — one resolved, one carried, one new ─────────────────────
console.log('Case 4: mixed — one resolved, one carried, one new');
{
  const prior = [
    { id: 'HIGH:foo.js:bar-baz',   title: 'Bar baz conflict',  severity: 'HIGH',   files: ['src/foo.js'] },
    { id: 'MEDIUM:baz.js:old-issue', title: 'Old issue carried', severity: 'MEDIUM', files: ['src/baz.js'] },
  ];
  const current = [
    { id: 'MEDIUM:baz.js:old-issue', title: 'Old issue carried', severity: 'MEDIUM', files: ['src/baz.js'] },
    { id: 'LOW:qux.js:brand-new',   title: 'Brand new finding', severity: 'LOW',    files: ['src/qux.js'] },
  ];
  const { resolvedFindings, newFindingIds } = computeLifecycleDelta(current, prior, COMMIT);
  checkEqual('one new finding id', newFindingIds, ['LOW:qux.js:brand-new']);
  checkEqual('one resolved finding', resolvedFindings.length, 1);
  checkEqual('resolved id is the disappeared one', resolvedFindings[0].id, 'HIGH:foo.js:bar-baz');
  checkEqual('carried finding is neither new nor resolved',
    newFindingIds.includes('MEDIUM:baz.js:old-issue') || resolvedFindings.some(f => f.id === 'MEDIUM:baz.js:old-issue'),
    false);
}

if (failures > 0) {
  console.log(`\nFAILED — ${failures} assertion(s) failed\n`);
  process.exit(1);
} else {
  console.log('\nPASSED — all assertions ok\n');
  process.exit(0);
}
