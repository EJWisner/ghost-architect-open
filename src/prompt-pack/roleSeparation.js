/**
 * src/prompt-pack/roleSeparation.js
 *
 * Detector #7: Role separation defects (Tier 1, regex/structural).
 *
 * Maps to Tian et al. (2025) "Role confusion" subtype under Prompt
 * Structure. Detects three concrete role-separation defects:
 *
 *   (a) Multiple <system> blocks in the same prompt. Models can be
 *       confused about which system instructions are authoritative
 *       when more than one appears.
 *
 *   (b) Mixed role conventions: an XML role tag (<system>, <user>,
 *       <assistant>) appears alongside a line-marker convention
 *       ("User:", "Assistant:", "Human:"). Sloppy authoring; the
 *       prompt switches frames midway and may confuse role-aware
 *       models.
 *
 *   (c) Stray line markers ("User:", "Assistant:", "Human:") that
 *       appear OUTSIDE a few-shot example context. A few-shot block
 *       legitimately contains these markers as demonstration; the
 *       same markers in instruction text suggest copy-paste residue
 *       or a confused author.
 *
 * Approach (per session decisions):
 *   - Multiple <system>: structural count of <system>...</system>
 *     blocks. Findings emit per *additional* block beyond the first
 *     so a prompt with 3 system blocks fires 2 findings.
 *   - Mixed conventions: presence check for both XML role tags AND
 *     line markers. One summary finding per prompt.
 *   - Stray line markers: scan each line that begins with
 *     "User:" / "Assistant:" / "Human:" and check the previous
 *     ~20 lines for a few-shot signal word. If absent, fire a
 *     finding.
 *
 * Severity policy:
 *   Multiple <system>: HIGH (real model-confusion source)
 *   Mixed conventions: MEDIUM (sloppy but recoverable)
 *   Stray line markers: LOW (the model usually still works)
 *
 * Out of scope for v1: pronoun-shift detection (you -> I -> we),
 * which is too noisy at the regex level. Inconsistent <user> /
 * <assistant> ordering is also out of scope for v1.
 *
 * Few-shot suppression heuristic looks for literal framing keywords:
 * "example(s)", "for instance", "demonstration", "few-shot", "few shot",
 * "sample exchange/interaction/conversation", "typical conversation",
 * "transcript", "dialogue". F-06 (v5.3.1) extended the original list
 * to cover transcript/dialogue/typical-conversation framings that were
 * missed in v1. Tier 2 LLM-assisted variant could read context to
 * distinguish framing usage from incidental mention; the bounded
 * 20-line upward scan keeps false suppression cost low.
 */

// ── Regex configuration ──────────────────────────────────────────────────

// XML role tags. We match opening tags with optional attributes.
// We don't try to match self-closing or weirdly-nested forms; real
// prompts use plain <system>...</system> shapes.
const SYSTEM_TAG_OPEN = /<system\b[^>]*>/gi;
const ANY_ROLE_TAG_OPEN = /<(system|user|assistant|human)\b[^>]*>/gi;

// Line-marker convention. Anchored to start of line, optionally
// preceded by markdown list/quote markers, followed by colon and
// at least one space.
const LINE_MARKER = /^(\s*(?:[-*>]\s+)?)(User|Assistant|Human)\s*:\s+/i;

// Few-shot signal words. Scanned upward from a stray-marker line.
// Case-insensitive. The list is intentionally short; we accept that
// some legitimate few-shot contexts will be missed and fire a LOW
// finding (documented as known limitation).
const FEWSHOT_SIGNAL = /\b(example|examples|for\s+instance|demonstration|few[- ]shot|sample\s+(exchange|interaction|conversation)|typical\s+conversation|transcript|dialogue)\b/i;

// How far to scan upward from a line-marker line when checking for
// few-shot framing. 20 lines is wide enough to catch "Examples:" at
// the top of a section without dragging in unrelated framing far
// above.
const FEWSHOT_SCAN_LINES = 20;

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a character index into { line, column } (1-indexed).
 */
function charIndexToLocation(promptText, charIndex) {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < charIndex; i++) {
    if (promptText.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: charIndex - lastNewline };
}

/**
 * Find every <system> opening-tag match in the prompt with location.
 * Returns array of { charIndex, line, column }.
 */
