/**
 * Smoke test for transient-stream-error retry in src/core/agent/loop.js.
 *
 * Transient stream errors ("Premature close", "ECONNRESET", "socket hang up",
 * "UND_ERR_SOCKET") used to abort the entire scan on the first occurrence,
 * yielding zero findings. The loop now retries the Anthropic API call up to
 * MAX_STREAM_RETRIES times with exponential backoff before giving up. These
 * tests lock in that behavior using the __setClientFactoryForTest seam to
 * inject a fake client — no network, no API key required.
 *
 * Run: node tests/agent-loop-stream-retry.smoke.mjs
 */

import { runAgentLoop, __setClientFactoryForTest } from '../src/core/agent/loop.js';
import { AgentMemory } from '../src/core/agent/memory.js';

let failures = 0;

function check(label, cond) {
  if (cond) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    failures++;
  }
}

// A minimal tool set whose finish tool returns done:true so the loop
// terminates after a single successful step.
const TOOLS = {
  finish: { description: 'finish', execute: async () => ({ done: true }) },
};

// A finish decision so the loop terminates after a single successful step.
const FINISH_RESPONSE = {
  content: [{ type: 'text', text: JSON.stringify({
    reasoning: 'Done', action: 'finish', input: { summary: 'ok', reason: 'complete' },
  }) }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

function makeTransientError(message) {
  const err = new Error(message);
  err.name = 'APIConnectionError';
  return err;
}

// ── Test 1: one transient error then success → loop retries and completes ──
console.log('Test 1: transient error ("Premature close") is retried, then loop succeeds');
{
  let calls = 0;
  __setClientFactoryForTest(() => ({
    messages: {
      create: async () => {
        calls++;
        if (calls === 1) throw makeTransientError('Premature close');
        return FINISH_RESPONSE;
      },
    },
  }));

  const memory   = new AgentMemory();
  const warnings = [];
  const result   = await runAgentLoop('analyze', TOOLS, memory, 5, {
    onWarning: ({ message }) => warnings.push(message),
  });

  check('API create() was called twice (1 failure + 1 success)', calls === 2);
  check('result.ok is true (no fatal API error)', result.ok === true);
  check('result.apiError is null', result.apiError === null);
  check('a retry warning was surfaced',
    warnings.some(w => w.includes('Transient stream error') && w.includes('retry 1/2')));
  check('a stream_retry was recorded in the audit trail',
    memory.actionsHistory.some(e => e.action === 'stream_retry'));
  check('the finish action ran (loop progressed past the error)',
    memory.actionsHistory.some(e => e.action === 'finish'));
}
console.log('');

// ── Test 2: non-transient error aborts immediately (no retry) ──────────────
console.log('Test 2: a non-transient error aborts the loop with no retry');
{
  let calls = 0;
  __setClientFactoryForTest(() => ({
    messages: {
      create: async () => {
        calls++;
        throw new Error('401 invalid x-api-key');
      },
    },
  }));

  const memory = new AgentMemory();
  const result = await runAgentLoop('analyze', {}, memory, 5, {});

  check('API create() was called exactly once (no retry)', calls === 1);
  check('result.ok is false', result.ok === false);
  check('result.apiError carries the message', /invalid x-api-key/.test(result.apiError || ''));
}
console.log('');

// ── Test 3: retries exhausted → loop aborts with the transient message ─────
console.log('Test 3: persistent transient error exhausts retries, then aborts');
{
  let calls = 0;
  __setClientFactoryForTest(() => ({
    messages: {
      create: async () => {
        calls++;
        throw makeTransientError('ECONNRESET');
      },
    },
  }));

  const memory = new AgentMemory();
  const result = await runAgentLoop('analyze', {}, memory, 5, {});

  // 1 initial attempt + MAX_STREAM_RETRIES (2) retries = 3 calls
  check('API create() was called 3 times (initial + 2 retries)', calls === 3);
  check('result.ok is false after exhausting retries', result.ok === false);
  check('result.apiError carries the transient message', /ECONNRESET/.test(result.apiError || ''));
}
console.log('');

// Reset the seam so we never leak a fake client to other suites.
__setClientFactoryForTest(null);

if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
