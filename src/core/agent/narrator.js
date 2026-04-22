/**
 * Ghost Architect — Agent Narrator
 * Narrative report synthesis: writes findings the way a senior architect would.
 * Takes memory output and produces a report that leads with what matters most,
 * not a fixed template. Pure async — no Chalk, no Inquirer.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getConfig, resolveApiKey } from '../../config.js';

function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-5'; }

// ── Severity ordering ─────────────────────────────────────────────────────────

const SEVERITY_ORDER = { BLOCKING: 0, CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4, INFO: 5 };

function sortByseverity(findings) {
  return [...findings].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99)
  );
}

// ── Build narrative prompt ────────────────────────────────────────────────────

function buildNarratorPrompt(memoryResult, context = {}) {
  const { findings, filesAnalyzed, stepCount, auditTrail } = memoryResult;
  const sorted = sortByseverity(findings);
  const rates = context.rates || { junior: 85, mid: 125, senior: 200 };

  const findingsList = sorted.map((f, i) =>
    `Finding ${i + 1} [${f.severity}] — ${f.title}\n` +
    `Files: ${(f.files || []).join(', ')}\n` +
    `Detail: ${f.detail}\n` +
    `Confidence: ${f.confidence || 90}%`
  ).join('\n\n');

  const rawSection = context.rawSynthesis
    ? `\n\nRAW SYNTHESIS (use this as your primary source — do not omit any findings from it):\n${context.rawSynthesis}`
    : '';

  // Source grounding: include snippets from files cited in findings so the narrator
  // can describe real code patterns instead of inferring them. We budget ~30K chars
  // across all cited files combined; files are truncated individually to stay within
  // the budget. If fileMap isn't available (older callers), this is a no-op.
  let sourceGroundingSection = '';
  if (context.fileMap && typeof context.fileMap === 'object') {
    const citedFiles = new Set();
    for (const f of findings) {
      for (const file of (f.files || [])) {
        // Resolve to actual fileMap key (basename fallback)
        const clean = file.replace(/^`|`$/g, '').trim();
        if (!clean) continue;
        if (context.fileMap[clean]) { citedFiles.add(clean); continue; }
        const basename = clean.split('/').pop().split('\\').pop();
        for (const key of Object.keys(context.fileMap)) {
          if (key.endsWith(`/${clean}`) || key.split('/').pop() === basename) {
            citedFiles.add(key);
            break;
          }
        }
      }
    }
    if (citedFiles.size > 0) {
      // Budget per file: 30000 / count, capped at 6000 each
      const perFileBudget = Math.min(6000, Math.floor(30000 / citedFiles.size));
      const snippets = [];
      for (const key of citedFiles) {
        const content = context.fileMap[key] || '';
        const trimmed = content.length > perFileBudget
          ? content.slice(0, Math.floor(perFileBudget / 2))
            + '\n\n... [truncated] ...\n\n'
            + content.slice(-Math.floor(perFileBudget / 2))
          : content;
        snippets.push(`=== ${key} ===\n${trimmed}`);
      }
      sourceGroundingSection =
        `\n\nSOURCE CODE FOR CITED FILES (authoritative — use this to verify findings describe real code patterns):\n` +
        snippets.join('\n\n---\n\n') +
        `\n\nWhen describing a finding:\n` +
        `  - Confirm the finding's claim against the source above before writing confident prose\n` +
        `  - If the source shows the "fix" the finding recommends is ALREADY in place, omit the finding entirely\n` +
        `  - If the finding's specifics don't match the source, use general language instead of inventing details`;
    }
  }

  const tableRequirement = context.requireRemediationTable
    ? `\n\nCRITICAL REQUIREMENT: You MUST include a complete REMEDIATION SUMMARY table at the end of the report. ` +
      `The table must have columns: Priority | Finding | Category | Effort | Complexity | Cost. ` +
      `Include every finding. Then include a totals section. This table is the most important part of the report — do not omit it under any circumstances.`
    : '';

  return `You are Ghost Architect, writing a codebase analysis report as a senior architect would.

ANALYSIS RESULTS:
- Files analyzed: ${filesAnalyzed}
- Steps taken: ${stepCount}
- Findings: ${memoryResult.findingCount || findings.length}
${context.projectLabel ? `- Project: ${context.projectLabel}` : ''}
${context.mode ? `- Analysis mode: ${context.mode}` : ''}
${rawSection}
${sourceGroundingSection}

CONFIRMED FINDINGS (sorted by severity):
${findingsList || 'No findings confirmed.'}

WRITE THE REPORT:
- Open with a one-paragraph executive summary that immediately names the most critical issue if one exists
- Group related findings thematically, not just by severity
- Write in the voice of a senior architect speaking directly to a delivery team
- For each finding: what it is, why it matters, what to do about it
- Close with a REMEDIATION SUMMARY table:
  LOW complexity: ${rates.junior}/hr | MEDIUM: ${rates.mid}/hr | HIGH/CRITICAL: ${rates.senior}/hr
- Include total estimated remediation cost${tableRequirement}

GROUNDING RULES (non-negotiable — violating these produces incorrect reports that damage customer trust):
- You are working from the CONFIRMED FINDINGS, RAW SYNTHESIS, and SOURCE CODE FOR CITED FILES above. These are your ONLY sources of truth.
- If SOURCE CODE FOR CITED FILES is present, it is authoritative — use it to verify claims before writing confident prose.
- Do NOT cite specific line numbers under any circumstances. Describe location by method, class, or code pattern (e.g. "in the rollback catch block" or "the generateType method") instead. Line numbers will be re-attached by a downstream verifier if they can be confirmed.
- NEVER invent specific method names, variable names, SQL strings, regex patterns, or code snippets. If the source material does not contain the specific detail, describe the issue in general terms instead.
- NEVER invent class names or file paths beyond what appears in the findings and file list.
- When in doubt, be less specific rather than more specific. "The retry logic in CartRuleHandler" is acceptable. "Lines 81-99 of CartRuleHandler.php retry the same code three times" is NOT acceptable.
- Do NOT write dates, timestamps, report generation metadata, version numbers, or coverage statistics. These are added by the report generator, not by you.
- If a finding mentions a file but the source code provided does not obviously contain what the finding describes, flag the finding as tentative with language like "appears to" or "based on the pattern suggested" rather than asserting confidently.
- If a finding recommends a fix that the source code shows is already implemented, OMIT the finding entirely — do not include it with caveats.

FILE CITATION RULES (critical — fabricated file paths cause the verifier to drop findings):
- Every finding MUST cite at least one real file path that appears in the CONFIRMED FINDINGS or SOURCE CODE FOR CITED FILES sections above.
- A file path looks like: 'src/Service/Foo.php', 'app/code/Vendor/Module/Block/Bar.php', or 'src/components/Baz.tsx'. It ends in a file extension and contains directory separators.
- NEVER write the following in a "Files:" or "**Files:**" line:
  * Prose fragments like "Inferred from order creation pattern" or "Based on the handler logic"
  * Narrative descriptions like "in a throwaway test database" or "are trusted code"
  * Generic descriptions like "the order system" or "the seeding flow"
  * Empty placeholders like "**" or "N/A" or "various"
- If a finding is thematic and does not point to a specific file, OMIT the Files: line entirely rather than inventing one.
- If you are unsure which file contains the issue, OMIT the finding entirely — a vague-but-unfileable finding is worse than no finding, because the verifier will drop it.
- File paths must be the exact strings that appear in the CONFIRMED FINDINGS Files: entries or in the SOURCE CODE FOR CITED FILES === FILE: headers. Do not add asterisks, decorations, or prose before the path.

FORMAT:
- Use markdown headers (## and ###)
- Be direct and clear — no filler language
- Use file names that appear in the findings; do not invent new ones
- The report should be immediately actionable

Write the complete report now:`;
}

// ── Stream narrative report ───────────────────────────────────────────────────
/**
 * Generate a narrative report from agent memory output.
 *
 * @param {object}   memoryResult  — from memory.synthesize()
 * @param {object}   context       — { projectLabel, mode, rates }
 * @param {function} onChunk       — streaming callback for CLI/Web display
 * @returns {string}               — complete report text
 */
