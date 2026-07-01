/**
 * Ghost Watcher™ — Anthropic Message Batches API helper
 *
 * Ghost Watcher runs headless inside GitHub Actions. On large codebases (~150K
 * tokens) the streaming Messages API drops with "Premature close" because the
 * ephemeral runner's network connection cannot hold open for the full response.
 * Non-streaming create() fails the same way at that size.
 *
 * The Message Batches API sidesteps this entirely: requests are submitted and
 * processed asynchronously server-side with no long-lived connection to
 * maintain. We submit a batch, then poll a short status endpoint until it ends
 * (most batches finish in well under an hour; results are stored for 29 days).
 * If the GitHub Actions job hits its wall-clock limit before the batch ends, the
 * batch keeps processing on Anthropic's servers and the NEXT commit push resumes
 * it (see retrievePendingBatches / storePendingBatch).
 *
 * Transport note: we talk to the Batches API directly over native fetch, NOT
 * through the @anthropic-ai/sdk client. The SDK's batches.create() reliably
 * drops with "Premature close" on GitHub Actions runners, while a plain
 * native-fetch POST to the same /v1/messages/batches endpoint succeeds with the
 * identical body and headers. So all four operations below are native-fetch
 * calls. For convenience the public functions still accept the SDK client object
 * as their first argument and pull the key off it (client.apiKey); a bare API
 * key string works too.
 *
 * HTTP surface (api.anthropic.com, anthropic-version: 2023-06-01 — the Batches
 * API is GA at SDK 0.39.0, so no anthropic-beta header is needed):
 *   POST /v1/messages/batches                 { requests: [{ custom_id, params }] } -> MessageBatch
 *   GET  /v1/messages/batches/{id}            -> MessageBatch (processing_status, request_counts, results_url)
 *   GET  {results_url}                        -> JSONL of MessageBatchIndividualResponse
 *   POST /v1/messages/batches/{id}/cancel     -> MessageBatch
 *
 * processing_status is one of 'in_progress' | 'canceling' | 'ended'.
 * Each result item: { custom_id, result: { type, message?, error? } } where
 * type is 'succeeded' | 'errored' | 'canceled' | 'expired'.
 */

import { getSamplingParams } from '../utils/sampling-params.js';

// ── Pending-batch state file (in the portal repo) ──────────────────────────────
//
// The portal repo holds a single JSON file tracking incomplete batches plus the
// consecutive-incomplete-run counter that drives the one-time setup warning email.
// Shape:
//   {
//     "batches": { "<batchId>": { batchId, type, commitHash, ... } },
//     "consecutiveIncompleteRuns": <number>,
//     "hasReceivedSetupWarning": <bool>
//   }
const PENDING_FILE = 'projects/.ghost-watcher-pending.json';

// ── Errors ─────────────────────────────────────────────────────────────────────

export class BatchTimeoutError extends Error {
  constructor(batchId, elapsedMinutes) {
    super(
      `Ghost Watcher™ batch timed out after ${elapsedMinutes} minutes. ` +
      `Batch ID: ${batchId}. Results will be retrieved automatically on the next commit push.`
    );
    this.name = 'BatchTimeoutError';
    this.batchId = batchId;
    this.elapsedMinutes = elapsedMinutes;
  }
}

export class BatchAllFailedError extends Error {
  constructor(batchId, counts) {
    super(`Ghost Watcher™ batch ${batchId} completed but all requests failed or expired.`);
    this.name = 'BatchAllFailedError';
    this.batchId = batchId;
    this.counts = counts;
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitRepo(portalRepo) {
  const [owner, repo] = String(portalRepo || '').split('/');
  return { owner, repo };
}

function defaultPendingState() {
  return { batches: {}, consecutiveIncompleteRuns: 0, hasReceivedSetupWarning: false };
}

function normalizePendingShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return defaultPendingState();
  return {
    batches: (parsed.batches && typeof parsed.batches === 'object') ? parsed.batches : {},
    consecutiveIncompleteRuns: Number.isFinite(parsed.consecutiveIncompleteRuns) ? parsed.consecutiveIncompleteRuns : 0,
    hasReceivedSetupWarning: parsed.hasReceivedSetupWarning === true,
  };
}

// Read the pending-state file from the portal repo. Returns the parsed state and
// its blob sha (needed for a conditional write). On any failure — file missing
// (404), unreadable, or malformed JSON — returns a fresh default state with a
// null sha so callers create the file.
async function readPendingFile(octokit, owner, repo) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: PENDING_FILE });
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { data: normalizePendingShape(parsed), sha: data.sha };
  } catch {
    return { data: defaultPendingState(), sha: null };
  }
}

