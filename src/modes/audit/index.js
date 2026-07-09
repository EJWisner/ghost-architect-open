// src/modes/audit/index.js
//
// Inheritance Audit Mode — entry point.
//
// Orchestrates the four audit-mode analyzers + the severity recast over
// standard triage findings, then hands the synthesized output off to the
// audit PDF template for deal-grade report generation.
//
// Audience: agency founders inheriting client codebases, PE/M&A diligence
// teams, fractional CTOs walking into a new engagement, modernization
// consultancies scoping a rebuild. NOT for ongoing developer use — that's
// what the standard modes (POI/Blast/Conflict) are for.
//
// Pipeline:
//   1. Codebase already loaded by ghost.js (codebaseContext.fileMap exists)
//   2. Run the four audit analyzers in sequence:
//        - Stack Reality Check    (deterministic; live in Day 2+)
//        - Key-Person Risk        (deterministic; live in Day 2+)
//        - Hidden Dependency Map  (deterministic; live in Day 3)
//        - Modernization Roadmap  (LLM synthesis; live in Day 3)
//   3. Optionally run standard triage (POI) and recast its findings into
//      deal language via severityRecast.js
//   4. Render the deal-grade PDF via audit-pdf.js (Day 4)
//
// v0.2.0 (current): stackReality + keyPersonRisk are real; the other two
// remain stubbed pending Day 3. Output to stdout shows real findings
// when available; PDF generation comes in Day 4.

import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import inquirer from 'inquirer';
import { spawn } from 'child_process';
import { runStackRealityCheck } from './stackReality.js';
import { runKeyPersonRisk, DEPARTED_THRESHOLD_DAYS, InvalidBasePathError } from './keyPersonRisk.js';
import { runDependencyMap } from './dependencyMap.js';
import { runRoadmapStub } from './roadmapStub.js';
import { buildAuditReport } from './reportBuilder.js';
import { saveReport } from '../../reports.js';
// @ghost-verified: these imports resolve to src/projects.js and src/estimator.js (CLI layer wrappers) not src/core/ -- intentional, audit mode uses CLI display functions
import { promptProjectLabel } from '../../projects.js';
import { showAuditCostEstimate, showActualCost } from '../../estimator.js';
import { getConfig } from '../../config.js';
import { PRICING } from '../../constants/pricing.js';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', warn: IS_WINDOWS ? '[!]' : '⚠' };

/**
 * Open-tier paywall panel. Audit Mode is Pro+ entirely — no partial run on
 * Open. The reasoning: a stripped-down free version misrepresents the
 * product. The Open user either thinks "that's all it does" (damaging
 * Ghost's reputation) or feels held hostage. Better to be honest about
 * Audit Mode being a premium deliverable and tell them clearly what it
 * produces, what it costs, and how to unlock it.
 *
 * Called from runAuditMode() when options.tier === 'open' (or undefined,
 * which defaults to 'open' for fail-closed safety). Prints the panel and
 * returns immediately. No analyzers run. No spinners. No API charges.
 */
