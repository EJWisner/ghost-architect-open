import { jest, describe, it, expect } from '@jest/globals';
import { convertToMarkdown } from '../reports.js';

// Sample content simulating what Claude returns after severity badge normalization.
// convertToMarkdown itself applies badge formatting, so feed it raw severity words.
const sampleContent = [
  '# Points of Interest\n',
  '---',
  '## Finding 1 — SQL Injection in checkout',
  'Severity: CRITICAL',
  'File: app/code/Custom/Checkout/Model/Payment.php',
  'Unsanitized user input passed to raw SQL query.',
  '',
  '---',
  '## Finding 2 — Hardcoded API key',
  'Severity: HIGH',
  'File: app/code/Custom/Integration/Helper/Data.php',
  'API key committed in source.',
  '',
  '---',
  '## Finding 3 — Missing CSRF token',
  'Severity: MEDIUM',
  'File: app/code/Custom/Form/Controller/Submit.php',
  'Form submission handler lacks CSRF validation.',
  '',
  '---',
  '## Finding 4 — Deprecated method usage',
  'Severity: LOW',
  'File: app/code/Custom/Catalog/Block/List.php',
  'Uses getChildHtml() which is deprecated in 2.4.7.',
  '',
  '## 📊 REMEDIATION SUMMARY',
  'Critical: 1, High: 1, Medium: 1, Low: 1',
].join('\n');

describe('convertToMarkdown — Ghost Open full report', () => {
  // Note: as of v5.0.0, Ghost Open shows full reports with no severity
  // truncation and no upgrade prompts. The Pro/Team/Enterprise gating
  // is now on workflow features (baseline comparison, velocity tracking,
  // Project Dashboard) rather than on which findings users can see.
  // See the bin/ghost.js comment block near VERSION declaration.

  it('includes all severity levels (CRITICAL, HIGH, MEDIUM, LOW)', () => {
    const md = convertToMarkdown(sampleContent, 'ghost-poi', 'TestProject', {}, '2026-01-01T00-00-00');

    expect(md).toContain('🔴 **CRITICAL**');
    expect(md).toContain('🟠 **HIGH**');
    expect(md).toContain('🟡 **MEDIUM**');
    expect(md).toContain('🟢 **LOW**');
  });

  it('includes the remediation summary section', () => {
    const md = convertToMarkdown(sampleContent, 'ghost-poi', 'TestProject', {}, '2026-01-01T00-00-00');

    expect(md).toMatch(/REMEDIATION SUMMARY/);
  });

  it('does not show a Pro upgrade prompt', () => {
    const md = convertToMarkdown(sampleContent, 'ghost-poi', 'TestProject', {}, '2026-01-01T00-00-00');

    // v5.0.0 removed the showUpgradePrompt function. Open users get
    // the full report without nag CTAs.
    expect(md).not.toContain('Ghost Pro');
    expect(md).not.toMatch(/of \d+ findings/);
  });

  it('includes the report header with project name', () => {
    const md = convertToMarkdown(sampleContent, 'ghost-poi', 'TestProject', {}, '2026-01-01T00-00-00');

    expect(md).toContain('Ghost Architect — Points of Interest Report');
    expect(md).toContain('TestProject');
  });

  it('includes the ghostarchitect.dev footer link', () => {
    const md = convertToMarkdown(sampleContent, 'ghost-poi', 'TestProject', {}, '2026-01-01T00-00-00');

    expect(md).toMatch(/ghostarchitect\.dev/);
  });
});
