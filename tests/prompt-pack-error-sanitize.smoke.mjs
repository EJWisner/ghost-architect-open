/**
 * Smoke tests for src/prompt-pack/index.js detector-crash sanitization.
 *
 * When a detector throws, runAll() catches it and emits a synthetic
 * LOW-severity "Detector crashed" finding. The raw err.message used to
 * be embedded verbatim, which is an XSS / injection risk once the
 * finding renders in a web portal or exports to an issue tracker. These
 * tests lock in the fix: the message is HTML-escaped, tag-stripped,
 * whitespace-collapsed, and truncated, while the full unsanitized error
 * still goes to stderr for debugging.
 *
 * Run: node tests/prompt-pack-error-sanitize.smoke.mjs
 */

import { sanitizeErrorMessage, runAll } from '../src/prompt-pack/index.js';

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

function checkContains(label, value, substring) {
  if (typeof value === 'string' && value.includes(substring)) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected to contain: ' + JSON.stringify(substring));
    console.log('       got:                 ' + JSON.stringify(value));
    failures++;
  }
}

function checkNotContains(label, value, substring) {
  if (typeof value === 'string' && !value.includes(substring)) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected NOT to contain: ' + JSON.stringify(substring));
    console.log('       got:                     ' + JSON.stringify(value));
    failures++;
  }
}

// Test 1: HTML/script payloads are neutralized
console.log('Test 1: malicious payloads are stripped and escaped');
{
  const xss = sanitizeErrorMessage('<script>alert(1)</script>');
  // The <script> tags are removed; the inner text survives, escaped.
  checkNotContains('no raw <script tag', xss, '<script');
  checkNotContains('no raw < bracket', xss, '<');
  checkNotContains('no raw > bracket', xss, '>');
  checkContains('inner text preserved', xss, 'alert(1)');

  const img = sanitizeErrorMessage('<img src=x onerror=alert(1)>');
  check('tag-only payload fully stripped', img, '');

  // A paired <...> span is treated as a tag and stripped wholesale (safe
  // over-removal): "5 < 10 and 10 > 5" loses the bracketed span.
  const paired = sanitizeErrorMessage('value 5 < 10 and 10 > 5');
  checkNotContains('paired span has no raw <', paired, '<');
  checkNotContains('paired span has no raw >', paired, '>');

  // Unpaired angle brackets (no matching close) survive stripping and
  // must be escaped, never left raw.
  const lt = sanitizeErrorMessage('a < b');
  checkContains('unpaired lt escaped', lt, '&lt;');
  checkNotContains('lt has no raw <', lt, '<');
  const gt = sanitizeErrorMessage('a > b');
  checkContains('unpaired gt escaped', gt, '&gt;');
  checkNotContains('gt has no raw >', gt, '>');

  // Quotes and ampersands escaped for attribute-context safety.
  const quotes = sanitizeErrorMessage(`he said "hi" & it's 'fine'`);
  checkContains('double quote escaped', quotes, '&quot;');
  checkContains('ampersand escaped', quotes, '&amp;');
  checkContains('single quote escaped', quotes, '&#39;');
  checkNotContains('no raw double quote', quotes, '"');
}
console.log('');

// Test 2: truncation to the 200-char budget
console.log('Test 2: long messages truncated');
{
  const long = sanitizeErrorMessage('A'.repeat(500));
  // 200 visible chars + the ellipsis marker.
  check('truncated length', long.length, 201);
  checkContains('ellipsis appended', long, '…');

  const short = sanitizeErrorMessage('short message');
  check('short message untouched', short, 'short message');
  checkNotContains('no ellipsis on short', short, '…');
}
console.log('');

// Test 3: whitespace collapse and non-string inputs
console.log('Test 3: whitespace collapse and edge inputs');
{
  const multiline = sanitizeErrorMessage('line one\n\tline two\n  line three');
  check('whitespace collapsed', multiline, 'line one line two line three');

  check('null becomes empty', sanitizeErrorMessage(null), '');
  check('undefined becomes empty', sanitizeErrorMessage(undefined), '');
  check('number coerced', sanitizeErrorMessage(42), '42');
}
console.log('');

// Test 4: end-to-end through runAll — a crashing detector yields a
// sanitized synthetic finding, and the raw error still hits stderr.
console.log('Test 4: runAll synthetic finding is sanitized');
{
  // Passing a non-string promptText makes the Tier 1 detectors throw
  // (e.g. promptText.split is not a function), exercising the catch path.
  // Skip Tier 2/3 so no live API calls are made.
  let stderrCapture = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrCapture += String(chunk); return true; };

  let findings;
  try {
    findings = await runAll(42, 'evil.txt', { skipTiers: [2, 3], verbose: true });
  } finally {
    process.stderr.write = originalWrite;
  }

  const crashFindings = findings.filter(f => /\/internal-error$/.test(f.detector));
  check('at least one crash finding produced', crashFindings.length > 0, true);

  if (crashFindings.length > 0) {
    const detail = crashFindings[0].detail;
    checkContains('detail notes sanitization', detail, 'error message sanitized');
    checkNotContains('detail has no raw <', detail, '<');
    checkNotContains('detail has no raw >', detail, '>');
    checkContains('stderr received raw error', stderrCapture, 'crashed:');
  }
}
console.log('');

if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
