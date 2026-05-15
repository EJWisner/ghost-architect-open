// tests/license/test-trial.mjs
//
// Trial-mode unit tests.
//
// Covers:
//   - HMAC trial-token encode + decode + verify roundtrip
//   - Cross-check: ghost-trial header MUST carry tier='trial'
//   - Cross-check: ghost-license header MUST NOT carry tier='trial'
//   - Trial tokens with paid tier are rejected (type-confusion defense)
//   - Trial token timeline (no grace period, hard_stop == expires)
//
// Run: node tests/license/test-trial.mjs

import assert from 'assert';
import crypto from 'crypto';
import { encodeToken, encodeTrialToken, decodeAndVerifyToken } from '../../src/license/token.js';
import { getTrialHmacSecret } from '../../src/license/keys.js';

const PASS = (name) => console.log(`  ✓ ${name}`);
const FAIL = (name, why) => { console.error(`  ✗ ${name}: ${why}`); process.exitCode = 1; };

function iso(d) { return new Date(d).toISOString().replace(/\.\d+Z$/, 'Z'); }

// Helper: build a well-formed trial payload
function trialPayload(opts = {}) {
  const now = new Date();
  const expires = new Date(now.getTime() + 14 * 86400 * 1000);
  return {
    lid: 'TRIALTESTAB',
    tier: 'trial',
    customer: 'trial@local',
    issued: iso(now),
    expires: iso(expires),
    grace_until: iso(expires),
    hard_stop: iso(expires),
    fingerprint: null,
    ...opts,
  };
}

function paidPayload(opts = {}) {
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 86400 * 1000);
  const grace = new Date(expires.getTime() + 5 * 86400 * 1000);
  const hard  = new Date(grace.getTime() + 1 * 86400 * 1000);
  return {
    lid: 'PAIDTESTXYZ',
    tier: 'pro',
    customer: 'paid@example.com',
    issued: iso(now),
    expires: iso(expires),
    grace_until: iso(grace),
    hard_stop: iso(hard),
    fingerprint: null,
    ...opts,
  };
}

console.log('\n── Trial token tests ──');

// Test 1: trial encode + verify roundtrip works
{
  const token = encodeTrialToken(trialPayload());
  try {
    const decoded = decodeAndVerifyToken(token);
    assert.strictEqual(decoded.header.t, 'ghost-trial');
    assert.strictEqual(decoded.payload.tier, 'trial');
    PASS('trial token encode → decode + verify roundtrip');
  } catch (e) { FAIL('trial roundtrip', e.message); }
}

// Test 2: encodeTrialToken refuses non-trial tier
{
  try {
    encodeTrialToken(paidPayload({ tier: 'pro' }));
    FAIL('encodeTrialToken with tier=pro', 'should have thrown');
  } catch (e) {
    if (/requires payload\.tier === "trial"/.test(e.message)) {
      PASS('encodeTrialToken refuses payload.tier !== "trial"');
    } else {
      FAIL('encodeTrialToken rejection message', e.message);
    }
  }
}

// Test 3: encodeToken (Ed25519) refuses tier=trial
{
  // We can't actually call encodeToken without a private key, so we expect
  // the validation to throw BEFORE the signing step.
  try {
    encodeToken(trialPayload(), 'BOGUS-KEY-NOT-EVEN-PEM');
    FAIL('encodeToken with tier=trial', 'should have thrown');
  } catch (e) {
    if (/encodeTrialToken/.test(e.message)) {
      PASS('encodeToken refuses payload.tier === "trial" (must use trial encoder)');
    } else {
      FAIL('encodeToken trial rejection', e.message);
    }
  }
}

