// tests/ad-hoc/extract-candidates-files.test.mjs
//
// Tests for extractCandidates JSON parser in src/core/conflict.js (Phase J).
// All fixtures are inline JSON code fences — the format the new parser expects.
//
// Run: node tests/ad-hoc/extract-candidates-files.test.mjs

import { extractCandidates, normalizeCandidateToFinding } from '../../src/core/conflict.js';
import fs from 'fs';

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
function hasFile(label, files, partial) {
  const found = (files || []).some(f => f.includes(partial));
  if (found) { console.log(`  ✓  ${label}`); passed++; }
  else {
    console.log(`  ✗  ${label}`);
    console.log(`       looking for: ${JSON.stringify(partial)}`);
    console.log(`       actual files: ${JSON.stringify(files)}`);
    failed++;
  }
}
function find(candidates, fragment) {
  return candidates.find(c => c.title?.toLowerCase().includes(fragment.toLowerCase()));
}
function jsonFence(obj) {
  return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
}

// ── Case 1: Multi-file finding with PHP paths ──────────────────────────────────
console.log('\n=== Case 1: Family 1 bullet-bold, multi-file ===');
{
  const fixture = jsonFence({ conflicts: [{
    title: 'GraphAPI Version Storage Schema Conflict',
    severity: 'HIGH',
    files: ['app/code/Meta/BusinessExtension/Model/Api/CoreConfig.php', 'app/code/Meta/BusinessExtension/Model/Api/GraphAPIAdapter.php'],
    description: 'Side A stores version as string, Side B expects int.',
  }]});
  const candidates = extractCandidates([fixture]);
  const c = find(candidates, 'GraphAPI Version') || candidates[0];
  if (!c) { console.log('  ✗  No candidate found'); failed++; }
  else {
    check('1a files non-empty',  (c.files||[]).length > 0,  true);
    hasFile('1b has Meta .php',  c.files, 'Meta');
    check('1c 2+ files',         (c.files||[]).length >= 2, true);
  }
}

// ── Case 2: Finding with PHP files ────────────────────────────────────────────
console.log('\n=== Case 2: Family 1 bullet-bold, Prior pass: annotation ===');
{
  const fixture = jsonFence({ conflicts: [{
    title: 'Access Token Config Path Conflict',
    severity: 'MEDIUM',
    files: ['app/code/Meta/BusinessExtension/Model/System/Config.php', 'app/code/Meta/BusinessExtension/Helper/FBEHelper.php'],
    description: 'Access token config path differs between config.php and FBEHelper.',
  }]});
  const candidates = extractCandidates([fixture]);
  const c = find(candidates, 'Access Token') || candidates[0];
  if (!c) { console.log('  ✗  No candidate found'); failed++; }
  else {
    check('2a files non-empty', (c.files||[]).length > 0, true);
    hasFile('2b has .php',      c.files, '.php');
  }
}

// ── Case 3: Finding with JS files ─────────────────────────────────────────────
console.log('\n=== Case 3: Family 1 inline Format B ===');
{
  const fixture = jsonFence({ conflicts: [{
    title: 'Profile Rate Override Conflict',
    severity: 'MEDIUM',
    files: ['src/profile/index.js', 'prompts/index.js', 'src/analyst/index.js'],
    description: 'Rate override applied inconsistently across modules.',
  }]});
  const candidates = extractCandidates([fixture]);
  const c = find(candidates, 'Profile Rate') || candidates[0];
  if (!c) { console.log('  ✗  No candidate found'); failed++; }
  else {
    check('3a files non-empty', (c.files||[]).length > 0, true);
    hasFile('3b has .js',       c.files, '.js');
    console.log(`     files: ${JSON.stringify(c.files)}`);
  }
}

