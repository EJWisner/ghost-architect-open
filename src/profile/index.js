/**
 * Ghost Partner — Profile loader
 *
 * Reads a consultant profile from disk and returns a normalized object that
 * `prompts/index.js` can inject into the scan system prompt.
 *
 * Schema follows Ghost Partner spec v0.6, §6.1. Field names match the
 * canonical YAML example so a profile authored against the spec "just works":
 *
 *   name:          string   // e.g. "Dustin Rea — SaaS MVP Assessment"
 *   description:   string
 *   author:        string   // consultant name (drives PDF "Prepared by")
 *   organization:  string
 *   version:       string   // author-controlled, e.g. "3"
 *   last_updated:  string   // ISO date
 *   priorities:    string[] // what they zero in on
 *   anti_patterns: string[] // patterns they call out
 *   red_flags:     string[] // severity-elevating signals
 *   branding:      { company_name?, logo_path?, accent_color? }
 *   prose:         string   // freeform narrative preserved from MD/TXT input
 *   raw:           string   // original source, always preserved
 *
 * Source format is auto-detected by extension:
 *   .yaml / .yml     — parsed directly, no LLM call
 *   .md / .markdown  — frontmatter YAML if present, plus recognized sections
 *                      (## Priorities, ## Anti-patterns, ## Red flags,
 *                      ## Branding). Prose outside recognized sections is
 *                      preserved under `prose`. If nothing recognizable is
 *                      found, the body falls through to LLM extraction.
 *   anything else    — plain text, full LLM extraction via extractor.js
 *
 * Extraction results are cached in ~/.ghost/profiles/.cache/ keyed by source
 * hash so the LLM call only runs when the source file changes (spec §6.1).
 *
 * Usage:
 *   import { loadProfile } from './profile/index.js';
 *   const profile = await loadProfile('./profiles/dustin.md');  // null if no path
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import YAML from 'yaml';
import { extractProfile } from './extractor.js';

const CACHE_DIR = path.join(os.homedir(), '.ghost', 'profiles', '.cache');

// Fields we expect from parsers/extractors. Unknown fields get preserved
// under `extra` so authors can experiment without us silently dropping data.
const KNOWN_SCALAR_FIELDS = new Set([
  'name', 'description', 'author', 'organization', 'version', 'last_updated',
]);
const KNOWN_ARRAY_FIELDS = new Set([
  'priorities', 'anti_patterns', 'red_flags',
]);
// `branding` is an object, `prose` is a freeform string — handled separately.

/**
 * Load and normalize a profile file.
 *
 * @param {string|null|undefined} filePath — falsy returns null (no profile).
 * @returns {Promise<object|null>}
 * @throws {Error} with a friendly message if the file can't be read or parsed.
 */
export async function loadProfile(filePath) {
  if (!filePath) return null;

  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Profile file not found: ${filePath}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(`Could not read profile file ${filePath}: ${err.message}`);
  }

  if (!raw.trim()) {
    throw new Error(`Profile file is empty: ${filePath}`);
  }

  const ext = path.extname(abs).toLowerCase();

  if (ext === '.yaml' || ext === '.yml') {
    return normalize(parseYaml(raw, filePath), raw, abs);
  }

  if (ext === '.md' || ext === '.markdown') {
    return normalize(await parseMarkdown(raw, filePath, abs), raw, abs);
  }

  // .txt or anything unknown — full LLM extraction, cached.
  return normalize(await extractWithCache(raw, abs), raw, abs);
}

// ─────────────────────────────────────────────────────────────────────────────
// YAML
// ─────────────────────────────────────────────────────────────────────────────

