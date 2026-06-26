import { showFriendlyError } from '../utils/errors.js';
const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import { runBlastRadius, buildBlastRequest, processBlastRawOutput } from '../analyst/index.js';
import { showCostEstimate, showActualCost, showConflictCost, SessionCostTracker } from '../estimator.js';
import { getConfig, resolveApiKey } from '../config.js';
import { saveReport } from '../reports.js';
import { resolveTransport } from '../lib/transport-menu.js';
import { buildStreamingTransport, buildBatchTransport } from '../lib/transport-meta.js';
import { addPendingBatch } from '../lib/batch-store.js';
import { deriveRepoName, submitBatchInteractive, formatBatchLabelDate } from '../lib/batch-submit.js';
import { runRecon, formatPlanForDisplay } from '../core/agent/planner.js';
import { promptProjectLabel } from '../projects.js';
import { requireTier } from '../license/tier-gates.js';
import { hasShownCallout, markCalloutShown } from '../cli/session-state.js';
// Static import: extractFindings is already used by sibling modes (poi.js)
// so there's no module-loading novelty justifying the dynamic-import pattern
// audit-mode used for its newly-introduced findingsFromAuditResults. Idiomatic
// top-level import; the audit-mode dynamic-import precedent doesn't apply here.
import { extractFindings } from '../utils/finding-parser.js';

// ── Target selection ────────────────────────────────────────────────────────
//
// pickBlastTargets returns either:
//   - a string: a single file/class/method name (free-text workflow)
//   - an array of strings: one or more selected file paths (picker workflow)
//
// The picker uses a two-step pattern that scales to large repos without
// adding any new dependencies on top of inquirer 9:
//   1. Optional filter substring (skip = show all). With ≤2000 files this is
//      cosmetic; with 10,000+ it's how a user actually narrows down.
//   2. Multi-select checkbox of files matching the filter, with a hard cap
//      so an unfiltered checkbox in a giant repo doesn't paint thousands of
//      lines of terminal output.
//
// The free-text path is preserved as a separate first-question option
// because typing a class name or method name is a legitimate workflow
// ("what's the blast radius if I rename `migrateToSecureStorage`?") and
// shouldn't be sacrificed for the picker.

const PICKER_HARD_CAP = 200; // max files shown in a single checkbox prompt

// Paths that are essentially never legitimate blast-radius targets. The user
// rarely wants to ask "what happens if I change a file inside node_modules".
// Scan-time --exclude flags are separate; this is purely a UI filter on the
// picker so the list isn't drowned in third-party dependencies. The full
// fileIndex is still passed to the model for context.
const PICKER_HIDE_PATTERNS = [
  /(?:^|\/)node_modules\//,
  /(?:^|\/)vendor\//,
  /(?:^|\/)\.git\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /(?:^|\/)\.next\//,
  /(?:^|\/)coverage\//,
  /(?:^|\/)\.cache\//,
  /\.lock$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
];

function isPickerHidden(filePath) {
  for (const re of PICKER_HIDE_PATTERNS) {
    if (re.test(filePath)) return true;
  }
  return false;
}

