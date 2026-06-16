#!/usr/bin/env node

import { createRequire } from 'module';
import chalk from 'chalk';
import gradient from 'gradient-string';
import figlet from 'figlet';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { isConfigured, runSetupWizard, reconfigure, usingEnvKey, getDefaultProfileSlug, setDefaultProfileSlug } from '../src/config.js';
import { loadCodebase, loadFromPath, setScanOptions } from '../src/loader/index.js';
import { runChatMode } from '../src/modes/chat.js';
import { runQuestionMode } from '../src/modes/question.js';
import { runPOIMode } from '../src/modes/poi.js';
import { runBlastMode } from '../src/modes/blast.js';
import { runReconMode } from '../src/modes/recon.js';
import { runAuditMode } from '../src/modes/audit/index.js';
import { pingModeUsage } from '../src/telemetry/pulse.js';
import { TIER_CAPS, getTierCap } from '../src/loader/tierCaps.js';
import { listPresets } from '../src/loader/excludes.js';
import { loadProfile } from '../src/profile/index.js';
import { runProfileWizard } from '../src/profile/wizard.js';
import { writeProfile, listProfiles, deleteProfile, profilePathFor, getProfilesDir } from '../src/profile/writer.js';
import fs, { realpathSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
import { runConflictMode, runSavedFixForecast } from '../src/modes/conflict.js';
import { runPromptTriageMode } from '../src/modes/prompt-triage.js';
import { runCommitForecastMode } from '../src/modes/commit-forecast.js';
import { listModelsForPicker } from '../src/prompt-pack/models.js';
import { showProjectDashboard } from '../src/projects.js';
import { SessionCostTracker } from '../src/estimator.js';
import { backChoice, isBack, isBackKeyword } from '../src/cli/prompt-helpers.js';

// ── License enforcement ────────────────────────────────────────────────────
// v1 ships on the Pro umbrella main branch only. Ghost Open (MIT, public)
// MUST NOT receive this code. Team and Enterprise inherit when those
// branches sync forward from main.
import { validateLicense, isBlocking } from '../src/license/validator.js';
import { decodeAndVerifyToken } from '../src/license/token.js';
import { tryParseKey } from '../src/license/format.js';
import { currentFingerprintHashes } from '../src/license/fingerprint.js';
import {
  saveActivation,
  clearLicense,
  hasLicense,
  getLicenseRecord,
} from '../src/license/store.js';
import { setActiveLicense, getActiveTier } from '../src/license/session.js';
import { requireTier } from '../src/license/tier-gates.js';
import { getScanCount, renderAuditPaywall, renderQuotaPaywall, getForecastCount, renderForecastPaywall } from '../src/freemium.js';

// Activation server endpoint. Hardcoded so customers can't be tricked into
// activating against a malicious server (they'd already need to compromise
// the binary or DNS). Override only available via GHOST_ACTIVATION_ENDPOINT
// env var for local-dev testing against `wrangler dev`.
const ACTIVATION_ENDPOINT = process.env.GHOST_ACTIVATION_ENDPOINT
  || 'https://license.ghostarchitect.dev/activate';

// VERSION is read dynamically from package.json so `npm version` bumps both.
const _require = createRequire(import.meta.url);
const VERSION   = _require('../package.json').version;
// TIER is resolved at runtime from the active license (post-validateLicense).
// Defaults to 'open' when no license is present (per D2). The constant
// declaration is `let` rather than `const` because Phase 1 moved the
// source of truth from a branch-cherry-picked constant to a license-
// driven runtime resolution. The pre-resolution placeholder value is
// 'open' so any code path that reads TIER before main()'s license gate
// (e.g. printUsage's tier-cap table) shows the most conservative tier.
let TIER = 'open';
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
    activate: null,
    licenseStatus: false,
    licenseClear: false,
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
    // License management flags.
    if (a === '--activate')         { out.activate = argv[++i] || ''; continue; }
    if (a.startsWith('--activate=')){ out.activate = a.slice('--activate='.length); continue; }
    if (a === '--license')          { out.licenseStatus = true; continue; }
    if (a === '--license-clear')    { out.licenseClear = true; continue; }
    if (a === '--deactivate')       { out.licenseClear = true; continue; } // alias for --license-clear

    // Commit Forecast non-interactive flags
    if (a === '--baseline')              { out.cfBaseline = argv[++i] || ''; continue; }
    if (a.startsWith('--baseline='))     { out.cfBaseline = a.slice('--baseline='.length); continue; }
    if (a === '--proposed')              { out.cfProposed = argv[++i] || ''; continue; }
    if (a.startsWith('--proposed='))     { out.cfProposed = a.slice('--proposed='.length); continue; }
    if (a === '--modes')                 { out.cfModes = argv[++i] || ''; continue; }
    if (a.startsWith('--modes='))        { out.cfModes = a.slice('--modes='.length); continue; }
    if (a === '--label')                 { out.cfLabel = argv[++i] || ''; continue; }
    if (a.startsWith('--label='))        { out.cfLabel = a.slice('--label='.length); continue; }
    if (a === '--no-verify')             { out.cfNoVerify = true; continue; }
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

Licensing:
  --activate <key|token>   Install your license. Accepts either:
                             (a) human-typeable key: GA-2026-PRO-XXXX-XXXX-XXXX
                                 — exchanged with the activation server for a
                                 token bound to this machine. Requires internet.
                             (b) pre-signed token — verified locally, no network.
                                 Used for offline activation when emailed by EJ.
                           Then exit.
  --license                Show current license status (tier, expiration, days
                           remaining, fingerprint match). Then exit.
  --license-clear          Remove the installed license from local storage.
                           Then exit. Useful for migrating to a new license.
  --deactivate             Alias for --license-clear.

Commit Forecast (non-interactive / CI mode):
  --baseline <path>        Path to the baseline codebase directory.
  --proposed <path>        Path to the folder of proposed (changed) files.
  --modes <list>           Comma-separated analysis modes to run.
                           Valid values: blast, conflict, both
                           Example: --modes=blast,conflict  or  --modes=conflict
                           Unknown mode values exit with an error.
  --label <name>           Project label for tracking in the portal. Omit to run
                           as a one-time scan (no project history recorded).
                           Matches interactive behavior of pressing Enter to skip
                           the label prompt.
  --no-verify              Skip conflict candidate verification step.

  When ALL of --baseline, --proposed, and --modes are present, Commit Forecast
  runs fully non-interactive. Any missing required flag drops back to the
  interactive prompt flow.

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
    chalk.gray(`  v${VERSION}  [${TIER.charAt(0).toUpperCase() + TIER.slice(1)}]\n`)
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
// it because they were looking in the mode menu (Question/POI/Blast/Conflict/
// Recon) instead. Now the menu is grouped by analysis target with named
// separators so Prompt Triage is visually distinct from code-loading options.
//
// Pro extras (Project Dashboard, Compare Reports, Manage Ghost Partner
// Profiles) live under the 'Other' separator alongside Reconfigure/Exit —
// they're tools that operate on saved data or app state, not analysis
// targets, so they belong out of the Code/Prompt analysis groups.

async function selectInputMethod(activeProfileLabel, tier = 'open') {
  // Profiles are a Pro+ feature. profilesAllowed gates two surfaces:
  // (1) the [profile: <name>] suffix on Local/ZIP/GitHub entries, and
  // (2) whether the Manage Ghost Partner Profiles entry is offered.
  // Defaults to 'open' (fail-closed) so a future caller that forgets to
  // pass tier never accidentally exposes the paid surface.
  const profilesAllowed = requireTier('feature:profiles', { tier }).allowed;
  const profileSuffix = (profilesAllowed && activeProfileLabel)
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
  ];

  if (profilesAllowed) {
    choices.push({ name: (IS_WINDOWS ? '[GP]  Manage Ghost Partner Profiles  ' : '👤  Manage Ghost Partner Profiles  ') + (IS_WINDOWS ? '' : chalk.gray('— Create, edit, set default, delete')), value: 'profiles' });
  }

  if (!usingEnvKey()) {
    choices.push({ name: IS_WINDOWS ? '[CFG] Reconfigure Ghost Architect' : '⚙   Reconfigure Ghost Architect', value: 'reconfigure' });
  }
  // Universal escape: top-level menu uses a single "← Exit Ghost" choice
  // (no separate Back vs Exit). Returning BACK_VALUE here means the same
  // thing as selecting Exit at the top level — there is no higher level
  // to back out to. Main loop catches isBack(method) and runs confirmExit().
  choices.push(new inquirer.Separator());
  choices.push(backChoice(IS_WINDOWS ? '[EXIT] Exit Ghost' : '🚪  Exit Ghost'));

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

async function selectMode(codebaseContext, tier = 'open') {
  console.log('\n' + boxen(
    chalk.green.bold(SYM.check + ' Project processed') + '\n' +
    chalk.gray(`${codebaseContext.loadedFiles} files | ${codebaseContext.fileIndex.slice(0, 3).join(', ')}${codebaseContext.fileIndex.length > 3 ? '...' : ''}`),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderColor: 'green', borderStyle: 'round' }
  ));

  // Cycle 14: Question is Open-tier inclusive; Chat is Pro+ (mode:chat
  // gated at dispatch). Hide Chat from the menu on Open so Open users
  // never read the word "Chat" in their tier's flow — the vocabulary
  // rule is part of the clean tier-product story. Pro+ tiers see both
  // Question (one-shot Q&A) and Chat (multi-turn) as distinct choices.
  const choices = [
    { name: IS_WINDOWS ? '[ASK] Ask a Question  ' : '❓  Ask a Question  ' + chalk.gray('— Single Q&A, save the answer if you like'), value: 'question' },
  ];
  if (tier !== 'open') {
    choices.push({ name: IS_WINDOWS ? '[CHT] Chat  ' : '💬  Chat  ' + chalk.gray('— Ongoing conversation about this project'), value: 'chat' });
  }
  choices.push(
    { name: IS_WINDOWS ? '[POI] Points of Interest Scan  ' : '🗺   Points of Interest Scan  ' + chalk.gray('— Auto-map red flags, landmarks, dead zones, fault lines'), value: 'poi' },
    { name: IS_WINDOWS ? '[BLT] Blast Radius Analysis  ' : '💥  Blast Radius Analysis  ' + chalk.gray('— Impact map + rollback plan'), value: 'blast' },
    { name: IS_WINDOWS ? '[CNF] Conflict Detection  ' : '⚡  Conflict Detection  ' + chalk.gray('— Find contract mismatches, schema conflicts, config errors'), value: 'conflict' },
    { name: IS_WINDOWS ? '[FXF] Fix Forecast        ' : '🩹  Fix Forecast        ' + chalk.gray('— Forecast fix impact from a saved conflict scan'), value: 'fix-forecast' },
    { name: IS_WINDOWS ? '[FCT] Commit Forecast  ' : '🔮  Commit Forecast  ' + chalk.gray('— Forecast blast + conflict impact before you push'), value: 'commit-forecast' },
    { name: IS_WINDOWS ? '[REC] Recon  ' : '🔍  Recon  ' + chalk.gray('— Sizing & engagement plan, no analysis'), value: 'recon' },
    { name: IS_WINDOWS ? '[AUD] Inheritance Audit  ' : '📋  Inheritance Audit  ' + chalk.gray('— Deal-grade audit for buyers, PE diligence, fractional CTOs'), value: 'audit' },
    { name: (IS_WINDOWS ? '[CMP] Compare Reports  ' : '🔍  Compare Reports  ') + (IS_WINDOWS ? '' : chalk.gray('— Before/after diff of two saved reports')), value: 'compare' },
    { name: (IS_WINDOWS ? '[DSH] Project Dashboard  ' : '📊  Project Dashboard  ') + (IS_WINDOWS ? '' : chalk.gray('— Remediation progress across all projects')), value: 'dashboard' },
    new inquirer.Separator(),
    // "New Scan" is the explicit back-out here — returns to selectInputMethod
    // with codebase context cleared. Labeled by intent ("scan a different
    // directory") rather than the abstract "Back" because the user has a
    // loaded codebase context and the natural next-thing-up is to load a
    // different one, not to abandon work entirely.
    { name: IS_WINDOWS ? '[RLD] New Scan  — scan a different directory' : '🔄  New Scan  — scan a different directory', value: 'reload' },
    // Universal escape: "Exit Ghost" with confirm-exit, consistent with
    // top-level menu. Caller checks isBack(mode) and runs confirmExit().
    backChoice(IS_WINDOWS ? '[EXIT] Exit Ghost' : '🚪  Exit Ghost'),
  );

  const { mode } = await inquirer.prompt([{
    type: 'list',
    name: 'mode',
    message: chalk.cyan('\nWhat do you want to do?'),
    theme: inquirerTheme,
    choices,
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
  // Profiles are a Pro+ feature. On Open, bail early so no disk lookup
  // happens and no profile leaks into mode dispatch via options.profile.
  // Defense in depth: the CLI flag handler above already rejects explicit
  // --profile requests, but a configstore default-profile-slug could still
  // route through here (e.g. user downgraded from Pro back to Open and a
  // stale default-slug remains). This guard handles that path cleanly.
  if (!requireTier('feature:profiles', { tier: TIER }).allowed) {
    return { profile: null, label: null };
  }
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

// ── Universal-escape helpers ────────────────────────────────────────────────

/**
 * Prompt the user to confirm exiting Ghost. Defaults to Yes so an
 * accidental Enter on the top-level Back/Exit choice does the natural
 * thing (exit cleanly) rather than trapping the user in a no-op loop.
 * The default of `true` matches the universal-escape TODO's specification
 * ("default Y so accidental Enter doesn't trap them").
 *
 * Returns true if the user confirms exit, false if they cancel and want
 * to stay in Ghost.
 */
async function confirmExit() {
  const { reallyExit } = await inquirer.prompt([{
    type: 'confirm',
    name: 'reallyExit',
    message: chalk.cyan('Exit Ghost?'),
    default: true,
    theme: inquirerTheme,
  }]);
  return reallyExit;
}

/**
 * Dispatch a paywall payload from requireTier() to the appropriate existing
 * renderer in src/freemium.js. Per design decision 2a (2026-05-23): tier-gates
 * emits an enum-like { kind: 'audit' | 'quota' | 'unknown' } and this helper
 * routes to renderAuditPaywall() or renderQuotaPaywall(). This preserves the
 * dispatch boundary between tier-gates (policy) and freemium (paywall
 * rendering).
 *
 * paywallPromo is the server-driven promo text from fetchPromoText. Threaded
 * through to the renderers so the worker is the source of truth for promo
 * copy. Empty string means no promo block renders.
 *
 * 'unknown' kind = a feature-gate paywall was requested but feature gates
 * don't have rendered paywalls in Phase 1 (they're soft-gate callouts via
 * src/cli/session-state.js, wired in Phase 2/3). Logging the gate id makes
 * accidental misuse visible during testing rather than silently failing.
 */
function renderPaywall(paywall, paywallPromo = '') {
  if (!paywall || !paywall.kind) {
    console.log(chalk.gray('  (Access denied. No paywall renderer available.)\n'));
    return;
  }
  if (paywall.kind === 'audit')  { renderAuditPaywall(paywallPromo); return; }
  if (paywall.kind === 'quota')  { renderQuotaPaywall(paywallPromo); return; }
  console.log(chalk.gray(`  (No paywall renderer for gate: ${paywall.gateId})\n`));
}

// ── Main loop ────────────────────────────────────────────────────────────────

// ── License helpers ────────────────────────────────────────────────────────

/**
 * Handle `ghost --activate <input>`. The input is either:
 *   (a) A human-typeable key like GA-2026-PRO-X7K9-M2P4-Q8R3 — we POST it to
 *       the activation server, receive a signed token bound to this machine,
 *       and save it.
 *   (b) A pre-signed token (long base64url.base64url.base64url blob) — we
 *       verify the signature locally, confirm fingerprint binding, and save.
 *       This is the v1-manual fallback for licenses minted by EJ on the iMac
 *       and emailed directly.
 *
 * We detect format with tryParseKey() first because:
 *   - Human keys have a fixed format (6 hyphen-separated segments, 26 chars)
 *     and a built-in checksum, so detection is unambiguous.
 *   - Pre-signed tokens are 200+ chars of base64url and would fail human-key
 *     parsing immediately with a "must have 6 segments" error.
 */
async function runActivateFlow(input) {
  if (!input || !input.trim()) {
    console.error(chalk.red(`\n${SYM.cross} --activate requires a license key or token. Paste the value from your license email.\n`));
    process.exit(2);
  }
  const cleaned = input.trim();

  // Try human-key path first. tryParseKey returns { ok, parsed } or { ok: false, error }.
  const keyAttempt = tryParseKey(cleaned);
  if (keyAttempt.ok) {
    await runActivateViaHumanKey(cleaned, keyAttempt.parsed);
    return;
  }

  // Not a human key — assume signed token.
  await runActivateViaSignedToken(cleaned);
}

/**
 * Human-key path: POST to the activation server with the human key + the
 * current machine's fingerprint hashes, receive a signed token, verify it
 * locally, save. This is the customer-facing flow after Stripe payment.
 */
async function runActivateViaHumanKey(humanKey, parsed) {
  console.log(chalk.gray(`\nActivating ${chalk.cyan(humanKey)} (tier: ${parsed.tier})...`));

  const fpHashes = currentFingerprintHashes();

  let resp;
  let respBody;
  try {
    resp = await fetch(ACTIVATION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ humanKey, fingerprintHashes: fpHashes }),
    });
    respBody = await resp.json().catch(() => ({}));
  } catch (err) {
    console.error(chalk.red(`\n${SYM.cross} Could not reach activation server: ${err.message}`));
    console.error(chalk.gray('   Check your internet connection and try again. If your network blocks'));
    console.error(chalk.gray('   ' + ACTIVATION_ENDPOINT + ', email support@ghostarchitect.dev'));
    console.error(chalk.gray('   for an offline activation token.\n'));
    process.exit(2);
  }

  if (!resp.ok) {
    const code = respBody && respBody.error ? respBody.error : `http_${resp.status}`;
    const friendly =
      code === 'license_not_found'                 ? 'License key not found. Double-check the key from your email.' :
      code === 'license_revoked'                   ? 'This license has been revoked. Email support@ghostarchitect.dev if you believe this is an error.' :
      code === 'license_bound_to_different_machine'? (respBody.detail || 'This license is already activated on a different machine.') :
      code === 'invalid_key_format'                ? 'License key format is invalid. Check for typos.' :
      code === 'rate_limit_exceeded'               ? 'Too many activation attempts. Wait a minute and try again.' :
                                                     `Activation server returned ${code}.`;
    console.error(chalk.red(`\n${SYM.cross} Activation refused: ${friendly}\n`));
    process.exit(2);
  }

  if (!respBody.signedToken || typeof respBody.signedToken !== 'string') {
    console.error(chalk.red(`\n${SYM.cross} Activation server returned an unexpected response (no signedToken).`));
    console.error(chalk.gray('   This is a bug — email support@ghostarchitect.dev with the time of this attempt.\n'));
    process.exit(2);
  }

  // Verify the returned token locally before saving. The server should never
  // hand us a bad token, but a compromised server is exactly what local
  // signature verification protects against.
  let decoded;
  try {
    decoded = decodeAndVerifyToken(respBody.signedToken);
  } catch (e) {
    console.error(chalk.red(`\n${SYM.cross} Activation server returned a token that failed local verification: ${e.message}`));
    console.error(chalk.gray('   This is a bug or a man-in-the-middle. Email support@ghostarchitect.dev.\n'));
    process.exit(2);
  }
  const payload = decoded.payload;

  // Confirm the token is bound to THIS machine. The server should have set
  // payload.fingerprint = fpHashes (the hashes we sent), but verify anyway.
  if (payload.fingerprint) {
    const { matchesFingerprint } = await import('../src/license/fingerprint.js');
    const m = matchesFingerprint(fpHashes, payload.fingerprint);
    if (!m.match) {
      console.error(chalk.red(`\n${SYM.cross} Server returned a token bound to a different machine.`));
      console.error(chalk.gray(`   This is a bug. Got ${m.matchCount} of 4 hardware components matching.\n`));
      process.exit(2);
    }
  }

  saveActivation({ token: respBody.signedToken, fingerprintHashes: fpHashes });

  const reactivated = !!respBody.reactivated;
  console.log('\n' + boxen(
    chalk.green.bold(`${SYM.check} License ${reactivated ? 're-activated' : 'activated'}`) + '\n\n' +
    chalk.white('Customer: ') + chalk.cyan(payload.customer) + '\n' +
    chalk.white('Tier:     ') + chalk.cyan(payload.tier) + '\n' +
    chalk.white('Expires:  ') + chalk.cyan(payload.expires.slice(0, 10)) + '\n' +
    chalk.white('Grace:    ') + chalk.cyan('through ' + payload.grace_until.slice(0, 10)),
    { padding: 1, borderColor: 'green', borderStyle: 'round' }
  ));
  if (reactivated) {
    console.log(chalk.gray('  (License was already activated on this machine — token refreshed.)'));
  }
  console.log('');
}

/**
 * Signed-token path: existing v1-manual flow. The customer was emailed a
 * pre-signed token (long base64url blob). We verify the signature locally,
 * confirm fingerprint binding matches this machine, save.
 */
async function runActivateViaSignedToken(tokenString) {
  let decoded;
  try {
    decoded = decodeAndVerifyToken(tokenString);
  } catch (e) {
    console.error(chalk.red(`\n${SYM.cross} Activation failed: ${e.message}`));
    console.error(chalk.gray('   The input was not a valid license key (GA-YYYY-TIER-XXXX-XXXX-XXXX format)'));
    console.error(chalk.gray('   AND not a valid signed token. Copy the value from your license email exactly\n   and try again. If issues persist, email support@ghostarchitect.dev.\n'));
    process.exit(2);
  }
  const payload = decoded.payload;
  const fpHashes = currentFingerprintHashes();

  // If the token has fingerprint binding, verify it matches THIS machine
  // before we save. Otherwise the customer gets a useless license and
  // a confusing "License is bound to a different machine" error on next run.
  if (payload.fingerprint) {
    const { matchesFingerprint } = await import('../src/license/fingerprint.js');
    const m = matchesFingerprint(fpHashes, payload.fingerprint);
    if (!m.match) {
      console.error(chalk.red(`\n${SYM.cross} Activation refused: this license is bound to a different machine.`));
      console.error(chalk.gray(`   Got ${m.matchCount} of 4 hardware components matching (need 3). If you have a new\n   machine, email support@ghostarchitect.dev to have your license reissued.\n`));
      process.exit(2);
    }
  }

  saveActivation({ token: tokenString, fingerprintHashes: fpHashes });

  console.log('\n' + boxen(
    chalk.green.bold(`${SYM.check} License activated`) + '\n\n' +
    chalk.white('Customer: ') + chalk.cyan(payload.customer) + '\n' +
    chalk.white('Tier:     ') + chalk.cyan(payload.tier) + '\n' +
    chalk.white('Expires:  ') + chalk.cyan(payload.expires.slice(0, 10)) + '\n' +
    chalk.white('Grace:    ') + chalk.cyan('through ' + payload.grace_until.slice(0, 10)),
    { padding: 1, borderColor: 'green', borderStyle: 'round' }
  ));
  console.log('');
}

/**
 * Handle `ghost --license` — show status without running validation against
 * the network (so the command is fast and works offline).
 */
async function runLicenseStatusFlow() {
  if (!hasLicense()) {
    console.log('\n' + boxen(
      chalk.yellow.bold(`No license installed`) + '\n\n' +
      chalk.gray('Install a license with:') + '\n' +
      chalk.cyan('  ghost --activate <signed-token-from-email>') + '\n\n' +
      chalk.gray('Purchase at ') + chalk.cyan('https://ghostarchitect.dev/pricing'),
      { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
    ));
    console.log('');
    return;
  }
  // Skip network clock check so this flag is fast + offline-safe.
  const result = await validateLicense({ skipNetworkClock: true });
  const record = getLicenseRecord();

  const stateColor =
    result.state === 'valid'      ? chalk.green :
    result.state === 'valid_warn' ? chalk.yellow :
    result.state === 'grace'      ? chalk.yellow :
    result.state === 'expired'    ? chalk.red :
    result.state === 'hard_stop'  ? chalk.red :
    result.state === 'tampered'   ? chalk.red :
    chalk.red;

  const lines = [
    chalk.cyan.bold(`License Status`) + '  ' + stateColor.bold(`[${result.state}]`),
    '',
    chalk.white('Customer:  ') + chalk.cyan(result.customer || '(unknown)'),
    chalk.white('Tier:      ') + chalk.cyan(result.tier || '(unknown)'),
  ];
  if (result.expires) {
    lines.push(chalk.white('Expires:   ') + chalk.cyan(result.expires.slice(0, 10)) +
      chalk.gray(`  (${result.daysUntilExpires} days)`));
  }
  if (result.hard_stop) {
    lines.push(chalk.white('Hard stop: ') + chalk.cyan(result.hard_stop.slice(0, 10)) +
      chalk.gray(`  (${result.daysUntilHardStop} days)`));
  }
  if (record && record.activated_at) {
    lines.push(chalk.white('Activated: ') + chalk.gray(record.activated_at.slice(0, 10)));
  }
  if (record && record.last_seen_utc) {
    lines.push(chalk.white('Last seen: ') + chalk.gray(record.last_seen_utc));
  }
  if (result.message) {
    lines.push('');
    lines.push(stateColor(result.message));
  }
  console.log('\n' + boxen(lines.join('\n'),
    { padding: 1, borderColor: stateColor === chalk.green ? 'green' :
                                stateColor === chalk.yellow ? 'yellow' : 'red',
      borderStyle: 'round' }));
  console.log('');
}

/**
 * Handle `ghost --license-clear` — remove the stored license. Asks for
 * confirmation to prevent fat-finger accidents.
 */
async function runLicenseClearFlow() {
  if (!hasLicense()) {
    console.log(chalk.gray('\nNo license installed. Nothing to clear.\n'));
    return;
  }
  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: chalk.yellow('Remove the installed license? You will need to re-activate to run new scans.'),
    default: false,
    theme: inquirerTheme,
  }]);
  if (!confirm) {
    console.log(chalk.gray('\nCancelled. License left in place.\n'));
    return;
  }
  clearLicense();
  console.log(chalk.green(`\n${SYM.check} License removed.\n`));
}