function parseYaml(raw, filePath) {
  try {
    const parsed = YAML.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Profile YAML did not parse to an object (got ${typeof parsed})`);
    }
    return parsed;
  } catch (err) {
    throw new Error(`Could not parse YAML profile ${filePath}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown — frontmatter + recognized section headers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Markdown parsing strategy per spec §6.1:
 *   1. If YAML frontmatter is present, parse it as the structured baseline.
 *   2. Walk headings. Recognized headings (## Priorities, ## Anti-patterns,
 *      ## Red flags, ## Branding) turn into structured fields:
 *        - Bullet lists become array entries.
 *        - Key: value lines inside ## Branding become the branding object.
 *        - Prose (non-list content under a recognized heading) is appended
 *          to `prose` with a heading hint so the scan prompt still sees it.
 *   3. Content under non-recognized headings is appended to `prose` verbatim.
 *   4. If after all that we still have nothing structured and no prose hints,
 *      fall back to LLM extraction on the whole body.
 *
 * Frontmatter fields override section-derived fields on collision — authors
 * who declare `priorities:` in frontmatter meant it.
 */
async function parseMarkdown(raw, filePath, absPath) {
  const { frontmatter, body } = splitFrontmatter(raw);

  let frontData = {};
  if (frontmatter) {
    try {
      frontData = YAML.parse(frontmatter) || {};
    } catch (err) {
      throw new Error(`Could not parse frontmatter in ${filePath}: ${err.message}`);
    }
  }

  const { sections, proseBuffer } = parseMarkdownSections(body);

  // Empty body: trust the frontmatter alone.
  if (!body.trim()) return frontData;

  // No recognized sections AND no frontmatter: fall back to LLM extraction.
  // This handles the case where someone writes a pure-prose .md file.
  const hasStructuredFrontmatter = Object.keys(frontData).length > 0;
  const hasRecognizedSections    = Object.keys(sections).length > 0;
  if (!hasStructuredFrontmatter && !hasRecognizedSections) {
    return await extractWithCache(body, absPath);
  }

  // Merge: sections first, frontmatter wins on conflict, prose tacked on.
  const merged = { ...sections, ...frontData };
  if (proseBuffer.trim()) merged.prose = proseBuffer.trim();
  return merged;
}

function splitFrontmatter(raw) {
  const match = raw.match(/^\uFEFF?\s*---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: raw };
  return { frontmatter: match[1], body: match[2] };
}

/**
 * Walk a markdown body and split it into recognized structured sections plus
 * a prose buffer for everything else.
 *
 * We recognize:
 *   ## Priorities       → priorities[]
 *   ## Anti-patterns    → anti_patterns[]   (also "Anti patterns", "Antipatterns")
 *   ## Red flags        → red_flags[]
 *   ## Branding         → branding{}   (key: value lines)
 *
 * Recognition is case-insensitive and tolerates both `##` and `###` depth.
 */
function parseMarkdownSections(body) {
  const sections = {};
  let proseBuffer = '';
  if (!body) return { sections, proseBuffer };

  const lines = body.split('\n');
  let currentHeading = null; // { name, recognized: 'priorities' | 'anti_patterns' | 'red_flags' | 'branding' | null }
  let currentBuffer = [];

  const flush = () => {
    if (!currentHeading) {
      // Content before any heading → prose.
      const text = currentBuffer.join('\n').trim();
      if (text) proseBuffer += (proseBuffer ? '\n\n' : '') + text;
      currentBuffer = [];
      return;
    }

    const { recognized, name } = currentHeading;
    const chunk = currentBuffer.join('\n');

    if (recognized === 'branding') {
      sections.branding = parseBrandingBlock(chunk);
    } else if (recognized) {
      const items = extractBulletItems(chunk);
      if (items.length) sections[recognized] = items;
      // If the recognized section had prose too (non-list lines), keep them
      // under prose so the scan prompt still sees the consultant's voice.
      const prose = extractNonBulletProse(chunk);
      if (prose) proseBuffer += (proseBuffer ? '\n\n' : '') + `## ${name}\n${prose}`;
    } else {
      // Unrecognized heading → prose, verbatim with its heading.
      const chunkTrimmed = chunk.trim();
      if (chunkTrimmed) proseBuffer += (proseBuffer ? '\n\n' : '') + `## ${name}\n${chunkTrimmed}`;
    }
    currentBuffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      const name = headingMatch[1].replace(/[*_]/g, '').trim();
      currentHeading = { name, recognized: recognizeHeading(name) };
      continue;
    }
    currentBuffer.push(line);
  }
  flush();

  return { sections, proseBuffer };
}

function recognizeHeading(name) {
  const normalized = name.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'priorities')          return 'priorities';
  if (normalized === 'antipatterns')        return 'anti_patterns';
  if (normalized === 'redflags')            return 'red_flags';
  if (normalized === 'branding')            return 'branding';
  // Spec-adjacent synonyms that'll show up in real-world profiles.
  if (normalized === 'focusareas')          return 'priorities';
  if (normalized === 'patternsihate')       return 'anti_patterns';
  return null;
}

function extractBulletItems(text) {
  const items = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$/);
    if (m) items.push(stripInlineMd(m[1]));
  }
  return items;
}

