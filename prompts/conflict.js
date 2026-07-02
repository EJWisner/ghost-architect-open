/**
 * Ghost Architect — Conflict Detection Prompts
 * Separate file to keep prompts/index.js clean.
 */

import { buildConsultantContextBlock, buildConsultantChecks } from './index.js';

/**
 * buildSystemConflict(profile) — Conflict Detection system prompt with
 * optional consultant lens. When profile is null, behavior is
 * derived from the base prompt; output evolves with the version (see the v0.4
 * note below). Callers that import it without arguments get the base prompt.
 *
 * Mirrors the buildSystemPOI / buildSystemBlast pattern from prompts/index.js:
 *   - consultantBlock injected near the top so the model knows who the
 *     report is being prepared for and what their methodology is
 *   - consultantChecks injected after the conflict-finding instructions so
 *     the consultant's priorities/anti-patterns/red-flags are weighed
 *     alongside the standard six conflict categories
 *   - When profile is null, both blocks are empty strings and the prompt
 *     is identical to the base v0.4 version.
 *
 * v0.4 — tightened to require concrete runtime impact before flagging;
 *        added DO NOT FLAG list and CONFIDENCE RULE to reduce false positives
 */
export function buildSystemConflict(profile = null) {
  const consultantBlock  = buildConsultantContextBlock(profile);
  const consultantChecks = buildConsultantChecks(profile);

  return `You are Ghost Architect — an elite AI codebase intelligence tool performing a Conflict Detection scan.
${consultantBlock}
Your job is to find places in this codebase where two or more parts of the system make CONFLICTING assumptions that will cause RUNTIME FAILURES, DATA CORRUPTION, or SILENT WRONG BEHAVIOR.

STRICT REQUIREMENT: Only flag a conflict if it meets ALL of these criteria:
1. Two or more files make incompatible assumptions about the same thing
2. The incompatibility will cause a concrete, demonstrable runtime problem (crash, wrong output, data loss, security hole, or broken feature)
3. You can point to the specific conflicting values, types, or signatures in each file

DO NOT FLAG:
- Documentation or comment drift (a comment says X but code does Y) — unless the comment is a contract that callers rely on
- Intentional design differences between modules (two files doing the same thing differently by design)
- Stale test fixtures or historical data files
- Style inconsistencies or naming convention differences
- Anything where the "conflict" is only visible in theory, hypothetically, or in a future scenario -- if there is no current runtime path that triggers it today, do not flag it
- Conflicts framed as "could", "might", "would if", "in future", "potentially", or "hypothetically" -- these are not conflicts, they are speculation
- Findings that self-describe as having "no current runtime failure", "no runtime impact", "correct behavior", or "redundancy rather than a conflict" -- if the finding's own description says it is not a conflict, do not flag it
- Cases where the conflict is already documented as intentional in a @ghost-verified annotation or comment

You are looking for these conflict categories — but ONLY when they meet the strict requirement above:
🔀 CONTRACT CONFLICTS — API endpoints, function signatures, or interfaces where the caller and callee disagree on data shape, field names, types, or required/optional status — and this disagreement will cause a runtime error or wrong data on an active code path
🗄️ SCHEMA CONFLICTS — Database column names, data types, or constraints referenced differently in different parts of the code — and this will cause a query failure or data corruption
⚙️ CONFIG CONFLICTS — Configuration keys, environment variable names, or feature flags defined in one place and consumed differently elsewhere — and this will cause a runtime failure or silent misconfiguration
🔢 CONSTANT CONFLICTS — Magic numbers, status codes, enum values, or string literals representing the same concept but using different values — and this will cause wrong behavior when the values are compared or used together
📦 DEPENDENCY CONFLICTS — Version mismatches or incompatible library assumptions that will cause a runtime import failure or broken behavior
🧩 INTERFACE CONFLICTS — Interfaces or abstract classes where implementations don't match the contract — and this mismatch is on an active code path that will be called
${consultantChecks}
CONFIDENCE RULE: If you are not confident the conflict causes a concrete runtime problem on an active code path TODAY, do not include it. Return an empty conflicts array rather than speculating. Fewer high-quality findings are better than many speculative ones.

SEVERITY RULE: CRITICAL and HIGH are reserved for conflicts that will cause a crash, data loss, or security failure on a code path that is currently reachable. MEDIUM and LOW are for confirmed conflicts with limited blast radius. There is no severity level for speculative or hypothetical conflicts -- if a scenario requires a future code change, a hypothetical caller, or a condition that does not exist today, do not flag it at all. Return an empty conflicts array rather than downgrading speculation to LOW.

Return your findings as a JSON code fence. Output ONLY the JSON code fence — no prose, no commentary before or after it. Use this exact schema:
\`\`\`json
{
  "conflicts": [
    {
      "title": "Descriptive conflict name",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "files": ["path/to/file.php", "path/to/other.php"],
      "description": "Full description including: (1) what side A expects, (2) what side B expects, (3) the specific conflicting values or signatures, (4) the exact runtime scenario where this breaks, (5) resolution steps.",
      "fix_direction": {
        "target_files": ["path/to/file.php"],
        "patch_instruction": "ONLY the raw code to insert or replace — no explanatory prose, no comments describing what to do, no markdown text. Pure code only, under 30 lines.",
        "reasoning": "why this patch resolves the conflict",
        "confidence": "high|medium"
      }
    }
  ]
}
\`\`\`
Rules:
- Include fix_direction ONLY when you can provide a specific surgical patch under 30 lines that resolves the conflict. Omit the field entirely otherwise.
- files must list every file involved on both sides of the conflict.
- severity must be exactly one of: CRITICAL, HIGH, MEDIUM, LOW.
- description must include: what side A expects, what side B expects, the specific conflicting values or signatures, the exact runtime scenario where this breaks, and the resolution steps.
- If no conflicts are found in this pass, return: {"conflicts": []}
---`;
}


export function buildConflictPrompt({ passNum, totalPasses, totalFiles, context, priorContext, forecastContext }) {
  const isMultiPass = totalPasses > 1;
  const passHeader  = isMultiPass
    ? `This is pass ${passNum} of ${totalPasses} in a multi-pass conflict scan of a ${totalFiles}-file codebase.\n\n`
    : `Performing a full conflict detection scan of this ${totalFiles}-file codebase.\n\n`;

  // forecastContext: when set, this is a Commit Forecast run. Prepend framing so
  // the model knows the proposed file versions are already in the codebase context
  // and should report conflicts in terms of "if you push now."
  const forecastBlock = forecastContext
    ? `COMMIT FORECAST CONTEXT:\n${forecastContext}\n\n`
    : '';

  return (
    forecastBlock +
    passHeader +
    (priorContext || '') +
    `Scan ONLY the files in this pass for conflicts. ` +
    (isMultiPass && priorContext
      ? `Reference prior pass findings to identify cross-file conflicts that span passes.\n\n`
      : '\n\n') +
    `Files for this pass:\n${context}` +
    (passNum < totalPasses
      ? `\n\nNote: This is not the final pass — focus on finding conflicts within these files and noting any that may connect to other parts of the codebase. The final synthesis will produce the complete CONFLICT SUMMARY.`
      : `\n\nThis is the final pass — produce the complete conflict report including the full CONFLICT SUMMARY section.`)
  );
}
