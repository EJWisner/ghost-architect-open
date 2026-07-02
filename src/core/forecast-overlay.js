// src/core/forecast-overlay.js — Ghost Architect™ Commit Forecast synthesis primitive
//
// PURPOSE: Build an in-memory "overlay" codebaseContext that treats files in a
// "proposed" folder as authoritative and falls back to the baseline repo for
// everything else. The returned object is shape-identical to the object returned
// by src/loader/index.js so Blast and Conflict analysts consume it unchanged.
//
// ARCHITECTURE NOTE: This module is pure synthesis logic. It owns no CLI surface,
// no prompts, no spinners. src/modes/commit-forecast.js owns all of that.
//
// OVERLAY ALGORITHM:
//   1. Walk proposedDir, build { relPath → rawContent } map.
//   2. Redact each proposed file through redactContent() — same contract as the loader.
//   3. Map proposed relative paths to baseline fileMap keys (mirror-structure rule).
//   4. Produce changedFiles manifest: { modified, added }.
//      "modified" = proposed path exists in baseline fileMap.
//      "added"    = proposed path is net-new (no baseline key).
//   5. Patch baseline fileMap: overwrite modified keys, insert added keys.
//   6. Rebuild context string from patched fileMap using the same token-budget logic
//      the loader uses (MAX_CONTEXT_TOKENS from tierCaps, same truncation behavior).
//   7. Return { patchedContext, changedFiles }.
//
// PATH RESOLUTION (mirror-structure rule):
//   Proposed files must mirror the repo's relative path structure.
//   e.g. /proposed/src/models/User.php patches /repo/src/models/User.php
//   when the baseline root is /repo/. Ghost resolves proposed relative paths
//   against the baseline root to find the matching fileMap key.
//
// PRE-COMMIT vs OFFLINE-FILES:
//   Pre-commit surface: proposedDir defaults to the repo working tree; Ghost
//   auto-discovers changed files via `git diff --name-only HEAD` and reads
//   them from disk. The result is still fed through this module — no separate
//   code path.
//   Offline/offshore surface: developer points Ghost at an arbitrary folder of
//   proposed files that mirrors the repo tree. Same code path.
//
// DELETION SUPPORT: v1 does not model deletions. A file that exists in baseline
// but is absent from proposedDir is treated as unchanged (baseline wins).
// v1.1 can add explicit deletion markers (empty file + sentinel comment, or a
// deletions.json manifest) if the use case surfaces.

import fs   from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { redactContent } from '../redactor.js';
import { resolveContextCap } from '../loader/tierCaps.js';

// Code extensions that the loader recognizes — kept in sync with loader/index.js.
// If the loader list grows, update this too. Sharing via a constants module is
// a v1.1 cleanup.
const CODE_EXTENSIONS = new Set([
  '.php', '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.java', '.go',
  '.cs', '.cpp', '.c', '.h', '.vue', '.svelte', '.sql', '.xml', '.json',
  '.yaml', '.yml', '.env.example', '.sh', '.bash', '.md',
]);

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Recursively collect all files under a directory. Returns an array of absolute
 * paths. Skips .git and node_modules to avoid noise in proposed folders that
 * developers might have left un-cleaned.
 */
