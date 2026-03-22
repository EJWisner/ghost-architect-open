/**
 * Ghost Architect — Projects (CLI layer)
 * Thin wrapper: displays project intelligence data from core/projects.js
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  listProjects, slugify, fuzzyMatch,
  saveProjectIntelligence, getProjectDashboardData,
  extractFindingsFromReport, ensureProjectsDir
} from './core/projects.js';

export { listProjects, extractFindingsFromReport, ensureProjectsDir } from './core/projects.js';

// ── Project label prompt (CLI) ────────────────────────────────────────────────

export async function promptProjectLabel() {
  const projects = listProjects();

  const existingHint = projects.length > 0
    ? chalk.gray(`  Existing projects: ${projects.map(p => chalk.white(p.label)).join(chalk.gray(' · '))}`)
    : chalk.gray('  No projects tracked yet — type a name to start one');

  console.log('');
  console.log(existingHint);
  console.log(chalk.gray('  Case-insensitive. Same name each time builds history. Enter = one-time scan.\n'));

  const { raw } = await inquirer.prompt([{
    type: 'input',
    name: 'raw',
    message: chalk.cyan('Project label:') + chalk.gray(' (Enter for one-time scan, no tracking)'),
  }]);

  const input = raw.trim();

  if (!input) {
    console.log(chalk.gray('  Running as one-time scan — no project history will be recorded.\n'));
    return null;
  }

  if (projects.length > 0) {
    const match = fuzzyMatch(input, projects);
    if (match && slugify(match.label) !== slugify(input)) {
      console.log('');
      const { confirm } = await inquirer.prompt([{
        type: 'confirm', name: 'confirm',
        message: chalk.yellow(`  "${input}" looks like existing project "${match.label}" — use "${match.label}"?`),
        default: true,
      }]);
      if (confirm) {
        console.log(chalk.green(`  ✓ Using project "${match.label}"\n`));
        return match.label;
      }
      console.log(chalk.green(`  ✓ Creating new project "${input}"\n`));
      return input;
    }
    if (match && slugify(match.label) === slugify(input)) {
      console.log(chalk.green(`  ✓ Continuing project "${match.label}" — scan will compare against baseline\n`));
      return match.label;
    }
  }

  console.log(chalk.green(`  ✓ New project "${input}" — this scan will establish the baseline\n`));
  return input;
}

// ── Project intelligence display (CLI) ───────────────────────────────────────

export async function handleProjectIntelligence(label, reportText, meta) {
  if (!label) return;

  const result = saveProjectIntelligence(label, reportText, meta);
  if (!result) return;

  if (result.type === 'baseline') {
    console.log(chalk.green(`\n  📊 Project baseline established — ${result.findingCount} findings recorded`));
    console.log(chalk.gray(`  Future scans will automatically compare against this baseline.\n`));
    return;
  }

  // Comparison display
  console.log('\n' + chalk.cyan.bold(`  📊 PROJECT INTELLIGENCE — ${result.label.toUpperCase()}`));
  console.log(chalk.gray(`  Baseline: ${result.baselineDate.slice(0,10)} (${result.baselineCount} findings)`));
  console.log(chalk.gray(`  This scan: ${result.scanDate.slice(0,10)} (${result.findingCount} findings)\n`));
  console.log(
    chalk.green(`  ✓ ${result.resolved} resolved`) + '  ' +
    chalk.red(`✗ ${result.remaining} remaining`) + '  ' +
    chalk.yellow(`⚠ ${result.newIssues} new`)
  );
  console.log(chalk.cyan(`  Remediation progress: ${result.progress}% of baseline issues resolved\n`));

  if (result.newIssues > 0) {
    console.log(chalk.yellow('  New issues since baseline:'));
    result.newIssuesList.forEach(f => console.log(chalk.yellow(`    ⚠ [${f.severity}] ${f.title}`)));
    if (result.newIssuesMore > 0) console.log(chalk.gray(`    ...and ${result.newIssuesMore} more`));
    console.log('');
  }

  if (result.velocity) {
    console.log(chalk.gray(`  Velocity: ~${result.velocity.avgResolved} issues resolved per scan on average`));
    if (result.velocity.scansToFix) {
      console.log(chalk.gray(`  At this pace: ${result.velocity.scansToFix} more scans to clear baseline\n`));
    }
  }
}

// ── Dashboard display (CLI) ───────────────────────────────────────────────────

export async function showProjectDashboard() {
  const data = getProjectDashboardData();

  if (data.length === 0) {
    console.log(chalk.gray('\n  No projects tracked yet. Run a scan and save with a project label.\n'));
    await inquirer.prompt([{ type: 'input', name: 'cont', message: chalk.gray('Press Enter to continue...') }]);
    return;
  }

  console.log('\n' + chalk.cyan.bold('  📊 PROJECT INTELLIGENCE DASHBOARD\n'));

  for (const p of data) {
    const filled = Math.round(p.progress / 5);
    const empty  = 20 - filled;
    const bar    = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));

    console.log(chalk.white.bold(`  ${p.label}`));
    console.log(chalk.gray(`  Baseline: ${p.baselineDate} | Last scan: ${p.lastScan} | ${p.scanCount} scans`));
    console.log(`  ${bar} ${p.progress}% remediated`);
    if (p.newIssues > 0) console.log(chalk.yellow(`  ⚠ ${p.newIssues} new issues in last scan`));
    console.log('');
  }

  await inquirer.prompt([{ type: 'input', name: 'cont', message: chalk.gray('Press Enter to continue...') }]);
}
