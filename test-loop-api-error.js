/**
 * Ghost Architect — Agent Loop API-Error Test
 * Run: node test-loop-api-error.js
 *
 * Verifies that when the agent loop aborts on an API error, the synthesized
 * result reports ok: false and carries the API error message at the top level
 * (so callers don't have to parse the memory/audit trail). Makes NO real API
 * calls — it injects a fake client whose messages.create() always throws.
 */

import { runAgentLoop, __setClientFactoryForTest } from './src/core/agent/loop.js';
import { AgentMemory }                             from './src/core/agent/memory.js';

const API_ERROR_MESSAGE = 'Injected API failure: 401 Unauthorized';

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('\x1b[32m✓\x1b[0m', msg); }
  else      { console.error('\x1b[31m✗\x1b[0m', msg); failures++; }
}

async function main() {
  console.log('\nTEST: Agent loop surfaces API errors (ok: false + apiError)\n');

  // Inject a client whose API call always throws — simulates an API outage/auth failure.
  __setClientFactoryForTest(() => ({
    messages: {
      create: async () => { throw new Error(API_ERROR_MESSAGE); },
    },
  }));

  const warnings = [];
  try {
    const memory = new AgentMemory();
    const tools  = {}; // loop aborts on the first API call, before any tool use
    const result = await runAgentLoop(
      'Analyze this codebase.',
      tools, memory, 3,
      { onWarning: ({ message }) => warnings.push(message) }
    );

    assert(result.ok === false,            'result.ok is false when the loop aborts on an API error');
    assert(typeof result.apiError === 'string',
           'result.apiError is a string');
    assert((result.apiError || '').includes(API_ERROR_MESSAGE),
           'result.apiError includes the underlying API error message');
    assert(result.hasWarnings === true,    'result.hasWarnings is true on API error');
    assert(warnings.some(w => w.includes(API_ERROR_MESSAGE)),
           'onWarning callback received the API error message');

    // Sanity check: a result without an API error reports ok: true / apiError: null.
    // (No client call happens because the loop has no tools and finishes at step cap
    //  only after an API call — so we just assert the negative-path shape directly via
    //  a fresh run where the client returns a valid finish decision.)
    __setClientFactoryForTest(() => ({
      messages: {
        create: async () => ({
          content: [{ text: JSON.stringify({ reasoning: 'done', action: 'finish', input: { summary: 'ok', reason: 'complete' } }) }],
          usage:   { input_tokens: 1, output_tokens: 1 },
        }),
      },
    }));
    const okMemory = new AgentMemory();
    const okResult = await runAgentLoop('Analyze.', { finish: { execute: async () => ({ done: true }) } }, okMemory, 3, {});
    assert(okResult.ok === true,        'result.ok is true on a clean run');
    assert(okResult.apiError === null,  'result.apiError is null on a clean run');
  } finally {
    __setClientFactoryForTest(null); // reset the seam for any later imports
  }

  console.log('');
  if (failures) {
    console.error(`\x1b[31m${failures} assertion(s) failed\x1b[0m\n`);
    process.exit(1);
  }
  console.log('\x1b[32mAPI-error test PASS\x1b[0m\n');
}

main().catch(err => {
  console.error('\n\x1b[31m✗ TEST FAILED:\x1b[0m', err.message);
  console.error(err.stack);
  process.exit(1);
});
