/**
 * Ghost Architect — Agent Verifier
 * Phase 2 of Conflict Detection: takes flagged candidates and verifies
 * each one using a mini ReAct loop before surfacing in the report.
 * Eliminates false positives. Pure async — no Chalk, no Inquirer.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs        from 'fs';
import path      from 'path';
import os        from 'os';
import { getConfig, resolveApiKey } from '../../config.js';
import { AgentMemory }              from './memory.js';
import { buildTools }               from './tools.js';
import { runMiniLoop }              from './loop.js';
import { requireTier }              from '../../license/tier-gates.js';
import { getSamplingParams }        from '../../utils/sampling-params.js';

function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-6'; }

// Debug telemetry directory — written when verification falls through to
// INSUFFICIENT for diagnosability. Files here are NEVER shown to the user;
// they're for diagnosing why the verifier couldn't classify findings.
//
// PRIVACY NOTE: these debug logs may contain excerpts of the scanned code
// (candidate descriptions, file paths, agent summaries, audit-trail inputs).
// Even after sanitizeForDebugLog() redacts the common secret patterns below,
// they can still hold proprietary source snippets and should be treated as
// sensitive. Do not attach them to public issues, paste them into chat, or
// share them outside the machine that ran the scan. They auto-expire after
// DEBUG_LOG_TTL_DAYS (see pruneOldDebugLogs).
const DEBUG_DIR = path.join(os.homedir(), 'Ghost Architect Reports', '.debug');
const DEBUG_LOG_TTL_DAYS = 7;

// Redact common secret shapes from a single string before it lands on disk.
// Best-effort defense in depth — not a guarantee. Ordered most-specific first
// so known token formats are caught before the generic key=value sweep.
function redactSecretsInString(str) {
  let s = str;

  // Provider / VCS / cloud token formats (whole token replaced).
  s = s.replace(/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '<redacted-key>');     // Anthropic
  s = s.replace(/\bsk-[A-Za-z0-9]{20,}/g,        '<redacted-key>');     // OpenAI-style
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<redacted-key>');     // GitHub PAT
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g,         '<redacted-key>');     // AWS access key
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '<redacted-key>');   // Slack
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<redacted-jwt>'); // JWT

  // Connection strings: scheme://user:pass@host — drop the credentials.
  s = s.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@\s/]+):([^@\s/]+)@/g, '$1<redacted>:<redacted>@');

  // Generic secret assignments: password=…, api_key: "…", token => …
  s = s.replace(
    /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth|authorization|client[_-]?secret)(\s*["']?\s*[:=]+\s*["']?)([^\s"',;)}\]]+)/gi,
    '$1$2<redacted>'
  );

  // Filesystem paths that leak a username.
  s = s.replace(/(\/Users\/|\/home\/)([^/\s"':;,)}\]]+)/g, '$1<user>');         // macOS / Linux
  s = s.replace(/([A-Za-z]:\\Users\\)([^\\/\s"':;,)}\]]+)/g, '$1<user>');        // Windows

  return s;
}

// Recursively sanitize an arbitrary debug payload (objects, arrays, strings)
// so secrets and usernames never reach disk. Non-string scalars pass through.
// Exported for testing (see tests/verifier-debug-sanitize.smoke.mjs).
export function sanitizeForDebugLog(value) {
  if (typeof value === 'string') return redactSecretsInString(value);
  if (Array.isArray(value))      return value.map(sanitizeForDebugLog);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeForDebugLog(v);
    return out;
  }
  return value;
}

// TTL policy: delete debug logs older than DEBUG_LOG_TTL_DAYS. Called once per
// scan so the .debug/ directory never accumulates stale, sensitive payloads.
// Exported so non-verifier scan paths (e.g. the narrator patcher) can enforce
// the same TTL on patcher-only runs that never invoke the verifier.
export function pruneOldDebugLogs() {
  try {
    if (!fs.existsSync(DEBUG_DIR)) return;
    const cutoff = Date.now() - DEBUG_LOG_TTL_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(DEBUG_DIR)) {
      const file = path.join(DEBUG_DIR, entry);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        // Skip files we can't stat/remove — never let cleanup fail the scan.
      }
    }
  } catch {
    // Never let TTL cleanup fail the verifier.
  }
}

function writeVerifierDebugLog(name, payload) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(DEBUG_DIR, `conflict-verifier-${ts}-${name}.json`);
    fs.writeFileSync(file, JSON.stringify(sanitizeForDebugLog(payload), null, 2), 'utf8');
    return file;
  } catch {
    return null;  // Never let debug logging fail the verifier.
  }
}

// ── Verdict types ─────────────────────────────────────────────────────────────

export const Verdict = {
  CONFIRMED:      'CONFIRMED',       // Definite conflict — include in report
  POSSIBLE:       'POSSIBLE',        // Likely conflict but needs human review
  FALSE_POSITIVE: 'FALSE_POSITIVE',  // Not actually a conflict — drop from report
  INSUFFICIENT:   'INSUFFICIENT',    // Not enough data to determine — surface with caveat
};

// ── Single conflict verification ──────────────────────────────────────────────

async function verifyOne(candidate, fileMap, callbacks = {}) {
  const { onVerifying } = callbacks;

  if (onVerifying) onVerifying({ candidate });

  // Each verification gets its own mini memory and tools
  const memory = new AgentMemory();
  const tools  = buildTools(fileMap, memory);

  // Build a targeted verification task. When candidate.files is empty (the
  // model didn't write a structured Files: line for this conflict, or the
  // parser couldn't extract one), the agent has nothing to anchor on. Give
  // it explicit instructions to start by mapping the codebase so it doesn't
  // burn its first step asking "where do I look?"
  const filesList = (candidate.files || []).filter(Boolean);
  const filesGuidance = filesList.length > 0
    ? `Files involved: ${filesList.join(', ')}`
    : `Files involved: (not specified — use listDirectory and searchFiles to locate the relevant files based on the description)`;

  const task = `Verify whether this is a REAL conflict or a false positive.

CANDIDATE CONFLICT:
Type: ${candidate.type || 'unknown'}
Severity: ${candidate.severity || 'unknown'}
${filesGuidance}
Description: ${candidate.description || candidate.title || 'No description'}

YOUR JOB:
1. Use the tools to examine the files involved (or locate them if not specified)
2. Check: Are both sides actually active? Same scope/context? Correct sort order?
3. Look for conditions, guards, or scope limits that might prevent the conflict
4. Conclude with flagFinding (if CONFIRMED or POSSIBLE) then finish

Verification criteria:
- CONFIRMED: The conflict will definitely manifest in normal usage
- POSSIBLE: The conflict could manifest under certain conditions
- FALSE_POSITIVE: There is no real conflict (e.g., one side is disabled, different scope, correct sort order)

Flag the finding if CONFIRMED or POSSIBLE. Then call finish with your verdict in the summary.
Use your verification budget efficiently — you have a limited number of steps before you must finish.`;

  // Run mini loop. We give the verifier 5 steps because a typical conflict
  // verification needs: (1) listDirectory to map the codebase, (2) readFile
  // for the suspected file(s), (3) searchFiles to find related callers, plus
  // (4) flagFinding and (5) finish. Three steps was too tight — the agent
  // would burn all its budget on context-gathering and never reach the
  // verdict-producing actions, falling through to INSUFFICIENT.
  const result = await runMiniLoop(task, tools, memory, 5, { onUsage: callbacks.onUsage });

  // Determine verdict from what the agent did
  let verdict    = Verdict.INSUFFICIENT;
  let evidence   = '';
  let confidence = 50;

  if (result.findings.length > 0) {
    // Agent flagged a finding — it's confirmed or possible
    const finding = result.findings[0];
    // Number.isFinite, not `||`. Two distinct reasons:
    //   1. flagFinding now records confidence: null when the model omitted it.
    //      Unstated confidence must fall to 75 and land in POSSIBLE, never be
    //      promoted to CONFIRMED by a tool-layer default of 90.
    //   2. `||` also swallowed a legitimate confidence of 0, silently rewriting
    //      the model's least-confident possible answer as 75.
    confidence    = Number.isFinite(finding.confidence) ? finding.confidence : 75;
    evidence      = finding.detail || '';
    verdict       = confidence >= 80 ? Verdict.CONFIRMED : Verdict.POSSIBLE;
  } else {
    // Agent didn't flag anything — inspect the finish summary for verdict.
    // The regex set is deliberately broad: real model outputs use a wide
    // variety of phrasings beyond the obvious keywords. Order matters —
    // FALSE_POSITIVE patterns are checked first so a summary like "this
    // is not a conflict, although it could matter under load" is correctly
    // classified as FALSE_POSITIVE rather than getting picked up by the
    // POSSIBLE catch-all.
    const finishAction = result.auditTrail?.find(a => a.action === 'finish');
    const summary      = finishAction?.result?.summary || finishAction?.resultSummary || '';

    // Step-cap detection. When the loop hits its step cap, loop.js synthesizes
    // a finish action with reason='step_cap' and summary='Step cap of N
    // reached'. That summary text doesn't match any verdict regex, so without
    // special handling the verifier falls through to INSUFFICIENT — even
    // when the agent was making productive progress (read files, found
    // matches). If the agent did 2+ productive non-finish steps before being
    // capped, treat the candidate as POSSIBLE rather than INSUFFICIENT: the
    // agent was actively building evidence and just ran out of budget.
    const finishReason = finishAction?.input?.reason || finishAction?.result?.reason;
    const productiveSteps = (result.auditTrail || []).filter(a =>
      a.action !== 'finish' &&
      a.action !== 'parse_error' &&
      a.action !== 'api_error' &&
      a.action !== 'invalid_action'
    ).length;

    const FALSE_POSITIVE_RE = /false[\s.-]*positive|not\s+(?:a|an|actually|really)\s+(?:a\s+)?conflict|no\s+(?:actual|real)?\s*conflict|already\s+(?:fixed|resolved|implemented|in\s+place)|disabled|different\s+scope|does\s+not\s+(?:match|conflict|appear)|cannot\s+confirm.*conflict|safe\s+(?:as|because)|correctly\s+handled|properly\s+(?:scoped|isolated)/i;
    const CONFIRMED_RE      = /confirmed|definitely|will\s+(?:break|fail|cause|conflict)|definite\s+conflict|real\s+conflict|genuine\s+conflict|both\s+sides.*conflict|incompatible/i;
    const POSSIBLE_RE       = /possible|possibly|might|could|may|under\s+(?:certain|some|specific)\s+conditions?|in\s+some\s+cases|edge\s+case|potential\s+(?:conflict|issue)|partial(?:ly)?\s+(?:supported|true)/i;

    if (FALSE_POSITIVE_RE.test(summary)) {
      verdict    = Verdict.FALSE_POSITIVE;
      evidence   = summary;
      confidence = 85;
    } else if (CONFIRMED_RE.test(summary)) {
      verdict    = Verdict.CONFIRMED;
      evidence   = summary;
      confidence = 80;
    } else if (POSSIBLE_RE.test(summary)) {
      verdict    = Verdict.POSSIBLE;
      evidence   = summary;
      confidence = 60;
    } else if (finishReason === 'step_cap' && productiveSteps >= 2) {
      // Agent ran out of steps but was making progress. Surface as POSSIBLE
      // so it shows up in the report instead of being silently dropped.
      // result.filesAnalyzed is a count (memory.filesRead.size), not an array,
      // so we extract actual paths from the audit trail's readFile actions.
      const inspectedPaths = (result.auditTrail || [])
        .filter(a => a.action === 'readFile' && a.input?.path)
        .map(a => a.input.path);
      const inspectedSummary = inspectedPaths.length > 0
        ? inspectedPaths.join(', ')
        : '(none recorded)';
      verdict    = Verdict.POSSIBLE;
      evidence   = `Agent ran out of verification steps after ${productiveSteps} productive actions. Inspected files: ${inspectedSummary}. Manual review recommended.`;
      confidence = 50;
    } else {
      verdict    = Verdict.INSUFFICIENT;
      evidence   = summary || 'Verification inconclusive';
      confidence = 40;
      // Diagnostic log: when we hit INSUFFICIENT, record the candidate and
      // the agent's actual summary so future bug investigation has data
      // instead of the current black hole. Disable via
      // GHOST_VERIFIER_DEBUG=0 to avoid disk writes in performance runs.
      if (process.env.GHOST_VERIFIER_DEBUG !== '0') {
        writeVerifierDebugLog('insufficient', {
          timestamp:  new Date().toISOString(),
          candidate: {
            title:       candidate.title,
            description: candidate.description,
            severity:    candidate.severity,
            files:       candidate.files,
            type:        candidate.type,
          },
          agentRanSteps:    result.stepCount,
          agentFlagged:     result.findings.length,
          finishSummary:    summary,
          finishSummaryLen: summary.length,
          finishReason,
          productiveSteps,
          auditTrail:       (result.auditTrail || []).map(a => ({
            action:     a.action,
            input:      typeof a.input === 'string' ? a.input.slice(0, 200) : a.input,
            resultPreview: typeof a.result === 'string'
              ? a.result.slice(0, 200)
              : (a.result?.summary || JSON.stringify(a.result || {}).slice(0, 200)),
          })),
        });
      }
    }
  }

  const verified = {
    ...candidate,
    verdict,
    evidence,
    confidence,
    stepsUsed:   result.stepCount,
    filesChecked: result.filesAnalyzed,
    auditTrail:  result.auditTrail,
  };

  // onVerified is deliberately NOT emitted here. verifyConflicts (the only
  // caller) emits it once per candidate after normalization, for both quick
  // and full modes; emitting here too printed every full-mode verdict line
  // twice in the CLI (Audit 8, finding 2.6).
  return verified;
}

// ── Batch verification ────────────────────────────────────────────────────────
/**
 * Verify a batch of conflict candidates.
 * Runs verifications sequentially to avoid overwhelming the API.
 *
 * @param {array}   candidates  — array of { type, severity, files, description }
 * @param {object}  fileMap     — loaded file map
 * @param {object}  callbacks   — { onVerifying, onVerified, onProgress }
 * @returns {object}            — { confirmed, possible, falsePositives, insufficient, all }
 */
