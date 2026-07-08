/**
 * Ghost Architect — Pending batch store (local configstore)
 *
 * Tracks batches the interactive CLI submitted via the transport menu, so the
 * user can come back later and run `ghost batch-status` / `ghost batch-retrieve
 * <id>`. This is the LOCAL, developer-machine counterpart to the Ghost Watcher's
 * pending-batch tracking — and deliberately separate from it:
 *
 *   - Ghost Watcher (src/modes/watcher-batch.js) persists pending batches in the
 *     portal GitHub repo via octokit, because it runs headless in CI with no
 *     local configstore to rely on.
 *   - This module persists in the local `ghost-architect` configstore (the same
 *     store that holds the API key and profile defaults), because the
 *     interactive CLI submitting a batch IS on a developer machine.
 *
 * Stored under the `pendingBatches` key as an array. Each entry:
 *   {
 *     id:          "batch_abc123",
 *     mode:        "blast-radius",
 *     repo:        "ghost-architect",
 *     label:       "Blast Radius — ghost-architect — Jun 26 2026 9:14am",
 *     submittedAt: "2026-06-26T09:14:00Z",
 *     status:      "pending",
 *     customId:    "blast-1750929240000",   // the batch request custom_id
 *     context:     { ... }                  // mode-specific replay data
 *   }
 *
 * `context` carries everything a later `batch-retrieve` needs to reproduce the
 * streaming output (target, project label, rates, profile, file counts, save
 * label, etc.) without re-loading the codebase. It is opaque to this store.
 */

import { getConfig } from '../config.js';

const KEY = 'pendingBatches';

// Normalize the persisted store to { version, batches }. Two on-disk shapes are
// accepted: the legacy bare-array form (treated as version 0) and the current
// { version, batches } object. The version counter is what mutatePendingBatches
// uses for optimistic locking across processes.
function readStore() {
  try {
    // @ghost-verified: split Configstore access with portal-publish.js is safe -- both use different keys (pendingBatches vs portalPublish), configstore writes atomically via write-file-atomic, and the two write paths (scan submission vs configuration) do not race in practice
    const raw = getConfig().get(KEY);
    if (Array.isArray(raw)) return { version: 0, batches: raw }; // legacy shape
    if (raw && Array.isArray(raw.batches)) {
      return {
        version: Number.isInteger(raw.version) ? raw.version : 0,
        batches: raw.batches,
      };
    }
    return { version: 0, batches: [] };
  } catch {
    return { version: 0, batches: [] };
  }
}

/**
 * Read the pending-batches array. Always returns an array (never throws);
 * a malformed/missing value resolves to [].
 */
export function getPendingBatches() {
  return readStore().batches;
}

/**
 * Find a single pending batch by id, or null.
 */
export function findPendingBatch(id) {
  if (!id) return null;
  return getPendingBatches().find(b => b && b.id === id) || null;
}

// Central read-modify-write helper with optimistic cross-process locking.
// Captures the store version before applying fn, re-reads immediately before
// writing, and retries the whole read-modify sequence if another process bumped
// the version in between. After MAX_RETRIES it warns and proceeds with
// last-write-wins so a genuinely contended store can never deadlock a run.
// fn receives the current batch list and returns the new list to persist.
function mutatePendingBatches(fn) {
  const MAX_RETRIES = 3;
  let updated = [];
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const before = readStore();          // capture version + batches
    updated = fn(before.batches);
    const current = readStore();         // re-read right before writing
    const changed = current.version !== before.version;
    if (changed && attempt < MAX_RETRIES) {
      // Another process wrote between our read and our write — retry against
      // the fresh state so we don't clobber its update.
      continue;
    }
    if (changed) {
      process.stderr.write(
        '[Ghost] batch-store: concurrent modification detected after ' +
        MAX_RETRIES + ' attempts; proceeding with last-write-wins.\n'
      );
    }
    // The checkpoint write is best-effort: if the configstore is unwritable
    // (read-only disk, permissions, quota) the batch itself has still been
    // submitted to the API and processing must continue. We surface the loss of
    // resume capability but never throw — a failed checkpoint degrades the
    // resume feature, it does not fail the run.
    try {
      getConfig().set(KEY, { version: current.version + 1, batches: updated });
    } catch (err) {
      process.stderr.write(
        '[Ghost] batch-store: checkpoint write failed: ' +
        (err && err.stack ? err.stack : (err && err.message ? err.message : String(err))) + '\n'
      );
      console.warn(
        '[Ghost] Batch checkpoint write failed: ' +
        (err && err.message ? err.message : String(err)) + '. Resume capability degraded.'
      );
    }
    return updated;
  }
  return updated;
}

/**
 * Append a pending batch. If an entry with the same id already exists it is
 * replaced (last-write-wins) so a re-submit can't duplicate.
 */
export function addPendingBatch(entry) {
  if (!entry || !entry.id) {
    throw new Error('batch-store: addPendingBatch requires an entry with an id.');
  }
  mutatePendingBatches(list => [...list.filter(b => b && b.id !== entry.id), entry]);
  return entry;
}

/**
 * Patch fields on a pending batch (e.g. status). No-op if the id is unknown.
 * Returns the updated entry or null.
 */
export function updatePendingBatch(id, patch = {}) {
  if (!id) return null;
  let updated = null;
  mutatePendingBatches(list => {
    const idx = list.findIndex(b => b && b.id === id);
    if (idx === -1) return list;
    const next = [...list];
    next[idx] = { ...next[idx], ...patch };
    updated = next[idx];
    return next;
  });
  return updated;
}

/**
 * Remove a pending batch by id. Idempotent.
 */
export function removePendingBatch(id) {
  if (!id) return;
  mutatePendingBatches(list => list.filter(b => b && b.id !== id));
}
