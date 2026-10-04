/**
 * Ghost Open™ 12: free for one person.
 *
 * Pins the 12.0.0 product decision end to end:
 *
 *   a. Census: none of the removed modules exist, and no file under src/, bin/
 *      or lib/ imports or references them, nor carries the removed upsell and
 *      license strings. Non-vacuity: the scanner must visit a real number of
 *      files, and every census pattern must fire on a planted sample.
 *   b. Formerly limited entry points run past the old limits: saveReport six
 *      times (old shared quota: 4), Prompt Triage™ five times (counted against
 *      the same quota), Commit Forecast™ twice (old limit: 1, run here against
 *      a local mock of the Anthropic API) and Fix Forecast three times (old
 *      limit: 1).
 *   c. Profiles are gone. A profile file in ~/.ghost/profiles plus a
 *      default-profile setting left by an older install change nothing: the
 *      CLI runs a scripted Commit Forecast™ without crashing, the prompts the
 *      model receives are byte-identical to a run without the leftovers, and
 *      the saved Markdown and PDF carry none of the profile's text. Reports
 *      carry Ghost Architect™ branding. The Inheritance Audit asks for no
 *      project name.
 *   d. The upgrade line prints exactly once per saveReport and is the last
 *      line of the Markdown footer and of the PDF footer.
 *   e. `npm pack --dry-run --json` ships none of the removed files, and the
 *      package version is 12.0.0.
 *   f. `node bin/ghost.js --help` exits 0 and mentions no profile flag and no
 *      license, tier or pricing words.
 *   g. Every .js/.mjs under src/, bin/ and lib/ imports cleanly in a child
 *      process with HOME isolated (bin/ghost.js runs the CLI on import, so it
 *      is covered by --help in f).
 *
 * Isolation: HOME and XDG_CONFIG_HOME point at a temp dir before any Ghost
 * module loads; GHOST_NO_PING=1; the Anthropic API is a local mock server
 * (ANTHROPIC_BASE_URL). Nothing here touches the network or a real home dir.
 *
 * Run: node tests/ghost-open-12-free-for-one.smoke.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync, spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Isolation (before any Ghost import) ──────────────────────────────────────
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-open12-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.XDG_CONFIG_HOME = path.join(TMP_HOME, '.config');
process.env.GHOST_NO_PING = '1';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
delete process.env.CI;
delete process.env.GITHUB_ACTIONS;

let failures = 0;
let checks = 0;
function ok(cond, label, detail) {
  checks++;
  if (cond) { console.log('  OK  ' + label); return; }
  failures++;
  console.log('  !!  ' + label);
  if (detail) console.log('       ' + String(detail).split('\n').join('\n       '));
}

// Capture console output while running a function; returns { result, out }.
async function capture(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const sink = (...args) => { lines.push(args.map(String).join(' ')); };
  console.log = sink; console.warn = sink; console.error = sink;
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };
  try {
    const result = await fn();
    return { result, out: lines.join('\n') };
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
    process.stdout.write = origWrite;
  }
}

const stripAnsi = (s) => String(s).replace(/\x1B\[[0-9;]*m/g, '');
// Report file names carry a seconds timestamp, so back-to-back saves inside
// one second share a name. Space runs out so every run keeps its own files.
const nextSecond = () => new Promise((r) => setTimeout(r, 1050));
const countOf = (hay, needle) => hay.split(needle).length - 1;

// ── a. Census ─────────────────────────────────────────────────────────────────
console.log('\na) Removal census');

// Every path deleted for 12.0.0 (from `git diff --diff-filter=D` against 11.0.3).
const REMOVED_PATHS = [
  'src/license',                      // whole directory
  'src/freemium.js',
  'src/constants/pricing.js',
  'src/loader/tierCaps.js',
  'src/cli/session-state.js',
  'src/core/team-sync.js',
  'src/core/enterprise.js',
  'src/core/portal-publish.js',
  'src/core/mobile-publish.js',
  'src/core/projects.js',
  'src/projects.js',
  'src/watch',                        // whole directory
  'src/modes/watcher-commit.js',
  'scripts/license-gen.mjs',
  'scripts/generate-keypair.mjs',
  'scripts/set-portal-config.mjs',
  'scripts/backfill-portal.mjs',
  'ghost-watcher.yaml',
  '.github/workflows/ghost-watcher.yml',
  'src/profile',                      // whole directory: methodology profiles
];

// Patterns that would mean a removed module is imported or referenced again.
const REFERENCE_PATTERNS = [
  ['src/license/',        /(?:^|[\/'"`.])license\/(?:tier-gates|session|validator|store|token|format|fingerprint|clock|keys|revocation|session-refresh)/],
  ['freemium',            /freemium/],
  ['constants/pricing',   /constants\/pricing/],
  ['tierCaps',            /tierCaps/],
  ['session-state',       /session-state/],
  ['team-sync',           /team-sync/],
  ['enterprise.js',       /enterprise\.js/],
  ['portal-publish',      /portal-publish/],
  ['mobile-publish',      /mobile-publish/],
  ['core/projects',       /core\/projects/],
  ['src/projects.js',     /['"`](?:\.\.?\/)+(?:src\/)?projects\.js['"`]/],
  ['src/watch/',          /['"`](?:\.\.?\/)+(?:src\/)?watch\//],
  ['watcher-commit',      /watcher-commit/],
  ['src/profile/',        /(?:^|[\/'"`.])profile\/(?:index|wizard|writer|extractor)(?:\.js)?['"`]/],
  ['loadProfile',         /\bloadProfile\b/],
  ['getBranding',         /\bgetBranding\b/],
  ['mergeRates',          /\bmergeRates\b/],
  ['defaultProfileSlug',  /DefaultProfileSlug|defaultProfileSlug/],
  ['profile flags',       /--(?:no-|create-|list-|set-default-|clear-default-)?profiles?\b/],
];

// Strings the free product must not carry.
const FORBIDDEN_STRINGS = [
  ['license.ghostarchitect.dev', /license\.ghostarchitect\.dev/],
  ['pulse-stats',                /pulse-stats/],
  ['Pro or higher',              /Pro or higher/],
  ['(Team plan)',                /\(Team plan\)/],
  ['(Max plan)',                 /\(Max plan\)/],
  ['upgrade to Pro',             /upgrade to Pro/i],
];

function listSourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js)$/.test(e.name)) out.push(p);
    }
  };
  for (const d of ['src', 'bin', 'lib']) walk(path.join(ROOT, d));
  return out.sort();
}

// The census itself, exported as a function so the non-vacuity checks below
// run the exact same matcher against planted samples.
function censusHits(text) {
  const hits = [];
  for (const [name, re] of REFERENCE_PATTERNS) if (re.test(text)) hits.push('ref:' + name);
  for (const [name, re] of FORBIDDEN_STRINGS) if (re.test(text)) hits.push('str:' + name);
  return hits;
}

{
  for (const rel of REMOVED_PATHS) {
    ok(!fs.existsSync(path.join(ROOT, rel)), `removed: ${rel} is gone`);
  }

  const files = listSourceFiles();
  ok(files.length >= 80, `census scans a real file set (${files.length} files under src/, bin/, lib/)`);
  ok(files.some(f => f.endsWith(path.join('bin', 'ghost.js'))), 'census includes bin/ghost.js');
  ok(files.some(f => f.endsWith(path.join('src', 'reports.js'))), 'census includes src/reports.js');

  const offenders = [];
  for (const f of files) {
    const hits = censusHits(fs.readFileSync(f, 'utf8'));
    if (hits.length) offenders.push(`${path.relative(ROOT, f)}: ${hits.join(', ')}`);
  }
  ok(offenders.length === 0, 'no source file references a removed module or upsell string', offenders.join('\n'));

  // Non-vacuity: each pattern must fire on a planted sample, so a census that
  // silently stopped matching would fail here instead of passing vacuously.
  const PLANTED = {
    'ref:src/license/':      "import { requireTier } from '../license/tier-gates.js';",
    'ref:freemium':          "import { getScanCount } from './freemium.js';",
    'ref:constants/pricing': "import { PRICING } from '../constants/pricing.js';",
    'ref:tierCaps':          "import { getTierCap } from './loader/tierCaps.js';",
    'ref:session-state':     "import { markCalloutShown } from '../cli/session-state.js';",
    'ref:team-sync':         "import { pushReport } from './core/team-sync.js';",
    'ref:enterprise.js':     "await import('./core/enterprise.js');",
    'ref:portal-publish':    "import { publishToPortal } from './core/portal-publish.js';",
    'ref:mobile-publish':    "import { publishProject } from './core/mobile-publish.js';",
    'ref:core/projects':     "import { slugify } from './core/projects.js';",
    'ref:src/projects.js':   "import { promptProjectLabel } from '../projects.js';",
    'ref:src/watch/':        "await import('../src/watch/index.js');",
    'ref:watcher-commit':    "await import('../src/modes/watcher-commit.js');",
    'ref:src/profile/':      "import { loadProfile } from '../src/profile/index.js';",
    'ref:loadProfile':       "const p = await loadProfile(file);",
    'ref:getBranding':       "const branding = getBranding(meta.profile);",
    'ref:mergeRates':        "const rates = mergeRates(getRates(), profile);",
    'ref:defaultProfileSlug':"const slug = getDefaultProfileSlug();",
    'ref:profile flags':     "if (a === '--set-default-profile') { }",
    'str:license.ghostarchitect.dev': "fetch('https://license.ghostarchitect.dev/activate')",
    'str:pulse-stats':       "fetch('https://signup.ghostarchitect.dev/pulse-stats')",
    'str:Pro or higher':     "chalk.gray('(Pro or higher)')",
    'str:(Team plan)':       "chalk.gray('  (Team plan)')",
    'str:(Max plan)':        "chalk.gray('  (Max plan)')",
    'str:upgrade to Pro':    "console.log('Upgrade to Pro for unlimited Forecasts.')",
  };
  for (const [want, sample] of Object.entries(PLANTED)) {
    ok(censusHits(sample).includes(want), `census fires on a planted ${want}`);
  }
  // And it must not fire on the kept neighbours that share words with removed modules.
  ok(censusHits("import { parseRepo } from '../utils/repo-url.js';").length === 0, 'census ignores the kept repo-url module');
  ok(censusHits("import { submitBatch } from '../modes/watcher-batch.js';").length === 0, 'census ignores the kept watcher-batch module');
  ok(censusHits("Files: `pricing.js`, `utils.js`").length === 0, 'census ignores an unrelated pricing.js file name');
}

// ── Ghost imports (after isolation) ──────────────────────────────────────────
const { saveReport, REPORTS_DIR } = await import('../src/reports.js');
const { UPGRADE_LINE } = await import('../src/cli/upgrade-line.js');
const { reportFooterLines } = await import('../src/pdf-generator.js');
const { runAuditMode } = await import('../src/modes/audit/index.js');
const inquirer = (await import('inquirer')).default;
const { runPromptTriageMode } = await import('../src/modes/prompt-triage.js');
const { runCommitForecastMode } = await import('../src/modes/commit-forecast.js');
const { runFixForecast } = await import('../src/modes/fix-forecast-writer.js');
const { loadFromPath, setScanOptions } = await import('../src/loader/index.js');

const PAYWALL_RE = /paywall|upgrade to pro|pro or higher|ghostarchitect\.dev\/pricing|free (?:scan|forecast)s? (?:left|used)|quota|activate a/i;

// Decode the text drawn into a PDFKit file: inflate each content stream and
// join the hex strings of every TJ array (WinAnsi, so ™ is 0x99).
function pdfText(file) {
  const buf = fs.readFileSync(file);
  const raw = buf.toString('latin1');
  const lines = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let body;
    try { body = zlib.inflateSync(buf.subarray(start, end)).toString('latin1'); } catch { continue; }
    for (const arr of body.matchAll(/\[((?:<[0-9a-fA-F]*>|[-\d.\s])*)\]\s*TJ/g)) {
      let line = '';
      for (const hex of arr[1].matchAll(/<([0-9a-fA-F]*)>/g)) {
        line += Buffer.from(hex[1], 'hex').toString('latin1').replace(/\x99/g, '™');
      }
      lines.push(line);
    }
  }
  return lines;
}
const squash = (s) => s.replace(/\s+/g, '');

// ── b. Formerly limited entry points run past the old limits ─────────────────
console.log('\nb) No limits: past the old quotas');

{
  // saveReport: the old Open quota was 4 saved scans, counted inside saveReport.
  const saved = [];
  let output = '';
  for (let i = 0; i < 6; i++) {
    if (i > 0) await nextSecond();
    const { result, out } = await capture(() =>
      saveReport(`POINTS OF INTEREST\n\nRun ${i}: no findings.\n`, 'ghost-poi', null, {}));
    saved.push(result);
    output += out + '\n';
  }
  ok(saved.every(r => r && fs.existsSync(r.mdPath) && fs.existsSync(r.txtPath)),
    'saveReport saved 6 reports in a row (old quota: 4)');
  ok(new Set(saved.map(r => r.filename)).size === 6, 'each save produced its own report files');
  ok(!PAYWALL_RE.test(stripAnsi(output)), 'no paywall or quota copy across 6 saves', stripAnsi(output).slice(0, 400));
}

{
  // Prompt Triage™ used to draw from the same 4-scan pool.
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-open12-prompts-'));
  fs.writeFileSync(path.join(folder, 'support.md'), '# Support agent\n\nYou are a support agent. Answer briefly.\n');
  const reportsDir = path.join(TMP_HOME, 'pt-reports');
  let completed = 0;
  let output = '';
  for (let i = 0; i < 5; i++) {
    const { result, out } = await capture(() =>
      runPromptTriageMode({ source: { kind: 'localFolder', path: folder }, reportsDir }));
    if (result && result.reportPath && fs.existsSync(result.reportPath)) completed++;
    output += out + '\n';
  }
  ok(completed === 5, `Prompt Triage™ completed 5 runs (old pool: 4), got ${completed}`);
  const plain = stripAnsi(output);
  ok(!PAYWALL_RE.test(plain), 'no paywall or quota copy across 5 Prompt Triage™ runs');
  ok(countOf(plain, UPGRADE_LINE) === 5, `Prompt Triage™ prints the upgrade line once per run (got ${countOf(plain, UPGRADE_LINE)} for 5 runs)`);
}

// Local mock of the Anthropic Messages API. Every request gets a short text
// answer with no findings; streaming requests get a well-formed SSE stream.
const mockCalls = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
    mockCalls.push({ url: req.url, stream: !!parsed.stream, body });
    const text = 'No findings: the proposed change has no measurable blast radius.';
    const message = {
      id: 'msg_mock', type: 'message', role: 'assistant', model: parsed.model || 'claude-sonnet-4-6',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 9 },
    };
    if (!parsed.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_mock' });
      res.end(JSON.stringify(message));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_mock' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } });
    ev('message_stop', {});
    res.end();
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

{
  // Commit Forecast™: the old Open allowance was one forecast per install.
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-open12-base-'));
  const proposed = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-open12-prop-'));
  fs.mkdirSync(path.join(baseline, 'src'), { recursive: true });
  fs.mkdirSync(path.join(proposed, 'src'), { recursive: true });
  fs.writeFileSync(path.join(baseline, 'src', 'cart.js'), 'export function total(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n');
  fs.writeFileSync(path.join(baseline, 'src', 'tax.js'), 'export const RATE = 0.07;\n');
  fs.writeFileSync(path.join(proposed, 'src', 'cart.js'), 'export function total(items) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n');

  setScanOptions({});
  const countForecasts = () => fs.readdirSync(REPORTS_DIR).filter(f => /^ghost-forecast-.*\.md$/.test(f)).length;
  const before = countForecasts();
  let output = '';
  for (let i = 0; i < 2; i++) {
    if (i > 0) await nextSecond();
    const { out } = await capture(async () => {
      const ctx = await loadFromPath(baseline);
      await runCommitForecastMode(ctx, { cfBaseline: baseline, cfProposed: proposed, cfModes: 'blast' });
    });
    output += out + '\n';
  }
  const made = countForecasts() - before;
  ok(made === 2, `Commit Forecast™ saved 2 forecasts in a row (old limit: 1), got ${made}`, stripAnsi(output).slice(-600));
  ok(mockCalls.length >= 2 && mockCalls.every(c => c.url.startsWith('/v1/messages')),
    `forecast model calls went to the local mock only (${mockCalls.length} calls)`);
  ok(!PAYWALL_RE.test(stripAnsi(output)), 'no paywall or quota copy across 2 forecasts');
}

{
  // Fix Forecast: the old Open allowance was one run; a blocked run returned null.
  const ctx = { fileMap: { '/repo/src/a.js': 'const a = 1;\n' }, basePath: '/repo', loadedFiles: 1, totalFiles: 1, context: '' };
  const finding = {
    id: 'CONFLICT-1', title: 'Mismatched constant', severity: 'LOW',
    // A patch with no locatable change site: the generator reports "failed",
    // so the run writes its fix artifact without any model call.
    fix_direction: { target_files: ['src/a.js'], patch_instruction: 'zzz_not_present_anywhere();', reasoning: 'n/a' },
  };
  const results = [];
  for (let i = 0; i < 3; i++) {
    const { result } = await capture(() => runFixForecast(finding, ctx, {}));
    results.push(result);
  }
  ok(results.every(r => r && r.fixArtifactPath && fs.existsSync(r.fixArtifactPath)),
    'Fix Forecast ran 3 times and wrote its artifact each time (old limit: 1)');
}

// ── c. No profiles: an older install's leftovers change nothing ──────────────
console.log('\nc) Profiles removed: legacy leftovers are ignored');

const MARKER = 'Zephyrine';
let brandedSave = null;
{
  // A scripted Commit Forecast™ in a child process, against the mock API,
  // with and without the leftovers of an 11.x methodology profile setup.
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-open12-cbase-'));
  const proposed = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-open12-cprop-'));
  fs.mkdirSync(path.join(baseline, 'src'), { recursive: true });
  fs.mkdirSync(path.join(proposed, 'src'), { recursive: true });
  fs.writeFileSync(path.join(baseline, 'src', 'pay.js'), 'export function capture(id) { return id; }\n');
  fs.writeFileSync(path.join(proposed, 'src', 'pay.js'), 'export function capture(id) { return String(id); }\n');

  const makeHome = (withLegacy) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-open12-child-'));
    const cfgDir = path.join(home, '.config', 'configstore');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfg = { wizardComplete: true, anthropicApiKey: 'sk-ant-test-not-a-real-key', defaultModel: 'claude-sonnet-4-6' };
    if (withLegacy) {
      const profDir = path.join(home, '.ghost', 'profiles');
      fs.mkdirSync(path.join(profDir, '.cache'), { recursive: true });
      fs.writeFileSync(path.join(profDir, 'legacy.yaml'), [
        `name: "${MARKER} Payments Review"`,
        `author: "${MARKER} Reviewer"`,
        'priorities:',
        `  - ${MARKER} idempotency of payment capture`,
        'rates:',
        '  senior: 999',
        'branding:',
        `  company_name: "${MARKER} Consulting"`,
        `  footer_text: "${MARKER} Footer"`,
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(profDir, '.cache', 'deadbeef.json'), '{ not json');
      cfg.defaultProfileSlug = 'legacy';
    }
    fs.writeFileSync(path.join(cfgDir, 'ghost-architect.json'), JSON.stringify(cfg));
    return home;
  };
  const runChild = (home) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'ghost.js'),
      '--baseline', baseline, '--proposed', proposed, '--modes', 'blast'], {
      cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), GHOST_NO_PING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
  const promptsOf = (calls) => calls.map(c => {
    try { const b = JSON.parse(c.body); return JSON.stringify({ system: b.system, messages: b.messages }); }
    catch { return ''; }
  });

  const cleanHome = makeHome(false);
  let from = mockCalls.length;
  const clean = await runChild(cleanHome);
  const cleanPrompts = promptsOf(mockCalls.slice(from));

  const legacyHome = makeHome(true);
  from = mockCalls.length;
  const legacy = await runChild(legacyHome);
  const legacyPrompts = promptsOf(mockCalls.slice(from));

  ok(clean.code === 0, `scripted forecast runs without legacy files (exit ${clean.code})`, clean.out.slice(-400));
  ok(legacy.code === 0, `scripted forecast runs with a legacy profile and default-profile setting (exit ${legacy.code})`, legacy.out.slice(-400));
  ok(!legacy.out.includes(MARKER) && !/profile/i.test(stripAnsi(legacy.out)), 'the CLI never mentions the legacy profile', stripAnsi(legacy.out).slice(-400));
  ok(legacyPrompts.length > 0 && legacyPrompts.length === cleanPrompts.length, `same number of model calls with and without leftovers (${legacyPrompts.length})`);
  ok(legacyPrompts.join('\n') === cleanPrompts.join('\n'), 'the prompts the model receives are identical with and without leftovers');
  ok(!legacyPrompts.join('\n').includes(MARKER), 'no legacy profile text reaches a prompt');

  const reportsOf = (home) => {
    const dir = path.join(home, 'Ghost Architect Reports');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^ghost-forecast-.*\.md$/.test(f)).map(f => path.join(dir, f)) : [];
  };
  const legacyMd = reportsOf(legacyHome);
  ok(legacyMd.length === 1, 'the legacy-home run saved its forecast');
  if (legacyMd.length === 1) {
    const md = fs.readFileSync(legacyMd[0], 'utf8');
    ok(md.startsWith('# Ghost Architect™ -- Commit Forecast'), 'the saved Markdown is Ghost Architect™ branded');
    ok(!md.includes(MARKER), 'the saved Markdown carries no legacy profile text');
    ok(!md.includes('$999'), 'legacy profile rates do not reach the report');
    const pdf = legacyMd[0].replace(/\.md$/, '.pdf');
    ok(fs.existsSync(pdf) && !pdfText(pdf).join('\n').includes(MARKER), 'the saved PDF carries no legacy profile text');
  }
  ok(fs.existsSync(path.join(legacyHome, '.ghost', 'profiles', 'legacy.yaml')), 'the legacy profile file is left untouched');

  // --help and --version also start cleanly with the leftovers in place.
  for (const flag of ['--help', '--version']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ghost.js'), flag], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HOME: legacyHome, XDG_CONFIG_HOME: path.join(legacyHome, '.config'), GHOST_NO_PING: '1' },
    });
    ok(r.status === 0 && !(r.stdout + r.stderr).includes(MARKER), `${flag} runs cleanly with legacy leftovers`);
  }
  // A removed profile flag is reported as unknown and ignored, not a crash.
  {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ghost.js'), '--list-profiles', '--version'], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HOME: legacyHome, XDG_CONFIG_HOME: path.join(legacyHome, '.config'), GHOST_NO_PING: '1' },
    });
    ok(r.status === 0 && /Unknown flag: --list-profiles/.test(r.stderr), 'a removed profile flag is ignored with an "Unknown flag" note');
  }
  for (const d of [baseline, proposed, cleanHome, legacyHome]) fs.rmSync(d, { recursive: true, force: true });
}

{
  // A saved report is Ghost Architect™ branded (used by section d below).
  const { result, out } = await capture(() => saveReport(
    'POINTS OF INTEREST\n\nRED FLAGS\n\nNo findings in this fixture.\n',
    'ghost-poi', null, { transport: { method: 'streaming' } }));
  brandedSave = { result, out };
  const md = fs.readFileSync(result.mdPath, 'utf8');
  ok(md.startsWith('# Ghost Architect™ -- Points of Interest Report'), 'Markdown header is Ghost Architect™ branded');
  ok(md.includes('Generated by Ghost Architect™'), 'Markdown keeps the "Generated by Ghost Architect™" footer');
  ok(result.pdfPath && fs.existsSync(result.pdfPath), 'PDF was written');
  const pdfLines = pdfText(result.pdfPath);
  ok(pdfLines.length > 10, `PDF text decodes (${pdfLines.length} text runs)`);
  ok(pdfLines.join('\n').includes('Ghost Architect™'), 'PDF chrome is Ghost Architect™ branded');
}

{
  // The Inheritance Audit asks for no project name. Drive it with every
  // inquirer prompt answered by a stub that records the questions.
  const asked = [];
  const origPrompt = inquirer.prompt;
  inquirer.prompt = async (questions) => {
    const answers = {};
    for (const q of [].concat(questions)) {
      asked.push(`${q.type || 'input'}:${q.name}:${stripAnsi(typeof q.message === 'function' ? q.message({}) : q.message)}`);
      if (q.type === 'list') {
        const choices = (q.choices || []).filter(c => c && c.value !== undefined);
        answers[q.name] = typeof q.default === 'number' && choices[q.default] ? choices[q.default].value : (choices[0] && choices[0].value);
      } else if (q.type === 'confirm') {
        answers[q.name] = q.name === 'proceed';
      } else {
        answers[q.name] = '';
      }
    }
    return answers;
  };
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-open12-audit-'));
  fs.writeFileSync(path.join(auditDir, 'package.json'), JSON.stringify({ name: 'audit-fixture', dependencies: { express: '^4.18.0' } }));
  fs.mkdirSync(path.join(auditDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(auditDir, 'src', 'server.js'), 'import express from "express";\nexport const app = express();\n');
  let crashed = null;
  try {
    setScanOptions({});
    await capture(async () => {
      const ctx = await loadFromPath(auditDir);
      await runAuditMode(ctx);
    });
  } catch (e) { crashed = e; } finally { inquirer.prompt = origPrompt; }
  ok(!crashed, 'the Inheritance Audit runs to its save prompt', crashed && crashed.message);
  ok(asked.length >= 2, `the audit asked its usual questions (${asked.length}: ${asked.map(a => a.split(':')[1]).join(', ')})`);
  ok(!asked.some(a => /project|label|name for the report/i.test(a)), 'the Inheritance Audit asks for no project name', asked.join('\n'));
  fs.rmSync(auditDir, { recursive: true, force: true });
}

await new Promise((r) => mock.close(r));

// ── d. The upgrade line ──────────────────────────────────────────────────────
console.log('\nd) Upgrade line');
{
  ok(UPGRADE_LINE === 'Ghost Open™ is free for one person. For deeper scans, teams and your own AI model on your own hardware: Ghost Architect™ Local 8 (early access beta): ghostarchitect.dev/beta.html',
    'the upgrade line is the exact approved wording');
  ok(!UPGRADE_LINE.includes('\u2014'), 'the upgrade line has no em dash');

  const term = stripAnsi(brandedSave.out);
  ok(countOf(term, UPGRADE_LINE) === 1, `saveReport prints the upgrade line exactly once (got ${countOf(term, UPGRADE_LINE)})`);
  ok(/\x1B\[90m/.test(brandedSave.out) || brandedSave.out === term,
    'the terminal upgrade line is dim gray (or colour is disabled)');

  const md = fs.readFileSync(brandedSave.result.mdPath, 'utf8');
  const mdLines = md.split('\n').filter(l => l.trim() !== '');
  ok(countOf(md, UPGRADE_LINE) === 1, 'the Markdown report carries the upgrade line exactly once');
  ok(mdLines[mdLines.length - 1] === UPGRADE_LINE, 'the upgrade line is the last line of the Markdown footer', mdLines.slice(-3).join('\n'));

  const footer = reportFooterLines({ transport: { method: 'streaming' } });
  ok(footer[footer.length - 1] === UPGRADE_LINE, 'the upgrade line is the last line of the PDF footer');
  ok(reportFooterLines({}).length === 1 && reportFooterLines({})[0] === UPGRADE_LINE, 'the PDF footer carries the upgrade line even without transport metadata');

  const pdfLines = pdfText(brandedSave.result.pdfPath);
  const tail = squash(pdfLines.slice(-4).join(''));
  ok(tail.endsWith(squash(UPGRADE_LINE)), 'the rendered PDF ends with the upgrade line', pdfLines.slice(-4).join(' | '));
  ok(countOf(squash(pdfLines.join('')), squash(UPGRADE_LINE)) === 1, 'the rendered PDF carries the upgrade line exactly once');
}

// ── e. Packed file list and version ──────────────────────────────────────────
console.log('\ne) npm pack');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok(pkg.version === '12.0.0', `package.json version is 12.0.0 (got ${pkg.version})`);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  ok(lock.version === '12.0.0' && lock.packages[''].version === '12.0.0', 'package-lock.json agrees on 12.0.0');

  const packOut = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_loglevel: 'silent' },
  });
  const packed = JSON.parse(packOut.slice(packOut.indexOf('[')));
  const files = (packed[0]?.files || []).map(f => f.path);
  ok(files.length > 50, `npm pack lists the package files (${files.length})`);
  ok(packed[0]?.version === '12.0.0', 'npm pack sees version 12.0.0');
  const shipped = files.filter(f => REMOVED_PATHS.some(r => f === r || f.startsWith(r + '/')));
  ok(shipped.length === 0, 'npm pack ships none of the removed files', shipped.join('\n'));
  ok(files.includes('src/modes/watcher-batch.js') && files.includes('src/lib/batch-submit.js'), 'the --batch transport still ships');
  ok(files.includes('src/cli/upgrade-line.js') && files.includes('src/loader/contextCap.js'), 'the new modules ship');
}

// ── f. --help ─────────────────────────────────────────────────────────────────
console.log('\nf) ghost --help');
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ghost.js'), '--help'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME }, timeout: 30000,
  });
  ok(r.status === 0, `--help exits 0 (got ${r.status})`, r.stderr);
  const help = r.stdout || '';
  const profileFlags = help.match(/--(?:no-|create-|list-|set-default-|clear-default-)?profiles?\b|--clean-cache/g);
  ok(!profileFlags, '--help names no profile flag', profileFlags && profileFlags.join(', '));
  ok(!/profile/i.test(help), '--help does not mention profiles at all');
  const bad = help.match(/licen[cs]e|\btiers?\b|pricing|\btrial\b|--activate|white-label|\bPro\+|Max plan|Team plan/gi);
  ok(!bad, '--help mentions no license, tier or pricing words', bad && bad.join(', '));
  ok(help.includes('Ghost Open™'), '--help names Ghost Open™');
}

// ── g. Every module imports cleanly ──────────────────────────────────────────
console.log('\ng) Clean imports');
{
  const SKIP = new Set([path.join(ROOT, 'bin', 'ghost.js')]); // runs the CLI on import; covered by f
  const modules = listSourceFiles().filter(f => !SKIP.has(f));
  const script = `
    const files = JSON.parse(process.argv[1]);
    const failed = [];
    for (const f of files) {
      try { await import(f); } catch (e) { failed.push(f + ': ' + (e && e.message)); }
    }
    process.stdout.write(JSON.stringify(failed));
    process.exit(0);
  `;
  const childHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-open12-imp-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script,
    JSON.stringify(modules.map(f => 'file://' + f))], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, HOME: childHome, USERPROFILE: childHome, XDG_CONFIG_HOME: path.join(childHome, '.config'), GHOST_NO_PING: '1' },
  });
  let failed = null;
  try { failed = JSON.parse(r.stdout); } catch { /* reported below */ }
  ok(Array.isArray(failed), `import child ran (${modules.length} modules)`, r.stderr);
  ok(Array.isArray(failed) && failed.length === 0, 'every module under src/, bin/, lib/ imports cleanly', (failed || []).join('\n'));
  fs.rmSync(childHome, { recursive: true, force: true });
}

fs.rmSync(TMP_HOME, { recursive: true, force: true });

console.log(`\n${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exit(1);
console.log('PASSED: Ghost Open™ 12 is free for one person');
process.exit(0);