async function pickBlastTargets(files) {
  // Apply the picker UI filter once up front. Hidden paths (node_modules,
  // vendor, build outputs, lock files) are still in the codebase context
  // for the model, but they don't clutter the picker.
  const visibleFiles = files.filter(f => !isPickerHidden(f));
  const totalFiles = visibleFiles.length;
  const hiddenCount = files.length - visibleFiles.length;

  if (totalFiles === 0) {
    // Edge case: every file matched a hidden pattern (e.g. someone scanned
    // a folder containing only node_modules). Fall back to free-text input
    // rather than presenting an empty checkbox.
    console.log(chalk.yellow(
      `  All ${files.length} files match the picker's hidden patterns ` +
      `(node_modules, vendor, build outputs, lock files). ` +
      `Switching to free-text target entry.\n`
    ));
    const { target } = await inquirer.prompt([{
      type: 'input',
      name: 'target',
      message: chalk.cyan('Analyze impact of changing:'),
      validate: (v) => v.trim().length > 0 ? true : 'Please enter a file, class, or method name'
    }]);
    return target.trim();
  }

  const hiddenNote = hiddenCount > 0
    ? ` (${hiddenCount} dependency/build file${hiddenCount === 1 ? '' : 's'} hidden)`
    : '';

  const { mode } = await inquirer.prompt([{
    type: 'list',
    name: 'mode',
    message: chalk.cyan('How would you like to pick targets?'),
    choices: [
      { name: `Pick file(s) from the project (${totalFiles} files available${hiddenNote})`, value: 'pick' },
      { name: 'Type a custom target (class name, method name, or file path)', value: 'custom' },
    ],
  }]);

  if (mode === 'custom') {
    const { target } = await inquirer.prompt([{
      type: 'input',
      name: 'target',
      message: chalk.cyan('Analyze impact of changing:'),
      validate: (v) => v.trim().length > 0 ? true : 'Please enter a file, class, or method name'
    }]);
    return target.trim();
  }

  // Picker path. Loop so the user can refine their filter if the first
  // pass returns too many files or zero matches.
  while (true) {
    let { filter } = await inquirer.prompt([{
      type: 'input',
      name: 'filter',
      message: chalk.cyan('Filter file list (optional — substring match, leave blank for all):'),
      default: '',
    }]);
    filter = filter.trim().toLowerCase();

    let pool = filter
      ? visibleFiles.filter(f => f.toLowerCase().includes(filter))
      : visibleFiles.slice();

    if (pool.length === 0) {
      console.log(chalk.yellow(`  No files matched "${filter}". Try a different filter (or leave blank to see all).\n`));
      continue;
    }

    let truncated = false;
    if (pool.length > PICKER_HARD_CAP) {
      console.log(chalk.yellow(
        `  ${pool.length} files matched "${filter || '(all)'}". Showing the first ${PICKER_HARD_CAP}; ` +
        `refine your filter if the file you want isn't in the list.`
      ));
      pool = pool.slice(0, PICKER_HARD_CAP);
      truncated = true;
    }

    const { selected } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'selected',
      message: chalk.cyan(
        `Select file(s) to analyze${truncated ? ' (truncated list)' : ''}:` +
        chalk.gray(' (Space toggles, Enter confirms)')
      ),
      choices: pool.map(f => ({ name: f, value: f })),
      pageSize: Math.min(20, pool.length),
      validate: (arr) => arr.length > 0 ? true : 'Pick at least one file (Space toggles selection).',
    }]);

    return selected;
  }
}

