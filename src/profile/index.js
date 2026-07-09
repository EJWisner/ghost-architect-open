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

// Cache hygiene. The extraction cache writes one JSON file per source hash, so
// it grows every time a prose profile's text changes and never shrinks on its
// own. MAX_CACHE_FILES bounds it on an LRU basis (file mtime = last use; cache
// hits touch the file). CACHE_SIZE_WARN_BYTES is a soft ceiling that only
// drives a startup warning — we never auto-delete on size, count handles that.
const MAX_CACHE_FILES = 20;
const CACHE_SIZE_WARN_BYTES = 50 * 1024 * 1024; // 50 MB

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

  // Hit: return cached extraction. Touch the file first so a re-read counts as
  // recent use for LRU eviction, not just recent creation.
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      touchCacheFile(cachePath);
      return cached;
    } catch {
      // Corrupted cache — ignore and re-extract.
    }
  }

  const extracted = await extractProfile(text);

  // Best-effort cache write. Never block the scan on a cache failure.
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(extracted, null, 2), 'utf8');
    evictCache(); // keep only the MAX_CACHE_FILES most recently used entries
  } catch { /* non-fatal */ }

  return extracted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache maintenance — LRU eviction, manual purge, and a size warning
//
// One JSON file per source hash lives in CACHE_DIR. Left alone it grows every
// time a prose profile's text changes, so extractWithCache() caps the count at
// MAX_CACHE_FILES on an LRU basis after each write. cleanCache() lets a user
// purge the whole cache by hand (wire to `ghost --clean-cache`); getCacheSize()
// backs a soft startup warning when the dir crosses CACHE_SIZE_WARN_BYTES.
//
// Everything here is best-effort and silent: cache hygiene must never break or
// slow a scan, so a missing dir or an unreadable/locked entry is swallowed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List cache entries with their stats, most-recently-used first (mtime desc).
 * Returns [] when the cache dir doesn't exist yet. Never throws.
 *
 * @returns {Array<{ path: string, mtimeMs: number, size: number }>}
 */
