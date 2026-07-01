/**
 * src/prompt-pack/integrationMismatch.js
 *
 * Detector #16: Integration mismatch (Tier 3, hybrid regex + LLM).
 *
 * The first and only Tier 3 detector. Tier 3 means hybrid: a cheap
 * regex pass identifies candidate sites (places in the prompt that
 * make integration-shape declarations), then an LLM call verifies
 * whether those declarations are internally consistent. The two-stage
 * pattern keeps cost bounded — prompts with no integration-shape
 * declarations skip the LLM call entirely.
 *
 * Defect definition: a prompt makes claims about its integration
 * shape (output format, tool/function schemas, expected response
 * envelope, model parameters) and those claims contradict each other
 * or contradict an example/template/few-shot in the same prompt. The
 * defect is internal: the prompt's own integration declarations do
 * not agree.
 *
 * v1 SCOPE — prompt-internal consistency only. Ghost cannot see the
 * calling code, the actual tool definitions, or the downstream parser.
 * Cross-system mismatch (where the prompt says "respond in JSON" and
 * the calling code uses a markdown parser) requires Ghost to analyze
 * both sides; that is a v5.3+ extension when calling-code analysis
 * is added. v5.2 ships the prompt-internal version.
 *
 * Common shapes:
 *
 *   - Output-format declaration drift:
 *     Top of prompt says "respond as a JSON object with keys 'answer'
 *     and 'confidence'." Few-shot example shows a markdown response
 *     with bold headers. The prompt declares a contract its own
 *     example breaks.
 *
 *   - Tool-schema field-name drift:
 *     Prompt declares a tool schema with field 'user_id'. Later
 *     instruction or example references 'userId' or 'uid'. Same
 *     concept, different identifier, no reconciliation.
 *
 *   - Tool-name mismatch:
 *     Prompt instructs "use the submit_form() function" but the
 *     declared tool list shows 'form_submit' or no such tool exists.
 *
 *   - Envelope-shape mismatch:
 *     Prompt says "wrap your reasoning in <thinking> tags." Example
 *     shows reasoning as a numbered list with no tags. Or vice versa.
 *
 *   - Parameter-vs-instruction tension:
 *     Prompt declares "temperature: 0.0, deterministic" while
 *     instructing "explore alternative approaches creatively."
 *
 * What this detector is NOT for:
 *
 *   - General two-rule conflict that has nothing to do with integration
 *     shape (use conflictingInstructions). If the conflict is "be
 *     concise" vs "be exhaustive", that is conflictingInstructions,
 *     not integration mismatch. The line: integration mismatch is
 *     specifically about declared INTEGRATION CONTRACTS — schemas,
 *     formats, tool definitions, envelopes — not general directive
 *     conflict.
 *
 *   - Output structure simply being undefined (use undefinedOutputFormat).
 *     If the prompt says "respond as JSON" and never lists fields,
 *     that is an undefined format, not a mismatch. Flag here only
 *     when the prompt makes TWO OR MORE integration declarations and
 *     they disagree.
 *
 *   - Few-shot example quality issues that are not contract mismatches
 *     (use inefficientFewShot). If the few-shot is just a placeholder
 *     or a poorly-chosen example, that's not an integration mismatch.
 *     Flag here only when the few-shot demonstrates a SHAPE that
 *     contradicts a stated SCHEMA elsewhere in the prompt.
 *
 *   - Single ambiguous instruction (use ambiguousInstruction). Mismatch
 *     requires TWO declarations that disagree. One unclear instruction
 *     is ambiguity, not mismatch.
 *
 *   - Missing rubrics for severity/effort/complexity scales (use
 *     underspecifiedConstraints). Those are missing measurement
 *     criteria, not declared contract drift.
 *
 * Severity policy:
 *   The LLM returns severity. HIGH, MEDIUM, and LOW all pass through
 *   (v5.3 removed the cap-at-MEDIUM limit — see capSeverity() below).
 *   HIGH is reserved for prompts that are genuinely broken per the
 *   severity framework in llmAuditClient.js.
 *
 * Confidence: 65. Slightly higher than Tier 2 (60) because the regex
 * pre-filter eliminates prompts with no integration declarations,
 * focusing LLM judgment on candidates that have at least two declared
 * shapes to compare. Lower than Tier 1 (70-95) because the final call
 * is still an LLM judgment on whether the shapes genuinely disagree.
 *
 * Findings cap: 5 per prompt. Tighter cap than Tier 2 detectors
 * (which use 10) because prompt-internal integration mismatches
 * cluster — one inconsistent contract usually generates several
 * related findings. After 5 the user has the signal; more is noise.
 */

