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
import { enrichFindingsWithPrompts } from '../src/modes/watcher-commit.js';

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

// watcher-batch.js talks to the Batches API over native global fetch (the SDK's
// create() drops with "Premature close" in CI). These helpers stub
// globalThis.fetch per-test and restore it afterward.
const ORIGINAL_FETCH = globalThis.fetch;
function setFetch(handler) { globalThis.fetch = handler; }
function restoreFetch() { globalThis.fetch = ORIGINAL_FETCH; }

// Minimal Response-like object. watcher-batch only reads res.ok / res.status /
// res.text(), so we don't need a full Response.
function mockResponse(status, bodyObjOrString) {
  const body = typeof bodyObjOrString === 'string' ? bodyObjOrString : JSON.stringify(bodyObjOrString);
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

// JSONL result lines (one MessageBatchIndividualResponse per line).
function succeededLine(customId, text) {
  return JSON.stringify({
    custom_id: customId,
    result: { type: 'succeeded', message: { content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } } },
  });
}
function erroredLine(customId) {
  return JSON.stringify({ custom_id: customId, result: { type: 'errored', error: { type: 'error', message: 'boom' } } });
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
  // 1) submitBatch — native-fetch POST shape + return + key resolution
  console.log('\nTest 1: submitBatch POSTs to /v1/messages/batches and returns the batch id');
  {
    let captured = null;
    setFetch(async (url, options) => { captured = { url, options }; return mockResponse(200, { id: 'msgbatch_abc', type: 'message_batch' }); });
    try {
      const requests = [{ custom_id: 'blast-abcdef1-123', params: { model: 'claude-sonnet-4-6', max_tokens: 8096, system: 'sys', messages: [{ role: 'user', content: 'hi' }] } }];
      const id = await submitBatch('sk-ant-test', requests);
      assert(id === 'msgbatch_abc', 'returns batch id', `got ${id}`);
      assert(captured?.url === 'https://api.anthropic.com/v1/messages/batches', 'POSTs to the batches endpoint', captured?.url);
      assert(captured?.options?.method === 'POST', 'method is POST');
      assert(captured?.options?.headers?.['x-api-key'] === 'sk-ant-test', 'x-api-key header set from the key');
      assert(captured?.options?.headers?.['anthropic-version'] === '2023-06-01', 'anthropic-version header set');
      const sentBody = JSON.parse(captured.options.body);
      assert(Array.isArray(sentBody.requests) && sentBody.requests.length === 1, 'body is { requests: [...] }');
      assert(sentBody.requests[0].custom_id === 'blast-abcdef1-123', 'custom_id passed through');
    } finally { restoreFetch(); }

    // also accepts an SDK client object and reads client.apiKey off it
    let capturedKey = null;
    setFetch(async (url, options) => { capturedKey = options.headers['x-api-key']; return mockResponse(200, { id: 'msgbatch_def' }); });
    try {
      const id2 = await submitBatch({ apiKey: 'sk-from-client' }, [{ custom_id: 'c', params: { model: 'm', max_tokens: 1, messages: [] } }]);
      assert(id2 === 'msgbatch_def' && capturedKey === 'sk-from-client', 'accepts SDK client object, reads client.apiKey');
    } finally { restoreFetch(); }
  }

  // 2) pollBatch happy path — status polling then JSONL results download
  console.log('\nTest 2: pollBatch polls status until ended and returns succeeded text from JSONL');
  {
    let nRetrieve = 0;
    setFetch(async (url) => {
      if (url === 'https://api.anthropic.com/v1/messages/batches/msgbatch_poll') {
        nRetrieve++;
        if (nRetrieve < 3) return mockResponse(200, { processing_status: 'in_progress', request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 } });
        return mockResponse(200, { processing_status: 'ended', request_counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 }, results_url: 'https://results.example/abc.jsonl' });
      }
      if (url === 'https://results.example/abc.jsonl') {
        return mockResponse(200, succeededLine('blast-x', 'BLAST OUTPUT') + '\n');
      }
      throw new Error('unexpected url ' + url);
    });
    try {
      const progress = [];
      const results = await pollBatch('sk-ant-test', 'msgbatch_poll', { pollIntervalMs: 5, timeoutMs: 5000, onProgress: (p) => progress.push(p.status) });
      assert(nRetrieve === 3, 'polled status 3 times (in_progress x2 then ended)', `got ${nRetrieve}`);
      assert(results.length === 1, 'one result item returned');
      assert(results[0].type === 'succeeded', 'result type succeeded');
      assert(results[0].text === 'BLAST OUTPUT', 'text extracted from JSONL message.content[0].text', `got ${results[0].text}`);
      assert(results[0].usage && results[0].usage.output_tokens === 50, 'usage carried through');
      assert(progress.length === 3 && progress[2] === 'ended', 'onProgress fired each poll, last status ended');
    } finally { restoreFetch(); }
  }

  // 3) pollBatch timeout
  console.log('\nTest 3: pollBatch throws BatchTimeoutError when timeout exceeded');
  {
    setFetch(async () => mockResponse(200, { processing_status: 'in_progress', request_counts: {} }));
    let thrown = null;
    try {
      await pollBatch('sk-ant-test', 'msgbatch_timeout', { pollIntervalMs: 5, timeoutMs: 25 });
    } catch (err) { thrown = err; } finally { restoreFetch(); }
    assert(thrown instanceof BatchTimeoutError, 'BatchTimeoutError thrown', thrown ? thrown.constructor.name : 'no throw');
    assert(thrown && thrown.batchId === 'msgbatch_timeout', 'batchId property set on the error');
  }

  // 4) pollBatch all failed
  console.log('\nTest 4: pollBatch throws BatchAllFailedError when every result errored');
  {
    setFetch(async (url) => {
      if (url.endsWith('/msgbatch_allfail')) return mockResponse(200, { processing_status: 'ended', request_counts: { processing: 0, succeeded: 0, errored: 2, canceled: 0, expired: 0 }, results_url: 'https://results.example/fail.jsonl' });
      if (url === 'https://results.example/fail.jsonl') return mockResponse(200, erroredLine('a') + '\n' + erroredLine('b') + '\n');
      throw new Error('unexpected url ' + url);
    });
    let thrown = null;
    try {
      await pollBatch('sk-ant-test', 'msgbatch_allfail', { pollIntervalMs: 5, timeoutMs: 5000 });
    } catch (err) { thrown = err; } finally { restoreFetch(); }
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
    setFetch(async () => { n++; if (n < 3) throw new Error('Premature close'); return mockResponse(200, { id: 'msgbatch_retry_ok' }); });
    let id;
    try {
      id = await submitBatch('sk-ant-test', [{ custom_id: 'blast-x', params: { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] } }], { maxAttempts: 4, baseBackoffMs: 2 });
    } finally { restoreFetch(); }
    assert(id === 'msgbatch_retry_ok' && n === 3, 'retried transient drops and returned the id', `id=${id} attempts=${n}`);

    let m = 0; let threw = false;
    setFetch(async () => { m++; return mockResponse(400, { type: 'error', error: { message: 'invalid_request_error' } }); });
    try { await submitBatch('sk-ant-test', [{ custom_id: 'c', params: {} }], { maxAttempts: 4, baseBackoffMs: 2 }); } catch { threw = true; } finally { restoreFetch(); }
    assert(threw && m === 1, 'a 4xx fails fast without retrying', `threw=${threw} attempts=${m}`);
  }

  // 12) submitBatch gives up after maxAttempts on persistent transient errors
  console.log('\nTest 12: submitBatch throws after exhausting retries on persistent drops');
  {
    let n = 0; let caught = null;
    setFetch(async () => { n++; throw new Error('Premature close'); });
    try { await submitBatch('sk-ant-test', [{ custom_id: 'z', params: {} }], { maxAttempts: 3, baseBackoffMs: 2 }); } catch (e) { caught = e; } finally { restoreFetch(); }
    assert(caught instanceof Error && n === 3, 'attempted maxAttempts times then threw', `attempts=${n}`);
    assert(caught && caught.message.includes('after 3 attempts'), 'error message reports the attempt count', caught?.message);
  }

  // 13) preflightBatchCheck — reachable (ok) vs unreachable (transient fail)
  console.log('\nTest 13: preflightBatchCheck reports ok on a tiny submit, and a transient failure on a drop');
  {
    let createdBody = null;
    setFetch(async (url, options) => {
      if (url.endsWith('/cancel')) return mockResponse(200, { id: 'msgbatch_pre', processing_status: 'canceling' });
      createdBody = JSON.parse(options.body);
      return mockResponse(200, { id: 'msgbatch_pre' });
    });
    let r1;
    try {
      r1 = await preflightBatchCheck('sk-ant-test', 'claude-sonnet-4-6');
      // let the fire-and-forget cancel run against the mock before restoring fetch
      await new Promise((res) => setTimeout(res, 10));
    } finally { restoreFetch(); }
    assert(r1.ok === true && r1.batchId === 'msgbatch_pre', 'ok:true with batchId when the tiny POST succeeds');
    assert(createdBody?.requests?.[0]?.params?.max_tokens === 1, 'preflight body is a 1-token request');
    assert(/^[a-zA-Z0-9_-]{1,64}$/.test(createdBody?.requests?.[0]?.custom_id), 'preflight custom_id is valid');

    setFetch(async () => { throw new Error('Premature close'); });
    let r2;
    try { r2 = await preflightBatchCheck('sk-ant-test', 'claude-sonnet-4-6'); } finally { restoreFetch(); }
    assert(r2.ok === false && r2.transient === true, 'ok:false + transient:true on a connection drop', JSON.stringify(r2));
  }

  // Normalized pollBatch result items (the shape enrichFindingsWithPrompts
  // consumes): { custom_id, type, text }. The detailed-prompts custom_id is
  // prompt-<commitSha>-<index>; enrich matches results back to findings by the
  // trailing index.
  const succeededResult = (index, text) => ({ custom_id: `prompt-abcdef1-${index}`, type: 'succeeded', text });

  // 14) enrichFindingsWithPrompts replaces matched prompts, leaves unmatched alone
  console.log('\nTest 14: enrichFindingsWithPrompts replaces matched prompts and leaves unmatched findings unchanged');
  {
    const findings = [
      { id: 'GB-001', prompt: 'orig-0' },
      { id: 'GB-002', prompt: 'orig-1' },
      { id: 'GB-003', prompt: 'orig-2' },
    ];
    // results for index 0 and 2 only; index 1 has no matching result
    const results = [succeededResult(0, 'NEW-0'), succeededResult(2, 'NEW-2')];
    const returned = enrichFindingsWithPrompts(findings, results);
    assert(returned === findings, 'returns the same findings array (mutated in place)');
    assert(findings[0].prompt === 'NEW-0', 'matched finding 0 prompt replaced', findings[0].prompt);
    assert(findings[1].prompt === 'orig-1', 'unmatched finding 1 prompt unchanged', findings[1].prompt);
    assert(findings[2].prompt === 'NEW-2', 'matched finding 2 prompt replaced', findings[2].prompt);
  }

  // 15) enrichFindingsWithPrompts only succeeded results replace prompts
  console.log('\nTest 15: enrichFindingsWithPrompts ignores errored/canceled/empty results, only succeeded replace prompts');
  {
    const findings = [
      { id: 'GB-001', prompt: 'orig-0' },
      { id: 'GB-002', prompt: 'orig-1' },
      { id: 'GB-003', prompt: 'orig-2' },
      { id: 'GB-004', prompt: 'orig-3' },
    ];
    const results = [
      { custom_id: 'prompt-abcdef1-0', type: 'errored',   text: null, error: { message: 'boom' } },
      { custom_id: 'prompt-abcdef1-1', type: 'canceled',  text: null },
      { custom_id: 'prompt-abcdef1-2', type: 'succeeded', text: '   ' }, // whitespace-only → skipped
      succeededResult(3, 'NEW-3'),
    ];
    enrichFindingsWithPrompts(findings, results);
    assert(findings[0].prompt === 'orig-0', 'errored result did not replace prompt', findings[0].prompt);
    assert(findings[1].prompt === 'orig-1', 'canceled result did not replace prompt', findings[1].prompt);
    assert(findings[2].prompt === 'orig-2', 'succeeded-but-empty result did not replace prompt', findings[2].prompt);
    assert(findings[3].prompt === 'NEW-3', 'succeeded result replaced prompt', findings[3].prompt);
  }

  // 16) enrichFindingsWithPrompts handles an empty results array without throwing
  console.log('\nTest 16: enrichFindingsWithPrompts handles an empty results array without throwing');
  {
    const findings = [
      { id: 'GB-001', prompt: 'orig-0' },
      { id: 'GB-002', prompt: 'orig-1' },
    ];
    let threw = null;
    let returned = null;
    try { returned = enrichFindingsWithPrompts(findings, []); } catch (err) { threw = err; }
    assert(threw === null, 'did not throw on empty results array', threw ? threw.message : '');
    assert(returned === findings, 'returns the findings array unchanged');
    assert(findings[0].prompt === 'orig-0' && findings[1].prompt === 'orig-1', 'no prompts changed with empty results');
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
