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

const FOLDERS = [
  { label: 'DOGFOOD CORPUS (real prompts, behavior depends on tuning)', dir: path.join(REPO_ROOT, 'prompts-extracted') },
  { label: 'BROKEN FIXTURES (expected: findings)',                       dir: path.join(REPO_ROOT, 'tests', 'prompt-triage-corpus') },
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

async function scanFolder(label, dir) {
  console.log('');
  console.log('═'.repeat(72));
  console.log(label);
  console.log('Folder: ' + dir);
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
    const findings = await runAll(promptText, filePath);
    totalFindings += findings.length;

    console.log('');
    console.log('━'.repeat(72));
    console.log(file + '  (' + promptText.length + ' chars, ' + findings.length + ' findings)');
    console.log('━'.repeat(72));

    if (findings.length === 0) {
      console.log('  no findings');
    } else {
      for (const f of findings) {
        const loc = f.location ? (' L' + f.location.line) : '';
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

  let grandTotal = 0;
  for (const folder of FOLDERS) {
    grandTotal += await scanFolder(folder.label, folder.dir);
  }

  console.log('');
  console.log('═'.repeat(72));
  console.log('GRAND TOTAL: ' + grandTotal + ' findings');
}

main().catch(err => { console.error(err); process.exit(1); });
