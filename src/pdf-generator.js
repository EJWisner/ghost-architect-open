/**
 * Ghost Architect PDF Report Generator v2.5
 * Copyright © 2026 Ghost Architect. All rights reserved.
 * Pure Node.js — no Python or system dependencies required.
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const C = {
  DARK_BG:    [13,  17,  23],
  NAVY:       [10,  22,  40],
  TEAL:       [0,   180, 216],
  ORANGE:     [255, 107, 53],
  PURPLE:     [123, 47,  190],
  RED:        [220, 38,  38],
  AMBER:      [217, 119, 6],
  GREEN:      [22,  163, 74],
  LIGHT_GRAY: [229, 231, 235],
  MED_GRAY:   [107, 114, 128],
  WHITE:      [255, 255, 255],
  CARD_BG:    [248, 250, 252],
  TEXT_DARK:  [31,  41,  55],
  BLUE:       [8,   145, 178],
};

const SECTION_MAP = {
  'RED FLAGS':           C.RED,
  'LANDMARKS':           C.TEAL,
  'DEAD ZONES':          C.MED_GRAY,
  'FAULT LINES':         C.AMBER,
  'REMEDIATION SUMMARY': C.PURPLE,
  'ROLLBACK PLAN':       C.ORANGE,
  'REMEDIATION PLAN':    C.BLUE,
  'DIRECT DEPENDENCIES': C.RED,
  'RIPPLE EFFECTS':      C.AMBER,
  'DANGER ZONES':        C.RED,
  'SAFE ZONES':          C.GREEN,
};

const PW = 612, PH = 792;
const ML = 43,  CW = PW - 86;
const HEADER_H = 40;
const FOOTER_H = 28;
const TOP    = HEADER_H + 14;
const BOTTOM = PH - FOOTER_H - 30;

function box(doc, x, y, w, h, color) {
  doc.save().rect(x, y, w, h).fill(color).restore();
}

function stripAnsi(s)  { return s.replace(/\x1B\[[0-9;]*m/g, ''); }
function stripEmoji(s) {
  return s.replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
          .replace(/[\u{2600}-\u{27BF}]/gu, '')
          .replace(/[🚩⚠✅❌🔴🟠🟡🟢👻💬📁🐙⚙🚪🗜■]/gu, '');
}
function stripMd(s) { return s.replace(/\*\*(.+?)\*\*/g,'$1').replace(/\*(.+?)\*/g,'$1').replace(/`(.+?)`/g,'$1'); }
function clean(s)   { return stripEmoji(stripMd(stripAnsi(s))).trim(); }

function sevColor(t) {
  const u = t.toUpperCase();
  if (u.includes('CRITICAL')) return C.RED;
  if (u.includes('HIGH'))     return C.ORANGE;
  if (u.includes('MEDIUM'))   return C.AMBER;
  if (u.includes('LOW'))      return C.GREEN;
  return C.MED_GRAY;
}

function secColor(t) {
  const u = t.toUpperCase();
  for (const [k,v] of Object.entries(SECTION_MAP)) if (u.includes(k)) return v;
  return C.NAVY;
}