function listCacheFiles() {
  let names;
  try {
    names = fs.readdirSync(CACHE_DIR);
  } catch {
    return []; // no cache dir yet, or unreadable
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(CACHE_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) entries.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch { /* vanished or unreadable entry — skip it */ }
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Mark a cache file as freshly used so LRU eviction keeps it around. */
function touchCacheFile(file) {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch { /* non-fatal — eviction just falls back to creation order */ }
}

/**
 * Evict all but the MAX_CACHE_FILES most-recently-used cache entries.
 *
 * @returns {number} count of files deleted
 */
function evictCache() {
  const entries = listCacheFiles();
  if (entries.length <= MAX_CACHE_FILES) return 0;
  let removed = 0;
  for (const entry of entries.slice(MAX_CACHE_FILES)) {
    try {
      fs.unlinkSync(entry.path);
      removed++;
    } catch { /* already gone or locked — leave it */ }
  }
  return removed;
}

/**
 * Remove every extraction-cache file. Backs a manual `ghost --clean-cache`.
 * Returns a summary so the caller can report what it freed.
 *
 * @returns {{ removed: number, bytesFreed: number }}
 */
export function cleanCache() {
  const entries = listCacheFiles();
  let removed = 0;
  let bytesFreed = 0;
  for (const entry of entries) {
    try {
      fs.unlinkSync(entry.path);
      removed++;
      bytesFreed += entry.size;
    } catch { /* skip — already gone or locked */ }
  }
  return { removed, bytesFreed };
}

/**
 * Total on-disk size of the extraction cache, with a flag for whether it has
 * crossed the soft warning ceiling. Backs a one-line startup warning; the
 * caller decides how (or whether) to surface it.
 *
 * @returns {{ bytes: number, files: number, limit: number, exceedsLimit: boolean }}
 */
export function getCacheSize() {
  const entries = listCacheFiles();
  const bytes = entries.reduce((sum, e) => sum + e.size, 0);
  return {
    bytes,
    files: entries.length,
    limit: CACHE_SIZE_WARN_BYTES,
    exceedsLimit: bytes > CACHE_SIZE_WARN_BYTES,
  };
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
    } else if (key === 'rates') {
      // Per-profile rate overrides. Each rate (junior/mid/senior) is
      // optional; whatever the profile declares replaces the global
      // value at scan time, while undeclared rates fall through to the
      // global config. See mergeRates() below.
      const r = normalizeRates(val);
      if (r) out.rates = r;
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

/**
 * Coerce a profile's `rates` block into the canonical { junior, mid, senior }
 * shape. Each field is optional; values that aren't positive finite numbers
 * are dropped silently so a typo in one rate doesn't suppress the others.
 * Returns null when nothing usable was found, so the caller can use it as
 * a presence check.
 *
 * Accepts:
 *   rates: { junior: 95, mid: 150, senior: 250 }       all three
 *   rates: { mid: 150 }                                  partial
 *   rates: { senior: '250' }                             string-as-number
 *   rates: { junior: -10 }                               dropped (invalid)
 *   rates: 'not an object'                               returns null
 */
function normalizeRates(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const out = {};
  for (const tier of ['junior', 'mid', 'senior']) {
    const raw = val[tier];
    if (raw == null) continue;
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (Number.isFinite(n) && n > 0) out[tier] = n;
  }
  return Object.keys(out).length ? out : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rates merge — single source of truth for resolving the rate set used at
// scan time. The global rate set (from config) is the baseline; the profile
// overrides whatever it declares. Tiers the profile leaves undeclared keep
// the global value. This means a profile with `rates: { mid: 150 }` ends
// up with junior + senior from config and mid from the profile.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge global rates with a profile's optional rate overrides.
 *
 * @param {{junior:number, mid:number, senior:number}} globalRates
 *        The fallback rate set, typically from getConfig() in the host.
 * @param {object|null|undefined} profile
 *        A loaded profile (or null). When the profile carries a `rates`
 *        block, those values override the matching tiers; absent tiers
 *        fall through to globalRates.
 * @returns {{junior:number, mid:number, senior:number}}
 *        A new object — inputs are not mutated.
 *
 * Behavior contract:
 *   - profile == null               returns a copy of globalRates
 *   - profile.rates == null         returns a copy of globalRates
 *   - profile.rates = { mid: 150 }  returns { junior: global, mid: 150, senior: global }
 *   - all three declared            returns the profile values verbatim
 */
// @ghost-verified: mergeRates requires caller to pass globalRates populated from getConfig() -- all production callers (poi.js, blast.js, watcher-commit.js) correctly pass getRates(); the hardcoded defaults are only a fallback for callers that omit globalRates
export function mergeRates(globalRates, profile) {
  const base = {
    junior: globalRates && Number.isFinite(globalRates.junior) ? globalRates.junior : 85,
    mid:    globalRates && Number.isFinite(globalRates.mid)    ? globalRates.mid    : 125,
    senior: globalRates && Number.isFinite(globalRates.senior) ? globalRates.senior : 200,
  };
  if (!profile || !profile.rates) return base;
  return { ...base, ...profile.rates };
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

// ───────────────────────────────────────────────────────────────────────────
// Branding extraction — single source of truth for white-label rendering
// ───────────────────────────────────────────────────────────────────────────

/**
 * Extract a normalized branding bundle from a loaded profile.
 *
 * Returns an object PDF and Markdown layers can consume without traversing
 * the profile structure themselves. When `profile` is null/undefined, returns
 * `null` so callers can do `branding ? whiteLabel(branding) : ghostDefault()`
 * with one check.
 *
 * Fields:
 *   isWhiteLabeled  — true when a profile is present (any profile triggers
 *                     full white-label mode; v0.1 ships full or nothing)
 *   companyName     — from branding.company_name, then organization, then
 *                     author, then 'Pre-Engagement Triage'
 *   author          — from author, then organization, then '' (renders as
 *                     'Prepared by <author>' on the cover)
 *   methodology     — from name (the profile title, e.g. 'SaaS MVP Assessment')
 *   description     — from description (one-line tagline, optional)
 *   logoPath        — absolute path to a logo image, resolved against the
 *                     profile's source directory if relative. Null if not
 *                     present or file doesn't exist on disk.
 *   accentColor     — [r,g,b] tuple parsed from branding.accent_color (#RRGGBB
 *                     or #RGB hex). Falls back to a neutral dark slate so the
 *                     cover never renders unstyled.
 *   footerText      — from branding.footer_text, falls back to companyName.
 *   confidentiality — from branding.confidentiality, falls back to
 *                     'Confidential — Prepared for [companyName] engagement use'
 */
// @ghost-verified: logo_path key is consistent between writer.js renderProfileYaml and index.js getBranding -- no conflict
export function getBranding(profile) {
  if (!profile || typeof profile !== 'object') return null;

  const branding = profile.branding || {};

  const companyName =
       toTrimmedString(branding.company_name)
    || toTrimmedString(profile.organization)
    || toTrimmedString(profile.author)
    || 'Pre-Engagement Triage';

  const author      = toTrimmedString(profile.author) || toTrimmedString(profile.organization) || '';
  const methodology = toTrimmedString(profile.name) || '';
  const description = toTrimmedString(profile.description) || '';

  // Resolve logo path: if relative, resolve against the profile source dir
  // so a profile at /tmp/gp-test/dustin.yaml referring to ./logo.png picks
  // up /tmp/gp-test/logo.png. If not present or missing on disk, return null.
  let logoPath = null;
  const rawLogo = toTrimmedString(branding.logo_path);
  if (rawLogo) {
    const sourceDir = profile.sourcePath ? path.dirname(profile.sourcePath) : process.cwd();
    const resolved  = path.isAbsolute(rawLogo) ? rawLogo : path.resolve(sourceDir, rawLogo);
    if (fs.existsSync(resolved)) logoPath = resolved;
  }

  // Parse accent color hex; fall back to a neutral slate (#1F2937) so the
  // cover is never rendered with an undefined fill.
  const accentColor = parseHexColor(branding.accent_color) || [31, 41, 55];

  const footerText = toTrimmedString(branding.footer_text) || companyName;

  const confidentiality =
       toTrimmedString(branding.confidentiality)
    || `Confidential -- Prepared for ${companyName} engagement use`;

  return {
    isWhiteLabeled: true,
    companyName,
    author,
    methodology,
    description,
    logoPath,
    accentColor,
    footerText,
    confidentiality,
  };
}

/**
 * Parse a CSS hex color (#RRGGBB, #RGB, or bare RRGGBB / RGB) into an
 * [r,g,b] tuple. Returns null on any parse failure so callers can fall back
 * to a default.
 */
function parseHexColor(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) return null;
  if (cleaned.length === 3) {
    return [
      parseInt(cleaned[0] + cleaned[0], 16),
      parseInt(cleaned[1] + cleaned[1], 16),
      parseInt(cleaned[2] + cleaned[2], 16),
    ];
  }
  if (cleaned.length === 6) {
    return [
      parseInt(cleaned.slice(0, 2), 16),
      parseInt(cleaned.slice(2, 4), 16),
      parseInt(cleaned.slice(4, 6), 16),
    ];
  }
  return null;
}
