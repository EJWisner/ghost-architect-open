/**
 * src/prompt-pack/ambiguousInstruction.js
 *
 * Detector #8: Ambiguous instruction (Tier 2, LLM-augmented).
 *
 * First Tier 2 detector. Maps to Tian et al. (2025) "Ambiguous
 * instructions" subtype under Instruction Quality.
 *
 * Defect definition: an instruction is ambiguous when a reasonable
 * model could plausibly take two or more different actions in
 * response and the prompt does not disambiguate. Common shapes:
 *
 *   - Pronoun reference unclear: "summarize it" — what does "it"
 *     refer to?
 *   - Scope unclear: "translate the technical terms" — all of them,
 *     or only the ones in this paragraph?
 *   - Quantifier missing: "identify the problem" — one, all, or
 *     the biggest?
 *   - Conflicting reading: "format as a list, then write a paragraph"
 *     — list of paragraphs, list then paragraph, either/or?
 *   - Vague verb without context: "handle edge cases appropriately"
 *     — handle how?
 *
 * What this detector is NOT for:
 *   - Output bound issues (use unboundedOutput)
 *   - Role confusion (use roleSeparation)
 *   - Missing constraints in general (use underspecifiedConstraints)
 *   - Direct contradictions (use conflictingInstructions)
 *
 * The line: two reasonable readings exist AND the prompt does not
 * pick one. Not "the instruction is short" or "informal."
 *
 * Severity policy:
 *   The LLM returns severity. We trust the call but cap at MEDIUM
 *   (Tier 2 advisory findings should not emit HIGH — those are LLM
 *   judgments, not load-bearing facts).
 *
 * Confidence: 60. Lower than Tier 1 (70-95) to reflect LLM-judgment
 * uncertainty.
 *
 * Findings cap: 10 per prompt. Real prompts with more than 10
 * ambiguous instructions exist, but readers glaze over after 5
 * anyway. After 10 we emit a summary "(N more not shown)" finding.
 */

import { auditPromptForDefect } from './llmAuditClient.js';

const FINDINGS_CAP = 10;

const DEFECT_DESCRIPTION =
  'An instruction is ambiguous when a reasonable model could plausibly '
  + 'take two or more different actions in response, and the prompt '
  + 'does not disambiguate which action is intended. The defect is '
  + 'about the existence of multiple reasonable readings, not about '
  + 'whether the instruction is short or informal. A short instruction '
  + 'with one clear reading is fine. A long instruction with two '
  + 'plausible readings is ambiguous.\n\n'
  + 'SCOPE OF THIS DETECTOR (read before flagging):\n'
  + 'This detector covers SINGLE-INSTRUCTION ambiguity only — one '
  + 'sentence, one rule, multiple readings of what action it asks for. '
  + 'It does NOT cover situations where two separate instructions in '
  + 'the same prompt cannot both be satisfied (one says "be concise" '
  + 'and another says "be exhaustive", one says "output JSON" and '
  + 'another says "use markdown layout", one says "cover every edge '
  + 'case" and another says "keep it under 100 words"). Those are '
  + 'two-instruction conflicts and belong to a different detector '
  + '(conflicting instructions). Even if the conflict feels '
  + '"ambiguous" because the model has to pick one, do NOT flag it '
  + 'here. Trip-wire: if a finding you are about to emit would use '
  + 'the words "conflicting", "contradictory", "incompatible", '
  + '"in tension", "mutually exclusive", "cannot both be satisfied", '
  + 'or "cannot coexist" in its title or detail, you are in the '
  + 'wrong detector — DROP that finding and continue. Do not emit it.\n\n'
  + 'Common shapes of ambiguous instructions:\n'
  + '  - Pronoun reference unclear (what does "it" or "they" refer to?)\n'
  + '  - Scope unclear (which subset does this apply to?)\n'
  + '  - Quantifier missing (one? all? the biggest? a sample?)\n'
  + '  - Conflicting reading (does X then Y mean both, or one then the other?)\n'
  + '  - Vague verb without context (handle how? appropriately by what standard?)\n\n'
  + 'Do NOT flag:\n'
  + '  - Output length/format issues (those are a different defect class)\n'
  + '  - Role confusion (different defect class)\n'
  + '  - Direct contradictions between TWO SEPARATE instructions. If '
  + 'the defect is rule A says one thing and rule B says the opposite '
  + '(both stated as binding, no precedence given), that is a '
  + 'DIFFERENT defect class (conflicting instructions), NOT ambiguity. '
  + 'Skip it. Examples of what NOT to flag here: "Be concise" plus '
  + '"Provide exhaustive detail on every point" elsewhere in the same '
  + 'prompt; "Output as JSON" plus "Use markdown headers"; "Use a '
  + 'formal tone" plus "Keep it casual". Those are two rules in '
  + 'tension, not one rule with multiple readings. Flag here only '
  + 'when a SINGLE instruction has multiple plausible readings (e.g. '
  + '"format as a list, then write a paragraph" — list-of-paragraphs '
  + 'or list-then-paragraph?). One sentence, two readings is '
  + 'ambiguity. Two sentences contradicting each other is conflict.\n'
  + '  - Missing rubrics, criteria, or scales for ratings/measurements/'
  + 'quality bars. If the prompt asks the model to ASSIGN A VALUE on '
  + 'a dimension (severity, complexity, risk level, effort hours, '
  + 'priority order, comprehensiveness, thoroughness, etc.) and the '
  + 'criteria for that dimension are missing, that is a DIFFERENT '
  + 'defect class (underspecified constraint), NOT ambiguity. Skip it. '
  + 'Examples of what NOT to flag here: "Severity: CRITICAL/HIGH/'
  + 'MEDIUM/LOW" without rubric, "Complexity: Low/Medium/High" without '
  + 'definitions, "Estimated effort: X-Y hours" without estimation '
  + 'basis, "Provide a comprehensive analysis" without measure of '
  + 'comprehensiveness, "Risk level" without criteria, "fix priority '
  + 'order number" without ranking criteria. Those all belong to a '
  + 'different detector. Flag here ONLY when an instruction has '
  + 'multiple readings of WHAT TO DO (the action), not multiple '
  + 'readings of HOW TO MEASURE OR SCORE.\n'
  + '  - Instructions that are merely short or informal but have one '
  + 'clear reading\n'
  + '  - Stylistic preferences ("be helpful" is vague but not ambiguous '
  + 'in the sense we care about; the model knows what helpful means)\n'
  + '  - Output STRUCTURE specification gaps (e.g. "output as JSON" '
  + 'without listing fields, "provide a report" without naming '
  + 'sections). Those belong to a different detector (undefined '
  + 'output format), NOT ambiguity. Skip them.';

