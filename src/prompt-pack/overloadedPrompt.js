/**
 * src/prompt-pack/overloadedPrompt.js
 *
 * Detector #12: Overloaded prompt (Tier 2, LLM-augmented).
 *
 * Maps to Tian et al. (2025) "Overloaded prompt" subtype under
 * Instruction Quality.
 *
 * Defect definition: a prompt asks the model to do too many distinct
 * things in a single call, splitting the model's attention budget
 * across competing task types and reducing quality on each. The
 * defect is about cognitive scope sprawl, not character count or
 * token cost. A long prompt with one focused job is not overloaded;
 * a short prompt asking for analysis + summary + recommendations +
 * tone control + format control all at once is overloaded.
 *
 * Common shapes:
 *
 *   - Distinct task types stacked:
 *     "Analyze X, then write a summary, then format as Y, then set
 *     a casual tone, then end with a call to action." Each item
 *     pulls a different model capability.
 *   - Multiple unrelated outputs:
 *     "Give me a code review, a marketing tagline, and a unit test."
 *     (Three deliverables, three audiences, three task types.)
 *   - Stacked governance layers:
 *     Content rules + style rules + safety rules + format rules +
 *     meta rules all at once. Each layer is fine alone; together
 *     they crowd out the actual task.
 *   - Long unprioritized requirement lists:
 *     15+ "must" requirements with no priority, no critical-vs-nice
 *     separation, no escape valve. The model has to satisfy all of
 *     them and ends up satisfying none well.
 *   - Audience/persona switching:
 *     "Respond as a senior engineer for the dev team, AND as a
 *     friendly explainer for non-technical stakeholders, AND as a
 *     concise summarizer for executives." Three audiences, three
 *     registers, one prompt.
 *
 * What this detector is NOT for:
 *   - Long prompts that focus on one task. Token count is not the
 *     signal. Ghost's POI prompt is 11K characters; it does ONE job
 *     (codebase triage) with many sub-instructions in service of
 *     that one job. Not overloaded. That belongs to length/excessive
 *     (Tier 1) if anything.
 *   - One instruction with multiple readings (ambiguousInstruction).
 *   - Multiple instructions in logical conflict (conflictingInstructions).
 *   - Output length not bounded (unboundedOutput).
 *   - Rating scales without rubrics (underspecifiedConstraints).
 *   - Output containers without schemas (undefinedOutputFormat).
 *   - A workflow with sequential dependent steps. "First do A, then
 *     use A's output to do B, then use B's output to do C" is a
 *     pipeline, not an overload. Each step builds on the previous;
 *     the model isn't splitting attention, it's chaining.
 *   - A prompt with extensive grounding context for one focused task.
 *     Long context + one job = focused, not overloaded.
 *
 * The line: the prompt asks for N independent tasks (each pulling a
 * different model capability or producing a separate deliverable)
 * in one call, AND there is no priority/order/precedence between
 * them. Not "the prompt is long" or "the prompt has many bullet
 * points." Real cognitive sprawl, not perceived complexity.
 *
 * Severity policy:
 *   The LLM returns severity. HIGH, MEDIUM, and LOW all pass through
 *   (v5.3 removed the cap-at-MEDIUM limit — see capSeverity() below).
 *   HIGH is reserved for prompts that are genuinely broken per the
 *   severity framework in llmAuditClient.js.
 *
 * Confidence: 60. Same as the four live Tier 2 siblings.
 *
 * Findings cap: 10 per prompt. Same policy as siblings.
 */

import { auditPromptForDefect } from './llmAuditClient.js';

const FINDINGS_CAP = 10;

