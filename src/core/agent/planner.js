/**
 * Ghost Architect — Agent Planner
 * Pre-analysis recon: lightweight structural scan that produces a proposed
 * analysis plan and cost estimate BEFORE any full analysis begins.
 * Pure async — no Chalk, no Inquirer, no console output.
 */

import Anthropic from '@anthropic-ai/sdk';
import path      from 'path';
import { getConfig, resolveApiKey } from '../../config.js';

function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-6'; }

// ── Structural scan ───────────────────────────────────────────────────────────
// Lightweight — reads file paths and first 20 lines only. No full content.

function buildStructureScan(fileMap) {
  const files     = Object.keys(fileMap);
  const total     = files.length;
  const byExt     = {};
  const byDir     = {};
  const riskFiles = [];

  // High-risk filename patterns
  const riskPatterns = [
    /payment|checkout|order|cart/i,
    /observer|plugin|interceptor/i,
    /di\.xml|events\.xml|config\.xml/i,
    /install|upgrade|setup/i,
    /api|rest|graphql|soap/i,
    /auth|login|session|token/i,
  ];

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase() || 'none';
    const dir = filePath.split('/').slice(0, 3).join('/');

    byExt[ext] = (byExt[ext] || 0) + 1;
    byDir[dir] = (byDir[dir] || 0) + 1;

    if (riskPatterns.some(p => p.test(filePath))) {
      riskFiles.push(filePath);
    }
  }

  // Top directories by file count
  const topDirs = Object.entries(byDir)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([dir, count]) => ({ dir, count }));

  // File type breakdown
  const topExts = Object.entries(byExt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => ({ ext, count }));

  // Sample first 15 lines of a few key config files for context
  const configFiles = files
    .filter(f => /di\.xml|events\.xml|config\.xml|module\.xml/.test(f))
    .slice(0, 5)
    .map(f => ({
      path:    f,
      preview: fileMap[f].split('\n').slice(0, 15).join('\n').slice(0, 500),
    }));

  return {
    totalFiles: total,
    topDirs,
    topExts,
    riskFiles:   riskFiles.slice(0, 20),
    riskCount:   riskFiles.length,
    configFiles,
    entryPoints: files.filter(f =>
      /index\.(js|php|ts)|main\.(js|php|ts)|bootstrap|registration\.php/.test(f)
    ).slice(0, 5),
  };
}

// ── Estimate pass count and cost ──────────────────────────────────────────────

function estimateCosts(fileMap, mode = 'poi') {
  const totalFiles  = Object.keys(fileMap).length;
  const totalChars  = Object.values(fileMap).reduce((s, c) => s + c.length, 0);
  const totalTokens = Math.ceil(totalChars / 4);

  const PASS_TOKEN_LIMIT = 45000;
  const estimatedPasses  = Math.ceil(totalTokens / PASS_TOKEN_LIMIT);

  // Cost estimate: ~$0.003/1K input tokens + ~$0.015/1K output tokens
  // Rough estimate: each pass ~$0.20-0.35 depending on output verbosity
  const costPerPass = mode === 'conflict' ? 0.30 : 0.25;
  const estCost     = (estimatedPasses * costPerPass).toFixed(2);
  const estMinutes  = Math.max(3, Math.round(estimatedPasses * 3.5));

  // Agent overhead: planner (1 call) + optional verifier calls
  const agentOverhead = mode === 'conflict'
    ? (0.05 * Math.min(estimatedPasses * 2, 20)).toFixed(2) // ~5¢ per verification
    : '0.05'; // just the planner call itself

  return {
    totalFiles,
    totalTokens,
    estimatedPasses,
    estCost,
    estMinutes,
    agentOverhead,
    totalEstCost: (parseFloat(estCost) + parseFloat(agentOverhead)).toFixed(2),
  };
}

// ── Consultant context block (lightweight) ───────────────────────────────────
//
// The narrator's buildConsultantLens is heavier — it includes vocabulary
// instructions and grounding rules tuned for finding-by-finding rendering.
// For recon we just need a short paragraph that tells the planner what the
// consultant cares about, so the resulting plan reflects their lens.
// Returns '' when no profile is provided so the prompt is unchanged.

