// src/core/blast-multipass.js
//
// Multi-pass Blast Radius orchestrator for Commit Forecast.
//
// When a codebase exceeds the single-pass context window, this module chunks
// the fileMap into tier-appropriate passes (same logic as conflict.js),
// runs Blast on each chunk, then feeds all per-chunk outputs to a synthesis
// pass that produces one unified rollback plan.
//
// This gives Pro/Team/Enterprise customers full Blast Radius coverage on any
// codebase size — the same multi-pass architecture Conflict already uses.

import { getTierCap }       from '../loader/tierCaps.js';
import { prioritizeFileMap } from '../prioritizer.js';
import { runBlastRadius }   from '../analyst/index.js';
import { getConfig, resolveApiKey } from '../config.js';

// Blast uses max_tokens: 8096 for output. Leave 20% headroom on top of that
// for system prompt and framing. Mirrors getPassTokenLimit() in conflict.js.
function getBlastPassTokenLimit(tier) {
  return Math.floor(getTierCap(tier) * 0.8);
}

// Build the per-pass file chunks. Same algorithm as buildConflictPasses.
function buildBlastPasses(fileMap, tier) {
  const ordered = prioritizeFileMap(fileMap);
  const passes  = [];
  let current   = { files: {}, tokens: 0 };
  const limit   = getBlastPassTokenLimit(tier);

  for (const [filePath, content] of Object.entries(ordered)) {
    const t = Math.ceil(content.length / 4);
    if (current.tokens + t > limit && current.tokens > 0) {
      passes.push(current);
      current = { files: {}, tokens: 0 };
    }
    current.files[filePath] = content;
    current.tokens += t;
  }
  if (Object.keys(current.files).length > 0) passes.push(current);
  return passes;
}

// Build a minimal codebaseContext-shaped object from a file chunk.
function chunkToContext(files) {
  let context = '';
  for (const [fp, content] of Object.entries(files)) {
    context += `\n\n=== FILE: ${fp} ===\n${content}`;
  }
  return {
    context,
    fileMap:     files,
    loadedFiles: Object.keys(files).length,
    totalFiles:  Object.keys(files).length,
  };
}

// Estimate pass count and cost for UI display.
export function getBlastPassInfo(fileMap, tier = 'open') {
  const totalTokens = Object.values(fileMap).reduce((sum, c) => sum + Math.ceil(c.length / 4), 0);
  const limit       = getBlastPassTokenLimit(tier);
  const singlePass  = totalTokens <= limit;
  const passes      = singlePass
    ? [{ files: fileMap, tokens: totalTokens }]
    : buildBlastPasses(fileMap, tier);
  // Blast costs more per pass than conflict (~$0.50 per pass estimate).
  const estCost     = (passes.length * 0.50).toFixed(2);
  const estMinutes  = Math.max(1, Math.round(passes.length * 1.5));
  return { passes, totalTokens, singlePass, estCost, estMinutes, passCount: passes.length };
}

// ── Main export ───────────────────────────────────────────────────────────────
//
// Runs multi-pass Blast and synthesizes results into one report.
//
// options mirrors runBlastRadius options:
//   profile, forecastMode, forecastTarget
//   onPassStart(passNum, totalPasses)
//   onPassComplete(passNum, totalPasses)
//   onSynthesisStart()
//
export async function runMultipassBlast(patchedContext, forecastTarget, options = {}) {
  const { tier = 'open', profile, forecastMode, onPassStart, onPassComplete, onSynthesisStart, onUsage = null } = options;

  const fileMap = patchedContext.fileMap || {};
  const passes  = buildBlastPasses(fileMap, tier);
  const total   = passes.length;

  const perPassResults = [];

  for (let i = 0; i < passes.length; i++) {
    const passNum    = i + 1;
    const chunkCtx   = chunkToContext(passes[i].files);

    if (onPassStart) onPassStart(passNum, total);

    let passOutput = '';
    await runBlastRadius(
      chunkCtx,
      forecastTarget,
      (chunk) => { passOutput += chunk; },
      {
        profile,
        forecastMode,
        onNarratorStart: () => {},
        onUsage,
      }
    );

    perPassResults.push(passOutput);
    if (onPassComplete) onPassComplete(passNum, total);
  }

  // ── Synthesis pass ────────────────────────────────────────────────────────
  // Feed all per-chunk blast outputs to a synthesis prompt that produces
  // one unified rollback plan. Uses the full patchedContext so the synthesizer
  // can reference any file.
  if (onSynthesisStart) onSynthesisStart();

  const combinedResults = perPassResults
    .map((r, i) => `=== BLAST PASS ${i + 1} OF ${total} ===\n${r}`)
    .join('\n\n---\n\n');

  // Build synthesis prompt inline — asks the model to merge N blast outputs
  // into one de-duplicated, priority-ranked rollback plan.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: resolveApiKey() });
  const synthesisModel = getConfig().get('defaultModel') || 'claude-sonnet-4-6';

  function getBlastMultipassSamplingParams(temperature) {
    const model = synthesisModel;
    if (model.includes('sonnet-5') || model.includes('opus-4-7') || model.includes('opus-4-8') || model.includes('opus-5')) {
      return {};
    }
    return { temperature };
  }

  const systemPrompt = `You are a senior software architect synthesizing multiple Blast Radius analysis passes into one unified report. Each pass analyzed a different chunk of the codebase. Your job is to merge them into a single, de-duplicated, priority-ranked Blast Radius + Rollback Plan. Remove duplicates. Merge related findings. Produce one clean report in the same format as a standard Ghost Architect Blast Radius report.`;

  const userMessage = `The following are Blast Radius analysis results from ${total} passes over a large codebase. Each pass analyzed a different subset of files. The target files being committed are: ${forecastTarget.join(', ')}.

Synthesize these into ONE unified Blast Radius report with:
1. Executive summary of total blast radius
2. De-duplicated, priority-ranked impact findings
3. One unified rollback plan

${combinedResults}`;

  let synthesisOutput = '';
  const stream = await anthropic.messages.stream({
    model:      synthesisModel,
    max_tokens: 8096,
    ...getBlastMultipassSamplingParams(0),
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userMessage }],
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      synthesisOutput += chunk.delta.text;
    }
  }

  // Capture real token usage from the synthesis call.
  if (onUsage) {
    try {
      const synthFinal = await stream.finalMessage();
      if (synthFinal?.usage) {
        onUsage(
          synthFinal.usage.input_tokens  ?? 0,
          synthFinal.usage.output_tokens ?? 0,
          synthesisModel
        );
      }
    } catch (_) {
      // Usage capture failed — response already delivered. Non-fatal.
    }
  }

  return synthesisOutput;
}
