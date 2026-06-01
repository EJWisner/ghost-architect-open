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
import { mergeRates } from '../profile/index.js';
import { getTierCap } from '../loader/tierCaps.js';
import { generateFindingId } from '../utils/finding-parser.js';
import { SessionCostTracker } from './estimator.js';

// Per-pass token budget for conflict detection. Scales with tier cap to leave
// uniform 20% headroom across all tiers. Setting this equal to or near the
// tier cap caused 'context length' errors on dense passes where file content
// alone consumed the entire budget. Pre-Cycle-13 this was hardcoded at 50K,
// which gave Open users (50K tier cap) zero headroom and Pro/Team/Enterprise
// massive over-restriction (50%/67%/75% headroom). See
// TODO-core-conflict-pass-token-limit-tier-scaling-stage3.md.
function getPassTokenLimit(tier) {
  return Math.floor(getTierCap(tier) * 0.8);
}

const MAX_SINGLE_PASS   = 60000;
const SESSION_PREFIX    = 'conflict-';

// ── Claude helpers ─────────────────────────────────────────────────────────────

function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-6'; }

async function callClaude(prompt, system, maxTokens = 8096, onChunk = null, onUsage = null) {
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
  // Capture real usage from the stream's final message.
  // stream.finalMessage() resolves once the stream is complete (it has already
  // drained by this point) — safe to call without an extra network round-trip.
  if (onUsage) {
    try {
      const finalMsg = await stream.finalMessage();
      if (finalMsg?.usage) {
        onUsage(
          finalMsg.usage.input_tokens  ?? 0,
          finalMsg.usage.output_tokens ?? 0,
          getModel()
        );
      }
    } catch (_) {
      // Usage capture failed — streaming response was already delivered. Ignore.
    }
  }
  return result;
}

// ── Pass builder ───────────────────────────────────────────────────────────────

export function buildConflictPasses(fileMap, tier = 'open') {
  const ordered = prioritizeFileMap(fileMap);
  const passes  = [];
  let current   = { files: {}, tokens: 0 };
  const passTokenLimit = getPassTokenLimit(tier);

  for (const [filePath, content] of Object.entries(ordered)) {
    const t = Math.ceil(content.length / 4);
    if (current.tokens + t > passTokenLimit && current.tokens > 0) {
      passes.push(current);
      current = { files: {}, tokens: 0 };
    }
    current.files[filePath] = content;
    current.tokens += t;
  }
  if (Object.keys(current.files).length > 0) passes.push(current);
  return passes;
}

export function getConflictPassInfo(fileMap, tier = 'open') {
  const totalTokens = Object.values(fileMap).reduce((sum, c) => sum + Math.ceil(c.length / 4), 0);
  const singlePass  = totalTokens <= MAX_SINGLE_PASS;
  const passes      = singlePass ? [{ files: fileMap, tokens: totalTokens }] : buildConflictPasses(fileMap, tier);
  const estCost     = (passes.length * 0.30).toFixed(2);
  const estMinutes  = Math.max(1, Math.round(passes.length * 0.5));
  return { passes, totalTokens, singlePass, estCost, estMinutes, totalFiles: Object.keys(fileMap).length };
}

// ── Single-pass conflict scan ──────────────────────────────────────────────────

async function runConflictPass(files, passNum, totalPasses, totalFiles, priorFindings, onChunk, profile, forecastContext, onUsage = null) {
  let context = '';
  for (const [fp, content] of Object.entries(files)) {
    context += `\n\n=== FILE: ${fp} ===\n${content}`;
  }

  const priorContext = priorFindings.length > 0
    ? `\n\nCONFLICTS FOUND IN PRIOR PASSES (use to find cross-pass conflicts):\n${priorFindings.join('\n---\n')}\n\n`
    : '';

  const prompt = buildConflictPrompt({ passNum, totalPasses, totalFiles, context, priorContext, forecastContext });
  return callClaude(prompt, buildSystemConflict(profile), 8096, passNum === totalPasses ? onChunk : null, onUsage);
}