function collectFiles(dir) {
  const results = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Skip the usual noise dirs so a proposed folder cloned from a repo
        // doesn't pull in thousands of vendor/node_modules files.
        if (entry.name === 'node_modules' || entry.name === '.git' ||
            entry.name === 'vendor'       || entry.name === 'dist'  ||
            entry.name === 'build'        || entry.name === '.next') {
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          results.push(full);
        }
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Read a file safely. Returns null on any I/O error rather than throwing,
 * so a single unreadable proposed file doesn't abort the entire forecast.
 */
function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Resolve the baseline root directory from a codebaseContext.
 * The baseline root is the common prefix of all keys in fileMap.
 * Returns the longest common directory prefix, or '/' as a fallback.
 */
function resolveBaselineRoot(fileMap) {
  const keys = Object.keys(fileMap);
  if (keys.length === 0) return '/';

  // Split each key into path segments and find the common prefix.
  const segmented = keys.map(k => k.split(path.sep));
  const first = segmented[0];
  let commonLen = first.length;
  for (const segs of segmented) {
    let i = 0;
    while (i < commonLen && i < segs.length && segs[i] === first[i]) i++;
    commonLen = i;
  }
  if (commonLen === 0) return '/';
  return first.slice(0, commonLen).join(path.sep) || '/';
}

/**
 * Use `git diff --name-only HEAD` to list files changed in the working tree
 * relative to HEAD. Returns an array of absolute paths. Falls back to an
 * empty array if not inside a git repo or git is unavailable.
 *
 * We also include untracked files via `git ls-files --others --exclude-standard`
 * because a developer working on a new file hasn't committed it yet but still
 * wants to forecast its impact.
 */
export function discoverWorkingTreeChanges(repoRoot) {
  const changes = new Set();
  try {
    // Modified/deleted tracked files
    const diffOut = execSync('git diff --name-only HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (diffOut) {
      for (const rel of diffOut.split('\n').filter(Boolean)) {
        changes.add(path.join(repoRoot, rel));
      }
    }
    // Staged changes (developer may have run `git add` already)
    const stagedOut = execSync('git diff --name-only --cached', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (stagedOut) {
      for (const rel of stagedOut.split('\n').filter(Boolean)) {
        changes.add(path.join(repoRoot, rel));
      }
    }
    // Untracked new files
    const untrackedOut = execSync('git ls-files --others --exclude-standard', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (untrackedOut) {
      for (const rel of untrackedOut.split('\n').filter(Boolean)) {
        const ext = path.extname(rel).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          changes.add(path.join(repoRoot, rel));
        }
      }
    }
  } catch {
    // Not a git repo, git not installed, or HEAD doesn't exist yet.
    // Return empty set — caller will fall back to manual folder input.
  }
  return [...changes];
}

/**
 * Check whether a directory is the root of a git repository (contains .git).
 */
export function isGitRepo(dir) {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

// ── Core synthesis ────────────────────────────────────────────────────────────

/**
 * Build the overlay codebaseContext.
 *
 * @param {object} baselineContext   — shape: { context, fileIndex, fileMap, totalFiles, loadedFiles }
 * @param {string} proposedDir       — absolute path to folder of proposed file states
 * @param {object} [opts]
 * @param {string} [opts.tier]       — 'open' | 'pro' | 'team' | 'enterprise'  (for token-cap)
 * @param {object} [opts.profile]    — Ghost Partner profile (null = none)
 * @param {boolean} [opts.verbose]   — emit console warnings for unmapped / unreadable files
 *
 * @returns {{
 *   patchedContext: object,   // shape-identical to codebaseContext from loader
 *   changedFiles: {
 *     modified: string[],     // baseline paths that were overwritten
 *     added:    string[],     // net-new paths in the proposed set
 *   }
 * }}
 */
export async function buildForecastOverlay(baselineContext, proposedDir, opts = {}) {
  const tier    = opts.tier    || 'open';
  const verbose = opts.verbose ?? false;

  const baselineFileMap = baselineContext.fileMap || {};
  const baselineRoot    = resolveBaselineRoot(baselineFileMap);

  // ── Step 1: Collect proposed files ─────────────────────────────────────
  const proposedAbsPaths = collectFiles(proposedDir);

  if (proposedAbsPaths.length === 0) {
    throw new Error(`Commit Forecast: no code files found in proposed directory: ${proposedDir}`);
  }

  // ── Step 2: Read + redact each proposed file ────────────────────────────
  const proposedRedacted = {}; // { relPathFromProposedDir → redactedContent }
  const redactionErrors  = [];

  for (const absPath of proposedAbsPaths) {
    const raw = safeReadFile(absPath);
    if (raw === null) {
      if (verbose) console.warn(`[forecast-overlay] unreadable: ${absPath}`);
      continue;
    }
    let redacted = raw;
    try {
      const result = redactContent(raw, []);
      if (result.partialRedaction) {
        redactionErrors.push(absPath);
        continue; // fail-closed per loader contract
      }
      redacted = result.redacted;
    } catch (err) {
      redactionErrors.push(absPath);
      if (verbose) console.warn(`[forecast-overlay] redaction error on ${absPath}: ${err.message}`);
      continue;
    }
    const relFromProposed = path.relative(proposedDir, absPath);
    proposedRedacted[relFromProposed] = redacted;
  }

  if (redactionErrors.length > 0) {
    throw new Error(
      `Commit Forecast: redaction failed on ${redactionErrors.length} proposed file(s). ` +
      `Scan aborted to protect secrets.\n` +
      redactionErrors.map(p => `  • ${p}`).join('\n')
    );
  }

  // ── Step 3: Map proposed relative paths to baseline fileMap keys ─────────
  // Mirror-structure rule: proposed/src/models/User.php → baseline src/models/User.php
  // Strategy: try to match the proposed relative path against every baseline key's
  // relative-from-root form. This handles the case where baseline keys are absolute
  // paths (loader stores them as absolute) and proposed relative paths are partial.

  const baselineKeys     = Object.keys(baselineFileMap);
  // Build a lookup: normalized-relative-from-root → original baseline key
  const baselineByRel    = {};
  for (const bKey of baselineKeys) {
    const rel = path.relative(baselineRoot, bKey);
    baselineByRel[rel] = bKey;
  }

  const modified = []; // baseline keys overwritten by proposed files
  const added    = []; // net-new keys from proposed files

  const patchedFileMap = { ...baselineFileMap }; // start with full baseline clone

  for (const [proposedRel, content] of Object.entries(proposedRedacted)) {
    // Normalize separators so cross-platform paths match.
    const normalizedRel = proposedRel.split(path.sep).join('/');

    // Try exact match first (proposed path == baseline relative path).
    let baselineKey = baselineByRel[normalizedRel]
                   || baselineByRel[proposedRel];

    if (!baselineKey) {
      // Fuzzy fallback: the common-prefix root resolution may strip more leading
      // segments than expected (e.g. all baseline files are under /repo/src/ so
      // root resolves to /repo/src/, making baseline rels like "models/User.php"
      // while proposed path is "src/models/User.php"). We try BOTH directions:
      //   A) proposed ends with baseline rel: proposed "src/models/User.php" ← rel "models/User.php"
      //   B) baseline rel ends with proposed: rel "src/models/User.php" ← proposed "models/User.php"
      // We prefer the shortest baseline rel match to avoid false positives in
      // deeply nested trees where a short proposed name could match multiple rels.
      let best = null;
      let bestLen = Infinity;
      for (const [rel, bKey] of Object.entries(baselineByRel)) {
        // Direction A: proposed is more specific — it contains extra leading segments
        const proposedEndsWithRel = normalizedRel.endsWith('/' + rel) || normalizedRel === rel
                                  || proposedRel.endsWith('/' + rel)  || proposedRel === rel;
        // Direction B: baseline rel is more specific — proposed is a suffix of rel
        const relEndsWithProposed = rel.endsWith('/' + normalizedRel) || rel === normalizedRel
                                  || rel.endsWith('/' + proposedRel)  || rel === proposedRel;

        if (proposedEndsWithRel || relEndsWithProposed) {
          if (rel.length < bestLen) {
            best = bKey;
            bestLen = rel.length;
          }
        }
      }
      baselineKey = best;
    }

    if (baselineKey) {
      // Modified: overwrite baseline content with proposed content.
      patchedFileMap[baselineKey] = content;
      modified.push(baselineKey);
    } else {
      // Added: net-new file. Store under an absolute path derived from
      // the baseline root so downstream consumers see a consistent key format.
      const newKey = path.join(baselineRoot, proposedRel);
      patchedFileMap[newKey] = content;
      added.push(newKey);
      if (verbose) {
        console.warn(`[forecast-overlay] net-new file (no baseline match): ${proposedRel}`);
      }
    }
  }

  // ── Step 4: Rebuild context string from patched fileMap ──────────────────
  // Mirrors the token-budget loop in loader/index.js exactly.
  const maxTokens  = resolveContextCap(tier).effective;
  let   context    = '';
  const fileIndex  = [];
  let   approxTokens = 0;

  // Prioritize changed files first so they're always included under the cap.
  const changedSet = new Set([...modified, ...added]);
  const orderedKeys = [
    ...Object.keys(patchedFileMap).filter(k => changedSet.has(k)),
    ...Object.keys(patchedFileMap).filter(k => !changedSet.has(k)),
  ];

  for (const filePath of orderedKeys) {
    const content = patchedFileMap[filePath];
    if (typeof content !== 'string') continue;
    const approxFileTokens = Math.ceil(content.length / 4);
    if (approxTokens + approxFileTokens > maxTokens) continue;
    context += `\n\n=== FILE: ${filePath} ===\n${content}`;
    fileIndex.push(filePath);
    approxTokens += approxFileTokens;
  }

  const totalFiles  = Object.keys(patchedFileMap).length;
  const loadedFiles = fileIndex.length;

  const patchedContext = {
    context,
    fileIndex,
    fileMap:      patchedFileMap,
    totalFiles,
    loadedFiles,
    // Preserve original baseline meta so modes can display it.
    _forecastMeta: {
      baselineRoot,
      proposedDir,
      tier,
    },
  };

  return {
    patchedContext,
    changedFiles: { modified, added },
  };
}
