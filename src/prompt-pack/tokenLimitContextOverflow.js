/**
 * src/prompt-pack/tokenLimitContextOverflow.js
 *
 * Detector #3: Token limit context overflow (Tier 1, hybrid).
 *
 * Flags prompts whose token count exceeds the target model's context
 * window. The user already knows when a prompt is over the limit (the
 * API rejects the call); this detector exists so they catch it BEFORE
 * shipping to production. Distinct from tokenLimitExcessive (which
 * fires below 100% as a warning) and from length/excessive (which is
 * about bloat regardless of model).
 *
 * Tier 1 / hybrid:
 *   For OpenAI prompts, the "API call" is local tiktoken (free, fast).
 *   For Claude prompts, this detector hits the Anthropic API for
 *   ground-truth counts. For Gemini and unknown models, falls back
 *   to the heuristic (with a downgraded severity to reflect uncertainty).
 *
 * Skip logic:
 *   No target model -> no finding. The detector cannot answer "are
 *   you over the model's window" without knowing which model.
 *   The mode file surfaces a one-line note when this skip happens
 *   so the absence is explained, not invisible.
 *
 * Severity policy:
 *   Exact count over window         -> HIGH
 *   Heuristic count over window     -> MEDIUM (we are less confident
 *                                       a heuristic-driven overflow
 *                                       claim is real)
 *   Count <= window                 -> no finding
 */

import { countTokensExact } from './tokenizer.js';
import { getModel } from './models.js';

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  if (!opts.targetModel) return [];
  const model = getModel(opts.targetModel);
  if (!model || !model.contextWindow) return [];

  const tokenResult = await countTokensExact(promptText, opts.targetModel);
  const { count, estimated, strategy } = tokenResult;

  if (count <= model.contextWindow) return [];

  const overBy = count - model.contextWindow;
  const percentOver = ((count / model.contextWindow) * 100).toFixed(1);
  const severity = estimated ? 'MEDIUM' : 'HIGH';

  let detail;
  if (estimated) {
    detail = 'The prompt is approximately ' + count + ' tokens (estimated '
      + 'via heuristic), which exceeds the ' + model.displayName + ' context '
      + 'window of ' + model.contextWindow.toLocaleString() + ' tokens by '
      + 'about ' + overBy + ' (' + percentOver + '% of window). The exact '
      + 'count could not be determined; severity is downgraded to MEDIUM '
      + 'because heuristic-driven overflow claims are less reliable than '
      + 'API-verified counts. The model will reject this prompt at API '
      + 'call time if the heuristic is correct.';
  } else {
    detail = 'The prompt is ' + count + ' tokens (counted via ' + strategy
      + '), which exceeds the ' + model.displayName + ' context window of '
      + model.contextWindow.toLocaleString() + ' tokens by ' + overBy
      + ' (' + percentOver + '% of window). The model will reject this '
      + 'prompt at API call time. No partial response is possible until '
      + 'the prompt is shortened.';
  }

  return [
    {
      detector: 'tokenLimitContextOverflow',
      severity,
      title: 'Prompt exceeds context window',
      file: filePath,
      location: null,
      detail,
      remediation:
        'Reduce the prompt length below the ' + model.displayName + ' '
        + 'context window of ' + model.contextWindow.toLocaleString()
        + ' tokens. Reserve headroom for the response (often 4K-8K tokens) '
        + 'and any tool definitions. Strategies: trim system instructions, '
        + 'move static reference material out of the prompt and into '
        + 'retrieval, or split work across multiple turns.',
      confidence: estimated ? 70 : 95,
    },
  ];
}
