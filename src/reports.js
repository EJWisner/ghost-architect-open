import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { generatePDF } from './pdf-generator.js';
import { getBranding } from './profile/index.js';
import { isTrialActive, getActiveLicense } from './license/session.js';
import { isPortalConfigured, publishToPortal, buildFindingsSidecar } from './core/portal-publish.js';
import { isTeamConfigured } from './config.js';
import { pushReport } from './core/team-sync.js';
import { appendAuditEvent } from './core/enterprise.js';
import { isPublishConfigured, publishProject } from './core/mobile-publish.js';
import { incrementScanCount } from './freemium.js';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version: GHOST_VERSION } = _require('../package.json');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPORTS_DIR = path.join(os.homedir(), 'Ghost Architect Reports');

export function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    console.log(chalk.gray(`  ✓ Created reports folder: ~/Ghost Architect Reports\n`));
  }
  return REPORTS_DIR;
}

// Ghost Architect v7 unification: filename convention dispatches on label
// presence, not tier. The CLI layer (bin/ghost.js, mode files) decides whether
// to pass a label based on tier and user input. saveReport itself is tier-blind
// on filename behavior — the parameter shape captures intent.
//
//   label present → history-tracked: ${prefix}-${label}-${timestamp}.{ext}
//                   Pro/Team/Enterprise project intelligence flow.
//
//   label absent  → one-off scan: ${prefix}.{ext}, overwrites on every run.
//                   Open's freemium flow. Also used by Pro/Team users running
//                   throwaway scans they don't want cluttering their reports
//                   dir with timestamps.
//
// Per-tier side effects (team-sync, mobile-publish, portal-publish) are gated
// by their existing isXConfigured() checks below. Stage 3 of v7 unification
// will rewire those gates as requireTier() calls; until then, behavior
// matches v6.0.1 exactly for each tier's already-configured customer.
export async function saveReport(content, prefix, label, meta = {}) {
  const dir = ensureReportsDir();
  console.error('DEBUG-v7-DIAG: [reports.js:saveReport-entry] saveReport entered');

  // ── Filename: dispatch by label presence ──────────────────────────
  let baseName;
  let timestamp;
  if (label) {
    timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = label.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 30);
    baseName = `${prefix}-${safeName}-${timestamp}`;
  } else {
    timestamp = null;
    baseName = prefix;
  }

  // Save TXT — plain text, terminal-friendly
  const txtPath = path.join(dir, `${baseName}.txt`);
  fs.writeFileSync(txtPath, stripAnsi(content));

  // Save MD — formatted Markdown, developer-friendly (or consultant-friendly
  // when a profile is active). getBranding(undefined) returns null cleanly,
  // so Open users with no profile get the no-branding render naturally.
  const branding = getBranding(meta.profile);
  const mdContent = convertToMarkdown(content, prefix, label, meta, timestamp, branding);
  const mdPath = path.join(dir, `${baseName}.md`);
  fs.writeFileSync(mdPath, mdContent);

  // Save PDF — branded professional report, client-friendly
  const pdfPath = path.join(dir, `${baseName}.pdf`);
  const reportType = prefix === 'ghost-poi'      ? 'Points of Interest Report'
    : prefix === 'ghost-blast'    ? 'Blast Radius Analysis + Rollback Plan'
    : prefix === 'ghost-conflict' ? 'Conflict Detection Report'
    : prefix === 'ghost-recon'    ? 'Pre-Engagement Recon'
    : prefix === 'ghost-audit'    ? 'Inheritance Audit Report'
    : prefix === 'ghost-chat'     ? 'Chat Transcript'
    : 'Report';

  // Pull trial state from the active license session so PDFs generated under
  // a trial license get watermarked. The active license is set once at CLI
  // startup by bin/ghost.js and persists through all mode invocations.
  // For Open users (no active license), isTrialActive() returns false and
  // trialMeta defaults to { trial: false } — no watermark, clean render.
  const trial = isTrialActive();
  const activeLicense = getActiveLicense();
  const trialMeta = trial && activeLicense && activeLicense.payload
    ? {
        trial: true,
        trialLicenseId: activeLicense.payload.lid,
        trialExpires: activeLicense.payload.expires,
      }
    : { trial: false };

  const metaWithType = { ...meta, project: label || 'Project Analysis', reportType, version: GHOST_VERSION, branding, ...trialMeta };

  try {
    console.error('DEBUG-v7-DIAG: [reports.js pre-generatePDF] about to call generatePDF');
    await generatePDF(stripAnsi(content), pdfPath, metaWithType);
    console.error('DEBUG-v7-DIAG: [reports.js post-generatePDF] generatePDF resolved');
  } catch (err) {
    // PDF generation failed silently — TXT and MD are still saved
    console.log(chalk.gray(`  (PDF generation skipped — ${err.message})`));
  }

  const pdfExists = fs.existsSync(pdfPath);

  // ── Findings sidecar ──────────────────────────────────────────────
  // Generate findings.json BEFORE any push side-effect so team-sync,
  // mobile-publish, and portal-publish can all reference the same sidecar
  // file. Build from the raw content (not the MD with its severity-emoji
  // rewrites) so the parser sees the original tokens. Open users (label
  // absent) still generate the sidecar with project: null — Jira export
  // downstream handles null project as "unlabeled scan" fallback.
  const findingsJsonPath = path.join(dir, `${baseName}.findings.json`);
  const mode = prefix.replace(/^ghost-/, '');
  let findingsSidecarWritten = false;
  try {
    const sidecar = buildFindingsSidecar(stripAnsi(content), {
      project: label || null,
      mode,
    });
    fs.writeFileSync(findingsJsonPath, JSON.stringify(sidecar, null, 2));
    findingsSidecarWritten = true;
  } catch (err) {
    // Sidecar generation is non-fatal — TXT/MD/PDF are still saved.
    console.log(chalk.gray(`  (findings.json skipped — ${err.message})`));
  }

  // ── Team Sync ─────────────────────────────────────────────────────
  // Push reports to the shared GitHub repo so other seats can read them.
  // Audit-log the scan event (currently Team-gated; see
  // TODO-architect-audit-log-tier-gating-ambiguity.md for resolution path
  // with first Enterprise customer). Both calls fail silently.
  console.error('DEBUG-v7-DIAG: [reports.js pre-team-sync-block] entering team-sync gate');
  if (label && isTeamConfigured()) {
    const projectSlug = label.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
    try {
      const pushJobs = [
        pushReport(projectSlug, txtPath),
        pushReport(projectSlug, mdPath),
        ...(pdfExists ? [pushReport(projectSlug, pdfPath)] : []),
        ...(findingsSidecarWritten ? [pushReport(projectSlug, findingsJsonPath)] : []),
      ];
      // Race against a 60-second timeout. Sync is non-essential — better
      // to skip and let the user move on than to block forever on a
      // network/GitHub issue.
      const syncTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('team-sync push timeout after 60s')), 60000)
      );
      await Promise.race([Promise.all(pushJobs), syncTimeout]);
      await Promise.race([
        appendAuditEvent({
          type: 'scan',
          projectLabel: label,
          reportFile: pdfExists ? `${baseName}.pdf` : `${baseName}.md`,
          cost: meta.cost || null,
          findingCount: meta.findingCount || null,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('audit log timeout after 30s')), 30000)),
      ]);
    } catch {
      // Sync failure is non-fatal
    }
  }
  console.error('DEBUG-v7-DIAG: [reports.js post-team-sync-block] team-sync block exited');

  // ── Ghost Mobile: auto-publish if configured ──────────────────────
  // Build a structured JSON payload with current scan + baseline + history
  // and push to the ghost-reports GitHub repo. Mobile app reads from there.
  console.error('DEBUG-v7-DIAG: [reports.js pre-mobile-publish-block] entering mobile-publish gate');
  if (label && isPublishConfigured()) {
    try {
      const projectSlug = label.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);

      // Load full project.json to get real scan history and baseline findings.
      // This is what populates the History tab and drill-down screens in Ghost Mobile.
      const projectJsonPath = path.join(
        os.homedir(), 'Ghost Architect Reports', 'projects',
        projectSlug, 'project.json'
      );
      let storedProject = null;
      try {
        if (fs.existsSync(projectJsonPath)) {
          storedProject = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
        }
      } catch { /* non-fatal — publish continues without history */ }

      const projectMeta = {
        label,
        slug:             projectSlug,
        baselineDate:     storedProject?.baselineDate     || meta.baselineDate || null,
        baselineCount:    meta.baselineCount              || meta.findingCount || 0,
        baselineFindings: storedProject?.baselineFindings || [],
        scans:            storedProject?.scans            || [],
      };

      const scanRecord = {
        date:         new Date().toISOString(),
        version:      GHOST_VERSION,
        findingCount: meta.findingCount || 0,
        critical:     meta.critical     || 0,
        high:         meta.high         || 0,
        medium:       meta.medium       || 0,
        low:          meta.low          || 0,
        totalHours:   meta.totalHours   || 0,
        totalCost:    meta.totalCost    || 0,
        newFindings:  meta.newFindings  || 0,
        resolved:     meta.resolved     || 0,
        txtFile:      `${baseName}.txt`,
        mdFile:       `${baseName}.md`,
        pdfFile:      pdfExists ? `${baseName}.pdf` : null,
        cost:         meta.cost         || null,
        reportText:   stripAnsi(content),
      };

      // Race against a 90-second timeout. Mobile publish does more work
      // than team-sync (loads + posts a richer payload), so allow more
      // time, but still bounded so the save doesn't hang the CLI forever.
      const publishTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('mobile-publish timeout after 90s')), 90000)
      );
      await Promise.race([publishProject(projectMeta, scanRecord), publishTimeout]);
    } catch {
      // Publish failure is non-fatal
    }
  }
  console.error('DEBUG-v7-DIAG: [reports.js post-mobile-publish-block] mobile-publish block exited');

  // ── Portal Publish ────────────────────────────────────────────────
  // Push report files + findings.json sidecar + manifest entry to the
  // ghost-reports-portal-test repo. The web portal at ghostarchitect.dev
  // reads from this repo via the signup.ghostarchitect.dev Worker. This
  // is what makes scans appear on the portal (and what makes the Jira
  // export buttons render — they only show when findings.json exists).
  console.error('DEBUG-v7-DIAG: [reports.js pre-portal-publish-block] entering portal gate');
  if (label && isPortalConfigured()) {
    try {
      const portalTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('portal-publish timeout after 120s')), 120000)
      );
      await Promise.race([
        publishToPortal({
          baseName,
          mode,
          label,
          txtPath,
          mdPath,
          pdfPath:          pdfExists ? pdfPath : null,
          findingsJsonPath: findingsSidecarWritten ? findingsJsonPath : null,
          reportText:       stripAnsi(content),
          scanIso:          new Date().toISOString(),
        }),
        portalTimeout,
      ]);
    } catch {
      // Portal failure is non-fatal — local save and other pushes succeeded.
    }
  }
  console.error('DEBUG-v7-DIAG: [reports.js post-portal-publish-block] portal block exited');

  // ── Freemium scan counter (Open tier) ─────────────────────────────
  // Stays here in Stage 2 of v7 unification. Stage 3 deletes the freemium
  // module entirely and replaces this call with the requireTier('open')
  // flow that handles counting internally (or eliminates the count
  // mechanism — decision deferred to Stage 3). Current behavior preserved
  // for Open users running v7 without an activated license.
  try {
    incrementScanCount();
  } catch {
    // Freemium counter is non-essential; never block the save on it.
  }

  console.error('DEBUG-v7-DIAG: [reports.js pre-return] about to return from saveReport');
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

