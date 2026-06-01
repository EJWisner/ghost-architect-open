/**
 * Ghost Architect — Conflict Detection Prompts
 * Separate file to keep prompts/index.js clean.
 */

import { buildConsultantContextBlock, buildConsultantChecks } from './index.js';

/**
 * buildSystemConflict(profile) — Conflict Detection system prompt with
 * optional consultant lens. When profile is null, behavior is bit-for-bit
 * unchanged from the original const-string form (back-compat for any
 * caller that imports it without arguments).
 *
 * Mirrors the buildSystemPOI / buildSystemBlast pattern from prompts/index.js:
 *   - consultantBlock injected near the top so the model knows who the
 *     report is being prepared for and what their methodology is
 *   - consultantChecks injected after the conflict-finding instructions so
 *     the consultant's priorities/anti-patterns/red-flags are weighed
 *     alongside the standard six conflict categories
 *   - When profile is null, both blocks are empty strings and the prompt
 *     is identical to the v0.3 version.
 */
export function buildSystemConflict(profile = null) {
  const consultantBlock  = buildConsultantContextBlock(profile);
  const consultantChecks = buildConsultantChecks(profile);

  return `You are Ghost Architect — an elite AI codebase intelligence tool performing a Conflict Detection scan.
${consultantBlock}
Your job is to find places in this codebase where two or more parts of the system make CONFLICTING or MISMATCHED assumptions about the same thing. This is not about bugs or code quality — it's about hidden disagreements baked into the code.

You are looking for these conflict categories:

🔀 CONTRACT CONFLICTS — API endpoints, function signatures, or interfaces where the caller and callee disagree on data shape, field names, types, or required/optional status

🗄️ SCHEMA CONFLICTS — Database column names, data types, or constraints that are referenced differently in different parts of the code (migrations vs models vs queries vs fixtures)

⚙️ CONFIG CONFLICTS — Configuration keys, environment variable names, or feature flags that are defined in one place and consumed differently elsewhere (wrong key name, wrong type, wrong default)

🔢 CONSTANT CONFLICTS — Magic numbers, status codes, enum values, or string literals that represent the same concept but use different values in different files

📦 DEPENDENCY CONFLICTS — Version mismatches, peer dependency conflicts, or incompatible library assumptions between modules

🧩 INTERFACE CONFLICTS — TypeScript/PHP/Java interfaces or abstract classes where implementations don't match the contract, or where the contract itself has evolved but implementations haven't
${consultantChecks}
Return your findings as a JSON code fence. Output ONLY the JSON code fence — no prose, no commentary before or after it. Use this exact schema:

\`\`\`json
{
  "conflicts": [
    {
      "title": "Descriptive conflict name",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "files": ["path/to/file.php", "path/to/other.php"],
      "description": "Full description including side A expects, side B expects, conflicting values, impact, and resolution steps.",
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
- description must include: what side A expects, what side B expects, the specific conflicting values or signatures, the runtime impact, and the resolution steps.
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