export async function runBlastMode(codebaseContext, options = {}) {
  // Ghost Partner — consultant profile (null when --profile was not passed).
  // Threaded through to the analyst (consultant lens in prompt + narrator)
  // and through saveReport meta (white-label cover + chrome in the PDF).
  const profile = options.profile || null;

  // Tier resolution. Defaults to 'open' (fail-closed) so any caller that
  // forgets to pass tier does not leak the paid project-tracking feature.
  // bin/ghost.js is the single source of truth — it passes TIER (resolved
  // from active license at line 1311) into this options object. Mirrors
  // the conflict Phase 2 adoption pattern from commit 5cfe7db.
  const tier = options.tier || 'open';

  // D4 gate: project-tracking is Pro+ only. Drives both the label prompt
  // below AND the saveLabel-fallback fix at the saveReport call site (the
  // synthetic fallback that would otherwise re-leak the four side-effect
  // blocks even after gating the label prompt). Gate ID is shared with
  // prompt-triage and conflict so D3 callout suppression spans all three.
  const projectIntelGate = requireTier('feature:project-tracking', { tier });
  const projectIntelEnabled = projectIntelGate.allowed;

  console.log('\n' + boxen(
    chalk.cyan.bold('💥 BLAST RADIUS ANALYSIS') + '\n' +
    chalk.gray('Pick one or more files to analyze, or type a class/method name.\nMulti-file selection produces ONE combined impact map.') +
    (profile ? '\n' + chalk.magenta(`👥 Ghost Partner profile: ${profile.name || profile.author || 'loaded'}`) : ''),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));

  console.log('');

  const files = codebaseContext.fileIndex;
  console.log(chalk.gray(`  Project has ${files.length} files.\n`));

  // pickBlastTargets returns either a string (custom target) or an array of
  // file paths (picker selection). The analyst handles both shapes.
  const target = await pickBlastTargets(files);
  const targetCount = Array.isArray(target) ? target.length : 1;

  // Surface what we're about to analyze so the user can sanity-check before
  // we burn API budget. Multi-file selections especially benefit from this
  // because the checkbox prompt scrolls and it's easy to miss a stray space.
  if (Array.isArray(target)) {
    console.log(chalk.gray('\n  Selected for analysis:'));
    target.forEach(f => console.log(chalk.gray(`    • ${f}`)));
    console.log('');
  }

  const model = getConfig().get('defaultModel') || 'claude-sonnet-4-6';
  showCostEstimate(codebaseContext, 'blast', model);

  // ── Agent Planner ─────────────────────────────────────────────────────────
  // The planner takes a focusAreas string. For multi-target we pass a
  // joined summary; for single target we pass it verbatim.
  const focusAreas = Array.isArray(target) ? target.join(', ') : target;
  try {
    const reconSpinner = ora({ text: chalk.gray('Ghost is sizing up your codebase...'), color: 'cyan' }).start();
    const reconPlan    = await runRecon(codebaseContext.fileMap || {}, 'blast', { focusAreas });
    reconSpinner.stop();
    const display = formatPlanForDisplay(reconPlan);

    console.log('\n' + boxen(
      chalk.cyan.bold('🔍 ANALYSIS PLAN') + '\n\n' +
      chalk.white(display.summary || '') + '\n\n' +
      chalk.gray('Files:   ') + chalk.bold(String(display.stats.files)) + '   ' +
      chalk.gray('Est. cost: ') + chalk.bold(display.stats.cost) + '   ' +
      chalk.gray('Est. time: ') + chalk.bold(display.stats.time) +
      (display.risks.length > 0
        ? '\n\n' + chalk.yellow.bold('⚠  High-risk areas:') + '\n' +
          display.risks.slice(0, 4).map(r => chalk.yellow(`   • ${r}`)).join('\n')
        : '') +
      (display.warnings.length > 0
        ? '\n\n' + chalk.yellow.bold('!  Warnings:') + '\n' +
          display.warnings.map(w => chalk.yellow(`   ${w}`)).join('\n')
        : ''),
      { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
    ));
    console.log('');
  } catch {
    console.log(chalk.gray('  (Recon unavailable — proceeding with standard analysis)\n'));
  }

  // Smart project label prompt — same UX as POI. The project label is what
  // groups scans together on the portal and in team-sync. Without this,
  // Blast was saving under a target-derived synthetic label like
  // "change-set-4-files" which broke project grouping entirely. The
  // change-set descriptor is now folded into meta instead.
  // Gated on Pro+ per D4: Open users skip labeling, label stays null
  // through to the saveLabel derivation below, which then resolves to
  // null (not the synthetic fallback) so saveReport's four side-effect
  // blocks short-circuit cleanly.
  let label = null;
  if (projectIntelEnabled) {
    label = await promptProjectLabel();
    console.log('');
  } else if (!hasShownCallout('feature:project-tracking')) {
    // D3 soft-gate callout: one line, once per session, gentle. Open users
    // still get the full blast scan and saved report — this just signals
    // what they'd gain on Pro. Shared gate ID with prompt-triage and
    // conflict so the callout coalesces to one display per ghost invocation
    // across all three modes.
    console.log(chalk.cyan('💡 Project tracking available on Pro. Scans run as one-shots on Open.'));
    console.log('');
    markCalloutShown('feature:project-tracking');
  }

  const { proceed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'proceed',
    message: chalk.cyan('Proceed with analysis?'),
    default: true
  }]);
  if (!proceed) { console.log(chalk.gray('\nAnalysis cancelled.\n')); return; }

  // ── Transport selection (streaming vs batch) ──────────────────────────────
  // Context is loaded and the scan is confirmed; choose how the Anthropic call
  // runs. --stream/--batch flags, CI, and Ghost Watcher contexts skip the menu
  // (see resolveTransport). Batch submits the request and exits cleanly; the
  // user retrieves later via `ghost batch-retrieve <id>`. Streaming falls
  // through to the existing live path below.
  const transport = await resolveTransport({
    flags:     options.flags || {},
    mode:      'blast',
    modeLabel: 'Blast Radius',
    codebaseContext,
    model,
  });

  if (transport === 'batch') {
    await submitBlastBatch({ codebaseContext, target, targetCount, profile, projectIntelEnabled, label });
    return;
  }

  console.log('');

  // Spinner copy reflects single vs change-set framing. We check
  // targetCount, not Array.isArray(target), because the picker always
  // returns an array — even for a single selection. "Mapping combined
  // blast radius across 1 files" was the buggy fallout from checking
  // isArray; the count is the real signal.
  const spinnerLabel = targetCount > 1
    ? `Mapping combined blast radius across ${targetCount} files`
    : `Mapping blast radius for: ${Array.isArray(target) ? target[0] : target}`;

  const spinner = ora({
    text: chalk.gray(spinnerLabel),
    color: 'cyan'
  }).start();

  let buffer = '';

  try {
    // Streaming-to-stdout was causing the report to scroll off-screen
    // before the user could read it (POI mode hit the same problem and
    // we fixed it the same way). The chunk handler still buffers the
    // text — we just don't paint it to the terminal as it arrives.
    // The spinner stays on screen the whole time and gives a clear
    // "still working" signal. The full report lives in `buffer` and
    // is what we save to disk; the user reads it from the saved files.
    const blastTracker = new SessionCostTracker();
    const blastUsage   = (i, o, m, stage) => blastTracker.record(stage || 'scan', i, o, m);

    const result = await runBlastRadius(
      codebaseContext,
      target,
      (chunk) => { buffer += chunk; },
      {
        onNarratorStart: () => {
          spinner.text = chalk.gray('Ghost is writing the blast radius report...');
        },
        profile,  // Ghost Partner — threads consultant lens into prompt + narrator
        onUsage: blastUsage,
      }
    );

    spinner.succeed(chalk.green('Blast radius report ready'));
    console.log('');

    showConflictCost(blastTracker);

    const { doSave } = await inquirer.prompt([{
      type: 'confirm', name: 'doSave',
      message: chalk.cyan('Save this analysis to ~/Ghost Architect Reports/?'), default: true
    }]);

    if (doSave) {
      // The saveLabel is the project label — this is what groups scans
      // across modes for the same project on the portal, in team-sync,
      // and in mobile-publish. When the user gave a label, use it. When
      // they skipped (label = null = one-time scan) on a paid tier, fall
      // back to the target-derived synthetic label so the file is still
      // uniquely named on disk. On Open (projectIntelEnabled false),
      // saveLabel stays null so the four `if (label && isXConfigured())`
      // side-effect blocks in saveReport (team-sync, mobile-publish,
      // portal-publish, audit log) short-circuit. The synthetic fallback
      // is a UX nicety for paid tiers, not a freshness mechanism that
      // should override D4. Without this gating, Open users with a multi-
      // file selection would have fallbackLabel = "change-set-N-files"
      // (truthy), defeating the label-prompt gate above.
      const fallbackLabel = targetCount > 1
        ? `change-set-${targetCount}-files`
        : (Array.isArray(target) ? target[0] : target);
      const saveLabel = projectIntelEnabled ? (label || fallbackLabel) : null;

      // changeSet captures what was actually analyzed — the file list or
      // free-text target — so the report header can show it even though
      // the file name now uses the project label. The narrator already
      // bakes this into the report body; meta carries it forward for
      // downstream renderers (PDF cover page, manifest entry, etc.).
      const changeSet = Array.isArray(target) ? target : [target];

      // Sidecar findings: parse the report into structured findings so the
      // .findings.json sidecar carries real severity counts and effort estimates
      // instead of the placeholder all-MEDIUM output buildFindingsSidecar produces
      // when called on raw report text. Same architectural pattern as audit-mode
      // (commits c2aeaad + dc352b0): mode populates meta.findings, reports.js
      // Strategy 2 conditional consumes it; falls back to buildFindingsSidecar
      // for callers that don't supply it.
      const parsedFindings = extractFindings(buffer);
      const criticalCount  = parsedFindings.filter(f => f.severity === 'CRITICAL').length;
      const highCount      = parsedFindings.filter(f => f.severity === 'HIGH').length;
      const mediumCount    = parsedFindings.filter(f => f.severity === 'MEDIUM').length;
      const lowCount       = parsedFindings.filter(f => f.severity === 'LOW').length;
      const totalHours     = parsedFindings.reduce((sum, f) => sum + (f.effortHours || 0), 0);

      // Meta drives PDF chrome and markdown branding. The `profile` field is
      // what flips PDF rendering into white-label mode — saveReport calls
      // getBranding(meta.profile) and threads the result into the PDF
      // generator. When profile is null, default Ghost branding renders.
      const meta = {
        filesAnalyzed: codebaseContext.totalFiles
          ? `${codebaseContext.loadedFiles} of ${codebaseContext.totalFiles}`
          : `${codebaseContext.loadedFiles || 0}`,
        totalFiles: codebaseContext.totalFiles,
        profile,
        changeSet,
        targetCount,
        // Sidecar findings — reports.js consumes meta.findings if present
        // (Strategy 2 conditional from commit dc352b0). Without these, the
        // .findings.json sidecar would default to all-MEDIUM placeholder
        // entries from parsing report markdown headers.
        findings:     parsedFindings,
        findingCount: parsedFindings.length,
        critical:     criticalCount,
        high:         highCount,
        medium:       mediumCount,
        low:          lowCount,
        totalHours,
        // Transport metadata — this scan ran live (streaming). Stamped into
        // findings.json and the PDF/Ghost Brief footer. See src/lib/transport-meta.js.
        transport:    buildStreamingTransport(),
      };

      const saved = await saveReport(buffer, 'ghost-blast', saveLabel, meta);
      console.log(chalk.green(`\n${SYM.check} Reports saved to ~/Ghost Architect Reports/`));
      console.log(chalk.gray(`  📄 ${saved.txtFile}`));
      console.log(chalk.gray(`  📋 ${saved.mdFile}`));
      if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
      console.log('');
    } else {
      // Even if the user declines to save, give them one last clear
      // signal that a report exists — it's been buffered but not
      // streamed, so they may not realize it ran at all.
      console.log(chalk.gray(`\n  (Report not saved. ${buffer.length.toLocaleString()} characters were generated.)\n`));
    }

    const { another } = await inquirer.prompt([{
      type: 'confirm', name: 'another',
      message: chalk.cyan('Analyze another target?'), default: false
    }]);
    if (another) return await runBlastMode(codebaseContext, options);

  } catch (err) {
    spinner.fail(chalk.red('Blast radius analysis failed'));
    showFriendlyError(err);
  }
}