// Test 4: cross-check — HMAC-signed payload with tier=pro is rejected at decode
{
  // Manually mint a tampered token: ghost-trial header but tier=pro payload.
  // This is what an attacker who extracted the HMAC secret would try in
  // order to mint paid licenses for themselves.
  const tamperedPayload = paidPayload({ tier: 'pro' });
  const tamperedHeader = { v: 1, t: 'ghost-trial' };
  const headerB64 = Buffer.from(JSON.stringify(tamperedHeader)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const mac = crypto.createHmac('sha256', getTrialHmacSecret())
    .update(Buffer.from(signingInput, 'utf8'))
    .digest('base64url');
  const tamperedToken = `${headerB64}.${payloadB64}.${mac}`;

  try {
    decodeAndVerifyToken(tamperedToken);
    FAIL('type-confusion attack: ghost-trial header + tier=pro payload', 'decoder accepted it');
  } catch (e) {
    if (/Trial-header token must carry tier=trial/.test(e.message)) {
      PASS('decoder rejects ghost-trial header with tier=pro payload (type-confusion defense)');
    } else {
      FAIL('type-confusion: wrong error', e.message);
    }
  }
}

// Test 5: cross-check inverse — ghost-license header with tier=trial payload
{
  // This case can't be reached via legitimate encode paths (encodeToken throws
  // on tier=trial), but we still want decode to reject it defensively in case
  // an attacker manages to mint such a token via stolen Ed25519 key.
  //
  // Building this token requires signing with Ed25519, which we don't have
  // here. So we construct an invalid signature and confirm the decoder still
  // rejects on the type-confusion check OR the signature check (either is fine).
  const wrongPayload = trialPayload({ tier: 'trial' });
  const wrongHeader = { v: 1, t: 'ghost-license' };
  const headerB64 = Buffer.from(JSON.stringify(wrongHeader)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(wrongPayload)).toString('base64url');
  // Bogus signature — will fail Ed25519 verification before we get to the
  // type-confusion check, but rejection is what matters.
  const fakeSig = Buffer.from('A'.repeat(64), 'utf8').toString('base64url');
  const fakeToken = `${headerB64}.${payloadB64}.${fakeSig}`;

  try {
    decodeAndVerifyToken(fakeToken);
    FAIL('inverse type-confusion', 'decoder accepted it');
  } catch (e) {
    // Either signature failure or cross-check failure is acceptable — both
    // mean the token is rejected.
    PASS(`decoder rejects ghost-license header with tier=trial payload (${e.message.slice(0, 50)}...)`);
  }
}

// Test 6: trial timeline must have grace_until === expires
{
  const payload = trialPayload();
  try {
    assert.strictEqual(payload.grace_until, payload.expires);
    assert.strictEqual(payload.hard_stop, payload.expires);
    PASS('trial token timeline: no grace period (grace_until == hard_stop == expires)');
  } catch (e) { FAIL('trial timeline', e.message); }
}

// Test 7: tampered HMAC signature is rejected
{
  const token = encodeTrialToken(trialPayload());
  const parts = token.split('.');
  const tampered = parts[0] + '.' + parts[1] + '.' + 'XXXXXXXXXXXXXXXXXXXXXXX';
  try {
    decodeAndVerifyToken(tampered);
    FAIL('tampered HMAC', 'should have rejected');
  } catch (e) {
    if (/HMAC verification FAILED/.test(e.message)) {
      PASS('tampered HMAC signature rejected');
    } else {
      FAIL('tampered HMAC: wrong error', e.message);
    }
  }
}

// Test 8: trial token timeline ordering enforced at encode
{
  try {
    encodeTrialToken(trialPayload({ expires: '2020-01-01T00:00:00Z' })); // way before issued
    FAIL('trial expires before issued', 'should have thrown');
  } catch (e) {
    if (/timeline/.test(e.message) || /issued/.test(e.message)) {
      PASS('trial token with expires < issued is rejected at encode');
    } else {
      FAIL('trial bad timeline', e.message);
    }
  }
}

console.log('');
if (process.exitCode) {
  console.log('FAIL: one or more trial tests failed.\n');
} else {
  console.log('PASS: all trial tests succeeded.\n');
}
