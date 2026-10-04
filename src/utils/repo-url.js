/**
 * Ghost Architect™: GitHub repository URL parsing.
 *
 * parseRepo() turns a GitHub remote URL into { owner, repo }. It is used by
 * the batch transport (src/lib/batch-submit.js) to name pending batches from
 * the scanned repository's git origin.
 */

/**
 * Extract { owner, repo } from a GitHub repository URL.
 *
 * Domain-agnostic on purpose: the owner/repo pair is read from the URL path,
 * so GitHub Enterprise Server hosts parse the same way as github.com. The
 * earlier implementation hard-stripped the "https://github.com/" prefix, which
 * left Enterprise URLs (https://github.company.com/owner/repo) with the domain
 * still embedded in the owner segment and 404'd on every Octokit call.
 *
 * The owner/repo pair is read as the LAST two non-empty path segments, so an
 * Enterprise Server instance hosted at a subpath parses the same as one hosted
 * at the domain root.
 *
 * Supported formats:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.company.com/owner/repo          (Enterprise Server)
 *   https://github.company.com/owner/repo.git
 *   https://company.com/github/owner/repo          (Enterprise Server on subpath)
 *   git@github.com:owner/repo.git                  (SSH)
 *   git@github.company.com:owner/repo              (Enterprise SSH)
 *   git@company.com:github/owner/repo              (Enterprise SSH on subpath)
 *
 * A trailing ".git" and trailing slashes are tolerated. Throws if the URL does
 * not contain a valid <owner>/<repo> path.
 */
export function parseRepo(repoUrl) {
  const url = String(repoUrl).trim().replace(/\.git$/, '').replace(/\/+$/, '');

  // Primary: protocol/host (HTTP) or git@<host>: (SSH), an optional subpath,
  // then the trailing owner/repo. (?:.+\/)? absorbs any segments before the
  // final two so subpath-hosted Enterprise instances parse cleanly.
  const match =
    url.match(/^https?:\/\/[^/]+\/(?:.+\/)?([^/]+)\/([^/]+)$/) ||
    url.match(/^git@[^:]+:(?:.+\/)?([^/]+)\/([^/]+)$/);

  if (match) {
    return { owner: match[1], repo: match[2] };
  }

  // Fallback: strip the protocol/host prefix and take the last two non-empty
  // path segments directly. Catches host shapes the primary regex didn't model.
  const hostStripped = url
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^git@[^:]+:/, '');
  if (hostStripped !== url) {
    const segments = hostStripped.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return { owner: segments[segments.length - 2], repo: segments[segments.length - 1] };
    }
  }

  throw new Error(
    `Unsupported GitHub repository URL: "${repoUrl}". Expected a GitHub URL of ` +
    `the form https://<host>/<owner>/<repo> (github.com or GitHub Enterprise ` +
    `Server, including subpath-hosted instances) or git@<host>:<owner>/<repo>.`
  );
}
