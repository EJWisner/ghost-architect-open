import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Regression test for mid-session license propagation (Audit 7, findings 1.2 + 1.3).
//
// validateLicense() used to run only at startup. Activating a license later in
// the same process (Reconfigure > License key, or first-run onboarding) saved
// the token but never updated the active session or the loader's tier cap, so
// a customer who just paid kept getting Open-tier treatment until restart.
// refreshLicenseSession() is the fix: validate, set the active session, push
// the tier into the loader, in one call. This test proves TIER-equivalent
// state and scan options update after a mid-session activation, no restart.
//
// Isolation: XDG_CONFIG_HOME is redirected to a throwaway temp dir BEFORE any
// Ghost module is imported (same pattern as tests/license/test-clock-ratchet.mjs),
// so nothing touches the real configstore. The license is delivered via the
// GHOST_LICENSE_KEY env seam, which feeds the exact same validator path as an
// installed record.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-session-refresh-'));
process.env.XDG_CONFIG_HOME = tmpDir;
process.env.GHOST_NO_LICENSE_VERIFY = '1';
delete process.env.GHOST_LICENSE_KEY;

const { encodeTrialToken } = await import('../src/license/token.js');
const loader = await import('../src/loader/index.js');
const session = await import('../src/license/session.js');
const { refreshLicenseSession } = await import('../src/license/session-refresh.js');

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
function trialToken({ daysFromNow }) {
  const now = new Date();
  const expires = new Date(now.getTime() + daysFromNow * 86400 * 1000);
  // issued must precede expires even for a lapsed token (timeline validation).
  const issued = new Date(expires.getTime() - 7 * 86400 * 1000);
  return encodeTrialToken({
    lid: 'TRIALSESSIONREFRESH',
    tier: 'trial',
    customer: 'trial@local',
    issued: iso(issued),
    expires: iso(expires),
    grace_until: iso(expires),
    hard_stop: iso(expires),
    fingerprint: null,
  });
}

// ── Baseline: session starts as Open, loader seeded with Open ───────────────
loader.setScanOptions({ tier: 'open' });
assert.equal(loader.getScanOptions().tier, 'open', 'baseline loader tier must be open');
assert.equal(session.getActiveTier(), null, 'baseline session has no active license');

// ── Mid-session activation: a live trial (Pro Max evaluation) lands ─────────
process.env.GHOST_LICENSE_KEY = trialToken({ daysFromNow: 7 });
const live = await refreshLicenseSession({ maxContextOverride: null });

assert.equal(live.tier, 'trial',
  `refresh must resolve the new tier without restart, got ${live.tier} (state: ${live.result.state})`);
assert.equal(session.getActiveTier(), 'trial',
  'active session must reflect the new license immediately');
assert.equal(loader.getScanOptions().tier, 'trial',
  'loader scan options must be re-seeded with the new tier immediately');

// ── Blocking license degrades the session instead of granting payload tier ──
process.env.GHOST_LICENSE_KEY = trialToken({ daysFromNow: -30 }); // long past hard stop
const lapsed = await refreshLicenseSession();

assert.equal(lapsed.tier, 'open',
  `a blocking (hard-stopped) license must degrade the session to open, got ${lapsed.tier}`);
assert.equal(session.getActiveTier(), null,
  'degraded session must not keep the stale paid tier');
assert.equal(loader.getScanOptions().tier, 'open',
  'loader must be re-seeded back to open on degrade');

// ── Overrides survive the re-seed (last-write-wins hazard) ───────────────────
process.env.GHOST_LICENSE_KEY = trialToken({ daysFromNow: 7 });
await refreshLicenseSession({ excludePatterns: ['vendor/**'] });
assert.deepEqual(loader.getScanOptions().excludePatterns, ['vendor/**'],
  'CLI-derived overrides passed to the refresh must survive the re-seed');

console.log('session refresh: PASS');
console.log('  mid-session activation updates active tier and loader scan options without restart');
console.log('  blocking license degrades to open; scan-option overrides survive the re-seed');
