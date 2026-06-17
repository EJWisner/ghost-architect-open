/**
 * tests/prompt-triage-corpus/_generate-length-fixtures.mjs
 *
 * One-shot generator for the prompt-triage detector length/tokenLimit
 * fixtures (06-11). Run with:
 *
 *   node tests/prompt-triage-corpus/_generate-length-fixtures.mjs
 *
 * The leading underscore keeps it sorted away from the numbered
 * fixtures and signals "tool, not test fixture" to anything that
 * globs the directory.
 *
 * This script is the source of truth for the generated fixtures. Edit
 * here and regenerate; do not hand-edit 06-11, because the next run of
 * this script overwrites them.
 *
 * Fixtures produced:
 *
 *   06-08: length/excessive (Tier 1, no model required)
 *     Sized to fire LOW/MEDIUM/HIGH under the gpt-4o tiktoken count
 *     used by the smoke test. Length detector thresholds are absolute
 *     token counts, so these also fire under any other model.
 *
 *   09-11: tokenLimit/excessive and tokenLimit/contextOverflow
 *     Sized against the test-tiny-4k model (4,000 token window) so
 *     repo footprint stays reasonable. Smoke test scans the broken
 *     fixtures folder with test-tiny-4k as the target model so these
 *     fire as designed.
 *
 * Content quality:
 *   Earlier revisions of these fixtures repeated a single sentence
 *   hundreds of times, which read as obviously synthetic and made the
 *   files brittle to reason about. The body is now built from a pool of
 *   distinct prompt-engineering guidelines, cycled and numbered so every
 *   line is duplicated-with-slight-variation rather than literal
 *   copy-paste. The result reads like a genuinely over-stuffed style
 *   guide, which is exactly the kind of prompt bloat these detectors are
 *   meant to catch. Each generated file also carries an HTML comment
 *   header recording its target word count, severity tier, generation
 *   date, and the triage finding it is expected to trigger.
 *
 * Sizing math:
 *   The prompt-pack tokenizer returns either an exact tiktoken count
 *   (for OpenAI target models) or a 4-chars-per-token heuristic (for
 *   anything else). The smoke test passes test-tiny-4k for the broken
 *   fixtures folder; that model uses tiktoken (o200k_base) so all
 *   sizing is against the same encoder. The guideline lines average
 *   ~200 characters each, the same per-line budget the old single
 *   paragraph used, so the documented paragraph counts still land each
 *   fixture in its intended tier.
 *
 *   Length fixtures (absolute thresholds):
 *     06-length-low    108 lines  ~21,600 chars  ~3,700 tokens -> LOW    (>3000)
 *     07-length-medium 215 lines  ~43,000 chars  ~7,400 tokens -> MEDIUM (>6000)
 *     08-length-high   431 lines  ~86,200 chars ~14,900 tokens -> HIGH   (>12000)
 *
 *   TokenLimit fixtures (% of 4,000-token window):
 *     09-tokenlimit-approaching 87 lines  ~17,400 chars ~3,000 tokens (~75%) -> LOW (excessive)
 *     10-tokenlimit-near       110 lines  ~22,000 chars ~3,800 tokens (~95%) -> MEDIUM (excessive)
 *     11-tokenlimit-overflow   128 lines  ~25,600 chars ~4,400 tokens (~111%) -> HIGH (overflow)
 *
 *   Note: 09-11 are also large enough to trip length/excessive at
 *   LOW (above 3000 tokens). That is realistic dogfood: a single prompt
 *   firing multiple detectors is the normal case.
 *
 *   These fixtures will all over-fire under heuristic strategy (~31%
 *   higher counts), so a smoke run that targets a Claude or Gemini
 *   model would still see findings. That's fine: we want fixtures
 *   that fire, not fixtures that thread the needle for every strategy.
 *
 * If thresholds change in src/prompt-pack/length.js or in the
 * tokenLimit detectors, update the line counts below to keep each
 * fixture comfortably above its tier and below the next. Do not change
 * the counts to "fix" content quality; counts are the sizing targets.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Pool of distinct prompt-engineering guidelines, each ~26-30 words so
// one guideline occupies roughly the same ~200-char budget the old
// single paragraph used. Cycling this pool and numbering each line gives
// realistic verbose content (duplicated-with-variation) instead of one
// sentence repeated verbatim.
const GUIDELINES = [
  'A well-designed prompt sets clear context, defines the task with precision, specifies the output format, and supplies relevant examples without bloating the input or burying the operative instruction.',
  'State the model role up front so it can adopt a consistent voice, then describe the audience and the goal before listing any constraints that the response must satisfy.',
  'Put the single most important instruction near the top, because instructions buried in the middle of a long prompt compete for attention and are the first thing a model quietly drops.',
  'When you provide examples, label the input and the expected output explicitly, and keep the formatting of those examples identical to the formatting you want the model to produce.',
  'Prefer a short, ordered list of requirements over a dense paragraph; numbered constraints are easier for the model to track and easier for a reviewer to audit later for drift.',
  'Specify the output format concretely: name the fields, the order, whether JSON or prose is expected, and what the model should do when a field has no value rather than leaving it open.',
  'Tell the model what to do when it is uncertain, because a prompt that never mentions ambiguity invites confident guessing, and a guess that reads as fact is worse than an honest hedge.',
  'Avoid stacking redundant instructions that say the same thing three different ways; each restatement adds tokens, adds cost, and gives the model one more place to find a contradiction.',
  'Use delimiters to separate instructions from data, so that text the user pastes in cannot be mistaken for a command the author intended the model to follow during the request.',
  'Keep the tone guidance specific: "plain, direct sentences" steers better than "be professional," which every model interprets differently and which therefore steers almost nothing at all.',
  'Define the boundaries of the task as carefully as the task itself, naming what is out of scope so the model does not wander into adjacent work that the author never actually requested.',
  'Re-read a long prompt as though you were the model: if two sections disagree, the one you notice last is the one that will silently win, so resolve the conflict before you ship it.',
  'When a constraint really matters, state the consequence of violating it, because a rule with a stated reason survives summarization and paraphrase better than a bare imperative ever does.',
  'Trim context that is no longer relevant on every revision; stale background accumulates quietly, and a prompt that grew by addition alone is almost always larger than the task requires.',
  'Ask for the reasoning and the answer in clearly separated sections when you need both, so a downstream parser can take the answer without having to strip the surrounding explanation first.',
  'Test the prompt against the edge cases you expect in production, not just the happy path, because the failure modes that matter are the ones the cheerful first draft never thought to cover.',
];

const FIXTURES = [
  // Length detector fixtures: tuned against absolute token thresholds.
  { file: '06-length-low.md',           severity: 'LOW',    lines: 108, detector: 'length/excessive',
    tierNote: 'token count clears the LOW length threshold (>3000) but stays below MEDIUM (6000)' },
  { file: '07-length-medium.md',        severity: 'MEDIUM', lines: 215, detector: 'length/excessive',
    tierNote: 'token count clears the MEDIUM length threshold (>6000) but stays below HIGH (12000)' },
  { file: '08-length-high.md',          severity: 'HIGH',   lines: 431, detector: 'length/excessive',
    tierNote: 'token count clears the HIGH length threshold (>12000)' },

  // TokenLimit detector fixtures: tuned against the test-tiny-4k
  // model's 4,000-token window.
  { file: '09-tokenlimit-approaching.md', severity: 'LOW',    lines: 87,  detector: 'tokenLimit/excessive',
    tierNote: 'sits at roughly 75% of the test-tiny-4k 4,000-token window' },
  { file: '10-tokenlimit-near.md',        severity: 'MEDIUM', lines: 110, detector: 'tokenLimit/excessive',
    tierNote: 'sits at roughly 95% of the test-tiny-4k 4,000-token window' },
  { file: '11-tokenlimit-overflow.md',    severity: 'HIGH',   lines: 128, detector: 'tokenLimit/contextOverflow',
    tierNote: 'overflows the test-tiny-4k 4,000-token window at roughly 111%' },
];

// Generation date, stamped into each fixture header. ISO yyyy-mm-dd.
const GENERATED = new Date().toISOString().slice(0, 10);

/**
 * Build the numbered guideline body for a fixture. Cycles the pool so a
 * fixture longer than the pool reuses guidelines, but the line number
 * makes every line unique, so the file is duplicated-with-variation
 * rather than a single sentence copy-pasted.
 */
