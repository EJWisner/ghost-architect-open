/**
 * Smoke tests for extractCandidates JSON parser in src/core/conflict.js (Phase J).
 *
 * All fixtures are inline JSON code fences — the format the new parser expects.
 * Each test asserts the same properties as the original markdown-fixture version.
 *
 * Run: node tests/conflict-extractor.smoke.mjs
 */

import { extractCandidates } from '../src/core/conflict.js';

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

function jsonFence(obj) {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

// Test 1: Two findings in one fence — both extracted, correct count
console.log('Test 1: Two findings in one JSON fence');
{
  const raw = jsonFence({ conflicts: [
    {
      title: 'DEFAULT_TAX_RATE_DRIFT — Tax rate inconsistency between checkout and pricing',
      severity: 'MEDIUM',
      files: ['index.js', 'pricing.js'],
      description: 'Side A: checkout uses 0.08. Side B: pricing uses 0.05. Impact: revenue errors. Resolution: define shared TAX_RATE constant.',
    },
    {
      title: 'DISCOUNT_CALCULATION_MISMATCH — Hardcoded discount percentages',
      severity: 'MEDIUM',
      files: ['pricing.js'],
      description: 'Discount codes use fragile hardcoded mapping. Resolution: extract to constant map.',
    },
  ]});
  const candidates = extractCandidates(raw);
  check('candidate count is 2', candidates.length, 2);
  checkPredicate('first candidate title contains DEFAULT_TAX_RATE_DRIFT', candidates[0]?.title, t => t && t.includes('DEFAULT_TAX_RATE_DRIFT'), 'should contain DEFAULT_TAX_RATE_DRIFT');
  checkPredicate('second candidate title contains DISCOUNT_CALCULATION_MISMATCH', candidates[1]?.title, t => t && t.includes('DISCOUNT_CALCULATION_MISMATCH'), 'should contain DISCOUNT_CALCULATION_MISMATCH');
  check('first severity', candidates[0]?.severity, 'MEDIUM');
  check('first files',    candidates[0]?.files, ['index.js', 'pricing.js']);
}
console.log('');

// Test 2: Single real finding — correct extraction
console.log('Test 2: Single real finding extracted');
{
  const raw = jsonFence({ conflicts: [
    {
      title: 'REAL_CONFLICT — A genuine architecture mismatch',
      severity: 'HIGH',
      files: ['foo.js'],
      description: 'Side A expects X, Side B expects Y. Impact: crash. Resolution: unify.',
    },
  ]});
  const candidates = extractCandidates(raw);
  check('only 1 candidate', candidates.length, 1);
  checkPredicate('candidate title contains REAL_CONFLICT', candidates[0]?.title, t => t && t.includes('REAL_CONFLICT'), 'should contain REAL_CONFLICT');
}
console.log('');

// Test 3: Severity normalization for all valid values
console.log('Test 3: Severity normalization');
{
  const cases = [
    { severity: 'CRITICAL', expected: 'CRITICAL' },
    { severity: 'HIGH',     expected: 'HIGH'     },
    { severity: 'MEDIUM',   expected: 'MEDIUM'   },
    { severity: 'LOW',      expected: 'LOW'      },
    { severity: 'bogus',    expected: 'MEDIUM'   },  // defaults to MEDIUM
    { severity: '',         expected: 'MEDIUM'   },  // defaults to MEDIUM
  ];
  for (const { severity, expected } of cases) {
    const raw = jsonFence({ conflicts: [{ title: 'Test Finding', severity, files: ['a.js'], description: 'desc' }] });
    const candidates = extractCandidates(raw);
    check(`severity "${severity}" → "${expected}"`, candidates[0]?.severity, expected);
  }
}
console.log('');

// Test 4: Multi-pass array input — both fences contribute candidates
console.log('Test 4: Array input from multi-pass scan');
{
  const pass1 = jsonFence({ conflicts: [{ title: 'PASS_1_CONFLICT — From pass 1', severity: 'HIGH',   files: ['a.js'], description: 'desc' }] });
  const pass2 = jsonFence({ conflicts: [{ title: 'PASS_2_CONFLICT — From pass 2', severity: 'MEDIUM', files: ['b.js'], description: 'desc' }] });
  const candidates = extractCandidates([pass1, pass2]);
  check('candidate count is 2', candidates.length, 2);
  checkPredicate('pass 1 finding present', candidates, cs => cs.some(c => c.title?.includes('PASS_1_CONFLICT')), 'should include PASS_1_CONFLICT');
  checkPredicate('pass 2 finding present', candidates, cs => cs.some(c => c.title?.includes('PASS_2_CONFLICT')), 'should include PASS_2_CONFLICT');
}
console.log('');

// Test 5: Empty conflicts array → zero candidates
console.log('Test 5: Empty conflicts array produces zero candidates');
{
  const raw = jsonFence({ conflicts: [] });
  const candidates = extractCandidates(raw);
  check('zero candidates from empty array', candidates.length, 0);
}
console.log('');

// Test 6: fix_direction populated and null cases
console.log('Test 6: fix_direction populated vs null');
{
  const raw = jsonFence({ conflicts: [
    {
      title: 'Finding With Fix Direction',
      severity: 'HIGH',
      files: ['src/core/verifier.js'],
      description: 'desc',
      fix_direction: {
        target_files: ['src/core/verifier.js'],
        patch_instruction: 'const x = 1;\nreturn x;',
        reasoning: 'unify constant',
        confidence: 'high',
      },
    },
    {
      title: 'Finding Without Fix Direction',
      severity: 'MEDIUM',
      files: ['src/core/multipass.js'],
      description: 'prose-only resolution, no surgical patch available',
      // no fix_direction
    },
  ]});
  const candidates = extractCandidates(raw);
  check('count is 2', candidates.length, 2);
  const withFix    = candidates.find(c => c.title?.includes('With Fix'));
  const withoutFix = candidates.find(c => c.title?.includes('Without Fix'));
  check('with fix_direction: non-null',    withFix?.fix_direction !== null && withFix?.fix_direction !== undefined, true);
  check('without fix_direction: null',     withoutFix?.fix_direction, null);
  if (withFix?.fix_direction) {
    check('target_files populated', withFix.fix_direction.target_files?.length > 0, true);
    checkPredicate('patch_instruction non-empty', withFix.fix_direction.patch_instruction, p => typeof p === 'string' && p.length > 0, 'should be non-empty string');
    check('confidence is high', withFix.fix_direction.confidence, 'high');
  }
}
console.log('');

// Test 7: Dedup by title prefix — near-duplicate titles collapsed
console.log('Test 7: Dedup by title prefix (first 40 chars)');
{
  const raw = jsonFence({ conflicts: [
    { title: 'REACT_VERSION_PEER_DEPENDENCY — React Version Peer Dependency Conflict First',  severity: 'MEDIUM', files: ['package.json'],  description: 'desc1' },
    { title: 'REACT_VERSION_PEER_DEPENDENCY — React Version Peer Dependency Conflict Second', severity: 'LOW',    files: ['package.lock'], description: 'desc2' },
    { title: 'MISSING_RETRY_LOGIC — Missing Retry Logic on GitHub API Calls',                 severity: 'MEDIUM', files: ['GitHubService.ts'], description: 'desc3' },
    { title: 'PRESENTATION_LAYER_PERSISTENCE — Presentation Layer Persistence Violation',     severity: 'MEDIUM', files: ['PortfolioScreen.tsx'], description: 'desc4' },
  ]});
  const candidates = extractCandidates(raw);
  // Two REACT_VERSION findings share "react_version_peer_dependency — react " (40 chars) → deduped
  // Three distinct findings total
  check('count is 3 (one REACT deduped)', candidates.length, 3);
  checkPredicate('REACT finding present',        candidates, cs => cs.some(c => c.title?.includes('REACT_VERSION')),         'should include REACT_VERSION');
  checkPredicate('MISSING_RETRY finding present',candidates, cs => cs.some(c => c.title?.includes('MISSING_RETRY')),         'should include MISSING_RETRY');
  checkPredicate('PRESENTATION finding present', candidates, cs => cs.some(c => c.title?.includes('PRESENTATION')),          'should include PRESENTATION');
}
console.log('');

// Test 8: Files array preserved exactly
console.log('Test 8: Files array preserved');
{
  const files = ['src/services/GitHubService.ts', 'src/screens/PortfolioScreen.tsx', 'src/core/verifier.js'];
  const raw = jsonFence({ conflicts: [{ title: 'Multi File Conflict', severity: 'HIGH', files, description: 'desc' }] });
  const candidates = extractCandidates(raw);
  check('count is 1', candidates.length, 1);
  check('files match exactly', candidates[0]?.files, files);
}
console.log('');

// Test 9: Malformed JSON fence is skipped gracefully, valid fence still parsed
console.log('Test 9: Malformed JSON fence skipped, valid fence parsed');
{
  const bad  = '```json\n{ this is not valid json }\n```';
  const good = jsonFence({ conflicts: [{ title: 'Valid Conflict', severity: 'HIGH', files: ['src/good.js'], description: 'desc' }] });
  const candidates = extractCandidates(bad + '\n\n' + good);
  check('count is 1 (bad fence skipped, good fence parsed)', candidates.length, 1);
  checkPredicate('valid finding present', candidates, cs => cs.some(c => c.title?.includes('Valid Conflict')), 'should include Valid Conflict');
}
console.log('');

// Summary
if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
