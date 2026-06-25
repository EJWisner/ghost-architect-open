/**
 * Smoke test for src/modes/watcher-batch.js — the Anthropic Message Batches
 * API helper that powers Ghost Watcher™'s Blast Radius and Conflict Detection
 * scans inside GitHub Actions.
 *
 * These tests use hand-rolled mock Anthropic and Octokit clients so nothing
 * touches the network. They lock in:
 *   - submitBatch shape + return value
 *   - pollBatch happy path, timeout, and all-failed paths
 *   - pending-batch persistence (store / retrieve / clear) against the portal repo
 *   - error class properties and messages
 *
 * Run: node tests/watcher-batch.smoke.mjs
 */

import {
  submitBatch,
  preflightBatchCheck,
  pollBatch,
  storePendingBatch,
  retrievePendingBatches,
  clearPendingBatch,
  BatchTimeoutError,
  BatchAllFailedError,
} from '../src/modes/watcher-batch.js';

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

// ── Mock builders ──────────────────────────────────────────────────────────────

// Mock Anthropic client. `retrieveSequence` is an array of MessageBatch-shaped
// objects returned by successive retrieve() calls; the last entry is reused once
// the sequence is exhausted. `resultsItems` is the array yielded by results().
function makeMockAnthropic({ retrieveSequence = [], resultsItems = [], onCreate } = {}) {
  let retrieveIdx = 0;
  const calls = { create: [], retrieve: [], results: [], cancel: [] };
  return {
    calls,
    messages: {
      batches: {
        async create(body) {
          calls.create.push(body);
          if (onCreate) return onCreate(body);
          return { id: 'msgbatch_mock_001', type: 'message_batch', processing_status: 'in_progress' };
        },
        async retrieve(batchId) {
          calls.retrieve.push(batchId);
          const item = retrieveSequence[Math.min(retrieveIdx, retrieveSequence.length - 1)];
          retrieveIdx++;
          return item;
        },
        async results(batchId) {
          calls.results.push(batchId);
          return resultsItems; // sync-iterable; for-await handles it
        },
        async cancel(batchId) {
          calls.cancel.push(batchId);
          return { id: batchId, type: 'message_batch', processing_status: 'canceling' };
        },
      },
    },
  };
}

const IN_PROGRESS = { processing_status: 'in_progress', request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 } };
const ENDED = (counts) => ({ processing_status: 'ended', request_counts: counts });

function succeededItem(customId, text) {
  return {
    custom_id: customId,
    result: {
      type: 'succeeded',
      message: { content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } },
    },
  };
}
function erroredItem(customId) {
  return { custom_id: customId, result: { type: 'errored', error: { type: 'error', message: 'boom' } } };
}