// ── Extract conflict candidates from raw pass results ─────────────────────────
//
// v5.1.3 backport from ghost-open: replaced Pro's prior 'severity within
// 8 lines' heuristic with Open's explicit fix-section state tracking +
// stripBoldMarkdown approach. Pro's prior implementation didn't handle
// `**Severity:** MEDIUM` (bold-wrapped value) so the verifier received
// candidates with files=[] and severity='MEDIUM' (default fallback)
// regardless of what the model emitted. Open's algorithm pre-strips
// bold markdown, then anchors regexes to the canonical un-bolded form.
//
// FIX_SECTION_RE / FIX_VERB_RE constants used by both extractCandidates
// and extractConflictSkeleton so cross-pass context isn't poisoned by
// fix-step bullets either.

// Imperative verbs that fix-recommendation bullets typically start with.
// If a candidate's title starts with one of these, it's almost certainly a
// fix instruction, not a conflict claim. The verbs are listed lowercased
// because we lowercase the title before checking.
// "store" removed: in Magento/PHP "Store" is overwhelmingly a noun (store entity,
// store ID, store config). Zero imperative-verb usages found across 8 real sessions.
// "test" retained: 2 confirmed legitimate imperative uses in real sessions.
const FIX_VERB_RE = /^(add|address|adjust|apply|audit|build|change|check|choose|configure|consider|consolidate|convert|create|define|delete|deprecate|disable|document|enable|ensure|establish|exclude|export|extract|fix|gate|generate|harden|implement|improve|include|inject|install|introduce|investigate|isolate|keep|load|log|maintain|migrate|modify|move|normalize|prevent|provide|publish|refactor|register|remove|rename|replace|resolve|restructure|return|review|run|save|search|set|setup|simplify|split|standardize|switch|test|track|update|use|validate|verify|wire|wrap)\b/i;

// Section headers that mark the start of a fix-recommendation sub-section.
// Numbered items inside these sections are fix steps, not conflict findings.
// Patterns are matched against pre-stripped lines (no `**`).
//
// Two real formats found across 8 sessions:
//   Format A: - Resolution: ...  (bullet-bold: "- **Resolution:**" → stripped "- Resolution:")
//   Format B: Resolution: ...    (standalone bold: "**Resolution:**" → stripped "Resolution:")
// The optional `(?:-\s+)?` prefix handles Format A.
// The optional `(?:\([^)]*\))?` handles parentheticals like (future) or (from Pass 1).
const FIX_SECTION_RE = /^(?:-\s+)?(?:resolution|recommended\s+fix|fix\s+steps?|fix|what\s+to\s+do|how\s+to\s+(?:fix|resolve)|remediation|action\s+items?|next\s+steps?|to\s+resolve|to\s+fix|recommendation|recommendations)\s*(?:\([^)]*\))?\s*:/i;

function stripBoldMarkdown(line) {
  return line.replace(/\*+/g, '');
}

