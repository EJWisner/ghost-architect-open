/**
 * ghostBriefAdapter.js
 * Converts raw Ghost scan findings into Ghost Brief prompt objects.
 * One adapter per source mode.
 */

export function fromFixForecast(findings) {
  return findings.map((f, i) => ({
    id: `GB-${String(i + 1).padStart(3, '0')}`,
    title: f.title || f.description || `Fix Forecast finding ${i + 1}`,
    severity: normalizeSeverity(f.severity),
    blast_radius: 'surgical', // will be overridden by blastLabel() in generateBrief
    blast_score: f.blast_score || f.blastScore || estimateBlastScore(f),
    source_finding_id: f.id || f.finding_id || null,
    source_mode: 'fix-forecast',
    files: {
      primary: f.files || f.affected_files || [],
      related: f.related_files || [],
      do_not_touch: f.do_not_touch || ['vendor/**', 'app/code/Core/**']
    },
    prompt: f.prompt || buildPromptText(f),
    validation_hints: f.validation_hints || buildValidationHints(f),
    tags: f.tags || []
  }));
}

export function fromPOI(findings) {
  return findings.map((f, i) => ({
    id: `GB-${String(i + 1).padStart(3, '0')}`,
    title: f.label || f.title || `POI finding ${i + 1}`,
    severity: normalizeSeverity(f.severity || 'medium'),
    blast_radius: 'surgical',
    blast_score: f.blast_score || estimateBlastScore(f),
    source_finding_id: f.id || null,
    source_mode: 'poi',
    files: {
      primary: f.files || [],
      related: [],
      do_not_touch: ['vendor/**', 'app/code/Core/**']
    },
    prompt: f.prompt || buildPromptText(f),
    validation_hints: f.validation_hints || buildValidationHints(f),
    tags: f.tags || []
  }));
}

export function fromConflict(findings) {
  return findings.map((f, i) => ({
    id: `GB-${String(i + 1).padStart(3, '0')}`,
    title: f.title || `Conflict finding ${i + 1}`,
    severity: normalizeSeverity(f.severity || 'high'),
    blast_radius: 'surgical',
    blast_score: f.blast_score || estimateBlastScore(f),
    source_finding_id: f.id || null,
    source_mode: 'conflict',
    files: {
      primary: f.files || f.affected_files || [],
      related: f.related_files || [],
      do_not_touch: ['vendor/**', 'app/code/Core/**']
    },
    prompt: f.prompt || buildPromptText(f),
    validation_hints: f.validation_hints || buildValidationHints(f),
    tags: f.tags || []
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeSeverity(raw) {
  const map = { critical: 'critical', high: 'high', medium: 'medium', low: 'low',
                 error: 'critical', warning: 'medium', info: 'low' };
  return map[(raw || '').toLowerCase()] || 'medium';
}

function estimateBlastScore(f) {
  const fileCount = (f.files || f.affected_files || []).length;
  const sevMap = { critical: 5, high: 10, medium: 20, low: 30 };
  const sevBase = sevMap[normalizeSeverity(f.severity)] || 20;
  return Math.max(1, sevBase - fileCount * 2);
}

function buildPromptText(f) {
  const title = f.title || f.label || f.description || 'this finding';
  const files = (f.files || f.affected_files || []).join(', ') || 'the affected file';
  return `Address the following issue: ${title}. Primary file(s): ${files}. Review the finding context and apply the minimal surgical fix. Do not modify vendor code or core framework files.`;
}

function buildValidationHints() {
  return [
    'No new errors introduced in affected files',
    'Existing tests still pass',
    'Change is limited to the files listed in primary'
  ];
}
