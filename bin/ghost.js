#!/usr/bin/env node

import { createRequire } from 'module';
import chalk from 'chalk';
import gradient from 'gradient-string';
import figlet from 'figlet';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { isConfigured, runSetupWizard, reconfigure, usingEnvKey, getDefaultProfileSlug, setDefaultProfileSlug, resolveApiKey, reconcileSudoOwnership, isLinuxRootWithoutSudoUser, getConfig, secureConfigFile, getModelChoices } from '../src/config.js';
import { getPublishConfig, setPublishConfig, getPublishToken, clearPendingMarker } from '../src/core/mobile-publish.js';
import { createOctokit } from '../src/utils/octokit-client.js';
import { loadCodebase, loadFromPath, setScanOptions } from '../src/loader/index.js';
import { runChatMode } from '../src/modes/chat.js';
import { runQuestionMode, retrieveQuestionBatchResult } from '../src/modes/question.js';
import { runPOIMode } from '../src/modes/poi.js';
import { runBlastMode, retrieveBlastBatchResult } from '../src/modes/blast.js';
import Anthropic from '@anthropic-ai/sdk';
import { getPendingBatches, findPendingBatch, updatePendingBatch, removePendingBatch } from '../src/lib/batch-store.js';
import { formatClockTime } from '../src/lib/transport-meta.js';
import { runReconMode } from '../src/modes/recon.js';
import { runAuditMode } from '../src/modes/audit/index.js';
import { pingModeUsage } from '../src/telemetry/pulse.js';
import { TIER_CAPS, getTierCap } from '../src/loader/tierCaps.js';
import { listPresets } from '../src/loader/excludes.js';
import { loadProfile, cleanCache, getCacheSize, getBranding } from '../src/profile/index.js';
import { runProfileWizard } from '../src/profile/wizard.js';
import { writeProfile, listProfiles, deleteProfile, profilePathFor, getProfilesDir } from '../src/profile/writer.js';
import fs, { realpathSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { SYM, IS_WINDOWS } from '../src/cli/symbols.js';
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
import { backChoice, isBack, isBackKeyword } from '../src/cli/prompt-helpers.js';
import { showFriendlyError } from '../src/utils/errors.js';

// ── License enforcement ────────────────────────────────────────────────────
// v1 ships on the Pro umbrella main branch only. Ghost Open (MIT, public)
// MUST NOT receive this code. Team and Enterprise inherit when those
// branches sync forward from main.
import { validateLicense, isBlocking, isWarning } from '../src/license/validator.js';
import { checkRevocation } from '../src/license/revocation.js';
import { decodeAndVerifyToken } from '../src/license/token.js';
import { tryParseKey, looksLikeHumanKey } from '../src/license/format.js';
import { currentFingerprintHashes } from '../src/license/fingerprint.js';
import {
  saveActivation,
  clearLicense,
  hasLicense,
  getLicenseRecord,
  getAdminToken,
  saveAdminToken,
} from '../src/license/store.js';
import { setActiveLicense, getActiveLicense, getActiveTier, trialDaysRemaining } from '../src/license/session.js';
import { refreshLicenseSession } from '../src/license/session-refresh.js';
import { requireTier, allowedTiers } from '../src/license/tier-gates.js';
import { getScanCount, renderAuditPaywall, renderQuotaPaywall, renderUpgradePaywall, getForecastCount, renderForecastPaywall, getFixForecastCount, renderFixForecastPaywall } from '../src/freemium.js';
import { PRICING } from '../src/constants/pricing.js';

// Activation server endpoint. Hardcoded so customers can't be tricked into
// activating against a malicious server (they'd already need to compromise
// the binary or DNS). Override only available via GHOST_ACTIVATION_ENDPOINT
// env var for local-dev testing against `wrangler dev`.
const ACTIVATION_ENDPOINT = process.env.GHOST_ACTIVATION_ENDPOINT
  || 'https://license.ghostarchitect.dev/activate';

// Admin license-issuance endpoint. Same override convention as activation so
// local-dev can point at `wrangler dev`. Used by --issue-license.
const ADMIN_ISSUE_ENDPOINT = process.env.GHOST_ADMIN_ISSUE_ENDPOINT
  || 'https://license.ghostarchitect.dev/admin/issue';

// Admin license-revocation endpoint. Same override convention. Used by
// --revoke-license.
const ADMIN_REVOKE_ENDPOINT = process.env.GHOST_ADMIN_REVOKE_ENDPOINT
  || 'https://license.ghostarchitect.dev/admin/revoke';

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

// CLI-derived scan-option overrides (--max-context, --exclude, presets,
// redaction skip), stashed by main() right after parseArgs so refresh points
// outside main()'s scope can re-seed the loader without dropping them.
// Empty until main() runs; the pre-main value only matters to code paths that
// never re-seed (none today).
let CLI_SCAN_OVERRIDES = {};

// Why the session was degraded to Open, when it was ('revoked' | 'trial-ended'
// | null). Degrade events call setActiveLicense(null), which erases the state
// the reconfigure menu needs to show a useful license row; this carries the
// reason so a cancelled customer sees "revoked: run ghost --activate <key> to
// restore" instead of "open: unknown" (Audit 7, finding 2.6). Cleared by a
// successful re-activation via refreshSessionAndTier().
let SESSION_DEGRADE_REASON = null;

// Re-validate the license and propagate the result into every session surface:
// active license, TIER, and the loader's tier cap. Call after ANY event that
// changes the installed license mid-process (in-menu activation, first-run
// onboarding activation). Audit 7 findings 1.2/1.3: without this, a customer
// who just paid saw "License activated" while the banner, the tier gates, and
// the context cap kept treating them as Open until restart, and the first-run
// wizard persisted the Open 50K cap into config for new paying customers.
async function refreshSessionAndTier() {
  const { result, tier } = await refreshLicenseSession(CLI_SCAN_OVERRIDES);
  TIER = tier;
  // A refresh that lands a usable license clears any earlier degrade note; a
  // refresh that lands a revoked or trial-ended one records it (mirrors the
  // startup blocks). Every OTHER blocking state clears the note too: keeping
  // the previous value meant a refresh landing 'missing' (license removed
  // mid-session) left the reconfigure menu's license row claiming "revoked:
  // run ghost --activate" on a machine with no license installed at all
  // (Audit 8, quick win 7).
  if (isBlocking(result.state)) {
    SESSION_DEGRADE_REASON =
      result.state === 'revoked' ? 'revoked' :
      (result.state === 'hard_stop' && result.payload?.tier === 'trial') ? 'trial-ended' :
      null;
  } else {
    SESSION_DEGRADE_REASON = null;
  }
  return tier;
}

const COPYRIGHT = 'Copyright © 2026 Ghost Architect™. All rights reserved.';

// The Max tiers, derived directly from the 'mode:ghost-brief' policy in
// src/license/tier-gates.js so there is exactly ONE source of truth. Previously
// a hardcoded array here drifted from the policy (two divergent BRIEF_TIERS
// wrongly included non-Max 'team'/'enterprise'); deriving makes that drift
// impossible — this list IS the set of tiers the policy allows Ghost Brief.
const MAX_TIERS = allowedTiers('mode:ghost-brief');
// Ghost Watcher entitlement, derived from the policy table rather than restated.
// bin/ghost.js used to carry two independent literal copies of this array (the
// headless --watcher-commit path and the Enable Watch menu), which is the same
// duplicated-tier-list drift that shipped an entitlement bug before.
const WATCH_TIERS_ALLOWED = allowedTiers('mode:watch');

// ── CLI argument parsing ────────────────────────────────────────────────────
// Supports:
//   --max-context N             override context cap (will be clamped to tier cap)
//   --exclude "glob"            exclude paths matching glob (repeatable)
//   --exclude-presets a,b       apply named exclusion preset(s), comma-separated
//   --profile path              Ghost Partner — load consultant profile from
//                               .yaml/.yml/.md/.txt file and inject into scans
//   --skip-redaction            Pro+ only — continue past a redaction failure
//                               instead of the fail-closed abort (secrets may leak)
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
    licenseDebug: false,
    configureAdminToken: false,
    issueLicense: false,
    issueTier: null,
    issueEmail: null,
    issueDays: null,
    revokeLicense: false,
    revokeKey: null,
    revokeReason: null,
    cleanCache: false,
    reconfigure: false,
    skipRedaction: false,
    stream: false,
    batch: false,
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
        console.error(chalk.red(`${SYM.cross} --max-context requires a positive integer (got: ${v})`));
        process.exit(2);
      }
      out.maxContext = n;
      continue;
    }
    if (a.startsWith('--max-context=')) {
      const v = a.slice('--max-context='.length);
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(chalk.red(`${SYM.cross} --max-context requires a positive integer (got: ${v})`));
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
    // Transport selection — skip the streaming-vs-batch menu and force a choice.
    if (a === '--stream')           { out.stream = true; continue; }
    if (a === '--batch')            { out.batch = true; continue; }
    // License management flags.
    if (a === '--activate')         { out.activate = argv[++i] || ''; continue; }
    if (a.startsWith('--activate=')){ out.activate = a.slice('--activate='.length); continue; }
    if (a === '--recover-session')          { out.recoverSession = argv[++i] || ''; continue; }
    if (a.startsWith('--recover-session=')) { out.recoverSession = a.slice('--recover-session='.length); continue; }
    if (a === '--sessions-dir')          { out.sessionsDir = argv[++i] || ''; continue; }
    if (a.startsWith('--sessions-dir=')) { out.sessionsDir = a.slice('--sessions-dir='.length); continue; }
    if (a === '--license')          { out.licenseStatus = true; continue; }
    if (a === '--export-ci-token')  { out.exportCiToken = true; continue; }
    if (a === '--license-clear')    { out.licenseClear = true; continue; }
    if (a === '--deactivate')       { out.licenseClear = true; continue; } // alias for --license-clear
    if (a === '--license-debug')    { out.licenseDebug = true; continue; }
    if (a === '--configure-admin-token') { out.configureAdminToken = true; continue; }
    if (a === '--issue-license')         { out.issueLicense = true; continue; }
    if (a === '--tier')              { out.issueTier = argv[++i] || ''; continue; }
    if (a.startsWith('--tier='))     { out.issueTier = a.slice('--tier='.length); continue; }
    if (a === '--email')             { out.issueEmail = argv[++i] || ''; continue; }
    if (a.startsWith('--email='))    { out.issueEmail = a.slice('--email='.length); continue; }
    if (a === '--days')              { out.issueDays = argv[++i] || ''; continue; }
    if (a.startsWith('--days='))     { out.issueDays = a.slice('--days='.length); continue; }
    if (a === '--revoke-license')    { out.revokeLicense = true; continue; }
    if (a === '--key')               { out.revokeKey = argv[++i] || ''; continue; }
    if (a.startsWith('--key='))      { out.revokeKey = a.slice('--key='.length); continue; }
    if (a === '--reason')            { out.revokeReason = argv[++i] || ''; continue; }
    if (a.startsWith('--reason='))   { out.revokeReason = a.slice('--reason='.length); continue; }
    if (a === '--clean-cache')      { out.cleanCache = true; continue; }
    if (a === '--reconfigure')      { out.reconfigure = true; continue; }
    // Pro+ escape hatch: bypass the fail-closed redaction abort. Honored only
    // on paid tiers by the loader; Open always fails closed regardless.
    if (a === '--skip-redaction')   { out.skipRedaction = true; continue; }

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
    // --force-clear-markers is a boolean flag consumed later via argv.includes,
    // not through the parsed opts object; recognize it here so it is not
    // reported as an unknown flag before it runs.
    if (a === '--force-clear-markers')   { continue; }
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
Ghost Architect: AI-powered codebase archaeology (v${VERSION}, ${TIER} tier)

Usage:
  ghost [options]

Options:
  --max-context N          Override context cap in tokens. Clamped to your tier limit.
                           Tier caps: open=${TIER_CAPS.open.toLocaleString()}, pro=${TIER_CAPS.pro.toLocaleString()}, team=${TIER_CAPS.team.toLocaleString()}, enterprise=${TIER_CAPS.enterprise.toLocaleString()}
  --exclude "glob"         Exclude files matching glob pattern (repeatable).
                           Example: --exclude "seeds/**" --exclude "*.fixture.js"
  --exclude-presets a,b    Apply named exclusion preset(s), comma-separated.
                           Available presets: ${presets}

Ghost Partner™ - white-label consultant profiles:
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
                                 - exchanged with the activation server for a
                                 token bound to this machine. Requires internet.
                             (b) pre-signed token: verified locally, no network.
                                 Used for offline activation when emailed by EJ.
                           Then exit.
  --license                Show current license status (tier, expiration, days
                           remaining, fingerprint match). Then exit.
  --license-clear          Remove the installed license from local storage.
                           Then exit. Useful for migrating to a new license.
  --deactivate             Alias for --license-clear.
  --export-ci-token        Print the installed signed license token to stdout
                           for CI setup (only the token goes to stdout, so it
                           is pipe-safe):
                             ghost --export-ci-token | gh secret set GHOST_LICENSE_KEY
                           Set it as the GHOST_LICENSE_KEY secret for
                           Ghost Watcher™ runners. Then exit.
  --license-debug          Print the full error (with stack) if license
                           validation hits an unexpected fault. Use this when
                           contacting support@ghostarchitect.dev so we can see
                           exactly what failed.

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

Ghost Brief™ (Max plans: Pro Max, Team Max, Enterprise Max):
  --brief                  Convert scan findings into a validated,
                           blast-radius-aware Claude Code prompt pack.
                           Writes ghost-brief.json to the current directory.
                           Requires an existing scan output file.
  --input=<path>           Input findings JSON file (default: ghost-report.json)
  --output=<path>          Output path for ghost-brief.json
                           (default: ghost-brief.json in current directory)

Transport (streaming vs batch):
  --stream                 Run scans live (streaming) and skip the transport menu.
  --batch                  Submit scans to the half-price Message Batches API and
                           skip the transport menu. Retrieve results later.
                           Supported by Blast Radius and Question only. Other
                           modes run streaming and print a notice.
  ghost batch-status       List batches you submitted and whether each is ready.
  ghost batch-retrieve <id>
                           Pull a finished batch and produce the same report,
                           sidecar, and PDF a streaming run would have.

Session recovery:
  --recover-session <label>
                           Force-recover a scan for <label> from its checkpoint
                           sidecar on the next run, even if a main session file
                           exists. Use when the saved session is stale or bad.
  --sessions-dir <path>    Relocate the resume-checkpoint directory for this run
                           (default: ~/Ghost Architect Reports/sessions). Useful
                           when the default location is read-only or unsuitable.

Misc:
  --reconfigure            Open the Reconfigure menu (API key, GitHub token,
                           license, scan model) without entering the main
                           interactive menu. Then exit.
  --clean-cache            Delete the profile extraction cache and exit.
  --skip-redaction         Pro+ only. If secret redaction fails on a file, continue
                           the scan instead of aborting. WARNING: secrets in the
                           affected files may be sent to the API unredacted. Open
                           tier always fails closed and ignores this flag.
  --version, -v            Print version and exit.
  --help, -h               Print this help and exit.

When flags are omitted, Ghost runs interactively and uses your configured defaults.
`);
}

// ── Banner ──────────────────────────────────────────────────────────────────

function printBanner(opts = {}) {
  // opts.skipClear leaves the screen intact — used on the post-setup call so the
  // "License active" / "Ghost Open" confirmation the user just saw is not wiped.
  if (!opts.skipClear) console.clear();
  const title = figlet.textSync('GHOST', { font: 'Doom', horizontalLayout: 'default' });
  const ghostGradient = gradient(['#00ffff', '#0088ff', '#004488']);
  console.log(ghostGradient(title));

  console.log(
    chalk.gray('  ') +
    chalk.cyan.bold('ARCHITECT') +
    chalk.gray('  -  AI-powered codebase archaeology') +
    chalk.gray(`  v${VERSION}  [${(TIER || 'open').split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ')}]\n`)
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
    { name: (IS_WINDOWS ? '[PRT] Prompt Triage' : '🧪  Prompt Triage') + chalk.gray('         - audit a folder of LLM prompts for defects'), value: 'prompt-triage' },

    new inquirer.Separator(otherGroupLabel),
    { name: (IS_WINDOWS ? '[DSH] Project Dashboard  ' : '📊  Project Dashboard  ') + (IS_WINDOWS ? '' : chalk.gray('- Remediation progress across all projects')), value: 'dashboard' },
    { name: (IS_WINDOWS ? '[CMP] Compare Reports  ' : '🔍  Compare Reports  ') + (IS_WINDOWS ? '' : chalk.gray('- Before/after diff of two saved reports')), value: 'compare' },
    {
      // Windows gets the same tier-aware suffix as everywhere else: the old
      // literal always showed the manage copy, so Windows Open users had no
      // pre-click signal the row is Pro-gated (Audit 8, quick win 10).
      name: (IS_WINDOWS ? '[PRF] Ghost Partner Profile  ' : '👤  Ghost Partner Profile  ') +
        (profilesAllowed
          ? chalk.gray('- create or manage white-label consultant profiles')
          : chalk.gray(IS_WINDOWS ? '- Pro or higher - ghostarchitect.dev/pricing' : '- Pro or higher · ghostarchitect.dev/pricing')),
      value: 'profiles-topLevel',
    },
  ];

  // Always offer Reconfigure. Even when the API key comes from the environment,
  // this menu still manages the GitHub reports token and license key, which an
  // env-key user needs. The API-key row itself is disabled inside the submenu
  // when usingEnvKey() is true.
  choices.push({ name: IS_WINDOWS ? '[CFG] Reconfigure Ghost Architect™' : '⚙   Reconfigure Ghost Architect™', value: 'reconfigure' });
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
  const BRIEF_TIERS = MAX_TIERS;
  const WATCH_TIERS = WATCH_TIERS_ALLOWED;

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
    { name: (IS_WINDOWS ? '[ASK] Ask a Question  ' : '❓  Ask a Question  ') + chalk.gray('- Single Q&A, save the answer if you like'), value: 'question' },
  ];
  if (tier !== 'open') {
    choices.push({ name: (IS_WINDOWS ? '[CHT] Chat  ' : '💬  Chat  ') + chalk.gray('- Ongoing conversation about this project'), value: 'chat' });
  }
  choices.push(
    { name: (IS_WINDOWS ? '[POI] Points of Interest Scan  ' : '🗺   Points of Interest Scan  ') + chalk.gray('- Auto-map red flags, landmarks, dead zones, fault lines'), value: 'poi' },
    { name: (IS_WINDOWS ? '[BLT] Blast Radius Analysis  ' : '💥  Blast Radius Analysis  ') + chalk.gray('- Impact map + rollback plan'), value: 'blast' },
    { name: (IS_WINDOWS ? '[CNF] Conflict Detection  ' : '⚡  Conflict Detection  ') + chalk.gray('- Find contract mismatches, schema conflicts, config errors'), value: 'conflict' },
    { name: (IS_WINDOWS ? '[FXF] Fix Forecast        ' : '🩹  Fix Forecast        ') + chalk.gray('- Forecast fix impact from a saved conflict scan'), value: 'fix-forecast' },
    { name: (IS_WINDOWS ? '[FCT] Commit Forecast  ' : '🔮  Commit Forecast  ') + chalk.gray('- Forecast blast + conflict impact before you push'), value: 'commit-forecast' },
    // Both Brief items stay SELECTABLE below their tier, deliberately. inquirer's
    // `disabled` made the row unpickable, so the dispatch-level requireTier() gate
    // never ran and the upgrade paywall never rendered. A locked row the user
    // cannot even click is a dead end at the exact moment they are interested in
    // the paid feature. Selecting it now falls through to renderPaywall().
    // The suffix keeps the tier requirement visible before they click.
    {
      name: (IS_WINDOWS
        ? '[GBR] Ghost Brief™     - Generate AI remediation prompt pack'
        : '📋  Ghost Brief™     ' + chalk.gray('- Generate AI remediation prompt pack'))
        + (!BRIEF_TIERS.includes(tier) ? chalk.gray('  (Max plan)') : ''),
      value: 'ghost-brief',
    },
    {
      name: (IS_WINDOWS
        ? '[EXB] Executive Brief  - One-page business intelligence report'
        : '📊  Executive Brief  ' + chalk.gray('- One-page business intelligence report'))
        + (!BRIEF_TIERS.includes(tier) ? chalk.gray('  (Max plan)') : ''),
      value: 'executive-brief',
    },
    new inquirer.Separator(IS_WINDOWS ? '── Ghost Watcher ──' : '─── Ghost Watcher™ ─────────────────────────────────'),
    {
      name: (IS_WINDOWS
        ? '[WEN] Enable Watch     - monitor commits on this repo'
        : '🔭  Enable Watch     ' + chalk.gray('- monitor commits on this repo'))
        + (!WATCH_TIERS.includes(tier) ? chalk.gray('  (Team plan)') : ''),
      value: 'watch-enable',
    },
    {
      name: (IS_WINDOWS
        ? '[WST] Watch Status     - view active Watch configuration'
        : '📋  Watch Status     ' + chalk.gray('- view active Watch configuration'))
        + (!WATCH_TIERS.includes(tier) ? chalk.gray('  (Team plan)') : ''),
      value: 'watch-status',
    },
    {
      name: (IS_WINDOWS
        ? '[WCF] Configure Watch  - change branches, modes, notifications'
        : '⚙   Configure Watch  ' + chalk.gray('- change branches, modes, notifications'))
        + (!WATCH_TIERS.includes(tier) ? chalk.gray('  (Team plan)') : ''),
      value: 'watch-configure',
    },
    {
      name: (IS_WINDOWS
        ? '[WDS] Disable Watch    - remove Watch from this repo'
        : '🚫  Disable Watch    ' + chalk.gray('- remove Watch from this repo'))
        + (!WATCH_TIERS.includes(tier) ? chalk.gray('  (Team plan)') : ''),
      value: 'watch-disable',
    },
    {
      name: (IS_WINDOWS
        ? '[WTM] Manage Team      - add, reassign, or deactivate members'
        : '👥  Manage Team      ' + chalk.gray('- add, reassign, or deactivate members'))
        + (!WATCH_TIERS.includes(tier) ? chalk.gray('  (Team plan)') : ''),
      value: 'watch-team',
    },
    new inquirer.Separator(IS_WINDOWS ? '── Other ──' : '─── Other ───────────────────────────────────────'),
    {
      name: (IS_WINDOWS
        ? '[PRF] Ghost Partner Profile  - create or manage white-label consultant profiles'
        : '👤  Ghost Partner Profile  ' + chalk.gray('- create or manage white-label consultant profiles'))
        + (tier === 'open' ? chalk.gray('  (Pro or higher)') : ''),
      value: 'profiles',
    },
    { name: (IS_WINDOWS ? '[REC] Recon  ' : '🔍  Recon  ') + chalk.gray('- Sizing & engagement plan, no analysis'), value: 'recon' },
    { name: (IS_WINDOWS ? '[AUD] Inheritance Audit  ' : '📋  Inheritance Audit  ') + chalk.gray('- Deal-grade audit for buyers, PE diligence, fractional CTOs'), value: 'audit' },
    { name: (IS_WINDOWS ? '[CMP] Compare Reports  ' : '🔍  Compare Reports  ') + (IS_WINDOWS ? '' : chalk.gray('- Before/after diff of two saved reports')), value: 'compare' },
    { name: (IS_WINDOWS ? '[DSH] Project Dashboard  ' : '📊  Project Dashboard  ') + (IS_WINDOWS ? '' : chalk.gray('- Remediation progress across all projects')), value: 'dashboard' },
    new inquirer.Separator(),
    // "New Scan" is the explicit back-out here — returns to selectInputMethod
    // with codebase context cleared. Labeled by intent ("scan a different
    // directory") rather than the abstract "Back" because the user has a
    // loaded codebase context and the natural next-thing-up is to load a
    // different one, not to abandon work entirely.
    { name: IS_WINDOWS ? '[RLD] New Scan  - scan a different directory' : '🔄  New Scan  - scan a different directory', value: 'reload' },
    // Universal escape: "Exit Ghost" with confirm-exit, consistent with
    // top-level menu. Caller checks isBack(mode) and runs confirmExit().
    backChoice(IS_WINDOWS ? '[EXIT] Exit Ghost' : '🚪  Exit Ghost'),
  );

  // Inject pending-batch rows ABOVE the main mode list. Each batch submitted via
  // the transport menu but not yet retrieved gets a row (selectable "READY" once
  // ended, grayed "checking..." while in progress). No pending batches → no
  // injection → the menu renders exactly as before.
  const pendingChoices = await buildPendingBatchChoices();
  if (pendingChoices.length > 0) {
    choices.unshift(...pendingChoices, new inquirer.Separator());
  }

  const { mode } = await inquirer.prompt([{
    type: 'list',
    name: 'mode',
    message: chalk.cyan(`\nReady to analyze ${codebaseContext.loadedFiles} files. What would you like Ghost to do?`),
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

    // IS_WINDOWS-gated like every other menu (Audit 8, quick win 10): the raw
    // emoji/Unicode literals rendered as mojibake in classic Windows consoles.
    const choices = [
      { name: IS_WINDOWS ? '[+] Create new profile' : '➕  Create new profile', value: 'create' },
    ];
    if (profiles.length) {
      choices.push({ name: IS_WINDOWS ? '[E] Edit existing profile' : '✎  Edit existing profile', value: 'edit' });
      choices.push({ name: IS_WINDOWS ? '[*] Set default profile' : '★  Set default profile', value: 'set-default' });
      if (defaultSlug) {
        choices.push({ name: IS_WINDOWS ? '[ ] Clear default profile' : '☆  Clear default profile', value: 'clear-default' });
      }
      choices.push({ name: IS_WINDOWS ? '[O] Open profile in editor' : '📄  Open profile in editor', value: 'open' });
      choices.push({ name: IS_WINDOWS ? '[D] Delete profile' : '🗑   Delete profile', value: 'delete' });
    }
    choices.push(new inquirer.Separator());
    choices.push({ name: IS_WINDOWS ? '[<] Back to main menu' : '←  Back to main menu', value: 'back' });

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

  // Resolve the requested editor from the environment, but never trust it
  // verbatim: env vars can be set by any process that runs before Ghost, so a
  // poisoned VISUAL/EDITOR would otherwise become arbitrary code execution.
  // Strip any path components and validate against a whitelist of known editors.
  const ALLOWED_EDITORS = new Set([
    'vi', 'vim', 'nano', 'emacs', 'notepad', 'notepad++',
    'code', 'subl', 'atom', 'gedit', 'kate',
  ]);
  const requested = process.env.VISUAL || process.env.EDITOR || (IS_WINDOWS ? 'notepad' : 'vi');
  const editor = path.basename(requested.trim());
  const editorName = editor.toLowerCase();

  // Validate the FULL basename against the whitelist first. Only after that
  // fails do we strip a trailing .exe (Windows compatibility) and re-check.
  // Stripping before the whitelist check let names like "notepad++.exe.bat"
  // slip through: the .exe$ strip is a no-op there, but the principle is the
  // same, so we never let suffix handling widen what counts as a match.
  let normalized = editorName;
  let allowed = ALLOWED_EDITORS.has(normalized);
  if (!allowed && normalized.endsWith('.exe')) {
    normalized = normalized.replace(/\.exe$/, '');
    allowed = ALLOWED_EDITORS.has(normalized);
  }
  // Second validation pass: the name we settled on must still be whitelisted.
  if (!allowed || !ALLOWED_EDITORS.has(normalized)) {
    console.error(chalk.red(`\nRefusing to launch unrecognized editor: ${requested}`));
    console.error(chalk.gray(`Set VISUAL or EDITOR to one of: ${[...ALLOWED_EDITORS].join(', ')}`));
    console.error(chalk.gray(`Or open the file manually: ${target.path}\n`));
    return;
  }

  // Confirm the resolved profile path really lives inside the profiles
  // directory before handing it to spawn, so a tampered profile entry cannot
  // point the editor at an arbitrary file outside the profiles dir.
  const profilesDir = path.resolve(getProfilesDir());
  const resolvedTarget = path.resolve(target.path);
  if (resolvedTarget !== profilesDir && !resolvedTarget.startsWith(profilesDir + path.sep)) {
    console.log(chalk.red(`\nProfile path is outside the profiles directory; refusing to open: ${target.path}\n`));
    return;
  }

  console.log(chalk.gray(`\nOpening ${resolvedTarget} in ${editor}...\n`));
  await new Promise((resolve) => {
    const proc = spawn(editor, [resolvedTarget], { stdio: 'inherit', shell: false });
    proc.on('exit', resolve);
    proc.on('error', (err) => {
      console.log(chalk.red(`\nCould not launch editor: ${err.message}`));
      console.log(chalk.gray(`Open the file manually: ${resolvedTarget}\n`));
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
    console.log(chalk.gray('   (Was the default profile: default cleared.)'));
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
 * emits an enum-like { kind: 'audit' | 'quota' | 'upgrade' | 'unknown' } and this
 * helper routes to renderAuditPaywall(), renderQuotaPaywall(), or
 * renderUpgradePaywall() (tier-blocked modes). This preserves the
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
  if (paywall.kind === 'audit')   { renderAuditPaywall(paywallPromo); return; }
  if (paywall.kind === 'quota')   { renderQuotaPaywall(paywallPromo); return; }
  if (paywall.kind === 'upgrade') { renderUpgradePaywall(paywall, paywallPromo); return; }
  console.log(chalk.gray(`  (No paywall renderer for gate: ${paywall.gateId})\n`));
}

// ── Main loop ────────────────────────────────────────────────────────────────

// ── License helpers ────────────────────────────────────────────────────────

/**
 * Report an UNEXPECTED license-validation fault to the user.
 *
 * Important distinction this enforces: `validateLicense()` returns a structured
 * { state: 'missing' } result when no license is installed — that is the
 * EXPECTED path (fall through to Open tier) and never reaches here. This helper
 * fires only when validation itself THREW — a transient filesystem/network/
 * decode fault — which previously failed silently and stripped a paying
 * customer down to Open tier with no explanation.
 *
 * The message goes to stderr so it never corrupts stdout output for display
 * surfaces (--help, --version) or scriptable flows. With --license-debug we
 * also print the full stack so support can diagnose the fault.
 *
 * @param {Error}  err          The thrown error.
 * @param {object} opts
 * @param {boolean} opts.debug  Whether --license-debug was passed.
 * @param {boolean} opts.degraded  True when we are continuing at Open tier
 *                                  rather than blocking (early-resolve path).
 */
function reportLicenseValidationError(err, { debug = false, degraded = false } = {}) {
  console.error(chalk.red(`\n${SYM.cross} License validation hit an unexpected error: ${err.message}`));
  if (degraded) {
    console.error(chalk.yellow('   Continuing at Open tier. If you have a paid license, this is likely a'));
    console.error(chalk.yellow('   transient filesystem or network issue: re-run the command.'));
  }
  if (debug) {
    console.error(chalk.gray('\n   --license-debug detail:'));
    console.error(chalk.gray('   ' + (err.stack || String(err)).split('\n').join('\n   ')));
  } else {
    console.error(chalk.gray('   Re-run with --license-debug for full detail, or email support@ghostarchitect.dev.'));
  }
  console.error('');
}

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
// Build the one "validity" line for a license panel from its payload, branching
// on the same date thresholds the validator uses (src/license/validator.js).
// This keeps a freshly-activated healthy license from showing alarming
// "Grace: through <date>" text: grace/expiry wording only appears once the
// license is actually in that state.
//   - trial              → "Trial expires: <expires>"
//   - active (healthy)   → "Active through: <expires>"
//   - in the grace window→ "Grace period active: through <grace_until>"
//   - past grace / hard stop → "License expired: <expires>"
function licenseValidityLine(payload) {
  const date = (iso) => chalk.cyan((iso || '').slice(0, 10));
  if (payload.tier === 'trial') {
    return chalk.white('Trial expires: ') + date(payload.expires);
  }
  const now        = Date.now();
  const expiresMs  = Date.parse(payload.expires);
  const graceMs    = Date.parse(payload.grace_until);
  // Past the end of grace (grace-ending or hard-stopped): subscription expired.
  if (Number.isFinite(graceMs) && now >= graceMs) {
    return chalk.white('License expired: ') + date(payload.expires);
  }
  // In the grace window: lapsed but grace not yet exhausted.
  if (Number.isFinite(expiresMs) && now >= expiresMs) {
    return chalk.white('Grace period active: ') + chalk.cyan('through ' + (payload.grace_until || '').slice(0, 10));
  }
  // Healthy active license — the fresh-activation case.
  return chalk.white('Active through: ') + date(payload.expires);
}

// Activation runs from two places with opposite failure contracts:
//
//   `ghost --activate <key>`  — a one-shot CLI invocation. A bad key should
//                               print and exit non-zero. Scripts depend on it.
//
//   Reconfigure > License     — a menu sub-flow. A bad key (a typo, a stray
//                               paste) must return the user to the menu so they
//                               can try again. It used to call process.exit(2)
//                               and hard-kill the whole app mid-menu.
//
// failActivation() reconciles the two: it throws inside the interactive flow and
// exits everywhere else. The message is always printed by the caller first.
class ActivationAborted extends Error {}
let activationInteractive = false;

function failActivation() {
  if (activationInteractive) throw new ActivationAborted();
  process.exit(2);
}

async function runActivateFlow(input) {
  if (!input || !input.trim()) {
    console.error(chalk.red(`\n${SYM.cross} --activate requires a license key or token. Paste the value from your license email.\n`));
    failActivation();
  }
  const cleaned = input.trim();

  // Real root login (no SUDO_USER) can't be redirected to a user's home, so
  // the license would land under /root and a non-root relaunch won't see it.
  // Warn (don't block — the operator may genuinely intend a root install).
  // sudo runs are auto-redirected in config.js and never reach this branch.
  if (isLinuxRootWithoutSudoUser()) {
    console.warn(chalk.yellow('\n⚠  Activating as root: the license will be stored under /root/.config and'));
    console.warn(chalk.yellow('   your normal user account will not see it on relaunch.'));
    console.warn(chalk.gray('   Re-run as your regular user (without sudo):  ghost --activate <key>\n'));
  }

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
    failActivation();
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
    failActivation();
  }

  if (!respBody.signedToken || typeof respBody.signedToken !== 'string') {
    console.error(chalk.red(`\n${SYM.cross} Activation server returned an unexpected response (no signedToken).`));
    console.error(chalk.gray('   This is a bug: email support@ghostarchitect.dev with the time of this attempt.\n'));
    failActivation();
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
    failActivation();
  }
  const payload = decoded.payload;

  // Cross-check the server-signed tier against the tier encoded in the key
  // format. parsed.tier comes from the key's 3-char tier code (CODE_TO_TIER in
  // src/license/format.js); payload.tier comes from the server-signed token.
  // They should always agree; a disagreement points at a mis-issued key or a
  // server returning the wrong tier. We do NOT hard-block: the server-signed
  // payload is authoritative and is what gets saved. We only warn so the
  // customer (and support) can catch a mis-provisioned license.
  if (parsed?.tier && payload.tier && payload.tier !== parsed.tier) {
    console.log(chalk.yellow(
      `Warning: license tier mismatch detected. Key format indicates ${parsed.tier} ` +
      `but server returned ${payload.tier}. Contact support@ghostarchitect.dev`
    ));
  }

  // Confirm the token is bound to THIS machine. The server should have set
  // payload.fingerprint = fpHashes (the hashes we sent), but verify anyway.
  if (payload.fingerprint) {
    const { matchesFingerprint } = await import('../src/license/fingerprint.js');
    const m = matchesFingerprint(fpHashes, payload.fingerprint);
    if (!m.match) {
      console.error(chalk.red(`\n${SYM.cross} Server returned a token bound to a different machine.`));
      console.error(chalk.gray(`   This is a bug. Got ${m.matchCount} of 4 hardware components matching.\n`));
      failActivation();
    }
  }

  saveActivation({ token: respBody.signedToken, fingerprintHashes: fpHashes });
  reconcileSudoOwnership();

  const reactivated = !!respBody.reactivated;
  console.log('\n' + boxen(
    chalk.green.bold(`${SYM.check} License ${reactivated ? 're-activated' : 'activated'}`) + '\n\n' +
    chalk.white('Customer: ') + chalk.cyan(payload.customer) + '\n' +
    chalk.white('Tier:     ') + chalk.cyan(payload.tier) + '\n' +
    licenseValidityLine(payload),
    { padding: 1, borderColor: 'green', borderStyle: 'round' }
  ));
  if (reactivated) {
    console.log(chalk.gray('  (License was already activated on this machine: token refreshed.)'));
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
    failActivation();
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
      failActivation();
    }
  }

  saveActivation({ token: tokenString, fingerprintHashes: fpHashes });
  reconcileSudoOwnership();

  // A signed token activates on signature and fingerprint alone, so an
  // expired or revoked one saves "successfully". Printing the green box for
  // a token that then validates as blocked showed the customer a success
  // screen while every subsequent scan paywalled them as Open with no
  // explanation (Audit 8, finding 1.3). Validate before celebrating; the
  // token stays saved either way so a renewal can pick it up.
  const postSave = await validateLicense({ skipNetworkClock: true });
  if (isBlocking(postSave.state)) {
    console.log('\n' + boxen(
      chalk.yellow.bold(`${SYM.warn} License saved, but it is not currently usable`) + '\n\n' +
      chalk.white('Customer: ') + chalk.cyan(payload.customer) + '\n' +
      chalk.white('Tier:     ') + chalk.cyan(payload.tier) + '\n' +
      chalk.white('State:    ') + chalk.yellow(postSave.state) + '\n\n' +
      (postSave.message
        ? chalk.white(postSave.message)
        : chalk.white('Your license activated but appears to be expired.\nRenew at ') +
          chalk.cyan('ghostarchitect.dev/pricing') + chalk.white(' or run ') +
          chalk.cyan('ghost --activate') + chalk.white(' with a valid key.')),
      { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
    ));
    console.log('');
    return;
  }

  console.log('\n' + boxen(
    chalk.green.bold(`${SYM.check} License activated`) + '\n\n' +
    chalk.white('Customer: ') + chalk.cyan(payload.customer) + '\n' +
    chalk.white('Tier:     ') + chalk.cyan(payload.tier) + '\n' +
    licenseValidityLine(payload),
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
      chalk.cyan('  ghost --activate <your GA- license key>') + '\n\n' +
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
    result.state === 'revoked'    ? chalk.red :
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
 * Handle `ghost --export-ci-token` — print the installed signed license token
 * to stdout for CI secret setup (GHOST_LICENSE_KEY in Ghost Watcher™ runners).
 *
 * The token, and ONLY the token, goes to stdout so the command is pipe-safe:
 *   ghost --export-ci-token | gh secret set GHOST_LICENSE_KEY
 * All guidance goes to stderr. Reads the installed record directly (never the
 * GHOST_LICENSE_KEY env var) so exporting from a machine that itself has the
 * env var set still exports the locally activated license.
 *
 * Why this exists: the signed token lives only in configstore after
 * activation, and CI runners cannot exchange a GA- human key themselves
 * (the worker's re-activation path is fingerprint-bound to the activating
 * machine, by design). This flag is the supported bridge.
 */
async function runExportCiTokenFlow() {
  const record = getLicenseRecord();
  if (!record || !record.token) {
    console.error('No license installed on this machine.');
    console.error('Activate first with: ghost --activate <your GA- license key>');
    console.error('Then re-run: ghost --export-ci-token');
    process.exit(1);
  }

  // Validate the STORED token before exporting. A revoked or hard-stopped
  // token exported cleanly here configured a CI runner that printed "license
  // is not valid" on every run and never scanned, with no hint at export time
  // that the token was already dead (Audit 8, finding 2.9).
  //
  // validateLicense() is deliberately NOT used here: it resolves its token via
  // getToken(), which prefers the GHOST_LICENSE_KEY env var, so on a machine
  // with the env var set it validated a DIFFERENT token than the one this flow
  // exports (Audit 9, finding 1.2). Decode and check the record token itself.
  // All output stays on stderr so stdout carries either the token or nothing.
  let payload;
  try {
    ({ payload } = decodeAndVerifyToken(record.token));
  } catch (err) {
    console.error(`The stored license token failed verification (${err.message}) and cannot run CI scans.`);
    console.error('Nothing was exported. Re-activate with ghost --activate <your GA- license key>, then re-run: ghost --export-ci-token');
    process.exit(1);
  }
  const exportNowMs   = Date.now();
  const exportExpires = Date.parse(payload.expires);
  const exportHardMs  = Date.parse(payload.hard_stop);
  if (exportNowMs >= exportHardMs) {
    console.error(`This license expired on ${payload.expires.slice(0, 10)} and cannot run CI scans.`);
    console.error('Nothing was exported. Renew or re-activate, then re-run: ghost --export-ci-token');
    process.exit(1);
  }
  if (payload.lid && payload.tier !== 'trial') {
    // Fail-open by contract (network faults return 'unknown'), same as every
    // other revocation consult. A cached or fresh revoked verdict blocks.
    const verdict = await checkRevocation(payload.lid);
    if (verdict === 'revoked') {
      console.error('This license has been revoked, usually because the subscription was cancelled, and cannot run CI scans.');
      console.error('Nothing was exported. Resubscribe at ghostarchitect.dev/pricing, re-activate, then re-run: ghost --export-ci-token');
      process.exit(1);
    }
  }
  if (exportNowMs >= exportExpires) {
    console.error(`Note: this license is past its expiry date (${payload.expires.slice(0, 10)}) and inside its grace window. ` +
      'CI runs will stop scanning once it fully expires. Renew soon.');
  } else if (exportExpires - exportNowMs <= 3 * 24 * 60 * 60 * 1000) {
    console.error(`Note: this license expires on ${payload.expires.slice(0, 10)}. ` +
      'CI runs will stop scanning once it fully expires. Renew soon.');
  }

  console.error('Signed Ghost Architect™ license token (set this as the GHOST_LICENSE_KEY secret in CI):');
  console.error('');
  process.stdout.write(record.token + '\n');
  console.error('');
  console.error('Treat this value as a secret. It carries your license entitlement.');
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
 * Admin: store the license-worker admin bearer token locally. Prompts with
 * masked input so the token is never echoed, and persists it to the configstore
 * via saveAdminToken. Used by `ghost --configure-admin-token`.
 */
async function runConfigureAdminTokenFlow() {
  console.log('\n' + boxen(
    chalk.cyan.bold('Configure Admin Token') + '\n\n' +
    chalk.gray('Paste your Ghost license-worker admin token. It is stored locally in\n') +
    chalk.gray('your Ghost config and used to issue licenses from this machine.'),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  // Yield to the event loop so the header box is flushed to the TTY before
  // inquirer v9 takes over and computes its render baseline. Without this, the
  // prompt can render ABOVE the box (user sees the masked prompt first, then
  // the box appears after they submit).
  await new Promise(resolve => setImmediate(resolve));
  const { token } = await inquirer.prompt([{
    type: 'password',
    name: 'token',
    mask: '•',
    message: chalk.cyan('Admin token:'),
    theme: inquirerTheme,
    validate: (v) => (v && v.trim().length > 0) ? true : 'Token cannot be empty.',
  }]);
  const trimmed = token.trim();
  saveAdminToken(trimmed);
  console.log('\n' + boxen(
    chalk.green.bold(`${SYM.check} Admin token saved`) + '\n\n' +
    chalk.white('Length: ') + chalk.cyan(`${trimmed.length} chars`) + '\n' +
    chalk.gray('Stored locally. Run `ghost --issue-license` to mint license keys.'),
    { padding: 1, borderColor: 'green', borderStyle: 'round' }
  ));
  console.log('');
}

// Tiers the admin endpoint accepts for issuance (mirrors the worker's
// PAYLOAD_VALID_TIERS; 'trial' is not issuable).
const ISSUABLE_TIERS = ['pro', 'pro-max', 'team', 'team-max', 'enterprise', 'enterprise-max'];

// Small red-box error + hard exit, for invalid admin-command flag values.
function adminFlagError(title, detail) {
  console.error('\n' + boxen(
    chalk.red.bold(`${SYM.cross} ${title}`) + '\n\n' + chalk.gray(detail),
    { padding: 1, borderColor: 'red', borderStyle: 'round' }
  ));
  console.log('');
  process.exit(1);
}

/**
 * Admin: issue a license via the license-worker /admin/issue endpoint. Reads
 * the stored admin token (hard-fails if none). tier/email/days may be supplied
 * as flags (--tier/--email/--days) for headless use; any of tier/email not
 * given as a flag is prompted for. days defaults to 365 and is never prompted.
 * Flag-supplied values are validated and hard-fail on error. POSTs and displays
 * the returned humanKey. Used by `ghost --issue-license`.
 */
async function runIssueLicenseFlow({ tier = null, email = null, days = null } = {}) {
  const token = getAdminToken();
  if (!token) {
    console.error('\n' + boxen(
      chalk.red.bold(`${SYM.cross} No admin token configured`) + '\n\n' +
      chalk.gray('Run ') + chalk.cyan('ghost --configure-admin-token') + chalk.gray(' first.'),
      { padding: 1, borderColor: 'red', borderStyle: 'round' }
    ));
    console.log('');
    process.exit(1);
  }

  // ── Resolve tier: flag (validated) or prompt ──
  if (tier != null) {
    tier = String(tier).trim().toLowerCase();
    if (!ISSUABLE_TIERS.includes(tier)) {
      adminFlagError(`Invalid --tier: ${tier}`, `Must be one of: ${ISSUABLE_TIERS.join(', ')}`);
    }
  }

  // ── Resolve email: flag (validated) or prompt ──
  if (email != null) {
    email = String(email).trim();
    if (!email.includes('@')) {
      adminFlagError(`Invalid --email: ${email}`, 'Email must contain @.');
    }
  }

  // ── Resolve days: flag (validated) or default 365, never prompted ──
  let resolvedDays = 365;
  if (days != null) {
    const n = Number(days);
    if (!Number.isInteger(n) || n <= 0) {
      adminFlagError(`Invalid --days: ${days}`, 'Days must be a positive whole number.');
    }
    resolvedDays = n;
  }

  // ── Prompt only for whatever tier/email wasn't supplied as a flag ──
  const prompts = [];
  if (tier == null) {
    prompts.push({
      type: 'list', name: 'tier', message: chalk.cyan('License tier:'),
      theme: inquirerTheme, choices: ISSUABLE_TIERS,
    });
  }
  if (email == null) {
    prompts.push({
      type: 'input', name: 'email', message: chalk.cyan('Customer email:'),
      theme: inquirerTheme,
      validate: (v) => (v && v.includes('@')) ? true : 'Enter a valid email address.',
    });
  }
  if (prompts.length > 0) {
    const answers = await inquirer.prompt(prompts);
    if (tier == null)  tier  = answers.tier;
    if (email == null) email = answers.email.trim();
  }

  console.log(chalk.gray(`\nIssuing ${tier} license for ${email} (${resolvedDays} days)...`));

  let resp, body;
  try {
    resp = await fetch(ADMIN_ISSUE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        email, tier, days: resolvedDays,
        actor: 'cli-admin', reason: 'cli-admin-issue', sendEmail: false,
      }),
    });
    body = await resp.json().catch(() => ({}));
  } catch (err) {
    console.error(chalk.red(`\n${SYM.cross} Could not reach the license server: ${err.message}\n`));
    process.exit(1);
  }

  if (!resp.ok) {
    const detail = (body && (body.detail || body.error)) || `HTTP ${resp.status}`;
    const hint = (resp.status === 401 || resp.status === 403)
      ? 'Admin token rejected. Re-run `ghost --configure-admin-token` with a current token.'
      : 'Check the inputs and try again.';
    console.error('\n' + boxen(
      chalk.red.bold(`${SYM.cross} License issuance failed`) + '\n\n' +
      chalk.white('Error: ') + chalk.red(detail) + '\n' +
      chalk.gray(hint),
      { padding: 1, borderColor: 'red', borderStyle: 'round' }
    ));
    console.log('');
    process.exit(1);
  }

  console.log('\n' + boxen(
    chalk.green.bold(`${SYM.check} License issued`) + '\n\n' +
    chalk.white('Key:      ') + chalk.cyan.bold(body.humanKey || '(missing)') + '\n' +
    chalk.white('Tier:     ') + chalk.cyan(body.tier || tier) + '\n' +
    chalk.white('Customer: ') + chalk.cyan(body.customer || email) + '\n' +
    chalk.white('Expires:  ') + chalk.cyan((body.expires || '').slice(0, 10) || '(unknown)') + '\n\n' +
    chalk.gray('Send this key to the customer; they activate with ghost --activate <key>.'),
    { padding: 1, borderColor: 'green', borderStyle: 'round' }
  ));
  console.log('');
}

/**
 * Admin: revoke a license via the license-worker /admin/revoke endpoint. Reads
 * the stored admin token (hard-fails if none). The key may be supplied as a flag
 * (--key) for headless use, or prompted for if omitted. --reason defaults to
 * 'admin-revoked' and is never prompted. POSTs and confirms revocation. Used by
 * `ghost --revoke-license`.
 */
async function runRevokeLicenseFlow({ key = null, reason = null } = {}) {
  const token = getAdminToken();
  if (!token) {
    console.error('\n' + boxen(
      chalk.red.bold(`${SYM.cross} No admin token configured`) + '\n\n' +
      chalk.gray('Run ') + chalk.cyan('ghost --configure-admin-token') + chalk.gray(' first.'),
      { padding: 1, borderColor: 'red', borderStyle: 'round' }
    ));
    console.log('');
    process.exit(1);
  }

  // ── Resolve key: flag (validated) or prompt ──
  if (key != null) {
    key = String(key).trim();
    if (!tryParseKey(key).ok) {
      adminFlagError(`Invalid --key: ${key}`, 'Must be a valid GA-YYYY-... license key.');
    }
  } else {
    const ans = await inquirer.prompt([{
      type: 'input', name: 'key', message: chalk.cyan('License key to revoke:'),
      theme: inquirerTheme,
      validate: (v) => tryParseKey((v || '').trim()).ok ? true : 'Enter a valid GA-YYYY-... license key.',
    }]);
    key = ans.key.trim();
  }

  // ── Resolve reason: flag or default 'admin-revoked', never prompted ──
  const revokeReason = (reason != null && String(reason).trim()) ? String(reason).trim() : 'admin-revoked';

  console.log(chalk.gray(`\nRevoking ${key}...`));

  let resp, body;
  try {
    resp = await fetch(ADMIN_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ humanKey: key, reason: revokeReason, actor: 'ejwisner' }),
    });
    body = await resp.json().catch(() => ({}));
  } catch (err) {
    console.error(chalk.red(`\n${SYM.cross} Could not reach the license server: ${err.message}\n`));
    process.exit(1);
  }

  if (!resp.ok) {
    const detail = (body && (body.detail || body.error)) || `HTTP ${resp.status}`;
    const hint = (resp.status === 401 || resp.status === 403)
      ? 'Admin token rejected. Re-run `ghost --configure-admin-token` with a current token.'
      : resp.status === 404 ? 'License key not found. Double-check the key.'
      : 'Check the key and try again.';
    console.error('\n' + boxen(
      chalk.red.bold(`${SYM.cross} Revocation failed`) + '\n\n' +
      chalk.white('Error: ') + chalk.red(detail) + '\n' +
      chalk.gray(hint),
      { padding: 1, borderColor: 'red', borderStyle: 'round' }
    ));
    console.log('');
    process.exit(1);
  }

  console.log('\n' + boxen(
    chalk.green.bold(`${SYM.check} License ${key} revoked.`) +
    (body && body.idempotent ? '\n\n' + chalk.gray('(Was already revoked.)') : ''),
    { padding: 1, borderColor: 'green', borderStyle: 'round' }
  ));
  console.log('');
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
    // Trial CTA leads the actionable block, before the pricing and activate
    // links, so Open users see the zero-friction offer up front instead of
    // discovering it only after hitting a paywall.
    lines.push(chalk.green.bold(`Start a free ${PRICING.TRIAL_DAYS}-day Ghost Pro Max™ trial (no card required):`));
    lines.push(chalk.cyan('  ' + PRICING.TRIAL_URL.replace(/^https?:\/\//, '')) + '\n');
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
    // A lapsed TRIAL must not dead-end the user: Question and Recon are free
    // forever on Open, so a hard_stopped trial degrades to Open (continue) with
    // a conversion prompt rather than process.exit(1). Paid hard_stops still
    // hard-block -- a paying customer whose term ended renews, not silently
    // downgrades. setActiveLicense(null) makes downstream getActiveTier()/trial
    // checks resolve to Open, keeping the whole run consistent.
    if (result.state === 'hard_stop' && result.payload?.tier === 'trial') {
      TIER = 'open';
      setActiveLicense(null);
      SESSION_DEGRADE_REASON = 'trial-ended';
      // Re-seed the loader at the degrade site itself so no caller can forget.
      // The tierBeforeGate re-seed in main() covers the startup path; this
      // covers any other (or future) caller. Last-write-wins, so the double
      // seed on the startup path is harmless.
      setScanOptions({ ...CLI_SCAN_OVERRIDES, tier: 'open' });
      console.log('\n' + boxen(
        chalk.yellow.bold(`Your ${PRICING.TRIAL_DAYS}-day Ghost Pro Max™ trial has ended.`) + '\n\n' +
        chalk.white('You still have access to Ghost Open.') + '\n' +
        chalk.white('Question and Recon are free forever.') + '\n\n' +
        chalk.white('To keep scanning: ') + chalk.cyan('https://ghostarchitect.dev/pricing'),
        { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
      ));
      console.log('');
      return false;  // continue as Open, do not block
    }
    // A REVOKED license degrades to Open rather than hard-blocking, on the same
    // reasoning as the lapsed trial above: the paid entitlements stop (that is
    // the revenue leak we are closing) but Question and Recon stay free forever,
    // so there is no reason to dead-end someone whose card simply expired. They
    // land on the pricing page with a working CLI instead of a brick.
    if (result.state === 'revoked') {
      TIER = 'open';
      setActiveLicense(null);
      SESSION_DEGRADE_REASON = 'revoked';
      // Same degrade-site re-seed as the lapsed-trial block above.
      setScanOptions({ ...CLI_SCAN_OVERRIDES, tier: 'open' });
      console.log('\n' + boxen(
        chalk.yellow.bold('This license has been revoked.') + '\n\n' +
        chalk.white('This usually means the subscription was cancelled.') + '\n' +
        chalk.white('You still have access to Ghost Open.') + '\n\n' +
        chalk.white('Resubscribe: ') + chalk.cyan('https://ghostarchitect.dev/pricing') + '\n' +
        chalk.white('To restore access after resubscribing, run: ') + chalk.cyan('ghost --activate <your new key>') + '\n' +
        chalk.white('Questions:   ') + chalk.cyan('support@ghostarchitect.dev'),
        { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
      ));
      console.log('');
      return false;  // continue as Open, do not block
    }
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
  // Active trial: surface days remaining so the countdown is visible and the
  // user can convert before it lapses. trialDaysRemaining() (session.js) reads
  // the active license; returns null for non-trial tiers or a lapsed trial.
  const trialLeft = trialDaysRemaining();
  if (trialLeft !== null && trialLeft >= 0) {
    console.log(chalk.cyan(`\nTrial: ${trialLeft} day${trialLeft === 1 ? '' : 's'} remaining.\n`));
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

// ── Batch transport commands ──────────────────────────────────────────────────
//
// `ghost batch-status` and `ghost batch-retrieve <id>` complete the
// streaming-vs-batch transport feature: a scan submitted as a batch (via the
// transport menu) is checked and pulled back here. Status/results go through
// the Anthropic SDK directly — the "Premature close" drop that forces the Ghost
// Watcher onto native fetch only happens on constrained CI runners, and these
// commands run interactively on a developer machine.

async function runBatchStatusCommand() {
  let pending = getPendingBatches();
  if (!pending.length) {
    console.log(chalk.gray('\nNo pending batches.\n'));
    return;
  }

  // Same retention prune the menu path applies (Audit 8, quick win 8): an
  // aged-out batch is no longer retrievable server-side, so listing it as
  // "error: Not Found" forever, with a closing line telling the user to
  // check again in a few minutes, was false on both counts.
  const expiredCutoff = Date.now() - BATCH_RETENTION_DAYS * 86400 * 1000;
  const expired = pending.filter(b => {
    const t = Date.parse(b.submittedAt || '');
    return Number.isFinite(t) && t < expiredCutoff;
  });
  for (const b of expired) removePendingBatch(b.id);
  if (expired.length > 0) {
    console.log(chalk.gray(
      `\nRemoved ${expired.length} expired batch${expired.length === 1 ? '' : 'es'} ` +
      `(older than ${BATCH_RETENTION_DAYS} days, no longer retrievable).`
    ));
    pending = getPendingBatches();
    if (!pending.length) {
      console.log(chalk.gray('No pending batches.\n'));
      return;
    }
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.log(chalk.red(`\n${SYM.cross} No Anthropic API key configured: cannot check batch status.\n`));
    return;
  }
  const client = new Anthropic({ apiKey });

  const rows = [];
  let anyReady = false;
  let anyGone = false;
  for (const b of pending) {
    let status = 'unknown';
    let ready = false;
    try {
      const r = await client.messages.batches.retrieve(b.id);
      status = r.processing_status || 'unknown';
      ready = status === 'ended';
      if (ready && b.status !== 'ended') updatePendingBatch(b.id, { status: 'ended' });
    } catch (err) {
      // A 404 means the batch is gone server-side and never coming back:
      // remove it, same as the menu path, instead of keeping a permanent
      // "error: Not Found" row (Audit 8, quick win 8).
      if (err && err.status === 404) {
        removePendingBatch(b.id);
        anyGone = true;
        status = 'gone (removed from your pending list)';
      } else {
        status = 'error: ' + String(err && err.message ? err.message : err).slice(0, 30);
      }
    }
    if (ready) anyReady = true;
    rows.push({
      id:        b.id,
      mode:      b.mode || '-',
      submitted: formatClockTime(b.submittedAt) || b.submittedAt || '-',
      status,
      ready:     ready ? 'yes' : 'no',
    });
  }

  // Simple column-aligned table.
  const headers = { id: 'ID', mode: 'MODE', submitted: 'SUBMITTED', status: 'STATUS', ready: 'READY?' };
  const cols = ['id', 'mode', 'submitted', 'status', 'ready'];
  const width = {};
  for (const c of cols) {
    width[c] = headers[c].length;
    for (const r of rows) width[c] = Math.max(width[c], String(r[c]).length);
  }
  const fmtRow = (r) => cols.map(c => String(r[c]).padEnd(width[c])).join('  ');

  console.log('\n' + chalk.cyan.bold('Pending batches'));
  console.log(chalk.gray('  ' + fmtRow(headers)));
  for (const r of rows) {
    const line = '  ' + fmtRow(r);
    console.log(r.ready === 'yes' ? chalk.green(line) : chalk.white(line));
  }
  console.log('');

  if (anyReady) {
    const readyOne = rows.find(r => r.ready === 'yes');
    console.log(chalk.cyan('One or more batches are ready. Retrieve with:'));
    console.log(chalk.gray('  ghost batch-retrieve ') + chalk.cyan(readyOne.id) + '\n');
  } else if (anyGone && rows.every(r => r.status.startsWith('gone'))) {
    console.log(chalk.gray('Those batches ended without retrievable results and were removed. Re-run the scan to try again.\n'));
  } else {
    console.log(chalk.gray('No batches ready yet: check again in a few minutes.\n'));
  }
}

async function runBatchRetrieveCommand(id) {
  if (!id) {
    console.log(chalk.red(`\n${SYM.cross} Usage: ghost batch-retrieve <batch-id>`));
    console.log(chalk.gray('  Run `ghost batch-status` to list pending batch ids.\n'));
    return;
  }

  const entry = findPendingBatch(id);
  if (!entry) {
    console.log(chalk.red(`\n${SYM.cross} No pending batch found with id: ${id}`));
    console.log(chalk.gray('  Run `ghost batch-status` to list pending batch ids.\n'));
    return;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.log(chalk.red(`\n${SYM.cross} No Anthropic API key configured: cannot retrieve the batch.\n`));
    return;
  }
  const client = new Anthropic({ apiKey });

  // Confirm the batch has finished before pulling results.
  let batch;
  try {
    batch = await client.messages.batches.retrieve(id);
  } catch (err) {
    console.log(chalk.red(`\n${SYM.cross} Could not check batch ${id}: ${err.message}\n`));
    return;
  }
  if (batch.processing_status !== 'ended') {
    console.log(chalk.yellow(`\n  Batch ${id} is not ready yet (status: ${batch.processing_status}).`));
    console.log(chalk.gray('  Check again later with `ghost batch-status`.\n'));
    return;
  }

  // Pull the result text for this batch's request.
  console.log(chalk.gray(`\n  Retrieving results for ${id}...`));
  let text = null;
  let batchUsage = null;
  try {
    const results = await client.messages.batches.results(id);
    for await (const item of results) {
      const matches = !entry.customId || item.custom_id === entry.customId;
      if (matches && item.result && item.result.type === 'succeeded') {
        text = item.result.message?.content?.[0]?.text ?? '';
        // Real batch usage, so the retrieve path can stamp the billed cost
        // into the saved report's meta (Audit 8, finding 2.4).
        batchUsage = item.result.message?.usage || null;
        break;
      }
    }
  } catch (err) {
    console.log(chalk.red(`\n${SYM.cross} Failed to download batch results: ${err.message}\n`));
    return;
  }

  if (text == null) {
    // Terminal state: the batch ENDED and carried no successful result, so
    // retrying can never produce one. Keeping it made it a permanent zombie:
    // it renders as a green READY row forever and re-hits the API on every
    // single menu redraw. Drop it.
    removePendingBatch(id);
    console.log(chalk.red(`\n${SYM.cross} Batch ${id} ended but no successful result was found.`));
    console.log(chalk.gray('  The request errored or expired. Removed from your pending list.'));
    console.log(chalk.gray('  Re-run the scan to try again.\n'));
    return;
  }

  // Dispatch to the mode's retrieve-replay so the output is identical to a
  // streaming run (same report files, sidecar, and PDF — only the transport
  // metadata differs).
  try {
    if (entry.mode === 'blast-radius') {
      const { saved } = await retrieveBlastBatchResult(text, entry, { batchUsage });
      removePendingBatch(id);
      console.log(chalk.green(`\n${SYM.check} Reports saved to ~/Ghost Architect Reports/`));
      console.log(chalk.gray(`  📄 ${saved.txtFile}`));
      console.log(chalk.gray(`  📋 ${saved.mdFile}`));
      if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
      console.log('');
    } else if (entry.mode === 'question') {
      const { saved } = await retrieveQuestionBatchResult(text, entry);
      removePendingBatch(id);
      console.log(chalk.green(`\n${SYM.check} Reports saved to ~/Ghost Architect Reports/`));
      console.log(chalk.gray(`  📄 ${saved.txtFile}`));
      console.log(chalk.gray(`  📋 ${saved.mdFile}`));
      if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
      console.log('');
    } else {
      console.log(chalk.yellow(`\n  Batch retrieve for mode "${entry.mode}" is not wired up in this build yet.`));
      console.log(chalk.gray('  Batch retrieve currently covers Blast Radius and Question.\n'));
    }
  } catch (err) {
    console.log(chalk.red(`\n${SYM.cross} Failed to process batch results: ${err.message}\n`));
  }
}

// Human-readable mode label for a pending-batch menu row.
function friendlyBatchModeLabel(mode) {
  switch (mode) {
    case 'blast-radius': return 'Blast Radius';
    case 'blast':        return 'Blast Radius';
    case 'question':     return 'Question';
    case 'poi':          return 'Points of Interest';
    case 'conflict':     return 'Conflict Detection';
    case 'audit':        return 'Inheritance Audit';
    case 'chat':         return 'Chat';
    case 'commit-forecast': return 'Commit Forecast';
    case 'fix-forecast':    return 'Fix Forecast';
    case 'executive-brief': return 'Executive Brief';
    default:             return mode || 'Scan';
  }
}

// Build the dynamic pending-batch rows injected at the top of the main mode
// menu. For each batch the interactive CLI submitted (tracked in configstore),
// check its status against the Anthropic Batches API and render a row:
//   - ended      → a selectable "READY" entry (value "batch:<id>")
//   - otherwise  → a grayed-out, non-selectable "checking..." entry
// Returns [] when there are no pending batches, so the menu is unchanged and no
// network call is made (spec: zero pending → zero changes).
// The Anthropic Batches API retains a batch for 29 days. Past that the id 404s
// forever, so an entry older than this can never be retrieved and is pure noise.
const BATCH_RETENTION_DAYS = 29;

// Modes with a real batch transport path. POI, Conflict and Audit are multipass
// and have no batch branch, so passing --batch to them is a no-op. Keep this in
// sync with the modes that actually read flags.batch (question.js, blast.js).
const BATCH_CAPABLE_MODES = ['question', 'blast'];

async function buildPendingBatchChoices() {
  let pending = getPendingBatches();
  if (pending.length === 0) return [];

  // Prune expired entries BEFORE spending an API call on them. Without this an
  // aged-out batch renders a perpetual "checking..." row and fires a doomed
  // retrieve on every single menu redraw.
  const expiredCutoff = Date.now() - BATCH_RETENTION_DAYS * 86400 * 1000;
  const expired = pending.filter(b => {
    const t = Date.parse(b.submittedAt || '');
    return Number.isFinite(t) && t < expiredCutoff;
  });
  for (const b of expired) removePendingBatch(b.id);
  if (expired.length > 0) {
    console.log(chalk.gray(
      `  Removed ${expired.length} expired batch${expired.length === 1 ? '' : 'es'} ` +
      `(older than ${BATCH_RETENTION_DAYS} days, no longer retrievable).`
    ));
    pending = getPendingBatches();
    if (pending.length === 0) return [];
  }

  const apiKey = resolveApiKey();
  let client = null;
  if (apiKey) {
    try { client = new Anthropic({ apiKey }); } catch { client = null; }
  }

  // Without an API key no status can ever resolve, so the rows rendered a
  // perpetual "checking..." on every menu draw with no hint that the missing
  // key was the cause (Audit 8, quick win 9). Say so once and render nothing.
  if (!client) {
    console.log(chalk.gray(
      `  ${pending.length} pending batch${pending.length === 1 ? '' : 'es'} cannot be checked: ` +
      'no Anthropic API key configured. Run ghost --reconfigure to add one.'
    ));
    return [];
  }

  console.log(chalk.gray(`  Checking ${pending.length} pending batch${pending.length === 1 ? '' : 'es'}...`));

  // Check all statuses concurrently. A failed/uncheckable status renders the
  // row as still-checking (non-selectable) rather than offering a bad retrieve.
  const checked = await Promise.all(pending.map(async (b) => {
    let status = 'unknown';
    if (client) {
      try {
        const r = await client.messages.batches.retrieve(b.id);
        status = r.processing_status || 'unknown';
      } catch (err) {
        // A 404 means the batch is gone server-side and never coming back.
        // Drop it now rather than rendering a row that re-fetches a doomed id
        // every time the menu is drawn. Any other error (network, 429, 5xx) is
        // transient: keep the entry and show it as still-checking.
        if (err && err.status === 404) {
          removePendingBatch(b.id);
          return { entry: b, status: 'gone' };
        }
        status = 'unknown';
      }
    }
    return { entry: b, status };
  }));

  const rows = [];
  for (const { entry, status } of checked) {
    const modeLabel = friendlyBatchModeLabel(entry.mode);
    const time = formatClockTime(entry.submittedAt) || entry.submittedAt || 'unknown';
    if (status === 'gone') continue;   // already pruned above, render nothing
    // IS_WINDOWS-gated icon, same convention as the rest of the menu
    // (Audit 8, quick win 10).
    const batchIcon = IS_WINDOWS ? '[BAT]' : '📬';
    if (status === 'ended') {
      rows.push({
        name: `${batchIcon} ${modeLabel} batch (submitted ${time}) - ` + chalk.green.bold('READY'),
        value: `batch:${entry.id}`,
      });
    } else {
      rows.push({
        name: chalk.gray(`${batchIcon} ${modeLabel} batch (submitted ${time})`),
        disabled: 'checking...',
      });
    }
  }
  return rows;
}

// ── Selective Reconfigure ──────────────────────────────────────────────────
// Replaces the old "replay the entire first-run wizard" behavior. Each item is
// updated independently and every level offers Back. (An earlier version of this
// comment promised Ctrl+C recovery in a sub-option; it never worked. inquirer
// 9.3.8 re-raises SIGINT, so Ctrl+C terminates Ghost from anywhere.)
// returns to this menu (never the main menu, never an exit). No em dashes in
// any user-facing string here (colons/hyphens only).

// Verify a GitHub reports token against the GitHub API. Pass an explicit token
// to test a candidate before saving; omit to test the currently-stored one.
async function testGithubToken(explicitToken) {
  try {
    const token = explicitToken !== undefined ? explicitToken : await getPublishToken();
    if (!token) return false;
    const octokit = createOctokit({ auth: token });
    await octokit.rest.users.getAuthenticated();
    return true;
  } catch (_) {
    return false;
  }
}

// Anthropic API key sub-flow. A blank Enter or 'back' cancels WITHOUT touching
// the stored key (the old wizard cleared it on blank Enter).
async function reconfigureApiKey() {
  try {
    const { key } = await inquirer.prompt([{
      type: 'password', name: 'key',
      message: chalk.cyan("Enter new Anthropic API key (press Enter to keep current, type 'back' to cancel):"),
    }]);
    const val = (key || '').trim();
    if (!val || val.toLowerCase() === 'back') {
      console.log(chalk.gray('  No changes saved.'));
      return;
    }
    if (!val.startsWith('sk-ant-')) {
      console.log(chalk.yellow('  Warning: key does not start with sk-ant-. Continuing anyway.'));
    }
    // Verify against the API BEFORE saving, mirroring the GitHub-token flow
    // (Audit 7, Q8): a truncated paste used to get a confident "API key
    // saved." and fail mid-scan. GET /v1/models is authenticated and free.
    // Verification is advisory: a network fault must not block an offline
    // save, so the user still decides at the Save prompt below.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let res;
      try {
        res = await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': val, 'anthropic-version': '2023-06-01' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        console.log(chalk.green(`  ${SYM.check} Key verified against the Anthropic API.`));
      } else if (res.status === 401) {
        console.log(chalk.red(`  ${SYM.cross} The Anthropic API rejected this key (401). Saving it will fail on your next scan.`));
      } else {
        console.log(chalk.yellow(`  Could not verify the key (API returned ${res.status}). You can still save it.`));
      }
    } catch {
      console.log(chalk.yellow('  Could not verify the key (network issue). You can still save it.'));
    }
    const { decision } = await inquirer.prompt([{
      type: 'list', name: 'decision', theme: inquirerTheme,
      message: chalk.cyan('Save this key?'),
      choices: [
        { name: 'Yes', value: 'yes' },
        { name: 'No', value: 'no' },
        { name: 'Back', value: 'back' },
      ],
    }]);
    if (decision === 'yes') {
      getConfig().set('anthropicApiKey', val);
      secureConfigFile();
      console.log(chalk.green('  API key saved.'));
    } else {
      console.log(chalk.gray('  Discarded. No changes saved.'));
    }
  } catch (_) {
    // NOT a Ctrl+C handler. inquirer 9.3.8 re-raises SIGINT and no process-level
    // SIGINT handler exists, so Ctrl+C kills the process and this catch never
    // runs for it. What this DOES catch is a prompt that throws: a non-TTY
    // stdin, a validation fault, a closed stream. Returning to the menu is
    // still the right response to those.
  }
}

// GitHub reports token sub-flow. Tests against GitHub BEFORE saving; on failure
// offers Try again or Back. Returns the (possibly updated) verified status.
async function reconfigureGithubToken(currentStatus) {
  try {
    while (true) {
      const { token } = await inquirer.prompt([{
        type: 'password', name: 'token',
        message: chalk.cyan("Enter GitHub reports token (starts with ghp_, press Enter to cancel):"),
      }]);
      const val = (token || '').trim();
      if (!val || val.toLowerCase() === 'back') return currentStatus;

      process.stdout.write(chalk.gray('  Testing token against GitHub...\n'));
      const ok = await testGithubToken(val);
      if (!ok) {
        const { retry } = await inquirer.prompt([{
          type: 'list', name: 'retry', theme: inquirerTheme,
          message: chalk.yellow('GitHub rejected this token. Try again or press Enter to cancel.'),
          choices: [
            { name: 'Try again', value: 'retry' },
            { name: 'Back', value: 'back' },
          ],
        }]);
        if (retry === 'back') return currentStatus;
        continue; // loop back to the token prompt
      }
      // Valid: persist via the keychain path (CC5). Always confirm/collect the
      // reports repo (BUG 1) so an existing value can be kept or changed, and
      // accept owner/repo shorthand (BUG 2).
      const cfg = getPublishConfig();
      const currentRepo = cfg?.repo || '';
      const { repoInput } = await inquirer.prompt([{
        type: 'input', name: 'repoInput',
        message: currentRepo
          ? chalk.cyan(`Reports repo (current: ${currentRepo}) [Enter to keep, or type a new one, 'back' to cancel]:`)
          : chalk.cyan("Reports repo (owner/repo or GitHub URL, type 'back' to cancel):"),
      }]);
      let repo = (repoInput || '').trim();
      if (!repo) repo = currentRepo; // Enter with a current value keeps it
      if (!repo || repo.toLowerCase() === 'back') {
        console.log(chalk.gray('  No repo provided. Token not saved.'));
        return currentStatus;
      }
      // BUG 2: expand owner/repo shorthand to a full GitHub URL.
      if (!repo.startsWith('https://') && !repo.startsWith('git@')) {
        repo = 'https://github.com/' + repo;
      }
      // Show the final (possibly expanded) URL and confirm before saving.
      const { confirmRepo } = await inquirer.prompt([{
        type: 'confirm', name: 'confirmRepo',
        message: chalk.cyan(`Save reports repo as ${repo}?`),
        default: true,
      }]);
      if (!confirmRepo) {
        console.log(chalk.gray('  Not saved.'));
        return currentStatus;
      }
      const saveResult = await setPublishConfig({ repo, token: val });
      console.log(chalk.green('  Token verified and saved successfully.'));
      if (saveResult && saveResult.secure === false) {
        console.log(chalk.yellow(
          '  Note: token is stored in plaintext config (OS keychain unavailable).\n' +
          '  For better security, export GHOST_PUBLISH_TOKEN in your shell instead;\n' +
          '  when set it takes priority and the on-disk copy is not used.'
        ));
      }
      return true;
    }
  } catch (_) {
    // See the note on reconfigureApiKey's catch: this does not fire on Ctrl+C
    // (inquirer 9.3.8 re-raises SIGINT and the process dies). It fires on a
    // prompt that throws, and returning the prior status is correct for that.
    return currentStatus;
  }
}

// License sub-flow. Runs only the activation path; never touches the API key or
// GitHub token. Returns to the reconfigure menu after activation completes,
// is cancelled, or fails.
async function reconfigureLicense() {
  try {
    const { key } = await inquirer.prompt([{
      type: 'input', name: 'key',
      message: chalk.cyan("Enter license key or signed token (type 'back' to cancel):"),
    }]);
    const val = (key || '').trim();
    if (!val || val.toLowerCase() === 'back') return;

    // A mistyped key must not kill the app. Every failure path inside
    // runActivateFlow calls failActivation(), which throws instead of exiting
    // while this flag is set, so a typo lands the user back on the reconfigure
    // menu to try again. The specific error was already printed by the path
    // that failed, so there is nothing to re-report here.
    activationInteractive = true;
    try {
      await runActivateFlow(val);
      // Activation succeeded: propagate it into the RUNNING session. Without
      // this, "License activated" printed while the banner, every tier gate,
      // and the loader's context cap kept treating the customer as their old
      // tier until restart (Audit 7, finding 1.2).
      const tier = await refreshSessionAndTier();
      if (tier !== 'open') {
        const tierLabel = tier.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
        console.log(chalk.green(`  ${SYM.check} This session is now running as Ghost Architect™ ${tierLabel}. No restart needed.\n`));
      } else {
        // The activation flow already printed WHY the license is unusable
        // (yellow "saved, but not currently usable" box for a blocked token).
        // Without this line, a customer who just watched activation finish
        // saw nothing and got paywalled on their next scan (Audit 8,
        // finding 1.3).
        console.log(chalk.yellow(`  ${SYM.warn} This session remains on the Open tier. If your license is expired or revoked, renew at ghostarchitect.dev/pricing or run ghost --activate with a valid key.\n`));
      }
    } catch (e) {
      if (!(e instanceof ActivationAborted)) throw e;
      console.log(chalk.gray('  Returning to the menu.\n'));
    } finally {
      activationInteractive = false;
    }
  } catch (_) {
    // NOT a Ctrl+C handler. inquirer 9.3.8 re-raises SIGINT and no process-level
    // SIGINT handler exists, so Ctrl+C kills the process and this catch never
    // runs for it. What this DOES catch is a prompt that throws: a non-TTY
    // stdin, a validation fault, a closed stream. Returning to the menu is
    // still the right response to those.
  }
}

// The selective reconfigure menu. licenseState is a short status string for the
// license line. Returns to the caller (main menu) only on explicit Back, or if
// the menu prompt itself throws. Ctrl+C does not return here: inquirer 9.3.8
// re-raises SIGINT and Ghost exits.
// Live label for the reconfigure menu's license row. Reads the CURRENT session
// state on every menu render (the old frozen-parameter label kept showing
// "open: missing" after an in-menu activation, and a useless "open: unknown"
// to degraded customers, Audit 7 findings 1.2 + 2.6). Degrade events null the
// active license, so the degrade reason is carried separately and rendered
// with the recovery action the customer actually needs.
function licenseMenuLabel() {
  if (SESSION_DEGRADE_REASON === 'revoked') {
    return 'License key (revoked: run ghost --activate <key> to restore)';
  }
  if (SESSION_DEGRADE_REASON === 'trial-ended') {
    return 'License key (trial ended: subscribe at ghostarchitect.dev/pricing)';
  }
  const state = getActiveLicense()?.state || 'missing';
  return `License key (${TIER}: ${state})`;
}

async function runSelectiveReconfigure() {
  // Test the GitHub token once when the menu opens; cache for the session.
  let githubOk = await testGithubToken();
  while (true) {
    const reconfigureChoices = [
      {
        name: `Anthropic API key ${resolveApiKey() ? '(configured)' : '(not set)'}`,
        value: 'apiKey',
        // When the key comes from the environment, it cannot be changed here --
        // disable this row but keep the GitHub token and license rows usable.
        disabled: usingEnvKey() ? chalk.gray('(set via ANTHROPIC_API_KEY env var)') : false,
      },
      { name: `GitHub reports token ${githubOk ? '(verified)' : '(bad credentials: needs update)'}`, value: 'githubToken' },
      { name: licenseMenuLabel(), value: 'license' },
      { name: `Change scan model (${getConfig().get('defaultModel') || 'claude-sonnet-4-6'})`, value: 'model' },
      { name: 'Run full setup wizard', value: 'full' },
      { name: 'Back', value: 'back' },
    ];
    let action;
    try {
      ({ action } = await inquirer.prompt([{
        type: 'list', name: 'action', theme: inquirerTheme,
        message: chalk.cyan('Reconfigure Ghost Architect™:'),
        choices: reconfigureChoices,
      }]));
    } catch (_) {
      // Not reachable via Ctrl+C (inquirer 9.3.8 re-raises SIGINT; the process
      // exits). Reachable when the prompt itself throws, e.g. a non-TTY stdin.
      return;
    }
    if (action === 'back') return;
    if (action === 'full') { await reconfigure(); return; }
    if (action === 'apiKey') { await reconfigureApiKey(); continue; }
    if (action === 'githubToken') { githubOk = await reconfigureGithubToken(githubOk); continue; }
    if (action === 'license') { await reconfigureLicense(); continue; }
    if (action === 'model') { await reconfigureModel(); continue; }
  }
}

// Scan-model sub-flow. Changes the default model used by every mode that does
// not prompt for one (Audit prompts separately). Choices come from config.js's
// MODEL_CHOICES, which is derived from MODEL_RATES, so this menu can never offer
// a model Ghost cannot price. Returns to the reconfigure menu on Back or on a
// prompt fault. Ctrl+C terminates Ghost (inquirer 9.3.8 re-raises SIGINT).
async function reconfigureModel() {
  try {
    const current = getConfig().get('defaultModel') || 'claude-sonnet-4-6';
    const choices = [...getModelChoices(), backChoice()];
    const currentIdx = choices.findIndex(c => c.value === current);
    const { model } = await inquirer.prompt([{
      type: 'list', name: 'model', theme: inquirerTheme,
      message: chalk.cyan('Default scan model:'),
      choices,
      default: currentIdx >= 0 ? currentIdx : 0,
    }]);
    if (isBack(model)) return;
    if (model === current) {
      console.log(chalk.gray(`  Already set to ${current}. No change.\n`));
      return;
    }
    getConfig().set('defaultModel', model);
    console.log(chalk.green(`  ${SYM.check} Default scan model set to ${model}.`));
    console.log(chalk.gray('  Pre-scan cost estimates now reflect this model\'s rates.\n'));
  } catch (_) {
    // NOT a Ctrl+C handler. inquirer 9.3.8 re-raises SIGINT and no process-level
    // SIGINT handler exists, so Ctrl+C kills the process and this catch never
    // runs for it. What this DOES catch is a prompt that throws: a non-TTY
    // stdin, a validation fault, a closed stream. Returning to the menu is
    // still the right response to those.
  }
}

async function main() {
  // Parse CLI flags first so --help / --version / --max-context etc. are honored
  // before we print the banner or run the setup wizard.
  const argv = process.argv.slice(2);
  const cliOpts = parseArgs(argv);

  // Stash the CLI-derived scan-option overrides where session refresh points
  // outside main()'s scope (reconfigureLicense, the degrade blocks in
  // renderLicenseStateAndMaybeBlock) can re-seed the loader without dropping
  // flags the user passed at launch. setScanOptions is last-write-wins, so
  // every re-seed must carry these or a mid-session refresh would silently
  // discard --max-context / --exclude / --skip-redaction.
  CLI_SCAN_OVERRIDES = {
    maxContextOverride: cliOpts.maxContext,
    excludePresets: cliOpts.presets,
    excludePatterns: cliOpts.excludes,
    skipRedaction: cliOpts.skipRedaction,
  };

  // Contradictory transport flags: resolveTransport checks stream first, so
  // stream wins. Say so instead of silently billing streaming rates to a user
  // who expected half-price batch (Audit 7, Q9). stderr, not stdout: this
  // runs before the --export-ci-token dispatch, and that flag guarantees
  // stdout carries only the token (Audit 9, finding 2.6).
  if (cliOpts.stream && cliOpts.batch) {
    console.error(chalk.yellow('Both --stream and --batch were passed. Running streaming.'));
  }

  // --recover-session <label>: force session recovery from the checkpoint sidecar
  // for this project on the next scan, even if a main session file exists. Wired
  // into multipass.loadSession's forced-recovery path.
  if (cliOpts.recoverSession) {
    const { setForceRecoverSession } = await import('../src/core/multipass.js');
    setForceRecoverSession(cliOpts.recoverSession);
  }

  // --sessions-dir <path>: relocate the primary resume-checkpoint directory for
  // this run. Useful when the default Reports volume is read-only or unsuitable.
  // Must be applied before any scan begins so every session read/write uses it.
  if (cliOpts.sessionsDir) {
    const { setSessionsDir } = await import('../src/core/multipass.js');
    setSessionsDir(cliOpts.sessionsDir);
  }

  // Early license-tier resolve for display surfaces (--help, --version, banner).
  // validateLicense({ skipNetworkClock: true }) skips the worldtimeapi roundtrip
  // so documentation flags stay fast. The main-flow validateLicense() later still
  // runs the full clock check; both calls are idempotent (updateLastSeenUtc is a
  // monotonic ratchet, setActiveLicense is last-write-wins). Display surfaces
  // always work, but a BLOCKING result degrades the session to Open here too:
  // the profile flag handlers below exit before the main-flow gate ever runs,
  // so a hard-stopped, tampered, or revoked license kept its paid tier on
  // --list-profiles / --set-default-profile / --create-profile indefinitely
  // (Audit 9, finding 3.6). Mirrors refreshSessionAndTier's degrade.
  try {
    // skipRevocationCheck: this runs ahead of --help/--version/profile flags,
    // which must stay fast and offline-safe. The main flow gate below does
    // check revocation; here only already-cached/offline-detectable blocking
    // states (hard_stop, tampered, invalid) degrade.
    const earlyLicenseResult = await validateLicense({ skipNetworkClock: true, skipRevocationCheck: true });
    if (isBlocking(earlyLicenseResult.state)) {
      setActiveLicense(null);
      TIER = 'open';
      SESSION_DEGRADE_REASON =
        earlyLicenseResult.state === 'revoked' ? 'revoked' :
        (earlyLicenseResult.state === 'hard_stop' && earlyLicenseResult.payload?.tier === 'trial') ? 'trial-ended' :
        null;
    } else {
      setActiveLicense(earlyLicenseResult);
      TIER = getActiveTier() || 'open';
    }
  } catch (err) {
    // Reaching here means validateLicense() THREW — a transient fault, not the
    // expected "no license" path (that returns { state: 'missing' } cleanly).
    // We stay non-blocking so display surfaces (--help, --version) and the
    // profile flags below still run, but we no longer fail silently: a paying
    // customer needs to know their tier dropped to Open because of a fault, not
    // a downgrade. Output goes to stderr so --version/--help stdout stays clean.
    TIER = 'open';
    reportLicenseValidationError(err, { debug: cliOpts.licenseDebug, degraded: true });
  }

  if (cliOpts.help)    { printUsage(); process.exit(0); }
  if (cliOpts.version) {
    // Title-case the tier for display: 'open' -> 'Open', 'pro-max' -> 'Pro Max'.
    // TIER is resolved above (getActiveTier() || 'open'); fall back to 'Open'
    // if it is somehow unset at this point.
    const tierLabel = (TIER || 'open')
      .split('-')
      .map(s => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' ');
    console.log(`Ghost Architect™ v${VERSION} (${tierLabel})`);
    process.exit(0);
  }

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
  if (cliOpts.exportCiToken) {
    await runExportCiTokenFlow();
    process.exit(0);
  }
  if (cliOpts.licenseClear) {
    await runLicenseClearFlow();
    process.exit(0);
  }
  if (cliOpts.configureAdminToken) {
    await runConfigureAdminTokenFlow();
    process.exit(0);
  }
  if (cliOpts.issueLicense) {
    await runIssueLicenseFlow({ tier: cliOpts.issueTier, email: cliOpts.issueEmail, days: cliOpts.issueDays });
    process.exit(0);
  }
  if (cliOpts.revokeLicense) {
    await runRevokeLicenseFlow({ key: cliOpts.revokeKey, reason: cliOpts.revokeReason });
    process.exit(0);
  }

  // ── Batch transport subcommands ───────────────────────────────────────────
  // `ghost batch-status` and `ghost batch-retrieve <id>` are positional
  // subcommands (not flags). Handle them here, before any codebase load or
  // setup, so they work as quick standalone commands. They operate purely on
  // the local pending-batch store + the Anthropic Batches API.
  const positional = argv.filter(a => !a.startsWith('-'));
  if (positional[0] === 'batch-status') {
    await runBatchStatusCommand();
    process.exit(0);
  }
  if (positional[0] === 'batch-retrieve') {
    await runBatchRetrieveCommand(positional[1]);
    process.exit(0);
  }

  // `ghost enterprise audit-status` reports audit-write failures buffered
  // locally while the sync repo was unreachable (flushed to the repo on the
  // next successful audit write). Purely local read, so it works offline.
  if (positional[0] === 'enterprise' && positional[1] === 'audit-status') {
    const { getLocalAuditFailureStatus } = await import('../src/core/enterprise.js');
    const status = getLocalAuditFailureStatus();
    if (status.count === 0) {
      console.log(chalk.green(`\n${SYM.check} No unsynced audit failures. The compliance trail is up to date.\n`));
    } else {
      console.log(chalk.yellow(`\n${SYM.cross} ${status.count} unsynced audit-write failure(s) buffered locally.`));
      console.log(chalk.gray(`  Local buffer: ${status.path}`));
      console.log(chalk.gray('  These will be pushed to the sync repo on the next successful audit write.\n'));
      for (const f of status.failures.slice(-10)) {
        console.log(chalk.gray(`  - ${f.timestamp}  ${f.seatId || 'unknown-seat'}: ${f.message || 'audit_write_failure'}`));
      }
      console.log('');
    }
    process.exit(0);
  }

  // `ghost --force-clear-markers` force-clears a stuck Ghost Mobile publish
  // marker (_pending.json) in the reports repo. Escape hatch for the rare case
  // where the automatic stale-marker cleanup did not run.
  if (argv.includes('--force-clear-markers')) {
    try {
      const result = await clearPendingMarker();
      if (result.reason === 'not_configured') {
        console.log(chalk.gray('\n  Ghost Mobile publish is not configured. Nothing to clear.\n'));
      } else if (result.reason === 'no_marker') {
        console.log(chalk.green(`\n${SYM.check} No pending publish marker found. Nothing to clear.\n`));
      } else {
        console.log(chalk.green(`\n${SYM.check} Cleared pending publish marker${result.slug ? ` (was for ${result.slug})` : ''}.\n`));
      }
    } catch (err) {
      console.log(chalk.red(`\n  Could not clear pending marker: ${err.message}\n`));
      process.exit(1);
    }
    process.exit(0);
  }

  // Profile cache maintenance. Pure local housekeeping, available on every
  // tier and before any other setup so it always works.
  if (cliOpts.cleanCache) {
    const { removed, bytesFreed } = cleanCache();
    const freedKb = (bytesFreed / 1024).toFixed(1);
    console.log(chalk.green(`\n${SYM.check} Cleared profile cache: ${removed} file(s) removed, ${freedKb} KB freed.\n`));
    process.exit(0);
  }

  // --reconfigure routes straight into the same Reconfigure menu the
  // interactive main menu offers. Recovery copy across the CLI points here
  // (cap clamping, pending-batch API key advisories), so the flag must exist:
  // it used to print "Unknown flag: --reconfigure (ignored)" to the exact
  // customer following printed instructions (Audit 9, finding 2.1).
  if (cliOpts.reconfigure) {
    await runSelectiveReconfigure();
    console.log('');
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

  // Soft warning when the profile extraction cache has grown past its ceiling.
  // Non-blocking and stderr-only: it points the user at --clean-cache without
  // interrupting the run.
  const cacheSize = getCacheSize();
  if (cacheSize.exceedsLimit) {
    const usedMb = (cacheSize.bytes / (1024 * 1024)).toFixed(1);
    const limitMb = (cacheSize.limit / (1024 * 1024)).toFixed(0);
    console.warn(chalk.yellow(`! Profile cache is ${usedMb} MB (over ${limitMb} MB). Run \`ghost --clean-cache\` to clear it.`));
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

  // Captured before runSetupWizard() flips isConfigured() to true, so the
  // post-setup banner below can skip its console.clear() and keep the
  // activation confirmation the user saw during setup on screen.
  const firstRun = !isConfigured();
  if (firstRun) {
    console.log(boxen(
      chalk.yellow.bold('Welcome to Ghost Architect!') + '\n' +
      chalk.gray('Looks like this is your first time here.\nLet\'s get you set up.'),
      { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
    ));
    console.log('');

    // First-run license check: offer to activate before the setup wizard so a
    // paying customer lands on their tier immediately; otherwise point them at
    // the trial / Open path. Either branch continues to setup afterward.
    const { hasKey } = await inquirer.prompt([{
      type: 'confirm',
      name: 'hasKey',
      message: chalk.cyan('Do you have a Ghost license key?'),
      default: false,
    }]);
    if (hasKey) {
      const { licenseKey } = await inquirer.prompt([{
        type: 'input',
        name: 'licenseKey',
        message: chalk.cyan('Paste your license key:'),
      }]);
      if (licenseKey && licenseKey.trim()) {
        // runActivateFlow signals failure via process.exit(2), which a plain
        // try/catch cannot intercept. During first-run onboarding we must never
        // kill the process, so temporarily convert process.exit into a throw for
        // the duration of the call, catch it, warn, and fall through to setup.
        // The success path returns normally and never calls process.exit, so
        // this only fires on a genuine activation failure.
        const realExit = process.exit;
        let activated = false;
        try {
          process.exit = (code) => { throw new Error(`first-run-activate-exit:${code}`); };
          await runActivateFlow(licenseKey.trim());
          activated = true;
        } catch (activationErr) {
          console.log('\n' + chalk.yellow("That key didn't activate -- you can try again later with ghost --activate <key>. Continuing setup.") + '\n');
        } finally {
          process.exit = realExit;
        }
        // Propagate the fresh activation into the session BEFORE the wizard
        // runs. The wizard's context-size prompt defaults to the ACTIVE tier's
        // cap and persists the answer; with a stale Open session it defaulted
        // to and saved 50K for brand-new paying customers, silently halving
        // their paid context on every future scan (Audit 7, finding 1.3).
        if (activated) {
          await refreshSessionAndTier();
        }
      }
    } else {
      console.log('\n' + chalk.gray(`No problem. You can start a ${PRICING.TRIAL_DAYS}-day free trial at ghostarchitect.dev/trial or run Ghost Open for free right now.`) + '\n');
    }

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
  // Populated when state is missing (no license = Open tier) AND for the
  // degrade-to-open states (revoked, lapsed trial): those sessions continue
  // as Open and DO hit the paywall renderers, and a cancelled or lapsed
  // customer is the highest-intent re-conversion audience, so they must see
  // the server-driven promo too (Audit 8, finding 2.11).
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
    // On first run, skip the clear so the confirmation from setup/activation
    // stays visible, then print a persistent one-line status under the banner.
    printBanner({ skipClear: firstRun });
    if (firstRun) {
      if (TIER === 'open') {
        console.log(chalk.yellow(`${SYM.info} Running as Ghost Open™. Activate a license with: ghost --activate <key>`));
      } else {
        const tierLabel = TIER.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
        console.log(chalk.green(`${SYM.check} License active: Ghost Architect™ ${tierLabel}. Ready to scan.`));
      }
      console.log('');
    }

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
      skipRedaction: cliOpts.skipRedaction,
    });

    // Fire promo fetch only for states that will actually reach a promo
    // surface: the no-license banner, and the degrade-to-open states
    // (revoked, lapsed trial) whose sessions continue as Open and hit the
    // paywall renderers. For any other state, skip the network call; it
    // adds nothing. The full result (welcome banner promo + paywall promo)
    // is stashed in the function-scoped `promos` so the mode loop below can
    // use paywallPromo when a gate fires.
    const willDegradeToOpen =
      licenseResult.state === 'revoked' ||
      (licenseResult.state === 'hard_stop' && licenseResult.payload?.tier === 'trial');
    if (licenseResult.state === 'missing' || willDegradeToOpen) {
      promos = await fetchPromoText();
    }
    const tierBeforeGate = TIER;
    const blocked = renderLicenseStateAndMaybeBlock(licenseResult, promos.promo);
    if (blocked) {
      console.log(chalk.gray(`${COPYRIGHT}\n`));
      process.exit(1);
    }

    // renderLicenseStateAndMaybeBlock can DEGRADE the tier without blocking: a
    // hard-stopped trial and a revoked license both fall back to Open so the
    // free modes keep working. That happens AFTER the setScanOptions() call
    // above, which had already seeded the loader with the pre-degrade tier. A
    // lapsed Pro Max trial therefore kept the trial's 100K context cap while
    // running as Open (50K), handing an expired trial a paid entitlement on
    // every subsequent scan. Re-seed whenever the gate moved the tier.
    if (TIER !== tierBeforeGate) {
      setScanOptions({
        tier: TIER,
        maxContextOverride: cliOpts.maxContext,
        excludePresets: cliOpts.presets,
        excludePatterns: cliOpts.excludes,
        skipRedaction: cliOpts.skipRedaction,
      });
    }
  } catch (err) {
    // Defense in depth: if validation itself crashes on the gated scan path, we
    // fail closed (block the run) rather than degrade silently. Unlike the
    // early-resolve path above, a scan must not proceed on an unverified tier.
    reportLicenseValidationError(err, { debug: cliOpts.licenseDebug, degraded: false });
    process.exit(1);
  }

  let codebaseContext = null;

  // ── Non-interactive Commit Forecast branch ────────────────────────────────
  // Fires ONLY when ALL THREE of --baseline, --proposed, --modes are present.
  // Any missing flag → fall through to the interactive while-loop below.
  if (cliOpts.cfBaseline && cliOpts.cfProposed && cliOpts.cfModes) {
    const { cfBaseline, cfProposed, cfModes } = cliOpts;

    // a. Validate paths exist and are readable directories.
    for (const [flag, p] of [['--baseline', cfBaseline], ['--proposed', cfProposed]]) {
      if (!fs.existsSync(p)) {
        console.error(chalk.red(`\n  ${SYM.cross} ${flag} path does not exist: ${p}\n`));
        process.exit(1);
      }
      if (!fs.statSync(p).isDirectory()) {
        console.error(chalk.red(`\n  ${SYM.cross} ${flag} path is not a directory: ${p}\n`));
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
      console.error(chalk.red(`\n  ${SYM.cross} Failed to load baseline: ${err.message}\n`));
      process.exit(1);
    }
    if (!codebaseContext) {
      console.error(chalk.red(`\n  ${SYM.cross} Baseline loaded no files from: ${cfBaseline}\n`));
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
          console.log(chalk.cyan('\nIntel gathered. Go make your move.\n'));
          console.log(chalk.gray(`${COPYRIGHT}\n`));
          process.exit(0);
        }
        continue;
      }

      if (method === 'reconfigure') {
        // licenseResult is block-scoped to the license-validation try above, so
        // it is not in scope here. Read the state from the session-stored active
        // license (set via setActiveLicense during validation) instead.
        await runSelectiveReconfigure();
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

      if (method === 'profiles-topLevel') {
        // Same renderer as the mode-menu Profile gate: the previous ad-hoc
        // three-line pitch here had no trial CTA and printed the raw
        // lowercase tier ("You are currently on Ghost open") — two different
        // conversion surfaces for the same feature (Audit 8, quick win 18).
        const profilesVerdict = requireTier('feature:profiles', { tier: TIER });
        if (!profilesVerdict.allowed) {
          renderPaywall(profilesVerdict.paywall, promos.paywallPromo);
          continue;
        }
        // runProfilesMenu() is the single source of truth for profile
        // management: create (persists via writeProfile), edit, set-default,
        // open, and delete. The previous inline menu here treated the wizard's
        // returned profile OBJECT as a file path (path.resolve/loadProfile on
        // an object), which crashed "use now" and silently discarded the
        // profile on "no". Routing here fixes both and adds edit/delete.
        await runProfilesMenu();
        // After managing profiles, re-resolve so a newly created profile or a
        // changed default takes effect immediately for this session.
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

    // Pending-batch retrieval — the user picked a "READY" row injected at the
    // top of the menu (value "batch:<id>"). Pull and save the finished batch
    // (same pipeline as `ghost batch-retrieve`: writes report files, confirms
    // the save, removes the entry from configstore), then loop back to the
    // menu — the retrieved batch no longer appears.
    if (typeof mode === 'string' && mode.startsWith('batch:')) {
      const batchId = mode.slice('batch:'.length);
      await runBatchRetrieveCommand(batchId);
      continue;
    }

    // Tier-gate check at dispatch — wall BEFORE API spend or codebase work.
    // Per design decision 2026-05-23 (Q4): dispatch-level gating, not
    // post-proceed-confirm gating. Quota-gated modes consult getScanCount()
    // for the current count; audit-gated checks the tier alone. Cycle 14
    // adds chat to this list (mode:chat went from open:true to open:false
    // when Question mode launched as the Open-tier Q&A surface). Question,
    // recon, compare, dashboard — free across all tiers.
    // commit-forecast is handled separately below (uses its own forecast-quota gate).
    if (['chat', 'poi', 'blast', 'conflict', 'audit', 'ghost-brief', 'executive-brief'].includes(mode)) {
      const verdict = requireTier(`mode:${mode}`, { scansUsed: getScanCount() });
      if (!verdict.allowed) {
        renderPaywall(verdict.paywall, promos.paywallPromo);
        continue;
      }
    }

    // Ghost Watcher™ rows are selectable at every tier (a locked row the user
    // cannot even click is a dead end at the exact moment they are interested
    // in the paid feature, same reasoning as the Brief rows above), so the
    // entitlement gate lives here at dispatch: below Team, selecting any Watch
    // row renders the upgrade paywall instead of the feature.
    if (['watch-enable', 'watch-status', 'watch-configure', 'watch-disable', 'watch-team'].includes(mode)) {
      const verdict = requireTier('mode:watch');
      if (!verdict.allowed) {
        renderPaywall(verdict.paywall, promos.paywallPromo);
        continue;
      }
    }

    // Ghost Partner Profiles: same selectable-row-plus-dispatch-gate pattern.
    if (mode === 'profiles') {
      const verdict = requireTier('feature:profiles');
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

    // Fix Forecast quota gate — same dispatch-level pattern as Commit
    // Forecast. The mode's own writer re-checks (its "run another" tail
    // re-enters directly), but without a dispatch gate the telemetry ping
    // below fired for every paywalled Open selection, inflating Pulse's
    // mode-usage numbers exactly where Open users bounce (Audit 8,
    // finding 3.11).
    if (mode === 'fix-forecast') {
      const verdict = requireTier('mode:fix-forecast', { fixForecastsUsed: getFixForecastCount() });
      if (!verdict.allowed) {
        renderFixForecastPaywall(promos.paywallPromo);
        continue;
      }
    }

    // --batch is only implemented by the two single-call modes. The multipass
    // modes (POI, Conflict, Audit) have no batch transport path, so the flag was
    // silently doing nothing and the user paid streaming prices believing they
    // had opted into the half-price Batches API. Say so out loud.
    // Only the API-calling scan modes get the notice. Recon makes no LLM call
    // at all, so "Running streaming at standard rates" there was false and
    // cost-alarming, and menu utility picks (watch-status, dashboards) printed
    // nonsense like "--batch is not supported for watch-status" (Audit 7, Q7).
    // Every mode that is not batch-capable must tell a user who passed
    // --batch that they are streaming at standard rates. Commit Forecast,
    // Fix Forecast, and Executive Brief were missing from this list, so a
    // user expecting half-price batch on those modes paid full price with
    // zero notice (Audit 8, finding 2.1).
    const BATCH_NOTICE_MODES = ['poi', 'conflict', 'audit', 'chat', 'commit-forecast', 'fix-forecast', 'executive-brief'];
    if (cliOpts.batch && BATCH_NOTICE_MODES.includes(mode) && !BATCH_CAPABLE_MODES.includes(mode)) {
      console.log(chalk.yellow(
        `\n  Note: --batch is not supported for ${friendlyBatchModeLabel(mode)}. ` +
        `Running streaming at standard rates.`
      ));
      console.log(chalk.gray('  Batch transport is available for Blast Radius and Question.\n'));
    }

    // Mode-usage telemetry. Fire-and-forget so a slow Pulse Worker never
    // delays a scan. Lands as `mode-<name>` in the Pulse dashboard so the
    // Scan Modes histogram shows real cross-tier usage (not just Open).
    //
    // Fires AFTER both gates, never before. Pinged ahead of the wall, every
    // paywalled selection counted as a scan that never ran, so Pulse's
    // cross-mode comparisons were inflated exactly where Open users bounce off
    // the quota (audit most of all). The prompt-triage path above already had
    // this ordering right; this one did not.
    pingModeUsage(VERSION, TIER, mode).catch(() => {});

    switch (mode) {
      // profile is threaded here for the same reason POI/Blast/Conflict get it:
      // saveReport() reads meta.profile to apply white-label branding. Without
      // it, the Question and Chat PDFs rendered unbranded while the CLI still
      // advertised the Question output as a "client-ready PDF".
      case 'question':        await runQuestionMode(codebaseContext, { profile, tier: TIER, flags: { stream: cliOpts.stream, batch: cliOpts.batch } });         break;
      case 'chat':            await runChatMode(codebaseContext, { profile, tier: TIER });             break;
      case 'poi':             await runPOIMode(codebaseContext, { profile, tier: TIER });  break;
      case 'blast':           await runBlastMode(codebaseContext, { profile, tier: TIER, flags: { stream: cliOpts.stream, batch: cliOpts.batch } });  break;
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
      case 'recon':           await runReconMode(codebaseContext, { profile, tier: TIER });  break;
      case 'audit':           await runAuditMode(codebaseContext, { profile, tier: TIER });  break;
      case 'compare':         await runCompareMode();                         break;
      case 'dashboard':       await showProjectDashboard();                   break;
      case 'ghost-brief': {
        // ── Ghost Brief™ — in-menu handler ────────────────────────────────
        const REPORTS_DIR_GB = path.join(os.homedir(), 'Ghost Architect Reports');
        let inputFile = null;

        // Bug fix 1: sort by mtime (most recently modified first)
        if (fs.existsSync(REPORTS_DIR_GB)) {
          const files = fs.readdirSync(REPORTS_DIR_GB)
            .filter(f => f.endsWith('.findings.json'))
            .map(f => ({
              name: f,
              mtime: fs.statSync(path.join(REPORTS_DIR_GB, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);
          const recentFile = files[0];
          if (recentFile) inputFile = path.join(REPORTS_DIR_GB, recentFile.name);
        }

        if (!inputFile) {
          console.log(chalk.yellow('\n  No findings file found in ~/Ghost Architect Reports/'));
          console.log(chalk.gray('  Run a scan first, then select Ghost Brief™.\n'));
          break;
        }

        console.log(chalk.gray(`\n  Using findings: ${path.basename(inputFile)}`));
        const { confirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: `Generate Ghost Brief™ from ${path.basename(inputFile)}?`,
          default: true,
          theme: inquirerTheme,
        }]);

        // Bug fix 2: if user says No, offer file picker instead of bailing
        if (!confirmed) {
          const allFiles = fs.readdirSync(REPORTS_DIR_GB)
            .filter(f => f.endsWith('.findings.json'))
            .map(f => ({
              name: f,
              mtime: fs.statSync(path.join(REPORTS_DIR_GB, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 10);

          if (allFiles.length === 0) {
            console.log(chalk.yellow('\n  No findings files found. Run a scan first.\n'));
            break;
          }

          const { chosenFile } = await inquirer.prompt([{
            type: 'list',
            name: 'chosenFile',
            message: 'Choose a findings file:',
            theme: inquirerTheme,
            choices: [
              ...allFiles.map(f => ({
                name: f.name,
                value: path.join(REPORTS_DIR_GB, f.name),
              })),
              { name: '← Back to menu', value: null },
            ],
          }]);

          if (!chosenFile) break;
          inputFile = chosenFile;
        }

        const briefOutputFile = path.join(process.cwd(), 'ghost-brief.json');
        try {
          const { generateBrief, writeBrief } = await import('../lib/ghostBrief.js');
          const { fromFixForecast, fromPOI, fromConflict } = await import('../lib/ghostBriefAdapter.js');
          const { publishBriefToPortal, isPortalConfigured } = await import('../src/core/portal-publish.js');
          const briefVersion = _require('../package.json').version;

          const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
          let findings = [];
          if (raw.prompts) {
            findings = raw.prompts;
          } else if (raw.findings) {
            const scanMode = raw.scan_mode || raw.mode || 'fix-forecast';
            if (scanMode === 'poi')           findings = fromPOI(raw.findings);
            else if (scanMode === 'conflict') findings = fromConflict(raw.findings);
            else                              findings = fromFixForecast(raw.findings);
          } else {
            console.log(chalk.yellow('\n  Input file has no recognized findings structure.\n'));
            break;
          }

          const brief = generateBrief({
            findings,
            ghostVersion: briefVersion,
            scanFile:     inputFile,
            codebaseRoot: process.cwd(),
            tier:         getActiveTier() || 'open',
          });

          const { jsonPath, htmlPath } = writeBrief(brief, briefOutputFile, getBranding(profile));
          console.log(chalk.green(`\n  ${SYM.check} Ghost Brief™ written to: ${jsonPath}`));
          console.log(chalk.green(`  ${SYM.check} HTML report written to: ${htmlPath}`));
          console.log(chalk.gray(`    ${brief.summary.total_prompts} prompts | ${brief.summary.estimated_agent_hours}h estimated\n`));

          if (isPortalConfigured() && fs.existsSync(jsonPath)) {
            try {
              const result = await publishBriefToPortal(jsonPath);
              if (result?.ok) console.log(chalk.gray(`  ${SYM.check} Ghost Brief™ pushed to portal.\n`));
            } catch { /* non-fatal */ }
          }
        } catch (e) {
          console.error(chalk.red(`\n  Ghost Brief failed: ${e.message}\n`));
        }
        break;
      }

      case 'executive-brief': {
        // ── Executive Brief — in-menu handler ─────────────────────────────
        const REPORTS_DIR_EB = path.join(os.homedir(), 'Ghost Architect Reports');
        let ebInputFile = null;

        // Sort by mtime (most recently modified first)
        if (fs.existsSync(REPORTS_DIR_EB)) {
          const files = fs.readdirSync(REPORTS_DIR_EB)
            .filter(f => f.endsWith('.findings.json'))
            .map(f => ({
              name: f,
              mtime: fs.statSync(path.join(REPORTS_DIR_EB, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);
          const recentFile = files[0];
          if (recentFile) ebInputFile = path.join(REPORTS_DIR_EB, recentFile.name);
        }

        if (!ebInputFile) {
          console.log(chalk.yellow('\n  No findings file found in ~/Ghost Architect Reports/'));
          console.log(chalk.gray('  Run a scan first, then select Executive Brief.\n'));
          break;
        }

        console.log(chalk.gray(`\n  Using findings: ${path.basename(ebInputFile)}`));
        const { ebConfirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'ebConfirmed',
          message: `Generate Executive Brief from ${path.basename(ebInputFile)}?`,
          default: true,
          theme: inquirerTheme,
        }]);

        // If user says No, offer file picker instead of bailing
        if (!ebConfirmed) {
          const allFiles = fs.readdirSync(REPORTS_DIR_EB)
            .filter(f => f.endsWith('.findings.json'))
            .map(f => ({
              name: f,
              mtime: fs.statSync(path.join(REPORTS_DIR_EB, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 10);

          if (allFiles.length === 0) {
            console.log(chalk.yellow('\n  No findings files found. Run a scan first.\n'));
            break;
          }

          const { chosenFile } = await inquirer.prompt([{
            type: 'list',
            name: 'chosenFile',
            message: 'Choose a findings file:',
            theme: inquirerTheme,
            choices: [
              ...allFiles.map(f => ({
                name: f.name,
                value: path.join(REPORTS_DIR_EB, f.name),
              })),
              { name: '← Back to menu', value: null },
            ],
          }]);

          if (!chosenFile) break;
          ebInputFile = chosenFile;
        }

        try {
          const { runExecutiveBriefMode } = await import('../src/modes/executive-brief.js');

          const raw = JSON.parse(fs.readFileSync(ebInputFile, 'utf8'));
          // Distinguish a MALFORMED file (no findings/prompts key at all) from a
          // valid scan that simply has zero findings. Only the former is an
          // error; a clean scan (findings: []) now renders a graceful
          // "no significant findings" brief via runExecutiveBriefMode.
          if (!Array.isArray(raw.findings) && !Array.isArray(raw.prompts)) {
            console.log(chalk.yellow('\n  Input file has no recognized findings structure.\n'));
            break;
          }
          const ebFindings = raw.findings || raw.prompts || [];

          console.log(chalk.gray('  Generating Executive Brief (this calls the API once)...\n'));
          const { pdfPath } = await runExecutiveBriefMode({
            findings: ebFindings,
            tier: getActiveTier() || 'open',
            scanFile: ebInputFile,
            codebaseRoot: raw.project || process.cwd(),
            anthropicClient: null,
            branding: getBranding(profile),
          });

          console.log(chalk.green(`\n  ${SYM.check} Executive Brief written to: ${pdfPath}\n`));
        } catch (e) {
          console.error(chalk.red(`\n  Executive Brief failed: ${e.message}\n`));
        }
        break;
      }

      case 'watch-enable': {
        const { enableWatch, buildWatchConfig } = await import('../src/watch/index.js');
        console.log('\n' + boxen(
          chalk.cyan.bold('🔭 ENABLE GHOST WATCHER™') + '\n' +
          chalk.gray('Monitor commits automatically. Findings delivered to Ghost Portal on every push.'),
          { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
        ));
        console.log('');

        const { repoUrl } = await inquirer.prompt([{
          type: 'input', name: 'repoUrl',
          message: chalk.cyan("GitHub repo URL to watch (blank or 'back' to cancel):"),
          default: '',
          validate: v => (v.trim() === '' || isBackKeyword(v) || v.includes('github.com')) ? true : 'Please enter a valid GitHub URL',
        }]);
        if (repoUrl.trim() === '' || isBackKeyword(repoUrl)) { console.log(chalk.gray('\nCancelled.\n')); break; }

        const { branches: selectedBranches } = await inquirer.prompt([{
          type: 'checkbox', name: 'branches',
          message: chalk.cyan('Which branches to watch?'),
          choices: [
            { name: 'main',          value: 'main',          checked: true },
            { name: 'develop',       value: 'develop',       checked: true },
            { name: 'feature/**',    value: 'feature/**',    checked: true },
            { name: 'bugfix/**',     value: 'bugfix/**',     checked: false },
            { name: 'release/**',    value: 'release/**',    checked: false },
          ],
          validate: arr => arr.length > 0 ? true : 'Select at least one branch',
        }]);

        const { customBranches } = await inquirer.prompt([{
          type: 'input', name: 'customBranches',
          message: chalk.cyan('Add custom branch names? (comma-separated, leave blank to skip):'),
          default: '',
        }]);

        const extraBranches = customBranches
          .split(',').map(s => s.trim()).filter(Boolean);

        const branches = [...selectedBranches, ...extraBranches];

        const { scans } = await inquirer.prompt([{
          type: 'checkbox', name: 'scans',
          message: chalk.cyan('Which scans to run on each commit?'),
          choices: [
            { name: 'Blast Radius',       value: 'blast',    checked: true },
            { name: 'Conflict Detection', value: 'conflict', checked: true },
            { name: 'Ghost Brief',        value: 'brief',    checked: true },
          ],
          validate: arr => arr.length > 0 ? true : 'Select at least one scan',
        }]);

        const { prComment } = await inquirer.prompt([{
          type: 'confirm', name: 'prComment',
          message: chalk.cyan('Post PR comment with findings summary?'),
          default: true,
        }]);

        const { emailInput } = await inquirer.prompt([{
          type: 'input', name: 'emailInput',
          message: chalk.cyan('Email notifications? (comma-separated, leave blank to skip):'),
          default: '',
        }]);
        const emailRecipients = emailInput
          .split(',').map(s => s.trim()).filter(Boolean);

        const { token } = await inquirer.prompt([{
          type: 'password', name: 'token',
          message: chalk.cyan("GitHub Personal Access Token (repo write scope, blank or 'back' to cancel):"),
        }]);
        if (token.trim() === '' || isBackKeyword(token)) { console.log(chalk.gray('\nCancelled.\n')); break; }

        const { commitsPerDay } = await inquirer.prompt([{
          type: 'input', name: 'commitsPerDay',
          message: chalk.cyan('Estimated commits per day across your team:'),
          default: '10',
          validate: v => Number.isFinite(parseInt(v, 10)) && parseInt(v, 10) > 0 ? true : 'Enter a positive number',
        }]);

        // Show cost estimate before final confirmation
        const { estimateWatcherCost } = await import('../src/watch/index.js');
        const estimate = estimateWatcherCost({
          commitsPerDay:     parseInt(commitsPerDay, 10),
          blastRadius:       scans.includes('blast'),
          conflictDetection: scans.includes('conflict'),
        });

        console.log('\n' + boxen(
          chalk.cyan.bold('💰 ESTIMATED API COST') + '\n' +
          chalk.gray('Charged to your Anthropic API key. Ghost does not charge for API usage.\n') +
          chalk.white(`Per commit:     `) + chalk.yellow(`$${estimate.perRun.low.toFixed(2)} – $${estimate.perRun.high.toFixed(2)}`) + '\n' +
          chalk.white(`Daily (~${commitsPerDay} commits): `) + chalk.yellow(`$${estimate.daily.low.toFixed(2)} – $${estimate.daily.high.toFixed(2)}`) + '\n' +
          chalk.white(`Monthly est.:   `) + chalk.yellow(`$${estimate.monthly.low.toFixed(2)} – $${estimate.monthly.high.toFixed(2)}`),
          { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
        ));
        console.log('');

        const { confirm } = await inquirer.prompt([{
          type: 'confirm', name: 'confirm',
          message: chalk.cyan(`Push ghost-watcher.yaml and GitHub Actions workflow to ${repoUrl}?`),
          default: true,
        }]);

        if (!confirm) { console.log(chalk.gray('\nCancelled.\n')); break; }

        try {
          console.log(chalk.gray('\n  Pushing Ghost Watcher configuration to repo...'));
          const watchResult = await enableWatch({
            repoUrl,
            token,
            version: VERSION,
            watchOptions: {
              branches,
              blastRadius:       scans.includes('blast'),
              conflictDetection: scans.includes('conflict'),
              ghostBrief:        scans.includes('brief'),
              prComment,
              emailRecipients,
            },
          });
          console.log(chalk.green(`\n  ${SYM.check} Ghost Watcher™ configuration pushed`));
          console.log('');

          if (!watchResult.workflowPushed) {
            console.log(chalk.yellow('  ⚠  GitHub Actions workflow requires additional setup.'));
            console.log(chalk.gray('  Your token needs "workflow" scope to push workflow files.'));
            console.log('');
            console.log(chalk.cyan('  Manual step: create this file in your repo:'));
            console.log(chalk.white('  .github/workflows/ghost-watcher.yml'));
            console.log('');
            console.log(chalk.gray('  With this content:'));
            console.log(chalk.gray('  ─────────────────────────────────────────'));
            console.log(watchResult.workflowContent);
            console.log(chalk.gray('  ─────────────────────────────────────────'));
            console.log('');
          } else {
            console.log(chalk.green(`  ${SYM.check} GitHub Actions workflow pushed`));
            console.log('');
          }

          console.log(chalk.cyan('  Next steps: add these secrets to your GitHub repo:'));
          console.log(chalk.gray('     ANTHROPIC_API_KEY: your Anthropic API key'));
          console.log(chalk.gray('     GHOST_LICENSE_KEY: the output of "ghost --export-ci-token" (run it on this machine, not your GA- key)'));
          console.log(chalk.gray('     GHOST_PORTAL_REPO: your ghost-reports repo URL'));
          console.log(chalk.gray('     GHOST_PORTAL_TOKEN: GitHub PAT with repo write scope'));
          console.log('');
        } catch (err) {
          console.error(chalk.red(`\n  Enable Watch failed: ${err.message}\n`));
        }
        break;
      }

      case 'watch-status': {
        const { getWatchStatus } = await import('../src/watch/index.js');
        const { repoUrl } = await inquirer.prompt([{
          type: 'input', name: 'repoUrl',
          message: chalk.cyan('GitHub repo URL (or \'back\' to cancel):'),
          validate: v => isBackKeyword(v) || v.includes('github.com') ? true : 'Please enter a valid GitHub URL',
        }]);
        // isBackKeyword, not isBack. isBack() tests for the '__ghost_back__'
        // sentinel that a LIST choice returns; a text input returns exactly what
        // the user typed. The prompt above offers 'back' and validate() accepts
        // it, so isBack() was always false here and the user who tried to cancel
        // got marched into the PAT prompt instead.
        if (isBackKeyword(repoUrl)) { console.log(chalk.gray('\nCancelled.\n')); break; }
        const { token } = await inquirer.prompt([{
          type: 'password', name: 'token',
          message: chalk.cyan('GitHub Personal Access Token:'),
          validate: v => v.trim().length > 0 ? true : 'Token is required',
        }]);
        try {
          const status = await getWatchStatus({ repoUrl, token });
          if (!status) {
            console.log(chalk.yellow('\n  Ghost Watcher is not configured for this repo.\n'));
            console.log(chalk.gray('  Select "Enable Watch" to set it up.\n'));
          } else {
            console.log('\n' + boxen(
              chalk.cyan.bold('📋 WATCH STATUS') + '\n\n' +
              chalk.gray('Enabled:    ') + chalk.bold(status.enabled ? chalk.green('Yes') : chalk.red('No')) + '\n' +
              chalk.gray('Branches:   ') + chalk.white((status.trigger?.branches || []).join(', ')) + '\n' +
              chalk.gray('Blast:      ') + chalk.white(status.scans?.blast_radius ? 'On' : 'Off') + '\n' +
              chalk.gray('Conflict:   ') + chalk.white(status.scans?.conflict_detection ? 'On' : 'Off') + '\n' +
              chalk.gray('Ghost Brief:') + chalk.white(status.scans?.ghost_brief ? 'On' : 'Off') + '\n' +
              chalk.gray('PR Comment: ') + chalk.white(status.notifications?.pr_comment ? 'On' : 'Off'),
              { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
            ));
            console.log('');
          }
        } catch (err) {
          console.error(chalk.red(`\n  Watch Status failed: ${err.message}\n`));
        }
        break;
      }

      case 'watch-configure': {
        console.log(chalk.cyan('\n  Configure Watch: coming soon.\n'));
        console.log(chalk.gray('  For now, edit ghost-watcher.yaml directly in your repo.\n'));
        break;
      }

      case 'watch-disable': {
        const { disableWatch } = await import('../src/watch/index.js');
        const { repoUrl } = await inquirer.prompt([{
          type: 'input', name: 'repoUrl',
          message: chalk.cyan('GitHub repo URL (or \'back\' to cancel):'),
          validate: v => isBackKeyword(v) || v.includes('github.com') ? true : 'Please enter a valid GitHub URL',
        }]);
        // isBackKeyword, not isBack. isBack() tests for the '__ghost_back__'
        // sentinel that a LIST choice returns; a text input returns exactly what
        // the user typed. The prompt above offers 'back' and validate() accepts
        // it, so isBack() was always false here and the user who tried to cancel
        // got marched into the PAT prompt instead.
        if (isBackKeyword(repoUrl)) { console.log(chalk.gray('\nCancelled.\n')); break; }
        const { token } = await inquirer.prompt([{
          type: 'password', name: 'token',
          message: chalk.cyan('GitHub Personal Access Token:'),
          validate: v => v.trim().length > 0 ? true : 'Token is required',
        }]);
        const { confirm } = await inquirer.prompt([{
          type: 'confirm', name: 'confirm',
          message: chalk.yellow(`Disable Ghost Watcher on ${repoUrl}?`),
          default: false,
        }]);
        if (!confirm) { console.log(chalk.gray('\nCancelled.\n')); break; }
        try {
          await disableWatch({ repoUrl, token });
          console.log(chalk.green('\n  Ghost Watcher disabled.\n'));
          console.log(chalk.gray('  The workflow file is still in your repo: re-enable anytime.\n'));
        } catch (err) {
          console.error(chalk.red(`\n  Disable Watch failed: ${err.message}\n`));
        }
        break;
      }

      case 'watch-team': {
        console.log(chalk.cyan('\n  Manage Team: coming soon.\n'));
        console.log(chalk.gray('  Team management will be available in the next release.\n'));
        break;
      }

      case 'profiles': {
        // Route to runProfilesMenu() (the create/edit/set-default/open/delete
        // menu with correct persistence) rather than the old inline menu, which
        // treated the wizard's returned profile OBJECT as a file path and so
        // crashed on "use now" and silently lost the profile on "no".
        await runProfilesMenu();
        // Re-resolve so a newly created profile or changed default applies to
        // the loaded session immediately.
        try {
          const resolved = await resolveStartupProfile(cliOpts);
          profile = resolved.profile;
          activeProfileLabel = resolved.label;
        } catch (err) {
          console.log(chalk.yellow(`⚠  Could not refresh profile: ${err.message}`));
        }
        break;
      }
    }
  }
}

// ── Ghost Watcher — cancel handler (marks portal state on Actions cancel) ──
if (process.argv.includes('--watcher-cancelled')) {
  const { runWatchCancelled } = await import('../src/modes/watcher-commit.js');
  await runWatchCancelled();
  process.exit(0);
}

// ── Ghost Watcher — headless CI mode ───────────────────────────────────────
if (process.argv.includes('--watcher-commit')) {
  const { runWatchCommit } = await import('../src/modes/watcher-commit.js');
  const { version } = _require('../package.json');

  // The classic CI misconfiguration: GHOST_LICENSE_KEY set to the GA- human
  // key instead of the signed token. decodeAndVerifyToken can never validate
  // it ("Token must have 3 parts, got 1"), which used to surface as a generic
  // "license is not valid" advisory line and a watcher that silently never
  // scanned. Catch it up front and say exactly how to fix it. Exit 0: Ghost
  // Watcher™ is advisory and never blocks a commit.
  if (looksLikeHumanKey(process.env.GHOST_LICENSE_KEY)) {
    console.error('👻 Ghost Watcher™: GHOST_LICENSE_KEY appears to be a license key rather than a signed token.');
    console.error("   Run 'ghost --activate <key>' on this machine first, or set GHOST_LICENSE_KEY to the output of 'ghost --export-ci-token'.");
    process.exit(0);
  }

  let watchTier;
  try {
    // Revocation IS checked here (no skipRevocationCheck). An unattended CI run
    // on a cancelled subscription is precisely the leak. The check fails open on
    // any network fault, so a runner with no egress still scans.
    const watchLicenseResult = await validateLicense({ skipNetworkClock: true });
    setActiveLicense(watchLicenseResult);

    // getActiveTier() reads payload.tier and answers "what did they buy", not
    // "may they use it". Without this gate a revoked, expired, or hard-stopped
    // license still resolved to 'team' and ran the watcher on every commit
    // forever. Exit 0 either way: Ghost Watcher is advisory and never blocks a
    // commit, but advisory does not mean free.
    if (isBlocking(watchLicenseResult.state)) {
      console.error('👻 Ghost Watcher™: ' + (watchLicenseResult.message || 'license is not valid.'));
      process.exit(0);
    }
    watchTier = getActiveTier() || 'open';
  } catch (err) {
    reportLicenseValidationError(err, { debug: process.argv.includes('--license-debug'), degraded: false });
    process.exit(0); // advisory — never block a commit
  }

  const WATCH_TIERS = WATCH_TIERS_ALLOWED;
  if (!WATCH_TIERS.includes(watchTier)) {
    console.error('👻 Ghost Watcher requires Ghost Team or higher.');
    console.error('   Upgrade at: https://ghostarchitect.dev/pricing');
    process.exit(0); // advisory — never block a commit
  }

  await runWatchCommit({ tier: watchTier, version });
  process.exit(0);
}

// ── Ghost Brief ───────────────────────────────────────────────────────────
if (process.argv.includes('--brief')) {
  const { generateBrief, writeBrief } = await import('../lib/ghostBrief.js');
  const { fromFixForecast, fromPOI, fromConflict } = await import('../lib/ghostBriefAdapter.js');
  const { publishBriefToPortal, isPortalConfigured } = await import('../src/core/portal-publish.js');
  const { version } = _require('../package.json');

  // Same CI misconfiguration guard as the watcher path: a GA- human key in
  // GHOST_LICENSE_KEY can never validate as a signed token. Ghost Brief™ is
  // fail-closed (gated Max-plan feature), so exit 1 here, but with the same
  // actionable guidance instead of a generic invalid-license line.
  if (looksLikeHumanKey(process.env.GHOST_LICENSE_KEY)) {
    console.error('Ghost Brief™: GHOST_LICENSE_KEY appears to be a license key rather than a signed token.');
    console.error("Run 'ghost --activate <key>' on this machine first, or set GHOST_LICENSE_KEY to the output of 'ghost --export-ci-token'.");
    process.exit(1);
  }

  // Resolve license tier before doing anything else. Fail closed on an
  // unexpected validation fault (Ghost Brief is a gated tier feature) rather
  // than letting the crash surface as an opaque unhandled rejection.
  let briefTier;
  try {
    const briefLicenseResult = await validateLicense({ skipNetworkClock: true });
    setActiveLicense(briefLicenseResult);
    // Same reasoning as the watcher path: a tier from the payload is not a
    // right to use it. Ghost Brief is a gated Max-plan feature, so fail closed.
    if (isBlocking(briefLicenseResult.state)) {
      console.error('Ghost Brief™: ' + (briefLicenseResult.message || 'license is not valid.'));
      process.exit(1);
    }
    briefTier = getActiveTier() || 'open';
  } catch (err) {
    reportLicenseValidationError(err, { debug: process.argv.includes('--license-debug'), degraded: false });
    process.exit(1);
  }

  const BRIEF_TIERS = MAX_TIERS;
  if (!BRIEF_TIERS.includes(briefTier)) {
    console.error('Ghost Brief requires a Max plan (Pro Max, Team Max, or Enterprise Max).');
    console.error('Upgrade at: https://ghostarchitect.dev/pricing');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  // Accept both `--flag=value` and space-separated `--flag value` so
  // `ghost --brief --output ./reports` works the same as `--output=./reports`.
  // Previously only the `=` form was parsed, so the space form silently fell
  // back to the default output path.
  const readFlag = (name, def) => {
    const eq = args.find(a => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('-')) {
      return args[idx + 1];
    }
    return def;
  };
  const inputFile = readFlag('--input', 'ghost-report.json');
  const outputFile = readFlag('--output', 'ghost-brief.json');

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
      codebaseRoot: process.cwd(),
      tier: briefTier
    });
    // Headless --brief has no `profile` in scope (that variable lives in
    // main()); this path doesn't parse --profile, so brand with the default.
    // Passing the undeclared `profile` here threw ReferenceError on every run.
    const { jsonPath, htmlPath } = writeBrief(brief, outputFile, getBranding(null));
    console.log(`Ghost Brief written to: ${jsonPath}`);
    console.log(`HTML report written to: ${htmlPath}`);
    console.log(`  ${brief.summary.total_prompts} prompts | ${brief.summary.estimated_agent_hours}h estimated`);

    // ── Portal Publish (non-fatal) ─────────────────────────────────────
    if (isPortalConfigured() && fs.existsSync(jsonPath)) {
      try {
        const portalResult = await publishBriefToPortal(jsonPath);
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
  // Last-resort safety nets so an unhandled promise rejection or a throw
  // outside the main() chain still gets the friendly, support-linked message
  // instead of a raw stack trace. Registered inside the isMain() guard so
  // importing this module in tests never installs process-wide handlers.
  process.on('unhandledRejection', (reason) => {
    showFriendlyError(reason instanceof Error ? reason : new Error(String(reason)));
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    showFriendlyError(err);
    process.exit(1);
  });

  main().catch(err => {
    showFriendlyError(err);
    process.exit(1);
  });
}

// Exports for testing. The guard above ensures importing this module
// from a test file (e.g. tests/banner-promo.smoke.mjs) does NOT execute
// main() — tests get clean access to the underlying helpers.
export { fetchPromoText, renderLicenseStateAndMaybeBlock };
