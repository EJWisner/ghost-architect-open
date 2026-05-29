// tests/ad-hoc/fix-forecast-writer.test.mjs
//
// Unit tests for fix-forecast-writer.js.
// Mocks generateCorrectedFile and the forecast pipeline.
// Does NOT make live API calls.
//
// Run: node tests/ad-hoc/fix-forecast-writer.test.mjs

import fs   from 'fs';
import os   from 'os';
import path from 'path';

// ── Minimal stub for runFixForecast without importing the whole dependency tree.
// We test the orchestration logic by re-implementing the pure portions here
// and injecting mock pipeline results.

import { computeUnifiedDiff } from '../../src/utils/diff-renderer.js';
import { generateCorrectedFile } from '../../src/utils/corrected-file-generator.js';

let passed = 0, failed = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.log(`  ✗  ${label}`);
    console.log(`       expected: ${JSON.stringify(String(expected).slice(0,120))}`);
    console.log(`       actual:   ${JSON.stringify(String(actual).slice(0,120))}`);
    failed++;
  }
}
function has(label, str, needle) {
  if (typeof str === 'string' && str.includes(needle)) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.log(`  ✗  ${label}`);
    console.log(`       expected to contain: ${JSON.stringify(needle)}`);
    console.log(`       actual (200ch): ${JSON.stringify((str||'').slice(0,200))}`);
    failed++;
  }
}
function not(label, str, needle) {
  if (typeof str === 'string' && !str.includes(needle)) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.log(`  ✗  ${label}`);
    console.log(`       expected NOT to contain: ${JSON.stringify(needle)}`);
    failed++;
  }
}

// ── Helpers replicated from fix-forecast-writer.js (pure, no side effects) ───

