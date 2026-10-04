// src/telemetry/pulse.js
//
// Anonymous mode-usage telemetry for Ghost Open™.
//
// What this does:
//   1. Generates a persistent anonymous userId (stored in configstore
//      under telemetry.userId so it survives across runs).
//   2. Fires a `mode-<name>` ping to the signup.ghostarchitect.dev Worker so
//      the Pulse dashboard can show which modes get used.
//
// What this does NOT do:
//   - No email capture
//   - No 24h heartbeat throttle (single mode-ping per scan, not per-day)
//   - No content, no codebase metadata, no findings
//
// Privacy: only the anonymous userId, version, mode name, and timestamp are
// transmitted, plus the fixed client header `ghost-architect-open`. The
// userId is generated client-side (UUID v4) and stored only locally.
//
// Failure modes:
//   • GHOST_NO_PING set (any value) → silent no-op
//   • Network error           → silent no-op (single attempt, no retry)
//   • Worker down             → silent no-op
//
// Never throws. Never blocks. Fire-and-forget by design.

import https from 'https';
import crypto from 'crypto';
import { getConfig } from '../config.js';

const SIGNUP_ENDPOINT = 'https://signup.ghostarchitect.dev/signup';
const POST_TIMEOUT_MS = 5000;

const config = getConfig();

function pingDisabled() {
  // Opt out on ANY set, non-empty value (GHOST_NO_PING=1, true, yes, ...), not
  // only the exact string '1'. Users reasonably expect setting the var at all
  // to disable telemetry.
  return !!process.env.GHOST_NO_PING;
}

// Persistent anonymous userId. Generated once, stored in configstore,
// reused across runs so Pulse can correlate mode events with installs.
function getOrCreateUserId() {
  let tel = config.get('telemetry') || {};
  if (!tel.userId) {
    tel.userId = crypto.randomUUID();
    config.set('telemetry', tel);
  }
  return tel.userId;
}

// The only client identity Ghost Open™ ever sends.
export const CLIENT_HEADER = 'ghost-architect-open';

/**
 * Fire a single anonymous mode-usage ping.
 *
 * @param {string} version  the CLI version (e.g. '12.0.0')
 * @param {string} mode     'question' | 'poi' | 'blast' | 'conflict' | 'recon' | 'audit' | 'chat' | 'compare' | ...
 * @returns {Promise<void>} resolves after the POST completes or fails (never throws)
 */
export function pingModeUsage(version, mode) {
  return new Promise((resolve) => {
    if (pingDisabled()) { resolve(); return; }

    let body;
    try {
      body = JSON.stringify({
        userId:    getOrCreateUserId(),
        email:     null,
        version,
        source:    `mode-${mode}`,
        timestamp: new Date().toISOString(),
      });
    } catch (_) {
      resolve();
      return;
    }

    let url;
    try {
      url = new URL(SIGNUP_ENDPOINT);
    } catch (_) {
      resolve();
      return;
    }

    const req = https.request(
      {
        method:   'POST',
        hostname: url.hostname,
        path:     url.pathname,
        port:     443,
        headers: {
          'Content-Type':    'application/json',
          'Content-Length':  Buffer.byteLength(body),
          'X-Ghost-Client':  CLIENT_HEADER,
        },
        timeout: POST_TIMEOUT_MS,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end',  () => resolve());
      }
    );

    req.on('error',   () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });

    req.write(body);
    req.end();
  });
}
