/**
 * Smoke tests for src/utils/finding-parser.js
 *
 * Tests the bug variants that were silently failing in v5.0.0 and earlier:
 * - `**Severity:** HIGH` (bold field with colon-inside-bold) — was returning
 *   wrong severity (defaulting to section header)
 * - `**Files:** \`pricing.js\`` — was capturing trailing `**` as part of the
 *   path, leaving values like `"** pricing.js"` that failed verification
 * - `**Effort:** 1-2 hours` — was returning 0 because regex required `hrs?`
 *   not `hours?`
 * - Body text containing word "files" — was hijacking the file list because
 *   FILES_RE wasn't anchored to start of line
 * - Severity with emoji indicator (`Severity: 🟠 HIGH`) — was failing because
 *   regex used `\s*` between colon and severity word, not allowing emoji
 *
 * Run: node tests/finding-parser.smoke.mjs
 *
 * Returns exit code 0 on all-pass, 1 on any failure.
 */

import { extractFindings, stripBoldMarkdown } from '../src/utils/finding-parser.js';

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

// Test 1: stripBoldMarkdown helper
console.log('Test 1: stripBoldMarkdown');
check('strips **',         stripBoldMarkdown('**Hello**'),  'Hello');
check('strips * (italic)', stripBoldMarkdown('*Hello*'),    'Hello');
check('mixed forms',       stripBoldMarkdown('**a*b**c'),    'abc');
check('no markdown',       stripBoldMarkdown('plain text'), 'plain text');
console.log('');

// Test 2: Severity extraction with all bolding variants
console.log('Test 2: Severity extraction');
{
  const cases = [
    ['**Severity:** CRITICAL',        'CRITICAL'],
    ['**Severity:** HIGH',            'HIGH'],
    ['**Severity:** MEDIUM',          'MEDIUM'],
    ['**Severity:** LOW',             'LOW'],
    ['**Severity:** **HIGH**',        'HIGH'],
    ['**Severity**: HIGH',            'HIGH'],
    ['Severity: HIGH',                'HIGH'],
    ['**Severity:** \u{1F7E0} HIGH',  'HIGH'],
    ['**Severity:** \u{1F534} **CRITICAL**', 'CRITICAL'],
  ];
  for (const [input, expectedSev] of cases) {
    const text = '## Critical Section\n\n### 1. Test Finding\n\n' + input + '\n**Files:** `foo.js`\n**Effort:** 1-2 hrs\n\nBody text.\n';
    const findings = extractFindings(text);
    check(JSON.stringify(input), findings[0]?.severity, expectedSev);
  }
}
console.log('');

// Test 3: Files extraction
console.log('Test 3: Files extraction');
{
  const cases = [
    ['**Files:** `pricing.js`',                              ['pricing.js']],
    ['**Files:** `a.js`, `b.js`',                            ['a.js', 'b.js']],
    ['**Files:** **bolded.js**',                             ['bolded.js']],
    ['Files: pricing.js',                                    ['pricing.js']],
    ['**Files**: pricing.js',                                ['pricing.js']],
    ['**Files:** `src/foo.js`, `src/bar.js`, `src/baz.js`', ['src/foo.js', 'src/bar.js', 'src/baz.js']],
  ];
  for (const [input, expectedFiles] of cases) {
    const text = '## Critical Section\n\n### 1. Test Finding\n\n**Severity:** HIGH\n' + input + '\n\nBody text.\n';
    const findings = extractFindings(text);
    check(JSON.stringify(input), findings[0]?.files, expectedFiles);
  }
}
console.log('');

// Test 4: Body text hijack (the FILES_RE anchor bug)
console.log('Test 4: Body text containing "files" should NOT hijack file list');
{
  const text =
    '## Critical Section\n\n' +
    '### 1. Test Finding\n\n' +
    '**Severity:** HIGH\n' +
    '**Files:** `pricing.js`\n' +
    '\n' +
    'Both files have the issue. These files share a common dependency.\n';
  const findings = extractFindings(text);
  check('files unaffected by body text', findings[0]?.files, ['pricing.js']);
}
console.log('');

// Test 5: Effort extraction (returns upper bound of range)
console.log('Test 5: Effort extraction (returns upper bound of range)');
{
  const cases = [
    ['**Effort:** 1-2 hrs',     2],
    ['**Effort:** 1-2 hours',   2],
    ['**Effort:** 1\u20132 hours', 2],
    ['**Effort:** 0.5-1 hours', 1],
    ['Effort: 2-3 hrs',         3],
    ['**Effort:** 1-2 hrs | **Complexity:** Medium', 2],
  ];
  for (const [input, expectedEffort] of cases) {
    const text = '## Critical Section\n\n### 1. Test Finding\n\n**Severity:** HIGH\n**Files:** `foo.js`\n' + input + '\n\nBody text.\n';
    const findings = extractFindings(text);
    check(JSON.stringify(input), findings[0]?.effortHours, expectedEffort);
  }
}
console.log('');