/**
 * Server-driven promo text fetcher. Reads `promo` and `paywallPromo` fields
 * from /pulse-stats on the signup worker. Worker is the source of truth;
 * change the constants in the worker, redeploy, every Open install on next
 * run sees new text. Decoupled from CLI release cycle by design.
 *
 * Returns { promo, paywallPromo } where both fields are trimmed strings.
 * Each field defaults to empty string independently: if the worker response
 * has `promo` but not yet `paywallPromo` (worker not yet redeployed with
 * Fix 4 changes), the result is { promo: 'whatever worker says',
 * paywallPromo: '' }. This makes the CLI backward compatible against either
 * an old or new worker deployment.
 *
 * Failure modes are all silent. Returns { promo: '', paywallPromo: '' } on
 * any error (network drop, timeout, non-2xx HTTP, malformed JSON, missing
 * or non-string fields). Never throws. Callers render conditionally on
 * non-empty strings; empty fields render nothing.
 */
async function fetchPromoText() {
  const PROMO_TIMEOUT_MS = 2000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROMO_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch('https://signup.ghostarchitect.dev/pulse-stats', {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return { promo: '', paywallPromo: '' };
    const data = await resp.json();
    return {
      promo:        typeof data?.promo        === 'string' ? data.promo.trim()        : '',
      paywallPromo: typeof data?.paywallPromo === 'string' ? data.paywallPromo.trim() : '',
    };
  } catch (_) {
    return { promo: '', paywallPromo: '' };
  }
}

/**
 * Render the appropriate banner for non-valid license states, BEFORE the
 * mode dispatch happens. For blocking states this also exits the process
 * after rendering — caller doesn't need to handle that.
 *
 * Returns true if the run should be blocked (caller should not proceed).
 * Returns false if the run can continue (state was valid or just a warning).
 */
function renderLicenseStateAndMaybeBlock(result, promoText = '') {
  // State: missing license. Render the Ghost Open welcome banner and
  // FALL THROUGH to Open tier behavior. Per D2 (locked 2026-05-23): no
  // license = Open tier; the user can run Question, Recon, and four free
  // deep scans before the quota wall fires. tier-gates.js requireTier()
  // handles enforcement at mode dispatch. This function just shows the
  // welcome surface.
  //
  // The promo line is worker-driven (see fetchPromoText callsite). When
  // promoText is a non-empty string, it renders between "After that, scans
  // require a license." and the "Pricing:" line. When empty, the banner
  // flows directly from one to the other, preserving EJ's launch-day
  // ability to change promo text via wrangler deploy without a CLI republish.
  if (result.state === 'missing') {
    const lines = [
      chalk.cyan.bold('Ghost Open') + '\n',
      chalk.white('Ask questions about your codebase and get an engagement plan,'),
      chalk.white('free, as often as you like.') + '\n',
      chalk.white('Run a deep scan to find risks, map impact, or detect conflicts.'),
      chalk.white('Your first four are free.') + '\n',
      chalk.white('After that, scans require a license.') + '\n',
    ];
    if (promoText) {
      lines.push(chalk.cyan.bold(promoText) + '\n');
    }
    lines.push(chalk.white('Pricing: ') + chalk.cyan('https://ghostarchitect.dev/pricing') + '\n');
    lines.push(chalk.white('Have a license? Activate it:'));
    lines.push(chalk.cyan('  ghost --activate <your key here>') + '\n');
    lines.push(chalk.white('Questions: ') + chalk.cyan('support@ghostarchitect.dev'));
    console.log('\n' + boxen(lines.join('\n'),
      { padding: 1, borderColor: 'yellow', borderStyle: 'round' }));
    console.log('');
    return false;  // fall through to Open tier behavior per D2
  }
  if (isBlocking(result.state)) {
    const headline =
      result.state === 'hard_stop' ? 'License expired' :
      result.state === 'invalid'   ? 'License invalid' :
      result.state === 'tampered'  ? 'Clock validation failed' :
                                     'License problem';
    console.log('\n' + boxen(
      chalk.red.bold(`${SYM.cross} ${headline}`) + '\n\n' +
      chalk.white(result.message) + '\n\n' +
      chalk.gray('Renew: ') + chalk.cyan('https://ghostarchitect.dev/pricing') + '\n' +
      chalk.gray('Help:  ') + chalk.cyan('support@ghostarchitect.dev'),
      { padding: 1, borderColor: 'red', borderStyle: 'round' }
    ));
    console.log('');
    console.log(chalk.gray('Existing reports on disk are unaffected. New scans are blocked until\nthe license is renewed.\n'));
    return true;
  }
  // valid_warn / grace / expired — show banner, continue
  if (result.state === 'valid_warn') {
    console.log(chalk.yellow(`\n⚠  ${result.message}\n`));
    return false;
  }
  if (result.state === 'grace' || result.state === 'expired') {
    const color = result.state === 'expired' ? 'red' : 'yellow';
    const chalkColor = result.state === 'expired' ? chalk.red : chalk.yellow;
    console.log('\n' + boxen(
      chalkColor.bold('License attention needed') + '\n\n' +
      chalk.white(result.message) + '\n\n' +
      chalk.gray('Renew: ') + chalk.cyan('https://ghostarchitect.dev/pricing'),
      { padding: 1, borderColor: color, borderStyle: 'round' }
    ));
    console.log('');
    return false;
  }
  return false;
}

async function main() {
  // Parse CLI flags first so --help / --version / --max-context etc. are honored
  // before we print the banner or run the setup wizard.
  const argv = process.argv.slice(2);
  const cliOpts = parseArgs(argv);

  // Early license-tier resolve for display surfaces (--help, --version, banner).
  // validateLicense({ skipNetworkClock: true }) skips the worldtimeapi roundtrip
  // so documentation flags stay fast. The main-flow validateLicense() later still
  // runs the full clock check; both calls are idempotent (updateLastSeenUtc is a
  // monotonic ratchet, setActiveLicense is last-write-wins). Blocking states are
  // NOT enforced here — display surfaces must always work; enforcement happens
  // at the main-flow gate.
  try {
    const earlyLicenseResult = await validateLicense({ skipNetworkClock: true });
    setActiveLicense(earlyLicenseResult);
    TIER = getActiveTier() || 'open';
  } catch (_) {
    // Non-fatal: fall through with TIER='open'. Main-flow error rendering catches real issues.
  }

  if (cliOpts.help)    { printUsage(); process.exit(0); }
  if (cliOpts.version) { console.log(`ghost-architect v${VERSION} (${TIER})`); process.exit(0); }

  // License management flags — handle and exit BEFORE we run any other
  // setup so customers can always reach `--activate`, `--license`, and
  // `--license-clear` even when their license is expired or missing.
  if (cliOpts.activate !== null) {
    await runActivateFlow(cliOpts.activate);
    process.exit(0);
  }
  if (cliOpts.licenseStatus) {
    await runLicenseStatusFlow();
    process.exit(0);
  }
  if (cliOpts.licenseClear) {
    await runLicenseClearFlow();
    process.exit(0);
  }

  // Ghost Partner profile flags are Pro+. On Open, exit early with a
  // friendly message before any flag-specific logic runs. --no-profile
  // is intentionally excluded (declarative "do not use a profile" is
  // already the default behavior on Open; rejecting it would be punitive).
  const profileFlagRequested =
    cliOpts.profile !== null ||
    cliOpts.createProfile ||
    cliOpts.listProfiles ||
    cliOpts.setDefaultProfile !== null ||
    cliOpts.clearDefaultProfile;
  if (profileFlagRequested && !requireTier('feature:profiles', { tier: TIER }).allowed) {
    console.log('\n' + boxen(
      chalk.cyan.bold('Ghost Partner profiles are a Pro feature') + '\n\n' +
      chalk.white('Profiles let consultants and agencies run scans with their own') + '\n' +
      chalk.white('branding, methodology, and billing rates baked into reports.') + '\n\n' +
      chalk.white('Activate a Pro license to use profiles:') + '\n' +
      chalk.cyan('  ghost --activate <your key here>') + '\n\n' +
      chalk.white('Pricing: ') + chalk.cyan('https://ghostarchitect.dev/pricing'),
      { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
    ));
    console.log('');
    process.exit(0);
  }

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

  if (!isConfigured()) {
    console.log(boxen(
      chalk.yellow.bold('Welcome to Ghost Architect!') + '\n' +
      chalk.gray('Looks like this is your first time here.\nLet\'s get you set up.'),
      { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
    ));
    console.log('');
    await runSetupWizard();
  }

  // ── License enforcement gate ─────────────────────────────────────────────
  // Runs after setup wizard so first-time users can complete API key
  // configuration before being told about licensing, but BEFORE we enter
  // the mode loop so we never accept work the customer can't pay for.
  // Status states (missing / invalid / hard_stop / tampered) block.
  // Warning states (valid_warn / grace / expired) display a banner and let
  // the run continue.

  // Worker-driven promo strings. Declared at function scope so the mode
  // loop below (which fires after license enforcement) has access to
  // paywallPromo when renderPaywall is invoked on a quota or audit gate.
  // Populated only when state is missing (no license = Open tier); other
  // license states never reach the paywall renderers.
  let promos = { promo: '', paywallPromo: '' };
  try {
    let licenseResult = await validateLicense();

    // Set active license for the session so downstream code (PDF generator
    // watermark, audit-mode block) can consult it without re-parsing the token.
    setActiveLicense(licenseResult);

    // Resolve TIER from the active license now that validation has succeeded.
    // Per D2 (locked 2026-05-23): no license = open tier. The setScanOptions
    // call below uses this TIER to seed the loader's tier-cap clamping, so
    // resolving here (post-license-validation, pre-mode-loop) means the loader
    // sees the right cap for the user's actual tier on the very first scan.
    TIER = getActiveTier() || 'open';

    // Banner emission happens here, AFTER tier resolution, so the title-case
    // `[Pro]` / `[Team]` / `[Open]` token in the banner reflects the active
    // license. All three CLI display surfaces (banner, --help, --version)
    // run post-license per meta-arb decision 2026-05-24: trust on display
    // surfaces is binary; partial fix is worse than no fix.
    printBanner();

    // Re-seed scan options with the resolved tier. The earlier setScanOptions
    // call (right after parseArgs) ran with TIER='open' as the placeholder
    // default — it had to, since license validation hadn't happened yet, but
    // CLI parsing precedes everything. Now that we know the real tier, push
    // it down to the loader so the very first loadCodebase() call uses the
    // correct tier-cap (open 50K vs pro/team/enterprise 100K/150K/200K).
    // setScanOptions is documented as last-write-wins and safe to recall.
    setScanOptions({
      tier: TIER,
      maxContextOverride: cliOpts.maxContext,
      excludePresets: cliOpts.presets,
      excludePatterns: cliOpts.excludes,
    });

    // Fire promo fetch only when we'll actually render the no-license banner.
    // For any other state, skip the network call; it adds nothing. The full
    // result (welcome banner promo + paywall promo) is stashed in the
    // function-scoped `promos` so the mode loop below can use paywallPromo
    // when a gate fires.
    if (licenseResult.state === 'missing') {
      promos = await fetchPromoText();
    }
    const blocked = renderLicenseStateAndMaybeBlock(licenseResult, promos.promo);
    if (blocked) {
      console.log(chalk.gray(`${COPYRIGHT}\n`));
      process.exit(1);
    }
  } catch (err) {
    // Defense in depth: if validation itself crashes, fail closed.
    console.error(chalk.red(`\n${SYM.cross} License validation failed unexpectedly: ${err.message}`));
    console.error(chalk.gray('   Email support@ghostarchitect.dev with this error if it persists.\n'));
    process.exit(1);
  }

  let codebaseContext = null;
  const session = new SessionCostTracker();

  // ── Non-interactive Commit Forecast branch ────────────────────────────────
  // Fires ONLY when ALL THREE of --baseline, --proposed, --modes are present.
  // Any missing flag → fall through to the interactive while-loop below.
  if (cliOpts.cfBaseline && cliOpts.cfProposed && cliOpts.cfModes) {
    const { cfBaseline, cfProposed, cfModes } = cliOpts;

    // a. Validate paths exist and are readable directories.
    for (const [flag, p] of [['--baseline', cfBaseline], ['--proposed', cfProposed]]) {
      if (!fs.existsSync(p)) {
        console.error(chalk.red(`\n  ✗ ${flag} path does not exist: ${p}\n`));
        process.exit(1);
      }
      if (!fs.statSync(p).isDirectory()) {
        console.error(chalk.red(`\n  ✗ ${flag} path is not a directory: ${p}\n`));
        process.exit(1);
      }
    }

    // b. Validate --modes values.
    const VALID_CF_MODES = ['blast', 'conflict', 'both'];
    const rawModes = cfModes.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const invalidModes = rawModes.filter(m => !VALID_CF_MODES.includes(m));
    if (invalidModes.length > 0) {
      console.error(chalk.red(
        `\n  ✗ Unknown --modes value(s): ${invalidModes.join(', ')}\n` +
        `  Valid values: ${VALID_CF_MODES.join(', ')}\n`
      ));
      process.exit(1);
    }

    // c. Load baseline as codebase using the existing loader.
    try {
      codebaseContext = await loadFromPath(cfBaseline);
    } catch (err) {
      console.error(chalk.red(`\n  ✗ Failed to load baseline: ${err.message}\n`));
      process.exit(1);
    }
    if (!codebaseContext) {
      console.error(chalk.red(`\n  ✗ Baseline loaded no files from: ${cfBaseline}\n`));
      process.exit(1);
    }

    // d. Dispatch directly to runCommitForecastMode with all flags.
    await runCommitForecastMode(codebaseContext, {
      profile,
      tier:         TIER,
      paywallPromo: promos.paywallPromo,
      cfBaseline,
      cfProposed,
      cfModes,
      cfLabel:      cliOpts.cfLabel    || null,
      cfNoVerify:   cliOpts.cfNoVerify || false,
    });
    process.exit(0);
  }

  while (true) {
    if (!codebaseContext) {
      const method = await selectInputMethod(activeProfileLabel, TIER);

      // Universal escape: top-level Back/Exit — confirm before leaving.
      if (isBack(method)) {
        if (await confirmExit()) {
          session.showSummary();
          console.log(chalk.cyan('\nIntel gathered. Go make your move.\n'));
          console.log(chalk.gray(`${COPYRIGHT}\n`));
          process.exit(0);
        }
        continue;
      }

      if (method === 'reconfigure') {
        await reconfigure();
        printBanner();
        continue;
      }

      if (method === 'dashboard') {
        pingModeUsage(VERSION, TIER, 'dashboard').catch(() => {});
        await showProjectDashboard();
        continue;
      }

      if (method === 'compare') {
        pingModeUsage(VERSION, TIER, 'compare').catch(() => {});
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
          message: chalk.cyan("Folder containing prompt files (absolute path, or 'back' to cancel):"),
          theme: inquirerTheme,
          validate: (input) => {
            if (!input || !input.trim()) return 'Folder path is required.';
            // Universal-escape: allow 'back' through validation so the
            // post-prompt isBackKeyword() check can route the cancellation.
            if (input.trim().toLowerCase() === 'back') return true;
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

        // Universal-escape: 'back' keyword — return to selectInputMethod.
        if (isBackKeyword(folderPath)) {
          continue;
        }

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
          // Universal-escape: add Back to the model picker so user isn't
          // committed to a model just because they answered "yes" to the
          // confirm above.
          modelChoices.push(new inquirer.Separator());
          modelChoices.push(backChoice('←  Back (don\'t specify a model)'));
          const answer = await inquirer.prompt([{
            type: 'list',
            name: 'targetModel',
            message: chalk.cyan('Target model:'),
            choices: modelChoices,
            pageSize: 12,
            theme: inquirerTheme,
          }]);
          // Back leaves targetModel null, same as if user had declined to specify.
          if (!isBack(answer.targetModel)) {
            targetModel = answer.targetModel;
          }
        }

        try {
          // Tier-gate check at dispatch — wall BEFORE telemetry ping and
          // before any prompt loading or LLM call. Mirrors the dispatch
          // gate below for POI/Blast/Conflict/Audit. Per D1: prompt-triage
          // shares the 4-scan quota with the other counted modes.
          const ptVerdict = requireTier('mode:prompt-triage', { scansUsed: getScanCount() });
          if (!ptVerdict.allowed) {
            renderPaywall(ptVerdict.paywall, promos.paywallPromo);
            continue;
          }

          // Telemetry — fire BEFORE the run so a long Prompt Triage doesn't
          // delay the ping landing in Pulse. Fire-and-forget; if the network
          // is slow, the user shouldn't wait. Lands as `mode-prompt-triage`
          // in the dashboard's Event Sources histogram.
          pingModeUsage(VERSION, TIER, 'prompt-triage').catch(() => {});

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

    const mode = await selectMode(codebaseContext, TIER);

    // Universal escape: Exit Ghost from mode menu — confirm before leaving.
    if (isBack(mode)) {
      if (await confirmExit()) {
        session.showSummary();
        console.log(chalk.cyan('\nIntel gathered. Go make your move.\n'));
        console.log(chalk.gray(`${COPYRIGHT}\n`));
        process.exit(0);
      }
      continue;
    }

    if (mode === 'reload') {
      codebaseContext = null;
      printBanner();
      continue;
    }

    // Mode-usage telemetry. Fire-and-forget so a slow Pulse Worker never
    // delays a scan. Lands as `mode-<name>` in the Pulse dashboard so the
    // Scan Modes histogram shows real cross-tier usage (not just Open).
    pingModeUsage(VERSION, TIER, mode).catch(() => {});

    // Tier-gate check at dispatch — wall BEFORE API spend or codebase work.
    // Per design decision 2026-05-23 (Q4): dispatch-level gating, not
    // post-proceed-confirm gating. Quota-gated modes consult getScanCount()
    // for the current count; audit-gated checks the tier alone. Cycle 14
    // adds chat to this list (mode:chat went from open:true to open:false
    // when Question mode launched as the Open-tier Q&A surface). Question,
    // recon, compare, dashboard — free across all tiers.
    // commit-forecast is handled separately below (uses its own forecast-quota gate).
    if (['chat', 'poi', 'blast', 'conflict', 'audit'].includes(mode)) {
      const verdict = requireTier(`mode:${mode}`, { scansUsed: getScanCount() });
      if (!verdict.allowed) {
        renderPaywall(verdict.paywall, promos.paywallPromo);
        continue;
      }
    }

    // Commit Forecast quota gate — checked at dispatch so the paywall fires
    // immediately when the user picks the mode, before any UI renders.
    if (mode === 'commit-forecast') {
      const verdict = requireTier('mode:commit-forecast', { forecastsUsed: getForecastCount() });
      if (!verdict.allowed) {
        renderForecastPaywall(promos.paywallPromo);
        continue;
      }
    }

    switch (mode) {
      case 'question':        await runQuestionMode(codebaseContext, { tier: TIER });         break;
      case 'chat':            await runChatMode(codebaseContext, { tier: TIER });             break;
      case 'poi':             await runPOIMode(codebaseContext, { profile, tier: TIER });  break;
      case 'blast':           await runBlastMode(codebaseContext, { profile, tier: TIER });  break;
      case 'conflict':        await runConflictMode(codebaseContext, { profile, tier: TIER });  break;
      case 'fix-forecast':    await runSavedFixForecast({ tier: TIER, profile, codebaseContext }); break;
      // Commit Forecast: gate is handled inside runCommitForecastMode via
      // checkForecastGate(), which reads getForecastCount() and calls
      // renderForecastPaywall() directly. This keeps the paywall-dispatch
      // logic co-located with the Forecast counter (freemium.js) rather than
      // duplicated here. paywallPromo passes through for server-driven copy.
      case 'commit-forecast': await runCommitForecastMode(codebaseContext, {
        profile,
        tier:         TIER,
        paywallPromo: promos.paywallPromo,
        cfBaseline:   cliOpts.cfBaseline || null,
        cfProposed:   cliOpts.cfProposed || null,
        cfModes:      cliOpts.cfModes    || null,
        cfLabel:      cliOpts.cfLabel    || null,
        cfNoVerify:   cliOpts.cfNoVerify || false,
      }); break;
      case 'recon':           await runReconMode(codebaseContext, { profile });  break;
      case 'audit':           await runAuditMode(codebaseContext, { profile, tier: TIER });  break;
      case 'compare':         await runCompareMode();                         break;
      case 'dashboard':       await showProjectDashboard();                   break;
    }
  }
}

// ── Ghost Brief ───────────────────────────────────────────────────────────
if (process.argv.includes('--brief')) {
  const { generateBrief, writeBrief } = await import('../lib/ghostBrief.js');
  const { fromFixForecast, fromPOI, fromConflict } = await import('../lib/ghostBriefAdapter.js');
  const { publishBriefToPortal, isPortalConfigured } = await import('../src/core/portal-publish.js');
  const { version } = _require('../package.json');

  // Resolve license tier before doing anything else
  const briefLicenseResult = await validateLicense({ skipNetworkClock: true });
  setActiveLicense(briefLicenseResult);
  const briefTier = getActiveTier() || 'open';

  const BRIEF_TIERS = ['pro-max', 'team', 'team-max', 'enterprise', 'enterprise-max'];
  if (!BRIEF_TIERS.includes(briefTier)) {
    console.error('Ghost Brief requires Ghost Pro Max or higher.');
    console.error('Upgrade at: https://ghostarchitect.dev/upgrade');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const inputFlag = args.find(a => a.startsWith('--input='));
  const outputFlag = args.find(a => a.startsWith('--output='));
  const inputFile = inputFlag ? inputFlag.split('=')[1] : 'ghost-report.json';
  const outputFile = outputFlag ? outputFlag.split('=')[1] : 'ghost-brief.json';

  if (!fs.existsSync(inputFile)) {
    console.error(`Ghost Brief: input file not found: ${inputFile}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } catch (e) {
    console.error(`Ghost Brief: failed to parse ${inputFile}: ${e.message}`);
    process.exit(1);
  }

  // Detect source and adapt findings
  let findings = [];
  if (raw.prompts) {
    // Already in Brief format — re-validate only
    findings = raw.prompts;
  } else if (raw.findings) {
    const mode = raw.scan_mode || raw.mode || 'fix-forecast';
    if (mode === 'fix-forecast') findings = fromFixForecast(raw.findings);
    else if (mode === 'poi') findings = fromPOI(raw.findings);
    else if (mode === 'conflict') findings = fromConflict(raw.findings);
    else findings = fromFixForecast(raw.findings); // best-effort fallback
  } else {
    console.error('Ghost Brief: input file has no recognized findings structure.');
    process.exit(1);
  }

  try {
    const brief = generateBrief({
      findings,
      ghostVersion: version,
      scanFile: inputFile,
      codemaseRoot: process.cwd()
    });
    const outPath = writeBrief(brief, outputFile);
    console.log(`Ghost Brief written to: ${outPath}`);
    console.log(`  ${brief.summary.total_prompts} prompts | ${brief.summary.estimated_agent_hours}h estimated`);

    // ── Portal Publish (non-fatal) ─────────────────────────────────────
    if (isPortalConfigured() && fs.existsSync(outPath)) {
      try {
        const portalResult = await publishBriefToPortal(outPath);
        if (portalResult.ok) {
          console.log('  Ghost Brief pushed to portal.');
        } else {
          console.log(`  Portal push skipped: ${portalResult.reason}`);
        }
      } catch (e) {
        console.log(`  Portal push failed (non-fatal): ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`Ghost Brief failed: ${e.message}`);
    process.exit(1);
  }

  process.exit(0);
}
// ── End Ghost Brief ───────────────────────────────────────────────────────

// Resolve symlinks on both sides so the `ghost` global-install symlink
// (which points at this file via realpath) is recognized as the entry
// point and triggers main(). The fallback catches edge cases where
// realpathSync throws (unusual but cheap to guard against).
const isMain = () => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
};

if (isMain()) {
  main().catch(err => {
    console.error(chalk.red('\n' + SYM.cross + ' Fatal error:'), err.message);
    process.exit(1);
  });
}

// Exports for testing. The guard above ensures importing this module
// from a test file (e.g. tests/banner-promo.smoke.mjs) does NOT execute
// main() — tests get clean access to the underlying helpers.
export { fetchPromoText, renderLicenseStateAndMaybeBlock };
