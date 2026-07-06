/**
 * src/prompt-pack/injectionStaticPattern.js
 *
 * Detector #6: Static-pattern prompt injection (Tier 1, regex/structural).
 *
 * Maps to Tian et al. (2025) "Prompt injection" subtype under Security.
 * This is the first SECURITY detector in the pack — detectors 1-5 cover
 * prompt quality, this one covers prompt safety. Flags content in the
 * prompt that matches known prompt-injection patterns: instruction
 * override attempts, role hijack attempts, jailbreak markers, and
 * system prompt exfiltration attempts.
 *
 * Approach (per session decisions):
 *   - Pattern-based regex variants, not a static string list. Real
 *     attackers rephrase. "ignore previous instructions" is the canonical
 *     form but variants like "disregard the above directives" or
 *     "forget your prior rules" are equally effective and worth catching.
 *   - One finding per match, with line+column. The user can jump to the
 *     exact line and decide whether the match is malicious content,
 *     legitimate documentation about prompt injection, or a false alarm.
 *   - Single MEDIUM severity. We flag suspicious content; we don't
 *     assert the prompt is actually compromised. Tiering by category
 *     would imply a confidence we don't have at the regex level.
 *
 * Pattern categories shipped in v1:
 *   1. Instruction override: "ignore/disregard/forget the above instructions"
 *   2. Role hijack: "you are now", "pretend to be", "act as", "from now on"
 *   3. Jailbreak markers: "DAN mode", "developer mode", "without restrictions"
 *   4. System prompt exfiltration: "show me your system prompt", etc.
 *
 * Out of scope for v1: hidden-instruction chat-template tokens
 * (<|im_start|>, etc.), encoding-bypass detection (base64, zero-width
 * unicode), and semantic-context filtering.
 *
 * Known limitation: a prompt that LEGITIMATELY teaches or discusses
 * prompt injection will fire findings. Example: a security training
 * doc saying "common attacks include 'ignore previous instructions'
 * and 'you are now in DAN mode'." The detector cannot distinguish
 * these from real injection attempts at the regex level. A future
 * Tier 2 LLM-assisted variant could read context; for v1, accept
 * the false positive class and document it. Findings are advisory:
 * a security training doc with 5 injection findings is the detector
 * working correctly, just on content that doesn't need remediation.
 */

// ── Pattern configuration ────────────────────────────────────────────────

// Each pattern is { category, name, regex }. The category and name
// appear in the finding title and detail so users can tell at a
// glance what kind of injection signal was detected.
//
// Patterns use \b word boundaries where appropriate to reduce
// incidental matches (e.g., "ignore" in "ignored the warning"
// shouldn't match "ignore" in "ignore the above").
const PATTERNS = [
  // ── Category 1: Instruction override ──────────────────────────────────
  {
    category: 'instruction-override',
    name: 'Override of prior instructions',
    regex: /\b(ignore|disregard|forget|skip|override|bypass)\s+(the\s+|all\s+|any\s+)?(above|prior|preceding|previous|earlier|original|initial|former)\s+(instructions?|prompts?|rules?|directives?|context|messages?|guidelines?|constraints?)\b/i,
  },
  {
    // F-05: instruction override via possessive determiner. Matches
    // "ignore your safety rules", "forget your guidelines", "override
    // your constraints". Disjoint from the position-word entry above
    // because the possessive slot does not overlap that pattern.
    category: 'instruction-override',
    name: 'Override of safety/system instructions (possessive form)',
    regex: /\b(ignore|disregard|forget|skip|override|bypass)\s+(your|my|its|their)\s+([a-z]+\s+){0,2}(instructions?|prompts?|rules?|directives?|guidelines?|constraints?|safeguards?|restrictions?|filters?|limits?|limitations?|context|messages?)\b/i,
  },
  {
    // F-05: instruction override via generic article + non-position-word.
    // Matches "override the system prompt", "bypass any restrictions",
    // "ignore all rules". Negative lookahead on position words prevents
    // double-firing with the entry above when phrasing includes "above",
    // "prior", "preceding", etc.
    category: 'instruction-override',
    name: 'Override of system instructions (generic article form)',
    regex: /\b(ignore|disregard|forget|skip|override|bypass)\s+(the|all|any)\s+(?!above\b|prior\b|preceding\b|previous\b|earlier\b|original\b|initial\b|former\b)([a-z]+\s+){0,2}(instructions?|prompts?|rules?|directives?|guidelines?|constraints?|safeguards?|restrictions?|filters?|limits?|limitations?|context|messages?|system\s+prompt)\b/i,
  },
  {
    category: 'instruction-override',
    name: 'Override of prior instructions (reversed phrasing)',
    regex: /\b(the\s+|all\s+|any\s+)?(above|prior|preceding|previous|earlier|original|initial)\s+(instructions?|prompts?|rules?|directives?|guidelines?)\s+(are|were)\s+(wrong|incorrect|invalid|outdated|cancelled|canceled|superseded|replaced)\b/i,
  },
  {
    category: 'instruction-override',
    name: 'New instructions claim',
    regex: /\b(your\s+(real|true|actual|new|updated)\s+(instructions?|task|job|role|purpose|prompt))\b/i,
  },

  // ── Category 2: Role hijack ───────────────────────────────────────────
  {
    category: 'role-hijack',
    name: 'Role reassignment',
    regex: /\byou\s+are\s+now\s+(a|an|the)?\s*\w+/i,
  },
  {
    category: 'role-hijack',
    name: 'Pretend/act-as instruction',
    regex: /\b(pretend\s+(to\s+be|you\s+are)|act\s+as\s+(a|an|the)|roleplay\s+as|behave\s+(as|like))\b/i,
  },
  {
    category: 'role-hijack',
    name: 'Persona override',
    regex: /\byour\s+new\s+(role|task|persona|character|identity|name)\b/i,
  },
  {
    category: 'role-hijack',
    name: 'Reset framing',
    regex: /\bfrom\s+now\s+on\s+(you|your)\b/i,
  },

  // ── Category 3: Jailbreak markers ─────────────────────────────────────
  {
    category: 'jailbreak-marker',
    name: 'Named jailbreak persona',
    regex: /\b(DAN\s+mode|developer\s+mode|god\s+mode|admin\s+mode|jailbreak\s+mode|unrestricted\s+(mode|version|assistant)|do\s+anything\s+now)\b/i,
  },
  {
    category: 'jailbreak-marker',
    name: 'Restriction bypass',
    regex: /\bwithout\s+(any\s+|the\s+|your\s+|usual\s+|normal\s+)?(restrictions?|filters?|guidelines?|rules?|limits?|limitations?|safeguards?|safety\s+(rails?|measures?))\b/i,
  },
  {
    category: 'jailbreak-marker',
    name: 'Capability unlock claim',
    regex: /\b(you\s+can\s+(now\s+)?(do\s+anything|say\s+anything|ignore\s+(your\s+)?(safety|content|ethical)))\b/i,
  },

  // ── Category 4: System prompt exfiltration ────────────────────────────
  {
    category: 'system-prompt-exfiltration',
    name: 'System prompt disclosure request',
    regex: /\b(show|reveal|print|output|repeat|tell\s+me|what\s+(is|are)|give\s+me)\s+(me\s+)?(your\s+|the\s+)?(system\s+prompt|initial\s+(instructions?|prompt)|original\s+(instructions?|prompt)|hidden\s+(instructions?|prompt)|prompt\s+(above|that\s+came\s+before))\b/i,
  },
  {
    category: 'system-prompt-exfiltration',
    name: 'Verbatim disclosure request',
    regex: /\b(repeat|echo|reproduce|copy)\s+(everything|all|the\s+entire)\s+(above|prior|preceding|previous)\b/i,
  },
];