function findSystemTagOpens(promptText) {
  const out = [];
  const re = new RegExp(SYSTEM_TAG_OPEN.source, SYSTEM_TAG_OPEN.flags);
  let match;
  while ((match = re.exec(promptText)) !== null) {
    const loc = charIndexToLocation(promptText, match.index);
    out.push({ charIndex: match.index, line: loc.line, column: loc.column });
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

/**
 * Scan upward from a line index looking for a few-shot signal.
 * Returns true if the signal is found within FEWSHOT_SCAN_LINES.
 */
function hasFewshotSignalAbove(lines, lineIdx) {
  const start = Math.max(0, lineIdx - FEWSHOT_SCAN_LINES);
  for (let i = lineIdx - 1; i >= start; i--) {
    if (FEWSHOT_SIGNAL.test(lines[i])) return true;
  }
  return false;
}

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  const safeText = String(promptText ?? '');
  const findings = [];
  const lines = safeText.split('\n');

  // ── Check (a): Multiple <system> blocks ────────────────────────────────
  const systemOpens = findSystemTagOpens(safeText);
  if (systemOpens.length > 1) {
    // Emit one finding per *additional* block beyond the first.
    for (let i = 1; i < systemOpens.length; i++) {
      const { line, column } = systemOpens[i];
      findings.push({
        detector: 'roleSeparation/multipleSystem',
        severity: 'HIGH',
        title: 'Multiple <system> blocks',
        file: filePath,
        location: { line, column },
        detail:
          'A second (or later) <system> block opens at line ' + line + '. '
          + 'Most LLMs treat the entire system message as authoritative '
          + 'context; multiple <system> blocks force the model to decide '
          + 'which one is the real system message and which is content. '
          + 'This is a common source of inconsistent or contradictory '
          + 'model behavior.',
        remediation:
          'Merge all system instructions into a single <system> block at '
          + 'the top of the prompt. If the additional blocks are meant to '
          + 'represent different role contexts (e.g., user input, tool '
          + 'output), use the appropriate <user> or <assistant> tag '
          + 'instead, or remove the framing entirely if the content is '
          + 'just instruction text.',
        confidence: 90,
      });
    }
  }

  // ── Check (b): Mixed XML role tags + line markers ─────────────────────
  const hasAnyRoleTag = ANY_ROLE_TAG_OPEN.test(safeText);
  // Reset lastIndex; .test() advanced the regex's internal pointer.
  ANY_ROLE_TAG_OPEN.lastIndex = 0;

  let hasAnyLineMarker = false;
  for (const line of lines) {
    if (LINE_MARKER.test(line)) {
      hasAnyLineMarker = true;
      break;
    }
  }

  if (hasAnyRoleTag && hasAnyLineMarker) {
    findings.push({
      detector: 'roleSeparation/mixedConventions',
      severity: 'MEDIUM',
      title: 'Mixed role conventions',
      file: filePath,
      location: null,
      detail:
        'The prompt mixes two role-marking conventions: XML role tags '
        + '(such as <system>, <user>, <assistant>) and line markers '
        + '(such as "User:", "Assistant:", "Human:"). Most LLMs handle '
        + 'one convention or the other cleanly, but mixing them in the '
        + 'same prompt is sloppy authoring and can cause role parsing '
        + 'errors in role-aware tooling that walks the prompt structure.',
      remediation:
        'Pick one convention and use it consistently. XML role tags are '
        + 'typical for Anthropic-shaped prompts; line markers are typical '
        + 'for OpenAI-style few-shot examples. If the line markers are '
        + 'inside a few-shot example block, consider isolating that block '
        + 'inside its own <example>...</example> tag so the role '
        + 'separation is unambiguous.',
      confidence: 80,
    });
  }

  // ── Check (c): Stray line markers outside few-shot context ────────────
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_MARKER);
    if (!m) continue;
    if (hasFewshotSignalAbove(lines, i)) continue;

    const role = m[2];
    const prefixLen = m[1].length;
    findings.push({
      detector: 'roleSeparation/strayLineMarker',
      severity: 'LOW',
      title: 'Stray ' + role + ': line marker',
      file: filePath,
      location: { line: i + 1, column: prefixLen + 1 },
      detail:
        'Line ' + (i + 1) + ' begins with "' + role + ':", a line marker '
        + 'commonly used inside few-shot example blocks. No few-shot '
        + 'framing word (such as "example", "demonstration", "for '
        + 'instance", "transcript", "dialogue") was found in the '
        + 'preceding lines. The marker '
        + 'may be copy-paste residue, a confused authoring style, or '
        + 'an attempt to embed a fake conversation turn into the '
        + 'instruction text.',
      remediation:
        'If the marker is meant to start a few-shot example block, add '
        + 'an explicit framing line above it (e.g., "Examples:" or "For '
        + 'instance:"). If the marker is left over from earlier editing, '
        + 'remove it. If the line is genuinely instruction text and the '
        + '"' + role + ':" prefix is intentional (rare), rephrase to '
        + 'avoid the role-marker convention.',
      confidence: 70,
    });
  }

  // Sort findings by line, then column, so output is read top-to-bottom
  // even though checks (a)/(b)/(c) run in their own order.
  findings.sort((a, b) => {
    const aLine = a.location ? a.location.line : 0;
    const bLine = b.location ? b.location.line : 0;
    if (aLine !== bLine) return aLine - bLine;
    const aCol = a.location ? a.location.column : 0;
    const bCol = b.location ? b.location.column : 0;
    return aCol - bCol;
  });

  return findings;
}
