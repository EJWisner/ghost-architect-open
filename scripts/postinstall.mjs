#!/usr/bin/env node
// Ghost Architect Open — postinstall ping
// Fires one anonymous POST to signup.ghostarchitect.dev/signup on npm install.
// Privacy: anonymous userId only, no email, no PII. Respects GHOST_NO_PING=1.
// Failure mode: completely silent. Never breaks an npm install.

import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SIGNUP_ENDPOINT = 'https://signup.ghostarchitect.dev/signup';
const TIMEOUT_MS = 10000;

function readVersion() {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch (_) { return 'unknown'; }
}

function isOptedOut() {
  if (process.env.GHOST_NO_PING === '1') return true;
  if (process.env.npm_config_ignore_scripts === 'true') return true;
  return false;
}

async function postOnce(payload) {
  return new Promise((resolve) => {
    let body;
    try { body = JSON.stringify(payload); } catch (_) { resolve(false); return; }
    let url;
    try { url = new URL(SIGNUP_ENDPOINT); } catch (_) { resolve(false); return; }
    const req = https.request({
      method: 'POST', hostname: url.hostname, path: url.pathname, port: 443,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Ghost-Client': 'ghost-architect-open-postinstall',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

async function main() {
  if (isOptedOut()) return;
  const version = readVersion();
  const userId = `install-${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  const payload = { userId, email: null, version, source: 'cli-install', timestamp };
  const ok = await postOnce(payload);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 2000));
    await postOnce(payload);
  }
}

main().catch(() => {});
