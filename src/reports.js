import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { generatePDF } from './pdf-generator.js';
import { getBranding } from './profile/index.js';
import { isTrialActive, getActiveLicense, getActiveTier } from './license/session.js';
import { isPortalConfigured, publishToPortal, buildFindingsSidecar } from './core/portal-publish.js';
import { isTeamConfigured } from './config.js';
import { pushReport } from './core/team-sync.js';
import { appendAuditEvent } from './core/enterprise.js';
import { isPublishConfigured, publishProject } from './core/mobile-publish.js';
import { sanitizeForDebugLog } from './core/agent/verifier.js';
import { incrementScanCount } from './freemium.js';
import { formatTransportFooter } from './lib/transport-meta.js';
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

// Ghost Architect v7 unification: filename convention dispatches on label
// presence, not tier. The CLI layer (bin/ghost.js, mode files) decides whether
// to pass a label based on tier and user input. saveReport itself is tier-blind
// on filename behavior — the parameter shape captures intent.
//
//   label present → history-tracked + grouped: ${prefix}-${slug}-${timestamp}.{ext}
//                   Pro/Team/Enterprise project intelligence flow.
//
//   label absent  → unlabeled scan: ${prefix}-${timestamp}.{ext}
//                   Open's freemium flow (label prompt gated per D4 in Phase 2).
//                   Also paid-tier users who skipped labeling for a one-off run.
//                   Each scan gets a unique filename; no silent overwrites.
//
// Per-tier side effects (team-sync, mobile-publish, portal-publish) are gated
// by their existing `if (label && isXConfigured())` checks below — null label
// still short-circuits all three even though filenames now always carry
// a timestamp. The D4 architectural decision (Phase 2: gate at mode-file
// level, not in saveReport) remains intact. Phase 3 owns defense-in-depth
// gating per TODO-architect-savereport-defense-in-depth-tier-gating-phase3.md.