// ── Case 4: Finding with XML file ─────────────────────────────────────────────
console.log('\n=== Case 4: Family 1 single-file (XML) ===');
{
  const fixture = jsonFence({ conflicts: [{
    title: 'Admin Route ID Redeclared Across Modules',
    severity: 'CRITICAL',
    files: ['app/code/Meta/Sales/etc/adminhtml/routes.xml', 'app/code/Meta/BusinessExtension/etc/adminhtml/routes.xml'],
    description: 'Route ID fbeadmin declared in multiple modules causing conflicts.',
  }]});
  const candidates = extractCandidates([fixture]);
  const c = find(candidates, 'Admin Route') || candidates[0];
  if (!c) { console.log('  ✗  No candidate found'); failed++; }
  else {
    check('4a files non-empty', (c.files||[]).length > 0, true);
    const hasPhpOrXml = (c.files||[]).some(f => f.endsWith('.php') || f.endsWith('.xml'));
    check('4b has php or xml', hasPhpOrXml, true);
    console.log(`     candidate: "${c.title?.slice(0,50)}" files: ${JSON.stringify(c.files)}`);
  }
}

// ── Case 5: Two separate findings — file sets do not overlap ──────────────────
console.log('\n=== Case 5: FIX_VERB_RE "store" fix — Store ID separate from Composer ===');
{
  const fixture = jsonFence({ conflicts: [
    {
      title: 'Store ID Type Constant Usage Conflict',
      severity: 'HIGH',
      files: ['CleanCache.php', 'PersistConfiguration.php', 'MbeUpdateInstalledConfig.php', 'Meta/BusinessExtension/Model/System/Config.php'],
      description: 'Store ID passed as string in one path, int in another.',
    },
    {
      title: 'Composer Constraint Version Conflict',
      severity: 'MEDIUM',
      files: ['composer.json', 'composer.lock'],
      description: 'Version constraint mismatch in Composer files.',
    },
  ]});
  const candidates = extractCandidates([fixture]);
  const storeId = find(candidates, 'Store ID Type Constant') || find(candidates, 'Store ID Type');
  if (!storeId) {
    console.log('  ✗  5a "Store ID Type Constant Usage" not found as separate candidate');
    console.log('       Available candidates:', candidates.map(c => c.title?.slice(0,45)));
    failed++;
  } else {
    check('5a Store ID is separate candidate',  true, true);
    hasFile('5b Store ID has CleanCache.php',           storeId.files, 'CleanCache.php');
    hasFile('5c Store ID has PersistConfiguration.php', storeId.files, 'PersistConfiguration.php');
    console.log(`     Store ID files: ${JSON.stringify(storeId.files)}`);
  }
  const composer = find(candidates, 'Composer');
  if (composer) {
    const storeIdFiles = ['CleanCache.php', 'PersistConfiguration.php', 'MbeUpdateInstalledConfig.php'];
    const leaked = (composer.files||[]).filter(f => storeIdFiles.some(sf => f.includes(sf)));
    check('5d Composer has no Store ID files', leaked.length, 0);
  }
}

// ── Case 6: Finding with large file list (5+ files) ──────────────────────────
console.log('\n=== Case 6: Family 1 large file list (5+ files) ===');
{
  const fixture = jsonFence({ conflicts: [{
    title: 'Event Name String Inconsistency Across Controllers',
    severity: 'MEDIUM',
    files: [
      'app/code/Meta/BusinessExtension/Controller/Adminhtml/Ajax/CleanCache.php',
      'app/code/Meta/BusinessExtension/Controller/Adminhtml/Ajax/PersistConfiguration.php',
      'app/code/Meta/BusinessExtension/Controller/Adminhtml/Ajax/MbeUpdateInstalledConfig.php',
      'app/code/Meta/BusinessExtension/Controller/Adminhtml/Ajax/FbeInstallsConfig.php',
      'app/code/Meta/BusinessExtension/Controller/Adminhtml/Ajax/FbeSettings.php',
      'app/code/Meta/BusinessExtension/Controller/Adminhtml/Ajax/Disconnect.php',
    ],
    description: 'Event names inconsistent across controller files.',
  }]});
  const candidates = extractCandidates([fixture]);
  const c = find(candidates, 'Event Name String') || candidates[0];
  if (!c) { console.log('  ✗  No candidate found'); failed++; }
  else {
    check('6a 3+ files',   (c.files||[]).length >= 3, true);
    hasFile('6b has .php', c.files, '.php');
    console.log(`     files: ${c.files?.length} — ${JSON.stringify(c.files?.slice(0,3))}...`);
  }
}

