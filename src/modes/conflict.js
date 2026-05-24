/**
 * Ghost Architect — Conflict Detection Mode (CLI layer)
 * Thin wrapper: handles all prompts and display for core/conflict.js
 */

import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import { showFriendlyError } from '../utils/errors.js';
import { runConflictScan, getConflictPassInfo } from '../core/conflict.js';
import { showCostEstimate, showActualCost } from '../estimator.js';
import { getConfig } from '../config.js';
import { saveReport } from '../reports.js';
import { runRecon, formatPlanForDisplay } from '../core/agent/planner.js';
import { promptProjectLabel } from '../projects.js';
import { requireTier } from '../license/tier-gates.js';
import { hasShownCallout, markCalloutShown } from '../cli/session-state.js';
// Static import: extractFindings is already used by sibling modes (poi.js,
// blast.js) so there's no module-loading novelty justifying the dynamic-import
// pattern audit-mode used for its newly-introduced findingsFromAuditResults.
// Idiomatic top-level; matches the Blast-sidecar wiring decision in commit
// 52e2782.
import { extractFindings } from '../utils/finding-parser.js';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };

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
  const model      = getConfig().get('defaultModel') || 'claude-sonnet-4-5';
  const info       = getConflictPassInfo(fileMap);
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

  // ── Agent Planner ─────────────────────────────────────────────────────────
  try {
    const reconSpinner = ora({ text: chalk.gray('Ghost is sizing up your codebase...'), color: 'magenta' }).start();
    const reconPlan    = await runRecon(fileMap, 'conflict', {});
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

    const result = await runConflictScan(fileMap, callbacks, { projectLabel: label || projectLabel, profile });

    if (!result?.finalReport) return;
    buffer = result.finalReport;

    // Show verification stats summary if available
    if (result.verified && result.stats) {
      const s = result.stats;
      console.log(chalk.magenta(
        `  👻 Agent verified ${s.total} candidates — ` +
        `${s.confirmed} confirmed, ${s.possible} possible, ${s.falsePositives} false positives eliminated\n`
      ));
    }

    // Cost
    const inputTokens  = Math.ceil(codebaseContext.context.length / 4) + 200;
    const outputTokens = Math.ceil(buffer.length / 4);
    showActualCost(inputTokens, outputTokens, model);

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
      const parsedFindings = extractFindings(buffer);
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
        cost: '\u0024' + (inputTokens * 0.000003 + outputTokens * 0.000015).toFixed(4),
        version: '4.1.1',
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
    }

  } catch (err) {
    if (spinner) spinner.stop();
    showFriendlyError(err);
  }
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
