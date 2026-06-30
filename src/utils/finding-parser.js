/**
 * Ghost Architect™ — Shared Finding Parser
 * Single source of truth for extracting findings from report markdown.
 * Finding 16: Previously duplicated across multipass.js, analyst/index.js, pdf-generator.js
 *
 * Handles both single-pass and multi-pass report formats.
 */

// ── Shared regex patterns ─────────────────────────────────────────────────────
//
// These regexes assume the field-LABEL portion of the input line (everything
// before the first colon) has been pre-stripped of `**` markdown bold markers
// via stripBoldFromLabel(). Pre-stripping the label is critical because the
// model produces variants like `**Field:** value`, `**Field**: value`, and
// `**Field:** **value**` — trying to encode all those positions inline with
// optional asterisks is fragile (see git history for the bugs that caused).
//
// Label-only stripping reduces every variant to the canonical `Field: value`
// form for matching, while leaving the value (and detail body text) untouched
// so that bold markers in code examples and remediation text are preserved in
// the parsed output. The value-side bold that these regexes do encounter (e.g.
// `**HIGH**`, `**3-5 hours**`) is absorbed by the existing `[^A-Za-z]*` /
// `[^\d]*` lead-ins; FILES_RE's value is stripped of stray asterisks during
// the file-list split. FILES_RE is anchored with `^` so body text containing
// the word "files" cannot hijack the file list.

export const FINDING_RE  = /^###\s+(?:\d+\.\s+)?(.+?)$/;
export const SEVERITY_RE = /^[Ss]everity\s*:[^A-Za-z]*(CRITICAL|HIGH|MEDIUM|LOW)/;
export const FILES_RE    = /^[Ff]iles?\s*:\s*(.+)/;
// Matches "Effort: 3-5 hours" or "Effort: 4 hours" at the start of a line.
// Accepts both ranges (3-5, 3–5) and single values (4, 4.5). Captures the
// full value text; the parser splits/parses it after the match.
export const EFFORT_RE   = /^[Ee]ffort\s*:[^\d]*([\d.]+(?:[\u2013\-][\d.]+)?)\s*(?:hours?|hrs?)/i;
// Same pattern as EFFORT_RE but unanchored — finds inline effort hidden
// inside pipe-separated metadata lines like "Severity: HIGH | Effort: 3-5
// hours | Complexity: Medium | Cost: $360-480". Used as a fallback when the
// effort field shares a line with severity instead of getting its own line.
export const EFFORT_INLINE_RE = /[Ee]ffort\s*:[^\d]*([\d.]+(?:[\u2013\-][\d.]+)?)\s*(?:hours?|hrs?)/i;

/**
 * Strip markdown bold/italic markers (`**`, `*`) from a line.
 *
 * The model wraps field labels in markdown bold (`**Severity:**`) and
 * sometimes wraps values too (`**HIGH**`). Trying to encode all asterisk
 * positions in regex via optional groups is brittle. Instead, strip first,
 * then match against the canonical un-bolded form.
 *
 * Backticks are NOT stripped here — they're handled separately when needed,
 * because file-list parsing uses backticks to delimit individual filenames.
 */
export function stripBoldMarkdown(line) {
  return line.replace(/\*+/g, '');
}

/**
 * Strip bold/italic markers from a line's field-LABEL only.
 *
 * Splits at the first colon: the label (before the colon) is reduced to its
 * canonical un-bolded form so the field regexes can match `Field: value`,
 * while the value (the colon and everything after it) is returned verbatim.
 * This preserves bold markers inside field values and detail body text — code
 * examples and remediation text keep their `**...**` emphasis intact rather
 * than being silently flattened before they reach the JSON sidecar.
 *
 * Lines with no colon (section headers, prose, separators) have no field label
 * to isolate, so they fall back to a full strip — clean titles, no behavior
 * change from the previous whole-line approach.
 */
export function stripBoldFromLabel(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return stripBoldMarkdown(line);
  return stripBoldMarkdown(line.slice(0, colonIdx)) + line.slice(colonIdx);
}

// ── Deterministic finding ID ──────────────────────────────────────────────────