// Append a paid-tier integration failure (team-sync, mobile-publish,
// portal-publish) to the debug directory for post-mortem diagnosis. These
// pushes race against a timeout and the loser's rejection used to be swallowed
// in a bare catch — the user saw "Report saved" while the sync never happened.
// The error is sanitized first so tokens, connection strings, and usernames
// never reach disk (GB-007). Best-effort: if even the debug log can't be
// written, there is nothing more we can do, so swallow that secondary failure.
function logIntegrationFailure(integration, timeoutSeconds, err) {
  try {
    const debugDir = path.join(os.homedir(), 'Ghost Architect Reports', '.debug');
    fs.mkdirSync(debugDir, { recursive: true });
    const logPath = path.join(debugDir, 'integration-failures.log');
    const message = sanitizeForDebugLog(err && err.message ? err.message : String(err));
    const stack = err && err.stack ? sanitizeForDebugLog(err.stack) : null;
    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] ${integration} FAILED (timeout ${timeoutSeconds}s): ${message}\n` +
      (stack ? `${stack}\n` : '')
    );
  } catch { /* debug logging is best-effort — never throw from here */ }
}

export async function saveReport(content, prefix, label, meta = {}) {
  const dir = ensureReportsDir();

  // ── Filename: always timestamp; label adds slug when present ──────
  // Pre-Phase-2 design treated bare-prefix filenames as a deliberate
  // "one-off throwaway" UX choice — users who wanted history typed a
  // label, users who wanted no-clutter pressed Enter. Phase 2 gated the
  // label prompt on Open (D4 leak fix), removing Open users' opt-in
  // path. The bare-prefix behavior then ALWAYS fired on Open scans,
  // silently overwriting prior reports on every re-scan. Data loss
  // beats disk clutter; timestamps now always append. Paid-tier users
  // who skip the label prompt get ${prefix}-${timestamp} instead of
  // overwriting — slightly more files in the reports dir, no data loss.
  // Closes TODO-architect-conflict-bare-filename.md (filed 2026-05-22,
  // expanded to 5 modes 2026-05-24 during Phase 2 mode-file work).
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
    : prefix === 'ghost-question' ? 'Question and Answer'
    : prefix === 'ghost-chat'     ? 'Chat Transcript'
    : prefix === 'ghost-forecast' ? (meta.mode === 'fix-forecast' ? 'Fix Forecast' : 'Commit Forecast')
    : prefix === 'ghost-fix-forecast-combined' ? 'Fix Forecast'
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
    await generatePDF(stripAnsi(content), pdfPath, metaWithType);
  } catch (err) {
    // PDF generation failed silently — TXT and MD are still saved
    console.log(chalk.gray(`  (PDF generation skipped -- ${err.message})`));
  }

  const pdfExists = fs.existsSync(pdfPath);

  // ── Findings sidecar ──────────────────────────────────────────────
  // Generate findings.json BEFORE any push side-effect so team-sync,
  // mobile-publish, and portal-publish can all reference the same sidecar
  // file. Open users (label absent) still generate the sidecar with
  // project: null — Jira export downstream handles null project as
  // "unlabeled scan" fallback.
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
  // Wire format on disk is identical regardless of path — same schema,
  // same field names, same shape downstream consumers (Mobile, Portal,
  // Jira export) already read. Only the source of finding data differs.
  const findingsJsonPath = path.join(dir, `${baseName}.findings.json`);
  const mode = prefix.replace(/^ghost-/, '');
  let findingsSidecarWritten = false;
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
    findingsSidecarWritten = true;
  } catch (err) {
    // Sidecar generation is non-fatal — TXT/MD/PDF are still saved.
    console.log(chalk.gray(`  (findings.json skipped -- ${err.message})`));
  }

  // ── Team Sync ─────────────────────────────────────────────────────
  // Push reports to the shared GitHub repo so other seats can read them.
  // Audit-log the scan event (currently Team-gated; see
  // TODO-architect-audit-log-tier-gating-ambiguity.md for resolution path
  // with first Enterprise customer). Both calls fail silently.
  if (label && isTeamConfigured()) {
    const projectSlug = label.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
    const SYNC_TIMEOUT_S = 60;
    let syncFailed = false;
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
        setTimeout(() => reject(new Error(`team-sync push timeout after ${SYNC_TIMEOUT_S}s`)), SYNC_TIMEOUT_S * 1000)
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
    } catch (err) {
      // Sync failure is non-fatal to the local save, but it must not be
      // silent: the report is on disk yet other seats will never see it.
      syncFailed = true;
      logIntegrationFailure('team-sync', SYNC_TIMEOUT_S, err);
    }
    if (syncFailed) {
      console.log(chalk.yellow(
        `  ${SYM.warn}  Team sync did not complete (timed out after ${SYNC_TIMEOUT_S}s or the push failed).\n` +
        `     Your report is saved locally, but other seats won't see this scan yet.\n` +
        `     Re-run the scan or check your GitHub token. Details logged to\n` +
        `     ~/Ghost Architect Reports/.debug/integration-failures.log\n`
      ));
    }
  }

  // ── Ghost Mobile: auto-publish if configured ──────────────────────
  // Build a structured JSON payload with current scan + baseline + history
  // and push to the ghost-reports GitHub repo. Mobile app reads from there.
  if (label && isPublishConfigured()) {
    const PUBLISH_TIMEOUT_S = 90;
    let mobileFailed = false;
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
        setTimeout(() => reject(new Error(`mobile-publish timeout after ${PUBLISH_TIMEOUT_S}s`)), PUBLISH_TIMEOUT_S * 1000)
      );
      await Promise.race([publishProject(projectMeta, scanRecord), publishTimeout]);
    } catch (err) {
      // Publish failure is non-fatal to the local save, but it must not be
      // silent: the scan won't appear in Ghost Mobile until it's re-published.
      mobileFailed = true;
      logIntegrationFailure('mobile-publish', PUBLISH_TIMEOUT_S, err);
    }
    if (mobileFailed) {
      console.log(chalk.yellow(
        `  ${SYM.warn}  Mobile publish did not complete (timed out after ${PUBLISH_TIMEOUT_S}s or the push failed).\n` +
        `     Your report is saved locally, but this scan won't appear in Ghost Mobile yet.\n` +
        `     Re-run the scan or check your GitHub token. Details logged to\n` +
        `     ~/Ghost Architect Reports/.debug/integration-failures.log\n`
      ));
    }
  }

  // ── Portal Publish ────────────────────────────────────────────────
  // Push report files + findings.json sidecar + manifest entry to the
  // ghost-reports-portal-test repo. The web portal at ghostarchitect.dev
  // reads from this repo via the signup.ghostarchitect.dev Worker. This
  // is what makes scans appear on the portal (and what makes the Jira
  // export buttons render — they only show when findings.json exists).
  //
  // Fires whenever portal is configured, regardless of label presence.
  // Anonymous (one-time) scans land in the manifest as project
  // "(untitled)" via buildManifestEntry fallbacks in core/portal-publish.js.
  // Team-sync, mobile-publish, and audit-log above remain label-gated
  // (paid-tier integrations); portal is broadly available so should reach
  // every scan including Open tier where labels are never prompted.
  if (isPortalConfigured()) {
    const PORTAL_TIMEOUT_S = 120;
    let portalFailed = false;
    try {
      const portalTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`portal-publish timeout after ${PORTAL_TIMEOUT_S}s`)), PORTAL_TIMEOUT_S * 1000)
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
    } catch (err) {
      // Portal failure is non-fatal to the local save, but it must not be
      // silent: the scan won't appear on the web portal until it's re-published.
      portalFailed = true;
      logIntegrationFailure('portal-publish', PORTAL_TIMEOUT_S, err);
    }
    if (portalFailed) {
      console.log(chalk.yellow(
        `  ${SYM.warn}  Portal publish did not complete (timed out after ${PORTAL_TIMEOUT_S}s or the push failed).\n` +
        `     Your report is saved locally, but this scan won't appear on the portal yet.\n` +
        `     Re-run the scan or check your GitHub token. Details logged to\n` +
        `     ~/Ghost Architect Reports/.debug/integration-failures.log\n`
      ));
    }
  }

  // ── Freemium scan counter (Open tier ONLY) ────────────────────────
  // Stays here in Stage 2 of v7 unification. Stage 3 deletes the freemium
  // module entirely and replaces this call with the requireTier('open')
  // flow that handles counting internally (or eliminates the count
  // mechanism — decision deferred to Stage 3).
  //
  // The tier check is load-bearing, not a micro-optimization. This counter
  // used to bump on EVERY save regardless of tier, so trial and paid scans
  // drained the Open quota that only Open tier ever reads. A 7-day Pro Max
  // trial burning four scans left the user at the Open wall the instant the
  // trial lapsed — a paywall at the exact moment we are asking for the sale,
  // for scans they never spent free quota on. Only count what Open spends.
  const activeTier = getActiveTier() || 'open';
  if (activeTier === 'open') {
    try {
      incrementScanCount(prefix);
    } catch {
      // Freemium counter is non-essential; never block the save on it.
    }
  }

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

