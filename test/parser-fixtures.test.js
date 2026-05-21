// Regression test for the v6.0.1 ##-as-finding parser fix.
//
// Reproduces the bug captured in TODO-architect-open-findings-json-missing-scan2.md:
// when the narrator emitted each finding as its own top-level ## block (no ###
// nesting), extractFindings() returned [] and saveReport silently skipped
// findings.json. Both fixtures are real reports captured during 2026-05-20
// verification — scan1-table-format.md is the canonical ##-category/###-finding
// shape, scan2-block-format.md is the divergent flat-## shape.
//
// Run with: node test/parser-fixtures.test.js
// Exits 0 on pass, non-zero on fail. Plain stdlib, no test framework, no deps.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { extractFindings } from '../src/utils/finding-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURES = [
  { name: 'scan1-table-format.md', file: 'fixtures/parser/scan1-table-format.md' },
  { name: 'scan2-block-format.md', file: 'fixtures/parser/scan2-block-format.md' },
];

function severityBreakdown(findings) {
  const buckets = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, OTHER: 0 };
  for (const f of findings) {
    const s = String(f.severity || '').toUpperCase();
    if (s in buckets) buckets[s]++;
    else buckets.OTHER++;
  }
  return buckets;
}

let failed = 0;

for (const fixture of FIXTURES) {
  const path = resolve(__dirname, fixture.file);
  const md = readFileSync(path, 'utf8');
  const findings = extractFindings(md);
  const sev = severityBreakdown(findings);

  console.log(`${fixture.name}: ${findings.length} findings`);
  console.log(
    `  CRITICAL: ${sev.CRITICAL}  HIGH: ${sev.HIGH}  ` +
    `MEDIUM: ${sev.MEDIUM}  LOW: ${sev.LOW}  OTHER: ${sev.OTHER}`
  );
  if (findings.length > 0) {
    const titles = findings.slice(0, 3).map(f => `    - [${f.severity}] ${f.title}`).join('\n');
    console.log(titles);
    if (findings.length > 3) console.log(`    ... and ${findings.length - 3} more`);
  }
  console.log('');

  try {
    assert(findings.length > 0,
      `${fixture.name}: expected at least 1 finding, got ${findings.length}`);
    console.log(`  ✓ ${fixture.name} passed\n`);
  } catch (err) {
    console.error(`  ✗ ${fixture.name} FAILED: ${err.message}\n`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`${failed} fixture(s) failed.`);
  process.exit(1);
}
console.log('All fixtures passed.');
