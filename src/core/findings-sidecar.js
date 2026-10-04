/**
 * Ghost Architect™: findings sidecar builder.
 *
 * Every saved report gets a <name>.findings.json beside it. When a mode does
 * not hand saveReport structured findings, the sidecar is rebuilt from the
 * report text here.
 */

import { extractFindings, generateFindingId } from '../utils/finding-parser.js';

/**
 * Build the findings.json sidecar payload from a report's content.
 * Shape: an array of finding objects with stable IDs plus severity counts.
 * Ghost Brief™ and the Executive Brief read this file as their input.
 */
export function buildFindingsSidecar(reportText, meta = {}) {
  const findings = extractFindings(reportText).map(f => ({
    id:          generateFindingId(f),
    title:       f.title,
    severity:    f.severity,
    files:       f.files || [],
    effortHours: f.effortHours || 0,
    confidence:  f.confidence  || 85,
    detail:      f.detail || '',
  }));

  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    const k = (f.severity || '').toLowerCase();
    if (counts[k] !== undefined) counts[k]++;
  }

  return {
    schema:          1,
    generatedAt:     new Date().toISOString(),
    project:         meta.project || meta.label || null,
    mode:            meta.mode    || null,
    totalFindings:   findings.length,
    severityCounts:  counts,
    findings,
  };
}
