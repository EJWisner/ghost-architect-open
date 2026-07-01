/**
 * Ghost Architect™ — Corrected-File Generator
 *
 * Pure string-in, string-out utility. No filesystem access. No LLM calls.
 * Given baseline file content and a structured fix_direction object (from
 * Phase 2 narrator enrichment), produces a corrected file content string
 * by locating the change site and applying the patch_instruction.
 *
 * Cascade order (first match wins):
 *   Mode 1 — High-similarity single-line replacement (Levenshtein ≥ 0.80)
 *   Mode 2 — Function/block anchor replacement (signature match + body replace)
 *   Mode 3 — Reasoning-anchored insertion (three spatial cue patterns)
 *   Fallback — Return original baseline unchanged, confidence "failed"
 *
 * Return shape: { correctedContent, confidence, notes }
 *   confidence: "high" | "medium" | "low" | "failed"
 *   notes:      string | null   (non-null whenever confidence < "high")
 */

// ── cleanPatchInstruction ─────────────────────────────────────────────────────
// Strips prose lines from a patch_instruction before it's used for patching or
// written to the fix artifact. LLMs sometimes emit explanatory prose alongside
// code (e.g. "Add validation before setStatus() call around line ~151:").
//
// A line is treated as prose and removed when ALL of the following hold:
//   1. It ends with `:` AND contains no PHP/JS syntax chars ($, {, }, (, ), ;)
//      — catches "Add validation before setStatus() call:" style headers
//   2. OR it starts with a common prose word (case-insensitive): this, adds,
//      ensures, prevents, around, following, note, warning, here, which
//      — catches "This adds a safety check..." style
//
// Empty lines are preserved as-is (blank lines in code are meaningful).
// Lines that contain code-syntax characters are always preserved regardless.
//
export function cleanPatchInstruction(raw) {
  if (typeof raw !== 'string') return raw;
  const proseStartRe = /^(?:this|adds|ensures|prevents|around|following|note|warning|here|which)\b/i;
  const syntaxChars  = /[${}();=<>'"]/;
  return raw
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (!t) return true; // preserve blank lines
      // Heuristic 1: ends with colon AND contains no syntax chars → prose header
      // (switch-case labels like `case 'foo':`, TypeScript annotations, and
      // goto labels all end with ':' but contain syntax chars or are valid code)
      if (t.endsWith(':') && !syntaxChars.test(t)) return false;
      // Heuristic 2: starts with a prose word → explanatory sentence
      if (proseStartRe.test(t) && !syntaxChars.test(t)) return false;
      return true;
    })
    .join('\n');
}

// ── Levenshtein distance + normalized ratio ───────────────────────────────────
// DP table implementation. O(m×n) time, O(min(m,n)) space.
// ratio = 1 - (editDistance / max(len(a), len(b)))
// Matches SequenceMatcher.ratio() semantics for character-level similarity.

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Use a single row rolling array — O(min(m,n)) space.
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,          // insertion
        prev[j] + 1,               // deletion
        prev[j - 1] + cost         // substitution
      );
    }
    prev = curr;
  }
  return prev[n];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(a, b) / maxLen;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

// Strip leading/trailing whitespace for comparison purposes.
// Preserves indentation in the actual lines array — only used for matching.
function normalizeForMatch(line) {
  return line.trim();
}

// Keywords that signal the first patch line is a function/method signature.
// Covers: PHP (public/private/protected function), JS/TS (function, export
// function, async function, const/let/var arrow), Python (def, async def),
// Rust (fn, pub fn — fn alone matches), Go (func), Java/C# (access modifiers
// + return type), Ruby (def), and class/interface/enum block openers.
const SIGNATURE_KEYWORDS = [
  /\bfunction\b/, /\bdef\b/, /\bfn\b/, /\bfunc\b/,
  /\bpublic\b/, /\bprivate\b/, /\bprotected\b/, /\bstatic\b/, /\binternal\b/,
  /\basync\s+function\b/, /\b(?:export\s+)?(?:default\s+)?function\b/,
  /\bclass\b/, /\binterface\b/, /\benum\b/,
  // JS/TS arrow functions: const foo = (x) => { or const bar = async (x) => {
  /\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(.*\)\s*=>/,
];

