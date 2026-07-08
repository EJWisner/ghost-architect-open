/**
 * Ghost Architect — Core Multi-Pass Scanner
 * Pure scanning logic. No Chalk. No Inquirer. Returns data, emits events via callbacks.
 *
 * v4.4: Narrator wired into final synthesis — report written as senior architect,
 * not raw template output. Existing pass pipeline and session management unchanged.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { getConfig, resolveApiKey } from '../config.js';
import { buildSystemPOI } from '../../prompts/index.js';
import { prioritizeFileMap, getTopFiles } from '../prioritizer.js';
import { narrateReport, scrubEmptyHeaders } from './agent/narrator.js';
import { extractFindings as extractFindingsFromReport } from '../utils/finding-parser.js';
import { isContextOverflow } from '../utils/errors.js';
import { verifyReport, formatVerifierReport } from './verifier.js';
import { createLLMVerifier } from './llm-verifier.js';
import { recordUsage } from './usage-tracker.js';
import { mergeRates } from '../profile/index.js';

const PASS_TOKEN_LIMIT = 45000;
const MERGE_BATCH_SIZE = 6;
const DEFAULT_PASS_CAP = 20;
const SESSIONS_DIR     = path.join(os.homedir(), 'Ghost Architect Reports', 'sessions');

// ── Session management ────────────────────────────────────────────────────────

function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionFilePath(label) {
  const safe = (label || 'default').replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
  return path.join(SESSIONS_DIR, `ghost-session-${safe}.json`);
}

// Fallback session location, used when the primary Reports volume is
// unwritable (full disk, permission flip, transient mount loss). persistSession
// writes here as a last resort and loadSession reads it back, so a scan that
// could only checkpoint to the fallback is still resumable.
const ALT_SESSIONS_DIR = path.join(os.tmpdir(), 'ghost-architect-sessions');

// Backoff between save retries, in seconds. Exponential-ish: a transient
// filesystem hiccup (brief lock, momentary ENOSPC during another process's
// flush) usually clears within a second or two.
const SESSION_SAVE_BACKOFF_SEC = [0.1, 0.4, 1.2];

function alternateSessionFilePath(label) {
  const safe = (label || 'default').replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
  return path.join(ALT_SESSIONS_DIR, `ghost-session-${safe}.json`);
}

// Read one session file with .bak fallback. Returns an object that
// distinguishes the two failure modes the caller must treat differently:
//
//   { session, reason: 'ok' }         — parsed successfully (from main or .bak)
//   { session: null, reason: 'absent' }    — no session file here at all
//   { session: null, reason: 'corrupted' } — file present but it AND its backup
//                                            failed to parse
//
// The distinction matters: an absent file means "no scan was ever checkpointed
// here" (normal), but a corrupted file means a real session existed and its
// resume state was just lost — the caller must warn loudly rather than silently
// behave as if nothing was there. On corruption we also surface `details` so
// the caller can log the underlying parse errors for post-mortem.
function readSessionFile(finalPath) {
  const bakPath = finalPath + '.bak';
  if (!fs.existsSync(finalPath)) {
    return { session: null, reason: 'absent' };
  }
  try {
    return { session: JSON.parse(fs.readFileSync(finalPath, 'utf8')), reason: 'ok' };
  } catch (mainErr) {
    // Main file corrupted — try backup
    if (fs.existsSync(bakPath)) {
      try {
        const session = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
        // Restore backup as main file
        fs.copyFileSync(bakPath, finalPath);
        return { session, reason: 'ok' };
      } catch (bakErr) {
        return {
          session: null,
          reason: 'corrupted',
          details: { path: finalPath, mainError: mainErr.message, bakPath, bakError: bakErr.message },
        };
      }
    }
    return {
      session: null,
      reason: 'corrupted',
      details: { path: finalPath, mainError: mainErr.message, bakPath, bakError: 'backup absent' },
    };
  }
}

// Append a session-corruption event to the debug directory for post-mortem
// diagnosis. Best-effort: if even the debug log can't be written, there is
// nothing more we can do, so swallow that secondary failure.
function logSessionCorruption(label, results, salvaged) {
  try {
    const debugDir = path.join(os.homedir(), 'Ghost Architect Reports', '.debug');
    fs.mkdirSync(debugDir, { recursive: true });
    const logPath = path.join(debugDir, 'session-corruption.log');
    const lines = results
      .filter(r => r && r.reason === 'corrupted' && r.details)
      .map(r =>
        `    file:   ${r.details.path}\n` +
        `      main error:  ${r.details.mainError}\n` +
        `      backup:      ${r.details.bakPath}\n` +
        `      backup error:${r.details.bakError}`
      )
      .join('\n');
    const salvageLine = salvaged
      ? `  salvaged ${salvaged.completedPassCount} completed pass(es) from checkpoint sidecar`
      : `  no usable checkpoint sidecar found — session restarted from pass 0`;
    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] Session corruption for "${label}":\n${lines}\n${salvageLine}\n`
    );
  } catch { /* debug logging is best-effort — never throw from here */ }
}

// Best-effort reconstruction of a resumable session from the .checkpoints/
// sidecar when the primary session file is corrupted. The checkpoint writer
// (writeCheckpoint) stores the full passResults array per project label, so we
// scan the .checkpoints directory for any checkpoint file belonging to this
// label, pick the freshest one that still has completed passes, and rebuild a
// session object the resume path can drive. Returns the reconstructed session,
// or null when no usable checkpoint exists.
function salvageSessionFromCheckpoints(label) {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const dir  = path.join(home, 'Ghost Architect Reports', '.checkpoints');
    if (!fs.existsSync(dir)) return null;

    const safe = (label || 'unnamed').replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
    const candidates = fs.readdirSync(dir).filter(f =>
      f.endsWith('.checkpoint.json') && f.toLowerCase().startsWith(safe)
    );
    if (candidates.length === 0) return null;

    let best = null;
    for (const f of candidates) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!Array.isArray(data.passResults) || data.passResults.length === 0) continue;
        if (!best || (data.timestamp || 0) > (best.timestamp || 0)) best = data;
      } catch { /* skip an unreadable checkpoint — keep scanning the rest */ }
    }
    if (!best) return null;

    // Rebuild a session shaped like the runner's own. We place every recovered
    // pass into pendingPassResults (not mergedGroups): the checkpoint only
    // stores a flat passResults array, so we can't reconstruct the original
    // merged/pending split — but synthesis merges pendingPassResults anyway,
    // so funneling everything there is lossless for the final report.
    const completedPassCount = best.completedPass || best.passResults.length;
    return {
      projectLabel:       label,
      startedAt:          best.timestamp ? new Date(best.timestamp).toISOString() : new Date().toISOString(),
      totalFiles:         best.totalFiles || 0,
      totalPassCount:     best.totalPasses || completedPassCount,
      completedPassCount,
      mergedGroups:       [],
      pendingPassResults: best.passResults,
      passSkeletons:      [],
      salvagedFromCheckpoint: true,
    };
  } catch {
    return null;
  }
}

export function loadSession(label) {
  // Primary location first, then the OS-temp fallback that persistSession's
  // retry path writes to when the Reports volume can't be written.
  const primary = readSessionFile(sessionFilePath(label));
  if (primary.session) return primary.session;

  const alternate = readSessionFile(alternateSessionFilePath(label));
  if (alternate.session) return alternate.session;

  // Neither location yielded a session. If either file was corrupted (rather
  // than simply absent), a real scan's resume state was just lost. Silently
  // returning null here would make the runner restart from pass 0 with no
  // explanation — burning hours of API quota the user already paid for. Warn
  // loudly, log the event, and try to salvage partial progress from the
  // checkpoint sidecar before giving up.
  const corrupted = primary.reason === 'corrupted' || alternate.reason === 'corrupted';
  if (!corrupted) return null;

  const salvaged = salvageSessionFromCheckpoints(label);
  logSessionCorruption(label, [primary, alternate], salvaged);

  if (salvaged) {
    process.stderr.write(chalk.yellow(
      `\n  ⚠  Session checkpoint is corrupted, but ${salvaged.completedPassCount} completed pass(es) were\n` +
      `     recovered from the checkpoint sidecar. Resuming from recovered state.\n`
    ));
    return salvaged;
  }

  process.stderr.write(chalk.red(
    `\n  ⚠  Session checkpoint is corrupted — starting fresh. Prior progress was lost.\n` +
    `     Details logged to ~/Ghost Architect Reports/.debug/session-corruption.log\n`
  ));
  return null;
}

