// src/utils/octokit-client.js
//
// Shared Octokit constructor.
//
// Silences the @octokit/request deprecation warning surfaced by callers
// using endpoints that route through the legacy request path. The warning
// is emitted by node_modules/@octokit/request/dist-src/fetch-wrapper.js:41
// via requestOptions.request.log.warn (NOT the top-level Octokit log option),
// so silencing must happen inside the nested `request.log` config.
//
// Channel separation (preserved intentionally):
//   - top-level octokit.log.warn  -> still surfaces (throttling-plugin meta-warnings)
//   - onRateLimit / onSecondaryRateLimit callbacks -> still fire (rate-limit notifications)
//   - request.log.warn -> silenced here (deprecation noise only)
//
// extraConfig.request is deep-merged after the silencer so callers can add
// their own request options (e.g. timeout) without losing the silencer.
// Callers passing their own request.log explicitly override the silencer.

import { Octokit } from 'octokit';

// Suppresses ONLY the @octokit/request endpoint-deprecation warning, emitted
// at node_modules/@octokit/request/dist-src/fetch-wrapper.js:40-42 as:
//   [@octokit/request] "<METHOD> <URL>" is deprecated. It is scheduled to be
//   removed on <sunset>...
// Every other warning (token-expiration notices, OAuth scope warnings, etc.)
// passes through to console.warn so the user still sees actionable signals.
function filterRequestWarn(message, ...args) {
  if (typeof message === 'string' && message.includes('[@octokit/request]') && message.includes('is deprecated')) {
    return;
  }
  console.warn(message, ...args);
}

export function createOctokit({ auth, ...extraConfig } = {}) {
  return new Octokit({
    auth,
    ...extraConfig,
    // Notify-only throttle callbacks -- return false so the plugin does NOT
    // auto-retry. The manual retry loop in loader/index.js stays authoritative
    // for backoff, wait times, and the user-facing continue/stop prompt.
    throttle: {
      onRateLimit: (retryAfter, options) => {
        console.warn(`GitHub rate limit hit for ${options.method} ${options.url} — waiting ${retryAfter}s (handled by caller)`);
        return false;
      },
      onSecondaryRateLimit: (retryAfter, options) => {
        console.warn(`GitHub secondary rate limit hit for ${options.method} ${options.url} — aborting request`);
        return false;
      },
    },
    request: {
      log: {
        debug: () => {},
        info:  () => {},
        warn:  filterRequestWarn,
        error: (message) => console.error(message),
      },
      ...(extraConfig.request || {}),
    },
  });
}
