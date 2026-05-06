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
 * Sizing math (CHARS_PER_TOKEN = 4 in length.js):
 *   PARAGRAPH = 200 chars (199 + \n)
 *   06: header + 65 paragraphs  ~13,080 chars  ~3,270 tokens  -> LOW
 *   07: header + 130 paragraphs ~26,080 chars  ~6,520 tokens  -> MEDIUM
 *   08: header + 260 paragraphs ~52,080 chars  ~13,020 tokens -> HIGH
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
  { file: '06-length-low.md',    severity: 'LOW',    paragraphs: 65  },
  { file: '07-length-medium.md', severity: 'MEDIUM', paragraphs: 130 },
  { file: '08-length-high.md',   severity: 'HIGH',   paragraphs: 260 },
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