const POSITIVE_EXAMPLES =
  '  - "When the customer mentions an issue, summarize it." '
  + '(Summarize the issue, or summarize the customer message?)\n'
  + '  - "Translate the technical terms." '
  + '(All technical terms in the document, or only the ones in this '
  + 'paragraph?)\n'
  + '  - "Identify the problem." '
  + '(One problem? All problems? The biggest? A sample?)\n'
  + '  - "Format the output as a list, then write a paragraph." '
  + '(List of paragraphs? List followed by separate paragraph? Either/or?)\n'
  + '  - "Handle edge cases appropriately." '
  + '(Handle how? Appropriately by what standard?)';

const NEGATIVE_EXAMPLES =
  '  - "Write a summary of the customer\'s complaint in 2-3 sentences." '
  + '(Clear referent: "customer\'s complaint". Clear bound: 2-3 sentences. '
  + 'Not ambiguous.)\n'
  + '  - "List up to five issues you find, ordered by severity." '
  + '(Clear scope: up to five. Clear ordering: by severity. Not ambiguous.)\n'
  + '  - "Be friendly in your response." '
  + '(Stylistic preference. Vague but not ambiguous in the sense we care '
  + 'about — the model knows what friendly means.)\n'
  + '  - "If you do not know the answer, say so." '
  + '(Clear conditional and clear action. Not ambiguous.)';

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  // Tier 2 detectors require a target model. The registry's
  // requiresTargetModel: true flag means the mode file shows a skip
  // note when no model is set; we additionally guard here so a
  // detector called directly without a model doesn't error.
  if (!opts.targetModel) return [];

  const result = await auditPromptForDefect({
    detectorName: 'ambiguousInstruction',
    modelId: opts.targetModel,
    promptText,
    defectName: 'Ambiguous instruction',
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
    detector: 'ambiguousInstruction',
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
      detector: 'ambiguousInstruction',
      severity: 'LOW',
      title: 'Additional ambiguous instructions not shown',
      file: filePath,
      location: null,
      detail:
        remaining + ' additional ambiguous-instruction finding'
        + (remaining === 1 ? '' : 's')
        + ' were detected but not shown. The audit is capped at '
        + FINDINGS_CAP + ' findings per prompt to keep reports '
        + 'readable. Address the visible findings first; re-running '
        + 'the audit after fixes will surface remaining ones.',
      remediation:
        'Address the ambiguous instructions shown above first, then '
        + 're-run Prompt Triage on the updated prompt to surface any '
        + 'remaining issues.',
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