function convertToMarkdown(content, prefix, label, meta, timestamp = null, branding = null) {
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
  // White-label mode: header carries the consultant's branding, no Ghost.
  // Default mode: header carries Ghost Architect branding.
  let md = '';
  if (branding && branding.isWhiteLabeled) {
    md += `# ${branding.companyName} -- ${typeLabel}\n\n`;
    if (branding.methodology) md += `**Methodology:** ${branding.methodology}  \n`;
    if (branding.author)      md += `**Prepared by:** ${branding.author}  \n`;
    if (branding.description) md += `*${branding.description}*\n`;
    md += `\n`;
  } else {
    md += `# Ghost Architect™ -- ${typeLabel}\n\n`;
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
    md += `| **Tool** | Ghost Architect™ v${GHOST_VERSION} |\n`;
    md += `| **Copyright** | © 2026 Ghost Architect™. All rights reserved. |\n`;
  }
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
  if (branding && branding.isWhiteLabeled) {
    md += `*${branding.footerText}*  \n`;
    if (branding.author && branding.author !== branding.footerText) {
      md += `*Prepared by ${branding.author}*\n`;
    }
  } else {
    md += `*Generated by Ghost Architect™ -- AI-powered codebase intelligence*  \n`;
    md += `*ghostarchitect.dev*\n`;
  }

  // Transport footer line — how the scan reached the model (streaming vs batch).
  // Rendered only when meta.transport is present; mirrors the PDF footer.
  const transportFooter = formatTransportFooter(meta.transport);
  if (transportFooter) {
    md += `\n${transportFooter}\n`;
  }

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
