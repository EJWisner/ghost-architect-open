import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { getConfig, resolveApiKey } from '../config.js';
import { SYSTEM_CHAT, buildSystemPOI, SYSTEM_BLAST } from '../../prompts/index.js';
import { narrateReport, narrateExecutiveSummary } from '../core/agent/narrator.js';

let client = null;

function getClient() {
  if (!client) {
    const apiKey = resolveApiKey();
    client = new Anthropic({ apiKey });
  }
  return client;
}

function getModel() {
  return getConfig().get('defaultModel') || 'claude-sonnet-4-5';
}

function getRates() {
  const cfg = getConfig();
  return { junior: cfg.get('rateJunior') || 85, mid: cfg.get('rateMid') || 125, senior: cfg.get('rateSenior') || 200 };
}

// ── Extract findings from raw POI/Blast text for narrator ─────────────────────

function extractFindings(rawText, mode = 'poi') {
  const findings  = [];
  const lines     = rawText.split('\n');
  const findingRe = /^\d+\.\s+\*?\*?(.+?)\*?\*?$/;
  const sevRe     = /severity[:\s]+?(CRITICAL|HIGH|MEDIUM|LOW|INFO)/i;
  const filesRe   = /files?[:\s]+(.+)/i;

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
      const sm = t.match(sevRe);
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

// ── Chat ──────────────────────────────────────────────────────────────────────

export async function streamChat(codebaseContext, conversationHistory, userMessage) {
  const anthropic = getClient();
  const messages  = [...conversationHistory, { role: 'user', content: userMessage }];

  const contextualMessages = messages.map((msg, i) => {
    if (i === 0 && msg.role === 'user') {
      return { ...msg, content: `Here is the codebase to analyze:\n\n${codebaseContext.context}\n\n---\n\n${msg.content}` };
    }
    return msg;
  });

  process.stdout.write(chalk.cyan('\n👻 Ghost: '));
  let fullResponse = '';

  const stream = anthropic.messages.stream({
    model: getModel(), max_tokens: 4096, system: SYSTEM_CHAT,
    messages: contextualMessages
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      const text = chunk.delta.text;
      process.stdout.write(chalk.white(text));
      fullResponse += text;
    }
  }

  console.log('\n');
  return fullResponse;
}

// ── POI Scan — single pass with narrator ─────────────────────────────────────

export async function runPOIScan(codebaseContext, onChunk, options = {}) {
  const anthropic = getClient();
  const rates     = getRates();

  // Step 1: Run scan silently — collect raw output
  const stream = anthropic.messages.stream({
    model: getModel(), max_tokens: 8096, system: buildSystemPOI(rates),
    messages: [{ role: 'user', content: `Perform a full Points of Interest scan on this codebase:\n\n${codebaseContext.context}` }]
  });

  let rawOutput = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      rawOutput += chunk.delta.text;
    }
  }

  // Step 2: Narrator rewrites — streaming to user
  const findings = extractFindings(rawOutput, 'poi');

  if (findings.length === 0) {
    // No structured findings — stream raw output directly
    for (const char of rawOutput) onChunk(char);
    return rawOutput;
  }

  if (options.onNarratorStart) options.onNarratorStart();

  const memoryResult = {
    findings,
    findingCount:  findings.length,
    filesAnalyzed: codebaseContext.loadedFiles || 0,
    stepCount:     1,
    auditTrail:    [],
  };

  const narratedReport = await narrateReport(
    memoryResult,
    { projectLabel: options.projectLabel || 'project', mode: 'poi', rates },
    onChunk
  );

  return narratedReport || rawOutput;
}

// ── Blast Radius — with narrator ──────────────────────────────────────────────

export async function runBlastRadius(codebaseContext, target, onChunk, options = {}) {
  const anthropic = getClient();
  const rates     = getRates();

  // Step 1: Run blast scan silently
  const stream = anthropic.messages.stream({
    model: getModel(), max_tokens: 8096, system: SYSTEM_BLAST,
    messages: [{ role: 'user', content: `Perform a blast radius analysis for: "${target}"\n\nCodebase:\n\n${codebaseContext.context}` }]
  });

  let rawOutput = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      rawOutput += chunk.delta.text;
    }
  }

  // Step 2: Narrator rewrites — streaming to user
  const findings = extractFindings(rawOutput, 'blast');

  if (findings.length === 0) {
    for (const char of rawOutput) onChunk(char);
    return rawOutput;
  }

  if (options.onNarratorStart) options.onNarratorStart();

  const memoryResult = {
    findings,
    findingCount:  findings.length,
    filesAnalyzed: codebaseContext.loadedFiles || 0,
    stepCount:     1,
    auditTrail:    [],
  };

  const narratedReport = await narrateReport(
    memoryResult,
    { projectLabel: target, mode: 'blast', rates },
    onChunk
  );

  return narratedReport || rawOutput;
}
