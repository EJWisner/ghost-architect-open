import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeHumanKey } from '../src/license/format.js';

// Regression test for the CI license misconfiguration (Audit 7, finding 1.1).
//
// Every doc surface used to tell Ghost Watcher™ customers to set
// GHOST_LICENSE_KEY to their GA- human key. The validator consumes a signed
// 3-part token, so the humanKey failed decode, resolved to state 'invalid',
// and the watcher exited 0 with a generic line: the Team tier's flagship
// feature silently never scanned. The fix detects the humanKey shape up front
// and prints actionable guidance pointing at `ghost --export-ci-token`.

// ── Unit: humanKey shape detection ───────────────────────────────────────────
assert.equal(looksLikeHumanKey('GA-2026-TEM-YQ3A-ZSN4-XNHU'), true,
  'GA- humanKey must be detected');
assert.equal(looksLikeHumanKey('  ga-2026-pro-q39c-mwm2-9jex  '), true,
  'lowercase/padded humanKey must be detected');
assert.equal(looksLikeHumanKey('eyJhbGciOi.eyJsaWQiOi.c2lnbmF0dXJl'), false,
  '3-part dot-delimited token must NOT be detected as a humanKey');
assert.equal(looksLikeHumanKey('junk-value'), true,
  'arbitrary junk deserves the same guidance (not token-shaped)');
assert.equal(looksLikeHumanKey('a.b'), true, '2-part value is not token-shaped');
assert.equal(looksLikeHumanKey('a..c'), true, 'empty middle segment is not token-shaped');
assert.equal(looksLikeHumanKey(''), false, 'empty value: nothing set, nothing to warn about');
assert.equal(looksLikeHumanKey(undefined), false, 'absent value: nothing to warn about');

// ── Integration: the real CLI paths react to a GA- value, loudly ─────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GHOST_BIN = path.join(__dirname, '..', 'bin', 'ghost.js');
const env = {
  ...process.env,
  GHOST_LICENSE_KEY: 'GA-2026-TEM-YQ3A-ZSN4-XNHU',
  GHOST_NO_PING: '1',
  GHOST_NO_LICENSE_VERIFY: '1',
};

// Watcher: advisory, exits 0, but MUST explain the misconfiguration.
const watcher = spawnSync('node', [GHOST_BIN, '--watcher-commit'], {
  env, encoding: 'utf8', timeout: 60000,
});
assert.equal(watcher.status, 0,
  `watcher must stay advisory (exit 0), got ${watcher.status}\nstderr: ${watcher.stderr}`);
assert.ok(watcher.stderr.includes('license key rather than a signed token'),
  `watcher stderr must name the misconfiguration, got:\n${watcher.stderr}`);
assert.ok(watcher.stderr.includes('ghost --export-ci-token'),
  `watcher stderr must point at the fix (ghost --export-ci-token), got:\n${watcher.stderr}`);
assert.ok(!watcher.stderr.includes('license is not valid'),
  'watcher must NOT fall through to the old generic invalid-license line');

// Ghost Brief™: fail-closed, exits 1, with the same actionable guidance.
const brief = spawnSync('node', [GHOST_BIN, '--brief'], {
  env, encoding: 'utf8', timeout: 60000,
});
assert.equal(brief.status, 1,
  `brief must fail closed (exit 1), got ${brief.status}\nstderr: ${brief.stderr}`);
assert.ok(brief.stderr.includes('ghost --export-ci-token'),
  `brief stderr must point at the fix, got:\n${brief.stderr}`);

console.log('CI license key misconfiguration: PASS');
console.log('  GA- humanKey in GHOST_LICENSE_KEY triggers actionable guidance, not a silent skip');
console.log('  watcher exits 0 (advisory), brief exits 1 (fail-closed), both name the fix');
