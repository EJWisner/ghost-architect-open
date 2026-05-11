/**
 * src/prompt-pack/poorDocumentation.js
 *
 * Detector #15: Poor documentation (Tier 2, LLM-augmented).
 *
 * Maps to Tian et al. (2025) "Poor documentation" subtype under
 * Maintainability.
 *
 * Defect definition: a prompt contains non-obvious choices (magic
 * numbers, undocumented business rules, internal jargon, negative
 * constraints, coupled-prompt assumptions) without the rationale or
 * context a future maintainer would need to safely modify it. The
 * prompt becomes a black box: someone editing it cannot tell which
 * choices are load-bearing, which are arbitrary, and which depend on
 * external context that is not stated anywhere in the prompt.
 *
 * IMPORTANT SCOPE: this detector is the most subjective of the
 * Tier 2 detectors. The risk of "I would have documented this
 * differently" false positives is high. The detector fires ONLY on
 * observable problems: a non-obvious choice (specific number, named
 * tier, internal term, negative constraint) that has no rationale
 * stated anywhere in the prompt. It does NOT fire on:
 *   - Short, focused prompts with one clear job and no non-obvious
 *     choices.
 *   - Conventional terminology well-known in the prompt's domain.
 *   - Stylistic preferences about prompt verbosity.
 *   - Prompts where the rationale is obvious from context.
 *
 * Common shapes:
 *
 *   - Magic numbers or strings without rationale:
 *     "Respond in under 200 words", "Limit examples to 3",
 *     "Escalate after 2 round-trips" — specific values with no
 *     explanation of why those values were chosen.
 *   - Business rules encoded without context:
 *     "If the customer is a Tier 3 partner, escalate to L2
 *     support" — what is Tier 3? Why L2 not L1? The encoded rule
 *     is opaque.
 *   - Internal jargon without glossary:
 *     The prompt uses internal terms (named tiers, project
 *     codenames, internal frameworks) without defining them.
 *     Future maintainers and other models cannot interpret.
 *   - Negative constraints without justification:
 *     "Never mention competitor X", "Do not discuss pricing" —
 *     constraints with no rationale (legal? brand? strategy?). A
 *     future maintainer cannot tell whether the constraint can be
 *     safely relaxed.
 *   - Drift indicators:
 *     Comments or framing reference functionality that no longer
 *     exists, or describe behavior in present tense that has been
 *     removed. The documentation contradicts the current prompt.
 *   - Undocumented coupled-prompt assumptions:
 *     "Use the output from the previous step" without explaining
 *     what the previous step is or what shape its output takes.
 *     The prompt is unmaintainable in isolation.
 *
 * What this detector is NOT for:
 *   - Short prompts with one clear job and no non-obvious choices.
 *     "Translate this paragraph to French" does not need a comment
 *     explaining itself. Documentation defects need surface area
 *     for non-obvious choices to exist.
 *   - Self-explanatory phrasings. If the prompt says "respond in
 *     JSON" you do not need a comment saying "// We use JSON
 *     because the consumer parses output as JSON". The format
 *     directive itself is its own rationale.
 *   - Conventional domain terminology. A code-review prompt using
 *     terms like "PR", "diff", "branch" does not need a glossary.
 *     Internal jargon is jargon ONLY when it would not be in a
 *     standard reference for the prompt's domain.
 *   - Stylistic preferences about prompt verbosity. "I would have
 *     documented this differently" is not a defect.
 *   - Prompts that lack comments but whose every choice is
 *     self-evident from the surrounding context. A 100-word
 *     prompt with one task and one constraint is fully documented
 *     by being readable.
 *   - Prompts that are well-known templates (e.g. a standard chain-
 *     of-thought prompt, a standard ReAct prompt, a standard
 *     classification template). Reproducing a known pattern does
 *     not require documentation that the pattern is being used.
 *   - Content-level defects: ambiguity (ambiguousInstruction),
 *     missing rubrics (underspecifiedConstraints), conflicts
 *     (conflictingInstructions), missing format spec
 *     (undefinedOutputFormat), too many tasks (overloadedPrompt),
 *     bad arrangement (poorOrganization), bad examples
 *     (inefficientFewShot). Those are sibling detector territory.
 *
 * The line: a non-obvious choice exists in the prompt AND the
 * choice has no stated rationale anywhere in the prompt AND a
 * future maintainer would need that rationale to safely modify
 * the prompt. Not "the prompt could be more verbose." Real
 * maintainability friction, not perceived sparseness.
 *
 * Severity policy:
 *   The LLM returns severity. We trust the call but cap at MEDIUM
 *   (Tier 2 advisory findings should not emit HIGH — those are LLM
 *   judgments, not load-bearing facts). Documentation defects skew
 *   LOW more than other Tier 2 defects because they degrade
 *   maintainability rather than break correctness; that's expected,
 *   not a tuning problem. See F-16 in PROMPT_TRIAGE_FOLLOWUPS.md
 *   for revisiting this cap.
 *
 * Confidence: 60. Same as the seven live Tier 2 siblings.
 *
 * Findings cap: 10 per prompt. Same policy as siblings.
 */