const DEFECT_DESCRIPTION =
  'A prompt is overloaded when it asks the model to do too many '
  + 'distinct things in a single call, splitting attention across '
  + 'competing task types and reducing quality on each. The defect '
  + 'is about cognitive scope sprawl: too many independent tasks, '
  + 'too many separate deliverables, too many stacked governance '
  + 'layers, or too many unprioritized requirements competing for '
  + 'the same response.\n\n'
  + 'SCOPE OF THIS DETECTOR (read before flagging):\n'
  + 'This detector covers TASK COUNT and COGNITIVE SCOPE only. It '
  + 'does NOT cover token count or character length (that is '
  + 'length/excessive, a Tier 1 detector). It does NOT cover '
  + 'instructions that are individually ambiguous (that is '
  + 'ambiguousInstruction). It does NOT cover instructions in '
  + 'logical conflict (that is conflictingInstructions). It does '
  + 'NOT cover missing length caps (unboundedOutput), missing '
  + 'rubrics (underspecifiedConstraints), or missing format schemas '
  + '(undefinedOutputFormat). Flag here ONLY when the prompt asks '
  + 'for multiple INDEPENDENT tasks in one call, where each task '
  + 'pulls a different model capability or produces a separate '
  + 'deliverable, and there is no priority, ordering, or precedence '
  + 'rule between them. Trip-wire: if a finding you are about to '
  + 'emit would use the words "ambiguous", "multiple readings", '
  + '"conflicting", "contradictory", "in tension", "mutually '
  + 'exclusive", "cannot both be satisfied", "cannot coexist", '
  + '"no length cap", "no word count", "rubric", "criteria", '
  + '"no schema", "no fields specified", or "no sections specified" '
  + 'in its title or detail, you are in the wrong detector — DROP '
  + 'that finding and continue. Do not emit it.\n\n'
  + 'Common shapes of overloaded prompts:\n'
  + '  - Distinct task types stacked (e.g. "analyze X, then write a '
  + 'summary, then format as Y, then set a casual tone" — each '
  + 'pulls a different model capability)\n'
  + '  - Multiple unrelated outputs (e.g. "give me a code review, a '
  + 'marketing tagline, and a unit test" — three deliverables, '
  + 'three audiences, three task types)\n'
  + '  - Stacked governance layers (content rules + style rules + '
  + 'safety rules + format rules + meta rules, all at once, '
  + 'crowding out the actual task)\n'
  + '  - Long unprioritized requirement lists (15+ "must" requirements '
  + 'with no priority, no critical-vs-nice separation, no escape '
  + 'valve)\n'
  + '  - Audience or persona switching without precedence (e.g. '
  + '"respond as a senior engineer for the dev team AND as a '
  + 'friendly explainer for stakeholders AND as a concise '
  + 'summarizer for executives")\n\n'
  + 'Do NOT flag:\n'
  + '  - Long prompts that focus on ONE task. Token count is not '
  + 'the signal. A 5,000-token prompt that does one job thoroughly '
  + 'is not overloaded; a 200-token prompt that does five different '
  + 'jobs is. Examples of what NOT to flag here: a long codebase-'
  + 'triage prompt with many sub-instructions in service of triage, '
  + 'a long customer-support prompt with extensive grounding for '
  + 'one response, a long analytical prompt with deep context for '
  + 'one analysis. Length without task multiplicity is length/'
  + 'excessive territory (different detector), not overload.\n'
  + '  - Sequential workflows where each step builds on the '
  + 'previous. "First summarize A, then use the summary to draft B, '
  + 'then refine B based on C" is a pipeline, not an overload. The '
  + 'model is chaining, not splitting attention. Flag only when the '
  + 'tasks are INDEPENDENT — each could stand alone in its own '
  + 'prompt without losing meaning.\n'
  + '  - One instruction with multiple readings. That is '
  + 'ambiguousInstruction (different detector). Skip it.\n'
  + '  - Multiple instructions in logical conflict (e.g. "be '
  + 'concise" plus "be exhaustive"). That is conflictingInstructions '
  + '(different detector). Skip it.\n'
  + '  - Missing length cap, missing rubric, or missing format '
  + 'schema. Those are unboundedOutput, underspecifiedConstraints, '
  + 'and undefinedOutputFormat respectively. Skip them.\n'
  + '  - Prompts with extensive grounding context (background docs, '
  + 'examples, reference material) supporting ONE focused task. '
  + 'Grounding is not overload. Flag only when there are multiple '
  + 'INDEPENDENT TASKS, not when there is one task with rich '
  + 'context.\n'
  + '  - Many sub-bullets that all serve one goal. A bullet list '
  + 'enumerating sub-aspects of one analysis (severity, location, '
  + 'remediation, root cause) is not overload — those bullets '
  + 'are facets of one deliverable. Overload is about multiple '
  + 'INDEPENDENT deliverables, not multiple aspects of one.\n'
  + '  - Demanding requirements that are individually achievable '
  + 'and serve one task. "Cite sources, use specific terminology, '
  + 'fit a defined schema, include examples" for one analytical '
  + 'task is demanding but not overloaded. Flag only when the '
  + 'requirements span multiple distinct task types.\n'
  + '  - Prompts whose individual instructions are clear and not '
  + 'too numerous, but whose arrangement creates structural '
  + 'friction (critical context buried late, related rules '
  + 'scattered across sections, inverted dependencies). That is '
  + 'poorOrganization (different detector), NOT overload. Skip it.\n'
  + '  - Prompts whose few-shot examples are present but inefficient '
  + '(examples contradict the instruction, contain placeholder '
  + 'content, lack the structure they should teach, or vary the '
  + 'wrong dimension). That is inefficientFewShot (different '
  + 'detector), NOT overload. The task count itself may be '
  + 'reasonable; the defect is example quality. Skip it.\n'
  + '  - Prompts with a reasonable task count but undocumented '
  + 'non-obvious choices (specific thresholds without rationale, '
  + 'internal jargon without glossary, negative constraints '
  + 'without justification). That is poorDocumentation (different '
  + 'detector), NOT overload. A maintainability defect, not a '
  + 'task-count defect. Skip it.';

