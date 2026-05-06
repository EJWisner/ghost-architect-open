/**
 * tests/prompt-triage-corpus/_generate-length-fixtures.mjs
 *
 * One-shot generator for the length detector fixtures (06/07/08).
 * Run with: node tests/prompt-triage-corpus/_generate-length-fixtures.mjs
 *
 * The leading underscore keeps it sorted away from the numbered
 * fixtures and signals "tool, not test fixture" to anything that
 * globs the directory. Fixture 06 (LOW) was hand-written first;
 * this script regenerates it alongside 07 and 08 from the same
 * paragraph source, so retuning is a one-edit affair.
 *
 * Sizing math:
 *   The prompt-pack tokenizer returns either an exact tiktoken count
 *   (for OpenAI target models) or a 4-chars-per-token heuristic (for
 *   anything else). The smoke test passes GPT-4o for the broken fixtures
 *   folder, so these counts must clear thresholds under tiktoken's
 *   actual measurement, not the heuristic estimate.
 *
 *   Empirically, our padding paragraph tokenizes to roughly 5.79
 *   chars/token under GPT-4o (o200k_base). With ~25% safety margin:
 *
 *   PARAGRAPH = 200 chars (199 + \n)
 *   06: header + 108 paragraphs ~21,640 chars  ~3,737 tokens (GPT-4o) -> LOW
 *   07: header + 215 paragraphs ~43,040 chars  ~7,433 tokens (GPT-4o) -> MEDIUM
 *   08: header + 431 paragraphs ~86,240 chars ~14,895 tokens (GPT-4o) -> HIGH
 *
 *   These same fixtures will over-fire under the heuristic strategy
 *   (about 31% higher counts), so a smoke run that targets a Claude
 *   or Gemini model will land each fixture squarely in or above its
 *   tier. That's fine: we want fixtures that fire, not fixtures that
 *   thread the needle for every strategy.
 *
 * If thresholds change in src/prompt-pack/length.js, update the
 * paragraph counts below to keep each fixture comfortably above its
 * tier and below the next.
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
  { file: '06-length-low.md',    severity: 'LOW',    paragraphs: 108 },
  { file: '07-length-medium.md', severity: 'MEDIUM', paragraphs: 215 },
  { file: '08-length-high.md',   severity: 'HIGH',   paragraphs: 431 },
];

for (const f of FIXTURES) {
  const header = '# Fixture ' + f.file.slice(0, 2)
    + ': expected to trigger length/excessive at ' + f.severity + ' severity.\n\n';
  const body = PARAGRAPH.repeat(f.paragraphs);
  const content = header + body;
  const path = join(__dirname, f.file);
  writeFileSync(path, content);
  const chars = content.length;
  const tokens = Math.round(chars / 4);
  console.log(f.file + ': ' + chars + ' chars, ~' + tokens + ' tokens (expect ' + f.severity + ')');
}
