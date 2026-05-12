#!/usr/bin/env node

import chalk from 'chalk';
import gradient from 'gradient-string';
import figlet from 'figlet';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { isConfigured, runSetupWizard, reconfigure, usingEnvKey, getDefaultProfileSlug, setDefaultProfileSlug } from '../src/config.js';
import { loadCodebase, setScanOptions } from '../src/loader/index.js';
import { runChatMode } from '../src/modes/chat.js';
import { runPOIMode } from '../src/modes/poi.js';
import { runBlastMode } from '../src/modes/blast.js';
import { runReconMode } from '../src/modes/recon.js';
import { runAuditMode } from '../src/modes/audit/index.js';
import { TIER_CAPS, getTierCap } from '../src/loader/tierCaps.js';
import { listPresets } from '../src/loader/excludes.js';
import { loadProfile } from '../src/profile/index.js';
import { runProfileWizard } from '../src/profile/wizard.js';
import { writeProfile, listProfiles, deleteProfile, profilePathFor, getProfilesDir } from '../src/profile/writer.js';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };
// Override Inquirer Unicode symbols on Windows
if (process.platform === 'win32') {
  process.env.FORCE_STDIN_TTY = '1';
}
const inquirerTheme = process.platform === 'win32' ? {
  icon: { cursor: '>' }
} : {};

import { runCompareMode } from '../src/modes/compare.js';
import { runConflictMode } from '../src/modes/conflict.js';
import { runPromptTriageMode } from '../src/modes/prompt-triage.js';
import { listModelsForPicker } from '../src/prompt-pack/models.js';
import { showProjectDashboard } from '../src/projects.js';
import { SessionCostTracker } from '../src/estimator.js';

const VERSION   = '5.4.0-pro-dev';
// TIER is branch-specific. main = Pro, ghost-team = Team, ghost-open = Open.
// When cherry-picking this file across branches, change this constant to match.
const TIER      = 'pro';
const COPYRIGHT = 'Copyright © 2026 Ghost Architect. All rights reserved.';

// ── CLI argument parsing ────────────────────────────────────────────────────
// Supports:
//   --max-context N             override context cap (will be clamped to tier cap)
//   --exclude "glob"            exclude paths matching glob (repeatable)
//   --exclude-presets a,b       apply named exclusion preset(s), comma-separated
//   --profile path              Ghost Partner — load consultant profile from
//                               .yaml/.yml/.md/.txt file and inject into scans
//   --help / -h                 print usage and exit
//   --version / -v              print version and exit
function parseArgs(argv) {
  const out = {
    maxContext: null,
    excludes: [],
    presets: [],
    profile: null,
    noProfile: false,
    createProfile: false,
    listProfiles: false,
    setDefaultProfile: null,
    clearDefaultProfile: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--version' || a === '-v') { out.version = true; continue; }
    if (a === '--max-context') {
      const v = argv[++i];
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(chalk.red(`✗ --max-context requires a positive integer (got: ${v})`));
        process.exit(2);
      }
      out.maxContext = n;
      continue;
    }
    if (a.startsWith('--max-context=')) {
      const v = a.slice('--max-context='.length);
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(chalk.red(`✗ --max-context requires a positive integer (got: ${v})`));
        process.exit(2);
      }
      out.maxContext = n;
      continue;
    }
    if (a === '--exclude') { out.excludes.push(argv[++i] || ''); continue; }
    if (a.startsWith('--exclude=')) { out.excludes.push(a.slice('--exclude='.length)); continue; }
    if (a === '--exclude-presets') {
      const v = argv[++i] || '';
      out.presets.push(...v.split(',').map(s => s.trim()).filter(Boolean));
      continue;
    }
    if (a.startsWith('--exclude-presets=')) {
      const v = a.slice('--exclude-presets='.length);
      out.presets.push(...v.split(',').map(s => s.trim()).filter(Boolean));
      continue;
    }
    if (a === '--profile')           { out.profile = argv[++i] || ''; continue; }
    if (a.startsWith('--profile='))  { out.profile = a.slice('--profile='.length); continue; }
    if (a === '--no-profile')        { out.noProfile = true; continue; }
    if (a === '--create-profile')    { out.createProfile = true; continue; }
    if (a === '--list-profiles')     { out.listProfiles = true; continue; }
    if (a === '--set-default-profile')          { out.setDefaultProfile = argv[++i] || ''; continue; }
    if (a.startsWith('--set-default-profile=')) { out.setDefaultProfile = a.slice('--set-default-profile='.length); continue; }
    if (a === '--clear-default-profile')        { out.clearDefaultProfile = true; continue; }
    // Unknown arg — warn but don't crash, preserves interactive usage.
    if (a.startsWith('-')) {
      console.error(chalk.yellow(`⚠ Unknown flag: ${a} (ignored)`));
    }
  }
  return out;
}

