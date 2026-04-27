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

const PASS_TOKEN_LIMIT  = 50000;
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

async function runConflictPass(files, passNum, totalPasses, totalFiles, priorFindings, onChunk, profile) {
  let context = '';
  for (const [fp, content] of Object.entries(files)) {
    context += `\n\n=== FILE: ${fp} ===\n${content}`;
  }

  const priorContext = priorFindings.length > 0
    ? `\n\nCONFLICTS FOUND IN PRIOR PASSES (use to find cross-pass conflicts):\n${priorFindings.join('\n---\n')}\n\n`
    : '';

  const prompt = buildConflictPrompt({ passNum, totalPasses, totalFiles, context, priorContext });
  return callClaude(prompt, buildSystemConflict(profile), 8096, passNum === totalPasses ? onChunk : null);
}

// ── Extract conflict candidates from raw pass results ─────────────────────────

function extractCandidates(rawResults) {
  const candidates = [];
  const combined   = Array.isArray(rawResults) ? rawResults.join('\n') : rawResults;
  const lines      = combined.split('\n');

  // The model's pass output has a structure like:
  //
  //   🔀 CONTRACT CONFLICTS
  //
  //   1. **Finding ID Field Mismatch**
  //      Severity: MEDIUM
  //      Files: src/services/GitHubService.ts, ...
  //      Impact: ...
  //      Resolution:
  //        1. Inspect actual ghost-reports JSON response structure
  //        2. If YES: Change Finding interface to `id: string`
  //
  // The previous extractor matched ANY `^\d+\. ...` line as a candidate,
  // which meant the numbered Resolution steps got pulled out as their own
  // candidates. With ~20 findings each having 3-5 resolution steps, the
  // extractor produced 60+ "candidates" that were actually fix-step text.
  // The verifier then couldn't make a judgment on a fragment of advice and
  // returned UNCLEAR for everything.
  //
  // Fix: a numbered line only counts as a candidate title if a Severity
  // line appears within the next ~8 lines. Real findings always have
  // Severity right under the title; resolution steps and other numbered
  // lists don't. We also accept markdown headers (## / ###) and bold-only
  // lines as candidate titles, since the model varies its formatting.

  const severityRe = /severity[:\s]+?(BLOCKING|CRITICAL|HIGH|MEDIUM|LOW|INFO)/i;
  // Broader file-line matcher: catches "Files:", "File:", "Affected files:",
  // "Affected Files:", "Locations:", "In:". This is what feeds the verifier;
  // when this regex misses, candidates arrive with files=[] and the verifier
  // returns INSUFFICIENT for everything.
  const filesRe    = /^(?:files?|affected\s+files?|locations?|in)[:\s]+(.+)/i;
  const numberedRe = /^\d+\.\s+\*?\*?(.+?)\*?\*?$/;
  const headerRe   = /^#{2,4}\s+(?:\d+\.\s+)?\*?\*?(.+?)\*?\*?$/;
  const boldOnlyRe = /^\*\*([^*]{6,120})\*\*$/;

  function hasSeverityNearby(startIdx, window = 8) {
    const end = Math.min(lines.length, startIdx + window + 1);
    for (let i = startIdx + 1; i < end; i++) {
      if (severityRe.test(lines[i])) return true;
    }
    return false;
  }

  let current    = null;
  let currentEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();

    let title = null;
    const hm = t.match(headerRe);
    if (hm) title = hm[1];
    if (!title) {
      const bm = t.match(boldOnlyRe);
      if (bm) title = bm[1];
    }
    if (!title) {
      const nm = t.match(numberedRe);
      if (nm && hasSeverityNearby(i)) title = nm[1];
    }

    if (title) {
      if (current) candidates.push(current);
      current = {
        title:       title.replace(/\*\*/g, '').trim(),
        description: '',
        severity:    'MEDIUM',
        files:       [],
        type:        'scan_detected',
        confidence:  60,
      };
      currentEnd = Math.min(lines.length, i + 30);
      continue;
    }

    if (current && i <= currentEnd) {
      const sm = t.match(severityRe);
      if (sm) { current.severity = sm[1].toUpperCase(); continue; }

      const fileM = t.match(filesRe);
      if (fileM) {
        // Strip markdown bold + backticks; split on commas/semicolons; require
        // each entry to have a path-like shape (slash or dot) so we don't capture
        // descriptive sentences as filenames.
        const raw = fileM[1].replace(/[*`]/g, '').trim();
        const parts = raw.split(/[,;]/).map(f => f.trim()).filter(Boolean);
        const filtered = parts.filter(p => /[\/.]/.test(p) && p.length > 3 && p.length < 200);
        if (filtered.length) current.files = filtered;
        continue;
      }

      if (t && !t.startsWith('---') && t.length > 10) {
        current.description += (current.description ? ' ' : '') + t;
      }
    }
  }
  if (current) candidates.push(current);

  // Filter out junk that slipped through:
  //  - titles starting with action verbs / conditional words (fix steps)
  //  - titles shorter than 12 chars (too generic to be a real conflict name)
  //  - candidates with empty title
  const junkPrefixRe = /^(if\s+(yes|no)\b|update|run|wait|or\s|add\s|remove\s|test\s|downgrade|verify|inspect|implement|refactor|halt|audit|pin|lock|force|adopt|integration\s+test|separate|document|decide|investigation|resolution|recommendation)/i;
  const filtered = candidates.filter(c => {
    if (!c.title || c.title.length < 12) return false;
    if (junkPrefixRe.test(c.title)) return false;
    return true;
  });

  // Dedupe by first-40-chars-of-title.
  const seen = new Set();
  return filtered.filter(c => {
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

async function mergeConflictResults(results, onChunk, profile) {
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

  return callClaude(prompt, buildSystemConflict(profile), 8096, onChunk);
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
    const result = await runConflictPass(fileMap, 1, 1, totalFiles, [], null, profile);
    passResults.push(result);
  } else {
    const sessionKey = conflictSessionKey(options.projectLabel || 'default');

    for (let i = startFromPass; i < info.passes.length; i++) {
      const pass      = info.passes[i];
      const passNum   = i + 1;
      const fileCount = Object.keys(pass.files).length;

      onProgress({ type: 'passStart', passNum, totalPasses: info.passes.length, fileCount, tokens: pass.tokens });

      const result   = await runConflictPass(pass.files, passNum, info.passes.length, totalFiles, skeletons, null, profile);
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
    const finalReport = await mergeConflictResults(passResults, onChunk, profile);
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
    const finalReport = await narrateConflictReport(skippedResult, { rates, profile, projectLabel: options.projectLabel }, onChunk);
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
    { rates, profile, projectLabel: options.projectLabel },
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
