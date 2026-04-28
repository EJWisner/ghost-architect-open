import { showFriendlyError } from '../utils/errors.js';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import { runPOIScan } from '../analyst/index.js';
import { buildPasses } from '../analyst/multipass.js';
import { runMultiPassPOI } from '../core/multipass.js';
import { showCostEstimate, showActualCost } from '../estimator.js';
import { getConfig } from '../config.js';
import { saveReport } from '../reports.js';
import { runRecon, formatPlanForDisplay } from '../core/agent/planner.js';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };

export async function runPOIMode(codebaseContext) {
  const fileMap      = codebaseContext.fileMap || {};
  const passes       = Object.keys(fileMap).length > 0 ? buildPasses(fileMap) : [];
  const useMultiPass = passes.length > 1;
  const model        = getConfig().get('defaultModel') || 'claude-sonnet-4-5';
  const rates        = {
    junior: getConfig().get('rateJunior') || 85,
    mid:    getConfig().get('rateMid')    || 125,
    senior: getConfig().get('rateSenior') || 200,
  };

  console.log('\n' + boxen(
    chalk.cyan.bold('🗺  POINTS OF INTEREST SCAN') + '\n' +
    chalk.gray(`Analyzing ${codebaseContext.loadedFiles} files for red flags, landmarks,\ndead zones, fault lines, effort estimates, and remediation steps...`) +
    (useMultiPass ? '\n' + chalk.yellow(`⚡ Large codebase — multi-pass mode (${passes.length} passes required)`) : '') + '\n' +
    chalk.gray(`Rates: $${rates.junior}/hr junior · $${rates.mid}/hr mid · $${rates.senior}/hr senior`),
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
        ? '\n\n' + chalk.yellow.bold('⚠  High-risk areas:') + '\n' +
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
    console.log(chalk.gray('  (Recon unavailable — proceeding with standard scan)\n'));
  }

  // Ghost Open v5.0.0: no project labels. Every scan is a one-shot.
  // Reports overwrite the prior ghost-poi.{txt,md,pdf} on each run.
  const label = null;
  console.log('');

  const { proceed } = await inquirer.prompt([{
    type: 'confirm', name: 'proceed',
    message: chalk.cyan('Proceed with scan?'), default: true
  }]);
  if (!proceed) { console.log(chalk.gray('\nScan cancelled.\n')); return; }

  let buffer  = '';
  let started = false;
  let spinner = null;

  try {
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
                console.log(chalk.gray(`\n  ⚠  Verifier: ${data.card.note || data.card.error}\n`));
              } else {
                const { verified, unverified, falsePositives, totalFindings, note } = data.card;
                if (note) {
                  console.log(chalk.gray(`\n  Verifier: ${note}\n`));
                } else {
                  const parts = [];
                  parts.push(chalk.green(`${verified}/${totalFindings} grounded`));
                  if (unverified > 0)     parts.push(chalk.yellow(`${unverified} unverified`));
                  if (falsePositives > 0) parts.push(chalk.red(`${falsePositives} false positives dropped`));
                  console.log(chalk.gray(`\n  Verification: `) + parts.join(chalk.gray(', ')) + '\n');
                }
              }
            }
          }
          if (type === "passStart") {
            if (spinner) { spinner.stop(); spinner = null; }
            spinner = ora({ text: chalk.gray(`  Pass ${data.passNum} of ${data.totalPasses} — ${data.fileCount} files (~${(data.tokens||0).toLocaleString()} tokens)...`), color: "cyan" }).start();
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
          console.log(chalk.cyan(`\n📂  Saved session: ${session.projectLabel} — ${session.completedPassCount}/${allPassCount} passes (${pct}% coverage)\n`));
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
          console.log(chalk.cyan(`\n  ${SYM.check} ${passCount} passes complete — ${coverage}% coverage`));
          console.log(chalk.gray(`  ${remaining} passes remain. Session saved.\n`));
          const promptSpinner = ora({ text: chalk.gray('Preparing options...'), color: 'cyan' }).start();
          await new Promise(r => setTimeout(r, 600));
          promptSpinner.stop();
          const { next } = await inquirer.prompt([{
            type: 'list', name: 'next',
            message: chalk.cyan('What would you like to do?'),
            choices: [
              { name: 'Generate report from completed passes now', value: 'report' },
              { name: 'Save and exit — continue next session',     value: 'save'   },
            ]
          }]);
          if (next === 'save') console.log(chalk.green(`\n  ${SYM.check} Session saved — continue from pass ${passCount + 1} next time\n`));
          return next;
        },
      });

      if (!multiResult) {
        // fall through
      } else if (multiResult.saved) {
        console.log(chalk.cyan(`\n  Session saved — run Ghost again to continue from where you left off.\n`));
        return;
      } else if (multiResult.finalReport) {
        // Stop the narrator spinner cleanly now that the full report is in hand.
        if (spinner) { spinner.succeed(chalk.green('  Report ready')); spinner = null; }
        buffer = multiResult.finalReport;
        // Use multipass total — reflects all files analyzed across all passes
        if (multiResult.totalFiles) {
          codebaseContext = { ...codebaseContext, loadedFiles: multiResult.totalFiles, totalFiles: multiResult.totalFiles };
        }
        console.log('\n');
        console.log(chalk.cyan(
          `  ${SYM.check} Multi-pass complete — ${multiResult.passCount} passes, ` +
          `${multiResult.coverage}% of ${multiResult.totalFiles} files analyzed\n`
        ));
      }

    } else {
      // Single-pass path: smaller codebases. Same rule — capture to buffer, no stream.
      const readSpinner = ora({ text: chalk.gray('Ghost is reading your project...'), color: 'cyan' }).start();
      let narratorSpinner = null;
      await runPOIScan(
        codebaseContext,
        (chunk) => {
          // Silent capture; spinner covers the UX.
          if (!started) {
            started = true;
            readSpinner.stop();
            narratorSpinner = ora({ text: chalk.cyan('  Ghost is writing the final report...'), color: 'cyan' }).start();
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
        }
      );
      if (narratorSpinner) { narratorSpinner.succeed(chalk.green('  Report ready')); narratorSpinner = null; }
      if (readSpinner && readSpinner.isSpinning) readSpinner.stop();
      console.log('\n');
    }

    if (!buffer) return;

    // Cost
    const inputTokens  = Math.ceil(codebaseContext.context.length / 4) + 200;
    const outputTokens = Math.ceil(buffer.length / 4);
    showActualCost(inputTokens, outputTokens, model);

    // Ghost Open v5.0.0: project intelligence is a Pro feature. Open does not
    // track baselines, deltas, or project history — there's no project label
    // to anchor that data to.
    let projectIntelResult = null;

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

    // Last-resort fallback: if we still have nothing, scan for the LAST dollar
    // amount that looks like a grand total. Better than showing $0.
    if (totalCost == null) {
      const allRanges = [...buffer.matchAll(/\$([\d,]+)[\u2013\-]\$([\d,]+)/g)];
      if (allRanges.length > 0) {
        const last = allRanges[allRanges.length - 1];
        const lo = parseInt(last[1].replace(/,/g, ''));
        const hi = parseInt(last[2].replace(/,/g, ''));
        totalCost = Math.round((lo + hi) / 2);
      } else {
        const allSingles = [...buffer.matchAll(/\$([\d,]{4,})/g)]; // 4+ digits = meaningful totals, not $50
        if (allSingles.length > 0) {
          const last = allSingles[allSingles.length - 1];
          totalCost = parseInt(last[1].replace(/,/g, ''));
        }
      }
    }
    if (totalHours == null) {
      const allHoursRanges = [...buffer.matchAll(/(\d+)[\u2013\-](\d+)\s*hours/g)];
      if (allHoursRanges.length > 0) {
        const last = allHoursRanges[allHoursRanges.length - 1];
        totalHours = Math.round((parseInt(last[1]) + parseInt(last[2])) / 2);
      } else {
        const allHoursSingles = [...buffer.matchAll(/(\d+)\s*hours/g)];
        if (allHoursSingles.length > 0) {
          const last = allHoursSingles[allHoursSingles.length - 1];
          totalHours = parseInt(last[1]);
        }
      }
    }

    // Resolved count: use project intelligence fuzzy match result if available,
    // otherwise fall back to baseline - current (simple delta)
    const baselineCount = projectIntelResult?.baselineCount || findingCount;
    const resolvedCount = projectIntelResult?.resolved != null
      ? projectIntelResult.resolved
      : Math.max(0, baselineCount - findingCount);

    const meta = {
      filesAnalyzed: `${codebaseContext.loadedFiles} of ${codebaseContext.totalFiles}`,
      totalFiles: codebaseContext.totalFiles,
      cost: `${(inputTokens * 0.000003 + outputTokens * 0.000015).toFixed(4)}`,
      version: '4.5.0',
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
    };

    if (doSave) {
      // Save locally — saveReport writes ghost-poi.{txt,md,pdf}, overwriting prior runs.
      const saved = await saveReport(buffer, 'ghost-poi', label, meta);
      console.log(chalk.green(`\n${SYM.check} Reports saved to ~/Ghost Architect Reports/`));
      console.log(chalk.gray(`  📄 ${saved.txtFile}`));
      console.log(chalk.gray(`  📋 ${saved.mdFile}`));
      if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
      console.log('');
    }

  } catch (err) {
    showFriendlyError(err);
  }
}

