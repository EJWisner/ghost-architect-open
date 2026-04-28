/**
 * Ghost Architect — Agent Narrator
 *
 * Two-pass narrative report synthesis:
 *
 *   Pass 1 (planReportStructure):
 *     Non-streaming, cheap, JSON output. Decides the category structure,
 *     assigns findings to categories, computes subtotals, drafts the exec
 *     summary. Output is a deterministic plan.
 *
 *   Pass 2 (renderReportFromPlan):
 *     Streaming, prose-focused. Takes the plan from Pass 1 and the original
 *     findings detail, writes the user-facing report.
 *
 *   Pass 2.5 (validateAndPatchProse):
 *     Post-processing completeness check. For any finding in the plan that
 *     does not appear as a prose entry in the rendered report, render a
 *     single-finding entry and splice it into the right category section.
 *     Fixes the common Pass 2 failure mode where the model renders a subset
 *     of findings and jumps to the summary table.
 *
 * If Pass 1 fails to produce valid JSON, we fall back to a single-pass
 * rendering (the legacy path).
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getConfig, resolveApiKey } from '../../config.js';

function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-5'; }

const DOLLAR = '\u0024';

// ── Severity ordering ─────────────────────────────────────────────────────────

const SEVERITY_ORDER = { BLOCKING: 0, CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4, INFO: 5 };

function sortByseverity(findings) {
  return [...findings].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99)
  );
}

// ── Shared prompt helpers ────────────────────────────────────────────────────

function buildConsultantLens(profile) {
  if (!profile) return '';
  const lines = [];
  if (profile.author)       lines.push('- Consultant: ' + profile.author + (profile.organization ? ' (' + profile.organization + ')' : ''));
  if (profile.name)         lines.push('- Profile: ' + profile.name);
  if (profile.description)  lines.push('- Purpose: ' + profile.description);
  if (Array.isArray(profile.priorities)    && profile.priorities.length)    lines.push('- Priorities:\n    • ' + profile.priorities.join('\n    • '));
  if (Array.isArray(profile.anti_patterns) && profile.anti_patterns.length) lines.push('- Anti-patterns:\n    • ' + profile.anti_patterns.join('\n    • '));
  if (Array.isArray(profile.red_flags)     && profile.red_flags.length)     lines.push('- Red flags:\n    • ' + profile.red_flags.join('\n    • '));
  if (profile.prose)        lines.push('- Diagnostic voice: ' + profile.prose);
  if (!lines.length) return '';
  return '\n\nCONSULTANT LENS — this report is being prepared on behalf of the consultant described below. Name findings in their vocabulary WHERE THE CODE ACTUALLY EXHIBITS THE PATTERN; paraphrase to plain Ghost terms where it does not. Vocabulary serves grounding, not the other way around.\n\n' + lines.join('\n');
}

function buildSourceGroundingBlock(findings, fileMap) {
  if (!fileMap || typeof fileMap !== 'object') return '';
  const citedFiles = new Set();
  for (const f of findings) {
    for (const file of (f.files || [])) {
      const clean = file.replace(/^`|`$/g, '').trim();
      if (!clean) continue;
      if (fileMap[clean]) { citedFiles.add(clean); continue; }
      const basename = clean.split('/').pop().split('\\').pop();
      for (const key of Object.keys(fileMap)) {
        if (key.endsWith('/' + clean) || key.split('/').pop() === basename) {
          citedFiles.add(key);
          break;
        }
      }
    }
  }
  if (citedFiles.size === 0) return '';
  const perFileBudget = Math.min(6000, Math.floor(30000 / citedFiles.size));
  const snippets = [];
  for (const key of citedFiles) {
    const content = fileMap[key] || '';
    const trimmed = content.length > perFileBudget
      ? content.slice(0, Math.floor(perFileBudget / 2))
        + '\n\n... [truncated] ...\n\n'
        + content.slice(-Math.floor(perFileBudget / 2))
      : content;
    snippets.push('=== ' + key + ' ===\n' + trimmed);
  }
  return '\n\nSOURCE CODE FOR CITED FILES (authoritative — use to verify findings):\n'
    + snippets.join('\n\n---\n\n')
    + '\n\nGROUNDING: Verify each finding against the source above. If the source shows the fix is already in place, skip that finding. If the finding specifics do not match the source, describe the issue in general terms.';
}

function extractJson(text) {
  if (!text) return null;
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

// ── Mode detection helpers ────────────────────────────────────────────────────

// Blast mode emits different category headers AND adds a structured rollback
// plan section. POI mode keeps the existing four-category Ghost framework.
// Conflict mode has its own narrator entry point and doesn't reach this path.
// We branch on context.mode === 'blast' explicitly; anything else (poi,
// undefined, etc.) takes the legacy POI path so existing behavior is
// preserved bit-for-bit.
function isBlastMode(context) {
  return context && context.mode === 'blast';
}

// ── Pass 1: Structural planning ──────────────────────────────────────────────

// Upper bound on findings that flow into Pass 1. Above this, the plan gets
// too big for Pass 2's 16K token budget and the report collapses (see
// baseline-v8: a 51-finding plan blew past the budget and the remediation
// table never got written). When the raw finding set exceeds this cap, we
// rank by (severity ordinal, cost midpoint descending) and keep the top N.
const MAX_FINDINGS_FOR_PASS_2 = 25;

function costMidpoint(finding) {
  const detail = finding.detail || '';
  const m = detail.match(/\$(\d{2,5}(?:,\d{3})*)\s*[–\-]\s*\$?(\d{2,5}(?:,\d{3})*)/);
  if (!m) return 0;
  const lo = parseInt(m[1].replace(/,/g, ''), 10);
  const hi = parseInt(m[2].replace(/,/g, ''), 10);
  return Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : 0;
}

/**
 * If the raw finding set is larger than the cap, keep the top N by
 * (severity ordinal ascending, cost midpoint descending). Returns a
 * new array; the input is not mutated. When `silent` is false, logs a
 * single stderr line so it's visible in the terminal without disrupting
 * user-facing output. Pass 1 logs; Pass 2 and the patcher are silent
 * (they call with silent=true so we don't emit three identical lines).
 */
function capFindingsForPass2(sortedFindings, cap, silent) {
  if (sortedFindings.length <= cap) return sortedFindings;
  const ranked = [...sortedFindings].sort((a, b) => {
    const sevA = SEVERITY_ORDER[a.severity] ?? 99;
    const sevB = SEVERITY_ORDER[b.severity] ?? 99;
    if (sevA !== sevB) return sevA - sevB;
    return costMidpoint(b) - costMidpoint(a);
  });
  const kept = ranked.slice(0, cap);
  if (!silent) {
    try {
      console.error(
        '  (Narrator: ' + sortedFindings.length + ' findings exceeded cap of ' + cap +
        '; rendering top ' + cap + ' by severity and cost.)'
      );
    } catch { /* ignore logging failures */ }
  }
  return kept;
}

/**
 * Return a one-line disclosure suitable for embedding in the saved report
 * when the finding cap was applied. Returns null when the cap did NOT
 * fire (originalCount <= cap), so callers can use it as a presence check.
 *
 * Why surface this in the saved report at all: the verbose stderr line
 * only appears in the terminal during the run. Consultants opening the
 * PDF later have no way to know that 3 findings were dropped. The
 * disclosure goes into the prompt and (defensively) into the patcher
 * so it always lands in the saved markdown when relevant.
 */
function getCapDisclosure(originalCount, cap) {
  if (!Number.isFinite(originalCount) || !Number.isFinite(cap)) return null;
  if (originalCount <= cap) return null;
  return '_Note: ' + originalCount + ' findings surfaced during analysis; this report renders the top '
    + cap + ' by severity and cost. The remaining '
    + (originalCount - cap) + ' lower-priority findings are available in the raw scan output._';
}

