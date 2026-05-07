/**
 * src/prompt-pack/formatting.js
 *
 * Detector #1: Formatting / syntax errors (Tier 1, regex/structural).
 *
 * Maps to Tian et al. (2025) subtype "Formatting/syntax errors" under
 * Structure & Formatting. Detects three flavors of structural error
 * that a static parser can catch with high confidence:
 *
 *   1. Unclosed fenced code blocks (triple-backtick count is odd)
 *   2. Mismatched HTML/XML tags (opens without closes, vice versa)
 *   3. Unclosed inline code (line ends with an unbalanced single backtick)
 *
 * Each emits a separate finding with detector id 'formatting/<flavor>'.
 *
 * Why this detector exists: when a prompt has an unclosed code block,
 * the LLM downstream may treat all subsequent text as part of the code
 * block and ignore instructions, or hallucinate a closing fence that
 * does not match what the author intended. Empirically common in
 * prompts that grew over time and were edited via copy-paste.
 *
 * Out of scope for v1: JSON syntax validation inside code blocks (handled
 * by the integration-mismatch detector), markdown-table malformation,
 * smart-quote vs straight-quote analysis. These are noisier and require
 * a real parser, not a regex.
 */

// ── Code block detection ──────────────────────────────────────────────────

/**
 * Find every triple-backtick fence in the prompt and return their line
 * numbers. We use a simple line-by-line scan rather than a single regex
 * over the whole text because we want line numbers for the finding's
 * location field, and because regex-against-multiline-text gets weird
 * fast with greedy matching.
 *
 * A fence line is a line whose first non-whitespace content is ``` (with
 * optional language tag after, e.g. ```js or ```python). Lines that
 * contain ``` somewhere in the middle (rare but possible inside prose)
 * are NOT counted as fences; only lines that START with ``` after
 * leading whitespace.
 */
function findCodeFences(promptText) {
  const fences = [];
  const lines = promptText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('```')) {
      fences.push({ line: i + 1, raw: lines[i] });
    }
  }
  return fences;
}

function detectUnclosedCodeBlock(promptText, filePath) {
  const fences = findCodeFences(promptText);
  if (fences.length === 0) return [];
  if (fences.length % 2 === 0) return [];

  // Odd fence count means at least one block never closed. Flag the
  // last unmatched fence as the most likely culprit (assumes the file
  // was being edited and the last block was left open).
  const lastFence = fences[fences.length - 1];
  return [
    {
      detector: 'formatting/unclosed-code-block',
      severity: 'HIGH',
      title: 'Unclosed fenced code block',
      file: filePath,
      location: { line: lastFence.line, column: 1 },
      detail:
        'The prompt contains ' + fences.length + ' triple-backtick fence(s), '
        + 'which is odd. At least one code block opens but never closes. '
        + 'The LLM may treat all subsequent prompt text as part of the open '
        + 'code block and ignore instructions that follow.',
      remediation:
        'Add a closing ``` fence to match the open one. The unmatched fence '
        + 'starts on line ' + lastFence.line + '. If the open fence is '
        + 'intentional (e.g. inside an example showing code), escape it '
        + 'or restructure the prompt.',
      confidence: 95,
    },
  ];
}

// ── HTML/XML tag balance ──────────────────────────────────────────────────

// Tags we care about. Most prompts use a small set of structural tags
// (instructions, context, example, system, user, assistant, output, input).
// Detecting balance for arbitrary tags is correct but produces noise on
// prose mentions like "use the <input> element". We allowlist the tags
// most commonly used as prompt-structure delimiters; mismatches outside
// the allowlist are out of scope for this detector.
//
// We deliberately do NOT include common HTML elements like <p>, <div>,
// <a>, <img>, <br>, <hr>, since prompts that include HTML markup as
// example content would generate false positives. The allowlist is
// "tags used as semantic prompt sections," not "all tags."
const STRUCTURAL_TAGS = new Set([
  'instructions',
  'instruction',
  'context',
  'example',
  'examples',
  'system',
  'user',
  'assistant',
  'output',
  'input',
  'task',
  'rules',
  'rule',
  'constraints',
  'constraint',
  'thinking',
  'response',
  'answer',
  'question',
  'document',
  'documents',
  'data',
]);