// ── Case 7: Finding with fix_direction null (no fix_direction field) ──────────
console.log('\n=== Case 7: CONFLICT_N format + Family 2 standalone-bold files ===');
{
  const fixture = jsonFence({ conflicts: [{
    title: 'StoreId Type Mismatch Across Controller Actions',
    severity: 'HIGH',
    files: [
      'Meta/BusinessExtension/Controller/Adminhtml/Ajax/FbeInstallsConfig.php',
      'Meta/BusinessExtension/Controller/Adminhtml/Ajax/PersistConfiguration.php',
      'Meta/BusinessExtension/Controller/Adminhtml/Ajax/MbeUpdateInstalledConfig.php',
    ],
    description: 'StoreId parameter typed as string in some actions, int in others.',
    // no fix_direction — prose-only resolution, no surgical patch
  }]});
  const candidates = extractCandidates([fixture]);
  const c = find(candidates, 'StoreId Type Mismatch') || candidates[0];
  if (!c) {
    console.log('  ✗  No candidate found');
    failed++;
  } else {
    check('7a finding recognized',              true, true);
    check('7b files non-empty',                (c.files||[]).length > 0, true);
    hasFile('7c has FbeInstallsConfig',         c.files, 'FbeInstallsConfig.php');
    hasFile('7d has PersistConfiguration',      c.files, 'PersistConfiguration.php');
    check('7e 3+ files',                       (c.files||[]).length >= 3, true);
    const norm = normalizeCandidateToFinding(c);
    check('7f fix_direction null (no fix_direction in JSON)', norm.fix_direction, null);
    console.log(`     files: ${JSON.stringify(c.files?.slice(0,3))}...`);
  }
}

// ── Case 8: Finding with fix_direction populated ──────────────────────────────
console.log('\n=== Case 8: HEAD_BOLD C-NNN format + fix_direction populates ===');
{
  const fixture = jsonFence({ conflicts: [
    {
      title: 'ProjectSummary hasBaseline Type Mismatch',
      severity: 'HIGH',
      files: ['src/services/GitHubService.ts', 'src/screens/PortfolioScreen.tsx'],
      description: 'hasBaseline property typed as boolean in interface but used as number in screen.',
      fix_direction: {
        target_files: ['src/services/GitHubService.ts'],
        patch_instruction: 'interface ProjectSummary {\n  hasBaseline: boolean;\n  baselineCount: number;\n}',
        reasoning: 'Align interface type with actual usage pattern.',
        confidence: 'high',
      },
    },
    {
      title: 'Finding arrays always initialized conflict',
      severity: 'LOW',
      files: ['src/core/verifier.js'],
      description: 'Verifier finding arrays inconsistently initialized.',
      // no fix_direction — 2-block resolution by design
    },
  ]});
  const candidates = extractCandidates([fixture]);
  const c001 = find(candidates, 'ProjectSummary') || find(candidates, 'hasBaseline');
  if (!c001) {
    console.log('  ✗  C-001 equivalent not found');
    console.log('     Available:', candidates.slice(0,5).map(x => x.title?.slice(0,50)));
    failed++;
  } else {
    check('8a C-001 recognized',       true, true);
    check('8b files non-empty',        (c001.files||[]).length > 0, true);
    hasFile('8c has GitHubService.ts', c001.files, 'GitHubService.ts');
    hasFile('8d has PortfolioScreen',  c001.files, 'PortfolioScreen');
    console.log(`     C-001 files: ${JSON.stringify(c001.files)}`);
  }
  const allNorm = candidates.map(normalizeCandidateToFinding);
  const withFix = allNorm.filter(c => c.fix_direction !== null);
  const c008norm = allNorm.find(c => c.title?.includes('finding arrays'));
  if (c008norm) {
    check('8e C-008 has 1 file (fix_direction-eligible shape)', c008norm.files.length, 1);
    check('8f C-008 fix_direction null (no fix_direction in JSON)', c008norm.fix_direction, null);
  }
  console.log('     Total candidates with fix_direction:', withFix.length, '(expect 1 — only hasBaseline has it)');
}