function extractNonBulletProse(text) {
  const proseLines = [];
  for (const line of text.split('\n')) {
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) continue; // skip bullets
    if (line.trim()) proseLines.push(line);
  }
  return proseLines.join('\n').trim();
}

function parseBrandingBlock(text) {
  const branding = {};
  for (const line of text.split('\n')) {
    const kv = line.match(/^\s*(?:[-*+]\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.+?)\s*$/);
    if (kv) {
      const key = kv[1].toLowerCase();
      const val = stripInlineMd(kv[2]).replace(/^["']|["']$/g, '');
      branding[key] = val;
    }
  }
  return branding;
}

function stripInlineMd(s) {
  return s.replace(/[`*_]/g, '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM extraction with on-disk cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a profile from prose and cache the result on disk so we don't pay
 * the LLM cost on every scan. Cache key is a hash of the source text, so
 * editing the profile invalidates the cache automatically.
 */
async function extractWithCache(text, absPath) {
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  const cachePath = path.join(CACHE_DIR, `${hash}.json`);

  // Hit: return cached extraction.
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      // Corrupted cache — ignore and re-extract.
    }
  }

  const extracted = await extractProfile(text);

  // Best-effort cache write. Never block the scan on a cache failure.
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(extracted, null, 2), 'utf8');
  } catch { /* non-fatal */ }

  return extracted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization — coerce parser/extractor output into the canonical shape
// ─────────────────────────────────────────────────────────────────────────────

function normalize(data, rawSource, absPath) {
  if (!data || typeof data !== 'object') {
    return { raw: rawSource, sourcePath: absPath };
  }

  const out = {};
  const extra = {};

  for (const [key, val] of Object.entries(data)) {
    if (KNOWN_SCALAR_FIELDS.has(key)) {
      const s = toTrimmedString(val);
      if (s) out[key] = s;
    } else if (KNOWN_ARRAY_FIELDS.has(key)) {
      const arr = toStringArray(val);
      if (arr.length) out[key] = arr;
    } else if (key === 'branding') {
      const b = normalizeBranding(val);
      if (b) out.branding = b;
    } else if (key === 'prose') {
      const s = toTrimmedString(val);
      if (s) out.prose = s;
    } else {
      extra[key] = val;
    }
  }

  if (Object.keys(extra).length) out.extra = extra;
  out.raw = rawSource;
  out.sourcePath = absPath;

  return out;
}

function normalizeBranding(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    const s = toTrimmedString(v);
    if (s) out[k.toLowerCase()] = s;
  }
  return Object.keys(out).length ? out : null;
}

function toTrimmedString(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val).trim();
}

function toStringArray(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map(v => toTrimmedString(v)).filter(Boolean);
  if (typeof val === 'string') {
    return val.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  }
  const s = toTrimmedString(val);
  return s ? [s] : [];
}
