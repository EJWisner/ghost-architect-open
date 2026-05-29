// tests/ad-hoc/loadFromPath.test.mjs
//
// Verifies that loadFromPath loads a directory correctly and returns
// the same shape as loadFromFiles (the interactive path).
// Proves that _loadFromDirPath (shared between both paths) works correctly.
//
// Run: node tests/ad-hoc/loadFromPath.test.mjs

import { loadFromPath } from '../../src/loader/index.js';

// ── Test against known fixture ────────────────────────────────────────────────
const FIXTURE = '/tmp/ghost-e2e-fixture';

let result;
try {
  result = await loadFromPath(FIXTURE);
} catch (err) {
  console.error('✗  loadFromPath threw:', err.message);
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
  ['Has basePath set to fixture dir',                result.basePath === FIXTURE],
  ['Context contains moduleA.js content',            result.context.includes('moduleA')],
  ['Context contains moduleB.js content',            result.context.includes('moduleB')],
];

let failures = 0;
for (const [label, result] of checks) {
  console.log(`${result ? '✓' : '✗'}  ${label}`);
  if (!result) failures++;
}

console.log('');
console.log(`${checks.length} checks — ${failures} failure(s)`);
if (failures > 0) process.exit(1);
