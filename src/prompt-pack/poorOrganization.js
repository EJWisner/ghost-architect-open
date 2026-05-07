/**
 * src/prompt-pack/poorOrganization.js
 *
 * Detector #13: Poor organization (Tier 2, LLM-augmented).
 *
 * Maps to Tian et al. (2025) "Poor organization" subtype under
 * Instruction Quality.
 *
 * Defect definition: a prompt's individual instructions are
 * individually fine, but the way they are arranged makes the model's
 * job harder than it needs to be. The defect is structural, not
 * content-level. The same instructions reorganized would produce a
 * better result with no semantic change.
 *
 * Common shapes:
 *
 *   - Critical context buried late:
 *     The role/audience/format spec appears at the end of the prompt,
 *     after several paragraphs of detail that depended on knowing it.
 *     The reader has to re-read the early content with new framing.
 *   - Related constraints scattered:
 *     Three different rules about the same dimension (output length,
 *     tone, format) appear in three different sections of the prompt
 *     instead of being grouped. The model has to assemble the
 *     picture from disparate locations.
 *   - Examples before instructions:
 *     Few-shot examples are shown without first stating what they
 *     are examples of. The reader has to infer the pattern before
 *     learning what they are looking at.
 *   - No section structure where there should be:
 *     A long prompt is all one block of prose, with system
 *     instructions, task, constraints, and examples all running
 *     together in a single wall of text.
 *   - Inverted dependency:
 *     Instruction B at line 5 depends on a definition or term
 *     introduced later at line 25. The model encounters B before
 *     it has the context to apply it.
 *   - Multiple competing organization schemes:
 *     The prompt uses headers in some places, numbered lists in
 *     others, prose paragraphs elsewhere, all for instructions of
 *     similar weight. The reader cannot tell what is load-bearing.
 *
 * What this detector is NOT for:
 *   - Stylistic preferences about prompt organization. "I would
 *     have put X before Y" is not a defect; "X depends on Y but
 *     appears 20 lines before Y" is. Flag observable structural
 *     problems, not aesthetic differences.
 *   - Long but well-organized prompts (use length/excessive if
 *     length itself is the concern).
 *   - Content-level defects: ambiguity (ambiguousInstruction),
 *     missing rubrics (underspecifiedConstraints), conflicts
 *     (conflictingInstructions), missing format spec
 *     (undefinedOutputFormat), too many tasks (overloadedPrompt).
 *   - Prompts with a clear header/section structure that puts
 *     information in a sensible order, even if a different
 *     organization would also be sensible.
 *   - Short prompts (under ~5 paragraphs). Organization defects
 *     need enough surface area to manifest. A 3-sentence prompt
 *     cannot be poorly organized in any meaningful sense.
 *
 * The line: the prompt's structural arrangement creates measurable
 * extra work for the reader (reading order doesn't match dependency
 * order, related rules are scattered, critical framing comes too
 * late). Not "the prompt could be tidier" or "headers would help."
 * Real structural friction, not perceived sloppiness.
 *
 * Severity policy:
 *   The LLM returns severity. We trust the call but cap at MEDIUM
 *   (Tier 2 advisory findings should not emit HIGH — those are LLM
 *   judgments, not load-bearing facts). Organization defects skew
 *   LOW more than other Tier 2 defects because they degrade quality
 *   without breaking correctness; that's expected, not a tuning
 *   problem. See F-16 in PROMPT_TRIAGE_FOLLOWUPS.md for revisiting
 *   this cap.
 *
 * Confidence: 60. Same as the five live Tier 2 siblings.
 *
 * Findings cap: 10 per prompt. Same policy as siblings.
 */

import { auditPromptForDefect } from './llmAuditClient.js';

const FINDINGS_CAP = 10;