async function writePendingFile(octokit, owner, repo, data, sha, message) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo,
    path: PENDING_FILE,
    message,
    content,
    ...(sha ? { sha } : {}),
  });
}

// Convert one MessageBatchIndividualResponse into the flat shape callers expect.
function normalizeResultItem(item) {
  const result = item?.result || {};
  const type = result.type; // 'succeeded' | 'errored' | 'canceled' | 'expired'
  let text = null;
  let usage = null;
  let error = null;
  if (type === 'succeeded') {
    const msg = result.message;
    text = msg?.content?.[0]?.text ?? '';
    usage = msg?.usage || null;
  } else if (type === 'errored') {
    error = result.error || null;
  }
  return { custom_id: item?.custom_id, type, text, usage, error };
}

// ── HTTP transport (native fetch) ──────────────────────────────────────────────
//
// The SDK's batches.create() drops with "Premature close" on GitHub Actions
// runners; a native-fetch POST to the same endpoint succeeds. So every Batches
// operation here is a direct native-fetch call. Public functions accept either
// the SDK client (we read client.apiKey) or a bare key string.

const ANTHROPIC_BASE    = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

// Per-request timeouts (ms). Submit gets a generous window for the large context
// upload; status/cancel are fast; results may be a sizeable JSONL download.
const SUBMIT_TIMEOUT_MS  = 120000;
const STATUS_TIMEOUT_MS  = 30000;
const RESULTS_TIMEOUT_MS  = 120000;

