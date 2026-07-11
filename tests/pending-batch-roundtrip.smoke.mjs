/**
 * Pending-batch field round-trip smoke test (Audit 10, session finding).
 *
 * retrievePendingBatches returns records through a field whitelist. Fields
 * that storePendingBatch call sites wrote but the whitelist did not map were
 * silently stripped on the way back: batchIds (Audit 7, finding 3.2) and
 * changedFiles (Audit 7, finding 3.8) were stored and never read, so
 * multi-chunk conflict resumes polled only chunk 1 and blast resumes always
 * narrated with an empty changed-file list. This test kills the class:
 *
 *   Test 1 stores a record carrying EVERY field any call site writes, reads
 *          it back through the real store/retrieve pipeline against a mock
 *          Octokit, and asserts each field survives with its value intact.
 *   Test 2 sweeps src/modes/watcher-commit.js for storePendingBatch call
 *          sites, extracts the metadata keys each one writes, and fails if
 *          any key is missing from the round-trip record below. Adding a new
 *          field at a store site without teaching the whitelist (and this
 *          test) about it is a test failure, not a silent drop.
 *
 * Run: node tests/pending-batch-roundtrip.smoke.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  storePendingBatch,
  retrievePendingBatches,
} from '../src/modes/watcher-batch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function ok(label) { console.log('  OK  ' + label); }
function bad(label, detail) {
  console.log('  !!  ' + label);
  if (detail) console.log('       ' + detail);
  failures++;
}
function assert(cond, label, detail) {
  if (cond) ok(label); else bad(label, detail);
}

// Mock Octokit backed by an in-memory file store keyed by path (same pattern
// as tests/watcher-batch.smoke.mjs).
function makeMockOctokit({ files = {} } = {}) {
  const store = { ...files };
  return {
    store,
    rest: {
      repos: {
        async getContent({ path: p }) {
          if (!(p in store)) {
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
          return {
            data: {
              content: Buffer.from(JSON.stringify(store[p])).toString('base64'),
              sha: 'sha-' + p,
            },
          };
        },
        async createOrUpdateFileContents({ path: p, content }) {
          store[p] = JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
          return { data: { commit: { sha: 'newsha' } } };
        },
      },
    },
  };
}

// ── The canonical record: every field any storePendingBatch call site writes ──
// batchId is added by storePendingBatch itself; everything else is metadata.
// Test 2 verifies this list stays complete against the source.
const CANONICAL = {
  type:            'conflict',
  commitHash:      'abc123def456abc123def456abc123def456abcd',
  repo:            'acme/storefront',
  repoOwner:       'acme',
  timestamp:       '2026-07-10T12:00:00.000Z',
  batchIds:        ['msgbatch_1', 'msgbatch_2', 'msgbatch_3'],
  changedFiles:    ['src/Checkout/Payment.php', 'src/Api/Order.php'],
  branch:          'feature/payment-refactor',
  developer:       'Dev Eloper',
  partial:         true,
  expectedScans:   { blast: true, conflict: true },
  emailRecipients: ['dev@example.com'],
  prNumber:        42,
  portalSlug:      'acme',
  pollIntervalMs:  10000,
  timeoutMs:       60000,
  findings:        [{ id: 'f1', title: 'Sample finding', severity: 'HIGH' }],
  severity:        { critical: 0, high: 1, medium: 0, low: 0 },
  findingCount:    1,
  developerEmail:  'dev@example.com',
  projectSlug:     'acme-storefront',
  version:         '11.0.2',
  tier:            'team',
  // Covered by Test 1 only: written by recordRegenAttempt, not at a
  // storePendingBatch call site, so Test 2's sweep never sees it.
  regenAttempts:   3,
};

console.log('\nTest 1: every stored field survives the store/retrieve round-trip');
{
  const octokit = makeMockOctokit();
  await storePendingBatch(octokit, 'acme/ghost-reports', 'msgbatch_1', CANONICAL);
  const records = await retrievePendingBatches(octokit, 'acme/ghost-reports');
  assert(records.length === 1, 'one record retrieved', `got ${records.length}`);
  const rec = records[0] || {};
  assert(rec.batchId === 'msgbatch_1', 'batchId survives');
  for (const [key, value] of Object.entries(CANONICAL)) {
    const got = rec[key];
    const same = JSON.stringify(got) === JSON.stringify(value);
    assert(same, `field "${key}" survives the round-trip`,
      `stored ${JSON.stringify(value)} but retrieved ${JSON.stringify(got)}`);
  }
}

console.log('\nTest 2: every key written at a storePendingBatch call site is covered above');
{
  // Scope note (Audit 11, quick win 7): this sweep covers watcher-commit.js,
  // the only file with storePendingBatch call sites today (verified by
  // repo-wide grep). A storePendingBatch call added in ANY OTHER file is NOT
  // guarded here and would need its own sweep entry; if you add one, extend
  // this test to read that file too.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'modes', 'watcher-commit.js'), 'utf8');

  // Extract the metadata object-literal keys at each call site.
  function extractStoreSiteKeys(src) {
    const sites = [];
    const re = /storePendingBatch\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const start = src.indexOf('{', m.index);
      if (start === -1) continue;
      let depth = 0, end = -1;
      for (let i = start; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) continue;
      let body = src.slice(start + 1, end);
      body = body.replace(/\/\/[^\n]*/g, '');                     // line comments
      while (/\{[^{}]*\}/.test(body)) {
        body = body.replace(/\{[^{}]*\}/g, 'NESTED');             // nested literals
      }
      const keys = new Set();
      for (const k of body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g)) keys.add(k[1]);
      // Shorthand properties (e.g. `branch,` or trailing `version, tier`):
      for (const k of body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=,|\s*$)/g)) keys.add(k[1]);
      sites.push([...keys]);
    }
    return sites;
  }

  const sites = extractStoreSiteKeys(source);
  assert(sites.length >= 4, 'found the four storePendingBatch call sites', `found ${sites.length}`);
  const covered = new Set(Object.keys(CANONICAL));
  for (let i = 0; i < sites.length; i++) {
    const missing = sites[i].filter(k => !covered.has(k) && k !== 'NESTED');
    assert(missing.length === 0,
      `call site ${i + 1} writes only round-trip-covered fields`,
      `uncovered field(s): ${missing.join(', ')} -- add to retrievePendingBatches AND this test`);
  }
}

if (failures > 0) {
  console.error(`\npending-batch-roundtrip.smoke: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nPASSED — all assertions ok');
