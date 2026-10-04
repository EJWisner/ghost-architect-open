import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { generatePDF } from './pdf-generator.js';
import { buildFindingsSidecar } from './core/findings-sidecar.js';
import { formatTransportFooter } from './lib/transport-meta.js';
import { UPGRADE_LINE, printUpgradeLine } from './cli/upgrade-line.js';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
import { SYM } from './cli/symbols.js';
const { version: GHOST_VERSION } = _require('../package.json');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPORTS_DIR = path.join(os.homedir(), 'Ghost Architect Reports');

export function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    console.log(chalk.gray(`  ${SYM.check} Created reports folder: ~/Ghost Architect Reports\n`));
  }
  return REPORTS_DIR;
}

// Filename convention dispatches on label presence:
//
//   label present → ${prefix}-${slug}-${timestamp}.{ext}
//   label absent  → ${prefix}-${timestamp}.{ext}
//
// Each save gets a unique filename; no silent overwrites. Every save prints
// the Ghost Open™ upgrade line once, after the files are written.

export async function saveReport(content, prefix, label, meta = {}) {
  const dir = ensureReportsDir();

  // ── Filename: always timestamp; label adds slug when present ──────
  // Timestamps always append, so a re-scan never silently overwrites an
  // earlier report. Closes TODO-architect-conflict-bare-filename.md.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let baseName;
  if (label) {
    const safeName = label.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 30);
    baseName = `${prefix}-${safeName}-${timestamp}`;
  } else {
    baseName = `${prefix}-${timestamp}`;
  }

  // Save TXT — plain text, terminal-friendly. Append the transport footer line
  // (how the scan reached the model) when present, mirroring the PDF/MD footer.
  const transportFooter = formatTransportFooter(meta.transport);
  const txtPath = path.join(dir, `${baseName}.txt`);
  fs.writeFileSync(
    txtPath,
    stripAnsi(content) + (transportFooter ? `\n\n${transportFooter}\n` : '')
  );

  // Save MD: formatted Markdown, developer-friendly. Always Ghost
  // Architect™ branded.
  const mdContent = convertToMarkdown(content, prefix, label, meta, timestamp);
  const mdPath = path.join(dir, `${baseName}.md`);
  fs.writeFileSync(mdPath, mdContent);

  // Save PDF: Ghost Architect™ branded professional report
  const pdfPath = path.join(dir, `${baseName}.pdf`);
  const reportType = prefix === 'ghost-poi'      ? 'Points of Interest Report'
    : prefix === 'ghost-blast'    ? 'Blast Radius Analysis + Rollback Plan'
    : prefix === 'ghost-conflict' ? 'Conflict Detection Report'
    : prefix === 'ghost-recon'    ? 'Pre-Engagement Recon'
    : prefix === 'ghost-audit'    ? 'Inheritance Audit Report'
    : prefix === 'ghost-question' ? 'Question and Answer'
    : prefix === 'ghost-chat'     ? 'Chat Transcript'
    : prefix === 'ghost-forecast' ? (meta.mode === 'fix-forecast' ? 'Fix Forecast' : 'Commit Forecast')
    : prefix === 'ghost-fix-forecast-combined' ? 'Fix Forecast'
    : 'Report';

  const metaWithType = { ...meta, project: label || 'Project Analysis', reportType, version: GHOST_VERSION };

  try {
    await generatePDF(stripAnsi(content), pdfPath, metaWithType);
  } catch (err) {
    // PDF generation failed silently — TXT and MD are still saved
    console.log(chalk.gray(`  (PDF generation skipped -- ${err.message})`));
  }

  const pdfExists = fs.existsSync(pdfPath);

  // ── Findings sidecar ──────────────────────────────────────────────
  // Unlabeled scans write project: null. Ghost Brief™ and the Executive
  // Brief read this file as their input.
  //
  // Two-path Strategy 2 design (v7 unification, May 22):
  //   1. If meta.findings is a non-empty array, the mode has already
  //      produced structured findings (e.g. audit mode's deterministic
  //      analyzers via findingsFromAuditResults). Use those directly —
  //      they're the source of truth and carry severity/files/effort
  //      information the markdown parser cannot recover.
  //   2. Otherwise, fall back to buildFindingsSidecar(content) which
  //      runs extractFindings() over the raw report text. Modes that
  //      haven't been wired to populate meta.findings yet (POI, Recon,
  //      Chat, Blast, Conflict as of this commit) keep their current
  //      behavior. Blast and Conflict wirings are queued as follow-up
  //      commits matching Open's fdfebb3 pattern.
  //
  // Wire format on disk is identical regardless of path: same schema, same
  // field names. Only the source of finding data differs.
  const findingsJsonPath = path.join(dir, `${baseName}.findings.json`);
  const mode = prefix.replace(/^ghost-/, '');
  try {
    let sidecar;
    if (Array.isArray(meta.findings) && meta.findings.length > 0) {
      // Mode supplied structured findings — build sidecar from meta.
      const findings = meta.findings.map((f) => ({
        id:          f.id,
        title:       f.title,
        severity:    f.severity,
        files:       Array.isArray(f.files) ? f.files : [],
        // null, not 0, when there is no estimate. A finding the narrator never
        // detailed was never given an effort estimate, and "0 hours" reads as
        // "free to fix" rather than "not estimated".
        effortHours: typeof f.effortHours === 'number' ? f.effortHours : null,
        // Confidence is an integer 0-100. findingsFromResults was corrected
        // from 0..1 float to 0-100 integer in v9.4.14 — the float-detection
        // branch is no longer needed.
        confidence:  typeof f.confidence === 'number' ? f.confidence : 85,
        detail:      typeof f.detail === 'string' ? f.detail : '',
        fix_direction: f.fix_direction || null,
        // true  = written up in the report body.
        // false = surfaced and verified, but ranked below the narrator's prose
        //         cap, so it exists only here. Consumers rendering "the report"
        //         should show these as a supplementary list.
        // Absent for modes that never cap, where every finding is detailed.
        ...(typeof f.detailed === 'boolean' ? { detailed: f.detailed } : {}),
      }));
      const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      for (const f of findings) {
        const k = (f.severity || '').toLowerCase();
        if (counts[k] !== undefined) counts[k]++;
      }
      sidecar = {
        schema:         1,
        generatedAt:    new Date().toISOString(),
        project:        label || null,
        mode,
        totalFindings:  findings.length,
        severityCounts: counts,
        findings,
      };
    } else {
      // No structured findings in meta — fall back to markdown parsing.
      sidecar = buildFindingsSidecar(stripAnsi(content), {
        project: label || null,
        mode,
      });
    }
    // Transport metadata — how this scan reached the model (streaming vs batch).
    // Stamped onto every findings.json when the mode supplies meta.transport.
    // See src/lib/transport-meta.js for the block shape.
    if (meta.transport) sidecar.transport = meta.transport;
    fs.writeFileSync(findingsJsonPath, JSON.stringify(sidecar, null, 2));
  } catch (err) {
    // Sidecar generation is non-fatal — TXT/MD/PDF are still saved.
    console.log(chalk.gray(`  (findings.json skipped -- ${err.message})`));
  }

  // The one Ghost Open™ upgrade line, once per saved report.
  printUpgradeLine();

  return {
    filename: baseName,
    txtFile:  `${baseName}.txt`,
    mdFile:   `${baseName}.md`,
    pdfFile:  pdfExists ? `${baseName}.pdf` : null,
    txtPath,
    mdPath,
    pdfPath:  pdfExists ? pdfPath : null,
    dir:      REPORTS_DIR
  };
}

