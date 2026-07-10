// tests/paywall-trial-cta.smoke.mjs
//
// Audit 8, finding 1.1: renderUpgradePaywall unconditionally appended the
// "free 7-day Ghost Pro Max™ trial" CTA, but mode:watch is trial:false. An
// Open or Pro user selecting a Watch row followed the CTA, started a trial,
// and hit the identical paywall again. The CTA read as bait at the
// highest-intent moment in the Team funnel.
//
// v11.0.0 contract:
//   - paywallFor() carries trialUnlocks derived from the TIER_POLICY table.
//   - renderUpgradePaywall suppresses the trial CTA when trialUnlocks is
//     false, and also when the viewer is already on a paid tier or on the
//     trial itself (a free-trial pitch is a downgrade to them).
//   - Gates the trial DOES unlock (mode:chat for an Open user) keep the CTA.
//
// Run: node tests/paywall-trial-cta.smoke.mjs
// Network-free.

import { paywallFor } from '../src/license/tier-gates.js';
import { renderUpgradePaywall } from '../src/freemium.js';

let failures = 0;
function check(label, ok) {
  if (ok) {
    console.log(`  OK  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

// Capture everything renderUpgradePaywall prints.
function captureRender(paywall, promo = '') {
  const realLog = console.log;
  let out = '';
  console.log = (...args) => { out += args.join(' ') + '\n'; };
  try {
    renderUpgradePaywall(paywall, promo);
  } finally {
    console.log = realLog;
  }
  // Strip ANSI color codes so text assertions see plain copy.
  // eslint-disable-next-line no-control-regex
  return out.replace(/\[[0-9;]*m/g, '');
}

// ── 1. Payload carries trialUnlocks from the policy table ────────────────────

const watchPaywall = paywallFor('mode:watch', 'open');
check('mode:watch payload is kind:upgrade', watchPaywall.kind === 'upgrade');
check('mode:watch payload has trialUnlocks:false', watchPaywall.trialUnlocks === false);

const chatPaywall = paywallFor('mode:chat', 'open');
check('mode:chat payload has trialUnlocks:true', chatPaywall.trialUnlocks === true);

const profilesPaywall = paywallFor('feature:profiles', 'open');
check('feature:profiles payload has trialUnlocks:true', profilesPaywall.trialUnlocks === true);

// ── 2. Watch paywall renders NO trial CTA ────────────────────────────────────

const watchOut = captureRender(watchPaywall);
check('Watch paywall names Ghost Watcher™', watchOut.includes('Ghost Watcher'));
check('Watch paywall names Ghost Team', watchOut.includes('Ghost Team'));
check('Watch paywall contains no trial pitch', !/trial/i.test(watchOut));
check('Watch paywall upgrade link does not dangle on "Or"', !watchOut.includes('Or upgrade at:'));
check('Watch paywall still shows the upgrade link', watchOut.includes('ghostarchitect.dev/pricing'));

// ── 3. Trial-eligible gate for an Open user keeps the CTA ───────────────────

const chatOut = captureRender(chatPaywall);
check('Chat paywall (open) keeps the trial CTA', /trial/i.test(chatOut));
check('Chat paywall (open) keeps "Or upgrade at:"', chatOut.includes('Or upgrade at:'));

// ── 4. Paid tiers never see the free-trial pitch ─────────────────────────────

const briefForPro = paywallFor('mode:ghost-brief', 'pro');
const proOut = captureRender(briefForPro);
check('Ghost Brief™ paywall for a Pro user has no trial pitch', !/trial/i.test(proOut));

const watchForTrial = paywallFor('mode:watch', 'trial');
const trialOut = captureRender(watchForTrial);
check('Watch paywall for a trial user has no trial pitch', !/trial/i.test(trialOut));

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nPASSED — trial CTA only renders where the trial actually unlocks the gate.');
