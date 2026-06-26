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

/**
 * Append a pending batch. If an entry with the same id already exists it is
 * replaced (last-write-wins) so a re-submit can't duplicate.
 */
export function addPendingBatch(entry) {
  if (!entry || !entry.id) {
    throw new Error('batch-store: addPendingBatch requires an entry with an id.');
  }
  const list = getPendingBatches().filter(b => b && b.id !== entry.id);
  list.push(entry);
  getConfig().set(KEY, list);
  return entry;
}

/**
 * Patch fields on a pending batch (e.g. status). No-op if the id is unknown.
 * Returns the updated entry or null.
 */
export function updatePendingBatch(id, patch = {}) {
  if (!id) return null;
  const list = getPendingBatches();
  const idx = list.findIndex(b => b && b.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  getConfig().set(KEY, list);
  return list[idx];
}

/**
 * Remove a pending batch by id. Idempotent.
 */
export function removePendingBatch(id) {
  if (!id) return;
  const list = getPendingBatches().filter(b => b && b.id !== id);
  getConfig().set(KEY, list);
}
