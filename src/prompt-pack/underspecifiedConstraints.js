/**
 * src/prompt-pack/underspecifiedConstraints.js
 *
 * Detector #9: Underspecified constraints (Tier 2, LLM-augmented).
 *
 * Maps to Tian et al. (2025) "Underspecified constraints" subtype
 * under Instruction Quality.
 *
 * Defect definition: a prompt names a measurement, rating dimension,
 * or quality bar but does not define the criteria the model should
 * use to assign values. The model is asked to rate, score, or bucket
 * something with no rubric for what each level means. Two reasonable
 * models given the same input will produce different ratings because
 * the standard is missing, not because they disagree on the input.
 *
 * Common shapes:
 *
 *   - Bucketed rating without bucket criteria:
 *     "Complexity: Low / Medium / High / Requires architect"
 *     (What makes something Low vs Medium? Lines changed? Risk?
 *     Number of files? Each model picks its own basis.)
 *   - Numeric range without basis:
 *     "Estimated effort: X-Y hours"
 *     (Estimate based on what? Code volume? Test surface? Past
 *     similar changes?)
 *   - Categorical assignment without rubric:
 *     "Severity: CRITICAL / HIGH / MEDIUM / LOW"
 *     (When is something CRITICAL vs HIGH? The categories are
 *     listed but the boundaries are not defined.)
 *   - Quality bar without standard:
 *     "Provide a comprehensive analysis"
 *     ("Comprehensive" by what measure? Coverage of every API? Of
 *     every risk? Two models will produce wildly different scopes.)
 *   - Comparison without referent:
 *     "More detailed than the prior section"
 *     (Prior section detail level was unspecified, so "more" has
 *     no anchor.)
 *
 * What this detector is NOT for:
 *   - Pronoun/scope/quantifier ambiguity (use ambiguousInstruction)
 *   - Output bound issues like missing length caps (unboundedOutput)
 *   - Pure stylistic preferences ("be friendly", "professional tone")
 *     — those are vague but not measurement instruments. The model
 *     knows what friendly means. The defect is specific to prompts
 *     asking for a rating/measurement without defining the scale.
 *   - Direct contradictions (use conflictingInstructions)
 *
 * The line: the prompt asks the model to ASSIGN A VALUE on some
 * dimension AND the dimension's scale or criteria is undefined.
 * Not "the prompt is short" or "the language is loose." A specific
 * measurement is requested without a measuring rubric.
 *
 * Severity policy:
 *   The LLM returns severity. We trust the call but cap at MEDIUM
 *   (Tier 2 advisory findings should not emit HIGH — those are LLM
 *   judgments, not load-bearing facts).
 *
 * Confidence: 60. Same as ambiguousInstruction — Tier 2 LLM-judgment
 * uncertainty. Consistent across detectors.
 *
 * Findings cap: 10 per prompt. Same policy as ambiguousInstruction.
 */

import { auditPromptForDefect } from './llmAuditClient.js';

const FINDINGS_CAP = 10;

const DEFECT_DESCRIPTION =
  'A constraint is underspecified when the prompt names a measurement, '
  + 'rating dimension, or quality bar but does not define the criteria '
  + 'the model should use to assign values. The defect is about asking '
  + 'for a measurement without providing a measuring rubric. Two '
  + 'reasonable models given the same input will produce different '
  + 'values because the scale is missing, not because they disagree '
  + 'on the input.\n\n'
  + 'Common shapes of underspecified constraints:\n'
  + '  - Bucketed rating without bucket criteria '
  + '(e.g. "Complexity: Low / Medium / High" with no definition of '
  + 'what makes something Low vs Medium)\n'
  + '  - Numeric range without basis '
  + '(e.g. "Effort: X-Y hours" with no instructions for how to estimate)\n'
  + '  - Categorical assignment without rubric '
  + '(e.g. "Severity: CRITICAL/HIGH/MEDIUM/LOW" listed but the '
  + 'boundaries between categories are not defined)\n'
  + '  - Quality bar without standard '
  + '(e.g. "comprehensive analysis" or "thorough review" — comprehensive '
  + 'by what measure?)\n'
  + '  - Comparison without referent '
  + '(e.g. "more detailed than the prior section" — prior detail level '
  + 'is itself undefined)\n\n'
  + 'Do NOT flag:\n'
  + '  - Pronoun, scope, or quantifier ambiguity. If the defect is '
  + 'about multiple readings of WHAT TO DO (which referent does "it" '
  + 'point to? are we summarizing one issue or all issues? does '
  + '"this code" mean one file or the whole change set?), that is a '
  + 'DIFFERENT defect class (ambiguous instruction), NOT an '
  + 'underspecified constraint. Skip it. '
  + 'Examples of what NOT to flag here: "summarize it" with unclear '
  + 'referent, "identify the problem" with no quantifier (one? all? '
  + 'biggest?), "translate the technical terms" with unclear scope. '
  + 'Those all belong to a different detector. Flag here ONLY when '
  + 'the prompt asks the model to ASSIGN A VALUE on an undefined '
  + 'scale, not when an instruction has multiple readings of its '
  + 'action.\n'
  + '  - Missing length caps on output (different defect class)\n'
  + '  - Stylistic preferences like "be friendly" or "professional tone" '
  + '(these are vague but not measurement instruments — the model knows '
  + 'what friendly means; flag only when the prompt asks the model to '
  + 'ASSIGN A VALUE on an undefined scale)\n'
  + '  - Direct contradictions between two separate instructions. If '
  + 'the defect is two rules in tension (e.g. "be concise" plus '
  + '"provide exhaustive detail", or "output as JSON" plus "use '
  + 'markdown headers"), that is a DIFFERENT defect class (conflicting '
  + 'instructions), NOT an underspecified constraint. Skip it. Flag '
  + 'here only when the prompt asks for a measurement on a dimension '
  + 'whose scale is undefined.\n'
  + '  - Constraints that ARE defined elsewhere in the same prompt '
  + '(if the prompt later defines what each complexity tier means, the '
  + 'constraint is specified)\n'
  + '  - Output STRUCTURE specification gaps (e.g. "output as JSON" '
  + 'without listing fields, "provide a report" without naming '
  + 'sections). Those belong to a different detector (undefined '
  + 'output format), NOT an underspecified constraint. Skip them. '
  + 'Flag here only when the prompt asks for a measurement on a '
  + 'dimension whose scale is undefined, not when an output '
  + 'container lacks an internal schema.\n'
  + '  - Prompts that ask for too many distinct tasks at once '
  + '(e.g. "analyze X, then write a marketing email, then generate '
  + 'a unit test"). That is overloadedPrompt (different detector), '
  + 'NOT an underspecified constraint. Each individual measurement '
  + 'request may have a clear scale; the defect is task-count '
  + 'sprawl. Skip it.';

