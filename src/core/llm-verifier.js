/**
 * Ghost Architect™ — LLM-backed Finding Verifier
 *
 * Second-pass grounding check. For each finding that survives the regex-based
 * verifier, ask Claude directly: "here is the actual source; does this finding
 * accurately describe this code?"
 *
 * This catches semantic fabrications the regex pass cannot:
 *   - "method throws on empty input" when the method actually returns
 *   - "no validation is performed" when validation IS performed (just differently)
 *   - "silently swallows errors" when errors ARE propagated
 *   - "unbounded loop" when the loop has a clear termination
 *
 * Contract:
 *   - Input:  a finding object (title, detail, files) + the source code it cites
 *   - Output: { verdict: 'supports' | 'partial' | 'not_supported' | 'contradicts',
 *               reason: string }
 *
 *   'supports'       → finding matches what the code actually does. Keep it.
 *   'partial'        → finding is directionally correct but specifics are off.
 *                      Annotate as UNVERIFIED.
 *   'not_supported'  → cannot find evidence for the claim in the source. Drop.
 *   'contradicts'    → the code demonstrably does NOT match the claim
 *                      (e.g. finding says "no try/catch" but code has try/catch). Drop.
 *
 * Cost: ~1000–3000 input tokens + ~100 output tokens per finding.
 *       At Sonnet 4.5 pricing, roughly $0.005–$0.02 per finding. For a typical
 *       10-finding report, ~$0.05–$0.20 per scan.
 */

import Anthropic from '@anthropic-ai/sdk';
import { resolveApiKey, getConfig } from '../config.js';

// Keep source snippets under this size to control cost. Most findings reference
// a single file; if the file is huge, we truncate with context markers.
const MAX_SOURCE_CHARS = 12000;

function getClient() {
  return new Anthropic({ apiKey: resolveApiKey() });
}

function getModel() {
  return getConfig().get('defaultModel') || 'claude-sonnet-4-5';
}

/**
 * Truncate source intelligently — keep the start (imports, class declaration)
 * and the end (most methods defined) if the file is too long.
 */
function truncateSource(source) {
  if (source.length <= MAX_SOURCE_CHARS) return source;
  const halfBudget = Math.floor((MAX_SOURCE_CHARS - 200) / 2);
  return source.slice(0, halfBudget)
    + '\n\n... [middle of file truncated for verification — full file is longer] ...\n\n'
    + source.slice(-halfBudget);
}

const SYSTEM_PROMPT = `You are a code-grounding verifier. Your ONLY job is to decide whether a reported finding about a piece of code is actually supported by that code.

You will be given:
1. A FINDING: a title and description claiming some bug, issue, or pattern exists in the code.
2. The SOURCE CODE the finding cites.

Your job: read the source carefully, then decide if the finding accurately describes what the code does.

Output EXACTLY one JSON object, no prose before or after, with two keys:
  "verdict" — one of: "supports", "partial", "not_supported", "contradicts"
  "reason"  — one sentence explaining the verdict, citing specific evidence from the code

Verdict definitions:
  "supports"       — The code demonstrably does what the finding claims. The issue is real.
  "partial"        — The finding is directionally correct but some specifics (method names,
                     exact mechanism, line-level details) don't match. The underlying concern
                     may still be valid.
  "not_supported"  — You cannot find evidence in the code for the claim. The finding may be
                     based on inference rather than what's there.
  "contradicts"    — The code demonstrably does NOT have the issue. For example, the finding
                     claims "no transaction wrapping" but the code clearly uses transactions.
                     Or the finding claims a method exists that does not exist.

Rules:
  - Base your verdict ONLY on what the code shows. Do not reason from general knowledge about
    what "typically" happens in this kind of code.
  - If the finding recommends a fix that is already present in the code, that is "contradicts".
  - If the finding names methods that don't exist in the code, that is "contradicts" or "not_supported"
    depending on whether the underlying concern might still be valid.
  - Short, specific reasons. Quote a tiny snippet from the source if it clarifies.
  - Do NOT include any text outside the JSON object. No preamble, no markdown fences, just the JSON.`;

/**
 * Verify a single finding against its cited source code using the LLM.
 *
 * @param {object} finding — { title, detail, files, severity }
 * @param {string} source  — the combined source code of the cited files
 * @returns {Promise<{verdict: string, reason: string}>}
 */
export async function verifyFindingWithLLM(finding, source) {
  if (!finding || !source) {
    return { verdict: 'not_supported', reason: 'No source or finding provided.' };
  }

  const trimmedSource = truncateSource(source);

  const userMsg =
`FINDING TITLE: ${finding.title}

FINDING DETAIL:
${finding.detail || '(no detail)'}

FILES CITED: ${(finding.files || []).join(', ') || '(none)'}

SOURCE CODE:
\`\`\`
${trimmedSource}
\`\`\`

Respond with a single JSON object: { "verdict": "...", "reason": "..." }`;

  const anthropic = getClient();
  let raw = '';
  try {
    const stream = anthropic.messages.stream({
      model: getModel(),
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        raw += chunk.delta.text;
      }
    }
  } catch (err) {
    return { verdict: 'partial', reason: `LLM verifier call failed: ${err.message}` };
  }

  // Parse the JSON response. The prompt asks for a bare JSON object but LLMs
  // occasionally wrap it in markdown fences or add preamble — be defensive.
  const trimmed = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    const parsed = JSON.parse(trimmed);
    const verdict = String(parsed.verdict || '').toLowerCase();
    const reason  = String(parsed.reason  || '').trim();
    if (!['supports', 'partial', 'not_supported', 'contradicts'].includes(verdict)) {
      return { verdict: 'partial', reason: `Verifier returned unknown verdict: ${verdict || '(empty)'}` };
    }
    return { verdict, reason };
  } catch {
    // If we can't parse, try to extract a verdict heuristically from the text
    const lower = trimmed.toLowerCase();
    if (lower.includes('contradicts'))         return { verdict: 'contradicts',   reason: trimmed.slice(0, 200) };
    if (lower.includes('not_supported') ||
        lower.includes('not supported'))        return { verdict: 'not_supported', reason: trimmed.slice(0, 200) };
    if (lower.includes('partial'))              return { verdict: 'partial',       reason: trimmed.slice(0, 200) };
    if (lower.includes('supports'))             return { verdict: 'supports',      reason: trimmed.slice(0, 200) };
    return { verdict: 'partial', reason: `Could not parse verifier response: ${trimmed.slice(0, 100)}` };
  }
}

/**
 * Returns a verifier function suitable for passing to verifyReport() as options.llmVerifier.
 * This is the function called once per finding during the second pass.
 */
export function createLLMVerifier() {
  return async (finding, source) => verifyFindingWithLLM(finding, source);
}