function buildBody(lineCount) {
  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    const guideline = GUIDELINES[i % GUIDELINES.length];
    lines.push((i + 1) + '. ' + guideline);
  }
  return lines.join('\n') + '\n';
}

/**
 * Build the HTML comment header recording the fixture's metadata and the
 * triage finding it is expected to trigger.
 */
function buildHeader(f, wordCount) {
  return '<!--\n'
    + '  Fixture ' + f.file + '\n'
    + '  Target word count: ~' + wordCount + ' words (' + f.lines + ' numbered guideline lines)\n'
    + '  Severity tier: ' + f.severity + '\n'
    + '  Generated: ' + GENERATED + ' by _generate-length-fixtures.mjs\n'
    + '\n'
    + '  Expected triage finding: ' + f.detector + ' at ' + f.severity + ' severity.\n'
    + '  This is an intentionally bloated prompt, a long and repetitive\n'
    + '  instruction list whose ' + f.tierNote + '.\n'
    + '  The body is duplicated instruction blocks with slight variation\n'
    + '  (a cycled pool of prompt-engineering guidelines, each line\n'
    + '  numbered), not one sentence repeated, so the file documents what\n'
    + '  real prompt bloat looks like.\n'
    + '-->\n\n'
    + '# Prompt engineering style guide (verbose, intentionally bloated)\n\n';
}

function countWords(text) {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

for (const f of FIXTURES) {
  const body = buildBody(f.lines);
  const wordCount = countWords(body);
  const content = buildHeader(f, wordCount) + body;
  const path = join(__dirname, f.file);
  writeFileSync(path, content);
  const chars = content.length;
  const tokens = Math.round(chars / 4);
  console.log(f.file + ': ' + chars + ' chars, ~' + wordCount + ' words, ~' + tokens
    + ' tokens (heuristic) (expect ' + f.severity + ' on ' + f.detector + ')');
}
