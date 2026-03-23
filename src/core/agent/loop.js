/**
 * Ghost Architect — Agent ReAct Loop
 * Core Reason → Act → Observe loop with hard step cap.
 * Pure async — no Chalk, no Inquirer, no console output.
 * Emits progress via callbacks for CLI/Web presentation layer.
 */

import Anthropic        from '@anthropic-ai/sdk';
import { getConfig, resolveApiKey } from '../../config.js';
import { buildToolDescriptions }    from './tools.js';

// ── Claude client ─────────────────────────────────────────────────────────────

function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-5'; }

// ── System prompt for agent ───────────────────────────────────────────────────

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

${context}`;
}

// ── Parse agent response ──────────────────────────────────────────────────────

function parseAgentResponse(raw) {
  try {
    // Strip markdown code fences if present
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch {
    // Try to extract JSON from the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    // Fallback — treat as finish with error
    return {
      reasoning: 'Failed to parse agent response — ending gracefully',
      action:    'finish',
      input:     { summary: raw.slice(0, 500), reason: 'parse_error' },
    };
  }
}

// ── Build next prompt from history ───────────────────────────────────────────

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
/**
 * Run the agent ReAct loop.
 *
 * @param {string}       task       — natural language task description
 * @param {object}       tools      — tool registry from buildTools()
 * @param {AgentMemory}  memory     — memory instance
 * @param {number}       maxSteps   — hard step cap (cost guardrail)
 * @param {object}       callbacks  — { onStep, onThought, onToolCall, onToolResult }
 * @returns {object}                — synthesized results from memory
 */
export async function runAgentLoop(task, tools, memory, maxSteps = 10, callbacks = {}) {
  const {
    onStep       = () => {},   // ({ step, maxSteps })
    onThought    = () => {},   // ({ reasoning, action, input })
    onToolCall   = () => {},   // ({ action, input })
    onToolResult = () => {},   // ({ action, result })
  } = callbacks;

  const anthropic    = getClient();
  const systemPrompt = buildAgentSystemPrompt(tools);
  let   lastResult   = null;
  let   finished     = false;

  for (let step = 1; step <= maxSteps && !finished; step++) {
    onStep({ step, maxSteps });

    // Build prompt for this iteration
    const userPrompt = buildIterationPrompt(task, memory.getHistory(), lastResult);

    // Call Claude for next action
    let raw = '';
    try {
      const response = await anthropic.messages.create({
        model:      getModel(),
        max_tokens: 1024,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      raw = response.content[0]?.text || '';
    } catch (err) {
      // API error — finish gracefully
      memory.record('error', { step }, { error: err.message }, 'API call failed');
      break;
    }

    // Parse the agent's decision
    const decision = parseAgentResponse(raw);
    const { reasoning, action, input } = decision;

    onThought({ reasoning, action, input, step });

    // Validate tool exists
    if (!tools[action]) {
      memory.record('invalid_action', { action }, { error: `Unknown tool: ${action}` }, reasoning);
      continue;
    }

    onToolCall({ action, input, step });

    // Execute the tool
    let result;
    try {
      result = await tools[action].execute(input || {});
    } catch (err) {
      result = { error: `Tool execution failed: ${err.message}` };
    }

    onToolResult({ action, input, result, step });

    // Record in memory
    memory.record(action, input, result, reasoning);
    lastResult = result;

    // Check if agent is done
    if (action === 'finish' || result?.done === true) {
      finished = true;
    }
  }

  // If loop hit maxSteps without finishing, record that
  if (!finished) {
    memory.record(
      'finish',
      { reason: 'step_cap' },
      { done: true, summary: `Step cap of ${maxSteps} reached`, reason: 'step_cap' },
      `Analysis stopped at step cap (${maxSteps})`
    );
  }

  return memory.synthesize();
}

// ── Mini loop for sub-tasks (verifier uses this) ──────────────────────────────
/**
 * Lightweight ReAct loop for sub-tasks like conflict verification.
 * Returns structured result rather than full memory synthesis.
 *
 * @param {string}  task
 * @param {object}  tools
 * @param {AgentMemory} memory
 * @param {number}  maxSteps
 * @param {string}  expectedOutputKey  — key to extract from last finish result
 */
export async function runMiniLoop(task, tools, memory, maxSteps = 3) {
  const result = await runAgentLoop(task, tools, memory, maxSteps);
  return result;
}