function printUsage() {
  const presets = listPresets().join(', ') || '(none)';
  console.log(`
Ghost Architect — AI-powered codebase archaeology (v${VERSION}, ${TIER} tier)

Usage:
  ghost [options]

Options:
  --max-context N          Override context cap in tokens. Clamped to your tier limit.
                           Tier caps: open=${TIER_CAPS.open.toLocaleString()}, pro=${TIER_CAPS.pro.toLocaleString()}, team=${TIER_CAPS.team.toLocaleString()}, enterprise=${TIER_CAPS.enterprise.toLocaleString()}
  --exclude "glob"         Exclude files matching glob pattern (repeatable).
                           Example: --exclude "seeds/**" --exclude "*.fixture.js"
  --exclude-presets a,b    Apply named exclusion preset(s), comma-separated.
                           Available presets: ${presets}

Ghost Partner™ — white-label consultant profiles:
  --profile path           Load a profile from .yaml/.yml/.md/.txt and apply
                           the consultant's lens + branding to all scans.
  --no-profile             Run without any profile, even if a default is set.
  --create-profile         Launch the interactive profile wizard and save the
                           result to ~/.ghost/profiles/. Then exit.
  --list-profiles          List all profiles in ~/.ghost/profiles/ and show
                           which one is currently the default. Then exit.
  --set-default-profile slug
                           Set the default profile by slug (filename without
                           extension, e.g. 'osc-performance-audit'). Applied
                           to every scan unless --profile or --no-profile is
                           passed. Then exit.
  --clear-default-profile  Remove the default profile setting. Then exit.

Misc:
  --version, -v            Print version and exit.
  --help, -h               Print this help and exit.

When flags are omitted, Ghost runs interactively and uses your configured defaults.
`);
}

// ── Banner ──────────────────────────────────────────────────────────────────

function printBanner() {
  console.clear();
  const title = figlet.textSync('GHOST', { font: 'Doom', horizontalLayout: 'default' });
  const ghostGradient = gradient(['#00ffff', '#0088ff', '#004488']);
  console.log(ghostGradient(title));

  console.log(
    chalk.gray('  ') +
    chalk.cyan.bold('ARCHITECT') +
    chalk.gray('  —  AI-powered codebase archaeology') +
    chalk.gray(`  v${VERSION}\n`)
  );

  // Copyright line
  console.log(chalk.gray(`  ${COPYRIGHT}\n`));

  // Env var notice
  if (usingEnvKey()) {
    console.log(chalk.gray('  ') + chalk.green(IS_WINDOWS ? '[KEY] Using ANTHROPIC_API_KEY from environment' : '⚡ Using ANTHROPIC_API_KEY from environment') + '\n');
  }
}

// ── Input method selector ───────────────────────────────────────────────────
//
// Grouped by what the user is analyzing, not just where the input comes from.
// Prompt Triage was previously stacked alongside Local/ZIP/GitHub which made
// it look like just another way to load a code project — users couldn't find
// it because they were looking in the mode menu (Chat/POI/Blast/Conflict/
// Recon) instead. Now the menu is grouped by analysis target with named
// separators so Prompt Triage is visually distinct from code-loading options.
//
// Pro extras (Project Dashboard, Compare Reports, Manage Ghost Partner
// Profiles) live under the 'Other' separator alongside Reconfigure/Exit —
// they're tools that operate on saved data or app state, not analysis
// targets, so they belong out of the Code/Prompt analysis groups.