function looksLikeSignature(line) {
  const t = line.trim();
  return SIGNATURE_KEYWORDS.some(re => re.test(t));
}

// Count opening vs closing brace depth change for a line (used in Mode 2 body-end detection).
function braceDepthDelta(line) {
  let delta = 0;
  let inString = false;
  let strChar = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === strChar && line[i - 1] !== '\\') inString = false;
    } else if (c === '"' || c === "'" || c === '`') {
      inString = true; strChar = c;
    } else if (c === '{') {
      delta++;
    } else if (c === '}') {
      delta--;
    }
  }
  return delta;
}

// Detect whether a patch is a complete method/block rewrite:
//   - Has at least one brace pair (open count === close count > 0)
//   - Last non-blank line is exactly "}"
// Distinguishes "complete rewrite" (Category B) from:
//   - "signature change" (no braces, Category C → Mode 2R sig-only path)
//   - "sentinel insertion" (// ..., Category A → Mode 2I)
// Verified against full corpus: 0 false positives, 1 true positive (smoke3).
function isBalancedAndClosed(patchLines) {
  let open = 0, close = 0;
  for (const l of patchLines) {
    for (const c of l) {
      if (c === '{') open++;
      else if (c === '}') close++;
    }
  }
  const last = patchLines.filter(l => l.trim()).pop()?.trim();
  return open > 0 && open === close && last === '}';
}

// State-machine brace-depth walker — finds the closing } of a method body.
// Handles: single-quoted strings, double-quoted strings, // single-line
// comments, and /* block */ comments. Ignores braces inside any of these.
// Verified: 7/7 PHP edge cases pass (strings-with-braces, commented braces,
// nested blocks). Safe to reintroduce — all prior Mode 2 failures were
// patch-shape misreads, not counting errors.
function findMethodEnd(baselineLines, sigMatchIdx) {
  let state = 'code';
  let depth = 0;
  let bodyOpened = false;
  let parenDepth = 0;

  for (let i = sigMatchIdx; i < baselineLines.length; i++) {
    const line = baselineLines[i];
    let j = 0;
    while (j < line.length) {
      const ch   = line[j];
      const next = line[j + 1] || '';

      if (state === 'block_comment') {
        if (ch === '*' && next === '/') { state = 'code'; j += 2; continue; }
        j++; continue;
      }
      if (state === 'string_sq') {
        if (ch === "'" && line[j - 1] !== '\\') state = 'code';
        j++; continue;
      }
      if (state === 'string_dq') {
        if (ch === '"' && line[j - 1] !== '\\') state = 'code';
        j++; continue;
      }
      // state === 'code'
      if (ch === '/' && next === '/') break;                         // single-line comment
      if (ch === '/' && next === '*') { state = 'block_comment'; j += 2; continue; }
      if (ch === "'") { state = 'string_sq'; j++; continue; }
      if (ch === '"') { state = 'string_dq'; j++; continue; }
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
      else if (ch === '{' && parenDepth <= 0) { depth++; bodyOpened = true; }
      else if (ch === '}' && parenDepth <= 0 && bodyOpened) {
        depth--;
        if (depth === 0) return i;  // found the method's closing brace line
      }
      j++;
    }
  }
  return baselineLines.length - 1;  // fallback: end of file
}

// ── Mode 1: Single-line similarity replacement ────────────────────────────────
// Find the baseline line most similar to the FIRST line of the patch.
// If best similarity ≥ 0.80 and patch is single-line: replace that line.
// If patch is multi-line but first line matches: replace starting from that line
// for patch.length lines (covers trailing single-line patches mid-function).
//
// Returns null if no line scores ≥ 0.80.

const MODE1_THRESHOLD = 0.80;
const MODE2_THRESHOLD = 0.70; // Lower than Mode 1 — sig lines are shorter and fuzzier