async function planReportStructure(memoryResult, context = {}) {
  // Mode router: blast reports need different category structure (Direct
  // Dependencies / Ripple Effects / Danger Zones / Safe Zones) and a
  // structured rollback plan that POI doesn't have. Route to the blast
  // planner if context says so; otherwise the existing POI planner runs
  // unchanged.
  if (isBlastMode(context)) {
    return planBlastReport(memoryResult, context);
  }

  const { findings } = memoryResult;
  const sortedAll = sortByseverity(findings);
  const sorted = capFindingsForPass2(sortedAll, MAX_FINDINGS_FOR_PASS_2, false);
  const rates = context.rates || { junior: 85, mid: 125, senior: 200 };
  const profile = context.profile || null;

  const findingsForPlanning = sorted.map((f, i) => {
    const detail = f.detail || '';
    const costMatch = detail.match(/\$(\d{2,5}(?:,\d{3})*)\s*[–\-]\s*\$?(\d{2,5}(?:,\d{3})*)/);
    const effortMatch = detail.match(/(\d+(?:\.\d+)?)\s*[–\-]\s*(\d+(?:\.\d+)?)\s*(?:hours|hrs)/i);
    const complexityMatch = detail.match(/complexity[:\s]+(low|medium|high|requires architect|critical)/i);
    return {
      id: i + 1,
      severity: f.severity,
      title: f.title,
      files: f.files || [],
      cost_range: costMatch ? (DOLLAR + costMatch[1] + '–' + DOLLAR + costMatch[2]) : null,
      effort_range: effortMatch ? (effortMatch[1] + '–' + effortMatch[2] + ' hrs') : null,
      complexity: complexityMatch ? complexityMatch[1].toUpperCase() : null,
      detail_excerpt: detail.slice(0, 400),
    };
  });

  const consultantLens = buildConsultantLens(profile);
  const rateJuniorLine = DOLLAR + rates.junior + '/hr';
  const rateMidLine    = DOLLAR + rates.mid    + '/hr';
  const rateSeniorLine = DOLLAR + rates.senior + '/hr';

  const projectLine = context.projectLabel ? ('PROJECT: ' + context.projectLabel + '\n') : '';
  const modeLine    = context.mode         ? ('MODE: ' + context.mode + '\n')           : '';

  const planningPrompt =
    (profile
      ? 'You are planning the structure of a pre-engagement codebase analysis report being prepared on behalf of the consultant described in the CONSULTANT LENS below. Your job is NOT to write prose — it is to organize findings into categories and compute totals. A second pass will render the prose from your plan.'
      : 'You are planning the structure of a Ghost Architect codebase analysis report. Your job is NOT to write prose — it is to organize findings into categories and compute totals. A second pass will render the prose from your plan.')
    + consultantLens + '\n\n'
    + 'FINDINGS TO ORGANIZE:\n' + JSON.stringify(findingsForPlanning, null, 2) + '\n\n'
    + 'BILLING RATES:\n'
    + '- LOW complexity: ' + rateJuniorLine + '\n'
    + '- MEDIUM complexity: ' + rateMidLine + '\n'
    + '- HIGH / CRITICAL / Requires architect: ' + rateSeniorLine + '\n\n'
    + projectLine + modeLine + '\n'
    + 'YOUR JOB:\n'
    + '1. Choose 3–6 category headers that fit these findings. Use Ghost\'s four canonical categories (🔴 Red Flags, 🏛️ Landmarks, ⚰️ Dead Zones, ⚡ Fault Lines) as the default. If a consultant lens is present, you may replace or rename categories to match their methodology — but only create a category if at least one finding belongs in it.\n'
    + '2. Assign every ACTIONABLE finding to exactly one category. Do NOT create a category that has zero findings. Every finding id from the input MUST appear in exactly one category UNLESS the finding is non-actionable (see rule 2a below).\n'
    + '2a. Skip non-actionable findings entirely. A finding is non-actionable when it is purely an architectural observation, a discussion of design tradeoffs, a description of how a system works, or anything that does not name a specific code change with measurable effort. These findings have no place in a remediation report. Do not assign them to a category, do not include them in any finding_ids array. They simply disappear from the plan. Symptoms that a finding is non-actionable: detail text uses words like "observation", "awareness", "document this", "this is by design", or "single point of failure" without a concrete code change; or no specific files, methods, or fixes are cited.\n'
    + '3. For each category, compute the subtotal dollar range by summing the cost_range of every finding assigned to it. If a finding has no cost_range, estimate one based on severity + complexity using the billing rates above. Estimates must be REAL ranges (e.g. ' + DOLLAR + '400–' + DOLLAR + '600), never ' + DOLLAR + '0 and never N/A.\n'
    + '4. Compute the grand total as the sum of all category subtotals.\n'
    + '5. Draft a 3–6 sentence executive summary that names the top 1–2 findings by impact and quantifies total remediation cost. Use the grand total dollar range verbatim — do NOT compute a separate subtotal in the summary unless you are restating a category subtotal from step 3.\n\n'
    + 'OUTPUT FORMAT:\n'
    + 'Respond with a single JSON object, no prose before or after, no code fences. Schema:\n\n'
    + '{\n'
    + '  "report_title": "string",\n'
    + '  "executive_summary": "string — 3–6 sentences, plain text, no markdown headers",\n'
    + '  "categories": [\n'
    + '    {\n'
    + '      "header": "string — full category heading including emoji if appropriate",\n'
    + '      "finding_ids": [1, 3, 5],\n'
    + '      "subtotal_low": 1985,\n'
    + '      "subtotal_high": 3170\n'
    + '    }\n'
    + '  ],\n'
    + '  "grand_total_low": 3704,\n'
    + '  "grand_total_high": 5710\n'
    + '}\n\n'
    + 'CRITICAL VALIDATION:\n'
    + '- Every finding id from the input MUST appear in exactly one category\'s finding_ids array.\n'
    + '- No category may have an empty finding_ids array.\n'
    + '- Subtotals must be numeric (no dollar signs, no commas in JSON numbers).\n'
    + '- The grand total must equal the sum of all category subtotals.\n'
    + '- The executive summary must be a single string with no markdown section headers.\n'
    + (profile
        ? '\nREPORT TITLE RULES:\n'
          + '- The report_title MUST NOT contain "Ghost Architect" or any reference to Ghost.\n'
          + '- Use "Pre-Engagement Diligence:" or "Codebase Triage:" as the prefix, followed by the project label.\n'
          + '- Example: "Pre-Engagement Diligence: ' + (context.projectLabel || 'project-name') + '".\n'
          + '\nEXECUTIVE SUMMARY RULES:\n'
          + '- The executive_summary MUST NOT mention "Ghost Architect" or "Ghost" by name.\n'
          + '- Write as the consultant would, in their voice, focused on findings and remediation.\n'
        : '')
    + '\nRespond with ONLY the JSON object.';

  const anthropic = getClient();
  try {
    const response = await anthropic.messages.create({
      model: getModel(),
      max_tokens: 3000,
      temperature: 0.2,
      messages: [{ role: 'user', content: planningPrompt }],
    });
    const text = response.content[0]?.text || '';
    const plan = extractJson(text);
    if (!plan) return null;
    if (!validatePlan(plan, sorted.length)) return null;
    return plan;
  } catch {
    return null;
  }
}

// ── Blast planner ────────────────────────────────────────────────────────────
//
// Parallel to planReportStructure (POI), tuned for blast radius output.
// Differences from the POI planner:
//   - Categories default to Direct Dependencies / Ripple Effects / Danger
//     Zones / Safe Zones / Before You Touch It instead of Red Flags /
//     Landmarks / Dead Zones / Fault Lines.
//   - The plan includes a `rollback_plan` field with structured subsections
//     (pre_change_snapshot, rollback_steps, point_of_no_return, who_to_notify,
//     smoke_test). The renderer turns this into the ## 🔄 Rollback Plan
//     section that the cover page promises.
//   - The executive summary frames findings as "impact of changing X" rather
//     than "debt to remediate".
//
// Total findings cap, cost-midpoint ranking, profile lens, and JSON validation
// are reused from the POI path because none of that is mode-specific.

async function planBlastReport(memoryResult, context = {}) {
  const { findings } = memoryResult;
  const sortedAll = sortByseverity(findings);
  const sorted = capFindingsForPass2(sortedAll, MAX_FINDINGS_FOR_PASS_2, false);
  const rates = context.rates || { junior: 85, mid: 125, senior: 200 };
  const profile = context.profile || null;

  const findingsForPlanning = sorted.map((f, i) => {
    const detail = f.detail || '';
    const costMatch = detail.match(/\$(\d{2,5}(?:,\d{3})*)\s*[\u2013\-]\s*\$?(\d{2,5}(?:,\d{3})*)/);
    const effortMatch = detail.match(/(\d+(?:\.\d+)?)\s*[\u2013\-]\s*(\d+(?:\.\d+)?)\s*(?:hours|hrs)/i);
    const complexityMatch = detail.match(/complexity[:\s]+(low|medium|high|requires architect|critical)/i);
    return {
      id: i + 1,
      severity: f.severity,
      title: f.title,
      files: f.files || [],
      cost_range: costMatch ? (DOLLAR + costMatch[1] + '\u2013' + DOLLAR + costMatch[2]) : null,
      effort_range: effortMatch ? (effortMatch[1] + '\u2013' + effortMatch[2] + ' hrs') : null,
      complexity: complexityMatch ? complexityMatch[1].toUpperCase() : null,
      detail_excerpt: detail.slice(0, 400),
    };
  });

  const consultantLens = buildConsultantLens(profile);
  const rateJuniorLine = DOLLAR + rates.junior + '/hr';
  const rateMidLine    = DOLLAR + rates.mid    + '/hr';
  const rateSeniorLine = DOLLAR + rates.senior + '/hr';

  const projectLine = context.projectLabel ? ('CHANGE TARGET: ' + context.projectLabel + '\n') : '';

  const planningPrompt =
    (profile
      ? 'You are planning the structure of a pre-engagement BLAST RADIUS analysis on behalf of the consultant described in the CONSULTANT LENS below. The developer is considering a coordinated code change and needs to understand the full impact AND have a complete rollback plan if something goes wrong. Your job is NOT to write prose \u2014 it is to organize findings into impact categories, plan the rollback procedure, and compute totals. A second pass will render the prose from your plan.'
      : 'You are planning the structure of a Ghost Architect BLAST RADIUS analysis. The developer is considering a coordinated code change and needs to understand the full impact AND have a complete rollback plan if something goes wrong. Your job is NOT to write prose \u2014 it is to organize findings into impact categories, plan the rollback procedure, and compute totals. A second pass will render the prose from your plan.')
    + consultantLens + '\n\n'
    + 'FINDINGS TO ORGANIZE:\n' + JSON.stringify(findingsForPlanning, null, 2) + '\n\n'
    + 'BILLING RATES:\n'
    + '- LOW complexity: ' + rateJuniorLine + '\n'
    + '- MEDIUM complexity: ' + rateMidLine + '\n'
    + '- HIGH / CRITICAL / Requires architect: ' + rateSeniorLine + '\n\n'
    + projectLine + 'MODE: blast radius\n\n'
    + 'YOUR JOB:\n'
    + '1. Choose 3\u20136 category headers that fit these findings using the BLAST RADIUS framework, NOT the POI four-category framework. The default blast categories are:\n'
    + '   \u2022 \ud83d\udca5 Direct Dependencies \u2014 files/classes that directly import or call the changing code\n'
    + '   \u2022 \ud83c\udf0a Ripple Effects \u2014 secondary impacts that depend on the direct dependencies\n'
    + '   \u2022 \ud83e\udde8 Danger Zones \u2014 places where the change could cause silent failures or hard-to-detect bugs\n'
    + '   \u2022 \u2705 Safe Zones \u2014 parts of the codebase that appear isolated from this change\n'
    + '   \u2022 \u26a0\ufe0f Before You Touch It \u2014 specific warnings, preconditions, things to verify first\n'
    + '   Use these categories. Do NOT use the POI categories (Red Flags / Landmarks / Dead Zones / Fault Lines) \u2014 they are for a different report type. If a consultant lens is present, you may rename categories to match their methodology vocabulary, but the underlying intent (direct deps, ripples, dangers, safe zones, preconditions) must stay.\n'
    + '2. Assign every ACTIONABLE finding to exactly one category. Do NOT create a category that has zero findings. Every finding id from the input MUST appear in exactly one category UNLESS the finding is non-actionable (rule 2a).\n'
    + '2a. Skip non-actionable findings entirely. A finding is non-actionable when it is purely an architectural observation, a discussion of design tradeoffs, or anything that does not name a specific code change with measurable effort. These do not appear in any category and disappear from the plan.\n'
    + '3. For each category, compute the subtotal dollar range by summing the cost_range of every finding assigned to it. If a finding has no cost_range, estimate one based on severity + complexity using the billing rates above. Estimates must be REAL ranges (e.g. ' + DOLLAR + '400\u2013' + DOLLAR + '600), never ' + DOLLAR + '0 and never N/A.\n'
    + '4. Compute the grand total as the sum of all category subtotals.\n'
    + '5. Draft a 3\u20136 sentence executive summary that frames the change set\u2019s impact (not POI-style debt language). Name the top 1\u20132 dangers and quantify total remediation cost using the grand total dollar range verbatim.\n'
    + '6. Plan the ROLLBACK PROCEDURE for the change set. This is the section the cover page promises. Provide concrete content for each subsection: pre_change_snapshot (what currently exists that the change will modify), rollback_steps (numbered plain-English steps to undo the change), point_of_no_return (the moment after which rollback becomes significantly harder), who_to_notify (roles that must be informed during a rollback and why), and smoke_test (3\u20135 specific things to verify rollback succeeded). The rollback plan must be specific to the actual files and behaviors named in the findings \u2014 not generic advice.\n\n'
    + 'OUTPUT FORMAT:\n'
    + 'Respond with a single JSON object, no prose before or after, no code fences. Schema:\n\n'
    + '{\n'
    + '  "report_title": "string",\n'
    + '  "executive_summary": "string \u2014 3\u20136 sentences, plain text, no markdown headers",\n'
    + '  "categories": [\n'
    + '    {\n'
    + '      "header": "string \u2014 full category heading including emoji",\n'
    + '      "finding_ids": [1, 3, 5],\n'
    + '      "subtotal_low": 1985,\n'
    + '      "subtotal_high": 3170\n'
    + '    }\n'
    + '  ],\n'
    + '  "grand_total_low": 3704,\n'
    + '  "grand_total_high": 5710,\n'
    + '  "rollback_plan": {\n'
    + '    "pre_change_snapshot": [\n'
    + '      "string \u2014 a specific file/value/state that exists BEFORE the change",\n'
    + '      "string \u2014 ..."\n'
    + '    ],\n'
    + '    "rollback_steps": [\n'
    + '      { "step": "string \u2014 specific action", "estimated_time": "string \u2014 e.g. \'2 minutes\' or \'10\u201315 minutes\'" },\n'
    + '      { "step": "string", "estimated_time": "string" }\n'
    + '    ],\n'
    + '    "total_rollback_time": "string \u2014 e.g. \'15\u201330 minutes\'",\n'
    + '    "rollback_complexity": "LOW | MEDIUM | HIGH | Impossible after point of no return",\n'
    + '    "rollback_risk": "string \u2014 what risks the rollback itself introduces",\n'
    + '    "point_of_no_return": {\n'
    + '      "trigger": "string \u2014 the action after which rollback becomes significantly harder",\n'
    + '      "additional_steps_required": "string \u2014 what extra work is needed after that threshold"\n'
    + '    },\n'
    + '    "who_to_notify": [\n'
    + '      { "role": "string", "reason": "string \u2014 why they need to know and what action they must take" }\n'
    + '    ],\n'
    + '    "smoke_test": [\n'
    + '      "string \u2014 a specific verification step",\n'
    + '      "string \u2014 ..."\n'
    + '    ]\n'
    + '  }\n'
    + '}\n\n'
    + 'CRITICAL VALIDATION:\n'
    + '- Every finding id from the input MUST appear in exactly one category\u2019s finding_ids array unless skipped under rule 2a.\n'
    + '- No category may have an empty finding_ids array.\n'
    + '- Subtotals must be numeric (no dollar signs, no commas in JSON numbers).\n'
    + '- The grand total must equal the sum of all category subtotals.\n'
    + '- The executive summary must be a single string with no markdown section headers.\n'
    + '- The rollback_plan field is REQUIRED and must contain all subsections shown in the schema. Empty arrays or empty strings are invalid \u2014 every subsection needs real content grounded in the findings.\n'
    + (profile
        ? '\nREPORT TITLE RULES:\n'
          + '- The report_title MUST NOT contain "Ghost Architect" or any reference to Ghost.\n'
          + '- Use "Pre-Engagement Diligence:", "Blast Radius Analysis:", or "Change Set Analysis:" as the prefix, followed by the change target.\n'
          + '- Example: "Blast Radius Analysis: ' + (context.projectLabel || 'change-target') + '".\n'
          + '\nEXECUTIVE SUMMARY RULES:\n'
          + '- The executive_summary MUST NOT mention "Ghost Architect" or "Ghost" by name.\n'
          + '- Write as the consultant would, in their voice, framing the change set\u2019s impact and rollback considerations.\n'
        : '')
    + '\nRespond with ONLY the JSON object.';

  const anthropic = getClient();
  try {
    const response = await anthropic.messages.create({
      model: getModel(),
      max_tokens: 4000,
      temperature: 0.2,
      messages: [{ role: 'user', content: planningPrompt }],
    });
    const text = response.content[0]?.text || '';
    const plan = extractJson(text);
    if (!plan) return null;
    if (!validateBlastPlan(plan, sorted.length)) return null;
    return plan;
  } catch {
    return null;
  }
}

