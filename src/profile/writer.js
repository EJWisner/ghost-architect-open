/**
 * Ghost Partner — Profile writer
 *
 * Takes a structured profile object (the output of the profile wizard)
 * and writes it to disk as a YAML file with section comments so a customer
 * who later opens the file in an editor can see what each section means.
 *
 * Files are saved by default to ~/.ghost/profiles/{slug}.yaml. The slug is
 * derived from the profile name. Returns the absolute path on success.
 *
 * The writer is deliberately separate from the wizard so:
 *   - The wizard module can be exercised in tests without touching disk.
 *   - Future entry points (e.g. an "import profile" command, a programmatic
 *     SDK, or auto-converting a TXT extraction into a YAML) can reuse the
 *     same canonical YAML emitter.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const PROFILES_DIR = path.join(os.homedir(), '.ghost', 'profiles');

/**
 * Slugify a profile name for use as a filename.
 *   "OSC Performance Audit"  →  "osc-performance-audit"
 *   "Dustin Rea — MVP Audit" →  "dustin-rea-mvp-audit"
 *
 * Falls back to "profile" when the name is empty/unusable so we never
 * generate a hidden file or a path that crashes the writer.
 */
export function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/[^a-z0-9]+/g, '-')        // anything else → hyphen
    .replace(/^-+|-+$/g, '')            // trim leading/trailing hyphens
    .slice(0, 60);                      // keep filenames sane
  return base || 'profile';
}

export function getProfilesDir() {
  return PROFILES_DIR;
}

/**
 * Resolve a profile name (or partial path) to its expected on-disk path.
 * Used by callers that want to check existence before overwriting.
 */
export function profilePathFor(name) {
  return path.join(PROFILES_DIR, `${slugify(name)}.yaml`);
}

/**
 * Write a profile object to ~/.ghost/profiles/{slug}.yaml.
 *
 * @param {object} profile  Wizard-shaped object. Required: name. Optional:
 *                          author, organization, description,
 *                          priorities[], anti_patterns[], red_flags[],
 *                          rates {junior, mid, senior},
 *                          branding {company_name, accent_color, logo_path,
 *                                    footer_text, confidentiality}
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite=false]  When true, replaces an existing
 *                                          file silently. When false and a
 *                                          file already exists, throws.
 * @returns {string}  Absolute path to the written file.
 *
 * Overwrite safety: when replacing an existing profile (overwrite=true), the
 * original is first copied to `{slug}.yaml.bak`, and the new content is written
 * to a temp file that is atomically renamed into place. If the write fails part
 * way through, the original profile is recoverable from the `.bak` file. The
 * backup is left in place after a successful write so a Partner can still revert
 * a profile they did not mean to change.
 */
export function writeProfile(profile, opts = {}) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('writeProfile: profile object required');
  }
  if (!profile.name || !String(profile.name).trim()) {
    throw new Error('writeProfile: profile.name is required');
  }

  const targetPath = profilePathFor(profile.name);

  if (!opts.overwrite && fs.existsSync(targetPath)) {
    throw new Error(
      `Profile already exists: ${targetPath}\n` +
      `Pass { overwrite: true } to replace it, or pick a different name.`
    );
  }

  fs.mkdirSync(PROFILES_DIR, { recursive: true });

  const content = renderProfileYaml(profile);

  // Back up the existing profile before we touch it, so a malformed write
  // (or a profile the Partner did not mean to replace) is always recoverable.
  if (fs.existsSync(targetPath)) {
    fs.copyFileSync(targetPath, `${targetPath}.bak`);
  }

  // Write to a temp file first, then atomically rename into place. A crash or
  // I/O error mid-write leaves the original (or its .bak) intact rather than a
  // half-written target.
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
    throw err;
  }

  return targetPath;
}

/**
 * Convert a wizard-shaped profile into a YAML string with section comments.
 *
 * We hand-roll the YAML rather than using a YAML library so:
 *   1. Comments survive (most YAML libraries strip or reformat them).
 *   2. Field order is deterministic and matches what the loader expects.
 *   3. Arrays are emitted as `- item` block style, not flow style.
 *
 * Exported for testing.
 */
