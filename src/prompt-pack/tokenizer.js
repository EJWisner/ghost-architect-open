/**
 * src/prompt-pack/tokenizer.js
 *
 * Pluggable token counter for Prompt Triage. Two public functions:
 *
 *   countTokens(text, modelId)
 *     Returns exact tiktoken counts for OpenAI models, heuristic
 *     estimates for everything else (including Claude and Gemini).
 *     No network calls. Used by detectors that prefer speed and
 *     graceful degradation over precision (currently length/excessive).
 *
 *   countTokensExact(text, modelId)
 *     Same as countTokens for OpenAI (tiktoken is already exact).
 *     For Claude, calls the Anthropic SDK messages.countTokens()
 *     endpoint over the network for ground-truth counts. For Gemini,
 *     falls back to heuristic (no offline tokenizer; no Gemini SDK
 *     dep this session). Used by detectors that need precision to
 *     answer their question correctly (tokenLimitContextOverflow,
 *     tokenLimitExcessive). On any API failure, degrades to heuristic
 *     and tags the result with estimated: true.
 *
 * Both functions return the same shape:
 *
 *   { count: number, estimated: boolean, strategy: string }
 *
 *   strategy is one of: 'tiktoken' | 'heuristic' | 'anthropic-api'
 *
 * Why two functions instead of one with a flag: detectors that should
 * NEVER hit the network (length/excessive runs against every prompt)
 * cannot accidentally do so. The function name is the contract.
 *
 * Per-run cache: results are cached by (functionName, modelId,
 * text-fingerprint) so repeated calls for the same input return
 * instantly. Cache lifetime is module-load (process lifetime for the
 * CLI). Acceptable because the same (text, model) pair deterministically
 * produces the same count.
 *
 * Failure mode: neither function ever throws. Any failure path
 * returns the heuristic count with estimated: true. Detector
 * pipelines should not crash because a tokenizer module misbehaved.
 */

import { getModel } from './models.js';
import { resolveApiKey } from '../config.js';

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
  'gpt-5':         'gpt-tokenizer/encoding/o200k_base',
  'gpt-4o':        'gpt-tokenizer/encoding/o200k_base',
  'gpt-4o-mini':   'gpt-tokenizer/encoding/o200k_base',
  'gpt-4-1':       'gpt-tokenizer/encoding/o200k_base',
  // Test-only entry. Uses the same o200k_base encoder as modern OpenAI
  // models so fixture sizing math is consistent across real and test
  // models.
  'test-tiny-4k':  'gpt-tokenizer/encoding/o200k_base',
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

// ── Per-run result cache ───────────────────────────────────────────────────

// Keyed by (functionName, modelId, textFingerprint). Same text +
// same model deterministically produces the same count, so we cache
// across calls within a process. Function name is part of the key
// because countTokens and countTokensExact may produce different
// results for the same input (Claude: heuristic vs anthropic-api).
const RESULT_CACHE = new Map();

// Cheap content fingerprint: length + first 64 + middle 64 + last 64.
// For text under 192 chars, returns the text itself. Three samples
// catch most realistic cases of distinct prompts that happen to share
// length and edges; full hashing would be more correct but cryptographic
// hashing of every prompt on every call is overkill for this workload.
function fingerprint(text) {
  if (text.length <= 192) return text;
  const mid = Math.floor(text.length / 2);
  return text.length
    + '::' + text.slice(0, 64)
    + '::' + text.slice(mid - 32, mid + 32)
    + '::' + text.slice(-64);
}

function cacheKey(fn, modelId, text) {
  return fn + '::' + (modelId || '_none_') + '::' + fingerprint(text);
}

// ── Anthropic API counter ──────────────────────────────────────────────────

// Delegate to the single shared Anthropic client owned by llmAuditClient.js
// so the exact token counter and the Tier 2 audit detectors share one client
// instance and one failure flag (no separate, uncoordinated singletons).
async function getAnthropicClient() {
  const { getAnthropicClient: getLLMClient } = await import('./llmAuditClient.js');
  return getLLMClient();
}

/**
 * Count tokens for a Claude prompt by calling the Anthropic API.
 * Returns null on any failure so the caller can fall back to heuristic.
 */
async function anthropicCountTokens(text, modelId) {
  const client = await getAnthropicClient();
  if (!client) return null;
  try {
    const result = await client.messages.countTokens({
      model: modelId,
      messages: [{ role: 'user', content: text }],
    });
    if (result && typeof result.input_tokens === 'number') {
      return result.input_tokens;
    }
    return null;
  } catch (err) {
    return null;
  }
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

  const key = cacheKey('fast', modelId, safeText);
  if (RESULT_CACHE.has(key)) return RESULT_CACHE.get(key);

  const result = await countTokensImpl(safeText, modelId);
  RESULT_CACHE.set(key, result);
  return result;
}

async function countTokensImpl(safeText, modelId) {
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

/**
 * Count tokens with maximum available precision for the given model.
 *
 * Same behavior as countTokens() for OpenAI (tiktoken is already exact)
 * and for null/unknown models (heuristic). For Claude, calls the
 * Anthropic API for ground-truth counts; falls back to heuristic on
 * any API failure (no key, network, rate limit, etc.). For Gemini,
 * falls back to heuristic (no API integration in v1).
 *
 * Use this from detectors that need precision to answer their
 * question correctly. Uses the network for Claude prompts.
 *
 * @param {string}   text
 * @param {string}  [modelId]
 * @returns {Promise<{ count: number, estimated: boolean, strategy: string }>}
 */
export async function countTokensExact(text, modelId) {
  const safeText = text == null ? '' : String(text);

  const key = cacheKey('exact', modelId, safeText);
  if (RESULT_CACHE.has(key)) return RESULT_CACHE.get(key);

  const result = await countTokensExactImpl(safeText, modelId);
  RESULT_CACHE.set(key, result);
  return result;
}

async function countTokensExactImpl(safeText, modelId) {
  const model = getModel(modelId);

  // No model or unknown model: heuristic.
  if (!model) {
    return {
      count: heuristicCount(safeText),
      estimated: true,
      strategy: 'heuristic',
    };
  }

  // Anthropic family: try API, fall back to heuristic on any failure.
  if (model.family === 'anthropic') {
    const apiCount = await anthropicCountTokens(safeText, model.id);
    if (apiCount !== null) {
      return {
        count: apiCount,
        estimated: false,
        strategy: 'anthropic-api',
      };
    }
    return {
      count: heuristicCount(safeText),
      estimated: true,
      strategy: 'heuristic',
    };
  }

  // OpenAI: tiktoken is already exact. Defer to countTokens().
  // Gemini: heuristic (no offline tokenizer, no SDK call this session).
  // Test entries with tiktoken strategy: tiktoken via countTokens().
  return countTokens(safeText, modelId);
}
