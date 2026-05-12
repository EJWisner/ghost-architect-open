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
//        - Stack Reality Check    (deterministic)
//        - Key-Person Risk        (deterministic, parses git log)
//        - Hidden Dependency Map  (deterministic, parses manifests)
//        - Modernization Roadmap  (LLM synthesis over the above)
//   3. Optionally run standard triage (POI) and recast its findings into
//      deal language via severityRecast.js
//   4. Render the deal-grade PDF via audit-pdf.js (template lives in
//      src/report/templates/, to be created in a later pass)
//
// v0.1.0 (current): All four analyzers are stubbed. This entry point
// prints a banner, invokes the stubs, and reports back. Enough wiring
// to verify the mode is reachable from the menu and CLI flag without
// having to ship analyzer logic first.

import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { runStackRealityCheck } from './stackReality.js';
import { runKeyPersonRisk } from './keyPersonRisk.js';
import { runDependencyMap } from './dependencyMap.js';
import { runRoadmapStub } from './roadmapStub.js';
import { DEAL_TIERS } from './severityRecast.js';

const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓' };

export async function runAuditMode(codebaseContext, options = {}) {
  const profile = options.profile || null;

  console.log('\n' + boxen(
    chalk.cyan.bold('📋  INHERITANCE AUDIT  —  PRE-CLOSE / POST-INHERITANCE') + '\n\n' +
    chalk.gray('Deal-grade codebase audit for buyers, PE diligence,') + '\n' +
    chalk.gray('fractional CTOs, and modernization consultants.') + '\n\n' +
    chalk.yellow('⚠  v0.1.0 development build — analyzers are stubbed') +
    (profile ? '\n\n' + chalk.magenta(`👥 Ghost Partner profile: ${profile.name || profile.author || 'loaded'}`) : ''),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  const startedAt = Date.now();
  const results = {};

  // Analyzer 1: Stack Reality Check
  let spinner = ora({ text: chalk.cyan('Running Stack Reality Check...'), color: 'cyan' }).start();
  try {
    results.stackReality = await runStackRealityCheck(codebaseContext, { profile });
    spinner.succeed(chalk.green(`  ${SYM.check} Stack Reality Check ${results.stackReality._stub ? chalk.gray('(stub)') : ''}`));
  } catch (err) {
    spinner.fail(chalk.red(`  Stack Reality Check failed: ${err.message}`));
    results.stackReality = { _error: err.message };
  }

  // Analyzer 2: Key-Person Risk
  spinner = ora({ text: chalk.cyan('Running Key-Person Risk analysis...'), color: 'cyan' }).start();
  try {
    results.keyPersonRisk = await runKeyPersonRisk(codebaseContext, { profile });
    spinner.succeed(chalk.green(`  ${SYM.check} Key-Person Risk ${results.keyPersonRisk._stub ? chalk.gray('(stub)') : ''}`));
  } catch (err) {
    spinner.fail(chalk.red(`  Key-Person Risk failed: ${err.message}`));
    results.keyPersonRisk = { _error: err.message };
  }

  // Analyzer 3: Hidden Dependency Map
  spinner = ora({ text: chalk.cyan('Running Hidden Dependency Map...'), color: 'cyan' }).start();
  try {
    results.dependencyMap = await runDependencyMap(codebaseContext, { profile });
    spinner.succeed(chalk.green(`  ${SYM.check} Hidden Dependency Map ${results.dependencyMap._stub ? chalk.gray('(stub)') : ''}`));
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
    spinner.succeed(chalk.green(`  ${SYM.check} Modernization Roadmap ${results.roadmap._stub ? chalk.gray('(stub)') : ''}`));
  } catch (err) {
    spinner.fail(chalk.red(`  Modernization Roadmap failed: ${err.message}`));
    results.roadmap = { _error: err.message };
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('');
  console.log(boxen(
    chalk.cyan.bold('Audit Mode — Development Status') + '\n\n' +
    chalk.gray(`Completed in ${elapsedSec}s`) + '\n\n' +
    chalk.white('Next implementation steps:') + '\n' +
    chalk.gray('  • Day 2: Stack Reality + Key-Person Risk real logic') + '\n' +
    chalk.gray('  • Day 3: Dependency Map manifest parsing') + '\n' +
    chalk.gray('  • Day 3: Roadmap LLM synthesis (audit-v1 prompt pack)') + '\n' +
    chalk.gray('  • Day 4: Deal-grade PDF template (audit-pdf.js)') + '\n' +
    chalk.gray('  • Day 5: End-to-end testing on sample repos') + '\n\n' +
    chalk.gray('Severity recast tiers available now:') + '\n' +
    chalk.gray(`  ${DEAL_TIERS.DEAL_BLOCKER} / ${DEAL_TIERS.POST_CLOSE_RISK} /`) + '\n' +
    chalk.gray(`  ${DEAL_TIERS.DAY_91_CLEANUP} / ${DEAL_TIERS.HEALTHY}`),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  return results;
}
