/**
 * Ghost Partner — Profile extractor
 *
 * Takes unstructured prose (a paragraph, a LinkedIn DM, a methodology memo
 * copied from a Google Doc) and extracts the normalized profile object
 * described in the Ghost Partner spec §6.1.
 *
 * Uses Anthropic's SDK directly — same pattern as src/analyst/index.js.
 * Called by src/profile/index.js for .txt files and for .md files that lack
 * both frontmatter and recognized section headers.
 *
 * The extractor returns JSON only. We parse strictly and surface the raw
 * response on failure so extraction bugs are obvious during development
 * rather than silently dropping fields.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getConfig, resolveApiKey } from '../config.js';

let client = null;

function getClient() {
  if (!client) {
    const apiKey = resolveApiKey();
    if (!apiKey) {
      throw new Error(
        'No Anthropic API key configured. Run `ghost` once to complete setup, ' +
        'or set ANTHROPIC_API_KEY before using --profile with a plain-text file.'
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

function getModel() {
  return getConfig().get('defaultModel') || 'claude-sonnet-4-6';
}

// Extraction prompt. Schema matches spec §6.1 field names exactly so a
// YAML-authored profile and an extracted prose profile produce compatible
// objects downstream.
const EXTRACTION_SYSTEM = `You extract a consultant's methodology from prose into a strict JSON object. You do NOT invent, embellish, or rewrite. You extract only what the source actually says.

Return ONLY valid JSON. No preamble, no code fences, no commentary.

Schema (all fields optional — omit or return empty if the source does not express them):
{
  "name":          string,    // profile name or title, e.g. "Dustin Rea — SaaS MVP Assessment". "" if unstated.
  "description":   string,    // one short sentence describing what this profile is for. "" if unclear.
  "author":        string,    // consultant's full name. "" if unstated.
  "organization":  string,    // firm or company name. "" if unstated.
  "priorities":    string[],  // what the consultant zeros in on during a review (architectural concerns, focus areas). 3–8 concrete items. [] if unclear.
  "anti_patterns": string[],  // specific patterns the consultant considers wrong or problematic. [] if unstated.
  "red_flags":     string[],  // signals that elevate severity — things that make the consultant call something critical. [] if unstated.
  "branding": {              // optional — include only if the source mentions branding, logos, colors, or company identity for reports
    "company_name":  string, // "" if unstated
    "logo_path":     string, // "" if unstated
    "accent_color":  string  // hex or named color, "" if unstated
  },
  "prose": string             // 1–3 sentence summary of the consultant's overall diagnostic voice — how they communicate findings. Preserve their tone. "" if unclear.
}

Rules:
- Fields not expressed in the source return "" for strings and [] for arrays. Never guess, never extrapolate.
- Preserve the consultant's phrasing. Do not paraphrase their concerns into your own words — copy the recognizable terms they use.
- Entries in priorities / anti_patterns / red_flags should be concrete and short (a phrase, not a paragraph). If the source lists things in bullet form, use those bullets.
- The "prose" field captures diagnostic voice, not a restatement of the priorities. Only include it if the source describes HOW the consultant communicates.
- No markdown, no bullets, no nested objects other than "branding". Flat JSON only.
- If the source is sparse, return a mostly-empty object. A small but accurate extraction is more useful than a padded one.`;

/**
 * Extract a profile from unstructured text.
 *
 * @param {string} text — raw prose from the consultant.
 * @returns {Promise<object>} — profile data (pre-normalization).
 * @throws {Error} if the API call fails or the response isn't valid JSON.
 */
export async function extractProfile(text) {
  if (!text || !text.trim()) {
    throw new Error('extractProfile: empty input');
  }

  const anthropic = getClient();

  let response;
  try {
    response = await anthropic.messages.create({
      model: getModel(),
      max_tokens: 1500,
      system: EXTRACTION_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            'Extract the consultant profile from this source. Return JSON only.\n\n' +
            '--- BEGIN SOURCE ---\n' +
            text +
            '\n--- END SOURCE ---',
        },
      ],
    });
  } catch (err) {
    throw new Error(`Profile extraction API call failed: ${err.message}`);
  }

  const content = response?.content?.[0]?.text || '';
  const json = extractJson(content);

  if (!json) {
    throw new Error(
      `Profile extractor returned non-JSON content. Got: ${truncate(content, 300)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Profile extractor returned invalid JSON (${err.message}). ` +
      `Got: ${truncate(json, 300)}`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Profile extractor did not return an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`
    );
  }

  return parsed;
}

/**
 * Pull a JSON object out of the LLM response.
 *
 * Claude is normally well-behaved under "JSON only" instructions, but we
 * defensively strip ``` fences and grab the first balanced { ... } block
 * so a stray preamble doesn't break extraction.
 */
function extractJson(text) {
  if (!text) return null;

  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned;

  // Fallback: find the first balanced top-level { ... } block.
  const start = cleaned.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
