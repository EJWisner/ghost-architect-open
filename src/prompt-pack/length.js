/**
 * src/prompt-pack/length.js
 *
 * Detector #2: Excessive prompt length (Tier 1, regex/structural).
 *
 * Flags prompts that are "longer than necessary" using a token count
 * supplied by the prompt-pack tokenizer abstraction. Separate from
 * context-window overflow (detector #3, tokenLimitContextOverflow),
 * which checks against an absolute model ceiling. This detector is
 * about prompt bloat, not capacity.
 *
 * A single finding is emitted per prompt at the highest applicable
 * severity. A 13K-token prompt fires HIGH only, not HIGH+MEDIUM+LOW.
 *
 * Token counting:
 *   When opts.targetModel is provided and the model uses an exact
 *   tokenizer (currently OpenAI families via gpt-tokenizer), the count
 *   reflects real tokenization. Otherwise the count is a heuristic
 *   (~4 chars/token) and the finding text says so explicitly.
 *
 * Thresholds were tuned against the Ghost dogfood corpus using the
 * heuristic count: POI prompts at ~11.6 KB / ~2.9K tokens sit just
 * under LOW; with-profile variants at ~15.3 KB / ~3.8K tokens trip
 * LOW. Real-tokenizer counts may differ by 5-15% (typically lower
 * for English prose, higher for code-dense text). Re-tune at the
 * THRESHOLDS const if real-data calibration shifts after extended use.
 */

import { countTokens } from './tokenizer.js';
import { getModel } from './models.js';

// ── Threshold configuration ─────────────────────────────────────────────

// Tiered thresholds in TOKENS. Order is LOW -> MEDIUM -> HIGH and the
// highest applicable tier wins.
const THRESHOLDS = [
  { severity: 'LOW',    tokens: 3000,  hint: 'consider breaking up' },
  { severity: 'MEDIUM', tokens: 6000,  hint: 'this is large, audit purpose' },
  { severity: 'HIGH',   tokens: 12000, hint: 'almost certainly bloated' },
];

// ── Core ─────────────────────────────────────────────────────────────────

/**
 * Pick the highest threshold the prompt clears, or null if it clears
 * none. Iterates in registry order and keeps the last match.
 */
function selectThreshold(tokenCount) {
  let hit = null;
  for (const t of THRESHOLDS) {
    if (tokenCount > t.tokens) hit = t;
  }
  return hit;
}

/**
 * Build the finding's `detail` string. Branches on whether the token
 * count is an exact tokenizer result or a heuristic estimate, so the
 * user sees honest precision language for what they're getting.
 *
 * Heuristic path further branches on *why* the count is heuristic:
 *   - no model specified -> nudge the user to specify one
 *   - model specified but family has no offline tokenizer (Claude,
 *     Gemini) -> name the model and explain the limitation
 */
function buildDetailString({ tokenCount, charCount, hit, tokenResult, model }) {
  const overBy = tokenCount - hit.tokens;
  if (tokenResult.estimated) {
    let precisionNote;
    if (model) {
      precisionNote = 'No offline tokenizer is available for '
        + model.displayName + '; count is approximate.';
    } else {
      precisionNote = 'Specify a target model when auditing for an '
        + 'exact token count where one is available.';
    }
    return 'The prompt is approximately ' + tokenCount + ' tokens '
      + '(' + charCount + ' characters, estimated via heuristic), which '
      + 'exceeds the ' + hit.severity + ' threshold of ' + hit.tokens
      + ' tokens by about ' + overBy + '. ' + precisionNote + ' Long '
      + 'prompts increase cost per call, slow response time, and often '
      + 'contain redundant or stale instructions that compete for the '
      + 'model attention budget.';
  }
  // Exact count via real tokenizer.
  const modelLabel = model ? model.displayName : 'the target model';
  return 'The prompt is ' + tokenCount + ' tokens '
    + '(' + charCount + ' characters, counted via ' + tokenResult.strategy
    + ' for ' + modelLabel + '), which exceeds the ' + hit.severity
    + ' threshold of ' + hit.tokens + ' tokens by ' + overBy + '. '
    + 'Long prompts increase cost per call, slow response time, and '
    + 'often contain redundant or stale instructions that compete for '
    + 'the model attention budget.';
}

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath, opts = {}) {
  const safeText = String(promptText ?? '');
  const charCount = safeText.length;
  const tokenResult = await countTokens(safeText, opts.targetModel);
  const tokenCount = tokenResult.count;

  const hit = selectThreshold(tokenCount);
  if (!hit) return [];

  const model = opts.targetModel ? getModel(opts.targetModel) : null;

  return [
    {
      detector: 'length/excessive',
      severity: hit.severity,
      title: 'Excessive prompt length',
      file: filePath,
      location: null,
      detail: buildDetailString({ tokenCount, charCount, hit, tokenResult, model }),
      remediation:
        'Audit the prompt for redundancy: duplicated instructions, '
        + 'examples that repeat the same pattern, context that is no '
        + 'longer relevant, or sections that could move to a separate '
        + 'tool definition. Severity hint: ' + hit.hint + '.',
      confidence: tokenResult.estimated ? 75 : 90,
    },
  ];
}
