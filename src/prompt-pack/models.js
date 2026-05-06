/**
 * src/prompt-pack/models.js
 *
 * Model registry for Prompt Triage. Maps model IDs to their context
 * window size and tokenizer strategy. Used by detectors that need to
 * reason about a prompt's relationship to a target model (currently
 * length/excessive; eventually tokenLimitContextOverflow and
 * tokenLimitExcessive).
 *
 * Scope (v1): Claude, GPT, and Gemini families. Open models (Llama,
 * Mistral, Qwen, etc.) are intentionally omitted. Without an accurate
 * offline tokenizer for each open-model family, listing them in this
 * registry would imply a precision the heuristic cannot deliver.
 * Revisit when a unified open-model tokenizer story is viable.
 *
 * Tokenizer strategies:
 *   'tiktoken'   - use gpt-tokenizer for accurate BPE counts (OpenAI)
 *   'heuristic'  - use len/4 estimate (Claude, Gemini, anything else)
 *
 * For Claude: Anthropic deprecated @anthropic-ai/tokenizer for Claude 3+
 * and recommends the API messages.countTokens() endpoint, which would
 * require a network call per audit. Until we wire that up as a hybrid
 * detector, Claude prompts use the heuristic.
 *
 * For Gemini: no mature offline JS tokenizer exists. Heuristic only.
 *
 * Context windows are in tokens. These values change when providers
 * release new models or expand existing ones; keep this file current.
 */

// ── Registry ─────────────────────────────────────────────────────────────

const MODELS = [
  // Claude family
  { id: 'claude-opus-4-7',       family: 'anthropic', displayName: 'Claude Opus 4.7',       contextWindow: 200000, tokenizerStrategy: 'heuristic' },
  { id: 'claude-opus-4-6',       family: 'anthropic', displayName: 'Claude Opus 4.6',       contextWindow: 200000, tokenizerStrategy: 'heuristic' },
  { id: 'claude-sonnet-4-6',     family: 'anthropic', displayName: 'Claude Sonnet 4.6',     contextWindow: 200000, tokenizerStrategy: 'heuristic' },
  { id: 'claude-haiku-4-5',      family: 'anthropic', displayName: 'Claude Haiku 4.5',      contextWindow: 200000, tokenizerStrategy: 'heuristic' },

  // OpenAI family. Tiktoken via gpt-tokenizer.
  { id: 'gpt-5',                 family: 'openai',    displayName: 'GPT-5',                 contextWindow: 400000, tokenizerStrategy: 'tiktoken' },
  { id: 'gpt-4o',                family: 'openai',    displayName: 'GPT-4o',                contextWindow: 128000, tokenizerStrategy: 'tiktoken' },
  { id: 'gpt-4o-mini',           family: 'openai',    displayName: 'GPT-4o mini',           contextWindow: 128000, tokenizerStrategy: 'tiktoken' },
  { id: 'gpt-4-1',               family: 'openai',    displayName: 'GPT-4.1',               contextWindow: 1000000, tokenizerStrategy: 'tiktoken' },

  // Google Gemini family. No mature offline tokenizer; heuristic only.
  { id: 'gemini-2-5-pro',        family: 'google',    displayName: 'Gemini 2.5 Pro',        contextWindow: 2000000, tokenizerStrategy: 'heuristic' },
  { id: 'gemini-2-5-flash',      family: 'google',    displayName: 'Gemini 2.5 Flash',      contextWindow: 1000000, tokenizerStrategy: 'heuristic' },
];

// Indexed lookup. Built once at module load.
const MODEL_INDEX = new Map();
for (const m of MODELS) MODEL_INDEX.set(m.id, m);

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Look up a model by ID. Returns the model entry, or null if unknown.
 *
 * @param {string} modelId
 * @returns {object|null}
 */
export function getModel(modelId) {
  if (!modelId) return null;
  return MODEL_INDEX.get(modelId) || null;
}

/**
 * List every registered model. Returns a fresh array each call so
 * callers cannot mutate the registry.
 *
 * @returns {Array<object>}
 */
export function listModels() {
  return MODELS.slice();
}

/**
 * Group models by family for menu rendering. Returns an object whose
 * keys are family names and values are arrays of models in that family.
 *
 * @returns {object}
 */
export function getModelsByFamily() {
  const out = {};
  for (const m of MODELS) {
    if (!out[m.family]) out[m.family] = [];
    out[m.family].push(m);
  }
  return out;
}
