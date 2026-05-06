/**
 * src/prompt-pack/conflictingInstructions.js
 *
 * Detector #10: Conflicting instructions (Tier 2, LLM-augmented).
 *
 * Maps to Tian et al. (2025) "Conflicting instructions" subtype under
 * Instruction Quality.
 *
 * Defect definition: a prompt contains two or more directives that
 * cannot both be satisfied by any single output. The model is forced
 * to pick one, drop the other, or compromise both. The defect lies in
 * stating both rules without a precedence order or a way to reconcile
 * them.
 *
 * Common shapes:
 *
 *   - Direct contradiction:
 *     "Be concise."
 *     "Provide thorough, exhaustive detail on every point."
 *   - Format vs content conflict:
 *     "Output as a single JSON object."
 *     "Use markdown headers, bullet points, and bold text for readability."
 *   - Tone conflict:
 *     "Use a formal, professional voice throughout."
 *     "Keep it casual and conversational so the reader feels at ease."
 *   - Scope vs length conflict:
 *     "Cover every possible edge case the user might encounter."
 *     "Keep your response under 100 words."
 *   - Sequence conflict:
 *     "First, summarize the article."
 *     "Use the summary as the article's introduction."
 *     (The summary is supposed to come from the article, but is also
 *     supposed to be the article's first section — circular.)
 *   - Constraint vs example conflict:
 *     Instruction says "always respond in English."
 *     Few-shot example responds in Spanish.
 *
 * What this detector is NOT for:
 *   - Pronoun, scope, or quantifier ambiguity in a single instruction
 *     (use ambiguousInstruction). Ambiguity is multiple readings of
 *     ONE instruction. Conflict is TWO instructions where satisfying
 *     one prevents satisfying the other.
 *   - Single instructions with two plausible readings (also
 *     ambiguousInstruction — "conflicting reading" of one sentence,
 *     not conflict between two sentences).
 *   - Missing rubrics or scales (use underspecifiedConstraints).
 *   - Output bound issues (use unboundedOutput).
 *   - Apparent tensions resolved by explicit precedence: "Be helpful,
 *     but if a request is unsafe, refuse." The prompt resolves the
 *     tension by stating the priority order; that is good prompt
 *     engineering, not a defect.
 *   - Soft tensions that are clearly the author's deliberate framing:
 *     "Be concise but thorough where it matters." This invites the
 *     model to use judgment, not to satisfy contradictory absolutes.
 *
 * The line: two stated rules, neither yields, no precedence given,
 * and the rules cannot be jointly satisfied. Not "the prompt has
 * many requirements" or "the requirements are demanding." Real
 * conflict, not perceived tension.
 *
 * Severity policy:
 *   The LLM returns severity. We trust the call but cap at MEDIUM
 *   (Tier 2 advisory findings should not emit HIGH — those are LLM
 *   judgments, not load-bearing facts). See F-16 in
 *   PROMPT_TRIAGE_FOLLOWUPS.md for revisiting this cap.
 *
 * Confidence: 60. Same as ambiguousInstruction and
 * underspecifiedConstraints. Tier 2 LLM-judgment uncertainty,
 * consistent across detectors.
 *
 * Findings cap: 10 per prompt. Same policy as siblings.
 */

import { auditPromptForDefect } from './llmAuditClient.js';

const FINDINGS_CAP = 10;

