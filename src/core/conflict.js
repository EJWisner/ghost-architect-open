/**
 * Ghost Architect — Core Conflict Detector
 * Pure logic. No Chalk. No Inquirer. Returns data, emits events via callbacks.
 *
 * Conflict Detection scans a codebase for places where two or more parts of
 * the system make conflicting or mismatched assumptions about the same thing:
 * shared config keys, API contracts, DB schemas, data shapes, constants, etc.
 * Works on any language or platform.
 *
 * v4.2: Agent verifier wired in — candidates are verified before surfacing.
 * v4.5.1: Session resumability — rate limit hits no longer lose completed passes.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getConfig, resolveApiKey } from '../config.js';
import { buildSystemConflict, buildConflictPrompt } from '../../prompts/conflict.js';
import { prioritizeFileMap } from '../prioritizer.js';
import { verifyConflicts } from './agent/verifier.js';
import { narrateConflictReport } from './agent/narrator.js';
import { loadSession, saveSession, deleteSession } from './multipass.js';

// Per-pass token budget. Set below the model's effective per-request ceiling
// (and below Open's 50K tier cap) to leave headroom for the system prompt,
// instructions, and prior-pass context. Mirrors POI's 45K headroom strategy.
// Setting this equal to the tier cap caused 'context length' errors on dense
// passes where the file content alone consumed the entire budget.
const PASS_TOKEN_LIMIT  = 40000;
const MAX_SINGLE_PASS   = 60000;
const SESSION_PREFIX    = 'conflict-';

// ── Claude helpers ─────────────────────────────────────────────────────────────

function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-5'; }

async function callClaude(prompt, system, maxTokens = 8096, onChunk = null) {
  const anthropic = getClient();
  let result = '';
  const stream = anthropic.messages.stream({
    model: getModel(), max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: prompt }]
  });
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      const text = chunk.delta.text;
      result += text;
      if (onChunk) onChunk(text);
    }
  }
  return result;
}

// ── Pass builder ───────────────────────────────────────────────────────────────

export function buildConflictPasses(fileMap) {
  const ordered = prioritizeFileMap(fileMap);
  const passes  = [];
  let current   = { files: {}, tokens: 0 };

  for (const [filePath, content] of Object.entries(ordered)) {
    const t = Math.ceil(content.length / 4);
    if (current.tokens + t > PASS_TOKEN_LIMIT && current.tokens > 0) {
      passes.push(current);
      current = { files: {}, tokens: 0 };
    }
    current.files[filePath] = content;
    current.tokens += t;
  }
  if (Object.keys(current.files).length > 0) passes.push(current);
  return passes;
}

export function getConflictPassInfo(fileMap) {
  const totalTokens = Object.values(fileMap).reduce((sum, c) => sum + Math.ceil(c.length / 4), 0);
  const singlePass  = totalTokens <= MAX_SINGLE_PASS;
  const passes      = singlePass ? [{ files: fileMap, tokens: totalTokens }] : buildConflictPasses(fileMap);
  const estCost     = (passes.length * 0.30).toFixed(2);
  const estMinutes  = Math.max(1, Math.round(passes.length * 0.5));
  return { passes, totalTokens, singlePass, estCost, estMinutes, totalFiles: Object.keys(fileMap).length };
}

// ── Single-pass conflict scan ──────────────────────────────────────────────────

async function runConflictPass(files, passNum, totalPasses, totalFiles, priorFindings, onChunk) {
  let context = '';
  for (const [fp, content] of Object.entries(files)) {
    context += `\n\n=== FILE: ${fp} ===\n${content}`;
  }

  const priorContext = priorFindings.length > 0
    ? `\n\nCONFLICTS FOUND IN PRIOR PASSES (use to find cross-pass conflicts):\n${priorFindings.join('\n---\n')}\n\n`
    : '';

  const prompt = buildConflictPrompt({ passNum, totalPasses, totalFiles, context, priorContext });
  return callClaude(prompt, buildSystemConflict(), 8096, passNum === totalPasses ? onChunk : null);
}

// ── Extract conflict candidates from raw pass results ─────────────────────────

function extractCandidates(rawResults) {
  const candidates = [];
  const combined   = Array.isArray(rawResults) ? rawResults.join('\n') : rawResults;
  const lines      = combined.split('\n');

  let current = null;
  const severityRe = /severity[:\s]+?(BLOCKING|CRITICAL|HIGH|MEDIUM|LOW|INFO)/i;
  const filesRe    = /files?[:\s]+(.+)/i;
  const findingRe  = /^\d+\.\s+\*?\*?(.+?)\*?\*?$/;

  for (const line of lines) {
    const t = line.trim();

    const fm = t.match(findingRe);
    if (fm) {
      if (current) candidates.push(current);
      current = {
        title:       fm[1].replace(/\*\*/g, '').trim(),
        description: '',
        severity:    'MEDIUM',
        files:       [],
        type:        'scan_detected',
        confidence:  60,
      };
      continue;
    }

    if (current) {
      const sm = t.match(severityRe);
      if (sm) { current.severity = sm[1].toUpperCase(); continue; }

      const fileM = t.match(filesRe);
      if (fileM) {
        current.files = fileM[1].split(/[,;]/).map(f => f.trim()).filter(Boolean);
        continue;
      }

      if (t && !t.startsWith('---') && t.length > 10) {
        current.description += (current.description ? ' ' : '') + t;
      }
    }
  }
  if (current) candidates.push(current);

  const seen = new Set();
  return candidates.filter(c => {
    const key = c.title.toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Extract skeleton for cross-pass context ────────────────────────────────────

function extractConflictSkeleton(result) {
  const lines    = result.split('\n');
  const skeleton = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^\d+\.\s+\*?\*?.+/.test(t) && t.length < 120)  skeleton.push(t.replace(/\*\*/g, ''));
    if (/Severity:/i.test(t))                              skeleton.push(t);
    if (/Files?:/i.test(t) && t.length < 100)             skeleton.push(t);
    if (/Contract|Schema|Config|API|Interface/i.test(t) && t.length < 100) skeleton.push(t);
  }
  return skeleton.slice(0, 30).join('\n');
}