export async function narrateReport(memoryResult, context = {}, onChunk = () => {}) {
  const anthropic = getClient();
  const prompt    = buildNarratorPrompt(memoryResult, context);
  let   report    = '';

  const stream = anthropic.messages.stream({
    model:      getModel(),
    max_tokens: 16000,
    messages:   [{ role: 'user', content: prompt }],
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      const text = chunk.delta.text;
      onChunk(text);
      report += text;
    }
  }

  return report;
}

// ── Non-streaming version ─────────────────────────────────────────────────────
/**
 * Generate a narrative report synchronously (no streaming).
 * Useful for batch processing or Web UI where streaming isn't needed.
 */
export async function narrateReportSync(memoryResult, context = {}) {
  const anthropic = getClient();
  const prompt    = buildNarratorPrompt(memoryResult, context);

  const response = await anthropic.messages.create({
    model:      getModel(),
    max_tokens: 16000,
    messages:   [{ role: 'user', content: prompt }],
  });

  return response.content[0]?.text || '';
}

// ── Executive summary only ────────────────────────────────────────────────────
/**
 * Generate just an executive summary — fast, cheap, useful for dashboard preview.
 */
export async function narrateExecutiveSummary(memoryResult, context = {}) {
  const anthropic = getClient();
  const sorted    = sortByseverity(memoryResult.findings || []);
  const top3      = sorted.slice(0, 3).map(f => `[${f.severity}] ${f.title}`).join(', ');

  const prompt =
    `In 2-3 sentences, summarize the key findings from this codebase analysis.\n\n` +
    `Files analyzed: ${memoryResult.filesAnalyzed}\n` +
    `Total findings: ${memoryResult.findingCount}\n` +
    `Top issues: ${top3 || 'none'}\n` +
    `Project: ${context.projectLabel || 'unknown'}\n\n` +
    `Write a direct, plain-English summary a project manager would understand:`;

  const response = await anthropic.messages.create({
    model:      getModel(),
    max_tokens: 300,
    messages:   [{ role: 'user', content: prompt }],
  });

  return response.content[0]?.text || '';
}