const DEFECT_DESCRIPTION =
  'A prompt contains conflicting instructions when it states two or '
  + 'more directives that cannot both be satisfied by any single '
  + 'output. The model must pick one, drop the other, or compromise '
  + 'both. The defect lies in stating both rules without a precedence '
  + 'order, a reconciliation rule, or any indication of which rule '
  + 'wins.\n\n'
  + 'Common shapes of conflicting instructions:\n'
  + '  - Direct contradiction (one rule asks for X, another asks for '
  + 'not-X)\n'
  + '  - Format vs content conflict (rules about structure that '
  + 'cannot coexist, e.g. JSON object vs markdown layout)\n'
  + '  - Tone conflict (formal vs casual, terse vs warm, expert vs '
  + 'beginner-friendly with no audience priority given)\n'
  + '  - Scope vs length conflict (cover everything vs stay under N '
  + 'words, with no guidance on what to cut)\n'
  + '  - Sequence or circular conflict (rule A depends on rule B, rule '
  + 'B depends on rule A)\n'
  + '  - Constraint vs example conflict (the instruction says one '
  + 'thing, the worked example or few-shot demonstrates the opposite)\n\n'
  + 'Do NOT flag:\n'
  + '  - Pronoun, scope, or quantifier ambiguity in a SINGLE '
  + 'instruction. Those are multiple readings of one rule, not two '
  + 'rules in tension. They belong to a different detector (ambiguous '
  + 'instruction). Examples of what NOT to flag here: "summarize it" '
  + 'with unclear referent, "identify the problem" with no quantifier, '
  + '"translate the technical terms" with unclear scope. Those are '
  + 'one rule that can be read multiple ways, not two rules in '
  + 'conflict.\n'
  + '  - Single instructions whose internal phrasing has two '
  + 'plausible meanings (e.g. "format as a list, then write a '
  + 'paragraph" can be read as list-of-paragraphs or list-then-'
  + 'paragraph). That is also ambiguous instruction, not conflict, '
  + 'because the defect is reading one sentence two ways, not two '
  + 'sentences contradicting each other.\n'
  + '  - Missing rubrics, criteria, or scales for ratings or quality '
  + 'bars. Those belong to underspecified constraint, not conflict.\n'
  + '  - Apparent tensions that the prompt itself resolves with '
  + 'explicit precedence. Examples of what NOT to flag here: "Be '
  + 'helpful, but if a request is unsafe, refuse" (precedence given: '
  + 'safety wins). "Aim for brevity, but include error-handling '
  + 'details when the user is debugging" (precedence given: '
  + 'debugging context overrides brevity). "Default to formal, '
  + 'switch to casual if the user does first" (precedence given: '
  + 'mirror the user). These are well-engineered prompts, not '
  + 'defects.\n'
  + '  - Soft tensions framed as deliberate author discretion '
  + '(e.g. "Be concise but thorough where it matters", "Use plain '
  + 'language unless precision is required"). The author is inviting '
  + 'the model to use judgment, not stating two absolutes. A genuine '
  + 'conflict requires two rules that each present themselves as '
  + 'binding without yielding to the other.\n'
  + '  - A long list of demanding requirements that are individually '
  + 'achievable. "Demanding" is not the same as "conflicting." Flag '
  + 'only when satisfying one rule actively prevents satisfying '
  + 'another.\n'
  + '  - Restating the same rule in different words (e.g. "Be brief. '
  + 'Keep it short. Do not ramble."). Redundant but not conflicting.\n'
  + '  - A single output format with missing internal specification '
  + '(e.g. "output as JSON" with no field list, "provide a report" '
  + 'with no section list). One stated format with an incomplete spec '
  + 'is undefined output format (different detector), NOT a conflict. '
  + 'Flag here only when TWO formats are stated and they cannot '
  + 'coexist in one output (e.g. "output as JSON" plus "use markdown '
  + 'headers"); not when one format is named without a complete spec.\n'
  + '  - Prompts that ask for too many distinct tasks at once where '
  + 'each individual task is clear and the tasks do not contradict '
  + 'each other. "Analyze X, then write a marketing email, then '
  + 'generate a unit test" is too much for one call but the rules '
  + 'do not conflict — they multiply. That is overloadedPrompt '
  + '(different detector), NOT conflict. Flag here only when satisfying '
  + 'one rule actively prevents satisfying another, not when the '
  + 'rules merely accumulate.';