// ── Fallback merge (used when verifier is skipped) ────────────────────────────

async function mergeConflictResults(results, onChunk) {
  const combined = results.map((r, i) =>
    `=== CONFLICT FINDINGS — BATCH ${i + 1} ===\n${r}`
  ).join('\n\n');

  const prompt =
    `Merge these ${results.length} conflict detection batches into a single unified report.\n\n` +
    `Rules:\n` +
    `- Merge duplicate conflicts (keep the most detailed description)\n` +
    `- Keep ALL unique conflicts — don't drop any\n` +
    `- If two batches found the same conflict from different angles, merge into one richer finding\n` +
    `- Maintain all severity ratings, file references, and recommended fixes\n` +
    `- Use the full Ghost Architect Conflict Detection report format\n` +
    `- Produce the final CONFLICT SUMMARY table with all counts and risk ratings\n\n` +
    `BATCHES:\n${combined}\n\nMerged conflict report:`;

  return callClaude(prompt, buildSystemConflict(), 8096, onChunk);
}

// ── Session key helper ─────────────────────────────────────────────────────────

function conflictSessionKey(projectLabel) {
  return `${SESSION_PREFIX}${projectLabel || 'default'}`;
}

// ── Main entry point ───────────────────────────────────────────────────────────
/**
 * Run conflict detection scan.
 *
 * callbacks:
 *   onProgress({ type, ...data })   — status events for CLI to display
 *   onChunk(text)                   — streaming final report text
 *   onSessionPrompt({ session, totalPasses }) → Promise<'resume'|'restart'>
 */