// validateBlastPlan extends validatePlan with rollback_plan structural checks.
// We can't reuse validatePlan directly because it doesn't know about
// rollback_plan; we duplicate the field checks here so the blast path is
// self-contained and POI's validator stays unchanged.
function validateBlastPlan(plan, totalFindings) {
  if (!plan || typeof plan !== 'object') return false;
  if (typeof plan.report_title !== 'string' || !plan.report_title.trim()) return false;
  if (typeof plan.executive_summary !== 'string' || !plan.executive_summary.trim()) return false;
  if (!Array.isArray(plan.categories) || plan.categories.length === 0) return false;

  const seenIds = new Set();
  let subtotalSumLow = 0;
  let subtotalSumHigh = 0;

  for (const cat of plan.categories) {
    if (typeof cat.header !== 'string' || !cat.header.trim()) return false;
    if (!Array.isArray(cat.finding_ids) || cat.finding_ids.length === 0) return false;
    for (const id of cat.finding_ids) {
      if (!Number.isInteger(id) || id < 1 || id > totalFindings) return false;
      if (seenIds.has(id)) return false;
      seenIds.add(id);
    }
    if (typeof cat.subtotal_low !== 'number' || typeof cat.subtotal_high !== 'number') return false;
    if (cat.subtotal_low < 0 || cat.subtotal_high < cat.subtotal_low) return false;
    subtotalSumLow  += cat.subtotal_low;
    subtotalSumHigh += cat.subtotal_high;
  }

  if (typeof plan.grand_total_low !== 'number' || typeof plan.grand_total_high !== 'number') return false;
  const slack = Math.max(500, subtotalSumHigh * 0.05);
  if (Math.abs(plan.grand_total_low  - subtotalSumLow)  > slack) return false;
  if (Math.abs(plan.grand_total_high - subtotalSumHigh) > slack) return false;

  if (seenIds.size === 0) return false;

  // Rollback plan validation: required for blast mode. Each subsection must
  // have real content. We tolerate small variations (string vs object steps,
  // who_to_notify entries that are just strings, etc.) but reject anything
  // that\u2019s clearly a placeholder.
  const rb = plan.rollback_plan;
  if (!rb || typeof rb !== 'object') return false;
  if (!Array.isArray(rb.pre_change_snapshot) || rb.pre_change_snapshot.length === 0) return false;
  if (!Array.isArray(rb.rollback_steps) || rb.rollback_steps.length === 0) return false;
  if (typeof rb.total_rollback_time !== 'string' || !rb.total_rollback_time.trim()) return false;
  if (typeof rb.rollback_complexity !== 'string' || !rb.rollback_complexity.trim()) return false;
  if (typeof rb.rollback_risk !== 'string' || !rb.rollback_risk.trim()) return false;
  if (!rb.point_of_no_return || typeof rb.point_of_no_return !== 'object') return false;
  if (typeof rb.point_of_no_return.trigger !== 'string' || !rb.point_of_no_return.trigger.trim()) return false;
  if (!Array.isArray(rb.who_to_notify) || rb.who_to_notify.length === 0) return false;
  if (!Array.isArray(rb.smoke_test) || rb.smoke_test.length === 0) return false;

  return true;
}

function validatePlan(plan, totalFindings) {
  if (!plan || typeof plan !== 'object') return false;
  if (typeof plan.report_title !== 'string' || !plan.report_title.trim()) return false;
  if (typeof plan.executive_summary !== 'string' || !plan.executive_summary.trim()) return false;
  if (!Array.isArray(plan.categories) || plan.categories.length === 0) return false;

  const seenIds = new Set();
  let subtotalSumLow = 0;
  let subtotalSumHigh = 0;

  for (const cat of plan.categories) {
    if (typeof cat.header !== 'string' || !cat.header.trim()) return false;
    if (!Array.isArray(cat.finding_ids) || cat.finding_ids.length === 0) return false;
    for (const id of cat.finding_ids) {
      if (!Number.isInteger(id) || id < 1 || id > totalFindings) return false;
      if (seenIds.has(id)) return false;
      seenIds.add(id);
    }
    if (typeof cat.subtotal_low !== 'number' || typeof cat.subtotal_high !== 'number') return false;
    if (cat.subtotal_low < 0 || cat.subtotal_high < cat.subtotal_low) return false;
    subtotalSumLow  += cat.subtotal_low;
    subtotalSumHigh += cat.subtotal_high;
  }

  if (typeof plan.grand_total_low !== 'number' || typeof plan.grand_total_high !== 'number') return false;
  // Math slack scales with the total: small reports (4 findings, $500 total)
  // can have rounding errors of $50 that shouldn't fail validation. Large
  // reports stay at 5% which is tight enough to catch real math drift.
  // Floor of $500 ensures small-N reports are not unfairly rejected.
  const slack = Math.max(500, subtotalSumHigh * 0.05);
  if (Math.abs(plan.grand_total_low  - subtotalSumLow)  > slack) return false;
  if (Math.abs(plan.grand_total_high - subtotalSumHigh) > slack) return false;

  // The planner can now legitimately drop non-actionable findings (rule 2a),
  // so seenIds.size may be less than totalFindings. We only require that no
  // SAME finding id appear twice (already enforced above) and that at least
  // one finding survives.
  if (seenIds.size === 0) return false;

  return true;
}

// ── Pass 2: Prose rendering ──────────────────────────────────────────────────