async function selectInputMethod(activeProfileLabel) {
  const profileSuffix = activeProfileLabel
    ? chalk.gray('  [profile: ') + chalk.cyan(activeProfileLabel) + chalk.gray(' ●]')
    : '';

  const codeAnalysisGroupLabel    = IS_WINDOWS ? '── Code analysis ──'   : '─── Code analysis ──────';
  const promptAnalysisGroupLabel  = IS_WINDOWS ? '── Prompt analysis ──' : '─── Prompt analysis ────';
  const otherGroupLabel           = IS_WINDOWS ? '── Other ──'           : '─── Other ──────────────';

  const choices = [
    new inquirer.Separator(codeAnalysisGroupLabel),
    { name: (IS_WINDOWS ? '[DIR] Local directory' : '📁  Local directory') + profileSuffix, value: 'files' },
    { name: (IS_WINDOWS ? '[ZIP] ZIP file' : '🗜   ZIP file') + profileSuffix, value: 'zip' },
    { name: (IS_WINDOWS ? '[GIT] GitHub repository' : '🐙  GitHub repository') + profileSuffix, value: 'github' },

    new inquirer.Separator(promptAnalysisGroupLabel),
    { name: (IS_WINDOWS ? '[PRT] Prompt Triage' : '🧪  Prompt Triage') + chalk.gray('         — audit a folder of LLM prompts for defects'), value: 'prompt-triage' },

    new inquirer.Separator(otherGroupLabel),
    { name: (IS_WINDOWS ? '[DSH] Project Dashboard  ' : '📊  Project Dashboard  ') + (IS_WINDOWS ? '' : chalk.gray('— Remediation progress across all projects')), value: 'dashboard' },
    { name: (IS_WINDOWS ? '[CMP] Compare Reports  ' : '🔍  Compare Reports  ') + (IS_WINDOWS ? '' : chalk.gray('— Before/after diff of two saved reports')), value: 'compare' },
    { name: (IS_WINDOWS ? '[GP]  Manage Ghost Partner Profiles  ' : '👤  Manage Ghost Partner Profiles  ') + (IS_WINDOWS ? '' : chalk.gray('— Create, edit, set default, delete')), value: 'profiles' },
  ];

  if (!usingEnvKey()) {
    choices.push({ name: IS_WINDOWS ? '[CFG] Reconfigure Ghost Architect' : '⚙   Reconfigure Ghost Architect', value: 'reconfigure' });
  }
  choices.push({ name: IS_WINDOWS ? '[EXIT] Exit' : '🚪  Exit', value: 'exit' });

  const { method } = await inquirer.prompt([{
    type: 'list',
    name: 'method',
    message: chalk.cyan('What do you want to analyze?'),
    theme: inquirerTheme,
    choices
  }]);
  return method;
}


// ── Mode selector ───────────────────────────────────────────────────────────

async function selectMode(codebaseContext) {
  console.log('\n' + boxen(
    chalk.green.bold(SYM.check + ' Project processed') + '\n' +
    chalk.gray(`${codebaseContext.loadedFiles} files | ${codebaseContext.fileIndex.slice(0, 3).join(', ')}${codebaseContext.fileIndex.length > 3 ? '...' : ''}`),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderColor: 'green', borderStyle: 'round' }
  ));

  const { mode } = await inquirer.prompt([{
    type: 'list',
    name: 'mode',
    message: chalk.cyan('\nWhat do you want to do?'),
    theme: inquirerTheme,
    choices: [
      { name: IS_WINDOWS ? '[CHT] Chat  ' : '💬  Chat  ' + chalk.gray('— Ask anything about this project'), value: 'chat' },
      { name: IS_WINDOWS ? '[POI] Points of Interest Scan  ' : '🗺   Points of Interest Scan  ' + chalk.gray('— Auto-map red flags, landmarks, dead zones, fault lines'), value: 'poi' },
      { name: IS_WINDOWS ? '[BLT] Blast Radius Analysis  ' : '💥  Blast Radius Analysis  ' + chalk.gray('— Impact map + rollback plan'), value: 'blast' },
      { name: IS_WINDOWS ? '[CNF] Conflict Detection  ' : '⚡  Conflict Detection  ' + chalk.gray('— Find contract mismatches, schema conflicts, config errors'), value: 'conflict' },
      { name: IS_WINDOWS ? '[REC] Recon  ' : '🔍  Recon  ' + chalk.gray('— Sizing & engagement plan, no analysis'), value: 'recon' },
      { name: IS_WINDOWS ? '[AUD] Inheritance Audit  ' : '📋  Inheritance Audit  ' + chalk.gray('— Deal-grade audit for buyers, PE diligence, fractional CTOs'), value: 'audit' },
      { name: (IS_WINDOWS ? '[CMP] Compare Reports  ' : '🔍  Compare Reports  ') + (IS_WINDOWS ? '' : chalk.gray('— Before/after diff of two saved reports')), value: 'compare' },
      { name: (IS_WINDOWS ? '[DSH] Project Dashboard  ' : '📊  Project Dashboard  ') + (IS_WINDOWS ? '' : chalk.gray('— Remediation progress across all projects')), value: 'dashboard' },
      new inquirer.Separator(),
      { name: IS_WINDOWS ? '[RLD] New Scan  — scan a different directory' : '🔄  New Scan  — scan a different directory', value: 'reload' },
      { name: IS_WINDOWS ? '[EXIT] Exit' : '🚪  Exit', value: 'exit' },
    ]
  }]);

  return mode;
}