/**
 * Generate a stable ID for a finding that survives title rewrites across scans.
 *
 * Strategy: combine severity + primary file + first 3 meaningful words of title.
 * This is stable because:
 *   - Severity rarely changes for the same underlying issue
 *   - Primary file is deterministic (same code = same file)
 *   - First 3 meaningful words capture the core concept even if title is reworded
 *
 * Examples:
 *   CRITICAL + SettingsService.ts + "migration fail silent" → "CRITICAL:SettingsService.ts:migration-fail-silent"
 *   HIGH + GitHubService.ts + "base64 decode memory" → "HIGH:GitHubService.ts:base64-decode-memory"
 *
 * Falls back to severity + title keywords when no file is available.
 */
export function generateFindingId(finding) {
  const severity = (finding.severity || 'UNKNOWN').toUpperCase();

  // Get primary file — first file, basename only (no path)
  const primaryFile = finding.files && finding.files.length > 0
    ? finding.files[0].trim().split('/').pop().split('\\').pop().replace(/[^a-zA-Z0-9._-]/g, '')
    : '';

  // Extract first 3 meaningful words from title
  const STOP = new Set([
    'the', 'this', 'that', 'with', 'from', 'when', 'will', 'should', 'could',
    'would', 'have', 'been', 'does', 'used', 'uses', 'using', 'and', 'for',
    'not', 'are', 'was', 'but', 'all', 'can', 'may', 'its', 'via', 'any',
  ]);
  const titleWords = (finding.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w))
    .slice(0, 3);

  const titleKey = titleWords.join('-');
  const fileKey  = primaryFile || 'nofile';

  return `${severity}:${fileKey}:${titleKey}`;
}

// ── Core extractor ────────────────────────────────────────────────────────────

function inferSeverityFromSection(sectionHeader) {
  if (/\u{1F534}|critical/iu.test(sectionHeader)) return 'CRITICAL';
  if (/\u{1F7E0}|\uD83D\uDD34|high|security|auth/iu.test(sectionHeader)) return 'HIGH';
  if (/\u{1F7E1}|medium|risk|fault/iu.test(sectionHeader)) return 'MEDIUM';
  if (/\u{1F7E2}|low|hygiene|dead|cleanup/iu.test(sectionHeader)) return 'LOW';
  return 'MEDIUM';
}

/**
 * Extract findings from a Ghost Architect report's markdown text.
 *
 * @param {string} reportText      Raw markdown text of the report.
 * @param {object} [opts]
 * @param {boolean} [opts.keepLandmarks=false]  When true, findings inside
 *        LANDMARK sections (## 🏛 LANDMARKS, etc.) are included with
 *        severity 'LANDMARK' instead of being dropped. Used by compare.js
 *        which tracks architectural-pattern findings across runs. Default
 *        false (POI/Blast scans drop landmarks because the narrator
 *        doesn't render them as severity-tracked items).
 * @returns {Array<Finding>}
 */
