/**
 * Smoke test for the license revocation check (checkRevocation).
 *
 * Background: a signed license token verifies offline forever. It proves we
 * minted it; it says nothing about whether the subscription behind it is still
 * alive. Stripe's customer.subscription.deleted webhook flips the KV record to
 * status='revoked', but until the /verify endpoint existed the CLI had no way
 * to ask, so a cancelled license kept working until its token's `expires` date
 * (up to a year). That was a silent revenue leak on the Team tier and worse on
 * the headless watcher, which runs unattended on every CI commit.
 *
 * The policy this test pins down is asymmetric, and the asymmetry is the whole
 * design:
 *
 *   - FAIL OPEN on every fault. Network down, timeout, 5xx, 404, malformed
 *     body: all return 'unknown' and the caller keeps working. Ghost Watcher is
 *     advisory and must never block a commit, and a worker outage must never
 *     break a paying customer's CI.
 *
 *   - STICKY on an explicit revoked verdict. Once the worker has said 'revoked'
 *     we persist it and honor it forever, network or no network. A cancelled
 *     customer cannot restore access by pulling the ethernet cable, because the
 *     verdict is already on their disk.
 *
 *   - Cache is keyed by licenseId, so one revoked license never poisons another
 *     on the same machine, and re-activation drops the cache entirely (a fresh
 *     key must not inherit the old key's verdict).
 *
 * Notably a 404 (license_not_found) must NOT read as revoked: an admin-issued
 * key missing from KV, or a KV read hiccup, would otherwise lock out a paying
 * customer.
 *
 * Isolation: XDG_CONFIG_HOME is redirected to a throwaway temp dir BEFORE any
 * Ghost module is imported, so this never touches the real configstore. The
 * worker is a local http server, so no real network calls are made.
 *
 * Run: node tests/license-revocation.smoke.mjs
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import http from 'http';
import assert from 'assert';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-revocation-'));
process.env.XDG_CONFIG_HOME = tmpHome;
delete process.env.GHOST_NO_LICENSE_VERIFY;
delete process.env.GHOST_LICENSE_VERIFY_FORCE;

// ── Fake license worker ────────────────────────────────────────────────────
let mode = 'activated';
const server = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    if (mode === 'down')      { res.destroy(); return; }
    if (mode === 'hang')      { return; }               // exercise the timeout
    if (mode === 'notfound')  { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"license_not_found"}'); return; }
    if (mode === 'ratelimit') { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":"rate_limited"}'); return; }
    if (mode === 'garbage')   { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('not json at all'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: mode }));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
process.env.GHOST_LICENSE_VERIFY_URL = `http://127.0.0.1:${server.address().port}/verify`;

const { getConfig }        = await import('../src/config.js');
const { checkRevocation }  = await import('../src/license/revocation.js');
const { getRevocationCache, saveActivation } = await import('../src/license/store.js');

// saveRevocationCache is a no-op without an installed license, so seed one.
getConfig().set('license', { token: 'fake.token.blob', last_seen_utc: '2026-07-10T00:00:00Z' });

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  OK  ${label}`); }
  catch (e) { failures++; console.error(`  FAIL  ${label}\n        ${e.message}`); }
};

// ── Fail-open on every fault ───────────────────────────────────────────────
console.log('\n── Fail-open contract ──');

mode = 'down';
const downVerdict = await checkRevocation('LICFAILOPEN1');
check("worker unreachable -> 'unknown'", () => assert.strictEqual(downVerdict, 'unknown'));

mode = 'notfound';
const nfVerdict = await checkRevocation('LICFAILOPEN2');
check("404 license_not_found -> 'unknown' (NOT revoked)", () => assert.strictEqual(nfVerdict, 'unknown'));

mode = 'ratelimit';
const rlVerdict = await checkRevocation('LICFAILOPEN3');
check("429 rate_limited -> 'unknown'", () => assert.strictEqual(rlVerdict, 'unknown'));

mode = 'garbage';
const gbVerdict = await checkRevocation('LICFAILOPEN4');
check("unparseable body -> 'unknown'", () => assert.strictEqual(gbVerdict, 'unknown'));

mode = 'hang';
const t0 = Date.now();
const hangVerdict = await checkRevocation('LICFAILOPEN5');
const elapsed = Date.now() - t0;
check("hung worker -> 'unknown'", () => assert.strictEqual(hangVerdict, 'unknown'));
check(`hung worker gives up inside 4s (took ${elapsed}ms)`, () => assert.ok(elapsed < 4000, `took ${elapsed}ms`));

// Resolved BEFORE the sync `check` helper, which would otherwise swallow an
// async body and report a vacuous pass.
mode = 'hang';   // if this ever touches the network the test would stall, not pass
const nullVerdict = await checkRevocation(null);
check("null licenseId -> 'unknown', no network", () => assert.strictEqual(nullVerdict, 'unknown'));

// ── Healthy license ────────────────────────────────────────────────────────
console.log('\n── Healthy license ──');

mode = 'activated';
const activeVerdict = await checkRevocation('LICACTIVE');
check("status=activated -> 'active'", () => assert.strictEqual(activeVerdict, 'active'));

mode = 'pending';
const pendingVerdict = await checkRevocation('LICPENDING');
check("status=pending -> 'active' (only 'revoked' blocks)", () => assert.strictEqual(pendingVerdict, 'active'));

// ── Sticky revocation ──────────────────────────────────────────────────────
console.log('\n── Sticky revocation ──');

mode = 'revoked';
const revVerdict = await checkRevocation('LICREVOKED');
check("status=revoked -> 'revoked'", () => assert.strictEqual(revVerdict, 'revoked'));
check('revoked verdict persisted to disk', () => {
  const c = getRevocationCache();
  assert.strictEqual(c?.status, 'revoked');
  assert.strictEqual(c?.license_id, 'LICREVOKED');
});

// The attack this exists to stop: cancel, then go offline.
mode = 'down';
const stickyVerdict = await checkRevocation('LICREVOKED');
check("network cut after revoke -> still 'revoked'", () => assert.strictEqual(stickyVerdict, 'revoked'));

// The above passes even WITHOUT the sticky guard, because a fresh cache entry
// answers 'revoked' on its own. The guard only earns its keep once the entry is
// stale: a stale entry falls through to the network, and the network is down.
// Age the cache past its 24h TTL and re-check. Without the sticky short-circuit
// this returns 'unknown' and a cancelled customer is back in business by simply
// waiting a day and unplugging. Do not delete this case.
const aged = getConfig().get('license');
aged.revocation.checked_at = new Date(Date.now() - 48 * 60 * 60 * 1000)
  .toISOString().replace(/\.\d+Z$/, 'Z');
getConfig().set('license', aged);

mode = 'down';
const staleOfflineVerdict = await checkRevocation('LICREVOKED');
check("cache older than TTL + worker unreachable -> still 'revoked'", () =>
  assert.strictEqual(staleOfflineVerdict, 'revoked'));

mode = 'activated';
const stickyOnlineVerdict = await checkRevocation('LICREVOKED');
check("worker reachable again -> still 'revoked' (sticky beats a stale 200)", () =>
  assert.strictEqual(stickyOnlineVerdict, 'revoked'));

// A revoked license must not poison a different licenseId on the same machine.
mode = 'down';
const otherVerdict = await checkRevocation('LICOTHER');
check("different licenseId does not inherit revoked -> 'unknown'", () =>
  assert.strictEqual(otherVerdict, 'unknown'));

// ── Forced re-probe (the support path for resubscribes) ────────────────────
// GHOST_LICENSE_VERIFY_FORCE=1 must be able to clear a sticky revoked verdict
// with a FRESH non-revoked worker answer (the customer resubscribed and the
// worker flipped their record back), but must NEVER fail open: a forced probe
// that learns nothing keeps the sticky verdict.
console.log('\n── Forced re-probe ──');

process.env.GHOST_LICENSE_VERIFY_FORCE = '1';

mode = 'down';
const forcedOfflineVerdict = await checkRevocation('LICREVOKED');
check("force + worker down -> still 'revoked' (force never fails open)", () =>
  assert.strictEqual(forcedOfflineVerdict, 'revoked'));

mode = 'garbage';
const forcedGarbageVerdict = await checkRevocation('LICREVOKED');
check("force + unparseable body -> still 'revoked'", () =>
  assert.strictEqual(forcedGarbageVerdict, 'revoked'));

mode = 'activated';
const forcedResubVerdict = await checkRevocation('LICREVOKED');
check("force + fresh 'activated' verdict -> 'active' (resubscribe takes effect)", () =>
  assert.strictEqual(forcedResubVerdict, 'active'));
check('forced non-revoked verdict overwrites the sticky cache', () => {
  const c = getRevocationCache();
  assert.strictEqual(c?.status, 'activated');
});

delete process.env.GHOST_LICENSE_VERIFY_FORCE;

// Sticky flag is gone: a later offline run with a fresh cache resolves from
// the cache, not the network.
mode = 'down';
const postResubOffline = await checkRevocation('LICREVOKED');
check("after forced resubscribe, offline run -> 'active' (fresh cache)", () =>
  assert.strictEqual(postResubOffline, 'active'));

// ── Re-activation clears the cache ─────────────────────────────────────────
console.log('\n── Re-activation ──');

saveActivation({ token: 'new.token.blob', fingerprintHashes: ['a', 'b', 'c', 'd'] });
check('saveActivation drops the revocation cache', () =>
  assert.strictEqual(getRevocationCache(), null));

mode = 'activated';
const afterReactivate = await checkRevocation('LICREVOKED');
check("previously revoked id resolves 'active' after re-activation", () =>
  assert.strictEqual(afterReactivate, 'active'));

// ── Opt-out ────────────────────────────────────────────────────────────────
console.log('\n── Opt-out ──');

process.env.GHOST_NO_LICENSE_VERIFY = '1';
mode = 'revoked';
const optOutVerdict = await checkRevocation('LICNEVERSEEN');
check("GHOST_NO_LICENSE_VERIFY=1 -> 'unknown' (no probe)", () =>
  assert.strictEqual(optOutVerdict, 'unknown'));
delete process.env.GHOST_NO_LICENSE_VERIFY;

// But opt-out must NOT resurrect an already-cached revoked verdict.
mode = 'revoked';
await checkRevocation('LICSTICKY2');
process.env.GHOST_NO_LICENSE_VERIFY = '1';
const optOutSticky = await checkRevocation('LICSTICKY2');
check("GHOST_NO_LICENSE_VERIFY does not resurrect a cached revoke", () =>
  assert.strictEqual(optOutSticky, 'revoked'));
delete process.env.GHOST_NO_LICENSE_VERIFY;

// ── Teardown ───────────────────────────────────────────────────────────────
server.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}

if (failures > 0) {
  console.error(`\nFAILED — ${failures} assertion(s) failed.\n`);
  process.exit(1);
}
console.log('\nPASSED — all assertions ok\n');
