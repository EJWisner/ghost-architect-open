/**
 * src/prompt-pack/report.js
 *
 * Markdown report renderer for Prompt Triage scans. Takes the raw
 * findings array from runAll() (across multiple prompt files) plus
 * scan metadata, returns a Markdown string ready to write to disk
 * or display in the terminal.
 *
 * Output shape (intentionally different from POI/Blast/Conflict reports):
 *
 *   # Prompt Triage Report
 *   _Scanned N prompts, found M findings._
 *
 *   ## Summary
 *   - Total prompts scanned: N
 *   - Total findings: M
 *   - By severity: CRITICAL n, HIGH n, MEDIUM n, LOW n
 *   - Detectors run: ...
 *
 *   ## Findings by file
 *   ### path/to/prompt-1.md
 *   - 🟠 [HIGH] formatting/unclosed-tag (L17): Unclosed <example> tag
 *     The prompt opens a <example> tag at line 17 but never closes it...
 *     **Fix:** Add a closing </example> tag at the appropriate place...
 *
 *   ## Clean prompts
 *   The following N prompts had no findings:
 *   - path/to/clean-1.md
 *   ...
 *
 * No dollar amounts, no remediation table, no billing rates. Prompt
 * findings are not unit-of-effort the way code findings are; the value
 * to the user is "what's wrong, where, how to fix it."
 */

const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function severityEmoji(s) {
  switch (s) {
    case 'CRITICAL': return '🔴';
    case 'HIGH':     return '🟠';
    case 'MEDIUM':   return '🟡';
    case 'LOW':      return '🔵';
    default:         return '⚪';
  }
}

function basename(filePath) {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * Format a finding's location for the report header. Tier 1 detectors
 * emit { line, column } with concrete numbers; Tier 2 detectors emit
 * { hint: 'free-form string' } because LLMs cannot reliably count
 * lines in arbitrary text. Both shapes render here.
 */
function formatLocation(location) {
  if (!location) return '';
  if (typeof location.line === 'number' && location.line > 0) {
    return ' (L' + location.line + ')';
  }
  if (typeof location.hint === 'string' && location.hint.trim().length > 0) {
    return ' (' + location.hint.trim() + ')';
  }
  return '';
}

/**
 * Build the markdown report from a flat array of findings + metadata.
 *
 * @param {Object} args
 * @param {Array}  args.findings        Flat array of findings (across all files).
 * @param {Array}  args.scannedFiles    Full list of prompt file paths scanned.
 * @param {Array}  args.detectors       [{ id, tier }] from listDetectors().
 * @param {Date}   [args.scanDate]      Defaults to now.
 * @param {string} [args.folderLabel]   Display label for the folder scanned.
 * @returns {string} Markdown report.
 */
export function renderReport({ findings, scannedFiles, detectors, scanDate, folderLabel }) {
  const date = scanDate || new Date();
  const total = findings.length;
  const promptCount = scannedFiles.length;

  // Group findings by file path. A file may have zero findings; we
  // surface those separately under "Clean prompts" so the user knows
  // they were scanned and not skipped.
  const byFile = new Map();
  for (const f of scannedFiles) byFile.set(f, []);
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  // Severity tally for the summary line.
  const sevCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) {
    if (sevCounts[f.severity] !== undefined) sevCounts[f.severity]++;
  }

  const lines = [];

  // ── Header ──────────────────────────────────────────────────────────────
  lines.push('# Prompt Triage Report');
  lines.push('');
  if (folderLabel) {
    lines.push('**Folder:** `' + folderLabel + '`');
  }
  lines.push('**Scan date:** ' + date.toISOString());
  lines.push('');
  if (total === 0) {
    lines.push('_Scanned ' + promptCount + ' prompt' + (promptCount === 1 ? '' : 's') + ', no findings._');
  } else {
    lines.push('_Scanned ' + promptCount + ' prompt' + (promptCount === 1 ? '' : 's') + ', found '
      + total + ' finding' + (total === 1 ? '' : 's') + '._');
  }
  lines.push('');

  // ── Summary ─────────────────────────────────────────────────────────────
  lines.push('## Summary');
  lines.push('');
  lines.push('- Total prompts scanned: ' + promptCount);
  lines.push('- Total findings: ' + total);
  if (total > 0) {
    const sevLine = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
      .filter(s => sevCounts[s] > 0)
      .map(s => severityEmoji(s) + ' ' + s + ' ' + sevCounts[s])
      .join(', ');
    lines.push('- By severity: ' + sevLine);
  }
  lines.push('- Detectors run: ' + detectors.map(d => d.id + ' (T' + d.tier + ')').join(', '));
  lines.push('');

  // ── Findings by file ────────────────────────────────────────────────────
  // Files with at least one finding, sorted by file path.
  const filesWithFindings = scannedFiles
    .filter(f => (byFile.get(f) || []).length > 0)
    .sort();

  if (filesWithFindings.length > 0) {
    lines.push('## Findings by file');
    lines.push('');

    for (const file of filesWithFindings) {
      const fileFindings = (byFile.get(file) || []).slice();
      // Sort findings within a file by severity, then by line number.
      fileFindings.sort((a, b) => {
        const sa = SEVERITY_ORDER[a.severity] ?? 99;
        const sb = SEVERITY_ORDER[b.severity] ?? 99;
        if (sa !== sb) return sa - sb;
        const la = (a.location && a.location.line) || 0;
        const lb = (b.location && b.location.line) || 0;
        return la - lb;
      });

      lines.push('### ' + basename(file));
      lines.push('');
      lines.push('_Path: `' + file + '`_');
      lines.push('');

      for (const f of fileFindings) {
        const loc = formatLocation(f.location);
        lines.push('#### ' + severityEmoji(f.severity) + ' [' + f.severity + '] '
          + f.detector + loc);
        lines.push('');
        lines.push('**' + f.title + '**');
        lines.push('');
        lines.push(f.detail);
        lines.push('');
        if (f.remediation) {
          lines.push('**Fix:** ' + f.remediation);
          lines.push('');
        }
        if (typeof f.confidence === 'number') {
          lines.push('_Confidence: ' + f.confidence + '%_');
          lines.push('');
        }
      }
    }
  }

  // ── Clean prompts ───────────────────────────────────────────────────────
  const cleanFiles = scannedFiles
    .filter(f => (byFile.get(f) || []).length === 0)
    .sort();

  if (cleanFiles.length > 0) {
    lines.push('## Clean prompts');
    lines.push('');
    lines.push('The following ' + cleanFiles.length + ' prompt'
      + (cleanFiles.length === 1 ? '' : 's')
      + ' had no findings:');
    lines.push('');
    for (const f of cleanFiles) {
      lines.push('- `' + f + '`');
    }
    lines.push('');
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('_Generated by Ghost Architect™ Prompt Triage. '
    + 'Detectors based on Tian et al. (2025), '
    + '"A Taxonomy of Prompt Defects in LLM Systems" (arXiv:2509.14404)._');
  lines.push('');

  return lines.join('\n');
}