// ── Batch transport: submit ─────────────────────────────────────────────────
//
// Build the exact same request the streaming path would send (buildBlastRequest)
// and submit it to the Message Batches API via the existing, hardened
// submitBatch() helper. Persist a pending-batch record in the local configstore
// (including everything a later `ghost batch-retrieve` needs to reproduce the
// streamed output without re-loading the codebase), print the retrieval
// instructions, and return — no polling, no waiting.

async function submitBlastBatch({ codebaseContext, target, targetCount, profile, projectIntelEnabled, label }) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.log(chalk.red(`\n${SYM.cross} No Anthropic API key configured — cannot submit a batch.`));
    console.log(chalk.gray('  Set ANTHROPIC_API_KEY or run `ghost` once to configure your key.\n'));
    return;
  }

  // Same request the streaming path builds — byte-for-byte identical params so
  // the batch result is indistinguishable from a live run.
  const req = buildBlastRequest(codebaseContext, target, { profile });

  const submittedAt = new Date().toISOString();
  const customId = `blast-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  const requests = [{
    custom_id: customId,
    params: {
      model:      req.model,
      max_tokens: req.max_tokens,
      temperature: req.temperature,
      system:     req.system,
      messages:   req.messages,
    },
  }];

  const spinner = ora({ text: chalk.gray('Submitting batch to Anthropic...'), color: 'cyan' }).start();
  let batchId;
  try {
    batchId = await submitBatchInteractive(apiKey, requests);
    spinner.succeed(chalk.green('Batch submitted'));
  } catch (err) {
    spinner.fail(chalk.red('Batch submission failed'));
    showFriendlyError(err);
    return;
  }

  // Derive save metadata now (at submit time) so retrieve can save under the
  // same project label the streaming path would have used. Mirrors the
  // saveLabel/changeSet logic in the streaming save block.
  const repo = deriveRepoName(codebaseContext);
  const fallbackLabel = targetCount > 1
    ? `change-set-${targetCount}-files`
    : (Array.isArray(target) ? target[0] : target);
  const saveLabel = projectIntelEnabled ? (label || fallbackLabel) : null;
  const changeSet = Array.isArray(target) ? target : [target];

  try {
    addPendingBatch({
      id:          batchId,
      mode:        'blast-radius',
      repo,
      label:       `Blast Radius — ${repo} — ${formatBatchLabelDate(submittedAt)}`,
      submittedAt,
      status:      'pending',
      customId,
      context: {
        targets:      req.targets,
        projectLabel: req.projectLabel,
        rates:        req.rates,
        profile:      profile || null,
        loadedFiles:  codebaseContext.loadedFiles || 0,
        totalFiles:   codebaseContext.totalFiles  || 0,
        saveLabel,
        changeSet,
        targetCount,
      },
    });
  } catch (err) {
    // The batch is already submitted on Anthropic's side; a configstore write
    // failure shouldn't lose the id. Surface it so the user can still retrieve.
    console.log(chalk.yellow(`\n  ⚠  Could not record the pending batch locally (${err.message}).`));
    console.log(chalk.yellow(`     Save this batch id to retrieve it later: ${batchId}\n`));
  }

  console.log('');
  console.log(chalk.green(`${SYM.check} Batch submitted — ID: ${batchId}`));
  console.log(chalk.gray('  Check status:        ') + chalk.cyan('ghost batch-status'));
  console.log(chalk.gray('  Retrieve when ready: ') + chalk.cyan(`ghost batch-retrieve ${batchId}`));
  console.log(chalk.gray('  Estimated ready: ~15 minutes'));
  console.log('');
}

// ── Batch transport: retrieve replay ────────────────────────────────────────
//
// Given the model's raw completion text from a retrieved batch plus the stored
// pending-batch entry, run the IDENTICAL post-stream pipeline (narrator,
// findings extraction) and saveReport the result — same files, same sidecar,
// same PDF the streaming path would have produced. The only difference is the
// transport metadata block (method: 'batch'). Called by `ghost batch-retrieve`.
//
// Returns { saved, buffer }.
export async function retrieveBlastBatchResult(rawOutput, entry) {
  const ctx = (entry && entry.context) || {};

  // Reproduce the streamed report into a buffer (no stdout streaming on
  // retrieve — the report is read from the saved files, same as a live run).
  let buffer = '';
  await processBlastRawOutput(rawOutput, {
    targets:      ctx.targets,
    projectLabel: ctx.projectLabel,
    rates:        ctx.rates,
    profile:      ctx.profile || null,
    loadedFiles:  ctx.loadedFiles || 0,
    onChunk:      (chunk) => { buffer += chunk; },
  });

  // Same sidecar-findings derivation as the streaming save block.
  const parsedFindings = extractFindings(buffer);
  const criticalCount  = parsedFindings.filter(f => f.severity === 'CRITICAL').length;
  const highCount      = parsedFindings.filter(f => f.severity === 'HIGH').length;
  const mediumCount    = parsedFindings.filter(f => f.severity === 'MEDIUM').length;
  const lowCount       = parsedFindings.filter(f => f.severity === 'LOW').length;
  const totalHours     = parsedFindings.reduce((sum, f) => sum + (f.effortHours || 0), 0);

  const meta = {
    filesAnalyzed: ctx.totalFiles
      ? `${ctx.loadedFiles} of ${ctx.totalFiles}`
      : `${ctx.loadedFiles || 0}`,
    totalFiles:   ctx.totalFiles,
    profile:      ctx.profile || null,
    changeSet:    ctx.changeSet,
    targetCount:  ctx.targetCount,
    findings:     parsedFindings,
    findingCount: parsedFindings.length,
    critical:     criticalCount,
    high:         highCount,
    medium:       mediumCount,
    low:          lowCount,
    totalHours,
    // Transport metadata — this scan ran via the Message Batches API.
    transport:    buildBatchTransport({ submittedAt: entry && entry.submittedAt }),
  };

  const saved = await saveReport(buffer, 'ghost-blast', ctx.saveLabel || null, meta);
  return { saved, buffer };
}

function colorizeOutput(text) {
  return text
    .replace(/💥 DIRECT DEPENDENCIES/g, chalk.red.bold('💥 DIRECT DEPENDENCIES'))
    .replace(/🌊 RIPPLE EFFECTS/g, chalk.yellow.bold('🌊 RIPPLE EFFECTS'))
    .replace(/🧨 DANGER ZONES/g, chalk.red.bold('🧨 DANGER ZONES'))
    .replace(/✅ SAFE ZONES/g, chalk.green.bold('✅ SAFE ZONES'))
    .replace(/⚠️ BEFORE YOU TOUCH IT/g, chalk.yellow.bold('⚠️  BEFORE YOU TOUCH IT'))
    .replace(/🛠️ REMEDIATION PLAN/g, chalk.cyan.bold('🛠️  REMEDIATION PLAN'))
    .replace(/\bCRITICAL\b/g, chalk.bgRed.white.bold(' CRITICAL '))
    .replace(/\bHIGH\b/g, chalk.red.bold('HIGH'))
    .replace(/\bMEDIUM\b/g, chalk.yellow.bold('MEDIUM'))
    .replace(/\bLOW\b/g, chalk.green.bold('LOW'))
    .replace(/Estimated effort:/g, chalk.cyan('Estimated effort:'))
    .replace(/Recommended approach:/g, chalk.green.bold('Recommended approach:'))
    .replace(/Testing requirements:/g, chalk.yellow('Testing requirements:'))
    .replace(/Rollback plan:/g, chalk.yellow('Rollback plan:'));
}