import { auditPromptForDefect } from './llmAuditClient.js';

const FINDINGS_CAP = 10;

const DEFECT_DESCRIPTION =
  'A prompt has poor documentation when it contains non-obvious '
  + 'choices (magic numbers, undocumented business rules, internal '
  + 'jargon, negative constraints, coupled-prompt assumptions) '
  + 'without the rationale or context a future maintainer would need '
  + 'to safely modify it. The prompt becomes a black box: someone '
  + 'editing it cannot tell which choices are load-bearing, which '
  + 'are arbitrary, and which depend on external context not stated '
  + 'anywhere in the prompt.\n\n'
  + 'CRITICAL SCOPE GATE: this detector ONLY fires when a NON-OBVIOUS '
  + 'CHOICE exists in the prompt and that choice has no stated '
  + 'rationale anywhere in the prompt. A non-obvious choice is a '
  + 'specific number, named tier, internal term, negative constraint, '
  + 'or coupled-prompt assumption that a reader cannot interpret '
  + 'without external context. Self-evident phrasings are NOT '
  + 'non-obvious choices. Conventional domain terminology is NOT '
  + 'non-obvious. The detector does NOT fire on prompts that simply '
  + 'lack comments. It does NOT fire on short prompts with one clear '
  + 'job. It does NOT fire on prompts where every choice is '
  + 'self-evident from context. It does NOT fire on stylistic '
  + 'preferences about verbosity.\n\n'
  + 'SCOPE OF THIS DETECTOR (read before flagging):\n'
  + 'This detector covers MAINTAINABILITY problems caused by '
  + 'undocumented non-obvious choices only. It does NOT cover '
  + 'instructions that are themselves ambiguous (that is '
  + 'ambiguousInstruction). It does NOT cover missing rubrics or '
  + 'rating scales (that is underspecifiedConstraints). It does '
  + 'NOT cover instructions in logical conflict (that is '
  + 'conflictingInstructions). It does NOT cover missing output '
  + 'format specs (that is undefinedOutputFormat). It does NOT '
  + 'cover prompts with too many distinct tasks (that is '
  + 'overloadedPrompt). It does NOT cover structural arrangement '
  + 'defects (that is poorOrganization). It does NOT cover '
  + 'inefficient few-shot examples (that is inefficientFewShot). '
  + 'Flag here ONLY when a NON-OBVIOUS CHOICE in the prompt has no '
  + 'rationale stated anywhere in the prompt, AND a future '
  + 'maintainer would need that rationale to safely modify the '
  + 'choice. Trip-wire: if a finding you are about to emit would '
  + 'use the words "ambiguous", "multiple readings", "conflicting", '
  + '"contradictory", "in tension", "mutually exclusive", "cannot '
  + 'both be satisfied", "cannot coexist", "no length cap", "no '
  + 'word count", "rubric", "criteria", "no schema", "no fields '
  + 'specified", "no sections specified", "task count", "too many '
  + 'tasks", "multiple deliverables", "scattered", "buried", '
  + '"inverted dependency", "examples contradict", "placeholder '
  + 'examples", or "few-shot" in its title or detail, you are in '
  + 'the wrong detector — DROP that finding and continue. Do not '
  + 'emit it.\n\n'
  + 'Common shapes of poor documentation:\n'
  + '  - Magic numbers or strings without rationale (e.g. "respond '
  + 'in under 200 words", "limit examples to 3", "escalate after '
  + '2 round-trips" — specific values with no explanation of why)\n'
  + '  - Business rules encoded without context (e.g. "if the '
  + 'customer is a Tier 3 partner, escalate to L2 support" — what '
  + 'is Tier 3, why L2 not L1?)\n'
  + '  - Internal jargon without glossary (e.g. "Bumblebee tier", '
  + '"Q-cycle review", "Falcon launch" used without definition)\n'
  + '  - Negative constraints without justification (e.g. "never '
  + 'mention competitor X", "do not discuss pricing" — why? legal? '
  + 'brand? strategy? A future maintainer cannot tell whether the '
  + 'constraint can be safely relaxed)\n'
  + '  - Drift indicators (comments or framing referencing '
  + 'functionality that no longer exists, or describing behavior '
  + 'in present tense that has been removed)\n'
  + '  - Undocumented coupled-prompt assumptions (e.g. "use the '
  + 'output from the previous step" without explaining what the '
  + 'previous step is or what shape its output takes)\n\n'
  + 'Do NOT flag:\n'
  + '  - PROMPTS WITHOUT NON-OBVIOUS CHOICES. The most common false '
  + 'positive risk. A short, focused prompt with one clear task and '
  + 'no specific magic numbers, internal jargon, or unjustified '
  + 'negative constraints is fully documented by being readable. '
  + 'Examples of what NOT to flag here: "Translate this paragraph '
  + 'to French", "Summarize this article in three sentences", '
  + '"List the top three risks in this design document". These '
  + 'prompts have no opaque choices and need no comments. Flag '
  + 'only when there ARE non-obvious choices AND those choices '
  + 'lack rationale.\n'
  + '  - SELF-EXPLANATORY PHRASINGS. If a directive carries its '
  + 'own rationale, no comment is needed. "Respond in JSON because '
  + 'the consumer parses JSON" is the same as just "respond in '
  + 'JSON" — the format directive implies the rationale. Do not '
  + 'flag prompts for failing to spell out reasoning that is '
  + 'evident from the choice itself.\n'
  + '  - CONVENTIONAL DOMAIN TERMINOLOGY. Terms that any reasonable '
  + 'reader of the prompt\'s domain would recognize do not require '
  + 'glossary entries. A code-review prompt using "PR", "diff", '
  + '"branch", "merge", "regression" does not need definitions. A '
  + 'medical prompt using "differential diagnosis" does not need '
  + 'a footnote. A legal prompt using "negligence" does not need '
  + 'a definition. Internal jargon is jargon ONLY when it would '
  + 'not appear in a standard reference for the domain.\n'
  + '  - STYLISTIC PREFERENCES about prompt verbosity. "I would '
  + 'have written this with more comments" is taste, not defect. '
  + 'Examples of what NOT to flag here: "the prompt could explain '
  + 'its purpose more clearly", "the rationale could be more '
  + 'detailed", "more context would be helpful". Those are '
  + 'preferences, not maintainability defects. Flag only when '
  + 'a SPECIFIC non-obvious choice would block a future '
  + 'maintainer.\n'
  + '  - WELL-KNOWN TEMPLATES. A standard chain-of-thought prompt, '
  + 'a standard ReAct prompt, a standard classification template, '
  + 'or any pattern documented in the literature does not need '
  + 'in-prompt documentation that the pattern is being used. The '
  + 'pattern is its own documentation if it is recognizable.\n'
  + '  - CONTENT-LEVEL DEFECTS. If the underlying instruction is '
  + 'ambiguous, in conflict, missing a rubric, missing a format '
  + 'spec, asking for too many tasks, poorly organized, or has '
  + 'inefficient examples, those are sibling detector territory. '
  + 'Skip those here. Flag here only when the prompt has '
  + 'non-obvious choices that are missing their RATIONALE, not '
  + 'when the instructions themselves are defective.\n'
  + '  - PROMPTS WHERE THE RATIONALE IS PROVIDED. If the prompt '
  + 'says "respond in under 200 words because users will read this '
  + 'on a mobile device", the magic number has its rationale '
  + 'stated. Do not flag. The detector targets undocumented '
  + 'choices, not all specific choices.\n'
  + '  - PROMPTS WHERE THE RATIONALE IS OBVIOUS FROM CONTEXT. If '
  + 'a customer-support triage prompt says "escalate to L2 if the '
  + 'issue involves data loss" and the prompt earlier establishes '
  + 'L1/L2/L3 as a standard support tier model, the choice is '
  + 'documented by context. Flag only when the maintainer would '
  + 'need EXTERNAL context to interpret the choice.\n'
  + '  - PROMPTS THAT ARE INTENTIONALLY TERSE FOR PRODUCTION USE. '
  + 'A short, focused production prompt that has been tightened '
  + 'for token efficiency is not poorly documented if its choices '
  + 'are self-evident. Documentation should match the maintenance '
  + 'risk; a stable, simple prompt does not need a verbose header.\n\n'
  + 'SEVERITY SKEW FOR THIS DETECTOR:\n'
  + 'Poor-documentation defects almost always score LOW. The whole '
  + 'category is about how a human maintainer reads the prompt, NOT '
  + 'about how the model executes it. An undefined identifier '
  + '("the consultant profile registry," "Tier 3 partner," '
  + '"Bumblebee tier") does not stop the model from producing '
  + 'correct output — the model treats the identifier as data and '
  + 'works with whatever surrounding context it has. The defect is '
  + 'that a future maintainer cannot safely modify the prompt '
  + 'because the rationale for the choice is missing. That is a '
  + 'human-side maintenance burden, not a model-behavior problem. '
  + 'Default every poor-documentation finding to LOW. The ONLY case '
  + 'for MEDIUM here is when the undocumented choice creates an '
  + 'observable model-behavior gap: a magic threshold that the '
  + 'model will apply inconsistently across runs because the prompt '
  + 'gives no decision criteria (in which case the finding is '
  + 'really underspecifiedConstraints, not poorDocumentation — '
  + 'drop it here and let that detector catch it). If you cannot '
  + 'articulate a model-behavior consequence, the finding is LOW. '
  + 'NEVER mark a poor-documentation finding HIGH.';

