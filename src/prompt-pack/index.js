/**
 * src/prompt-pack/index.js
 *
 * Detector registry for Prompt Triage. Each detector exports an async
 * detect(promptText, filePath) function returning an array of findings
 * with the shape:
 *
 *   {
 *     detector: 'category/specific-defect',
 *     severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW',
 *     title: 'Short human label',
 *     file: '/path/to/prompt.md',
 *     location: { line: number, column: number } | null,
 *     detail: '1-3 sentence explanation',
 *     remediation: '1-3 sentence fix',
 *     confidence: 0-100,
 *   }
 *
 * Detectors are loaded by name. The mode file calls runAll() to run every
 * registered detector against every prompt in a folder.
 *
 * v1 ships 15 detectors organized in three tiers:
 *   Tier 1, regex/structural, no LLM call (7 detectors)
 *   Tier 2, LLM-assisted, one Claude call per detector per prompt (7 detectors)
 *   Tier 3, hybrid, regex flags then LLM verification (1 detector)
 *
 * As detectors land, they get registered here. v1 starts with formatting/
 * syntax errors (Tier 1, detector #1).
 */

import * as formatting from './formatting.js';
import * as length from './length.js';
import * as tokenLimitContextOverflow from './tokenLimitContextOverflow.js';
import * as tokenLimitExcessive from './tokenLimitExcessive.js';

/**
 * Registry: detector module + metadata.
 *
 * Order is the order detectors run. Tier 1 first (cheap, regex-only),
 * then Tier 2 (LLM calls, expensive), then Tier 3 (hybrid). Within a
 * tier, order does not matter for correctness, but we keep them in the
 * order chosen for the v1 prompt-pack so output is stable across runs.
 */
const REGISTRY = [
  // Tier 1: regex/structural
  { id: 'formatting',          tier: 1, module: formatting },
  { id: 'length',              tier: 1, module: length },
  // [pending] unboundedOutput, roleSeparation, poorDocumentation,
  // [pending] injectionStaticPattern

  // Tier 2: LLM/API-augmented. requiresTargetModel signals to the mode
  // file that these detectors emit nothing without a target model and
  // a one-line skip note should be shown.
  { id: 'tokenLimitContextOverflow', tier: 2, module: tokenLimitContextOverflow, requiresTargetModel: true },
  { id: 'tokenLimitExcessive',       tier: 2, module: tokenLimitExcessive,       requiresTargetModel: true },
  // [pending] ambiguousInstruction, underspecifiedConstraints, conflictingInstructions,
  // [pending] poorOrganization, undefinedOutputFormat, overloadedPrompt,
  // [pending] inefficientFewShot

  // Tier 3: hybrid
  // [pending] integrationMismatch
];

/**
 * Run every registered detector against a single prompt.
 *
 * Returns a flat array of findings from all detectors. Each detector
 * runs independently; one detector crashing does not block the others.
 * Detector failures are caught and surfaced as a synthetic LOW-severity
 * finding so the mode file can render them in the report instead of
 * silently dropping work.
 *
 * @param {string} promptText  The full text of the prompt to audit.
 * @param {string} filePath    Path to the prompt file (for the file field).
 * @param {object} [opts]      Optional context for detectors. Currently:
 *                              opts.targetModel - model registry ID, used
 *                              by length-aware detectors for accurate
 *                              token counts. Detectors that don't care
 *                              about the target model ignore opts.
 * @returns {Promise<Array>}   Findings from all detectors.
 */
export async function runAll(promptText, filePath, opts = {}) {
  const allFindings = [];

  for (const entry of REGISTRY) {
    try {
      const findings = await entry.module.detect(promptText, filePath, opts);
      if (Array.isArray(findings)) {
        for (const f of findings) allFindings.push(f);
      }
    } catch (err) {
      allFindings.push({
        detector: entry.id + '/internal-error',
        severity: 'LOW',
        title: 'Detector crashed',
        file: filePath,
        location: null,
        detail: 'The ' + entry.id + ' detector threw an error and was skipped: '
          + (err && err.message ? err.message : String(err)),
        remediation: 'Re-run the scan. If the error persists, the detector may have a bug.',
        confidence: 100,
      });
    }
  }

  return allFindings;
}

/**
 * List detector IDs that are currently registered. Used by the mode
 * file to render a "ran N detectors against M prompts" summary line
 * and to detect which registered detectors require a target model.
 *
 * @returns {Array<{id: string, tier: number, requiresTargetModel?: boolean}>}
 */
export function listDetectors() {
  return REGISTRY.map(e => ({
    id: e.id,
    tier: e.tier,
    requiresTargetModel: !!e.requiresTargetModel,
  }));
}
