// tests/license/mock-activation-server.mjs
//
// Tiny local mock of the Cloudflare Worker's POST /activate endpoint.
// Used by test-activate-via-worker.mjs to exercise the bin/ghost.js human-key
// activation path without deploying the real Worker.
//
// Mints a real Ed25519-signed token using the actual private key at
// ~/.ghost-signing/private.pem — same logic the Worker would use in
// production. CLI then verifies the token locally using the embedded
// public key, which closes the loop on the whole human-key → server →
// signed-token → local-verify pipeline.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeToken } from '../../src/license/token.js';
import { parseKey } from '../../src/license/format.js';

const PRIVATE_KEY_PATH = path.join(os.homedir(), '.ghost-signing', 'private.pem');

function isoNoMicro(d) {
  return new Date(d).toISOString().replace(/\.\d+Z$/, 'Z');
}

export function startMockServer({ port = 0, scenario = 'success' } = {}) {
  const privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');

  const server = http.createServer(async (req, res) => {
    if (req.url !== '/activate' || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_json' }));
        return;
      }

      // Test scenarios — switch behavior so we can exercise each error path.
      if (scenario === 'not_found') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'license_not_found' }));
        return;
      }
      if (scenario === 'revoked') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'license_revoked' }));
        return;
      }
      if (scenario === 'bound_elsewhere') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'license_bound_to_different_machine',
          detail: '0 of 4 hardware components match.',
          activatedAt: '2026-05-01T12:00:00Z',
        }));
        return;
      }
      if (scenario === 'rate_limit') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate_limit_exceeded' }));
        return;
      }

      // Default success path: parse the human key, mint a real signed token
      // bound to the incoming fingerprintHashes.
      let parsed;
      try { parsed = parseKey(payload.humanKey); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_key_format', detail: e.message }));
        return;
      }
      const now = new Date();
      const expires = new Date(now.getTime() + 30 * 86400 * 1000);
      const grace = new Date(expires.getTime() + 5 * 86400 * 1000);
      const hard = new Date(grace.getTime() + 1 * 86400 * 1000);
      const tokenPayload = {
        lid: parsed.licenseId,
        tier: parsed.tier,
        customer: 'mock-test@example.com',
        issued: isoNoMicro(now),
        expires: isoNoMicro(expires),
        grace_until: isoNoMicro(grace),
        hard_stop: isoNoMicro(hard),
        fingerprint: payload.fingerprintHashes,
      };
      const signedToken = encodeToken(tokenPayload, privateKeyPem);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        signedToken,
        tier: parsed.tier,
        customer: 'mock-test@example.com',
        expires: tokenPayload.expires,
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}/activate`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
