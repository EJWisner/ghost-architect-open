/**
 * Ghost Architect — Conflict Detection Mode (CLI layer)
 * Thin wrapper: handles all prompts and display for core/conflict.js
 */

import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { showFriendlyError } from '../utils/errors.js';
import { runConflictScan, getConflictPassInfo } from '../core/conflict.js';
import { normalizeCandidateToFinding } from '../core/conflict.js';
import { showCostEstimate, showConflictCost, SessionCostTracker } from '../estimator.js';
import { getConfig } from '../config.js';
import { saveReport, REPORTS_DIR } from '../reports.js';
import { loadFromPath } from '../loader/index.js';
import { runRecon, formatPlanForDisplay } from '../core/agent/planner.js';
import { promptProjectLabel } from '../projects.js';
import { requireTier } from '../license/tier-gates.js';
import { hasShownCallout, markCalloutShown } from '../cli/session-state.js';
// Static import: extractFindings is already used by sibling modes (poi.js,
// blast.js) so there's no module-loading novelty justifying the dynamic-import
// pattern audit-mode used for its newly-introduced findingsFromAuditResults.
// Idiomatic top-level; matches the Blast-sidecar wiring decision in commit
// 52e2782.
import { runFixForecast } from './fix-forecast-writer.js';

import { SYM, IS_WINDOWS } from '../cli/symbols.js';
import { offerUnsavedReport } from '../cli/unsaved-report.js';
import { createRequire } from 'module';
const _conflictRequire = createRequire(import.meta.url);
const { version: GHOST_VERSION } = _conflictRequire('../../package.json');

