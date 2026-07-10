import fs from 'fs';
import { SYM, IS_WINDOWS } from '../cli/symbols.js';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import boxen from 'boxen';
import { REPORTS_DIR } from '../reports.js';
import {
  extractFindings as extractFindingsCanonical,
  similarFinding as similarFindingCanonical,
} from '../utils/finding-parser.js';

export async function runCompareMode() {
  console.log('\n' + boxen(
    chalk.cyan.bold('🔍  BEFORE / AFTER COMPARISON') + '\n' +
    chalk.gray('Compare two Ghost reports to see what changed —\nresolved issues, remaining problems, new findings.'),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
  console.log('');

  // List available reports
  let reports = [];
  try {
    reports = fs.readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.txt'))
      .map(f => ({
        name: f,
        path: path.join(REPORTS_DIR, f),
        mtime: fs.statSync(path.join(REPORTS_DIR, f)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {}

  if (reports.length < 2) {
    console.log(chalk.yellow(`  ${SYM.warn}  You need at least 2 saved reports to compare.`));
    console.log(chalk.gray('  Run a POI scan and save it first.\n'));
    return;
  }

  const choices = reports.map(r => ({ name: r.name, value: r.path }));

  const { beforePath } = await inquirer.prompt([{
    type: 'list',
    name: 'beforePath',
    message: chalk.cyan('Select the BEFORE report (older):'),
    choices
  }]);

  const { afterPath } = await inquirer.prompt([{
    type: 'list',
    name: 'afterPath',
    message: chalk.cyan('Select the AFTER report (newer):'),
    choices: choices.filter(c => c.value !== beforePath)
  }]);

  console.log('');
  console.log(chalk.gray('  Analyzing differences...\n'));

  const beforeText = fs.readFileSync(beforePath, 'utf8');
  const afterText  = fs.readFileSync(afterPath,  'utf8');

  const beforeFindings = extractFindings(beforeText);
  const afterFindings  = extractFindings(afterText);

  const resolved = beforeFindings.filter(f => !afterFindings.some(a => similarFinding(f, a)));
  const newIssues = afterFindings.filter(f => !beforeFindings.some(b => similarFinding(f, b)));
  const remaining = beforeFindings.filter(f => afterFindings.some(a => similarFinding(f, a)));

  // Display results
  console.log(chalk.green.bold(`✅  RESOLVED — ${resolved.length} issue${resolved.length !== 1 ? 's' : ''} fixed`));
  if (resolved.length === 0) {
    console.log(chalk.gray('  None\n'));
  } else {
    resolved.forEach(f => console.log(chalk.green(`  ${SYM.check} ${f.title}`) + chalk.gray(` [${f.severity}]`)));
    console.log('');
  }

  console.log(chalk.red.bold(`🔴  REMAINING — ${remaining.length} issue${remaining.length !== 1 ? 's' : ''} still open`));
  if (remaining.length === 0) {
    console.log(chalk.gray('  None\n'));
  } else {
    remaining.forEach(f => console.log(chalk.red(`  ${SYM.cross} ${f.title}`) + chalk.gray(` [${f.severity}]`)));
    console.log('');
  }

  console.log(chalk.yellow.bold(`🆕  NEW — ${newIssues.length} new issue${newIssues.length !== 1 ? 's' : ''} found`));
  if (newIssues.length === 0) {
    console.log(chalk.gray('  None\n'));
  } else {
    newIssues.forEach(f => console.log(chalk.yellow(`  ${SYM.warn} ${f.title}`) + chalk.gray(` [${f.severity}]`)));
    console.log('');
  }

  // Summary box
  const progress = beforeFindings.length > 0
    ? Math.round((resolved.length / beforeFindings.length) * 100)
    : 0;

  console.log(boxen(
    chalk.white.bold('COMPARISON SUMMARY') + '\n\n' +
    chalk.gray('Before: ') + chalk.white(`${beforeFindings.length} findings`) + '\n' +
    chalk.gray('After:  ') + chalk.white(`${afterFindings.length} findings`) + '\n\n' +
    chalk.green(`${SYM.check} ${resolved.length} resolved`) + '  ' +
    chalk.red(`${SYM.cross} ${remaining.length} remaining`) + '  ' +
    chalk.yellow(`${SYM.warn} ${newIssues.length} new`) + '\n\n' +
    chalk.cyan.bold(`Progress: ${progress}% of original issues resolved`),
    { padding: 1, borderColor: progress >= 75 ? 'green' : progress >= 40 ? 'yellow' : 'red', borderStyle: 'round' }
  ));
  console.log('');

  // Offer to save comparison report
  const { save } = await inquirer.prompt([{
    type: 'confirm',
    name: 'save',
    message: chalk.cyan('Save this comparison to ~/Ghost Architect Reports/?'),
    default: true
  }]);

  if (save) {
    const beforeName = path.basename(beforePath, '.txt');
    const afterName  = path.basename(afterPath,  '.txt');
    const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath    = path.join(REPORTS_DIR, `ghost-compare-${timestamp}.txt`);

    const content = buildCompareReport(beforeName, afterName, resolved, remaining, newIssues, progress);
    fs.writeFileSync(outPath, content);
    console.log(chalk.green(`\n${SYM.check} Comparison saved: ghost-compare-${timestamp}.txt\n`));
  }
}

// ── Finding extraction ─────────────────────────────────────────────────────────
//
// F-26 fix (2026-05-08): the previous local implementation tried to
// match both `### Title` and numbered-list `1. Title` shapes with a
// big regex plus a fixStepVerbs filter and a descBullet filter to
// avoid mis-extracting fix-step bullets. It was complex and still
// wrong on real saved reports. The canonical parser in
// src/utils/finding-parser.js anchors on `### Title` (the format
// SYSTEM_POI/SYSTEM_BLAST actually instruct the model to emit) and
// is the single source of truth across analyst, compare, projects,
// and multipass.
//
// Compare needs landmarks tracked across runs (architectural patterns
// can change between scans), so we pass keepLandmarks: true.
//
// similarFinding is also delegated to the canonical implementation,
// which uses deterministic finding IDs as the primary match key with
// fuzzy title overlap as a fallback — strictly better than the local
// 60%-overlap heuristic that compare previously used.

// keepLandmarks: true is intentional for compare mode. Landmarks represent
// architectural patterns that can change between scans and should appear in
// resolved/remaining/new counts. Other modes (poi, blast, conflict) exclude
// landmarks from their sidecar findingCount — this is a known intentional
// difference between the comparison surface and the sidecar surface.
// @ghost-verified: keepLandmarks: true is intentional for compare mode -- landmarks appear in resolved/remaining/new counts; this intentionally differs from sidecar findingCount which excludes landmarks
function extractFindings(text) {
  return extractFindingsCanonical(text, { keepLandmarks: true });
}

function similarFinding(a, b) {
  return similarFindingCanonical(a, b);
}

function buildCompareReport(beforeName, afterName, resolved, remaining, newIssues, progress) {
  const ts = new Date().toLocaleString();
  let out = `GHOST ARCHITECT — COMPARISON REPORT\n`;
  out += `Generated: ${ts}\n`;
  out += `Before: ${beforeName}\n`;
  out += `After:  ${afterName}\n`;
  out += `${'─'.repeat(60)}\n\n`;

  out += `PROGRESS: ${progress}% of original issues resolved\n\n`;

  out += `✅ RESOLVED (${resolved.length})\n`;
  resolved.forEach(f => { out += `  ${SYM.check} [${f.severity}] ${f.title}\n`; });
  out += '\n';

  out += `🔴 REMAINING (${remaining.length})\n`;
  remaining.forEach(f => { out += `  ${SYM.cross} [${f.severity}] ${f.title}\n`; });
  out += '\n';

  out += `🆕 NEW ISSUES (${newIssues.length})\n`;
  newIssues.forEach(f => { out += `  ${SYM.warn} [${f.severity}] ${f.title}\n`; });
  out += '\n';

  out += `${'─'.repeat(60)}\n`;
  out += `Generated by Ghost Architect — ghostarchitect.dev\n`;
  out += `© 2026 Ghost Architect. All rights reserved.\n`;

  return out;
}
