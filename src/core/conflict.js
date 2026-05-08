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
const FIX_VERB_RE = /^(add|address|adjust|apply|audit|build|change|check|choose|configure|consider|consolidate|convert|create|define|delete|deprecate|disable|document|enable|ensure|establish|exclude|export|extract|fix|gate|generate|harden|implement|improve|include|inject|install|introduce|investigate|isolate|keep|load|log|maintain|migrate|modify|move|normalize|prevent|provide|publish|refactor|register|remove|rename|replace|resolve|restructure|return|review|run|save|search|set|setup|simplify|split|standardize|store|switch|test|track|update|use|validate|verify|wire|wrap)\b/i;

// Section headers that mark the start of a fix-recommendation sub-section.
// Numbered items inside these sections are fix steps, not conflict findings.
// Patterns are matched against pre-stripped lines (no `**`).
const FIX_SECTION_RE = /^(?:resolution|recommended\s+fix|fix\s+steps?|fix|what\s+to\s+do|how\s+to\s+(?:fix|resolve)|remediation|action\s+items?|next\s+steps?|to\s+resolve|to\s+fix|recommendation|recommendations)\s*:/i;

function stripBoldMarkdown(line) {
  return line.replace(/\*+/g, '');
}

// Exported for use by tests and diagnostic tooling. The verifier consumes
// the candidate list internally; external consumers should call runConflictScan
// rather than this function directly.
export function extractCandidates(rawResults) {
  const candidates = [];
  const combined   = Array.isArray(rawResults) ? rawResults.join('\n') : rawResults;
  const lines      = combined.split('\n');

  // Patterns assume pre-stripped lines. Anchored to start of line so body
  // text like "…both files…" can't hijack the file list.
  const severityRe = /^[Ss]everity\s*:[^A-Za-z]*(BLOCKING|CRITICAL|HIGH|MEDIUM|LOW|INFO)/;
  const filesRe    = /^[Ff]iles?\s*:\s*(.+)/;
  const findingRe  = /^\d+\.\s+(.+?)$/;

  let current        = null;
  let inFixSection   = false;  // Inside a Resolution/Fix-steps sub-section?

  for (const line of lines) {
    const tRaw = line.trim();
    const t    = stripBoldMarkdown(tRaw);

    // Section state tracking. A fix-section header ("Resolution:",
    // "Recommended Fix:", etc.) starts a fix block. A markdown header
    // (## / ###), a horizontal rule (---), or a new finding header
    // ("### Conflict 2", `1. **Title**`) ends the fix block.
    if (FIX_SECTION_RE.test(t)) {
      inFixSection = true;
    } else if (/^#{1,3}\s+/.test(tRaw)) {
      // Markdown header always ends a fix section — the model is starting
      // a new top-level section.
      inFixSection = false;
    } else if (tRaw.startsWith('---')) {
      // Horizontal rule ends a fix section. Blank lines do NOT — they're
      // common inside fix sub-sections.
      inFixSection = false;
    }

    // Try to match a finding header. Skip this match if we're inside a fix
    // sub-section — those numbered items are fix steps, not findings.
    const fm = !inFixSection ? t.match(findingRe) : null;
    if (fm) {
      const titleCandidate = fm[1].trim();

      // Backstop: if the title starts with an imperative fix-verb, it's
      // almost certainly a fix-step bullet that escaped the section
      // detection. Skip it. Keep `current` open so the surrounding finding
      // continues to accumulate description.
      if (FIX_VERB_RE.test(titleCandidate)) {
        // Treat as description content of the current finding, not a new one.
        if (current && titleCandidate.length > 10) {
          current.description += (current.description ? ' ' : '') + tRaw;
        }
        continue;
      }

      // Backstop: titles ending with `:` (like "Update both functions to
      // reference this constant:") are usually fix-step bullet headers.
      if (titleCandidate.endsWith(':')) {
        if (current && titleCandidate.length > 10) {
          current.description += (current.description ? ' ' : '') + tRaw;
        }
        continue;
      }

      if (current) candidates.push(current);
      // Long titles indicate the model wrote title + description on a single
      // line without a newline separator. Split on the first sentence-end
      // character (period, semicolon, em-dash followed by capital) so the
      // verifier gets a short, focused title to anchor on. The remainder
      // becomes the description — the verifier reads both, so no info is
      // lost. Threshold of 120 chars matches the skeleton extractor's limit.
      let titleText = titleCandidate;
      let extractedDescription = '';
      if (titleText.length > 120) {
        // Find the first natural split point. Prefer em-dash (most common in
        // model output: "NAME — explanation") then sentence terminators.
        const dashSplit  = titleText.search(/\s—\s/);
        const colonSplit = titleText.search(/:\s+[A-Z]/);
        const periodSplit = titleText.search(/\.\s+[A-Z]/);
        const candidateSplits = [dashSplit, colonSplit, periodSplit].filter(i => i > 0 && i < 120);
        if (candidateSplits.length > 0) {
          const firstSplit = Math.min(...candidateSplits);
          extractedDescription = titleText.slice(firstSplit + 1).trim();
          titleText = titleText.slice(0, firstSplit).trim();
        }
      }

      current = {
        title:       titleText,
        description: extractedDescription,
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
        current.files = fileM[1].split(/[,;]/).map(f => f.trim().replace(/`/g, '')).filter(Boolean);
        continue;
      }

      if (t && !t.startsWith('---') && t.length > 10) {
        current.description += (current.description ? ' ' : '') + t;
      }
    }
  }
  if (current) candidates.push(current);

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