export function extractFindings(reportText, opts = {}) {
  if (!reportText) return [];

  const keepLandmarks = !!opts.keepLandmarks;
  const findings = [];
  const lines    = reportText.split('\n');
  let current    = null;
  let currentSectionSeverity = 'MEDIUM';
  let inNonFindingSection = false;
  let inLandmarkSection = false;
  let inCodeBlock = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const tRaw = line.trim();
    // Pre-strip markdown bold from the field LABEL only so the regex patterns
    // can be simple, while leaving values and detail body text untouched. See
    // header comments above the regex patterns for why.
    const t = stripBoldFromLabel(tRaw);

    // Code block detection uses the raw line (`***` is not a code fence).
    if (tRaw.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (/^=== (PASS|MERGED GROUP|FINDINGS BATCH)/i.test(t)) continue;
    if (/^#\s+/.test(t)) continue;

    if (/^##\s+/.test(t)) {
      if (current) { findings.push(finalize(current)); current = null; }

      // Landmark sections are special: when keepLandmarks=true, treat them
      // as a finding section with severity 'LANDMARK'. When false (default),
      // skip them entirely as non-finding architectural commentary.
      const isLandmark = /landmark/i.test(t);
      if (isLandmark) {
        if (keepLandmarks) {
          inNonFindingSection = false;
          inLandmarkSection = true;
          currentSectionSeverity = 'LANDMARK';
          continue;
        }
        inNonFindingSection = true;
        inLandmarkSection = false;
        continue;
      }

      // Other non-finding sections (architecture overview, executive summary,
      // recommended fixes, cost breakdown, remediation summary).
      if (/architecture|summary|recommended|cost breakdown|remediation summary|rollback plan|pre-change snapshot|rollback steps|point of no return|who to notify|smoke test after rollback/i.test(t)) {
        inNonFindingSection = true;
        inLandmarkSection = false;
        continue;
      }

      // ##-as-finding peek-ahead (v6.0.1).
      // Some narrator outputs emit each finding as its own top-level ##
      // block rather than nesting findings under a category ## with ###
      // per item. When this happens the existing ### finding-trigger
      // never fires and saveReport silently skips findings.json (the
      // sidecar write is gated on findings.length > 0).
      //
      // Peek up to 5 non-empty lines forward for a `Severity:` line
      // before the next ## or ### header. Presence of a severity line
      // is the unambiguous "this ## is a finding header" signal — non-
      // finding category sections (`## 🔴 Red Flags`, `## Fault Lines`)
      // never have a Severity line directly under them; they contain
      // ### children that do.
      //
      // See TODO-architect-narrator-drift-open-vs-pro.md for the
      // upstream question this defensive patch is working around.
      let peeksRemaining = 5;
      let isFindingHeader = false;
      for (let i = lineIdx + 1; i < lines.length && peeksRemaining > 0; i++) {
        const peek = stripBoldMarkdown(lines[i].trim());
        if (!peek) continue;
        if (/^#{2,3}\s+/.test(peek)) break;
        if (SEVERITY_RE.test(peek)) { isFindingHeader = true; break; }
        peeksRemaining--;
      }
      if (isFindingHeader) {
        const title = t.replace(/^##\s+/, '').replace(/^\d+\.\s+/, '').trim();
        current = {
          title,
          severity:    'MEDIUM',  // overwritten by the Severity: line below
          detail:      '',
          files:       [],
          effortHours: 0,
          confidence:  85,
        };
        inNonFindingSection = false;
        inLandmarkSection = false;
        continue;
      }

      inNonFindingSection = false;
      inLandmarkSection = false;
      currentSectionSeverity = inferSeverityFromSection(tRaw);  // raw — emoji indicators are part of the header
      continue;
    }

    if (inNonFindingSection) continue;

    if (/^###\s+/.test(t)) {
      if (current) findings.push(finalize(current));
      const title = t.replace(/^###\s+/, '').replace(/^\d+\.\s+/, '').trim();
      current = {
        title,
        severity:    currentSectionSeverity,
        detail:      '',
        files:       [],
        effortHours: 0,
        confidence:  85,
      };
      continue;
    }

    if (current) {
      const sm = t.match(SEVERITY_RE);
      if (sm) {
        current.severity = sm[1].toUpperCase();
        // v5.5.1+: pipe-separated metadata lines often pack severity, effort,
        // complexity, and cost onto a single line. Try to extract inline
        // effort from the same line before continuing. Without this, any
        // report using the format "Severity: X | Effort: Y hours | ..." loses
        // its effort estimates because the parser already consumed the line.
        if (current.effortHours === 0) {
          const eim = t.match(EFFORT_INLINE_RE);
          if (eim) {
            const parts = eim[1].split(/[\u2013\-]/);
            current.effortHours = parseFloat(parts[parts.length - 1]) || 0;
          }
        }
        continue;
      }

      const fim = t.match(FILES_RE);
      if (fim) {
        // Each file may still have backticks left from the un-stripped raw
        // form (e.g. `Files: \`pricing.js\`, \`utils.js\``). Strip them after
        // splitting on commas/semicolons.
        //
        // Final filter drops narrator-emitted placeholders like
        //   "Files: *(None specified in candidate data)*"  (Conflict mode)
        //   "Files: (N/A)"
        //   "Files: not applicable"
        // which the parser would otherwise capture as a single bogus file
        // entry and ship downstream to portal/mobile/Jira export. See
        // TODO-architect-extractfindings-severity-detection-v7.md.
        current.files = fim[1].split(/[,;]/)
          .map(f => f.trim().replace(/`/g, '').replace(/\*+/g, '').replace(/^\(|\)$/g, '').trim())
          .filter(Boolean)
          .filter(f => !/^(none|n\/a|not\s+(specified|applicable))/i.test(f))
          .filter(f => {
            // Reject tokens that are not real file paths:
            // - all-digit-and-dot strings (version strings like "9.4.9")
            // - tokens with spaces or parentheses ("package.json (version field 9.4.9")
            // - tokens without a dotted extension or invalid path characters
            // Mirrors looksLikeFilePath in watcher-commit.js.
            if (/^[\d.]+$/.test(f)) return false;
            if (/\s/.test(f) || f.includes('(') || f.includes(')')) return false;
            return /\.[A-Za-z0-9]+$/.test(f) && /^[\w./@-]+$/.test(f);
          });
        continue;
      }

      // Line-start "Effort: ..." pattern (each field on its own line)
      const em = t.match(EFFORT_RE);
      if (em) {
        const parts = em[1].split(/[\u2013\-]/);
        current.effortHours = parseFloat(parts[parts.length - 1]) || 0;
        continue;
      }

      // Inline effort fallback — catches "Effort:" tokens embedded in
      // pipe-separated metadata or anywhere mid-line. Only fires when we
      // don't already have an effort value to avoid overwriting a clean
      // line-anchored match.
      if (current.effortHours === 0) {
        const eim = t.match(EFFORT_INLINE_RE);
        if (eim) {
          const parts = eim[1].split(/[\u2013\-]/);
          current.effortHours = parseFloat(parts[parts.length - 1]) || 0;
          // Don't continue — the line might also contain detail text we
          // want to capture. Fall through to the detail-accumulation branch.
        }
      }

      if (t && t.length > 10 && !t.startsWith('---') && !t.startsWith('===') && !tRaw.startsWith('```') && !t.startsWith('|')) {
        // Append the raw line so bold markers in detail body text (code
        // examples, remediation steps) are preserved in the parsed finding.
        current.detail += (current.detail ? ' ' : '') + tRaw;
      }
    }
  }

  if (current) findings.push(finalize(current));
  return findings;
}

/**
 * Finalize a finding by generating its deterministic ID.
 * Called after all fields are populated so files are available for ID generation.
 */
function finalize(finding) {
  return {
    ...finding,
    id: generateFindingId(finding),
  };
}

// ── Similarity helper (fuzzy fallback) ────────────────────────────────────────

function normalize(s) {
  return s.toLowerCase()
    .replace(/^\d+\.\s+/, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'with', 'from', 'when', 'will', 'should', 'could',
  'would', 'have', 'been', 'does', 'used', 'uses', 'using', 'call', 'calls',
  'called', 'function', 'method', 'value', 'data', 'code', 'type', 'state',
  'screen', 'service', 'settings', 'error', 'result', 'return', 'check',
  'handle', 'handler', 'missing', 'field', 'param', 'props', 'store',
]);

export function similarFinding(a, b) {
  // Primary match — deterministic ID (exact)
  if (a.id && b.id && a.id === b.id) return true;

  const na = normalize(a.title || a);
  const nb = normalize(b.title || b);

  if (na === nb) return true;

  const wa = new Set(na.split(' ').filter(w => w.length > 3 && !STOP_WORDS.has(w)));
  const wb = new Set(nb.split(' ').filter(w => w.length > 3 && !STOP_WORDS.has(w)));

  if (wa.size === 0 || wb.size === 0) return false;

  const shared = [...wa].filter(w => wb.has(w));
  const overlap = shared.length / Math.max(wa.size, wb.size);
  if (shared.length >= 3 && overlap >= 0.75) return true;

  const aFiles = (a.files || []).map(f => f.toLowerCase());
  const bFiles = (b.files || []).map(f => f.toLowerCase());
  const sharedFiles = aFiles.filter(f => bFiles.includes(f));
  if (sharedFiles.length > 0 && shared.length >= 2 && overlap >= 0.50) return true;

  return false;
}