// Accept either an SDK client object (pull .apiKey off it) or a bare key string.
// Falls back to the ANTHROPIC_API_KEY env var.
function resolveKey(clientOrKey) {
  if (typeof clientOrKey === 'string') return clientOrKey;
  if (clientOrKey && typeof clientOrKey === 'object') {
    return clientOrKey.apiKey || clientOrKey.api_key || process.env.ANTHROPIC_API_KEY || null;
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

function batchHeaders(apiKey) {
  return {
    'x-api-key':         apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type':      'application/json',
  };
}

// One native-fetch round trip with an AbortController timeout. Returns the raw
// Response. Network-level failures (premature close, ECONNRESET, DNS, abort)
// reject here; HTTP error statuses (4xx/5xx) resolve and are checked by callers.
async function anthropicFetch(apiKey, pathOrUrl, { method = 'GET', body, timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  if (!apiKey) throw new Error('No Anthropic API key available for Batches request.');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${ANTHROPIC_BASE}${pathOrUrl}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers: batchHeaders(apiKey),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Read a Response body, throwing a status-bearing Error on non-2xx so callers can
// distinguish deterministic 4xx from retryable 5xx/connection failures.
async function readJsonOrThrow(res) {
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Batches API HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Batches API returned non-JSON body: ${text.slice(0, 200)}`);
  }
}

async function createBatchHttp(apiKey, requests, timeoutMs = SUBMIT_TIMEOUT_MS) {
  const res = await anthropicFetch(apiKey, '/v1/messages/batches', { method: 'POST', body: { requests }, timeoutMs });
  return readJsonOrThrow(res);
}

async function retrieveBatchHttp(apiKey, batchId, timeoutMs = STATUS_TIMEOUT_MS) {
  const res = await anthropicFetch(apiKey, `/v1/messages/batches/${encodeURIComponent(batchId)}`, { method: 'GET', timeoutMs });
  return readJsonOrThrow(res);
}

async function cancelBatchHttp(apiKey, batchId, timeoutMs = STATUS_TIMEOUT_MS) {
  const res = await anthropicFetch(apiKey, `/v1/messages/batches/${encodeURIComponent(batchId)}/cancel`, { method: 'POST', timeoutMs });
  await res.text().catch(() => {});
  return res;
}

// Fetch and parse the JSONL results file from a batch's results_url. Each
// non-empty line is one MessageBatchIndividualResponse.
async function fetchBatchResultsHttp(apiKey, resultsUrl, timeoutMs = RESULTS_TIMEOUT_MS) {
  const res = await anthropicFetch(apiKey, resultsUrl, { method: 'GET', timeoutMs });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Batches results HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const items = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { items.push(JSON.parse(trimmed)); } catch { /* skip a malformed JSONL line */ }
  }
  return items;
}

// ── Public: submission / polling / cancel ──────────────────────────────────────

// Classify an error as a transient network/connection failure (worth retrying)
// vs a deterministic API rejection. "Premature close" / ECONNRESET / socket hang
// up / fetch failed / abort are the connection drops seen on GitHub Actions
// runners. 5xx and 429 are retryable server-side conditions; other 4xx are
// deterministic and must not be retried.
function isTransientNetworkError(err) {
  const name = err?.name || '';
  if (name === 'AbortError') return true; // AbortController timeout
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;
  const status = err?.status;
  if (typeof status === 'number') {
    if (status === 429 || status >= 500) return true; // rate limit / server error → retry
    if (status >= 400) return false;                  // other 4xx → deterministic
  }
  const msg = (err?.message || '').toLowerCase();
  return (
    msg.includes('premature close') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('eai_again') ||
    msg.includes('enotfound') ||
    msg.includes('network') ||
    msg.includes('connection error') ||
    msg.includes('terminated') ||
    msg.includes('aborted') ||
    msg.includes('fetch failed')
  );
}

/**
 * Cheap reachability probe for the Batches POST path. Submits a minimal 1-token
 * batch (native fetch) BEFORE we attempt to upload the full ~600KB codebase
 * context, so we can tell a network/auth failure (tiny POST also fails) apart
 * from a payload-size failure (tiny POST succeeds, full POST drops). Never throws.
 *
 * @param {object|string} clientOrKey  SDK client or bare API key
 * @returns {Promise<{ok: boolean, batchId?: string, error?: string, transient?: boolean}>}
 */
export async function preflightBatchCheck(clientOrKey, model) {
  const apiKey = resolveKey(clientOrKey);
  const requests = [{
    custom_id: `preflight-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64),
    params: {
      model: model || 'claude-sonnet-4-6',
      max_tokens: 1,
      ...getSamplingParams(0, model || 'claude-sonnet-4-6'),
      messages: [{ role: 'user', content: 'ping' }],
    },
  }];
  try {
    const batch = await createBatchHttp(apiKey, requests, STATUS_TIMEOUT_MS);
    const batchId = batch?.id;
    if (!batchId) return { ok: false, error: 'Batches API returned no batch id for preflight.' };
    // Best-effort cleanup — don't leave a stray tiny batch behind. Don't await.
    Promise.resolve(cancelBatch(clientOrKey, batchId)).catch(() => {});
    return { ok: true, batchId };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), transient: isTransientNetworkError(err) };
  }
}

/**
 * Submit an array of requests to the Batches API over native fetch, with
 * retry-and-backoff on transient connection failures (the "Premature close" /
 * ECONNRESET drops seen on CI runners). Deterministic 4xx rejections fail fast.
 *
 * Each request: { custom_id, params: { model, max_tokens, system, messages } }.
 * custom_id must match ^[a-zA-Z0-9_-]{1,64}$ (caller's responsibility to build).
 *
 * @param {object|string} clientOrKey  SDK client or bare API key
 * @param {Array}  requests
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=4]
 * @param {number} [opts.baseBackoffMs=2000]      attempt N waits baseBackoffMs * 2^(N-1)
 * @param {number} [opts.requestTimeoutMs=120000]
 * @returns {Promise<string>} the batch id
 * @throws if submission ultimately fails
 */
