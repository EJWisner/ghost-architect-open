/**
 * Ghost Watcher™ — watcher-commit mode
 * Headless CI pipeline. Triggered by `ghost --watcher-commit` inside GitHub Actions.
 *
 * Pipeline:
 *   1. Read ghost-watcher.yaml from repo root
 *   2. Identify changed files via git diff
 *   3. Load codebase context
 *   4. Run Blast Radius on changed files
 *   5. Run Conflict Detection on changed files
 *   6. Generate Ghost Brief prompt pack
 *   7. Push results to portal repo (ghost-reports)
 *   8. Post PR comment (if pr_comment: true)
 *   9. Exit 0 always — Ghost Watcher never blocks a commit
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { createOctokit } from '../utils/octokit-client.js';
import { getPortalConfig, isPortalConfigured } from '../core/portal-publish.js';
import { loadProfile, getBranding } from '../profile/index.js';
import { getDefaultProfileSlug } from '../config.js';
import { loadFromPath } from '../loader/index.js';
import { runBlastRadius } from '../analyst/index.js';
import { runConflictScan } from '../core/conflict.js';
import { extractFindings } from '../utils/finding-parser.js';
import { normalizeCandidateToFinding } from '../core/conflict.js';
import { fromPOI, fromConflict } from '../../lib/ghostBriefAdapter.js';

// ── Constants ────────────────────────────────────────────────────────────────

const WATCH_CONFIG_FILE = 'ghost-watcher.yaml';
const WATCH_SCHEMA_VERSION = '1.0';

// ── Config reader ─────────────────────────────────────────────────────────────

/**
 * Read and validate ghost-watcher.yaml from the repo root.
 * Throws with a clear message if the file is missing or malformed.
 */
export function readWatchConfig(repoRoot = process.cwd()) {
  const configPath = path.join(repoRoot, WATCH_CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Ghost Watcher: ${WATCH_CONFIG_FILE} not found in ${repoRoot}.\n` +
      `Run 'ghost' and select Ghost Watcher > Enable Watch to set up.`
    );
  }

  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Ghost Watcher: failed to parse ${WATCH_CONFIG_FILE}: ${err.message}`);
  }

  const cfg = raw?.ghost_watcher;
  if (!cfg) {
    throw new Error(`Ghost Watcher: ${WATCH_CONFIG_FILE} must have a top-level 'ghost_watcher:' key.`);
  }

  if (cfg.enabled === false) {
    throw new Error(`Ghost Watcher: Watch is disabled in ${WATCH_CONFIG_FILE}. Set enabled: true to activate.`);
  }

  return cfg;
}

// ── Git diff ──────────────────────────────────────────────────────────────────

/**
 * Identify changed files for this CI event.
 *
 * GitHub Actions sets GITHUB_EVENT_NAME:
 *   push            — diff HEAD~1..HEAD
 *   pull_request    — diff origin/<base>...HEAD (full PR diff)
 *
 * Returns an array of relative file paths that exist on disk (deleted
 * files are excluded — nothing to analyze).
 */
export function getChangedFiles(repoRoot = process.cwd()) {
  const eventName = process.env.GITHUB_EVENT_NAME || 'push';
  const baseRef   = process.env.GITHUB_BASE_REF;   // set on pull_request events

  let diffCmd;
  if (eventName === 'pull_request' && baseRef) {
    diffCmd = `git diff origin/${baseRef}...HEAD --name-only`;
  } else {
    // push event or fallback
    diffCmd = `git diff HEAD~1 HEAD --name-only`;
  }

  let output;
  try {
    output = execSync(diffCmd, { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    // On the very first commit HEAD~1 does not exist — fall back to all tracked files
    try {
      output = execSync('git diff --cached --name-only', { cwd: repoRoot, encoding: 'utf8' });
    } catch {
      return [];
    }
  }

  const allChanged = output
    .split('\n')
    .map(f => f.trim())
    .filter(Boolean);

  // Filter to files that actually exist (skip deleted files)
  return allChanged.filter(f => fs.existsSync(path.join(repoRoot, f)));
}

// ── Developer identity ────────────────────────────────────────────────────────

/**
 * Resolve developer identity from environment or git config.
 * Identity matched on email for platform-agnostic team routing.
 */
export function resolveDeveloperIdentity() {
  // Explicit override via env — useful for bot commits or shared CI
  const envId = process.env.GHOST_DEVELOPER_ID;
  if (envId) {
    const [name, email] = envId.split('|').map(s => s.trim());
    return { name: name || envId, email: email || envId };
  }

  try {
    const name  = execSync('git config user.name',  { encoding: 'utf8' }).trim();
    const email = execSync('git config user.email', { encoding: 'utf8' }).trim();
    return { name, email };
  } catch {
    return { name: 'unknown', email: 'unknown' };
  }
}

// ── Portal repo push ──────────────────────────────────────────────────────────

/**
 * Slugify an email for use as a directory name.
 * ed@acme.com -> ed-at-acme-com
 */
function emailToSlug(email) {
  return (email || 'unknown')
    .replace('@', '-at-')
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase();
}

/**
 * Push a Watch result JSON to the portal repo via GitHub API.
 * Uses upsertFile pattern from portal-publish.js.
 *
 * Path: projects/<projectSlug>/scans/watch/<developerSlug>/<filename>
 */
async function upsertPortalFile(octokit, owner, repo, filePath, content, message) {
  // Get existing sha for conditional update
  let sha = null;
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    sha = data.sha;
  } catch { /* file does not exist yet — create it */ }

  const encoded = Buffer.isBuffer(content)
    ? content.toString('base64')
    : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2)).toString('base64');

  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo,
    path: filePath,
    message,
    content: encoded,
    ...(sha ? { sha } : {}),
  });
}

