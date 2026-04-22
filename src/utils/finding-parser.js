/**
 * Ghost Architect™ — Shared Finding Parser
 * Single source of truth for extracting findings from report markdown.
 * Finding 16: Previously duplicated across multipass.js, analyst/index.js, pdf-generator.js
 *
 * Handles both single-pass and multi-pass report formats.
 */

// ── Shared regex patterns ─────────────────────────────────────────────────────

export const FINDING_RE  = /^###\s+(?:\d+\.\s+)?\*?\*?(.+?)\*?\*?$/;
export const SEVERITY_RE = /^\*?\*?[Ss]everity\*?\*?:\s*\*?\*?(CRITICAL|HIGH|MEDIUM|LOW)\*?\*?/;
export const FILES_RE    = /\*?\*?[Ff]iles?\*?\*?[:\s]+(.+)/i;
export const EFFORT_RE   = /\*?\*?[Ee]ffort\*?\*?[:\s]+([\d.]+[\u2013\-][\d.]+)\s*hrs?/i;

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

export function extractFindings(reportText) {
  if (!reportText) return [];

  const findings = [];
  const lines    = reportText.split('\n');
  let current    = null;
  let currentSectionSeverity = 'MEDIUM';
  let inNonFindingSection = false;
  let inCodeBlock = false;

  for (const line of lines) {
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
      if (/landmark|architecture|summary|recommended|cost breakdown|remediation summary/i.test(t)) {
        inNonFindingSection = true;
        continue;
      }
      inNonFindingSection = false;
      currentSectionSeverity = inferSeverityFromSection(t);
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
        current.files = fim[1].split(/[,;]/).map(f => f.trim().replace(/`/g, '')).filter(Boolean);
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
