// src/loader/excludes.js
// Path exclusion utilities for Ghost Architect scans.
// Supports --exclude "glob" and --exclude-presets <name> flags.

import { minimatch } from 'minimatch';
import chalk from 'chalk';

/**
 * Curated exclusion presets. Keys are preset names usable with --exclude-presets.
 * Values are arrays of glob patterns applied to file paths relative to the scan root.
 */
export const PRESETS = {
  'test-data': [
    '**/seeds/**',
    '**/migrations/**',
    '**/fixtures/**',
    '**/tests/**',
    '**/__tests__/**',
    '**/spec/**',
    '**/specs/**',
    '**/*.test.js',
    '**/*.test.ts',
    '**/*.spec.js',
    '**/*.spec.ts',
    '**/*.test.php',
    '**/*Test.php',
  ],
  'generated': [
    '**/generated/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/out/**',
    '**/coverage/**',
  ],
  'vendor-cache': [
    '**/var/**',
    '**/tmp/**',
    '**/.cache/**',
    '**/pub/static/**',
    '**/pub/media/**',
  ],
};

/**
 * Resolve exclusion patterns from CLI flags.
 *
 * @param {string[]} presetNames - from --exclude-presets (comma-separated values split already)
 * @param {string[]} customPatterns - from --exclude (repeatable)
 * @returns {string[]} flat list of glob patterns to exclude
 */
export function resolveExcludePatterns(presetNames = [], customPatterns = []) {
  const patterns = [];

  for (const rawName of presetNames) {
    const name = String(rawName || '').trim();
    if (!name) continue;
    if (!PRESETS[name]) {
      const available = Object.keys(PRESETS).join(', ');
      console.warn(chalk.yellow(`⚠ Unknown exclude preset: "${name}". Available: ${available}`));
      continue;
    }
    patterns.push(...PRESETS[name]);
  }

  for (const raw of customPatterns) {
    const p = String(raw || '').trim();
    if (p) patterns.push(p);
  }

  return patterns;
}

/**
 * Check whether a file path matches any exclusion pattern.
 *
 * @param {string} filePath - path relative to scan root, forward slashes
 * @param {string[]} patterns - resolved glob patterns
 * @returns {boolean}
 */
export function isExcluded(filePath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return patterns.some(p => minimatch(normalized, p, { dot: true, nocase: true }));
}

/**
 * List available preset names.
 */
export function listPresets() {
  return Object.keys(PRESETS);
}

/**
 * Apply exclusions to a list of file paths and return the survivors + count of skipped.
 *
 * @param {string[]} filePaths
 * @param {string} basePath - so we can build relative paths for pattern matching
 * @param {string[]} patterns
 * @returns {{ kept: string[], excluded: number }}
 */
export function filterPaths(filePaths, basePath, patterns) {
  if (!patterns || patterns.length === 0) {
    return { kept: filePaths, excluded: 0 };
  }
  let excluded = 0;
  const kept = [];
  for (const fp of filePaths) {
    // Build a relative path; handle both absolute and already-relative inputs.
    let rel = fp;
    if (basePath && fp.startsWith(basePath)) {
      rel = fp.slice(basePath.length).replace(/^[\\/]/, '');
    }
    if (isExcluded(rel, patterns)) {
      excluded++;
    } else {
      kept.push(fp);
    }
  }
  return { kept, excluded };
}
