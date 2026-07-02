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

/**
 * Read the pending-batches array. Always returns an array (never throws);
 * a malformed/missing value resolves to [].
 */
export function getPendingBatches() {
  try {
    // @ghost-verified: split Configstore access with portal-publish.js is safe -- both use different keys (pendingBatches vs portalPublish), configstore writes atomically via write-file-atomic, and the two write paths (scan submission vs configuration) do not race in practice
    const raw = getConfig().get(KEY);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/**
 * Find a single pending batch by id, or null.
 */
export function findPendingBatch(id) {
  if (!id) return null;
  return getPendingBatches().find(b => b && b.id === id) || null;
}

// Central read-modify-write helper. Re-reads the list immediately before
// writing to minimise the cross-process lost-update window. fn receives the
// current list and returns the new list to persist.
function mutatePendingBatches(fn) {
  const current = getPendingBatches(); // fresh read
  const updated = fn(current);
  getConfig().set(KEY, updated);
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
