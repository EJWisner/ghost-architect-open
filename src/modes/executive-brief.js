// executive-brief.js
// Executive Brief mode — one-page business-intelligence report.
//
// Takes a set of Ghost findings, computes a weighted health score, builds a
// structured data object, asks Claude for a plain-language executive narrative,
// then renders a dark-themed deal-grade PDF via ReportLab (Python).
//
// Exported entry point: runExecutiveBriefMode({ findings, tier, scanFile,
// codebaseRoot, anthropicClient }) -> { pdfPath }

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { resolveApiKey, getConfig } from '../config.js';

// ── Health score ─────────────────────────────────────────────────────────────
// Start at 100, deduct per severity with per-band caps, floor at 5.
export function computeHealthScore({ criticalCount, highCount, mediumCount }) {
  let score = 100;
  score -= Math.min(criticalCount * 25, 50);
  score -= Math.min(highCount * 8, 30);
  score -= Math.min(mediumCount * 2, 15);
  return Math.max(score, 5);
}

export function healthLabel(score) {
  if (score >= 90) return 'Healthy';
  if (score >= 70) return 'Moderate Risk';
  if (score >= 50) return 'Elevated Risk';
  if (score >= 30) return 'High Risk';
  return 'Critical Risk';
}

// green / amber / orange / red, keyed off the score band.
function healthColor(score) {
  if (score >= 90) return '#3fb950'; // green
  if (score >= 70) return '#d4a72c'; // amber
  if (score >= 50) return '#e07340'; // orange
  return '#da3633';                  // red
}

function normSeverity(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'critical' || s === 'error') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'medium' || s === 'warning') return 'medium';
  if (s === 'low' || s === 'info') return 'low';
  return 'medium';
}

// Blast profile bucket from the count of affected files.
function blastBucket(finding) {
  const explicit = String(finding.blast_radius || finding.blastProfile || '').toLowerCase();
  if (explicit === 'surgical' || explicit === 'moderate' || explicit === 'broad') return explicit;
  const n = (finding.files || finding.affected_files || []).length;
  if (n <= 1) return 'surgical';
  if (n <= 4) return 'moderate';
  return 'broad';
}

