#!/usr/bin/env python3
"""
Ghost Architect PDF Report Generator
Copyright © 2026 Ghost Architect. All rights reserved.
"""
import sys, os, re, json
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, Image
from reportlab.lib.enums import TA_LEFT, TA_CENTER

# Brand colors
DARK_BG    = colors.HexColor('#0D1117')
NAVY       = colors.HexColor('#0A1628')
TEAL       = colors.HexColor('#00B4D8')
ORANGE     = colors.HexColor('#FF6B35')
PURPLE     = colors.HexColor('#7B2FBE')
RED        = colors.HexColor('#DC2626')
AMBER      = colors.HexColor('#D97706')
GREEN      = colors.HexColor('#16A34A')
LIGHT_GRAY = colors.HexColor('#E5E7EB')
MED_GRAY   = colors.HexColor('#6B7280')
WHITE      = colors.white
CARD_BG    = colors.HexColor('#F8FAFC')

SECTION_COLORS = {
    'RED FLAGS':           RED,
    'LANDMARKS':           TEAL,
    'DEAD ZONES':          MED_GRAY,
    'FAULT LINES':         AMBER,
    'REMEDIATION SUMMARY': PURPLE,
    'ROLLBACK PLAN':       ORANGE,
    'REMEDIATION PLAN':    colors.HexColor('#0891B2'),
    'DIRECT DEPENDENCIES': RED,
    'RIPPLE EFFECTS':      AMBER,
    'DANGER ZONES':        RED,
    'SAFE ZONES':          GREEN,
}

def severity_color(text):
    t = text.upper()
    if 'CRITICAL' in t: return RED
    if 'HIGH' in t:     return ORANGE
    if 'MEDIUM' in t:   return AMBER
    if 'LOW' in t:      return GREEN
    return MED_GRAY

def clean(text):
    text = re.sub(r'\x1B\[[0-9;]*m', '', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'\*(.+?)\*', r'<i>\1</i>', text)
    text = text.replace('&', '&amp;').replace('<b>', '\x00b').replace('</b>', '\x01b').replace('<i>', '\x00i').replace('</i>', '\x01i')
    text = text.replace('<', '&lt;').replace('>', '&gt;')
    text = text.replace('\x00b', '<b>').replace('\x01b', '</b>').replace('\x00i', '<i>').replace('\x01i', '</i>')
    return text.strip()

def build_styles():
    return {
        'title':          ParagraphStyle('title', fontName='Helvetica-Bold', fontSize=22, textColor=WHITE, spaceAfter=4),
        'section_header': ParagraphStyle('section_header', fontName='Helvetica-Bold', fontSize=13, textColor=WHITE, spaceBefore=4, spaceAfter=4),
        'finding_title':  ParagraphStyle('finding_title', fontName='Helvetica-Bold', fontSize=10, textColor=DARK_BG, spaceBefore=4, spaceAfter=2),
        'body':           ParagraphStyle('body', fontName='Helvetica', fontSize=9, textColor=colors.HexColor('#1F2937'), spaceBefore=1, spaceAfter=1, leading=13),
        'bullet':         ParagraphStyle('bullet', fontName='Helvetica', fontSize=9, textColor=colors.HexColor('#1F2937'), leftIndent=14, spaceBefore=1, spaceAfter=1, leading=13),
        'numbered':       ParagraphStyle('numbered', fontName='Helvetica', fontSize=9, textColor=colors.HexColor('#1F2937'), leftIndent=14, spaceBefore=1, spaceAfter=1, leading=13),
        'meta_title':     ParagraphStyle('meta_title', fontName='Helvetica-Bold', fontSize=14, textColor=DARK_BG, spaceAfter=4),
        'meta_body':      ParagraphStyle('meta_body', fontName='Helvetica', fontSize=9, textColor=MED_GRAY, spaceAfter=2),
        'footer':         ParagraphStyle('footer', fontName='Helvetica', fontSize=7, textColor=MED_GRAY, alignment=TA_CENTER),
    }