// Append session-save failure details to the debug directory for post-mortem
// diagnosis. Best-effort: if even the debug log can't be written, there is
// nothing more we can do, so swallow that secondary failure.
function logSessionSaveFailure(label, attempts) {
  try {
    const debugDir = path.join(os.homedir(), 'Ghost Architect Reports', '.debug');
    fs.mkdirSync(debugDir, { recursive: true });
    const logPath = path.join(debugDir, 'session-save-errors.log');
    const lines = attempts
      .map((a, i) => `    attempt ${i + 1}: ${a.path} -> ${a.message}`)
      .join('\n');
    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] Session save FAILED for "${label}" after ${attempts.length} attempt(s):\n${lines}\n`
    );
  } catch { /* debug logging is best-effort — never throw from here */ }
}

// Write a single session file. When `atomic` is true (the default), write to a
// .tmp sibling, back up any existing file to .bak, then rename into place so a
// crash mid-write can never corrupt the live session. Throws on any failure.
function writeSessionFile(targetPath, session, atomic = true) {
  const payload = JSON.stringify(session, null, 2);
  if (!atomic) {
    fs.writeFileSync(targetPath, payload);
    return;
  }
  const tmpPath = targetPath + '.tmp';
  const bakPath = targetPath + '.bak';
  try {
    fs.writeFileSync(tmpPath, payload);
    if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, bakPath);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
    throw err;
  }
}

/**
 * Persist a session durably, or throw. This is the resilient path used by the
 * long-running multi-pass runner, where a silently-dropped checkpoint turns a
 * multi-hour scan into unresumable wasted API quota.
 *
 * Strategy, in order, with exponential backoff between attempts:
 *   1. atomic write to the primary sessions dir
 *   2. atomic write to the primary sessions dir (retry the transient hiccup)
 *   3. atomic write to the OS-temp fallback dir (in case the Reports volume
 *      itself is the problem)
 *
 * On total failure it logs every attempt's error to the debug directory and
 * throws an Error tagged `code: 'SESSION_SAVE_FAILED'` so callers can decide
 * whether to continue with a prominent warning or abort. Returns the path the
 * session was written to on success.
 *
 * Note: the exported saveSession() below stays non-throwing (boolean) for
 * backward compatibility with callers that invoke it synchronously without a
 * try/catch (e.g. the conflict scanner); this throwing variant is what the
 * multi-pass runner uses.
 */
export async function persistSession(label, session) {
  ensureSessionsDir();
  const primary   = sessionFilePath(label);
  const alternate = alternateSessionFilePath(label);
  const strategies = [
    { path: primary,   atomic: true },
    { path: primary,   atomic: true },
    { path: alternate, atomic: true },
  ];

  const attempts = [];
  for (let i = 0; i < strategies.length; i++) {
    const { path: targetPath, atomic } = strategies[i];
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      writeSessionFile(targetPath, session, atomic);
      if (targetPath === alternate) {
        process.stdout.write(chalk.yellow(
          `\n  ⚠  Saved resume checkpoint to fallback location: ${alternate}\n` +
          `     (primary sessions directory was unwritable — resume will still find it)\n`
        ));
      }
      return targetPath;
    } catch (err) {
      attempts.push({ path: targetPath, message: err.message });
      const backoff = SESSION_SAVE_BACKOFF_SEC[i];
      if (i < strategies.length - 1 && backoff) await sleep(backoff);
    }
  }

  logSessionSaveFailure(label, attempts);
  const failure = new Error(
    `Could not persist session "${label}" after ${attempts.length} attempts: ` +
    attempts.map(a => `${a.path} (${a.message})`).join('; ')
  );
  failure.code = 'SESSION_SAVE_FAILED';
  failure.attempts = attempts;
  throw failure;
}

export function saveSession(label, session) {
  ensureSessionsDir();
  const finalPath = sessionFilePath(label);
  try {
    writeSessionFile(finalPath, session, true);
    return true;
  } catch (err) {
    logSessionSaveFailure(label, [{ path: finalPath, message: err.message }]);
    // Finding 6: warn user that session save failed
    process.stdout.write(`\n  ⚠ Progress checkpoint failed to save — resume may not work (${err.message})\n`);
    return false;
  }
}

export function deleteSession(label) {
  const p = sessionFilePath(label);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function listSessions() {
  ensureSessionsDir();
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.startsWith('ghost-session-') && f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

// ── Pass builder ──────────────────────────────────────────────────────────────

export function buildPasses(fileMap) {
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

export function getPassInfo(fileMap) {
  const passes     = buildPasses(fileMap);
  const topFiles   = getTopFiles(fileMap, 5);
  const totalFiles = Object.keys(fileMap).length;
  const remaining  = passes.length;
  const estCost    = (remaining * 0.25).toFixed(2);
  const estMinutes = Math.max(3, Math.round(remaining * 3.5));
  return { passes, topFiles, totalFiles, remaining, estCost, estMinutes, defaultCap: Math.min(DEFAULT_PASS_CAP, remaining) };
}

// ── Cross-pass skeleton extraction ───────────────────────────────────────────
// DISABLED as of April 22 2026: The skeleton compression (max 40 lines, kept
// only last 3 passes) produced such a thin view of prior findings that it
// encouraged later passes to hallucinate details to fill gaps. Each pass now
// stands alone; the merge stage handles duplicate detection instead.
//
// Keeping the function signature as a no-op so callers don't break; the
// passSkeletons array stays empty and contributes nothing to later passes.

function extractSkeleton(_passResult) {
  return '';
}

// ── Claude API ────────────────────────────────────────────────────────────────


// ── Retry / resilience helpers ────────────────────────────────────────────────
const OVERLOAD_RETRY_DELAYS = [15, 30, 60]; // seconds between retries
const PASS_TIMEOUT_MS       = 8 * 60 * 1000; // 8 minutes — warn if exceeded

function sleep(s) { return new Promise(r => setTimeout(r, s * 1000)); }

function isOverloadErr(err) {
  const msg = err?.message || '';
  return err?.status === 529 || msg.includes('529') || msg.includes('overloaded');
}

function isRateLimitErr(err) {
  const msg = err?.message || '';
  return err?.status === 429 || msg.includes('429') || msg.includes('rate_limit');
}

function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-6'; }
function getRates()  {
  const cfg = getConfig();
  return { junior: cfg.get('rateJunior') || 85, mid: cfg.get('rateMid') || 125, senior: cfg.get('rateSenior') || 200 };
}

// Delegate to the canonical, tested context-overflow detector
// (src/utils/errors.js, covered by tests/error-classification.smoke.mjs).
//
// We deliberately match on the error MESSAGE, not on `status === 400` alone.
// A bare 400 also fires for malformed requests, invalid models, bad
// parameters, and billing/usage-limit errors. The old code returned true for
// ANY 400, so those were misclassified as "context limit exceeded" — which
// tells the user to scan a subfolder and skips the retry that would have
// succeeded. isContextOverflow requires the message to actually name a
// context-length problem (prompt too long, maximum context, context window,
// too many tokens, exceed context limit) and still catches genuine context
// errors that arrive without a status (the non-400 path).
function isContextLimitErr(err) {
  return isContextOverflow(err);
}

async function callClaudeRaw(prompt, system, maxTokens = 8096) {
  const anthropic = getClient();
  let result = '';
  let activeStream = null;

  // Timeout warning — if no response after PASS_TIMEOUT_MS, warn user
  const timeoutHandle = setTimeout(() => {
    process.stdout.write(chalk.yellow('\n  ⚠  Pass is taking longer than expected — API may be slow. Still waiting...\n'));
  }, PASS_TIMEOUT_MS);

  try {
    activeStream = anthropic.messages.stream({
      model: getModel(), max_tokens: maxTokens, temperature: 0.3, system,
      messages: [{ role: 'user', content: prompt }]
    });
    for await (const chunk of activeStream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        result += chunk.delta.text;
      }
    }
    // Record REAL token usage so the cost report reflects the actual API bill.
    // Every multi-pass scan pass, the synthesis call, and the follow-up merges
    // route through here, so this one capture covers all callClaude traffic.
    // Best-effort: a usage-capture hiccup must never fail a scan.
    try {
      const finalMsg = await activeStream.finalMessage();
      if (finalMsg?.usage) {
        recordUsage(finalMsg.usage.input_tokens ?? 0, finalMsg.usage.output_tokens ?? 0);
      }
    } catch { /* usage capture is best-effort */ }
  } catch (err) {
    // Abort stream cleanly before rethrowing — prevents orphaned background processes
    if (activeStream) {
      try { activeStream.abort(); } catch (e) { /* ignore abort errors */ }
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    activeStream = null;
  }
  return result;
}

async function callClaude(prompt, system, maxTokens = 8096) {
  for (let attempt = 0; attempt <= OVERLOAD_RETRY_DELAYS.length; attempt++) {
    try {
      return await callClaudeRaw(prompt, system, maxTokens);
    } catch (err) {
      const isLast = attempt === OVERLOAD_RETRY_DELAYS.length;

      // Context limit — never retry, give clean message
      if (isContextLimitErr(err)) {
        process.stdout.write(chalk.yellow('\n  ⚠  This pass exceeds the API context limit. The file is too large for a single pass.\n'));
        process.stdout.write(chalk.gray('  Tip: Try scanning a subfolder or ZIP of specific modules rather than the full repo.\n\n'));
        throw err;
      }

      // Overload or rate limit — retry with backoff
      if (isOverloadErr(err) || isRateLimitErr(err)) {
        if (isLast) throw err;
        const wait = OVERLOAD_RETRY_DELAYS[attempt];
        process.stdout.write(chalk.yellow(`\n  ⏳ API overloaded — waiting ${wait}s and retrying (attempt ${attempt + 1}/${OVERLOAD_RETRY_DELAYS.length})...\n`));
        await sleep(wait);
        process.stdout.write(chalk.gray('  Retrying...\n'));
        continue;
      }

      // Any other error — retry once, then give up
      if (!isLast && attempt === 0) {
        process.stdout.write(chalk.yellow(`\n  ⏳ Pass failed — waiting 10s and retrying...\n`));
        await sleep(10);
        continue;
      }

      throw err;
    }
  }
}


// ── Checkpoint helpers ────────────────────────────────────────────────────────
function getCheckpointPath(projectLabel) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir  = path.join(home, 'Ghost Architect Reports', '.checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  const safe = (projectLabel || 'unnamed').replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
  return path.join(dir, `${safe}.checkpoint.json`);
}

export function writeCheckpoint(projectLabel, passNum, totalPasses, passResults) {
  try {
    const cpPath = getCheckpointPath(projectLabel);
    const data = {
      projectLabel,
      completedPass: passNum,
      totalPasses,
      passResults,
      timestamp: Date.now(),
    };
    fs.writeFileSync(cpPath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    // Finding 6: log checkpoint failures instead of silently swallowing them
    try {
      const logDir  = path.join(process.env.HOME || process.env.USERPROFILE || '', 'Ghost Architect Reports', '.checkpoints');
      const logPath = path.join(logDir, '.ghost-errors.log');
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] Checkpoint write failed for ${projectLabel}: ${e.message}\n`);
    } catch { /* log write also failed — nothing we can do */ }
    return false;
  }
}