const POSITIVE_EXAMPLES =
  '  - A customer-support triage prompt with rules like "escalate '
  + 'after 2 round-trips", "use formal tone for Tier 3+ accounts", '
  + 'and "respond within 4 hours" — none of these specific values '
  + '(2 round-trips, Tier 3 threshold, 4 hours) is explained '
  + 'anywhere in the prompt. A future maintainer cannot tell '
  + 'whether to change "2 round-trips" to "3" or what "Tier 3+" '
  + 'means in the company\'s tier system.\n'
  + '  - A marketing content prompt using internal terms like '
  + '"Bumblebee tier customers", "Falcon launch messaging", '
  + 'and "Q-cycle review process" with no glossary or definition '
  + 'of any of these terms. The terms are clearly internal '
  + 'to the company; a maintainer outside the original team has '
  + 'no way to interpret them.\n'
  + '  - A content-moderation prompt with the rule "never mention '
  + 'competitor names: Acme Corp, Globex, Initech" but no '
  + 'explanation of why this constraint exists (legal restriction? '
  + 'brand guideline? past incident?). A future maintainer cannot '
  + 'tell whether the list can be updated, whether the constraint '
  + 'has an expiration, or whether it can be relaxed in certain '
  + 'contexts.\n'
  + '  - A multi-step pipeline prompt that says "use the output '
  + 'from the categorization step" without explaining what the '
  + 'categorization step produces, what its output format is, or '
  + 'where it sits in the pipeline. The prompt is uneditable in '
  + 'isolation because critical context lives elsewhere.\n'
  + '  - A prompt with an inline comment "/* original behavior: '
  + 'returns 5 items, currently returns 10 */" where the comment '
  + 'describes a state that contradicts the current code. The '
  + 'documentation has drifted from the prompt and a maintainer '
  + 'has no way to tell which is correct.';