// ── Ghost Partner profile helpers ──────────────────────────────────

/**
 * Resolve which profile to load for this run, in priority order:
 *   1. --no-profile          → always null
 *   2. --profile <path>      → explicit path wins
 *   3. config defaultProfileSlug → if a default is set and the file exists
 *   4. nothing                → null (no profile)
 *
 * Returns { profile, label } where label is shown in the menu suffix.
 * Throws on explicit --profile failures so the user sees the error
 * immediately rather than silently scanning without their profile.
 */
async function resolveStartupProfile(cliOpts) {
  if (cliOpts.noProfile) return { profile: null, label: null };

  if (cliOpts.profile) {
    const profile = await loadProfile(cliOpts.profile);
    return { profile, label: profile?.name || path.basename(cliOpts.profile) };
  }

  const slug = getDefaultProfileSlug();
  if (!slug) return { profile: null, label: null };

  const candidate = path.join(getProfilesDir(), `${slug}.yaml`);
  if (!fs.existsSync(candidate)) {
    console.log(chalk.yellow(
      `⚠  Default profile '${slug}' not found at ${candidate}. ` +
      `Run \`ghost --clear-default-profile\` to clear or \`ghost --list-profiles\` to see available profiles.`
    ));
    return { profile: null, label: null };
  }

  try {
    const profile = await loadProfile(candidate);
    return { profile, label: profile?.name || slug };
  } catch (err) {
    console.log(chalk.yellow(
      `⚠  Could not load default profile '${slug}': ${err.message}. Continuing without a profile.`
    ));
    return { profile: null, label: null };
  }
}

/**
 * Headless --create-profile flow. Runs the wizard, saves the result, prints
 * usage hints. Returns the saved path or null if the user cancelled.
 */
async function runCreateProfileFlow() {
  const profile = await runProfileWizard();
  if (!profile) {
    console.log(chalk.gray('\nProfile creation cancelled. Nothing saved.\n'));
    return null;
  }

  let savedPath;
  try {
    savedPath = writeProfile(profile);
  } catch (err) {
    if (/already exists/i.test(err.message)) {
      const { overwrite } = await inquirer.prompt([{
        type: 'confirm',
        name: 'overwrite',
        message: chalk.yellow(`A profile named "${profile.name}" already exists. Overwrite?`),
        default: false,
      }]);
      if (!overwrite) {
        console.log(chalk.gray('\nNot saved. Run again with a different name.\n'));
        return null;
      }
      savedPath = writeProfile(profile, { overwrite: true });
    } else {
      throw err;
    }
  }

  const slug = path.basename(savedPath, path.extname(savedPath));

  console.log('\n' + boxen(
    chalk.green.bold(`${SYM.check} Profile saved`) + '\n\n' +
    chalk.white('Path: ') + chalk.cyan(savedPath) + '\n\n' +
    chalk.white('Use it for one scan:') + '\n' +
    chalk.gray('  ghost --profile ') + chalk.cyan(savedPath) + '\n\n' +
    chalk.white('Set as your default profile (auto-applied to every scan):') + '\n' +
    chalk.gray('  ghost --set-default-profile ') + chalk.cyan(slug),
    { padding: 1, borderColor: 'green', borderStyle: 'round' }
  ));
  console.log('');
  return savedPath;
}

