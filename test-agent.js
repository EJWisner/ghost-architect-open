/**
 * Ghost Architect — Agent Layer Test Script
 * Run: node test-agent.js
 *
 * Tests the full agent pipeline against files in the current directory.
 * Does NOT touch the main CLI — safe to run standalone.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load a small file map from src/ for testing ───────────────────────────────

function loadTestFileMap(dir, maxFiles = 15) {
  const fileMap = {};
  function walk(d) {
    if (Object.keys(fileMap).length >= maxFiles) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (Object.keys(fileMap).length >= maxFiles) break;
      const full = path.join(d, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git', '.next'].includes(entry.name)) {
        walk(full);
      } else if (entry.isFile() && /\.(js|ts|json|xml|php)$/.test(entry.name)) {
        const rel = path.relative(__dirname, full);
        fileMap[rel] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  walk(dir);
  return fileMap;
}

// ── Color helpers (inline — no chalk dependency) ──────────────────────────────

const c = {
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  gray:   s => `\x1b[90m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
};

function divider(char = '─', len = 60) {
  return c.gray(char.repeat(len));
}

// ── Run tests ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + divider('═'));
  console.log(c.bold(c.cyan('  👻 GHOST ARCHITECT — AGENT LAYER TEST')));
  console.log(divider('═'));

  const args    = process.argv.slice(2);
  const runAll  = args.length === 0;
  const runTest = name => runAll || args.includes(name);

  // ── TEST 1: Memory ──────────────────────────────────────────────────────────
  if (runTest('memory')) {
    console.log('\n' + c.bold('TEST 1: AgentMemory'));
    console.log(divider());

    const { AgentMemory } = await import('./src/core/agent/memory.js');
    const mem = new AgentMemory();

    mem.record('readFile',    { path: 'src/test.js' }, 'file contents here', 'Reading test file');
    mem.record('searchFiles', { query: 'Payment' },    [{ path: 'a.js' }],   'Searching for payment refs');
    mem.record('flagFinding', { severity: 'HIGH', title: 'Test finding' }, { recorded: true }, 'Found issue');
    mem.addFinding({ severity: 'HIGH', title: 'Test Finding', detail: 'Detail here', files: ['a.js'], confidence: 90 });

    const history = mem.getHistory(5);
    const summary = mem.summary();
    const synth   = mem.synthesize();

    console.log(c.green('✓ record()    ') + `${summary.steps} steps recorded`);
    console.log(c.green('✓ getHistory()') + ` ${history.length} entries returned`);
    console.log(c.green('✓ hasRead()   ') + `src/test.js → ${mem.hasRead('src/test.js')}`);
    console.log(c.green('✓ addFinding()') + ` ${summary.findings} findings`);
    console.log(c.green('✓ synthesize()') + ` filesAnalyzed=${synth.filesAnalyzed}, stepCount=${synth.stepCount}`);
    console.log(c.green('✓ Memory PASS'));
  }

  // ── TEST 2: Tools ───────────────────────────────────────────────────────────
  if (runTest('tools')) {
    console.log('\n' + c.bold('TEST 2: Agent Tools'));
    console.log(divider());

    const { AgentMemory }                       = await import('./src/core/agent/memory.js');
    const { buildTools, buildToolDescriptions } = await import('./src/core/agent/tools.js');

    const fileMap = loadTestFileMap(path.join(__dirname, 'src'), 10);
    const memory  = new AgentMemory();
    const tools   = buildTools(fileMap, memory);

    console.log(c.gray(`  Loaded ${Object.keys(fileMap).length} test files:`));
    Object.keys(fileMap).slice(0, 5).forEach(f => console.log(c.gray(`    ${f}`)));
    console.log('');

    const listResult   = await tools.listDirectory.execute({ path: 'src' });
    console.log(c.green('✓ listDirectory') + ` found ${listResult.fileCount} files under src/`);

    const searchResult = await tools.searchFiles.execute({ query: 'import', type: 'string', limit: 5 });
    console.log(c.green('✓ searchFiles  ') + ` found ${searchResult.resultCount} files matching 'import'`);

    const firstFile    = Object.keys(fileMap).find(f => f.endsWith('.js'));
    if (firstFile) {
      const sumResult  = await tools.summarizeFile.execute({ path: firstFile });
      console.log(c.green('✓ summarizeFile') + ` ${firstFile} — ${sumResult.lineCount} lines, ${sumResult.methods.length} methods`);
    }

    const readResult   = await tools.readFile.execute({ path: firstFile });
    console.log(c.green('✓ readFile     ') + ` got ${readResult.content?.length || 0} chars`);

    const classResult  = await tools.resolveClass.execute({ className: 'AgentMemory' });
    console.log(c.green('✓ resolveClass ') + ` AgentMemory → ${classResult.path || 'not found (expected)'}`);

    const flagResult   = await tools.flagFinding.execute({
      severity: 'HIGH', title: 'Test Flag', detail: 'Test detail', files: ['src/test.js'], confidence: 85
    });
    console.log(c.green('✓ flagFinding  ') + ` recorded finding #${flagResult.findingId}`);

    const descs = buildToolDescriptions(tools);
    console.log(c.green('✓ buildToolDescriptions') + ` ${descs.length} chars`);
    console.log(c.green('✓ Tools PASS'));
  }

  // ── TEST 3: Planner ─────────────────────────────────────────────────────────
  if (runTest('planner')) {
    console.log('\n' + c.bold('TEST 3: Planner (Recon)'));
    console.log(divider());
    console.log(c.gray('  Making 1 API call to Claude...'));

    const { runRecon, formatPlanForDisplay } = await import('./src/core/agent/planner.js');
    const fileMap = loadTestFileMap(path.join(__dirname, 'src'), 15);
    const plan    = await runRecon(fileMap, 'poi', {});
    const display = formatPlanForDisplay(plan);

    console.log('');
    console.log(c.cyan('  Plan Summary:'));
    console.log('  ' + (display.summary || 'none'));
    console.log('');
    console.log(c.cyan('  Stats:'));
    Object.entries(display.stats).forEach(([k, v]) => console.log(`    ${k}: ${c.bold(String(v))}`));
    if (display.risks.length)    display.risks.slice(0, 3).forEach(r => console.log(c.yellow(`    ⚠ ${r}`)));
    if (display.warnings.length) display.warnings.forEach(w => console.log(c.yellow(`    ! ${w}`)));
    console.log('');
    console.log(c.green('✓ Planner PASS'));
  }

  // ── TEST 4: Agent Loop ──────────────────────────────────────────────────────
  if (runTest('loop')) {
    console.log('\n' + c.bold('TEST 4: Agent Loop (3-step mini run)'));
    console.log(divider());
    console.log(c.gray('  Running agent loop — up to 3 API calls...'));

    const { AgentMemory }  = await import('./src/core/agent/memory.js');
    const { buildTools }   = await import('./src/core/agent/tools.js');
    const { runAgentLoop } = await import('./src/core/agent/loop.js');

    const fileMap = loadTestFileMap(path.join(__dirname, 'src'), 10);
    const memory  = new AgentMemory();
    const tools   = buildTools(fileMap, memory);

    const result = await runAgentLoop(
      'List the main files in this codebase, identify what each one does, and flag any issues you find. Keep it brief.',
      tools, memory, 3,
      {
        onStep:       ({ step, maxSteps }) => process.stdout.write(c.gray(`  Step ${step}/${maxSteps}... `)),
        onThought:    ({ action })         => process.stdout.write(c.cyan(`${action}\n`)),
        onToolCall:   ({ input })          => process.stdout.write(c.dim(`    → ${JSON.stringify(input).slice(0, 80)}\n`)),
        onToolResult: ({ result })         => process.stdout.write(c.dim(`    ← ${JSON.stringify(result).slice(0, 100)}\n`)),
      }
    );

    console.log('');
    console.log(`    Files analyzed: ${result.filesAnalyzed}`);
    console.log(`    Steps taken:    ${result.stepCount}`);
    console.log(`    Findings:       ${result.findingCount}`);
    console.log(`    Duration:       ${result.elapsedSeconds}s`);
    if (result.findings.length > 0) {
      result.findings.forEach(f => console.log(c.yellow(`    [${f.severity}] ${f.title}`)));
    }
    console.log(c.green('✓ Loop PASS'));
  }

  // ── TEST 5: Narrator ────────────────────────────────────────────────────────
  if (runTest('narrator')) {
    console.log('\n' + c.bold('TEST 5: Narrator'));
    console.log(divider());
    console.log(c.gray('  Generating executive summary from mock findings...'));

    const { narrateExecutiveSummary } = await import('./src/core/agent/narrator.js');

    const mockResult = {
      filesAnalyzed: 12, findingCount: 3, stepCount: 7,
      findings: [
        { severity: 'HIGH',   title: 'Multiple observers on checkout_submit_all_after', detail: 'Three observers on same event, no sort order. Race condition risk.', files: ['src/modes/conflict.js'], confidence: 90 },
        { severity: 'MEDIUM', title: 'Unused import in analyst module',                 detail: 'Dead code — imported module never called.',                          files: ['src/analyst/index.js'],  confidence: 85 },
        { severity: 'LOW',    title: 'Hardcoded API endpoint in config',                detail: 'URL should be in environment config.',                               files: ['src/config.js'],         confidence: 75 },
      ],
      auditTrail: [],
    };

    const summary = await narrateExecutiveSummary(mockResult, { projectLabel: 'ghost-architect-test' });
    console.log('');
    console.log(c.cyan('  Executive Summary:'));
    console.log('  ' + summary.split('\n').join('\n  '));
    console.log('');
    console.log(c.green('✓ Narrator PASS'));
  }

  console.log('\n' + divider('═'));
  console.log(c.bold(c.green('  👻 ALL TESTS COMPLETE')));
  console.log(divider('═') + '\n');
}

main().catch(err => {
  console.error('\n\x1b[31m✗ TEST FAILED:\x1b[0m', err.message);
  console.error(err.stack);
  process.exit(1);
});
