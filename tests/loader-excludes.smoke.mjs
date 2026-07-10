/**
 * Smoke test for loader exclusion behavior.
 *
 * Three things had no coverage at all, and all three are revenue-adjacent: a
 * scan that silently swallows a customer's source files produces a report with
 * a hole in it, and a scan that silently swallows nothing sends node_modules to
 * the API at the customer's expense.
 *
 *   1. Default excludes apply. node_modules, vendor, build output, lock files,
 *      and binary assets never reach the model, on every input method.
 *   2. Custom excludes stack. --exclude patterns and --exclude-presets compose
 *      with the defaults rather than replacing them.
 *   3. ZIP excludes are REPORTED. The directory path has always printed
 *      "Default excludes: skipped N file(s)"; the ZIP and GitHub paths applied
 *      the same filters with a bare `continue` and told the user nothing, so a
 *      ZIP scan silently dropped files the user could not account for.
 *
 * Isolation: XDG_CONFIG_HOME is redirected before any Ghost module is imported,
 * fixtures live in a temp dir, and stdout is captured rather than polluted.
 *
 * Run: node tests/loader-excludes.smoke.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-excl-home-'));
process.env.XDG_CONFIG_HOME = tmpHome;
process.env.GHOST_NO_LICENSE_VERIFY = '1';

const { setScanOptions, loadFromPath, loadFromZipPath, isScannablePath } =
  await import('../src/loader/index.js');
const { resolveExcludePatterns, isExcluded, PRESETS, filterPaths } =
  await import('../src/loader/excludes.js');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  OK  ${label}`); }
  catch (e) { failures++; console.error(`  FAIL  ${label}\n        ${e.message}`); }
};

// Silence + capture the loader's console output so we can assert on it.
async function captureStdout(fn) {
  const chunks = [];
  const origLog = console.log;
  console.log = (...a) => { chunks.push(a.join(' ')); };
  try { return { result: await fn(), out: chunks.join('\n') }; }
  finally { console.log = origLog; }
}

// ── Fixture tree ────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-excl-repo-'));
const write = (rel, body) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
};

// Real source, must survive.
write('src/app.js',            'export const app = 1;\n');
write('src/util.ts',           'export const util = 2;\n');
write('src/Service.php',       '<?php class Service {}\n');
write('src/Model.kt',          'class Model\n');
write('src/View.swift',        'struct View {}\n');
write('.env.example',          'API_KEY=\n');
// Default-excluded: dependency dirs, build output, lock files.
write('node_modules/left-pad/index.js', 'module.exports = 1;\n');
write('vendor/lib/vendor.php',          '<?php // vendor\n');
write('dist/bundle.js',                 'var bundled = 1;\n');
write('package-lock.json',              '{}\n');
// Custom-exclude targets.
write('tests/app.test.js',     'test("x", () => {});\n');
write('src/generated/api.ts',  'export const gen = 3;\n');
write('secrets/keys.js',       'export const k = 1;\n');

const names = (ctx) => Object.keys(ctx.fileMap || {}).map(p => p.replace(/\\/g, '/'));
const has = (ctx, frag) => names(ctx).some(n => n.endsWith(frag));

// ── 1. Default excludes ─────────────────────────────────────────────────────
console.log('\n── Default excludes ──');

setScanOptions({ tier: 'enterprise' });   // big cap so nothing is dropped for size
const { result: base, out: baseOut } = await captureStdout(() => loadFromPath(root));

check('real source files are loaded', () => {
  for (const f of ['src/app.js', 'src/util.ts', 'src/Service.php']) {
    assert.ok(has(base, f), `${f} missing from fileMap`);
  }
});

check('Swift and Kotlin are scannable (README claims support)', () => {
  assert.ok(has(base, 'src/Model.kt'),    '.kt not loaded');
  assert.ok(has(base, 'src/View.swift'),  '.swift not loaded');
});

check('.env.example is reachable (path.extname returns ".example")', () => {
  assert.ok(has(base, '.env.example'), '.env.example not loaded');
  assert.ok(isScannablePath('.env.example'), 'isScannablePath rejects .env.example');
});

check('node_modules is excluded by default', () => {
  assert.ok(!names(base).some(n => n.includes('node_modules')), 'node_modules leaked into the scan');
});

check('vendor is excluded by default', () => {
  assert.ok(!names(base).some(n => n.includes('vendor/')), 'vendor leaked into the scan');
});

check('build output (dist) is excluded by default', () => {
  assert.ok(!names(base).some(n => n.includes('dist/')), 'dist leaked into the scan');
});

check('lock files are excluded by default', () => {
  assert.ok(!has(base, 'package-lock.json'), 'package-lock.json leaked into the scan');
});

check('the directory path REPORTS how many files the defaults skipped', () => {
  assert.ok(/Default excludes: skipped \d+ file\(s\)/.test(baseOut),
    `no default-exclude count printed. stdout was:\n${baseOut}`);
});

// ── 2. Custom excludes stack on top of the defaults ─────────────────────────
console.log('\n── Custom excludes stack ──');

setScanOptions({ tier: 'enterprise', excludePatterns: ['**/secrets/**'] });
const { result: custom } = await captureStdout(() => loadFromPath(root));

check('a custom --exclude pattern removes its target', () => {
  assert.ok(!names(custom).some(n => n.includes('secrets/')), 'secrets/ survived --exclude');
});

check('a custom exclude does NOT disable the defaults', () => {
  assert.ok(!names(custom).some(n => n.includes('node_modules')),
    'passing --exclude replaced the default excludes instead of stacking');
});

check('unrelated source still loads alongside a custom exclude', () => {
  assert.ok(has(custom, 'src/app.js'));
});

setScanOptions({ tier: 'enterprise', excludePresets: ['test-data'] });
const { result: preset } = await captureStdout(() => loadFromPath(root));

check('an --exclude-presets preset removes its targets', () => {
  assert.ok(!names(preset).some(n => n.includes('tests/')), 'tests/ survived the test-data preset');
});

setScanOptions({
  tier: 'enterprise',
  excludePresets: ['test-data', 'generated'],
  excludePatterns: ['**/secrets/**'],
});
const { result: both } = await captureStdout(() => loadFromPath(root));

check('presets and custom patterns compose', () => {
  const n = names(both);
  assert.ok(!n.some(x => x.includes('tests/')),         'test-data preset not applied');
  assert.ok(!n.some(x => x.includes('src/generated/')), 'generated preset not applied');
  assert.ok(!n.some(x => x.includes('secrets/')),       'custom pattern not applied');
  assert.ok(!n.some(x => x.includes('node_modules')),   'defaults not applied');
  assert.ok(has(both, 'src/app.js'),                    'real source was over-excluded');
});

check('resolveExcludePatterns concatenates presets then custom patterns', () => {
  const p = resolveExcludePatterns(['test-data'], ['**/secrets/**']);
  assert.deepStrictEqual(p, [...PRESETS['test-data'], '**/secrets/**']);
});

check('an unknown preset is skipped, not fatal', () => {
  const p = resolveExcludePatterns(['no-such-preset'], ['**/x/**']);
  assert.deepStrictEqual(p, ['**/x/**']);
});

check('isExcluded matches on forward-slashed relative paths', () => {
  assert.ok(isExcluded('tests/app.test.js', PRESETS['test-data']));
  assert.ok(!isExcluded('src/app.js', PRESETS['test-data']));
});

check('filterPaths reports how many it removed', () => {
  const { kept, excluded } = filterPaths(
    ['src/app.js', 'tests/a.test.js', 'tests/b.test.js'],
    '.',
    PRESETS['test-data']
  );
  assert.strictEqual(excluded, 2);
  assert.deepStrictEqual(kept, ['src/app.js']);
});

// ── 3. ZIP excludes are applied AND reported ────────────────────────────────
console.log('\n── ZIP excludes ──');

const AdmZip = (await import('adm-zip')).default;
const zip = new AdmZip();
zip.addFile('proj/src/app.js',                  Buffer.from('export const app = 1;\n'));
zip.addFile('proj/src/Service.php',             Buffer.from('<?php class Service {}\n'));
zip.addFile('proj/node_modules/dep/index.js',   Buffer.from('module.exports = 1;\n'));
zip.addFile('proj/vendor/lib/vendor.php',       Buffer.from('<?php // vendor\n'));
zip.addFile('proj/package-lock.json',           Buffer.from('{}\n'));
zip.addFile('proj/tests/app.test.js',           Buffer.from('test("x",()=>{});\n'));
const zipPath = path.join(root, 'proj.zip');
zip.writeZip(zipPath);

setScanOptions({ tier: 'enterprise' });
const { result: zctx, out: zipOut } = await captureStdout(() => loadFromZipPath(zipPath));

check('ZIP: real source is loaded', () => {
  assert.ok(has(zctx, 'src/app.js'), 'src/app.js missing from ZIP scan');
});

check('ZIP: default excludes are applied', () => {
  const n = names(zctx);
  assert.ok(!n.some(x => x.includes('node_modules')),   'node_modules leaked from ZIP');
  assert.ok(!n.some(x => x.includes('vendor/')),        'vendor leaked from ZIP');
  assert.ok(!n.some(x => x.endsWith('package-lock.json')), 'lock file leaked from ZIP');
});

check('ZIP: default excludes are REPORTED, not silent', () => {
  assert.ok(/Default excludes: skipped \d+ file\(s\)/.test(zipOut),
    `ZIP path applied excludes silently. stdout was:\n${zipOut}`);
});

setScanOptions({ tier: 'enterprise', excludePresets: ['test-data'] });
const { result: zctx2 } = await captureStdout(() => loadFromZipPath(zipPath));

check('ZIP: custom presets stack on the defaults', () => {
  const n = names(zctx2);
  assert.ok(!n.some(x => x.includes('tests/')),       'test-data preset not applied to ZIP');
  assert.ok(!n.some(x => x.includes('node_modules')), 'ZIP defaults dropped when a preset was passed');
  assert.ok(has(zctx2, 'src/app.js'),                 'ZIP real source over-excluded');
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