def header_footer(canvas, doc):
    canvas.saveState()
    w, h = letter
    # Header bar
    canvas.setFillColor(DARK_BG)
    canvas.rect(0, h - 40, w, 40, fill=1, stroke=0)
    # Logo
    logo_path = os.path.join(os.path.dirname(__file__), '..', 'assets', 'logo.jpeg')
    if os.path.exists(logo_path):
        canvas.drawImage(logo_path, 12, h - 36, width=28, height=28, preserveAspectRatio=True, mask='auto')
    # Header text
    canvas.setFillColor(WHITE)
    canvas.setFont('Helvetica-Bold', 11)
    canvas.drawString(48, h - 16, 'Ghost Architect')
    canvas.setFillColor(TEAL)
    canvas.setFont('Helvetica', 8)
    canvas.drawString(48, h - 28, 'AI-powered codebase intelligence  |  ghostarchitect.dev')
    # Page number
    canvas.setFillColor(MED_GRAY)
    canvas.setFont('Helvetica', 8)
    canvas.drawRightString(w - 20, h - 22, f'Page {doc.page}')
    # Footer bar
    canvas.setFillColor(DARK_BG)
    canvas.rect(0, 0, w, 26, fill=1, stroke=0)
    canvas.setFillColor(MED_GRAY)
    canvas.setFont('Helvetica', 7)
    canvas.drawString(20, 8, f'Generated {datetime.now().strftime("%B %d, %Y at %I:%M %p")}  |  ghostarchitect.dev')
    canvas.setFillColor(TEAL)
    canvas.setFont('Helvetica-Bold', 7)
    canvas.drawRightString(w - 20, 8, '© 2026 Ghost Architect. All rights reserved. Confidential.')
    canvas.restoreState()

