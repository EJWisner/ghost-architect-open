/**
 * src/prompt-pack/inefficientFewShot.js
 *
 * Detector #14: Inefficient few-shot examples (Tier 2, LLM-augmented).
 *
 * Maps to Tian et al. (2025) "Inefficient few-shot" subtype under
 * Instruction Quality.
 *
 * Defect definition: a prompt contains few-shot examples (worked
 * examples, sample inputs and outputs, demonstrations) that fail to
 * do their job. The examples are present but they don't teach what
 * the prompt needs them to teach: they contradict the instructions,
 * are too narrow to generalize from, contain placeholder content
 * instead of concrete instances, lack the structure they're
 * supposed to demonstrate, or vary the wrong dimension.
 *
 * IMPORTANT SCOPE GATE: this detector ONLY fires when examples ARE
 * present in the prompt. A prompt with no examples is not by itself
 * a defect. "This prompt would benefit from examples" is not a
 * finding here. The detector identifies examples that are actively
 * making the prompt worse, not the absence of examples that might
 * make it better.
 *
 * Common shapes:
 *
 *   - Examples contradict instructions:
 *     The instruction says "respond in JSON with keys X, Y, Z" but
 *     the worked example shows a prose paragraph. The instruction
 *     says "be concise" but the example is verbose. The reader
 *     cannot tell which to follow.
 *   - Single example presented as a pattern:
 *     One example for a complex task where multiple are needed to
 *     establish what generalizes vs what is specific to that one
 *     case. Especially harmful when the single example is an edge
 *     case the model will treat as the typical case.
 *   - Examples too narrow to generalize:
 *     All examples are the same edge case, all positive sentiment,
 *     all the same length, all the same domain. The demonstrated
 *     pattern appears narrower than the instruction's actual scope.
 *   - Placeholder or meta content:
 *     <example_input>describe the issue here</example_input>,
 *     [INSERT NAME], "Lorem ipsum...", "TODO: add a real example".
 *     The example is a description of an example, not an example
 *     itself. The model has nothing concrete to learn from.
 *   - Examples lack the structure they're supposed to teach:
 *     The instruction is meant to teach the model an output schema,
 *     but the examples don't follow that schema. The instruction is
 *     meant to teach a reasoning style, but the examples just show
 *     outputs without the reasoning steps.
 *   - Counter-examples not marked as counter-examples:
 *     A prompt shows what NOT to do without clearly labeling it
 *     ("Bad example:", "Avoid this:", "Counter-example:"). The
 *     model treats unmarked content as positive examples to imitate.
 *   - Examples vary the wrong dimension:
 *     The instruction wants to teach format, but examples vary
 *     content while keeping format constant — so format becomes
 *     opaque. Or the instruction wants to teach reasoning, but
 *     examples just show input-output pairs without the reasoning
 *     between them.
 *
 * What this detector is NOT for:
 *   - Prompts with NO examples. Absence of examples is not a defect
 *     here. Other detectors may flag the consequences of missing
 *     examples (ambiguousInstruction, underspecifiedConstraints) but
 *     this detector requires examples to be present before firing.
 *   - Examples that are simply different from how the reviewer would
 *     have written them. "I would have used three examples instead
 *     of two" is taste, not defect. Flag only OBSERVABLE problems
 *     with the examples that are present (contradictions with the
 *     instruction text, placeholder content, structural mismatches).
 *   - Instructions that are themselves ambiguous, underspecified,
 *     conflicting, or missing format specs. Those are sibling
 *     detector territory. Flag here only when the EXAMPLES are the
 *     defective element.
 *   - Long prompts with extensive grounding context that includes
 *     reference cases. Reference material is not few-shot — few-shot
 *     means input-output pairs intended to teach a pattern. A
 *     reference case study or background document is grounding,
 *     not a few-shot example.
 *   - Examples used for illustration (one motivating example before
 *     the task) where the prompt does not claim them as a teaching
 *     pattern. Single illustrative examples are a recognized
 *     rhetorical pattern; not the same as one example claiming to
 *     teach a complex task.
 *
 * The line: examples are present, and they fail at the job examples
 * are supposed to do (concretize, demonstrate, disambiguate). Not
 * "the prompt has no examples" or "different examples would also
 * work." Real demonstrative failure, not perceived gaps.
 *
 * Severity policy:
 *   The LLM returns severity. HIGH, MEDIUM, and LOW all pass through
 *   (v5.3 removed the cap-at-MEDIUM limit — see capSeverity() below).
 *   HIGH is reserved for prompts that are genuinely broken per the
 *   severity framework in llmAuditClient.js. Inefficient few-shot
 *   findings skew MEDIUM more than LOW because the defect is
 *   typically structural (contradictions, placeholders) rather than
 *   stylistic.
 *
 * Confidence: 60. Same as the six live Tier 2 siblings.
 *
 * Findings cap: 10 per prompt. Same policy as siblings.
 */

