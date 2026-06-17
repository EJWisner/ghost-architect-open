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
  const map = {
    critical: 'critical', high: 'high', medium: 'medium', low: 'low',
    error: 'critical', warning: 'medium', info: 'low'
  };
  return map[(raw || '').toLowerCase()] || 'medium';
}

function estimateBlastScore(f) {
  const fileCount = (f.files || f.affected_files || []).length;
  const sevMap = { critical: 5, high: 10, medium: 20, low: 30 };
  const sevBase = sevMap[normalizeSeverity(f.severity)] || 20;
  return Math.max(1, sevBase - fileCount * 2);
}

/**
 * Extract "Why this matters:" context from the detail blob.
 * Finds the text between "Why this matters:" and the first numbered step.
 */
function extractWhyItMatters(detail) {
  if (!detail) return '';
  const match = detail.match(/Why this matters:\s*(.+?)(?=\s*\d+\.\s|\s*$)/s);
  if (!match) return '';
  return match[1].trim().replace(/\s+/g, ' ');
}

/**
 * Extract numbered fix steps (1. 2. 3. ...) from the detail blob.
 * Returns them as a formatted list string.
 */
function extractFixSteps(detail) {
  if (!detail) return '';
  // Match all "N. text" items until the next numbered item or end
  const steps = [];
  const stepRegex = /(\d+)\.\s+(.+?)(?=\s+\d+\.\s|\s*$)/gs;
  let match;
  while ((match = stepRegex.exec(detail)) !== null) {
    steps.push(`${match[1]}. ${match[2].trim().replace(/\s+/g, ' ')}`);
  }
  return steps.join('\n');
}

/**
 * Build a rich, surgical prompt from a finding.
 * Falls back to a useful multi-line prompt if detail is absent.
 */
function buildPromptText(f) {
  const title = f.title || f.label || f.description || 'this finding';
  const primaryFiles = (f.files || f.affected_files || []);
  const fileList = primaryFiles.length > 0
    ? primaryFiles.join(', ')
    : 'the affected file(s)';
  const doNotTouch = (f.do_not_touch || ['vendor/**', 'app/code/Core/**']).join(', ');

  const why = extractWhyItMatters(f.detail);
  const steps = extractFixSteps(f.detail);

  const confidenceLine = f.confidence != null
    ? `\nCONFIDENCE: ${f.confidence}%` : '';
  const effortLine = f.effortHours != null
    ? `\nESTIMATED EFFORT: ${f.effortHours} hour${f.effortHours !== 1 ? 's' : ''}` : '';

  if (why || steps) {
    return [
      `In ${fileList}, address the following issue: ${title}`,
      '',
      why ? `CONTEXT:\n${why}` : '',
      steps ? `\nFIX STEPS:\n${steps}` : '',
      '',
      `CONSTRAINTS:\n- Only modify the files listed above\n- Do not touch: ${doNotTouch}\n- Do not refactor unrelated code in the same files\n- Run existing tests after each change to confirm no regressions`,
      confidenceLine,
      effortLine
    ].filter(s => s !== '').join('\n').trim();
  }

  // Fallback: still multi-line and useful even without detail
  return [
    `In ${fileList}, address the following issue: ${title}`,
    '',
    `CONSTRAINTS:\n- Only modify the files listed above\n- Do not touch: ${doNotTouch}\n- Do not refactor unrelated code in the same files\n- Run existing tests after each change to confirm no regressions`,
    confidenceLine,
    effortLine
  ].filter(s => s !== '').join('\n').trim();
}

/**
 * Build finding-specific validation hints.
 */
function buildValidationHints(f) {
  const title = (f.title || f.label || f.description || '').toLowerCase();
  const severity = normalizeSeverity(f.severity);

  const hints = [
    'Existing tests still pass after the change',
    'Change is limited to the files listed in primary',
  ];

  if (severity === 'critical') {
    hints.push('No new attack surface introduced');
  }

  if (/injection|spawn/.test(title)) {
    hints.push('Validate all external inputs before passing to system calls');
  }

  if (/secret|hmac|token/.test(title)) {
    hints.push('No secrets or keys remain hardcoded in any source file');
  }

  if (/silent|failure|error/.test(title)) {
    hints.push('Error condition is now visible to the user or logged');
  }

  if (/concurrent|manifest/.test(title)) {
    hints.push('Concurrent operation tested and no data loss occurs');
  }

  if (/cache/.test(title)) {
    hints.push('Cache directory size bounded and cleanup logic verified');
  }

  return hints;
}