export async function verifyConflicts(candidates, fileMap, callbacks = {}, mode = 'full', tier = 'open') {
  const { onProgress, onUsage } = callbacks;
  const results = [];

  // Expire stale debug logs once per scan before any new ones are written.
  pruneOldDebugLogs();

  for (let i = 0; i < candidates.length; i++) {
    if (onProgress) onProgress({ current: i + 1, total: candidates.length });

    const verified = mode === 'quick'
      ? await quickVerify(candidates[i], fileMap, tier, onUsage)
      : await verifyOne(candidates[i], fileMap, { ...callbacks });

    // Normalize quickVerify verdict to match verifyOne output
    if (mode === 'quick' && verified.verdict === 'INSUFFICIENT') {
      verified.verdict = Verdict.INSUFFICIENT;
    }

    // Emit onVerified for CLI display
    if (callbacks.onVerified) callbacks.onVerified({ verified });

    results.push(verified);
  }

  // Partition by verdict
  const confirmed      = results.filter(r => r.verdict === Verdict.CONFIRMED);
  const possible       = results.filter(r => r.verdict === Verdict.POSSIBLE);
  const falsePositives = results.filter(r => r.verdict === Verdict.FALSE_POSITIVE);
  const insufficient   = results.filter(r => r.verdict === Verdict.INSUFFICIENT);

  return {
    confirmed,
    possible,
    falsePositives,
    insufficient,
    all: results,
    stats: {
      total:         candidates.length,
      confirmed:     confirmed.length,
      possible:      possible.length,
      falsePositives: falsePositives.length,
      insufficient:  insufficient.length,
      eliminated:    falsePositives.length,
      surfaced:      confirmed.length + possible.length,
    },
  };
}

