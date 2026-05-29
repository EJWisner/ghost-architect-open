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

// Count brace depth change for a line (used in Mode 2 body-end detection).
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

// ── Mode 1: Single-line similarity replacement ────────────────────────────────
// Find the baseline line most similar to the FIRST line of the patch.
// If best similarity ≥ 0.80 and patch is single-line: replace that line.
// If patch is multi-line but first line matches: replace starting from that line
// for patch.length lines (covers trailing single-line patches mid-function).
//
// Returns null if no line scores ≥ 0.80.

const MODE1_THRESHOLD = 0.80;

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

// ── Mode 2: Function/block anchor replacement ─────────────────────────────────
// First patch line looks like a function/method signature AND matches a
// baseline line at ≥ 0.80. Find the full function body in the baseline
// (from signature line to matching closing brace via depth counting), replace
// the entire block with the patch content.
//
// Returns null if first patch line is not a signature or no match found.

function tryMode2(baselineLines, patchLines) {
  if (patchLines.length < 2) return null;
  if (!looksLikeSignature(patchLines[0])) return null;

  const patchFirst = normalizeForMatch(patchLines[0]);
  const scores = baselineLines.map((bl, idx) => ({
    idx,
    score: similarity(patchFirst, normalizeForMatch(bl)),
  }));
  const matches = scores.filter(s => s.score >= MODE1_THRESHOLD);
  if (matches.length === 0) return null;

  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];
  const sigLineIdx = best.idx;

  // Walk forward from signature line counting brace depth to find body end.
  // Handles both K&R style (brace on same line as signature) and Allman style
  // (brace on the next line). We wait until we've seen the opening brace that
  // brings depth to exactly 1 (the function body's opening brace), then track
  // back to 0 as the body-closing brace.
  let depth = 0;
  let bodyEnd = sigLineIdx;
  let bodyStarted = false;
  let bodyOpenDepth = 0;
  for (let i = sigLineIdx; i < baselineLines.length; i++) {
    const delta = braceDepthDelta(baselineLines[i]);
    depth += delta;
    if (!bodyStarted && depth > 0) {
      bodyStarted   = true;
      bodyOpenDepth = depth; // typically 1; >1 if signature is inside a class
    }
    if (bodyStarted && depth < bodyOpenDepth) {
      bodyEnd = i;
      break;
    }
  }

  // Preserve indentation of the signature line.
  const baseIndent = (baselineLines[sigLineIdx].match(/^(\s*)/) || ['', ''])[1];
  const corrected = [
    ...baselineLines.slice(0, sigLineIdx),
    ...patchLines.map((pl, i) =>
      i === 0 ? baseIndent + pl.trim() : pl
    ),
    ...baselineLines.slice(bodyEnd + 1),
  ];

  const confidence = matches.length === 1 ? 'high' : 'medium';
  const notes = matches.length === 1
    ? null
    : `Function body replaced at highest-similarity signature match (line ${sigLineIdx + 1}). ` +
      `Similar signatures also at: ${matches.slice(1).map(m => `line ${m.idx + 1}`).join(', ')}. ` +
      `Verify scope.`;

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
  const patchLines    = fixDirection.patch_instruction.split('\n');
  const reasoning     = fixDirection.reasoning || null;

  // Mode 1 — similarity-based line replacement.
  // Skip Mode 1 when the first patch line looks like a function signature —
  // Mode 2 handles that case with correct body-boundary detection.
  if (!looksLikeSignature(patchLines[0])) {
    const m1 = tryMode1(baselineLines, patchLines);
    if (m1) return m1;
  }

  // Mode 2 — function/block signature replacement.
  const m2 = tryMode2(baselineLines, patchLines);
  if (m2) return m2;

  // Mode 1 fallback — if Mode 2 didn't match but patch looks like a signature,
  // try Mode 1 anyway (edge case: signature-shaped patch for a non-function context).
  if (looksLikeSignature(patchLines[0])) {
    const m1 = tryMode1(baselineLines, patchLines);
    if (m1) return m1;
  }

  // Mode 3 — reasoning-anchored insertion.
  const m3 = tryMode3(baselineLines, patchLines, reasoning);
  if (m3) return m3;

  // Fallback — no match. Return original baseline unchanged.
  return {
    correctedContent: baselineContent,
    confidence: 'failed',
    notes: 'Could not locate a matching insertion point via similarity (Mode 1), ' +
           'function anchor (Mode 2), or reasoning cues (Mode 3). ' +
           'Use patch_instruction as a manual guide.',
  };
}