/**
 * Walk the prompt and find structural-tag opens/closes. Tag names are
 * lowercased for matching. Self-closing tags (<example/>) are ignored.
 *
 * Skips tags inside fenced code blocks and tags wrapped in single
 * backticks on the same line, since those are author-marked code
 * references rather than real prompt structure. This is what stops
 * "the `<example>` element" prose from being flagged as an unclosed tag.
 *
 * Returns an array of { tag, kind: 'open'|'close', line, column }.
 */
function findStructuralTags(promptText) {
  const found = [];
  const lines = promptText.split('\n');
  // Match <name> or </name>. Disallow attributes for simplicity; if the
  // user has <example name="x"> we still match the open tag and treat
  // any attribute payload as opaque. No self-closing handling here
  // because none of the structural tags are conventionally self-closing.
  // The regex captures: leading slash (optional, marks close), tag name.
  const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9_-]*)(\s[^>]*)?>/g;

  // Track whether we're inside a multi-line fenced code block so XML/HTML
  // example content inside ```xml ... ``` blocks doesn't trip the detector.
  let insideFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Toggle fence state on lines that start with ```. The fence line
    // itself is not scanned for tags (it's the fence boundary).
    if (trimmed.startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    // Build a set of column ranges on this line that are inside single
    // backticks (inline code). Tags whose opening '<' falls inside one
    // of these ranges are skipped. We pair backticks left-to-right;
    // unpaired trailing backticks are not used to mask anything.
    const inlineCodeRanges = [];
    {
      let openIdx = -1;
      for (let c = 0; c < line.length; c++) {
        if (line[c] !== '`') continue;
        // Skip triple-backtick (rare on a non-fence line, but possible).
        if (line[c + 1] === '`' && line[c + 2] === '`') { c += 2; continue; }
        if (openIdx < 0) {
          openIdx = c;
        } else {
          inlineCodeRanges.push([openIdx, c]);
          openIdx = -1;
        }
      }
    }
    const isInsideInlineCode = (col) => {
      for (const [lo, hi] of inlineCodeRanges) {
        if (col >= lo && col <= hi) return true;
      }
      return false;
    };

    let match;
    TAG_RE.lastIndex = 0;
    while ((match = TAG_RE.exec(line)) !== null) {
      const isClose = match[1] === '/';
      const tagName = match[2].toLowerCase();
      if (!STRUCTURAL_TAGS.has(tagName)) continue;
      if (isInsideInlineCode(match.index)) continue;
      found.push({
        tag: tagName,
        kind: isClose ? 'close' : 'open',
        line: i + 1,
        column: match.index + 1,
      });
    }
  }
  return found;
}