function drawChrome(doc, pageNum, logoPath) {
  const ts = new Date().toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
  // Header
  box(doc, 0, 0, PW, HEADER_H, C.DARK_BG);
  if (logoPath && fs.existsSync(logoPath)) {
    try { doc.image(logoPath, 10, 6, { width: 28, height: 28 }); } catch(e) {}
  }
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.WHITE).text('Ghost Architect', 46, 11, { lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(C.TEAL).text('AI-powered codebase intelligence  |  ghostarchitect.dev', 46, 25, { lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(C.MED_GRAY).text(`Page ${pageNum}`, PW - 80, 17, { width: 60, align: 'right', lineBreak: false });
  // Footer
  box(doc, 0, PH - FOOTER_H, PW, FOOTER_H, C.DARK_BG);
  doc.font('Helvetica').fontSize(7).fillColor(C.MED_GRAY).text(`Generated ${ts}  |  ghostarchitect.dev`, 20, PH - 18, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C.TEAL).text('© 2026 Ghost Architect. All rights reserved. Confidential.', 0, PH - 18, { width: PW - 20, align: 'right', lineBreak: false });
  // Reset cursor to content area so pdfkit internals don't drift
  doc.x = ML;
  doc.y = TOP;
}

export async function generatePDF(reportText, outputPath, meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      const logoPath = path.join(__dirname, '..', 'assets', 'logo.jpeg');
      const doc = new PDFDocument({ size: 'LETTER', margin: 0, autoFirstPage: true,
        info: { Title: 'Ghost Architect Report', Author: 'Ghost Architect' } });
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      let y = TOP;
      let pageNum = 1;

      // Draw chrome on first page immediately
      drawChrome(doc, pageNum, logoPath);

      function newPage() {
        doc.addPage();
        pageNum++;
        y = TOP;
        drawChrome(doc, pageNum, logoPath);
      }

      function need(h) { if (y + h > BOTTOM) newPage(); }

      function writeLine(text, opts = {}) {
        const { font = 'Helvetica', size = 9, color = C.TEXT_DARK, indent = 0 } = opts;
        doc.font(font).fontSize(size);
        const h = doc.heightOfString(text, { width: CW - indent }) + 2;
        need(h);
        doc.fillColor(color).text(text, ML + indent, y, { width: CW - indent });
        y += h + 1;
      }

      // Cover banner
      need(58);
      box(doc, ML, y, CW, 52, C.DARK_BG);
      doc.font('Helvetica-Bold').fontSize(22).fillColor(C.WHITE)
         .text(meta.reportType || 'Points of Interest Report', ML + 16, y + 14, { width: CW - 32, lineBreak: false });
      y += 58;

      // Metadata card
      need(96);
      const cardH = 82;
      box(doc, ML, y, CW, cardH, C.CARD_BG);
      doc.save().rect(ML, y, CW, cardH).lineWidth(0.5).stroke(C.LIGHT_GRAY).restore();
      if (logoPath && fs.existsSync(logoPath)) {
        try { doc.image(logoPath, ML + 12, y + 12, { width: 56, height: 56 }); } catch(e) {}
      }
      let my = y + 12;
      const mx = ML + 80, mw = CW - 90;
      doc.font('Helvetica-Bold').fontSize(14).fillColor(C.TEXT_DARK).text(meta.project || 'Project Analysis', mx, my, { width: mw }); my += 18;
      doc.font('Helvetica').fontSize(9).fillColor(C.MED_GRAY);
      const ts = new Date().toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
      doc.text(`Generated: ${ts}`, mx, my, { width: mw }); my += 12;
      if (meta.filesAnalyzed) { doc.text(`Files analyzed: ${meta.filesAnalyzed}`, mx, my, { width: mw }); my += 12; }
      if (meta.cost)          { doc.text(`Analysis cost: ${meta.cost}`, mx, my, { width: mw }); my += 12; }
      doc.text(`Ghost Architect v${meta.version || '3.2.1'}  |  ghostarchitect.dev`, mx, my, { width: mw });
      y += cardH + 14;

      // Body
      const lines = reportText.split('\n');
      let i = 0;
      let lastSection = '';

      while (i < lines.length) {
        const line = lines[i].trim();
        if (!line) { y += 4; i++; continue; }

        // Section header
        const isMdSec    = /^##\s/.test(line);
        const isGhostSec = /^(🔴|🏛|🏛️|⚰️|⚡|📊)\s/.test(line) ||
          /^(RED FLAGS|LANDMARKS|DEAD ZONES|FAULT LINES|REMEDIATION SUMMARY|ROLLBACK PLAN|DIRECT DEPENDENCIES|RIPPLE EFFECTS|DANGER ZONES|SAFE ZONES)\b/i.test(line);
        if (isMdSec || isGhostSec) {
          const raw   = stripAnsi(isMdSec ? line.replace(/^#+\s*/,'') : line);
          const label = clean(raw);
          // Skip if same section as last one — Ghost repeats section headers per finding
          if (label === lastSection) { i++; continue; }
          lastSection = label;
          // Require space for banner + at least one finding header below it
          need(30 + 28 + 22);
          box(doc, ML, y, CW, 26, secColor(raw));
          doc.font('Helvetica-Bold').fontSize(11).fillColor(C.WHITE)
             .text(label, ML + 12, y + 8, { width: CW - 24, lineBreak: false, ellipsis: true });
          y += 30; i++; continue;
        }

        // Finding header — look ahead to see if the whole block fits
        const isMdFind    = /^###\s/.test(line);
        const isGhostFind = /^\d+\.\s+[A-Z]/.test(line) && line.length > 10;
        if (isMdFind || isGhostFind) {
          // Look ahead: estimate height of this entire finding block
          let lookahead = 28; // finding header
          let j = i + 1;
          while (j < lines.length) {
            const next = lines[j].trim();
            // Stop at next finding, section header, or blank line after content
            if (/^###\s/.test(next) || /^\d+\.\s+[A-Z]/.test(next) && next.length > 10) break;
            if (isMdSec || /^(🔴|🏛|🏛️|⚰️|⚡|📊)\s/.test(next)) break;
            lookahead += next ? 14 : 4;
            if (lookahead > 120) break; // cap estimate at 120px — if it's bigger it'll paginate mid-block which is fine
            j++;
          }
          need(Math.min(lookahead, 80)); // ensure at least 80px free before starting a finding
          const label = clean(isMdFind ? line.replace(/^#+\s*/,'') : line);
          box(doc, ML, y, CW, 24, C.CARD_BG);
          box(doc, ML, y,  3, 24, C.TEAL);
          doc.save().rect(ML, y, CW, 24).lineWidth(0.3).stroke(C.LIGHT_GRAY).restore();
          doc.font('Helvetica-Bold').fontSize(10).fillColor(C.TEXT_DARK)
             .text(label, ML + 10, y + 7, { width: CW - 20, lineBreak: false });
          y += 28; i++; continue;
        }

        // Severity badge
        const sevM = line.match(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/i);
        if (sevM && (line.toLowerCase().startsWith('severity') || /^\*\*(critical|high|medium|low)\*\*/i.test(line))) {
          need(22);
          box(doc, ML, y, 72, 18, sevColor(sevM[1]));
          doc.font('Helvetica-Bold').fontSize(8).fillColor(C.WHITE)
             .text(sevM[1].toUpperCase(), ML, y + 5, { width: 72, align: 'center', lineBreak: false });
          y += 22; i++; continue;
        }

        // HR
        if (/^-{3,}$/.test(line)) {
          need(12);
          doc.save().moveTo(ML, y+4).lineTo(ML+CW, y+4).lineWidth(0.5).stroke(C.LIGHT_GRAY).restore();
          y += 10; i++; continue;
        }

        // Table
        if (line.startsWith('|')) {
          const rows = [];
          while (i < lines.length && lines[i].trim().startsWith('|')) {
            const ro = lines[i].trim();
            if (!/^\|[-:\s|]+\|$/.test(ro)) rows.push(ro.split('|').slice(1,-1).map(c => clean(c)));
            i++;
          }
          const cols = rows.length ? Math.max(...rows.map(ro => ro.length)) : 0;
          const cw2 = CW / (cols || 1);
          for (let ri = 0; ri < rows.length; ri++) {
            need(18);
            box(doc, ML, y, CW, 18, ri===0 ? C.NAVY : (ri%2===0 ? C.CARD_BG : C.WHITE));
            rows[ri].forEach((cell, ci) => {
              doc.font(ri===0?'Helvetica-Bold':'Helvetica').fontSize(8)
                 .fillColor(ri===0?C.WHITE:C.TEXT_DARK)
                 .text(cell, ML+ci*cw2+6, y+5, { width: cw2-10, lineBreak: false });
            });
            doc.save().rect(ML, y, CW, 18).lineWidth(0.3).stroke(C.LIGHT_GRAY).restore();
            y += 18;
          }
          if (rows.length) y += 6;
          continue;
        }

        // Code block — skip entirely (PDF is for stakeholders, not developers)
        if (line.startsWith('```') || line === '`c' || line === '`') {
          i++;
          while (i < lines.length) {
            const cl = lines[i].trim();
            if (cl.startsWith('```') || cl === '`') { i++; break; }
            i++;
          }
          continue;
        }

        // Detect truncated remediation summary — add graceful note
        if (line.toLowerCase().includes('analysis coverage') && line.toLowerCase().endsWith('covers')) {
          writeLine('Analysis Coverage: Partial scan — run additional passes for complete cost estimate.', { font: 'Helvetica', color: C.MED_GRAY });
          writeLine('Re-run with more passes to generate the full remediation cost table.', { font: 'Helvetica', color: C.MED_GRAY });
          i++; continue;
        }

        if (line.startsWith('- ') || line.startsWith('• ')) { writeLine(`• ${clean(line.slice(2))}`, { indent: 14 }); i++; continue; }
        if (/^\d+\./.test(line)) { writeLine(clean(line), { indent: 14 }); i++; continue; }
        if (/^\*\*.+\*\*/.test(line)) { writeLine(clean(line), { font: 'Helvetica-Bold' }); i++; continue; }
        writeLine(clean(line)); i++;
      }

      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    } catch(err) { reject(err); }
  });
}