function buildReconConsultantContext(profile) {
  if (!profile) return '';
  const lines = [];
  if (profile.author)      lines.push('- Consultant: ' + profile.author + (profile.organization ? ' (' + profile.organization + ')' : ''));
  if (profile.name)        lines.push('- Methodology: ' + profile.name);
  if (profile.description) lines.push('- Purpose: ' + profile.description);
  if (Array.isArray(profile.priorities) && profile.priorities.length) {
    lines.push('- Priorities: ' + profile.priorities.slice(0, 6).join('; '));
  }
  if (Array.isArray(profile.anti_patterns) && profile.anti_patterns.length) {
    lines.push('- Anti-patterns watched for: ' + profile.anti_patterns.slice(0, 6).join('; '));
  }
  if (Array.isArray(profile.red_flags) && profile.red_flags.length) {
    lines.push('- Red flags: ' + profile.red_flags.slice(0, 6).join('; '));
  }
  if (!lines.length) return '';
  return '\n\nCONSULTANT LENS (this report is being prepared on behalf of the consultant below; weight findings and language toward their methodology):\n' + lines.join('\n');
}

// ── Ask Claude for a plan ─────────────────────────────────────────────────────

async function generatePlan(structure, costs, mode, options = {}) {
  const anthropic = getClient();
  const profile   = options.profile || null;
  const isRecon   = mode === 'recon';

  const consultantContext = buildReconConsultantContext(profile);

  // Recon mode produces an extra prose section (engagement_perspective) suited
  // for a saved client-facing markdown report. POI/Blast/Conflict modes use
  // the plan internally as a CLI banner, so they don't need that prose.
  const reconExtraSchema = isRecon
    ? ',\n  "engagement_perspective": "3\u20135 sentence paragraph framing what a full scan would surface from this codebase, written in the voice of the consultant when one is present. Plain prose, no bullets, no markdown headers.",\n  "sizing_summary": "2\u20133 sentence paragraph describing the codebase shape (size, dominant file types, structural posture). Plain prose.",\n  "methodology_note": "2\u20134 sentence paragraph explaining how the consultant\u2019s methodology applies to this codebase\u2019s actual structure. Empty string when no consultant profile is loaded."'
    : '';

  const prompt = `You are Ghost Architect's planning agent. Analyze this codebase structure and produce a focused analysis plan.${consultantContext}

CODEBASE STRUCTURE:
- Total files: ${structure.totalFiles}
- File types: ${structure.topExts.map(e => `${e.ext}(${e.count})`).join(', ')}
- Top directories: ${structure.topDirs.map(d => `${d.dir}(${d.count} files)`).join(', ')}
- High-risk files detected: ${structure.riskCount}
- Risk files (sample): ${structure.riskFiles.slice(0, 8).join(', ')}
- Entry points: ${structure.entryPoints.join(', ') || 'none detected'}
- Config files: ${structure.configFiles.map(c => c.path).join(', ') || 'none'}

ANALYSIS MODE: ${mode}
${options.focusAreas ? `USER-SPECIFIED FOCUS: ${options.focusAreas}` : ''}

COST ESTIMATES:
- Estimated passes: ${costs.estimatedPasses}
- Estimated cost: $${costs.estCost}
- Agent overhead: $${costs.agentOverhead}
- Total estimated: $${costs.totalEstCost}
- Estimated time: ${costs.estMinutes} minutes

Produce a JSON analysis plan:
{
  "recommendedPasses": number,
  "highRiskAreas": ["path/to/area1", "path/to/area2"],
  "warningFlags": ["description of pre-scan concern"],
  "proposedStartingPoint": "path/to/entry",
  "recommendedMode": "${mode}",
  "planSummary": "2-3 sentence plain English description of what Ghost will analyze and why",
  "confidenceNote": "any caveats about the estimate accuracy"${reconExtraSchema}
}

Respond with JSON only. No preamble.`;

  try {
    const response = await anthropic.messages.create({
      model:      getModel(),
      max_tokens: 1024,
      temperature: 0,
      messages:   [{ role: 'user', content: prompt }],
    });

    // Capture usage for cost tracking if caller provided a callback
    if (options.onUsage && response.usage) {
      options.onUsage(
        response.usage.input_tokens  ?? 0,
        response.usage.output_tokens ?? 0,
        getModel()
      );
    }

    const raw   = response.content[0]?.text || '{}';
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch {
    // Fallback plan if Claude call fails
    return {
      recommendedPasses:    costs.estimatedPasses,
      highRiskAreas:        structure.riskFiles.slice(0, 5),
      warningFlags:         structure.riskCount > 10 ? ['High number of risk files detected'] : [],
      proposedStartingPoint: structure.entryPoints[0] || structure.topDirs[0]?.dir || '.',
      recommendedMode:      mode,
      planSummary:          `Analyze ${structure.totalFiles} files across ${costs.estimatedPasses} passes. ${structure.riskCount} high-risk files detected.`,
      confidenceNote:       'Estimate based on file count and size.',
      // Recon mode falls back to lightly-templated prose. The full LLM
      // version is much better, but if the API fails we still produce
      // something coherent rather than blank fields.
      engagement_perspective: isRecon
        ? `A full Pre-Engagement Diligence scan of this ${structure.totalFiles}-file codebase would surface specific findings across architecture, security, performance, and maintainability. ${structure.riskCount} high-risk files have been pre-identified through filename pattern matching; a full scan would inspect their contents and produce concrete remediation steps with cost estimates.`
        : '',
      sizing_summary: isRecon
        ? `${structure.totalFiles} files across ${structure.topDirs.length || 0} top-level directories. Dominant file types: ${structure.topExts.slice(0, 3).map(e => `${e.ext} (${e.count})`).join(', ')}.`
        : '',
      methodology_note: (isRecon && profile)
        ? `${profile.author || 'The consultant'} would weight findings through their methodology lens (${profile.name || 'pre-engagement diligence'}), focusing on the priorities and red flags described in their profile.`
        : '',
    };
  }
}

// ── Main planner entry point ──────────────────────────────────────────────────
/**
 * Run pre-analysis recon and generate a plan.
 *
 * @param {object} fileMap    — loaded file map { path: content }
 * @param {string} mode       — 'poi' | 'blast' | 'conflict' | 'recon'
 * @param {object} options    — { focusAreas, maxPasses, profile }
 * @returns {object}          — plan object for user approval. When mode is
 *                              'recon', the result also contains the prose
 *                              fields engagement_perspective, sizing_summary,
 *                              and methodology_note (suitable for direct
 *                              rendering into a saved markdown report).
 */
export async function runRecon(fileMap, mode = 'poi', options = {}) {
  const structure = buildStructureScan(fileMap);
  const costs     = estimateCosts(fileMap, mode);
  const plan      = await generatePlan(structure, costs, mode, options);

  return {
    // Plan details
    recommendedPasses:    plan.recommendedPasses    || costs.estimatedPasses,
    highRiskAreas:        plan.highRiskAreas        || [],
    warningFlags:         plan.warningFlags         || [],
    proposedStartingPoint: plan.proposedStartingPoint || '',
    planSummary:          plan.planSummary          || '',
    confidenceNote:       plan.confidenceNote       || '',

    // Recon-only prose fields (empty strings when mode != 'recon').
    engagementPerspective: plan.engagement_perspective || '',
    sizingSummary:         plan.sizing_summary         || '',
    methodologyNote:       plan.methodology_note       || '',

    // Cost info
    totalFiles:           costs.totalFiles,
    estimatedPasses:      costs.estimatedPasses,
    estCost:              costs.estCost,
    agentOverhead:        costs.agentOverhead,
    totalEstCost:         costs.totalEstCost,
    estMinutes:           costs.estMinutes,

    // Structure summary
    riskFileCount:        structure.riskCount,
    topDirs:              structure.topDirs,
    entryPoints:          structure.entryPoints,

    // Approval state (set by caller after user confirms)
    approved:             false,
  };
}

// ── Present plan as structured data (CLI/Web formats this) ───────────────────

export function formatPlanForDisplay(plan) {
  return {
    summary:    plan.planSummary,
    stats: {
      files:   plan.totalFiles,
      passes:  plan.estimatedPasses,
      cost:    `~$${plan.totalEstCost}`,
      time:    `~${plan.estMinutes} min`,
    },
    risks:      plan.highRiskAreas,
    warnings:   plan.warningFlags,
    entryPoint: plan.proposedStartingPoint,
    confidence: plan.confidenceNote,
  };
}
