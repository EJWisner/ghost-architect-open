#!/usr/bin/env node
// scripts/license-gen.mjs
//
// Manual license generator. Run on EJ's iMac.
//
// Reads the private signing key from ~/.ghost-signing/private.pem, takes
// customer details from CLI args, mints a human-typeable key + signed token,
// writes a manifest entry, and prints a copy-pasteable email blob.
//
// Usage:
//   node scripts/license-gen.mjs \
//     --customer "maier@bemeir.com" \
//     --tier pro \
//     --days 30 \
//     [--fingerprint hash1,hash2,hash3,hash4]
//
// If --fingerprint is omitted, the token is issued unbound — useful for v1
// where activation is manual. The customer can still install the token, but
// any machine running it passes the fingerprint check (which is null-skipped
// in the validator). Once we have the Cloudflare Worker activation endpoint
// shipped, --fingerprint will be supplied at activation time and bound there.

import fs from 'fs';
import path from 'path';
import os from 'os';

import { generateKey, parseKey } from '../src/license/format.js';
import { encodeToken } from '../src/license/token.js';

const PRIVATE_KEY_PATH = path.join(os.homedir(), '.ghost-signing', 'private.pem');
const MANIFEST_PATH = path.join(os.homedir(), '.ghost-signing', 'license-manifest.json');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const customer = arg('--customer');
const tierArg = (arg('--tier') || 'pro').toLowerCase();
const daysArg = parseInt(arg('--days', '30'), 10);
const fingerprintArg = arg('--fingerprint');

if (!customer) {
  console.error('Usage: node scripts/license-gen.mjs --customer EMAIL --tier pro|team|enterprise --days 30 [--fingerprint h1,h2,h3,h4]');
  process.exit(2);
}
if (!['pro', 'team', 'enterprise'].includes(tierArg)) {
  console.error(`Invalid --tier: ${tierArg} (must be pro/team/enterprise)`);
  process.exit(2);
}
if (!Number.isInteger(daysArg) || daysArg <= 0) {
  console.error(`Invalid --days: ${daysArg}`);
  process.exit(2);
}

const tierToKeyCode = { pro: 'PRO', team: 'TEM', enterprise: 'ENT' };
const keyCode = tierToKeyCode[tierArg];

if (!fs.existsSync(PRIVATE_KEY_PATH)) {
  console.error(`Private key not found at ${PRIVATE_KEY_PATH}.`);
  console.error('Run `node scripts/generate-keypair.mjs` first.');
  process.exit(1);
}
const privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');

// (1) Human-typeable key
const humanKey = generateKey(keyCode);
const parsed = parseKey(humanKey);

// (2) Build payload timeline
const now = new Date();
const expires = new Date(now.getTime() + daysArg * 86400 * 1000);
const grace   = new Date(expires.getTime() + 5 * 86400 * 1000);
const hard    = new Date(grace.getTime()   + 1 * 86400 * 1000);

function isoZ(d) { return d.toISOString().replace(/\.\d+Z$/, 'Z'); }

const fingerprint = fingerprintArg
  ? fingerprintArg.split(',').map(s => s.trim())
  : null;
if (fingerprint && fingerprint.length !== 4) {
  console.error(`--fingerprint must be exactly 4 comma-separated hashes (got ${fingerprint.length})`);
  process.exit(2);
}

const payload = {
  lid: parsed.licenseId,
  tier: tierArg,
  customer,
  issued: isoZ(now),
  expires: isoZ(expires),
  grace_until: isoZ(grace),
  hard_stop: isoZ(hard),
  fingerprint,
};

// (3) Sign
const signedToken = encodeToken(payload, privateKeyPem);

// (4) Update manifest
let manifest = {};
if (fs.existsSync(MANIFEST_PATH)) {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}
manifest[parsed.licenseId] = {
  humanKey,
  customer,
  tier: tierArg,
  issued: payload.issued,
  expires: payload.expires,
  fingerprint,
  signedToken,
};
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

// (5) Output
console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  LICENSE GENERATED');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');
console.log(`  Customer:      ${customer}`);
console.log(`  Tier:          ${tierArg}`);
console.log(`  Human key:     ${humanKey}`);
console.log(`  Issued:        ${payload.issued}`);
console.log(`  Expires:       ${payload.expires}`);
console.log(`  Grace through: ${payload.grace_until}`);
console.log(`  Hard stop:     ${payload.hard_stop}`);
console.log(`  Fingerprint:   ${fingerprint ? 'bound' : 'unbound (manual activation)'}`);
console.log('');
console.log('  Signed token (paste into customer config or email):');
console.log('  ─────────────────────────────────────────────────────────────');
console.log(`  ${signedToken}`);
console.log('  ─────────────────────────────────────────────────────────────');
console.log('');
console.log(`  Manifest updated: ${MANIFEST_PATH}`);
console.log('');
