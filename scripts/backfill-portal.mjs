#!/usr/bin/env node
// One-shot: backfill findings.json sidecars for existing reports and push
// the full set (txt/md/pdf + findings.json + manifest update) to the portal
// repo. Use this whenever scans were generated before saveReport learned to
// emit sidecars and auto-publish to the portal.
//
// Default: backfills reports matching a label substring. Pass --all to
// backfill everything in ~/Ghost Architect Reports/.
//
// Usage:
//   node scripts/backfill-portal.mjs "Blue Acorn iCi"
//   node scripts/backfill-portal.mjs --all
//   node scripts/backfill-portal.mjs --dry-run "Blue Acorn iCi"

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import {
  buildFindingsSidecar,
  publishToPortal,
  isPortalConfigured,
  getPortalConfig,
} from '../src/core/portal-publish.js';

const REPORTS_DIR = path.join(os.homedir(), 'Ghost Architect Reports');

// Args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all    = args.includes('--all');
const labelFilter = args.find(a => !a.startsWith('--')) || null;

if (!all && !labelFilter) {
  console.error('Usage: node scripts/backfill-portal.mjs "<label substring>" | --all  [--dry-run]');
  process.exit(1);
}

if (!isPortalConfigured() && !dryRun) {
  console.error('Portal publish not configured. Run scripts/set-portal-config.mjs first.');
  process.exit(1);
}

// Filename parser: ghost-{mode}-{label}-{ts}.{ext}
const FILE_RE = /^ghost-(audit|poi|blast|conflict|recon|chat|compare|dashboard|inheritance)-(.+?)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.(md|pdf|txt)$/;

async function main() {
  const all_files = await fs.promises.readdir(REPORTS_DIR);

  // Group files by base name (everything before the extension).
  const reports = new Map();
  for (const f of all_files) {
    const m = f.match(FILE_RE);
    if (!m) continue;
    const [, mode, labelSlug, ts, ext] = m;
    const baseName = `ghost-${mode}-${labelSlug}-${ts}`;
    if (!reports.has(baseName)) {
      reports.set(baseName, {
        baseName,
        mode: mode === 'inheritance' ? 'audit' : mode,
        labelSlug,
        ts,
        files: {},
      });
    }
    reports.get(baseName).files[ext] = path.join(REPORTS_DIR, f);
  }

  // Filter by label if applicable.
  const filtered = [];
  for (const r of reports.values()) {
    if (all) {
      filtered.push(r);
    } else if (labelFilter) {
      // Match the label substring against the slugified label inside the
      // filename. Slugs are lowercase with dashes; normalize the filter
      // the same way so "Blue Acorn iCi" matches "blue-acorn-ici".
      const filterSlug = labelFilter.replace(/[^a-z0-9]/gi, '-').toLowerCase();
      if (r.labelSlug.includes(filterSlug)) filtered.push(r);
    }
  }

  if (filtered.length === 0) {
    console.log(`No reports matched filter "${labelFilter || '(all)'}"`);
    return;
  }

  console.log(`Backfilling ${filtered.length} report(s):`);
  for (const r of filtered) console.log(`  - ${r.baseName}`);
  console.log('');

  if (dryRun) {
    console.log('[DRY RUN] Would generate findings.json for each and push to portal.');
    return;
  }

  const cfg = getPortalConfig();
  console.log(`Pushing to ${cfg.repo} ...`);
  console.log('');

  let succeeded = 0;
  let failed = 0;

  for (const r of filtered) {
    const txtPath = r.files.txt || null;
    const mdPath  = r.files.md  || null;
    const pdfPath = r.files.pdf || null;

    if (!mdPath && !txtPath) {
      console.log(`  ⚠  ${r.baseName} — no md or txt found, skipping`);
      failed++;
      continue;
    }

    const reportText = await fs.promises.readFile(mdPath || txtPath, 'utf8');

    // Generate findings.json sidecar if it doesn't already exist.
    const findingsPath = path.join(REPORTS_DIR, `${r.baseName}.findings.json`);
    let findingsExists = fs.existsSync(findingsPath);
    if (!findingsExists) {
      try {
        // Reverse the slug back to a human label for the manifest entry.
        const humanLabel = r.labelSlug
          .replace(/---/g, ' \u2014 ')      // ---  → em-dash with spaces
          .replace(/-/g, ' ')                // remaining dashes → spaces
          .replace(/\b\w/g, c => c.toUpperCase());

        const sidecar = buildFindingsSidecar(reportText, {
          project: humanLabel,
          mode:    r.mode,
        });
        await fs.promises.writeFile(findingsPath, JSON.stringify(sidecar, null, 2));
        findingsExists = true;
        console.log(`  ✓ ${r.baseName} — sidecar written (${sidecar.totalFindings} findings)`);
      } catch (err) {
        console.log(`  ⚠  ${r.baseName} — sidecar failed: ${err.message}`);
      }
    } else {
      console.log(`  ✓ ${r.baseName} — sidecar already exists`);
    }

    // Push to portal.
    try {
      // Reverse the slug to recover the human label for the manifest entry.
      const humanLabel = r.labelSlug
        .replace(/---/g, ' \u2014 ')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

      // Reconstruct scan ISO from the timestamp in the filename.
      const scanIso = r.ts.replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1T$2:$3:$4Z');

      await publishToPortal({
        baseName:         r.baseName,
        mode:             r.mode,
        label:            humanLabel,
        txtPath:          txtPath || mdPath,
        mdPath:           mdPath  || txtPath,
        pdfPath:          pdfPath,
        findingsJsonPath: findingsExists ? findingsPath : null,
        reportText,
        scanIso,
      });
      console.log(`  ✓ ${r.baseName} — pushed to portal`);
      succeeded++;
    } catch (err) {
      console.log(`  ✗ ${r.baseName} — portal push failed: ${err.message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`Done. ${succeeded} pushed, ${failed} failed.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
