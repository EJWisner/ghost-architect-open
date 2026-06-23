/**
 * Ghost Watcher™ — Watch management utilities
 * Used by the CLI Enable Watch wizard and Configure Watch menu.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { createOctokit } from '../utils/octokit-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_TEMPLATE_PATH = path.join(__dirname, 'github-actions-template.yml');
const WORKFLOW_DEST_PATH     = '.github/workflows/ghost-watcher.yml';
const WATCH_CONFIG_PATH      = 'ghost-watcher.yaml';

// ── Octokit helpers ───────────────────────────────────────────────────────────

function parseRepo(repoUrl) {
  const clean = repoUrl.replace('https://github.com/', '').replace(/\.git$/, '');
  const [owner, repo] = clean.split('/');
  return { owner, repo };
}

async function upsertRepoFile(octokit, owner, repo, filePath, content, message) {
  let sha = null;
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    sha = data.sha;
  } catch { /* file does not exist yet */ }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo,
    path: filePath,
    message,
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {}),
  });
}

// ── Cost estimator ────────────────────────────────────────────────────────────

/**
 * Estimate monthly Ghost Watcher API cost based on team and repo configuration.
 * Uses conservative per-run estimates based on observed costs.
 *
 * @param {object} opts
 * @param {number} opts.teamSize        number of active developers
 * @param {number} opts.commitsPerDay   estimated commits per day across the team
 * @param {boolean} opts.blastRadius    Blast Radius enabled
 * @param {boolean} opts.conflictDetection  Conflict Detection enabled
 * @returns {{ low: number, high: number, perRun: { low: number, high: number } }}
 */
export function estimateWatcherCost({ teamSize = 1, commitsPerDay = 5, blastRadius = true, conflictDetection = true }) {
  // Per-run cost ranges based on observed production costs
  // Blast Radius only: $0.15 - $0.30
  // Conflict Detection (no verification): $0.80 - $1.50
  // Both: $1.50 - $3.00
  let perRunLow  = 0;
  let perRunHigh = 0;

  if (blastRadius) {
    perRunLow  += 0.15;
    perRunHigh += 0.30;
  }
  if (conflictDetection) {
    perRunLow  += 0.80;
    perRunHigh += 1.50;
  }

  const runsPerMonth = commitsPerDay * 30;
  const monthlyLow   = parseFloat((perRunLow  * runsPerMonth).toFixed(2));
  const monthlyHigh  = parseFloat((perRunHigh * runsPerMonth).toFixed(2));

  return {
    perRun:  { low: perRunLow, high: perRunHigh },
    daily:   { low: parseFloat((perRunLow  * commitsPerDay).toFixed(2)), high: parseFloat((perRunHigh * commitsPerDay).toFixed(2)) },
    monthly: { low: monthlyLow, high: monthlyHigh },
    runsPerMonth,
  };
}

// ── Watch config builder ──────────────────────────────────────────────────────

/**
 * Build a ghost-watcher.yaml string from wizard answers.
 */
export function buildWatchConfig({
  branches       = ['main', 'develop', 'feature/**', 'bugfix/**'],
  blastRadius    = true,
  conflictDetection = true,
  ghostBrief     = true,
  conflictVerify = false,
  prComment      = true,
  emailRecipients = [],
  portalRepo     = '',
  profile        = null,
  maxIterations  = 5,
  exitThreshold  = { max_severity: 'medium' },
} = {}) {
  const cfg = {
    ghost_watcher: {
      version: '1.0',
      enabled: true,
      trigger: { branches },
      scans: {
        blast_radius:       blastRadius,
        conflict_detection: conflictDetection,
        ghost_brief:        ghostBrief,
        conflict_verify:    conflictVerify,
      },
      portal: {
        repo:      portalRepo,
        token_env: 'GHOST_PORTAL_TOKEN',
      },
      notifications: {
        pr_comment: prComment,
        ...(emailRecipients.length > 0 ? { email: emailRecipients } : {}),
      },
      iterations: {
        max:            maxIterations,
        exit_threshold: exitThreshold,
      },
      ...(profile ? { profile } : {}),
      team: { config: 'team.yaml' },
    },
  };

  return yaml.stringify(cfg);
}