export async function submitBatch(clientOrKey, requests, opts = {}) {
  const { maxAttempts = 4, baseBackoffMs = 2000, requestTimeoutMs = SUBMIT_TIMEOUT_MS } = opts;
  const apiKey = resolveKey(clientOrKey);

  // Report the on-the-wire body size. A large POST body is a known trigger for
  // mid-upload connection drops on constrained CI networks; logging it gives us
  // the real number from each run instead of an estimate.
  let bodyBytes = 0;
  try { bodyBytes = Buffer.byteLength(JSON.stringify({ requests }), 'utf8'); } catch { /* size logging is best-effort */ }
  if (bodyBytes) {
    const mb = (bodyBytes / 1024 / 1024).toFixed(2);
    console.log(`Ghost Watcher: submitting batch — request body ${bodyBytes.toLocaleString()} bytes (${mb} MB)`);
    if (bodyBytes > 1024 * 1024) {
      console.warn(`Ghost Watcher: batch request body exceeds 1 MB (${mb} MB) — large POST bodies can drop mid-upload on CI networks.`);
    }
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const batch = await createBatchHttp(apiKey, requests, requestTimeoutMs);
      const batchId = batch?.id;
      if (!batchId) throw new Error('Batches API returned no batch id.');
      console.log(`Ghost Watcher: batch submitted — ${batchId}`);
      return batchId;
    } catch (err) {
      lastErr = err;
      const transient = isTransientNetworkError(err);
      if (!transient || attempt === maxAttempts) {
        throw new Error(
          `Ghost Watcher™ batch submission failed` +
          `${transient ? ` after ${attempt} attempt${attempt === 1 ? '' : 's'}` : ''} — ${err?.message || String(err)}`
        );
      }
      const backoff = baseBackoffMs * Math.pow(2, attempt - 1);
      console.warn(`Ghost Watcher: batch submission attempt ${attempt}/${maxAttempts} failed (${err?.message || err}); retrying in ${Math.round(backoff / 1000)}s...`);
      await sleep(backoff);
    }
  }
  throw new Error(`Ghost Watcher™ batch submission failed — ${lastErr?.message || 'unknown error'}`);
}

/**
 * Poll a batch until it ends (native fetch), then download and parse its JSONL
 * results. Transient status-check failures are tolerated (logged and retried on
 * the next interval) so an occasional connection blip does not abort a long poll.
 *
 * @param {object|string} clientOrKey  SDK client or bare API key
 * @param {string} batchId
 * @param {object} opts
 * @param {number} [opts.pollIntervalMs=30000]
 * @param {number} [opts.timeoutMs=5400000]  90 minutes — matches the workflow timeout
 * @param {function} [opts.onProgress]        called as ({ status, counts, elapsedMs }) each poll
 * @returns {Promise<Array<{custom_id, type, text, usage, error}>>}
 * @throws {BatchTimeoutError}    if timeoutMs is exceeded before the batch ends
 * @throws {BatchAllFailedError}  if the batch ends but every result errored/expired/canceled
 */
export async function pollBatch(clientOrKey, batchId, opts = {}) {
  const { pollIntervalMs = 30000, timeoutMs = 5400000, onProgress } = opts;
  const apiKey = resolveKey(clientOrKey);
  const start = Date.now();

  for (;;) {
    let batch;
    try {
      batch = await retrieveBatchHttp(apiKey, batchId);
    } catch (err) {
      if (Date.now() - start >= timeoutMs) {
        throw new BatchTimeoutError(batchId, Math.round((Date.now() - start) / 60000));
      }
      if (isTransientNetworkError(err)) {
        console.warn(`Ghost Watcher: batch ${batchId} status check failed transiently (${err?.message || err}); retrying next interval`);
        await sleep(pollIntervalMs);
        continue;
      }
      throw err; // deterministic (e.g. 404 batch not found)
    }

    const elapsedMs = Date.now() - start;
    const status = batch?.processing_status;
    const counts = batch?.request_counts || {};

    if (typeof onProgress === 'function') {
      try { onProgress({ status, counts, elapsedMs }); } catch { /* progress must never break polling */ }
    }
    console.log(`Ghost Watcher: batch ${batchId} — ${status} (${Math.round(elapsedMs / 1000)}s elapsed)`);

    if (status === 'ended') {
      if (!batch.results_url) {
        throw new Error(`Batches API: batch ${batchId} ended but returned no results_url.`);
      }
      // Download the JSONL results, tolerating a couple of transient blips.
      let rawItems = null;
      for (let rAttempt = 1; ; rAttempt++) {
        try {
          rawItems = await fetchBatchResultsHttp(apiKey, batch.results_url);
          break;
        } catch (err) {
          if (!isTransientNetworkError(err) || rAttempt >= 3) throw err;
          console.warn(`Ghost Watcher: batch ${batchId} results download attempt ${rAttempt} failed transiently (${err?.message || err}); retrying...`);
          await sleep(2000 * rAttempt);
        }
      }
      const results = rawItems.map(normalizeResultItem);
      const succeeded = results.filter(r => r.type === 'succeeded').length;
      if (results.length > 0 && succeeded === 0) {
        throw new BatchAllFailedError(batchId, counts);
      }
      return results;
    }

    if (Date.now() - start >= timeoutMs) {
      throw new BatchTimeoutError(batchId, Math.round((Date.now() - start) / 60000));
    }

    await sleep(pollIntervalMs);
  }
}

