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
import { getSamplingParams }        from '../../utils/sampling-params.js';

// Client factory is overridable so tests can inject a fake client (e.g. one
// whose messages.create() throws) without making real API calls.
let clientFactory = () => new Anthropic({ apiKey: resolveApiKey() });
function getClient() { return clientFactory(); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-6'; }

/** Test seam — override the Anthropic client factory. Pass null to reset. */
export function __setClientFactoryForTest(factory) {
  clientFactory = factory || (() => new Anthropic({ apiKey: resolveApiKey() }));
}

// Transient stream errors (dropped sockets mid-response) abort a whole scan
// with zero findings if not retried. We retry these a small number of times
// with exponential backoff before giving up on the step.
const MAX_STREAM_RETRIES = 2;
const TRANSIENT_STREAM_PATTERNS = ['Premature close', 'ECONNRESET', 'socket hang up', 'UND_ERR_SOCKET'];

function isTransientStreamError(err) {
  const msg = (err && err.message) || '';
  return TRANSIENT_STREAM_PATTERNS.some(pattern => msg.includes(pattern));
}

// In CI (GitHub Actions sets CI=true), the streaming connection to the
// Anthropic API gets dropped consistently on large-context scans (~150K tokens),
// surfacing as "Premature close". Retrying the same streaming call fails the same
// way. In CI we force a non-streaming request (stream: false) so the SDK waits for
// the full response in one shot, which eliminates the mid-response stream closure.
// Local dev keeps the existing behavior untouched.
//
// Detection mirrors src/license/validator.js: trust CI, but also honor
// GITHUB_ACTIONS as a fallback in case a runner ever leaves CI unset/empty.
function isCI() {
  const truthy = (v) => v !== undefined && v !== '' && v !== 'false' && v !== '0';
  return truthy(process.env.CI) || truthy(process.env.GITHUB_ACTIONS);
}

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
    onUsage      = null,       // (inputTokens, outputTokens, model) — cost tracking
  } = callbacks;

  const anthropic    = getClient();
  const systemPrompt = buildAgentSystemPrompt(tools);
  const inCI         = isCI();
  let   lastResult   = null;
  let   finished     = false;
  let   parseErrors  = 0;      // track parse failures across whole run
  let   skippedSteps = 0;      // steps dropped because their response never parsed (results incomplete)
  let   apiError     = null;   // set to the API error message if the loop aborts on an API failure
  const MAX_PARSE_RETRIES = 2; // per step

  // Surface the CI non-streaming switch through the warning channel so it shows
  // up in the GitHub Actions log (this module emits no console output directly).
  if (inCI) {
    onWarning({ message: 'CI environment detected — using non-streaming Anthropic API calls (stream: false) to avoid premature stream closure on large-context scans.' });
  }

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
        // Transient stream errors (Premature close / dropped sockets) are
        // retried in-place with exponential backoff so a momentary network
        // blip does not abort the entire scan. Any other error, or exhausting
        // the retries, falls through to the outer catch and aborts the loop.
        let response = null;
        for (let streamAttempt = 0; ; streamAttempt++) {
          try {
            // In CI, force a non-streaming response (stream: false) so the SDK
            // waits for the full message instead of holding a stream that the CI
            // network drops mid-response on large contexts. Locally we omit the
            // flag entirely to preserve the existing behavior.
            const createParams = {
              model:      getModel(),
              max_tokens: 1024,
              ...getSamplingParams(0, getModel()),
              system:     systemPrompt,
              messages:   [{ role: 'user', content: prompt }],
            };
            if (inCI) createParams.stream = false;
            response = await anthropic.messages.create(createParams);
            break; // success — leave the stream-retry loop
          } catch (streamErr) {
            if (isTransientStreamError(streamErr) && streamAttempt < MAX_STREAM_RETRIES) {
              const backoffMs = 1000 * Math.pow(2, streamAttempt); // 1000ms, then 2000ms
              memory.record(
                'stream_retry',
                { step, attempt, streamAttempt: streamAttempt + 1 },
                { error: streamErr.message },
                'Transient stream error — retrying'
              );
              onWarning({
                message: `Transient stream error at step ${step} (retry ${streamAttempt + 1}/${MAX_STREAM_RETRIES}) — ${streamErr.message}; retrying in ${backoffMs}ms...`,
              });
              await new Promise(resolve => setTimeout(resolve, backoffMs));
              continue; // retry the API call
            }
            throw streamErr; // non-transient, or retries exhausted
          }
        }
        raw = response.content[0]?.text || '';
        // Capture real API usage for cost tracking (one record per loop step)
        if (onUsage && response.usage) {
          onUsage(
            response.usage.input_tokens  ?? 0,
            response.usage.output_tokens ?? 0,
            getModel()
          );
        }
      } catch (err) {
        // API error — record and break out of step loop entirely.
        // Capture the message so callers can detect the abort (result.ok === false)
        // and surface it without parsing the memory/audit trail.
        apiError = err.message;
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
    if (!decision) {
      // Parse retries were exhausted for this step (decision stayed null), so
      // the step is dropped. Count it so the result reports incompleteness
      // instead of masquerading as a complete analysis.
      skippedSteps++;
      continue;
    }

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
  result.skippedSteps  = skippedSteps;                   // steps dropped after parse retries exhausted
  result.incomplete    = skippedSteps > 0;               // true when at least one step was dropped
  // ok is false when the loop aborted on an API error OR dropped one or more
  // steps to unparseable responses. Callers should check result.ok and handle
  // the failure (warn / prompt retry) rather than treating a truncated result
  // as a complete analysis.
  result.ok            = apiError === null && skippedSteps === 0;
  result.apiError      = apiError;                       // null when no API error occurred
  result.hasWarnings   = parseErrors > 0 || apiError !== null || skippedSteps > 0;

  // Summary warning so a partial run is visible even if the per-step onWarning
  // messages scrolled past. Routed through onWarning (not console.warn) to keep
  // this module's "no direct console output" contract — the CLI decides how to
  // surface it, same as every other warning here. onWarning takes { message }.
  if (skippedSteps > 0) {
    onWarning({ message: `Ghost Agent: ${skippedSteps} step(s) could not be parsed and were skipped. Results may be incomplete.` });
  }

  return result;
}

export async function runMiniLoop(task, tools, memory, maxSteps = 3, callbacks = {}) {
  return runAgentLoop(task, tools, memory, maxSteps, callbacks);
}
