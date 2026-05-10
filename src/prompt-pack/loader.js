/**
 * src/prompt-pack/loader.js
 *
 * Tagged-source dispatcher for loading prompts. The mode file calls
 * loadPromptSource(source) with a source descriptor and gets back a
 * uniform { files: [{ path, content }, ...] } result regardless of
 * where the prompts came from.
 *
 * v1 implements only the localFolder case. v1.1 will add githubRepo
 * and teamSyncRepo for Team/Enterprise. The mode file and the
 * prompt-pack are agnostic to the source kind.
 *
 * Source shapes:
 *
 *   { kind: 'localFolder', path: '/abs/or/rel/folder' }
 *   { kind: 'githubRepo',   url, pat, subpath }   // v1.1 NOT IMPLEMENTED
 *   { kind: 'teamSyncRepo' }                       // v1.1 NOT IMPLEMENTED
 *
 * Return shape:
 *
 *   {
 *     files: [{ path: 'absolute path', content: 'utf-8 string' }, ...],
 *     stats: { scanned: N, skipped: M, totalBytes: K },
 *     sourceLabel: 'human-readable source description'
 *   }
 */

import fs from 'fs';
import path from 'path';

// File extensions we consider prompt files. Markdown is the canonical
// format. .txt for plain prompts. .yaml/.yml because some teams store
// prompt config (system + few-shots + metadata) as YAML. .json for
// structured prompt files (e.g. Anthropic SDK message arrays exported
// to JSON).
//
// We deliberately do NOT include .js / .ts / .py — extracting prompt
// strings from source code is the v2 --from-source feature.
const PROMPT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.yaml',
  '.yml',
  '.json',
]);

// Filenames that match a prompt extension but are almost always repo
// metadata, not prompts. We skip these by name (case-insensitive,
// extension-stripped) so users pointing Prompt Triage at a project
// folder don't get their README audited as a prompt.
//
// Authors who genuinely want to audit a file named README.md as a
// prompt should rename it (or wait for v1.1's source-kind dispatcher
// which will let users pass an explicit file list).
const SKIP_BASENAMES = new Set([
  'readme',
  'changelog',
  'changes',
  'history',
  'license',
  'licence',
  'copying',
  'authors',
  'contributors',
  'contributing',
  'code_of_conduct',
  'security',
  'notice',
  // Project-level documentation that lives next to source. These read
  // like prompts to a regex (markdown with imperative bullets) but are
  // developer documentation. Skip silently.
  'claude',
  'cursor',
  'aider',
  'agents',
  'instructions',
  'todo',
  'todos',
  'roadmap',
  'plan',
  'notes',
]);

// Filename patterns (full filename, case-insensitive) that match repo
// configuration manifests rather than prompts. Tested against the full
// basename including extension. These exist to filter out package.json,
// package-lock.json, tsconfig.json, eslint config, etc., which all have
// a .json extension but are clearly not prompts.
const SKIP_PATTERNS = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^npm-shrinkwrap\.json$/i,
  /^yarn\.lock$/i, // not in PROMPT_EXTENSIONS but defensive
  /^pnpm-lock\.yaml$/i,
  /^bun\.lock(b)?$/i,
  /^composer\.json$/i,
  /^composer\.lock$/i,
  /^tsconfig.*\.json$/i,
  /^jsconfig\.json$/i,
  /^\.eslintrc.*$/i,
  /^\.prettierrc.*$/i,
  /^\.babelrc.*$/i,
  /^babel\.config\.(json|yaml|yml)$/i,
  /^jest\.config\.(json|yaml|yml)$/i,
  /^vitest\.config\.(json|yaml|yml)$/i,
  /^webpack\.config\.(json|yaml|yml)$/i,
  /^rollup\.config\.(json|yaml|yml)$/i,
  /^\.npmrc$/i,
  /^\.yarnrc.*$/i,
  /^renovate\.json$/i,
  /^\.github\/.*$/i, // workflows etc.
  /^manifest\.json$/i,
  /^lerna\.json$/i,
  /^nx\.json$/i,
  /^turbo\.json$/i,
  /^netlify\.toml$/i,
  /^vercel\.json$/i,
  /^firebase\.json$/i,
  /^now\.json$/i,
  /^\.followups?\.md$/i, // dogfood-specific developer notes
  /^.*_FOLLOWUPS?\.md$/i, // PROMPT_TRIAGE_FOLLOWUPS.md and similar
  /^.*_PLAN.*\.md$/i,
  /^.*_NOTES.*\.md$/i,
  /^.*_TODO.*\.md$/i,
];

