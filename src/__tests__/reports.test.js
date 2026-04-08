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

describe('convertToMarkdown — Ghost Open truncation', () => {
  it('includes CRITICAL and HIGH findings only', () => {
    const md = convertToMarkdown(sampleContent, 'ghost-poi', 'TestProject', {}, '2026-01-01T00-00-00');

    expect(md).toContain('🔴 **CRITICAL**');
    expect(md).toContain('🟠 **HIGH**');
    expect(md).not.toContain('🟡 **MEDIUM**');
    expect(md).not.toContain('🟢 **LOW**');
  });

  it('does not include the remediation summary section', () => {
    const md = convertToMarkdown(sampleContent, 'ghost-poi', 'TestProject', {}, '2026-01-01T00-00-00');

    expect(md).not.toMatch(/REMEDIATION SUMMARY/);
  });

  it('shows the upgrade prompt at the end', () => {
    const md = convertToMarkdown(sampleContent, 'ghost-poi', 'TestProject', {}, '2026-01-01T00-00-00');

    // The upgrade CTA should reference finding counts and ghostarchitect.dev
    expect(md).toMatch(/ghostarchitect\.dev/);
    expect(md).toContain('Ghost Pro');

    // Verify the upgrade prompt is near the end (after all findings)
    const lines = md.trimEnd().split('\n');
    const last20 = lines.slice(-20).join('\n');
    expect(last20).toContain('ghostarchitect.dev');
  });

  it('reports correct shown vs total finding counts in upgrade prompt', () => {
    const md = convertToMarkdown(sampleContent, 'ghost-poi', 'TestProject', {}, '2026-01-01T00-00-00');

    // 2 shown (Critical + High) of 4 total
    expect(md).toContain('2 of 4 findings');
  });

  it('includes the report header with project name', () => {
    const md = convertToMarkdown(sampleContent, 'ghost-poi', 'TestProject', {}, '2026-01-01T00-00-00');

    expect(md).toContain('Ghost Architect — Points of Interest Report');
    expect(md).toContain('TestProject');
  });
});
