/**
 * src/prompt-pack/models.js
 *
 * Model registry for Prompt Triage. Maps model IDs to their context
 * window size and tokenizer strategy. Used by detectors that need to
 * reason about a prompt's relationship to a target model (currently
 * length/excessive; eventually tokenLimitContextOverflow and
 * tokenLimitExcessive).
 *
 * Scope: Claude, GPT, Gemini, plus open-weight families (Llama, Mistral,
 * Qwen). Open-weight families use the heuristic tokenizer strategy. The
 * tokenLimit detectors handle heuristic uncertainty by downgrading severity
 * and explicitly disclosing "estimated via heuristic" in finding text, so
 * the user is never shown deceptive precision. F-07 closed in v5.3.1.
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

// @ghost-verified: hyphenated model IDs (e.g. claude-opus-4-7) are correct -- Anthropic's API accepts these IDs; the format matches what estimator.js PRICING table and llmAuditClient.js MODEL_RATES use
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

  // Meta Llama family. Heuristic only. Maverick window picked at 256K to
  // reflect the reliable working range; Scout's nominal 10M is gated by
  // "lost in the middle" effects and is intentionally not the chosen
  // threshold here. Falsely warning is safer than falsely clearing.
  { id: 'llama-4-maverick',      family: 'meta',      displayName: 'Llama 4 Maverick',      contextWindow: 256000,  tokenizerStrategy: 'heuristic' },
  { id: 'llama-3-3-70b',         family: 'meta',      displayName: 'Llama 3.3 70B',         contextWindow: 128000,  tokenizerStrategy: 'heuristic' },

  // Mistral AI family. Heuristic only.
  { id: 'mistral-large-3',       family: 'mistral',   displayName: 'Mistral Large 3',       contextWindow: 256000,  tokenizerStrategy: 'heuristic' },
  { id: 'mistral-small-3',       family: 'mistral',   displayName: 'Mistral Small 3',       contextWindow: 32000,   tokenizerStrategy: 'heuristic' },

  // Alibaba Qwen family. Heuristic only. Qwen 3.5 native window is 256K
  // (extendable to 1M via YaRN); 256K used here as the unmodified default.
  { id: 'qwen-3-5',              family: 'alibaba',   displayName: 'Qwen 3.5',              contextWindow: 256000,  tokenizerStrategy: 'heuristic' },
  { id: 'qwen-2-5',              family: 'alibaba',   displayName: 'Qwen 2.5',              contextWindow: 128000,  tokenizerStrategy: 'heuristic' },

  // Test-only entries. Marked testOnly: true so listModelsForPicker()
  // hides them from the end-user CLI prompt. Smoke tests and the
  // generator pass these IDs explicitly. Do not display in production UX.
  {
    id: 'test-tiny-4k',
    family: 'test',
    displayName: '(test) Tiny 4K window',
    contextWindow: 4000,
    tokenizerStrategy: 'tiktoken',
    testOnly: true,
  },
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
 * Includes test-only entries. For end-user CLI menus, use
 * listModelsForPicker() instead.
 *
 * @returns {Array<object>}
 */
export function listModels() {
  return MODELS.slice();
}

/**
 * Like listModels() but excludes test-only entries. Use this in any
 * end-user-facing UX (CLI inquirer choices, web pickers, docs).
 *
 * @returns {Array<object>}
 */
export function listModelsForPicker() {
  return MODELS.filter(m => !m.testOnly);
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
