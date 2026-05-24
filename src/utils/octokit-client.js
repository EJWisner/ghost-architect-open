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

export function createOctokit({ auth, ...extraConfig } = {}) {
  return new Octokit({
    auth,
    ...extraConfig,
    request: {
      log: {
        debug: () => {},
        info:  () => {},
        warn:  () => {},
        error: (message) => console.error(message),
      },
      ...(extraConfig.request || {}),
    },
  });
}
