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
 *   Tier 1, no LLM judgment, may use offline tokenizers or free counting
 *     APIs (8 detectors)
 *   Tier 2, LLM judgment required, one Claude call per detector per
 *     prompt (6 detectors)
 *   Tier 3, hybrid, regex flags then LLM verification (1 detector)
 *
 * Tier definition note: "Tier 1" means "no LLM judgment about prompt
 * content," not "no API call." The tokenLimit detectors are Tier 1
 * because they only count tokens (free Anthropic countTokens endpoint
 * for Claude, offline tiktoken for OpenAI). They never ask the LLM to
 * evaluate prompt quality. Tier 2 is for detectors that send the prompt
 * to a model and use the model's judgment as the answer.
 *
 * Note on Tier 1 vs Tier 2 split: poorDocumentation moved from Tier 1 to
 * Tier 2 because the question "is this prompt documented enough?" is
 * inherently a judgment call that needs LLM context to answer well. A
 * regex check would either fire on every prompt without comments
 * (most of them) or never fire (if we only flag obvious omissions).
 *
 * As detectors land, they get registered here. v1 starts with formatting/
 * syntax errors (Tier 1, detector #1).
 */

import * as formatting from './formatting.js';
import * as length from './length.js';
import * as unboundedOutput from './unboundedOutput.js';
import * as injectionStaticPattern from './injectionStaticPattern.js';
import * as roleSeparation from './roleSeparation.js';
import * as ambiguousInstruction from './ambiguousInstruction.js';
import * as underspecifiedConstraints from './underspecifiedConstraints.js';
import * as conflictingInstructions from './conflictingInstructions.js';
import * as undefinedOutputFormat from './undefinedOutputFormat.js';
import * as overloadedPrompt from './overloadedPrompt.js';
import * as poorOrganization from './poorOrganization.js';
import * as inefficientFewShot from './inefficientFewShot.js';
import * as poorDocumentation from './poorDocumentation.js';
import * as tokenLimitContextOverflow from './tokenLimitContextOverflow.js';
import * as tokenLimitExcessive from './tokenLimitExcessive.js';
import * as integrationMismatch from './integrationMismatch.js';
import { dedupFindings } from './dedup.js';

/**
 * Registry: detector module + metadata.
 *
 * Order is the order detectors run. Tier 1 first (cheap, regex-only),
 * then Tier 2 (LLM calls, expensive), then Tier 3 (hybrid). Within a
 * tier, order does not matter for correctness, but we keep them in the
 * order chosen for the v1 prompt-pack so output is stable across runs.
 */
// F-09: optional progress logging for long Tier 2/3 audit batches.
// Production behavior unchanged — stays silent unless GHOST_PROGRESS=1
// is set in the environment. Helps users running large scans see that
// progress is being made rather than wondering if Ghost has hung.
function maybeLogProgress(message) {
  if (process.env.GHOST_PROGRESS === '1') {
    process.stderr.write(message + '\n');
  }
}

// Sanitize a detector's crash message before it lands in a finding's
// detail field. Findings flow into web portals and issue-tracker
// exports (Jira), where a raw err.message could carry HTML or markup
// that renders as live markup or injects content. We strip tags, escape
// the HTML-significant characters, collapse whitespace, and truncate to
// a fixed budget. The full unsanitized error is logged to stderr by the
// caller for debugging; it never reaches the report.
const ERROR_MESSAGE_MAX = 200;
export function sanitizeErrorMessage(raw) {
  let text = String(raw == null ? '' : raw);
  // Drop anything that looks like an HTML/XML tag outright.
  text = text.replace(/<[^>]*>/g, '');
  // Collapse all whitespace (including newlines) to single spaces so a
  // multi-line stack-ish message can't break report formatting.
  text = text.replace(/\s+/g, ' ').trim();
  // Truncate the plain text first, so the 200-char budget counts visible
  // characters and escaping below can't split an entity (e.g. "&amp;").
  if (text.length > ERROR_MESSAGE_MAX) {
    text = text.slice(0, ERROR_MESSAGE_MAX) + '…';
  }
  // Escape the characters that are dangerous in HTML/attribute contexts.
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return text;
}

const REGISTRY = [
  // Tier 1: no LLM judgment about prompt content. Includes pure-regex
  // detectors and token-counting detectors. May still require a target
  // model when the count needs to be tier-specific (tokenLimit/*).
  { id: 'formatting',          tier: 1, module: formatting },
  { id: 'length',              tier: 1, module: length },
  { id: 'unboundedOutput',     tier: 1, module: unboundedOutput },
  { id: 'injectionStaticPattern', tier: 1, module: injectionStaticPattern },
  { id: 'roleSeparation',      tier: 1, module: roleSeparation },
  { id: 'tokenLimitContextOverflow', tier: 1, module: tokenLimitContextOverflow, requiresTargetModel: true },
  { id: 'tokenLimitExcessive',       tier: 1, module: tokenLimitExcessive,       requiresTargetModel: true },

  // Tier 2: LLM judgment required. Each detector sends the prompt to
  // a model and uses the model's judgment as the answer. Costs money.
  // requiresTargetModel: true signals to the mode file that these
  // detectors emit nothing without a target model and a one-line skip
  // note should be shown.
  { id: 'ambiguousInstruction',       tier: 2, module: ambiguousInstruction,       requiresTargetModel: true },
  { id: 'underspecifiedConstraints',  tier: 2, module: underspecifiedConstraints,  requiresTargetModel: true },
  { id: 'conflictingInstructions',    tier: 2, module: conflictingInstructions,    requiresTargetModel: true },
  { id: 'undefinedOutputFormat',      tier: 2, module: undefinedOutputFormat,      requiresTargetModel: true },
  { id: 'overloadedPrompt',           tier: 2, module: overloadedPrompt,           requiresTargetModel: true },
  { id: 'poorOrganization',           tier: 2, module: poorOrganization,           requiresTargetModel: true },
  { id: 'inefficientFewShot',         tier: 2, module: inefficientFewShot,         requiresTargetModel: true },
  { id: 'poorDocumentation',          tier: 2, module: poorDocumentation,          requiresTargetModel: true },

  // Tier 3: hybrid (regex flag + LLM verification). Same
  // requiresTargetModel semantics as Tier 2 — the LLM-verify phase needs
  // a target model, and the detector emits zero findings without one.
  { id: 'integrationMismatch', tier: 3, module: integrationMismatch, requiresTargetModel: true },
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
 *                              opts.skipTiers - array of tier numbers to
 *                              skip entirely (e.g. [2] to run only Tier 1
 *                              and Tier 3). Used by the smoke harness to
 *                              avoid live API calls during routine
 *                              detector verification. Default: [].
 *                              Note: tokenLimitContextOverflow and
 *                              tokenLimitExcessive are Tier 1 but may make
 *                              Anthropic API calls for Claude target models
 *                              (countTokens endpoint). Pass skipTiers: [1, 2]
 *                              to avoid all API calls.
 *                              opts.verbose - if true, skip the dedup pass
 *                              and return ALL detector findings including
 *                              overlapping duplicates. Default: false.
 *                              See src/prompt-pack/dedup.js for the full
 *                              dedup taxonomy and rationale.
 * @returns {Promise<Array>}   Deduped findings from all detectors. Each
 *                              finding may include an `alsoFlaggedBy`
 *                              array listing other detectors that fired
 *                              on the same range but were suppressed.
 */
export async function runAll(promptText, filePath, opts = {}) {
  const allFindings = [];
  const skipTiers = Array.isArray(opts.skipTiers) ? opts.skipTiers : [];

  // F-09: count active Tier 2/3 detectors for progress reporting.
  // Tier 1 stays silent because it's fast enough that progress noise
  // would clutter the output. The user wants to know "is the slow
  // part progressing", which is Tier 2/3.
  const slowDetectors = REGISTRY.filter(
    e => (e.tier === 2 || e.tier === 3) && !skipTiers.includes(e.tier)
  );
  const totalSlow = slowDetectors.length;
  let slowIndex = 0;
  const auditStartMs = Date.now();
  if (totalSlow > 0) {
    maybeLogProgress('[Tier 2/3 audit] starting ' + totalSlow + ' detectors on ' + filePath);
  }

  for (const entry of REGISTRY) {
    if (skipTiers.includes(entry.tier)) continue;
    const isSlow = (entry.tier === 2 || entry.tier === 3);
    if (isSlow) {
      slowIndex++;
      maybeLogProgress('[Tier 2/3 audit] ' + slowIndex + '/' + totalSlow + ' ' + entry.id + '...');
    }
    const callStartMs = Date.now();
    try {
      const findings = await entry.module.detect(promptText, filePath, opts);
      if (Array.isArray(findings)) {
        for (const f of findings) allFindings.push(f);
      }
      if (isSlow) {
        const callMs = Date.now() - callStartMs;
        const findCount = Array.isArray(findings) ? findings.length : 0;
        maybeLogProgress('[Tier 2/3 audit] ' + slowIndex + '/' + totalSlow + ' ' + entry.id
          + ' done (' + callMs + 'ms, ' + findCount + ' findings)');
      }
    } catch (err) {
      // Log the FULL unsanitized error to stderr for debugging. This is
      // the only place the raw message is allowed to surface. It must
      // never be embedded in a finding, which can render in web portals
      // or export to issue trackers (XSS / injection risk).
      const rawMessage = err && err.message ? err.message : String(err);
      process.stderr.write('[prompt-pack] detector "' + entry.id
        + '" crashed: ' + rawMessage + '\n');
      // Sanitized copy for the report: tags stripped, HTML-escaped,
      // whitespace-collapsed, and truncated to a fixed character budget.
      const safeMessage = sanitizeErrorMessage(rawMessage);
      allFindings.push({
        detector: entry.id + '/internal-error',
        severity: 'LOW',
        title: 'Detector crashed',
        file: filePath,
        location: null,
        detail: 'The ' + entry.id + ' detector threw an error and was skipped: '
          + safeMessage
          + ' (error message sanitized; see stderr for the full unsanitized error).',
        remediation: 'Re-run the scan. If the error persists, the detector may have a bug.',
        confidence: 100,
      });
    }
  }

  // F-09: emit completion summary if we logged any progress.
  if (totalSlow > 0) {
    const totalMs = Date.now() - auditStartMs;
    const totalSec = (totalMs / 1000).toFixed(1);
    maybeLogProgress('[Tier 2/3 audit] complete: ' + totalSlow + ' detectors, ' + totalSec + 's total');
  }

  // Dedup pass: enforce the documented detector taxonomy. When two
  // detectors fire on the same range, keep the more-specific one and
  // suppress the more-general one (annotated as `alsoFlaggedBy` on the
  // keeper so cross-detector signal isn't lost). See dedup.js for the
  // full taxonomy and rationale. Skip when verbose=true is requested.
  if (opts.verbose) {
    return allFindings;
  }
  const { findings: deduped } = dedupFindings(allFindings);
  return deduped;
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