// Pull a single readable sentence out of a finding's detail blob, stripping
// blockquote markers and markdown emphasis.
function oneSentenceDetail(finding) {
  let d = String(finding.detail || finding.description || '').trim();
  if (!d) return '';
  d = d.replace(/^>\s?/gm, ' ')      // blockquote markers
       .replace(/[*_`#]/g, '')       // markdown emphasis / headings
       .replace(/\s+/g, ' ')         // collapse whitespace
       .trim();
  const m = d.match(/^.*?[.!?](\s|$)/);
  let sentence = (m ? m[0] : d).trim();
  if (sentence.length > 240) sentence = sentence.slice(0, 237).trimEnd() + '...';
  return sentence;
}

// ── Structured data object ───────────────────────────────────────────────────
//
// seniorRate falls back to 200 only when the caller passes nothing. The rate is
// a configured value (rateSenior, set in the setup wizard and read by
// analyst/index.js and core/multipass.js). estimatedManualCost used to multiply
// by a hardcoded 200, so a consultant who set their senior rate to 250 got an
// Executive Brief quoting $200/hr while every other Ghost deliverable from the
// same scan quoted $250/hr. Two different numbers in front of the same buyer.
export function buildBriefData(findings, seniorRate = 200) {
  const list = Array.isArray(findings) ? findings : [];
  const bySev = { critical: [], high: [], medium: [], low: [] };
  for (const f of list) bySev[normSeverity(f.severity)].push(f);

  const totalEffortHours = list.reduce((sum, f) => sum + (Number(f.effortHours) || 0), 0);

  const blastProfile = { surgical: 0, moderate: 0, broad: 0 };
  for (const f of list) blastProfile[blastBucket(f)] += 1;

  return {
    criticalCount: bySev.critical.length,
    highCount: bySev.high.length,
    mediumCount: bySev.medium.length,
    lowCount: bySev.low.length,
    topCritical: bySev.critical.slice(0, 2).map(f => ({
      title: String(f.title || 'Untitled critical finding'),
      detail: oneSentenceDetail(f),
    })),
    topHigh: bySev.high.slice(0, 3).map(f => String(f.title || 'Untitled high finding')),
    totalEffortHours: Math.round(totalEffortHours * 10) / 10,
    estimatedManualCost: Math.round(totalEffortHours * seniorRate),
    estimatedAiCost: Math.round(totalEffortHours * AI_COST_PER_MANUAL_HOUR * 100) / 100,
    estimatedAiHours: Math.max(1, Math.ceil(totalEffortHours * AI_HOURS_PER_MANUAL_HOUR)),
    blastProfile,
  };
}

// AI-assisted remediation economics rendered in the buyer-facing PDF.
// These are DELIBERATE modeling assumptions, not measurements: an AI-assisted
// fix cycle is modeled at ~10% of the manual engineering hours, with API spend
// of ~$0.15 per manual hour displaced (roughly one Sonnet-class fix loop per
// small finding at mid-2026 token prices). They exist as named constants so
// the assumption is visible, reviewable, and changeable in one place instead
// of living as magic numbers inside a client deliverable (Audit 7, Q27). If a
// Ghost Partner profile ever carries its own AI-economics assumptions, wire
// them through buildBriefData the way seniorRate already is.
const AI_COST_PER_MANUAL_HOUR  = 0.15;
const AI_HOURS_PER_MANUAL_HOUR = 0.10;

// ── Executive narrative (one Anthropic call) ─────────────────────────────────
const NARRATIVE_SYSTEM =
  'You are a senior enterprise architect writing an executive brief for a ' +
  'non-technical business audience. Write in plain business language. No ' +
  'jargon. No markdown. No bullet points. Short paragraphs. Maximum 3 ' +
  'paragraphs total. Never use em dashes.';

async function generateNarrative(client, { data, healthScore, label, project }) {
  const userPrompt =
    `Project: ${project}\n` +
    `Overall codebase health score: ${healthScore} out of 100 (${label}).\n\n` +
    `Findings breakdown:\n` +
    `Critical: ${data.criticalCount}, High: ${data.highCount}, ` +
    `Medium: ${data.mediumCount}, Low: ${data.lowCount}.\n\n` +
    `Top critical issues:\n` +
    (data.topCritical.length
      ? data.topCritical.map((c, i) => `${i + 1}. ${c.title}. ${c.detail}`).join('\n')
      : 'None.') +
    `\n\nTop high-severity issues:\n` +
    (data.topHigh.length
      ? data.topHigh.map((t, i) => `${i + 1}. ${t}`).join('\n')
      : 'None.') +
    `\n\nRemediation effort estimate: ${data.totalEffortHours} hours.\n` +
    `Estimated manual remediation cost: $${data.estimatedManualCost.toLocaleString()} ` +
    `(senior architect rate). Estimated AI-assisted cost: $${data.estimatedAiCost}.\n` +
    `Blast profile: ${data.blastProfile.surgical} surgical, ` +
    `${data.blastProfile.moderate} moderate, ${data.blastProfile.broad} broad.\n\n` +
    `Write a three paragraph executive summary. Paragraph one: the overall ` +
    `health and what it means for the business. Paragraph two: the top risks ` +
    `in plain language and their business impact. Paragraph three: the ` +
    `recommended path forward and what it will take.`;

  // Honor the user's configured default model instead of pinning Sonnet 4.6;
  // the Brief was the last mode ignoring defaultModel (Audit 7, Q16).
  const briefModel = getConfig().get('defaultModel') || 'claude-sonnet-4-6';
  const resp = await client.messages.create({
    model: briefModel,
    max_tokens: 1000,
    temperature: 0,
    system: NARRATIVE_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return (resp.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

// ── PDF rendering (ReportLab via Python) ─────────────────────────────────────
// Embedded Python so the module stays self-contained. Reads a JSON payload
// from argv[1], writes the PDF to argv[2].
const PY_RENDERER = String.raw`
import json, sys
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table,
    TableStyle, FrameBreak,
)
from reportlab.lib.enums import TA_LEFT

with open(sys.argv[1]) as fh:
    payload = json.load(fh)
out_path = sys.argv[2]

BG     = colors.HexColor('#0a0d12')
PANEL  = colors.HexColor('#11161f')
ORANGE = colors.HexColor('#e07340')
TEXT   = colors.HexColor('#e6edf3')
MUTED  = colors.HexColor('#8b949e')
HEALTH = colors.HexColor(payload['healthColor'])

def para_style(name, **kw):
    base = dict(fontName='Helvetica', fontSize=10, leading=15,
                textColor=TEXT, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(name, **base)

s_logo    = para_style('logo', fontName='Helvetica-Bold', fontSize=15, textColor=ORANGE)
s_title   = para_style('title', fontName='Helvetica-Bold', fontSize=20, textColor=TEXT, leading=24, spaceBefore=4)
s_meta    = para_style('meta', fontSize=9, textColor=MUTED, leading=13)
s_conf    = para_style('conf', fontName='Helvetica-Bold', fontSize=9, textColor=ORANGE, leading=13)
s_section = para_style('section', fontName='Helvetica-Bold', fontSize=12, textColor=ORANGE, spaceBefore=10, spaceAfter=4)
s_body    = para_style('body', fontSize=10, leading=15, spaceAfter=7)
s_score   = para_style('score', fontName='Helvetica-Bold', fontSize=46, textColor=HEALTH, leading=48)
s_scorelbl= para_style('scorelbl', fontName='Helvetica-Bold', fontSize=13, textColor=HEALTH, leading=16)

def paint_bg(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(BG)
    canvas.rect(0, 0, letter[0], letter[1], stroke=0, fill=1)
    canvas.setFillColor(MUTED)
    canvas.setFont('Helvetica', 8)
    canvas.drawCentredString(letter[0] / 2.0, 0.45 * inch, payload['footer_text'])
    canvas.setStrokeColor(ORANGE)
    canvas.setLineWidth(0.5)
    canvas.line(0.75 * inch, 0.65 * inch, letter[0] - 0.75 * inch, 0.65 * inch)
    canvas.restoreState()

story = []
story.append(Paragraph(payload['company_name'], s_logo))
story.append(Paragraph('Executive Codebase Intelligence Brief', s_title))
story.append(Spacer(1, 6))
story.append(Paragraph('Codebase: %s' % payload['project'], s_meta))
story.append(Paragraph('Path: %s' % payload['codebaseRoot'], s_meta))
story.append(Paragraph('Date: %s' % payload['date'], s_meta))
story.append(Paragraph(payload['confidentiality_text'], s_conf))
story.append(Spacer(1, 14))

# Health score + findings summary, side by side.
score_cell = [
    Paragraph(str(payload['healthScore']), s_score),
    Paragraph('out of 100', s_meta),
    Paragraph(payload['healthLabel'].upper(), s_scorelbl),
]
sev = payload['data']
summary_rows = [
    ['Severity', 'Count'],
    ['Critical', str(sev['criticalCount'])],
    ['High', str(sev['highCount'])],
    ['Medium', str(sev['mediumCount'])],
    ['Low', str(sev['lowCount'])],
]
summary_tbl = Table(summary_rows, colWidths=[1.4 * inch, 0.9 * inch])
summary_tbl.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), ORANGE),
    ('TEXTCOLOR', (0, 0), (-1, 0), BG),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('BACKGROUND', (0, 1), (-1, -1), PANEL),
    ('TEXTCOLOR', (0, 1), (-1, -1), TEXT),
    ('TEXTCOLOR', (1, 1), (1, 1), colors.HexColor('#da3633')),
    ('FONTSIZE', (0, 0), (-1, -1), 10),
    ('GRID', (0, 0), (-1, -1), 0.5, BG),
    ('TOPPADDING', (0, 0), (-1, -1), 5),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ('LEFTPADDING', (0, 0), (-1, -1), 8),
]))
header_tbl = Table([[score_cell, summary_tbl]], colWidths=[2.6 * inch, 2.6 * inch])
header_tbl.setStyle(TableStyle([
    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ('BACKGROUND', (0, 0), (0, 0), PANEL),
    ('LEFTPADDING', (0, 0), (0, 0), 16),
    ('RIGHTPADDING', (0, 0), (0, 0), 16),
    ('TOPPADDING', (0, 0), (0, 0), 14),
    ('BOTTOMPADDING', (0, 0), (0, 0), 14),
]))
story.append(header_tbl)
story.append(Spacer(1, 14))