/**
 * Interactive submenu for managing profiles. Reachable from the main menu
 * ("Manage Ghost Partner Profiles") and re-entrant — returns to itself
 * after each action until the user picks Back.
 */
async function runProfilesMenu() {
  while (true) {
    const profiles = listProfiles();
    const defaultSlug = getDefaultProfileSlug();

    console.log('\n' + boxen(
      chalk.cyan.bold('👤  GHOST PARTNER PROFILES') + '\n' +
      chalk.gray(`Stored at: ${getProfilesDir()}`) + '\n' +
      chalk.gray(`Total profiles: ${profiles.length}`) +
      (defaultSlug ? '\n' + chalk.gray('Default profile: ') + chalk.cyan(defaultSlug) : ''),
      { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
    ));

    const choices = [
      { name: '➕  Create new profile', value: 'create' },
    ];
    if (profiles.length) {
      choices.push({ name: '✎  Edit existing profile', value: 'edit' });
      choices.push({ name: '★  Set default profile', value: 'set-default' });
      if (defaultSlug) {
        choices.push({ name: '☆  Clear default profile', value: 'clear-default' });
      }
      choices.push({ name: '📄  Open profile in editor', value: 'open' });
      choices.push({ name: '🗑   Delete profile', value: 'delete' });
    }
    choices.push(new inquirer.Separator());
    choices.push({ name: '←  Back to main menu', value: 'back' });

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: chalk.cyan('Profile management:'),
      theme: inquirerTheme,
      choices,
    }]);

    if (action === 'back')          return;
    if (action === 'create')        { await runCreateProfileFlow(); continue; }
    if (action === 'edit')          { await runEditProfileFlow(profiles); continue; }
    if (action === 'set-default')   { await runSetDefaultFlow(profiles); continue; }
    if (action === 'clear-default') {
      setDefaultProfileSlug(null);
      console.log(chalk.green(`\n${SYM.check} Default profile cleared.\n`));
      continue;
    }
    if (action === 'open')   { await runOpenProfileFlow(profiles); continue; }
    if (action === 'delete') { await runDeleteProfileFlow(profiles); continue; }
  }
}

async function runEditProfileFlow(profiles) {
  const { slug } = await inquirer.prompt([{
    type: 'list',
    name: 'slug',
    message: chalk.cyan('Which profile do you want to edit?'),
    theme: inquirerTheme,
    choices: [
      ...profiles.map(p => ({ name: `${p.name}  ${chalk.gray('(' + p.slug + ')')}`, value: p.slug })),
      new inquirer.Separator(),
      { name: '←  Cancel', value: '__cancel__' },
    ],
  }]);
  if (slug === '__cancel__') return;

  const target = profiles.find(p => p.slug === slug);
  let existing = null;
  try {
    existing = await loadProfile(target.path);
  } catch (err) {
    console.log(chalk.red(`\n${SYM.cross} Could not load existing profile: ${err.message}\n`));
    return;
  }

  const updated = await runProfileWizard({ existing });
  if (!updated) {
    console.log(chalk.gray('\nEdit cancelled. Profile unchanged.\n'));
    return;
  }

  // If the user changed the name, the slug may have changed too. Save
  // under the new slug, then offer to delete the old file.
  const newPath = writeProfile(updated, { overwrite: true });
  const newSlug = path.basename(newPath, path.extname(newPath));
  if (newSlug !== slug) {
    const { removeOld } = await inquirer.prompt([{
      type: 'confirm',
      name: 'removeOld',
      message: chalk.yellow(
        `Profile name changed (${slug} → ${newSlug}). Delete the old file?`
      ),
      default: true,
    }]);
    if (removeOld) {
      deleteProfile(slug);
      if (getDefaultProfileSlug() === slug) setDefaultProfileSlug(newSlug);
      console.log(chalk.gray(`Removed old profile: ${slug}.yaml`));
    }
  }
  console.log(chalk.green(`\n${SYM.check} Saved: ${newPath}\n`));
}

