// test/ghostBrief.test.mjs
//
// Unit tests for Ghost Brief™: ghostBrief.js, ghostBriefAdapter.js, and the
// Ghost Open™ 12 rule that Ghost Brief™ is available to everyone with Ghost
// Architect™ branding only.
//
// Run: node test/ghostBrief.test.mjs
// Exits 0 on pass, non-zero on fail. Plain stdlib, no test framework, no deps.

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

import fs from 'node:fs';
import { generateBrief, validateBrief, blastLabel, renderBriefHtml } from '../lib/ghostBrief.js';
import { fromFixForecast } from '../lib/ghostBriefAdapter.js';

let passed = 0, failed = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.log(`  ✗  ${label}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function ok(label, value) {
  if (value) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.log(`  ✗  ${label}`);
    console.log(`       expected truthy, got: ${JSON.stringify(value)}`);
    failed++;
  }
}

function throws(label, fn) {
  try {
    fn();
    console.log(`  ✗  ${label} — expected throw, but did not throw`);
    failed++;
  } catch (e) {
    console.log(`  ✓  ${label}`);
    passed++;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeValidPrompt(overrides = {}) {
  return {
    id: 'GB-001',
    title: 'Fix broken thing',
    severity: 'high',
    blast_radius: 'surgical',
    blast_score: 10,
    source_mode: 'fix-forecast',
    files: { primary: ['app/code/MyModule/Plugin.php'], related: [], do_not_touch: ['vendor/**'] },
    prompt: 'Address the issue in Plugin.php.',
    validation_hints: ['Tests still pass'],
    tags: [],
    ...overrides
  };
}

function makeValidBriefInput(prompts) {
  return {
    findings: prompts,
    ghostVersion: '7.2.2',
    scanFile: 'ghost-report.json',
    codebaseRoot: '/tmp/test-codebase'
  };
}

// ── Section A: ghostBrief.js — generateBrief() ───────────────────────────────

console.log('\nA) ghostBrief.js — generateBrief()');

// A1: throws if prompts array is empty
throws(
  'throws if findings is empty array',
  () => generateBrief(makeValidBriefInput([]))
);

// A2: throws if a prompt is missing validation_hints
throws(
  'throws if a prompt is missing validation_hints',
  () => generateBrief(makeValidBriefInput([
    makeValidPrompt({ validation_hints: [] })
  ]))
);

// A3: blastLabel thresholds
check('blast_score 10  → surgical', blastLabel(10), 'surgical');
check('blast_score 25  → moderate', blastLabel(25), 'moderate');
check('blast_score 50  → broad',    blastLabel(50), 'broad');
check('blast_score 15  → surgical (boundary)', blastLabel(15), 'surgical');
check('blast_score 16  → moderate (boundary)', blastLabel(16), 'moderate');
check('blast_score 40  → moderate (boundary)', blastLabel(40), 'moderate');
check('blast_score 41  → broad    (boundary)', blastLabel(41), 'broad');

// A4: sorts prompts by blast_score ascending
{
  const findings = [
    makeValidPrompt({ id: 'GB-001', blast_score: 50 }),
    makeValidPrompt({ id: 'GB-002', blast_score: 5  }),
    makeValidPrompt({ id: 'GB-003', blast_score: 25 }),
  ];
  const brief = generateBrief(makeValidBriefInput(findings));
  check('sorts prompts ascending by blast_score — first is lowest',  brief.prompts[0].blast_score, 5);
  check('sorts prompts ascending by blast_score — last is highest',  brief.prompts[2].blast_score, 50);
}

// A5: estimated_agent_hours — 4 prompts × 0.25 = 1.0
{
  const findings = [
    makeValidPrompt({ id: 'GB-001' }),
    makeValidPrompt({ id: 'GB-002' }),
    makeValidPrompt({ id: 'GB-003' }),
    makeValidPrompt({ id: 'GB-004' }),
  ];
  const brief = generateBrief(makeValidBriefInput(findings));
  check('4 prompts → estimated_agent_hours = 1.0', brief.summary.estimated_agent_hours, 1.0);
  check('4 prompts → total_prompts = 4',           brief.summary.total_prompts, 4);
}

// A6: scan_mode = 'multi' when 2+ source_modes present
{
  const findings = [
    makeValidPrompt({ id: 'GB-001', source_mode: 'fix-forecast' }),
    makeValidPrompt({ id: 'GB-002', source_mode: 'poi'          }),
  ];
  const brief = generateBrief(makeValidBriefInput(findings));
  check('2 source_modes → scan_mode = multi', brief.source.scan_mode, 'multi');
  ok(  '2 source_modes → contributing_modes is array', Array.isArray(brief.source.contributing_modes));
  check('contributing_modes has 2 entries', brief.source.contributing_modes.length, 2);
}

// A7: scan_mode = single mode name when only 1 source_mode present
{
  const findings = [
    makeValidPrompt({ id: 'GB-001', source_mode: 'fix-forecast' }),
    makeValidPrompt({ id: 'GB-002', source_mode: 'fix-forecast' }),
  ];
  const brief = generateBrief(makeValidBriefInput(findings));
  check('1 source_mode  → scan_mode = fix-forecast',    brief.source.scan_mode, 'fix-forecast');
  check('1 source_mode  → contributing_modes undefined', brief.source.contributing_modes, undefined);
}

// ── Section B: ghostBriefAdapter.js — fromFixForecast() ─────────────────────

console.log('\nB) ghostBriefAdapter.js — fromFixForecast()');

// B1: maps severity 'error' → 'critical'
{
  const [result] = fromFixForecast([{
    severity: 'error',
    files: ['app/code/Foo/Bar.php'],
    title: 'Test finding'
  }]);
  check("severity 'error' → 'critical'", result.severity, 'critical');
}

// B2: maps severity 'warning' → 'medium'
{
  const [result] = fromFixForecast([{
    severity: 'warning',
    files: ['app/code/Foo/Bar.php'],
    title: 'Test finding'
  }]);
  check("severity 'warning' → 'medium'", result.severity, 'medium');
}

// B3: sets source_mode to 'fix-forecast'
{
  const [result] = fromFixForecast([{
    severity: 'high',
    files: ['app/code/Foo/Bar.php'],
    title: 'Test finding'
  }]);
  check("source_mode = 'fix-forecast'", result.source_mode, 'fix-forecast');
}

// B4: sets default do_not_touch globs when none provided
{
  const [result] = fromFixForecast([{
    severity: 'high',
    files: ['app/code/Foo/Bar.php'],
    title: 'Test finding'
  }]);
  ok('do_not_touch is an array',               Array.isArray(result.files.do_not_touch));
  ok('do_not_touch includes vendor/**',        result.files.do_not_touch.includes('vendor/**'));
  ok('do_not_touch includes app/code/Core/**', result.files.do_not_touch.includes('app/code/Core/**'));
}

// ── Section C: available to everyone, Ghost Architect™ branding ──────────────

console.log('\nC) Ghost Brief™ for everyone, Ghost Architect™ branding');

{
  const brief = generateBrief(makeValidBriefInput([makeValidPrompt()]));
  ok('brief carries no tier field', !('tier' in brief));
  const html = renderBriefHtml(brief);
  ok('HTML title is Ghost Brief™', html.includes('<div class="htitle">Ghost Brief™</div>'));
  ok('HTML footer links ghostarchitect.dev', html.includes('>ghostarchitect.dev</a>'));
  ok('HTML names the edition Ghost Open™', html.includes('Ghost Open™'));
  // renderBriefHtml no longer accepts a branding bundle; a stray second
  // argument (as 11.x callers passed) must not change the output.
  const withStray = renderBriefHtml(brief, { companyName: 'Acme Consulting', footerText: 'acme.example' });
  ok('a stray branding argument is ignored', !withStray.includes('Acme Consulting') && !withStray.includes('acme.example'));
}

{
  // No Max-plan gate anywhere on the Ghost Brief™ paths in the CLI.
  const cli = fs.readFileSync(resolve(__dirname, '..', 'bin', 'ghost.js'), 'utf8');
  ok('no "(Max plan)" menu suffix', !cli.includes('(Max plan)'));
  ok('no "requires a Max plan" refusal', !/requires a Max plan/i.test(cli));
  ok('no tier gate in the CLI', !/requireTier|allowedTiers|MAX_TIERS/.test(cli));
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Ghost Brief tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
