// src/utils/concurrency.js — bounded-concurrency helper.
//
// Run an array of async task thunks with at most `limit` in flight at a time,
// while PRESERVING input order: each task's promise is pushed into `results` in
// task order, and Promise.all(results) resolves them in that same order
// regardless of which finishes first. Use it to fan out per-item API calls
// (e.g. one Anthropic verifier call per finding) without opening dozens of
// simultaneous connections that rate-limit a low-tier key.

export async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    if (limit <= tasks.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}
