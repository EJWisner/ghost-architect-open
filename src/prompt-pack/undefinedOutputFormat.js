/**
 * src/prompt-pack/undefinedOutputFormat.js
 *
 * Detector #11: Undefined output format (Tier 2, LLM-augmented).
 *
 * Maps to Tian et al. (2025) "Undefined output format" subtype under
 * Output Specification.
 *
 * Defect definition: a prompt asks the model to produce output but
 * does not specify the structure of that output. The model has to
 * invent the shape: what fields, what nesting, what delimiters, what
 * order, what sections. Two reasonable models given the same input
 * will produce structurally different outputs because the format
 * specification is missing.
 *
 * Common shapes:
 *
 *   - Stated container, no schema:
 *     "Output as JSON" without listing required fields and types.
 *     "Return XML" without a tag structure.
 *     "Give me a CSV" without naming columns.
 *   - Named structure, no fields:
 *     "Provide a report" without saying what sections.
 *     "Write a summary" without saying what dimensions it covers.
 *     "Create a table" without naming columns or row meaning.
 *   - Composite without structure:
 *     "Give me the answer and your reasoning."
 *     (Concatenated? Labeled sections? JSON keys? The model picks.)
 *   - Ordering implied but unspecified:
 *     "List the issues and their fixes."
 *     (Issue then fix interleaved? All issues then all fixes? Table?)
 *   - Format inherited from context but never stated:
 *     A long analytical prompt that never specifies whether the
 *     response should be markdown, plain prose, a code block, etc.
 *
 * What this detector is NOT for:
 *   - Output bound issues like missing length caps. That is a
 *     different defect class (unboundedOutput, Tier 1). The two can
 *     co-fire when the prompt is missing both length and shape; that
 *     is correct, not a duplicate.
 *   - Pronoun, scope, or quantifier ambiguity in the action being
 *     requested. Those belong to ambiguousInstruction. Even if a
 *     finding could plausibly be read as "the format is unclear", if
 *     the defect is really "the instruction has multiple readings",
 *     it belongs in ambiguousInstruction, not here.
 *   - Two stated formats in tension (e.g. "output as JSON" and "use
 *     markdown headers" in the same prompt). That is conflicting
 *     instructions. Flag here only when ONE format is named (or
 *     implied) and its specification is incomplete.
 *   - Missing rubrics for ratings or quality bars. That is
 *     underspecifiedConstraints.
 *   - Prompts where the format is named AND the field/content spec
 *     exists elsewhere in the same prompt. Example: "output a
 *     markdown table" with the column list defined three paragraphs
 *     later is fully specified, even if it is awkwardly organized.
 *     Flag only when the spec is genuinely absent, not when it is
 *     just non-adjacent.
 *   - Cases where the output is naturally free-form and a structure
 *     spec would be silly (e.g. "write a poem about resilience" does
 *     not need a JSON schema). Flag only when the prompt's task
 *     implies the consumer needs structured output: parsing,
 *     downstream processing, comparison across runs, automated
 *     extraction.
 *
 * The line: the prompt names a format or implies a structured
 * consumer AND the structure is not defined anywhere in the prompt.
 * Not "the prompt is informal" or "the format could be tighter."
 * Real missing-spec, not perceived looseness.
 *
 * Severity policy:
 *   The LLM returns severity. HIGH, MEDIUM, and LOW all pass through
 *   (v5.3 removed the cap-at-MEDIUM limit — see capSeverity() below).
 *   HIGH is reserved for prompts that are genuinely broken per the
 *   severity framework in llmAuditClient.js.
 *
 * Confidence: 60. Same as the three live Tier 2 siblings.
 *
 * Findings cap: 10 per prompt. Same policy as siblings.
 */

import { auditPromptForDefect } from './llmAuditClient.js';

const FINDINGS_CAP = 10;

