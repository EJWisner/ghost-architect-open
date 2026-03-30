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
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-5'; }

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

// ── Ask Claude for a plan ─────────────────────────────────────────────────────

async function generatePlan(structure, costs, mode, options = {}) {
  const anthropic = getClient();

  const prompt = `You are Ghost Architect's planning agent. Analyze this codebase structure and produce a focused analysis plan.

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
  "confidenceNote": "any caveats about the estimate accuracy"
}

Respond with JSON only. No preamble.`;

  try {
    const response = await anthropic.messages.create({
      model:      getModel(),
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });

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
    };
  }
}

// ── Main planner entry point ──────────────────────────────────────────────────
/**
 * Run pre-analysis recon and generate a plan.
 *
 * @param {object} fileMap    — loaded file map { path: content }
 * @param {string} mode       — 'poi' | 'blast' | 'conflict'
 * @param {object} options    — { focusAreas, maxPasses }
 * @returns {object}          — plan object for user approval
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
