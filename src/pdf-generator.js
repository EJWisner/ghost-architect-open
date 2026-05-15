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
function clean(s)   { return stripEmoji(stripMd(stripAnsi(s))).replace(/!'/g, '->').trim(); }

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

function drawChrome(doc, pageNum, logoPath, branding = null, trialInfo = null) {
  const ts = new Date().toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });

  // ── Trial watermark ──────────────────────────────────────────────────────
  // When the active license is trial-tier, every page gets a large translucent
  // diagonal "TRIAL" stamp plus a footer-level identifier with the license id
  // and expiration. The output stays readable but is visibly unsuitable for
  // submitting to a deal committee — protects the value of the paid tier
  // without breaking the trial UX. Drawn FIRST so all other chrome paints
  // on top of it cleanly.
  if (trialInfo && trialInfo.trial) {
    doc.save();
    // Big diagonal stamp: light gray, large font, rotated -30 degrees,
    // centered on the page. Render with low opacity so body text remains
    // readable through it.
    doc.opacity(0.10);
    doc.fillColor([180, 0, 0]); // red so it's unmistakable
    doc.font('Helvetica-Bold').fontSize(120);
    doc.rotate(-30, { origin: [PW / 2, PH / 2] });
    doc.text('TRIAL', 0, PH / 2 - 60, {
      width: PW,
      align: 'center',
      lineBreak: false,
    });
    doc.restore();

    // Smaller secondary stamp at top-right of content area: license id and
    // expiration. Higher opacity so reviewers can read who/when this trial
    // was issued at a glance.
    doc.save();
    doc.opacity(0.55);
    doc.fillColor([180, 0, 0]);
    doc.font('Helvetica-Bold').fontSize(7);
    const stampLines = [
      'TRIAL OUTPUT — NOT FOR DISTRIBUTION',
      `Lic: ${trialInfo.trialLicenseId || 'unknown'}  ·  Expires: ${(trialInfo.trialExpires || '').slice(0, 10)}`,
    ];
    doc.text(stampLines.join('\n'), 0, HEADER_H + 2, {
      width: PW - 8,
      align: 'right',
      lineBreak: true,
    });
    doc.restore();
  }

  // White-label mode: use the consultant's accent color and company name
  // in the header/footer. No Ghost Architect branding rendered.
  // Default mode: dark navy bar, teal accent, Ghost Architect branding.
  const isWL          = !!(branding && branding.isWhiteLabeled);
  const headerBg      = isWL ? branding.accentColor : C.DARK_BG;
  const accentText    = isWL ? C.WHITE              : C.TEAL;
  const headerLogoSrc = isWL ? branding.logoPath    : logoPath;

  // Header
  box(doc, 0, 0, PW, HEADER_H, headerBg);
  if (headerLogoSrc && fs.existsSync(headerLogoSrc)) {
    try { doc.image(headerLogoSrc, 10, 6, { fit: [28, 28] }); } catch(e) {}
  }

  if (isWL) {
    // Consultant header: company name on the left, no tagline (keeps it
    // looking like a corporate deliverable, not a tool).
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.WHITE)
       .text(branding.companyName, 46, 14, { lineBreak: false });
    if (branding.methodology) {
      doc.font('Helvetica').fontSize(8).fillColor(C.WHITE)
         .text(branding.methodology, 46, 27, { lineBreak: false });
    }
  } else {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.WHITE)
       .text('Ghost Architect', 46, 11, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(C.TEAL)
       .text('AI-powered codebase intelligence  |  ghostarchitect.dev', 46, 25, { lineBreak: false });
  }

  doc.font('Helvetica').fontSize(8).fillColor(isWL ? C.WHITE : C.MED_GRAY)
     .text(`Page ${pageNum}`, PW - 80, 17, { width: 60, align: 'right', lineBreak: false });

  // Footer
  box(doc, 0, PH - FOOTER_H, PW, FOOTER_H, headerBg);
  if (isWL) {
    doc.font('Helvetica').fontSize(7).fillColor(C.WHITE)
       .text(`Generated ${ts}`, 20, PH - 18, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.WHITE)
       .text(branding.confidentiality, 0, PH - 18, { width: PW - 20, align: 'right', lineBreak: false });
  } else {
    doc.font('Helvetica').fontSize(7).fillColor(C.MED_GRAY)
       .text(`Generated ${ts}  |  ghostarchitect.dev`, 20, PH - 18, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.TEAL)
       .text('© 2026 Ghost Architect. All rights reserved. Confidential.', 0, PH - 18, { width: PW - 20, align: 'right', lineBreak: false });
  }

  // Reset cursor to content area so pdfkit internals don't drift
  doc.x = ML;
  doc.y = TOP;
}