export function readCheckpoint(projectLabel) {
  try {
    const cpPath = getCheckpointPath(projectLabel);
    if (!fs.existsSync(cpPath)) return null;
    const data = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
    // Only valid if < 24 hours old and has at least one completed pass
    const ageHours = (Date.now() - data.timestamp) / (1000 * 60 * 60);
    if (ageHours > 24 || !data.passResults?.length) return null;
    return data;
  } catch (e) { return null; }
}

export function clearCheckpoint(projectLabel) {
  try {
    const cpPath = getCheckpointPath(projectLabel);
    if (fs.existsSync(cpPath)) fs.unlinkSync(cpPath);
  } catch (e) { /* non-fatal */ }
}

// ── Single pass ───────────────────────────────────────────────────────────────

async function runPass(pass, passNum, totalPasses, totalFiles, priorSkeletons, profile = null) {
  let context = '';
  for (const [fp, content] of Object.entries(pass.files)) {
    context += `\n\n=== FILE: ${fp} ===\n${content}`;
  }
  const skeletonContext = priorSkeletons.length > 0
    ? `\n\nCROSS-PASS CONTEXT (findings from prior passes — use to identify relationships):\n${priorSkeletons.join('\n---\n')}\n\n`
    : '';

  // Ghost Partner — reinforce the consultant lens in the user message too.
  // System prompt has the CONSULTANT CONTEXT block; this user-turn reminder
  // gives the model a second, shorter nudge right next to the code, which
  // empirically pulls stronger adherence to the profile's vocabulary.
  const profileReminder = profile
    ? `You are scanning on behalf of ${profile.author || 'the consultant'}. Apply their methodology as described in the CONSULTANT CONTEXT block of your system prompt — weight findings through their lens, name findings in their vocabulary, and organize findings around their priorities. Do not fabricate findings to match their priorities; apply them only where the code actually exhibits the pattern.\n\n`
    : '';

  return callClaude(
    `${profileReminder}This is pass ${passNum} of ${totalPasses} in a multi-pass analysis of a ${totalFiles}-file codebase.` +
    `${skeletonContext}` +
    `Analyze ONLY the files in this pass. Reference prior pass findings if you see related issues.\n\n` +
    `Files for this pass:\n${context}`,
    buildSystemPOI(mergeRates(getRates(), profile), profile)
  );
}

// ── Intermediate merge ────────────────────────────────────────────────────────

async function mergePassResults(results, label, profile = null) {
  const combined = results.map((r, i) =>
    `=== FINDINGS BATCH ${i + 1} (${r.fileCount} files) ===\n${r.findings}`
  ).join('\n\n');

  return callClaude(
    `Intermediate merge for project: ${label}\n\n` +
    `Merge these ${results.length} batches into condensed findings:\n` +
    `- Merge duplicates (keep most severe/detailed)\n` +
    `- Keep all unique findings\n` +
    `- Preserve severity, effort, and priority numbers\n` +
    `- Output must stay under 4,000 words\n` +
    `- Use Ghost Architect section format\n\n` +
    `BATCHES:\n${combined}\n\nMerged findings:`,
    buildSystemPOI(mergeRates(getRates(), profile), profile), 6000
  );
}

// ── Extract findings from merged text for narrator ────────────────────────────
//
// REMOVED April 24 2026: local extractFindingsForNarrator with regex
//   /^\d+\.\s+\*?\*?(.+?)\*?\*?$/
// matched both real findings ('1. **Title**') AND every fix-step bullet
// inside a finding ('1. Wrap atob in try/catch'). On the Ghost Mobile scan
// this turned ~10 real findings into 51-70 phantom 'findings' that flowed
// into the narrator, broke Pass 2's token budget, and forced the
// MAX_FINDINGS_FOR_PASS_2 cap to fire as a workaround. Now we use the
// shared parser in src/utils/finding-parser.js which splits on '### '
// headers (the actual finding marker) and ignores numbered fix steps.
//
// extractFindingsFromReport from finding-parser.js is the single source of
// truth for finding extraction. Imported at the top of this file.