const DEFECT_DESCRIPTION =
  'A prompt is poorly organized when its individual instructions are '
  + 'individually fine but the way they are arranged makes the model\'s '
  + 'job harder than it needs to be. The defect is structural, not '
  + 'content-level. The same instructions reorganized would produce '
  + 'better results with no semantic change.\n\n'
  + 'SCOPE OF THIS DETECTOR (read before flagging):\n'
  + 'This detector covers STRUCTURAL ARRANGEMENT problems only — the '
  + 'order of content, the grouping of related rules, the placement of '
  + 'critical framing relative to the content it frames. It does NOT '
  + 'cover content-level defects. It does NOT cover ambiguous '
  + 'instructions (that is ambiguousInstruction). It does NOT cover '
  + 'missing rubrics or rating scales (that is underspecifiedConstraints). '
  + 'It does NOT cover instructions in logical conflict (that is '
  + 'conflictingInstructions). It does NOT cover missing output format '
  + 'specs (that is undefinedOutputFormat). It does NOT cover prompts '
  + 'with too many distinct tasks (that is overloadedPrompt). It does '
  + 'NOT cover token count concerns (that is length/excessive, Tier 1). '
  + 'Flag here ONLY when the prompt\'s arrangement creates observable '
  + 'extra work for the reader: reading order does not match dependency '
  + 'order, related rules are scattered across sections, critical '
  + 'framing appears too late to be useful, or the prompt mixes '
  + 'incompatible organization schemes for instructions of similar '
  + 'weight. Trip-wire: if a finding you are about to emit would use '
  + 'the words "ambiguous", "multiple readings", "conflicting", '
  + '"contradictory", "in tension", "mutually exclusive", "cannot '
  + 'both be satisfied", "cannot coexist", "no length cap", "no word '
  + 'count", "rubric", "criteria", "no schema", "no fields specified", '
  + '"no sections specified", "task count", "too many tasks", or '
  + '"multiple deliverables" in its title or detail, you are in the '
  + 'wrong detector — DROP that finding and continue. Do not emit it.\n\n'
  + 'Common shapes of poor organization:\n'
  + '  - Critical context buried late (e.g. role, audience, or output '
  + 'format named only at the end of a long prompt, after the reader '
  + 'has already had to interpret content without that framing)\n'
  + '  - Related constraints scattered (e.g. three rules about output '
  + 'length appearing in three different sections instead of grouped)\n'
  + '  - Examples before instructions (few-shot examples shown without '
  + 'first stating what pattern they demonstrate)\n'
  + '  - No section structure in a long prompt (a wall of prose '
  + 'mixing system instructions, task, constraints, and examples '
  + 'with no headers or clear breaks)\n'
  + '  - Inverted dependency (an instruction that uses a term, role, '
  + 'or rule defined later in the prompt)\n'
  + '  - Mixed organization schemes (headers in some sections, '
  + 'numbered lists in others, prose paragraphs elsewhere, with no '
  + 'clear principle for which form applies to which content)\n\n'
  + 'Do NOT flag:\n'
  + '  - Stylistic preferences. "I would have put the role definition '
  + 'first" is not a defect if the prompt\'s actual organization is '
  + 'workable. Flag only OBSERVABLE structural friction (forward '
  + 'references, scattered related rules, buried critical framing), '
  + 'not aesthetic differences. Examples of what NOT to flag here: '
  + '"the prompt could use clearer headers", "the constraints could '
  + 'be grouped together", "the tone of the prompt is informal" — '
  + 'those are taste, not structure.\n'
  + '  - Short prompts. Organization defects need surface area. A '
  + '3-sentence prompt cannot be poorly organized in any meaningful '
  + 'sense. Skip prompts shorter than roughly 5 paragraphs unless '
  + 'they have a clear inverted-dependency or buried-context defect.\n'
  + '  - Prompts with a sensible section structure even if a '
  + 'different organization would also be sensible. Multiple workable '
  + 'organizations can coexist; "different from how I would do it" '
  + 'is not a defect.\n'
  + '  - Content-level defects. If the underlying instruction is '
  + 'ambiguous, in conflict, missing a rubric, missing a format spec, '
  + 'or asking for too many tasks, that belongs to a sibling detector. '
  + 'Skip those here. Flag here only when the INSTRUCTIONS THEMSELVES '
  + 'ARE FINE but their ARRANGEMENT creates extra work.\n'
  + '  - Token count concerns. Length without structural problems is '
  + 'length/excessive (Tier 1, different detector). A long but '
  + 'well-organized prompt is not poorly organized.\n'
  + '  - Long prompts that focus on ONE task with extensive grounding '
  + 'context. Long context for a single focused task is not poor '
  + 'organization — it is grounded specification. Flag here only '
  + 'when the structural arrangement creates friction, not when the '
  + 'prompt is simply long.\n'
  + '  - Prompts with intentional repetition for emphasis. "Be '
  + 'concise. Once more: be concise." is rhetorically deliberate, '
  + 'not a structural defect, even if it is repetitive.\n'
  + '  - Cosmetic markdown choices. "This prompt uses ## instead of '
  + '###" or "this prompt does not have a table of contents" is not '
  + 'a structural defect.\n'
  + '  - Few-shot example quality problems. If the issue is that the '
  + 'examples themselves are inefficient (contradict the instruction, '
  + 'contain placeholder content, lack the structure they should '
  + 'teach), that is inefficientFewShot (different detector), NOT '
  + 'poor organization. This detector cares about WHERE content sits '
  + 'in the prompt; inefficientFewShot cares whether examples '
  + 'demonstrate what they claim to demonstrate. Examples placed '
  + 'before the instruction they exemplify is a poor-organization '
  + 'defect (placement). Examples that show the wrong format or '
  + 'contain placeholder text is an inefficient-few-shot defect '
  + '(content). Skip the latter here.';

