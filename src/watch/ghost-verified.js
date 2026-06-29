// src/watch/ghost-verified.js
//
// @ghost-verified annotation system.
//
// A developer can mark code that Ghost Watcher flagged as reviewed-and-accepted
// by dropping an in-code comment marker:
//
//   // @ghost-verified
//   // @ghost-verified: legacy adapter is intentional, reviewed 2026-06-29
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

/**
 * Scan a single file's content for the @ghost-verified marker.
 *
 * @param {string} filePath  path key to look up in fileMap
 * @param {Object} fileMap   { path -> content } map (codebaseContext.fileMap)
 * @returns {{ verified: boolean, reason: string|null }}
 *   verified:false (reason:null) if the file is absent from fileMap or has no
 *   marker. When the marker carries an optional ": reason" suffix, reason holds
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

  const markerIdx = content.indexOf(MARKER);
  if (markerIdx === -1) {
    return { verified: false, reason: null };
  }

  // Optional reason: text after a ':' immediately following the marker, up to
  // the end of that line. "@ghost-verified: foo" -> "foo"; bare marker -> null.
  let reason = null;
  const afterMarker = markerIdx + MARKER.length;
  // Find the end of the marker's line so the reason never bleeds into the next.
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
