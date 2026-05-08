import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { getConfig, resolveApiKey } from '../config.js';
import { SYSTEM_CHAT, buildSystemPOI, SYSTEM_BLAST } from '../../prompts/index.js';
import { narrateReport, narrateExecutiveSummary } from '../core/agent/narrator.js';
import { verifyReport } from '../core/verifier.js';
import { createLLMVerifier } from '../core/llm-verifier.js';
import { extractFindings as extractFindingsCanonical } from '../utils/finding-parser.js';

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
//
// F-26 fix (2026-05-08): the previous local implementation matched
// /^\d+\.\s+\*?\*?(.+?)\*?\*?$/ which treated NUMBERED-LIST FIX STEPS
// inside a finding as if they were finding titles. On a real saved POI
// report this produced 29 "findings" all of which were fix-step bullets,
// while the canonical parser correctly extracted 8 actual findings.
//
// The canonical parser in src/utils/finding-parser.js correctly anchors
// on "### Title" markdown headers (the format SYSTEM_POI/SYSTEM_BLAST
// actually instruct the model to emit) and properly recognizes section
// boundaries (Recommended Fix, Effort, Severity, Files). It also drops
// findings that fall inside non-finding sections like REMEDIATION SUMMARY.
//
// All three call sites (analyst POI, analyst Blast, modes/compare) now
// route through the canonical parser. No shape transformation is needed:
// canonical returns { id, title, severity, detail, files, effortHours,
// confidence } and the narrator only consumes title/severity/files/detail/
// confidence, which canonical already provides.

function extractFindings(rawText, mode = 'poi') {
  // mode parameter retained for API compatibility but no longer needed
  // — the canonical parser handles POI and Blast formats identically
  // because both follow the same ### Title + structured-fields shape.
  return extractFindingsCanonical(rawText);
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
    {
      projectLabel: options.projectLabel || 'project',
      mode: 'poi',
      rates,
      fileMap: options.fileMap || codebaseContext.fileMap,
    },
    onChunk
  );

  let finalOutput = narratedReport || rawOutput;

  // Verifier — two-pass source-grounded check against fileMap.
  //   Pass 1: cheap regex check
  //   Pass 2: LLM semantic check
  if (options.fileMap || codebaseContext.fileMap) {
    try {
      if (options.onVerifierStart) options.onVerifierStart();
      const { annotatedReport, report: verifierCard } = await verifyReport(
        finalOutput,
        options.fileMap || codebaseContext.fileMap,
        { llmVerifier: createLLMVerifier() }
      );
      finalOutput = annotatedReport;
      if (options.onVerifierReport) options.onVerifierReport(verifierCard);
    } catch (err) {
      if (options.onVerifierReport) {
        options.onVerifierReport({ error: err.message, note: 'Verifier errored; report returned unverified.' });
      }
    }
  }

  return finalOutput;
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
