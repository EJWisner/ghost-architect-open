/**
 * Ghost Partner — Profile creation wizard
 *
 * Interactive Q&A flow that produces a Ghost Partner profile YAML file.
 * Designed for consultants buying Ghost Pro who want to white-label their
 * scan reports without hand-writing YAML.
 *
 * Two entry points:
 *   - runProfileWizard()              — create a new profile from scratch
 *   - runProfileWizard({ existing })  — edit an existing profile, prefilling
 *                                       its current values as defaults
 *
 * The wizard does not write to disk itself; it returns the structured
 * profile object so the caller can decide whether to confirm, save, or
 * discard. writer.js handles persistence.
 *
 * Design notes
 *   - Free-text list questions (priorities, anti_patterns, red_flags) accept
 *     items separated by blank lines. The wizard prints clear instructions
 *     so the consultant knows when to stop typing. Inquirer's `editor`
 *     prompt opens $EDITOR for these — that's the only place a CLI flow
 *     can sanely accept multi-paragraph input.
 *   - The wizard tolerates skipped fields. A profile with just a name and
 *     three priorities is valid YAML and will load. We don't force the
 *     consultant to fill in every section.
 *   - Hex color validation accepts #RGB, #RRGGBB, and bare 3/6-char hex.
 *     Anything else gets rejected with a friendly message instead of
 *     silently saving an unparseable color.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';
import YAML from 'yaml';
import { slugify, profilePathFor } from './writer.js';

const HEX_COLOR_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Run the full create/edit profile flow.
 *
 * @param {object} [opts]
 * @param {object} [opts.existing]  An already-loaded profile object whose
 *                                  fields are used as defaults. Pass this
 *                                  to implement "Edit existing profile".
 * @returns {Promise<object|null>}  The completed profile, or null if the
 *                                  consultant cancelled at the final
 *                                  confirmation.
 */