async function runAuditOpenPaywall() {
  console.log('\n' + boxen(
    chalk.cyan.bold('📋  INHERITANCE AUDIT  (Pro feature)') + '\n\n' +
    chalk.gray('Deal-grade codebase audit for buyers, PE diligence,') + '\n' +
    chalk.gray('fractional CTOs, and modernization consultants.') + '\n\n' +
    chalk.white('Inheritance Audit produces a 5-page deal-grade PDF combining') + '\n' +
    chalk.white('four analyzers:') + '\n\n' +
    chalk.green('  ✓  ') + chalk.white('Stack Reality Check: what the codebase actually contains,') + '\n' +
    chalk.gray('     framework versions, end-of-life flags') + '\n' +
    chalk.green('  ✓  ') + chalk.white('Key-Person Risk: who has been writing this code,') + '\n' +
    chalk.gray('     key-person dependency, contributor concentration') + '\n' +
    chalk.green('  ✓  ') + chalk.white('Hidden Dependency Map: license risk, EOL exposure,') + '\n' +
    chalk.gray('     commercial encumbrances the buyer is inheriting') + '\n' +
    chalk.green('  ✓  ') + chalk.white('Modernization Roadmap: LLM-synthesized stabilize-vs-rebuild') + '\n' +
    chalk.gray('     recommendation with a 90-day plan and confidence rating') + '\n\n' +
    chalk.white('The audit produces deal-committee-ready TXT, MD, and PDF reports') + '\n' +
    chalk.white('in roughly 30 to 60 seconds at roughly $0.02 to $0.04 per audit') + '\n' +
    chalk.white('in API charges, on top of your subscription.') + '\n\n' +
    chalk.cyan.bold('Available on:') + '\n' +
    chalk.white('  •  Ghost Pro  ($' + PRICING.PRO.monthly + '/mo)   full audit, one engagement at a time') + '\n' +
    chalk.white('  •  Ghost Team ($' + PRICING.TEAM.monthly + '/mo)  full audit + audit-over-time') + '\n' +
    chalk.gray( '                          comparison for modernization') + '\n' +
    chalk.gray( '                          engagements') + '\n' +
    chalk.white('  •  Ghost Enterprise      custom branding + multi-engagement') + '\n' +
    chalk.gray( '                          audit history') + '\n\n' +
    chalk.cyan('Upgrade at:  ') + chalk.cyan.underline('https://ghostarchitect.dev/pricing'),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  // Give the reader a clear next action. "Back to mode menu" is the default
  // happy path (Enter accepts it). "Open pricing page in browser" turns a
  // passive disclosure into an active conversion moment for senior buyers
  // who finished the panel and thought "this looks interesting." No exit
  // option — exiting Ghost from a paywall is hostile UX; they can exit from
  // the next menu if they want to leave.
  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: chalk.cyan('What would you like to do?'),
    choices: [
      { name: '←  Back to mode menu', value: 'back' },
      { name: '🌐  Open pricing page in browser', value: 'pricing' },
    ],
    default: 'back',
  }]);

  if (action === 'pricing') {
    const url = 'https://ghostarchitect.dev/pricing';
    // Cross-platform open: macOS uses 'open', Windows uses 'start' via
    // shell, Linux uses 'xdg-open'. Detached so the user's terminal isn't
    // blocked. If launching fails (e.g. xdg-open missing on a headless
    // Linux box), fall back to printing the URL so they can copy it.
    const platform = process.platform;
    try {
      let cmd, args;
      if (platform === 'darwin')      { cmd = 'open';     args = [url]; }
      else if (platform === 'win32')  { cmd = 'cmd';      args = ['/c', 'start', '', url]; }
      else                            { cmd = 'xdg-open'; args = [url]; }
      const proc = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      proc.unref();
      proc.on('error', () => {
        console.log(chalk.gray(`  Could not launch browser. Open this URL manually: ${url}\n`));
      });
      console.log(chalk.gray(`  Opening ${url} in your default browser...\n`));
    } catch (err) {
      console.log(chalk.gray(`  Could not launch browser. Open this URL manually: ${url}\n`));
    }
  }
}

