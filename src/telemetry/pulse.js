// src/telemetry/pulse.js
//
// Lightweight mode-usage telemetry for Ghost Architect Pro and Team.
//
// The Open tier has a full first-run module that handles email capture,
// 24h-throttled heartbeats, and per-mode pings. Pro and Team users already
// converted (provided email at purchase), so they don't need the full
// machinery — but they still represent meaningful product signal. This
// module exists so the Pulse dashboard can show mode usage across ALL
// tiers, not just the Open funnel.
//
// What this does:
//   1. Generates a persistent anonymous userId (stored in configstore
//      under telemetry.userId so it survives across runs).
//   2. Fires a `mode-<name>` ping to the same signup.ghostarchitect.dev
//      Worker that Open pings, with the same envelope shape so the
//      Pulse dashboard groups Open + Pro + Team in the same histogram.
//
// What this does NOT do:
//   - No email capture (Pro/Team already provided email at purchase)
//   - No 24h heartbeat throttle (single mode-ping per scan, not per-day)
//   - No content, no codebase metadata, no findings
//
// Privacy: only the anonymous userId, version, tier, mode name, and
// timestamp are transmitted. Same envelope as Open's heartbeat. The
// userId is generated client-side (UUID v4) and stored only locally.
//
// Failure modes:
//   • GHOST_NO_PING=1 set     → silent no-op
//   • Network error           → silent no-op (single attempt, no retry —
//                                Pro/Team users running modes are not the
//                                "first impression" surface, so we keep
//                                the code simple)
//   • Worker down             → silent no-op
//
// Never throws. Never blocks. Fire-and-forget by design.

import https from 'https';
import crypto from 'crypto';
import Configstore from 'configstore';

const SIGNUP_ENDPOINT = 'https://signup.ghostarchitect.dev/signup';
const POST_TIMEOUT_MS = 5000;

const config = new Configstore('ghost-architect');

function pingDisabled() {
  return process.env.GHOST_NO_PING === '1';
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

/**
 * Fire a single anonymous mode-usage ping.
 *
 * @param {string} version  the CLI version (e.g. '6.0.0-pro')
 * @param {string} tier     'pro' or 'team' (used in the X-Ghost-Client header)
 * @param {string} mode     'question' | 'poi' | 'blast' | 'conflict' | 'recon' | 'audit' | 'chat' | 'compare' | 'dashboard'
 * @returns {Promise<void>} resolves after the POST completes or fails (never throws)
 */
export function pingModeUsage(version, tier, mode) {
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
          'X-Ghost-Client':  `ghost-architect-${tier}`,
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