// ── PR comment ────────────────────────────────────────────────────────────────

/**
 * Post a Ghost Watcher summary comment on the PR that triggered this run.
 * Uses GITHUB_TOKEN (provided automatically by GitHub Actions).
 * No-ops gracefully if PR context is not available.
 */
async function postPRComment({ findings, blastFileCount, briefPromptCount, portalUrl, clean = false }) {
  const prToken = process.env.GHOST_PR_TOKEN || process.env.GITHUB_TOKEN;
  if (!prToken) return;

  // GitHub Actions sets GITHUB_REPOSITORY and GITHUB_REF for PR events
  const repository = process.env.GITHUB_REPOSITORY; // owner/repo
  const sha        = process.env.GITHUB_SHA         || 'unknown';
  const refName    = process.env.GITHUB_REF_NAME    || process.env.GITHUB_HEAD_REF || 'unknown';
  const actor      = process.env.GITHUB_ACTOR       || 'unknown';

  if (!repository) return; // not running in GitHub Actions

  // Extract PR number from GITHUB_REF (refs/pull/123/merge)
  const prMatch = (process.env.GITHUB_REF || '').match(/refs\/pull\/(\d+)\//);
  if (!prMatch) return; // push event, not a PR — no comment to post

  // Zero findings — post clean green comment and return
  if (clean) {
    try {
      const octokit = createOctokit({ auth: prToken });
      const [owner, repo] = repository.split('/');
      const prNumber = parseInt(prMatch[1], 10);
      const shortSha = sha.slice(0, 7);
      const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const body = [
        `## 👻 Ghost Watcher™ — Commit Analysis`,
        ``,
        `**Branch:** \`${refName}\``,
        `**Commit:** \`${shortSha}\` · ${actor} · ${date}`,
        ``,
        `✅ **No findings detected.**`,
        ``,
        `Blast Radius: no affected files outside the changed set`,
        `Conflict Detection: no conflicts found`,
        `Ghost Brief: not needed`,
        ``,
        `**Safe to merge.**`,
      ].join('\n');
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    } catch (err) {
      console.error(`Ghost Watcher: clean PR comment failed (non-fatal): ${err.message}`);
    }
    return;
  }

  const prNumber = parseInt(prMatch[1], 10);
  const [owner, repo] = repository.split('/');

  // Severity breakdown
  const critical = findings.filter(f => f.severity === 'CRITICAL').length;
  const high     = findings.filter(f => f.severity === 'HIGH').length;
  const medium   = findings.filter(f => f.severity === 'MEDIUM').length;
  const low      = findings.filter(f => f.severity === 'LOW').length;
  const total    = findings.length;

  // Severity summary line
  const parts = [];
  if (critical) parts.push(`${critical} critical`);
  if (high)     parts.push(`${high} high`);
  if (medium)   parts.push(`${medium} medium`);
  if (low)      parts.push(`${low} low`);
  const severitySummary = parts.length ? parts.join(' · ') : 'none';

  // Phase grouping for the comment body
  const phase1 = findings.filter(f => ['CRITICAL', 'HIGH'].includes(f.severity));
  const phase2 = findings.filter(f => ['MEDIUM', 'LOW'].includes(f.severity));

  const shortSha = sha.slice(0, 7);
  const date     = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  let body = `## 👻 Ghost Watcher™ — Commit Analysis\n\n`;
  body    += `**Branch:** \`${refName}\`\n`;
  body    += `**Commit:** \`${shortSha}\` · ${actor} · ${date}\n\n`;
  body    += `**Findings:** ${total} (${severitySummary})\n`;
  body    += `**Blast radius:** ${blastFileCount} file${blastFileCount === 1 ? '' : 's'} affected\n`;
  body    += `**Ghost Brief:** ${briefPromptCount} prompt${briefPromptCount === 1 ? '' : 's'} ready\n\n`;

  if (phase1.length > 0) {
    body += `### PHASE 1 — Fix first (surgical)\n`;
    for (const f of phase1) {
      body += `  - **${f.severity}:** ${f.title}\n`;
    }
    body += `  → Prompts ready in Ghost Portal\n\n`;
  }

  if (phase2.length > 0) {
    body += `### PHASE 2 — Fix second (moderate)\n`;
    for (const f of phase2) {
      body += `  - **${f.severity}:** ${f.title}\n`;
    }
    body += `  → Prompts ready in Ghost Portal\n\n`;
  }

  if (total === 0) {
    body += `No findings detected for this commit.\n\n`;
  }

  if (portalUrl) {
    body += `[Open Ghost Portal to copy prompts into your AI coding tool.](${portalUrl})\n`;
  }

  try {
    const octokit = createOctokit({ auth: prToken });
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  } catch (err) {
    // Non-fatal — never block the pipeline over a comment failure
    console.error(`Ghost Watcher: PR comment failed (non-fatal): ${err.message}`);
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Entry point for `ghost --watcher-commit`.
 * Orchestrates the full Watch pipeline. Always exits 0.
 */
export async function runWatchCommit({ tier = 'team', version = '9.0.0' } = {}) {
  const repoRoot = process.cwd();

  console.log(`\n👻 Ghost Watcher™ v${version} — Commit Analysis`);
  console.log(`   Running in: ${repoRoot}\n`);

  // ── Step 1: Read config ──────────────────────────────────────────────────
  let watchConfig;
  try {
    watchConfig = readWatchConfig(repoRoot);
  } catch (err) {
    console.error(`Ghost Watcher: config error — ${err.message}`);
    process.exit(0); // advisory only — never block
  }

  // ── Step 1b: ghost-skip tag check ───────────────────────────────────────
  // If the commit message contains [ghost-skip], exit immediately.
  // Developers use this to bypass Watch on doc-only or trivial commits.
  try {
    const { execSync } = await import('child_process');
    const commitMsg = execSync('git log -1 --format=%B', { cwd: repoRoot, encoding: 'utf8' }).trim();
    if (commitMsg.includes('[ghost-skip]')) {
      console.log('Ghost Watcher: [ghost-skip] detected in commit message — skipping scan.');
      console.log('👻 Ghost Watcher™ skipped.\n');
      process.exit(0);
    }
  } catch {
    // git log failed — not fatal, continue
  }

  // ── Step 1c: Iteration limit check ──────────────────────────────────────
  // Prevents Ghost Watcher from running indefinitely on high-commit PRs.
  // Reads max_iterations from ghost-watcher.yaml (default: 10).
  // Counts prior Watch runs for this PR by checking GITHUB_RUN_NUMBER.
  const maxIterations = watchConfig.iterations?.max ?? 10;
  const runNumber     = parseInt(process.env.GITHUB_RUN_NUMBER || '1', 10);
  if (runNumber > maxIterations) {
    console.log(`Ghost Watcher: iteration limit reached (run ${runNumber} of ${maxIterations} max).`);
    console.log('   Open Ghost Portal to review findings from earlier runs.');
    console.log('👻 Ghost Watcher™ skipped — iteration limit.\n');
    process.exit(0);
  }

  // ── Step 2: Changed files ────────────────────────────────────────────────
  const changedFiles = getChangedFiles(repoRoot);
  if (changedFiles.length === 0) {
    console.log('Ghost Watcher: no changed files detected. Nothing to analyze.');
    process.exit(0);
  }
  console.log(`Ghost Watcher: ${changedFiles.length} changed file(s) detected`);
  changedFiles.forEach(f => console.log(`  · ${f}`));
  console.log('');

  // ── Step 3: Developer identity ───────────────────────────────────────────
  const developer = resolveDeveloperIdentity();
  const commitSha  = (process.env.GITHUB_SHA || 'local').slice(0, 7);
  const branch     = process.env.GITHUB_REF_NAME || process.env.GITHUB_HEAD_REF || 'unknown';
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  console.log(`Ghost Watcher: developer — ${developer.name} <${developer.email}>`);
  console.log(`Ghost Watcher: commit    — ${commitSha} on ${branch}\n`);

  // ── Profile resolution ───────────────────────────────────────────────────
  // Priority: GHOST_PROFILE env var (CI override) → ghost-watcher.yaml profile
  // field → configstore default profile slug → no profile.
  let profile = null;
  try {
    const profileEnv  = process.env.GHOST_PROFILE;
    const profileYaml = watchConfig.profile || null;
    const profileSlug = profileEnv || profileYaml || getDefaultProfileSlug();
    if (profileSlug) {
      profile = await loadProfile(profileSlug);
      console.log(`Ghost Watcher: profile — ${profile?.name || profile?.author || profileSlug}\n`);
    }
  } catch (err) {
    console.log(`Ghost Watcher: profile load failed (non-fatal) — ${err.message}\n`);
  }

  // ── Step 4: Load codebase ────────────────────────────────────────────────
  console.log('Ghost Watcher: loading codebase context...');
  let codebaseContext;
  try {
    codebaseContext = await loadFromPath(repoRoot);
  } catch (err) {
    console.error(`Ghost Watcher: failed to load codebase — ${err.message}`);
    process.exit(0);
  }
  console.log(`Ghost Watcher: loaded ${codebaseContext.loadedFiles} files\n`);

  // ── Step 5: Blast Radius on changed files ────────────────────────────────
  let blastFindings  = [];
  let blastFileCount = 0;

  if (watchConfig.scans?.blast_radius !== false) {
    console.log('Ghost Watcher: running Blast Radius...');
    let blastBuffer = '';
    const blastHeartbeat = setInterval(() => process.stdout.write('.'), 8000);
    try {
      await runBlastRadius(
        codebaseContext,
        changedFiles,
        (chunk) => { blastBuffer += chunk; },
        { tier, headless: true, profile }
      );
      clearInterval(blastHeartbeat);
      process.stdout.write('\n');
      blastFindings  = extractFindings(blastBuffer);
      blastFileCount = blastFindings.reduce((acc, f) => acc + (f.files?.length || 0), 0);
      console.log(`Ghost Watcher: Blast Radius complete — ${blastFindings.length} findings\n`);
    } catch (err) {
      clearInterval(blastHeartbeat);
      process.stdout.write('\n');
      console.error(`Ghost Watcher: Blast Radius failed (non-fatal) — ${err.message}`);
    }
  }

  // ── Step 6: Conflict Detection on changed files ──────────────────────────
  let conflictFindings = [];

  if (watchConfig.scans?.conflict_detection !== false) {
    console.log('Ghost Watcher: running Conflict Detection...');
    const conflictHeartbeat = setInterval(() => process.stdout.write('.'), 8000);
    try {
      // conflict_verify defaults to false in Watch mode — verification is
      // expensive per-run in CI. Set conflict_verify: true in ghost-watcher.yaml
      // to enable quick verification (recommended for Enterprise only).
      const conflictVerify = watchConfig.scans?.conflict_verify === true ? 'quick' : 'skip';

      const result = await runConflictScan(
        codebaseContext.fileMap || {},
        {
          onChunk:          (text) => { /* headless — buffer not needed */ },
          onProgress:       () => {},
          onVerifyPrompt:   async () => conflictVerify,
          onSessionPrompt:  async () => 'restart',
        },
        {
          projectLabel: `watch-${commitSha}`,
          tier,
          headless: true,
          seedFiles: changedFiles,
          profile,
        }
      );
      clearInterval(conflictHeartbeat);
      process.stdout.write('\n');
      if (result?.candidates) {
        conflictFindings = result.candidates.map(normalizeCandidateToFinding);
      }
      console.log(`Ghost Watcher: Conflict Detection complete — ${conflictFindings.length} findings\n`);
    } catch (err) {
      clearInterval(conflictHeartbeat);
      process.stdout.write('\n');
      console.error(`Ghost Watcher: Conflict Detection failed (non-fatal) — ${err.message}`);
    }
  }

  // ── Step 7: Merge findings ───────────────────────────────────────────────
  const allFindings = [
    ...blastFindings.map(f => ({ ...f, source_mode: 'blast' })),
    ...conflictFindings.map(f => ({ ...f, source_mode: 'conflict' })),
  ];

  console.log(`Ghost Watcher: ${allFindings.length} total findings (blast: ${blastFindings.length}, conflict: ${conflictFindings.length})\n`);

  // ── Step 8: Ghost Brief ──────────────────────────────────────────────────
  let brief           = null;
  let briefPromptCount = 0;

  if (watchConfig.scans?.ghost_brief !== false && allFindings.length > 0) {
    try {
      const { generateBrief, writeBrief } = await import('../../lib/ghostBrief.js');

      // Adapt raw findings into Ghost Brief prompt shape via the adapter.
      // Blast findings use fromPOI (same shape); conflict findings use fromConflict.
      const adaptedFindings = [
        ...fromPOI(blastFindings.map(f => ({ ...f, source_mode: 'blast' }))),
        ...fromConflict(conflictFindings),
      ].filter(f => f.files?.primary?.length > 0);

      brief = generateBrief({
        findings:      adaptedFindings,
        ghostVersion:  version,
        scanFile:      `watch-${commitSha}`,
        codebaseRoot:  repoRoot,
        tier,
        profile,
      });
      briefPromptCount = brief?.prompts?.length || 0;
      console.log(`Ghost Watcher: Ghost Brief generated — ${briefPromptCount} prompts\n`);
    } catch (err) {
      console.error(`Ghost Watcher: Ghost Brief failed (non-fatal) — ${err.message}`);
    }
  }

  // ── Step 9: Push to portal repo ──────────────────────────────────────────
  // Resolve portal credentials: env vars take priority (CI/GitHub Actions),
  // then ghost-watcher.yaml, then the local Ghost configstore (developer machines).
  const localPortalCfg = getPortalConfig();
  const portalRepoUrl  = process.env.GHOST_PORTAL_REPO
    || watchConfig.portal?.repo
    || localPortalCfg?.repo
    || null;
  const portalToken    = process.env.GHOST_PORTAL_TOKEN
    || (watchConfig.portal?.token_env ? process.env[watchConfig.portal.token_env] : null)
    || localPortalCfg?.token
    || null;

  let portalUrl = null;

  if (portalRepoUrl && portalToken) {
    try {
      const octokit = createOctokit({ auth: portalToken });
      const clean   = portalRepoUrl.replace('https://github.com/', '').replace(/\.git$/, '');
      const [portalOwner, portalRepo] = clean.split('/');

      const devSlug     = emailToSlug(developer.email);
      const projectSlug = (process.env.GITHUB_REPOSITORY || 'unknown-project')
        .replace('/', '-').toLowerCase();
      const baseFileName = `watch-${commitSha}-${timestamp}`;
      const basePath     = `projects/${projectSlug}/scans/watch/${devSlug}`;

      // Build the Watch result payload
      const watchResult = {
        schema:      '1.0',
        generatedAt: new Date().toISOString(),
        commit:      process.env.GITHUB_SHA || 'local',
        commitShort: commitSha,
        branch,
        developer,
        projectSlug,
        findingCount: allFindings.length,
        severityCounts: {
          critical: allFindings.filter(f => f.severity === 'CRITICAL').length,
          high:     allFindings.filter(f => f.severity === 'HIGH').length,
          medium:   allFindings.filter(f => f.severity === 'MEDIUM').length,
          low:      allFindings.filter(f => f.severity === 'LOW').length,
        },
        blastFileCount,
        briefPromptCount,
        findings:    allFindings,
        brief:       brief || null,
      };

      // Push findings JSON
      await upsertPortalFile(
        octokit, portalOwner, portalRepo,
        `${basePath}/${baseFileName}.json`,
        JSON.stringify(watchResult, null, 2),
        `watch: ${commitSha} — ${developer.email}`
      );
      console.log(`Ghost Watcher: results pushed to portal repo\n`);

      // Push Ghost Brief JSON separately for portal Brief tab
      if (brief) {
        await upsertPortalFile(
          octokit, portalOwner, portalRepo,
          `${basePath}/watch-brief-${commitSha}.json`,
          JSON.stringify(brief, null, 2),
          `watch-brief: ${commitSha}`
        );
      }

      // Build portal URL for PR comment
      const portalSlug = process.env.GHOST_PORTAL_SLUG || portalOwner;
      portalUrl = `https://ghostarchitect.dev/portal-${portalSlug}`;

    } catch (err) {
      console.error(`Ghost Watcher: portal push failed (non-fatal) — ${err.message}`);
    }
  } else {
    console.log('Ghost Watcher: GHOST_PORTAL_REPO or GHOST_PORTAL_TOKEN not set — skipping portal push\n');
  }

  // ── Step 10: PR comment ───────────────────────────────────────────────────
  if (watchConfig.notifications?.pr_comment !== false) {
    await postPRComment({ findings: allFindings, blastFileCount, briefPromptCount, portalUrl, clean: allFindings.length === 0 });
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log(`👻 Ghost Watcher™ complete.`);
  console.log(`   Findings: ${allFindings.length} | Brief prompts: ${briefPromptCount} | Exit: 0\n`);

  // Always exit 0 — Ghost Watcher never blocks a commit
  process.exit(0);
}