import { auditPromptForDefect } from './llmAuditClient.js';

const FINDINGS_CAP = 10;

const DEFECT_DESCRIPTION =
  'A prompt has inefficient few-shot examples when worked examples '
  + 'or demonstrations are present in the prompt but fail to do '
  + 'their job. The examples may contradict the instructions, be '
  + 'too narrow to generalize from, contain placeholder content '
  + 'instead of concrete instances, lack the structure they are '
  + 'supposed to demonstrate, or vary the wrong dimension. The '
  + 'defect is about the QUALITY of examples that are present, not '
  + 'the absence of examples that might be useful.\n\n'
  + 'CRITICAL SCOPE GATE: this detector ONLY fires when examples '
  + 'ARE present in the prompt. A prompt with no few-shot examples '
  + 'is NOT a defect for this detector. Do not flag "this prompt '
  + 'would benefit from examples" or "no examples are provided" — '
  + 'absence of examples is OUT OF SCOPE here. If the prompt has '
  + 'zero examples, return zero findings from this detector and '
  + 'move on.\n\n'
  + 'SCOPE OF THIS DETECTOR (read before flagging):\n'
  + 'This detector covers FEW-SHOT EXAMPLE QUALITY only — the '
  + 'demonstrative effectiveness of worked examples that the prompt '
  + 'has actually included. It does NOT cover instructions that '
  + 'are themselves ambiguous (that is ambiguousInstruction). It '
  + 'does NOT cover missing rubrics or rating scales (that is '
  + 'underspecifiedConstraints). It does NOT cover instructions in '
  + 'logical conflict (that is conflictingInstructions). It does '
  + 'NOT cover missing output format specs (that is '
  + 'undefinedOutputFormat). It does NOT cover prompts with too '
  + 'many distinct tasks (that is overloadedPrompt). It does NOT '
  + 'cover structural arrangement defects (that is poorOrganization). '
  + 'Flag here ONLY when the prompt contains examples (worked '
  + 'examples, sample input-output pairs, demonstrations) AND those '
  + 'examples have an observable problem: contradicting the '
  + 'instruction text, containing placeholder content, lacking the '
  + 'structure they are meant to demonstrate, being too narrow to '
  + 'generalize from, or varying the wrong dimension. Trip-wire: if '
  + 'a finding you are about to emit would use the words "ambiguous", '
  + '"multiple readings", "conflicting", "contradictory", "in '
  + 'tension", "mutually exclusive", "cannot both be satisfied", '
  + '"cannot coexist", "no length cap", "no word count", "rubric", '
  + '"criteria", "no schema", "no fields specified", "no sections '
  + 'specified", "task count", "too many tasks", "multiple '
  + 'deliverables", "scattered", "buried", "inverted dependency", '
  + 'or "no examples provided" in its title or detail, you are in '
  + 'the wrong detector — DROP that finding and continue. Do not '
  + 'emit it.\n\n'
  + 'Common shapes of inefficient few-shot:\n'
  + '  - Examples contradict the instruction (e.g. instruction says '
  + '"respond in JSON" but the example shows prose; instruction says '
  + '"be concise" but the example is verbose)\n'
  + '  - Placeholder or meta content instead of concrete instances '
  + '(e.g. "<example_input>describe the issue</example_input>", '
  + '"[INSERT NAME HERE]", "Lorem ipsum", "TODO: add example")\n'
  + '  - Examples lack the structure they should teach (instruction '
  + 'specifies an output schema, examples do not follow it; '
  + 'instruction asks for chain-of-thought reasoning, examples '
  + 'show only conclusions)\n'
  + '  - Single example presented as the pattern when multiple are '
  + 'needed to disambiguate (one edge case shown for a task whose '
  + 'general shape needs at least two or three examples to convey)\n'
  + '  - Examples too narrow to generalize (all positive cases, '
  + 'all the same length, all the same domain — the demonstrated '
  + 'pattern looks narrower than the instruction\'s scope)\n'
  + '  - Counter-examples not marked as counter-examples (a "bad" '
  + 'or "what not to do" example presented without a clear label, '
  + 'so the model treats it as a positive example)\n'
  + '  - Examples vary the wrong dimension (instruction is teaching '
  + 'format but examples vary content; instruction is teaching '
  + 'reasoning style but examples show only outputs)\n\n'
  + 'Do NOT flag:\n'
  + '  - PROMPTS WITH NO EXAMPLES. This is the most common false '
  + 'positive risk. Absence of examples is not a defect for this '
  + 'detector. If the prompt contains zero worked examples, sample '
  + 'inputs, or demonstrations, return zero findings. Do not flag '
  + '"this prompt would be clearer with examples" — that is a '
  + 'different kind of defect (ambiguity or underspecification, '
  + 'covered by sibling detectors). Examples must be PRESENT for '
  + 'this detector to apply.\n'
  + '  - Examples that simply differ from how the reviewer would '
  + 'have written them. "I would have used three examples instead '
  + 'of two" is taste. Flag only OBSERVABLE problems: '
  + 'contradictions with the instruction text, placeholder content, '
  + 'structural mismatches with the schema the instruction names. '
  + 'Examples of what NOT to flag here: "the example could be more '
  + 'detailed", "the example uses an unusual domain", "the example '
  + 'tone is different from what I would expect" — those are '
  + 'preferences, not defects.\n'
  + '  - Single illustrative examples that the prompt presents as '
  + 'illustration rather than as a teaching pattern. "Here is one '
  + 'motivating case to set context: [example]. Now your task is..." '
  + 'is a recognized rhetorical pattern. Flag here only when '
  + 'examples are CLAIMING to teach a pattern (multiple examples '
  + 'shown as a set, or one example introduced with framing like '
  + '"follow this format" or "respond like this").\n'
  + '  - Reference cases, background material, or grounding '
  + 'documents that are not framed as few-shot examples. A case '
  + 'study, a background document, or a reference table is '
  + 'grounding context, not a few-shot example. Flag here only '
  + 'when content is presented as input-output pairs intended to '
  + 'teach a pattern.\n'
  + '  - Defects in the INSTRUCTIONS themselves. If the instruction '
  + 'is ambiguous, conflicting, missing a rubric, missing a format '
  + 'spec, asking too many tasks, or poorly organized, those are '
  + 'sibling detector territory. Flag here only when the EXAMPLES '
  + 'are the defective element, not when the examples are fine but '
  + 'the surrounding instructions are the problem.\n'
  + '  - Examples that demonstrate ONE CORRECT pattern with '
  + 'consistent structure, even if the reviewer can imagine '
  + 'additional examples that would teach more. Sufficient is not '
  + 'optimal, and "more examples would help" is not a defect.\n'
  + '  - Examples that match the instructions, follow the requested '
  + 'schema, and use concrete content. These are working examples; '
  + 'do not flag.\n'
  + '  - Prompts whose examples are working but contain undocumented '
  + 'non-obvious choices elsewhere (magic numbers without rationale, '
  + 'internal jargon without glossary, negative constraints without '
  + 'justification). That is poorDocumentation (different detector), '
  + 'NOT inefficient few-shot. The examples themselves may be fine; '
  + 'the defect is undocumented choices in the surrounding prompt. '
  + 'Skip it here.\n\n'
  + 'SEVERITY GUIDANCE FOR THIS DETECTOR:\n'
  + 'Few-shot defects split between LOW and MEDIUM depending on the '
  + 'specific shape. Use these rules:\n'
  + '  MEDIUM — examples that contradict the instruction text (e.g. '
  + 'instruction says JSON, example shows prose), placeholder content '
  + '(e.g. "<example_input>describe issue</example_input>"), or '
  + 'counter-examples not marked as counter-examples (the model will '
  + 'imitate them as positives). These do change model behavior and '
  + 'are correctly MEDIUM.\n'
  + '  LOW — single illustrative example presented as a pattern (the '
  + 'model can usually generalize from one), examples that demonstrate '
  + 'the right pattern but are stylistically narrow (all positive '
  + 'sentiment, all same length), or examples that work but could be '
  + 'more diverse. The model still produces correct output; the issue '
  + 'is example coverage, not example correctness.\n'
  + 'When in doubt between LOW and MEDIUM, ask: "will this cause the '
  + 'model to produce a structurally wrong output (MEDIUM) or just a '
  + 'narrower one (LOW)?" NEVER mark an inefficient-few-shot finding '
  + 'HIGH.';