// Test 7: F-26 regression — fix-step numbered list must NOT become findings
console.log('Test 7: F-26 regression — fix steps are not findings');
{
  // This fixture mirrors the actual SYSTEM_POI output format the model
  // emits: ### Title headers for findings, with **Recommended Fix:** sections
  // containing numbered lists for the fix steps. Before F-26, the analyst
  // and compare parsers anchored on /^\d+\.\s+/ which extracted EVERY
  // fix-step bullet as a finding — producing 29 fake findings on a real
  // 8-finding report. The canonical parser correctly anchors on `### Title`
  // headers and skips numbered lists.
  const text = `## \u{1F534} Critical Findings

### Redactor Returns Unredacted Context When Rules Fail

**Severity:** CRITICAL
**Files:** \`src/redactor.js\`
**Effort:** 1-2 hours

When the redactor encounters an unparseable rule it falls through silently.

**Recommended Fix:**
1. Change \`redactCodebase\` to throw when redaction fails completely.
2. Add a \`--force-unredacted\` flag for cases where the consultant explicitly wants to proceed.
3. In modes that call redactCodebase, check result.partialRedaction and prompt the user.

**Fix Priority:** 1

### Silent Tier Downgrade on Invalid Tier String

**Severity:** HIGH
**Files:** \`src/loader/tierCaps.js\`
**Effort:** 0.5-1 hour

Invalid tier strings silently fall back to Open tier without warning.

**Recommended Fix:**
1. Add a validation check at the top of resolveContextCap.
2. Log a warning when falling back to Open.
3. Export a VALID_TIERS constant.
`;
  const findings = extractFindings(text);
  check('finding count is 2 (not 6 from fix-step bullets)',
    findings.length, 2);
  check('finding 1 title is the header, not a fix step',
    findings[0]?.title, 'Redactor Returns Unredacted Context When Rules Fail');
  check('finding 2 title is the header, not a fix step',
    findings[1]?.title, 'Silent Tier Downgrade on Invalid Tier String');
  // Negative checks: none of the fix-step verbs should appear as titles
  const titleStartsWithVerb = findings.some(f =>
    /^(Change|Add|In|Log|Export)\s/.test(f.title));
  check('no finding title starts with a fix-step verb',
    titleStartsWithVerb, false);
}
console.log('');

// Test 8: F-26 landmark behavior — keepLandmarks toggles inclusion
console.log('Test 8: F-26 landmark behavior (keepLandmarks toggle)');
{
  const text = `## \u{1F534} Critical

### Critical Bug A

**Severity:** CRITICAL
**Files:** \`a.js\`
**Effort:** 1-2 hours

Description of bug A.

## \u{1F3DB}\uFE0F LANDMARKS

### Two-Pass Narrator Architecture

**Severity:** N/A
**Files:** \`src/core/agent/narrator.js\`

The narrator runs in two passes: first the raw scan, then the rewrite.

### Tier-Gated Context Cap Enforcement

**Severity:** N/A
**Files:** \`src/loader/tierCaps.js\`

Context caps enforce per-tier limits on token budget.

## \u{1F7E0} High

### High Bug B

**Severity:** HIGH
**Files:** \`b.js\`
**Effort:** 2-3 hours

Description of bug B.
`;

  // Default mode: landmarks dropped
  const defaultFindings = extractFindings(text);
  check('default mode finding count (2 non-landmark)',
    defaultFindings.length, 2);
  check('default mode has no LANDMARK severities',
    defaultFindings.some(f => f.severity === 'LANDMARK'), false);

  // Compare mode: landmarks kept with severity LANDMARK
  const keepFindings = extractFindings(text, { keepLandmarks: true });
  check('keepLandmarks=true finding count (2 + 2 landmarks = 4)',
    keepFindings.length, 4);
  const landmarkCount = keepFindings.filter(f => f.severity === 'LANDMARK').length;
  check('keepLandmarks=true has 2 LANDMARK findings',
    landmarkCount, 2);
  // Severity transitions should be correct
  check('keepLandmarks=true: bug B (after landmarks) gets HIGH not LANDMARK',
    keepFindings.find(f => f.title === 'High Bug B')?.severity,
    'HIGH');
}
console.log('');

// Test 6: End-to-end multi-finding fixture
console.log('Test 6: End-to-end multi-finding extraction');
{
  const text = `## \u{1F534} Critical: Security & Data Integrity

### 1. Dual Tax Rate Configuration Drift

**Severity:** CRITICAL
**Files:** \`pricing.js\`
**Effort:** 1-2 hrs

The pricing module has two tax sources.

## \u{1F7E0} High: Architectural Integrity

### 2. Multiple Files Test

**Severity:** HIGH
**Files:** \`src/redactor.js\`, \`src/core/verifier.js\`
**Effort:** 2-3 hrs

Both files have the issue.

## \u{1F7E1} Medium: Functional Correctness

### 3. Bolded Severity Worst Case

**Severity:** \u{1F7E1} **MEDIUM**
**Files:** **edge.js**
**Effort:** 0.5-1 hours

Edge case where filename and severity are both bolded.
`;
  const findings = extractFindings(text);
  check('finding count',  findings.length,           3);
  check('finding 1 sev',  findings[0]?.severity,     'CRITICAL');
  check('finding 1 files', findings[0]?.files,       ['pricing.js']);
  check('finding 2 sev',  findings[1]?.severity,     'HIGH');
  check('finding 2 files', findings[1]?.files,       ['src/redactor.js', 'src/core/verifier.js']);
  check('finding 3 sev',  findings[2]?.severity,     'MEDIUM');
  check('finding 3 files', findings[2]?.files,       ['edge.js']);
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