function buildRenderingPrompt(plan, memoryResult, context = {}) {
  const { findings } = memoryResult;
  // Mirror Pass 1's cap so ids in the plan resolve to the same findings
  // here during prose rendering.
  const sortedAll = sortByseverity(findings);
  const sorted = capFindingsForPass2(sortedAll, MAX_FINDINGS_FOR_PASS_2, true);
  const rates = context.rates || { junior: 85, mid: 125, senior: 200 };
  const profile = context.profile || null;

  // Cap disclosure: when the original finding set was larger than the cap,
  // we tell the renderer to insert a one-line italic note immediately after
  // the H1. The post-render patcher injects it defensively if the model
  // skips the instruction.
  const capDisclosure = getCapDisclosure(sortedAll.length, MAX_FINDINGS_FOR_PASS_2);

  const findingsById = sorted.map((f, i) =>
    'FINDING #' + (i + 1) + ' [' + f.severity + '] — ' + f.title + '\n' +
    // Only emit a Files line if we actually have file paths. An empty
    // 'Files: ' line in the prompt empirically causes Pass 2 to fill it
    // with placeholder bold-markdown (`**Files:** **`), which the post-
    // render parser then captures as a literal '**' glob and the verifier
    // drops every finding. Better to give the model nothing than an empty
    // labeled field; with no Files line in the prompt, the model still
    // emits one in the rendered output drawn from the finding detail.
    ((f.files && f.files.length) ? 'Files: ' + f.files.join(', ') + '\n' : '') +
    'Detail: ' + f.detail + '\n' +
    'Confidence: ' + (f.confidence || 90) + '%'
  ).join('\n\n');

  const rawSection = context.rawSynthesis
    ? '\n\nRAW SYNTHESIS (primary source for prose — do not omit findings from it):\n' + context.rawSynthesis
    : '';

  const sourceGroundingSection = buildSourceGroundingBlock(findings, context.fileMap);
  const consultantLens = buildConsultantLens(profile);

  const planJson = JSON.stringify(plan, null, 2);

  const rateJuniorLine = DOLLAR + rates.junior + '/hr';
  const rateMidLine    = DOLLAR + rates.mid    + '/hr';
  const rateSeniorLine = DOLLAR + rates.senior + '/hr';

  const grandTotalLowDisplay  = DOLLAR + plan.grand_total_low.toLocaleString();
  const grandTotalHighDisplay = DOLLAR + plan.grand_total_high.toLocaleString();

  let totalFindingsCount = 0;
  for (const cat of plan.categories) totalFindingsCount += cat.finding_ids.length;

  return (profile
      ? 'You are rendering a pre-planned pre-engagement codebase analysis report as polished prose, on behalf of the consultant described in the CONSULTANT LENS below. Write in their voice. Do NOT identify yourself as Ghost Architect or mention Ghost in the prose; the deliverable is the consultant\'s.'
      : 'You are Ghost Architect, rendering a pre-planned codebase analysis report as polished prose.')
    + consultantLens + '\n\n'
    + 'The report structure has ALREADY BEEN DECIDED in the plan below. Your job is to render polished prose for each section. You MUST NOT reorganize the categories, reassign findings, add or remove categories, or change the totals. If the plan says a category contains findings [1, 3, 5], you render those three findings under that category header — no more, no fewer, no substitutions.\n\n'
    + (profile
        ? 'METADATA BLOCK — DO NOT WRITE ONE. The host application has already rendered a complete metadata table at the top of the document with the consultant name, methodology, project label, file count, and generation date. Do NOT repeat any of that information after the report H1. After the H1, the next thing must be the "## Executive Summary" header. Do NOT insert lines like "**Consultant:** ...", "**Engagement:** ...", "**Codebase:** ...", "**Files analyzed:** ...", or "**Analysis date:** ..." anywhere in the report. They are duplicates and the dates you would write are guesses.\n\n'
        : '')
    + 'COMPLETENESS CONTRACT: A post-processor validates that every finding id in the plan has a corresponding ### prose entry in your output. Any finding you skip will be detected and rendered separately, which wastes tokens and degrades report flow. RENDER EVERY FINDING. No editorial pruning, no "top N only", no skipping items you find redundant. The plan is the contract.\n\n'
    + 'REPORT PLAN (non-negotiable structure):\n' + planJson + '\n\n'
    + 'FULL FINDINGS DETAIL (use for prose; the plan tells you which go where):\n' + findingsById + '\n'
    + rawSection
    + sourceGroundingSection + '\n\n'
    + 'HOW TO RENDER:\n'
    + '1. Start with the report title from plan.report_title as an H1 (# header).\n'
    + (capDisclosure
        ? '1a. IMMEDIATELY after the H1 (and before the "## Executive Summary" header), insert exactly this italicized note on its own line, then a blank line:\n\n    '
          + capDisclosure + '\n\n   This is the SAVED-REPORT VERSION of the cap notice that streamed during analysis. Do not paraphrase it; copy it verbatim.\n'
        : '')
    + '2. Write an "## Executive Summary" section using the text from plan.executive_summary, lightly polished. Do not add math claims that are not in the summary already.\n'
    + '3. For each category in plan.categories, in the order given:\n'
    + '   a. Write a level-2 header (##) using the exact text of plan.categories[i].header.\n'
    + '   b. Under that header, render EVERY finding whose id appears in plan.categories[i].finding_ids — look up each one by id in the FULL FINDINGS DETAIL above. If the plan lists 9 ids, produce 9 ### entries.\n'
    + '   c. For each finding, produce a level-3 header (###) with the finding title (or a polished version of it), followed by Files, Severity, Effort, Complexity, Cost, a 2–3 sentence prose explanation, a "Why this matters" sentence, and a "Fix" block with 2–4 specific steps. Include a short before/after code example ONLY if the fix is a concise code change AND the source code is visible in the grounding block; otherwise skip the code block.\n'
    + '   d. EVERY ### finding MUST have NUMERIC Effort, Complexity, and Cost values — never "N/A", never "TBD", never blank, NEVER "' + DOLLAR + '0". Effort is a numeric hour range like "2–3 hours" or "4–6 hours" (or "0.5–1 hours" for very small fixes). Complexity is one of LOW, MEDIUM, HIGH, or "Requires architect". Cost is computed by STRICT TIER MAPPING from Complexity — there is no judgment involved:\n'
    + '         • LOW          → use ' + DOLLAR + rates.junior + '/hr (the junior rate)\n'
    + '         • MEDIUM       → use ' + DOLLAR + rates.mid    + '/hr (the mid rate)\n'
    + '         • HIGH / CRITICAL / Requires architect → use ' + DOLLAR + rates.senior + '/hr (the senior rate)\n'
    + '       Then Cost = Effort range × the matched rate. Compute the LOW end of the dollar range as (low effort × rate) and the HIGH end as (high effort × rate). Round to the nearest ' + DOLLAR + '5 if needed; do not round to the nearest ' + DOLLAR + '50 or ' + DOLLAR + '100 — keep the math honest.\n'
    + '       Worked examples using THESE rates (junior=' + DOLLAR + rates.junior + ', mid=' + DOLLAR + rates.mid + ', senior=' + DOLLAR + rates.senior + '):\n'
    + '         • 1–2 hours at LOW    = ' + DOLLAR + (rates.junior * 1) + '–' + DOLLAR + (rates.junior * 2) + '\n'
    + '         • 2–3 hours at LOW    = ' + DOLLAR + (rates.junior * 2) + '–' + DOLLAR + (rates.junior * 3) + '\n'
    + '         • 4–6 hours at MEDIUM = ' + DOLLAR + (rates.mid    * 4) + '–' + DOLLAR + (rates.mid    * 6) + '\n'
    + '         • 8–12 hours at HIGH  = ' + DOLLAR + (rates.senior * 8) + '–' + DOLLAR + (rates.senior * 12) + '\n'
    + '       Do NOT use any other rate. Do NOT use the senior rate for LOW or MEDIUM findings. Do NOT use the mid rate for HIGH findings. Do NOT round to a different rate. The Cost shown in the prose must EXACTLY equal Effort × the tier-matched rate above.\n'
    + '       For findings smaller than 1 hour, the floor is ' + DOLLAR + Math.round(rates.junior / 2) + '–' + DOLLAR + rates.junior + ' (half hour to one hour at the junior rate). "' + DOLLAR + '0" is never the right answer. If a finding feels too abstract for numeric estimates, it does NOT belong as a ### finding — it should be omitted from the rendered report.\n'
    + '   e. Never write a category header with no findings under it. The plan guarantees every category has at least one finding.\n'
    + '   f. ANTI-DUPLICATION: Each finding id appears in EXACTLY ONE category in the plan. Render each finding EXACTLY ONCE in prose, under the category whose finding_ids array contains its id. Do NOT render the same finding under multiple category headers. Do NOT write "(Duplicate Entry)" notes. Do NOT invent hybrid categories like "Red Flags / Fault Lines". One finding, one prose entry, one category.\n'
    + '4. Close with "## 📊 Remediation Summary":\n'
    + '   - State the billing rates: LOW = ' + rateJuniorLine + ' | MEDIUM = ' + rateMidLine + ' | HIGH / CRITICAL / Requires architect = ' + rateSeniorLine + '.\n'
    + '   - Render the remediation table with columns: Priority | Finding | Category | Effort | Complexity | Cost. Include every finding exactly once, in the order Priority 1..N where the priority reflects severity and business impact. Each row\'s Category column contains the SINGLE category name from the plan (no slashes, no hybrids).\n'
    + '   - Below the table, state: Total findings = ' + totalFindingsCount + ', Total effort = sum range, Total cost = ' + grandTotalLowDisplay + '–' + grandTotalHighDisplay + ' (these numbers come from the plan — use them EXACTLY).\n'
    + '5. Close with "## Risk if Left Unaddressed" — one paragraph.\n\n'
    + 'STRUCTURAL RULES:\n'
    + '- Use ONLY the categories in plan.categories. Do NOT invent new ones. If the plan has 2 categories, your report has 2 ## headers (plus Executive Summary, Remediation Summary, and Risk if Left Unaddressed). Do NOT add Ghost\'s canonical categories (Red Flags, Landmarks, Dead Zones, Fault Lines) unless they appear in plan.categories.\n'
    + '- Every category header you write MUST have at least one full finding entry beneath it before the next header appears.\n'
    + '- Table and prose must agree: every finding in the table appears as prose above, and every prose finding appears in the table.\n'
    + '- Do NOT reference findings by number in prose (no "see Finding #3").\n'
    + '- The grand total in the prose MUST match ' + grandTotalLowDisplay + '–' + grandTotalHighDisplay + ' exactly.\n\n'
    + 'GROUNDING RULES:\n'
    + '- Work only from the findings detail and source code provided. Do not invent method names, line numbers, or code patterns.\n'
    + '- Do NOT cite specific line numbers.\n'
    + '- If finding specifics do not match the source code, use general language rather than asserting with confidence.\n\n'
    + 'FILE CITATION RULES:\n'
    + '- Every finding must cite at least one real file path from the findings detail.\n'
    + '- Never write prose in a Files: line.\n\n'
    + 'Write the complete report now:';
}

