/**
 * Smoke test for context-cap clamping (Ghost Open™ 12: one cap for everyone).
 *
 * The cap is applied while building the scan context, so this test drives the
 * real loader against a fixture and checks what actually reaches the model:
 *
 *   1. With no override, a scan gets the full CONTEXT_CAP (the highest cap any
 *      former tier had), and a fixture larger than the cap is truncated at it.
 *   2. --max-context below the cap is honored; above the cap it is clamped.
 *      Invalid values fall back to the cap, never to zero.
 *   3. A saved `ghost --reconfigure` value below the cap is honored, and an
 *      explicit --max-context still wins over it.
 *
 * Isolation: XDG_CONFIG_HOME is redirected before any Ghost module is imported,
 * so the real configstore is never read or written.
 *
 * Run: node tests/context-cap-clamping.smoke.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cap-home-'));
process.env.XDG_CONFIG_HOME = tmpHome;

const { setScanOptions, loadFromPath } = await import('../src/loader/index.js');
const { CONTEXT_CAP, resolveContextCap, getContextCap } = await import('../src/loader/contextCap.js');
const { getConfig } = await import('../src/config.js');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  OK  ${label}`); }
  catch (e) { failures++; console.error(`  FAIL  ${label}\n        ${e.message}`); }
};

async function quiet(fn) {
  const origLog = console.log, origWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = origLog; console.warn = origWarn; }
}
function quietSync(fn) {
  const w = console.warn; console.warn = () => {};
  try { return fn(); } finally { console.warn = w; }
}

// ── Fixture: more source than the cap ───────────────────────────────────────
// Context is token-estimated from characters (chars / 4). 260 files of ~4KB is
// ~1MB, roughly 260K tokens, comfortably over the 200K cap.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cap-repo-'));
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
const FILE_BODY = (i) =>
  `// module ${i}\n` + Array.from({ length: 50 }, (_, k) =>
    `export function fn${i}_${k}(alpha, beta) { return alpha + beta + ${i * k}; }`
  ).join('\n') + '\n';
for (let i = 0; i < 260; i++) {
  fs.writeFileSync(path.join(root, 'src', `mod${i}.js`), FILE_BODY(i), 'utf8');
}

const loadedAt = async (opts) => {
  setScanOptions(opts);
  const ctx = await quiet(() => loadFromPath(root));
  return { loaded: ctx.loadedFiles, total: ctx.totalFiles, chars: ctx.context.length };
};

// ── 1. One cap, the highest ─────────────────────────────────────────────────
console.log('\n── One context cap for everyone ──');

check('CONTEXT_CAP is 200,000 tokens (the highest former cap)', () => {
  assert.strictEqual(CONTEXT_CAP, 200000);
  assert.strictEqual(getContextCap(), 200000);
});

const full = await loadedAt({ maxContextOverride: null });
console.log(`  full ${full.loaded}/${full.total} files (${full.chars} chars)`);

check('the fixture is larger than the cap, so the cap actually truncates', () => {
  assert.ok(full.loaded < full.total, `loaded all ${full.total} files; fixture too small`);
});

check('the loaded context stays within the cap', () => {
  assert.ok(Math.ceil(full.chars / 4) <= CONTEXT_CAP + 1000,
    `~${Math.ceil(full.chars / 4)} tokens loaded, cap ${CONTEXT_CAP}`);
});

check('the loaded context uses more than the old 150K ceiling', () => {
  assert.ok(Math.ceil(full.chars / 4) > 150000,
    `only ~${Math.ceil(full.chars / 4)} tokens loaded`);
});

// ── 2. --max-context ─────────────────────────────────────────────────────────
console.log('\n── --max-context ──');

const small = await loadedAt({ maxContextOverride: 20000 });

check('--max-context below the cap is honored (loads fewer files)', () => {
  assert.ok(small.loaded < full.loaded, `--max-context 20000 loaded ${small.loaded}, full ${full.loaded}`);
});

check('--max-context above the cap is clamped to the cap', () => {
  const r = quietSync(() => resolveContextCap(999999, 'cli'));
  assert.strictEqual(r.effective, CONTEXT_CAP);
  assert.strictEqual(r.clamped, true);
  assert.strictEqual(r.cap, CONTEXT_CAP);
});

check('--max-context within the cap is passed through unclamped', () => {
  const r = resolveContextCap(120000, 'cli');
  assert.strictEqual(r.effective, 120000);
  assert.strictEqual(r.clamped, false);
});

check('a null request resolves to the full cap', () => {
  assert.strictEqual(resolveContextCap(null).effective, CONTEXT_CAP);
});

check('an invalid --max-context falls back to the cap, not zero', () => {
  for (const bad of [0, -5, NaN, 'lots', Infinity]) {
    const r = quietSync(() => resolveContextCap(bad, 'cli'));
    assert.strictEqual(r.effective, CONTEXT_CAP, `bad value ${String(bad)} did not fall back`);
    assert.strictEqual(r.clamped, false);
  }
});

// ── 3. Saved settings ────────────────────────────────────────────────────────
console.log('\n── Saved context setting ──');

getConfig().set('maxTokensContext', 20000);
const saved = await loadedAt({ maxContextOverride: null });
const savedWithFlag = await loadedAt({ maxContextOverride: 40000 });
getConfig().delete('maxTokensContext');

check('a saved value below the cap is honored', () => {
  assert.strictEqual(saved.loaded, small.loaded, `saved 20K loaded ${saved.loaded}, --max-context 20K loaded ${small.loaded}`);
});

check('an explicit --max-context wins over the saved value', () => {
  assert.ok(savedWithFlag.loaded > saved.loaded,
    `--max-context 40000 loaded ${savedWithFlag.loaded}, saved 20K loaded ${saved.loaded}`);
});

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(tmpHome, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\ncontext-cap-clamping.smoke: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nPASSED: all assertions ok');
