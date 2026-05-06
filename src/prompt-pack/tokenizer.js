/**
 * src/prompt-pack/tokenizer.js
 *
 * Pluggable token counter for Prompt Triage. Returns accurate counts
 * for OpenAI models (via gpt-tokenizer) and a heuristic estimate for
 * everything else.
 *
 * Single public API:
 *
 *   countTokens(text, modelId) -> { count, estimated, strategy }
 *
 *   text:       string to count
 *   modelId:    model registry ID (or null/undefined for heuristic)
 *   returns:    {
 *     count:      number of tokens
 *     estimated:  true if heuristic was used, false if tokenizer was exact
 *     strategy:   'tiktoken' | 'heuristic'
 *   }
 *
 * Why the contract matters: callers (detectors) use the `estimated`
 * flag to decide what language to put in finding messages. A finding
 * that says "approximately 3,200 tokens (estimated)" sets different
 * user expectations than "3,124 tokens (counted via gpt-tokenizer)."
 *
 * Failure mode: if a tiktoken-strategy model is requested but the
 * encoding fails to load (corrupt install, unsupported model ID), we
 * fall back to the heuristic and tag the result as estimated. We never
 * throw from countTokens(); detector pipelines should not crash because
 * a tokenizer module misbehaved.
 */

import { getModel } from './models.js';

// Approximate chars-per-token for English prose. Used by the heuristic
// fallback. Matches the constant in length.js so the two stay in sync.
const CHARS_PER_TOKEN = 4;

/**
 * OpenAI encoding selection. gpt-tokenizer ships per-encoding modules
 * which we lazy-load so we don't pay the cost of loading every BPE
 * table at startup.
 *
 *   o200k_base  - gpt-4o, gpt-4o-mini, gpt-4.1, gpt-5, o-series
 *   cl100k_base - gpt-4 (original), gpt-3.5-turbo
 *
 * Map model ID -> encoding module path. Add new entries when new
 * OpenAI models are added to models.js.
 */
const OPENAI_ENCODING_PATHS = {
  'gpt-5':       'gpt-tokenizer/encoding/o200k_base',
  'gpt-4o':      'gpt-tokenizer/encoding/o200k_base',
  'gpt-4o-mini': 'gpt-tokenizer/encoding/o200k_base',
  'gpt-4-1':     'gpt-tokenizer/encoding/o200k_base',
};

// Cache loaded encoders so we only dynamically import each one once.
const ENCODER_CACHE = new Map();

async function loadOpenAIEncoder(modelId) {
  if (ENCODER_CACHE.has(modelId)) return ENCODER_CACHE.get(modelId);
  const encodingPath = OPENAI_ENCODING_PATHS[modelId];
  if (!encodingPath) return null;
  try {
    const mod = await import(encodingPath);
    const encoder = { encode: mod.encode };
    ENCODER_CACHE.set(modelId, encoder);
    return encoder;
  } catch (err) {
    // Cache the null so we don't retry a broken import on every call.
    ENCODER_CACHE.set(modelId, null);
    return null;
  }
}

function heuristicCount(text) {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Count tokens in text against the given model.
 *
 * @param {string}   text
 * @param {string}  [modelId]
 * @returns {Promise<{ count: number, estimated: boolean, strategy: string }>}
 */
export async function countTokens(text, modelId) {
  const safeText = text == null ? '' : String(text);

  // No model specified or unknown model: heuristic only.
  const model = getModel(modelId);
  if (!model) {
    return {
      count: heuristicCount(safeText),
      estimated: true,
      strategy: 'heuristic',
    };
  }

  // Heuristic-strategy model (Claude, Gemini): no tokenizer call.
  if (model.tokenizerStrategy === 'heuristic') {
    return {
      count: heuristicCount(safeText),
      estimated: true,
      strategy: 'heuristic',
    };
  }

  // Tiktoken-strategy model (OpenAI): load encoder, count, fall back
  // to heuristic on any failure.
  if (model.tokenizerStrategy === 'tiktoken') {
    const encoder = await loadOpenAIEncoder(model.id);
    if (!encoder) {
      return {
        count: heuristicCount(safeText),
        estimated: true,
        strategy: 'heuristic',
      };
    }
    try {
      const tokens = encoder.encode(safeText);
      return {
        count: tokens.length,
        estimated: false,
        strategy: 'tiktoken',
      };
    } catch (err) {
      return {
        count: heuristicCount(safeText),
        estimated: true,
        strategy: 'heuristic',
      };
    }
  }

  // Unknown strategy: defensive fallback. Should not happen if models.js
  // is internally consistent, but better to degrade than crash.
  return {
    count: heuristicCount(safeText),
    estimated: true,
    strategy: 'heuristic',
  };
}