async function runSetDefaultFlow(profiles) {
  const { slug } = await inquirer.prompt([{
    type: 'list',
    name: 'slug',
    message: chalk.cyan('Which profile should be the default?'),
    theme: inquirerTheme,
    choices: [
      ...profiles.map(p => ({ name: `${p.name}  ${chalk.gray('(' + p.slug + ')')}`, value: p.slug })),
      new inquirer.Separator(),
      { name: '←  Cancel', value: '__cancel__' },
    ],
  }]);
  if (slug === '__cancel__') return;
  setDefaultProfileSlug(slug);
  console.log(chalk.green(`\n${SYM.check} Default profile set: ${slug}\n`));
  console.log(chalk.gray('   Will be auto-applied to every scan unless --profile or --no-profile is passed.\n'));
}

async function runOpenProfileFlow(profiles) {
  const { slug } = await inquirer.prompt([{
    type: 'list',
    name: 'slug',
    message: chalk.cyan('Which profile do you want to open?'),
    theme: inquirerTheme,
    choices: [
      ...profiles.map(p => ({ name: `${p.name}  ${chalk.gray('(' + p.slug + ')')}`, value: p.slug })),
      new inquirer.Separator(),
      { name: '←  Cancel', value: '__cancel__' },
    ],
  }]);
  if (slug === '__cancel__') return;
  const target = profiles.find(p => p.slug === slug);
  const editor = process.env.VISUAL || process.env.EDITOR || (IS_WINDOWS ? 'notepad' : 'vi');
  console.log(chalk.gray(`\nOpening ${target.path} in ${editor}...\n`));
  await new Promise((resolve) => {
    const proc = spawn(editor, [target.path], { stdio: 'inherit' });
    proc.on('exit', resolve);
    proc.on('error', (err) => {
      console.log(chalk.red(`\nCould not launch editor: ${err.message}`));
      console.log(chalk.gray(`Open the file manually: ${target.path}\n`));
      resolve();
    });
  });
}

async function runDeleteProfileFlow(profiles) {
  const { slug } = await inquirer.prompt([{
    type: 'list',
    name: 'slug',
    message: chalk.cyan('Which profile do you want to delete?'),
    theme: inquirerTheme,
    choices: [
      ...profiles.map(p => ({ name: `${p.name}  ${chalk.gray('(' + p.slug + ')')}`, value: p.slug })),
      new inquirer.Separator(),
      { name: '←  Cancel', value: '__cancel__' },
    ],
  }]);
  if (slug === '__cancel__') return;

  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: chalk.yellow(`Permanently delete profile '${slug}'? This cannot be undone.`),
    default: false,
  }]);
  if (!confirm) return;

  deleteProfile(slug);
  if (getDefaultProfileSlug() === slug) {
    setDefaultProfileSlug(null);
    console.log(chalk.gray('   (Was the default profile — default cleared.)'));
  }
  console.log(chalk.green(`\n${SYM.check} Deleted profile: ${slug}\n`));
}

/**
 * Print all profiles to stdout. Used by --list-profiles.
 */
