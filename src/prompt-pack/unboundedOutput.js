/**
 * src/prompt-pack/unboundedOutput.js
 *
 * Detector #5: Unbounded output (Tier 1, regex/structural).
 *
 * Maps to Tian et al. (2025) subtype "Unbounded output requests" under
 * Output Specification. Detects requests that ask the LLM to produce
 * output without specifying length, count, format, or other stopping
 * criteria. The classic failure mode is a prompt like "list the issues"
 * with no count cap; the response could be 3 issues or 30, and the
 * author has no signal either way.
 *
 * Approach (per session decisions):
 *   - Pattern matching with a conservative trigger verb list, anchored
 *     to line start. Prompts in markdown almost always put requests on
 *     their own line, and line-anchoring drops the false positive rate
 *     for incidental verb mentions ("don't write code that...").
 *   - For each trigger match, look in a forward-weighted 200-char
 *     window for any constraint marker (number+unit, length adjective,
 *     format anchor, comparative bound). If no marker is found, the
 *     request is unbounded.
 *   - One finding per unbounded request, each with line+column. The
 *     user can jump to the exact line and add a constraint.
 *
 * Severity: single LOW. Unbounded output is advisory; it produces
 * longer-than-expected responses but rarely catastrophic failure.
 *
 * Out of scope for v1: structural detection (treating the prompt as
 * a whole), multi-line trigger matching, semantic constraint detection
 * (e.g., understanding that "a definition" implies brevity).
 *
 * Known limitation: bullet-list behavioral guidelines that start with
 * an output verb get flagged as output requests. For example, in a
 * "For each finding:" instruction list, a bullet like "- Explain the
 * WHY behind the code" is a behavioral guideline (when you explain,
 * do it this way), not a request for unbounded output. The detector
 * cannot distinguish these from real output requests at the regex
 * level. A future Tier 2 LLM-assisted variant could read context;
 * for v1, accept the false positive class and document it.
 */

// ── Trigger configuration ────────────────────────────────────────────────

// Imperative verbs and phrasings that request output. Matched at line
// start (after optional leading whitespace, list markers, or numbered
// prefixes like "1." or "-"). Case-insensitive.
//
// Excluded by design:
//   show     - too generic, often refers to UI/visual output
//   answer   - usually has implicit format from the question
//   respond  - meta about format, not content
const TRIGGERS = [
  /\bwrite\b/i,
  /\blist\b/i,
  /\bdescribe\b/i,
  /\bexplain\b/i,
  /\bsummarize\b/i,
  /\bgenerate\b/i,
  /\bcreate\b/i,
  /\benumerate\b/i,
  /\boutline\b/i,
  /\btell me about\b/i,
  /\bgive me\b/i,
  /\bprovide\b/i,
];

// Markers that indicate the request is bounded. Any one within the
// window around a trigger is enough to treat the request as bounded.
const CONSTRAINT_MARKERS = [
  // Numbers with units: "5 items", "3 paragraphs", "200 words", "4 steps"
  /\b\d+\s+(items?|paragraphs?|words?|sentences?|lines?|characters?|chars?|bullets?|points?|examples?|steps?|sections?|entries|results?|rows?|reasons?|tips?|ideas?|options?|choices?|things?)\b/i,
  // Length adjectives
  /\b(brief|briefly|short|shortly|concise|concisely|terse|tersely|one[- ]sentence|one[- ]line|single[- ]paragraph|single[- ]sentence|two[- ]sentence|few[- ]word)\b/i,
  // Format constraints
  /\bas\s+(a|an)\s+(json|yaml|xml|csv|table|markdown|list|bullet|paragraph|sentence|tweet|email|haiku|sonnet)\b/i,
  /\bin\s+(json|yaml|xml|csv|markdown|table)\s+format\b/i,
  // Format-as-template constraint: 'format as "..."' or 'formatted as ...' — the
  // request supplies an explicit format string, so output shape is bounded by it.
  /\bformat(?:ted)?\s+as\b/i,
  // 'In the form of X', 'in this format:', 'using this template' — explicit
  // format-supplied bounding.
  /\b(in\s+the\s+form\s+of|in\s+this\s+format|using\s+this\s+template|following\s+this\s+(?:format|template|schema|shape))\b/i,
  // Comparative bounds
  /\b(no\s+more\s+than|at\s+most|at\s+least|fewer\s+than|less\s+than|up\s+to|limit\s+to|limited\s+to|maximum\s+of|max\s+of|minimum\s+of|min\s+of)\s+\d+\b/i,
  // Specific format anchors with explicit count
  /\bin\s+\d+\s+(words?|sentences?|paragraphs?|lines?|characters?|chars?|bullets?|points?|steps?|items?)\b/i,
  /\b\d+(\s*[-\u2013]\s*|\s+to\s+)\d+\s+(words?|sentences?|paragraphs?|lines?|steps?|items?|bullets?|points?|examples?)\b/i,
  // Range with adjectives between number and unit: '2-4 plain English steps',
  // '3-5 actionable bullets', '5-10 detailed sentences'. The range and unit may
  // be separated by up to ~30 chars of adjectives/qualifiers.
  /\b\d+(\s*[-\u2013]\s*|\s+to\s+)\d+\s+\S+(?:\s+\S+){0,4}\s+(words?|sentences?|paragraphs?|lines?|steps?|items?|bullets?|points?|examples?)\b/i,
  // Bare-count with adjectives between number and unit: '5 plain English steps',
  // '3 actionable bullets'.
  /\b\d+\s+\S+(?:\s+\S+){0,4}\s+(items?|paragraphs?|words?|sentences?|lines?|bullets?|points?|examples?|steps?|sections?|entries|results?|rows?|reasons?|tips?|ideas?|options?|choices?|things?)\b/i,
];