function tryMode1(baselineLines, patchLines) {
  if (patchLines.length === 0) return null;
  const patchFirst = normalizeForMatch(patchLines[0]);
  if (patchFirst.length === 0) return null;

  // Compute similarity for every baseline line.
  const scores = baselineLines.map((bl, idx) => ({
    idx,
    score: similarity(patchFirst, normalizeForMatch(bl)),
  }));

  const matches = scores.filter(s => s.score >= MODE1_THRESHOLD);
  if (matches.length === 0) return null;

  // Sort by score descending; take best.
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];

  // Determine how many baseline lines the patch should replace.
  // For a single-patch-line: always replace exactly 1 baseline line.
  // For multi-line patches where Mode 1 fires: replace as many baseline
  // lines as the patch has lines (starting from the match point).
  const replaceCount = patchLines.length === 1
    ? 1
    : Math.min(patchLines.length, baselineLines.length - best.idx);

  // Preserve the indentation of the matched baseline line.
  const baseIndent = (baselineLines[best.idx].match(/^(\s*)/) || ['', ''])[1];
  const corrected = [
    ...baselineLines.slice(0, best.idx),
    ...patchLines.map((pl, i) =>
      i === 0
        ? baseIndent + pl.trim()
        : pl  // subsequent patch lines carry their own indentation
    ),
    ...baselineLines.slice(best.idx + replaceCount),
  ];

  const confidence = matches.length === 1 ? 'high' : 'medium';
  const notes = matches.length === 1
    ? null
    : `Patch applied at highest-similarity match (line ${best.idx + 1}). ` +
      `Similar lines also found at: ${matches.slice(1).map(m => `line ${m.idx + 1}`).join(', ')}. ` +
      `Verify this is the intended location.`;

  return { correctedContent: corrected.join('\n'), confidence, notes };
}

// ── Mode 2R: Signature-line replacement ──────────────────────────────────────
// First patch line looks like a function/method signature AND does NOT contain
// a truncation sentinel (// ...). Replaces ONLY the baseline signature block
// (from the matching line through the opening {) with the patch's signature.
// The body (everything after the {) is preserved intact.
//
// Handles all three brace-position styles:
//   K&R same-line:  "public function foo($x) {"
//   Allman:         "public function foo($x)\n{"
//   Multi-line sig: "public function foo(\n  $x\n) {"
//
// Returns null if first patch line is not a signature, contains a sentinel,
// or no baseline match found at similarity ≥ 0.70.