// Severity badge emoji, keyed by canonical (upper-case) severity word.
const SEVERITY_EMOJI = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🟢' };

// Convert severity words to bold, colour-badged markdown — but ONLY where the
// word is an actual severity field value, never in prose. This mirrors the
// stricter, line-oriented gate the PDF path uses (pdf-generator.js): a bare
// global replace over the whole body badges "HIGH availability", "criticality",
// "LOW latency", etc. We instead badge a severity word only when it is:
//   (1) the value following a "Severity:" label on the same line, or
//   (2) a standalone severity label occupying its own line (optionally wrapped
//       in ** or led by a "- "/"* " bullet).
// Everything else is left untouched.
export function badgeSeverities(text) {
  const badge = (w) => `${SEVERITY_EMOJI[w.toUpperCase()]} **${w.toUpperCase()}**`;
  return text.split('\n').map((line) => {
    // (1) "Severity:" field value. The label may be decorated with markdown
    // bold and spacing in several forms — "Severity: HIGH", "**Severity:** HIGH",
    // "**Severity**: HIGH", "- **Severity:** HIGH" — so allow any run of
    // stars/colons/spaces between the label word and the value.
    const field = line.replace(
      /(Severity[\s*:]*)(CRITICAL|HIGH|MEDIUM|LOW)\b/i,
      (_m, pre, word) => pre + badge(word)
    );
    if (field !== line) return field;
    // (2) Standalone severity label — the whole line is just the word.
    return line.replace(
      /^(\s*(?:[-*]\s+)?)(?:\*\*)?(CRITICAL|HIGH|MEDIUM|LOW)(?:\*\*)?(\s*)$/i,
      (_m, pre, word, post) => pre + badge(word) + post
    );
  }).join('\n');
}