// Directory names we always skip when walking a prompt folder. These
// are noise; nobody stores prompts under node_modules. Matches the
// IGNORED_DIRS pattern from src/loader/ but trimmed to what's relevant
// for prompt audits (prompts don't live in build artifacts).
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '__pycache__',
  'venv',
  '.venv',
]);

// Hard cap on how many prompt files we'll load. A folder of 10,000
// markdown notes is not a prompt library and shouldn't run as one.
// If the user really has more than this, they need a more targeted
// folder structure (or wait for v1.1's githubRepo source which can
// scope by subpath).
const MAX_FILES = 1000;

// Hard cap on individual file size. A single 10 MB markdown is almost
// certainly something else (a saved web page, a PDF dump). Skip with
// a counted-skip warning rather than load it.
const MAX_FILE_BYTES = 1024 * 1024; // 1 MB

/**
 * Recursively walk a directory and collect prompt-shaped files.
 *
 * @param {string} root      Absolute directory path.
 * @returns {{ files: Array, stats: Object }}
 */
function walkLocalFolder(root) {
  const files = [];
  const stats = { scanned: 0, skipped: 0, totalBytes: 0 };

  function walk(dir) {
    if (files.length >= MAX_FILES) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Folder we can't read (permissions, broken symlink, etc).
      // Skip silently rather than crash the whole scan.
      stats.skipped++;
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue; // hidden dirs (.git already covered, but defense)
        walk(full);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!PROMPT_EXTENSIONS.has(ext)) continue;

      // Skip repo-metadata filenames (README, CHANGELOG, LICENSE, etc.)
      // even if their extension matches. Compare case-insensitively
      // against the basename minus extension. These are filtered
      // silently, like node_modules/ — not surfaced to the user as
      // "skipped" since they're not prompts in the first place.
      const basenameNoExt = entry.name.slice(0, entry.name.length - ext.length).toLowerCase();
      if (SKIP_BASENAMES.has(basenameNoExt)) {
        continue;
      }

      // Skip files matching repo-config or developer-doc patterns
      // (package.json, package-lock.json, tsconfig.json, *_FOLLOWUPS.md,
      // *_PLAN.md, etc.). Same silent-skip semantics as SKIP_BASENAMES.
      let matchedSkipPattern = false;
      for (const pattern of SKIP_PATTERNS) {
        if (pattern.test(entry.name)) { matchedSkipPattern = true; break; }
      }
      if (matchedSkipPattern) continue;

      // Size gate.
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        stats.skipped++;
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        stats.skipped++;
        continue;
      }

      // Read content.
      let content;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        stats.skipped++;
        continue;
      }

      files.push({ path: full, content });
      stats.scanned++;
      stats.totalBytes += stat.size;
    }
  }

  walk(root);
  return { files, stats };
}

/**
 * Public entry point. Dispatches on source.kind.
 *
 * @param {Object} source
 * @returns {Promise<{files: Array, stats: Object, sourceLabel: string}>}
 */
export async function loadPromptSource(source) {
  if (!source || typeof source !== 'object' || !source.kind) {
    throw new Error('loadPromptSource: source must be an object with a kind field');
  }

  switch (source.kind) {
    case 'localFolder': {
      if (typeof source.path !== 'string' || !source.path) {
        throw new Error('loadPromptSource: localFolder requires a path string');
      }
      const abs = path.resolve(source.path);
      if (!fs.existsSync(abs)) {
        throw new Error('Folder does not exist: ' + abs);
      }
      const stat = fs.statSync(abs);
      if (!stat.isDirectory()) {
        throw new Error('Path is not a directory: ' + abs);
      }
      const { files, stats } = walkLocalFolder(abs);
      return {
        files,
        stats,
        sourceLabel: abs,
      };
    }

    case 'githubRepo':
    case 'teamSyncRepo': {
      // v1.1 work. The dispatcher knows about these kinds so error
      // messages are precise rather than confusing "unknown kind"
      // errors when a user asks for them in v1.
      throw new Error(
        'Prompt source kind "' + source.kind + '" is planned for v1.1. '
        + 'v1 supports localFolder only. See PROMPT_TRIAGE_PLAN_2026-05-05.md.'
      );
    }

    default:
      throw new Error('Unknown prompt source kind: ' + source.kind);
  }
}
