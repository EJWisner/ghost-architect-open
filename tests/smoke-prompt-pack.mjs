#!/usr/bin/env node
/**
 * tests/smoke-prompt-pack.mjs
 *
 * Manual smoke-test harness for the Prompt Triage detector pack. Runs
 * every registered detector against two folders and prints findings:
 *
 *   1. prompts-extracted/         the dogfood corpus, behavior depends on
 *                                 detector tuning (some prompts may legitimately
 *                                 fire findings as the detector pack grows)
 *   2. tests/prompt-triage-corpus/ synthetic broken prompts, expected
 *                                 to fire the detectors they target
 *
 * Use during prompt-pack development to verify a new detector works
 * end-to-end and does not regress prior detectors. Not a real test
 * runner: no assertions, no exit codes based on findings count, no
 * jest. Eyeball the output, compare to what each fixture should
 * produce, fix or move on.
 *
 * A real test runner with assertions will replace this once the v1
 * detector pack is complete and we have a stable expected-findings
 * baseline per fixture.
 *
 * Run from repo root:
 *   node tests/smoke-prompt-pack.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { runAll, listDetectors } from '../src/prompt-pack/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
// Script lives in tests/, so repo root is one level up.
const REPO_ROOT  = path.dirname(__dirname);

// Tier 2 detectors make live API calls and cost real money on every run.
// Default: skip Tier 2 in smoke. Opt in for occasional verification with
// SMOKE_TIER2=1.
const RUN_TIER2 = process.env.SMOKE_TIER2 === '1';
const SKIP_TIERS = RUN_TIER2 ? [] : [2];

const FOLDERS = [
  {
    label: 'DOGFOOD CORPUS (real prompts, behavior depends on tuning)',
    dir: path.join(REPO_ROOT, 'prompts-extracted'),
    targetModel: 'claude-opus-4-7',
  },
  {
    label: 'BROKEN FIXTURES (expected: findings)',
    dir: path.join(REPO_ROOT, 'tests', 'prompt-triage-corpus'),
    targetModel: 'test-tiny-4k',
  },
  // Tier 2 fixtures live in their own folder targeting a real Claude
  // model (Haiku, for cost) so the testOnly bypass doesn't silently
  // skip the audit. This folder is only scanned when SMOKE_TIER2=1
  // because it costs real money on every run. Default smoke skips it.
  {
    label: 'TIER 2 FIXTURES (Tier 2 only, opt-in via SMOKE_TIER2=1)',
    dir: path.join(REPO_ROOT, 'tests', 'prompt-triage-corpus-tier2'),
    targetModel: 'claude-haiku-4-5',
    tier2Only: true,
  },
];

function severitySymbol(s) {
  switch (s) {
    case 'CRITICAL': return '🔴';
    case 'HIGH':     return '🟠';
    case 'MEDIUM':   return '🟡';
    case 'LOW':      return '🔵';
    default:         return '⚪';
  }
}

function formatLocation(location) {
  if (!location) return '';
  if (typeof location.line === 'number' && location.line > 0) return ' L' + location.line;
  if (typeof location.hint === 'string' && location.hint.trim().length > 0) {
    return ' (' + location.hint.trim() + ')';
  }
  return '';
}

async function scanFolder(label, dir, targetModel) {
  console.log('');
  console.log('═'.repeat(72));
  console.log(label);
  console.log('Folder: ' + dir);
  if (targetModel) {
    console.log('Target model: ' + targetModel);
  }
  console.log('═'.repeat(72));

  if (!fs.existsSync(dir)) {
    console.log('  (folder does not exist, skipping)');
    return 0;
  }

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'README.md')
    .sort();

  let totalFindings = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const promptText = fs.readFileSync(filePath, 'utf8');
    const findings = await runAll(promptText, filePath, { targetModel, skipTiers: SKIP_TIERS });
    totalFindings += findings.length;

    console.log('');
    console.log('━'.repeat(72));
    console.log(file + '  (' + promptText.length + ' chars, ' + findings.length + ' findings)');
    console.log('━'.repeat(72));

    if (findings.length === 0) {
      console.log('  no findings');
    } else {
      for (const f of findings) {
        const loc = formatLocation(f.location);
        console.log('  ' + severitySymbol(f.severity) + ' [' + f.severity + '] ' + f.detector + loc);
        console.log('     ' + f.title);
        console.log('     ' + f.detail.split('\n').join('\n     '));
        console.log('');
      }
    }
  }

  return totalFindings;
}

async function main() {
  const detectors = listDetectors();
  console.log('Registered detectors: ' + detectors.map(d => d.id + '(t' + d.tier + ')').join(', '));
  if (RUN_TIER2) {
    console.log('Tier 2 mode: ENABLED (SMOKE_TIER2=1) — live API calls will be made.');
  } else {
    console.log('Tier 2 mode: skipped (set SMOKE_TIER2=1 to enable, costs API spend).');
  }

  let grandTotal = 0;
  for (const folder of FOLDERS) {
    // Skip Tier-2-only folders unless Tier 2 is enabled. Their fixtures
    // exist solely to verify Tier 2 detectors and would produce zero
    // useful output (and waste an iteration) under Tier 1 mode.
    if (folder.tier2Only && !RUN_TIER2) continue;
    grandTotal += await scanFolder(folder.label, folder.dir, folder.targetModel);
  }

  console.log('');
  console.log('═'.repeat(72));
  console.log('GRAND TOTAL: ' + grandTotal + ' findings');
}

main().catch(err => { console.error(err); process.exit(1); });