// ── Final synthesis — with narrator ──────────────────────────────────────────

/**
 * Diagnostic dumper. Writes the report at a named pipeline stage to
 * ~/Ghost Architect Reports/.debug/ so we can diff stages and find where
 * content is being lost. Best-effort — never throws, never blocks the scan.
 *
 * Filename pattern: synthesis-<timestamp>-<stage>.md
 * The same `runId` is shared across all four stages of one scan so the
 * files cluster together in directory listings.
 *
 * Stages we write:
 *   1-after-narrator        — what narrateReport returned
 *   2-after-verifier        — after verifyReport's annotations
 *   3-after-scrub           — after scrubEmptyHeaders
 *   4-after-regen           — after exec-summary + risk-paragraph regeneration
 *
 * If a stage produces a report dramatically smaller than the previous
 * stage, we have the smoking gun for the truncation bug.
 */
function writeSynthesisStageDump(runId, stage, report, projectLabel) {
  try {
    const debugDir = path.join(os.homedir(), 'Ghost Architect Reports', '.debug');
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
    const safeLabel = (projectLabel || 'project').replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
    const filename = `synthesis-${runId}-${stage}-${safeLabel}.md`;
    const filepath = path.join(debugDir, filename);
    const header = `<!-- Synthesis stage dump
  Stage:     ${stage}
  Project:   ${projectLabel || '(none)'}
  Run ID:    ${runId}
  Length:    ${(report || '').length} chars
  Timestamp: ${new Date().toISOString()}
-->

`;
    fs.writeFileSync(filepath, header + (report || ''), 'utf8');
  } catch { /* never let logging break the scan */ }
}

async function synthesizeFinal(mergedGroups, totalFiles, completedPasses, totalPasses, coverage, onChunk, options = {}) {
  // Diagnostic run id — timestamps all four stage dumps in this scan so they
  // cluster together in directory listings. Filename-safe (no colons/dots).
  const runId = new Date().toISOString().replace(/[:.]/g, '-');

  const combined  = mergedGroups.map((r, i) => `=== MERGED GROUP ${i + 1} ===\n${r}`).join('\n\n');
  const rates     = mergeRates(getRates(), options.profile);

  // Ghost Partner — reinforce consultant lens in synthesis user message too.
  const profileReminder = options.profile
    ? `You are synthesizing on behalf of ${options.profile.author || 'the consultant'}. The final report must reflect their methodology as described in the CONSULTANT CONTEXT block of your system prompt — name findings in their vocabulary and organize the report around their priorities. Do not fabricate findings to match their priorities; apply them only where the findings below actually exhibit the pattern.\n\n`
    : '';

  // Step 1: Raw synthesis (produces structured findings). Routed through
  // callClaude (not a bare anthropic.messages.stream) so a transient 529 /
  // ECONNRESET / overload during the FINAL synthesis is retried with backoff
  // instead of discarding the whole report after an already-expensive
  // multi-pass scan. callClaude streams-and-accumulates exactly like the old
  // inline stream did, and the raw synthesis is not streamed to the user (only
  // the narrator step below streams via onChunk), so behavior is unchanged
  // apart from the added resilience. Temperature 0.3 (set inside callClaudeRaw)
  // matches the pass/merge calls for consistency.
  const synthesisPrompt =
    profileReminder +
    `Final synthesis: ${completedPasses} of ${totalPasses} passes complete.\n\n` +
    `Produce the final unified Points of Interest Report:\n` +
    `1. Merge remaining duplicates, rank by severity and business impact\n` +
    `2. Analysis was distributed across ${totalFiles} files in ${totalPasses} passes; ${completedPasses} passes completed.\n` +
    `3. Produce complete REMEDIATION SUMMARY with tiered rates:\n` +
    `   LOW complexity: ${rates.junior}/hr | MEDIUM: ${rates.mid}/hr | HIGH/CRITICAL: ${rates.senior}/hr\n` +
    `4. Use full Ghost Architect report format\n\n` +
    `GROUNDING: Only cite file paths, method names, line numbers, and code strings that appear verbatim in the findings below. If a detail is not in the source material, describe the issue in general terms.\n\n` +
    `FINDINGS:\n${combined}\n\nFinal report:`;
  const rawSynthesis = await callClaude(synthesisPrompt, buildSystemPOI(rates, options.profile), 8096);

  // Step 2: Narrator rewrites as senior architect (streaming to user)
  if (options.onNarratorStart) options.onNarratorStart();

  // Use the shared finding parser — splits on '### ' headers, ignores
  // numbered fix-step bullets that the previous local parser was matching
  // as if they were findings. This is what unblocks the upstream noise
  // that was forcing the narrator's MAX_FINDINGS_FOR_PASS_2 cap to fire.
  let findings = [];
  try {
    findings = extractFindingsFromReport(rawSynthesis);
  } catch { /* fall through to placeholder below */ }

  // Keep whatever findings actually parsed, even if there are only one or two.
  // Fall back to the raw-synthesis blob card ONLY when nothing parsed at all.
  // The old `>= 3` threshold discarded real findings and replaced them with a
  // single synthetic HIGH card, and findingCount then disagreed with the array
  // that was actually returned. findingCount now always matches the findings.
  let resultFindings;
  let actualFindingCount;
  if (findings.length > 0) {
    resultFindings = findings;
    actualFindingCount = findings.length;
  } else {
    // Last resort: nothing parsed, so surface the raw synthesis as a single
    // card so the narrator still has material to work from. It is one card.
    resultFindings = [{
      title: 'See full analysis below',
      severity: 'HIGH',
      detail: rawSynthesis.slice(0, 2000),
      files: [],
      confidence: 90,
    }];
    actualFindingCount = 1;
  }

  // Build memory result — raw synthesis passed through for the narrator.
  const memoryResult = {
    findings:      resultFindings,
    findingCount:  actualFindingCount,
    filesAnalyzed: totalFiles,
    stepCount:     completedPasses,
    auditTrail:    [],
    rawSynthesis,  // pass through so narrator can reference it directly
  };

  // Build enhanced narrator prompt that explicitly requires remediation table
  const narratorContext = {
    projectLabel: options.projectLabel || 'project',
    mode: 'poi',
    rates,
    requireRemediationTable: true,
    rawSynthesis: rawSynthesis.slice(0, 8000), // give narrator the raw text directly
    fileMap: options.fileMap,                  // source-ground the narrator against real code
    profile: options.profile,                  // Ghost Partner — consultant lens for narrator voice
  };

  const narratedReport = await narrateReport(
    memoryResult,
    narratorContext,
    onChunk
  );

  // Validate narrator produced a remediation table — if not, fall back to raw
  const hasTable = narratedReport && (
    narratedReport.includes('| Category |') ||
    narratedReport.includes('| Finding |') ||
    narratedReport.includes('Remediation Summary') ||
    narratedReport.includes('REMEDIATION')
  );

  let finalOutput;
  if (!hasTable && rawSynthesis.includes('Remediation')) {
    // Narrator dropped the table — append it from raw synthesis
    const remStart = rawSynthesis.indexOf('Remediation');
    const remSection = rawSynthesis.slice(remStart);
    finalOutput = (narratedReport || rawSynthesis) + '\n\n' + remSection;
  } else {
    finalOutput = narratedReport || rawSynthesis;
  }

  // Stage 1 dump — what the narrator returned (before any verifier work).
  writeSynthesisStageDump(runId, '1-after-narrator', finalOutput, options.projectLabel);

  // Verifier — two-pass grounding check against actual source code.
  //   Pass 1: cheap regex check (method existence, line bounds, safe-pattern detection)
  //   Pass 2: LLM check (semantic correctness against the actual source)
  // Both drop false positives entirely; single-flaw findings are annotated UNVERIFIED.
  let verifierCard = null;
  if (options.fileMap) {
    try {
      if (options.onVerifierStart) options.onVerifierStart();
      const verifyResult = await verifyReport(
        finalOutput,
        options.fileMap,
        { llmVerifier: createLLMVerifier() }
      );
      finalOutput  = verifyResult.annotatedReport;
      verifierCard = verifyResult.report;
      if (options.onVerifierReport) options.onVerifierReport(verifierCard);
    } catch (err) {
      // Verifier failure must never block the report — surface a note and continue.
      if (options.onVerifierReport) {
        options.onVerifierReport({ error: err.message, note: 'Verifier errored; report returned unverified.' });
      }
    }
  }

  // Stage 2 dump — after verifier annotations and false-positive drops.
  writeSynthesisStageDump(runId, '2-after-verifier', finalOutput, options.projectLabel);

  // Final scrub — the verifier removes false-positive findings but does not
  // touch their parent ## category headers, so a category whose findings all
  // got dropped will be left as a dangling empty header. Run the scrubber
  // here, AFTER verification, to clean those up. Defense in depth: this is
  // the same scrubber that runs inside the narrator's patcher path; we run
  // it again here because content can disappear between narrator and now.
  finalOutput = scrubEmptyHeaders(finalOutput);

  // Stage 3 dump — after scrubEmptyHeaders.
  writeSynthesisStageDump(runId, '3-after-scrub', finalOutput, options.projectLabel);

  // Post-verifier exec summary regeneration. The original exec summary was
  // written by the planner against the pre-drop finding set, so when the
  // verifier drops findings, the summary can reference findings that no
  // longer appear in the body — it lies. Detect drops and regenerate the
  // summary against the surviving findings only.
  //
  // Cost: ~$0.02 per scan (small prompt, ~300 token output). Skipped
  // entirely when nothing was dropped, so default-mode scans pay nothing.
  if (verifierCard && verifierCard.falsePositives > 0) {
    try {
      finalOutput = await regenerateExecutiveSummary(
        finalOutput,
        verifierCard,
        options.profile,
        options.projectLabel
      );
    } catch (err) {
      // Regen failure is non-fatal — the original summary still describes
      // the report's general shape, just imperfectly. Surface a debug note
      // so we can diagnose if it starts failing in production.
      try {
        const debugDir = path.join(os.homedir(), 'Ghost Architect Reports', '.debug');
        fs.mkdirSync(debugDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(debugDir, `exec-summary-regen-error-${ts}.txt`),
          `Exec summary regeneration failed: ${err.message}\n\nStack:\n${err.stack || '(no stack)'}\n`
        );
      } catch { /* never let debug logging break the scan */ }
    }

    // Same problem, different section: the Risk if Left Unaddressed
    // paragraph was also drafted against the pre-verification finding
    // set, so it commonly references findings the verifier dropped
    // (e.g. "the migration path that deletes plaintext tokens" when no
    // such finding survived). Regenerate it against the surviving set
    // so the closing paragraph stays consistent with the body.
    try {
      finalOutput = await regenerateRiskParagraph(
        finalOutput,
        options.profile,
        options.projectLabel
      );
    } catch (err) {
      try {
        const debugDir = path.join(os.homedir(), 'Ghost Architect Reports', '.debug');
        fs.mkdirSync(debugDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(debugDir, `risk-paragraph-regen-error-${ts}.txt`),
          `Risk paragraph regeneration failed: ${err.message}\n\nStack:\n${err.stack || '(no stack)'}\n`
        );
      } catch { /* never let debug logging break the scan */ }
    }
  }

  // Stage 4 dump — after exec-summary + risk-paragraph regeneration. This
  // is what gets returned to the caller and ultimately written to disk by
  // saveReport. If this dump matches the saved markdown, the truncation is
  // upstream of saveReport; if it doesn't, saveReport is the culprit.
  writeSynthesisStageDump(runId, '4-after-regen', finalOutput, options.projectLabel);

  return finalOutput;
}