// ── Candidate normalizer ──────────────────────────────────────────────────────
// Converts an extractCandidates candidate to the findings-sidecar shape.
// Bypasses extractFindings for Conflict mode so fix_direction survives the
// parse→narrate→reparse round-trip. Parity contract:
//   - id:          generateFindingId({severity, files, title}) — byte-identical
//   - title:       candidate.title — unchanged
//   - severity:    candidate.severity — unchanged
//   - files:       candidate.files — unchanged
//   - effortHours: 0 — matches current production output (EFFORT_RE doesn't
//                  match "Remediation estimate:" format; all Conflict findings
//                  ship with effortHours:0 today). TODO: fix EFFORT_RE.
//   - confidence:  85 — matches current production output (extractFindings
//                  hardcodes 85; candidate confidence:60 is internal only).
//                  TODO: replace with meaningful per-finding signal.
//   - detail:      candidate.description — pre-narration verifier text.
//                  More faithful to analysis; less polished than narrated prose.
//                  Documented deliberate change per May 2026 Phase 2 decision.
//   - fix_direction: candidate.fix_direction — new field, null when not extractable
export function normalizeCandidateToFinding(candidate) {
  // Filter files FIRST — generateFindingId reads files[0] for the id,
  // so the clean path must be in place before id generation.
  const files = (Array.isArray(candidate.files) ? candidate.files : [])
    .map(f => typeof f === 'string' ? f.replace(/\s*\([^)]*\)\s*$/, '').trim() : '')
    .filter(f => f && (f.includes('/') || f.includes('\\') || !/\s/.test(f)))
    .filter(f => !/^(none|n\/a|not\s+(specified|applicable))/i.test(f));

  return {
    id:           generateFindingId({ ...candidate, files }),
    title:        candidate.title        || '',
    severity:     candidate.severity     || 'MEDIUM',
    files,
    effortHours:  0,
    confidence:   85,
    detail:       candidate.description  || '',
    fix_direction: candidate.fix_direction || null,
  };
}
export function extractCandidates(rawResults) {
  const combined = Array.isArray(rawResults) ? rawResults.join('\n') : rawResults;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function normalizeSeverity(s) {
    const v = (s || '').toString().toUpperCase().trim();
    if (v === 'CRITICAL') return 'CRITICAL';
    if (v === 'HIGH')     return 'HIGH';
    if (v === 'LOW')      return 'LOW';
    if (v === 'INFO')     return 'INFO';
    return 'MEDIUM'; // default
  }

  function buildFixDirection(fd, files) {
    if (!fd || typeof fd !== 'object') return null;
    const targetFiles = Array.isArray(fd.target_files)
      ? fd.target_files.filter(Boolean)
      : (Array.isArray(files) ? files.slice(0, 1) : []);
    if (targetFiles.length === 0) return null;
    if (!fd.patch_instruction || typeof fd.patch_instruction !== 'string') return null;
    return {
      target_files:      targetFiles,
      patch_instruction: fd.patch_instruction,
      reasoning:         fd.reasoning || null,
      confidence:        fd.confidence === 'medium' ? 'medium' : 'high',
    };
  }

  // ── JSON fence extraction ──────────────────────────────────────────────────
  // Find all ```json ... ``` fences in the combined string.
  const fenceRe = /```json\s*([\s\S]*?)```/g;
  const candidates = [];

  let match;
  while ((match = fenceRe.exec(combined)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch (err) {
      // Malformed JSON from this pass — skip and continue
      console.warn(`[extractCandidates] JSON parse failed: ${err.message}`);
      continue;
    }

    const conflicts = parsed.conflicts;
    if (!Array.isArray(conflicts)) continue;

    for (const conflict of conflicts) {
      if (!conflict || typeof conflict !== 'object') continue;
      const title = (conflict.title || 'Untitled').trim();
      if (!title) continue;

      candidates.push({
        title,
        description:   conflict.description || '',
        severity:      normalizeSeverity(conflict.severity),
        files:         Array.isArray(conflict.files) ? conflict.files.filter(Boolean) : [],
        type:          'scan_detected',
        confidence:    60,
        fix_direction: buildFixDirection(conflict.fix_direction, conflict.files),
      });
    }
  }

  // Dedupe by title prefix (catches near-duplicates from multi-pass merge)
  const seen = new Set();
  return candidates.filter(c => {
    const key = c.title.toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Extract skeleton for cross-pass context ───────────────────────────────────

function extractConflictSkeleton(result) {
  // Same section-awareness as extractCandidates so cross-pass context isn't
  // poisoned by fix-step bullets. See extractCandidates for full rationale.
  const lines    = result.split('\n');
  const skeleton = [];
  let inFixSection = false;

  for (const line of lines) {
    const tRaw = line.trim();
    const t    = stripBoldMarkdown(tRaw);

    if (FIX_SECTION_RE.test(t))   inFixSection = true;
    else if (tRaw.startsWith('---') || /^#{1,3}\s+/.test(tRaw)) inFixSection = false;

    // Numbered finding header — only count outside fix sections, and only if
    // the title isn't an imperative fix-verb bullet.
    const findingMatch = !inFixSection && /^\d+\.\s+(.+?)$/.test(t) && t.length < 120 ? t.match(/^\d+\.\s+(.+?)$/) : null;
    if (findingMatch && !FIX_VERB_RE.test(findingMatch[1].trim()) && !findingMatch[1].trim().endsWith(':')) {
      skeleton.push(t);
    }
    if (/^[Ss]everity\s*:/.test(t))                          skeleton.push(t);
    if (/^[Ff]iles?\s*:/.test(t) && t.length < 100)         skeleton.push(t);
    if (/Contract|Schema|Config|API|Interface/i.test(tRaw) && tRaw.length < 100) skeleton.push(tRaw);
  }
  return skeleton.slice(0, 30).join('\n');
}


// ── Fallback merge (used when verifier is skipped) ────────────────────────────

async function mergeConflictResults(results, onChunk, profile, onUsage = null) {
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

  return callClaude(prompt, buildSystemConflict(profile), 8096, onChunk, onUsage);
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

  // Ghost Partner — consultant profile threads through every Claude call
  // in this scan so findings, narrator prose, and any merge-fallback
  // output share the consultant's lens. When options.profile is null the
  // scan behaves bit-for-bit like v0.3 — buildSystemConflict(null) returns
  // the original system prompt unchanged.
  const profile = options.profile || null;

  // Tier threads through for Stage 3 gates (currently: verifier-fallback in
  // quickVerify). Defaults to 'open' (fail-closed) so any caller that
  // forgets to pass tier does not leak a paid-tier privilege. See
  // TODO-verifier-agent-stage3-evaluate.md.
  const tier = options.tier || 'open';

  // ── Cost tracker — accumulates real API usage from every pipeline stage ─────
  // Accepts an external tracker (when caller pre-records plan stage costs) or
  // creates a fresh one. Each stage fires onUsage(inputTokens, outputTokens, model).
  const tracker = options.tracker instanceof SessionCostTracker
    ? options.tracker
    : new SessionCostTracker();
  const scanUsage    = (i, o, m) => tracker.record('scan',    i, o, m);
  const verifyUsage  = (i, o, m) => tracker.record('verify',  i, o, m);
  const narrateUsage = (i, o, m) => tracker.record('narrate', i, o, m);

  const info       = getConflictPassInfo(fileMap, tier);
  const totalFiles = info.totalFiles;
  const rates      = mergeRates({
    junior: getConfig().get('rateJunior') || 85,
    mid:    getConfig().get('rateMid')    || 125,
    senior: getConfig().get('rateSenior') || 200,
  }, profile);

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

  // forecastContext: when set (by Commit Forecast mode), prepends framing to every
  // conflict pass prompt so the model frames findings as "if you push now" rather
  // than generic conflict detection. Undefined/null = standard conflict scan.
  const forecastContext = options.forecastContext || null;

  if (info.singlePass) {
    onProgress({ type: 'scanning', fileCount: totalFiles, tokens: info.totalTokens });
    const result = await runConflictPass(fileMap, 1, 1, totalFiles, [], null, profile, forecastContext, scanUsage);
    passResults.push(result);
  } else {
    const sessionKey = conflictSessionKey(options.projectLabel || 'default');

    for (let i = startFromPass; i < info.passes.length; i++) {
      const pass      = info.passes[i];
      const passNum   = i + 1;
      const fileCount = Object.keys(pass.files).length;

      onProgress({ type: 'passStart', passNum, totalPasses: info.passes.length, fileCount, tokens: pass.tokens });

      const result   = await runConflictPass(pass.files, passNum, info.passes.length, totalFiles, skeletons, null, profile, forecastContext, scanUsage);
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
    const finalReport = await mergeConflictResults(passResults, onChunk, profile, scanUsage);
    onProgress({ type: 'done', passCount: info.passes.length });
    return { finalReport, passCount: info.passes.length, totalFiles, verified: false, candidates: [], tracker };
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
    const finalReport = await narrateConflictReport(skippedResult, { rates, profile, projectLabel: options.projectLabel }, onChunk, narrateUsage);
    onProgress({ type: 'done', passCount: info.passes.length });
    return { finalReport, passCount: info.passes.length, totalFiles, verified: false, stats: skippedResult.stats, candidates, tracker };
  }

  onProgress({ type: 'verification_start', count: candidates.length });

  const verificationResult = await verifyConflicts(candidates, fileMap, {
    onVerifying: ({ candidate }) =>
      onProgress({ type: 'verifying', title: candidate.title }),
    onVerified: ({ verified }) =>
      onProgress({ type: 'verified', title: verified.title, verdict: verified.verdict }),
    onProgress: ({ current, total }) =>
      onProgress({ type: 'verification_progress', current, total }),
    onUsage: verifyUsage,
  }, verifyChoice, tier);

  onProgress({
    type:  'verification_done',
    stats: verificationResult.stats,
  });

  // ── Phase 4: Narrator writes final report ─────────────────────────────────

  onProgress({ type: 'narrating' });

  const finalReport = await narrateConflictReport(
    verificationResult,
    { rates, profile, projectLabel: options.projectLabel },
    onChunk,
    narrateUsage
  );

  onProgress({ type: 'done', passCount: info.passes.length });

  return {
    finalReport,
    passCount:  info.passes.length,
    totalFiles,
    verified:   true,
    stats:      verificationResult.stats,
    candidates,
    tracker,
  };
}
