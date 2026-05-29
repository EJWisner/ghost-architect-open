// src/utils/diff-renderer.js — Ghost Architect™ Commit Forecast diff display
//
// Renders a human-readable inline diff of proposed vs baseline file content
// for the Commit Forecast mode. Shown BEFORE analysis runs so the developer
// can sanity-check the overlay before burning API budget.
//
// Design constraints:
//   - No external diff library. Uses a simple line-level unified diff algorithm
//     (longest common subsequence via Myers-ish patience approach). Fast enough
//     for typical file sizes (< 5000 lines); not intended for binary or minified
//     files.
//   - Output is terminal-only (chalk). Not included in saved reports.
//   - Hard cap: if a single file diff exceeds MAX_DIFF_LINES, show a summary
//     line count instead of the full diff. Prevents wall-of-text for large files.
//   - Cap on number of files shown in detail: DETAIL_FILE_CAP. Beyond that, list
//     filenames only.

import chalk from 'chalk';
import path  from 'path';

const MAX_DIFF_LINES   = 60;  // max changed lines shown per file before truncating
const DETAIL_FILE_CAP  = 8;   // max files shown with inline diff detail
const CONTEXT_LINES    = 2;   // unchanged lines shown above/below each change block

// ── LCS-based line diff ───────────────────────────────────────────────────────

/**
 * Compute a unified line diff between two strings.
 * Returns an array of { type: 'context'|'add'|'remove', line: string } objects.
 * 
 * Uses a simple patience-diff algorithm (LCS on unique lines). Fast and readable
 * output for code files. Not optimal for pathological inputs but those won't
 * appear in normal codebases.
 */
