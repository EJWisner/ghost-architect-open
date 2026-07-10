import { showFriendlyError } from '../utils/errors.js';
import { SYM, IS_WINDOWS } from '../cli/symbols.js';
import { offerUnsavedReport } from '../cli/unsaved-report.js';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import { runPOIScan } from '../analyst/index.js';
import { buildPasses } from '../analyst/multipass.js';
import { runMultiPassPOI } from '../core/multipass.js';
import { beginUsageCapture, endUsageCapture } from '../core/usage-tracker.js';
import { showCostEstimate, showActualCost, calcActualCost } from '../estimator.js';
import { createRequire } from 'module';
const _poiRequire = createRequire(import.meta.url);
const { version: GHOST_VERSION } = _poiRequire('../../package.json');
import { getConfig } from '../config.js';
import { saveReport } from '../reports.js';
import { handleProjectIntelligence, promptProjectLabel } from '../projects.js';
import { requireTier } from '../license/tier-gates.js';
import { hasShownCallout, markCalloutShown } from '../cli/session-state.js';
import { runRecon, formatPlanForDisplay } from '../core/agent/planner.js';
import { mergeRates } from '../profile/index.js';

export async function runPOIMode(codebaseContext, options = {}) {
  // Ghost Partner — consultant profile (null when --profile was not passed).
  const profile = options.profile || null;

  // Tier resolution. Defaults to 'open' (fail-closed) so any caller that
  // forgets to pass tier does not leak the paid project-tracking feature.
  // bin/ghost.js is the single source of truth — it passes TIER (resolved
  // from active license at line 1311) into this options object. Mirrors
  // the Phase 2 adoption pattern from commits 2d813bb (prompt-triage),
  // 5cfe7db (conflict), b38c0cb (blast), 2ff4cc6 (chat).
  const tier = options.tier || 'open';

  // D4 gate: project-tracking is Pro+ only. POI has THREE D4 leak
  // surfaces, all naturally gated by `if (label)` checks downstream:
  //   1. handleProjectIntelligence at line ~301 (gated by `if (label)` at ~295)
  //      — writes project-tracking state (project.json, baseline snapshots,
  //      comparison data) to ~/Ghost Architect Reports/projects/{slug}/.
  //      This is the unique D4 surface no prior Phase 2 cycle had.
  //   2. saveReport's four `if (label && isXConfigured())` side-effect
  //      blocks (team-sync, mobile-publish, portal-publish, audit log) at
  //      the saveReport call ~line 428. Same shape as conflict (5cfe7db).
  //   3. publishProject fallback at ~line 442 (gated by `else if (label)`
  //      at ~434, further gated by `if (isPublishConfigured())` at ~437).
  //      The "user declined local save but we still publish to mobile if
  //      configured" path — a leak surface no prior cycle had.
  // When projectIntelEnabled is false on Open, label stays null through to
  // all three sites and they short-circuit cleanly without further changes.
  // No saveLabel-fallback fix needed here (unlike blast b38c0cb and chat
  // 2ff4cc6 which had synthetic fallbacks — `change-set-N-files` and
  // `'conversation'` respectively) because POI passes raw `label`
  // everywhere. The label-gate at the top of this function is the ONE
  // intervention. Gate ID is shared with prompt-triage, conflict, blast,
  // and chat (five modes coalesce D3 callout to one display per ghost
  // invocation).
  //
  // Internal-scan keying note: the `label || 'project'` fallbacks at lines
  // ~105 (multipass sessionKey) and ~281 (single-pass projectLabel option)
  // are deliberately NOT gated. They feed scan internals (session-resume
  // checkpoint keying for multipass orchestration; analyst scan tracking)
  // and never reach saveReport's labeled-save machinery. Same architectural
  // role as conflict's projectLabel arg to runConflictScan.
  const projectIntelGate = requireTier('feature:project-tracking', { tier });
  const projectIntelEnabled = projectIntelGate.allowed;

  const fileMap      = codebaseContext.fileMap || {};
  const passes       = Object.keys(fileMap).length > 0 ? buildPasses(fileMap) : [];
  const useMultiPass = passes.length > 1;
  const model        = getConfig().get('defaultModel') || 'claude-sonnet-4-6';
  // Rates shown in the scan banner reflect what the report itself will
  // use, so per-profile rate overrides apply here too. Without this, an
  // OSC scan would show $85/$125/$200 in the banner but render the
  // report with $50/$90/$150 — the user-visible numbers would
  // disagree with the saved report.
  const rates = mergeRates({
    junior: getConfig().get('rateJunior') || 85,
    mid:    getConfig().get('rateMid')    || 125,
    senior: getConfig().get('rateSenior') || 200,
  }, profile);

  const ratesLine = 'Rates: $' + rates.junior + '/hr junior \u00b7 $' + rates.mid + '/hr mid \u00b7 $' + rates.senior + '/hr senior';

  console.log('\n' + boxen(
    chalk.cyan.bold('🗺  POINTS OF INTEREST SCAN') + '\n' +
    chalk.gray(`Analyzing ${codebaseContext.loadedFiles} files for red flags, landmarks,\ndead zones, fault lines, effort estimates, and remediation steps...`) +
    (useMultiPass ? '\n' + chalk.yellow(`⚡ Large codebase: multi-pass mode (${passes.length} passes required)`) : '') + '\n' +
    chalk.gray(ratesLine) +
    (profile ? '\n' + chalk.magenta(`👥 Ghost Partner profile: ${profile.name || profile.author || 'loaded'}`) : ''),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  if (!useMultiPass) showCostEstimate(codebaseContext, 'poi', model);

  // ── Agent Planner — recon + cost estimate before any analysis ──────────────
  let reconPlan = null;
  try {
    const reconSpinner = ora({ text: chalk.gray('Ghost is sizing up your codebase...'), color: 'cyan' }).start();
    reconPlan = await runRecon(fileMap, 'poi', {});
    reconSpinner.stop();

    const display = formatPlanForDisplay(reconPlan);

    console.log('\n' + boxen(
      chalk.cyan.bold('🔍 ANALYSIS PLAN') + '\n\n' +
      chalk.white(display.summary || '') + '\n\n' +
      chalk.gray('Files:   ') + chalk.bold(String(display.stats.files)) + '   ' +
      chalk.gray('Passes:  ') + chalk.bold(String(display.stats.passes)) + '   ' +
      chalk.gray('Est. cost: ') + chalk.bold(display.stats.cost) + '   ' +
      chalk.gray('Est. time: ') + chalk.bold(display.stats.time) +
      (display.risks.length > 0
        ? '\n\n' + chalk.yellow.bold(`${SYM.warn}  High-risk areas:`) + '\n' +
          display.risks.slice(0, 4).map(r => chalk.yellow(`   • ${r}`)).join('\n')
        : '') +
      (display.warnings.length > 0
        ? '\n\n' + chalk.yellow.bold('!  Warnings:') + '\n' +
          display.warnings.map(w => chalk.yellow(`   ${w}`)).join('\n')
        : '') +
      (display.entryPoint
        ? '\n\n' + chalk.gray('Starting at: ') + chalk.cyan(display.entryPoint)
        : ''),
      { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
    ));
    console.log('');
  } catch {
    // Planner failure is non-fatal — continue without it
    console.log(chalk.gray('  (Recon unavailable, proceeding with standard scan)\n'));
  }

  // Smart project label prompt — shows existing projects, fuzzy matches, confirms.
  // Gated on Pro+ per D4: Open users skip labeling, label stays null through
  // to all three downstream D4-sensitive sites (handleProjectIntelligence,
  // saveReport, publishProject fallback), all of which short-circuit cleanly
  // on null label per the if-label checks in each branch. The function-entry
  // comment block above enumerates these three leak surfaces in detail.
  let label = null;
  if (projectIntelEnabled) {
    label = await promptProjectLabel();
    console.log('');
  } else if (!hasShownCallout('feature:project-tracking')) {
    // D3 soft-gate callout: one line, once per session. Open users still
    // get the full POI scan and saved report — this just signals what
    // they'd gain on Pro. Shared gate ID coalesces with all other Phase 2
    // modes that surface project-tracking (prompt-triage, conflict, blast,
    // chat) so the callout displays once per ghost invocation across the
    // five-mode set.
    console.log(chalk.cyan('💡 Project tracking available on Pro. Scans run as one-shots on Open.'));
    console.log('');
    markCalloutShown('feature:project-tracking');
  }

  const { proceed } = await inquirer.prompt([{
    type: 'confirm', name: 'proceed',
    message: chalk.cyan('Proceed with scan?'), default: true
  }]);
  if (!proceed) { console.log(chalk.gray('\nScan cancelled.\n')); return; }

  let buffer  = '';
  let started = false;
  let spinner = null;
  // The full verified finding set, including the findings ranked below the
  // narrator's prose cap. Populated by BOTH scan paths: multipass via
  // multiResult.findings, single-pass via runPOIScan's onSidecarFindings
  // callback (the old comment here claimed the single-pass report "already
  // contains every finding", which was false once the narrator's 30-finding
  // cap fired — Audit 7, finding 3.4).
  let sidecarFindings = null;

  try {
    // Capture REAL API token usage across the whole scan. Every scan pass,
    // synthesis, narrator, and per-finding verifier call records into the usage
    // tracker, so the cost line below can report the actual Anthropic bill
    // instead of the old char/4 estimate that only measured the codebase context
    // once and ignored the rest (historically ~9x low on a full POI scan).
    beginUsageCapture();
    if (useMultiPass) {
      const multiResult = await runMultiPassPOI(fileMap, label || 'project', {
        onChunk(chunk) {
          // Capture the report to the buffer, but do NOT stream it to stdout.
          // Streaming the raw report:
          //   1. Looks messy — wall of markdown scrolling past at high speed
          //   2. On Ghost Open, leaks the full pre-paywall report into scrollback
          // A spinner (started when 'narrating' fires) shows progress instead.
          buffer += chunk;
          started = true;
        },
        onProgress({ type, ...data }) {
          if (type === 'narrating') {
            if (spinner) { spinner.stop(); spinner = null; }
            spinner = ora({ text: chalk.cyan('  Ghost is writing the final report...'), color: 'cyan' }).start();
          }
          if (type === 'verifying') {
            if (spinner) { spinner.stop(); spinner = null; }
            spinner = ora({ text: chalk.cyan('  Verifying findings against source...'), color: 'cyan' }).start();
          }
          if (type === 'verifierReport') {
            // Stash the verifier card so we can show it after save decision
            // (it arrives between narrating and report ready)
            if (data.card) {
              if (data.card.error) {
                console.log(chalk.gray(`\n  ${SYM.warn}  Verifier: ${data.card.note || data.card.error}\n`));
              } else {
                const { verified, unverified, falsePositives, disputed, verifierUnavailable, totalFindings, note } = data.card;
                if (note) {
                  console.log(chalk.gray(`\n  Verifier: ${note}\n`));
                } else {
                  // Disputed findings are dropped from the report exactly like
                  // false positives are, so they must be counted here too, or
                  // the line the user reads does not sum to totalFindings.
                  const excluded = (falsePositives || 0) + (disputed || 0);
                  const parts = [];
                  parts.push(chalk.green(`${verified}/${totalFindings} grounded`));
                  if (unverified > 0) parts.push(chalk.yellow(`${unverified} unverified`));
                  if (excluded   > 0) parts.push(chalk.gray(`${excluded} low-confidence signals excluded`));
                  if (verifierUnavailable > 0) parts.push(chalk.yellow(`${verifierUnavailable} could not be verified`));
                  console.log(chalk.gray(`\n  Verification: `) + parts.join(chalk.gray(', ')) + '\n');
                }
              }
            }
          }
          if (type === "passStart") {
            if (spinner) { spinner.stop(); spinner = null; }
            spinner = ora({ text: chalk.gray(`  Pass ${data.passNum} of ${data.totalPasses}: ${data.fileCount} files (~${(data.tokens||0).toLocaleString()} tokens)...`), color: "cyan" }).start();
          }
          if (type === "passComplete") {
            if (spinner) { spinner.succeed(chalk.green(`  ${SYM.check} Pass ${data.passNum} complete`)); spinner = null; }
            console.log("");
            // Holding spinner covers the gap before merging/synthesizing fires.
            // It's immediately replaced if 'merging' or 'synthesizing' fires next — that's fine.
            spinner = ora({ text: chalk.gray('  Preparing the final report...'), color: 'cyan' }).start();
          }
          if (type === "merging") {
            if (spinner) { spinner.stop(); spinner = null; }
            spinner = ora({ text: chalk.gray(`  Merging batch of ${data.count} passes...`), color: "cyan" }).start();
          }
          if (type === "mergeDone") {
            if (spinner) { spinner.succeed(chalk.green("  Batch merged")); spinner = null; }
            console.log("");
          }
          if (type === "synthesizing") {
            if (spinner) { spinner.stop(); spinner = null; }
            // Show pass count instead of group count — more meaningful to the user
            const passLabel = data.passCount
              ? `${data.passCount} pass${data.passCount === 1 ? '' : 'es'}`
              : null;
            const label = passLabel
              ? `  Preparing the final report (${passLabel})...`
              : `  Preparing the final report...`;
            spinner = ora({ text: chalk.cyan(label), color: "cyan" }).start();
          }
          if (type === "passInfo") {
            if (data.isSelected) {
              console.log(chalk.cyan(`  Running: ${data.remaining} pass${data.remaining === 1 ? '' : 'es'} selected`));
              console.log(chalk.gray(`     Est. cost: ~${data.estCost} and ~${data.estMinutes} minutes\n`));
            } else {
              console.log(chalk.cyan(`  Multi-pass: ${data.totalPasses} total passes available, ${data.remaining} remaining`));
              console.log(chalk.gray(`     Full run: ~${data.estCost} and ~${data.estMinutes} minutes\n`));
            }
          }
        },
        async onPassCapPrompt({ remaining, defaultCap }) {
          const { passCap } = await inquirer.prompt([{
            type: 'input', name: 'passCap',
            message: chalk.cyan(`Passes to run now?`) + chalk.gray(` (max ${remaining}, Enter for ${defaultCap})`),
            default: String(defaultCap),
            validate: v => { const n = parseInt(v); return (!isNaN(n) && n >= 1 && n <= remaining) ? true : `Enter 1–${remaining}`; }
          }]);
          console.log('');
          return parseInt(passCap);
        },
        async onSessionPrompt({ session, allPassCount, pct }) {
          console.log(chalk.cyan(`\n📂  Saved session: ${session.projectLabel} (${session.completedPassCount}/${allPassCount} passes, ${pct}% coverage)\n`));
          const promptSpinner = ora({ text: chalk.gray('Preparing options...'), color: 'cyan' }).start();
          await new Promise(r => setTimeout(r, 600));
          promptSpinner.stop();
          const { action } = await inquirer.prompt([{
            type: 'list', name: 'action',
            message: chalk.cyan('What would you like to do?'),
            choices: [
              { name: `Continue from pass ${session.completedPassCount + 1}`, value: 'continue' },
              { name: 'Generate report from completed passes now',             value: 'report'   },
              { name: 'Start over',                                            value: 'restart'  },
            ]
          }]);
          if (action === 'report') console.log(chalk.cyan('\n  🧠 Generating report from completed passes...\n'));
          return action;
        },
        async onCompletePrompt({ coverage, remaining, passCount }) {
          console.log(chalk.cyan(`\n  ${SYM.check} ${passCount} passes complete: ${coverage}% coverage`));
          console.log(chalk.gray(`  ${remaining} passes remain. Session saved.\n`));
          const promptSpinner = ora({ text: chalk.gray('Preparing options...'), color: 'cyan' }).start();
          await new Promise(r => setTimeout(r, 600));
          promptSpinner.stop();
          const { next } = await inquirer.prompt([{
            type: 'list', name: 'next',
            message: chalk.cyan('What would you like to do?'),
            choices: [
              { name: 'Generate report from completed passes now', value: 'report' },
              { name: 'Save and exit: continue next session',     value: 'save'   },
            ]
          }]);
          if (next === 'save') console.log(chalk.green(`\n  ${SYM.check} Session saved: continue from pass ${passCount + 1} next time\n`));
          return next;
        },
      }, { profile });

      if (!multiResult) {
        // fall through
      } else if (multiResult.saved) {
        console.log(chalk.cyan(`\n  Session saved. Run Ghost again to continue from where you left off.\n`));
        return;
      } else if (multiResult.finalReport) {
        // Stop the narrator spinner cleanly now that the full report is in hand.
        if (spinner) { spinner.succeed(chalk.green('  Report ready')); spinner = null; }
        buffer = multiResult.finalReport;
        // Every finding that survived verification, including the ones the
        // narrator did not have room to detail. Threaded into saveReport's meta
        // below so the .findings.json sidecar matches what the report's cap
        // disclosure promises is in it.
        if (Array.isArray(multiResult.findings) && multiResult.findings.length > 0) {
          sidecarFindings = multiResult.findings;
        }
        // Coverage-aware file counts for the SAVED artifact.
        //
        // This used to set loadedFiles = totalFiles = multiResult.totalFiles, so
        // meta.filesAnalyzed rendered "396 of 396" even on a capped run that
        // only analyzed 40% of them. The honest `coverage` figure was printed to
        // the terminal on the very next line and then thrown away, so the PDF a
        // consultant hands a buyer claimed full coverage of a partial scan.
        // A capped run is a legitimate, deliberate outcome (see
        // userGotWhatTheyAskedFor in core/multipass.js). It just has to say so.
        if (multiResult.totalFiles) {
          const coverage = Number.isFinite(multiResult.coverage) ? multiResult.coverage : 100;
          const analyzed = Math.round(multiResult.totalFiles * coverage / 100);
          codebaseContext = {
            ...codebaseContext,
            loadedFiles: analyzed,
            totalFiles:  multiResult.totalFiles,
            coverage,
          };
        }
        console.log('\n');
        console.log(chalk.cyan(
          `  ${SYM.check} Multi-pass complete: ${multiResult.passCount} passes, ` +
          `${multiResult.coverage}% of ${multiResult.totalFiles} files analyzed\n`
        ));
      }

    } else {
      // Single-pass path: smaller codebases. Same rule — capture to buffer, no stream.
      const readSpinner = ora({ text: chalk.gray('Ghost is reading your project...'), color: 'cyan' }).start();
      let narratorSpinner = null;
      // Use the RETURN VALUE as the report. The chunks streamed into `buffer`
      // below are the narrator's pre-verifier draft (captured silently for
      // fallback); the return value is the finished report AFTER verifier
      // annotations, false-positive drops, empty-header scrubbing, and the
      // cap-disclosure rewrite. Discarding the return value shipped the
      // unverified draft on every single-pass scan (found during the Audit 7
      // remediation; not in the audit list).
      const singlePassReport = await runPOIScan(
        codebaseContext,
        (chunk) => {
          // Silent capture; spinner covers the UX.
          //
          // The spinner is normally started by the onNarratorStart callback below
          // (which fires before the first chunk arrives). The narratorSpinner guard
          // here prevents creating a SECOND spinner and orphaning the first — which
          // would leave a dangling spinner that never gets stopped, hiding the save
          // prompt that follows. The guard preserves the fallback for any caller that
          // doesn't fire onNarratorStart.
          if (!started) {
            started = true;
            readSpinner.stop();
            if (!narratorSpinner) {
              narratorSpinner = ora({ text: chalk.cyan('  Ghost is writing the final report...'), color: 'cyan' }).start();
            }
          }
          buffer += chunk;
        },
        {
          onNarratorStart: () => {
            if (readSpinner && readSpinner.isSpinning) readSpinner.stop();
            if (!narratorSpinner) {
              narratorSpinner = ora({ text: chalk.cyan('  Ghost is writing the final report...'), color: 'cyan' }).start();
            }
          },
          projectLabel: label || 'project',
          profile,  // Ghost Partner — consultant lens injected into scan + narrator
          // Full verified finding set (detailed + remainder) for the sidecar,
          // same contract as the multipass path's multiResult.findings.
          onSidecarFindings: (found) => {
            if (Array.isArray(found) && found.length > 0) sidecarFindings = found;
          },
        }
      );
      if (singlePassReport) buffer = singlePassReport;
      if (narratorSpinner) { narratorSpinner.succeed(chalk.green('  Report ready')); narratorSpinner = null; }
      if (readSpinner && readSpinner.isSpinning) readSpinner.stop();
      console.log('\n');
    }

    // Early return with an open capture window used to strand the tracker: the
    // next scan's beginUsageCapture() silently discarded it. Close it, and if
    // the run spent anything before producing no buffer, say so.
    if (!buffer) {
      const orphaned = endUsageCapture();
      if (orphaned && orphaned.calls > 0) {
        console.log(chalk.yellow('\n  Scan produced no report. You were billed for the work that ran:'));
        showActualCost(orphaned.inputTokens, orphaned.outputTokens, model);
      }
      return;
    }

    // Cost — prefer REAL captured token usage (every API call in the pipeline
    // records into the usage tracker). Fall back to the char/4 estimate only if
    // capture produced nothing (e.g. a code path that bypassed the tracker), so
    // the cost line degrades gracefully rather than showing $0.
    const captured = endUsageCapture();
    let inputTokens, outputTokens;
    if (captured && captured.calls > 0) {
      inputTokens  = captured.inputTokens;
      outputTokens = captured.outputTokens;
    } else {
      inputTokens  = Math.ceil(codebaseContext.context.length / 4) + 200;
      outputTokens = Math.ceil(buffer.length / 4);
    }
    showActualCost(inputTokens, outputTokens, model);

    // Project Intelligence — auto-compare against baseline
    let projectIntelResult = null;
    if (label) {
      const piMeta = {
        filesAnalyzed: `${codebaseContext.loadedFiles} of ${codebaseContext.totalFiles}`,
        rates,
      };
      projectIntelResult = await handleProjectIntelligence(label, buffer, piMeta);
    }

    // Save prompt
    const { doSave } = await inquirer.prompt([{
      type: 'confirm', name: 'doSave',
      message: chalk.cyan('Save this report to ~/Ghost Architect Reports/?'), default: true
    }]);

    // Parse severity counts using the finding parser — counts actual findings,
    // not raw word occurrences which over-count due to summary tables/headers
    const { extractFindings } = await import('../utils/finding-parser.js');
    const parsedFindings = extractFindings(buffer);
    const criticalCount = parsedFindings.filter(f => f.severity === 'CRITICAL').length;
    const highCount     = parsedFindings.filter(f => f.severity === 'HIGH').length;
    const mediumCount   = parsedFindings.filter(f => f.severity === 'MEDIUM').length;
    const lowCount      = parsedFindings.filter(f => f.severity === 'LOW').length;
    const findingCount  = parsedFindings.length;

    // Parse total hours and cost from the remediation summary section.
    // Reports come in two formats:
    //   RANGE:  "Total Estimated Cost: $1,524–$2,269"
    //   SINGLE: "Grand Total: 55 hours | $7,865"
    // We support both. If neither matches, totals stay null so downstream UI
    // can render “—” instead of a misleading $0.
    let totalHours = null;
    let totalCost  = null;

    // ── Hours: range patterns first, then single values ──
    const hoursRangeMatch =
         buffer.match(/Total Estimated Effort[:\s]+([\d.]+)[\u2013\-]([\d.]+)\s*hours/i)
      || buffer.match(/Grand Total[:\s\S]{0,40}?([\d.]+)[\u2013\-]([\d.]+)\s*hours/i)
      || buffer.match(/Total[^\n]*?([\d]+)[\u2013\-]([\d]+)\s*hours/i);
    if (hoursRangeMatch) {
      totalHours = Math.round((parseFloat(hoursRangeMatch[1]) + parseFloat(hoursRangeMatch[2])) / 2);
    } else {
      const hoursSingleMatch =
           buffer.match(/Total Estimated Effort[:\s]+([\d.]+)\s*hours/i)
        || buffer.match(/Grand Total[^\n]*?([\d.]+)\s*hours/i)
        || buffer.match(/^\s*(?:\*\*)?Total(?:\*\*)?[^\n]*?([\d.]+)\s*hours/im);
      if (hoursSingleMatch) {
        totalHours = Math.round(parseFloat(hoursSingleMatch[1]));
      }
    }

    // ── Cost: range patterns first, then single values ──
    const costRangeMatch =
         buffer.match(/Total Estimated Cost[:\s]+\$([\d,]+)[\u2013\-]\$([\d,]+)/i)
      || buffer.match(/Grand Total[:\s\S]{0,80}?\$([\d,]+)[\u2013\-]\$([\d,]+)/i)
      || buffer.match(/Total[^\n]*?\$([\d,]+)[\u2013\-]\$([\d,]+)/i);
    if (costRangeMatch) {
      const lo = parseInt(costRangeMatch[1].replace(/,/g, ''));
      const hi = parseInt(costRangeMatch[2].replace(/,/g, ''));
      totalCost = Math.round((lo + hi) / 2);
    } else {
      const costSingleMatch =
           buffer.match(/Total Estimated Cost[:\s]+\$([\d,]+)(?!\s*[\u2013\-])/i)
        || buffer.match(/Grand Total[\s\S]{0,120}?\$([\d,]+)(?!\s*[\u2013\-])/i)
        || buffer.match(/^\s*(?:\*\*)?Grand Total(?:\*\*)?[\s\S]{0,120}?\$([\d,]+)/im);
      if (costSingleMatch) {
        totalCost = parseInt(costSingleMatch[1].replace(/,/g, ''));
      }
    }

    // REMOVED (v10.0.17): a "last-resort" fallback that grabbed the LAST dollar
    // range (or last 4+ digit dollar figure) anywhere in the report, and the same
    // for hours, and presented it as the project grand total.
    //
    // The last large dollar figure in a Ghost report is not the grand total. It
    // is whatever finding happened to be rendered last. So a scan whose labeled
    // "Grand Total" line the parser failed to match would confidently stamp one
    // finding's remediation cost onto meta.totalCost, and that number reached the
    // PDF, the portal, and Ghost Mobile as the cost of the whole engagement.
    //
    // The fallback justified itself as "better than showing $0". It is not. A
    // buyer reading $0 knows the field is empty. A buyer reading $1,800 when the
    // real total is $47,000 makes a decision on it. Leaving these null honors the
    // contract stated at the top of this block: no number beats a wrong number.

    // Resolved count: use project intelligence fuzzy match result if available,
    // otherwise fall back to baseline - current (simple delta)
    const baselineCount = projectIntelResult?.baselineCount || findingCount;
    const resolvedCount = projectIntelResult?.resolved != null
      ? projectIntelResult.resolved
      : Math.max(0, baselineCount - findingCount);

    const meta = {
      filesAnalyzed: `${codebaseContext.loadedFiles} of ${codebaseContext.totalFiles}`,
      totalFiles: codebaseContext.totalFiles,
      // Was hardcoded to Sonnet's $3/$15 per-million rate regardless of the
      // model actually used, so an Opus or Fable 5 scan under-reported its own
      // cost in the saved artifact by 1.7x to 3.3x. calcActualCost() reads the
      // canonical MODEL_RATES table (and honors the Sonnet 5 intro-pricing
      // cutover), so the number now tracks whatever model ran.
      cost: `${calcActualCost(inputTokens, outputTokens, model).totalCost.toFixed(4)}`,
      // Was a hardcoded '4.5.0' left behind years of releases. Derive it.
      version: GHOST_VERSION,
      findingCount,
      critical: criticalCount,
      high: highCount,
      medium: mediumCount,
      low: lowCount,
      totalHours,
      totalCost,
      // Project intelligence — baseline comparison results
      baselineCount,
      baselineDate:   projectIntelResult?.baselineDate   || null,
      resolved:       resolvedCount,
      newFindings:    projectIntelResult?.newIssues      || 0,
      scans:          [],
      // Ghost Partner — profile drives full white-label rendering in PDF + MD.
      // When `profile` is null, all renderers fall back to default Ghost branding.
      profile,
      // Strategy 2 sidecar: when the multipass path supplied the full verified
      // finding set, reports.js writes it verbatim instead of re-parsing the
      // capped report text. This is what makes the cap disclosure's promise
      // ("all N findings are in the accompanying .findings.json") true.
      ...(sidecarFindings ? { findings: sidecarFindings } : {}),
    };

    if (doSave) {
      // Save locally — saveReport also auto-publishes to Ghost Mobile if configured
      const saved = await saveReport(buffer, 'ghost-poi', label, meta);
      console.log(chalk.green(`\n${SYM.check} Reports saved to ~/Ghost Architect Reports/`));
      console.log(chalk.gray(`  📄 ${saved.txtFile}`));
      console.log(chalk.gray(`  📋 ${saved.mdFile}`));
      if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
      console.log('');
    } else {
      if (label) {
        // @ghost-verified: intentionally minimal payload — no local save means no report text, resolved count, or file refs; buildPublishPayload fallbacks handle absent fields correctly
        // No local save — but still publish to Ghost Mobile if configured
        try {
          const { isPublishConfigured, publishProject } = await import('../core/mobile-publish.js');
          if (isPublishConfigured()) {
            const projectSlug = label.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
            await publishProject(
              { label, slug: projectSlug, baselineDate: null, baselineCount: 0, scans: [] },
              {
                date: new Date().toISOString(),
                version: GHOST_VERSION,   // was a hardcoded '4.7.0'
                findingCount: 0,
                cost: meta.cost,
              }
            );
            console.log(chalk.gray(`\n  📱 Published to Ghost Mobile (local save skipped)\n`));
          }
        } catch { /* non-fatal */ }
      }
      // Declining the save used to be a silent no-op whenever there was no
      // project label: no message, no output, and the buffered report, which the
      // user had already been billed for, was simply dropped. Offer to print it.
      // See src/cli/unsaved-report.js.
      await offerUnsavedReport(buffer, { prefix: 'ghost-poi' });
    }

  } catch (err) {
    // A pass that throws (rate-limit exhaustion, network drop on pass 3 of 5)
    // jumps straight here. Without this, endUsageCapture() never ran and the
    // tokens the user was ALREADY BILLED for on the completed passes vanished
    // silently: no cost line, no acknowledgement, nothing. Surface what the
    // interrupted scan actually cost before showing the error.
    try {
      const partial = endUsageCapture();
      if (partial && partial.calls > 0) {
        console.log(chalk.yellow('\n  Scan interrupted. You were billed for the passes that completed:'));
        showActualCost(partial.inputTokens, partial.outputTokens, model);
      }
    } catch { /* never let cost reporting mask the real error */ }
    showFriendlyError(err);
  }
}