story.append(Paragraph('Executive Summary', s_section))
for para in payload['narrative'].split('\n'):
    para = para.strip()
    if para:
        story.append(Paragraph(para.replace('&', '&amp;'), s_body))

story.append(Paragraph('Remediation Cost Comparison', s_section))
cost_rows = [
    ['Approach', 'Effort', 'Estimated Cost'],
    ['Manual remediation', '%s hrs' % sev['totalEffortHours'], '$%s' % format(sev['estimatedManualCost'], ',')],
    ['AI-assisted with Ghost Brief', '~%s hrs' % sev['estimatedAiHours'], '~$%.2f in API costs' % sev['estimatedAiCost']],
]
cost_tbl = Table(cost_rows, colWidths=[2.4 * inch, 1.1 * inch, 1.7 * inch])
cost_tbl.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), ORANGE),
    ('TEXTCOLOR', (0, 0), (-1, 0), BG),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('BACKGROUND', (0, 1), (-1, -1), PANEL),
    ('TEXTCOLOR', (0, 1), (-1, -1), TEXT),
    ('FONTSIZE', (0, 0), (-1, -1), 10),
    ('GRID', (0, 0), (-1, -1), 0.5, BG),
    ('TOPPADDING', (0, 0), (-1, -1), 6),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ('LEFTPADDING', (0, 0), (-1, -1), 8),
]))
story.append(cost_tbl)

