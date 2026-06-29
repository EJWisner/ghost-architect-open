// src/license/token.js
//
// Signed license token — Ed25519 over base64(header).base64(payload),
// joined with '.' separators. JWT-shaped but explicitly NOT a JWT: we don't
// honor any `alg` field in the header, so algorithm-confusion attacks against
// standard JWT libraries don't apply.
//
// Header is always: { v: 1, t: "ghost-license" }
// Payload is the license claims object (see schema below).
//
// PAYLOAD SCHEMA (verified at decode time):
//   {
//     lid:           string  — license id (11 chars, matches human key)
//     tier:          'pro' | 'team' | 'enterprise' | 'trial'
//     customer:      string  — email or human-readable identifier
//     issued:        ISO-8601 UTC
//     expires:       ISO-8601 UTC
//     grace_until:   ISO-8601 UTC (expires + ~5 days)
//     hard_stop:     ISO-8601 UTC (grace_until + ~1 day = day 36 from issue)
//     fingerprint:   array of 4 sha256 hex strings (component hashes)
//                    OR null if token issued before hardware binding (rare)
//     min_cli_version: string (optional) — semver, force-upgrade gate
//   }

import crypto from 'crypto';
import { getPublicKey, getTrialHmacSecret } from './keys.js';

// Standard header for Ed25519-signed paid licenses.
const HEADER = { v: 1, t: 'ghost-license' };
const HEADER_JSON = JSON.stringify(HEADER);
const HEADER_B64 = Buffer.from(HEADER_JSON, 'utf8').toString('base64url');

// Trial-license header — distinct from paid so we route to HMAC verify path.
const TRIAL_HEADER = { v: 1, t: 'ghost-trial' };
const TRIAL_HEADER_JSON = JSON.stringify(TRIAL_HEADER);
const TRIAL_HEADER_B64 = Buffer.from(TRIAL_HEADER_JSON, 'utf8').toString('base64url');

const VALID_TIERS = new Set(['pro', 'team', 'enterprise', 'trial', 'pro-max', 'team-max', 'enterprise-max']);

function isIsoUtc(s) {
  if (typeof s !== 'string') return false;
  // Strict-ish: YYYY-MM-DDTHH:MM:SS(.sss)?Z
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s);
}

function validatePayloadShape(p) {
  if (!p || typeof p !== 'object') throw new Error('Token payload missing or not an object');
  if (typeof p.lid !== 'string' || p.lid.length === 0) throw new Error('Token payload.lid missing');
  if (!VALID_TIERS.has(p.tier)) throw new Error(`Token payload.tier invalid: ${p.tier}`);
  if (typeof p.customer !== 'string' || p.customer.length === 0) throw new Error('Token payload.customer missing');
  if (!isIsoUtc(p.issued)) throw new Error('Token payload.issued not a UTC ISO timestamp');
  if (!isIsoUtc(p.expires)) throw new Error('Token payload.expires not a UTC ISO timestamp');
  if (!isIsoUtc(p.grace_until)) throw new Error('Token payload.grace_until not a UTC ISO timestamp');
  if (!isIsoUtc(p.hard_stop)) throw new Error('Token payload.hard_stop not a UTC ISO timestamp');
  // fingerprint may be null (token issued without binding) or a 4-element array of hex.
  if (p.fingerprint !== null && p.fingerprint !== undefined) {
    if (!Array.isArray(p.fingerprint) || p.fingerprint.length !== 4) {
      throw new Error('Token payload.fingerprint must be a 4-element array or null');
    }
    for (const h of p.fingerprint) {
      if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) {
        throw new Error('Token payload.fingerprint entries must be sha256 hex strings');
      }
    }
  }
  // Time ordering: issued < expires <= grace_until <= hard_stop
  const t = (s) => Date.parse(s);
  if (!(t(p.issued) <= t(p.expires))) throw new Error('Token timeline: issued > expires');
  if (!(t(p.expires) <= t(p.grace_until))) throw new Error('Token timeline: expires > grace_until');
  if (!(t(p.grace_until) <= t(p.hard_stop))) throw new Error('Token timeline: grace_until > hard_stop');
}

