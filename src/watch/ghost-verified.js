// src/watch/ghost-verified.js
//
// The @ghost-verified annotation system.
//
// A developer can mark code that Ghost Watcher flagged as reviewed-and-accepted
// by adding a comment whose text is the marker, optionally with a reason:
//
//   Example (bare):    @ghost-verified
//   Example (reason):  @ghost-verified: legacy adapter is intentional, reviewed 2026-06-29
//
// During a watcher run, findings whose files carry this marker are segregated
// out of the active set (so they stop nagging on every commit) but are NOT
// discarded: they are surfaced in a "Reviewed · Expected Behavior" section so
// the suppression stays auditable and reversible.
//
// Detection uses indexOf scanning (not regex), mirroring the stateful PEM/cert
// parsers in src/redactor.js. This keeps annotation-scanning ReDoS-immune and
// able to run on a file of any size without the 500KB regex size guard.

const MARKER = '@ghost-verified';

// A marker only counts as an annotation when it sits directly after a comment
// opener. This stops the marker STRING appearing in code (the MARKER constant
// above, the PR-comment template text in watcher-commit.js, etc.) from falsely
// verifying a file. indexOf/endsWith only — ReDoS-immune. Supports the common
// single-line and block comment openers across languages.
const COMMENT_PREFIXES = ['// ', '# ', '-- ', '/* '];

/**
 * Scan a single file's content for the @ghost-verified marker in comment
 * context.
 *
 * @param {string} filePath  path key to look up in fileMap
 * @param {Object} fileMap   { path -> content } map (codebaseContext.fileMap)
 * @returns {{ verified: boolean, reason: string|null }}
 *   verified:false (reason:null) if the file is absent, empty, or only contains
 *   the marker outside a comment (e.g. inside a string literal). When a
 *   comment-context marker carries an optional ": reason" suffix, reason holds
 *   the trimmed text up to end-of-line; otherwise reason is null.
 */
export function scanForVerified(filePath, fileMap) {
  if (!filePath || !fileMap || typeof fileMap !== 'object') {
    return { verified: false, reason: null };
  }
  const content = fileMap[filePath];
  if (typeof content !== 'string' || content.length === 0) {
    return { verified: false, reason: null };
  }

  // Scan EVERY occurrence: a file may carry the marker in a string literal on
  // one line and in a real comment on another. Only a comment-context hit
  // verifies; the first such hit wins (and supplies the reason).
  let searchFrom = 0;
  while (true) {
    const markerIdx = content.indexOf(MARKER, searchFrom);
    if (markerIdx === -1) break;
    searchFrom = markerIdx + MARKER.length;

    // Text from the start of the marker's line up to the marker. If, after
    // trimming leading whitespace, it ENDS WITH a comment opener, the marker is
    // in comment context — either on its own comment line or trailing after
    // code (e.g. `foo();` then a comment). A code string that merely contains
    // the marker ends with a quote, not a comment opener, so it is skipped.
    const lineStart = content.lastIndexOf('\n', markerIdx - 1) + 1;
    const before = content.slice(lineStart, markerIdx).trimStart();
    if (!COMMENT_PREFIXES.some((prefix) => before.endsWith(prefix))) {
      continue;
    }

    // Comment-context hit. Optional reason: text after a ':' immediately
    // following the marker, up to end of line.
    let reason = null;
    const afterMarker = markerIdx + MARKER.length;
    let lineEnd = content.indexOf('\n', afterMarker);
    if (lineEnd === -1) lineEnd = content.length;
    const tail = content.slice(afterMarker, lineEnd);
    const colonIdx = tail.indexOf(':');
    if (colonIdx !== -1) {
      const candidate = tail.slice(colonIdx + 1).trim();
      if (candidate.length > 0) reason = candidate;
    }

    return { verified: true, reason };
  }

  return { verified: false, reason: null };
}

/**
 * Partition merged findings into active vs verified based on the
 * @ghost-verified marker in any of each finding's files.
 *
 * A finding is "verified" if ANY path in finding.files[] resolves to a file in
 * fileMap that contains the marker. Findings with an empty files[] cannot be
 * file-annotated and always stay active. Verified findings are returned with
 * `verified: true` and `verifiedReason` (the reason from the first matching
 * file, or null).
 *
 * @param {Array} allFindings  merged findings (each with a files[] string array)
 * @param {Object} fileMap     { path -> content } map
 * @returns {{ active: Array, verified: Array }}
 */
export function partitionFindings(allFindings, fileMap) {
  const active   = [];
  const verified = [];

  if (!Array.isArray(allFindings)) {
    return { active: [], verified: [] };
  }

  for (const finding of allFindings) {
    const files = Array.isArray(finding?.files) ? finding.files : [];
    if (files.length === 0) {
      active.push(finding);
      continue;
    }

    let matched = null;
    for (const file of files) {
      const result = scanForVerified(file, fileMap);
      if (result.verified) {
        matched = result;
        break;
      }
    }

    if (matched) {
      verified.push({ ...finding, verified: true, verifiedReason: matched.reason });
    } else {
      active.push(finding);
    }
  }

  return { active, verified };
}