function convertToMarkdown(content, prefix, label, meta, timestamp = null, branding = null) {
  const clean = stripAnsi(content);
  const date = new Date().toLocaleString();

  // Build report type label
  const typeLabel = prefix === 'ghost-poi'      ? 'Points of Interest Report'
    : prefix === 'ghost-blast'    ? 'Blast Radius Analysis'
    : prefix === 'ghost-conflict' ? 'Conflict Detection Report'
    : prefix === 'ghost-recon'    ? 'Pre-Engagement Recon'
    : prefix === 'ghost-audit'    ? 'Inheritance Audit Report'
    : prefix === 'ghost-chat'     ? 'Chat Transcript'
    : 'Report';

  // ── Header ──────────────────────────────────────────────────────────────
  // White-label mode: header carries the consultant's branding, no Ghost.
  // Default mode: header carries Ghost Architect branding.
  let md = '';
  if (branding && branding.isWhiteLabeled) {
    md += `# ${branding.companyName} — ${typeLabel}\n\n`;
    if (branding.methodology) md += `**Methodology:** ${branding.methodology}  \n`;
    if (branding.author)      md += `**Prepared by:** ${branding.author}  \n`;
    if (branding.description) md += `*${branding.description}*\n`;
    md += `\n`;
  } else {
    md += `# Ghost Architect — ${typeLabel}\n\n`;
  }

  // ── Metadata table ─────────────────────────────────────────────────────
  md += `| | |\n|---|---|\n`;
  md += `| **Project** | ${label || 'Unnamed project'} |\n`;
  md += `| **Generated** | ${date} |\n`;
  if (meta.filesAnalyzed) md += `| **Files Analyzed** | ${meta.filesAnalyzed} |\n`;
  if (meta.totalFiles)    md += `| **Total Files in Project** | ${meta.totalFiles} |\n`;
  if (meta.cost)          md += `| **Analysis Cost** | $${meta.cost} |\n`;
  if (branding && branding.isWhiteLabeled) {
    if (branding.companyName) md += `| **Prepared by** | ${branding.companyName} |\n`;
    md += `| **Confidentiality** | ${branding.confidentiality} |\n`;
  } else {
    md += `| **Tool** | Ghost Architect v${GHOST_VERSION} |\n`;
    md += `| **Copyright** | © 2026 Ghost Architect. All rights reserved. |\n`;
  }
  md += `\n---\n\n`;

  // Convert content — clean up terminal formatting for Markdown
  let body = clean
    // Headers
    .replace(/^# (.+)$/gm, '# $1')
    .replace(/^## (.+)$/gm, '## $1')
    .replace(/^### (.+)$/gm, '### $1')
    // Severity badges — convert to bold colored text
    .replace(/CRITICAL/g, '🔴 **CRITICAL**')
    .replace(/\bHIGH\b/g, '🟠 **HIGH**')
    .replace(/\bMEDIUM\b/g, '🟡 **MEDIUM**')
    .replace(/\bLOW\b/g, '🟢 **LOW**')
    // Section dividers
    .replace(/^---+$/gm, '\n---\n')
    // Clean up excessive blank lines
    .replace(/\n{4,}/g, '\n\n\n');

  md += body;

  // ── Footer ──────────────────────────────────────────────────────────────
  md += `\n\n---\n\n`;
  if (branding && branding.isWhiteLabeled) {
    md += `*${branding.footerText}*  \n`;
    if (branding.author && branding.author !== branding.footerText) {
      md += `*Prepared by ${branding.author}*\n`;
    }
  } else {
    md += `*Generated by Ghost Architect — AI-powered codebase intelligence*  \n`;
    md += `*ghostarchitect.dev*\n`;
  }

  return md;
}

export function listReports() {
  const dir = ensureReportsDir();
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.txt') || f.endsWith('.md'))
    .map(f => ({
      name: f,
      path: path.join(dir, f),
      modified: fs.statSync(path.join(dir, f)).mtime
    }))
    .sort((a, b) => b.modified - a.modified);
  return files;
}

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

export { REPORTS_DIR, convertToMarkdown };
