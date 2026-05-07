import fs from 'fs';
const IS_WINDOWS = process.platform === 'win32';
const SYM = { check: IS_WINDOWS ? '[OK]' : '✓', cross: IS_WINDOWS ? '[X]' : '✗' };
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import boxen from 'boxen';
import { REPORTS_DIR } from '../reports.js';

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
    console.log(chalk.yellow('  ⚠  You need at least 2 saved reports to compare.'));
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
    newIssues.forEach(f => console.log(chalk.yellow(`  ⚠ ${f.title}`) + chalk.gray(` [${f.severity}]`)));
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
    chalk.yellow(`⚠ ${newIssues.length} new`) + '\n\n' +
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

function extractFindings(text) {
  const findings = [];
  const lines = text.split('\n');

  const sectionPattern = /^(?:🔴|🏛|🏛️|⚰️|⚡|📊|##\s)/;
  const landmarkPattern = /LANDMARK|🏛/i;
  const findingPattern = /^(?:###\s+)?\d+\.\s+\*?\*?(.+?)\*?\*?$/;
  const severityPattern = /\*?\*?Severity:\*?\*?\s*(CRITICAL|HIGH|MEDIUM|LOW)/i;
  const importancePattern = /\*?\*?Importance:\*?\*?\s*(CRITICAL|HIGH|MEDIUM|LOW)/i;
  const naPattern = /\*?\*?Severity:\*?\*?\s*N\/A/i;  // LANDMARK findings use Severity: N/A

  const fixStepVerbs = /^(add|remove|use|replace|check|ensure|move|set|document|consider|implement|audit|update|extract|provide|expose|validate|track|introduce|accumulate|log|test|grep|keep|delete|run|verify|create|disable|enable|gate|save|restore|notify|post|close|open|read|write|scan|load|store|if\s|or\s|see\s|apply\s|for\s)/i;

  const descBullet = /^(•|\*\s|-\s|`|WHY:|IMPACT:|FUNCTION|EXAMPLE|CAVEAT|Also\s|Contains\s|Every\s|This\s|The\s|If\s|On\s|When\s|Changes\s|Modifies\s|Handles\s|Manages\s|Performs\s|Reads\s|Writes\s|Translates\s|Determines\s|Maps\s|Polls\s|Resets\s|Transfers\s|Triggers\s|Acquires\s|Creates\s|Schedules\s|Waits\s|Releases\s|Copies\s|Allocates\s|Manually\s|Automatically\s|Decodes\s|Opens\s|Implements\s|Intercepts\s|Converts\s|Connects\s|Bridges\s|Wraps\s|Exposes\s|Provides\s)/;

  let currentFinding = null;
  let inRecommendedFix = false;
  let inLandmarkSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect section header changes
    if (sectionPattern.test(line)) {
      inLandmarkSection = landmarkPattern.test(line);
      inRecommendedFix = false;
    }

    // Enter fix section
    if (/^(\*\*)?Recommended Fix:(\*\*)?/i.test(line)) { inRecommendedFix = true; continue; }

    // Exit fix section
    if (/^Fix Priority:/i.test(line)) { inRecommendedFix = false; continue; }
    if (inRecommendedFix && line === '') {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      const next = lines[j]?.trim() || '';
      if (/^(?:###\s+)?\d+\.\s+/.test(next) || sectionPattern.test(next)) inRecommendedFix = false;
    }
    if (inRecommendedFix) continue;

    // Skip description bullets
    if (descBullet.test(line)) continue;

    const match = line.match(findingPattern);
    if (match) {
      const title = match[1].replace(/\*\*/g, '').trim();
      if (fixStepVerbs.test(title) || title.length > 100 || descBullet.test(title)) continue;

      if (currentFinding) findings.push(currentFinding);
      currentFinding = { title, severity: inLandmarkSection ? 'LANDMARK' : 'UNKNOWN', raw: line };
    } else if (currentFinding) {
      const sev = line.match(severityPattern) || line.match(importancePattern);
      if (sev) currentFinding.severity = sev[1].toUpperCase();
      // Severity: N/A means this is a LANDMARK architectural finding
      if (naPattern.test(line)) currentFinding.severity = 'LANDMARK';
    }
  }

  if (currentFinding) findings.push(currentFinding);
  return findings;
}

function similarFinding(a, b) {
  // Normalize titles for comparison — strip numbers, punctuation, lowercase
  const normalize = s => s.toLowerCase().replace(/^\d+\.\s+/, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const na = normalize(a.title);
  const nb = normalize(b.title);

  // Exact match
  if (na === nb) return true;

  // Significant word overlap (>60%)
  const wordsA = new Set(na.split(' ').filter(w => w.length > 3));
  const wordsB = new Set(nb.split(' ').filter(w => w.length > 3));
  if (wordsA.size === 0) return false;
  const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
  return overlap / wordsA.size >= 0.6;
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
  remaining.forEach(f => { out += `  ✗ [${f.severity}] ${f.title}\n`; });
  out += '\n';

  out += `🆕 NEW ISSUES (${newIssues.length})\n`;
  newIssues.forEach(f => { out += `  ⚠ [${f.severity}] ${f.title}\n`; });
  out += '\n';

  out += `${'─'.repeat(60)}\n`;
  out += `Generated by Ghost Architect — ghostarchitect.dev\n`;
  out += `© 2026 Ghost Architect. All rights reserved.\n`;

  return out;
}