// ── Core ─────────────────────────────────────────────────────────────────

/**
 * Convert a character index in promptText into { line, column }
 * (1-indexed). Used to attach human-readable locations to findings.
 */
function charIndexToLocation(promptText, charIndex) {
  // Count newlines before charIndex to get the line number.
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < charIndex; i++) {
    if (promptText.charCodeAt(i) === 10) { // '\n'
      line++;
      lastNewline = i;
    }
  }
  const column = charIndex - lastNewline;
  return { line, column };
}

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  const safeText = String(promptText ?? '');
  const findings = [];

  for (const pattern of PATTERNS) {
    // Use a global, sticky search so we can find every match in the
    // prompt rather than just the first.
    const globalRe = new RegExp(pattern.regex.source, pattern.regex.flags + 'g');
    let match;
    while ((match = globalRe.exec(safeText)) !== null) {
      const matchedText = match[0];
      const charIndex = match.index;
      const { line, column } = charIndexToLocation(safeText, charIndex);

      findings.push({
        detector: 'injectionStaticPattern',
        severity: 'MEDIUM',
        title: 'Possible prompt injection: ' + pattern.name,
        file: filePath,
        location: { line, column },
        detail:
          'Line ' + line + ' contains text matching a known prompt-injection '
          + 'pattern in category "' + pattern.category + '": "'
          + truncateForDisplay(matchedText) + '". This phrasing is '
          + 'commonly used in attacks that try to override system '
          + 'instructions, hijack the assistant role, bypass safety '
          + 'measures, or exfiltrate hidden context. The match itself '
          + 'is not proof of an attack; legitimate documentation that '
          + 'discusses prompt injection will fire the same finding.',
        remediation:
          'Verify the match. If the prompt is incorporating user-supplied '
          + 'or third-party content, isolate that content (e.g., enclose '
          + 'in quoted XML tags and instruct the model to treat the '
          + 'enclosed text as data, not instructions). If the prompt '
          + 'legitimately discusses prompt injection patterns, suppress '
          + 'this finding by adding context that makes the match '
          + 'recognizable as documentation rather than instruction.',
        confidence: 70,
      });

      // Guard against zero-length matches creating an infinite loop.
      // Defensive: none of our regexes can match zero-length strings,
      // but the pattern is cheap insurance.
      if (match.index === globalRe.lastIndex) globalRe.lastIndex++;
    }
  }

  // Sort findings by line, then column, so output is read top-to-bottom
  // even though pattern iteration order doesn't follow file order.
  findings.sort((a, b) => {
    if (a.location.line !== b.location.line) {
      return a.location.line - b.location.line;
    }
    return a.location.column - b.location.column;
  });

  return findings;
}

/**
 * Trim long matched text to a readable preview. Keeps the first 80
 * chars and appends an ellipsis if truncation occurred.
 */
function truncateForDisplay(text) {
  if (text.length <= 80) return text;
  return text.slice(0, 77) + '...';
}