// ── Blast Pass 2: Prose rendering ────────────────────────────────────────────
//
// Builds the rendering prompt for blast mode. Differences from POI:
//   - The structural template is Direct Dependencies / Ripple Effects /
//     Danger Zones / Safe Zones / Before You Touch It (driven by
//     plan.categories, not hardcoded), then a ## \ud83d\udee0\ufe0f Remediation Plan
//     paragraph (effort + complexity + risk + go/no-go), then the
//     ## \ud83d\udd04 Rollback Plan section rendered from plan.rollback_plan,
//     then ## \ud83d\udcca Remediation Summary table, then ## Risk if Left
//     Unaddressed.
//   - The renderer reads the rollback structure from the plan and emits it
//     as authored prose, not asking the model to invent it. This is what
//     guarantees the rollback section appears \u2014 it\u2019s pre-planned, not
//     hoped-for.

function buildBlastRenderingPrompt(plan, memoryResult, context = {}) {
  const { findings } = memoryResult;
  const sortedAll = sortByseverity(findings);
  const sorted = capFindingsForPass2(sortedAll, MAX_FINDINGS_FOR_PASS_2, true);
  const rates = context.rates || { junior: 85, mid: 125, senior: 200 };
  const profile = context.profile || null;

  // Cap disclosure: same logic as POI. When the original finding set
  // exceeded the cap, the saved report carries a one-line italic note
  // immediately after the H1 so the consultant opening the PDF later
  // sees what was rendered vs. what was surfaced.
  const capDisclosure = getCapDisclosure(sortedAll.length, MAX_FINDINGS_FOR_PASS_2);

  const findingsById = sorted.map((f, i) =>
    'FINDING #' + (i + 1) + ' [' + f.severity + '] — ' + f.title + '\n' +
    // Same defensive omission as the POI rendering prompt. An empty
    // Files line empirically causes Pass 2 to emit `**Files:** **` which
    // the parser captures as files: ['**'] and the verifier drops as
    // false-positive.
    ((f.files && f.files.length) ? 'Files: ' + f.files.join(', ') + '\n' : '') +
    'Detail: ' + f.detail + '\n' +
    'Confidence: ' + (f.confidence || 90) + '%'
  ).join('\n\n');

  const rawSection = context.rawSynthesis
    ? '\n\nRAW SYNTHESIS (primary source for prose \u2014 do not omit findings from it):\n' + context.rawSynthesis
    : '';

  const sourceGroundingSection = buildSourceGroundingBlock(findings, context.fileMap);
  const consultantLens = buildConsultantLens(profile);

  const planJson = JSON.stringify(plan, null, 2);

  const rateJuniorLine = DOLLAR + rates.junior + '/hr';
  const rateMidLine    = DOLLAR + rates.mid    + '/hr';
  const rateSeniorLine = DOLLAR + rates.senior + '/hr';

  const grandTotalLowDisplay  = DOLLAR + plan.grand_total_low.toLocaleString();
  const grandTotalHighDisplay = DOLLAR + plan.grand_total_high.toLocaleString();

  let totalFindingsCount = 0;
  for (const cat of plan.categories) totalFindingsCount += cat.finding_ids.length;

  return (profile
      ? 'You are rendering a pre-planned BLAST RADIUS analysis as polished prose, on behalf of the consultant described in the CONSULTANT LENS below. Write in their voice. Do NOT identify yourself as Ghost Architect or mention Ghost in the prose; the deliverable is the consultant\u2019s.'
      : 'You are Ghost Architect, rendering a pre-planned BLAST RADIUS analysis as polished prose.')
    + consultantLens + '\n\n'
    + 'The report structure has ALREADY BEEN DECIDED in the plan below, including the complete rollback plan. Your job is to render polished prose for each section. You MUST NOT reorganize the categories, reassign findings, change the totals, or alter the rollback plan content. The rollback plan in the plan is authoritative \u2014 render it verbatim with light prose polish; do NOT invent new rollback steps or omit subsections.\n\n'
    + (profile
        ? 'METADATA BLOCK \u2014 DO NOT WRITE ONE. The host application has already rendered a complete metadata table at the top of the document with the consultant name, methodology, project label, file count, and generation date. Do NOT repeat any of that information after the report H1. After the H1, the next thing must be the "## Executive Summary" header.\n\n'
        : '')
    + 'COMPLETENESS CONTRACT: A post-processor validates that every finding id in the plan has a corresponding ### prose entry. RENDER EVERY FINDING. The rollback plan must include every subsection from plan.rollback_plan. No editorial pruning.\n\n'
    + 'REPORT PLAN (non-negotiable structure):\n' + planJson + '\n\n'
    + 'FULL FINDINGS DETAIL (use for prose; the plan tells you which go where):\n' + findingsById + '\n'
    + rawSection
    + sourceGroundingSection + '\n\n'
    + 'HOW TO RENDER:\n'
    + '1. Start with the report title from plan.report_title as an H1 (# header).\n'
    + (capDisclosure
        ? '1a. IMMEDIATELY after the H1 (and before the "## Executive Summary" header), insert exactly this italicized note on its own line, then a blank line:\n\n    '
          + capDisclosure + '\n\n   This is the SAVED-REPORT VERSION of the cap notice that streamed during analysis. Do not paraphrase it; copy it verbatim.\n'
        : '')
    + '2. Write an "## Executive Summary" section using the text from plan.executive_summary, lightly polished. Frame the change set\u2019s impact (not POI-style debt language). Do not add math claims that are not in the summary already.\n'
    + '3. For each category in plan.categories, in the order given:\n'
    + '   a. Write a level-2 header (##) using the exact text of plan.categories[i].header.\n'
    + '   b. Under that header, render EVERY finding whose id appears in plan.categories[i].finding_ids \u2014 look up each one by id in the FULL FINDINGS DETAIL above. If the plan lists 9 ids, produce 9 ### entries.\n'
    + '   c. For each finding, produce a level-3 header (###) with the finding title (or a polished version), followed by Files, Severity, Effort, Complexity, Cost, a 2\u20133 sentence prose explanation of the IMPACT (what this means for the change set, what breaks, what cascades), a "Why this matters" sentence framed in change-set terms, and a "Fix" block with 2\u20134 specific steps.\n'
    + '   d. EVERY ### finding MUST have NUMERIC Effort, Complexity, and Cost values \u2014 never "N/A", never "TBD", never blank, NEVER "' + DOLLAR + '0". Effort is a numeric hour range like "2\u20133 hours". Complexity is one of LOW, MEDIUM, HIGH, or "Requires architect". Cost is a dollar range computed as effort \u00d7 hourly rate, with a minimum of "' + DOLLAR + '40\u2013' + DOLLAR + '85".\n'
    + '   e. Never write a category header with no findings under it.\n'
    + '   f. ANTI-DUPLICATION: each finding id appears in exactly one category. Render each finding exactly once.\n'
    + '4. After all category sections, write "## \ud83d\udee0\ufe0f Remediation Plan" \u2014 a 2\u20133 paragraph synthesis covering: estimated total effort to make the change safely (use the grand total range), complexity (Low / Medium / High / Requires architect), risk level (LOW / MEDIUM / HIGH / CRITICAL), recommended sequence of steps to ship the change safely, and a clear Go / No-Go recommendation. This is the \u201cif you do this, here\u2019s how\u201d section \u2014 forward-looking, not the rollback.\n'
    + '5. Then write "## \ud83d\udd04 Rollback Plan" using plan.rollback_plan as the source. The structure is:\n'
    + '   a. "### Pre-Change Snapshot" \u2014 a bulleted list rendered from rollback_plan.pre_change_snapshot. Each item is a specific file/value/state that exists today and will be modified.\n'
    + '   b. "### Rollback Steps" \u2014 a numbered list rendered from rollback_plan.rollback_steps. Each step shows the action and the estimated time inline (e.g. "1. Revert SettingsService.ts to commit abc123 \u2014 Est. 2 minutes").\n'
    + '   c. A line each for: "**Total Rollback Time:** ..." (from rollback_plan.total_rollback_time), "**Rollback Complexity:** ..." (from rollback_plan.rollback_complexity), "**Rollback Risk:** ..." (from rollback_plan.rollback_risk).\n'
    + '   d. "### Point of No Return" \u2014 a paragraph using rollback_plan.point_of_no_return.trigger and additional_steps_required.\n'
    + '   e. "### Who to Notify on Rollback" \u2014 a bulleted list from rollback_plan.who_to_notify, each item formatted as "- **{role}** \u2014 {reason}".\n'
    + '   f. "### Smoke Test After Rollback" \u2014 a numbered list from rollback_plan.smoke_test.\n'
    + '   Render the rollback section in this order, with these subheaders. Do NOT skip subsections. Do NOT invent extra ones.\n'
    + '6. Then write "## \ud83d\udcca Remediation Summary":\n'
    + '   - State the billing rates: LOW = ' + rateJuniorLine + ' | MEDIUM = ' + rateMidLine + ' | HIGH / CRITICAL / Requires architect = ' + rateSeniorLine + '.\n'
    + '   - Render the remediation table with columns: Priority | Finding | Category | Effort | Complexity | Cost. Include every finding exactly once, in the order Priority 1..N where the priority reflects severity and impact on the change set. Each row\u2019s Category column contains the SINGLE category name from the plan (no slashes, no hybrids).\n'
    + '   - Below the table, state: Total findings = ' + totalFindingsCount + ', Total effort = sum range, Total cost = ' + grandTotalLowDisplay + '\u2013' + grandTotalHighDisplay + ' (these numbers come from the plan \u2014 use them EXACTLY).\n'
    + '7. Close with "## Risk if Left Unaddressed" \u2014 one paragraph framed in change-set terms (\u201cif you ship this change without addressing X, Y will happen\u201d).\n\n'
    + 'STRUCTURAL RULES:\n'
    + '- Use ONLY the categories in plan.categories. Do NOT use POI categories (Red Flags / Landmarks / Dead Zones / Fault Lines). Do NOT invent new ones.\n'
    + '- Every category header you write MUST have at least one full finding entry beneath it before the next header appears.\n'
    + '- The Rollback Plan section is REQUIRED. It must appear after Remediation Plan and before Remediation Summary.\n'
    + '- Table and prose must agree: every finding in the table appears as prose above, and every prose finding appears in the table.\n'
    + '- Do NOT reference findings by number in prose (no "see Finding #3").\n'
    + '- The grand total in the prose MUST match ' + grandTotalLowDisplay + '\u2013' + grandTotalHighDisplay + ' exactly.\n\n'
    + 'GROUNDING RULES:\n'
    + '- Work only from the findings detail and source code provided. Do not invent method names, line numbers, or code patterns.\n'
    + '- Do NOT cite specific line numbers.\n'
    + '- Rollback plan steps must be specific to the actual change set \u2014 never generic advice like "revert your commit". Every step names a real file or behavior.\n\n'
    + 'FILE CITATION RULES:\n'
    + '- Every finding must cite at least one real file path from the findings detail.\n'
    + '- Never write prose in a Files: line.\n\n'
    + 'Write the complete report now:';
}