const POSITIVE_EXAMPLES =
  '  - Prompt says: "Be concise. Keep your response brief." '
  + 'Same prompt also says: "Provide an exhaustive analysis covering '
  + 'every edge case, with worked examples for each." '
  + '(Cannot satisfy both. No precedence given.)\n'
  + '  - Prompt says: "Output your response as a single JSON object '
  + 'with no surrounding text." '
  + 'Same prompt also says: "Use markdown headers and bullet points '
  + 'to organize the response for readability." '
  + '(JSON object and markdown layout cannot coexist in one output.)\n'
  + '  - Prompt says: "Use a formal, professional tone." '
  + 'Same prompt also says: "Keep the language casual and friendly, '
  + 'as if chatting with a colleague." '
  + '(Two tone rules, neither yields, no audience priority given.)\n'
  + '  - Prompt says: "Cover every possible failure mode the user '
  + 'might hit." '
  + 'Same prompt also says: "Keep your response under 100 words." '
  + '(Scope and length cannot both be honored. No guidance on what '
  + 'to cut.)\n'
  + '  - Prompt says: "First, summarize the article in two sentences." '
  + 'Same prompt also says: "Use that summary as the article\'s '
  + 'opening paragraph." '
  + '(Circular: the summary is derived from the article, but is also '
  + 'supposed to be the article\'s first section.)\n'
  + '  - Prompt instructs: "Always respond in English." '
  + 'Few-shot example in the same prompt shows the assistant '
  + 'responding in Spanish. '
  + '(Constraint and example contradict each other; the model has '
  + 'to guess which signal is binding.)';

const NEGATIVE_EXAMPLES =
  '  - "Be helpful, but if the request is unsafe, refuse." '
  + '(Apparent tension between helpfulness and refusal, but precedence '
  + 'is explicit: safety wins. Not a conflict.)\n'
  + '  - "Default to a formal tone; if the user writes casually, '
  + 'mirror their style." '
  + '(Two tone modes, but the trigger is explicit. The model knows '
  + 'when to switch. Not a conflict.)\n'
  + '  - "Aim for brevity, but include full error-handling details '
  + 'when debugging." '
  + '(Soft tension resolved by context. Author intent is clear. Not a '
  + 'conflict.)\n'
  + '  - "Use plain language unless technical precision is required." '
  + '(Deliberate author discretion. Model invited to use judgment. '
  + 'Not a conflict.)\n'
  + '  - "Be concise. Keep your response brief. Avoid filler." '
  + '(Three rules, all in agreement. Redundant but not conflicting.)\n'
  + '  - A prompt with eight strict requirements (must include '
  + 'examples, must cite sources, must use specific terminology, must '
  + 'fit a defined schema, etc.) where every requirement is '
  + 'individually achievable in the same output. (Demanding, not '
  + 'conflicting.)\n'
  + '  - "summarize it" with unclear referent. (That is ambiguous '
  + 'instruction, not conflict — one rule with two readings, not two '
  + 'rules in tension.)';

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  // Tier 2 detectors require a target model. The registry's
  // requiresTargetModel: true flag means the mode file shows a skip
  // note when no model is set; we additionally guard here so a
  // detector called directly without a model doesn't error.
  if (!opts.targetModel) return [];

  const result = await auditPromptForDefect({
    detectorName: 'conflictingInstructions',
    modelId: opts.targetModel,
    promptText,
    defectName: 'Conflicting instructions',
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
    detector: 'conflictingInstructions',
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
      detector: 'conflictingInstructions',
      severity: 'LOW',
      title: 'Additional conflicting instructions not shown',
      file: filePath,
      location: null,
      detail:
        remaining + ' additional conflicting-instruction finding'
        + (remaining === 1 ? '' : 's')
        + ' were detected but not shown. The audit is capped at '
        + FINDINGS_CAP + ' findings per prompt to keep reports '
        + 'readable. Address the visible findings first; re-running '
        + 'the audit after fixes will surface remaining ones.',
      remediation:
        'Address the conflicting instructions shown above first, then '
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
