// tests/ad-hoc/loadFromPath.test.mjs
//
// Verifies that loadFromPath loads a directory correctly and returns
// the same shape as loadFromFiles (the interactive path).
// Proves that _loadFromDirPath (shared between both paths) works correctly.
//
// Run: node tests/ad-hoc/loadFromPath.test.mjs

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadFromPath } from '../../src/loader/index.js';

// ── Build a self-contained fixture in an OS temp dir ──────────────────────────
// Previously this test hardcoded /tmp/ghost-e2e-fixture, which does not exist on
// every system and had to be created out of band. Create (and later remove) a
// throwaway fixture so the test runs anywhere.
const fixtureDir = mkdtempSync(path.join(tmpdir(), 'ghost-e2e-'));
writeFileSync(path.join(fixtureDir, 'moduleA.js'), 'export const moduleA = () => "A";\n');
writeFileSync(path.join(fixtureDir, 'moduleB.js'), 'export const moduleB = () => "B";\n');
writeFileSync(path.join(fixtureDir, 'moduleC.js'), 'export const moduleC = () => "C";\n');

let result;
try {
  result = await loadFromPath(fixtureDir);
} catch (err) {
  console.error('✗  loadFromPath threw:', err.message);
  rmSync(fixtureDir, { recursive: true, force: true });
  process.exit(1);
}

const checks = [
  ['Returns an object (not null/undefined)',         result !== null && typeof result === 'object'],
  ['Has context string',                             typeof result.context === 'string' && result.context.length > 0],
  ['Has fileMap object',                             typeof result.fileMap === 'object' && result.fileMap !== null],
  ['fileMap has 3 entries (moduleA/B/C)',            Object.keys(result.fileMap).length === 3],
  ['fileMap values are strings (not objects)',       Object.values(result.fileMap).every(v => typeof v === 'string')],
  ['Has loadedFiles count',                          typeof result.loadedFiles === 'number' && result.loadedFiles === 3],
  ['Has totalFiles count',                           typeof result.totalFiles === 'number'],
  ['Has basePath set to fixture dir',                result.basePath === fixtureDir],
  ['Context contains moduleA.js content',            result.context.includes('moduleA')],
  ['Context contains moduleB.js content',            result.context.includes('moduleB')],
];

let failures = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'}  ${label}`);
  if (!ok) failures++;
}

rmSync(fixtureDir, { recursive: true, force: true });

console.log('');
console.log(`${checks.length} checks — ${failures} failure(s)`);
if (failures > 0) process.exit(1);
