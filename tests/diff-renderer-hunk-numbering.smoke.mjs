import { computeUnifiedDiff } from '../src/utils/diff-renderer.js';
import assert from 'node:assert/strict';

// Regression fixture for the leading-offset underflow bug.
// A diff whose first change is deep in the file used to emit @@ -1,... @@
// (wrong) instead of the correct line number. This fixture structurally
// requires i0 > 0 (the bug's precondition) so it cannot silently miss the fix.

// Build a 30-line "original" file and a "modified" file that changes lines 18 and 25.
const CONTEXT = 2; // must match CONTEXT_LINES in src/utils/diff-renderer.js

function makeLines(n) {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`);
}

const original = makeLines(30);
const modified = [...original];
modified[17] = 'line 18 CHANGED'; // 0-indexed → line 18
modified[24] = 'line 25 CHANGED'; // 0-indexed → line 25

const diff = computeUnifiedDiff(original.join('\n'), modified.join('\n'));

// The first hunk should start at line 18 - CONTEXT = 16
// The second hunk should start at line 25 - CONTEXT = 23
const lines = diff.split('\n').filter(l => l.startsWith('@@'));

assert.ok(lines.length >= 2, `Expected at least 2 @@ headers, got: ${lines.length}\nFull diff:\n${diff}`);

// First hunk: @@ -15,... +15,... @@
const firstMatch = lines[0].match(/@@ -(\d+),/);
assert.ok(firstMatch, `Could not parse first @@ header: ${lines[0]}`);
const firstAStart = parseInt(firstMatch[1], 10);
assert.equal(firstAStart, 18 - CONTEXT,
  `First hunk should start at line ${18 - CONTEXT} but got ${firstAStart}.\nThis indicates the leading-offset underflow bug is present.\nFull diff:\n${diff}`);

// Second hunk: @@ -22,... +22,... @@
const secondMatch = lines[1].match(/@@ -(\d+),/);
assert.ok(secondMatch, `Could not parse second @@ header: ${lines[1]}`);
const secondAStart = parseInt(secondMatch[1], 10);
assert.equal(secondAStart, 25 - CONTEXT,
  `Second hunk should start at line ${25 - CONTEXT} but got ${secondAStart}.\nFull diff:\n${diff}`);

console.log('diff-renderer hunk numbering: PASS');
console.log(`  First hunk start:  ${firstAStart} (expected ${18 - CONTEXT})`);
console.log(`  Second hunk start: ${secondAStart} (expected ${25 - CONTEXT})`);