const POSITIVE_EXAMPLES =
  '  - "Complexity: Low / Medium / High / Requires architect" '
  + '(Buckets named, criteria absent. What makes a change Low vs Medium?)\n'
  + '  - "Estimated effort: X-Y hours" '
  + '(Range requested, no basis given for estimating.)\n'
  + '  - "Severity: CRITICAL / HIGH / MEDIUM / LOW" '
  + '(Categories listed, no rubric for the boundaries.)\n'
  + '  - "Provide a comprehensive analysis of the codebase." '
  + '(Quality bar named, "comprehensive" undefined — every API? '
  + 'every risk? a sample?)\n'
  + '  - "Risk level: LOW / MEDIUM / HIGH / CRITICAL" '
  + '(Same shape as severity — categories without criteria.)\n'
  + '  - "Rate the code quality from 1 to 5." '
  + '(Numeric scale, no rubric for what each value means.)';

const NEGATIVE_EXAMPLES =
  '  - "Estimated effort: X-Y hours, where Low complexity is under 4 '
  + 'hours, Medium is 4-16 hours, High is 16-40 hours, and Requires '
  + 'architect is 40+ hours." '
  + '(Buckets defined; criteria specified. Not underspecified.)\n'
  + '  - "Be friendly in your response." '
  + '(Stylistic preference. Vague but not a measurement instrument. '
  + 'Not a flag.)\n'
  + '  - "Write a 2-3 sentence summary." '
  + '(Bound is defined: 2-3 sentences. Not underspecified.)\n'
  + '  - "Severity is CRITICAL when the issue causes data loss, HIGH '
  + 'when it blocks customer transactions, MEDIUM when it degrades '
  + 'experience, and LOW for cosmetic issues." '
  + '(Categories defined with concrete criteria. Not underspecified.)\n'
  + '  - "List the files affected by this change." '
  + '(No measurement requested. Not a constraint at all.)';

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  // Tier 2 detectors require a target model. The registry's
  // requiresTargetModel: true flag means the mode file shows a skip
  // note when no model is set; we additionally guard here so a
  // detector called directly without a model doesn't error.
  if (!opts.targetModel) return [];

  const result = await auditPromptForDefect({
    detectorName: 'underspecifiedConstraints',
    modelId: opts.targetModel,
    promptText,
    defectName: 'Underspecified constraint',
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
    detector: 'underspecifiedConstraints',
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
      detector: 'underspecifiedConstraints',
      severity: 'LOW',
      title: 'Additional underspecified constraints not shown',
      file: filePath,
      location: null,
      detail:
        remaining + ' additional underspecified-constraint finding'
        + (remaining === 1 ? '' : 's')
        + ' were detected but not shown. The audit is capped at '
        + FINDINGS_CAP + ' findings per prompt to keep reports '
        + 'readable. Address the visible findings first; re-running '
        + 'the audit after fixes will surface remaining ones.',
      remediation:
        'Address the underspecified constraints shown above first, '
        + 'then re-run Prompt Triage on the updated prompt to surface '
        + 'any remaining issues.',
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