export async function runConflictScan(fileMap, callbacks = {}, options = {}) {
  const {
    onProgress      = () => {},
    onChunk         = () => {},
    onSessionPrompt = async () => 'resume',
    onVerifyPrompt  = async () => 'full',
  } = callbacks;

  const info       = getConflictPassInfo(fileMap);
  const totalFiles = info.totalFiles;
  const rates      = {
    junior: getConfig().get('rateJunior') || 85,
    mid:    getConfig().get('rateMid')    || 125,
    senior: getConfig().get('rateSenior') || 200,
  };

  onProgress({ type: 'start', totalFiles, totalPasses: info.passes.length, singlePass: info.singlePass });

  // ── Session resumability (multi-pass only) ─────────────────────────────────

  let passResults   = [];
  let skeletons     = [];
  let startFromPass = 0;

  if (!info.singlePass) {
    const sessionKey     = conflictSessionKey(options.projectLabel || 'default');
    const existingSession = loadSession(sessionKey);

    if (existingSession && existingSession.completedPassCount > 0) {
      const action = await onSessionPrompt({
        session:     existingSession,
        totalPasses: info.passes.length,
      });

      if (action === 'restart') {
        deleteSession(sessionKey);
      } else {
        // Resume — restore completed pass state
        passResults   = existingSession.passResults   || [];
        skeletons     = existingSession.skeletons     || [];
        startFromPass = existingSession.completedPassCount;
        onProgress({ type: 'resuming', fromPass: startFromPass, totalPasses: info.passes.length });
      }
    }
  }

  // ── Phase 1: Scan passes → collect raw findings ────────────────────────────

  if (info.singlePass) {
    onProgress({ type: 'scanning', fileCount: totalFiles, tokens: info.totalTokens });
    const result = await runConflictPass(fileMap, 1, 1, totalFiles, [], null);
    passResults.push(result);
  } else {
    const sessionKey = conflictSessionKey(options.projectLabel || 'default');

    for (let i = startFromPass; i < info.passes.length; i++) {
      const pass      = info.passes[i];
      const passNum   = i + 1;
      const fileCount = Object.keys(pass.files).length;

      onProgress({ type: 'passStart', passNum, totalPasses: info.passes.length, fileCount, tokens: pass.tokens });

      const result   = await runConflictPass(pass.files, passNum, info.passes.length, totalFiles, skeletons, null);
      const skeleton = extractConflictSkeleton(result);
      skeletons.push(skeleton);
      passResults.push(result);

      onProgress({ type: 'passComplete', passNum, totalPasses: info.passes.length });

      // Checkpoint after every pass
      saveSession(sessionKey, {
        projectLabel:       options.projectLabel || 'conflict',
        startedAt:          new Date().toISOString(),
        completedPassCount: passNum,
        totalPassCount:     info.passes.length,
        passResults,
        skeletons,
      });
    }

    // All passes done — clean up session
    deleteSession(sessionKey);
  }

  // ── Phase 2: Extract candidates from raw findings ──────────────────────────

  const candidates = extractCandidates(passResults);
  onProgress({ type: 'candidates_found', count: candidates.length });

  if (candidates.length === 0) {
    onProgress({ type: 'merging', count: passResults.length });
    const finalReport = await mergeConflictResults(passResults, onChunk);
    onProgress({ type: 'done', passCount: info.passes.length });
    return { finalReport, passCount: info.passes.length, totalFiles, verified: false };
  }

  // ── Phase 3: Verify each candidate ────────────────────────────────────────

  const quickCost = (candidates.length * 0.01).toFixed(2);
  const fullCost  = (candidates.length * 0.10).toFixed(2);

  const verifyChoice = await onVerifyPrompt({
    count:     candidates.length,
    quickCost,
    fullCost,
  });

  if (verifyChoice === 'skip') {
    onProgress({ type: 'narrating' });
    const skippedResult = {
      confirmed:      [],
      possible:       [],
      falsePositives: [],
      insufficient:   candidates,
      all:            candidates,
      stats: {
        total:          candidates.length,
        confirmed:      0,
        possible:       0,
        falsePositives: 0,
        insufficient:   candidates.length,
        eliminated:     0,
        surfaced:       0,
      },
    };
    const finalReport = await narrateConflictReport(skippedResult, { rates }, onChunk);
    onProgress({ type: 'done', passCount: info.passes.length });
    return { finalReport, passCount: info.passes.length, totalFiles, verified: false, stats: skippedResult.stats };
  }

  onProgress({ type: 'verification_start', count: candidates.length });

  const verificationResult = await verifyConflicts(candidates, fileMap, {
    onVerifying: ({ candidate }) =>
      onProgress({ type: 'verifying', title: candidate.title }),
    onVerified: ({ verified }) =>
      onProgress({ type: 'verified', title: verified.title, verdict: verified.verdict }),
    onProgress: ({ current, total }) =>
      onProgress({ type: 'verification_progress', current, total }),
  }, verifyChoice);

  onProgress({
    type:  'verification_done',
    stats: verificationResult.stats,
  });

  // ── Phase 4: Narrator writes final report ─────────────────────────────────

  onProgress({ type: 'narrating' });

  const finalReport = await narrateConflictReport(
    verificationResult,
    { rates },
    onChunk
  );

  onProgress({ type: 'done', passCount: info.passes.length });

  return {
    finalReport,
    passCount:  info.passes.length,
    totalFiles,
    verified:   true,
    stats:      verificationResult.stats,
  };
}
