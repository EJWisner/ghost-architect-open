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
import { runStackRealityCheck } from './stackReality.js';
import { runKeyPersonRisk } from './keyPersonRisk.js';
import { runDependencyMap } from './dependencyMap.js';
import { runRoadmapStub } from './roadmapStub.js';
import { DEAL_TIERS } from './severityRecast.js';
import { buildAuditReport } from './reportBuilder.js';
import { saveReport } from '../../reports.js';
import { promptProjectLabel } from '../../projects.js';
import { showAuditCostEstimate, showActualCost } from '../../estimator.js';
import { getConfig } from '../../config.js';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', warn: IS_WINDOWS ? '[!]' : '⚠' };

export async function runAuditMode(codebaseContext, options = {}) {
  const profile = options.profile || null;

  console.log('\n' + boxen(
    chalk.cyan.bold('📋  INHERITANCE AUDIT  —  PRE-CLOSE / POST-INHERITANCE') + '\n\n' +
    chalk.gray('Deal-grade codebase audit for buyers, PE diligence,') + '\n' +
    chalk.gray('fractional CTOs, and modernization consultants.') + '\n\n' +
    chalk.yellow(`${SYM.warn}  v0.4.0 development — all analyzers live; deal-grade reports saving`) +
    (profile ? '\n\n' + chalk.magenta(`👥 Ghost Partner profile: ${profile.name || profile.author || 'loaded'}`) : ''),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  // Project label — names the saved report files. Same UX as POI/Blast.
  // The label is also used as the "project" line in the PDF cover card.
  const label = await promptProjectLabel();
  console.log('');

  // Cost estimate + confirmation — same protective convention as POI/Blast.
  // The Modernization Roadmap step makes an LLM API call. Other three
  // analyzers run locally and incur no charges. Show the user an honest
  // preview before any spending happens.
  const model = getConfig().get('defaultModel') || 'claude-sonnet-4-5';
  showAuditCostEstimate(model);
  const { proceed } = await inquirer.prompt([{
    type: 'confirm', name: 'proceed',
    message: chalk.cyan('Proceed with audit?'), default: true
  }]);
  if (!proceed) { console.log(chalk.gray('\nAudit cancelled.\n')); return; }
  console.log('');

  const startedAt = Date.now();
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
    spinner.fail(chalk.red(`  Key-Person Risk failed: ${err.message}`));
    results.keyPersonRisk = { _error: err.message };
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
    }, { profile });
    const tag = results.roadmap._stub ? chalk.gray(' (stub)') : '';
    spinner.succeed(chalk.green(`  ${SYM.check} Modernization Roadmap${tag}`));
  } catch (err) {
    spinner.fail(chalk.red(`  Modernization Roadmap failed: ${err.message}`));
    results.roadmap = { _error: err.message };
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  // ── Render real findings to stdout ───────────────────────────────────
  console.log('');
  renderStackRealityFindings(results.stackReality);
  renderKeyPersonRiskFindings(results.keyPersonRisk);
  renderDependencyMapFindings(results.dependencyMap);
  renderRoadmapFindings(results.roadmap);

  // ── Save report ────────────────────────────────────────
  // Audit Mode always saves — deal-grade reports are the deliverable.
  // No save prompt; this is a one-shot audit, not an exploratory scan.
  const reportContent = buildAuditReport(results, {
    label,
    profile,
    filesAnalyzed: codebaseContext.loadedFiles || 0,
    totalFiles: codebaseContext.totalFiles || 0,
  });

  let saved = null;
  const saveSpinner = ora({ text: chalk.cyan('Saving deal-grade report (TXT / MD / PDF)...'), color: 'cyan' }).start();
  try {
    saved = await saveReport(reportContent, 'ghost-audit', label, {
      filesAnalyzed: `${codebaseContext.loadedFiles || 0} of ${codebaseContext.totalFiles || 0}`,
      totalFiles: codebaseContext.totalFiles || 0,
      profile,
    });
    saveSpinner.succeed(chalk.green(`  ${SYM.check} Reports saved`));
  } catch (err) {
    saveSpinner.fail(chalk.red(`  Save failed: ${err.message}`));
  }

  if (saved) {
    console.log('');
    console.log(chalk.green(`Reports saved to ~/Ghost Architect Reports/`));
    console.log(chalk.gray(`  📄 ${saved.txtFile}`));
    console.log(chalk.gray(`  📋 ${saved.mdFile}`));
    if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← deal-committee-ready PDF`));
    console.log('');
  }

  // ── Development summary box ──────────────────────────────────────────
  console.log('');
  console.log(boxen(
    chalk.cyan.bold('Audit Mode — Development Status') + '\n\n' +
    chalk.gray(`Completed in ${elapsedSec}s`) + '\n\n' +
    chalk.white('Live analyzers:') + '\n' +
    chalk.green('  ✓ Stack Reality Check') + '\n' +
    chalk.green('  ✓ Key-Person Risk') + '\n' +
    chalk.green('  ✓ Hidden Dependency Map') + '\n' +
    chalk.green('  ✓ Modernization Roadmap (LLM synthesis)') + '\n' +
    chalk.green('  ✓ Deal-grade TXT / MD / PDF reports') + '\n\n' +
    chalk.white('Pending:') + '\n' +
    chalk.gray('  • Sample-repo testing (Day 5)') + '\n\n' +
    chalk.gray('Severity recast tiers:') + '\n' +
    chalk.gray(`  ${DEAL_TIERS.DEAL_BLOCKER} / ${DEAL_TIERS.POST_CLOSE_RISK} /`) + '\n' +
    chalk.gray(`  ${DEAL_TIERS.DAY_91_CLEANUP} / ${DEAL_TIERS.HEALTHY}`),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

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
    `   ${chalk.white('Bus factor:')} ${chalk.cyan(busFactorEstimate)}` +
    `   ${chalk.white('Concentration risk:')} ${riskColor.bold(concentrationRisk.toUpperCase())}`
  );

  // Top contributors
  if (topContributors && topContributors.length > 0) {
    console.log('');
    console.log(chalk.white.bold('  Top contributors by lines changed'));
    for (const c of topContributors.slice(0, 5)) {
      const bar = makeBar(c.linesChangedPct, 30);
      const departed = c.likelyDeparted ? chalk.red(`  (likely departed — ${c.daysSinceLastCommit}d ago)`) : '';
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
