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
 * SDK surface used (verified against @anthropic-ai/sdk 0.39.0
 * resources/messages/batches.d.ts):
 *   client.messages.batches.create({ requests: [{ custom_id, params }] }) -> MessageBatch
 *   client.messages.batches.retrieve(batchId)  -> MessageBatch (has processing_status, request_counts)
 *   client.messages.batches.results(batchId)   -> Promise<JSONLDecoder<MessageBatchIndividualResponse>> (async-iterable)
 *   client.messages.batches.cancel(batchId)    -> MessageBatch
 *
 * processing_status is one of 'in_progress' | 'canceling' | 'ended'.
 * Each result item: { custom_id, result: { type, message?, error? } } where
 * type is 'succeeded' | 'errored' | 'canceled' | 'expired'.
 */

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

// ── Public: submission / polling / cancel ──────────────────────────────────────

/**
 * Submit an array of requests to the Batches API.
 * Each request: { custom_id, params: { model, max_tokens, system, messages } }.
 * custom_id must match ^[a-zA-Z0-9_-]{1,64}$ (caller's responsibility to build).
 *
 * @returns {Promise<string>} the batch id
 * @throws if submission fails
 */
export async function submitBatch(anthropic, requests) {
  let batch;
  try {
    batch = await anthropic.messages.batches.create({ requests });
  } catch (err) {
    throw new Error(`Ghost Watcher™ batch submission failed — ${err.message}`);
  }
  const batchId = batch?.id;
  if (!batchId) {
    throw new Error('Ghost Watcher™ batch submission failed — Batches API returned no batch id.');
  }
  console.log(`Ghost Watcher: batch submitted — ${batchId}`);
  return batchId;
}

/**
 * Poll a batch until it ends, then collect and return its results.
 *
 * @param {object} anthropic  Anthropic SDK client
 * @param {string} batchId
 * @param {object} opts
 * @param {number} [opts.pollIntervalMs=30000]
 * @param {number} [opts.timeoutMs=5400000]  90 minutes — matches the workflow timeout
 * @param {function} [opts.onProgress]        called as ({ status, counts, elapsedMs }) each poll
 * @returns {Promise<Array<{custom_id, type, text, usage, error}>>}
 * @throws {BatchTimeoutError}    if timeoutMs is exceeded before the batch ends
 * @throws {BatchAllFailedError}  if the batch ends but every result errored/expired/canceled
 */
export async function pollBatch(anthropic, batchId, opts = {}) {
  const { pollIntervalMs = 30000, timeoutMs = 5400000, onProgress } = opts;
  const start = Date.now();

  for (;;) {
    const batch = await anthropic.messages.batches.retrieve(batchId);
    const elapsedMs = Date.now() - start;
    const status = batch?.processing_status;
    const counts = batch?.request_counts || {};

    if (typeof onProgress === 'function') {
      try { onProgress({ status, counts, elapsedMs }); } catch { /* progress must never break polling */ }
    }
    console.log(`Ghost Watcher: batch ${batchId} — ${status} (${Math.round(elapsedMs / 1000)}s elapsed)`);

    if (status === 'ended') {
      const results = [];
      const decoder = await anthropic.messages.batches.results(batchId);
      for await (const item of decoder) {
        results.push(normalizeResultItem(item));
      }
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
 * Cancel a batch. Best effort — swallows all errors.
 */
export async function cancelBatch(anthropic, batchId) {
  try {
    await anthropic.messages.batches.cancel(batchId);
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
    await writePendingFile(octokit, owner, repo, data, sha, `ghost: store pending batch ${batchId}`);
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