import { auditPromptForDefect } from './llmAuditClient.js';

const FINDINGS_CAP = 10;

// ── Regex pre-filter: integration-declaration markers ────────────────────

// Each pattern matches a kind of integration declaration. The detector
// requires AT LEAST TWO matches across distinct categories (or two
// matches within the same category referencing different shapes) before
// firing the LLM call. A prompt with one integration declaration cannot
// have an internal mismatch — there is nothing to disagree with.
const DECLARATION_PATTERNS = [
  // ── Output format declarations ─────────────────────────────────────
  {
    category: 'output-format',
    regex: /\b(respond|reply|return|output|answer|format(?:ted)?\s+as)\s+(in\s+|with\s+|as\s+)?(a|an|the)?\s*(json|yaml|xml|csv|tsv|markdown|html|plain\s+text|prose|bullet|numbered\s+list|table)\b/i,
  },
  {
    category: 'output-format',
    regex: /\boutput\s+format\s*:/i,
  },
  {
    category: 'output-format',
    regex: /\bresponse\s+(format|shape|schema|structure)\s*:/i,
  },

  // ── Tool / function declarations ───────────────────────────────────
  {
    category: 'tool-declaration',
    regex: /\b(tools?|functions?)\s+available\s*:/i,
  },
  {
    category: 'tool-declaration',
    regex: /\b(call|invoke|use)\s+the\s+\w+(_\w+)*\s*\(\s*\)/i,
  },
  {
    category: 'tool-declaration',
    regex: /\bfunction\s+(name|signature)\s*:/i,
  },

  // ── Schema-shape declarations ──────────────────────────────────────
  {
    category: 'schema-declaration',
    regex: /\b(schema|fields?|keys?|properties|columns?)\s*:/i,
  },
  {
    category: 'schema-declaration',
    regex: /\b\{\s*"?(\w+)"?\s*:/, // detects JSON-shaped declarations like { "field": ... }
  },

  // ── Envelope / wrapper declarations ────────────────────────────────
  {
    category: 'envelope-declaration',
    regex: /\bwrap(ped)?\s+(in|with)\s+<\w+>/i,
  },
  {
    category: 'envelope-declaration',
    regex: /\b(enclose|inside|within)\s+<\w+>/i,
  },
  {
    category: 'envelope-declaration',
    regex: /<(thinking|answer|reasoning|response|output|result|tool_use|invoke)>/i,
  },

  // ── Model-parameter declarations ───────────────────────────────────
  {
    category: 'model-parameter',
    regex: /\btemperature\s*[:=]\s*[\d.]+/i,
  },
  {
    category: 'model-parameter',
    regex: /\b(deterministic|creative|exploratory|reproducible)\b/i,
  },

  // ── Few-shot or example declarations ───────────────────────────────
  {
    category: 'example-declaration',
    regex: /\b(example|few[- ]shot|sample|demonstration)\s*\d*\s*:/i,
  },
  {
    category: 'example-declaration',
    regex: /\binput\s*:.*\noutput\s*:/i, // input:/output: example pattern
  },
];

/**
 * Scan a prompt for integration-declaration markers. Returns the set
 * of distinct categories that fired and the total match count.
 *
 * @param {string} promptText
 * @returns {{ categories: Set<string>, totalMatches: number }}
 */
function scanForDeclarations(promptText) {
  const categories = new Set();
  let totalMatches = 0;
  for (const pattern of DECLARATION_PATTERNS) {
    if (pattern.regex.test(promptText)) {
      categories.add(pattern.category);
      totalMatches++;
    }
  }
  return { categories, totalMatches };
}

// ── Defect description and examples for the LLM verifier ─────────────────

const DEFECT_DESCRIPTION =
  'A prompt has an integration mismatch when it makes two or more '
  + 'declarations about its integration shape (output format, tool or '
  + 'function schemas, expected response envelope, model parameters, '
  + 'or few-shot examples) and those declarations contradict each '
  + 'other. The defect is internal to the prompt: the prompt declares '
  + 'a contract and then either restates it differently elsewhere, or '
  + 'demonstrates a different shape in an example.\n\n'
  + 'SCOPE OF THIS DETECTOR (read before flagging):\n'
  + 'This detector is specifically about INTEGRATION CONTRACTS that '
  + 'disagree with each other within the same prompt. Trip-wire: if a '
  + 'finding you are about to emit is just "two general directives '
  + 'are in tension" with no integration-shape angle, you are in the '
  + 'wrong detector \u2014 DROP that finding and continue. Conflicts about '
  + 'tone, length, scope, or general behavior belong to '
  + 'conflictingInstructions, not here. Flag here ONLY when the '
  + 'conflicting declarations are about machine-readable shape: JSON '
  + 'schemas, tool/function names, XML envelopes, response formats, '
  + 'temperature/parameter directives, or few-shot examples that '
  + 'demonstrate a structure different from what is stated elsewhere.\n\n'
  + 'Common shapes of integration mismatch:\n'
  + '  - Output-format declaration drift (top of prompt says JSON, '
  + 'few-shot example shows markdown).\n'
  + '  - Tool-schema field-name drift (declared field is "user_id", '
  + 'instruction or example references "userId").\n'
  + '  - Tool-name mismatch (instruction says "call submit_form()", '
  + 'declared tool list shows "form_submit").\n'
  + '  - Envelope-shape mismatch (prompt says "wrap reasoning in '
  + '<thinking> tags", example shows numbered-list reasoning with '
  + 'no tags).\n'
  + '  - Parameter-vs-instruction tension (prompt declares '
  + '"temperature: 0.0, deterministic" while instructing the model '
  + 'to "explore creative alternatives").\n\n'
  + 'Do NOT flag:\n'
  + '  - General directive conflict with no integration-shape angle. '
  + '"Be concise" vs "be exhaustive" is conflictingInstructions, not '
  + 'integration mismatch. Skip it.\n'
  + '  - Output format simply being undefined (no schema given for a '
  + 'declared JSON output). That is undefinedOutputFormat. Flag here '
  + 'ONLY when there are two or more declarations that disagree, not '
  + 'when there is one declaration with no spec.\n'
  + '  - Few-shot examples that are just bad (placeholders, poorly '
  + 'chosen, off-topic). Those are inefficientFewShot. Flag here '
  + 'ONLY when the few-shot demonstrates a shape that contradicts a '
  + 'stated schema elsewhere in the prompt.\n'
  + '  - Single ambiguous instruction with multiple readings. Mismatch '
  + 'requires TWO declarations that disagree, not one unclear one.\n'
  + '  - Missing rubrics for severity, complexity, or effort. Those '
  + 'are underspecifiedConstraints, not integration mismatch.\n'
  + '  - Stylistic preferences ("be friendly", "professional tone"). '
  + 'Not integration declarations.';

const POSITIVE_EXAMPLES =
  '  - Top of prompt says "Respond as a JSON object with fields '
  + '\'answer\' and \'confidence\'." Few-shot example shows a markdown '
  + 'response with **bold answer** and confidence as a percentage in '
  + 'parentheses. (Stated schema vs demonstrated shape disagree.)\n'
  + '  - Tool list declares get_user(user_id: string). Instruction '
  + 'later says "call get_user with the userId from the input." '
  + '(Field name drift: user_id vs userId.)\n'
  + '  - Prompt says "Wrap your reasoning in <thinking> tags before '
  + 'the final answer." Few-shot example shows reasoning as a '
  + 'numbered 1, 2, 3 list with no tags. (Envelope declaration vs '
  + 'demonstrated envelope disagree.)\n'
  + '  - Prompt declares "temperature: 0.0, deterministic output" '
  + 'and later instructs "be creative and explore alternative '
  + 'angles." (Parameter vs instruction.)';

const NEGATIVE_EXAMPLES =
  '  - "Respond as JSON" without a field schema. (That is '
  + 'undefinedOutputFormat, not mismatch \u2014 only one declaration, '
  + 'nothing to disagree with.)\n'
  + '  - "Be concise" and "Provide thorough detail" stated together. '
  + '(That is conflictingInstructions, not integration mismatch \u2014 '
  + 'general directive conflict, no integration shape involved.)\n'
  + '  - "Output as a markdown table" with the column list defined '
  + 'three paragraphs later. (Fully specified, just non-adjacent. '
  + 'Not a mismatch.)\n'
  + '  - "Use a formal tone" plus "keep it casual." (Tone conflict, '
  + 'belongs to conflictingInstructions.)\n'
  + '  - A few-shot example whose prose is awkward but whose output '
  + 'shape matches the stated schema. (Bad example quality is '
  + 'inefficientFewShot, not mismatch.)';

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  // Tier 3 requires a target model for the LLM verification phase. The
  // registry's requiresTargetModel: true flag means the mode file shows
  // a skip note when no model is set; we additionally guard here so a
  // detector called directly without a model doesn't error.
  if (!opts.targetModel) return [];

  // ── Phase 1: regex pre-filter ──────────────────────────────────────
  // A prompt needs at least TWO integration declarations across
  // categories OR three+ within one category for the LLM verification
  // to be useful. Single-declaration prompts cannot have an internal
  // mismatch by definition. Skipping them keeps cost bounded.
  const { categories, totalMatches } = scanForDeclarations(promptText);
  const hasMultipleCategories = categories.size >= 2;
  const hasManyMatchesInOneCategory = totalMatches >= 3;
  if (!hasMultipleCategories && !hasManyMatchesInOneCategory) {
    return [];
  }

  // ── Phase 2: LLM verification ──────────────────────────────────────
  const result = await auditPromptForDefect({
    detectorName: 'integrationMismatch',
    modelId: opts.targetModel,
    promptText,
    defectName: 'Integration mismatch',
    defectDescription: DEFECT_DESCRIPTION,
    positiveExamples: POSITIVE_EXAMPLES,
    negativeExamples: NEGATIVE_EXAMPLES,
  });

  if (!result.ok) {
    // Audit failed (SDK load, parse retry, API error). Fail open with
    // zero findings; the user sees no false positives from a broken
    // call.
    return [];
  }

  // Cap findings and append a summary if we exceeded.
  const llmFindings = result.findings;
  const truncated = llmFindings.length > FINDINGS_CAP;
  const visible = truncated ? llmFindings.slice(0, FINDINGS_CAP) : llmFindings;

  const findings = visible.map(f => ({
    detector: 'integrationMismatch',
    severity: capSeverity(f.severity),
    title: f.title,
    file: filePath,
    location: f.location_hint ? { hint: f.location_hint } : null,
    detail: f.detail,
    remediation: f.remediation,
    confidence: 65,
  }));

  if (truncated) {
    const remaining = llmFindings.length - FINDINGS_CAP;
    findings.push({
      detector: 'integrationMismatch',
      severity: 'LOW',
      title: 'Additional integration mismatches not shown',
      file: filePath,
      location: null,
      detail:
        remaining + ' additional integration-mismatch finding'
        + (remaining === 1 ? '' : 's')
        + ' were detected but not shown. The audit is capped at '
        + FINDINGS_CAP + ' findings per prompt to keep reports '
        + 'readable. Address the visible findings first; re-running '
        + 'the audit after fixes will surface remaining ones.',
      remediation:
        'Address the integration mismatches shown above first, then '
        + 're-run Prompt Triage on the updated prompt to surface any '
        + 'remaining issues.',
      confidence: 65,
    });
  }

  return findings;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Validate LLM-returned severity. v5.3 removed the cap-at-MEDIUM
 * limit — with proper severity calibration in the envelope (see
 * llmAuditClient.js), the LLM now correctly reserves HIGH for
 * prompts that are genuinely broken. Integration-contract mismatches
 * that demonstrably cause downstream parse failure (declared JSON
 * schema vs example showing prose) are exactly the kind of HIGH the
 * cap was hiding.
 */
function capSeverity(s) {
  if (s === 'HIGH' || s === 'MEDIUM' || s === 'LOW') return s;
  return 'LOW';
}