story.append(Paragraph('Recommended Sequence', s_section))
seq_rows = [
    ['Phase', 'Focus', 'Items'],
    ['Phase 1', 'Critical findings', str(sev['criticalCount'])],
    ['Phase 2', 'High findings', str(sev['highCount'])],
    ['Phase 3', 'Medium findings', str(sev['mediumCount'])],
]
seq_tbl = Table(seq_rows, colWidths=[1.2 * inch, 2.6 * inch, 1.4 * inch])
seq_tbl.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), ORANGE),
    ('TEXTCOLOR', (0, 0), (-1, 0), BG),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('BACKGROUND', (0, 1), (-1, -1), PANEL),
    ('TEXTCOLOR', (0, 1), (-1, -1), TEXT),
    ('FONTNAME', (0, 1), (0, -1), 'Helvetica-Bold'),
    ('TEXTCOLOR', (0, 1), (0, -1), ORANGE),
    ('FONTSIZE', (0, 0), (-1, -1), 10),
    ('GRID', (0, 0), (-1, -1), 0.5, BG),
    ('TOPPADDING', (0, 0), (-1, -1), 6),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ('LEFTPADDING', (0, 0), (-1, -1), 8),
]))
story.append(seq_tbl)

frame = Frame(0.75 * inch, 0.75 * inch,
              letter[0] - 1.5 * inch, letter[1] - 1.5 * inch,
              id='main', showBoundary=0)
doc = BaseDocTemplate(out_path, pagesize=letter,
                      leftMargin=0.75 * inch, rightMargin=0.75 * inch,
                      topMargin=0.75 * inch, bottomMargin=0.75 * inch)
doc.addPageTemplates([PageTemplate(id='dark', frames=[frame],
                                   onPage=paint_bg)])
