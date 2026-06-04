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
    target_files: ['app/code/Meta/Sales/Model/Api/CreateOrderApi.php'],
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

// ── Case B: Signature replacement (Mode 2R) — body ALWAYS preserved ──────────
// Mode 2 (destructive body replacement) has been removed.
// Mode 2R replaces only the signature block; body is preserved intact.
// This test: add nullable return type to an untyped method.
console.log('\n=== Case B: Signature replacement (Mode 2R) — body preserved ===');
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
    '        return null;',
    '    }',
    '',
    '    public function otherMethod(): void {}',
    '}',
  ].join('\n');

  const fixDir = {
    target_files: ['app/code/Meta/Catalog/Helper/MagentoDataHelper.php'],
    patch_instruction: 'public function getContentId(Product $product): ?string',
    reasoning: 'Add nullable string return type declaration.',
    confidence: 'high',
  };

  const r = generateCorrectedFile(baseline, fixDir);
  check('B1 confidence not failed',             r.confidence !== 'failed', true);
  has('B2 new return type added',               r.correctedContent, ': ?string');
  // Body must be PRESERVED — this is the key regression guard against old Mode 2 behavior
  has('B3 body getSku() preserved',             r.correctedContent, 'getSku()');
  has('B4 body return null preserved',          r.correctedContent, 'return null;');
  has('B5 subsequent method preserved',         r.correctedContent, 'otherMethod');
  // Old untyped signature must be gone
  check('B6 old untyped sig replaced',
    !r.correctedContent.includes('getContentId(Product $product)\n'), true);
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
    target_files: ['src/loader/index.js'],
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
    target_files: ['src/some/file.js'],
    patch_instruction: 'SELECT * FROM users WHERE role = "admin";',
    reasoning: 'Completely unrelated SQL query that matches nothing in the baseline.',
    confidence: 'high',
  };

  const r = generateCorrectedFile(baseline, fixDir);
  check('D1 confidence is "failed"',          r.confidence, 'failed');
  check('D2 correctedContent === baseline',   r.correctedContent, baseline);
  check('D3 notes is non-null',               r.notes !== null, true);
  has('D4 notes mentions Mode 1',             r.notes || '', 'Mode 1');
  has('D5 notes mentions Mode 2R',            r.notes || '', 'Mode 2R');
  has('D6 notes mentions Mode 3',             r.notes || '', 'Mode 3');
}

// ── E: Mode 2I — sentinel insertion (the diagnosed production bug) ────────────
// GraphAPIAdapter callApi — patch starts with function sig + // ... proceed.
// Old Mode 2 deleted the entire 70-line body. Mode 2I inserts the guard clause
// at the top of the body and preserves all original content.
{
  const baseline = [
    '    private function callApi($method, $endpoint, $request)',
    '    {',
    '        try {',
    '            $logRequest = $request;',
    '            if ($this->debugMode) {',
    '                $this->logger->debug(json_encode([\'endpoint\' => $endpoint]));',
    '            }',
    '            $response = $this->http->post($endpoint, $request);',
    '            return $response;',
    '        } catch (\\Exception $e) {',
    '            throw new LocalizedException(__($e->getMessage()));',
    '        }',
    '    }',
  ].join('\n');

  const fixDir = {
    target_files: ['app/code/Meta/BusinessExtension/Helper/GraphAPIAdapter.php'],
    patch_instruction: [
      'private function callApi($method, $endpoint, $request) {',
      '         if (!$this->accessToken) {',
      '             throw new LocalizedException(__(\'Access token not set. Call setAccessToken() first.\'));',
      '         }',
      '         // ... proceed',
      '     }',
    ].join('\n'),
    reasoning: 'Add access token guard at top of callApi before any API call proceeds.',
    confidence: 'high',
  };

  const r = generateCorrectedFile(baseline, fixDir);

  // Must succeed (not "failed")
  check('E1 confidence not failed',               r.confidence !== 'failed', true);
  // Guard clause must be inserted
  has('E2 guard clause inserted',                 r.correctedContent, 'Access token not set');
  // Original HTTP logic must be preserved (the critical regression test)
  has('E3 original http->post call preserved',    r.correctedContent, 'http->post');
  has('E4 original try/catch preserved',          r.correctedContent, 'catch');
  has('E5 original debug logging preserved',      r.correctedContent, 'debugMode');
  // The // ... sentinel must NOT appear in the output
  check('E6 truncation sentinel not in output',
    r.correctedContent.includes('// ... proceed'), false);
  console.log('     confidence:', r.confidence, '| notes:', (r.notes||'').slice(0,60));
}