// ── Enable Watch ──────────────────────────────────────────────────────────────

/**
 * Push ghost-watcher.yaml and GitHub Actions workflow to the customer's repo.
 * Called by the Enable Watch wizard after collecting answers.
 *
 * @param {object} args
 * @param {string} args.repoUrl        GitHub repo URL
 * @param {string} args.token          GitHub PAT with repo write scope
 * @param {object} args.watchOptions   Options from the wizard (passed to buildWatchConfig)
 */
export async function enableWatch({ repoUrl, token, watchOptions = {}, version = 'latest' }) {
  const octokit         = createOctokit({ auth: token });
  const { owner, repo } = parseRepo(repoUrl);

  // Build ghost-watcher.yaml
  const watchConfigContent = buildWatchConfig(watchOptions);

  // Read the workflow template, pin the current Ghost version, and inject branches
  const branches = watchOptions.branches || ['main', 'develop', 'feature/**', 'bugfix/**'];
  const branchYaml = branches.map(b => `      - '${b}'`).join('\n');

  const workflowContent = fs.readFileSync(WORKFLOW_TEMPLATE_PATH, 'utf8')
    .replace('ghost-architect-open@latest', `ghost-architect-open@${version}`)
    .replace(
      /on:\n  push:\n    branches:\n(      - .+\n)+/,
      `on:\n  push:\n    branches:\n${branchYaml}\n`
    );

  // Push ghost-watcher.yaml (requires repo scope only)
  await upsertRepoFile(
    octokit, owner, repo,
    WATCH_CONFIG_PATH,
    watchConfigContent,
    'ghost-watcher: enable Ghost Watcher™'
  );

  // Push GitHub Actions workflow (requires workflow scope)
  // If token lacks workflow scope, return workflow content for manual setup
  let workflowPushed = false;
  try {
    await upsertRepoFile(
      octokit, owner, repo,
      WORKFLOW_DEST_PATH,
      workflowContent,
      'ghost-watcher: add GitHub Actions workflow'
    );
    workflowPushed = true;
  } catch (err) {
    // workflow scope not available — customer must add manually
    workflowPushed = false;
  }

  return { ok: true, owner, repo, workflowPushed, workflowContent };
}

// ── Disable Watch ─────────────────────────────────────────────────────────────

/**
 * Disable Watch by setting enabled: false in ghost-watcher.yaml.
 * Does NOT delete the workflow file — customer can re-enable without reconfiguring.
 */
export async function disableWatch({ repoUrl, token }) {
  const octokit         = createOctokit({ auth: token });
  const { owner, repo } = parseRepo(repoUrl);

  // Read current config
  let currentCfg = {};
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner, repo, path: WATCH_CONFIG_PATH,
    });
    const raw = Buffer.from(data.content, 'base64').toString('utf8');
    currentCfg = yaml.parse(raw) || {};
  } catch { /* file may not exist */ }

  // Set enabled: false
  if (currentCfg.ghost_watcher) {
    currentCfg.ghost_watcher.enabled = false;
  } else {
    currentCfg.ghost_watcher = { enabled: false };
  }

  await upsertRepoFile(
    octokit, owner, repo,
    WATCH_CONFIG_PATH,
    yaml.stringify(currentCfg),
    'ghost-watcher: disable Ghost Watcher™'
  );

  return { ok: true };
}

// ── Watch Status ──────────────────────────────────────────────────────────────

/**
 * Read ghost-watcher.yaml from a repo and return its parsed config.
 * Returns null if Watch is not configured.
 */
export async function getWatchStatus({ repoUrl, token }) {
  const octokit         = createOctokit({ auth: token });
  const { owner, repo } = parseRepo(repoUrl);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner, repo, path: WATCH_CONFIG_PATH,
    });
    const raw = Buffer.from(data.content, 'base64').toString('utf8');
    return yaml.parse(raw)?.ghost_watcher || null;
  } catch {
    return null;
  }
}
// license test Tue Jun 23 15:30:36 CDT 2026
