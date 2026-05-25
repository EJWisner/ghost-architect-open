/**
 * Smoke tests for the worker-driven promo module wiring.
 *
 * Two contracts under test:
 *
 *   1. Banner contract — when fetchPromoText returns non-empty AND the
 *      license state is 'missing', renderLicenseStateAndMaybeBlock must
 *      render the promo text in the banner output. When fetchPromoText
 *      returns '', the banner must NOT contain a 'Launch special'
 *      sentinel anywhere.
 *
 *   2. Fetcher robustness contract — fetchPromoText must NEVER throw,
 *      and must return '' on every failure path: timeout (AbortError),
 *      malformed response (missing `promo` field, `promo` is null, or
 *      `promo` is a non-string type). All failures are silent.
 *
 * The banner is rendered via console.log + boxen. To assert on output,
 * each case patches console.log to push to an in-memory buffer, runs
 * the function, restores the real console.log, and inspects the joined
 * buffer for the sentinel.
 *
 * globalThis.fetch is stubbed per-case (save once at top of file, each
 * case sets its own stub inside try/finally and restores in finally).
 * No external mock library — same pattern as verifier-stepcap.smoke.mjs.
 *
 * Run: node tests/banner-promo.smoke.mjs
 */

import { fetchPromoText, renderLicenseStateAndMaybeBlock } from '../bin/ghost.js';

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected: ' + e);
    console.log('       actual:   ' + a);
    failures++;
  }
}

function checkPredicate(label, value, predicate, predicateDesc) {
  if (predicate(value)) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       failed:   ' + predicateDesc);
    console.log('       value:    ' + JSON.stringify(value));
    failures++;
  }
}

// Save the real fetch and console.log once; cases save/restore per-case
// inside try/finally so a failing case doesn't leak its stub.
const realFetch = globalThis.fetch;
const realConsoleLog = console.log;

// Helper: run a sync render function with console.log patched to a buffer.
// Returns the joined captured output. Restores console.log even if render
// throws.
function captureRender(renderFn) {
  const buffer = [];
  console.log = (...args) => {
    buffer.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
  };
  try {
    renderFn();
  } finally {
    console.log = realConsoleLog;
  }
  return buffer.join('\n');
}

// The exact promo string shipped in the worker as PROMO_TEXT. One source
// of truth: any divergence between this fixture and the worker constant
// is a real bug.
const PROMO_FIXTURE = 'Launch special: 50% off first month. 100 spots remaining. Code LAUNCH50';

// Sentinel for negative-case detection. Tight, unique to promo content,
// no false positives against the rest of the banner.
const PROMO_SENTINEL = 'Launch special';

// ── Test 1: positive render — non-empty promo + missing license state
console.log('Test 1: non-empty promoText + state=missing → banner contains promo string');
{
  const output = captureRender(() => {
    renderLicenseStateAndMaybeBlock({ state: 'missing' }, PROMO_FIXTURE);
  });

  checkPredicate(
    'banner output contains the full promo string',
    output,
    s => s.includes(PROMO_FIXTURE),
    'output should include the exact PROMO_FIXTURE'
  );

  checkPredicate(
    "banner output contains 'Purchase at:' (adjacency preserved)",
    output,
    s => s.includes('Purchase at:'),
    "output should include the Purchase CTA"
  );

  // Adjacency check: promo must appear BEFORE 'Purchase at:' in the
  // output. The intentional placement is promo-then-purchase so the
  // discount visually anchors to the purchase URL.
  const promoIdx    = output.indexOf(PROMO_FIXTURE);
  const purchaseIdx = output.indexOf('Purchase at:');
  checkPredicate(
    'promo appears BEFORE Purchase at: in banner (anchored to purchase CTA)',
    { promoIdx, purchaseIdx },
    v => v.promoIdx >= 0 && v.purchaseIdx >= 0 && v.promoIdx < v.purchaseIdx,
    'promoIdx should be >= 0, purchaseIdx should be >= 0, and promoIdx < purchaseIdx'
  );
}
console.log('');

// ── Test 2: empty promo suppresses the line, banner otherwise intact
console.log('Test 2: empty promoText + state=missing → no sentinel, banner still renders');
{
  const output = captureRender(() => {
    renderLicenseStateAndMaybeBlock({ state: 'missing' }, '');
  });

  checkPredicate(
    "banner output does NOT contain the 'Launch special' sentinel",
    output,
    s => !s.includes(PROMO_SENTINEL),
    "output should not include any 'Launch special' substring"
  );

  checkPredicate(
    "banner output does NOT contain 'LAUNCH50' code reference",
    output,
    s => !s.includes('LAUNCH50'),
    "output should not include the promo code"
  );

  // The rest of the banner must still render normally — empty promo
  // is a render-skip, not a banner-skip.
  checkPredicate(
    "banner output still contains 'Purchase at:' (banner intact)",
    output,
    s => s.includes('Purchase at:'),
    "output should still include the Purchase CTA"
  );

  checkPredicate(
    "banner output still contains 'No license installed' headline",
    output,
    s => s.includes('No license installed'),
    "output should still include the banner headline"
  );
}
console.log('');

// ── Test 5: fetchPromoText silent failure on AbortError-shape rejection
//
// The real timeout path goes: setTimeout(2000ms) → controller.abort() →
// fetch rejects with an AbortError. We don't wait 2 wall-clock seconds
// here — instead we stub fetch to reject immediately with an
// AbortError-shaped error. This tests the contract ("any error → '' ")
// against the right error shape, in case fetchPromoText is ever tightened
// to discriminate on err.name (forward-compat).
console.log('Test 5: fetch rejects with AbortError → fetchPromoText returns empty string');
{
  try {
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    const result = await fetchPromoText();
    check('AbortError → empty string', result, '');
    check('result is exactly type string', typeof result, 'string');
  } finally {
    globalThis.fetch = realFetch;
  }
}
console.log('');

// ── Test 6: fetchPromoText silent failure on malformed response shapes
//
// Four sub-shapes that all violate the typeof === 'string' guard. Each
// is stubbed independently; each should return '' without throwing.
console.log('Test 6: malformed response shapes → fetchPromoText returns empty string for each');
{
  // 6a: response missing promo field entirely
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ latestVersion: '7.0.0' }),  // no promo key
    });
    const result = await fetchPromoText();
    check('missing promo field → empty string', result, '');
  } finally {
    globalThis.fetch = realFetch;
  }

  // 6b: promo is explicitly null
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ promo: null }),
    });
    const result = await fetchPromoText();
    check('promo is null → empty string', result, '');
  } finally {
    globalThis.fetch = realFetch;
  }

  // 6c: promo is a number (non-string type)
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ promo: 42 }),
    });
    const result = await fetchPromoText();
    check('promo is number → empty string', result, '');
  } finally {
    globalThis.fetch = realFetch;
  }

  // 6d: non-2xx HTTP response (resp.ok is false)
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ promo: PROMO_FIXTURE }),  // even if body had promo
    });
    const result = await fetchPromoText();
    check('non-2xx HTTP response → empty string (body ignored)', result, '');
  } finally {
    globalThis.fetch = realFetch;
  }
}
console.log('');

// ── Summary
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