function tryMode2R(baselineLines, patchLines) {
  if (patchLines.length < 1) return null;
  if (!looksLikeSignature(patchLines[0])) return null;
  // Truncation sentinel means Mode 2I should handle this, not 2R
  if (patchLines.some(l => /\/\/\s*\.\.\.|\/\/\s*existing|\/\/\s*proceed|\/\/\s*rest\s+of|\/\/\s*remaining|\/\/\s*etc\.?$/i.test(l))) return null;

  const patchFirst = normalizeForMatch(patchLines[0]);
  const scores = baselineLines.map((bl, idx) => ({
    idx,
    score: similarity(patchFirst, normalizeForMatch(bl)),
  }));
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  // Lower threshold than Mode 1 (0.70 vs 0.80) — sig lines are shorter
  if (best.score < MODE2_THRESHOLD) return null;

  // Walk forward from sig match to find the { that opens the body.
  // Track paren depth so braces inside parameter lists are ignored.
  let parenDepth = 0;
  let braceLineIdx = best.idx;
  for (let i = best.idx; i < baselineLines.length; i++) {
    for (const ch of baselineLines[i]) {
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
      else if (ch === '{' && parenDepth <= 0) { braceLineIdx = i; parenDepth = -999; break; }
    }
    if (parenDepth < 0) break;
  }

  const baseIndent = (baselineLines[best.idx].match(/^(\s*)/) || ['', ''])[1];
  const patchHasBrace = patchLines.some(l => l.includes('{'));
  const patchIsComplete = isBalancedAndClosed(patchLines);

  let endIdx, replacement;

  if (patchIsComplete) {
    // Complete method rewrite: patch has a full balanced body (new sig + body + }).
    // Use state-machine walker to find the baseline method's closing brace, then
    // replace the entire block (sig through closing }) with the patch.
    // This prevents the old body from being appended after the new body.
    endIdx = findMethodEnd(baselineLines, best.idx);
    replacement = patchLines.map((l, i) => i === 0 ? baseIndent + l.trim() : l);
  } else if (patchHasBrace) {
    // Patch includes { but is not a complete rewrite (unbalanced or no closing }).
    // Replace sig through opening { only; body from baseline follows.
    endIdx = braceLineIdx;
    replacement = patchLines.map((l, i) => i === 0 ? baseIndent + l.trim() : l);
  } else {
    // Signature-only change: patch has no braces. Preserve baseline { line,
    // adjusting for K&R style where ) and { appear together on the brace line.
    endIdx = braceLineIdx;
    const braceLine    = baselineLines[braceLineIdx];
    const braceIndent  = (braceLine.match(/^(\s*)/) || ['', ''])[1];
    const emittedBraceLine = braceLine.trim().startsWith(')')
      ? braceIndent + '{'     // K&R ") {" → emit just "{"
      : braceLine;            // Allman "{" → keep as-is
    replacement = [
      ...patchLines.map((l, i) => i === 0 ? baseIndent + l.trim() : l),
      emittedBraceLine,
    ];
  }

  const confidence = scores.filter(s => s.score >= MODE2_THRESHOLD).length === 1 ? 'high' : 'medium';
  const notes = confidence === 'medium'
    ? `Signature replaced at highest-similarity match (line ${best.idx + 1}). ` +
      `Similar signatures also found — verify scope.`
    : null;

  const corrected = [
    ...baselineLines.slice(0, best.idx),
    ...replacement,
    ...baselineLines.slice(endIdx + 1),
  ];

  return { correctedContent: corrected.join('\n'), confidence, notes };
}

// ── Mode 2I: Truncation-sentinel insertion ────────────────────────────────────
// First patch line looks like a function signature AND the patch contains a
// truncation sentinel (// ..., // existing, // proceed, etc.). The sentinel
// means the LLM is showing a snippet to INSERT at the TOP of the method body,
// not a complete replacement.
//
// Extracts the lines between the signature line and the sentinel, inserts them
// at the top of the baseline method body (right after the opening {).
// The rest of the original body is preserved intact.
//
// Example (the diagnosed bug case):
//   patch:    private function callApi(...) {
//               if (!$this->accessToken) { throw ...; }
//               // ... proceed          ← sentinel
//             }
//   Result:   the guard clause is inserted at the top of the real body.
//
// Returns null if no sentinel, no sig match, or similarity < 0.70.

function tryMode2I(baselineLines, patchLines) {
  if (patchLines.length < 2) return null;
  if (!looksLikeSignature(patchLines[0])) return null;
  const sentinelRe = /\/\/\s*\.\.\.|\/\/\s*existing|\/\/\s*proceed|\/\/\s*rest\s+of|\/\/\s*remaining|\/\/\s*etc\.?$/i;
  const sentinelIdx = patchLines.findIndex(l => sentinelRe.test(l));
  if (sentinelIdx < 0) return null;

  const patchFirst = normalizeForMatch(patchLines[0]);
  const scores = baselineLines.map((bl, idx) => ({
    idx,
    score: similarity(patchFirst, normalizeForMatch(bl)),
  }));
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (best.score < MODE2_THRESHOLD) return null;

  // Find the opening brace
  let parenDepth = 0;
  let braceLineIdx = best.idx;
  for (let i = best.idx; i < baselineLines.length; i++) {
    for (const ch of baselineLines[i]) {
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
      else if (ch === '{' && parenDepth <= 0) { braceLineIdx = i; parenDepth = -999; break; }
    }
    if (parenDepth < 0) break;
  }

  // Insert lines between patch[1] and the sentinel into the body
  const insertLines = patchLines.slice(1, sentinelIdx);

  const corrected = [
    ...baselineLines.slice(0, braceLineIdx + 1),  // everything up to and including {
    ...insertLines,
    ...baselineLines.slice(braceLineIdx + 1),      // original body preserved
  ];

  const confidence = scores.filter(s => s.score >= MODE2_THRESHOLD).length === 1 ? 'medium' : 'low';
  const notes = `Patch inserted at top of '${patchLines[0].trim().slice(0, 40)}' body ` +
    `based on truncation sentinel. Review insertion point before applying.`;

  return { correctedContent: corrected.join('\n'), confidence, notes };
}

