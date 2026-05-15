// src/license/clock.js
//
// Clock validation with monotonic ratchet against clock rollback.
//
// At every gated CLI run:
//   1. Read last_seen_utc from store (if any). This is the highest UTC we
//      have ever observed during a successful validation.
//   2. Get the current local UTC.
//   3. If local UTC is more than 60 seconds BEHIND last_seen_utc, fail with
//      a clock-tampered state. This is the rollback defense.
//   4. Best-effort fetch network UTC from worldtimeapi.org, with timeapi.io
//      as a fallback. 5-second timeout each. If network succeeds and the
//      cached network time is older than 1 hour, refresh.
//   5. If the network time differs from local clock by more than 5 minutes,
//      treat as clock-tampered. Reject.
//   6. If network fetch fails entirely, do NOT block — trust local clock,
//      but emit a soft warning. We don't want a Pro customer on a plane
//      with no wifi to be locked out.
//   7. Compute new_last_seen = max(local, network or 0, last_seen_utc).
//      Caller is responsible for persisting this back to the store.
//
// Returns one of:
//   { ok: true, nowMs, lastSeenMs, networkOk, newLastSeenMs, note }
//   { ok: false, reason }
//
// nowMs is what other validators should compare against — i.e. the
// best estimate of "now" given available time sources.

import https from 'https';

const ROLLBACK_TOLERANCE_MS = 60 * 1000;          // 60 seconds
const NETWORK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;  // 5 minutes
const NETWORK_FETCH_TIMEOUT_MS = 5000;
const NETWORK_CACHE_TTL_MS = 60 * 60 * 1000;      // 1 hour

// In-memory cache so we don't hammer worldtimeapi within a single process.
// Persists across multiple validator calls in one CLI run.
let networkCache = null;  // { fetchedAtMs, networkMs }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: NETWORK_FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Network time response was not JSON'));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Network time fetch timed out'));
    });
    req.on('error', (e) => reject(e));
  });
}

async function fetchNetworkTimeMs() {
  // Try worldtimeapi.org first.
  try {
    const body = await fetchJson('https://worldtimeapi.org/api/timezone/Etc/UTC');
    if (body && body.utc_datetime) {
      const ms = Date.parse(body.utc_datetime);
      if (Number.isFinite(ms)) return { ms, source: 'worldtimeapi.org' };
    }
  } catch (e) { /* fall through to backup */ }

  // Fallback: timeapi.io
  try {
    const body = await fetchJson('https://timeapi.io/api/Time/current/zone?timeZone=UTC');
    if (body && body.dateTime) {
      // timeapi.io returns local-style format without Z. Append Z for UTC.
      const iso = body.dateTime.endsWith('Z') ? body.dateTime : body.dateTime + 'Z';
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) return { ms, source: 'timeapi.io' };
    }
  } catch (e) { /* fall through */ }

  return null;
}

// Main entry. lastSeenIso is the previously stored last_seen_utc (or null).
// Returns the structured result described at the top of the file.
export async function validateClock(lastSeenIso) {
  const nowLocalMs = Date.now();
  const lastSeenMs = lastSeenIso ? Date.parse(lastSeenIso) : 0;

  // (1) Rollback check: local clock must not be behind last_seen by more
  //     than the small skew tolerance.
  if (lastSeenMs && nowLocalMs < lastSeenMs - ROLLBACK_TOLERANCE_MS) {
    return {
      ok: false,
      reason: 'clock_rollback',
      nowMs: nowLocalMs,
      lastSeenMs,
      detail: `Local time is ${Math.round((lastSeenMs - nowLocalMs) / 1000)}s behind last observed time.`,
    };
  }

  // (2) Network time: refresh if cache stale.
  let networkOk = false;
  let networkMs = null;
  let networkSource = null;
  let networkNote = null;

  const cacheFresh = networkCache && (nowLocalMs - networkCache.fetchedAtMs) < NETWORK_CACHE_TTL_MS;
  if (cacheFresh) {
    networkOk = true;
    networkMs = networkCache.networkMs + (nowLocalMs - networkCache.fetchedAtMs);
    networkSource = networkCache.source + ' (cached)';
  } else {
    const result = await fetchNetworkTimeMs();
    if (result) {
      networkOk = true;
      networkMs = result.ms;
      networkSource = result.source;
      networkCache = {
        fetchedAtMs: nowLocalMs,
        networkMs: result.ms,
        source: result.source,
      };
    } else {
      networkNote = 'network time check skipped (no reachable time server)';
    }
  }

  // (3) If we have network time, check skew vs local.
  if (networkOk && networkMs !== null) {
    const skewMs = Math.abs(networkMs - nowLocalMs);
    if (skewMs > NETWORK_SKEW_TOLERANCE_MS) {
      return {
        ok: false,
        reason: 'clock_skew',
        nowMs: nowLocalMs,
        networkMs,
        networkSource,
        lastSeenMs,
        detail: `Local clock differs from network time by ${Math.round(skewMs / 1000)}s.`,
      };
    }
  }

  // (4) New last_seen is the max of (local, network if available, prior).
  const newLastSeenMs = Math.max(nowLocalMs, networkMs || 0, lastSeenMs);

  return {
    ok: true,
    nowMs: nowLocalMs,
    lastSeenMs,
    networkOk,
    networkMs,
    networkSource,
    newLastSeenMs,
    note: networkNote,
  };
}

// Resets the in-process network cache. Test-only.
export function _resetNetworkCache() {
  networkCache = null;
}