/**
 * Regenerate the executive summary section of a verified report so it
 * references only findings that survived verification.
 *
 * Why this exists: the original exec summary was drafted by the narrator's
 * planning pass against the pre-verification finding set. When the verifier
 * drops findings as not-supported-by-source, the summary can name findings
 * that no longer exist in the body — exactly the kind of internal
 * inconsistency a sharp consultant catches on first read.
 *
 * Approach: extract surviving findings from the (already-verified, already-
 * scrubbed) report, ask the LLM to rewrite just the exec summary against
 * that set, and splice the new summary in place of the old one. Everything
 * else in the report — categories, prose entries, remediation table, risk
 * paragraph — stays exactly as the verifier left it.
 *
 * If the report doesn't have an `## Executive Summary` section, we return
 * it untouched. If the LLM call fails, we return the original report
 * untouched. Both cases are non-fatal.
 */
async function regenerateExecutiveSummary(report, verifierCard, profile, projectLabel) {
  // Locate the existing exec summary section. Pattern: `## Executive Summary`
  // (optionally with emoji prefix), followed by content, ending at the next
  // `## ` header.
  const summaryHeaderRe = /^##\s+(?:[\u{1F300}-\u{1FAFF}]\s*)?Executive\s+Summary\s*$/imu;
  const headerMatch = summaryHeaderRe.exec(report);
  if (!headerMatch) return report; // No summary section — nothing to regenerate.

  const headerStart = headerMatch.index;
  const headerEnd   = headerStart + headerMatch[0].length;

  // Find the next ## header to bound the summary section.
  const afterHeader = report.slice(headerEnd);
  const nextHeaderRe = /\n##\s+/;
  const nextMatch = nextHeaderRe.exec(afterHeader);
  const summaryEndIdx = nextMatch ? headerEnd + nextMatch.index : report.length;

  // Extract surviving findings from the post-verifier body. We use the
  // shared parser so we get the same severity inference as everywhere else.
  const surviving = extractFindingsFromReport(report);
  if (!surviving || surviving.length === 0) return report;

  // Build a compact, severity-ordered finding list for the prompt.
  const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4, BLOCKING: 0 };
  const ranked = [...surviving].sort((a, b) => {
    const rA = SEVERITY_RANK[(a.severity || '').toUpperCase()] ?? 99;
    const rB = SEVERITY_RANK[(b.severity || '').toUpperCase()] ?? 99;
    return rA - rB;
  });
  const findingLines = ranked.map((f, i) =>
    `${i + 1}. [${f.severity || 'MEDIUM'}] ${f.title}` +
    (f.files && f.files.length ? ` (files: ${f.files.slice(0, 3).join(', ')})` : '')
  ).join('\n');

  // Count by severity. We construct the breakdown sentence ourselves in code
  // rather than trusting the LLM to count and report accurately — multiple
  // attempts to prompt the model into emitting an accurate breakdown phrase
  // ("1 critical, 2 high, 4 medium, 1 low") consistently failed because the
  // model has a strong narrative prior to collapse adjacent severity bands.
  const sevCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0, BLOCKING: 0 };
  for (const f of surviving) {
    const s = (f.severity || 'MEDIUM').toUpperCase();
    if (sevCounts[s] !== undefined) sevCounts[s]++;
  }
  const presentBands = Object.entries(sevCounts).filter(([_, n]) => n > 0);

  // Build the count + breakdown sentence in code. Format:
  //   "My pre-engagement analysis of the <project> codebase identified <N>
  //    findings: <X critical-severity, Y high-severity, Z medium-severity>."
  // The breakdown is comma-separated with an Oxford-and joining the last two
  // items when there are 3+ bands. With 2 bands we use "and". With 1 band
  // we just say "all <N> are <band>-severity".
  const projectClause = projectLabel ? ` of the ${projectLabel} codebase` : '';
  const subjectClause = profile
    ? `My pre-engagement analysis${projectClause}`
    : `This pre-engagement analysis${projectClause}`;

  let breakdownClause;
  if (presentBands.length === 1) {
    const [band, n] = presentBands[0];
    const bandWord = band.toLowerCase();
    breakdownClause = n === 1
      ? `: 1 ${bandWord}-severity issue`
      : `: ${n} ${bandWord}-severity issues`;
  } else if (presentBands.length === 2) {
    const parts = presentBands.map(([band, n]) => `${n} ${band.toLowerCase()}-severity`);
    breakdownClause = `: ${parts[0]} and ${parts[1]}`;
  } else {
    const parts = presentBands.map(([band, n]) => `${n} ${band.toLowerCase()}-severity`);
    const allButLast = parts.slice(0, -1).join(', ');
    const last = parts[parts.length - 1];
    breakdownClause = `: ${allButLast}, and ${last}`;
  }

  const totalNoun = surviving.length === 1 ? 'finding' : 'findings';
  const openerSentence = `${subjectClause} identified ${surviving.length} ${totalNoun}${breakdownClause}.`;

  // Profile-aware persona — match the narrator's white-label conventions.
  // When a profile is loaded, we do NOT identify as Ghost Architect.
  const persona = profile
    ? `You are writing the body of an executive summary for a pre-engagement codebase analysis report on behalf of ${profile.author || 'the consultant'}${profile.organization ? ` (${profile.organization})` : ''}. Write in the consultant's voice. Do NOT mention "Ghost Architect" or "Ghost" in the output.`
    : 'You are Ghost Architect, writing the body of an executive summary for a codebase analysis report.';

  // The LLM only writes the prose AFTER the opener. The opener + breakdown
  // sentence is constructed deterministically in code above. We give the LLM
  // the opener for context so its prose connects to it grammatically, but
  // the LLM's output is appended AFTER the opener.
  const prompt =
    `${persona}\n\n` +
    `The first sentence of the executive summary has already been written:\n` +
    `\n  "${openerSentence}"\n\n` +
    `Your job is to write 2 to 4 additional sentences that follow this opener, naming the top finding(s) by name and impact. Do NOT rewrite the opener. Do NOT mention severity counts (the opener already covered them). Do NOT mention dropped findings or the verifier.\n\n` +
    `SURVIVING FINDINGS (ordered by severity, item 1 is the most severe):\n${findingLines}\n\n` +
    `WHAT TO WRITE:\n` +
    `- 2 to 4 sentences of plain prose, no markdown, no bullet lists.\n` +
    `- Name the most severe finding (item 1 above) by name and impact in plain language.\n` +
    `- If there is more than one CRITICAL or HIGH finding, name the second one too.\n` +
    `- Use one sentence to gesture at the remaining findings as a group (e.g., "the remaining issues span dependency hygiene and configuration debt") rather than listing them all.\n` +
    `- Do NOT cite line numbers or method names.\n` +
    `- Do NOT invent dollar totals; the remediation table elsewhere has those numbers.\n` +
    `- Do NOT repeat the count or severity breakdown from the opener.\n` +
    `- Output ONLY the additional sentences. No preamble, no "Here is...". Start your output with the first new sentence.\n\n` +
    `Additional sentences:`;

  const additional = await callClaude(prompt, '', 500);
  const cleanedAdditional = (additional || '').trim();

  // Compose the final summary: code-built opener + LLM-built body. If the
  // LLM call failed or returned empty, fall back to opener alone — better
  // than a stale or absent summary.
  const composedSummary = cleanedAdditional
    ? `${openerSentence} ${cleanedAdditional}`
    : openerSentence;

  // Splice: keep everything up to and including the `## Executive Summary`
  // line, then the new body, then everything from the next ## header onward.
  const before     = report.slice(0, headerEnd);
  const after      = report.slice(summaryEndIdx);
  const reassembled = before + '\n\n' + composedSummary + '\n' + after;

  return reassembled;
}

