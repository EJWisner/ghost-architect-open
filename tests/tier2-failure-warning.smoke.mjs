/**
 * Smoke test for Tier 2 failure-warning surfacing in
 * src/prompt-pack/llmAuditClient.js.
 *
 * Tier 2 detectors fail open by design: a broken detector (no API key, API
 * error, unparseable response) returns zero findings so the scan still
 * completes. The risk is that a paying customer receives an incomplete audit
 * and never knows a check was skipped. emitTier2FailureWarning() plus the
 * module's process-exit safety net make those silent failures visible on
 * stderr. These tests lock in that surfacing.
 *
 * To trigger a real failure deterministically and OFFLINE, each case runs in a
 * child process with a sanitized environment: a fresh empty HOME and no
 * ANTHROPIC_API_KEY. With no key resolvable, resolveApiKey() returns null,
 * getAnthropicClient() returns null, and auditPromptForDefect() records a
 * fail-open failure without ever making a network call.
 *
 * Run: node tests/tier2-failure-warning.smoke.mjs
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const clientPath = path.join(repoRoot, 'src', 'prompt-pack', 'llmAuditClient.js');
const configPath = path.join(repoRoot, 'src', 'config.js');

let failures = 0;

function checkContains(label, value, substring) {
  if (typeof value === 'string' && value.includes(substring)) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected to contain: ' + JSON.stringify(substring));
    console.log('       got:                 ' + JSON.stringify(value));
    failures++;
  }
}

function checkNotContains(label, value, substring) {
  if (typeof value !== 'string' || !value.includes(substring)) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected NOT to contain: ' + JSON.stringify(substring));
    console.log('       got:                     ' + JSON.stringify(value));
    failures++;
  }
}

// Build a child script that runs one audit and then executes `tail`. Marker
// lines on stdout let the parent assert on the audit outcome; the warning
// itself is asserted on stderr.
function childScript({ modelId, tail }) {
  return `
import { auditPromptForDefect, resetSessionUsage, getTier2Failures, emitTier2FailureWarning } from ${JSON.stringify(clientPath)};
import { getConfig } from ${JSON.stringify(configPath)};

// Belt and suspenders: empty HOME already means no stored key, but clear the
// (temp) configstore too so nothing on the host machine can leak in.
delete process.env.ANTHROPIC_API_KEY;
try { getConfig().clear(); } catch {}

resetSessionUsage();
const r = await auditPromptForDefect({
  detectorName: 'test/tier2-warning',
  modelId: ${JSON.stringify(modelId)},
  promptText: 'Summarize the following text in one sentence.',
  defectName: 'demo',
  defectDescription: 'demo',
  positiveExamples: '-',
  negativeExamples: '-',
});
process.stdout.write('AUDIT_OK=' + r.ok + '\\n');
process.stdout.write('FAILURES=' + getTier2Failures().length + '\\n');
void emitTier2FailureWarning; // referenced so the import is always live
${tail}
`;
}

function runChild(opts) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-tier2-test-'));
  const scriptFile = path.join(tmpHome, 'child.mjs');
  fs.writeFileSync(scriptFile, childScript(opts));

  const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
  delete env.ANTHROPIC_API_KEY;
  delete env.XDG_CONFIG_HOME;

  const res = spawnSync(process.execPath, [scriptFile], { env, encoding: 'utf8' });
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

// ── Test 1: explicit emit surfaces the warning on stderr ───────────────────
console.log('Test 1: emitTier2FailureWarning() prints to stderr after a failure');
{
  const { stdout, stderr } = runChild({
    modelId: 'claude-sonnet-4-6',
    tail:
      "const w = emitTier2FailureWarning();\n"
      + "process.stdout.write('EMIT_RETURNED=' + (typeof w === 'string' ? 'string' : 'null') + '\\n');",
  });
  checkContains('audit failed open (ok=false)', stdout, 'AUDIT_OK=false');
  checkContains('one failure recorded', stdout, 'FAILURES=1');
  checkContains('emit returned the warning string', stdout, 'EMIT_RETURNED=string');
  checkContains('stderr shows Tier 2 warning', stderr, 'Tier 2 deep-analysis');
  checkContains('stderr explains incompleteness', stderr, 'could not complete');
  checkContains('stderr names the detector', stderr, 'test/tier2-warning');
}
console.log('');

// ── Test 2: process-exit safety net surfaces the warning with NO explicit ──
// ── call. This is the production path: the mode file was not modified, so ──
// ── nothing calls emit during the scan; the exit handler must still fire.  ──
console.log('Test 2: exit handler surfaces the warning even with no explicit emit call');
{
  const { stdout, stderr } = runChild({
    modelId: 'claude-sonnet-4-6',
    tail: "// intentionally do not call emitTier2FailureWarning(); rely on the exit net",
  });
  checkContains('audit failed open (ok=false)', stdout, 'AUDIT_OK=false');
  checkContains('one failure recorded', stdout, 'FAILURES=1');
  checkContains('stderr shows Tier 2 warning at exit', stderr, 'Tier 2 deep-analysis');
}
console.log('');

// ── Test 3: no failures → no warning (no false alarms) ─────────────────────
// A testOnly model is skipped (ok:true, no failure recorded), so neither the
// explicit emit nor the exit handler should print anything.
console.log('Test 3: no warning when there were no Tier 2 failures');
{
  const { stdout, stderr } = runChild({
    modelId: 'test-tiny-4k',
    tail:
      "const w = emitTier2FailureWarning();\n"
      + "process.stdout.write('EMIT_RETURNED=' + (typeof w === 'string' ? 'string' : 'null') + '\\n');",
  });
  checkContains('audit skipped cleanly (ok=true)', stdout, 'AUDIT_OK=true');
  checkContains('no failures recorded', stdout, 'FAILURES=0');
  checkContains('emit returned null', stdout, 'EMIT_RETURNED=null');
  checkNotContains('stderr has no Tier 2 warning', stderr, 'Tier 2 deep-analysis');
}
console.log('');

if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