export async function generatePDF(reportText, outputPath, meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      const logoPath = path.join(__dirname, '..', 'assets', 'logo.jpeg');
      const branding = meta.branding || null;
      const isWL     = !!(branding && branding.isWhiteLabeled);

      // PDF metadata: title and author reflect the consultant in white-label
      // mode so a downloaded file's properties don't leak "Ghost Architect".
      const pdfTitle  = isWL ? `${branding.companyName} — ${meta.reportType || 'Analysis'}` : 'Ghost Architect Report';
      const pdfAuthor = isWL ? (branding.author || branding.companyName)                    : 'Ghost Architect';

      const doc = new PDFDocument({ size: 'LETTER', margin: 0, autoFirstPage: true,
        info: { Title: pdfTitle, Author: pdfAuthor } });
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      let y = TOP;
      let pageNum = 1;

      // Trial state from saveReport — when present, drawChrome stamps every
      // page with a "TRIAL" watermark + license id + expiration.
      const trialInfo = meta.trial
        ? {
            trial: true,
            trialLicenseId: meta.trialLicenseId,
            trialExpires: meta.trialExpires,
          }
        : null;

      // Draw chrome on first page immediately
      drawChrome(doc, pageNum, logoPath, branding, trialInfo);

      function newPage() {
        doc.addPage();
        pageNum++;
        y = TOP;
        drawChrome(doc, pageNum, logoPath, branding, trialInfo);
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
      // White-label: accent-colored banner with company name + report type +
      // "Prepared by" + methodology byline. Reads as a consultant deliverable.
      // Default: dark banner with the report type only.
      const bannerH = isWL ? 80 : 52;
      need(bannerH + 6);
      const bannerBg = isWL ? branding.accentColor : C.DARK_BG;
      box(doc, ML, y, CW, bannerH, bannerBg);
      if (isWL) {
        // Stack: company name (large), report type (medium), methodology + author (small)
        doc.font('Helvetica-Bold').fontSize(20).fillColor(C.WHITE)
           .text(branding.companyName, ML + 16, y + 12, { width: CW - 32, lineBreak: false });
        doc.font('Helvetica').fontSize(13).fillColor(C.WHITE)
           .text(meta.reportType || 'Pre-Engagement Triage', ML + 16, y + 36, { width: CW - 32, lineBreak: false });
        const subline = [
          branding.methodology,
          branding.author ? `Prepared by ${branding.author}` : null,
        ].filter(Boolean).join('  ·  ');
        if (subline) {
          doc.font('Helvetica').fontSize(9).fillColor(C.WHITE)
             .text(subline, ML + 16, y + 58, { width: CW - 32, lineBreak: false });
        }
      } else {
        doc.font('Helvetica-Bold').fontSize(22).fillColor(C.WHITE)
           .text(meta.reportType || 'Points of Interest Report', ML + 16, y + 14, { width: CW - 32, lineBreak: false });
      }
      y += bannerH + 6;

      // Metadata card
      need(96);
      const cardH = 82;
      box(doc, ML, y, CW, cardH, C.CARD_BG);
      doc.save().rect(ML, y, CW, cardH).lineWidth(0.5).stroke(C.LIGHT_GRAY).restore();

      // Logo: consultant logo in white-label mode (already validated as
      // existing on disk by getBranding); Ghost logo otherwise.
      const cardLogoSrc = isWL ? branding.logoPath : logoPath;
      if (cardLogoSrc && fs.existsSync(cardLogoSrc)) {
        try { doc.image(cardLogoSrc, ML + 12, y + 12, { fit: [56, 56] }); } catch(e) {}
      }

      let my = y + 12;
      const mx = ML + 80, mw = CW - 90;
      doc.font('Helvetica-Bold').fontSize(14).fillColor(C.TEXT_DARK)
         .text(meta.project || 'Project Analysis', mx, my, { width: mw }); my += 18;
      doc.font('Helvetica').fontSize(9).fillColor(C.MED_GRAY);
      const ts = new Date().toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
      doc.text(`Generated: ${ts}`, mx, my, { width: mw }); my += 12;
      if (meta.filesAnalyzed) { doc.text(`Files analyzed: ${meta.filesAnalyzed}`, mx, my, { width: mw }); my += 12; }
      if (meta.cost)          { doc.text(`Analysis cost: $${meta.cost}`, mx, my, { width: mw }); my += 12; }

      // White-label footer line on the metadata card: consultant attribution
      // instead of "Ghost Architect v4.5.5 | ghostarchitect.dev".
      if (isWL) {
        const finalLine = branding.author && branding.author !== branding.companyName
          ? `${branding.companyName}  ·  Prepared by ${branding.author}`
          : branding.companyName;
        doc.text(finalLine, mx, my, { width: mw });
      } else {
        doc.text(`Ghost Architect v${meta.version || '4.5.5'}  |  ghostarchitect.dev`, mx, my, { width: mw });
      }
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
          // Accent stripe on the left edge of each finding card.
          // White-label mode uses the consultant's accent color so the
          // visual rhythm of the report matches their brand.
          box(doc, ML, y,  3, 24, isWL ? branding.accentColor : C.TEAL);
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
          // Smart column widths — Finding column (index 1) gets 35%, others share the rest
          function getColWidths(numCols, totalW) {
            if (numCols === 6) return [totalW*0.07, totalW*0.28, totalW*0.14, totalW*0.14, totalW*0.16, totalW*0.21];
            if (numCols === 5) return [totalW*0.08, totalW*0.34, totalW*0.16, totalW*0.16, totalW*0.26];
            const w = totalW / (numCols || 1);
            return Array(numCols).fill(w);
          }
          const colWidths = getColWidths(cols, CW);
          for (let ri = 0; ri < rows.length; ri++) {
            // Calculate row height based on tallest cell with word wrap
            doc.font(ri===0?'Helvetica-Bold':'Helvetica').fontSize(8);
            const cellHeights = rows[ri].map((cell, ci) =>
              doc.heightOfString(cell, { width: colWidths[ci] - 10 })
            );
            const rowH = Math.max(18, Math.max(...cellHeights) + 10);
            need(rowH);
            box(doc, ML, y, CW, rowH, ri===0 ? C.NAVY : (ri%2===0 ? C.CARD_BG : C.WHITE));
            let cx = ML;
            rows[ri].forEach((cell, ci) => {
              doc.font(ri===0?'Helvetica-Bold':'Helvetica').fontSize(8)
                 .fillColor(ri===0?C.WHITE:C.TEXT_DARK)
                 .text(cell, cx+6, y+5, { width: colWidths[ci]-10 });
              cx += colWidths[ci];
            });
            doc.save().rect(ML, y, CW, rowH).lineWidth(0.3).stroke(C.LIGHT_GRAY).restore();
            y += rowH;
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
