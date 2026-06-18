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
import { getConfig } from '../config.js';

const ROLLBACK_TOLERANCE_MS = 60 * 1000;          // 60 seconds
const NETWORK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;  // 5 minutes
const NETWORK_FETCH_TIMEOUT_MS = 5000;
const NETWORK_CACHE_TTL_MS = 60 * 60 * 1000;      // 1 hour

// Fail-open grace window. The network fetch failing means we trust the local
// clock (item 6) so an offline Pro customer is not locked out. But trusting
// the local clock UNCONDITIONALLY and FOREVER is exactly the attack: block the
// network, then roll the clock back undetected. So we count consecutive
// offline validations and, once they exceed this limit, stop failing open and
// require a successful network check before any further gated run. The limit
// is generous on purpose so legitimate offline stretches (a long flight, a
// few days air-gapped) still work; it only bites sustained, deliberate
// network denial. A single successful network check resets the counter.
const MAX_CONSECUTIVE_OFFLINE = 10;

// Persisted (cross-process) clock state, separate from the `license` record
// owned by store.js. Shape: { offlineStreak, lastNetworkOkMs }.
const CLOCK_STATE_KEY = 'clock';

// In-memory cache so we don't hammer worldtimeapi within a single process.
// Persists across multiple validator calls in one CLI run.
let networkCache = null;  // { fetchedAtMs, networkMs }

// Telemetry sink for the fail-open path. Default is best-effort and never
// throws: it writes a structured diagnostic line to stderr under GHOST_DEBUG
// so there is a local audit trail of every fail-open event. Tests (and any
// future remote pipeline) override it via _setClockTelemetrySink to capture
// the event object directly.
let clockTelemetrySink = null;

// Indirection so the network fetch can be stubbed deterministically in tests
// (simulating an offline machine) without real network access.
let networkTimeFetcher = fetchNetworkTimeMs;

function readClockState() {
  try {
    const s = getConfig().get(CLOCK_STATE_KEY);
    return (s && typeof s === 'object') ? s : {};
  } catch (_) {
    // Config unavailable (e.g. read-only/missing store): degrade to a fresh
    // counter rather than blocking. Persistence is best-effort bookkeeping.
    return {};
  }
}

function writeClockState(state) {
  try {
    getConfig().set(CLOCK_STATE_KEY, state);
  } catch (_) {
    // Persistence failure must never block validation or be mistaken for
    // tampering. Worst case the offline counter does not advance this run.
  }
}

function emitClockTelemetry(event) {
  try {
    if (clockTelemetrySink) {
      clockTelemetrySink(event);
      return;
    }
    if (process.env.GHOST_DEBUG === '1') {
      process.stderr.write('ghost: clock-telemetry ' + JSON.stringify(event) + '\n');
    }
  } catch (_) {
    // Telemetry must never affect the validation result.
  }
}

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
    const result = await networkTimeFetcher();
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

  // (4) Offline grace counter + fail-open telemetry.
  //
  // networkOk true  → a live or freshly-cached network check succeeded. Reset
  //                   the consecutive-offline counter and record the last
  //                   known-good network time.
  // networkOk false → we are about to FAIL OPEN (trust the local clock). Emit
  //                   telemetry so a sustained offline window is visible, warn
  //                   the user, and advance the counter. Once it exceeds the
  //                   grace window we stop failing open and demand a real
  //                   network check, which is the rollback defense for an
  //                   attacker who can deny network access indefinitely.
  const clockState = readClockState();
  let consecutiveOffline = 0;

  if (networkOk) {
    const lastNetworkOkMs = (networkMs !== null && networkMs !== undefined) ? networkMs : nowLocalMs;
    if ((clockState.offlineStreak || 0) !== 0 || clockState.lastNetworkOkMs !== lastNetworkOkMs) {
      writeClockState({ offlineStreak: 0, lastNetworkOkMs });
    }
  } else {
    consecutiveOffline = (clockState.offlineStreak || 0) + 1;
    const lastNetworkOkMs = (typeof clockState.lastNetworkOkMs === 'number')
      ? clockState.lastNetworkOkMs
      : (networkCache ? networkCache.networkMs : null);

    emitClockTelemetry({
      event: 'clock_fail_open',
      failureMs: nowLocalMs,
      failureIso: new Date(nowLocalMs).toISOString(),
      lastNetworkOkMs,
      lastNetworkOkIso: lastNetworkOkMs !== null ? new Date(lastNetworkOkMs).toISOString() : null,
      trustedLocalMs: nowLocalMs,
      consecutiveOffline,
    });

    writeClockState({ offlineStreak: consecutiveOffline, lastNetworkOkMs });

    if (consecutiveOffline > MAX_CONSECUTIVE_OFFLINE) {
      return {
        ok: false,
        reason: 'clock_offline_grace_exceeded',
        nowMs: nowLocalMs,
        lastSeenMs,
        networkOk: false,
        consecutiveOffline,
        detail: `Offline for ${consecutiveOffline} consecutive runs (limit ${MAX_CONSECUTIVE_OFFLINE}); a successful network time check is now required. Connect to the internet and retry.`,
      };
    }

    // Soft warning so the user knows expiration is riding on the local clock.
    process.stderr.write(
      'ghost: Network time check skipped (offline mode). License expiration is based on local clock.\n'
    );
  }

  // (5) New last_seen is the max of (local, network if available, prior).
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
    consecutiveOffline,
  };
}

// Resets the in-process network cache. Test-only.
export function _resetNetworkCache() {
  networkCache = null;
}

// Overrides the fail-open telemetry sink. Pass a function to capture events,
// or null to restore the default (GHOST_DEBUG stderr line). Test-only.
export function _setClockTelemetrySink(fn) {
  clockTelemetrySink = (typeof fn === 'function') ? fn : null;
}

// Overrides the network-time fetcher so tests can simulate an offline machine
// deterministically. Pass null to restore the real fetcher. Test-only.
export function _setNetworkTimeFetcher(fn) {
  networkTimeFetcher = (typeof fn === 'function') ? fn : fetchNetworkTimeMs;
}
