// tests/checkpoint-salvage.smoke.mjs
//
// Audit 8, finding 3.1: the pass loop checkpoints
// [...session.mergedGroups, ...session.pendingPassResults], but mergedGroups
// entries are plain strings (the return of mergePassResults) while the merge
// template read .fileCount/.findings off every entry. Any salvaged scan of
// MERGE_BATCH_SIZE+ passes rendered its already-merged groups as
// "=== FINDINGS BATCH n (undefined files) ===\nundefined", silently
// destroying recovered findings while the CLI reported the API spend as
// recovered.
//
// This suite pins the v11.0.0 contract at both layers:
//   1. writeCheckpoint wraps string entries as {type:'merged', content} so
//      the persisted payload is always structured.
//   2. formatPassResultsForMerge renders merged wrappers (and, for
//      pre-v11.0.0 checkpoints already on disk, raw strings) with their
//      content intact and never emits "undefined".
//
// Run: node tests/checkpoint-salvage.smoke.mjs
// Network-free; uses a temp HOME so no real checkpoint files are touched.

import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-checkpoint-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { writeCheckpoint, readCheckpoint, formatPassResultsForMerge } =
  await import('../src/core/multipass.js');

let failures = 0;
function check(label, ok) {
  if (ok) {
    console.log(`  OK  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

// ── 1. formatPassResultsForMerge renders every shape without "undefined" ────

const MERGED_TEXT = 'MERGED GROUP FINDINGS: legacy auth bypass in session.php';
const PASS_TEXT   = 'PASS FINDINGS: unbounded query in export job';

const mixed = [
  { type: 'merged', content: MERGED_TEXT, fileCount: 0, findings: [] },
  MERGED_TEXT,                                       // pre-v11.0.0 raw string
  { passNum: 7, fileCount: 12, findings: PASS_TEXT }, // normal pass object
];

const rendered = formatPassResultsForMerge(mixed);
check('merged wrapper content survives', rendered.includes(MERGED_TEXT));
check('normal pass findings survive', rendered.includes(PASS_TEXT));
check('normal pass file count renders', rendered.includes('(12 files)'));
check('no "undefined" anywhere in the merge block', !rendered.includes('undefined'));

// ── 2. writeCheckpoint normalizes strings; readCheckpoint returns them ──────

const label = 'checkpoint-salvage-smoke';
const ok = writeCheckpoint(label, 7, 10, [
  MERGED_TEXT,                                        // raw string, as the pass loop hands it
  { passNum: 7, fileCount: 12, findings: PASS_TEXT },
]);
check('writeCheckpoint succeeded', ok === true);

const cp = readCheckpoint(label);
check('readCheckpoint returns the checkpoint', !!cp);
check('string entry was wrapped as {type:"merged"}',
  cp && cp.passResults[0] && cp.passResults[0].type === 'merged' &&
  cp.passResults[0].content === MERGED_TEXT);
check('object entry passed through untouched',
  cp && cp.passResults[1] && cp.passResults[1].findings === PASS_TEXT &&
  cp.passResults[1].fileCount === 12);

// ── 3. End to end: persisted checkpoint renders cleanly through the merge ───

const roundTrip = formatPassResultsForMerge(cp.passResults);
check('round-tripped merged content intact', roundTrip.includes(MERGED_TEXT));
check('round-tripped pass content intact', roundTrip.includes(PASS_TEXT));
check('round trip emits no "undefined"', !roundTrip.includes('undefined'));

fs.rmSync(tmpHome, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nPASSED — checkpoint salvage renders findings intact, no "undefined".');