// ── Session-based synthesis ───────────────────────────────────────────────────

/**
 * Regenerate the Risk if Left Unaddressed paragraph so it references only
 * findings that survived verification.
 *
 * Why this exists: same root cause as regenerateExecutiveSummary — the
 * narrator drafted the closing paragraph during initial rendering, before
 * the verifier dropped any findings. When verification removes findings,
 * the closing paragraph commonly references issues by name that no longer
 * appear elsewhere in the report ("the migration path that deletes
 * plaintext tokens", "the new architecture flag without compatibility
 * verification", etc.). A sharp consultant reader will notice immediately.
 *
 * Approach: locate the `## Risk if Left Unaddressed` section, extract the
 * surviving findings from the verified report body, and ask the LLM for a
 * single closing paragraph constrained to that set. Splice the new
 * paragraph in place of the old one. Everything before the Risk header
 * stays exactly as the verifier left it.
 *
 * Non-fatal failures: missing section header → return original. Empty LLM
 * response → return original. The exec summary regen sets the precedent.
 */
async function regenerateRiskParagraph(report, profile, projectLabel) {
  // Locate the existing Risk section. Pattern: `## Risk if Left Unaddressed`
  // (optionally with emoji prefix). Tolerate a few legacy header variants
  // that older Ghost reports used: "Risk Assessment", "Risks".
  const riskHeaderRe = /^##\s+(?:[\u{1F300}-\u{1FAFF}]\s*)?Risk(?:\s+if\s+Left\s+Unaddressed|\s+Assessment|s)?\s*$/imu;
  const headerMatch = riskHeaderRe.exec(report);
  if (!headerMatch) return report; // No risk section — nothing to regenerate.

  const headerStart = headerMatch.index;
  const headerEnd   = headerStart + headerMatch[0].length;

  // Find the next ## header to bound the section. The Risk paragraph is
  // typically the last ## section in the report, so we may hit EOF first.
  const afterHeader = report.slice(headerEnd);
  const nextHeaderRe = /\n##\s+/;
  const nextMatch = nextHeaderRe.exec(afterHeader);
  const sectionEndIdx = nextMatch ? headerEnd + nextMatch.index : report.length;

  // Extract surviving findings from the post-verifier body. Same parser
  // the exec summary regen uses, so severity inference is consistent.
  const surviving = extractFindingsFromReport(report);
  if (!surviving || surviving.length === 0) return report;

  // Severity-rank the findings so the most important ones lead in the
  // prompt. The LLM tends to weight earlier list items more heavily, and
  // the closing paragraph should be anchored on what's most consequential.
  const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4, BLOCKING: 0 };
  const ranked = [...surviving].sort((a, b) => {
    const rA = SEVERITY_RANK[(a.severity || '').toUpperCase()] ?? 99;
    const rB = SEVERITY_RANK[(b.severity || '').toUpperCase()] ?? 99;
    return rA - rB;
  });
  const findingLines = ranked.map((f, i) =>
    `${i + 1}. [${f.severity || 'MEDIUM'}] ${f.title}` +
    (f.files && f.files.length ? ` (files: ${f.files.slice(0, 3).join(', ')})` : '')
  ).join('\n');

  // Profile-aware persona — mirror the exec summary regen's white-label
  // conventions. When a profile is loaded, do NOT identify as Ghost.
  const persona = profile
    ? `You are writing the closing paragraph of a pre-engagement codebase analysis report on behalf of ${profile.author || 'the consultant'}${profile.organization ? ` (${profile.organization})` : ''}. Write in the consultant's voice. Do NOT mention "Ghost Architect" or "Ghost" in the output.`
    : 'You are Ghost Architect, writing the closing paragraph of a codebase analysis report.';

  const projectLine = projectLabel ? `Project: ${projectLabel}\n` : '';

  const prompt =
    `${persona}\n\n` +
    `${projectLine}` +
    `Write a single "Risk if Left Unaddressed" paragraph for this report. The findings below are the COMPLETE set that survived source-code verification. The paragraph must reference ONLY these findings — do not invent or imply additional issues.\n\n` +
    `SURVIVING FINDINGS (${surviving.length} total — ordered by severity, item 1 is the most severe):\n${findingLines}\n\n` +
    `WHAT TO WRITE:\n` +
    `- A single paragraph of 3 to 6 sentences. Plain prose. No markdown headers. No bullet lists.\n` +
    `- Focus on consequences if the listed findings remain unaddressed: production failure modes, user impact, support burden, security exposure where applicable.\n` +
    `- Anchor the paragraph on the highest-severity findings (items at the top of the list above).\n` +
    `- You may reference findings by descriptive paraphrase ("the credential migration issue", "the silent storage failures") rather than verbatim title.\n` +
    `- Do NOT mention any issue not in the list above. If you are tempted to write "the X path" and X is not in the list, do not write that sentence.\n` +
    `- Do NOT mention dropped findings, source verification, or the verifier itself.\n` +
    `- Do NOT cite line numbers, method names, or specific dollar amounts.\n` +
    `- Do NOT write a section header like "## Risk if Left Unaddressed" — output ONLY the paragraph body.\n` +
    `- Do NOT write any preamble like "Here is the rewritten paragraph:". Output ONLY the paragraph itself.\n\n` +
    `Risk paragraph:`;

  const newParagraph = await callClaude(prompt, '', 600);
  const cleaned = (newParagraph || '').trim();
  if (!cleaned) return report; // Empty response — leave original alone.

  // Splice: keep everything up to and including the `## Risk if Left
  // Unaddressed` line, then the new paragraph, then everything from the
  // next ## header onward (or EOF). Preserves trailing footer content.
  const before     = report.slice(0, headerEnd);
  const after      = report.slice(sectionEndIdx);
  const reassembled = before + '\n\n' + cleaned + '\n' + after;

  return reassembled;
}