// Mock Octokit backed by an in-memory file store keyed by path. `present` seeds
// existing files. Records createOrUpdateFileContents calls in `.writes`.
function makeMockOctokit({ files = {} } = {}) {
  const store = { ...files };
  const writes = [];
  return {
    writes,
    store,
    rest: {
      repos: {
        async getContent({ path }) {
          if (!(path in store)) {
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
          const json = store[path];
          return {
            data: {
              content: Buffer.from(JSON.stringify(json)).toString('base64'),
              sha: 'sha-' + path,
            },
          };
        },
        async createOrUpdateFileContents({ path, content, message, sha }) {
          const decoded = JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
          store[path] = decoded;
          writes.push({ path, message, sha, json: decoded });
          return { data: { commit: { sha: 'newsha' } } };
        },
      },
    },
  };
}

const PENDING_PATH = 'projects/.ghost-watcher-pending.json';

// ── Tests ───────────────────────────────────────────────────────────────────────

async function run() {
  // 1) submitBatch
  console.log('\nTest 1: submitBatch calls create with correct shape and returns the batch id');
  {
    const mock = makeMockAnthropic({ onCreate: () => ({ id: 'msgbatch_abc' }) });
    const requests = [{ custom_id: 'blast-abcdef1-123', params: { model: 'claude-sonnet-4-6', max_tokens: 8096, system: 'sys', messages: [{ role: 'user', content: 'hi' }] } }];
    const id = await submitBatch(mock, requests);
    assert(id === 'msgbatch_abc', 'returns batch id', `got ${id}`);
    assert(mock.calls.create.length === 1, 'create called once');
    assert(Array.isArray(mock.calls.create[0]?.requests) && mock.calls.create[0].requests.length === 1, 'create called with { requests: [...] }');
    assert(mock.calls.create[0].requests[0].custom_id === 'blast-abcdef1-123', 'custom_id passed through');
  }

  // 2) pollBatch happy path
  console.log('\nTest 2: pollBatch polls until ended and returns succeeded text');
  {
    const mock = makeMockAnthropic({
      retrieveSequence: [IN_PROGRESS, IN_PROGRESS, ENDED({ processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 })],
      resultsItems: [succeededItem('blast-x', 'BLAST OUTPUT')],
    });
    const progress = [];
    const results = await pollBatch(mock, 'msgbatch_poll', {
      pollIntervalMs: 5, timeoutMs: 5000,
      onProgress: (p) => progress.push(p.status),
    });
    assert(mock.calls.retrieve.length === 3, 'retrieved 3 times (in_progress x2 then ended)', `got ${mock.calls.retrieve.length}`);
    assert(results.length === 1, 'one result item returned');
    assert(results[0].type === 'succeeded', 'result type succeeded');
    assert(results[0].text === 'BLAST OUTPUT', 'text extracted from message.content[0].text', `got ${results[0].text}`);
    assert(results[0].usage && results[0].usage.output_tokens === 50, 'usage carried through');
    assert(progress.length === 3 && progress[2] === 'ended', 'onProgress fired each poll, last status ended');
  }

  // 3) pollBatch timeout
  console.log('\nTest 3: pollBatch throws BatchTimeoutError when timeout exceeded');
  {
    const mock = makeMockAnthropic({ retrieveSequence: [IN_PROGRESS] });
    let thrown = null;
    try {
      await pollBatch(mock, 'msgbatch_timeout', { pollIntervalMs: 5, timeoutMs: 25 });
    } catch (err) { thrown = err; }
    assert(thrown instanceof BatchTimeoutError, 'BatchTimeoutError thrown', thrown ? thrown.constructor.name : 'no throw');
    assert(thrown && thrown.batchId === 'msgbatch_timeout', 'batchId property set on the error');
  }

  // 4) pollBatch all failed
  console.log('\nTest 4: pollBatch throws BatchAllFailedError when every result errored');
  {
    const counts = { processing: 0, succeeded: 0, errored: 2, canceled: 0, expired: 0 };
    const mock = makeMockAnthropic({
      retrieveSequence: [ENDED(counts)],
      resultsItems: [erroredItem('a'), erroredItem('b')],
    });
    let thrown = null;
    try {
      await pollBatch(mock, 'msgbatch_allfail', { pollIntervalMs: 5, timeoutMs: 5000 });
    } catch (err) { thrown = err; }
    assert(thrown instanceof BatchAllFailedError, 'BatchAllFailedError thrown', thrown ? thrown.constructor.name : 'no throw');
    assert(thrown && thrown.batchId === 'msgbatch_allfail', 'batchId property set');
    assert(thrown && thrown.counts && thrown.counts.errored === 2, 'counts carried on the error');
  }

  // 5) storePendingBatch
  console.log('\nTest 5: storePendingBatch creates the file and adds an entry keyed by batchId');
  {
    const octo = makeMockOctokit(); // no existing file → getContent 404 → create
    await storePendingBatch(octo, 'EJWisner/ghost-reports-portal-test', 'msgbatch_store', {
      type: 'blast', commitHash: 'abc123def456', repo: 'EJWisner/demo', repoOwner: 'EJWisner',
      timestamp: '2026-06-25T00:00:00.000Z', emailRecipients: ['ejwisner@gmail.com'],
      prNumber: 7, portalSlug: 'ejwisner', pollIntervalMs: 30000, timeoutMs: 5400000,
    });
    assert(octo.writes.length === 1, 'createOrUpdateFileContents called once');
    const write = octo.writes[0];
    assert(write.path === PENDING_PATH, 'wrote to projects/.ghost-watcher-pending.json', write.path);
    assert(write.json.batches && write.json.batches['msgbatch_store'], 'entry keyed by batchId present');
    assert(write.json.batches['msgbatch_store'].type === 'blast', 'entry carries metadata (type)');
    assert(write.json.batches['msgbatch_store'].batchId === 'msgbatch_store', 'entry carries batchId field');
  }

  // 6) retrievePendingBatches with an existing file
  console.log('\nTest 6: retrievePendingBatches returns the entries with all fields');
  {
    const existing = {
      batches: {
        msgbatch_r1: {
          batchId: 'msgbatch_r1', type: 'conflict', commitHash: 'deadbeef', repo: 'EJWisner/demo',
          repoOwner: 'EJWisner', timestamp: '2026-06-25T01:00:00.000Z', emailRecipients: ['a@b.com'],
          prNumber: 12, portalSlug: 'ejwisner', pollIntervalMs: 30000, timeoutMs: 5400000,
        },
      },
      consecutiveIncompleteRuns: 1,
      hasReceivedSetupWarning: false,
    };
    const octo = makeMockOctokit({ files: { [PENDING_PATH]: existing } });
    const arr = await retrievePendingBatches(octo, 'EJWisner/ghost-reports-portal-test');
    assert(Array.isArray(arr) && arr.length === 1, 'returns an array with one entry', `len ${arr.length}`);
    const b = arr[0];
    assert(b.batchId === 'msgbatch_r1', 'batchId field');
    assert(b.type === 'conflict', 'type field');
    assert(b.commitHash === 'deadbeef', 'commitHash field');
    assert(b.repo === 'EJWisner/demo', 'repo field');
    assert(b.repoOwner === 'EJWisner', 'repoOwner field');
    assert(b.prNumber === 12, 'prNumber field');
    assert(b.portalSlug === 'ejwisner', 'portalSlug field');
    assert(b.pollIntervalMs === 30000 && b.timeoutMs === 5400000, 'poll/timeout fields');
    assert(Array.isArray(b.emailRecipients) && b.emailRecipients[0] === 'a@b.com', 'emailRecipients field');
  }

  // 7) retrievePendingBatches with a 404
  console.log('\nTest 7: retrievePendingBatches returns [] when the file does not exist');
  {
    const octo = makeMockOctokit(); // no file
    const arr = await retrievePendingBatches(octo, 'EJWisner/ghost-reports-portal-test');
    assert(Array.isArray(arr) && arr.length === 0, 'returns empty array on 404', `got ${JSON.stringify(arr)}`);
  }

  // 8) clearPendingBatch
  console.log('\nTest 8: clearPendingBatch removes the entry and rewrites the file');
  {
    const existing = {
      batches: {
        keep_me:    { batchId: 'keep_me', type: 'blast' },
        remove_me:  { batchId: 'remove_me', type: 'conflict' },
      },
      consecutiveIncompleteRuns: 0,
      hasReceivedSetupWarning: false,
    };
    const octo = makeMockOctokit({ files: { [PENDING_PATH]: existing } });
    await clearPendingBatch(octo, 'EJWisner/ghost-reports-portal-test', 'remove_me');
    assert(octo.writes.length === 1, 'createOrUpdateFileContents called once');
    const written = octo.writes[0].json;
    assert(!written.batches.remove_me, 'removed entry is gone');
    assert(!!written.batches.keep_me, 'other entry preserved');
    assert(octo.writes[0].sha === 'sha-' + PENDING_PATH, 'conditional update passed the read sha');
  }

  // 9) BatchTimeoutError properties + message
  console.log('\nTest 9: BatchTimeoutError carries batchId / elapsedMinutes and a clear message');
  {
    const e = new BatchTimeoutError('msgbatch_zzz', 90);
    assert(e instanceof Error, 'is an Error');
    assert(e.batchId === 'msgbatch_zzz', 'batchId property');
    assert(e.elapsedMinutes === 90, 'elapsedMinutes property');
    assert(e.message.includes('msgbatch_zzz') && e.message.includes('90 minutes'), 'message names the batch id and elapsed minutes');
    assert(e.message.includes('next commit push'), 'message reassures about auto-retry');
  }

  // 10) BatchAllFailedError properties
  console.log('\nTest 10: BatchAllFailedError carries batchId / counts');
  {
    const counts = { succeeded: 0, errored: 3, expired: 0, canceled: 0, processing: 0 };
    const e = new BatchAllFailedError('msgbatch_fail', counts);
    assert(e instanceof Error, 'is an Error');
    assert(e.batchId === 'msgbatch_fail', 'batchId property');
    assert(e.counts && e.counts.errored === 3, 'counts property');
    assert(e.message.includes('msgbatch_fail'), 'message names the batch id');
  }

  // 11) submitBatch retries transient connection errors, fails fast on 4xx
  console.log('\nTest 11: submitBatch retries "Premature close" then succeeds, but fails fast on 4xx');
  {
    let n = 0;
    const flaky = { messages: { batches: { create: async () => { n++; if (n < 3) throw new Error('Premature close'); return { id: 'msgbatch_retry_ok' }; } } } };
    const id = await submitBatch(flaky, [{ custom_id: 'blast-x', params: { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] } }], { maxAttempts: 4, baseBackoffMs: 2 });
    assert(id === 'msgbatch_retry_ok' && n === 3, 'retried transient drops and returned the id', `id=${id} attempts=${n}`);

    let m = 0; let threw = false;
    const badreq = { messages: { batches: { create: async () => { m++; const e = new Error('invalid_request_error'); e.status = 400; throw e; } } } };
    try { await submitBatch(badreq, [{ custom_id: 'c', params: {} }], { maxAttempts: 4, baseBackoffMs: 2 }); } catch { threw = true; }
    assert(threw && m === 1, 'a 4xx fails fast without retrying', `threw=${threw} attempts=${m}`);
  }

  // 12) submitBatch gives up after maxAttempts on persistent transient errors
  console.log('\nTest 12: submitBatch throws after exhausting retries on persistent drops');
  {
    let n = 0; let caught = null;
    const dead = { messages: { batches: { create: async () => { n++; throw new Error('Premature close'); } } } };
    try { await submitBatch(dead, [{ custom_id: 'z', params: {} }], { maxAttempts: 3, baseBackoffMs: 2 }); } catch (e) { caught = e; }
    assert(caught instanceof Error && n === 3, 'attempted maxAttempts times then threw', `attempts=${n}`);
    assert(caught && caught.message.includes('after 3 attempts'), 'error message reports the attempt count', caught?.message);
  }

  // 13) preflightBatchCheck — reachable (ok) vs unreachable (transient fail)
  console.log('\nTest 13: preflightBatchCheck reports ok on a tiny submit, and a transient failure on a drop');
  {
    let created = null;
    const okClient = { messages: { batches: { create: async (b) => { created = b; return { id: 'msgbatch_pre' }; }, cancel: async () => {} } } };
    const r1 = await preflightBatchCheck(okClient, 'claude-sonnet-4-6');
    assert(r1.ok === true && r1.batchId === 'msgbatch_pre', 'ok:true with batchId when the tiny POST succeeds');
    assert(created?.requests?.[0]?.params?.max_tokens === 1, 'preflight body is a 1-token request');
    assert(/^[a-zA-Z0-9_-]{1,64}$/.test(created?.requests?.[0]?.custom_id), 'preflight custom_id is valid');

    const failClient = { messages: { batches: { create: async () => { throw new Error('Premature close'); } } } };
    const r2 = await preflightBatchCheck(failClient, 'claude-sonnet-4-6');
    assert(r2.ok === false && r2.transient === true, 'ok:false + transient:true on a connection drop', JSON.stringify(r2));
  }

  console.log('');
  if (failures === 0) {
    console.log('PASSED — all assertions ok\n');
    process.exit(0);
  } else {
    console.log('FAILED — ' + failures + ' assertion(s) failed\n');
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(1);
});