const POSITIVE_EXAMPLES =
  '  - A 2,000-token prompt where lines 1-50 give detailed task '
  + 'instructions and constraints, and line 51 says "You are a '
  + 'pediatric oncology nurse." (Critical role framing buried at '
  + 'the end. The reader had to interpret the entire task without '
  + 'knowing the speaker.)\n'
  + '  - A prompt that says "the response must be under 200 words" '
  + 'in paragraph 2, "remember to keep it brief" in paragraph 5, '
  + 'and "your answer should fit in a single tweet" in paragraph 8. '
  + '(Three rules about length scattered across the prompt instead '
  + 'of grouped. The reader has to assemble the picture from three '
  + 'separate locations.)\n'
  + '  - A prompt that opens with three worked examples of the '
  + 'desired output, then — after the examples — explains what '
  + 'the task is and what the examples demonstrate. (Examples '
  + 'before instructions; the reader sees outputs without knowing '
  + 'what they are examples of.)\n'
  + '  - A long prompt with no headers, no numbered sections, no '
  + 'visual breaks. System instructions, task description, '
  + 'constraints, examples, and output format all run together as '
  + 'one continuous block of prose. (Wall-of-text organization '
  + 'with significant surface area; the reader cannot tell where '
  + 'one section ends and the next begins.)\n'
  + '  - A prompt that says in paragraph 1 "use the schema defined '
  + 'in the appendix" and then defines the schema in paragraph 12. '
  + '(Inverted dependency — the instruction uses a definition that '
  + 'has not been introduced yet.)\n'
  + '  - A prompt mixing markdown headers (## Constraints), '
  + 'numbered lists (1. Format the output...), bold prose '
  + '(**Important**: do not...), and unmarked paragraphs for '
  + 'instructions of similar load-bearing weight, with no clear '
  + 'principle for which form goes with which content type.';

const NEGATIVE_EXAMPLES =
  '  - A long codebase-triage prompt that defines the role and '
  + 'audience first, then the task, then the constraints, then '
  + 'the output format, with clear section headers between each. '
  + '(Sensible structure. Not a flag.)\n'
  + '  - A short prompt of two paragraphs. (Organization defects '
  + 'need surface area; a 2-paragraph prompt cannot meaningfully '
  + 'be poorly organized. Skip.)\n'
  + '  - A long prompt without markdown headers but with clear '
  + 'paragraph breaks and a logical flow (role, then task, then '
  + 'constraints, then examples, in that order). (Sensible '
  + 'organization, just no decorative markdown. Not a flag — '
  + 'organization is about content arrangement, not formatting '
  + 'syntax.)\n'
  + '  - A prompt that opens with one motivating example, then '
  + 'gives the task, then more examples. (Single up-front example '
  + 'as a teaser, followed by full task definition, is a '
  + 'recognized rhetorical pattern; not the same as showing all '
  + 'examples without explanation. Not a flag.)\n'
  + '  - A long prompt with extensive grounding documentation '
  + 'before the task. (Grounding-then-task is a sensible '
  + 'organization for tasks that need rich context. Not a flag.)\n'
  + '  - A prompt that says "be concise" once and means it. (Not '
  + 'scattered, not repeated, not poorly organized.)';

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  // Tier 2 detectors require a target model. The registry's
  // requiresTargetModel: true flag means the mode file shows a skip
  // note when no model is set; we additionally guard here so a
  // detector called directly without a model doesn't error.
  if (!opts.targetModel) return [];

  const result = await auditPromptForDefect({
    detectorName: 'poorOrganization',
    modelId: opts.targetModel,
    promptText,
    defectName: 'Poor organization',
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
    detector: 'poorOrganization',
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
      detector: 'poorOrganization',
      severity: 'LOW',
      title: 'Additional poor-organization findings not shown',
      file: filePath,
      location: null,
      detail:
        remaining + ' additional poor-organization finding'
        + (remaining === 1 ? '' : 's')
        + ' were detected but not shown. The audit is capped at '
        + FINDINGS_CAP + ' findings per prompt to keep reports '
        + 'readable. Address the visible findings first; re-running '
        + 'the audit after fixes will surface remaining ones.',
      remediation:
        'Address the poor-organization findings shown above first, '
        + 'then re-run Prompt Triage on the updated prompt to '
        + 'surface any remaining issues.',
      confidence: 60,
    });
  }

  return findings;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Cap LLM-returned severity at MEDIUM. Tier 2 advisories should not
 * emit HIGH; HIGH is reserved for load-bearing structural problems
 * caught by Tier 1.
 */
function capSeverity(s) {
  if (s === 'HIGH') return 'MEDIUM';
  if (s === 'MEDIUM' || s === 'LOW') return s;
  // Defensive: client validated this already, but fall back to LOW
  // if something slipped through.
  return 'LOW';
}
