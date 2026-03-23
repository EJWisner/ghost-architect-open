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
import { getConfig, resolveApiKey } from '../config.js';
import { buildSystemPOI } from '../../prompts/index.js';
import { prioritizeFileMap, getTopFiles } from '../prioritizer.js';
import { narrateReport } from './agent/narrator.js';

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

export function loadSession(label) {
  const finalPath = sessionFilePath(label);
  const bakPath   = finalPath + '.bak';

  // Try main file first
  if (fs.existsSync(finalPath)) {
    try {
      return JSON.parse(fs.readFileSync(finalPath, 'utf8'));
    } catch {
      // Main file corrupted — try backup
      if (fs.existsSync(bakPath)) {
        try {
          const session = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
          // Restore backup as main file
          fs.copyFileSync(bakPath, finalPath);
          return session;
        } catch { /* backup also corrupted */ }
      }
      return null;
    }
  }
  return null;
}

export function saveSession(label, session) {
  ensureSessionsDir();
  const finalPath = sessionFilePath(label);
  const tmpPath   = finalPath + '.tmp';
  const bakPath   = finalPath + '.bak';

  try {
    // Write to temp file first
    fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2));
    // Back up existing session before overwriting
    if (fs.existsSync(finalPath)) {
      fs.copyFileSync(finalPath, bakPath);
    }
    // Atomic rename — POSIX guarantees this is atomic
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    // Clean up temp file if something went wrong
    if (fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
    throw err; // re-throw so caller knows save failed
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
  const estMinutes = Math.round(remaining * 0.75);
  return { passes, topFiles, totalFiles, remaining, estCost, estMinutes, defaultCap: Math.min(DEFAULT_PASS_CAP, remaining) };
}

// ── Cross-pass skeleton extraction ───────────────────────────────────────────

function extractSkeleton(passResult) {
  const lines    = passResult.split('\n');
  const skeleton = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('**Files:**') || t.startsWith('Files:'))        skeleton.push(t.replace(/\*\*/g, ''));
    if (/^\d+\.\s+\*?\*?.+/.test(t) && t.length < 100)              skeleton.push(t.replace(/\*\*/g, ''));
    if (/Severity:/i.test(t))                                         skeleton.push(t);
  }
  return skeleton.slice(0, 40).join('\n');
}

// ── Claude API ────────────────────────────────────────────────────────────────

function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-5'; }
function getRates()  {
  const cfg = getConfig();
  return { junior: cfg.get('rateJunior') || 85, mid: cfg.get('rateMid') || 125, senior: cfg.get('rateSenior') || 200 };
}

async function callClaude(prompt, system, maxTokens = 8096) {
  const anthropic = getClient();
  let result = '';
  const stream = anthropic.messages.stream({
    model: getModel(), max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: prompt }]
  });
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      result += chunk.delta.text;
    }
  }
  return result;
}

// ── Single pass ───────────────────────────────────────────────────────────────

async function runPass(pass, passNum, totalPasses, totalFiles, priorSkeletons) {
  let context = '';
  for (const [fp, content] of Object.entries(pass.files)) {
    context += `\n\n=== FILE: ${fp} ===\n${content}`;
  }
  const skeletonContext = priorSkeletons.length > 0
    ? `\n\nCROSS-PASS CONTEXT (findings from prior passes — use to identify relationships):\n${priorSkeletons.join('\n---\n')}\n\n`
    : '';

  return callClaude(
    `This is pass ${passNum} of ${totalPasses} in a multi-pass analysis of a ${totalFiles}-file codebase.` +
    `${skeletonContext}` +
    `Analyze ONLY the files in this pass. Reference prior pass findings if you see related issues.\n\n` +
    `Files for this pass:\n${context}`,
    buildSystemPOI(getRates())
  );
}

// ── Intermediate merge ────────────────────────────────────────────────────────

async function mergePassResults(results, label) {
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
    buildSystemPOI(getRates()), 6000
  );
}

// ── Extract findings from merged text for narrator ────────────────────────────

function extractFindingsForNarrator(mergedText) {
  const findings = [];
  const lines    = mergedText.split('\n');
  const findingRe  = /^\d+\.\s+\*?\*?(.+?)\*?\*?$/;
  const severityRe = /severity[:\s]+?(CRITICAL|HIGH|MEDIUM|LOW|INFO)/i;
  const filesRe    = /files?[:\s]+(.+)/i;
  const effortRe   = /effort[:\s]+(\d[\d–\-]*)\s*hours?/i;

  let current = null;
  for (const line of lines) {
    const t  = line.trim();
    const fm = t.match(findingRe);
    if (fm) {
      if (current) findings.push(current);
      current = { title: fm[1].replace(/\*\*/g, '').trim(), severity: 'MEDIUM', detail: '', files: [], confidence: 85 };
      continue;
    }
    if (current) {
      const sm = t.match(severityRe);
      if (sm) { current.severity = sm[1].toUpperCase(); continue; }
      const fm2 = t.match(filesRe);
      if (fm2) { current.files = fm2[1].split(/[,;]/).map(f => f.trim()).filter(Boolean); continue; }
      if (t && t.length > 10 && !t.startsWith('---')) {
        current.detail += (current.detail ? ' ' : '') + t;
      }
    }
  }
  if (current) findings.push(current);
  return findings;
}

// ── Final synthesis — with narrator ──────────────────────────────────────────