// ── Mode 3: Reasoning-anchored insertion ──────────────────────────────────────
// Three spatial cue patterns extracted from real narrator output:
//
//   Pattern A — "before/above the X call/invocation/check"
//     Extract X, find line containing X, insert patch BEFORE that line.
//
//   Pattern B — "after/below retrieving/getting/calling Y"
//     Extract Y, find line containing retrieval of Y, insert patch AFTER.
//
//   Pattern C — "inside the Z function/method"
//     Extract Z, find Z's signature line, insert patch at top of body
//     (right after the opening brace line).
//
// Returns null if no pattern matches or anchor not found in baseline.

// Pattern regexes — scoped to what's observed in real narrator output.
const BEFORE_RE  = /\b(?:before|above)\s+(?:the\s+)?([`'"]?)(\w[\w.$]*)\1\s*(?:call|invocation|check|line|statement)?\b/i;
const AFTER_RE   = /\b(?:after|below)\s+(?:retrieving|getting|calling|fetching|reading|the\s+)?(?:the\s+)?([`'"]?)(\w[\w.$]*)\1\b/i;
const INSIDE_RE  = /\b(?:inside|within|at the top of)\s+(?:the\s+)?([`'"]?)(\w[\w.$]*)\1\s*(?:function|method|block)?\b/i;

function findLinesContaining(baselineLines, token) {
  const lower = token.toLowerCase();
  return baselineLines.reduce((acc, line, idx) => {
    if (line.toLowerCase().includes(lower)) acc.push(idx);
    return acc;
  }, []);
}

function tryMode3(baselineLines, patchLines, reasoning) {
  if (!reasoning || typeof reasoning !== 'string') return null;

  let insertBefore = null; // line index to insert before
  let patternName  = '';

  // Pattern A — before/above X
  const beforeM = reasoning.match(BEFORE_RE);
  if (beforeM) {
    const token = beforeM[2];
    const found = findLinesContaining(baselineLines, token);
    if (found.length === 0) return null;
    if (found.length > 1) {
      // Ambiguous — low confidence, use first occurrence.
      const corrected = [
        ...baselineLines.slice(0, found[0]),
        ...patchLines,
        ...baselineLines.slice(found[0]),
      ].join('\n');
      return {
        correctedContent: corrected,
        confidence: 'low',
        notes: `Reasoning-anchored insertion before '${token}' (Pattern A). ` +
               `Token found at multiple locations (lines ${found.map(i => i + 1).join(', ')}). ` +
               `Inserted before first occurrence. Verify insertion point.`,
      };
    }
    insertBefore = found[0];
    patternName  = `before '${token}' (Pattern A)`;
  }

  // Pattern B — after/below Y
  if (insertBefore === null) {
    const afterM = reasoning.match(AFTER_RE);
    if (afterM) {
      const token = afterM[2];
      const found = findLinesContaining(baselineLines, token);
      if (found.length === 0) return null;
      if (found.length > 1) {
        const insertIdx = found[0] + 1;
        const corrected = [
          ...baselineLines.slice(0, insertIdx),
          ...patchLines,
          ...baselineLines.slice(insertIdx),
        ].join('\n');
        return {
          correctedContent: corrected,
          confidence: 'low',
          notes: `Reasoning-anchored insertion after '${token}' (Pattern B). ` +
                 `Token found at multiple locations (lines ${found.map(i => i + 1).join(', ')}). ` +
                 `Inserted after first occurrence. Verify insertion point.`,
        };
      }
      insertBefore = found[0] + 1; // insert AFTER found line
      patternName  = `after '${token}' (Pattern B)`;
    }
  }

  // Pattern C — inside Z function
  if (insertBefore === null) {
    const insideM = reasoning.match(INSIDE_RE);
    if (insideM) {
      const token = insideM[2];
      // Find signature line containing token (function/method name).
      const found = baselineLines.reduce((acc, line, idx) => {
        if (looksLikeSignature(line) && line.toLowerCase().includes(token.toLowerCase())) {
          acc.push(idx);
        }
        return acc;
      }, []);
      if (found.length === 0) return null;
      // Find the opening brace line after the signature.
      let braceLineIdx = found[0];
      for (let i = found[0]; i < Math.min(found[0] + 5, baselineLines.length); i++) {
        if (baselineLines[i].trim() === '{' || baselineLines[i].includes('{')) {
          braceLineIdx = i;
          break;
        }
      }
      insertBefore = braceLineIdx + 1; // insert at top of body
      patternName  = `inside '${token}' function (Pattern C)`;

      if (found.length > 1) {
        const corrected = [
          ...baselineLines.slice(0, insertBefore),
          ...patchLines,
          ...baselineLines.slice(insertBefore),
        ].join('\n');
        return {
          correctedContent: corrected,
          confidence: 'low',
          notes: `Reasoning-anchored insertion ${patternName}. ` +
                 `Signature found at multiple locations. Inserted at first match. Verify.`,
        };
      }
    }
  }

  if (insertBefore === null) return null;

  // Single unambiguous match — confidence "medium" (reasoning-dependent).
  const corrected = [
    ...baselineLines.slice(0, insertBefore),
    ...patchLines,
    ...baselineLines.slice(insertBefore),
  ].join('\n');

  return {
    correctedContent: corrected,
    confidence: 'medium',
    notes: `No similar line found in baseline. Patch inserted ${patternName} ` +
           `based on reasoning text. Review insertion point before applying.`,
  };
}

// ── Mode 2N: New insertion before class/interface body closer ─────────────────
// Handles pure insertions — new constants, properties, or methods that don't
// replace any existing line. Tracks brace depth from the class/interface
// declaration to find the true outermost closing `}`, then inserts the patch
// lines immediately before it with consistent indentation.
//
// Trigger: baseline contains a class/interface declaration AND brace structure
// is balanced. No similarity match needed — this is a pure append-before-closer.
// Returns null when the file has no class/interface declaration, or when braces
// are unbalanced (e.g. a config snippet rather than a class file).

function tryMode2N(baselineLines, patchLines) {
  // Skip signature-shaped patches — Mode 2R/2I handle those; if they failed,
  // Mode 1 fallback is more appropriate than inserting before the class closer.
  if (patchLines.length > 0 && looksLikeSignature(patchLines[0])) return null;

  // Step 1: Find the class/interface declaration line
  const declRe = /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait)\s+\w/;
  const declIdx = baselineLines.findIndex(l => declRe.test(l));
  if (declIdx === -1) return null; // not a class/interface file

  // Step 2: Track brace depth from declaration line to find outermost closer
  let depth = 0;
  let closerIdx = -1;
  for (let i = declIdx; i < baselineLines.length; i++) {
    const line = baselineLines[i];
    // Count braces — skip string literals and comments (basic approximation)
    for (const ch of line) {
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          closerIdx = i;
          break;
        }
      }
    }
    if (closerIdx !== -1) break;
  }
  if (closerIdx === -1) return null; // unbalanced braces — bail

  // Step 3: Determine indentation from surrounding context
  // Use the indentation of the line just before the closer, or default to 4 spaces
  const prevLine = baselineLines[closerIdx - 1] || '';
  const indentMatch = prevLine.match(/^(\s+)/);
  const indent = indentMatch ? indentMatch[1] : '    ';

  // Step 4: Insert patch lines before the closer, with consistent indentation
  const indentedPatch = patchLines.map(l => l.trim() ? indent + l.trimStart() : '');
  const result = [
    ...baselineLines.slice(0, closerIdx),
    '',
    ...indentedPatch,
    baselineLines[closerIdx],
    ...baselineLines.slice(closerIdx + 1),
  ];

  return {
    correctedContent: result.join('\n'),
    confidence:       'medium',
    notes:            `Mode 2N: inserted ${patchLines.length} line(s) before class body closer (line ${closerIdx + 1})`,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a corrected file by applying fix_direction.patch_instruction
 * to baselineContent.
 *
 * @param {string} baselineContent   Full content of the file to be patched.
 * @param {object} fixDirection      fix_direction object from findings JSON.
 *   Required fields: patch_instruction (string), reasoning (string|null)
 * @returns {{ correctedContent: string, confidence: string, notes: string|null }}
 */
export function generateCorrectedFile(baselineContent, fixDirection) {
  // Guard: invalid inputs → failed immediately.
  if (typeof baselineContent !== 'string') {
    return {
      correctedContent: baselineContent ?? '',
      confidence: 'failed',
      notes: 'Invalid input: baselineContent must be a string.',
    };
  }
  if (!fixDirection || typeof fixDirection.patch_instruction !== 'string') {
    return {
      correctedContent: baselineContent,
      confidence: 'failed',
      notes: 'Invalid input: fix_direction.patch_instruction is missing or not a string.',
    };
  }

  const baselineLines = baselineContent.split('\n');
  const patchLines    = cleanPatchInstruction(fixDirection.patch_instruction).split('\n');
  const reasoning     = fixDirection.reasoning || null;

  // Mode cascade (first match wins):
  //   Mode 1  — High-similarity single-line replacement (≥ 0.80)
  //             Skipped when first patch line looks like a function signature
  //             (Mode 2R/2I handle those cases with body-aware logic).
  //   Mode 2R — Signature-line replacement: patch starts with a function sig,
  //             no truncation sentinel. Replaces the baseline sig block only;
  //             body preserved intact.
  //   Mode 2I — Sentinel insertion: patch starts with a function sig AND
  //             contains // ... / // existing / // proceed. Inserts the guard
  //             clause at the top of the baseline body; body preserved intact.
  //   Mode 3  — Reasoning-anchored insertion (three spatial cue patterns).
  //   Fallback — Return original baseline unchanged, confidence "failed".
  //
  // Mode 2 (destructive full-body replacement) has been removed.
  // Corpus analysis across 83 findings.json files confirmed:
  //   - 0 patches were genuine complete rewrites (Category B = zero)
  //   - 3/4 sig-starting patches had // ... sentinels (Category A — Mode 2I)
  //   - 1/4 was a signature-only change (Category C — Mode 2R)
  // Mode 2 was replacing entire 70+ line method bodies with 4-6 line snippets.

  // Mode 1 — single-line or non-signature patches
  if (!looksLikeSignature(patchLines[0])) {
    const m1 = tryMode1(baselineLines, patchLines);
    if (m1) return m1;
  }

  // Mode 2R — signature replacement (no sentinel)
  const m2r = tryMode2R(baselineLines, patchLines);
  if (m2r) return m2r;

  // Mode 2I — sentinel insertion (// ...)
  const m2i = tryMode2I(baselineLines, patchLines);
  if (m2i) return m2i;

  // Mode 2N — new insertion before class/interface body closer
  const m2n = tryMode2N(baselineLines, patchLines);
  if (m2n) return m2n;

  // Mode 1 fallback for signature-shaped patches that didn't match 2R/2I
  if (looksLikeSignature(patchLines[0])) {
    const m1 = tryMode1(baselineLines, patchLines);
    if (m1) return m1;
  }

  // Mode 3 — reasoning-anchored insertion
  const m3 = tryMode3(baselineLines, patchLines, reasoning);
  if (m3) return m3;

  // Fallback — no match
  return {
    correctedContent: baselineContent,
    confidence: 'failed',
    notes: 'Could not locate a matching insertion point via similarity (Mode 1), ' +
           'signature replacement (Mode 2R), sentinel insertion (Mode 2I), ' +
           'or reasoning cues (Mode 3). ' +
           'Use patch_instruction as a manual guide.',
  };
}
