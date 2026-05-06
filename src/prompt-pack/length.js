/**
 * src/prompt-pack/length.js
 *
 * Detector #2: Excessive prompt length (Tier 1, regex/structural).
 *
 * Flags prompts that are "longer than necessary" using a fuzzy
 * char-count -> token-count heuristic (~4 chars/token). Separate from
 * context-window overflow (detector #3, tokenLimitContextOverflow),
 * which checks against an absolute model ceiling. This detector is
 * about prompt bloat, not capacity.
 *
 * A single finding is emitted per prompt at the highest applicable
 * severity. A 13K-token prompt fires HIGH only, not HIGH+MEDIUM+LOW.
 *
 * Thresholds (chars and approx tokens) are tuned against the Ghost
 * dogfood corpus: POI prompts at ~11.6 KB / ~2.9K tokens sit just
 * under LOW; with-profile variants at ~15.3 KB / ~3.8K tokens trip
 * LOW. Retune at the THRESHOLDS const if real-data calibration shifts.
 *
 * Out of scope for v1: real tokenizer integration (tiktoken, etc.).
 * The threshold is fuzzy by design and a more accurate count would
 * not change which findings fire.
 */

// ── Threshold configuration ──────────────────────────────────────────────

// Approximate chars-per-token for English prose. Real ratio depends on
// tokenizer and content (code is denser, prose looser); 4 is the
// commonly cited average and is sufficient for threshold-based flagging.
const CHARS_PER_TOKEN = 4;

// Tiered thresholds in TOKENS. Char thresholds are derived. Order is
// LOW -> MEDIUM -> HIGH and the highest applicable tier wins.
const THRESHOLDS = [
  { severity: 'LOW',    tokens: 3000,  hint: 'consider breaking up' },
  { severity: 'MEDIUM', tokens: 6000,  hint: 'this is large, audit purpose' },
  { severity: 'HIGH',   tokens: 12000, hint: 'almost certainly bloated' },
];

// ── Core ─────────────────────────────────────────────────────────────────

function estimateTokens(text) {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

/**
 * Pick the highest threshold the prompt clears, or null if it clears
 * none. Iterates in registry order and keeps the last match.
 */
function selectThreshold(estimatedTokens) {
  let hit = null;
  for (const t of THRESHOLDS) {
    if (estimatedTokens > t.tokens) hit = t;
  }
  return hit;
}

// ── Public detect() ──────────────────────────────────────────────────────

export async function detect(promptText, filePath) {
  const charCount = promptText.length;
  const estimatedTokens = estimateTokens(promptText);
  const hit = selectThreshold(estimatedTokens);
  if (!hit) return [];

  return [
    {
      detector: 'length/excessive',
      severity: hit.severity,
      title: 'Excessive prompt length',
      file: filePath,
      location: null,
      detail:
        'The prompt is approximately ' + estimatedTokens + ' tokens '
        + '(' + charCount + ' characters), which exceeds the '
        + hit.severity + ' threshold of ' + hit.tokens + ' tokens. '
        + 'Long prompts increase cost per call, slow response time, and '
        + 'often contain redundant or stale instructions that compete '
        + 'for the model attention budget.',
      remediation:
        'Audit the prompt for redundancy: duplicated instructions, '
        + 'examples that repeat the same pattern, context that is no '
        + 'longer relevant, or sections that could move to a separate '
        + 'tool definition. Severity hint: ' + hit.hint + '.',
      confidence: 85,
    },
  ];
}