const DEFECT_DESCRIPTION =
  'A prompt has an undefined output format when it asks the model to '
  + 'produce output but does not specify the structure of that output. '
  + 'The model has to invent the shape: what fields, what nesting, '
  + 'what delimiters, what order, what sections. Two reasonable models '
  + 'given the same input will produce structurally different outputs '
  + 'because the format specification is missing.\n\n'
  + 'SCOPE OF THIS DETECTOR (read before flagging):\n'
  + 'This detector covers OUTPUT STRUCTURE specification gaps only. '
  + 'It does NOT cover output length (that is unboundedOutput, a '
  + 'different detector). It does NOT cover ambiguity in the action '
  + 'being requested (that is ambiguousInstruction). It does NOT '
  + 'cover two stated formats in tension (that is conflicting '
  + 'instructions). It does NOT cover missing rubrics for ratings '
  + 'or quality bars (that is underspecifiedConstraints). Flag here '
  + 'ONLY when the prompt names a format or implies a structured '
  + 'consumer AND the structure is not defined anywhere in the '
  + 'prompt. Trip-wire: if a finding you are about to emit would '
  + 'use the words "ambiguous", "multiple readings", "conflicting", '
  + '"contradictory", "in tension", "mutually exclusive", "cannot '
  + 'both be satisfied", "no length cap", "rubric", or "criteria" '
  + 'in its title or detail, you are in the wrong detector — DROP '
  + 'that finding and continue. Do not emit it.\n\n'
  + 'Common shapes of undefined output format:\n'
  + '  - Stated container, no schema (e.g. "output as JSON" without '
  + 'listing required fields; "return XML" without tag structure; '
  + '"give me a CSV" without column headers)\n'
  + '  - Named structure, no fields (e.g. "provide a report" without '
  + 'saying what sections; "write a summary" without saying what '
  + 'dimensions it covers; "create a table" without naming columns)\n'
  + '  - Composite output without structure (e.g. "give me the '
  + 'answer and your reasoning" — concatenated? labeled sections? '
  + 'JSON keys? The model picks.)\n'
  + '  - Ordering implied but unspecified (e.g. "list the issues '
  + 'and their fixes" — issue-then-fix interleaved, all issues then '
  + 'all fixes, or a table?)\n'
  + '  - Format inherited from context but never stated (a long '
  + 'analytical prompt that never says whether the response should '
  + 'be markdown, plain prose, a code block, etc.)\n\n'
  + 'Do NOT flag:\n'
  + '  - Missing length caps. If the defect is the response could '
  + 'be 10 words or 10 pages, that is unboundedOutput (different '
  + 'detector). Skip it. Examples of what NOT to flag here: '
  + '"Provide an analysis" with no word count, "Summarize" without '
  + 'a sentence limit, "Explain" with no length bound. Length '
  + 'belongs to a different detector. Flag here only when the '
  + 'STRUCTURE is missing, not the length.\n'
  + '  - Action ambiguity. If the defect is "the instruction has '
  + 'multiple readings of what to do", that is ambiguousInstruction. '
  + 'Skip it. Examples of what NOT to flag here: "summarize it" '
  + 'with unclear referent, "identify the problem" with no '
  + 'quantifier, "translate the technical terms" with unclear '
  + 'scope.\n'
  + '  - Two formats in tension. If the defect is "output as JSON" '
  + 'plus "use markdown headers" stated in the same prompt, that '
  + 'is conflictingInstructions (different detector). Skip it. '
  + 'Flag here only when ONE format is named and its specification '
  + 'is incomplete, not when two formats contradict.\n'
  + '  - Missing rubrics for ratings, scales, or quality bars. '
  + 'Those belong to underspecifiedConstraints. Examples of what '
  + 'NOT to flag here: "Severity: CRITICAL/HIGH/MEDIUM/LOW" without '
  + 'criteria, "Effort: X-Y hours" without estimation basis, '
  + '"comprehensive analysis" without comprehensiveness measure. '
  + 'Those are missing measurement scales, not missing format '
  + 'specs.\n'
  + '  - Prompts where the format is named AND the field or content '
  + 'spec exists elsewhere in the same prompt. Example: a prompt '
  + 'that says "output a markdown table" near the top and lists the '
  + 'column names three paragraphs later is fully specified, even '
  + 'if awkwardly organized. Flag only when the spec is genuinely '
  + 'absent from the entire prompt, not when it is just '
  + 'non-adjacent.\n'
  + '  - Naturally free-form output where a structure spec would be '
  + 'silly (e.g. "write a poem", "respond in your own words", '
  + '"chat with the user"). The defect is missing-of-spec for '
  + 'output that NEEDS a spec, typically because the consumer is '
  + 'doing parsing, downstream processing, comparison across runs, '
  + 'or automated extraction. If the consumer is a human reading '
  + 'prose, the format is implicit and not a defect.\n'
  + '  - Stylistic preferences ("be friendly", "professional tone"). '
  + 'Those are not format specs.\n'
  + '  - Formats whose structural rules are sufficient for the '
  + 'consumer to parse boundaries, even if internal item content is '
  + 'free-form. Example: "output as a numbered list with one item '
  + 'per question" specifies the container (numbered list) and the '
  + 'cardinality rule (one item per question). The internal shape '
  + 'of each list item (full sentences? bullet points within? a '
  + 'restated question?) is left to the model, but that is not a '
  + 'defect — a numbered list is parseable as-is. Flag here only '
  + 'when the missing internal structure would prevent a downstream '
  + 'parser from extracting the right boundaries (e.g. a JSON '
  + 'object with no field names is not parseable into known slots; '
  + 'a numbered list is). If the format gives the consumer enough '
  + 'to find item boundaries, do NOT flag for missing item internals.\n'
  + '  - Prompts that ask for too many distinct tasks at once '
  + '(e.g. "analyze X, then write a marketing email, then generate '
  + 'a unit test"). That is overloadedPrompt (different detector), '
  + 'NOT undefined output format. Each individual deliverable may '
  + 'have a clear (or unclear) format spec; the defect there is '
  + 'task-count sprawl, not missing structure. Skip it.\n'
  + '  - Prompts where the format spec exists but is scattered or '
  + 'placed awkwardly relative to other content. If the schema is '
  + 'present in the prompt at all (even non-adjacent to its '
  + 'directive), that is poorOrganization (different detector), '
  + 'NOT undefined output format. Flag here only when the spec is '
  + 'genuinely ABSENT, not just badly placed.\n'
  + '  - Prompts whose few-shot examples are present but inefficient '
  + '(examples contradict the format spec, contain placeholder '
  + 'content, or fail to demonstrate the schema they should teach). '
  + 'That is inefficientFewShot (different detector), NOT undefined '
  + 'output format. The format spec itself may be present or absent; '
  + 'the defect there is example quality. Skip it.\n'
  + '  - Prompts whose output format is fully defined but contain '
  + 'undocumented non-obvious choices elsewhere (specific thresholds '
  + 'without rationale, internal jargon without glossary). That is '
  + 'poorDocumentation (different detector), NOT undefined output '
  + 'format. Flag here only when the format STRUCTURE is missing, '
  + 'not when the format is defined but other parts of the prompt '
  + 'have undocumented choices.';