async function renderBlastReportFromPlan(plan, memoryResult, context = {}, onChunk = () => {}) {
  const anthropic = getClient();
  const prompt    = buildBlastRenderingPrompt(plan, memoryResult, context);
  let   report    = '';

  const stream = anthropic.messages.stream({
    model:      getModel(),
    max_tokens: 16000,
    temperature: 0.3,
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

async function renderReportFromPlan(plan, memoryResult, context = {}, onChunk = () => {}) {
  // Mode router: blast reports use a different rendering prompt that
  // includes the rollback plan template. POI uses the existing prompt
  // unchanged.
  if (isBlastMode(context)) {
    return renderBlastReportFromPlan(plan, memoryResult, context, onChunk);
  }

  const anthropic = getClient();
  const prompt    = buildRenderingPrompt(plan, memoryResult, context);
  let   report    = '';

  const stream = anthropic.messages.stream({
    model:      getModel(),
    max_tokens: 16000,
    temperature: 0.3,
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

// ── Pass 2.5: Completeness validator + repair ────────────────────────────────
//
// Pass 2 sometimes renders a subset of the plan's findings under token
// pressure. We detect this after the fact: for each finding in the plan,
// check whether a matching ### header exists in the rendered report. For
// each missing finding, render a targeted prose entry and splice it into
// the correct category section before the next ## header.

function normalizeTitle(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRenderedFindingTitles(report) {
  const titles = [];
  const lines = report.split('\n');
  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) titles.push(normalizeTitle(m[1]));
  }
  return titles;
}

function findingIsRendered(finding, renderedTitles) {
  const wanted = normalizeTitle(finding.title);
  if (!wanted) return true;
  for (const t of renderedTitles) {
    if (t === wanted) return true;
    if (t.includes(wanted) && wanted.length > 10) return true;
    if (wanted.includes(t) && t.length > 10) return true;
  }
  return false;
}

async function renderSingleFinding(finding, categoryHeader, rates, profile) {
  const anthropic = getClient();
  const rateJuniorLine = DOLLAR + rates.junior + '/hr';
  const rateMidLine    = DOLLAR + rates.mid    + '/hr';
  const rateSeniorLine = DOLLAR + rates.senior + '/hr';

  const consultantLens = buildConsultantLens(profile);

  const prompt =
    (profile
      ? 'You are writing prose for a single finding in a pre-engagement codebase analysis report on behalf of the consultant described in the CONSULTANT LENS below. The category this finding belongs to has already been decided. Do NOT identify yourself as Ghost Architect or mention Ghost in the prose.'
      : 'You are Ghost Architect, writing prose for a single finding in a codebase analysis report. The category this finding belongs to has already been decided.')
    + consultantLens + '\n\n'
    + 'CATEGORY: ' + categoryHeader + '\n\n'
    + 'FINDING:\n'
    + 'Title: ' + finding.title + '\n'
    + 'Severity: ' + finding.severity + '\n'
    // Same defensive omission as the main rendering prompt: don't emit an
    // empty 'Files: ' line that the model fills with placeholder bold.
    + ((finding.files && finding.files.length) ? 'Files: ' + finding.files.join(', ') + '\n' : '')
    + 'Detail: ' + (finding.detail || '') + '\n\n'
    + 'BILLING RATES (STRICT TIER MAPPING — no judgment): LOW → ' + rateJuniorLine + ', MEDIUM → ' + rateMidLine + ', HIGH/CRITICAL → ' + rateSeniorLine + '. Cost = Effort × the rate matched to Complexity. Examples using THESE rates: 1–2 hours at LOW = ' + DOLLAR + (rates.junior * 1) + '–' + DOLLAR + (rates.junior * 2) + '. 4–6 hours at MEDIUM = ' + DOLLAR + (rates.mid * 4) + '–' + DOLLAR + (rates.mid * 6) + '. 8–12 hours at HIGH = ' + DOLLAR + (rates.senior * 8) + '–' + DOLLAR + (rates.senior * 12) + '. Sub-hour floor is ' + DOLLAR + Math.round(rates.junior / 2) + '–' + DOLLAR + rates.junior + '. Do NOT use the senior rate for LOW or MEDIUM findings.\n\n'
    + 'Write ONLY the prose entry for this single finding. Output format (using the exact markdown shown, including the triple-hash header):\n\n'
    + '### Finding title, polished\n'
    + '**Files:** <file paths from above>\n'
    + '**Severity:** <severity with emoji if appropriate>\n'
    + '**Effort:** <N–M hours>  **Complexity:** <LOW/MEDIUM/HIGH>  **Cost:** <Effort × tier-matched rate, e.g. 2–3 hours at LOW = ' + DOLLAR + (rates.junior * 2) + '–' + DOLLAR + (rates.junior * 3) + '>\n\n'
    + '<2–3 sentence explanation>\n\n'
    + '**Why this matters:** <one or two sentences>\n\n'
    + '**Fix:**\n'
    + '1. <step>\n'
    + '2. <step>\n'
    + '3. <step>\n\n'
    + 'RULES:\n'
    + '- Start directly with the ### line. Do NOT write ## or # headers.\n'
    + '- Do NOT include the category header (it is already in the report).\n'
    + '- Do NOT cite line numbers.\n'
    + '- Do NOT write "(Duplicate Entry)" or parenthetical placement notes.\n'
    + '- Do NOT reference other findings by number.\n'
    + '- End after the Fix steps. No further commentary.\n\n'
    + 'Write the entry now:';

  try {
    const response = await anthropic.messages.create({
      model: getModel(),
      max_tokens: 800,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (response.content[0]?.text || '').trim();
    const idx = text.indexOf('###');
    if (idx < 0) return null;
    return text.slice(idx);
  } catch {
    return null;
  }
}

function escapeRegex(s) {
  // Escape all regex metacharacters. We avoid the special-replacement
  // pattern $& by passing a function to replace() instead of a string.
  return s.replace(/[.*+?^{}()|[\]\\]/g, function (m) { return '\\' + m; });
}

function spliceIntoSection(report, sectionStartIdx, proseToInsert) {
  const afterCurrentHeader = report.indexOf('\n', sectionStartIdx);
  if (afterCurrentHeader < 0) {
    return report + '\n\n' + proseToInsert + '\n';
  }
  const nextH2Re = /\n##\s/g;
  nextH2Re.lastIndex = afterCurrentHeader + 1;
  const next = nextH2Re.exec(report);
  const insertAt = next ? next.index : report.length;
  const before = report.slice(0, insertAt);
  const after  = report.slice(insertAt);
  const sep = before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
  return before + sep + proseToInsert + '\n\n' + after;
}

async function validateAndPatchProse(report, plan, memoryResult, context) {
  // Must use the SAME cap as Pass 1 so finding ids in the plan align
  // with the findingById map. Without this, the patcher looks up id 1..N
  // against the full finding list but the plan was built from the
  // top-25, and every cross-reference gets the wrong finding.
  const sortedAll = sortByseverity(memoryResult.findings || []);
  const sorted = capFindingsForPass2(sortedAll, MAX_FINDINGS_FOR_PASS_2, true);
  const findingById = new Map();
  sorted.forEach((f, i) => findingById.set(i + 1, f));

  // Defensive injection: if the cap fired and the rendered report does
  // not contain the disclosure note, splice it in immediately after the
  // H1 line. Pass 2 is instructed to render this verbatim, but the model
  // sometimes skips it under token pressure or when consultant lens
  // instructions compete for attention. A consultant opening the PDF
  // must always see how many findings were dropped.
  let workingReport = report;
  const capDisclosure = getCapDisclosure(sortedAll.length, MAX_FINDINGS_FOR_PASS_2);
  if (capDisclosure) {
    // Detect the disclosure by its lead-in phrase ("N findings surfaced")
    // rather than exact-matching the whole sentence — the model occasionally
    // adds bold or rewords slightly. Match the cap-fired count, not the cap.
    const expectedCount = sortedAll.length;
    const presenceRegex = new RegExp(expectedCount + '\\s+findings\\s+surfaced', 'i');
    if (!presenceRegex.test(workingReport)) {
      // Find the first H1 line and splice the disclosure immediately after it.
      const h1Match = workingReport.match(/^#\s+.+$/m);
      if (h1Match) {
        const h1End = workingReport.indexOf('\n', h1Match.index) + 1;
        const before = workingReport.slice(0, h1End);
        const after  = workingReport.slice(h1End);
        workingReport = before + '\n' + capDisclosure + '\n' + after;
      } else {
        // No H1 found (unusual). Prepend the disclosure so it still appears.
        workingReport = capDisclosure + '\n\n' + workingReport;
      }
    }
  }

  const renderedTitles = extractRenderedFindingTitles(workingReport);

  const missingByCategory = new Map();
  for (const cat of plan.categories) {
    for (const id of cat.finding_ids) {
      const f = findingById.get(id);
      if (!f) continue;
      if (findingIsRendered(f, renderedTitles)) continue;
      if (!missingByCategory.has(cat.header)) missingByCategory.set(cat.header, []);
      missingByCategory.get(cat.header).push(f);
    }
  }

  // Debug log — written to .debug/ in reports dir so we can diagnose
  // patcher behavior without cluttering user-facing output.
  writePatcherDebugLog(plan, renderedTitles, missingByCategory, workingReport);

  if (missingByCategory.size === 0) {
    // Even when nothing is missing, scrub empty category headers before
    // returning (Pass 2 occasionally writes a ## header with no body).
    return scrubEmptyHeaders(workingReport);
  }

  const rates = context.rates || { junior: 85, mid: 125, senior: 200 };
  const profile = context.profile || null;

  let patched = workingReport;

  for (const [categoryHeader, missingFindings] of missingByCategory) {
    const prose = await Promise.all(
      missingFindings.map(f => renderSingleFinding(f, categoryHeader, rates, profile))
    );
    const joined = prose.filter(p => p && p.trim()).join('\n\n\n');
    if (!joined) {
      writePatcherDebugLog_append('All renderSingleFinding calls returned null for category: ' + categoryHeader);
      continue;
    }

    let headerIdx = patched.indexOf('## ' + categoryHeader);
    if (headerIdx < 0) {
      const re = new RegExp('^##\\s+' + escapeRegex(categoryHeader).replace(/\s+/g, '\\s+'), 'mi');
      const m = re.exec(patched);
      if (!m) {
        writePatcherDebugLog_append('Could not locate category header in report: ' + categoryHeader);
        continue;
      }
      headerIdx = m.index;
    }
    patched = spliceIntoSection(patched, headerIdx, joined);
    writePatcherDebugLog_append('Spliced ' + missingFindings.length + ' findings into: ' + categoryHeader);
  }

  // Final pass: remove any category headers that ended up with no
  // content beneath them (either because the patcher could not fill
  // them, or because Pass 2 never had findings for them despite the
  // plan listing some).
  return scrubEmptyHeaders(patched);
}

/**
 * Walk through the report and remove any ## section header that is
 * immediately followed by another ## header (no prose, no ### entries
 * between them). Preserves the remediation summary and other sections
 * that have real content.
 *
 * This is a safety net for when Pass 2 writes structure it does not
 * fill in. A missing finding in the table is forgivable; an empty
 * section header looks broken.
 */
export function scrubEmptyHeaders(report) {
  const lines = report.split('\n');
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Is this a ## heading?
    const isH2 = /^##\s+/.test(line) && !/^###/.test(line);
    if (!isH2) {
      kept.push(line);
      i++;
      continue;
    }
    // Look ahead for content. "Content" means any non-blank, non-hr line
    // that is not another ## header. If we find content before the next
    // ## header, the current header stays.
    let j = i + 1;
    let foundContent = false;
    while (j < lines.length) {
      const next = lines[j];
      if (/^##\s+/.test(next) && !/^###/.test(next)) break; // next ## — stop
      const trimmed = next.trim();
      if (trimmed !== '' && trimmed !== '---') { foundContent = true; break; }
      j++;
    }
    if (foundContent) {
      kept.push(line);
      i++;
    } else {
      // Drop this header and any blank/hr lines up to the next ## or EOF.
      i = j;
    }
  }
  return kept.join('\n');
}

// Lightweight debug log written to the reports directory when the
// patcher runs. Never throws — all fs ops are best-effort.
function writePatcherDebugLog(plan, renderedTitles, missingByCategory, report) {
  try {
    const debugDir = path.join(os.homedir(), 'Ghost Architect Reports', '.debug');
    fs.mkdirSync(debugDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(debugDir, 'narrator-patcher-' + ts + '.txt');
    const missingEntries = [];
    for (const [cat, findings] of missingByCategory) {
      missingEntries.push('  [' + cat + ']: ' + findings.map(f => f.title).join(' | '));
    }
    const planSummary = plan.categories.map(c =>
      '  ' + c.header + ' -> ids [' + c.finding_ids.join(',') + ']'
    ).join('\n');
    const content =
      '=== Narrator Patcher Debug ===\n' +
      'Timestamp: ' + new Date().toISOString() + '\n\n' +
      'PLAN CATEGORIES:\n' + planSummary + '\n\n' +
      'RENDERED TITLES (' + renderedTitles.length + '):\n' +
      renderedTitles.map(t => '  ' + t).join('\n') + '\n\n' +
      'MISSING BY CATEGORY (' + missingByCategory.size + ' categories with missing findings):\n' +
      (missingEntries.length ? missingEntries.join('\n') : '  (none — all findings rendered)') + '\n\n' +
      'REPORT LENGTH: ' + report.length + ' chars\n' +
      'REPORT HEAD (first 400 chars):\n' + report.slice(0, 400) + '\n';
    fs.writeFileSync(logPath, content);
    // Stash the path so the append function can add to it.
    global.__ghostPatcherLogPath = logPath;
  } catch { /* non-fatal */ }
}

function writePatcherDebugLog_append(line) {
  try {
    const logPath = global.__ghostPatcherLogPath;
    if (!logPath) return;
    fs.appendFileSync(logPath, '\n' + line);
  } catch { /* non-fatal */ }
}

// ── Legacy single-pass prompt (fallback when Pass 1 fails) ───────────────────

// ── Blast legacy fallback ────────────────────────────────────────────────────
//
// Used when blast Pass 1 (planBlastReport) fails to produce valid JSON. We
// can\u2019t fall back to the POI legacy prompt because that emits the wrong
// category structure and no rollback section. This prompt asks for the
// blast-specific structure in a single pass without the planner\u2019s
// scaffolding \u2014 less reliable than the planned path, but better than the
// POI fallback for blast-mode inputs.

function buildBlastLegacyPrompt(memoryResult, context = {}) {
  const { findings, filesAnalyzed, stepCount } = memoryResult;
  const sorted = sortByseverity(findings);
  const rates = context.rates || { junior: 85, mid: 125, senior: 200 };
  const profile = context.profile || null;

  const findingsList = sorted.map((f, i) =>
    'Finding ' + (i + 1) + ' [' + f.severity + '] — ' + f.title + '\n' +
    // Defensive omission: empty Files line causes Pass 2 to emit
    // placeholder bold that breaks downstream finding extraction.
    ((f.files && f.files.length) ? 'Files: ' + f.files.join(', ') + '\n' : '') +
    'Detail: ' + f.detail + '\n' +
    'Confidence: ' + (f.confidence || 90) + '%'
  ).join('\n\n');

  const rawSection = context.rawSynthesis
    ? '\n\nRAW SYNTHESIS:\n' + context.rawSynthesis
    : '';

  const sourceGroundingSection = buildSourceGroundingBlock(findings, context.fileMap);
  const consultantLens = buildConsultantLens(profile);

  const rateJuniorLine = DOLLAR + rates.junior + '/hr';
  const rateMidLine    = DOLLAR + rates.mid    + '/hr';
  const rateSeniorLine = DOLLAR + rates.senior + '/hr';

  const analysisLine = '- Files analyzed: ' + filesAnalyzed + '\n'
    + '- Steps taken: ' + stepCount + '\n'
    + '- Findings: ' + (memoryResult.findingCount || findings.length) + '\n'
    + (context.projectLabel ? '- Change target: ' + context.projectLabel + '\n' : '')
    + '- Mode: blast radius\n';

  return (profile
      ? 'You are writing a pre-engagement BLAST RADIUS analysis as a senior architect, on behalf of the consultant described in the CONSULTANT LENS below. Write in their voice. Do NOT identify yourself as Ghost Architect or mention Ghost in the prose.'
      : 'You are Ghost Architect, writing a BLAST RADIUS analysis as a senior architect.')
    + consultantLens + '\n\n'
    + 'ANALYSIS:\n' + analysisLine
    + rawSection
    + sourceGroundingSection + '\n\n'
    + 'CONFIRMED FINDINGS:\n' + (findingsList || 'No findings confirmed.') + '\n\n'
    + 'WRITE THE REPORT in this exact structure:\n'
    + '1. # H1 title (e.g. "Blast Radius Analysis: <change target>").\n'
    + '2. ## Executive Summary \u2014 one paragraph framing the change set\u2019s impact.\n'
    + '3. Group findings into BLAST RADIUS categories (NOT POI categories): \ud83d\udca5 Direct Dependencies, \ud83c\udf0a Ripple Effects, \ud83e\udde8 Danger Zones, \u2705 Safe Zones, \u26a0\ufe0f Before You Touch It. Use only the categories that have findings; skip empty ones. Do NOT use Red Flags / Landmarks / Dead Zones / Fault Lines \u2014 those are POI categories.\n'
    + '4. For each finding: Files, Severity, Effort, Complexity, Cost, 2\u20133 sentence impact explanation, why-it-matters, fix steps.\n'
    + '5. ## \ud83d\udee0\ufe0f Remediation Plan \u2014 estimated effort, complexity, risk level, recommended approach, go/no-go.\n'
    + '6. ## \ud83d\udd04 Rollback Plan \u2014 REQUIRED. Subsections: ### Pre-Change Snapshot (bulleted list of current state), ### Rollback Steps (numbered with time estimates), then **Total Rollback Time:**, **Rollback Complexity:**, **Rollback Risk:**, ### Point of No Return (paragraph), ### Who to Notify on Rollback (bulleted list with role and reason), ### Smoke Test After Rollback (numbered list of 3\u20135 verifications). Every step must reference real files or behaviors from the findings.\n'
    + '7. ## \ud83d\udcca Remediation Summary \u2014 table with columns Priority | Finding | Category | Effort | Complexity | Cost. Then totals.\n'
    + '8. ## Risk if Left Unaddressed \u2014 one paragraph framed as change-set risk.\n\n'
    + 'BILLING: LOW = ' + rateJuniorLine + ' | MEDIUM = ' + rateMidLine + ' | HIGH/CRITICAL = ' + rateSeniorLine + '\n'
    + 'Do NOT reference findings by number. Do NOT cite line numbers. File citations must use real paths.\n\n'
    + 'Write the complete report now:';
}

async function renderBlastLegacySinglePass(memoryResult, context = {}, onChunk = () => {}) {
  const anthropic = getClient();
  const prompt    = buildBlastLegacyPrompt(memoryResult, context);
  let   report    = '';

  const stream = anthropic.messages.stream({
    model:      getModel(),
    max_tokens: 16000,
    temperature: 0.3,
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

function buildLegacyPrompt(memoryResult, context = {}) {
  const { findings, filesAnalyzed, stepCount } = memoryResult;
  const sorted = sortByseverity(findings);
  const rates = context.rates || { junior: 85, mid: 125, senior: 200 };
  const profile = context.profile || null;

  const findingsList = sorted.map((f, i) =>
    'Finding ' + (i + 1) + ' [' + f.severity + '] — ' + f.title + '\n' +
    // Defensive omission: empty Files line causes Pass 2 to emit
    // placeholder bold that breaks downstream finding extraction.
    ((f.files && f.files.length) ? 'Files: ' + f.files.join(', ') + '\n' : '') +
    'Detail: ' + f.detail + '\n' +
    'Confidence: ' + (f.confidence || 90) + '%'
  ).join('\n\n');

  const rawSection = context.rawSynthesis
    ? '\n\nRAW SYNTHESIS:\n' + context.rawSynthesis
    : '';

  const sourceGroundingSection = buildSourceGroundingBlock(findings, context.fileMap);
  const consultantLens = buildConsultantLens(profile);

  const tableRequirement = context.requireRemediationTable
    ? '\n\nCRITICAL: Include a complete REMEDIATION SUMMARY table with columns Priority | Finding | Category | Effort | Complexity | Cost.'
    : '';

  const rateJuniorLine = DOLLAR + rates.junior + '/hr';
  const rateMidLine    = DOLLAR + rates.mid    + '/hr';
  const rateSeniorLine = DOLLAR + rates.senior + '/hr';

  const analysisLine = '- Files analyzed: ' + filesAnalyzed + '\n'
    + '- Steps taken: ' + stepCount + '\n'
    + '- Findings: ' + (memoryResult.findingCount || findings.length) + '\n'
    + (context.projectLabel ? '- Project: ' + context.projectLabel + '\n' : '')
    + (context.mode ? '- Mode: ' + context.mode + '\n' : '');

  return (profile
      ? 'You are writing a pre-engagement codebase analysis report as a senior architect, on behalf of the consultant described in the CONSULTANT LENS below. Write in their voice. Do NOT identify yourself as Ghost Architect or mention Ghost in the prose; the deliverable is the consultant\'s.'
      : 'You are Ghost Architect, writing a codebase analysis report as a senior architect.')
    + consultantLens + '\n\n'
    + 'ANALYSIS:\n' + analysisLine
    + rawSection
    + sourceGroundingSection + '\n\n'
    + 'CONFIRMED FINDINGS:\n' + (findingsList || 'No findings confirmed.') + '\n\n'
    + 'WRITE THE REPORT:\n'
    + '- One-paragraph executive summary naming the most critical issue\n'
    + '- Group findings thematically into 3–6 categories (use Ghost\'s four canonical categories 🔴 Red Flags / 🏛️ Landmarks / ⚰️ Dead Zones / ⚡ Fault Lines by default; a consultant profile may replace these)\n'
    + '- Every category header MUST have at least one full finding below it — if a category would be empty, do not write its header\n'
    + '- For each finding: Files, Severity, Effort, Complexity, Cost, a 2–3 sentence explanation, why it matters, fix steps\n'
    + '- Close with REMEDIATION SUMMARY table (Priority | Finding | Category | Effort | Complexity | Cost), then totals, then risk-if-unaddressed paragraph'
    + tableRequirement + '\n'
    + '- Billing: LOW = ' + rateJuniorLine + ' | MEDIUM = ' + rateMidLine + ' | HIGH/CRITICAL = ' + rateSeniorLine + '\n'
    + '- Do NOT reference findings by number (no "see Finding #3")\n'
    + '- Do NOT cite line numbers or invent method names\n'
    + '- File citations must use real paths from the findings\n\n'
    + 'Write the complete report now:';
}

async function renderLegacySinglePass(memoryResult, context = {}, onChunk = () => {}) {
  const anthropic = getClient();
  const prompt    = buildLegacyPrompt(memoryResult, context);
  let   report    = '';

  const stream = anthropic.messages.stream({
    model:      getModel(),
    max_tokens: 16000,
    temperature: 0.3,
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

// ── Public entry points ──────────────────────────────────────────────────────

export async function narrateReport(memoryResult, context = {}, onChunk = () => {}) {
  // Mode-aware planning. Both planners share the same return contract
  // (a plan object with categories, finding ids, totals; blast plans add
  // a rollback_plan field). The renderer is also mode-aware via
  // renderReportFromPlan\u2019s internal router. Patcher and scrubber are
  // mode-blind \u2014 they operate on category headers and ### entries the
  // same way regardless of which planner produced them.
  const plan = await planReportStructure(memoryResult, context);

  if (plan) {
    try {
      const report = await renderReportFromPlan(plan, memoryResult, context, onChunk);
      try {
        return await validateAndPatchProse(report, plan, memoryResult, context);
      } catch {
        // Patcher threw \u2014 still scrub empty headers as a defense-in-depth
        // safety net before returning the un-patched report.
        return scrubEmptyHeaders(report);
      }
    } catch {
      // Pass 2 failure \u2014 fall through to legacy path
    }
  }

  // Legacy fallback \u2014 mode-aware. Blast inputs go through the blast
  // legacy prompt (preserves blast structure + rollback section). POI
  // inputs go through the POI legacy prompt unchanged.
  const legacyReport = isBlastMode(context)
    ? await renderBlastLegacySinglePass(memoryResult, context, onChunk)
    : await renderLegacySinglePass(memoryResult, context, onChunk);
  return scrubEmptyHeaders(legacyReport);
}

export async function narrateReportSync(memoryResult, context = {}) {
  const plan = await planReportStructure(memoryResult, context);

  const anthropic = getClient();
  // Mode-aware prompt selection mirrors narrateReport\u2019s router.
  const prompt = plan
    ? (isBlastMode(context)
        ? buildBlastRenderingPrompt(plan, memoryResult, context)
        : buildRenderingPrompt(plan, memoryResult, context))
    : (isBlastMode(context)
        ? buildBlastLegacyPrompt(memoryResult, context)
        : buildLegacyPrompt(memoryResult, context));

  const response = await anthropic.messages.create({
    model:      getModel(),
    max_tokens: 16000,
    temperature: 0.3,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.text || '';

  if (plan) {
    try {
      return await validateAndPatchProse(text, plan, memoryResult, context);
    } catch {
      return scrubEmptyHeaders(text);
    }
  }
  return scrubEmptyHeaders(text);
}

// ── Executive summary only ────────────────────────────────────────────────────

export async function narrateExecutiveSummary(memoryResult, context = {}) {
  const anthropic = getClient();
  const sorted    = sortByseverity(memoryResult.findings || []);
  const top3      = sorted.slice(0, 3).map(f => '[' + f.severity + '] ' + f.title).join(', ');

  const prompt =
    'In 2-3 sentences, summarize the key findings from this codebase analysis.\n\n'
    + 'Files analyzed: ' + memoryResult.filesAnalyzed + '\n'
    + 'Total findings: ' + memoryResult.findingCount + '\n'
    + 'Top issues: ' + (top3 || 'none') + '\n'
    + 'Project: ' + (context.projectLabel || 'unknown') + '\n\n'
    + 'Write a direct, plain-English summary a project manager would understand:';

  const response = await anthropic.messages.create({
    model:      getModel(),
    max_tokens: 300,
    messages:   [{ role: 'user', content: prompt }],
  });

  return response.content[0]?.text || '';
}

// ── Conflict-specific narrative ───────────────────────────────────────────────
//
// Single-pass narrator (no Pass 1/Pass 2 split) for Conflict Detection. The
// verifier already produced structured candidates; this function turns them
// into a polished report.
//
// Profile awareness: when context.profile is present, we inject the
// consultant lens (same buildConsultantLens helper used by POI and Blast)
// and switch identity language so the report reads as the consultant's
// deliverable rather than Ghost's. Branding chrome (cover, headers, footer)
// is handled downstream by saveReport via meta.profile — the narrator just
// needs to keep the prose consistent with that branding.

export async function narrateConflictReport(verificationResult, context = {}, onChunk = () => {}) {
  const anthropic = getClient();

  const { confirmed, possible, insufficient, stats } = verificationResult;

  const confirmedList = confirmed.map(c =>
    'CONFIRMED [' + (c.severity || 'HIGH') + ']: ' + (c.title || c.description) + '\n' +
    'Files: ' + (c.files || []).join(', ') + '\n' +
    'Evidence: ' + c.evidence
  ).join('\n\n');

  const possibleList = possible.map(c =>
    'POSSIBLE [' + (c.severity || 'MEDIUM') + ']: ' + (c.title || c.description) + '\n' +
    'Files: ' + (c.files || []).join(', ') + '\n' +
    'Evidence: ' + c.evidence
  ).join('\n\n');

  const insufficientList = (insufficient || []).slice(0, 20).map(c =>
    'INCONCLUSIVE [' + (c.severity || 'MEDIUM') + ']: ' + (c.title || c.description) + '\n' +
    'Files: ' + (c.files || []).join(', ')
  ).join('\n\n');

  const allInconclusive = stats.confirmed === 0 && stats.possible === 0 && (insufficient || []).length > 0;

  const rates = context.rates || { junior: 85, mid: 125, senior: 200 };
  const profile = context.profile || null;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const consultantLens = buildConsultantLens(profile);

  const prompt =
    (profile
      ? 'Write a Conflict Detection report as a senior architect, on behalf of the consultant described in the CONSULTANT LENS below. Write in their voice. Do NOT identify yourself as Ghost Architect or mention Ghost in the prose; the deliverable is the consultant\'s.'
      : 'Write a Ghost Architect Conflict Detection report as a senior architect.')
    + consultantLens + '\n\n'
    + 'Today\'s date is ' + today + '. Use this as the Report Date in the report header.\n\n'
    + 'VERIFICATION STATS:\n'
    + '- Candidates analyzed: ' + stats.total + '\n'
    + '- Confirmed conflicts: ' + stats.confirmed + '\n'
    + '- Possible conflicts: ' + stats.possible + '\n'
    + '- False positives eliminated: ' + stats.falsePositives + '\n'
    + '- Inconclusive (requires manual review): ' + (insufficient || []).length + '\n\n'
    + (allInconclusive
      ? 'IMPORTANT: The verifier could not confirm or eliminate any candidates due to limited file context. Do NOT say the codebase is safe. Instead surface the top candidates as requiring manual review.\n\n'
      : '')
    + (confirmedList    ? 'CONFIRMED CONFLICTS:\n' + confirmedList + '\n\n'    : 'No confirmed conflicts.\n\n')
    + (possibleList     ? 'POSSIBLE CONFLICTS:\n'  + possibleList  + '\n\n'    : '')
    + (insufficientList ? 'REQUIRES MANUAL REVIEW (top 20 of ' + (insufficient || []).length + '):\n' + insufficientList + '\n\n' : '')
    + (profile
      ? 'REPORT TITLE RULES:\n'
        + '- The report H1 MUST NOT contain "Ghost Architect" or any reference to Ghost.\n'
        + '- Use "Conflict Detection:" or "Pre-Engagement Conflict Audit:" as the prefix, followed by the project label or codebase name.\n'
        + '- Example: "Conflict Detection: ' + (context.projectLabel || 'project-name') + '".\n\n'
        + 'EXECUTIVE SUMMARY RULES:\n'
        + '- The opening section MUST NOT mention "Ghost Architect" or "Ghost" by name.\n'
        + '- Write as the consultant would, in their voice, focused on conflicts and resolution.\n\n'
      : '')
    + 'Write a complete report:\n'
    + '- Open with deployment recommendation (safe/unsafe/conditional/inconclusive)\n'
    + '- If all results are inconclusive, say so clearly — do NOT claim the codebase is conflict-free\n'
    + '- Detail each confirmed conflict: impact, affected flows, fix\n'
    + '- Note possible conflicts with investigation guidance\n'
    + '- List inconclusive candidates as requiring manual review\n'
    + '- Close with remediation estimates at ' + rates.junior + '/' + rates.mid + '/' + rates.senior + '/hr\n'
    + 'Use markdown. Be direct and specific:';

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