const POSITIVE_EXAMPLES =
  '  - A prompt that says "Respond in JSON with keys severity, '
  + 'location, and recommendation" and includes a worked example '
  + 'that shows a prose paragraph instead of a JSON object. (The '
  + 'example contradicts the format instruction. The reader cannot '
  + 'tell whether the JSON spec or the example pattern is '
  + 'authoritative.)\n'
  + '  - A prompt with example blocks like '
  + '"<example_input>describe the customer issue</example_input>" '
  + 'and "<example_output>provide a structured summary</example_output>". '
  + '(The example tags contain meta-descriptions of what an example '
  + 'should be, not concrete examples themselves. The model gets '
  + 'no signal about the actual pattern.)\n'
  + '  - A prompt that asks for chain-of-thought reasoning and '
  + 'provides three examples that show only the final conclusion '
  + 'with no intermediate steps. (The examples lack the very '
  + 'structure the instruction is trying to teach. The model is '
  + 'shown outputs without reasoning, then asked to produce '
  + 'reasoning.)\n'
  + '  - A prompt teaching a complex task with one single example. '
  + 'Where the task has multiple legitimate variations (different '
  + 'input shapes, different output strategies), one example is '
  + 'shown and the prompt says "respond like the example above." '
  + '(One data point cannot establish a pattern for a multi-shape '
  + 'task; the model will overfit to the specific example.)\n'
  + '  - A prompt that includes "what NOT to do" cases mixed in '
  + 'with positive examples without any label distinguishing them '
  + '(no "Bad example:", "Avoid this:", or "Counter-example:" '
  + 'header). The model treats all the cases as positive examples '
  + 'to imitate.\n'
  + '  - A prompt asking the model to learn an output FORMAT, with '
  + 'three examples that all use the same content but different '
  + 'formats with no labeling of which format is correct. (The '
  + 'examples vary the wrong dimension; the format pattern is '
  + 'unclear because content is held constant while format varies.)';

