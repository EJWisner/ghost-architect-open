// test/ghostBrief.test.mjs
//
// Unit tests for Ghost Brief: ghostBrief.js, ghostBriefAdapter.js, and
// the 'mode:ghost-brief' entry in tier-gates.js TIER_POLICY.
//
// Run: node test/ghostBrief.test.mjs
// Exits 0 on pass, non-zero on fail. Plain stdlib, no test framework, no deps.

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { generateBrief, validateBrief, blastLabel } from '../lib/ghostBrief.js';
import { fromFixForecast } from '../lib/ghostBriefAdapter.js';
import { TIER_POLICY, requireTier } from '../src/license/tier-gates.js';

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

// ── Section C: TIER_POLICY — mode:ghost-brief ────────────────────────────────

console.log('\nC) TIER_POLICY — mode:ghost-brief');

const ghostBriefPolicy = TIER_POLICY['mode:ghost-brief'];

ok("'mode:ghost-brief' exists in TIER_POLICY", ghostBriefPolicy !== undefined);
check('open         tier → false', ghostBriefPolicy?.open,              false);
check('pro          tier → false', ghostBriefPolicy?.pro,               false);
check('pro-max           → true',  ghostBriefPolicy?.['pro-max'],       true);
check('team         tier → false', ghostBriefPolicy?.team,              false);
check('team-max          → true',  ghostBriefPolicy?.['team-max'],      true);
check('enterprise   tier → false', ghostBriefPolicy?.enterprise,        false);
check('enterprise-max    → true',  ghostBriefPolicy?.['enterprise-max'], true);

// Verify via requireTier() with tier override
{
  const openVerdict          = requireTier('mode:ghost-brief', { tier: 'open'           });
  const proVerdict           = requireTier('mode:ghost-brief', { tier: 'pro'            });
  const proMaxVerdict        = requireTier('mode:ghost-brief', { tier: 'pro-max'        });
  const teamVerdict          = requireTier('mode:ghost-brief', { tier: 'team'           });
  const teamMaxVerdict       = requireTier('mode:ghost-brief', { tier: 'team-max'       });
  const enterpriseVerdict    = requireTier('mode:ghost-brief', { tier: 'enterprise'     });
  const enterpriseMaxVerdict = requireTier('mode:ghost-brief', { tier: 'enterprise-max' });

  check('requireTier: open          → allowed=false', openVerdict.allowed,          false);
  check('requireTier: pro           → allowed=false', proVerdict.allowed,           false);
  check('requireTier: pro-max       → allowed=true',  proMaxVerdict.allowed,        true);
  check('requireTier: team          → allowed=false', teamVerdict.allowed,          false);
  check('requireTier: team-max      → allowed=true',  teamMaxVerdict.allowed,       true);
  check('requireTier: enterprise    → allowed=false', enterpriseVerdict.allowed,    false);
  check('requireTier: enterprise-max→ allowed=true',  enterpriseMaxVerdict.allowed, true);
}

// ── requireTier: quota verdicts must fail loud on a missing count ───────────────
//
// Regression guard: a quota-gated mode must NEVER default a missing count to 0,
// which would let an exhausted Open user scan without limit. requireTier must
// throw when the caller forgets to pass the count.
{
  // Empty opts → resolves to 'open' tier → 'quota' verdict, no scansUsed.
  throws('requireTier: empty opts on quota mode throws', () =>
    requireTier('mode:poi', {}));
  throws('requireTier: open quota mode without scansUsed throws', () =>
    requireTier('mode:poi', { tier: 'open' }));
  throws('requireTier: open forecast-quota without forecastsUsed throws', () =>
    requireTier('mode:commit-forecast', { tier: 'open' }));
  throws('requireTier: open fix-forecast-quota without fixForecastsUsed throws', () =>
    requireTier('mode:fix-forecast', { tier: 'open' }));

  // A count of 0 is valid and must NOT throw — it means "fresh quota".
  check('requireTier: scansUsed=0 allowed',
    requireTier('mode:poi', { tier: 'open', scansUsed: 0 }).allowed, true);
  check('requireTier: scansUsed at limit blocked',
    requireTier('mode:poi', { tier: 'open', scansUsed: 4 }).allowed, false);
  // Non-quota tiers short-circuit before the count check, so no count needed.
  check('requireTier: pro quota mode allowed without count',
    requireTier('mode:poi', { tier: 'pro' }).allowed, true);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Ghost Brief tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
