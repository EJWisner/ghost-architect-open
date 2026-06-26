/**
 * Ghost Architect — Transport metadata
 *
 * Pure helpers (no inquirer, no SDK) for the transport block that gets stamped
 * onto report artifacts so a reader can tell HOW a scan was run:
 *
 *   streaming: { method:'streaming', completedAt, version }
 *   batch:     { method:'batch', submittedAt, retrievedAt, version }
 *
 * and the one-line footer used by the Ghost Brief HTML report and the PDF
 * executive brief:
 *
 *   Scan transport: Batch (submitted 9:14am, retrieved 9:47am) · ghost-architect-open@9.2.3
 *   Scan transport: Streaming (completed 9:17am) · ghost-architect-open@9.2.3
 *
 * Kept dependency-free on purpose: reports.js, pdf-generator.js, and
 * lib/ghostBrief.js all import from here, and none of them should pull in the
 * interactive menu (inquirer) just to render a footer.
 *
 * Transport metadata is intentionally NOT surfaced in PR comments or email
 * notifications — only in findings.json, the Ghost Brief HTML, and the PDF.
 */

import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const PKG = _require('../../package.json');
const PKG_NAME    = PKG.name || 'ghost-architect-open';
const PKG_VERSION = PKG.version || '0.0.0';

/**
 * Build the streaming transport block. completedAt defaults to now.
 */
export function buildStreamingTransport({ completedAt, version } = {}) {
  return {
    method:      'streaming',
    completedAt: completedAt || new Date().toISOString(),
    version:     version || PKG_VERSION,
  };
}

/**
 * Build the batch transport block. submittedAt comes from the pending-batch
 * record (when the batch was submitted); retrievedAt defaults to now.
 */
export function buildBatchTransport({ submittedAt, retrievedAt, version } = {}) {
  return {
    method:      'batch',
    submittedAt: submittedAt || null,
    retrievedAt: retrievedAt || new Date().toISOString(),
    version:     version || PKG_VERSION,
  };
}

/**
 * Format an ISO timestamp as a short wall-clock time like "9:14am".
 * Returns '' for a missing/invalid timestamp.
 */
export function formatClockTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

/**
 * Render the one-line transport footer string. Returns '' when there is no
 * transport block (so callers can omit the line entirely).
 *
 * @param {object} transport  a streaming or batch transport block
 */
export function formatTransportFooter(transport) {
  if (!transport || !transport.method) return '';
  const version = transport.version || PKG_VERSION;
  const stamp   = `${PKG_NAME}@${version}`;

  if (transport.method === 'batch') {
    const sub = formatClockTime(transport.submittedAt);
    const ret = formatClockTime(transport.retrievedAt);
    const parts = [];
    if (sub) parts.push(`submitted ${sub}`);
    if (ret) parts.push(`retrieved ${ret}`);
    const detail = parts.length ? ` (${parts.join(', ')})` : '';
    return `Scan transport: Batch${detail} · ${stamp}`;
  }

  // streaming
  const done = formatClockTime(transport.completedAt);
  const detail = done ? ` (completed ${done})` : '';
  return `Scan transport: Streaming${detail} · ${stamp}`;
}

export { PKG_NAME, PKG_VERSION };
