// tests/executive-brief-pdf.smoke.mjs
//
// Audit 8, finding 3.9: the Executive Brief's embedded Python renderer
// escaped only '&' before handing narrative paragraphs to ReportLab's
// Paragraph, which parses its input as XML-ish markup. Any '<' or '>' in the
// LLM narrative ("< 30 days") raised a paragraph parse error and failed the
// entire brief with "PDF generation failed". v11.0.0 escapes all three
// metacharacters.
//
// This test drives the REAL python3 renderer with a narrative containing
// <, >, and &, and asserts a non-empty PDF lands on disk. Skips cleanly
// (exit 0 with a notice) when python3 or reportlab is unavailable, matching
// the runtime's own graceful degradation.
//
// Run: node tests/executive-brief-pdf.smoke.mjs

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// Isolate the reports dir before importing the module under test.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-exec-brief-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

// Environment probe: this test is about OUR escaping, not about whether the
// machine has reportlab. Skip (pass) when the renderer stack is absent.
try {
  execFileSync('python3', ['-c', 'import reportlab'], { stdio: 'pipe' });
} catch {
  console.log('SKIPPED — python3/reportlab not available on this machine; escaping contract not exercisable.');
  process.exit(0);
}

const { renderPdf } = await import('../src/modes/executive-brief.js');

const payload = {
  company_name: 'Ghost Architect',
  project: 'escaping-smoke',
  codebaseRoot: '/tmp/example',
  date: '2026-07-10',
  footer_text: 'Ghost Architect Executive Brief',
  confidentiality_text: 'Confidential',
  healthScore: 72,
  healthLabel: 'fair',
  healthColor: '#d29922',
  narrative:
    'Remediation is achievable in < 30 days if the team moves now.\n' +
    'The auth layer uses <legacy> token handling & the export job compares a > b unsafely.\n' +
    'Standard prose paragraph with no metacharacters.',
  data: {
    criticalCount: 2,
    highCount: 3,
    mediumCount: 5,
    lowCount: 1,
    totalEffortHours: 40,
    estimatedManualCost: 8000,
    estimatedAiHours: 4,
    estimatedAiCost: 1.25,
  },
};

let failures = 0;
function check(label, ok) {
  if (ok) {
    console.log(`  OK  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

let pdfPath = null;
let renderError = null;
try {
  pdfPath = renderPdf(payload);
} catch (err) {
  renderError = err;
}

check('renderPdf did not throw on <, >, & in the narrative', renderError === null);
if (renderError) console.error(`      ${renderError.message}`);
check('PDF file exists', pdfPath !== null && fs.existsSync(pdfPath));
check('PDF file is non-empty', pdfPath !== null && fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 500);
check('PDF has the %PDF magic header',
  pdfPath !== null && fs.existsSync(pdfPath) &&
  fs.readFileSync(pdfPath).subarray(0, 5).toString('latin1') === '%PDF-');

fs.rmSync(tmpHome, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nPASSED — Executive Brief PDF renders with <, >, and & in the narrative.');