function detectMismatchedTags(promptText, filePath) {
  const tags = findStructuralTags(promptText);
  if (tags.length === 0) return [];

  // Stack-based balance check. For each open tag, push it onto the stack.
  // For each close tag, look for a matching open on the stack. Unmatched
  // closes and leftover opens are findings.
  //
  // We don't strictly enforce nesting order here (an <example> closing
  // before <context> when context opened first should ideally flag).
  // For v1 we only flag opens-without-closes and closes-without-opens,
  // not order violations. Order violations can be added in v2 with the
  // same data structure.
  const stack = [];
  const unmatchedCloses = [];

  for (const t of tags) {
    if (t.kind === 'open') {
      stack.push(t);
    } else {
      // Find the most recent matching open on the stack.
      let foundIdx = -1;
      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j].tag === t.tag) {
          foundIdx = j;
          break;
        }
      }
      if (foundIdx >= 0) {
        stack.splice(foundIdx, 1);
      } else {
        unmatchedCloses.push(t);
      }
    }
  }

  const findings = [];

  // Each leftover open on the stack is a finding.
  for (const t of stack) {
    findings.push({
      detector: 'formatting/unclosed-tag',
      severity: 'HIGH',
      title: 'Unclosed <' + t.tag + '> tag',
      file: filePath,
      location: { line: t.line, column: t.column },
      detail:
        'The prompt opens a <' + t.tag + '> tag at line ' + t.line + ' but '
        + 'never closes it. The LLM may interpret prompt content following '
        + 'the open tag as part of the section, including instructions that '
        + 'were meant to apply at the top level.',
      remediation:
        'Add a closing </' + t.tag + '> tag at the appropriate place. If the '
        + 'tag was meant to be self-closing or part of example content, '
        + 'escape the angle brackets or restructure.',
      confidence: 90,
    });
  }

  // Each unmatched close is also a finding.
  for (const t of unmatchedCloses) {
    findings.push({
      detector: 'formatting/unmatched-close-tag',
      severity: 'MEDIUM',
      title: 'Unmatched closing </' + t.tag + '> tag',
      file: filePath,
      location: { line: t.line, column: t.column },
      detail:
        'The prompt has a closing </' + t.tag + '> tag at line ' + t.line + ' '
        + 'with no matching opening tag. This is usually a copy-paste error '
        + 'or a leftover from a deleted section.',
      remediation:
        'Either add the missing opening <' + t.tag + '> tag at the section '
        + 'start, or remove the orphan close tag if the section was '
        + 'restructured.',
      confidence: 90,
    });
  }

  return findings;
}

// ── Inline code balance (per-line) ────────────────────────────────────────

/**
 * Lines with an odd count of single backticks suggest unclosed inline
 * code. We exclude lines that are inside a fenced code block (between
 * paired ``` fences), and we exclude lines that are themselves fence
 * lines.
 *
 * False-positive risk: prose that mentions a single backtick character
 * (rare in practice) trips this. We mark these as LOW severity and
 * lower confidence to reflect the heuristic nature.
 */
function detectUnclosedInlineCode(promptText, filePath) {
  const findings = [];
  const lines = promptText.split('\n');
  let insideFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (trimmed.startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    // Count single backticks that are NOT part of a triple-backtick.
    // Strip ``` first, then count remaining `.
    const stripped = line.replace(/```+/g, '');
    const backtickCount = (stripped.match(/`/g) || []).length;
    if (backtickCount === 0) continue;
    if (backtickCount % 2 === 0) continue;

    findings.push({
      detector: 'formatting/unbalanced-inline-code',
      severity: 'LOW',
      title: 'Possible unclosed inline code',
      file: filePath,
      location: { line: i + 1, column: 1 },
      detail:
        'Line ' + (i + 1) + ' has an odd number of backtick characters '
        + '(' + backtickCount + ') outside any fenced code block. This often '
        + 'indicates an unclosed inline `code` span.',
      remediation:
        'Check the line for an opening backtick that was never closed. If '
        + 'the backtick is intentional prose, escape it or rephrase.',
      confidence: 60,
    });
  }

  return findings;
}

// ── Public detect() ───────────────────────────────────────────────────────

/**
 * Run all formatting/syntax sub-detectors against a single prompt.
 *
 * @param {string} promptText  The prompt to audit.
 * @param {string} filePath    Path to the prompt file (for finding.file).
 * @param {object} [opts]      Reserved for future use; ignored here.
 *                              Formatting detection is purely structural
 *                              and does not depend on the target model.
 * @returns {Promise<Array>}   Findings from all sub-detectors.
 */
export async function detect(promptText, filePath, opts = {}) {
  const findings = [];

  findings.push(...detectUnclosedCodeBlock(promptText, filePath));
  findings.push(...detectMismatchedTags(promptText, filePath));
  findings.push(...detectUnclosedInlineCode(promptText, filePath));

  return findings;
}
