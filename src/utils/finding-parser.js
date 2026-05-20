/**
 * Ghost Architect™ — Shared Finding Parser
 * Single source of truth for extracting findings from report markdown.
 * Finding 16: Previously duplicated across multipass.js, analyst/index.js, pdf-generator.js
 *
 * Handles both single-pass and multi-pass report formats.
 */

// ── Shared regex patterns ─────────────────────────────────────────────────────
//
// Notes on the anchoring choices:
//
// FILES_RE is anchored with `^` so body text containing the word "files"
// (e.g. "Both files have the issue") cannot hijack the file list. Before
// this anchor was added, narrator Pass 2 prose like "These files share a
// common dependency." was matched and overwrote the actual file list.
// Fixed: 2026-05-08.
//
// EFFORT_RE accepts both `hours` and `hrs` because the model emits both
// spellings depending on whether it's running with white-label / consultant-
// voice profiles (which prefer the longer form) or without. Before this
// expansion, the regex required `hrs?` only and silently returned 0 for
// any "hours" effort estimate, breaking remediation cost calculations on
// scans that used the longer form. Fixed: 2026-05-08.

export const FINDING_RE  = /^###\s+(?:\d+\.\s+)?\*?\*?(.+?)\*?\*?$/;
// SEVERITY_RE matches lines like `**Severity:** **HIGH**` and the newer
// emoji-prefixed form `**Severity:** 🟠 **HIGH**`. The narrator started
// emitting the emoji form for white-label / consultant-voice reports; the
// regex must tolerate any number of emoji and whitespace between the colon
// and the severity word, otherwise the parser silently falls back to the
// surrounding section header's inferred severity (e.g. tagging every
// finding under `## 🔴 Red Flags ...` as CRITICAL regardless of its actual
// per-finding rating).
export const SEVERITY_RE = /^\*?\*?[Ss]everity\*?\*?:\s*[^A-Za-z]*\*?\*?(CRITICAL|HIGH|MEDIUM|LOW)\*?\*?/;
export const FILES_RE    = /^\*?\*?[Ff]iles?\*?\*?[:\s]+(.+)/i;
// EFFORT_RE uses `[^\d]*` between the colon and the digits to absorb any
// non-digit characters (asterisks from `**Effort:** 1-2 hrs`, emoji, extra
// whitespace) without an exhaustive enumeration. The original regex used
// `[:\s]+` which failed on `**Effort:** 1-2 hrs` because `**` after the
// colon is neither colon nor whitespace and broke the match.
export const EFFORT_RE   = /\*?\*?[Ee]ffort\*?\*?\s*:[^\d]*([\d.]+[\u2013\-][\d.]+)\s*(?:hours?|hrs?)/i;

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
 * True when the given `## ...` header line is a non-finding section that
 * should be skipped by the finding extractor. Strips the `##`, leading
 * emoji, and any markdown emphasis so we can match section names against
 * a clean text body.
 *
 * The closed set of non-finding sections Ghost emits today:
 *   - Executive Summary
 *   - Remediation Summary (sometimes prefixed with 📊 or other emoji)
 *   - Risk if Left Unaddressed
 *   - Risk Assessment (legacy)
 *   - Cost Breakdown (legacy)
 *   - Recommended Next Steps (legacy)
 *
 * Anything else — including Ghost's canonical finding categories (Red
 * Flags, Landmarks, Dead Zones, Fault Lines) and Partner-defined custom
 * categories (Architecture, State Management, etc.) — is treated as a
 * finding category and its ### entries are extracted.
 */