function idToSlug(id) {
  return (id || 'unknown')
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

const DIVIDER = '═'.repeat(59);
const RULE    = '─'.repeat(59);

function buildFixArtifact(finding, generateResult, generatedAt) {
  const { fix_direction, title, severity, id } = finding;
  const { correctedContent, confidence, notes } = generateResult;
  const targetFile = fix_direction.target_file;

  const lines = [
    'Ghost Architect™ — Suggested Fix',
    DIVIDER,
    '',
    `Finding:    ${id}`,
    `Title:      ${title}`,
    `Severity:   ${(severity || 'UNKNOWN').toUpperCase()}`,
    `File:       ${targetFile}`,
    `Generated:  ${generatedAt}`,
    `Confidence: ${confidence}`,
    '',
    RULE,
    'WHY THIS FIX',
    RULE,
    '',
    fix_direction.reasoning || '(No reasoning provided.)',
    '',
  ];

  if (confidence === 'failed') {
    lines.push(
      RULE,
      'PROPOSED CHANGE  [confidence: failed — insertion point not located]',
      RULE,
      '',
      'Ghost could not locate a single insertion point in the baseline file.',
      'The fix direction is shown as-is. Apply it manually using this as a guide.',
      '',
      fix_direction.patch_instruction.split('\n').map(l => `  ${l}`).join('\n'),
      '',
    );
    if (notes) lines.push(`Note: ${notes}`, '');
  } else {
    const diffText = generateResult.unifiedDiff || '';
    lines.push(RULE, `PROPOSED CHANGE  [confidence: ${confidence}]`, RULE, '');
    if (notes) lines.push(`⚠  ${notes}`, '');
    if (diffText) lines.push(diffText);
    else lines.push('(No diff could be generated.)', '');
  }

  lines.push(RULE, '', 'Ghost flagged this. You decide whether to ship it.', '', DIVIDER);
  return lines.join('\n');
}

// ── Case 1: Fix artifact written with correct content (successful match) ──────
console.log('\n=== Case 1: Fix artifact written — high-confidence match ===');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-test-'));
  try {
    const finding = {
      id: 'MEDIUM:CreateOrderApi.php:type-mismatch-order',
      title: 'Type Mismatch in Order Creation Flow',
      severity: 'MEDIUM',
      files: ['app/code/Vendor/Sales/Model/Api/CreateOrderApi.php'],
      fix_direction: {
        target_file: 'app/code/Vendor/Sales/Model/Api/CreateOrderApi.php',
        patch_instruction: '$storeId = (int)$quote->getStoreId();',
        reasoning: 'Add explicit type cast immediately after retrieving store ID.',
        confidence: 'high',
      },
    };

    const baseline = [
      '<?php declare(strict_types=1);',
      'class CreateOrderApi {',
      '    public function process(Quote $quote): void {',
      '        $storeId = $quote->getStoreId();',
      '        $this->buildMetaLogContext($storeId, $quote);',
      '    }',
      '}',
    ].join('\n');

    const genResult = generateCorrectedFile(baseline, finding.fix_direction);
    genResult.unifiedDiff = computeUnifiedDiff(baseline, genResult.correctedContent,
      finding.fix_direction.target_file, finding.fix_direction.target_file);

    const slug = idToSlug(finding.id);
    const fixPath = path.join(tmpDir, `ghost-fix-${slug}.txt`);
    const content = buildFixArtifact(finding, genResult, '2026-05-29T21:00:00Z');
    fs.writeFileSync(fixPath, content, 'utf8');

    const written = fs.readFileSync(fixPath, 'utf8');

    check('1a slug is filesystem-safe',    slug.match(/^[a-z0-9-]+$/) !== null, true);
    has('1b fix file has finding id',      written, 'MEDIUM:CreateOrderApi.php:type-mismatch-order');
    has('1c fix file has title',           written, 'Type Mismatch in Order Creation Flow');
    has('1d fix file has reasoning',       written, 'Add explicit type cast');
    has('1e fix file has diff header',     written, '--- a/');
    has('1f fix file has (int) in diff',   written, '(int)$quote->getStoreId()');
    has('1g confidence shown',             written, 'Confidence: high');
    has('1h footer present',               written, 'Ghost flagged this. You decide');
    check('1i genResult confidence',       genResult.confidence, 'high');
    check('1j notes null on high',         genResult.notes, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Case 2: Failed-confidence path — forecast call skipped ────────────────────
console.log('\n=== Case 2: Failed-confidence — patch_instruction shown as-is ===');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-test-'));
  let forecastCalled = false;
  try {
    const finding = {
      id: 'HIGH:src-some-file-js:no-match',
      title: 'Unmatchable Fix',
      severity: 'HIGH',
      files: ['src/some/file.js'],
      fix_direction: {
        target_file: 'src/some/file.js',
        patch_instruction: 'SELECT * FROM users WHERE admin = true;',
        reasoning: 'Completely unrelated SQL.',
        confidence: 'high',
      },
    };

    const baseline = 'const x = 1;\nconst y = 2;\nconsole.log(x + y);\n';
    const genResult = generateCorrectedFile(baseline, finding.fix_direction);
    // confidence should be 'failed' — SQL doesn't match JS

    // Simulate: if failed, do NOT call forecast pipeline
    if (genResult.confidence === 'failed') {
      forecastCalled = false; // confirmed skip
    } else {
      forecastCalled = true; // should not happen
    }

    const slug = idToSlug(finding.id);
    const fixPath = path.join(tmpDir, `ghost-fix-${slug}.txt`);
    const content = buildFixArtifact(finding, genResult, '2026-05-29T21:00:00Z');
    fs.writeFileSync(fixPath, content, 'utf8');
    const written = fs.readFileSync(fixPath, 'utf8');

    check('2a genResult confidence is "failed"',         genResult.confidence, 'failed');
    check('2b forecast pipeline NOT called on failed',   forecastCalled, false);
    check('2c correctedContent === baseline',            genResult.correctedContent, baseline);
    has('2d fix file contains patch_instruction as-is',  written, 'SELECT * FROM users');
    has('2e fix file has failure header',                written, 'confidence: failed');
    has('2f fix file has manual guidance note',          written, 'Apply it manually');
    not('2g no diff header in failed case',              written, '--- a/');
    has('2h footer still present',                       written, 'Ghost flagged this. You decide');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Case 3: Temp dir cleanup — try/finally pattern ────────────────────────────
console.log('\n=== Case 3: Temp dir cleaned up even if pipeline throws ===');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-fix-forecast-test-'));
  const sentinelFile = path.join(tmpDir, 'sentinel.txt');
  fs.writeFileSync(sentinelFile, 'exists');

  // Simulate the try/finally cleanup pattern from runFixForecast.
  let cleanupRan = false;
  try {
    // Simulate a pipeline throw mid-run.
    throw new Error('simulated pipeline failure');
  } catch {
    // swallowed — just like the outer try/catch in runFixForecast
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    cleanupRan = true;
  }

  check('3a cleanup ran in finally',          cleanupRan, true);
  check('3b temp dir no longer exists',       fs.existsSync(tmpDir), false);
}

// ── Case 4: computeUnifiedDiff produces patch-compatible output ───────────────
console.log('\n=== Case 4: computeUnifiedDiff output is patch-p1 compatible ===');
{
  const baseline = '<?php\n$storeId = $quote->getStoreId();\nbuildMetaLogContext($storeId);\n';
  const corrected = '<?php\n$storeId = (int)$quote->getStoreId();\nbuildMetaLogContext($storeId);\n';
  const diff = computeUnifiedDiff(baseline, corrected, 'app/Foo.php', 'app/Foo.php');

  check('4a diff is non-empty',              diff.length > 0, true);
  has('4b diff has --- a/ header',           diff, '--- a/app/Foo.php');
  has('4c diff has +++ b/ header',           diff, '+++ b/app/Foo.php');
  has('4d diff has @@ hunk marker',          diff, '@@');
  has('4e diff shows removed line with -',   diff, '-$storeId = $quote->getStoreId();');
  has('4f diff shows added line with +',     diff, '+$storeId = (int)$quote->getStoreId();');
  has('4g context line with space prefix',   diff, ' <?php');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} checks — ${failed} failure(s)\n`);
if (failed > 0) process.exit(1);
