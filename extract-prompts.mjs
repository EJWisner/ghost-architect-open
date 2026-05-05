#!/usr/bin/env node
/**
 * extract-prompts.mjs
 *
 * One-shot script to render Ghost Architect's top-level system prompts
 * into standalone .md files under prompts-extracted/. Output is the
 * dogfood corpus for Prompt Triage v1 — these are the prompts the LLM
 * actually sees when Ghost runs a scan.
 *
 * Run with:
 *   node extract-prompts.mjs
 *
 * Output: prompts-extracted/*.md
 *
 * Safe to delete after generation. Re-run anytime prompts/ changes to
 * regenerate the corpus.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  SYSTEM_CHAT,
  buildSystemPOI,
  buildSystemBlast,
} from './prompts/index.js';

import { buildSystemConflict } from './prompts/conflict.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const OUT_DIR    = path.join(__dirname, 'prompts-extracted');

// Default billing rates the prompt builders fall back to when no rates
// argument is passed. Mirroring these here keeps the extractor's output
// stable across rate-config changes; the corpus represents "default Ghost"
// not "EJ's local rates".
const DEFAULT_RATES = { junior: 85, mid: 125, senior: 200 };

// Generic agency-consultant profile for profile-aware prompt variants.
// Picked to be representative of what an agency founder running a
// pre-engagement audit on an inherited Magento codebase would author.
// Not modeled on any real consultant; the field shapes match what
// src/profile/index.js produces.
const SAMPLE_PROFILE = {
  author: 'Sample Consultant',
  organization: 'Acme Agency',
  name: 'magento-pre-engagement',
  description:
    'Pre-engagement audit methodology for inherited Magento and Adobe Commerce ' +
    'codebases. Focuses on PCI compliance, performance regressions, and integration ' +
    'risk before quoting a fixed-price engagement.',
  priorities: [
    'PCI-DSS surface area in payment integration code',
    'SAP and ERP integration timeouts and retry behavior',
    'Customer PII handling in logs, exports, and admin views',
    'Caching strategy and full-page-cache misses on category pages',
  ],
  anti_patterns: [
    'Hardcoded credentials, tokens, or API keys in source',
    'Direct database access bypassing the resource model layer',
    'Synchronous external API calls inside checkout',
    'Custom modules overriding core admin ACL without audit trail',
  ],
  red_flags: [
    'Unsanitized user input flowing to SQL or shell',
    'PCI-relevant data persisted outside tokenized fields',
    'Missing rate limits on customer-facing REST endpoints',
    'Composer dependencies pinned to specific commit hashes',
  ],
  prose:
    'Frame findings the way a senior architect would brief an incoming ' +
    'client CTO: lead with risk, name the specific files and patterns, give ' +
    'a concrete fix path, and quantify remediation cost. Avoid academic ' +
    'language; the audience is making a buy/no-buy decision.',
};

function ensureOutDir() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

function write(name, content) {
  const filepath = path.join(OUT_DIR, name);
  fs.writeFileSync(filepath, content, 'utf8');
  const size = Buffer.byteLength(content, 'utf8');
  console.log('  wrote ' + name + ' (' + size + ' bytes)');
}

function header(title, source) {
  return [
    '<!--',
    'Ghost Architect dogfood corpus entry',
    '',
    'Title:  ' + title,
    'Source: ' + source,
    'Generated: ' + new Date().toISOString(),
    '',
    'This file is a snapshot of a real Ghost Architect system prompt.',
    'Used as a test fixture for Prompt Triage detectors.',
    '-->',
    '',
  ].join('\n');
}

function main() {
  console.log('Extracting Ghost Architect prompts to prompts-extracted/');
  ensureOutDir();

  // 01 — Chat system prompt (static, no parameters)
  write(
    '01-chat-system.md',
    header('Chat mode system prompt', 'prompts/index.js :: SYSTEM_CHAT')
      + SYSTEM_CHAT
      + '\n'
  );

  // 02 — POI system prompt, default rates, no profile
  write(
    '02-poi-default.md',
    header(
      'Points of Interest system prompt (no profile)',
      'prompts/index.js :: buildSystemPOI(DEFAULT_RATES, null)'
    )
      + buildSystemPOI(DEFAULT_RATES, null)
      + '\n'
  );

  // 03 — POI system prompt, default rates, sample profile
  write(
    '03-poi-with-profile.md',
    header(
      'Points of Interest system prompt (with consultant profile)',
      'prompts/index.js :: buildSystemPOI(DEFAULT_RATES, SAMPLE_PROFILE)'
    )
      + buildSystemPOI(DEFAULT_RATES, SAMPLE_PROFILE)
      + '\n'
  );

  // 04 — Blast system prompt, default rates, no profile
  write(
    '04-blast-default.md',
    header(
      'Blast Radius system prompt (no profile)',
      'prompts/index.js :: buildSystemBlast(DEFAULT_RATES, null)'
    )
      + buildSystemBlast(DEFAULT_RATES, null)
      + '\n'
  );

  // 05 — Blast system prompt, default rates, sample profile
  write(
    '05-blast-with-profile.md',
    header(
      'Blast Radius system prompt (with consultant profile)',
      'prompts/index.js :: buildSystemBlast(DEFAULT_RATES, SAMPLE_PROFILE)'
    )
      + buildSystemBlast(DEFAULT_RATES, SAMPLE_PROFILE)
      + '\n'
  );

  // 06 — Conflict system prompt, no profile
  write(
    '06-conflict-default.md',
    header(
      'Conflict Detection system prompt (no profile)',
      'prompts/conflict.js :: buildSystemConflict(null)'
    )
      + buildSystemConflict(null)
      + '\n'
  );

  // 07 — Conflict system prompt, sample profile
  write(
    '07-conflict-with-profile.md',
    header(
      'Conflict Detection system prompt (with consultant profile)',
      'prompts/conflict.js :: buildSystemConflict(SAMPLE_PROFILE)'
    )
      + buildSystemConflict(SAMPLE_PROFILE)
      + '\n'
  );

  // README for the corpus folder itself
  write(
    'README.md',
    [
      '# prompts-extracted',
      '',
      'Snapshot of Ghost Architect\'s top-level system prompts, rendered to ',
      'standalone Markdown files. Used as the dogfood corpus for Prompt Triage ',
      'detectors during v1 development.',
      '',
      'Each `.md` file in this folder is the exact text the LLM sees when Ghost ',
      'runs a scan in the corresponding mode. The leading HTML comment block ',
      'identifies the source builder and generation timestamp.',
      '',
      '## Contents',
      '',
      '| File | Mode | Profile |',
      '| --- | --- | --- |',
      '| 01-chat-system.md | Chat | (none, static prompt) |',
      '| 02-poi-default.md | Points of Interest | none |',
      '| 03-poi-with-profile.md | Points of Interest | sample agency profile |',
      '| 04-blast-default.md | Blast Radius | none |',
      '| 05-blast-with-profile.md | Blast Radius | sample agency profile |',
      '| 06-conflict-default.md | Conflict Detection | none |',
      '| 07-conflict-with-profile.md | Conflict Detection | sample agency profile |',
      '',
      '## How this corpus was generated',
      '',
      'Run `node extract-prompts.mjs` from the repo root. The script imports the ',
      'public prompt builders (`buildSystemPOI`, `buildSystemBlast`, ',
      '`buildSystemConflict`) and `SYSTEM_CHAT`, calls each with default billing ',
      'rates and either no profile or a representative sample agency profile, ',
      'then writes the rendered output to this folder.',
      '',
      'Re-run anytime the source prompts change. Treat this corpus as a snapshot, ',
      'not a live mirror.',
      '',
      '## Sample profile fields',
      '',
      'The profile-aware variants use a generic agency-consultant profile (priorities ',
      'around PCI, SAP integration, PII handling; anti-patterns around hardcoded ',
      'credentials and direct DB access; etc.). The exact field values are in ',
      'extract-prompts.mjs at the top of the file.',
      '',
      '## Out of scope for v1',
      '',
      'Not included in this corpus:',
      '',
      '- Internal narrator/verifier prompts (require runtime findings + plans to render)',
      '- Per-pass user messages (scan-specific, not "prompts" in the audit sense)',
      '- Conflict per-pass user messages from buildConflictPrompt (same reason)',
      '',
      'These may be added to v2 if the Prompt Triage scope expands to internal ',
      'pipeline auditing.',
      '',
    ].join('\n')
  );

  console.log('Done. Output in: ' + OUT_DIR);
}

main();
