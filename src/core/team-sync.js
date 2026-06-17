/**
 * Ghost Architect™ — Team Sync Engine
 * Pushes and pulls project intelligence and reports to/from a shared
 * private GitHub repo. Each seat on the team points at the same repo.
 *
 * Repo structure in ghost-team-sync:
 *   projects/
 *     <project-slug>/
 *       project.json       ← project meta + scan history
 *       scan-<date>.json   ← individual scan records
 *   reports/
 *     <project-slug>/
 *       <filename>.txt
 *       <filename>.md
 *       <filename>.pdf     ← binary, base64 encoded
 */

import { createOctokit } from '../utils/octokit-client.js';
import { getDefaultTeamSync, resolveTeamSync } from '../config.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const LOCAL_SYNC_DIR = path.join(os.homedir(), 'Ghost Architect Reports', 'team-sync');

// ── Octokit instance ──────────────────────────────────────────────────────────

function getOctokit(syncEntry) {
  return createOctokit({ auth: syncEntry.token });
}

/**
 * Extract { owner, repo } from a GitHub repository URL.
 *
 * Domain-agnostic on purpose: the owner/repo pair is read from the URL path,
 * so GitHub Enterprise Server hosts parse the same way as github.com. The
 * earlier implementation hard-stripped the "https://github.com/" prefix, which
 * left Enterprise URLs (https://github.company.com/owner/repo) with the domain
 * still embedded in the owner segment and 404'd on every Octokit call.
 *
 * Supported formats:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.company.com/owner/repo          (Enterprise Server)
 *   https://github.company.com/owner/repo.git
 *   git@github.com:owner/repo.git                  (SSH)
 *   git@github.company.com:owner/repo              (Enterprise SSH)
 *
 * A trailing ".git" and trailing slashes are tolerated. Throws if the URL does
 * not contain a valid <owner>/<repo> path.
 */
export function parseRepo(repoUrl) {
  const url = String(repoUrl).trim().replace(/\.git$/, '').replace(/\/+$/, '');

  // HTTP(S): protocol, then any host, then exactly owner/repo.
  // SSH:     git@<host>:owner/repo.
  const match =
    url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)$/) ||
    url.match(/^git@[^:]+:([^/]+)\/([^/]+)$/);

  if (!match) {
    throw new Error(
      `Unsupported team sync repo URL: "${repoUrl}". Expected a GitHub URL of ` +
      `the form https://<host>/<owner>/<repo> (github.com or GitHub Enterprise ` +
      `Server) or git@<host>:<owner>/<repo>.`
    );
  }

  return { owner: match[1], repo: match[2] };
}

// ── Low-level GitHub helpers ──────────────────────────────────────────────────

async function getFileSha(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    return data.sha;
  } catch {
    return null;
  }
}

async function upsertFile(octokit, owner, repo, filePath, content, message) {
  const sha = await getFileSha(octokit, owner, repo, filePath);
  const encoded = Buffer.from(content).toString('base64');
  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo,
    path: filePath,
    message,
    content: encoded,
    ...(sha ? { sha } : {}),
  });
}

async function getFileContent(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

async function listDirectory(octokit, owner, repo, dirPath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: dirPath });
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// ── Sync entry resolution ─────────────────────────────────────────────────────

function resolveSyncEntry(workspaceName) {
  if (workspaceName) {
    const all = resolveTeamSync();
    return all.find(r => r.name === workspaceName) || null;
  }
  return getDefaultTeamSync();
}

// ── Project sync ──────────────────────────────────────────────────────────────

/**
 * Push a project's meta JSON to the sync repo.
 */
export async function pushProject(projectSlug, projectMeta, workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) throw new Error('No team sync repo configured. Run ghost --configure-team.');

  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  const filePath = `projects/${projectSlug}/project.json`;

  await upsertFile(
    octokit, owner, repo, filePath,
    JSON.stringify(projectMeta, null, 2),
    `sync: update project ${projectSlug}`
  );
}