// How far around a trigger we look for a constraint marker.
// Forward-weighted because English request grammar puts constraints
// after the verb: "write a 200-word essay" is common; "in 200 words,
// write..." is rare but supported by the modest back-window.
const WINDOW_BACK = 50;
const WINDOW_FORWARD = 150;

// ── Core ─────────────────────────────────────────────────────────────────

/**
 * For a given line and column position, extract the surrounding window
 * (in the full prompt text) and check for any constraint marker.
 */
function hasNearbyConstraint(promptText, charIndex) {
  const start = Math.max(0, charIndex - WINDOW_BACK);
  const end = Math.min(promptText.length, charIndex + WINDOW_FORWARD);
  const window = promptText.slice(start, end);
  for (const marker of CONSTRAINT_MARKERS) {
    if (marker.test(window)) return true;
  }
  return false;
}

/**
 * For a single line, check whether it begins (after optional leading
 * whitespace and common list markers) with a trigger verb. Returns
 * { matched: bool, verb: string, columnInLine: number } where
 * columnInLine is 1-indexed.
 */
function matchTriggerAtLineStart(line) {
  // Strip optional leading whitespace and common list markers:
  //   "- ", "* ", "1. ", "2) ", "> ", or just whitespace
  const PREFIX = /^(\s*(?:[-*>]\s+|\d+[.)]\s+)?)/;
  const m = line.match(PREFIX);
  const prefixLen = m ? m[1].length : 0;
  const remainder = line.slice(prefixLen);

  for (const trigger of TRIGGERS) {
    // Anchor the trigger to start of remainder. Triggers in the list
    // already use \b boundaries internally; we add ^ here.
    const anchored = new RegExp('^' + trigger.source, trigger.flags);
    const t = remainder.match(anchored);
    if (t) {
      return {
        matched: true,
        verb: t[0],
        columnInLine: prefixLen + 1,
        isBullet: prefixLen > 0 && /[-*>]\s|\d+[.)]\s/.test(line.slice(0, prefixLen)),
      };
    }
  }
  return { matched: false };
}

/**
 * Decide whether a bullet line is a behavioral-guideline rule rather than
 * an output request. The heuristic: if the bullet sits under an introducing
 * line that ends with a colon and looks like a 'rules' header ("When
 * answering:", "For each finding:", "Rules:", "Guidelines:"), the bullets
 * underneath are behavioral guidelines, not output requests. This prevents
 * false positives on prompts that say things like:
 *   When answering questions:
 *   - Explain the WHY behind code, not just the WHAT
 *
 * Only applies to lines that start with a list marker (-, *, >, 1.). A bare
 * paragraph that begins with 'Explain' is still treated as a request.
 */
function isBehavioralGuidelineBullet(lines, lineIndex) {
  const BULLET_LINE = /^\s*(?:[-*>]\s+|\d+[.)]\s+)/;
  // Walk backwards skipping blank lines AND other bullet lines (sibling items
  // in the same list). The line we want is the non-bullet line that
  // introduces the list — typically a sentence ending with a colon.
  for (let j = lineIndex - 1; j >= 0; j--) {
    const raw = lines[j];
    const prev = raw.trim();
    if (prev.length === 0) continue;
    if (BULLET_LINE.test(raw)) continue;
    // First non-empty, non-bullet line above the target. If it doesn't end
    // with a colon, the bullets above are not under a list header.
    if (!prev.endsWith(':')) return false;
    const RULE_HEADER = /\b(when|for each|for every|rules?|guidelines?|behavior|behaviour|principles?|how (you|to) (answer|behave|respond|operate|work)|in (your )?responses?|while (analyzing|reviewing|answering)|when (answering|analyzing|reviewing|generating)|always|never)\b.*:$/i;
    return RULE_HEADER.test(prev);
  }
  return false;
}

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  const findings = [];
  const lines = promptText.split('\n');

  // We need the absolute char index of each line start to compute the
  // window into the full prompt text. Build a running offset.
  let lineOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const result = matchTriggerAtLineStart(line);
    if (result.matched) {
      const triggerCharIndex = lineOffset + (result.columnInLine - 1);
      const bounded = hasNearbyConstraint(promptText, triggerCharIndex);
      const isBehavioralGuideline = result.isBullet && isBehavioralGuidelineBullet(lines, i);
      if (!bounded && !isBehavioralGuideline) {
        findings.push({
          detector: 'output/unbounded',
          severity: 'LOW',
          title: 'Unbounded output request',
          file: filePath,
          location: { line: i + 1, column: result.columnInLine },
          detail:
            'The request "' + result.verb + '" on line ' + (i + 1) + ' '
            + 'does not specify a length, count, format, or other '
            + 'stopping criterion. The model may produce a response that '
            + 'is much longer or shorter than intended, and downstream '
            + 'processing that expects a bounded shape may break.',
          remediation:
            'Add a constraint to the request. For length: "in 200 words", '
            + '"in 3-5 sentences", "no more than one paragraph". For '
            + 'count: "list the top 5", "give 3 examples". For format: '
            + '"as a JSON object", "as a markdown table". The right '
            + 'constraint depends on what downstream code or readers '
            + 'expect.',
          confidence: 75,
        });
      }
    }
    // Advance offset past this line and the \n that split() consumed.
    lineOffset += line.length + 1;
  }

  return findings;
}