// ── Case 9: JSON parser never creates junk from non-JSON content ───────────────
console.log('\n=== Case 9: H1 pass header must NOT create a candidate ===');
{
  // Non-JSON input — no fences → zero candidates (H1 junk test is moot)
  const markdown = '# Ghost Architect — Conflict Detection Scan (Pass 1 of 5)\n\nNo conflicts found.';
  const candidates = extractCandidates([markdown]);
  const junk = candidates.find(c =>
    c.title && c.title.toLowerCase().includes('ghost architect') &&
    c.title.toLowerCase().includes('conflict detection scan'));
  check('9a no junk candidate created from non-JSON input', junk === undefined, true);
  check('9b zero candidates from non-JSON input', candidates.length, 0);
  if (junk) console.log('     Junk candidate found:', junk.title?.slice(0,60));
}

// ── Case 10: Severity normalization — all valid values preserved ───────────────
console.log('\n=== Case 10: emoji ⚙️ Config Conflict header → clean candidate title ===');
{
  // JSON parser: title comes directly from JSON — no emoji prefix possible
  const fixture = jsonFence({ conflicts: [{
    title: 'Config Key Conflict: External Business ID Scope Mismatch',
    severity: 'HIGH',
    files: ['app/code/Meta/BusinessExtension/etc/config.xml', 'app/code/Meta/BusinessExtension/Model/Api/CoreConfig.php'],
    description: 'External business ID scope defined differently in config vs model.',
  }]});
  const candidates = extractCandidates([fixture]);
  const c = find(candidates, 'Config Key Conflict') || find(candidates, 'External Business ID Scope Mismatch');
  if (!c) {
    console.log('  ✗  10a no Config Conflict candidate found');
    failed++;
  } else {
    check('10a Config Conflict candidate exists',  true, true);
    // JSON titles are clean — no emoji possible
    const hasEmoji = /[^\x00-\x7F]/.test(c.title?.slice(0, 5) || '');
    check('10b title does not start with emoji',  hasEmoji, false);
    console.log('     title:', c.title?.slice(0, 60));
  }
}

// ── Case 11: Title extraction — clean, no prefix artifacts ───────────────────
console.log('\n=== Case 11: emoji 🔀 Contract Conflict header → clean candidate title ===');
{
  const fixture = jsonFence({ conflicts: [{
    title: 'Contract Conflict: Store ID Type Inconsistency in Request Parameters',
    severity: 'HIGH',
    files: ['app/code/Meta/BusinessExtension/Controller/Adminhtml/Ajax/CleanCache.php', 'app/code/Meta/BusinessExtension/Model/System/Config.php'],
    description: 'Store ID passed as string in controller, consumed as int in model.',
  }]});
  const candidates = extractCandidates([fixture]);
  const c = find(candidates, 'Contract Conflict') || find(candidates, 'Store ID Type Inconsistency');
  if (!c) {
    console.log('  ✗  11a no Contract Conflict candidate found');
    failed++;
  } else {
    check('11a Contract Conflict candidate exists', true, true);
    const hasEmoji = /[^\x00-\x7F]/.test(c.title?.slice(0, 5) || '');
    check('11b title does not start with emoji',   hasEmoji, false);
    console.log('     title:', c.title?.slice(0, 60));
  }
}

// ── Case 12: Empty JSON and multi-fence handling ──────────────────────────────
console.log('\n=== Case 12: "Highest risk conflicts" recap items must NOT create candidates ===');
{
  // 12a: empty conflicts array → zero candidates
  const emptyFence = jsonFence({ conflicts: [] });
  const synth = extractCandidates([emptyFence]);
  check('12a empty conflicts array → zero candidates', synth.length, 0);
  console.log('     synthetic candidates total:', synth.length, '(expect 0)');

  // 12b/12c: two real findings in separate fences — both survive
  const fence1 = jsonFence({ conflicts: [{
    title: 'Store ID Type Inconsistency Across Ajax Controllers',
    severity: 'HIGH',
    files: ['app/code/Meta/BusinessExtension/Controller/Adminhtml/Ajax/CleanCache.php'],
    description: 'Store ID typed inconsistently.',
  }]});
  const fence2 = jsonFence({ conflicts: [{
    title: 'Access Token Scope Parameter Mismatch',
    severity: 'MEDIUM',
    files: ['app/code/Meta/BusinessExtension/Model/Api/GraphAPIAdapter.php'],
    description: 'Access token scope differs between API calls.',
  }]});
  // Pass both as separate pass results (array input)
  const candidates = extractCandidates([fence1, fence2]);
  const legit1 = find(candidates, 'Store ID Type Inconsistency');
  const legit2 = find(candidates, 'Access Token Scope Parameter');
  check('12b legitimate finding 1 still present (Store ID Type)',   legit1 !== undefined, true);
  check('12c legitimate finding 2 still present (Access Token Scope)', legit2 !== undefined, true);
  if (legit1) console.log('     legit1 files:', legit1.files?.length);
  if (legit2) console.log('     legit2 files:', legit2.files?.length);
  console.log('     Total candidates:', candidates.length);
}