export function renderProfileYaml(profile) {
  const lines = [];

  // ── Header comment block ──────────────────────────────────────────────────
  lines.push('# Ghost Partner™ profile');
  lines.push('# Generated by `ghost --create-profile` — edit any field below.');
  lines.push('# To use this profile in a scan:');
  lines.push(`#   ghost --profile ${profilePathFor(profile.name)}`);
  lines.push('# To set as your default profile (auto-applied to every scan):');
  lines.push(`#   ghost --set-default-profile ${slugify(profile.name)}`);
  lines.push('');

  // ── Identity ──────────────────────────────────────────────────────────────
  lines.push('# Profile identity. `name` is required; the rest are optional.');
  lines.push(`name: ${yamlString(profile.name)}`);
  if (profile.description) lines.push(`description: ${yamlString(profile.description)}`);
  if (profile.author)       lines.push(`author: ${yamlString(profile.author)}`);
  if (profile.organization) lines.push(`organization: ${yamlString(profile.organization)}`);
  if (profile.version)      lines.push(`version: ${yamlString(profile.version)}`);
  if (profile.last_updated) lines.push(`last_updated: ${yamlString(profile.last_updated)}`);
  lines.push('');

  // ── Priorities ────────────────────────────────────────────────────────────
  lines.push('# What you focus on first when reviewing a codebase.');
  lines.push('# These shape what the scanner emphasizes in findings.');
  lines.push('priorities:');
  for (const item of profile.priorities || []) {
    lines.push(`  - ${yamlString(item)}`);
  }
  lines.push('');

  // ── Anti-patterns ─────────────────────────────────────────────────────────
  lines.push('# Patterns you call out as wrong or problematic.');
  lines.push('# Findings matching these get extra emphasis in the report.');
  lines.push('anti_patterns:');
  for (const item of profile.anti_patterns || []) {
    lines.push(`  - ${yamlString(item)}`);
  }
  lines.push('');

  // ── Red flags ─────────────────────────────────────────────────────────────
  lines.push('# Signals that elevate severity — things that make a finding critical.');
  lines.push('red_flags:');
  for (const item of profile.red_flags || []) {
    lines.push(`  - ${yamlString(item)}`);
  }
  lines.push('');

  // ── Billing rates ─────────────────────────────────────────────────────────
  if (profile.rates && (profile.rates.junior || profile.rates.mid || profile.rates.senior)) {
    lines.push('# Per-profile billing rates ($/hr). Override the global config.');
    lines.push('# Any rate omitted falls through to your global rate.');
    lines.push('rates:');
    if (Number.isFinite(profile.rates.junior)) lines.push(`  junior: ${profile.rates.junior}`);
    if (Number.isFinite(profile.rates.mid))    lines.push(`  mid: ${profile.rates.mid}`);
    if (Number.isFinite(profile.rates.senior)) lines.push(`  senior: ${profile.rates.senior}`);
    lines.push('');
  }

  // ── Branding (white-label) ────────────────────────────────────────────────
  const b = profile.branding || {};
  const hasBranding = !!(b.company_name || b.accent_color || b.logo_path || b.footer_text || b.confidentiality);
  if (hasBranding) {
    lines.push('# White-label branding for PDF reports.');
    lines.push('# When loaded, Ghost replaces its own branding with yours.');
    lines.push('branding:');
    if (b.company_name)    lines.push(`  company_name: ${yamlString(b.company_name)}`);
    if (b.accent_color)    lines.push(`  accent_color: ${yamlString(b.accent_color)}`);
    if (b.logo_path)       lines.push(`  logo_path: ${yamlString(b.logo_path)}`);
    if (b.footer_text)     lines.push(`  footer_text: ${yamlString(b.footer_text)}`);
    if (b.confidentiality) lines.push(`  confidentiality: ${yamlString(b.confidentiality)}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Quote a YAML scalar. We always quote strings so colons, leading dashes,
 * and unicode in the value never accidentally turn into YAML structure.
 * Single quotes mean YAML treats the contents literally; we just have to
 * escape embedded single quotes by doubling them per the YAML 1.2 spec.
 */
function yamlString(val) {
  const s = String(val == null ? '' : val);
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * List all profiles currently saved under ~/.ghost/profiles/.
 * Returns an array of { slug, path, name } where `name` is parsed from
 * the file's `name:` field when readable, falling back to the slug.
 */
export function listProfiles() {
  if (!fs.existsSync(PROFILES_DIR)) return [];

  const out = [];
  for (const entry of fs.readdirSync(PROFILES_DIR)) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const full = path.join(PROFILES_DIR, entry);
    const slug = entry.replace(/\.(yaml|yml)$/i, '');
    let name = slug;
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const m = raw.match(/^name:\s*['"]?([^'"\n]+)['"]?\s*$/m);
      if (m) name = m[1].trim();
    } catch { /* keep slug as fallback */ }
    out.push({ slug, path: full, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Delete a profile by slug or absolute path. Returns true if a file was
 * removed, false if nothing matched.
 */
export function deleteProfile(slugOrPath) {
  const target = path.isAbsolute(slugOrPath)
    ? slugOrPath
    : path.join(PROFILES_DIR, `${slugOrPath}.yaml`);
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  return true;
}