function colorizeOutput(text) {
  return text
    .replace(/🔴 RED FLAGS/g, chalk.red.bold('🔴 RED FLAGS'))
    .replace(/🏛️ LANDMARKS/g, chalk.blue.bold('🏛️  LANDMARKS'))
    .replace(/⚰️ DEAD ZONES/g, chalk.gray.bold('⚰️  DEAD ZONES'))
    .replace(/⚡ FAULT LINES/g, chalk.yellow.bold('⚡ FAULT LINES'))
    .replace(/📊 REMEDIATION SUMMARY/g, chalk.cyan.bold('📊 REMEDIATION SUMMARY'))
    .replace(/CRITICAL/g, chalk.bgRed.white.bold(' CRITICAL '))
    .replace(/\bHIGH\b/g, chalk.red.bold('HIGH'))
    .replace(/\bMEDIUM\b/g, chalk.yellow.bold('MEDIUM'))
    .replace(/\bLOW\b/g, chalk.green.bold('LOW'))
    .replace(/Effort:/g, chalk.cyan('Effort:'))
    .replace(/Complexity:/g, chalk.cyan('Complexity:'))
    .replace(/Recommended fix:/g, chalk.green.bold('Recommended fix:'))
    .replace(/Fix priority:/g, chalk.yellow('Fix priority:'));
}
