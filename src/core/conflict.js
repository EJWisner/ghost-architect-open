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

async function runConflictPass(files, passNum, totalPasses, totalFiles, priorFindings, onChunk, profile, forecastContext) {
  let context = '';
  for (const [fp, content] of Object.entries(files)) {
    context += `\n\n=== FILE: ${fp} ===\n${content}`;
  }

  const priorContext = priorFindings.length > 0
    ? `\n\nCONFLICTS FOUND IN PRIOR PASSES (use to find cross-pass conflicts):\n${priorFindings.join('\n---\n')}\n\n`
    : '';

  const prompt = buildConflictPrompt({ passNum, totalPasses, totalFiles, context, priorContext, forecastContext });
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

// ── Fix-direction extractor ───────────────────────────────────────────────────
// Extracts structured fix_direction from the raw lines of a finding's
// Resolution/Fix section, accumulated during the extractCandidates pass.
//
// Returns null (not an error) when:
//   - No code block is present in the fix lines
//   - files array is empty or has multiple entries (no single target file)
//   - Multiple code blocks found (ambiguous)
//   - fixLines is empty or malformed
//
// NOTE: This function is intentionally kept narrow in scope so it can be
// extracted to src/utils/fix-direction-extractor.js when Blast enrichment
// is added in Phase 2b. Keep the signature (fixLines: string[], files: string[])
// stable for that migration.
function extractFixDirection(fixLines, files) {
  try {
    // Gate 1: must have exactly one target file
    if (!Array.isArray(files) || files.length !== 1 || !files[0] || !files[0].trim()) {
      return null;
    }
    const targetFile = files[0].trim();

    if (!Array.isArray(fixLines) || fixLines.length === 0) return null;

    // Gate 2: find code blocks in the fix lines
    // Code blocks are delimited by ``` (with optional language tag)
    const codeBlockRe = /^```/;
    const blocks = [];
    let inBlock = false;
    let blockLines = [];
    let reasoningLines = [];

    for (const line of fixLines) {
      if (codeBlockRe.test(line.trim())) {
        if (inBlock) {
          // closing fence
          blocks.push(blockLines.join('\n'));
          blockLines = [];
          inBlock = false;
        } else {
          // opening fence — capture prose before this as reasoning
          inBlock = true;
        }
      } else if (inBlock) {
        blockLines.push(line);
      } else {
        // Outside a code block — accumulate as reasoning prose
        const stripped = stripBoldMarkdown(line).trim();
        if (stripped && !stripped.match(/^Remediation estimate/i)) {
          reasoningLines.push(stripped);
        }
      }
    }

    // Gate 3: must have exactly one code block (multiple = ambiguous)
    if (blocks.length !== 1) return null;

    const patchInstruction = blocks[0].trim();
    if (!patchInstruction) return null;

    // Gate 4: patch instruction sanity — reject obviously non-code content
    // (e.g. a block that only contains prose like "run: rector process")
    // Heuristic: if it's > 30 lines it's probably a full-file replacement,
    // not a surgical patch. Return null and let the human decide.
    const patchLines = patchInstruction.split('\n').length;
    if (patchLines > 30) return null;

    // Confidence: single file + code block found
    // high: ≤ 10 lines (surgical), medium: 11-30 lines (larger change)
    const confidence = patchLines <= 10 ? 'high' : 'medium';

    // Reasoning: join prose lines, collapse whitespace
    const reasoning = reasoningLines
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/:\s*$/, '.');  // normalize trailing colon to period

    return {
      target_file:       targetFile,
      patch_instruction: patchInstruction,
      reasoning:         reasoning || null,
      confidence,
    };
  } catch {
    // Never crash the scan due to fix-direction parsing
    return null;
  }
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
  let currentFixLines = [];    // Raw lines of the current finding's fix section

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
      inFixSection = false;
    } else if (tRaw.startsWith('---')) {
      inFixSection = false;
    }

    // Accumulate fix-section lines for the current candidate.
    // These are passed to extractFixDirection when the candidate is finalized.
    if (inFixSection && current && !FIX_SECTION_RE.test(t)) {
      currentFixLines.push(line);
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

      if (current) {
        current.fix_direction = extractFixDirection(currentFixLines, current.files);
        candidates.push(current);
      }
      currentFixLines = [];
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
  if (current) {
    current.fix_direction = extractFixDirection(currentFixLines, current.files);
    candidates.push(current);
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

  // Tier threads through for Stage 3 gates (currently: verifier-fallback in
  // quickVerify). Defaults to 'open' (fail-closed) so any caller that
  // forgets to pass tier does not leak a paid-tier privilege. See
  // TODO-verifier-agent-stage3-evaluate.md.
  const tier = options.tier || 'open';

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
    const result = await runConflictPass(fileMap, 1, 1, totalFiles, [], null, profile, forecastContext);
    passResults.push(result);
  } else {
    const sessionKey = conflictSessionKey(options.projectLabel || 'default');

    for (let i = startFromPass; i < info.passes.length; i++) {
      const pass      = info.passes[i];
      const passNum   = i + 1;
      const fileCount = Object.keys(pass.files).length;

      onProgress({ type: 'passStart', passNum, totalPasses: info.passes.length, fileCount, tokens: pass.tokens });

      const result   = await runConflictPass(pass.files, passNum, info.passes.length, totalFiles, skeletons, null, profile, forecastContext);
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
    return { finalReport, passCount: info.passes.length, totalFiles, verified: false, candidates: [] };
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
    return { finalReport, passCount: info.passes.length, totalFiles, verified: false, stats: skippedResult.stats, candidates };
  }

  onProgress({ type: 'verification_start', count: candidates.length });

  const verificationResult = await verifyConflicts(candidates, fileMap, {
    onVerifying: ({ candidate }) =>
      onProgress({ type: 'verifying', title: candidate.title }),
    onVerified: ({ verified }) =>
      onProgress({ type: 'verified', title: verified.title, verdict: verified.verdict }),
    onProgress: ({ current, total }) =>
      onProgress({ type: 'verification_progress', current, total }),
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
    onChunk
  );

  onProgress({ type: 'done', passCount: info.passes.length });

  return {
    finalReport,
    passCount:  info.passes.length,
    totalFiles,
    verified:   true,
    stats:      verificationResult.stats,
    candidates,
  };
}