function printProfilesList() {
  const profiles = listProfiles();
  const defaultSlug = getDefaultProfileSlug();

  console.log(`\nGhost Partner profiles in ${getProfilesDir()}:\n`);
  if (!profiles.length) {
    console.log(chalk.gray('  (none)\n'));
    console.log(chalk.gray('Create one with: ') + chalk.cyan('ghost --create-profile\n'));
    return;
  }
  for (const p of profiles) {
    const marker = p.slug === defaultSlug ? chalk.green(' [default ●]') : '';
    console.log(`  ${chalk.cyan(p.slug)}${marker}`);
    console.log(`    ${chalk.gray(p.name)}`);
    console.log(`    ${chalk.gray(p.path)}\n`);
  }
  if (defaultSlug) {
    console.log(chalk.gray('Clear default: ') + chalk.cyan('ghost --clear-default-profile\n'));
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  // Parse CLI flags first so --help / --version / --max-context etc. are honored
  // before we print the banner or run the setup wizard.
  const argv = process.argv.slice(2);
  const cliOpts = parseArgs(argv);

  if (cliOpts.help)    { printUsage(); process.exit(0); }
  if (cliOpts.version) { console.log(`ghost-architect v${VERSION} (${TIER})`); process.exit(0); }

  // Headless Ghost Partner profile management flags. Each one performs its
  // action and exits cleanly so users can script them without entering the
  // interactive menu.
  if (cliOpts.listProfiles) { printProfilesList(); process.exit(0); }

  if (cliOpts.clearDefaultProfile) {
    setDefaultProfileSlug(null);
    console.log(chalk.green(`\n${SYM.check} Default profile cleared.\n`));
    process.exit(0);
  }

  if (cliOpts.setDefaultProfile != null) {
    const slug = String(cliOpts.setDefaultProfile).trim();
    if (!slug) {
      console.error(chalk.red(`\n${SYM.cross} --set-default-profile requires a slug. Use --list-profiles to see available slugs.\n`));
      process.exit(2);
    }
    const expected = path.join(getProfilesDir(), `${slug}.yaml`);
    if (!fs.existsSync(expected)) {
      console.error(chalk.red(`\n${SYM.cross} No profile found at ${expected}. Use --list-profiles to see available slugs.\n`));
      process.exit(2);
    }
    setDefaultProfileSlug(slug);
    console.log(chalk.green(`\n${SYM.check} Default profile set: ${slug}\n`));
    console.log(chalk.gray('   Auto-applied to every scan. Override per-run with --profile or --no-profile.\n'));
    process.exit(0);
  }

  if (cliOpts.createProfile) {
    if (!isConfigured()) {
      console.log(boxen(
        chalk.yellow.bold('Set up Ghost Architect first') + '\n' +
        chalk.gray('--create-profile needs a configured environment so the wizard\n') +
        chalk.gray('can use your defaults. Run `ghost` once to complete setup,\n') +
        chalk.gray('then re-run with --create-profile.'),
        { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
      ));
      process.exit(2);
    }
    await runCreateProfileFlow();
    process.exit(0);
  }

  // Seed the loader with this run's tier + CLI-driven options.
  // Caps get clamped; excludes get merged with presets at scan time.
  setScanOptions({
    tier: TIER,
    maxContextOverride: cliOpts.maxContext,
    excludePresets: cliOpts.presets,
    excludePatterns: cliOpts.excludes,
  });

  // Resolve which profile to load for this session.
  // Priority: --no-profile > --profile path > config defaultProfileSlug > none.
  // Explicit --profile failures are fatal; default-profile failures degrade
  // gracefully with a warning.
  let profile = null;
  let activeProfileLabel = null;
  try {
    const resolved = await resolveStartupProfile(cliOpts);
    profile = resolved.profile;
    activeProfileLabel = resolved.label;
  } catch (err) {
    console.error(chalk.red(`\n${SYM.cross} Failed to load profile: ${err.message}\n`));
    process.exit(2);
  }

  printBanner();

  if (!isConfigured()) {
    console.log(boxen(
      chalk.yellow.bold('Welcome to Ghost Architect!') + '\n' +
      chalk.gray('Looks like this is your first time here.\nLet\'s get you set up.'),
      { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
    ));
    console.log('');
    await runSetupWizard();
    printBanner();
  }

  let codebaseContext = null;
  const session = new SessionCostTracker();

  while (true) {
    if (!codebaseContext) {
      const method = await selectInputMethod(activeProfileLabel);

      if (method === 'exit') {
        session.showSummary();
        console.log(chalk.cyan('\nIntel gathered. Go make your move.\n'));
        console.log(chalk.gray(`${COPYRIGHT}\n`));
        process.exit(0);
      }

      if (method === 'reconfigure') {
        await reconfigure();
        printBanner();
        continue;
      }

      if (method === 'dashboard') {
        await showProjectDashboard();
        continue;
      }

      if (method === 'compare') {
        await runCompareMode();
        continue;
      }

      if (method === 'profiles') {
        await runProfilesMenu();
        // After the user manages profiles, re-resolve in case they changed
        // the default or created a new profile they want to use immediately.
        try {
          const resolved = await resolveStartupProfile(cliOpts);
          profile = resolved.profile;
          activeProfileLabel = resolved.label;
        } catch (err) {
          console.log(chalk.yellow(`⚠  Could not refresh profile: ${err.message}`));
        }
        printBanner();
        continue;
      }

      if (method === 'prompt-triage') {
        // No default: an explicit path must be typed. v5.1.2 had `default:
        // process.cwd()` which created a UX trap — if the user hit Enter
        // without typing, Ghost would silently scan the current working
        // directory (often a code repo, not a prompts folder). Caught in
        // the v5.1.2 smoke run when /tmp/ghost-prompt-smoke-rich was typed
        // but cwd ended up being scanned anyway. Forcing the user to type
        // a path eliminates the silent-fallback failure mode.
        const { folderPath } = await inquirer.prompt([{
          type: 'input',
          name: 'folderPath',
          message: chalk.cyan('Folder containing prompt files (absolute path):'),
          theme: inquirerTheme,
          validate: (input) => {
            if (!input || !input.trim()) return 'Folder path is required.';
            const abs = path.resolve(input.trim());
            if (!fs.existsSync(abs)) return 'Folder does not exist: ' + abs;
            try {
              if (!fs.statSync(abs).isDirectory()) return 'Path is not a directory: ' + abs;
            } catch (err) {
              return 'Could not access path: ' + err.message;
            }
            return true;
          },
        }]);

        // Optional target-model selection. When specified, length-aware
        // detectors use the correct tokenizer (exact for OpenAI, heuristic
        // with model-specific context-window labels for others).
        const { specifyModel } = await inquirer.prompt([{
          type: 'confirm',
          name: 'specifyModel',
          message: chalk.cyan('Specify a target model?'),
          default: false,
          theme: inquirerTheme,
        }]);
        let targetModel = null;
        if (specifyModel) {
          const modelChoices = listModelsForPicker().map(m => ({
            name: m.displayName + chalk.gray(' (' + m.family + ', '
              + m.contextWindow.toLocaleString() + ' tokens)'),
            value: m.id,
          }));
          const answer = await inquirer.prompt([{
            type: 'list',
            name: 'targetModel',
            message: chalk.cyan('Target model:'),
            choices: modelChoices,
            pageSize: 12,
            theme: inquirerTheme,
          }]);
          targetModel = answer.targetModel;
        }

        try {
          await runPromptTriageMode({
            source: { kind: 'localFolder', path: folderPath.trim() },
            targetModel,
            tier: TIER,
          });
        } catch (err) {
          console.log(chalk.red('\n' + SYM.cross + ' Prompt Triage failed: ' + err.message + '\n'));
        }
        continue;
      }

      console.log('');
      codebaseContext = await loadCodebase(method);
      if (!codebaseContext) { codebaseContext = null; continue; }
    }

    const mode = await selectMode(codebaseContext);

    if (mode === 'exit') {
      session.showSummary();
      console.log(chalk.cyan('\nIntel gathered. Go make your move.\n'));
      console.log(chalk.gray(`${COPYRIGHT}\n`));
      process.exit(0);
    }

    if (mode === 'reload') {
      codebaseContext = null;
      printBanner();
      continue;
    }

    switch (mode) {
      case 'chat':      await runChatMode(codebaseContext);             break;
      case 'poi':       await runPOIMode(codebaseContext, { profile });  break;
      case 'blast':     await runBlastMode(codebaseContext, { profile });  break;
      case 'conflict':  await runConflictMode(codebaseContext, { profile });  break;
      case 'recon':     await runReconMode(codebaseContext, { profile });  break;
      case 'audit':     await runAuditMode(codebaseContext, { profile, tier: TIER });  break;
      case 'compare':   await runCompareMode();                         break;
      case 'dashboard': await showProjectDashboard();                   break;
    }
  }
}

main().catch(err => {
  console.error(chalk.red('\n' + SYM.cross + ' Fatal error:'), err.message);
  process.exit(1);
});
