/**
 * Ghost Architect — Agent Entry Point & Mode Router
 * Wires together memory, tools, loop, planner, verifier, and narrator.
 * All agent modes flow through here.
 * Pure async — no Chalk, no Inquirer, no console output.
 */

import { AgentMemory }                          from './memory.js';
import { buildTools }                           from './tools.js';
import { runAgentLoop }                         from './loop.js';
import { runRecon, formatPlanForDisplay }       from './planner.js';
import { verifyConflicts, quickVerify, Verdict } from './verifier.js';
import { narrateReport, narrateConflictReport, narrateExecutiveSummary } from './narrator.js';

export { AgentMemory, buildTools, runAgentLoop, runRecon, formatPlanForDisplay };
export { verifyConflicts, quickVerify, Verdict };
export { narrateReport, narrateConflictReport, narrateExecutiveSummary };

// ── Agent mode constants ──────────────────────────────────────────────────────

export const AgentMode = {
  RECON:    'recon',     // Pre-analysis planner only
  POI:      'poi',       // Agentic POI scan
  BLAST:    'blast',     // Agentic blast radius
  CONFLICT: 'conflict',  // Conflict detection with verification
  CHAT:     'chat',      // Tool-enabled chat
};

// ── Step caps by mode and tier ────────────────────────────────────────────────

const STEP_CAPS = {
  recon:    3,    // Always cheap — just the planner
  poi:      15,   // Full agentic multipass
  blast:    10,   // Blast radius — targeted
  conflict: 5,    // Per-conflict verification
  chat:     3,    // Per chat turn
};

export function getStepCap(mode, tier = 'pro') {
  const base = STEP_CAPS[mode] || 10;
  if (tier === 'team' || tier === 'enterprise') return base;
  if (tier === 'pro')  return Math.min(base, 8);    // Pro gets slightly lower caps
  return Math.min(base, 3);                          // Open gets minimal
}

// ── Main agent runner ─────────────────────────────────────────────────────────
/**
 * Run an agent analysis.
 *
 * @param {string}  mode       — AgentMode constant
 * @param {object}  fileMap    — { path: content }
 * @param {object}  options    — { projectLabel, tier, focusAreas, rates }
 * @param {object}  callbacks  — { onStep, onThought, onToolCall, onToolResult, onChunk, onProgress }
 * @returns {object}           — { plan, memoryResult, report }
 */
export async function runAgent(mode, fileMap, options = {}, callbacks = {}) {
  const {
    projectLabel = 'unknown',
    tier         = 'pro',
    focusAreas   = '',
    rates        = { junior: 85, mid: 125, senior: 200 },
  } = options;

  const { onChunk = () => {}, onProgress = () => {} } = callbacks;

  // Step 1: Always run recon first (cheap — 1 API call)
  onProgress({ type: 'recon_start' });
  const plan = await runRecon(fileMap, mode, { focusAreas });
  onProgress({ type: 'recon_done', plan: formatPlanForDisplay(plan) });

  if (mode === AgentMode.RECON) {
    return { plan, memoryResult: null, report: null };
  }

  // Step 2: Run the appropriate agent mode
  const memory   = new AgentMemory();
  const tools    = buildTools(fileMap, memory);
  const stepCap  = getStepCap(mode, tier);

  let memoryResult, report;

  if (mode === AgentMode.POI || mode === AgentMode.BLAST) {
    // Agentic multipass POI or blast radius
    const task = mode === AgentMode.POI
      ? buildPOITask(plan, projectLabel, focusAreas)
      : buildBlastTask(plan, projectLabel, focusAreas);

    onProgress({ type: 'agent_start', mode, stepCap });
    memoryResult = await runAgentLoop(task, tools, memory, stepCap, callbacks);
    onProgress({ type: 'narrating' });
    report = await narrateReport(memoryResult, { projectLabel, mode, rates }, onChunk);

  } else if (mode === AgentMode.CONFLICT) {
    // Conflict detection: scan for candidates, then verify each
    onProgress({ type: 'conflict_scan_start' });
    const candidates = await scanForCandidates(fileMap, plan, callbacks);
    onProgress({ type: 'conflict_scan_done', count: candidates.length });

    onProgress({ type: 'verification_start', count: candidates.length });
    const verificationResult = await verifyConflicts(candidates, fileMap, {
      ...callbacks,
      onVerifying: ({ candidate }) => onProgress({ type: 'verifying', candidate }),
      onVerified:  ({ verified  }) => onProgress({ type: 'verified',  verified  }),
    });
    onProgress({ type: 'verification_done', stats: verificationResult.stats });

    onProgress({ type: 'narrating' });
    report = await narrateConflictReport(verificationResult, { projectLabel, rates }, onChunk);

    // Synthesize memory result from verification
    memoryResult = {
      findings:      [...verificationResult.confirmed, ...verificationResult.possible],
      findingCount:  verificationResult.confirmed.length + verificationResult.possible.length,
      filesAnalyzed: plan.totalFiles,
      stepCount:     candidates.length * 3, // approximate
      verificationStats: verificationResult.stats,
    };
  }

  return { plan, memoryResult, report };
}