export async function synthesizeFromSession(session, totalFiles, totalPasses, onChunk, options = {}) {
  const groups = [...session.mergedGroups];
  if (session.pendingPassResults.length > 0) {
    const merged = await mergePassResults(session.pendingPassResults, session.projectLabel, options.profile);
    groups.push(merged);
  }
  const coverage = Math.round((session.completedPassCount / totalPasses) * 100);
  return synthesizeFinal(groups, totalFiles, session.completedPassCount, totalPasses, coverage, onChunk, {
    ...options,
    projectLabel: session.projectLabel,
  });
}

// ── Pre-scan filesystem preflight ─────────────────────────────────────────────
//
// Checkpoint saves happen after every pass, but the user only discovers a
// broken sessions directory (full disk, read-only mount, permission flip)
// AFTER the first pass has already burned API quota. Probe the directory up
// front by writing and deleting a tiny file, so we can warn before a single
// token is spent. Returns { ok: true } on success, or { ok: false, error,
// path } when the probe write fails. Never throws.
function preflightSessionsWritable() {
  const probePath = path.join(SESSIONS_DIR, `.ghost-write-probe-${process.pid}`);
  try {
    ensureSessionsDir();
    fs.writeFileSync(probePath, 'ok');
    fs.unlinkSync(probePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, path: SESSIONS_DIR };
  }
}

// Build the Error thrown when checkpoint persistence has failed badly enough
// that the scan is no longer resumable. The message names the pass range that
// can no longer be recovered and the approximate API cost already spent on it,
// so the user understands exactly what aborting throws away. Cost uses the same
// ~$0.25/pass figure the rest of this file estimates with (see getPassInfo).
function makeUnresumableAbortError(cause, lastPersistedPass, currentPassNum) {
  const firstLost  = lastPersistedPass + 1;
  const lostCount  = Math.max(1, currentPassNum - lastPersistedPass);
  const range      = lostCount === 1 ? `pass ${currentPassNum}` : `passes ${firstLost}–${currentPassNum}`;
  const approxCost = (lostCount * 0.25).toFixed(2);

  const err = new Error(
    `Checkpoint persistence failed and the scan cannot be resumed. ` +
    `Lost work: ${range} (~$${approxCost} in API usage). Original error: ${cause.message}`
  );
  err.code          = 'SESSION_SAVE_FAILED';
  err.cause         = cause;
  err.lostRange     = range;
  err.approxCostUsd = approxCost;
  err.userMessage =
    `\n  ✗  Checkpoint persistence has failed and this scan cannot be resumed.\n` +
    `     Aborting to avoid spending more API quota on unrecoverable work.\n` +
    `     Lost: ${range} (~$${approxCost} in API usage already spent).\n` +
    `     Free disk space or fix permissions on ${SESSIONS_DIR} and re-run.\n`;
  return err;
}

// ── Main entry point ──────────────────────────────────────────────────────────
/**
 * Run multi-pass POI scan.
 *
 * callbacks:
 *   onProgress({ type, message })     — status messages for CLI to display
 *   onChunk(text)                     — streaming final report text
 *   onPassCapPrompt({ remaining, defaultCap }) → Promise<number>
 *   onSessionPrompt({ session, allPassCount }) → Promise<'continue'|'report'|'restart'>
 *   onCompletePrompt({ coverage, remaining }) → Promise<'report'|'save'>
 *   onSaveFailurePrompt({ passNum, message, sessionsDir }) → Promise<'continue'|'abort'>
 *     Called on the FIRST checkpoint-save failure so the user can make an
 *     informed choice instead of the scan silently limping toward an abort two
 *     passes later. 'continue' acknowledges the risk and suppresses the
 *     consecutive-failure abort; 'abort' stops now. Optional: when not wired,
 *     the legacy behavior applies (warn, continue, abort after 2 consecutive
 *     failures).
 *
 * options:
 *   profile — Ghost Partner consultant profile object (or null). Injected into
 *             the system prompt at every API call — pass, merge, and final
 *             synthesis — so the consultant's lens is applied consistently.
 */