export async function runConflictMode(codebaseContext, options = {}) {
  // Ghost Partner — consultant profile (null when --profile was not passed).
  // Threaded through to runConflictScan (consultant lens in system prompt +
  // narrator) and through saveReport meta (white-label cover + chrome in
  // the PDF). Mirrors the runPOIMode and runBlastMode pattern.
  const profile = options.profile || null;

  // Tier resolution. Defaults to 'open' (fail-closed) so any caller that
  // forgets to pass tier does not leak the paid project-tracking feature.
  // bin/ghost.js is the single source of truth — it passes TIER (resolved
  // from active license at line 1311) into this options object. Mirrors
  // the prompt-triage Phase 2 adoption pattern from commit 2d813bb.
  const tier = options.tier || 'open';

  // D4 gate: project-tracking is Pro+ only. Wraps the label prompt below
  // so Open users skip labeling entirely, which keeps the label null
  // through to saveReport and short-circuits all four labeled-save
  // side-effect blocks (team-sync, mobile-publish, portal-publish, audit
  // log) in src/reports.js. Gate ID is shared with prompt-triage so D3
  // callout suppression spans both modes per session.
  const projectIntelGate = requireTier('feature:project-tracking', { tier });
  const projectIntelEnabled = projectIntelGate.allowed;

  const fileMap    = codebaseContext.fileMap || {};
  const projectLabel = (codebaseContext.fileIndex?.[0] || 'project')
    .split('/').slice(0, 2).join('-')
    .replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40) || 'conflict-default';
  const model      = getConfig().get('defaultModel') || 'claude-sonnet-4-6';
  const info       = getConflictPassInfo(fileMap, tier);
  const multiPass  = !info.singlePass;

  console.log('\n' + boxen(
    chalk.magenta.bold('⚡ CONFLICT DETECTION') + '\n' +
    chalk.gray(
      `Scanning ${codebaseContext.loadedFiles} files for contract conflicts,\n` +
      `schema mismatches, config key errors, and constant disagreements.`
    ) +
    (multiPass
      ? '\n' + chalk.yellow(`⚡ Large codebase — ${info.passes.length} passes required`)
      : '') +
    (profile ? '\n' + chalk.magenta(`👥 Ghost Partner profile: ${profile.name || profile.author || 'loaded'}`) : '') + '\n' +
    chalk.gray('Est. cost: ~' + '\u0024' + info.estCost + '  ·  Est. time: ~' + info.estMinutes + ' min'),
    { padding: 1, borderColor: 'magenta', borderStyle: 'round' }
  ));
  console.log('');

  if (info.singlePass) {
    // Pass 'conflict' as mode so the cost estimator label says
    // 'Conflict Detection' instead of the copy-pasted 'Points of
    // Interest Scan' default that this mode inherited from POI.
    showCostEstimate(codebaseContext, 'conflict', model);
  }

  // ── Cost tracker — created here so planner (plan stage) can record into it ──
  const tracker = new SessionCostTracker();

  // ── Agent Planner ─────────────────────────────────────────────────────────
  try {
    const reconSpinner = ora({ text: chalk.gray('Ghost is sizing up your codebase...'), color: 'magenta' }).start();
    const reconPlan    = await runRecon(fileMap, 'conflict', {
      onUsage: (i, o, m) => tracker.record('plan', i, o, m),
    });
    reconSpinner.stop();
    const display = formatPlanForDisplay(reconPlan);

    console.log('\n' + boxen(
      chalk.magenta.bold('🔍 ANALYSIS PLAN') + '\n\n' +
      chalk.white(display.summary || '') + '\n\n' +
      chalk.gray('Files:   ') + chalk.bold(String(display.stats.files)) + '   ' +
      chalk.gray('Passes:  ') + chalk.bold(String(display.stats.passes)) + '   ' +
      chalk.gray('Est. cost: ') + chalk.bold(display.stats.cost) + '   ' +
      chalk.gray('Est. time: ') + chalk.bold(display.stats.time) +
      (display.risks.length > 0
        ? '\n\n' + chalk.yellow.bold('⚠  High-risk areas:') + '\n' +
          display.risks.slice(0, 4).map(r => chalk.yellow(`   • ${r}`)).join('\n')
        : '') +
      (display.warnings.length > 0
        ? '\n\n' + chalk.yellow.bold('!  Warnings:') + '\n' +
          display.warnings.map(w => chalk.yellow(`   ${w}`)).join('\n')
        : '') +
      (display.entryPoint
        ? '\n\n' + chalk.gray('Starting at: ') + chalk.magenta(display.entryPoint)
        : ''),
      { padding: 1, borderColor: 'magenta', borderStyle: 'round' }
    ));
    console.log('');
  } catch {
    console.log(chalk.gray('  (Recon unavailable — proceeding with standard scan)\n'));
  }

  // Smart project label prompt — same UX as POI/Blast/Recon/Audit. The label
  // is what groups Conflict scans with the rest of a project's history on
  // the portal, in team-sync, and in mobile-publish. Gated on Pro+ per D4:
  // Open users get unlabeled saves (bare-filename via saveReport's no-label
  // branch), no project-tracking machinery fires.
  let label = null;
  if (projectIntelEnabled) {
    label = await promptProjectLabel();
    console.log('');
  } else if (!hasShownCallout('feature:project-tracking')) {
    // D3 soft-gate callout: one line, once per session, gentle. Open users
    // still get the full conflict scan and saved report — this just signals
    // what they'd gain on Pro (label-driven baselines, comparison, velocity).
    // Shared gate ID with prompt-triage so a user who runs both modes in one
    // ghost invocation sees the callout exactly once across them.
    console.log(chalk.cyan('💡 Project tracking available on Pro. Scans run as one-shots on Open.'));
    console.log('');
    markCalloutShown('feature:project-tracking');
  }

  const { proceed } = await inquirer.prompt([{
    type: 'confirm', name: 'proceed',
    message: chalk.cyan('Run conflict detection?'), default: true
  }]);
  if (!proceed) { console.log(chalk.gray('\nCancelled.\n')); return; }



  let buffer  = '';
  let spinner = null;

  // Bridging spinner — covers the gap between "Run conflict detection? Yes"
  // and the first onProgress event from runConflictScan. Without this the
  // terminal sits silent for 30-60+ seconds while the model prepares the
  // first pass. The very first onProgress event will stop and replace
  // this spinner.
  spinner = ora({ text: chalk.gray('  Ghost is starting the conflict scan...'), color: 'magenta' }).start();

  try {
    const callbacks = {
      onChunk(text) {
        // Pure buffer-only — do NOT toggle spinner state on first chunk.
        // Why: when the narrator's API stream starts emitting tokens, we
        // want the "Ghost is writing the conflict report..." spinner to
        // KEEP SPINNING for the entire 30-60 second narration. Stopping
        // it on first chunk creates dead air for the rest of the stream
        // because we don't write the chunks to stdout (white-label safety).
        // Only the 'done' progress event stops the spinner.
        buffer += text;
      },

      onProgress({ type, ...data }) {
        switch (type) {
          case 'start':
            // Stop the bridging spinner first so we don't stack two
            // spinners. The bridging spinner was started in runConflictMode
            // immediately after "Run conflict detection? Yes" to cover the
            // gap before this event fires.
            if (spinner) { spinner.stop(); spinner = null; }
            if (data.singlePass) {
              spinner = ora({ text: chalk.gray('Ghost is scanning for conflicts...'), color: 'magenta' }).start();
            }
            break;

          case 'passStart': {
            // Start a per-pass spinner so the user sees activity while the
            // model is thinking. Without this, the terminal sits silent on
            // a static "Pass N of M" line for ~30-60s and looks hung.
            // Stop any prior spinner first (defensive — passComplete should
            // already have stopped it).
            if (spinner) { spinner.stop(); spinner = null; }
            const passLabel = `  Pass ${data.passNum} of ${data.totalPasses} — ` +
              `${data.fileCount} files (~${data.tokens.toLocaleString()} tokens)...`;
            spinner = ora({ text: chalk.gray(passLabel), color: 'magenta' }).start();
            break;
          }

          case 'passComplete':
            // Stop the per-pass spinner before printing the green checkmark.
            if (spinner) { spinner.stop(); spinner = null; }
            console.log(chalk.green(`  ${SYM.check} Pass ${data.passNum} complete`));
            break;

          case 'resuming':
            console.log(chalk.magenta(
              `\n  ⚡ Resuming from Pass ${data.fromPass + 1} of ${data.totalPasses} — prior passes restored.\n`
            ));
            break;

          case 'candidates_found':
            if (spinner) spinner.stop();
            console.log(chalk.cyan(`\n  🔍 ${data.count} conflict candidates found — running verification...\n`));
            break;

          case 'verification_start':
            console.log(chalk.gray(`  Verifying ${data.count} candidates against codebase...`));
            break;

          case 'verifying':
            process.stdout.write(chalk.gray(`  ⟳  Verifying: ${data.title.slice(0, 60)}...\r`));
            break;

          case 'verified': {
            const icon =
              data.verdict === 'CONFIRMED'      ? chalk.red('  ' + SYM.cross + '  CONFIRMED') :
              data.verdict === 'POSSIBLE'        ? chalk.yellow('  ?  POSSIBLE ') :
              data.verdict === 'FALSE_POSITIVE'  ? chalk.green('  ' + SYM.check + '  ELIMINATED') :
                                                   chalk.gray('  ~  UNCLEAR  ');
            console.log(`${icon}  ${chalk.gray(data.title.slice(0, 55))}`);
            break;
          }

          case 'verification_done':
            console.log('');
            console.log(
              chalk.bold('  Verification complete: ') +
              chalk.red(`${data.stats.confirmed} confirmed  `) +
              chalk.yellow(`${data.stats.possible} possible  `) +
              chalk.green(`${data.stats.falsePositives} eliminated`)
            );
            console.log('');
            // Start the narrator-anticipation spinner IMMEDIATELY after
            // printing verification stats. Without this, the gap between
            // "Verification complete" and the 'narrating' event firing
            // (~1-3 seconds of prompt assembly + first-token latency)
            // looks like dead air. The spinner is updated (or replaced)
            // when 'narrating' fires.
            if (spinner) { spinner.stop(); spinner = null; }
            spinner = ora({ text: chalk.gray('  Preparing conflict report...'), color: 'magenta' }).start();
            break;

          case 'narrating':
            // Update the spinner text now that the narrator is actually
            // streaming. Replace cleanly to avoid spinner-frame artifacts.
            if (spinner) { spinner.stop(); spinner = null; }
            spinner = ora({ text: chalk.gray('  Ghost is writing the conflict report...'), color: 'magenta' }).start();
            break;

          case 'merging':
            console.log(chalk.gray(`\n  🔀 Merging ${data.count} passes into final report...`));
            break;

          case 'done':
            if (spinner) { spinner.stop(); spinner = null; }
            console.log('');
            break;
        }
      },

      async onVerifyPrompt({ count, quickCost, fullCost }) {
        console.log(chalk.cyan(
          `\n  🔍 ${count} conflict candidates found\n`
        ));
        console.log(chalk.gray(
          `     Quick verify: ~$${quickCost}  ~${Math.ceil(count * 3 / 60)} min\n` +
          `     Full verify:  ~$${fullCost}  ~${Math.ceil(count * 10 / 60)} min\n`
        ));
        const { choice } = await inquirer.prompt([{
          type: 'list', name: 'choice',
          message: chalk.cyan('Choose verification depth:'),
          choices: [
            { name: `Quick  — fast scan, surfaces candidates for review  (~$${quickCost})`, value: 'quick' },
            { name: `Full   — deep agent verification per candidate       (~$${fullCost})`,  value: 'full' },
            { name: `Skip   — no verification, surface all as manual review ($0)`,            value: 'skip' },
          ],
        }]);
        return choice;
      },

      async onSessionPrompt({ session, totalPasses }) {
        const pct = Math.round((session.completedPassCount / totalPasses) * 100);
        console.log(chalk.cyan(`\n📂  Saved session: ${session.projectLabel} — ${session.completedPassCount}/${totalPasses} passes (${pct}% coverage)\n`));
        const { action } = await inquirer.prompt([{
          type: 'list', name: 'action',
          message: chalk.cyan('What would you like to do?'),
          choices: [
            { name: `Continue from pass ${session.completedPassCount + 1}`, value: 'resume'  },
            { name: 'Generate report from completed passes now',              value: 'report'  },
            { name: 'Restart from scratch',                                   value: 'restart' },
          ],
        }]);
        if (action === 'report') console.log(chalk.cyan('\n  🧠 Generating report from completed passes...\n'));
        return action;
      },
    };

    const result = await runConflictScan(fileMap, callbacks, { projectLabel: label || projectLabel, profile, tier, tracker });

    if (!result?.finalReport) return;
    buffer = result.finalReport;

    // Show verification stats summary if available
    if (result.verified && result.stats) {
      const s = result.stats;
      console.log(chalk.magenta(
        `  👻 Agent verified ${s.total} candidates -- ` +
        `${s.confirmed} confirmed, ${s.possible} possible, ${s.falsePositives} low-signal findings filtered\n`
      ));
    }

    // Cost — show real per-stage breakdown from the tracker (replaces
    // the old character-count estimate that was 17x under the actual charge)
    showConflictCost(result.tracker || tracker);

    // Save prompt
    const { doSave } = await inquirer.prompt([{
      type: 'confirm', name: 'doSave',
      message: chalk.cyan('Save this conflict report to ~/Ghost Architect Reports/?'), default: true
    }]);

    if (doSave) {
      // Sidecar findings: parse the report into structured findings so the
      // .findings.json sidecar carries real severity counts and effort
      // estimates instead of the all-MEDIUM placeholder buildFindingsSidecar
      // produces when called on raw report text. Same architectural pattern
      // as audit-mode (c2aeaad + dc352b0) and Blast-mode (52e2782).
      // Use normalized candidates as structured findings — bypasses extractFindings
      // round-trip so fix_direction survives. All parity fields match sidecar output.
      // detail = candidate.description (pre-narration; more faithful, less polished).
      const parsedFindings = (result.candidates || []).map(normalizeCandidateToFinding);
      const criticalCount  = parsedFindings.filter(f => f.severity === 'CRITICAL').length;
      const highCount      = parsedFindings.filter(f => f.severity === 'HIGH').length;
      const mediumCount    = parsedFindings.filter(f => f.severity === 'MEDIUM').length;
      const lowCount       = parsedFindings.filter(f => f.severity === 'LOW').length;
      const totalHours     = parsedFindings.reduce((sum, f) => sum + (f.effortHours || 0), 0);

      // Meta drives PDF chrome and markdown branding. The `profile` field
      // is what flips PDF rendering into white-label mode — saveReport
      // calls getBranding(meta.profile) and threads the result into the
      // PDF generator. When profile is null, default Ghost branding renders.
      const meta = {
        filesAnalyzed: `${codebaseContext.loadedFiles} of ${codebaseContext.totalFiles}`,
        totalFiles: codebaseContext.totalFiles,
        cost: (result.tracker || tracker).totalCost.toFixed(4),
        version: GHOST_VERSION,   // was a hardcoded '4.1.1'
        mode: 'conflict-detection',
        verified: result.verified || false,
        verificationStats: result.stats || null,
        profile,
        // Sidecar findings — reports.js Strategy 2 conditional (commit
        // dc352b0) consumes meta.findings when present. Without these,
        // the .findings.json sidecar would default to all-MEDIUM
        // placeholder entries from parsing report markdown headers.
        // Note: verificationStats (CONFIRMED/POSSIBLE/FALSE_POSITIVE) is
        // an orthogonal classification signal — distinct from severity
        // and effortHours. Downstream consumers could fold it into
        // sidecar finding objects later as an additional dimension.
        findings:     parsedFindings,
        findingCount: parsedFindings.length,
        critical:     criticalCount,
        high:         highCount,
        medium:       mediumCount,
        low:          lowCount,
        totalHours,
      };
      const saved = await saveReport(buffer, 'ghost-conflict', label, meta);
      console.log(chalk.green(`\n${SYM.check} Conflict report saved to ~/Ghost Architect Reports/`));
      console.log(chalk.gray(`  📄 ${saved.txtFile}`));
      console.log(chalk.gray(`  📋 ${saved.mdFile}`));
      if (saved.pdfFile) console.log(chalk.magenta(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
      console.log('');

      // Phase 4 → Phase 5: offer fix forecast follow-up.
      // Delegated to runPostScanFixForecast — single source of truth for
      // the checkbox + cost-gate + H3 re-forecast protection + serial loop.
      await runPostScanFixForecast(parsedFindings, codebaseContext, { tier, profile });
    } else {
      // There was no else branch here at all: declining the save prompt printed
      // nothing and dropped the buffer, silently destroying a report the user
      // had already been billed for. Offer to print it.
      // See src/cli/unsaved-report.js.
      await offerUnsavedReport(buffer, { prefix: 'ghost-conflict' });
    }

  } catch (err) {
    if (spinner) spinner.stop();
    showFriendlyError(err);
  }
}

// ── Severity label renderer — matches colorizeOutput palette ─────────────────
function severityLabel(sev) {
  const s = (sev || 'UNKNOWN').toUpperCase();
  if (s === 'CRITICAL') return chalk.bgRed.white.bold(' CRITICAL ');
  if (s === 'HIGH')     return chalk.red.bold('HIGH    ');
  if (s === 'MEDIUM')   return chalk.yellow.bold('MEDIUM  ');
  if (s === 'LOW')      return chalk.green.bold('LOW     ');
  return chalk.gray(s.padEnd(8));
}

// ── Phase 4: Follow-up fix forecast offer ────────────────────────────────────
// Offered after a Conflict scan saves successfully.
// Filters findings to those with a populated suggestedFix field.
// Silent-skips when zero eligible findings exist — no output, no prompt.
//
// forecasted: Set of finding IDs already run this session. Findings in
// forecasted are marked "[✓ forecasted]" in the checkbox list.
//
// Returns an array of selected finding objects (may be empty).
async function promptFixForecast(findings, forecasted = new Set()) {
  if (!findings || findings.length === 0) return [];

  const eligible = findings.filter(f => f.fix_direction);
  if (eligible.length === 0) {
    console.log(chalk.yellow('No findings with suggested fixes available.'));
    return [];
  }

  // Print summary of all eligible findings before checkbox appears
  console.log(chalk.cyan('\n  Eligible findings for Fix Forecast:\n'));
  eligible.forEach((f, i) => {
    const files = (f.files || []).slice(0, 2).join(', ') + ((f.files || []).length > 2 ? ` +${f.files.length - 2} more` : '');
    console.log(
      `  ${chalk.bold(`[${i + 1}]`)}  ${severityLabel(f.severity)}  ${chalk.white(f.title)}`
    );
    if (files) {
      console.log(`       ${chalk.gray(files)}`);
    }
  });
  console.log('');

  const { chosen } = await inquirer.prompt([{
    type:    'checkbox',
    name:    'chosen',
    message: chalk.cyan('Select findings to forecast (space to toggle, enter to confirm):'),
    choices: eligible.map((f, i) => {
      const doneMark = forecasted.has(f.id) ? chalk.green(' [✓ forecasted]') : '';
      return {
        name:  `  [${i + 1}]  ${severityLabel(f.severity)}  ${f.title}${doneMark}`,
        value: f,
      };
    }),
  }]);

  return chosen; // array, may be empty
}

function colorizeOutput(text) {
  return text
    .replace(/🔀 CONTRACT CONFLICTS/g,   chalk.blue.bold('🔀 CONTRACT CONFLICTS'))
    .replace(/🗄️ SCHEMA CONFLICTS/g,     chalk.yellow.bold('🗄️  SCHEMA CONFLICTS'))
    .replace(/⚙️ CONFIG CONFLICTS/g,      chalk.cyan.bold('⚙️  CONFIG CONFLICTS'))
    .replace(/🔢 CONSTANT CONFLICTS/g,   chalk.green.bold('🔢 CONSTANT CONFLICTS'))
    .replace(/📦 DEPENDENCY CONFLICTS/g, chalk.red.bold('📦 DEPENDENCY CONFLICTS'))
    .replace(/🧩 INTERFACE CONFLICTS/g,  chalk.magenta.bold('🧩 INTERFACE CONFLICTS'))
    .replace(/⚡ CONFLICT SUMMARY/g,     chalk.magenta.bold('⚡ CONFLICT SUMMARY'))
    .replace(/CONFIRMED/g,  chalk.red.bold('CONFIRMED'))
    .replace(/POSSIBLE/g,   chalk.yellow.bold('POSSIBLE'))
    .replace(/CRITICAL/g,   chalk.bgRed.white.bold(' CRITICAL '))
    .replace(/\bHIGH\b/g,   chalk.red.bold('HIGH'))
    .replace(/\bMEDIUM\b/g, chalk.yellow.bold('MEDIUM'))
    .replace(/\bLOW\b/g,    chalk.green.bold('LOW'))
    .replace(/Resolution:/g, chalk.green.bold('Resolution:'))
    .replace(/Impact:/g,     chalk.yellow('Impact:'))
    .replace(/Severity:/g,   chalk.cyan('Severity:'));
}

// ── Shared Fix Forecast execution: checkbox + cost-gate + H3 + serial run ────
// Called by runConflictMode (post-scan), runSavedFixForecast (standalone menu),
// and runCommitForecastMode (after Commit Forecast conflict scan).
// Keeps all Fix Forecast prompt logic in one place — single source of truth.
//
// parsedFindings  — array of normalized findings (must have fix_direction field)
// codebaseContext — real loaded context ({ fileMap, loadedFiles, ... })
// opts            — { tier, profile }
export async function runPostScanFixForecast(parsedFindings, codebaseContext, opts = {}) {
  const { tier, profile } = opts;
  const forecasted = new Set();
  let selectedFindings = await promptFixForecast(parsedFindings, forecasted);

  while (selectedFindings.length > 0) {
    const count = selectedFindings.length;
    const estimatedCost = (count * 1.31).toFixed(2);

    const { confirmed } = await inquirer.prompt([{
      type:    'confirm',
      name:    'confirmed',
      message: chalk.cyan(`You selected ${count} finding${count === 1 ? '' : 's'}. Estimated cost ~$${estimatedCost}. Continue?`),
      default: true,
    }]);

    if (confirmed) {
      const alreadyForecasted = selectedFindings.filter(f => forecasted.has(f.id));

      if (alreadyForecasted.length > 0) {
        const names = alreadyForecasted.map(f => chalk.yellow(f.title)).join(', ');
        console.log(chalk.yellow(`\n${alreadyForecasted.length} finding${alreadyForecasted.length === 1 ? '' : 's'} already forecasted: ${names}`));

        const { runRepeats } = await inquirer.prompt([{
          type:    'confirm',
          name:    'runRepeats',
          message: chalk.yellow('Run them again?'),
          default: false,
        }]);

        if (!runRepeats) {
          selectedFindings = selectedFindings.filter(f => !forecasted.has(f.id));
          console.log(chalk.cyan(`Proceeding with ${selectedFindings.length} finding${selectedFindings.length === 1 ? '' : 's'}.`));
        }
      }

      break;
    }

    selectedFindings = await promptFixForecast(parsedFindings, forecasted);
  }

  if (selectedFindings.length > 0) {
    const results = [];
    for (const finding of selectedFindings) {
      const result = await runFixForecast(finding, codebaseContext, { tier, profile, label: null });
      forecasted.add(finding.id);
      if (result) results.push(result);
    }

    // Combined report — only when N >= 2
    if (selectedFindings.length === 1) {
      console.log(chalk.gray('\n  No combined report generated — only one finding was forecasted.\n'));
    } else if (results.length >= 2) {
      const hasForecasts = results.some(r => r.conflictBuffer);
      if (hasForecasts) {
        const generatedAt = new Date().toLocaleString();
        const sections = results.map((r, i) => {
          const header = `## Finding ${i + 1}: ${r.findingTitle || 'Untitled'} (${r.findingSeverity || 'MEDIUM'})`;
          const body = r.conflictBuffer || '_No impact forecast generated for this finding._';
          return `${header}\n\n${body}`;
        });

        const combinedContent = [
          `# Fix Forecast — Combined Report`,
          `Generated: ${generatedAt}`,
          `Findings forecasted: ${results.length}`,
          ``,
          `---`,
          ``,
          ...sections.flatMap(s => [s, `\n---\n`]),
        ].join('\n');

        const combinedMeta = {
          mode:        'fix-forecast',
          profile,
          fixForecast: true,
        };

        try {
          const saved = await saveReport(combinedContent, 'ghost-fix-forecast-combined', null, combinedMeta);
          console.log(chalk.green(`\n  ${SYM.check} Combined report saved:`));
          console.log(chalk.gray(`    📄 ${saved.txtFile}`));
          console.log(chalk.gray(`    📋 ${saved.mdFile}`));
          if (saved.pdfFile) console.log(chalk.gray(`    📑 ${saved.pdfFile}  ← client-ready PDF`));
          console.log('');
        } catch (err) {
          console.log(chalk.yellow(`  ${SYM.warn}  Failed to save combined report: ${err.message}`));
        }
      } else {
        console.log(chalk.yellow('\n  No combined report generated — no impact forecasts completed successfully.\n'));
      }
    }
  }
}

// ── Standalone Fix Forecast: load saved findings and run promptFixForecast ───
// Exported so bin/ghost.js can call it as a top-level menu mode.
// Does NOT require a live codebase context — reads from a saved findings JSON.
export async function runSavedFixForecast({ tier, profile, codebaseContext: providedContext } = {}) {
  // 1. Glob all _findings.json files from the reports directory.
  const reportsDir = REPORTS_DIR || path.join(os.homedir(), 'Ghost Architect Reports');
  let allFiles;
  try {
    allFiles = fs.readdirSync(reportsDir);
  } catch {
    console.log(chalk.yellow('\nNo saved reports directory found. Run a Conflict Detection scan first.\n'));
    return;
  }

  // 2. Filter to conflict findings JSONs only.
  const findingsFiles = allFiles
    .filter(f => f.startsWith('ghost-conflict-') && f.endsWith('.findings.json'))
    .map(f => path.join(reportsDir, f));

  if (findingsFiles.length === 0) {
    console.log(chalk.yellow('\nNo saved conflict findings found. Run a Conflict Detection scan first.\n'));
    return;
  }

  // 3. Parse each file: extract project name, timestamp, eligible count.
  //    Two filename patterns:
  //      Labeled:  ghost-conflict-<project>-<YYYY>-<MM>-<DD>T<HH>-<MM>-<SS>.findings.json
  //      No-label: ghost-conflict-<YYYY>-<MM>-<DD>T<HH>-<MM>-<SS>.findings.json
  //    The project prefix is optional — when absent, display as "one-time scan".
  const parsed = [];
  for (const filePath of findingsFiles) {
    const base = path.basename(filePath, '.findings.json');
    // Strip leading "ghost-conflict-"
    const rest = base.slice('ghost-conflict-'.length);
    // Match optional project prefix followed by the ISO-ish timestamp segment.
    // Group 1: project slug (may be empty for no-label files)
    // Group 2: timestamp "YYYY-MM-DDTHH-MM-SS"
    const dateMatch = rest.match(/^(?:(.*?)-)?(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/);
    if (!dateMatch) continue;

    const project   = dateMatch[1] || 'one-time scan';
    const isoRaw    = dateMatch[2]; // e.g. "2026-06-01T13-33-33"
    // Convert time separators: "2026-06-01T13-33-33" → "2026-06-01T13:33:33"
    const isoStr    = isoRaw.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
    const date      = new Date(isoStr + 'Z'); // treat as UTC (matches filename convention)

    // Count eligible findings
    let eligibleCount = 0;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const findings = raw.findings || [];
      eligibleCount = findings.filter(f => f.fix_direction && typeof f.fix_direction === 'object').length;
    } catch {
      // Unreadable file — skip
      continue;
    }

    parsed.push({ filePath, project, date, eligibleCount });
  }

  if (parsed.length === 0) {
    console.log(chalk.yellow('\nNo readable conflict findings files found.\n'));
    return;
  }

  // 4. Sort newest-first.
  parsed.sort((a, b) => b.date - a.date);

  // 5. Format display labels.
  const choices = parsed.map(({ filePath, project, date, eligibleCount }) => {
    const dateLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const timeLabel = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    const eligibleLabel = eligibleCount === 0
      ? chalk.gray('(0 eligible findings)')
      : chalk.cyan(`(${eligibleCount} eligible finding${eligibleCount === 1 ? '' : 's'})`);
    return {
      name:  `  ${project} — ${dateLabel} ${timeLabel}  ${eligibleLabel}`,
      value: filePath,
    };
  });
  choices.push(new inquirer.Separator());
  choices.push({ name: chalk.gray('  Cancel'), value: null });

  // 6. Show selection prompt.
  console.log('');
  const { selectedFile } = await inquirer.prompt([{
    type:    'list',
    name:    'selectedFile',
    message: chalk.cyan('Select a saved conflict scan to load:'),
    choices,
  }]);

  if (!selectedFile) {
    console.log(chalk.gray('\nCancelled.\n'));
    return;
  }

  // 7. Load and parse selected findings JSON.
  let findings;
  try {
    const raw = JSON.parse(fs.readFileSync(selectedFile, 'utf8'));
    findings = raw.findings || [];
  } catch (err) {
    console.log(chalk.red(`\nFailed to load findings file: ${err.message}\n`));
    return;
  }

  if (findings.length === 0) {
    console.log(chalk.yellow('\nNo findings in selected file.\n'));
    return;
  }

  // 8. Resolve codebase context — validate providedContext before trusting it.
  // The session context may have a fileMap truncated by the token cap, missing
  // target files that were in the scan. If none of the eligible findings' target
  // files match any key in providedContext.fileMap, fall back to prompting.
  let codebaseContext = null;

  if (providedContext && Object.keys(providedContext.fileMap || {}).length > 0) {
    const eligibleFindings = findings.filter(f => f.fix_direction);
    const allTargetFiles = eligibleFindings.flatMap(f =>
      (f.fix_direction?.target_files || [])
    );
    const hasMatch = allTargetFiles.some(target => {
      const normalized = target.split(/[\\/]/).join('/');
      return Object.keys(providedContext.fileMap).some(k =>
        k.split(/[\\/]/).join('/') === normalized
      );
    });
    if (hasMatch) {
      codebaseContext = providedContext;
    }
  }

  if (!codebaseContext) {
    console.log(chalk.gray('\nFix Forecast needs to read the codebase files to generate a corrected version.'));
    const { codebasePath } = await inquirer.prompt([{
      type:     'input',
      name:     'codebasePath',
      message:  chalk.cyan('Path to codebase directory:'),
      validate: (v) => v.trim().length > 0 || 'Path is required',
    }]);

    try {
      codebaseContext = await loadFromPath(codebasePath.trim());
    } catch (err) {
      console.log(chalk.red(`\nFailed to load codebase: ${err.message}\n`));
      return;
    }

    if (!codebaseContext || Object.keys(codebaseContext.fileMap || {}).length === 0) {
      console.log(chalk.yellow('\nNo files found in the specified directory.\n'));
      return;
    }

    console.log(chalk.green(`\n  ${SYM.check} Loaded ${codebaseContext.loadedFiles} files from ${codebasePath.trim()}\n`));
  }

  // 9. Run Fix Forecast — checkbox, cost-gate, H3 re-forecast protection, serial execution.
  await runPostScanFixForecast(findings, codebaseContext, { tier, profile });
}