const NEGATIVE_EXAMPLES =
  '  - A prompt with no worked examples at all. (Absence of '
  + 'examples is OUT OF SCOPE for this detector. Do not flag.)\n'
  + '  - A prompt with three concrete, structurally consistent '
  + 'examples that match the instruction\'s output format spec, '
  + 'use realistic content from the target domain, and demonstrate '
  + 'the variation the instruction names. (Working examples; not '
  + 'a defect.)\n'
  + '  - A prompt that opens with one motivating illustrative '
  + 'example for context ("To set the stage, here is a typical '
  + 'case the team encounters...") followed by the actual task. '
  + '(Single illustrative example as scene-setting is a rhetorical '
  + 'pattern, not a teaching pattern; not a defect.)\n'
  + '  - A prompt with extensive reference material — a case study, '
  + 'a taxonomy document, a glossary — that is presented as '
  + 'grounding context rather than as a few-shot example set. '
  + '(Reference material is not few-shot; not a defect.)\n'
  + '  - A prompt where the instruction is itself ambiguous or '
  + 'underspecified, but the examples are concrete and consistent '
  + 'with whatever the instruction does say. (The defect is the '
  + 'instruction, not the examples; sibling detector territory; '
  + 'not a defect for this detector.)\n'
  + '  - A prompt with two examples that show variations of the '
  + 'same correct pattern. (Sufficient demonstrative coverage; '
  + '"more examples would help" is a preference, not a defect.)';

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  // Tier 2 detectors require a target model. The registry's
  // requiresTargetModel: true flag means the mode file shows a skip
  // note when no model is set; we additionally guard here so a
  // detector called directly without a model doesn't error.
  if (!opts.targetModel) return [];

  const result = await auditPromptForDefect({
    detectorName: 'inefficientFewShot',
    modelId: opts.targetModel,
    promptText,
    defectName: 'Inefficient few-shot examples',
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
    detector: 'inefficientFewShot',
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
      detector: 'inefficientFewShot',
      severity: 'LOW',
      title: 'Additional inefficient-few-shot findings not shown',
      file: filePath,
      location: null,
      detail:
        remaining + ' additional inefficient-few-shot finding'
        + (remaining === 1 ? '' : 's')
        + ' were detected but not shown. The audit is capped at '
        + FINDINGS_CAP + ' findings per prompt to keep reports '
        + 'readable. Address the visible findings first; re-running '
        + 'the audit after fixes will surface remaining ones.',
      remediation:
        'Address the inefficient-few-shot findings shown above '
        + 'first, then re-run Prompt Triage on the updated prompt '
        + 'to surface any remaining issues.',
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
