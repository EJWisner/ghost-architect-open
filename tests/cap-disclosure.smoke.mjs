/**
 * Smoke test for the Pass-2 finding cap: the disclosure, and the sidecar it
 * points at.
 *
 * Three things have to agree, and historically none of them did:
 *
 *   1. getCapDisclosure()  emits the sentence the report carries.
 *   2. presenceRegex       decides whether the model already wrote that
 *                          sentence, so a second copy is not spliced in.
 *   3. the .findings.json  is what the sentence promises the reader.
 *      sidecar
 *
 * (1) and (2) drifted: the regex searched for "N findings surfaced", a phrase
 * the disclosure never contained, so the check ALWAYS failed and every capped
 * report shipped the disclosure twice.
 *
 * (1) and (3) drifted worse: the disclosure said all N findings were "available
 * in the accompanying JSON file", but the sidecar was built by parsing the
 * FINISHED report, which only ever contains the top `cap`. The other N-cap
 * findings were never verified and never written anywhere. The report sent the
 * buyer looking for data that did not exist.
 *
 * That is now fixed at the source: splitFindingsAtCap() exposes the exact
 * partition the narrator applies, the pipeline verifies the undetailed
 * remainder, and every survivor is written to the sidecar. This test pins the
 * whole chain, including the invariant EJ asked for explicitly: on a capped run
 * the sidecar count equals sortedAll.length.
 *
 * Run: node tests/cap-disclosure.smoke.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

// Isolate configstore before importing anything that touches it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-capdisc-'));
process.env.XDG_CONFIG_HOME = tmpHome;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NARRATOR = path.join(__dirname, '..', 'src', 'core', 'agent', 'narrator.js');
const src = fs.readFileSync(NARRATOR, 'utf8');

const { splitFindingsAtCap, rewriteCapDisclosure } = await import('../src/core/agent/narrator.js');
const { verifyFindings, survivedVerification }     = await import('../src/core/verifier.js');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  OK  ${label}`); }
  catch (e) { failures++; console.error(`  FAIL  ${label}\n        ${e.message}`); }
};

// ── Reconstruct the two coupled pieces from live source ─────────────────────
// Evaluating them out of the file means the test breaks if someone edits the
// sentence without editing the regex, which is the drift that shipped.
const bodyMatch = src.match(/function getCapDisclosure\(total, cap\) \{([\s\S]*?)\n\}/);
assert.ok(bodyMatch, 'could not locate getCapDisclosure in narrator.js');
// eslint-disable-next-line no-new-func
const getCapDisclosure = new Function('total', 'cap', bodyMatch[1]);

const regexMatch = src.match(/const presenceRegex = new RegExp\((.+?), 'i'\);/);
assert.ok(regexMatch, 'could not locate presenceRegex in narrator.js');

const CAP = 30;
const TOTAL = 71;
const disclosure = getCapDisclosure(TOTAL, CAP);

// eslint-disable-next-line no-new-func
const presenceRegex = new Function('expectedCount', `return new RegExp(${regexMatch[1]}, 'i');`)(TOTAL);

console.log('\n── Disclosure text ──');
console.log(`  ${disclosure}\n`);

console.log('── Coupling: disclosure vs presence regex ──');

check('presenceRegex matches the sentence getCapDisclosure emits', () => {
  assert.ok(
    presenceRegex.test('# Report\n\n' + disclosure + '\n\n## Findings'),
    `regex ${presenceRegex} does not match the emitted disclosure. ` +
    'getCapDisclosure() and presenceRegex have drifted; every capped report ' +
    'will now ship the disclosure line twice.'
  );
});

check('presenceRegex does NOT match a report that omitted the disclosure', () => {
  assert.ok(
    !presenceRegex.test('# Report\n\n## Findings\n\nSome prose about 71 things.'),
    'regex matches a report with no disclosure, so a genuinely missing ' +
    'disclosure would never be spliced in.'
  );
});

console.log('\n── Disclosure content ──');

check('disclosure names the findings JSON sidecar', () => {
  assert.ok(/findings\.json/i.test(disclosure),
    'the disclosure must tell the reader where the undetailed findings live');
});

check('disclosure states the cap, the true total, and the remainder', () => {
  assert.ok(disclosure.includes(String(CAP)),         'cap missing');
  assert.ok(disclosure.includes(String(TOTAL)),       'total missing');
  assert.ok(disclosure.includes(String(TOTAL - CAP)), 'undetailed remainder missing');
});

check('no disclosure when the finding count is at or under the cap', () => {
  assert.strictEqual(getCapDisclosure(CAP, CAP), null);
  assert.strictEqual(getCapDisclosure(1, CAP), null);
});

check('no disclosure for non-finite input', () => {
  assert.strictEqual(getCapDisclosure(NaN, CAP), null);
  assert.strictEqual(getCapDisclosure(TOTAL, undefined), null);
});

check('disclosure contains no em dash', () => {
  assert.ok(!disclosure.includes('—'), 'em dash in customer-facing disclosure');
});

// ── The partition the narrator actually applies ─────────────────────────────
console.log('\n── splitFindingsAtCap partition ──');

const mkFinding = (i) => ({
  title:      `Finding number ${i}`,
  severity:   i < 5 ? 'CRITICAL' : i < 15 ? 'HIGH' : i < 30 ? 'MEDIUM' : 'LOW',
  detail:     `The module at src/mod${i}.js has a structural concern worth review. Estimated cost $${100 + i}0-$${200 + i}0.`,
  files:      [`src/mod${i}.js`],
  confidence: 90,
});

const rawFindings = Array.from({ length: TOTAL }, (_, i) => mkFinding(i));
const fileMap = Object.fromEntries(
  rawFindings.map((f, i) => [`src/mod${i}.js`, `export function mod${i}() { return ${i}; }\n`])
);

const { sortedAll, detailed, undetailed, cap } = splitFindingsAtCap(rawFindings);

check('cap matches the narrator constant used in the disclosure', () => {
  assert.strictEqual(cap, CAP);
});

check('sortedAll holds every raw finding', () => {
  assert.strictEqual(sortedAll.length, TOTAL);
});

check('detailed is exactly the cap', () => {
  assert.strictEqual(detailed.length, CAP);
});

check('detailed + undetailed partitions sortedAll with no overlap', () => {
  assert.strictEqual(detailed.length + undetailed.length, sortedAll.length);
  const dTitles = new Set(detailed.map(f => f.title));
  const oTitles = new Set(undetailed.map(f => f.title));
  const overlap = [...dTitles].filter(t => oTitles.has(t));
  assert.strictEqual(overlap.length, 0, `overlapping findings: ${overlap.join(', ')}`);
  assert.strictEqual(new Set([...dTitles, ...oTitles]).size, TOTAL);
});

check('an uncapped set leaves nothing undetailed', () => {
  const small = splitFindingsAtCap(rawFindings.slice(0, 10));
  assert.strictEqual(small.undetailed.length, 0);
  assert.strictEqual(small.detailed.length, 10);
});

// ── The invariant that matters: sidecar count == sortedAll.length ───────────
//
// The pipeline verifies the detailed set (via verifyReport, which reparses the
// rendered report) and the undetailed remainder (via verifyFindings directly),
// then writes every survivor. With a clean fileMap nothing is dropped, so the
// sidecar must carry the full uncapped set.
console.log('\n── Sidecar completeness on a capped run ──');

const { results: allResults } = await verifyFindings(sortedAll, fileMap, {});
const survivors = allResults.filter(survivedVerification);

check('nothing is dropped when every finding is grounded in source', () => {
  assert.strictEqual(survivors.length, sortedAll.length,
    `${sortedAll.length - survivors.length} finding(s) unexpectedly dropped`);
});

// Reproduce the pipeline's assembly: detailed survivors + undetailed survivors.
const { results: detailedResults }   = await verifyFindings(detailed,   fileMap, {});
const { results: undetailedResults } = await verifyFindings(undetailed, fileMap, {});
const sidecarFindings = [
  ...detailedResults.filter(survivedVerification).map(r => ({ ...r.finding, detailed: true })),
  ...undetailedResults.filter(survivedVerification).map(r => ({ ...r.finding, effortHours: null, detailed: false })),
];

check('SIDECAR COUNT MATCHES sortedAll.length ON A CAPPED RUN', () => {
  assert.strictEqual(sidecarFindings.length, sortedAll.length,
    `sidecar has ${sidecarFindings.length}, sortedAll has ${sortedAll.length}. ` +
    'The cap disclosure promises the reader every finding is in this file.');
});

check('the sidecar carries the undetailed findings, not just the narrated ones', () => {
  const undetailedInSidecar = sidecarFindings.filter(f => f.detailed === false);
  assert.strictEqual(undetailedInSidecar.length, TOTAL - CAP);
});

check('undetailed findings report no effort estimate rather than zero hours', () => {
  const u = sidecarFindings.find(f => f.detailed === false);
  assert.strictEqual(u.effortHours, null,
    '0 hours reads as "free to fix"; these were never estimated');
});

check('detailed findings are flagged as such', () => {
  assert.strictEqual(sidecarFindings.filter(f => f.detailed === true).length, CAP);
});

// ── The disclosure must state the number that is actually in the file ──────
console.log('\n── Disclosure agrees with the sidecar ──');

const rendered = `# Report\n\n${getCapDisclosure(sortedAll.length, cap)}\n\n## Findings\n`;
const finalReport = rewriteCapDisclosure(rendered, sidecarFindings.length, cap);

check('rewritten disclosure states the real sidecar count', () => {
  assert.ok(finalReport.includes(`All ${sidecarFindings.length} findings`),
    `report does not state the sidecar count (${sidecarFindings.length})`);
});

check('a report whose disclosure count disagrees with the sidecar is impossible', () => {
  // Simulate verification dropping 11 findings.
  const dropped = rewriteCapDisclosure(rendered, 60, cap);
  assert.ok(dropped.includes('All 60 findings'), 'rewrite did not restate the total');
  assert.ok(!dropped.includes('All 71 findings'), 'stale pre-verification count survived');
  assert.ok(dropped.includes('30 not detailed here'), 'remainder not recomputed');
});

check('disclosure is removed entirely when drops take the total under the cap', () => {
  const uncapped = rewriteCapDisclosure(rendered, 12, cap);
  assert.ok(!/This report details the top/.test(uncapped),
    'a report that is no longer capped must not carry a cap disclosure');
});

check('rewrite is a no-op on a report with no disclosure', () => {
  const plain = '# Report\n\n## Findings\n';
  assert.strictEqual(rewriteCapDisclosure(plain, 71, cap), plain);
});

check('a fully de-italicized disclosure still rewrites (Audit 8, quick win 6)', () => {
  // Pass 2 may strip the emphasis entirely. The old trailing anchor required
  // at least one closing */_, so this variant escaped the rewrite and the
  // stale count shipped.
  const unstyled =
    '# Report\n\n' +
    `This report details the top ${cap} findings by severity. ` +
    `All 71 findings, including the ${71 - cap} not detailed here, are listed in the accompanying .findings.json file.\n\n` +
    '## Findings\n';
  const rewritten = rewriteCapDisclosure(unstyled, 60, cap);
  assert.ok(rewritten.includes('All 60 findings'), 'unstyled disclosure was not rewritten');
  assert.ok(!rewritten.includes('All 71 findings'), 'stale count survived on the unstyled variant');
});

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}

if (failures > 0) {
  console.error(`\nFAILED — ${failures} assertion(s) failed.\n`);
  process.exit(1);
}
console.log('\nPASSED — all assertions ok\n');