const NEGATIVE_EXAMPLES =
  '  - "Translate the following passage from English to French. '
  + 'Preserve the original tone." (Short, focused, no non-obvious '
  + 'choices. Fully documented by being readable. Not a flag.)\n'
  + '  - A code-review prompt that uses standard developer '
  + 'terminology — PR, diff, branch, merge conflict, regression — '
  + 'without a glossary. (Conventional domain terminology, no '
  + 'glossary needed. Not a flag.)\n'
  + '  - A standard chain-of-thought prompt: "Solve this problem '
  + 'step by step. First, identify what is being asked. Then, '
  + 'list what you know. Then, work through the solution. Then, '
  + 'state your final answer." (Well-known template; the pattern '
  + 'is its own documentation. Not a flag.)\n'
  + '  - A prompt that says "Respond in under 200 words because '
  + 'users will read this on a mobile device where shorter '
  + 'responses load faster and reduce scrolling." (Magic number '
  + 'present, but rationale is stated. Not a flag.)\n'
  + '  - A prompt with no inline comments but where every choice '
  + 'is self-evident: "You are a code review assistant. For each '
  + 'function in the diff, identify any issues with logic, '
  + 'performance, or security. Output your findings as a JSON '
  + 'array with one object per issue." (No magic numbers, no '
  + 'internal jargon, no unjustified negative constraints. '
  + 'Adequately documented by being clear. Not a flag.)\n'
  + '  - A prompt that defines its own internal terms inline: '
  + '"For each ticket, classify it by urgency. Urgency tiers '
  + 'are: P0 = customer-blocking outage, P1 = significant '
  + 'feature broken, P2 = minor bug, P3 = enhancement request." '
  + '(Internal jargon present, but defined in-prompt. Not a flag.)';

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  // Tier 2 detectors require a target model. The registry's
  // requiresTargetModel: true flag means the mode file shows a skip
  // note when no model is set; we additionally guard here so a
  // detector called directly without a model doesn't error.
  if (!opts.targetModel) return [];

  const result = await auditPromptForDefect({
    detectorName: 'poorDocumentation',
    modelId: opts.targetModel,
    promptText,
    defectName: 'Poor documentation',
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
    detector: 'poorDocumentation',
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
      detector: 'poorDocumentation',
      severity: 'LOW',
      title: 'Additional poor-documentation findings not shown',
      file: filePath,
      location: null,
      detail:
        remaining + ' additional poor-documentation finding'
        + (remaining === 1 ? '' : 's')
        + ' were detected but not shown. The audit is capped at '
        + FINDINGS_CAP + ' findings per prompt to keep reports '
        + 'readable. Address the visible findings first; re-running '
        + 'the audit after fixes will surface remaining ones.',
      remediation:
        'Address the poor-documentation findings shown above first, '
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