// ── F: Mode 2R — signature-only change (Category C, no sentinel) ──────────────
// getExternalBusinessId signature change: add $scope parameter.
// Must replace only the signature, body preserved intact.
{
  const baseline = [
    '    /**',
    '     * Get external business ID.',
    '     */',
    '    public function getExternalBusinessId($scopeId = null)',
    '    {',
    '        if ($scopeId === null) {',
    '            $scopeId = $this->storeManager->getStore()->getId();',
    '        }',
    '        return $this->scopeConfig->getValue(',
    '            self::XML_PATH_EXTERNAL_BUSINESS_ID,',
    '            ScopeInterface::SCOPE_STORES,',
    '            $scopeId',
    '        );',
    '    }',
  ].join('\n');

  const fixDir = {
    target_files: ['app/code/Meta/BusinessExtension/Helper/MBEHelper.php'],
    patch_instruction: [
      'public function getExternalBusinessId(',
      '         $scopeId = null,',
      '         $scope = ScopeInterface::SCOPE_STORES // Default scope',
      '     )',
    ].join('\n'),
    reasoning: 'Add $scope parameter with default SCOPE_STORES to standardize scope handling.',
    confidence: 'high',
  };

  const r = generateCorrectedFile(baseline, fixDir);

  check('F1 confidence not failed',                 r.confidence !== 'failed', true);
  // New parameter must be in the output
  has('F2 new $scope parameter added',              r.correctedContent, 'SCOPE_STORES');
  // Original body must be fully preserved
  has('F3 body scopeConfig->getValue preserved',    r.correctedContent, 'scopeConfig->getValue');
  has('F4 body XML_PATH constant preserved',        r.correctedContent, 'XML_PATH_EXTERNAL_BUSINESS_ID');
  has('F5 storeManager lookup preserved',           r.correctedContent, 'storeManager->getStore');
  // Original single-parameter signature must be gone
  check('F6 old single-param sig replaced',
    r.correctedContent.includes('getExternalBusinessId($scopeId = null)\n'), false);
  console.log('     confidence:', r.confidence);
}

// ── G: Mode 1 still works for non-signature patches ───────────────────────────
// Regression guard: existing Mode 1 (single-line statement replacement) must
// still fire correctly and not be broken by the new Mode 2R/2I additions.
// Use a small edit — Mode 1 requires ≥ 0.80 similarity, so the patch must be
// a minor modification of the baseline line (not a full restructure).
{
  const baseline = [
    'function processOrder($orderId) {',
    '    $storeId = (int)$this->getRequest()->getParam(\'store_id\');',
    '    $status = $this->orderRepo->getById($orderId)->getStatus();',
    '    return $status;',
    '}',
  ].join('\n');

  // Small change: add null-coalescing default to the int cast
  const fixDir = {
    target_files: ['src/some/processor.php'],
    patch_instruction: '    $storeId = (int)($this->getRequest()->getParam(\'store_id\') ?? 0);',
    reasoning: 'Add null-coalescing fallback for missing store_id param.',
    confidence: 'high',
  };

  const r = generateCorrectedFile(baseline, fixDir);

  check('G1 confidence not failed',              r.confidence !== 'failed', true);
  has('G2 null-coalesce applied',                r.correctedContent, '?? 0');
  has('G3 rest of function preserved',           r.correctedContent, 'orderRepo->getById');
  has('G4 return statement preserved',           r.correctedContent, 'return $status');
  check('G5 mode 1 fired (no sig keyword)',
    !r.correctedContent.includes('function processOrder') ||
    r.correctedContent.includes('?? 0'), true);
  console.log('     confidence:', r.confidence);
}

// ── Case H: Mode 2R complete-rewrite branch (Bug 2 fix) ──────────────────────
// Smoke 3 case: getGraphApiVersion patch is brace-balanced and closes with }.
// Before fix: Mode 2R replaced only sig through opening {, then appended OLD
//   body — result: new body + old body stacked (malformed PHP).
// After fix:  isBalancedAndClosed detected → state-machine walker finds closing }
//   of baseline method → full replacement, old body absent, nextMethod preserved.
{
  // Simulate the Allman-style baseline (how the file likely looks)
  const baseline = [
    '    /**',
    '     * @return string',
    '     */',
    '    public function getGraphApiVersion(): string',
    '    {',
    '        $latestGraphApiVersion = $this->systemConfig->getGraphAPIVersion();',
    '        return $latestGraphApiVersion ?? $this->graphAPIVersion;',
    '    }',
    '    public function nextMethod(): string {',
    '        return "next";',
    '    }',
  ].join('\n');

  // The exact smoke3 patch_instruction (complete rewrite — balanced braces, closes with })
  const fixDir = {
    target_files: ['app/code/Meta/BusinessExtension/Helper/GraphAPIAdapter.php'],
    patch_instruction: [
      'public function getGraphApiVersion(): string {',
      '         $version = $this->systemConfig->getGraphAPIVersion();',
      '         if (!$version) {',
      '             throw new LocalizedException(__(\'Graph API version not configured\'));',
      '         }',
      '         return $version;',
      '     }',
    ].join('\n'),
    reasoning: 'Remove hard-coded fallback; fail-fast if version not configured.',
    confidence: 'high',
  };

  const r = generateCorrectedFile(baseline, fixDir);

  check('H1 confidence not failed',                 r.confidence !== 'failed', true);
  // New logic must be present
  has('H2 new throw clause inserted',               r.correctedContent, 'Graph API version not configured');
  has('H3 new $version variable present',           r.correctedContent, '$this->systemConfig->getGraphAPIVersion()');
  // Old body must be ABSENT — the key regression this case tests
  check('H4 old body absent (latestGraphApiVersion)',
    r.correctedContent.includes('$latestGraphApiVersion'), false);
  check('H5 old ?? fallback absent',
    r.correctedContent.includes('?? $this->graphAPIVersion'), false);
  // nextMethod after the patched function must survive
  has('H6 nextMethod still present',                r.correctedContent, 'nextMethod');
  // No double-body (old body should not appear at all)
  const oldBodyCount = (r.correctedContent.match(/latestGraphApiVersion/g) || []).length;
  check('H7 old body does not appear twice',        oldBodyCount, 0);
  console.log('     confidence:', r.confidence, '| notes:', (r.notes||'(none)').slice(0,50));
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} checks — ${failed} failure(s)\n`);
if (failed > 0) process.exit(1);