export async function runProfileWizard({ existing = null } = {}) {
  const isEdit = !!existing;

  console.log('\n' + boxen(
    chalk.cyan.bold('👻  GHOST PARTNER — PROFILE WIZARD') + '\n\n' +
    chalk.gray(isEdit
      ? 'Editing your profile. Press Enter to keep current values.'
      : 'A profile lets Ghost render reports in your name and methodology.\n' +
        'You can skip any section by leaving it blank.'),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  // ── Identity ──────────────────────────────────────────────────────────────
  const identity = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: chalk.cyan('Profile name') + chalk.gray(' (e.g. "OSC Performance Audit"):'),
      default: existing?.name || '',
      validate: (v) => v.trim() ? true : 'A profile name is required.',
    },
    {
      type: 'input',
      name: 'description',
      message: chalk.cyan('One-line description') + chalk.gray(' (optional):'),
      default: existing?.description || '',
    },
    {
      type: 'input',
      name: 'author',
      message: chalk.cyan('Your full name') + chalk.gray(' (shows as "Prepared by ___" on the cover):'),
      default: existing?.author || '',
    },
    {
      type: 'input',
      name: 'organization',
      message: chalk.cyan('Your firm or organization:'),
      default: existing?.organization || '',
    },
  ]);

  // ── Branding ──────────────────────────────────────────────────────────────
  console.log('\n' + chalk.gray('— Branding (white-label PDF) —'));

  const branding = await inquirer.prompt([
    {
      type: 'input',
      name: 'company_name',
      message: chalk.cyan('Company name on PDF cover') + chalk.gray(' (defaults to organization above):'),
      default: existing?.branding?.company_name || identity.organization || '',
    },
    {
      type: 'input',
      name: 'accent_color',
      message: chalk.cyan('Brand accent color') + chalk.gray(' (hex, e.g. #0B5394 — leave blank for default):'),
      default: existing?.branding?.accent_color || '',
      validate: (v) => {
        if (!v.trim()) return true;
        return HEX_COLOR_RE.test(v.trim()) ? true : 'Use #RRGGBB, #RGB, or leave blank.';
      },
      filter: (v) => {
        const t = v.trim();
        if (!t) return '';
        return t.startsWith('#') ? t : `#${t}`;
      },
    },
    {
      type: 'input',
      name: 'logo_path',
      message: chalk.cyan('Logo file path') + chalk.gray(' (absolute path to PNG/JPG — leave blank to skip):'),
      default: existing?.branding?.logo_path || '',
      validate: (v) => {
        if (!v.trim()) return true;
        const expanded = expandTilde(v.trim());
        if (!fs.existsSync(expanded)) {
          return `File not found: ${expanded}\n  (Tip: drag the file into Terminal to paste its full path.)`;
        }
        return true;
      },
      filter: (v) => v.trim() ? expandTilde(v.trim()) : '',
    },
    {
      type: 'input',
      name: 'footer_text',
      message: chalk.cyan('PDF footer text') + chalk.gray(' (defaults to company name):'),
      default: existing?.branding?.footer_text || '',
    },
    {
      type: 'input',
      name: 'confidentiality',
      message: chalk.cyan('Confidentiality notice') + chalk.gray(' (defaults to "Confidential — Prepared for client engagement use"):'),
      default: existing?.branding?.confidentiality || '',
    },
  ]);

  // ── Methodology — priorities, anti-patterns, red flags ───────────────────
  console.log('\n' + chalk.gray('— Methodology —'));
  console.log(chalk.gray('  For each list below, type one item and press Enter.'));
  console.log(chalk.gray('  Press Enter on a blank line to finish that list.\n'));

  const priorities = await collectListInline({
    label: 'Priorities — what you zero in on during a review',
    examples: ['Site speed and Core Web Vitals', 'Security exposure', 'Database query efficiency'],
    existing: existing?.priorities,
  });

  const anti_patterns = await collectListInline({
    label: 'Anti-patterns — what you call out as wrong',
    examples: ['Direct database queries bypassing the ORM', 'Custom code overriding core without preference patterns'],
    existing: existing?.anti_patterns,
  });

  const red_flags = await collectListInline({
    label: 'Red flags — signals that elevate severity to critical',
    examples: ['Missing security patches', 'Hardcoded credentials', 'No backup/recovery strategy'],
    existing: existing?.red_flags,
  });

  // ── Billing rates ─────────────────────────────────────────────────────────
  console.log('\n' + chalk.gray('— Billing rates ($/hr) —'));
  console.log(chalk.gray('  Used for cost estimates in remediation tables. Override your global'));
  console.log(chalk.gray('  config rates only when this profile is loaded. Leave blank to use'));
  console.log(chalk.gray('  your global config rates.\n'));

  const rates = await inquirer.prompt([
    {
      type: 'input',
      name: 'junior',
      message: chalk.cyan('Junior rate') + chalk.gray(' ($/hr, blank = use global):'),
      default: existing?.rates?.junior != null ? String(existing.rates.junior) : '',
      validate: (v) => v === '' || /^\d+(\.\d+)?$/.test(v) ? true : 'Enter a number or leave blank.',
    },
    {
      type: 'input',
      name: 'mid',
      message: chalk.cyan('Mid-level rate') + chalk.gray(' ($/hr, blank = use global):'),
      default: existing?.rates?.mid != null ? String(existing.rates.mid) : '',
      validate: (v) => v === '' || /^\d+(\.\d+)?$/.test(v) ? true : 'Enter a number or leave blank.',
    },
    {
      type: 'input',
      name: 'senior',
      message: chalk.cyan('Senior rate') + chalk.gray(' ($/hr, blank = use global):'),
      default: existing?.rates?.senior != null ? String(existing.rates.senior) : '',
      validate: (v) => v === '' || /^\d+(\.\d+)?$/.test(v) ? true : 'Enter a number or leave blank.',
    },
  ]);

  // ── Assemble result ───────────────────────────────────────────────────────
  const profile = {
    name: identity.name.trim(),
    description: identity.description.trim() || undefined,
    author: identity.author.trim() || undefined,
    organization: identity.organization.trim() || undefined,
    last_updated: new Date().toISOString().slice(0, 10),
    priorities,
    anti_patterns,
    red_flags,
    rates: trimRates(rates),
    branding: trimBranding(branding),
  };

  // ── Confirmation preview ──────────────────────────────────────────────────
  console.log('\n' + chalk.gray('— Review —'));
  console.log(chalk.gray('Saving as: ') + chalk.cyan(profilePathFor(profile.name)));
  console.log('');
  printProfileSummary(profile);

  const { confirm } = await inquirer.prompt([{
    type: 'list',
    name: 'confirm',
    message: chalk.cyan('Save this profile?'),
    choices: [
      { name: 'Save', value: 'save' },
      { name: 'Edit again — go back through every section', value: 'redo' },
      { name: 'Cancel — discard everything', value: 'cancel' },
    ],
  }]);

  if (confirm === 'cancel') return null;
  if (confirm === 'redo')   return runProfileWizard({ existing: profile });

  return profile;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Inline list collection. Prompts the user for one item at a time until
 * they enter a blank line. Pre-shows existing items (in edit mode) and lets
 * the user keep, replace, or remove them before adding new ones.
 *
 * Works on every terminal — no external $EDITOR involved. This is the
 * canonical pattern for multi-item input in a CLI wizard. Inquirer's
 * editor prompt is unsafe across user environments because the default
 * $EDITOR on macOS is vi, which is hostile to non-vi users.
 */