// ── Task builders ─────────────────────────────────────────────────────────────

function buildPOITask(plan, projectLabel, focusAreas) {
  const focus = focusAreas || plan.proposedStartingPoint || '';
  return (
    `Analyze this codebase for Points of Interest: Red Flags, Landmarks, Dead Zones, and Fault Lines.\n\n` +
    `Project: ${projectLabel}\n` +
    (focus ? `Start with: ${focus}\n` : '') +
    (plan.highRiskAreas.length ? `Known risk areas: ${plan.highRiskAreas.join(', ')}\n` : '') +
    `\nUse listDirectory and searchFiles to orient yourself, then readFile or summarizeFile on key files.\n` +
    `Flag each confirmed finding with flagFinding(). When complete, call finish().`
  );
}

function buildBlastTask(plan, projectLabel, focusAreas) {
  return (
    `Perform a Blast Radius analysis on this codebase.\n\n` +
    `Project: ${projectLabel}\n` +
    (focusAreas ? `Focus area: ${focusAreas}\n` : '') +
    `\nIdentify: what breaks if the focus area changes, ripple effects, rollback risk.\n` +
    `Use searchFiles to trace dependencies. Flag each confirmed blast impact with flagFinding().\n` +
    `When complete, call finish().`
  );
}

// ── Conflict candidate scanner ────────────────────────────────────────────────
// Phase 1: quick scan to identify candidates before verification

async function scanForCandidates(fileMap, plan, callbacks) {
  const { onProgress = () => {} } = callbacks;

  const memory = new AgentMemory();
  const tools  = buildTools(fileMap, memory);

  const task =
    `Scan this codebase for potential conflict patterns. Do NOT verify them — just identify candidates.\n\n` +
    `Look for:\n` +
    `- Multiple plugins/observers on the same event or method\n` +
    `- Preference chain overlaps (multiple classes extending/replacing the same target)\n` +
    `- Duplicate class definitions\n` +
    `- Config key conflicts in di.xml, events.xml, etc.\n` +
    `- Sort order conflicts between plugins\n\n` +
    `For each candidate found, use flagFinding() with:\n` +
    `- severity: your best guess (BLOCKING/HIGH/MEDIUM/LOW)\n` +
    `- title: short description\n` +
    `- detail: what you saw that made you flag this\n` +
    `- files: the relevant file paths\n` +
    `- confidence: 50-70 (these are unverified candidates)\n\n` +
    `When done scanning, call finish().`;

  onProgress({ type: 'candidate_scan_start' });
  const result = await runAgentLoop(task, tools, memory, 8, callbacks);
  onProgress({ type: 'candidate_scan_done', count: result.findings.length });

  // Convert memory findings to candidate format
  return result.findings.map(f => ({
    type:        'agent_detected',
    severity:    f.severity,
    title:       f.title,
    description: f.detail,
    files:       f.files || [],
    confidence:  f.confidence || 60,
  }));
}