function convertToMarkdown(content, prefix, label, meta, timestamp = null) {
  const clean = stripAnsi(content);
  const date = new Date().toLocaleString();

  // Build report type label
  const typeLabel = prefix === 'ghost-poi'      ? 'Points of Interest Report'
    : prefix === 'ghost-blast'    ? 'Blast Radius Analysis'
    : prefix === 'ghost-conflict' ? 'Conflict Detection Report'
    : prefix === 'ghost-recon'    ? 'Pre-Engagement Recon'
    : prefix === 'ghost-audit'    ? 'Inheritance Audit Report'
    : prefix === 'ghost-question' ? 'Question and Answer'
    : prefix === 'ghost-chat'     ? 'Chat Transcript'
    : prefix === 'ghost-forecast' ? (meta.mode === 'fix-forecast' ? 'Fix Forecast' : 'Commit Forecast')
    : prefix === 'ghost-fix-forecast-combined' ? 'Fix Forecast'
    : 'Report';

  // ── Header ──────────────────────────────────────────────────────────────
  // Always Ghost Architect™ branding.
  let md = '';
  md += `# Ghost Architect™ -- ${typeLabel}\n\n`;

  // ── Metadata table ─────────────────────────────────────────────────────
  md += `| | |\n|---|---|\n`;
  md += `| **Project** | ${label || 'Unnamed project'} |\n`;
  md += `| **Generated** | ${date} |\n`;
  if (meta.filesAnalyzed) md += `| **Files Analyzed** | ${meta.filesAnalyzed} |\n`;
  if (meta.totalFiles)    md += `| **Total Files in Project** | ${meta.totalFiles} |\n`;
  if (meta.cost)          md += `| **Analysis Cost** | $${meta.cost} |\n`;
  md += `| **Tool** | Ghost Architect™ v${GHOST_VERSION} |\n`;
  md += `| **Copyright** | © 2026 Ghost Architect™. All rights reserved. |\n`;
  md += `\n---\n\n`;

  // Convert content — clean up terminal formatting for Markdown
  let body = clean
    // Headers
    .replace(/^# (.+)$/gm, '# $1')
    .replace(/^## (.+)$/gm, '## $1')
    .replace(/^### (.+)$/gm, '### $1');
  // Severity badges — anchored to field values only, never prose (see
  // badgeSeverities). Prior code global-replaced severity words across the
  // whole body, badging "HIGH availability", "criticality", "LOW latency".
  body = badgeSeverities(body);
  body = body
    // Section dividers
    .replace(/^---+$/gm, '\n---\n')
    // Clean up excessive blank lines
    .replace(/\n{4,}/g, '\n\n\n');

  md += body;

  // ── Footer ──────────────────────────────────────────────────────────────
  md += `\n\n---\n\n`;
  md += `*Generated by Ghost Architect™ -- AI-powered codebase intelligence*  \n`;
  md += `*ghostarchitect.dev*\n`;

  // Transport footer line — how the scan reached the model (streaming vs batch).
  // Rendered only when meta.transport is present; mirrors the PDF footer.
  const transportFooter = formatTransportFooter(meta.transport);
  if (transportFooter) {
    md += `\n${transportFooter}\n`;
  }

  // The Ghost Open™ upgrade line is always the last footer line.
  md += `\n${UPGRADE_LINE}\n`;

  return md;
}

// listReports() was removed in v11.0.0 (Audit 8, quick win 13): it was an
// exported API with zero callers anywhere in the tree, and if ever wired
// as-is it would have listed every report twice (both .txt and .md pass the
// filter) plus the -unsaved- recovery files. Dead code describing a behavior
// contract misleads the next reader; rebuild deliberately if a "View saved
// reports" feature lands.

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

export { REPORTS_DIR, convertToMarkdown };