const POSITIVE_EXAMPLES =
  '  - "Output your response as a JSON object." '
  + '(Container named, no fields listed. The model invents the schema.)\n'
  + '  - "Provide a report on the codebase." '
  + '(Named structure, no sections specified. Each model picks '
  + 'different headings.)\n'
  + '  - "Return a CSV of the findings." '
  + '(Format named, columns absent. The model picks columns.)\n'
  + '  - "Give me the answer and your reasoning." '
  + '(Composite output, no structure. Concatenated? Labeled? Two '
  + 'fields in JSON?)\n'
  + '  - "List the issues you find and how to fix each one." '
  + '(Ordering and pairing unspecified. Issues-then-fixes? Table? '
  + 'Interleaved?)\n'
  + '  - A 2,000-token analytical prompt asking the model to scan a '
  + 'codebase and produce findings, where the prompt never specifies '
  + 'whether the response should be markdown, plain prose, JSON, or '
  + 'a code block. The downstream is parsing the output but the '
  + 'prompt is silent on shape.';

const NEGATIVE_EXAMPLES =
  '  - "Output a JSON object with the following keys: summary '
  + '(string), issues (array of objects with title and severity), '
  + 'recommendations (array of strings)." '
  + '(Container named, schema specified. Not a flag.)\n'
  + '  - "Provide a report with these sections: Executive Summary, '
  + 'Findings, Recommendations, Appendix." '
  + '(Structure named, sections enumerated. Not a flag.)\n'
  + '  - "Write a poem about resilience." '
  + '(Free-form output, no structure spec needed. The consumer is '
  + 'a human reading prose. Not a flag.)\n'
  + '  - "Summarize the article in 2-3 sentences." '
  + '(Length is bounded; structure is implicit prose. The bound '
  + 'belongs to a different detector if anything, but the prose '
  + 'shape here is not a defect because the consumer is human.)\n'
  + '  - "Output a markdown table sorted by priority." '
  + '(Format named: markdown table. If the column list is defined '
  + 'elsewhere in the same prompt, this is fully specified. Flag '
  + 'only if the column list is genuinely absent from the entire '
  + 'prompt.)\n'
  + '  - "Provide an analysis." '
  + '(Vague, but the issue is missing length and missing structure. '
  + 'The length half belongs to unboundedOutput. Flag here only the '
  + 'structure half if the prompt context implies a structured '
  + 'consumer; if the consumer is a human reading prose, not a '
  + 'flag.)\n'
  + '  - "Output as a numbered list with one item per question." '
  + '(Container named: numbered list. Cardinality rule: one item '
  + 'per question. Internal item shape is left to the model, but '
  + 'list boundaries are clear and parseable. Not a flag.)';

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  // Tier 2 detectors require a target model. The registry's
  // requiresTargetModel: true flag means the mode file shows a skip
  // note when no model is set; we additionally guard here so a
  // detector called directly without a model doesn't error.
  if (!opts.targetModel) return [];

  const result = await auditPromptForDefect({
    detectorName: 'undefinedOutputFormat',
    modelId: opts.targetModel,
    promptText,
    defectName: 'Undefined output format',
    defectDescription: DEFECT_DESCRIPTION,
    positiveExamples: POSITIVE_EXAMPLES,
    negativeExamples: NEGATIVE_EXAMPLES,
  });

  if (!result.ok) {
    // Audit failed (SDK load, parse retry, API error). Fail open with
    // zero findings; the user sees no false positives from a broken
    // call. The mode file already shows a generic skip note for
    // Tier 2 issues.
    return [];
  }

  // Cap findings and append a summary if we exceeded.
  const llmFindings = result.findings;
  const truncated = llmFindings.length > FINDINGS_CAP;
  const visible = truncated ? llmFindings.slice(0, FINDINGS_CAP) : llmFindings;

  const findings = visible.map(f => ({
    detector: 'undefinedOutputFormat',
    severity: capSeverity(f.severity),
    title: f.title,
    file: filePath,
    location: f.location_hint ? { hint: f.location_hint } : null,
    detail: f.detail,
    remediation: f.remediation,
    confidence: 60,
  }));

  if (truncated) {
    const remaining = llmFindings.length - FINDINGS_CAP;
    findings.push({
      detector: 'undefinedOutputFormat',
      severity: 'LOW',
      title: 'Additional undefined output format findings not shown',
      file: filePath,
      location: null,
      detail:
        remaining + ' additional undefined-output-format finding'
        + (remaining === 1 ? '' : 's')
        + ' were detected but not shown. The audit is capped at '
        + FINDINGS_CAP + ' findings per prompt to keep reports '
        + 'readable. Address the visible findings first; re-running '
        + 'the audit after fixes will surface remaining ones.',
      remediation:
        'Address the undefined output format findings shown above '
        + 'first, then re-run Prompt Triage on the updated prompt to '
        + 'surface any remaining issues.',
      confidence: 60,
    });
  }

  return findings;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Validate LLM-returned severity. v5.3 removed the cap-at-MEDIUM
 * limit — with proper severity calibration in the envelope (see
 * llmAuditClient.js), the LLM now correctly reserves HIGH for
 * prompts that are genuinely broken (impossible joint satisfaction,
 * context overflow, injection patterns disabling safety). Suppressing
 * HIGH was hiding load-bearing signal from users.
 */
function capSeverity(s) {
  if (s === 'HIGH' || s === 'MEDIUM' || s === 'LOW') return s;
  // Defensive: client validated this already, but fall back to LOW
  // if something slipped through.
  return 'LOW';
}
