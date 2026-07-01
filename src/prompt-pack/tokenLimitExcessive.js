/**
 * src/prompt-pack/tokenLimitExcessive.js
 *
 * Detector #4: Token limit excessive — approaching context window
 * (Tier 1, hybrid).
 *
 * Flags prompts that consume a high percentage of the target model's
 * context window without actually overflowing. Distinct from
 * tokenLimitContextOverflow (which fires above 100%) and from
 * length/excessive (which is about absolute prompt bloat regardless
 * of model). This detector exists because the most useful warning
 * is the one you can act on BEFORE the API rejects the call.
 *
 * Tier 1 / hybrid:
 *   For OpenAI prompts, the "API call" is local tiktoken (free, fast).
 *   For Claude prompts, this detector hits the Anthropic API for
 *   ground-truth counts. For Gemini and unknown models, falls back
 *   to the heuristic.
 *
 * Skip logic:
 *   No target model -> no finding. The detector cannot answer "how
 *   close to the model's window" without knowing which model.
 *
 * Threshold tiers (percent of context window):
 *   >70%, <=90%   -> LOW    "approaching limit"
 *   >90%, <=100%  -> MEDIUM "near limit, no headroom for response"
 *   >100%         -> no finding (tokenLimitContextOverflow handles it)
 *
 * Severity policy:
 *   Exact count          -> tier as listed above
 *   Heuristic count      -> downgrade one tier (MEDIUM -> LOW; LOW
 *                            stays LOW). Heuristic-driven warnings at
 *                            the LOW band are already low confidence;
 *                            heuristic-driven warnings at the MEDIUM
 *                            band may be false positives so we soften.
 */

import { countTokensExact } from './tokenizer.js';
import { getModel } from './models.js';

const LOW_THRESHOLD_PCT = 70;
const MEDIUM_THRESHOLD_PCT = 90;
const OVERFLOW_PCT = 100;

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  if (!opts.targetModel) return [];
  const model = getModel(opts.targetModel);
  if (!model || !model.contextWindow) return [];

  const tokenResult = await countTokensExact(promptText, opts.targetModel);
  const { count, estimated, strategy } = tokenResult;

  const pct = (count / model.contextWindow) * 100;
  if (pct <= LOW_THRESHOLD_PCT) return [];
  if (pct > OVERFLOW_PCT) return []; // overflow detector owns this range

  // Pick tier by percent.
  let baseSeverity;
  if (pct > MEDIUM_THRESHOLD_PCT) baseSeverity = 'MEDIUM';
  else baseSeverity = 'LOW';

  // Downgrade MEDIUM to LOW when count is estimated (heuristic).
  let severity = baseSeverity;
  if (estimated && baseSeverity === 'MEDIUM') severity = 'LOW';

  const pctRounded = pct.toFixed(1);
  const remaining = model.contextWindow - count;

  let detail;
  if (estimated) {
    detail = 'The prompt is approximately ' + count + ' tokens (estimated '
      + 'via heuristic), about ' + pctRounded + '% of the '
      + model.displayName + ' context window of '
      + model.contextWindow.toLocaleString() + ' tokens. Roughly '
      + remaining.toLocaleString() + ' tokens remain for the response '
      + 'and any tool output. The exact count could not be determined; '
      + 'severity reflects the uncertainty of the heuristic.';
  } else {
    detail = 'The prompt is ' + count + ' tokens (counted via ' + strategy
      + '), ' + pctRounded + '% of the ' + model.displayName + ' context '
      + 'window of ' + model.contextWindow.toLocaleString() + ' tokens. '
      + remaining.toLocaleString() + ' tokens remain for the response and '
      + 'any tool output. At this fill rate, complex responses may be '
      + 'truncated or the response may exhaust headroom.';
  }

  return [
    {
      detector: 'tokenLimitExcessive',
      severity,
      title: 'Prompt approaching context window',
      file: filePath,
      location: null,
      detail,
      remediation:
        'Free up headroom in the ' + model.displayName + ' context window. '
        + 'Reserve at least 4K-8K tokens for typical responses, more for '
        + 'long-form output or tool-use loops. Strategies: trim system '
        + 'instructions, move static reference material to retrieval, or '
        + 'split work across multiple turns.',
      confidence: estimated ? 70 : 90,
    },
  ];
}
