#!/usr/bin/env node
/**
 * tests/assert-prompt-pack.mjs
 *
 * Assertion-based test harness for the Prompt Triage detector pack.
 * Unlike smoke-prompt-pack.mjs (eyeball-only), this exits non-zero on
 * any regression. Designed for CI and pre-publish gating.
 *
 * Coverage:
 *   1. Tier 1 fixture assertions: every synthetic fixture in
 *      tests/prompt-triage-corpus/ checked against an expected range.
 *   2. Loader assertion: point loader at repo root, expect 50-55 files
 *      post-F-34 filtering.
 *   3. Production prompt baselines: the 7 Ghost prompts in
 *      prompts-extracted/ checked against the May 10 v5.2 dogfood
 *      ceiling. Future runs <= ceiling = pass; > ceiling = regression.
 *   4. integrationMismatch regex pre-filter sanity.
 *
 * Tier 2 LLM-verify phases are NOT in this harness. Use
 * smoke-prompt-pack.mjs with SMOKE_TIER2=1 for manual Tier 2 work.
 *
 * Run from repo root: node tests/assert-prompt-pack.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { runAll, listDetectors } from '../src/prompt-pack/index.js';
import { loadPromptSource } from '../src/prompt-pack/loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.dirname(__dirname);

const TIER1_ONLY = { skipTiers: [2, 3] };

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(label, condition, detail) {
  if (condition) {
    console.log('  \x1b[32m\u2713\x1b[0m ' + label);
    passCount++;
  } else {
    console.log('  \x1b[31m\u2717\x1b[0m ' + label);
    if (detail) console.log('     ' + detail);
    failures.push({ label, detail });
    failCount++;
  }
}

const TIER1_EXPECTATIONS = {
  '01-broken-unclosed-code-block.md': { min: 1, max: 6 },
  '02-broken-unclosed-tags.md':       { min: 1, max: 12 },
  '03-broken-unclosed-inline-code.md':{ min: 1, max: 12 },
  '04-broken-unmatched-close-tag.md': { min: 1, max: 6 },
  '05-clean.md':                      { min: 0, max: 0 },
  '06-length-low.md':                 { min: 1, max: 3 },
  '07-length-medium.md':              { min: 1, max: 3 },
  '08-length-high.md':                { min: 1, max: 3 },
  '09-tokenlimit-approaching.md':     { min: 1, max: 3 },
  '10-tokenlimit-near.md':            { min: 1, max: 3 },
  '11-tokenlimit-overflow.md':        { min: 1, max: 3 },
  '12-unbounded-output.md':           { min: 3, max: 14 },
  '13-bounded-output.md':             { min: 0, max: 3 },
  '14-injection-override.md':         { min: 1, max: 6 },
  '15-injection-jailbreak.md':        { min: 1, max: 16 },
  '16-injection-exfiltration.md':     { min: 1, max: 6 },
  '17-injection-clean.md':            { min: 0, max: 3 },
  '18-multiple-system-blocks.md':     { min: 1, max: 3 },
  '19-mixed-role-conventions.md':     { min: 1, max: 4 },
  '20-stray-line-markers.md':         { min: 1, max: 8 },
  '21-clean-with-fewshot.md':         { min: 0, max: 1 },
};

const PRODUCTION_CEILINGS = {
  '01-chat-system.md':           1,
  '02-poi-default.md':           15,
  '03-poi-with-profile.md':      15,
  '04-blast-default.md':         10,
  '05-blast-with-profile.md':    9,
  '06-conflict-default.md':      3,
  '07-conflict-with-profile.md': 6,
};

async function runFixtureAssertions() {
  console.log('\n\u2500 Tier 1 fixture assertions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  const dir = path.join(REPO_ROOT, 'tests', 'prompt-triage-corpus');
  for (const [filename, expected] of Object.entries(TIER1_EXPECTATIONS)) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) {
      assert(filename, false, 'fixture file missing');
      continue;
    }
    const promptText = fs.readFileSync(filePath, 'utf8');
    const findings = await runAll(promptText, filePath, {
      ...TIER1_ONLY,
      targetModel: 'test-tiny-4k',
    });
    const inRange = findings.length >= expected.min && findings.length <= expected.max;
    assert(
      filename + ' (' + findings.length + ' findings, expected ' + expected.min + '-' + expected.max + ')',
      inRange,
      inRange ? null : 'count out of expected range'
    );
  }
}

async function runLoaderAssertion() {
  console.log('\n\u2500 Loader assertion \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  const loaded = await loadPromptSource({ kind: 'localFolder', path: REPO_ROOT });
  // Range covers Pro (52 files) and Team (46 files) and Open (variable).
  // The point of this assertion is to catch F-34 regressions where project
  // metadata files leak back in — a broken loader would jump well past 60.
  const inRange = loaded.files.length >= 40 && loaded.files.length <= 65;
  assert(
    'loader returns 40-65 files from repo root (got ' + loaded.files.length + ')',
    inRange,
    inRange ? null : 'F-34 loader filter may have regressed'
  );
}

async function runProductionAssertions() {
  console.log('\n\u2500 Production prompt ceiling assertions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  const dir = path.join(REPO_ROOT, 'prompts-extracted');
  if (!fs.existsSync(dir)) {
    console.log('  (prompts-extracted/ not found, skipping)');
    return;
  }
  for (const [filename, ceiling] of Object.entries(PRODUCTION_CEILINGS)) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) {
      assert(filename, false, 'production prompt missing');
      continue;
    }
    const promptText = fs.readFileSync(filePath, 'utf8');
    const findings = await runAll(promptText, filePath, {
      ...TIER1_ONLY,
      targetModel: 'claude-opus-4-7',
    });
    const underCeiling = findings.length <= ceiling;
    assert(
      filename + ' (' + findings.length + ' findings, ceiling ' + ceiling + ')',
      underCeiling,
      underCeiling ? null : 'finding count regressed above v5.2 ceiling'
    );
  }
}

async function runIntegrationMismatchSanity() {
  console.log('\n\u2500 integrationMismatch regex pre-filter sanity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  const cleanPrompt =
    'You are a helpful assistant. When asked a question, think carefully '
    + 'before responding. Be friendly. Use plain language. Keep answers '
    + 'reasonable in length and avoid being verbose. Help the user '
    + 'understand the topic.';
  const detector = await import('../src/prompt-pack/integrationMismatch.js');
  const findings = await detector.detect(cleanPrompt, '/test/clean.md', {
    targetModel: 'claude-opus-4-7',
  });
  assert(
    'no findings on prompt without integration declarations (regex short-circuits)',
    findings.length === 0,
    findings.length === 0 ? null : 'expected 0, got ' + findings.length
  );
}

async function main() {
  const detectors = listDetectors();
  console.log('\nGhost Prompt Triage \u2014 assertion harness');
  console.log('Detectors registered: ' + detectors.length
    + ' (Tier 1: ' + detectors.filter(d => d.tier === 1).length
    + ', Tier 2: ' + detectors.filter(d => d.tier === 2).length
    + ', Tier 3: ' + detectors.filter(d => d.tier === 3).length + ')');

  await runFixtureAssertions();
  await runLoaderAssertion();
  await runProductionAssertions();
  await runIntegrationMismatchSanity();

  console.log('\n' + '\u2550'.repeat(60));
  console.log('Pass: ' + passCount + '   Fail: ' + failCount);
  console.log('\u2550'.repeat(60));

  if (failCount > 0) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    for (const f of failures) {
      console.log('  - ' + f.label);
      if (f.detail) console.log('    ' + f.detail);
    }
    process.exit(1);
  } else {
    console.log('\n\x1b[32mAll assertions passed.\x1b[0m');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\n\x1b[31mHarness crashed:\x1b[0m', err);
  process.exit(2);
});