const POSITIVE_EXAMPLES =
  '  - "Analyze the user\'s code for security issues. Then write '
  + 'a marketing email about the product. Then generate a unit '
  + 'test for the main function. Format the response as a JSON '
  + 'object." (Three distinct deliverables — security audit, '
  + 'marketing copy, test code — plus a format directive. Each '
  + 'task pulls different capabilities. No precedence given.)\n'
  + '  - "Respond as a senior engineer giving technical advice, '
  + 'AND as a friendly explainer for the non-technical reader, '
  + 'AND as a concise summarizer for the executive audience. '
  + 'Cover all three perspectives in your reply." (Three '
  + 'audiences, three registers, one response. Personas multiply '
  + 'scope.)\n'
  + '  - A prompt with 25 numbered "must" requirements covering '
  + 'tone, format, content, citation, security, brand voice, '
  + 'legal review, accessibility, SEO, and length, with no '
  + 'priority order and no instruction on what to drop if conflicts '
  + 'arise. (Stacked governance layers; the actual task is buried.)\n'
  + '  - "Summarize the article. Translate the summary to French. '
  + 'Generate three social-media variants. Write a blog post about '
  + 'the topic. Identify three follow-up research questions." '
  + '(Five independent deliverables — summary, translation, '
  + 'social copy, blog, research questions — each could stand '
  + 'alone as its own prompt.)';

const NEGATIVE_EXAMPLES =
  '  - "Triage the codebase: identify the top issues, categorize '
  + 'them by type, suggest remediations, and produce a prioritized '
  + 'fix list." (One task: codebase triage. The sub-bullets are '
  + 'facets of one deliverable, not independent tasks.)\n'
  + '  - "Write a 500-word blog post about X. The post should '
  + 'have an introduction, three main sections, and a conclusion. '
  + 'Cite at least two sources. Use a conversational tone. Include '
  + 'one image suggestion." (One deliverable: a blog post. The '
  + 'requirements are facets of that one post.)\n'
  + '  - A 5,000-token prompt providing detailed grounding context '
  + '(reference docs, examples, taxonomies) followed by one '
  + 'focused task: "produce a single triage report on the codebase '
  + 'using this framework." (Long, but one task with rich context. '
  + 'Length without task multiplicity is not overload.)\n'
  + '  - "First summarize the customer message in 2 sentences. '
  + 'Then use that summary to identify the customer\'s top concern. '
  + 'Then draft a response addressing that concern." (Sequential '
  + 'pipeline: each step depends on the previous. Not overload — '
  + 'the model is chaining, not splitting attention.)\n'
  + '  - "For each function in the diff, output: function name, '
  + 'risk level, test coverage need, refactor priority, estimated '
  + 'effort, and one-sentence summary." (Many fields per item, but '
  + 'all are facets of one deliverable: a function-by-function '
  + 'review. Not overload.)';

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  // Tier 2 detectors require a target model. The registry's
  // requiresTargetModel: true flag means the mode file shows a skip
  // note when no model is set; we additionally guard here so a
  // detector called directly without a model doesn't error.
  if (!opts.targetModel) return [];

  const result = await auditPromptForDefect({
    detectorName: 'overloadedPrompt',
    modelId: opts.targetModel,
    promptText,
    defectName: 'Overloaded prompt',
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
    detector: 'overloadedPrompt',
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
      detector: 'overloadedPrompt',
      severity: 'LOW',
      title: 'Additional overloaded-prompt findings not shown',
      file: filePath,
      location: null,
      detail:
        remaining + ' additional overloaded-prompt finding'
        + (remaining === 1 ? '' : 's')
        + ' were detected but not shown. The audit is capped at '
        + FINDINGS_CAP + ' findings per prompt to keep reports '
        + 'readable. Address the visible findings first; re-running '
        + 'the audit after fixes will surface remaining ones.',
      remediation:
        'Address the overloaded-prompt findings shown above first, '
        + 'then re-run Prompt Triage on the updated prompt to '
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
