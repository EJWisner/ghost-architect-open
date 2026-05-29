// tests/ad-hoc/blast-multipass-import.test.mjs
// Verifies that the dynamic Anthropic import pattern used in
// blast-multipass.js works correctly in the ESM context.
// Run: node tests/ad-hoc/blast-multipass-import.test.mjs

const { default: Anthropic } = await import('@anthropic-ai/sdk');
const { getConfig } = await import('../../src/config.js');

const apiKey = getConfig().get('anthropicApiKey');
if (!apiKey) throw new Error('No API key in configstore');

const anthropic = new Anthropic({ apiKey });

const checks = [
  ['Anthropic class instantiated',       typeof anthropic === 'object'],
  ['messages.stream is callable',        typeof anthropic.messages.stream === 'function'],
  ['messages.create is callable',        typeof anthropic.messages.create === 'function'],
  ['apiKey is a non-empty string',       typeof apiKey === 'string' && apiKey.length > 0],
];

let failures = 0;
for (const [label, result] of checks) {
  console.log(`${result ? '✓' : '✗'}  ${label}`);
  if (!result) failures++;
}

console.log('');
console.log(`${checks.length} checks — ${failures} failure(s)`);
if (failures > 0) process.exit(1);