// ── Quick single-call verification (cheaper alternative) ─────────────────────
// For when you want to verify without a full agent loop — one Claude call

export async function quickVerify(candidate, fileMap, tier = 'open', onUsage = null) {
  const anthropic = getClient();

  // First try to look up only the files the candidate cited. This is the
  // common case and saves tokens.
  let fileContents = (candidate.files || [])
    .filter(f => fileMap[f])
    .map(f => `=== ${f} ===\n${fileMap[f].slice(0, 1000)}`)
    .join('\n\n');

  // Fallback: when the candidate has no files, an empty file list, or none
  // of the cited files match the fileMap, give the verifier the full project
  // map up to a fixed token budget so it can still make a determination.
  // Without this fallback, the verifier returns INSUFFICIENT for every
  // candidate whose Files: line was missing or unparseable from the model's
  // pass output — which is the 0/0/0 verification failure mode we hit in
  // v0.4 testing.
  //
  // Stage 3 tier gate: the fallback consumes ~5K extra tokens per ambiguous
  // verification. That's a real cost. Gate behind requireTier so Open users
  // get the cheaper INSUFFICIENT verdict (matching pre-fallback behavior),
  // and trial/Pro/Team/Enterprise get the fallback they're paying for. The
  // gate is silent (no callout from this layer — verifier is deep in a
  // per-candidate loop; surfacing an upsell from here would require
  // plumbing callbacks down). A mode-layer callout (when INSUFFICIENT-count
  // crosses threshold on Open scans) is the right architectural layer for
  // surfacing this in a future cycle. See TODO-verifier-agent-stage3-evaluate.md.
  if (!fileContents) {
    const fallbackGate = requireTier('feature:verifier-fallback', { tier });
    if (fallbackGate.allowed) {
      const BUDGET_CHARS = 20000; // ~5K tokens of context. Quick mode stays cheap.
      const entries = Object.entries(fileMap);
      let acc = '';
      let used = 0;
      for (const [path, content] of entries) {
        const slice = content.slice(0, 600);
        const block = '=== ' + path + ' ===\n' + slice + '\n\n';
        if (used + block.length > BUDGET_CHARS) break;
        acc += block;
        used += block.length;
      }
      fileContents = acc.trim();
    }
  }

  if (!fileContents) {
    return {
      ...candidate,
      verdict:    Verdict.INSUFFICIENT,
      evidence:   'Files not available for verification',
      confidence: 0,
    };
  }

  const prompt = `Is this a real conflict or a false positive?

CONFLICT CANDIDATE:
${JSON.stringify(candidate, null, 2)}

RELEVANT FILE EXCERPTS:
${fileContents}

Respond with JSON only:
{
  "verdict": "CONFIRMED|POSSIBLE|FALSE_POSITIVE",
  "confidence": 0-100,
  "evidence": "one sentence explanation"
}`;

  try {
    const response = await anthropic.messages.create({
      model:      getModel(),
      max_tokens: 256,
      ...getSamplingParams(0, getModel()),
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw    = response.content[0]?.text || '{}';
    // Capture usage for cost tracking
    if (onUsage && response.usage) {
      onUsage(
        response.usage.input_tokens  ?? 0,
        response.usage.output_tokens ?? 0,
        getModel()
      );
    }
    const clean  = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);

    // Validate the verdict against the enum. verifyConflicts partitions with
    // strict === against the four Verdict values, so an off-enum string the
    // model invented ("LIKELY_CONFLICT", "TRUE_POSITIVE", lowercase variants)
    // used to land in NO bucket: counted in stats.total, absent from every
    // report section, gone without a trace (Audit 7, finding 3.7). Normalize
    // case, then map anything unrecognized to INSUFFICIENT (surfaced with a
    // caveat, never silently dropped).
    const normalizedVerdict = typeof parsed.verdict === 'string'
      ? parsed.verdict.trim().toUpperCase()
      : '';
    const verdict = Object.prototype.hasOwnProperty.call(Verdict, normalizedVerdict)
      ? Verdict[normalizedVerdict]
      : Verdict.INSUFFICIENT;

    return {
      ...candidate,
      verdict,
      // Number.isFinite, not ||: a legitimate confidence of 0 is the model's
      // least-confident possible answer and must not be rewritten as 50 (same
      // bug class fixed in verifyOne in v10.0.17).
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 50,
      evidence:   parsed.evidence   || '',
      method:     'quick',
    };
  } catch (err) {
    // Diagnostic log: capture the raw model response on parse failure so we
    // can see WHY the JSON didn't parse (truncation, prose preamble, etc.).
    if (process.env.GHOST_VERIFIER_DEBUG !== '0') {
      writeVerifierDebugLog('quick-parse-fail', {
        timestamp:    new Date().toISOString(),
        candidate: {
          title:    candidate.title,
          severity: candidate.severity,
          files:    candidate.files,
        },
        error:        err.message,
        // We can't access `raw` here — it's scoped inside the try. Re-call
        // would double the cost. Future improvement: hoist `raw` out of try.
      });
    }
    return {
      ...candidate,
      verdict:    Verdict.INSUFFICIENT,
      evidence:   'Quick verification failed: ' + err.message,
      confidence: 0,
      method:     'quick',
    };
  }
}