/**
 * Cancel a batch (native fetch). Best effort — swallows all errors.
 *
 * @param {object|string} clientOrKey  SDK client or bare API key
 */
export async function cancelBatch(clientOrKey, batchId) {
  try {
    const apiKey = resolveKey(clientOrKey);
    await cancelBatchHttp(apiKey, batchId);
    console.log(`Ghost Watcher: batch ${batchId} canceled`);
  } catch {
    /* best effort — a cancel failure must never surface */
  }
}

// ── Public: pending-batch persistence (in the portal repo) ─────────────────────

/**
 * Record a pending batch in the portal repo so a future run can resume it.
 * Never throws — logs a warning on failure.
 *
 * @param {object} octokit
 * @param {string} portalRepo  'owner/repo'
 * @param {string} batchId
 * @param {object} metadata    { type, commitHash, repo, repoOwner, timestamp,
 *                               emailRecipients, prNumber, portalSlug,
 *                               pollIntervalMs, timeoutMs }
 */
export async function storePendingBatch(octokit, portalRepo, batchId, metadata = {}) {
  try {
    if (!octokit || !portalRepo || !batchId) return;
    const { owner, repo } = splitRepo(portalRepo);
    const { data, sha } = await readPendingFile(octokit, owner, repo);
    data.batches[batchId] = { batchId, ...metadata };
    try {
      await writePendingFile(octokit, owner, repo, data, sha, `ghost: store pending batch ${batchId}`);
    } catch (err) {
      // SHA conflict: another concurrent run updated the pending file between
      // our read and write. Storing a batch is purely additive, so re-read the
      // current state, re-apply just our batch entry onto it (never clobbering
      // what the other run wrote), and retry once with the fresh SHA.
      const isShaMismatch = err?.status === 409 ||
        (typeof err?.message === 'string' && err.message.includes('does not match'));
      if (!isShaMismatch) throw err;
      const fresh = await readPendingFile(octokit, owner, repo);
      fresh.data.batches[batchId] = { batchId, ...metadata };
      await writePendingFile(octokit, owner, repo, fresh.data, fresh.sha, `ghost: store pending batch ${batchId} (retry)`);
    }
  } catch (err) {
    console.warn(`Ghost Watcher: storePendingBatch failed (non-fatal) — ${err.message}`);
  }
}

/**
 * Read all pending batches recorded in the portal repo.
 * Returns [] if the file does not exist, cannot be read, or is malformed.
 *
 * @returns {Promise<Array<object>>}
 */