export async function runMultiPassPOI(fileMap, projectLabel, callbacks = {}, options = {}) {
  const {
    onProgress       = () => {},
    onChunk          = () => {},
    onPassCapPrompt  = async ({ defaultCap }) => defaultCap,
    onSessionPrompt  = async () => 'continue',
    onCompletePrompt = async () => 'report',
    onSaveFailurePrompt = null,
  } = callbacks;

  const profile = options.profile || null;

  const allPasses  = buildPasses(fileMap);
  const totalFiles = Object.keys(fileMap).length;

  if (allPasses.length === 1) return null;

  // Preflight: confirm the sessions directory is writable BEFORE spending any
  // API quota. Checkpoints save after each pass; a broken directory would
  // otherwise only surface after pass 1 has already burned tokens. Warn now so
  // the user can fix disk/permissions before a long, expensive scan.
  const preflight = preflightSessionsWritable();
  if (!preflight.ok) {
    process.stdout.write(chalk.yellow(
      `\n  ⚠  The sessions directory is not writable — resume checkpoints will fail:\n` +
      `     ${preflight.path}\n` +
      `     ${preflight.error}\n` +
      `     The scan can still run, but it will NOT be resumable if interrupted.\n` +
      `     Free disk space or fix permissions before starting a long scan.\n`
    ));
    onProgress({ type: 'preflightWarning', path: preflight.path, message: preflight.error });
  }

  const topFiles = getTopFiles(fileMap, 5);
  onProgress({ type: 'topFiles', files: topFiles });

  // Check for existing session
  let session       = loadSession(projectLabel);
  let startFromPass = 0;

  if (session) {
    const pct    = Math.round((session.completedPassCount / allPasses.length) * 100);
    const action = await onSessionPrompt({ session, allPassCount: allPasses.length, pct });

    if (action === 'restart') {
      deleteSession(projectLabel);
      session = null;  // Finding 8: explicit null to prevent stale state leak
      startFromPass = 0;
    } else if (action === 'report') {
      onProgress({ type: 'synthesizing', groups: 1 });
      const finalReport = await synthesizeFromSession(session, totalFiles, allPasses.length, onChunk, {
        projectLabel,
        fileMap,
        profile,
        onVerifierStart:  () => onProgress({ type: 'verifying' }),
        onVerifierReport: (card) => onProgress({ type: 'verifierReport', card }),
      });
      deleteSession(projectLabel);
      const coverage = Math.round((session.completedPassCount / allPasses.length) * 100);
      return { finalReport, passCount: session.completedPassCount, totalFiles, coverage };
    } else {
      startFromPass = session.completedPassCount;
    }
  }

  if (!session) {
    session = {
      projectLabel, startedAt: new Date().toISOString(),
      totalFiles, totalPassCount: allPasses.length,
      completedPassCount: 0,
      mergedGroups: [], pendingPassResults: [],
      passSkeletons: [],
    };
  }

  const remaining  = allPasses.length - startFromPass;
  const defaultCap = Math.min(DEFAULT_PASS_CAP, remaining);

  // Emit passInfo BEFORE cap prompt so UI can show full context
  onProgress({ type: 'passInfo', totalPasses: allPasses.length, remaining, estCost: (remaining * 0.25).toFixed(2), estMinutes: Math.max(3, Math.round(remaining * 3.5)) });

  const cap     = await onPassCapPrompt({ remaining, defaultCap });

  // After cap is known, emit corrected cost/time for the selected passes
  const capCost    = (cap * 0.25).toFixed(2);
  const capMinutes = Math.max(3, Math.round(cap * 3.5));
  onProgress({ type: 'passInfo', totalPasses: allPasses.length, remaining: cap, estCost: capCost, estMinutes: capMinutes, isSelected: true });

  const endPass = Math.min(startFromPass + cap, allPasses.length);

  // Track consecutive checkpoint-save failures. A single filesystem hiccup is
  // survivable (the in-memory session still drives final synthesis), but if
  // checkpoints keep failing the scan is unresumable, so continuing only burns
  // API quota — abort instead.
  let consecutiveSaveFailures = 0;

  // The newest pass number whose results are durably checkpointed on disk.
  // Initialized to startFromPass: passes up to there came from a prior session
  // that was already persisted. Used to report the lost (unresumable) pass
  // range if we have to abort.
  let lastPersistedPass = startFromPass;

  // Set once the user explicitly accepts running without resume capability.
  // While true, further save failures neither re-prompt nor trip the
  // consecutive-failure abort — the user already acknowledged the risk.
  let saveFailureAcknowledged = false;

  // Run passes
  for (let p = startFromPass; p < endPass; p++) {
    const pass      = allPasses[p];
    const passNum   = p + 1;
    const fileCount = Object.keys(pass.files).length;

    onProgress({ type: 'passStart', passNum, totalPasses: startFromPass + cap, fileCount, tokens: pass.tokens });

    const priorSkeletons = session.passSkeletons || [];
    const result         = await runPass(pass, passNum, allPasses.length, totalFiles, priorSkeletons, profile);

    const skeleton = extractSkeleton(result);
    session.passSkeletons = [...priorSkeletons, skeleton].slice(-3);
    session.pendingPassResults.push({ passNum, fileCount, findings: result });
    session.completedPassCount = passNum;

    // Always acknowledge the pass completed FIRST — gives users clear feedback
    // that every pass they selected actually ran. Without this, hitting the
    // merge threshold would swallow the final pass's "complete" message.
    onProgress({ type: 'passComplete', passNum });

    if (session.pendingPassResults.length >= MERGE_BATCH_SIZE) {
      onProgress({ type: 'merging', count: session.pendingPassResults.length });
      const merged = await mergePassResults(session.pendingPassResults, projectLabel, profile);
      session.mergedGroups.push(merged);
      session.pendingPassResults = [];
      onProgress({ type: 'mergeDone' });
    }

    try {
      await persistSession(projectLabel, session);
      consecutiveSaveFailures = 0;
      lastPersistedPass = passNum;
    } catch (err) {
      consecutiveSaveFailures++;
      process.stdout.write(chalk.yellow(
        `\n  ⚠  Progress checkpoint failed to save after retries (pass ${passNum}/${endPass}).\n` +
        `     ${err.message}\n` +
        `     Details logged to ~/Ghost Architect Reports/.debug/session-save-errors.log\n`
      ));
      onProgress({ type: 'saveFailed', passNum, message: err.message });

      // First failure with an interactive host wired in: stop and let the user
      // decide, rather than silently limping toward an abort two passes later.
      // (Without a host wired in, onSaveFailurePrompt is null and we fall
      // through to the legacy warn-and-continue / abort-on-second behavior.)
      if (onSaveFailurePrompt && !saveFailureAcknowledged) {
        let choice = 'abort';
        try {
          choice = await onSaveFailurePrompt({ passNum, message: err.message, sessionsDir: SESSIONS_DIR });
        } catch { /* prompt itself failed — fall back to the safe choice (abort) */ }

        if (choice === 'continue') {
          // User accepted running without resume capability. Suppress the
          // consecutive-failure abort so their acknowledgement holds for the
          // rest of the scan.
          saveFailureAcknowledged = true;
        } else {
          const abortErr = makeUnresumableAbortError(err, lastPersistedPass, passNum);
          process.stdout.write(chalk.red(abortErr.userMessage));
          throw abortErr;
        }
      }

      // Legacy / unacknowledged path: a single failure is survivable (the
      // in-memory session still drives final synthesis), but two in a row means
      // the scan is unresumable and further passes only burn quota — abort.
      if (!saveFailureAcknowledged && consecutiveSaveFailures >= 2) {
        const abortErr = makeUnresumableAbortError(err, lastPersistedPass, passNum);
        process.stdout.write(chalk.red(abortErr.userMessage));
        throw abortErr;
      }
    }
  }

  const allDone  = session.completedPassCount >= allPasses.length;
  const coverage = Math.round((session.completedPassCount / allPasses.length) * 100);

  // The user picked `cap` passes for this session. If they asked for less than
  // the full remaining count, completing the cap is a complete job — they got
  // exactly what they asked for. Synthesize and ship without re-asking.
  // Only prompt when the user asked for everything available AND the run
  // didn't finish (retries, partial failures), which is the legitimate
  // 'do you want to keep going or save and resume' case.
  const userGotWhatTheyAskedFor = cap < remaining;

  if (!allDone && !userGotWhatTheyAskedFor) {
    const next = await onCompletePrompt({
      coverage,
      remaining: allPasses.length - session.completedPassCount,
      passCount: session.completedPassCount,
    });
    if (next === 'save') {
      return { finalReport: null, saved: true, passCount: session.completedPassCount, totalFiles, coverage };
    }
  }

  if (session.pendingPassResults.length > 0) {
    onProgress({ type: 'mergingFinal' });
    const merged = await mergePassResults(session.pendingPassResults, projectLabel, profile);
    session.mergedGroups.push(merged);
    session.pendingPassResults = [];
    try {
      await persistSession(projectLabel, session);
    } catch (err) {
      // Non-fatal here: final synthesis runs next in this same process and
      // produces the report, so a failed save only costs resumability if
      // synthesis is later interrupted. Warn prominently and continue.
      process.stdout.write(chalk.yellow(
        `\n  ⚠  Final-merge checkpoint failed to save after retries — resume may not work if synthesis is interrupted.\n` +
        `     ${err.message}\n` +
        `     Details logged to ~/Ghost Architect Reports/.debug/session-save-errors.log\n`
      ));
      onProgress({ type: 'saveFailed', message: err.message });
    }
  }

  // Final synthesis + narrator
  onProgress({ type: 'synthesizing', groups: session.mergedGroups.length });
  const finalReport = await synthesizeFinal(
    session.mergedGroups, totalFiles,
    session.completedPassCount, allPasses.length, coverage, onChunk,
    {
      projectLabel,
      fileMap,  // pass source map to verifier for grounding checks
      profile,  // Ghost Partner — consultant lens applied at synthesis too
      onNarratorStart:    () => onProgress({ type: 'narrating' }),
      onVerifierStart:    () => onProgress({ type: 'verifying' }),
      onVerifierReport:   (card) => onProgress({ type: 'verifierReport', card }),
    }
  );

  deleteSession(projectLabel);
  return { finalReport, passCount: session.completedPassCount, totalFiles, coverage };
}