// ── Conflict-specific narrative ───────────────────────────────────────────────
/**
 * Narrative specifically for Conflict Detection results.
 * Formats verified vs possible vs eliminated conflict counts clearly.
 */
export async function narrateConflictReport(verificationResult, context = {}, onChunk = () => {}) {
  const anthropic = getClient();

  const { confirmed, possible, falsePositives, insufficient, stats } = verificationResult;

  const confirmedList = confirmed.map(c =>
    `CONFIRMED [${c.severity || 'HIGH'}]: ${c.title || c.description}\n` +
    `Files: ${(c.files || []).join(', ')}\n` +
    `Evidence: ${c.evidence}`
  ).join('\n\n');

  const possibleList = possible.map(c =>
    `POSSIBLE [${c.severity || 'MEDIUM'}]: ${c.title || c.description}\n` +
    `Files: ${(c.files || []).join(', ')}\n` +
    `Evidence: ${c.evidence}`
  ).join('\n\n');

  const insufficientList = (insufficient || []).slice(0, 20).map(c =>
    `INCONCLUSIVE [${c.severity || 'MEDIUM'}]: ${c.title || c.description}\n` +
    `Files: ${(c.files || []).join(', ')}`
  ).join('\n\n');

  const allInconclusive = stats.confirmed === 0 && stats.possible === 0 && (insufficient || []).length > 0;

  const rates  = context.rates || { junior: 85, mid: 125, senior: 200 };
  const today  = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const prompt =
    `Write a Ghost Architect Conflict Detection report as a senior architect.\n\n` +
    `Today's date is ${today}. Use this as the Report Date in the report header.

` +
    `VERIFICATION STATS:\n` +
    `- Candidates analyzed: ${stats.total}\n` +
    `- Confirmed conflicts: ${stats.confirmed}\n` +
    `- Possible conflicts: ${stats.possible}\n` +
    `- False positives eliminated: ${stats.falsePositives}\n` +
    `- Inconclusive (requires manual review): ${(insufficient || []).length}\n\n` +
    (allInconclusive
      ? `IMPORTANT: The verifier could not confirm or eliminate any candidates due to limited file context. ` +
        `Do NOT say the codebase is safe. Instead surface the top candidates as requiring manual review.\n\n`
      : '') +
    (confirmedList    ? `CONFIRMED CONFLICTS:\n${confirmedList}\n\n`       : 'No confirmed conflicts.\n\n') +
    (possibleList     ? `POSSIBLE CONFLICTS:\n${possibleList}\n\n`          : '') +
    (insufficientList ? `REQUIRES MANUAL REVIEW (top 20 of ${(insufficient||[]).length}):\n${insufficientList}\n\n` : '') +
    `Write a complete report:\n` +
    `- Open with deployment recommendation (safe/unsafe/conditional/inconclusive)\n` +
    `- If all results are inconclusive, say so clearly — do NOT claim the codebase is conflict-free\n` +
    `- Detail each confirmed conflict: impact, affected flows, fix\n` +
    `- Note possible conflicts with investigation guidance\n` +
    `- List inconclusive candidates as requiring manual review\n` +
    `- Close with remediation estimates at ${rates.junior}/${rates.mid}/${rates.senior}/hr\n` +
    `Use markdown. Be direct and specific:`;

  let report = '';
  const stream = anthropic.messages.stream({
    model: getModel(), max_tokens: 5000,
    messages: [{ role: 'user', content: prompt }],
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      const text = chunk.delta.text;
      onChunk(text);
      report += text;
    }
  }

  return report;
}