async function synthesizeFinal(mergedGroups, totalFiles, completedPasses, totalPasses, coverage, onChunk, options = {}) {
  const combined  = mergedGroups.map((r, i) => `=== MERGED GROUP ${i + 1} ===\n${r}`).join('\n\n');
  const rates     = getRates();
  const anthropic = getClient();

  // Step 1: Raw synthesis (same as before — produces structured findings)
  let rawSynthesis = '';
  const stream = anthropic.messages.stream({
    model: getModel(), max_tokens: 8096, system: buildSystemPOI(rates),
    messages: [{
      role: 'user',
      content:
        `Final synthesis: ${completedPasses} of ${totalPasses} passes complete (${coverage}% of ${totalFiles} files).\n\n` +
        `Produce the final unified Points of Interest Report:\n` +
        `1. Merge remaining duplicates, rank by severity and business impact\n` +
        `2. Note coverage: this analysis covers ${coverage}% of the codebase\n` +
        `3. Produce complete REMEDIATION SUMMARY with tiered rates:\n` +
        `   LOW complexity: $${rates.junior}/hr | MEDIUM: $${rates.mid}/hr | HIGH/CRITICAL: $${rates.senior}/hr\n` +
        `4. Use full Ghost Architect report format\n\n` +
        `FINDINGS:\n${combined}\n\nFinal report:`
    }]
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      rawSynthesis += chunk.delta.text;
    }
  }

  // Step 2: Narrator rewrites as senior architect (streaming to user)
  if (options.onNarratorStart) options.onNarratorStart();

  const findings = extractFindingsForNarrator(rawSynthesis);

  // If narrator produces nothing useful, fall back to raw synthesis
  if (findings.length === 0) {
    for (const char of rawSynthesis) onChunk(char);
    return rawSynthesis;
  }

  const memoryResult = {
    findings,
    findingCount:  findings.length,
    filesAnalyzed: totalFiles,
    stepCount:     completedPasses,
    auditTrail:    [],
  };

  const narratedReport = await narrateReport(
    memoryResult,
    { projectLabel: options.projectLabel || 'project', mode: 'poi', rates },
    onChunk
  );

  return narratedReport || rawSynthesis;
}

// ── Session-based synthesis ───────────────────────────────────────────────────

export async function synthesizeFromSession(session, totalFiles, totalPasses, onChunk, options = {}) {
  const groups = [...session.mergedGroups];
  if (session.pendingPassResults.length > 0) {
    const merged = await mergePassResults(session.pendingPassResults, session.projectLabel);
    groups.push(merged);
  }
  const coverage = Math.round((session.completedPassCount / totalPasses) * 100);
  return synthesizeFinal(groups, totalFiles, session.completedPassCount, totalPasses, coverage, onChunk, {
    ...options,
    projectLabel: session.projectLabel,
  });
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
 */
export async function runMultiPassPOI(fileMap, projectLabel, callbacks = {}) {
  const {
    onProgress       = () => {},
    onChunk          = () => {},
    onPassCapPrompt  = async ({ defaultCap }) => defaultCap,
    onSessionPrompt  = async () => 'continue',
    onCompletePrompt = async () => 'report',
  } = callbacks;

  const allPasses  = buildPasses(fileMap);
  const totalFiles = Object.keys(fileMap).length;

  if (allPasses.length === 1) return null;

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
      session = null;
    } else if (action === 'report') {
      onProgress({ type: 'synthesizing', groups: 1 });
      const finalReport = await synthesizeFromSession(session, totalFiles, allPasses.length, onChunk, { projectLabel });
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
  const estCost    = (remaining * 0.25).toFixed(2);
  const estMinutes = Math.round(remaining * 0.75);
  const defaultCap = Math.min(DEFAULT_PASS_CAP, remaining);

  onProgress({ type: 'passInfo', totalPasses: allPasses.length, remaining, estCost, estMinutes });

  const cap     = await onPassCapPrompt({ remaining, defaultCap, estCost, estMinutes });
  const endPass = Math.min(startFromPass + cap, allPasses.length);

  // Run passes
  for (let p = startFromPass; p < endPass; p++) {
    const pass      = allPasses[p];
    const passNum   = p + 1;
    const fileCount = Object.keys(pass.files).length;

    onProgress({ type: 'passStart', passNum, totalPasses: allPasses.length, fileCount, tokens: pass.tokens });

    const priorSkeletons = session.passSkeletons || [];
    const result         = await runPass(pass, passNum, allPasses.length, totalFiles, priorSkeletons);

    const skeleton = extractSkeleton(result);
    session.passSkeletons = [...priorSkeletons, skeleton].slice(-3);
    session.pendingPassResults.push({ passNum, fileCount, findings: result });
    session.completedPassCount = passNum;

    if (session.pendingPassResults.length >= MERGE_BATCH_SIZE) {
      onProgress({ type: 'merging', count: session.pendingPassResults.length });
      const merged = await mergePassResults(session.pendingPassResults, projectLabel);
      session.mergedGroups.push(merged);
      session.pendingPassResults = [];
      onProgress({ type: 'mergeDone' });
    } else {
      onProgress({ type: 'passComplete', passNum });
    }

    saveSession(projectLabel, session);
  }

  const allDone  = session.completedPassCount >= allPasses.length;
  const coverage = Math.round((session.completedPassCount / allPasses.length) * 100);

  if (!allDone) {
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
    const merged = await mergePassResults(session.pendingPassResults, projectLabel);
    session.mergedGroups.push(merged);
    session.pendingPassResults = [];
    saveSession(projectLabel, session);
  }

  // Final synthesis + narrator
  onProgress({ type: 'synthesizing', groups: session.mergedGroups.length });
  const finalReport = await synthesizeFinal(
    session.mergedGroups, totalFiles,
    session.completedPassCount, allPasses.length, coverage, onChunk,
    {
      projectLabel,
      onNarratorStart: () => onProgress({ type: 'narrating' }),
    }
  );

  deleteSession(projectLabel);
  return { finalReport, passCount: session.completedPassCount, totalFiles, coverage };
}
