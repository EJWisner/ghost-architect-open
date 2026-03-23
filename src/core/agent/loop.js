/**
 * Ghost Architect — Agent ReAct Loop
 * Core Reason → Act → Observe loop with hard step cap.
 * Pure async — no Chalk, no Inquirer, no console output.
 * Emits progress via callbacks for CLI/Web presentation layer.
 *
 * v4.5.1: Parse error retry (max 2 attempts), structured warnings, no silent failures.
 */

import Anthropic        from '@anthropic-ai/sdk';
import { getConfig, resolveApiKey } from '../../config.js';
import { buildToolDescriptions }    from './tools.js';

function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-5'; }

function buildAgentSystemPrompt(tools, context = '') {
  return `You are Ghost Architect's autonomous analysis agent — a senior software architect AI.

Your job is to analyze codebases by using the available tools, then report confirmed findings.

AVAILABLE TOOLS:
${buildToolDescriptions(tools)}

HOW TO RESPOND:
Always respond with a JSON object in this exact format:
{
  "reasoning": "Brief explanation of what you found and why you're taking this action",
  "action": "toolName",
  "input": { ...tool input parameters }
}

Or when you are done:
{
  "reasoning": "Summary of analysis complete",
  "action": "finish",
  "input": { "summary": "...", "reason": "complete" }
}

RULES:
- Use tools systematically. Start broad (listDirectory, searchFiles), then go deep (readFile, summarizeFile).
- Only call flagFinding for CONFIRMED issues — not candidates or suspicions.
- Always provide reasoning before every action.
- If a file is not found, try searchFiles to locate it differently.
- Call finish when: all relevant files analyzed, step cap approaching, or task is complete.
- Never fabricate file contents — only work with what the tools return.
- IMPORTANT: Respond with valid JSON only. No preamble text, no markdown, no explanation before the JSON.

${context}`;
}

// ── Parse agent response — with retry support ────────────────────────────────

function parseAgentResponse(raw) {
  // Strip markdown code fences
  const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  // Try direct parse
  try { return { decision: JSON.parse(clean), parseError: null }; } catch { /* fall through */ }

  // Try extracting JSON block from response that has preamble text
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try { return { decision: JSON.parse(match[0]), parseError: null }; } catch { /* fall through */ }
  }

  // Parse failed — return error for retry logic
  return {
    decision:   null,
    parseError: `Could not parse JSON from response. Raw (first 300 chars): ${raw.slice(0, 300)}`,
  };
}

function buildRetryPrompt(task, history, lastResult, parseError) {
  return `TASK: ${task}

Your previous response could not be parsed as JSON. Error: ${parseError}

You MUST respond with ONLY a valid JSON object. No text before or after. No markdown. Just JSON.

Example of correct format:
{"reasoning": "I will list the files first", "action": "listDirectory", "input": {"path": "src"}}

What is your next action?`;
}

function buildIterationPrompt(task, history, lastResult) {
  const historyStr = history.length > 0
    ? '\n\nACTION HISTORY (most recent last):\n' +
      history.map(h =>
        `Step ${h.step}: ${h.action}(${JSON.stringify(h.input).slice(0, 100)}) → ${h.resultSummary}`
      ).join('\n')
    : '';

  const resultStr = lastResult
    ? `\n\nLAST TOOL RESULT:\n${JSON.stringify(lastResult, null, 2).slice(0, 2000)}`
    : '';

  return `TASK: ${task}${historyStr}${resultStr}\n\nWhat is your next action? Respond with JSON only.`;
}

// ── Main ReAct loop ───────────────────────────────────────────────────────────

export async function runAgentLoop(task, tools, memory, maxSteps = 10, callbacks = {}) {
  const {
    onStep       = () => {},
    onThought    = () => {},
    onToolCall   = () => {},
    onToolResult = () => {},
    onWarning    = () => {},   // NEW: ({ message }) — surfaces warnings to CLI
  } = callbacks;

  const anthropic    = getClient();
  const systemPrompt = buildAgentSystemPrompt(tools);
  let   lastResult   = null;
  let   finished     = false;
  let   parseErrors  = 0;      // track parse failures across whole run
  const MAX_PARSE_RETRIES = 2; // per step

  for (let step = 1; step <= maxSteps && !finished; step++) {
    onStep({ step, maxSteps });

    const userPrompt = buildIterationPrompt(task, memory.getHistory(), lastResult);

    // ── API call with retry on parse error ──────────────────────────────────
    let decision = null;
    let raw      = '';

    for (let attempt = 1; attempt <= MAX_PARSE_RETRIES + 1; attempt++) {
      // Build prompt — use retry prompt if we had a parse failure
      const prompt = attempt === 1
        ? userPrompt
        : buildRetryPrompt(task, memory.getHistory(), lastResult,
            `Attempt ${attempt - 1} failed to parse`);

      try {
        const response = await anthropic.messages.create({
          model:      getModel(),
          max_tokens: 1024,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: prompt }],
        });
        raw = response.content[0]?.text || '';
      } catch (err) {
        // API error — record and break out of step loop entirely
        memory.record('api_error', { step, attempt }, { error: err.message }, 'API call failed');
        onWarning({ message: `API error at step ${step}: ${err.message}` });
        finished = true;
        break;
      }

      const { decision: parsed, parseError } = parseAgentResponse(raw);

      if (parsed) {
        decision = parsed;
        break; // successful parse — proceed
      }

      // Parse failed
      parseErrors++;
      memory.record('parse_error', { step, attempt, raw: raw.slice(0, 500) }, { error: parseError }, 'Parse failed');

      if (attempt <= MAX_PARSE_RETRIES) {
        onWarning({ message: `Parse error at step ${step} (attempt ${attempt}/${MAX_PARSE_RETRIES}) — retrying...` });
        continue; // retry
      }

      // All retries exhausted — warn and skip this step
      onWarning({ message: `⚠ Agent loop: step ${step} failed to parse after ${MAX_PARSE_RETRIES} attempts — results may be incomplete` });
      decision = null;
      break;
    }

    if (finished) break;
    if (!decision) continue; // skip step, move to next

    const { reasoning, action, input } = decision;
    onThought({ reasoning, action, input, step });

    if (!tools[action]) {
      memory.record('invalid_action', { action }, { error: `Unknown tool: ${action}` }, reasoning);
      continue;
    }

    onToolCall({ action, input, step });

    let result;
    try {
      result = await tools[action].execute(input || {});
    } catch (err) {
      result = { error: `Tool execution failed: ${err.message}` };
    }

    onToolResult({ action, input, result, step });
    memory.record(action, input, result, reasoning);
    lastResult = result;

    if (action === 'finish' || result?.done === true) {
      finished = true;
    }
  }

  if (!finished) {
    memory.record(
      'finish',
      { reason: 'step_cap' },
      { done: true, summary: `Step cap of ${maxSteps} reached`, reason: 'step_cap' },
      `Analysis stopped at step cap (${maxSteps})`
    );
  }

  // Attach warning metadata to result
  const result = memory.synthesize();
  result.parseErrors   = parseErrors;
  result.hasWarnings   = parseErrors > 0;
  return result;
}

export async function runMiniLoop(task, tools, memory, maxSteps = 3) {
  return runAgentLoop(task, tools, memory, maxSteps);
}