// ── Case 13: Title is clean — no digit-dot prefix ─────────────────────────────
console.log('\n=== Case 13: ### N. Plain Title format (reports-js) ===');
{
  const fixture = jsonFence({ conflicts: [{
    title: 'Finding Parser Import Mismatch — extractFindings vs extractFindingsFromReport',
    severity: 'MEDIUM',
    files: ['src/reports.js', 'src/utils/finding-parser.js', 'src/modes/poi.js'],
    description: 'extractFindings imported under two different names causing call-site confusion.',
  }]});
  const candidates = extractCandidates([fixture]);
  const c = find(candidates, 'Finding Parser Import Mismatch') || find(candidates, 'Finding Parser');
  if (!c) {
    console.log('  ✗  13a "Finding Parser Import Mismatch" not found');
    failed++;
  } else {
    check('13a finding recognized with clean title', true, true);
    check('13b title does not start with digit-dot', /^\d+\./.test(c.title || ''), false);
    check('13c files non-empty', (c.files||[]).length > 0, true);
    console.log('     title:', c.title?.slice(0,60));
    console.log('     files:', c.files?.length, c.files?.[0]?.split('/').pop());
  }
}

// ── Case 14: fix_direction fully populated ────────────────────────────────────
console.log('\n=== Case 14: ### N. **Bold Title** + fix_direction (package-json) ===');
{
  const fixture = jsonFence({ conflicts: [{
    title: 'Verifier Callback Interface Inconsistency',
    severity: 'HIGH',
    files: ['src/core/verifier.js', 'src/core/multipass.js', 'src/core/agent/loop.js', 'src/core/agent/verifier.js'],
    description: 'VerifierCallbacks interface defined differently in verifier.js vs multipass.js. onStart vs onVerified naming conflict.',
    fix_direction: {
      target_files: ['src/core/verifier.js', 'src/core/multipass.js'],
      patch_instruction: 'interface VerifierCallbacks {\n  onStart?: () => void;\n  onVerified?: (r: Result) => void;\n  onUsage?: (i: number, o: number, m: string) => void;\n}',
      reasoning: 'Unify callback interface in verifier.js — multipass.js imports from there.',
      confidence: 'high',
    },
  }]});
  const candidates = extractCandidates([fixture]);
  const c = find(candidates, 'Verifier Callback Interface');
  if (!c) {
    console.log('  ✗  14a "Verifier Callback Interface Inconsistency" not found');
    failed++;
  } else {
    check('14a finding recognized',                    true, true);
    check('14b title does not start with digit-dot',  /^\d+\./.test(c.title || ''), false);
    check('14c files non-empty',                       (c.files||[]).length > 0, true);
    hasFile('14d has verifier.js',                     c.files, 'verifier.js');
    hasFile('14e has multipass.js',                    c.files, 'multipass.js');
    const norm = normalizeCandidateToFinding(c);
    check('14f fix_direction populated',               norm.fix_direction !== null, true);
    if (norm.fix_direction) {
      console.log('     target_files:', JSON.stringify(norm.fix_direction.target_files?.slice(0,2)));
      console.log('     confidence:  ', norm.fix_direction.confidence);
      console.log('     patch (50c): ', norm.fix_direction.patch_instruction?.slice(0,50));
    }
  }
}