export async function retrievePendingBatches(octokit, portalRepo) {
  try {
    if (!octokit || !portalRepo) return [];
    const { owner, repo } = splitRepo(portalRepo);
    const { data } = await readPendingFile(octokit, owner, repo);
    return Object.values(data.batches || {})
      .filter(b => b && b.batchId)
      .map(b => ({
        batchId:         b.batchId,
        type:            b.type,
        commitHash:      b.commitHash,
        repo:            b.repo,
        repoOwner:       b.repoOwner,
        timestamp:       b.timestamp,
        emailRecipients: Array.isArray(b.emailRecipients) ? b.emailRecipients : [],
        prNumber:        b.prNumber ?? null,
        portalSlug:      b.portalSlug ?? null,
        pollIntervalMs:  b.pollIntervalMs,
        timeoutMs:       b.timeoutMs,
        // Detailed-prompts (type 'prompts') resume payload:
        findings:        Array.isArray(b.findings) ? b.findings : undefined,
        severity:        b.severity ?? undefined,
        findingCount:    b.findingCount ?? undefined,
        developerEmail:  b.developerEmail ?? undefined,
        projectSlug:     b.projectSlug ?? undefined,
        version:         b.version ?? undefined,
        tier:            b.tier ?? undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Remove a pending batch entry from the portal repo. Never throws.
 */
export async function clearPendingBatch(octokit, portalRepo, batchId) {
  try {
    if (!octokit || !portalRepo || !batchId) return;
    const { owner, repo } = splitRepo(portalRepo);
    const { data, sha } = await readPendingFile(octokit, owner, repo);
    if (data.batches && Object.prototype.hasOwnProperty.call(data.batches, batchId)) {
      delete data.batches[batchId];
      await writePendingFile(octokit, owner, repo, data, sha, `ghost: clear pending batch ${batchId}`);
    }
  } catch (err) {
    console.warn(`Ghost Watcher: clearPendingBatch failed (non-fatal) — ${err.message}`);
  }
}

// ── Public: consecutive-incomplete-run counter ─────────────────────────────────
//
// Stored alongside the pending batches in the same file. Drives EMAIL 4 (the
// one-time "GitHub Actions minutes insufficient" warning). All never-throw.

/**
 * Return the full pending-state object: { batches, consecutiveIncompleteRuns,
 * hasReceivedSetupWarning }. Defaults on any read failure.
 */
export async function getPendingState(octokit, portalRepo) {
  try {
    if (!octokit || !portalRepo) return defaultPendingState();
    const { owner, repo } = splitRepo(portalRepo);
    const { data } = await readPendingFile(octokit, owner, repo);
    return data;
  } catch {
    return defaultPendingState();
  }
}

/**
 * Increment the consecutive-incomplete-run counter and return the new value.
 * Returns 0 on failure (so callers never trigger the warning on a write error).
 */
export async function incrementIncompleteRuns(octokit, portalRepo) {
  try {
    if (!octokit || !portalRepo) return 0;
    const { owner, repo } = splitRepo(portalRepo);
    const { data, sha } = await readPendingFile(octokit, owner, repo);
    data.consecutiveIncompleteRuns = (data.consecutiveIncompleteRuns || 0) + 1;
    await writePendingFile(octokit, owner, repo, data, sha,
      `ghost: incomplete run ${data.consecutiveIncompleteRuns}`);
    return data.consecutiveIncompleteRuns;
  } catch {
    return 0;
  }
}

/**
 * Reset the consecutive-incomplete-run counter to 0 (on any successful scan).
 * No-op when already 0. Never throws.
 */
export async function resetIncompleteRuns(octokit, portalRepo) {
  try {
    if (!octokit || !portalRepo) return;
    const { owner, repo } = splitRepo(portalRepo);
    const { data, sha } = await readPendingFile(octokit, owner, repo);
    if ((data.consecutiveIncompleteRuns || 0) !== 0) {
      data.consecutiveIncompleteRuns = 0;
      await writePendingFile(octokit, owner, repo, data, sha, 'ghost: reset incomplete run counter');
    }
  } catch {
    /* never throws */
  }
}

/**
 * Mark the one-time setup-warning email as sent so it never re-sends. Never throws.
 */
export async function markSetupWarningSent(octokit, portalRepo) {
  try {
    if (!octokit || !portalRepo) return;
    const { owner, repo } = splitRepo(portalRepo);
    const { data, sha } = await readPendingFile(octokit, owner, repo);
    data.hasReceivedSetupWarning = true;
    await writePendingFile(octokit, owner, repo, data, sha, 'ghost: setup warning sent');
  } catch {
    /* never throws */
  }
}