doc.build(story)
`;

function renderPdf(payload) {
  const reportsDir = path.join(os.homedir(), 'Ghost Architect Reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeProject = String(payload.project || 'project')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'project';
  const pdfPath = path.join(reportsDir, `ghost-executive-brief-${safeProject}-${stamp}.pdf`);

  const tmpData = path.join(os.tmpdir(), `ghost-exec-brief-${Date.now()}.json`);
  fs.writeFileSync(tmpData, JSON.stringify(payload), 'utf8');
  try {
    execFileSync('python3', ['-c', PY_RENDERER, tmpData, pdfPath], { stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    if (err.code === 'ENOENT') {
      throw new Error('PDF generation requires python3, which was not found on PATH. Install Python 3 and try again.');
    }
    if (/No module named ['"]?reportlab/.test(stderr)) {
      throw new Error('PDF generation requires the Python "reportlab" package. Install it with: pip3 install reportlab');
    }
    throw new Error(`PDF generation failed (python3 exited ${err.status ?? 'non-zero'}).\n${stderr || '(no stderr captured)'}`);
  } finally {
    try { fs.unlinkSync(tmpData); } catch { /* ignore */ }
  }
  return pdfPath;
}

// ── Entry point ──────────────────────────────────────────────────────────────
export async function runExecutiveBriefMode({ findings, tier, scanFile, codebaseRoot, anthropicClient, branding }) {
  const findingsList = Array.isArray(findings) ? findings : [];
  // Read the configured senior rate rather than letting buildBriefData fall back
  // to its 200 default, so the brief quotes the same hourly rate as every other
  // Ghost deliverable. Same resolution as analyst/index.js's rates().
  const seniorRate = getConfig().get('rateSenior') || 200;
  const data = buildBriefData(findingsList, seniorRate);
  const healthScore = computeHealthScore(data);
  const label = healthLabel(healthScore);

  const project = (scanFile
    ? path.basename(scanFile).replace(/\.findings\.json$/i, '').replace(/\.json$/i, '')
    : (codebaseRoot ? path.basename(codebaseRoot) : 'project'));

  // Empty findings: the codebase passed pre-engagement review with nothing to
  // remediate. Skip the narrative API call (there is nothing to summarize) and
  // emit a clean, complete clean-bill-of-health brief rather than erroring or
  // paying for an awkward "zero findings" narrative. computeHealthScore already
  // returns a perfect 100 for an all-zero finding set. No em dashes (rule 1 and
  // the narrative style contract).
  let narrative;
  if (findingsList.length === 0) {
    narrative =
      'This pre-engagement review surfaced no significant findings. The codebase ' +
      'passed automated triage across the analyzed scope, with no critical, high, ' +
      'medium, or low-severity issues flagged for remediation. On the evidence ' +
      'reviewed it presents a clean baseline: no immediate remediation work is ' +
      'indicated, and the estimated remediation effort and cost are zero. As with ' +
      'any automated review, this reflects the findings the scan produced and is ' +
      'not a guarantee that every possible defect is absent.';
  } else {
    const client = anthropicClient || new Anthropic({ apiKey: resolveApiKey() });
    try {
      narrative = await generateNarrative(client, { data, healthScore, label, project });
    } catch (e) {
      narrative =
        'An executive narrative could not be generated automatically for this brief. ' +
        'The findings summary, cost comparison, and recommended sequence below reflect ' +
        'the underlying scan data. (' + (e.message || 'narrative generation failed') + ')';
    }
  }

  const payload = {
    project,
    codebaseRoot: codebaseRoot || scanFile || 'unknown',
    tier: tier || 'open',
    date: new Date().toISOString().slice(0, 10),
    healthScore,
    healthLabel: label,
    healthColor: healthColor(healthScore),
    data,
    narrative,
    company_name:         branding ? branding.companyName    : 'GHOST ARCHITECT\u2122',
    footer_text:          branding ? branding.footerText      : 'ghostarchitect.dev',
    confidentiality_text: branding ? branding.confidentiality : 'CONFIDENTIAL',
  };

  const pdfPath = renderPdf(payload);
  return { pdfPath };
}

export default runExecutiveBriefMode;