export async function runAuditMode(codebaseContext, options = {}) {
  const profile = options.profile || null;

  // Tier policy: audit is the original Phase 1 tier-gating pattern source.
  // The `const tier = options.tier || 'open'` plus early-return-on-Open
  // shape established here was adopted by prompt-triage (commit 2d813bb),
  // conflict (commit 5cfe7db), and blast (commit b38c0cb) during Phase 2
  // mode-file reconciliation. Audit's gating is mode-wide rather than
  // feature-specific: TIER_POLICY in src/license/tier-gates.js sets
  // 'mode:audit' to false for Open (hard block, not 'quota'), and the
  // dispatch gate at bin/ghost.js line ~1522 walls Open users via
  // renderAuditPaywall before they reach this function. The
  // runAuditOpenPaywall panel above is the in-mode-file second gate for
  // any caller that bypasses dispatch (defense in depth). All four
  // D-decisions (D1 quota, D2 no-license-equals-Open, D3 soft-gate
  // callout, D4 labeled-save gating) are automatically satisfied by
  // audit being Pro+ entirely; there is no Open code path through this
  // mode. The 'ghost-audit' prefix is intentionally absent from
  // COUNTED_PREFIXES in src/freemium.js because audit doesn't need
  // quota accrual: it cannot run on Open at all, so there are no Open
  // scans to count.
  //
  // If audit ever becomes partially available on Open (e.g. a stripped-
  // down preview tier), four coordinates must change together: this
  // comment, the TIER_POLICY 'mode:audit' entry, the dispatch gate
  // array at bin/ghost.js line ~1522, and the COUNTED_PREFIXES set in
  // src/freemium.js (to start counting Open audit runs against quota).

  // Feature gating. Audit Mode is Pro+ only. Default to 'open' (fail-closed)
  // so any caller that forgets to pass tier does not leak the paid feature.
  // The bin/ghost.js for each branch is the source of truth for TIER and
  // passes it through via { tier: TIER }.
  const tier = options.tier || 'open';
  if (tier === 'open') {
    await runAuditOpenPaywall();
    return;
  }

  console.log('\n' + boxen(
    chalk.cyan.bold('📋  INHERITANCE AUDIT  —  PRE-CLOSE / POST-INHERITANCE') + '\n\n' +
    chalk.gray('Deal-grade codebase audit for buyers, PE diligence,') + '\n' +
    chalk.gray('fractional CTOs, and modernization consultants.') +
    (profile ? '\n\n' + chalk.magenta(`👥 Ghost Partner profile: ${profile.name || profile.author || 'loaded'}`) : ''),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  // Project label — names the saved report files. Same UX as POI/Blast.
  // The label is also used as the "project" line in the PDF cover card.
  const label = await promptProjectLabel();
  console.log('');

  // Model picker — per-run choice for the Modernization Roadmap LLM call.
  // Defaults to whatever the user has set in `defaultModel` config so
  // pressing Enter respects their global preference. Audit is a high-stakes
  // deliverable; users may want Opus for an important deal even if they
  // run POI on Sonnet day-to-day. Same two choices the config picker offers.
  const configuredModel = getConfig().get('defaultModel') || 'claude-sonnet-4-6';
  const modelChoices = [
    { name: 'claude-sonnet-4-6 (recommended — best balance)', value: 'claude-sonnet-4-6' },
    { name: 'claude-opus-4-7 (most powerful — slower/costlier)', value: 'claude-opus-4-7' },
  ];
  const defaultChoiceIdx = modelChoices.findIndex(c => c.value === configuredModel);
  const { model } = await inquirer.prompt([{
    type: 'list', name: 'model',
    message: chalk.cyan('Which model for the Modernization Roadmap synthesis?'),
    choices: modelChoices,
    default: defaultChoiceIdx >= 0 ? defaultChoiceIdx : 0,
  }]);
  console.log('');

  // Cost estimate + confirmation — same protective convention as POI/Blast.
  // The Modernization Roadmap step makes an LLM API call. Other three
  // analyzers run locally and incur no charges. Show the user an honest
  // preview before any spending happens.
  showAuditCostEstimate(model);
  const { proceed } = await inquirer.prompt([{
    type: 'confirm', name: 'proceed',
    message: chalk.cyan('Proceed with audit?'), default: true
  }]);
  if (!proceed) { console.log(chalk.gray('\nAudit cancelled.\n')); return; }
  console.log('');

  const results = {};

  // Analyzer 1: Stack Reality Check
  let spinner = ora({ text: chalk.cyan('Running Stack Reality Check...'), color: 'cyan' }).start();
  try {
    results.stackReality = await runStackRealityCheck(codebaseContext, { profile });
    const tag = results.stackReality._stub ? chalk.gray(' (stub)') : '';
    spinner.succeed(chalk.green(`  ${SYM.check} Stack Reality Check${tag}`));
  } catch (err) {
    spinner.fail(chalk.red(`  Stack Reality Check failed: ${err.message}`));
    results.stackReality = { _error: err.message };
  }

  // Analyzer 2: Key-Person Risk
  spinner = ora({ text: chalk.cyan('Running Key-Person Risk analysis...'), color: 'cyan' }).start();
  try {
    results.keyPersonRisk = await runKeyPersonRisk(codebaseContext, { profile });
    const tag = results.keyPersonRisk._stub ? chalk.gray(' (stub)') : '';
    spinner.succeed(chalk.green(`  ${SYM.check} Key-Person Risk${tag}`));
  } catch (err) {
    if (err instanceof InvalidBasePathError) {
      // Malformed basePath: skip only this analyzer and continue the audit
      // rather than halting the whole run.
      spinner.warn(chalk.yellow(`  Key-Person Risk skipped: ${err.message}`));
      process.stderr.write(
        '[Ghost Audit] Skipping Key-Person Risk analysis (' + err.message + '). Audit continues.\n'
      );
      results.keyPersonRisk = { _error: err.message, _skipped: true };
    } else {
      spinner.fail(chalk.red(`  Key-Person Risk failed: ${err.message}`));
      results.keyPersonRisk = { _error: err.message };
    }
  }

  // Analyzer 3: Hidden Dependency Map
  spinner = ora({ text: chalk.cyan('Running Hidden Dependency Map...'), color: 'cyan' }).start();
  try {
    results.dependencyMap = await runDependencyMap(codebaseContext, { profile });
    const tag = results.dependencyMap._stub ? chalk.gray(' (stub)') : '';
    spinner.succeed(chalk.green(`  ${SYM.check} Hidden Dependency Map${tag}`));
  } catch (err) {
    spinner.fail(chalk.red(`  Hidden Dependency Map failed: ${err.message}`));
    results.dependencyMap = { _error: err.message };
  }

  // Analyzer 4: Modernization Roadmap Stub
  spinner = ora({ text: chalk.cyan('Synthesizing Modernization Roadmap...'), color: 'cyan' }).start();
  try {
    results.roadmap = await runRoadmapStub({
      stackReality: results.stackReality,
      keyPersonRisk: results.keyPersonRisk,
      dependencyMap: results.dependencyMap,
    }, { profile, model });
    const tag = results.roadmap._stub ? chalk.gray(' (stub)') : '';
    spinner.succeed(chalk.green(`  ${SYM.check} Modernization Roadmap${tag}`));
  } catch (err) {
    spinner.fail(chalk.red(`  Modernization Roadmap failed: ${err.message}`));
    results.roadmap = { _error: err.message };
  }

  // ── Render real findings to stdout ───────────────────────────────────
  console.log('');
  renderStackRealityFindings(results.stackReality);
  renderKeyPersonRiskFindings(results.keyPersonRisk);
  renderDependencyMapFindings(results.dependencyMap);
  renderRoadmapFindings(results.roadmap);

  // ── Save report ────────────────────────────────────────
  // Audit Mode prompts before saving — same convention as POI/Blast.
  // Default is Yes since the audit is the deliverable, but the user can
  // bail if the synthesis came back weak or they want to re-run with
  // different inputs first.
  const reportContent = buildAuditReport(results, {
    label,
    profile,
    filesAnalyzed: codebaseContext.loadedFiles || 0,
    totalFiles: codebaseContext.totalFiles || 0,
  });

  const { doSave } = await inquirer.prompt([{
    type: 'confirm', name: 'doSave',
    message: chalk.cyan('Save this audit to ~/Ghost Architect Reports/?'), default: true
  }]);

  let saved = null;
  if (doSave) {
    const saveSpinner = ora({ text: chalk.cyan('Saving deal-grade report (TXT / MD / PDF)...'), color: 'cyan' }).start();
    try {
      // v5.6.0: derive structured findings from the programmatic analyzer
      // outputs (NOT from markdown parsing). Audit's findings are produced
      // by deterministic analyzers — dependencyMap, stackReality,
      // keyPersonRisk — so we normalize them directly into the canonical
      // findings schema rather than asking the model to emit and re-parse.
      const { findingsFromAuditResults } = await import('./findingsFromResults.js');
      const parsedFindings = findingsFromAuditResults(results);
      // TODO(severity-recast-wiring): this is the planned integration point for
      // src/modes/audit/severityRecast.js (currently unwired). parsedFindings is
      // the flat, severity-bearing findings array; groupByDealTier(parsedFindings)
      // would recast it into Deal-Blocker / Post-Close Risk / Day-91 Cleanup /
      // Healthy tiers for a "Findings by Deal Impact" report section. Deferred
      // because it requires a report-structure decision (new section vs. replacing
      // the analyzer sections) across MD, PDF, and the portal sidecar. See the
      // matching TODO in severityRecast.js.
      const criticalCount = parsedFindings.filter(f => f.severity === 'CRITICAL').length;
      const highCount     = parsedFindings.filter(f => f.severity === 'HIGH').length;
      const mediumCount   = parsedFindings.filter(f => f.severity === 'MEDIUM').length;
      const lowCount      = parsedFindings.filter(f => f.severity === 'LOW').length;
      const totalHours    = parsedFindings.reduce((sum, f) => sum + (f.effortHours || 0), 0);

      saved = await saveReport(reportContent, 'ghost-audit', label, {
        filesAnalyzed: `${codebaseContext.loadedFiles || 0} of ${codebaseContext.totalFiles || 0}`,
        totalFiles: codebaseContext.totalFiles || 0,
        profile,
        findings: parsedFindings,
        findingCount: parsedFindings.length,
        critical: criticalCount,
        high:     highCount,
        medium:   mediumCount,
        low:      lowCount,
        totalHours,
      });
      saveSpinner.succeed(chalk.green(`  ${SYM.check} Reports saved`));
    } catch (err) {
      saveSpinner.fail(chalk.red(`  Save failed: ${err.message}`));
    }
  }

  if (saved) {
    console.log('');
    console.log(chalk.green(`Reports saved to ~/Ghost Architect Reports/`));
    console.log(chalk.gray(`  📄 ${saved.txtFile}`));
    console.log(chalk.gray(`  📋 ${saved.mdFile}`));
    if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← deal-committee-ready PDF`));
    console.log('');
  } else if (!doSave) {
    console.log('');
    console.log(chalk.gray('Audit not saved. Findings remain in this terminal session only.'));
    console.log('');
  }

  return results;
}

// ── Render helpers — show real analyzer output as readable terminal text ──

function renderStackRealityFindings(stackReality) {
  if (!stackReality || stackReality._error || stackReality._stub) return;

  const { actualLanguages, frameworks, surpriseFindings, totalCodeLOC } = stackReality;

  console.log(boxen(
    chalk.cyan.bold('STACK REALITY CHECK') + '\n' +
    chalk.gray('What the codebase actually contains'),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderColor: 'cyan', borderStyle: 'round' }
  ));

  // Language breakdown — split into code languages and support/markup files
  if (actualLanguages && actualLanguages.length > 0) {
    const codeLangs = actualLanguages.filter(l => l.isCode);
    const nonCodeLangs = actualLanguages.filter(l => !l.isCode);

    if (codeLangs.length > 0) {
      console.log('');
      console.log(chalk.white.bold('  Code languages') + chalk.gray(`  (~${totalCodeLOC.toLocaleString()} LOC)`));
      for (const lang of codeLangs.slice(0, 6)) {
        const bar = makeBar(lang.pct, 30);
        console.log(
          `    ${chalk.white(lang.language.padEnd(18))} ${chalk.cyan(bar)} ${chalk.gray(lang.pct.toString().padStart(3) + '%')} ${chalk.gray(`(${lang.fileCount} files, ~${lang.locApprox.toLocaleString()} LOC)`)}`
        );
      }
      if (codeLangs.length > 6) {
        console.log(chalk.gray(`    ... and ${codeLangs.length - 6} more`));
      }
    }

    if (nonCodeLangs.length > 0) {
      const nonCodeTotal = nonCodeLangs.reduce((sum, l) => sum + l.locApprox, 0);
      console.log('');
      console.log(chalk.white.bold('  Support / config / docs') + chalk.gray(`  (~${nonCodeTotal.toLocaleString()} LOC)`));
      for (const lang of nonCodeLangs.slice(0, 4)) {
        console.log(
          `    ${chalk.gray('·')} ${chalk.white(lang.language.padEnd(16))} ${chalk.gray(`${lang.fileCount} files, ~${lang.locApprox.toLocaleString()} LOC`)}`
        );
      }
      if (nonCodeLangs.length > 4) {
        console.log(chalk.gray(`    ... and ${nonCodeLangs.length - 4} more`));
      }
    }
  } else {
    console.log('');
    console.log(chalk.gray('  No recognized language files found.'));
  }

  // Detected frameworks
  if (frameworks && frameworks.length > 0) {
    console.log('');
    console.log(chalk.white.bold('  Detected frameworks & runtimes'));
    for (const f of frameworks) {
      const eolBadge = f.eolFlag ? chalk.red(' [EOL]') : '';
      const versionLabel = f.version ? chalk.gray(`@ ${f.version}`) : chalk.gray('(version not parsed)');
      console.log(`    ${chalk.cyan('•')} ${chalk.white(f.displayName)} ${versionLabel}${eolBadge}`);
      if (f.eolFlag && f.eolNote) {
        console.log(`      ${chalk.red(f.eolNote)}`);
      }
    }
  }

  // Surprise findings
  if (surpriseFindings && surpriseFindings.length > 0) {
    console.log('');
    console.log(chalk.yellow.bold('  ⚠ Reality-vs-pitch callouts'));
    for (const surprise of surpriseFindings) {
      console.log(`    ${chalk.yellow('→')} ${chalk.white(surprise)}`);
    }
  }
}

function renderKeyPersonRiskFindings(keyPersonRisk) {
  if (!keyPersonRisk || keyPersonRisk._error || keyPersonRisk._stub) return;

  console.log('');
  console.log(boxen(
    chalk.cyan.bold('KEY-PERSON RISK') + '\n' +
    chalk.gray('Who has been writing this code'),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderColor: 'cyan', borderStyle: 'round' }
  ));

  // Graceful degradation case — git history wasn't available
  if (!keyPersonRisk._gitAvailable) {
    console.log('');
    for (const callout of (keyPersonRisk.callouts || [])) {
      console.log(`    ${chalk.gray('•')} ${chalk.gray(callout)}`);
    }
    return;
  }

  const { totalAuthors, totalCommits, busFactorEstimate, concentrationRisk, topContributors, callouts } = keyPersonRisk;

  console.log('');
  const riskColor = concentrationRisk === 'high' ? chalk.red
    : concentrationRisk === 'medium' ? chalk.yellow
    : concentrationRisk === 'low' ? chalk.green
    : chalk.gray;
  console.log(
    `  ${chalk.white('Total authors:')} ${chalk.cyan(totalAuthors)}` +
    `   ${chalk.white('Commits:')} ${chalk.cyan(totalCommits.toLocaleString())}` +
    `   ${chalk.white('Key contributors:')} ${chalk.cyan(busFactorEstimate)}` +
    `   ${chalk.white('Concentration risk:')} ${riskColor.bold(concentrationRisk.toUpperCase())}`
  );

  // Top contributors
  if (topContributors && topContributors.length > 0) {
    console.log('');
    console.log(chalk.white.bold('  Top contributors by lines changed'));
    for (const c of topContributors.slice(0, 5)) {
      const bar = makeBar(c.linesChangedPct, 30);
      const departed = c.likelyDeparted ? chalk.red(`  (likely departed: ${c.daysSinceLastCommit}d since last commit; flagged after ${DEPARTED_THRESHOLD_DAYS}d of inactivity)`) : '';
      console.log(
        `    ${chalk.white(c.displayLabel.padEnd(10))} ${chalk.cyan(bar)} ${chalk.gray(c.linesChangedPct.toString().padStart(3) + '%')} ${chalk.gray(`(${c.commits} commits)`)}${departed}`
      );
    }
  }

  // Callouts
  if (callouts && callouts.length > 0) {
    console.log('');
    console.log(chalk.white.bold('  Callouts'));
    for (const callout of callouts) {
      const icon = concentrationRisk === 'high' ? chalk.red('→')
        : concentrationRisk === 'medium' ? chalk.yellow('→')
        : chalk.green('→');
      console.log(`    ${icon} ${chalk.white(callout)}`);
    }
  }
}

function renderDependencyMapFindings(dependencyMap) {
  if (!dependencyMap || dependencyMap._error || dependencyMap._stub) return;
  if (!dependencyMap.totalDependencies) return;

  console.log('');
  console.log(boxen(
    chalk.cyan.bold('HIDDEN DEPENDENCY MAP') + '\n' +
    chalk.gray('Third-party libraries the buyer is inheriting'),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderColor: 'cyan', borderStyle: 'round' }
  ));

  console.log('');
  console.log(`  ${chalk.white('Total direct dependencies:')} ${chalk.cyan(dependencyMap.totalDependencies)}`);

  if (dependencyMap.riskCallouts && dependencyMap.riskCallouts.length > 0) {
    console.log('');
    console.log(chalk.white.bold('  Risk callouts'));
    for (const callout of dependencyMap.riskCallouts) {
      const severityColor = callout.severity === 'high' ? chalk.red
        : callout.severity === 'medium' ? chalk.yellow
        : chalk.gray;
      const icon = severityColor('→');
      console.log(`    ${icon} ${chalk.white(callout.summary)}`);
      if (callout.packages && callout.packages.length > 0) {
        const preview = callout.packages.slice(0, 5).join(', ');
        const more = callout.packages.length > 5 ? `, ... +${callout.packages.length - 5} more` : '';
        console.log(`      ${chalk.gray(preview + more)}`);
      }
    }
  } else {
    console.log('');
    console.log(chalk.gray('  No license, EOL, or commercial-dependency risks detected in direct dependencies.'));
  }
}

function renderRoadmapFindings(roadmap) {
  if (!roadmap || roadmap._error) return;

  // Compact terminal summary only. Full prose (narratives, 90-day plan,
  // rebuild scope ranges, caveats) lives in the saved TXT / MD / PDF
  // deliverables. Dumping it to stdout is noise — the deal-committee
  // reader sees the PDF, the consultant running the audit sees this
  // summary and trusts that the saved files contain the full version.

  console.log('');
  console.log(boxen(
    chalk.cyan.bold('MODERNIZATION ROADMAP') + '\n' +
    chalk.gray('Stabilize-and-keep vs rebuild scope — full prose in saved report'),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderColor: 'cyan', borderStyle: 'round' }
  ));

  const confColor = roadmap.confidence === 'high' ? chalk.green
    : roadmap.confidence === 'medium' ? chalk.yellow
    : chalk.gray;
  console.log('');
  console.log(
    `  ${chalk.white('Recommendation:')} ${chalk.cyan.bold(roadmap.recommendation)}` +
    `   ${chalk.white('Confidence:')} ${confColor.bold(roadmap.confidence)}`
  );

  if (roadmap.stabilizeAndKeep?.headline) {
    console.log('');
    console.log(`  ${chalk.white.bold('Stabilize and keep:')} ${chalk.cyan(roadmap.stabilizeAndKeep.headline)}`);
  }

  if (roadmap.rebuildScope?.headline) {
    console.log(`  ${chalk.white.bold('Rebuild scope:')}     ${chalk.cyan(roadmap.rebuildScope.headline)}`);
  }

  // Phase count summary instead of full bullets
  const phaseCount = roadmap.stabilizeAndKeep?.sequencedSteps?.length || 0;
  const caveatCount = roadmap.caveats?.length || 0;
  if (phaseCount > 0 || caveatCount > 0) {
    console.log('');
    const parts = [];
    if (phaseCount > 0) parts.push(`${phaseCount} stabilization phase${phaseCount === 1 ? '' : 's'}`);
    if (caveatCount > 0) parts.push(`${caveatCount} caveat${caveatCount === 1 ? '' : 's'}`);
    console.log(chalk.gray(`  (${parts.join(', ')} captured in the saved report)`));
  }
}

function wrapAndIndent(text, indent, width) {
  if (!text) return '';
  const lines = [];
  for (const paragraph of String(text).split('\n\n')) {
    const words = paragraph.split(/\s+/);
    let current = indent;
    for (const word of words) {
      if (current.length + word.length + 1 > width && current.length > indent.length) {
        lines.push(current);
        current = indent + word;
      } else if (current.length === indent.length) {
        current = indent + word;
      } else {
        current += ' ' + word;
      }
    }
    if (current.length > indent.length) lines.push(current);
    lines.push('');
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function makeBar(pct, width) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
