/**
 * tests/prompt-triage-corpus/_generate-length-fixtures.mjs
 *
 * One-shot generator for the prompt-triage detector fixtures.
 * Run with: node tests/prompt-triage-corpus/_generate-length-fixtures.mjs
 *
 * The leading underscore keeps it sorted away from the numbered
 * fixtures and signals "tool, not test fixture" to anything that
 * globs the directory.
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
 * Sizing math:
 *   The prompt-pack tokenizer returns either an exact tiktoken count
 *   (for OpenAI target models) or a 4-chars-per-token heuristic (for
 *   anything else). The smoke test passes test-tiny-4k for the broken
 *   fixtures folder; that model uses tiktoken (o200k_base) so all
 *   sizing is against the same encoder our padding paragraph hits at
 *   ~5.79 chars/token.
 *
 *   PARAGRAPH = 200 chars (199 + \n)
 *
 *   Length fixtures (absolute thresholds):
 *     06-length-low    108 paras  ~21,640 chars  ~3,737 tokens -> LOW    (>3000)
 *     07-length-medium 215 paras  ~43,040 chars  ~7,433 tokens -> MEDIUM (>6000)
 *     08-length-high   431 paras  ~86,240 chars ~14,895 tokens -> HIGH   (>12000)
 *
 *   TokenLimit fixtures (% of 4,000-token window):
 *     09-tokenlimit-approaching 87 paras  ~17,400 chars ~3,005 tokens (~75%) -> LOW (excessive)
 *     10-tokenlimit-near       110 paras  ~22,000 chars ~3,799 tokens (~95%) -> MEDIUM (excessive)
 *     11-tokenlimit-overflow   128 paras  ~25,600 chars ~4,421 tokens (~111%) -> HIGH (overflow)
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
 * tokenLimit detectors, update the paragraph counts below to keep
 * each fixture comfortably above its tier and below the next.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PARAGRAPH =
  'A well-designed prompt sets clear context, defines the task with precision, '
  + 'specifies output format, and supplies relevant examples without bloating '
  + 'the input or burying the operative instruction.\n';

const FIXTURES = [
  // Length detector fixtures: tuned against absolute token thresholds.
  { file: '06-length-low.md',           severity: 'LOW',    paragraphs: 108, expectedDetector: 'length/excessive'           },
  { file: '07-length-medium.md',        severity: 'MEDIUM', paragraphs: 215, expectedDetector: 'length/excessive'           },
  { file: '08-length-high.md',          severity: 'HIGH',   paragraphs: 431, expectedDetector: 'length/excessive'           },

  // TokenLimit detector fixtures: tuned against the test-tiny-4k
  // model's 4,000-token window.
  { file: '09-tokenlimit-approaching.md', severity: 'LOW',    paragraphs: 87,  expectedDetector: 'tokenLimit/excessive'        },
  { file: '10-tokenlimit-near.md',        severity: 'MEDIUM', paragraphs: 110, expectedDetector: 'tokenLimit/excessive'        },
  { file: '11-tokenlimit-overflow.md',    severity: 'HIGH',   paragraphs: 128, expectedDetector: 'tokenLimit/contextOverflow' },
];

for (const f of FIXTURES) {
  const header = '# Fixture ' + f.file.slice(0, 2)
    + ': expected to trigger ' + f.expectedDetector + ' at ' + f.severity + ' severity.\n\n';
  const body = PARAGRAPH.repeat(f.paragraphs);
  const content = header + body;
  const path = join(__dirname, f.file);
  writeFileSync(path, content);
  const chars = content.length;
  const tokens = Math.round(chars / 4);
  console.log(f.file + ': ' + chars + ' chars, ~' + tokens + ' tokens (heuristic) (expect ' + f.severity + ' on ' + f.expectedDetector + ')');
}