function computeLineDiff(baselineText, proposedText) {
  const baseLines     = (baselineText || '').split('\n');
  const proposedLines = (proposedText  || '').split('\n');

  // Build LCS table
  const m = baseLines.length;
  const n = proposedLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (baseLines[i - 1] === proposedLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && baseLines[i - 1] === proposedLines[j - 1]) {
      ops.push({ type: 'context', line: baseLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', line: proposedLines[j - 1] });
      j--;
    } else {
      ops.push({ type: 'remove', line: baseLines[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

/**
 * Collapse a full op list to only the changed lines plus CONTEXT_LINES
 * of surrounding context. Returns a compressed array of op objects, with
 * `{ type: 'separator', skipped: N }` markers between non-contiguous hunks.
 */
function collapseToHunks(ops) {
  const changedIndices = new Set();
  ops.forEach((op, idx) => {
    if (op.type !== 'context') changedIndices.add(idx);
  });

  if (changedIndices.size === 0) return [];

  // Expand each changed index by ±CONTEXT_LINES
  const shown = new Set();
  for (const idx of changedIndices) {
    for (let k = Math.max(0, idx - CONTEXT_LINES); k <= Math.min(ops.length - 1, idx + CONTEXT_LINES); k++) {
      shown.add(k);
    }
  }

  const result = [];
  let lastShown = -1;
  for (let i = 0; i < ops.length; i++) {
    if (shown.has(i)) {
      if (lastShown >= 0 && i > lastShown + 1) {
        result.push({ type: 'separator', skipped: i - lastShown - 1 });
      }
      result.push(ops[i]);
      lastShown = i;
    }
  }
  return result;
}

// ── Public renderer ───────────────────────────────────────────────────────────

/**
 * Render a diff summary for the Commit Forecast mode.
 *
 * @param {object} changedFiles     — { modified: string[], added: string[] }
 * @param {object} baselineFileMap  — the original { filePath: content } map
 * @param {object} patchedFileMap   — the overlay { filePath: content } map
 */
export function renderForecastDiff(changedFiles, baselineFileMap, patchedFileMap) {
  const { modified = [], added = [] } = changedFiles;
  const total = modified.length + added.length;

  if (total === 0) return;

  console.log('\n' + chalk.cyan.bold('─── Proposed Changes Detail ─────────────────────────────────────'));
  console.log('');

  let detailCount = 0;

  // ── Modified files ──────────────────────────────────────────────────────
  for (const filePath of modified) {
    const baseline = baselineFileMap[filePath] || '';
    const proposed = patchedFileMap[filePath]  || '';

    if (baseline === proposed) {
      // Identical content — this happens with untracked files where the
      // baseline and working-tree file are the same. Show as a new addition
      // with a content preview rather than skipping silently.
      if (baseline === '') continue; // truly empty, nothing to show
      const lineCount = proposed.split('\n').length;
      console.log(chalk.green(`  + ${path.basename(filePath)}`) + chalk.dim(`  (${path.dirname(filePath)})  [new file, ${lineCount} lines]`));
      if (detailCount < DETAIL_FILE_CAP) {
        const previewLines = proposed.split('\n').slice(0, 8);
        for (const line of previewLines) {
          console.log(chalk.green(`    + ${line}`));
        }
        if (lineCount > 8) console.log(chalk.gray(`    ... ${lineCount - 8} more lines`));
        console.log('');
      }
      detailCount++;
      continue;
    }

    const relPath = Object.keys(baselineFileMap).includes(filePath)
      ? path.basename(filePath)
      : filePath;

    console.log(chalk.yellow(`  ~ ${relPath}`) + chalk.dim(`  (${path.dirname(filePath)})`));

    if (detailCount >= DETAIL_FILE_CAP) {
      console.log(chalk.gray('    (diff detail omitted — file limit reached)\n'));
      continue;
    }

    const ops      = computeLineDiff(baseline, proposed);
    const adds     = ops.filter(o => o.type === 'add').length;
    const removes  = ops.filter(o => o.type === 'remove').length;
    const totalChanged = adds + removes;

    console.log(chalk.gray(`    ${chalk.green('+' + adds)} ${chalk.red('-' + removes)}`));

    if (totalChanged > MAX_DIFF_LINES) {
      console.log(chalk.gray(`    (${totalChanged} changed lines — showing summary only)\n`));
      detailCount++;
      continue;
    }

    const hunks = collapseToHunks(ops);
    for (const op of hunks) {
      if (op.type === 'separator') {
        console.log(chalk.gray(`    @@ ... ${op.skipped} unchanged lines ... @@`));
      } else if (op.type === 'add') {
        console.log(chalk.green(`    + ${op.line}`));
      } else if (op.type === 'remove') {
        console.log(chalk.red(`    - ${op.line}`));
      } else {
        console.log(chalk.gray(`      ${op.line}`));
      }
    }
    console.log('');
    detailCount++;
  }

  // ── Added files ─────────────────────────────────────────────────────────
  for (const filePath of added) {
    const proposed  = patchedFileMap[filePath] || '';
    const lineCount = proposed.split('\n').length;
    console.log(chalk.green(`  + ${path.basename(filePath)}`) + chalk.dim(`  (${path.dirname(filePath)})  [new file, ${lineCount} lines]`));

    if (detailCount >= DETAIL_FILE_CAP) {
      console.log(chalk.gray('    (diff detail omitted — file limit reached)\n'));
      continue;
    }

    const previewLines = proposed.split('\n').slice(0, 12);
    for (const line of previewLines) {
      console.log(chalk.green(`    + ${line}`));
    }
    if (lineCount > 12) {
      console.log(chalk.gray(`    ... ${lineCount - 12} more lines`));
    }
    console.log('');
    detailCount++;
  }

  console.log(chalk.cyan.bold('─────────────────────────────────────────────────────────────────'));
  console.log('');
}

// ── computeUnifiedDiff ────────────────────────────────────────────────────────
/**
 * Generate a standard unified diff string from two file content strings.
 * Output is applyable with `patch -p1` from the codebase root.
 *
 * Reuses computeLineDiff (LCS) and collapseToHunks (3-line context) from the
 * chalk-display function above. String output only — no console output, no
 * chalk coloring.
 *
 * @param {string} a       Baseline file content
 * @param {string} b       Corrected file content
 * @param {string} pathA   Relative path for --- header (e.g. "src/loader/index.js")
 * @param {string} pathB   Relative path for +++ header (usually same as pathA)
 * @returns {string}       Standard unified diff text, empty string when no changes
 */
export function computeUnifiedDiff(a, b, pathA, pathB) {
  const ops = computeLineDiff(a, b);
  const hunks = collapseToHunks(ops);
  if (hunks.length === 0) return '';

  const aLines = (a || '').split('\n');
  const bLines = (b || '').split('\n');

  // Walk hunks once to build @@ line-number metadata and output lines.
  const diffLines = [
    `--- a/${pathA}`,
    `+++ b/${pathB || pathA}`,
  ];

  // Reconstruct hunk groups (runs between separators) with @@ headers.
  // Track original-file (aLine) and new-file (bLine) positions.
  let aLine = 1;
  let bLine = 1;
  let hunkOps = [];

  function flushHunk() {
    if (hunkOps.length === 0) return;
    // Count lines in the hunk for the @@ header.
    const aCount = hunkOps.filter(o => o.type === 'context' || o.type === 'remove').length;
    const bCount = hunkOps.filter(o => o.type === 'context' || o.type === 'add').length;
    // aLine at start of this hunk: aLine has already advanced past context before the hunk
    const hunkAStart = aLine - hunkOps.filter(o => o.type === 'context' || o.type === 'remove').length;
    const hunkBStart = bLine - hunkOps.filter(o => o.type === 'context' || o.type === 'add').length;
    diffLines.push(`@@ -${hunkAStart},${aCount} +${hunkBStart},${bCount} @@`);
    for (const op of hunkOps) {
      if (op.type === 'context') diffLines.push(` ${op.line}`);
      else if (op.type === 'add')    diffLines.push(`+${op.line}`);
      else if (op.type === 'remove') diffLines.push(`-${op.line}`);
    }
    hunkOps = [];
  }

  // Replay the full ops (not collapsed) to get accurate line numbers.
  // collapseToHunks only gives us context-windowed view; we need raw ops
  // for @@ numbering, then apply the separator positions to split hunks.
  //
  // Strategy: identify separator positions from collapseToHunks, then
  // replay the full ops list splitting at those gaps.
  const separatorPositions = new Set();
  let opIdx = 0;
  for (const h of hunks) {
    if (h.type === 'separator') separatorPositions.add(opIdx);
    else opIdx++;
  }

  // Replay full ops, splitting into hunks at separator boundaries.
  // We use the collapseToHunks result directly: iterate hunks linearly.
  // Each non-separator entry maps to a diff op.
  aLine = 1; bLine = 1; hunkOps = [];
  let inHunk = false;

  for (const h of hunks) {
    if (h.type === 'separator') {
      flushHunk();
      aLine += h.skipped;
      bLine += h.skipped;
      inHunk = false;
    } else {
      inHunk = true;
      hunkOps.push(h);
      if (h.type === 'context' || h.type === 'remove') aLine++;
      if (h.type === 'context' || h.type === 'add')    bLine++;
    }
  }
  flushHunk();

  return diffLines.join('\n') + '\n';
}
