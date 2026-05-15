#!/usr/bin/env node
// scripts/generate-keypair.mjs
//
// ONE-TIME KEYPAIR GENERATOR for Ghost Architect license signing.
//
// Runs once on EJ's iMac. Generates an Ed25519 keypair, writes the PRIVATE
// key to ~/.ghost-signing/private.pem (NEVER committed anywhere), and prints
// the PUBLIC key as a hex string for embedding into src/license/keys.js.
//
// If a private key already exists at the target path, this script REFUSES to
// overwrite it. Rotating the signing key would invalidate every active
// license. To rotate, manually move the old key aside first.
//
// Usage:
//   node scripts/generate-keypair.mjs
//
// Output:
//   - Writes /Users/<user>/.ghost-signing/private.pem (0600 perms)
//   - Writes /Users/<user>/.ghost-signing/public.pem  (0644 perms)
//   - Prints public key hex to stdout for pasting into src/license/keys.js

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SIGNING_DIR = path.join(os.homedir(), '.ghost-signing');
const PRIVATE_PATH = path.join(SIGNING_DIR, 'private.pem');
const PUBLIC_PATH = path.join(SIGNING_DIR, 'public.pem');

function abort(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(SIGNING_DIR)) {
  fs.mkdirSync(SIGNING_DIR, { mode: 0o700, recursive: true });
  console.log(`✓ Created ${SIGNING_DIR}`);
}

if (fs.existsSync(PRIVATE_PATH)) {
  abort(
    `Private key already exists at ${PRIVATE_PATH}.\n  ` +
    `Refusing to overwrite. To rotate the signing key, move the old\n  ` +
    `private.pem aside first (and understand this invalidates every\n  ` +
    `active license in the wild).`
  );
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem  = publicKey.export({ type: 'spki', format: 'pem' });

fs.writeFileSync(PRIVATE_PATH, privatePem, { mode: 0o600 });
fs.writeFileSync(PUBLIC_PATH, publicPem, { mode: 0o644 });

// Raw 32-byte public key for embedding in source as a hex constant.
const rawPublic = publicKey.export({ type: 'spki', format: 'der' });
// DER SPKI for Ed25519 is a 44-byte structure where the last 32 bytes are
// the raw public key.
const raw32 = rawPublic.subarray(rawPublic.length - 32);
const publicHex = raw32.toString('hex');

console.log('');
console.log('✓ Ed25519 keypair generated');
console.log(`✓ Private key written to ${PRIVATE_PATH} (0600)`);
console.log(`✓ Public key  written to ${PUBLIC_PATH} (0644)`);
console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  PUBLIC KEY (hex) — paste this into src/license/keys.js:');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');
console.log(`  ${publicHex}`);
console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');
console.log('  Reminder: BACK UP THE PRIVATE KEY to an encrypted USB drive.');
console.log('  Losing it makes every active license unverifiable.');
console.log('');