/**
 * Push an individual scan record to the sync repo.
 */
export async function pushScanRecord(projectSlug, scanFile, scanData, workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) throw new Error('No team sync repo configured.');

  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  const filePath = `projects/${projectSlug}/${scanFile}`;

  await upsertFile(
    octokit, owner, repo, filePath,
    JSON.stringify(scanData, null, 2),
    `sync: scan record ${projectSlug}/${scanFile}`
  );
}

/**
 * Pull all projects from the sync repo into local sync dir.
 * Returns array of { slug, meta } objects.
 */
export async function pullProjects(workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) throw new Error('No team sync repo configured.');

  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);

  const projectDirs = await listDirectory(octokit, owner, repo, 'projects');
  const results = [];

  for (const dir of projectDirs) {
    if (dir.type !== 'dir') continue;
    const content = await getFileContent(octokit, owner, repo, `projects/${dir.name}/project.json`);
    if (!content) continue;
    try {
      const meta = JSON.parse(content);
      const localDir = path.join(LOCAL_SYNC_DIR, 'projects', dir.name);
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, 'project.json'), content);
      results.push({ slug: dir.name, meta });
    } catch { /* skip malformed */ }
  }

  return results;
}

/**
 * Pull a single project from the sync repo.
 */
export async function pullProject(projectSlug, workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) throw new Error('No team sync repo configured.');

  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);

  const content = await getFileContent(octokit, owner, repo, `projects/${projectSlug}/project.json`);
  if (!content) return null;

  try { return JSON.parse(content); } catch { return null; }
}

// ── Report sync ───────────────────────────────────────────────────────────────

/**
 * Push a report file (txt, md, or pdf) to the sync repo.
 */
export async function pushReport(projectSlug, filePath, workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) throw new Error('No team sync repo configured.');

  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);
  const fileName = path.basename(filePath);
  const remotePath = `reports/${projectSlug}/${fileName}`;

  const raw = fs.readFileSync(filePath);
  const encoded = raw.toString('base64');
  const sha = await getFileSha(octokit, owner, repo, remotePath);

  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo,
    path: remotePath,
    message: `sync: report ${projectSlug}/${fileName}`,
    content: encoded,
    ...(sha ? { sha } : {}),
  });
}

/**
 * Pull all reports for a project from the sync repo.
 */
export async function pullReports(projectSlug, workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) throw new Error('No team sync repo configured.');

  const octokit = getOctokit(entry);
  const { owner, repo } = parseRepo(entry.repo);

  const files = await listDirectory(octokit, owner, repo, `reports/${projectSlug}`);
  const localDir = path.join(LOCAL_SYNC_DIR, 'reports', projectSlug);
  fs.mkdirSync(localDir, { recursive: true });

  const pulled = [];
  for (const file of files) {
    if (file.type !== 'file') continue;
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path: file.path });
      const raw = Buffer.from(data.content, 'base64');
      const localPath = path.join(localDir, file.name);
      fs.writeFileSync(localPath, raw);
      pulled.push(localPath);
    } catch { /* skip */ }
  }

  return pulled;
}

// ── Sync status ───────────────────────────────────────────────────────────────

/**
 * Test connection to the sync repo.
 */
export async function testSyncConnection(workspace) {
  const entry = resolveSyncEntry(workspace);
  if (!entry) return { ok: false, error: 'No team sync repo configured.' };

  try {
    const octokit = getOctokit(entry);
    const { owner, repo } = parseRepo(entry.repo);
    await octokit.rest.repos.get({ owner, repo });
    return { ok: true, repo: entry.repo, workspace: entry.name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * List all workspaces and their connection status.
 */
export async function listWorkspaces() {
  const all = resolveTeamSync();
  const results = [];
  for (const entry of all) {
    const status = await testSyncConnection(entry.name);
    results.push({ ...entry, ...status });
  }
  return results;
}