// ── Case 15: cost tracker accumulates correctly across mock pipeline calls ────
// (Unchanged — tests SessionCostTracker, not the parser)
console.log('\n=== Case 15: cost tracker accumulates correctly ===');
{
  const { SessionCostTracker } = await import('../../src/core/estimator.js');
  const tracker = new SessionCostTracker();
  const model = 'claude-sonnet-4-6';
  const mockCalls = [
    { mode: 'scan',    inputTokens: 120000, outputTokens: 8412  },
    { mode: 'scan',    inputTokens: 115000, outputTokens: 7900  },
    { mode: 'verify',  inputTokens:   4800, outputTokens:  256  },
    { mode: 'verify',  inputTokens:   5200, outputTokens:  312  },
    { mode: 'narrate', inputTokens:  22000, outputTokens: 4800  },
    { mode: 'plan',    inputTokens:   2800, outputTokens:  404  },
  ];
  for (const call of mockCalls) {
    tracker.record(call.mode, call.inputTokens, call.outputTokens, model);
  }
  const summary = tracker.getSummary();
  check('15a all pipeline calls recorded', summary.runs.length, mockCalls.length);
  const expectedTotal = mockCalls.reduce((sum, c) =>
    sum + (c.inputTokens / 1e6) * 3 + (c.outputTokens / 1e6) * 15, 0);
  const delta = Math.abs(summary.totalCost - expectedTotal);
  check('15b total cost matches sum of components', delta < 0.000001, true);
  console.log('     expected: $' + expectedTotal.toFixed(6));
  console.log('     actual:   $' + summary.totalCost.toFixed(6));
  const byStage = {};
  for (const r of summary.runs) { byStage[r.mode] = (byStage[r.mode] || 0) + r.cost; }
  const stageSum = Object.values(byStage).reduce((s, c) => s + c, 0);
  check('15c per-stage breakdown sums to total', Math.abs(stageSum - summary.totalCost) < 0.000001, true);
  const scanCost = byStage['scan'] || 0;
  const expectedScanCost = ((120000+115000)/1e6)*3 + ((8412+7900)/1e6)*15;
  check('15d scan stage accumulates across multiple calls', Math.abs(scanCost - expectedScanCost) < 0.000001, true);
  const verifyCost = byStage['verify'] || 0;
  const expectedVerifyCost = ((4800+5200)/1e6)*3 + ((256+312)/1e6)*15;
  check('15e verify stage tracked independently', Math.abs(verifyCost - expectedVerifyCost) < 0.000001, true);
  console.log('     stage breakdown:');
  for (const [stage, cost] of Object.entries(byStage)) {
    console.log('       ' + stage.padEnd(9) + '$' + cost.toFixed(4));
  }
  console.log('       ' + '─'.repeat(16));
  console.log('       Actual cost: $' + summary.totalCost.toFixed(4));
}