async function collectListInline({ label, examples = [], existing }) {
  console.log('\n' + chalk.cyan(label));

  const items = [];

  // If editing, show what's there and let the user keep/discard.
  if (existing && existing.length) {
    console.log(chalk.gray('  Current items:'));
    for (let i = 0; i < existing.length; i++) {
      console.log(chalk.gray(`    ${i + 1}. `) + existing[i]);
    }
    const { keep } = await inquirer.prompt([{
      type: 'list',
      name: 'keep',
      message: chalk.cyan('Keep these existing items?'),
      choices: [
        { name: 'Keep all and add more', value: 'keep' },
        { name: 'Start over (clear all)', value: 'clear' },
      ],
    }]);
    if (keep === 'keep') items.push(...existing.map(s => String(s).trim()).filter(Boolean));
  } else if (examples.length) {
    console.log(chalk.gray('  Examples:'));
    for (const ex of examples) console.log(chalk.gray('    • ') + chalk.gray(ex));
  }

  console.log(chalk.gray('  Enter one item per line. Press Enter on a blank line when done.'));

  while (true) {
    const num = items.length + 1;
    const { item } = await inquirer.prompt([{
      type: 'input',
      name: 'item',
      message: chalk.cyan(`  ${num}.`),
    }]);
    const trimmed = String(item || '').trim();
    if (!trimmed) break;
    if (items.includes(trimmed)) {
      console.log(chalk.gray('     (already in the list — skipped)'));
      continue;
    }
    items.push(trimmed);
  }

  return items;
}

function trimRates(input) {
  const out = {};
  for (const tier of ['junior', 'mid', 'senior']) {
    const raw = input[tier];
    if (raw == null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) out[tier] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

function trimBranding(input) {
  const out = {};
  for (const k of ['company_name', 'accent_color', 'logo_path', 'footer_text', 'confidentiality']) {
    const v = String(input[k] || '').trim();
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function expandTilde(p) {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~')          return os.homedir();
  return p;
}

function printProfileSummary(profile) {
  const lines = [];
  lines.push(chalk.bold(profile.name));
  if (profile.description) lines.push(chalk.gray(profile.description));
  if (profile.author)       lines.push('Prepared by: ' + chalk.cyan(profile.author));
  if (profile.organization) lines.push('Organization: ' + chalk.cyan(profile.organization));

  const fmtList = (label, arr) => {
    if (!arr || !arr.length) return;
    lines.push('');
    lines.push(chalk.bold(label) + chalk.gray(` (${arr.length})`));
    for (const item of arr.slice(0, 5)) lines.push('  • ' + item);
    if (arr.length > 5) lines.push(chalk.gray(`  …and ${arr.length - 5} more`));
  };
  fmtList('Priorities',     profile.priorities);
  fmtList('Anti-patterns',  profile.anti_patterns);
  fmtList('Red flags',      profile.red_flags);

  if (profile.rates) {
    lines.push('');
    lines.push(chalk.bold('Billing rates'));
    if (profile.rates.junior) lines.push(`  Junior: $${profile.rates.junior}/hr`);
    if (profile.rates.mid)    lines.push(`  Mid:    $${profile.rates.mid}/hr`);
    if (profile.rates.senior) lines.push(`  Senior: $${profile.rates.senior}/hr`);
  }

  if (profile.branding) {
    lines.push('');
    lines.push(chalk.bold('Branding'));
    if (profile.branding.company_name)    lines.push('  Company: ' + profile.branding.company_name);
    if (profile.branding.accent_color)    lines.push('  Accent:  ' + profile.branding.accent_color);
    if (profile.branding.logo_path)       lines.push('  Logo:    ' + profile.branding.logo_path);
    if (profile.branding.footer_text)     lines.push('  Footer:  ' + profile.branding.footer_text);
    if (profile.branding.confidentiality) lines.push('  Notice:  ' + profile.branding.confidentiality);
  }

  console.log(boxen(lines.join('\n'), { padding: 1, borderColor: 'gray', borderStyle: 'round' }));
}