def generate_pdf(report_text, output_path, meta={}):
    doc = SimpleDocTemplate(
        output_path, pagesize=letter,
        leftMargin=0.6*inch, rightMargin=0.6*inch,
        topMargin=0.75*inch, bottomMargin=0.55*inch,
        title='Ghost Architect Report', author='Ghost Architect',
    )
    styles = build_styles()
    story = []
    story.append(Spacer(1, 0.15*inch))  # Clear the header bar

    # Cover banner
    cover_type = meta.get('reportType', 'Points of Interest Report')
    cover_table = Table([[Paragraph(cover_type, styles['title'])]], colWidths=[7.3*inch])
    cover_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), DARK_BG),
        ('TOPPADDING', (0,0), (-1,-1), 20),
        ('BOTTOMPADDING', (0,0), (-1,-1), 14),
        ('LEFTPADDING', (0,0), (-1,-1), 16),
        ('RIGHTPADDING', (0,0), (-1,-1), 16),
    ]))
    story.append(cover_table)

    # Metadata card
    logo_path = os.path.join(os.path.dirname(__file__), '..', 'assets', 'logo.jpeg')
    logo_cell = Image(logo_path, width=1.0*inch, height=1.0*inch) if os.path.exists(logo_path) else Paragraph('', styles['body'])
    meta_paras = [
        Paragraph(meta.get('project', 'Project Analysis'), styles['meta_title']),
        Paragraph(f"Generated: {datetime.now().strftime('%B %d, %Y at %I:%M %p')}", styles['meta_body']),
    ]
    if meta.get('filesAnalyzed'): meta_paras.append(Paragraph(f"Files analyzed: {meta['filesAnalyzed']} of {meta.get('totalFiles', '—')}", styles['meta_body']))
    if meta.get('cost'):          meta_paras.append(Paragraph(f"Analysis cost: {meta['cost']}", styles['meta_body']))
    meta_paras.append(Paragraph('Ghost Architect v2.4.0  |  ghostarchitect.dev', styles['meta_body']))

    meta_table = Table([[logo_cell, meta_paras]], colWidths=[1.2*inch, 6.1*inch])
    meta_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), CARD_BG),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 12),
        ('BOTTOMPADDING', (0,0), (-1,-1), 12),
        ('LEFTPADDING', (0,0), (0,-1), 14),
        ('LEFTPADDING', (1,0), (1,-1), 10),
        ('BOX', (0,0), (-1,-1), 0.5, LIGHT_GRAY),
    ]))
    story.append(meta_table)
    story.append(Spacer(1, 12))

    # Parse report content
    lines = report_text.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            story.append(Spacer(1, 3))
            i += 1
            continue

        # Section headers ## 
        if re.match(r'^##\s', line):
            header_text = re.sub(r'^#+\s*', '', line)
            header_text = re.sub(r'\*+', '', header_text)
            bg = NAVY
            for key, col in SECTION_COLORS.items():
                if key in header_text.upper():
                    bg = col
                    break
            ht = Table([[Paragraph(clean(header_text), styles['section_header'])]], colWidths=[7.3*inch])
            ht.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (-1,-1), bg),
                ('TOPPADDING', (0,0), (-1,-1), 7),
                ('BOTTOMPADDING', (0,0), (-1,-1), 7),
                ('LEFTPADDING', (0,0), (-1,-1), 12),
            ]))
            story.append(ht)
            story.append(Spacer(1, 5))
            i += 1
            continue

        # Finding headers ###
        if re.match(r'^###\s', line):
            finding_text = re.sub(r'^#+\s*', '', line)
            finding_text = re.sub(r'\*+', '', finding_text)
            ft = Table([[Paragraph(clean(finding_text), styles['finding_title'])]], colWidths=[7.3*inch])
            ft.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (-1,-1), CARD_BG),
                ('TOPPADDING', (0,0), (-1,-1), 5),
                ('BOTTOMPADDING', (0,0), (-1,-1), 5),
                ('LEFTPADDING', (0,0), (-1,-1), 10),
                ('LINEAFTER', (0,0), (0,-1), 3, TEAL),
                ('BOX', (0,0), (-1,-1), 0.3, LIGHT_GRAY),
            ]))
            story.append(ft)
            i += 1
            continue

        # Severity badge
        if 'Severity:' in line or 'SEVERITY:' in line.upper():
            sev_match = re.search(r'(CRITICAL|HIGH|MEDIUM|LOW)', line.upper())
            if sev_match:
                sev = sev_match.group(1)
                sc = severity_color(sev)
                badge = Table([[Paragraph(f'<b> {sev} </b>', ParagraphStyle('badge', fontName='Helvetica-Bold', fontSize=8, textColor=WHITE))]], colWidths=[0.85*inch])
                badge.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),sc),('TOPPADDING',(0,0),(-1,-1),2),('BOTTOMPADDING',(0,0),(-1,-1),2),('LEFTPADDING',(0,0),(-1,-1),6)]))
                story.append(badge)
                story.append(Spacer(1, 2))
                i += 1
                continue

        # HR
        if re.match(r'^-{3,}$', line) or re.match(r'^={3,}$', line):
            story.append(HRFlowable(width='100%', thickness=0.5, color=LIGHT_GRAY, spaceAfter=4, spaceBefore=4))
            i += 1
            continue

        # Markdown table
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                row_line = lines[i].strip()
                if re.match(r'^\|[-:\s|]+\|$', row_line):
                    i += 1
                    continue
                cells = [c.strip() for c in row_line.split('|')[1:-1]]
                rows.append(cells)
                i += 1
            if rows:
                max_cols = max(len(r) for r in rows)
                col_w = 7.3 / max_cols
                pdf_rows = []
                for ri, row in enumerate(rows):
                    pdf_row = []
                    for cell in row:
                        cell_clean = re.sub(r'\*+', '', cell)
                        s = ParagraphStyle('th', fontName='Helvetica-Bold', fontSize=8, textColor=WHITE) if ri == 0 else styles['body']
                        pdf_row.append(Paragraph(clean(cell_clean), s))
                    pdf_rows.append(pdf_row)
                t = Table(pdf_rows, colWidths=[col_w*inch]*max_cols)
                t.setStyle(TableStyle([
                    ('BACKGROUND',(0,0),(-1,0),NAVY),
                    ('ROWBACKGROUNDS',(0,1),(-1,-1),[WHITE,CARD_BG]),
                    ('GRID',(0,0),(-1,-1),0.3,LIGHT_GRAY),
                    ('TOPPADDING',(0,0),(-1,-1),4),
                    ('BOTTOMPADDING',(0,0),(-1,-1),4),
                    ('LEFTPADDING',(0,0),(-1,-1),6),
                ]))
                story.append(t)
                story.append(Spacer(1, 5))
            continue

        # Bullets
        if line.startswith('- ') or line.startswith('• '):
            story.append(Paragraph(f'• {clean(line[2:])}', styles['bullet']))
            i += 1
            continue

        # Numbered
        if re.match(r'^\d+\.', line):
            story.append(Paragraph(clean(line), styles['numbered']))
            i += 1
            continue

        # Regular text
        story.append(Paragraph(clean(line), styles['body']))
        story.append(Spacer(1, 1))
        i += 1

    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python3 pdf-generator.py <report_text_file> <output_pdf> [meta_json]")
        sys.exit(1)
    
    with open(sys.argv[1], 'r') as f:
        report_text = f.read()
    
    meta = {}
    if len(sys.argv) > 3:
        try:
            meta = json.loads(sys.argv[3])
        except:
            pass
    
    generate_pdf(report_text, sys.argv[2], meta)
    print(f"PDF saved: {sys.argv[2]}")