// ── Case 16: runMiniLoop callbacks forwarding (Unchanged — structural check) ───
console.log('\n=== Case 16: runMiniLoop callbacks forwarding (Bug 1 fix) ===');
{
  const loopSrc = (await import('fs')).default.readFileSync(
    new URL('../../src/core/agent/loop.js', import.meta.url), 'utf8');
  const verifierSrc = (await import('fs')).default.readFileSync(
    new URL('../../src/core/agent/verifier.js', import.meta.url), 'utf8');
  const miniLoopHasCallbacks = /export async function runMiniLoop\(task,\s*tools,\s*memory,\s*maxSteps[^)]*,\s*callbacks/.test(loopSrc);
  check('16a runMiniLoop signature includes callbacks param', miniLoopHasCallbacks, true);
  const miniLoopPassesCallbacks = /runAgentLoop\(task,\s*tools,\s*memory,\s*maxSteps,\s*callbacks\)/.test(loopSrc);
  check('16b runMiniLoop passes callbacks to runAgentLoop', miniLoopPassesCallbacks, true);
  const verifyOnePassesUsage = /runMiniLoop\(task,\s*tools,\s*memory,\s*5,\s*\{[^}]*onUsage/.test(verifierSrc);
  check('16c verifyOne passes { onUsage } to runMiniLoop', verifyOnePassesUsage, true);
  const { SessionCostTracker } = await import('../../src/core/estimator.js');
  const tracker = new SessionCostTracker();
  const onUsage = (i, o, m) => tracker.record('verify', i, o, m);
  onUsage(4800, 256, 'claude-sonnet-4-6');
  onUsage(5100, 312, 'claude-sonnet-4-6');
  onUsage(4600, 280, 'claude-sonnet-4-6');
  const verifyCost = tracker.runs.filter(r => r.mode === 'verify').reduce((s,r) => s+r.cost, 0);
  check('16d verify stage accumulates in tracker via onUsage', verifyCost > 0, true);
  console.log('     verify cost accumulated: $' + verifyCost.toFixed(4));
}

// ── Case 17: Multi-pass JSON merge — both passes produce candidates ────────────
console.log('\n=== Case 17: "Pass N of M" plain — must NOT be a candidate ===');
{
  // JSON parser: pass banners are irrelevant — JSON fences are extracted directly
  // Rewritten: verify that two JSON fences from two passes both contribute candidates
  const pass1 = jsonFence({ conflicts: [{
    title: 'AAM Settings Field Extraction Conflict',
    severity: 'HIGH',
    files: ['app/code/Meta/Conversion/Helper/AAMFieldsExtractorHelper.php'],
    description: 'Field extraction uses deprecated method in pass 1.',
  }]});
  const pass2 = jsonFence({ conflicts: [{
    title: 'Real Finding From Pass 2',
    severity: 'MEDIUM',
    files: ['app/code/Meta/BusinessExtension/Model/Api/GraphAPIAdapter.php'],
    description: 'Conflicting API call pattern in pass 2.',
  }]});

  // 17a: no "Pass N of M" junk candidate (trivially true for JSON parser)
  const cands = extractCandidates([pass1, pass2]);
  const passCand = cands.find(c => /pass\s+\d+\s+of\s+\d+/i.test(c.title||''));
  check('17a "Pass N of M" not extracted as candidate', !!passCand, false);

  // 17b: real finding from pass 2 is still extracted
  const realCand = cands.find(c => /Real Finding From Pass 2/i.test(c.title||''));
  check('17b real finding still extracted', !!realCand, true);
  console.log('     total candidates:', cands.length, '(expect 2 — one from each pass)');
}

// ── Case 18: Multi-fence from single pass + dedup ─────────────────────────────
console.log('\n=== Case 18: "CONFLICT DETECTION SCAN — PASS 9 of 11" — must NOT be a candidate ===');
{
  // JSON parser: scan banners are irrelevant. Rewritten: single fence with one finding.
  const fixture = jsonFence({ conflicts: [{
    title: 'Store ID Parameter Type Mismatch',
    severity: 'HIGH',
    files: ['app/code/Meta/BusinessExtension/Controller/Adminhtml/Ajax/CleanCache.php'],
    description: 'StoreId treated as string in one path, int in another.',
  }]});
  const cands = extractCandidates([fixture]);
  const scanBannerCand = cands.find(c => /CONFLICT DETECTION SCAN/i.test(c.title||'') && /pass/i.test(c.title||''));
  check('18a banner heading not extracted as candidate', !!scanBannerCand, false);
  const realCand = cands.find(c => /Store ID Parameter/i.test(c.title||''));
  check('18b real finding still extracted', !!realCand, true);
  console.log('     total candidates:', cands.length, '(expect 1)');
}

// ── Case 19: Dedup by title prefix (first 40 chars) ──────────────────────────
console.log('\n=== Case 19: Phase 4.5 numHeadRe findings still match (regression guard) ===');
{
  // JSON parser: numbered headings irrelevant. Rewritten: test title-prefix dedup.
  const fixture = jsonFence({ conflicts: [
    {
      title: 'Verifier Warning Annotation Format Mismatch in Core Module',
      severity: 'HIGH',
      files: ['src/core/verifier.js'],
      description: 'Annotation format inconsistent.',
    },
    {
      // Same first 40 chars as above — should be deduped
      title: 'Verifier Warning Annotation Format Mismatch in Agent Module',
      severity: 'MEDIUM',
      files: ['src/core/agent/verifier.js'],
      description: 'Duplicate title prefix — should be deduped.',
    },
  ]});
  const cands = extractCandidates([fixture]);
  const numberedCand = cands.find(c => /Verifier Warning/i.test(c.title||''));
  check('19a finding recognized',                 !!numberedCand, true);
  check('19b title does not contain leading digit-dot', /^\d+\./.test(numberedCand?.title || ''), false);
  // Dedup: both share "verifier warning annotation format mismatc" as first 40 chars
  check('19c dedup removes duplicate title prefix', cands.length, 1);
  if (numberedCand) console.log('     title:', numberedCand.title?.slice(0,60));
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} checks — ${failed} failure(s)\n`);
if (failed > 0) process.exit(1);
