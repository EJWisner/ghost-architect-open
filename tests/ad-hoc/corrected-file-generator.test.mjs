// tests/ad-hoc/corrected-file-generator.test.mjs
// Run: node tests/ad-hoc/corrected-file-generator.test.mjs

import { generateCorrectedFile } from
  '../../src/utils/corrected-file-generator.js';

let passed = 0, failed = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.log(`  ✗  ${label}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       actual:   ${JSON.stringify(String(actual).slice(0,120))}`);
    failed++;
  }
}
function has(label, haystack, needle) {
  if (typeof haystack === 'string' && haystack.includes(needle)) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.log(`  ✗  ${label}`);
    console.log(`       expected to contain: ${JSON.stringify(needle)}`);
    console.log(`       actual (first 200):  ${JSON.stringify((haystack||'').slice(0,200))}`);
    failed++;
  }
}
function not(label, haystack, needle) {
  if (typeof haystack === 'string' && !haystack.includes(needle)) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.log(`  ✗  ${label}`);
    console.log(`       expected NOT to contain: ${JSON.stringify(needle)}`);
    failed++;
  }
}

// ── Case A: Single-line replacement (Mode 1) ─────────────────────────────────
console.log('\n=== Case A: Single-line replacement (Mode 1) ===');
{
  const baseline = [
    '<?php',
    'declare(strict_types=1);',
    '',
    'class CreateOrderApi {',
    '    public function process(Quote $quote): void {',
    '        $storeId = $quote->getStoreId();',
    '        $this->buildMetaLogContext($storeId, $quote);',
    '    }',
    '}',
  ].join('\n');

  const fixDir = {
    target_file: 'app/code/Meta/Sales/Model/Api/CreateOrderApi.php',
    patch_instruction: '$storeId = (int)$quote->getStoreId();',
    reasoning: 'Add explicit type cast immediately after retrieving store ID.',
    confidence: 'high',
  };

  const r = generateCorrectedFile(baseline, fixDir);
  check('A1 confidence is "high"',           r.confidence, 'high');
  has('A2 corrected has (int) cast',          r.correctedContent, '(int)$quote->getStoreId()');
  not('A3 original un-cast line gone',        r.correctedContent, '$storeId = $quote->getStoreId();');
  check('A4 notes is null',                   r.notes, null);
  has('A5 surrounding context preserved',     r.correctedContent, 'buildMetaLogContext');
}

// ── Case B: Function block replacement (Mode 2) ───────────────────────────────
console.log('\n=== Case B: Function block replacement (Mode 2) ===');
{
  const baseline = [
    '<?php',
    'class MagentoDataHelper {',
    '    public function getContentId(Product $product)',
    '    {',
    "        $contentIdType = $this->systemConfig->getProductIdentifierAttr();",
    "        if ($contentIdType === 'sku') {",
    '            return $product->getSku();',
    '        }',
    "        if ($contentIdType === 'id') {",
    '            return $product->getId();',
    '        }',
    '        return null;',
    '    }',
    '',
    '    public function otherMethod(): void {}',
    '}',
  ].join('\n');

  const patch = [
    'public function getContentId(Product $product): string',
    '    {',
    "        $contentIdType = $this->systemConfig->getProductIdentifierAttr();",
    "        if ($contentIdType === 'sku') {",
    '            return (string)$product->getSku();',
    '        }',
    '        return (string)$product->getId();',
    '    }',
  ].join('\n');

  const fixDir = {
    target_file: 'app/code/Meta/Catalog/Helper/MagentoDataHelper.php',
    patch_instruction: patch,
    reasoning: 'Refactor to return a single type.',
    confidence: 'high',
  };

  const r = generateCorrectedFile(baseline, fixDir);
  check('B1 confidence is "high"',            r.confidence, 'high');
  has('B2 new signature with ": string"',     r.correctedContent, 'getContentId(Product $product): string');
  not('B3 old "return null" removed',         r.correctedContent, 'return null;');
  has('B4 cast return in output',             r.correctedContent, '(string)$product->getSku()');
  check('B5 notes is null',                   r.notes, null);
  has('B6 subsequent method still present',   r.correctedContent, 'otherMethod');
}

// ── Case C: Reasoning-anchored insertion (Mode 3) ────────────────────────────
console.log('\n=== Case C: Reasoning-anchored insertion (Mode 3) ===');
{
  const baseline = [
    'export async function loadFromPath(dirPath) {',
    '  if (!fs.existsSync(dirPath)) {',
    '    throw new Error(`Path does not exist: ${dirPath}`);',
    '  }',
    '  if (!fs.statSync(dirPath).isDirectory()) {',
    '    throw new Error(`Path is not a directory: ${dirPath}`);',
    '  }',
    '  return await _loadFromDirPath(dirPath);',
    '}',
  ].join('\n');

  const patch = [
    '  if (!stat) {',
    '    throw new Error(`Cannot stat path: ${dirPath}`);',
    '  }',
  ].join('\n');

  const fixDir = {
    target_file: 'src/loader/index.js',
    patch_instruction: patch,
    reasoning: 'Add null guard before the isDirectory call.',
    confidence: 'high',
  };

  const r = generateCorrectedFile(baseline, fixDir);
  check('C1 confidence is "medium"',          r.confidence, 'medium');
  has('C2 null guard inserted',               r.correctedContent, 'if (!stat)');
  has('C3 isDirectory line still present',    r.correctedContent, 'isDirectory');
  const guardIdx = r.correctedContent.indexOf('if (!stat)');
  const isDirIdx = r.correctedContent.indexOf('isDirectory');
  check('C4 guard appears before isDirectory()', guardIdx < isDirIdx && guardIdx >= 0, true);
  check('C5 notes is non-null',               r.notes !== null, true);
  has('C6 notes mentions reasoning',          r.notes || '', 'reasoning');
}

// ── Case D: No match — failed fallback ───────────────────────────────────────
console.log('\n=== Case D: No match — failed fallback ===');
{
  const baseline = [
    'const x = 1;',
    'const y = 2;',
    'console.log(x + y);',
  ].join('\n');

  const fixDir = {
    target_file: 'src/some/file.js',
    patch_instruction: 'SELECT * FROM users WHERE role = "admin";',
    reasoning: 'Completely unrelated SQL query that matches nothing in the baseline.',
    confidence: 'high',
  };

  const r = generateCorrectedFile(baseline, fixDir);
  check('D1 confidence is "failed"',          r.confidence, 'failed');
  check('D2 correctedContent === baseline',   r.correctedContent, baseline);
  check('D3 notes is non-null',               r.notes !== null, true);
  has('D4 notes mentions Mode 1',             r.notes || '', 'Mode 1');
  has('D5 notes mentions Mode 2',             r.notes || '', 'Mode 2');
  has('D6 notes mentions Mode 3',             r.notes || '', 'Mode 3');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} checks — ${failed} failure(s)\n`);
if (failed > 0) process.exit(1);
