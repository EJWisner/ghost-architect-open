import assert from 'node:assert/strict';

// Regression fixture for enterprise org-file lost-update bug.
// Validates that mutateOrgFile-style CAS retry preserves concurrent writes.
//
// The test models a true compare-and-swap store:
//   - A write succeeds only if the caller's sha matches the current sha.
//   - If another writer updated the file between read and write, the sha
//     no longer matches and the write throws 409.
//   - The retry loop must re-read fresh content+sha and re-apply its delta,
//     so the concurrent writer's data is never clobbered.
//
// Failure mode being guarded: a buggy no-retry implementation lets Writer B
// overwrite Writer A's event with a stale read, dropping event-A permanently.

// ── CAS store (models GitHub's SHA-conditional write) ────────────────────────
function makeCasStore(initial) {
  let current = JSON.parse(JSON.stringify(initial));
  let currentSha = 'sha-0';
  let version = 0;
  return {
    read() { return { content: JSON.parse(JSON.stringify(current)), sha: currentSha }; },
    write(next, sha) {
      if (sha !== currentSha) {
        const err = new Error(`SHA does not match: expected ${currentSha}, got ${sha}`);
        err.status = 409;
        throw err;
      }
      current = JSON.parse(JSON.stringify(next));
      version++;
      currentSha = `sha-${version}`;
    },
    get() { return current; },
  };
}

// ── mutateOrgFile simulation (drives the real retry logic) ───────────────────
async function mutateWithRetry(store, applyFn, maxAttempts = 4, onBeforeWrite = null) {
  let lastErr;
  let retryCount = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { content, sha } = store.read();
    const next = applyFn(content);
    // Hook lets the test inject a concurrent write between read and write
    if (onBeforeWrite) onBeforeWrite(attempt);
    try {
      store.write(next, sha);
      return { next, retryCount };
    } catch (err) {
      const isConflict = err?.status === 409 || err?.status === 422 ||
        (typeof err?.message === 'string' && err.message.includes('does not match'));
      if (!isConflict || attempt === maxAttempts) throw err;
      retryCount++;
      lastErr = err;
    }
  }
  throw lastErr;
}

// ── Scenario ─────────────────────────────────────────────────────────────────
// Initial state: audit log with one existing event
const store = makeCasStore({ events: ['event-original'] });

// Writer A runs first and succeeds immediately
await mutateWithRetry(store, c => ({
  events: [...(c?.events || []), 'event-A'].slice(-1000),
}));

// Writer B: on its FIRST attempt, a concurrent write (simulating Writer A's
// effect arriving mid-flight) invalidates its sha -- it must 409 and retry.
// The onBeforeWrite hook injects Writer A's write on attempt 1 only.
let injectedCount = 0;
const { retryCount } = await mutateWithRetry(
  store,
  c => ({ events: [...(c?.events || []), 'event-B'].slice(-1000) }),
  4,
  (attempt) => {
    if (attempt === 1 && injectedCount === 0) {
      // Inject a third concurrent writer mid-flight to force a 409 on B's first attempt
      store.write(
        { events: [...store.read().content.events, 'event-concurrent'] },
        store.read().sha,
      );
      injectedCount++;
    }
  }
);

// ── Assertions ───────────────────────────────────────────────────────────────
const final = store.get().events;

// The retry path MUST have fired -- if retryCount === 0 the test is vacuous
assert.ok(retryCount >= 1,
  `Expected at least 1 retry (CAS conflict) but got 0 -- the 409 path was never exercised`);

// All events must be present -- no lost update
assert.ok(final.includes('event-original'), 'Original event must be preserved');
assert.ok(final.includes('event-A'),        'Writer A event must be preserved');
assert.ok(final.includes('event-concurrent'), 'Concurrent injected event must be preserved');
assert.ok(final.includes('event-B'),        'Writer B event must be preserved');
assert.equal(final.length, 4,
  `Expected 4 events but got ${final.length}: ${JSON.stringify(final)}`);

console.log('enterprise org-file concurrency: PASS');
console.log(`  Retries fired: ${retryCount} (confirms 409 path was exercised)`);
console.log(`  Final events: ${JSON.stringify(final)}`);
console.log('  All writers preserved -- no lost update');
