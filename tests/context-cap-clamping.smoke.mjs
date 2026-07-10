/**
 * Smoke test for context-cap clamping.
 *
 * tests/tier-caps.smoke.mjs locks the STATIC table (getTierCap per tier). This
 * test covers what actually reaches the model: the cap is applied while building
 * the scan context, so a tier with a smaller cap must load strictly fewer files
 * from the same repository. Nothing exercised that path, which is how a lapsed
 * trial ended up scanning at the trial's 100K cap while billing as Open at 50K.
 *
 * Covered here:
 *   1. The tier cap is enforced at the correct value per tier: the same fixture
 *      loads open < pro < team files.
 *   2. --max-context is honored, and is clamped down to the tier ceiling when it
 *      asks for more than the tier allows.
 *   3. ignoreSavedContext (the Ghost Watcher CI guard) ignores a developer's
 *      saved sub-tier override and restores the full tier cap. Without it, a
 *      Team runner inherits whatever `ghost --reconfigure` last wrote.
 *   4. A lapsed trial that degrades to Open re-seeds the loader at the OPEN cap,
 *      not the trial's. The degrade happens after the loader is first seeded, so
 *      the re-seed is what makes it real.
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
import { fileURLToPath } from 'url';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cap-home-'));
process.env.XDG_CONFIG_HOME = tmpHome;
process.env.GHOST_NO_LICENSE_VERIFY = '1';

const { setScanOptions, getScanOptions, loadFromPath } = await import('../src/loader/index.js');
const { getTierCap, resolveContextCap, TIER_CAPS }     = await import('../src/loader/tierCaps.js');
const { getConfig }                                    = await import('../src/config.js');

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

// ── Fixture: enough source to blow past the Open cap but fit under Team's ────
// Context is token-estimated from characters, so we size in characters. Open is
// 50K tokens, Team 150K. ~120 files x ~4KB = ~480KB ~= 120K tokens.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cap-repo-'));
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
const FILE_BODY = (i) =>
  `// module ${i}\n` + Array.from({ length: 90 }, (_, k) =>
    `export function fn${i}_${k}(alpha, beta) { return alpha + beta + ${i * k}; }`
  ).join('\n') + '\n';
for (let i = 0; i < 120; i++) {
  fs.writeFileSync(path.join(root, 'src', `mod${i}.js`), FILE_BODY(i), 'utf8');
}

const loadedAt = async (opts) => {
  setScanOptions(opts);
  const ctx = await quiet(() => loadFromPath(root));
  return { loaded: ctx.loadedFiles, total: ctx.totalFiles, chars: ctx.context.length };
};

// ── 1. The tier cap is enforced at the correct value per tier ───────────────
console.log('\n── Tier cap enforced per tier ──');

const open = await loadedAt({ tier: 'open',  maxContextOverride: null });
const pro  = await loadedAt({ tier: 'pro',   maxContextOverride: null });
const team = await loadedAt({ tier: 'team',  maxContextOverride: null });

console.log(`  open ${open.loaded}/${open.total} files (${open.chars} chars)`);
console.log(`  pro  ${pro.loaded}/${pro.total} files (${pro.chars} chars)`);
console.log(`  team ${team.loaded}/${team.total} files (${team.chars} chars)`);

check('the fixture is large enough to actually trip the Open cap', () => {
  assert.ok(open.loaded < open.total,
    `Open loaded all ${open.total} files; fixture too small to test clamping`);
});

check('Open loads strictly fewer files than Pro', () => {
  assert.ok(open.loaded < pro.loaded, `open=${open.loaded} pro=${pro.loaded}`);
});

check('Pro loads no more files than Team', () => {
  assert.ok(pro.loaded <= team.loaded, `pro=${pro.loaded} team=${team.loaded}`);
});

check('loaded context scales with the tier cap', () => {
  assert.ok(open.chars < pro.chars, 'Pro did not receive more context than Open');
});

check('the per-tier ceilings are the documented values', () => {
  assert.strictEqual(getTierCap('open'),            50000);
  assert.strictEqual(getTierCap('trial'),          100000);
  assert.strictEqual(getTierCap('pro'),            100000);
  assert.strictEqual(getTierCap('pro-max'),        100000);
  assert.strictEqual(getTierCap('team'),           150000);
  assert.strictEqual(getTierCap('team-max'),       150000);
  assert.strictEqual(getTierCap('enterprise'),     200000);
  assert.strictEqual(getTierCap('enterprise-max'), 200000);
});

check('an unknown tier falls back to the Open ceiling', () => {
  assert.strictEqual(getTierCap('platinum'), TIER_CAPS.open);
});

// ── 2. --max-context is honored, and clamped at the tier ceiling ────────────
console.log('\n── --max-context ──');

const proSmall = await loadedAt({ tier: 'pro', maxContextOverride: 20000 });

check('--max-context below the tier cap is honored (loads fewer files)', () => {
  assert.ok(proSmall.loaded < pro.loaded,
    `--max-context 20000 loaded ${proSmall.loaded}, full Pro loaded ${pro.loaded}`);
});

check('--max-context above the tier cap is clamped to the ceiling', () => {
  const r = resolveContextCap('open', 999999, 'cli');
  assert.strictEqual(r.effective, 50000);
  assert.strictEqual(r.clamped, true);
  assert.strictEqual(r.tierCap, 50000);
});

check('--max-context within the tier cap is passed through unclamped', () => {
  const r = resolveContextCap('team', 120000, 'cli');
  assert.strictEqual(r.effective, 120000);
  assert.strictEqual(r.clamped, false);
});

check('a null request resolves to the full tier ceiling', () => {
  assert.strictEqual(resolveContextCap('enterprise', null).effective, 200000);
});

check('an invalid --max-context falls back to the tier ceiling, not zero', () => {
  for (const bad of [0, -5, NaN, 'lots', Infinity]) {
    const r = quietSync(() => resolveContextCap('pro', bad, 'cli'));
    assert.strictEqual(r.effective, 100000, `bad value ${String(bad)} did not fall back`);
    assert.strictEqual(r.clamped, false);
  }
  function quietSync(fn) {
    const w = console.warn; console.warn = () => {};
    try { return fn(); } finally { console.warn = w; }
  }
});

// ── 3. ignoreSavedContext: the Ghost Watcher CI guard ───────────────────────
console.log('\n── ignoreSavedContext (Ghost Watcher CI guard) ──');

// A developer ran `ghost --reconfigure` and saved a 20K preference. A Team CI
// runner reading that configstore would silently scan at 20K.
getConfig().set('maxTokensContext', 20000);

const teamWithSaved = await loadedAt({ tier: 'team', maxContextOverride: null, ignoreSavedContext: false });
const teamIgnoring  = await loadedAt({ tier: 'team', maxContextOverride: null, ignoreSavedContext: true  });

check('a saved sub-tier override does clamp a Team scan', () => {
  assert.ok(teamWithSaved.loaded < team.loaded,
    `saved 20K did not clamp: ${teamWithSaved.loaded} vs full team ${team.loaded}`);
});

check('ignoreSavedContext restores the full tier cap for CI', () => {
  assert.strictEqual(teamIgnoring.loaded, team.loaded,
    `CI guard loaded ${teamIgnoring.loaded}, full Team loads ${team.loaded}`);
});

// Precedence: CLI --max-context > saved config > full tier cap. ignoreSavedContext
// only neutralizes the middle term; an explicit flag must still win.
const teamIgnoringWithFlag = await loadedAt({
  tier: 'team', maxContextOverride: 20000, ignoreSavedContext: true,
});

check('an explicit --max-context still wins over ignoreSavedContext', () => {
  assert.ok(teamIgnoringWithFlag.loaded < teamIgnoring.loaded,
    `--max-context 20000 loaded ${teamIgnoringWithFlag.loaded}, ` +
    `but the CI guard alone loaded ${teamIgnoring.loaded}: the flag was ignored`);
  assert.strictEqual(resolveContextCap('team', 20000, 'cli').effective, 20000);
});

getConfig().delete('maxTokensContext');

// ── 4. Lapsed trial degrades to Open, and the loader follows ────────────────
console.log('\n── Lapsed trial re-seeds at the Open cap ──');

// Seed as the license validator first sees it: a live Pro Max trial.
const trial = await loadedAt({ tier: 'trial', maxContextOverride: null });

check('a live trial scans at the trial (Pro Max) cap, not Open', () => {
  assert.strictEqual(getTierCap('trial'), 100000);
  assert.ok(trial.loaded > open.loaded,
    `trial loaded ${trial.loaded}, open loads ${open.loaded}`);
});

// The license gate degrades a hard-stopped trial to Open. bin/ghost.js re-seeds
// the loader when the gate moves the tier; this is that re-seed.
const degraded = await loadedAt({ tier: 'open', maxContextOverride: null });

check('after the degrade the loader is seeded at Open, not trial', () => {
  assert.strictEqual(getScanOptions().tier, 'open');
});

check('a degraded trial scans at the OPEN cap (50K), not the trial cap (100K)', () => {
  assert.strictEqual(degraded.loaded, open.loaded,
    `degraded loaded ${degraded.loaded} files, a true Open scan loads ${open.loaded}`);
  assert.ok(degraded.loaded < trial.loaded,
    'a lapsed trial is still scanning at the trial cap: the loader was never re-seeded');
});

// The re-seed only happens because bin/ghost.js calls setScanOptions again after
// the license gate can change TIER. Guard that call site: deleting it would make
// every assertion above pass while the shipped CLI regressed.
console.log('\n── The re-seed call site exists in bin/ghost.js ──');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ghostSrc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'ghost.js'), 'utf8');

check('bin/ghost.js captures the tier before the license gate', () => {
  assert.ok(/const tierBeforeGate = TIER;/.test(ghostSrc),
    'tierBeforeGate snapshot is gone');
});

check('bin/ghost.js re-seeds setScanOptions when the gate changed the tier', () => {
  const idxGate   = ghostSrc.indexOf('renderLicenseStateAndMaybeBlock(licenseResult');
  const idxReseed = ghostSrc.indexOf('if (TIER !== tierBeforeGate) {');
  assert.ok(idxGate > -1,   'license gate call site not found');
  assert.ok(idxReseed > -1, 'tier-change re-seed is missing: a lapsed trial keeps the trial context cap');
  assert.ok(idxReseed > idxGate, 're-seed runs before the gate, so it cannot see the degrade');
  const after = ghostSrc.slice(idxReseed, idxReseed + 400);
  assert.ok(/setScanOptions\(\{/.test(after), 're-seed branch does not call setScanOptions');
});

// ── Teardown ────────────────────────────────────────────────────────────────
setScanOptions({ tier: 'open' });
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}

if (failures > 0) {
  console.error(`\nFAILED — ${failures} assertion(s) failed.\n`);
  process.exit(1);
}
console.log('\nPASSED — all assertions ok\n');