function isNonFindingSectionHeader(line) {
  // Strip leading '## ', any emoji prefix, markdown emphasis, and trailing
  // descriptive text (anything after a dash or em-dash). What remains is
  // the bare section name.
  const cleaned = line
    .replace(/^##\s+/, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')   // strip emoji
    .replace(/\*+/g, '')                       // strip markdown emphasis
    .split(/[\u2014\u2013\-\u00b7]/)[0]        // take part before any dash/bullet
    .trim()
    .toLowerCase();

  // Exact-name matches (closed set of known non-finding sections)
  const NON_FINDING_NAMES = [
    'executive summary',
    'remediation summary',
    'risk if left unaddressed',
    'risk assessment',
    'cost breakdown',
    'recommended next steps',
  ];
  if (NON_FINDING_NAMES.includes(cleaned)) return true;

  // Catch a couple of permissive variants we've seen in the wild
  if (/^remediation\b/.test(cleaned) && /summary$/.test(cleaned)) return true;
  if (/^risk\b/.test(cleaned) && /unaddressed$/.test(cleaned))    return true;

  return false;
}

/**
 * Extract findings from a Ghost Architect report's markdown text.
 *
 * @param {string} reportText      Raw markdown text of the report.
 * @param {object} [opts]
 * @param {boolean} [opts.keepLandmarks=false]  When true, findings inside
 *        a section whose name matches /landmark/i are tagged with severity
 *        'LANDMARK' (overriding inferSeverityFromSection). Used by
 *        compare.js to track architectural-pattern findings across runs.
 *        When false (default), landmark sections are treated like any
 *        other finding category and their severity is inferred from the
 *        header (typically MEDIUM in absence of a severity emoji).
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
  let inCodeBlock = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const t = line.trim();

    if (t.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (/^=== (PASS|MERGED GROUP|FINDINGS BATCH)/i.test(t)) continue;
    if (/^#\s+/.test(t)) continue;

    if (/^##\s+/.test(t)) {
      if (current) { findings.push(finalize(current)); current = null; }
      // Detect non-finding sections precisely. Earlier regex matched
      // substrings like 'landmark' and 'architecture', which collide with
      // legitimate finding categories ('🏛️ Landmarks', Partner
      // 'Architecture & Separation of Concerns'). We instead match exact
      // section names anchored after the leading ##, allowing emoji and
      // whitespace before them. The section list is the closed set of
      // non-finding sections Ghost emits: Executive Summary, Remediation
      // Summary (with or without emoji), Risk if Left Unaddressed, Cost
      // Breakdown, Recommended Next Steps. Custom Partner categories with
      // any other name are treated as finding categories by default.
      if (isNonFindingSectionHeader(t)) {
        inNonFindingSection = true;
        continue;
      }
      inNonFindingSection = false;

      // ##-as-finding peek-ahead (v6.0.1).
      // Some narrator outputs emit each finding as its own top-level ##
      // block rather than nesting findings under a category ## with ###
      // per item. When this happens the existing ### finding-trigger
      // never fires and saveReport silently skips findings.json (the
      // sidecar write is gated on findings.length > 0).
      //
      // Peek up to 5 non-empty lines forward for a Severity: line before
      // the next ## or ### header. Presence of a severity line is the
      // unambiguous "this ## is a finding header" signal — non-finding
      // category sections (## 🔴 Red Flags, ## Fault Lines) never have a
      // Severity line directly under them; they contain ### children that
      // do, and the ### header stops the peek before we reach those.
      //
      // See TODO-architect-narrator-drift-open-vs-pro.md for the upstream
      // question this defensive patch is working around.
      let peeksRemaining = 5;
      let isFindingHeader = false;
      for (let i = lineIdx + 1; i < lines.length && peeksRemaining > 0; i++) {
        const peek = lines[i].trim();
        if (!peek) continue;
        if (/^#{2,3}\s+/.test(peek)) break;
        if (SEVERITY_RE.test(peek)) { isFindingHeader = true; break; }
        peeksRemaining--;
      }
      if (isFindingHeader) {
        if (current) findings.push(finalize(current));
        const title = t.replace(/^##\s+/, '').replace(/^\d+\.\s+/, '').replace(/\*\*/g, '').trim();
        current = {
          title,
          severity:    currentSectionSeverity, // overwritten by Severity: line; otherwise inherits section context
          detail:      '',
          files:       [],
          effortHours: 0,
          confidence:  85,
        };
        continue;
      }

      // When opts.keepLandmarks is true and the section header matches
      // /landmark/i, override the section severity to 'LANDMARK' so the
      // compare-mode caller can identify architectural findings explicitly.
      // Otherwise, infer severity from the header as usual (Pro's default
      // behavior, which preserves Partner-defined categories with their
      // own emoji-derived severity).
      if (keepLandmarks && /landmark/i.test(t)) {
        currentSectionSeverity = 'LANDMARK';
      } else {
        currentSectionSeverity = inferSeverityFromSection(t);
      }
      continue;
    }

    if (inNonFindingSection) continue;

    if (/^###\s+/.test(t)) {
      if (current) findings.push(finalize(current));
      const title = t.replace(/^###\s+/, '').replace(/^\d+\.\s+/, '').replace(/\*\*/g, '').trim();
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
      if (sm) { current.severity = sm[1].toUpperCase(); continue; }

      const fim = t.match(FILES_RE);
      if (fim) {
        // Strip markdown artifacts that the narrator's Pass 2 sometimes
        // emits inside the Files line: backticks, bold (**), emphasis (*),
        // angle brackets <...>, and any leading/trailing whitespace. After
        // stripping, drop any entry that is empty OR contains nothing but
        // punctuation (e.g. "**" by itself, which the verifier would treat
        // as a literal glob and fail every file-existence check). The bug-
        // firing osc-cap-test scan on April 27 produced files: ["**"] for
        // every finding because Pass 2 emitted `**Files:** **` with empty
        // bold; this strips it to nothing and we drop the entry, leaving
        // current.files = [] which is a more honest signal to downstream.
        current.files = fim[1]
          .split(/[,;]/)
          .map(f => f
            .trim()
            .replace(/`/g, '')
            .replace(/\*+/g, '')
            .replace(/^<|>$/g, '')
            .trim()
          )
          .filter(f => f && /[a-zA-Z0-9]/.test(f));
        continue;
      }

      const em = t.match(EFFORT_RE);
      if (em) {
        const parts = em[1].split(/[\u2013\-]/);
        current.effortHours = parseFloat(parts[parts.length - 1]) || 0;
        continue;
      }

      if (t && t.length > 10 && !t.startsWith('---') && !t.startsWith('===') && !t.startsWith('```') && !t.startsWith('|')) {
        current.detail += (current.detail ? ' ' : '') + t.replace(/\*\*/g, '');
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