// ENCODE PAID — used by the generator script. Requires the Ed25519 PRIVATE key.
// privateKeyPem is the contents of ~/.ghost-signing/private.pem
export function encodeToken(payload, privateKeyPem) {
  validatePayloadShape(payload);
  if (payload.tier === 'trial') {
    throw new Error('Use encodeTrialToken() for tier=trial — paid Ed25519 encode is for pro/team/enterprise only');
  }
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const privateKey = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem', type: 'pkcs8' });
  const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), privateKey);
  const sigB64 = signature.toString('base64url');
  return `${HEADER_B64}.${payloadB64}.${sigB64}`;
}

// ENCODE TRIAL — runs inside the CLI itself, NO private key needed. Uses
// the HMAC secret baked into keys.js. Result is a trial-typed token that
// decodeAndVerifyToken accepts as long as the HMAC verifies and the payload
// declares tier=trial. Anyone with the binary can mint trial tokens, which
// is exactly the trade-off described in keys.js — trial-tier output is
// watermarked and audit-blocked, so the bypass value is low.
export function encodeTrialToken(payload) {
  validatePayloadShape(payload);
  if (payload.tier !== 'trial') {
    throw new Error('encodeTrialToken requires payload.tier === "trial"');
  }
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const signingInput = `${TRIAL_HEADER_B64}.${payloadB64}`;
  const mac = crypto.createHmac('sha256', getTrialHmacSecret())
    .update(Buffer.from(signingInput, 'utf8'))
    .digest();
  const macB64 = mac.toString('base64url');
  return `${TRIAL_HEADER_B64}.${payloadB64}.${macB64}`;
}

// DECODE + VERIFY — used by the CLI at every gated run. No Ed25519 private
// key needed. Routes on header.t: 'ghost-license' uses Ed25519 verify against
// the embedded public key; 'ghost-trial' uses HMAC-SHA256 verify against the
// embedded trial secret. Returns { header, payload } on success. Throws on
// any failure.
export function decodeAndVerifyToken(tokenString) {
  if (typeof tokenString !== 'string') throw new Error('Token must be a string');
  const parts = tokenString.split('.');
  if (parts.length !== 3) throw new Error(`Token must have 3 parts, got ${parts.length}`);
  const [headerB64, payloadB64, sigB64] = parts;

  // Parse header FIRST (it's small, untrusted-but-bounded) so we know which
  // verification algorithm to apply. We still validate header shape strictly
  // before trusting the type field.
  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch (e) {
    throw new Error('Token header is not valid JSON');
  }
  if (header.v !== 1) throw new Error(`Token version ${header.v} not supported by this CLI`);
  if (header.t !== 'ghost-license' && header.t !== 'ghost-trial') {
    throw new Error(`Token type ${header.t} not a Ghost license`);
  }
  const isTrial = header.t === 'ghost-trial';

  // Verify signature against the correct algorithm BEFORE parsing the payload.
  const signingInput = `${headerB64}.${payloadB64}`;
  let signature;
  try {
    signature = Buffer.from(sigB64, 'base64url');
  } catch (e) {
    throw new Error('Token signature is not valid base64url');
  }

  if (isTrial) {
    // Constant-time HMAC compare.
    const expected = crypto.createHmac('sha256', getTrialHmacSecret())
      .update(Buffer.from(signingInput, 'utf8'))
      .digest();
    if (expected.length !== signature.length ||
        !crypto.timingSafeEqual(expected, signature)) {
      throw new Error('Trial token HMAC verification FAILED');
    }
  } else {
    const pubKey = getPublicKey();
    const ok = crypto.verify(null, Buffer.from(signingInput, 'utf8'), pubKey, signature);
    if (!ok) throw new Error('Token signature verification FAILED');
  }

  // Payload must parse and pass shape validation.
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (e) {
    throw new Error('Token payload is not valid JSON');
  }
  validatePayloadShape(payload);

  // Cross-check: a 'ghost-trial' header must carry tier='trial' payload,
  // and a 'ghost-license' header must NOT carry tier='trial'. This stops
  // anyone from minting a paid-tier token using the HMAC trial secret.
  if (isTrial && payload.tier !== 'trial') {
    throw new Error('Trial-header token must carry tier=trial in payload');
  }
  if (!isTrial && payload.tier === 'trial') {
    throw new Error('Trial-tier payload must use ghost-trial header, not ghost-license');
  }

  return { header, payload };
}

// Convenience: decode WITHOUT verification, for diagnostic / debug purposes.
// Never use this in the validation path.
export function decodeTokenUnsafe(tokenString) {
  const parts = tokenString.split('.');
  if (parts.length !== 3) throw new Error(`Token must have 3 parts, got ${parts.length}`);
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return { header, payload };
}
