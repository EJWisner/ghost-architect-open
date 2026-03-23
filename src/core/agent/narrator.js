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

  const findingsList = sorted.map((f, i) =>
    `Finding ${i + 1} [${f.severity}] — ${f.title}\n` +
    `Files: ${(f.files || []).join(', ')}\n` +
    `Detail: ${f.detail}\n` +
    `Confidence: ${f.confidence || 90}%`
  ).join('\n\n');

  const rates = context.rates || { junior: 85, mid: 125, senior: 200 };

  return `You are Ghost Architect, writing a codebase analysis report as a senior architect would.

ANALYSIS RESULTS:
- Files analyzed: ${filesAnalyzed}
- Steps taken: ${stepCount}
- Findings: ${findings.length}
${context.projectLabel ? `- Project: ${context.projectLabel}` : ''}
${context.mode ? `- Analysis mode: ${context.mode}` : ''}

CONFIRMED FINDINGS (sorted by severity):
${findingsList || 'No findings confirmed.'}

WRITE THE REPORT:
- Open with a one-paragraph executive summary that immediately names the most critical issue if one exists
- Group related findings thematically, not just by severity
- Write in the voice of a senior architect speaking directly to a delivery team
- For each finding: what it is, why it matters, what to do about it
- Close with a REMEDIATION SUMMARY table:
  LOW complexity: $${rates.junior}/hr | MEDIUM: $${rates.mid}/hr | HIGH/CRITICAL: $${rates.senior}/hr
- Include total estimated remediation cost

FORMAT:
- Use markdown headers (## and ###)
- Be direct and specific — no filler language
- Mention specific file names and line patterns when known
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

  const { confirmed, possible, falsePositives, stats } = verificationResult;

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

  const rates  = context.rates || { junior: 85, mid: 125, senior: 200 };
  const prompt =
    `Write a Ghost Architect Conflict Detection report as a senior architect.\n\n` +
    `VERIFICATION STATS:\n` +
    `- Candidates analyzed: ${stats.total}\n` +
    `- Confirmed conflicts: ${stats.confirmed}\n` +
    `- Possible conflicts: ${stats.possible}\n` +
    `- False positives eliminated: ${stats.falsePositives}\n\n` +
    (confirmedList ? `CONFIRMED CONFLICTS:\n${confirmedList}\n\n` : 'No confirmed conflicts.\n\n') +
    (possibleList  ? `POSSIBLE CONFLICTS:\n${possibleList}\n\n`  : '') +
    `Write a complete report:\n` +
    `- Open with deployment recommendation (safe/unsafe/conditional)\n` +
    `- Detail each confirmed conflict: impact, affected flows, fix\n` +
    `- Note possible conflicts with investigation guidance\n` +
    `- Close with remediation estimates at $${rates.junior}/$${rates.mid}/$${rates.senior}/hr\n` +
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
