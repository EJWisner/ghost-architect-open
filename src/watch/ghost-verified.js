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

import { CODE_EXTENSIONS } from '../constants/code-extensions.js';

const MARKER = '@ghost-verified';

// A marker only counts as an annotation when it sits directly after a comment
// opener. This stops the marker STRING appearing in code (the MARKER constant
// above, the PR-comment template text in watcher-commit.js, etc.) from falsely
// verifying a file. indexOf/endsWith only — ReDoS-immune. Supports the common
// single-line and block comment openers across languages.
//
// These are the bare openers (no trailing space). The matcher tolerates any
// run of spaces/tabs — or none at all — between the opener and the marker, so
// "// @ghost-verified", "//@ghost-verified", "//   @ghost-verified" and
// "//\t@ghost-verified" all anchor identically. (The previous implementation
// hardcoded a single trailing space and silently missed every other spacing.)
// '*' covers JSDoc/doc-block continuation lines (' * @ghost-verified'), the
// most common JS annotation style, which previously never anchored (Audit 7,
// Q24). Safe under the same guards as the other openers: the marker must sit
// directly after the opener (whitespace-tolerant), string-literal context is
// excluded, and a bare '*' mid-expression never ENDS the pre-marker text once
// trailing whitespace is stripped unless the marker directly follows it.
const COMMENT_OPENERS = ['//', '#', '--', '/*', '*'];

// File-extension allowlist: only source code files are eligible for the
// @ghost-verified annotation. Documentation and data files (.md, .json,
// .yaml, etc.) frequently contain the marker STRING as documentation text
// (changelogs, README feature descriptions) and must never be scanned for it.
//
// Derived from the shared CODE_EXTENSIONS list minus a doc/data denylist, so
// a language made scannable is automatically annotatable. v10.0.17 added
// Swift/Kotlin scanning while this list stayed hand-maintained: watcher
// findings on those files could exist but never be suppressed as
// reviewed-and-accepted (Audit 7, Q14) — the exact two-lists-disagree failure
// code-extensions.js was created to kill. EXTRA_SOURCE_EXTENSIONS preserves
// the entries this list always had that CODE_EXTENSIONS does not (yet) carry.
const DOC_DATA_EXTENSIONS     = new Set(['.md', '.json', '.xml', '.yaml', '.yml']);
const EXTRA_SOURCE_EXTENSIONS = ['.rs', '.css', '.scss'];
const SOURCE_EXTENSIONS = new Set(
  [...CODE_EXTENSIONS, ...EXTRA_SOURCE_EXTENSIONS].filter(e => !DOC_DATA_EXTENSIONS.has(e))
);

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

  // Only source files are eligible. Non-source files (.md, .json, .yaml, etc.)
  // may contain the marker as documentation text — never treat them as verified.
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(ext)) {
    return { verified: false, reason: null };
  }

  // Scan EVERY occurrence: a file may carry the marker in a string literal on
  // one line and in a real comment on another. Only a comment-context hit
  // verifies; the first such hit wins (and supplies the reason).
  let searchFrom = 0;
  let nearMiss = false;
  while (true) {
    const markerIdx = content.indexOf(MARKER, searchFrom);
    if (markerIdx === -1) break;
    searchFrom = markerIdx + MARKER.length;

    // Text from the start of the marker's line up to the marker. Strip leading
    // indentation AND any trailing whitespace between the comment opener and
    // the marker; if what remains ENDS WITH a comment opener, the marker is in
    // comment context — either on its own comment line or trailing after code
    // (e.g. `foo();` then a comment). Collapsing the trailing whitespace is the
    // fix for near-miss spacing: zero, one, or several spaces/tabs all anchor.
    const lineStart = content.lastIndexOf('\n', markerIdx - 1) + 1;
    const before = content.slice(lineStart, markerIdx).replace(/[ \t]+$/, '').trimStart();
    if (!COMMENT_OPENERS.some((opener) => before.endsWith(opener))) {
      // Not comment-anchored, so this occurrence does nothing. Distinguish a
      // genuine near-miss (a marker a developer meant as an annotation but
      // placed where it is silently ignored) from a legitimate mention:
      //   - inside a string literal (prev char is a quote): intentional, e.g.
      //     the MARKER constant or PR-template text — stay silent.
      //   - already inside a comment earlier on the line (doc/example text):
      //     not a live annotation — stay silent.
      // Anything else (a bare marker with no comment opener and no quote) is a
      // near-miss worth surfacing so it is not lost without a trace.
      const prevChar = content[markerIdx - 1];
      const inStringLiteral = prevChar === '"' || prevChar === "'" || prevChar === '`';
      const commentEarlierOnLine = COMMENT_OPENERS.some((opener) => before.includes(opener));
      if (!inStringLiteral && !commentEarlierOnLine) nearMiss = true;
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

  // The marker appeared but never anchored to a comment. Surface it once so a
  // misplaced annotation is visible instead of silently doing nothing.
  if (nearMiss) {
    console.warn(
      `[ghost-verified] "${MARKER}" found in ${filePath} but not anchored to a comment opener ` +
      `(${COMMENT_OPENERS.join(' ')}); annotation ignored. Put it right after a comment marker, e.g. "// ${MARKER}".`
    );
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
