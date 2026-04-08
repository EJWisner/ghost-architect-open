import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { generatePDF } from './pdf-generator.js';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version: GHOST_VERSION } = _require('../package.json');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPORTS_DIR = path.join(os.homedir(), 'Ghost Architect Reports');

export function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    console.log(chalk.gray(`  ✓ Created reports folder: ~/Ghost Architect Reports\n`));
  }
  return REPORTS_DIR;
}

export async function saveReport(content, prefix, label, meta = {}) {
  const dir = ensureReportsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = label ? label.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 30) : '';
  const baseName = safeName ? `${prefix}-${safeName}-${timestamp}` : `${prefix}-${timestamp}`;

  // Save TXT — plain text, terminal-friendly
  const txtPath = path.join(dir, `${baseName}.txt`);
  fs.writeFileSync(txtPath, stripAnsi(content));

  // Save MD — formatted Markdown, developer-friendly
  const mdContent = convertToMarkdown(content, prefix, label, meta, timestamp);
  const mdPath = path.join(dir, `${baseName}.md`);
  fs.writeFileSync(mdPath, mdContent);

  // Save PDF — branded professional report, client-friendly
  const pdfPath = path.join(dir, `${baseName}.pdf`);
  const reportType = prefix === 'ghost-poi'      ? 'Points of Interest Report'
    : prefix === 'ghost-blast'    ? 'Blast Radius Analysis + Rollback Plan'
    : prefix === 'ghost-conflict' ? 'Conflict Detection Report'
    : prefix === 'ghost-chat'     ? 'Chat Transcript'
    : 'Report';
  const metaWithType = { ...meta, project: label || 'Project Analysis', reportType, version: GHOST_VERSION };
  
  try {
    await generatePDF(stripAnsi(content), pdfPath, metaWithType);
  } catch (err) {
    // PDF generation failed silently — TXT and MD are still saved
    console.log(chalk.gray(`  (PDF generation skipped — ${err.message})`));
  }

  const pdfExists = fs.existsSync(pdfPath);

  return {
    filename: baseName,
    txtFile: `${baseName}.txt`,
    mdFile: `${baseName}.md`,
    pdfFile: pdfExists ? `${baseName}.pdf` : null,
    txtPath,
    mdPath,
    pdfPath: pdfExists ? pdfPath : null,
    dir: REPORTS_DIR
  };
}

function convertToMarkdown(content, prefix, label, meta, timestamp) {
  const clean = stripAnsi(content);
  const date = new Date().toLocaleString();

  // Build report type label
  const typeLabel = prefix === 'ghost-poi'      ? 'Points of Interest Report'
    : prefix === 'ghost-blast'    ? 'Blast Radius Analysis'
    : prefix === 'ghost-conflict' ? 'Conflict Detection Report'
    : prefix === 'ghost-chat'     ? 'Chat Transcript'
    : 'Report';

  // Build header
  let md = `# Ghost Architect — ${typeLabel}\n\n`;
  md += `| | |\n|---|---|\n`;
  md += `| **Project** | ${label || 'Unnamed project'} |\n`;
  md += `| **Generated** | ${date} |\n`;
  if (meta.filesAnalyzed) md += `| **Files Analyzed** | ${meta.filesAnalyzed} |\n`;
  if (meta.totalFiles) md += `| **Total Files in Project** | ${meta.totalFiles} |\n`;
  if (meta.cost) md += `| **Analysis Cost** | ${meta.cost} |\n`;
  md += `| **Tool** | Ghost Architect v${GHOST_VERSION} |\n`;
  md += `| **Copyright** | © 2026 Ghost Architect. All rights reserved. |\n\n`;
  md += `---\n\n`;

  // Convert content — clean up terminal formatting for Markdown
  let body = clean
    // Headers
    .replace(/^# (.+)$/gm, '# $1')
    .replace(/^## (.+)$/gm, '## $1')
    .replace(/^### (.+)$/gm, '### $1')
    // Severity badges — convert to bold colored text
      .replace(/🔴 \*\*CRITICAL\*\*/g, 'CRITICAL')
      .replace(/🟠 \*\*HIGH\*\*/g, 'HIGH')
      .replace(/🟡 \*\*MEDIUM\*\*/g, 'MEDIUM')
      .replace(/🟢 \*\*LOW\*\*/g, 'LOW')
      .replace(/\bCRITICAL\b/g, '🔴 **CRITICAL**')
      .replace(/\bHIGH\b/g, '🟠 **HIGH**')
      .replace(/\bMEDIUM\b/g, '🟡 **MEDIUM**')
      .replace(/\bLOW\b/g, '🟢 **LOW**')    // Section dividers
    .replace(/^---+$/gm, '\n---\n')
    // Clean up excessive blank lines
    .replace(/\n{4,}/g, '\n\n\n');
  const bodyNoSummary = body.replace(/## 📊 .*?SUMMARY[\s\S]*$/i, '');
  // Ghost Open: MD truncated to Critical + High findings only
  const findingBlocks = bodyNoSummary.split(/(?=\n---\n)/);
  const shownFindings = (bodyNoSummary.match(/🔴 \*\*CRITICAL\*\*|🟠 \*\*HIGH\*\*/g) || []).length;
  const totalFindings = (bodyNoSummary.match(/🔴 \*\*CRITICAL\*\*|🟠 \*\*HIGH\*\*|🟡 \*\*MEDIUM\*\*|🟢 \*\*LOW\*\*/g) || []).length;
  const critHighBlocks = findingBlocks.filter(block =>
    /🔴 \*\*CRITICAL\*\*|🟠 \*\*HIGH\*\*/.test(block)
  );
  const truncatedBody = critHighBlocks.join('');
  md += truncatedBody;

  md += `\n\n---\n\n`;
  md += `> You are looking at ${shownFindings} of ${totalFindings} findings. The rest are in Ghost Pro — full PDF, markdown, multipass, project intelligence. Know what you are inheriting before you commit. [ghostarchitect.dev](https://ghostarchitect.dev)\n`;
  md += `\n`;

  md += `\n\n---\n\n`;
  md += `*Generated by Ghost Architect — AI-powered codebase intelligence*  \n`;
  md += `*ghostarchitect.dev*\n`;

  return md;
}

export function listReports() {
  const dir = ensureReportsDir();
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.txt') || f.endsWith('.md'))
    .map(f => ({
      name: f,
      path: path.join(dir, f),
      modified: fs.statSync(path.join(dir, f)).mtime
    }))
    .sort((a, b) => b.modified - a.modified);
  return files;
}

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

export { REPORTS_DIR, convertToMarkdown };
