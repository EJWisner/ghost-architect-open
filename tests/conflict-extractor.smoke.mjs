/**
 * Smoke tests for extractCandidates in src/core/conflict.js
 *
 * The pre-fix extractCandidates pulled fix-step bullets from "Resolution:"
 * sections as if they were top-level conflict findings. On small codebases the
 * model produces lots of fix recommendations, so the candidate list became
 * dominated by recommendation prose like "Update both functions to reference
 * this constant" — which the verifier can't classify because those aren't
 * conflict claims, they're fix instructions.
 *
 * These tests use synthetic fixtures matching the model output shape that
 * triggered the bug today, plus historic real reports as smoke confirmation.
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

// Test 1: Synthetic — fix-step bullets inside Resolution should NOT become candidates
console.log('Test 1: Resolution fix-steps are NOT extracted as candidates');
{
  const raw = `1. **DEFAULT_TAX_RATE_DRIFT** — Tax rate inconsistency between checkout and pricing

**Severity:** MEDIUM
**Files:** index.js, pricing.js
**Description:** Two different default tax rates exist.

**Resolution:**
1. Define a single source of truth for the default tax rate as a constant
2. Update both functions to reference this constant
3. Choose 0.08 as the canonical value (since checkout() is the primary entry)

---

2. **DISCOUNT_CALCULATION_MISMATCH** — Hardcoded discount percentages

**Severity:** MEDIUM
**Files:** pricing.js
**Description:** Discount codes use fragile mapping.

**Resolution:**
1. Extract discount definitions to a constant map
2. Make the percentage explicit
`;
  const candidates = extractCandidates(raw);
  check('candidate count is 2 (not 7)', candidates.length, 2);
  check('first candidate title', candidates[0]?.title, 'DEFAULT_TAX_RATE_DRIFT \u2014 Tax rate inconsistency between checkout and pricing');
  check('second candidate title', candidates[1]?.title, 'DISCOUNT_CALCULATION_MISMATCH \u2014 Hardcoded discount percentages');
  check('first severity', candidates[0]?.severity, 'MEDIUM');
  check('first files',    candidates[0]?.files, ['index.js', 'pricing.js']);
}
console.log('');

// Test 2: Pre-fix bug regression — imperative-verb titles get filtered
console.log('Test 2: Imperative-verb titles are filtered as backstop');
{
  const raw = `1. **REAL_CONFLICT** — A genuine architecture mismatch

**Severity:** HIGH
**Files:** foo.js

1. Update both functions to reference this constant
2. Add input validation
3. Extract magic numbers
4. Implement validation at boundaries
`;
  const candidates = extractCandidates(raw);
  check('only 1 candidate (real one)', candidates.length, 1);
  check('candidate title is real conflict', candidates[0]?.title, 'REAL_CONFLICT \u2014 A genuine architecture mismatch');
}
console.log('');

// Test 3: Bold markdown variants don't break extraction
console.log('Test 3: Bold markdown variants');
{
  const cases = [
    [
      '1. **CONFLICT_A** — Title with bold\n**Severity:** CRITICAL\n**Files:** a.js',
      { title: 'CONFLICT_A \u2014 Title with bold', severity: 'CRITICAL', files: ['a.js'] }
    ],
    [
      '1. CONFLICT_B — Plain title\nSeverity: HIGH\nFiles: b.js',
      { title: 'CONFLICT_B \u2014 Plain title', severity: 'HIGH', files: ['b.js'] }
    ],
    [
      '1. **CONFLICT_C** — Backticked files\n**Severity:** MEDIUM\n**Files:** `c.js`, `d.js`',
      { title: 'CONFLICT_C \u2014 Backticked files', severity: 'MEDIUM', files: ['c.js', 'd.js'] }
    ],
  ];
  for (const [raw, expected] of cases) {
    const candidates = extractCandidates(raw);
    check('count for ' + JSON.stringify(raw.slice(0, 30)), candidates.length, 1);
    if (candidates.length === 1) {
      check('  title',    candidates[0].title,    expected.title);
      check('  severity', candidates[0].severity, expected.severity);
      check('  files',    candidates[0].files,    expected.files);
    }
  }
}
console.log('');

// Test 4: Multi-pass output (array of pass results)
console.log('Test 4: Array input from multi-pass scan');
{
  const passes = [
    `1. **PASS_1_CONFLICT** — From pass 1\n**Severity:** HIGH\n**Files:** a.js`,
    `1. **PASS_2_CONFLICT** — From pass 2\n**Severity:** MEDIUM\n**Files:** b.js`,
  ];
  const candidates = extractCandidates(passes);
  // Note: candidate numbers reset between passes (both start with "1."), so
  // dedup-by-title-prefix should keep them as distinct (different prefixes).
  check('candidate count is 2', candidates.length, 2);
}
console.log('');

// Test 5: Section header detection variants
console.log('Test 5: Various fix-section headers should suppress numbered items');
{
  const variants = [
    'Resolution:',
    'Recommended Fix:',
    'Recommended fix:',
    'Fix Steps:',
    'What to do:',
    'How to fix:',
    'How to resolve:',
    'Remediation:',
    'Action items:',
    'Next steps:',
    'To resolve:',
    'To fix:',
  ];
  for (const header of variants) {
    const raw = `1. **THE_CONFLICT** — Real conflict
**Severity:** HIGH
**Files:** foo.js

${header}
1. First fix step that should NOT be a candidate
2. Second fix step that should NOT be a candidate
`;
    const candidates = extractCandidates(raw);
    check('header "' + header + '" suppresses fix-step bullets', candidates.length, 1);
  }
}
console.log('');

// Test 6: Markdown header (## or ###) ends the fix section
console.log('Test 6: Markdown header ends fix section');
{
  const raw = `1. **FIRST_CONFLICT**
**Severity:** HIGH

Resolution:
1. Fix step one
2. Fix step two

## Section Header

1. **SECOND_CONFLICT**
**Severity:** MEDIUM
**Files:** bar.js
`;
  const candidates = extractCandidates(raw);
  check('count is 2 (markdown header reset)', candidates.length, 2);
  check('first title',  candidates[0]?.title, 'FIRST_CONFLICT');
  check('second title', candidates[1]?.title, 'SECOND_CONFLICT');
}
console.log('');

// Test 7: Real historic data from a working v5.0.0 conflict scan output
// This is a synthetic approximation of what the model produced on April 27.
// The structure is "C-001:" style with bold severity badges and structured sections.
console.log('Test 7: Historic v5.0.0 conflict-scan output shape');
{
  const raw = `Performing a full conflict detection scan of this 24-file codebase.

1. **REACT_VERSION_PEER_DEPENDENCY** — React Version Peer Dependency Conflict

**Severity:** MEDIUM
**Files:** package.json
**Description:** React 19.1.0 is installed alongside React Native 0.81.5.

**Impact:** Runtime errors in navigation.

**Fix:**
1. Downgrade to React 18.2.0
2. Update peer dependencies

---

2. **MISSING_RETRY_LOGIC** — Missing Retry Logic on GitHub API Calls

**Severity:** MEDIUM
**Files:** services/GitHubService.ts
**Description:** No retry logic on transient failures.

**Fix:**
1. Wrap fetchWithTimeout with exponential backoff
2. Add circuit breaker

---

3. **PRESENTATION_LAYER_PERSISTENCE** — Presentation Layer Persistence Violation

**Severity:** MEDIUM
**Files:** screens/PortfolioScreen.tsx
**Description:** Screen calls AsyncStorage directly.

**Fix:**
1. Move persistence to SettingsService
2. Provide hideProject method
`;
  const candidates = extractCandidates(raw);
  check('count is 3 (not 9)', candidates.length, 3);
  checkPredicate('first candidate title contains REACT', candidates[0]?.title, t => t && t.includes('REACT_VERSION'), 'should contain REACT_VERSION');
  checkPredicate('second candidate title contains MISSING_RETRY', candidates[1]?.title, t => t && t.includes('MISSING_RETRY'), 'should contain MISSING_RETRY');
  checkPredicate('third candidate title contains PRESENTATION', candidates[2]?.title, t => t && t.includes('PRESENTATION'), 'should contain PRESENTATION');
}
console.log('');

// Summary
if (failures > 0) {
  console.log('FAILED \u2014 ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED \u2014 all assertions ok');
  process.exit(0);
}
