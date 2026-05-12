// src/modes/audit/reportBuilder.js
//
// Build the audit-mode report content from the four analyzer outputs.
//
// Returns a markdown-formatted string that the existing saveReport()
// infrastructure (src/reports.js + src/pdf-generator.js) can turn into
// TXT, MD, and PDF files. We DON'T write a custom PDF template — the
// existing generator already knows how to render markdown headers,
// tables, severity badges, lists, and HRs. We just have to produce the
// markdown in a shape that maps cleanly to the PDF chrome.
//
// Structure of the generated report:
//
//   ## Executive Summary
//   (Recommendation, confidence, headlines for both scenarios)
//
//   ## Stack Reality Check
//   (Languages, frameworks, EOL flags, surprise findings)
//
//   ## Key-Person Risk
//   (Authors, bus factor, top contributors table, callouts)
//
//   ## Hidden Dependency Map
//   (Total deps, risk callouts grouped by category)
//
//   ## Modernization Roadmap
//   (Stabilize-and-keep narrative + 90-day plan, rebuild scope, caveats)
//
//   ## Methodology
//   (One paragraph explaining what Audit Mode does, what it doesn't,
//   and how to read the findings.)
//
// The audience for this report is the deal committee, not the engineer.
// Tone is professional, prose-forward, with tables and bullets only where
// they materially help comprehension.

const REPORT_VERSION = '1.0';

export function buildAuditReport(results, meta = {}) {
  const { stackReality, keyPersonRisk, dependencyMap, roadmap } = results || {};

  const sections = [];

  // ── Executive Summary ────────────────────────────────────────────────
  sections.push(buildExecutiveSummary(roadmap, stackReality, keyPersonRisk, dependencyMap));

  // ── Stack Reality Check ──────────────────────────────────────────────
  sections.push(buildStackRealitySection(stackReality));

  // ── Key-Person Risk ──────────────────────────────────────────────────
  sections.push(buildKeyPersonRiskSection(keyPersonRisk));

  // ── Hidden Dependency Map ────────────────────────────────────────────
  sections.push(buildDependencyMapSection(dependencyMap));

  // ── Modernization Roadmap ────────────────────────────────────────────
  sections.push(buildRoadmapSection(roadmap));

  // ── Methodology footer ───────────────────────────────────────────────
  sections.push(buildMethodologySection());

  return sections.filter(Boolean).join('\n\n---\n\n');
}

// ── Executive Summary ──────────────────────────────────────────────────

function buildExecutiveSummary(roadmap, stackReality, keyPersonRisk, dependencyMap) {
  const lines = ['## Executive Summary', ''];

  // Top-line metrics card
  const codeLoc = stackReality?.totalCodeLOC || 0;
  const authors = keyPersonRisk?.totalAuthors || 0;
  const concentration = keyPersonRisk?.concentrationRisk || 'unknown';
  const deps = dependencyMap?.totalDependencies || 0;
  const recommendation = roadmap?.recommendation || 'needs-discovery';
  const confidence = roadmap?.confidence || 'low';

  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Codebase size | ~${codeLoc.toLocaleString()} lines of code |`);
  lines.push(`| Total contributors | ${authors} |`);
  lines.push(`| Contributor concentration | ${concentration.toUpperCase()} |`);
  lines.push(`| Direct dependencies | ${deps} |`);
  lines.push(`| **Recommendation** | **${recommendation}** |`);
  lines.push(`| Confidence | ${confidence} |`);
  lines.push('');

  if (roadmap?.stabilizeAndKeep?.headline) {
    lines.push('### Stabilize and Keep');
    lines.push('');
    lines.push(roadmap.stabilizeAndKeep.headline);
    lines.push('');
  }

  if (roadmap?.rebuildScope?.headline) {
    lines.push('### Rebuild Scope');
    lines.push('');
    lines.push(roadmap.rebuildScope.headline);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Stack Reality Check ────────────────────────────────────────────────

function buildStackRealitySection(stackReality) {
  if (!stackReality || stackReality._error) {
    return '## Stack Reality Check\n\n_Section unavailable: analyzer error._';
  }

  const lines = ['## Stack Reality Check', ''];
  lines.push('What the codebase actually contains, framework versions, and end-of-life flags.');
  lines.push('');

  const { actualLanguages, frameworks, surpriseFindings, totalCodeLOC, totalAllLOC } = stackReality;

  // Languages table
  if (actualLanguages?.length > 0) {
    const codeLangs = actualLanguages.filter(l => l.isCode);
    const nonCodeLangs = actualLanguages.filter(l => !l.isCode);

    if (codeLangs.length > 0) {
      lines.push('### Code Languages');
      lines.push('');
      lines.push(`Total code LOC: ~${(totalCodeLOC || 0).toLocaleString()}`);
      lines.push('');
      lines.push('| Language | Share | Files | LOC |');
      lines.push('|---|---|---|---|');
      for (const lang of codeLangs.slice(0, 12)) {
        lines.push(`| ${lang.language} | ${lang.pct}% | ${lang.fileCount} | ~${lang.locApprox.toLocaleString()} |`);
      }
      lines.push('');
    }

    if (nonCodeLangs.length > 0) {
      const nonCodeTotal = nonCodeLangs.reduce((sum, l) => sum + l.locApprox, 0);
      lines.push('### Support / Configuration / Documentation');
      lines.push('');
      lines.push(`Total support-file LOC: ~${nonCodeTotal.toLocaleString()}`);
      lines.push('');
      lines.push('| File type | Files | LOC |');
      lines.push('|---|---|---|');
      for (const lang of nonCodeLangs.slice(0, 8)) {
        lines.push(`| ${lang.language} | ${lang.fileCount} | ~${lang.locApprox.toLocaleString()} |`);
      }
      lines.push('');
    }
  }

  // Frameworks
  if (frameworks?.length > 0) {
    lines.push('### Detected Frameworks and Runtimes');
    lines.push('');
    lines.push('| Framework | Version | Status |');
    lines.push('|---|---|---|');
    for (const f of frameworks) {
      const status = f.eolFlag
        ? `**EOL** — ${f.eolNote || 'past end-of-life'}`
        : 'In support';
      lines.push(`| ${f.displayName} | ${f.version || 'unparsed'} | ${status} |`);
    }
    lines.push('');
  }

  // Surprise findings
  if (surpriseFindings?.length > 0) {
    lines.push('### Reality-vs-Pitch Callouts');
    lines.push('');
    lines.push('Notable gaps between what a typical seller pitch would describe and what the codebase actually contains.');
    lines.push('');
    for (const surprise of surpriseFindings) {
      lines.push(`- ${surprise}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Key-Person Risk ────────────────────────────────────────────────────

function buildKeyPersonRiskSection(keyPersonRisk) {
  if (!keyPersonRisk || keyPersonRisk._error) {
    return '## Key-Person Risk\n\n_Section unavailable: analyzer error._';
  }

  const lines = ['## Key-Person Risk', ''];
  lines.push('Concentration of code authorship and contributor stability over the git history.');
  lines.push('');

  if (!keyPersonRisk._gitAvailable) {
    lines.push('### Git History Unavailable');
    lines.push('');
    for (const callout of (keyPersonRisk.callouts || [])) {
      lines.push(`- ${callout}`);
    }
    return lines.join('\n');
  }

  const { totalAuthors, totalCommits, totalLinesChanged, busFactorEstimate, concentrationRisk, topContributors, callouts } = keyPersonRisk;

  lines.push('### Repository Statistics');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Distinct authors | ${totalAuthors} |`);
  lines.push(`| Total commits (non-merge) | ${totalCommits?.toLocaleString() || 0} |`);
  lines.push(`| Total lines changed | ${totalLinesChanged?.toLocaleString() || 0} |`);
  lines.push(`| Bus factor estimate | ${busFactorEstimate} |`);
  lines.push(`| Concentration risk | ${concentrationRisk.toUpperCase()} |`);
  lines.push('');

  if (topContributors?.length > 0) {
    lines.push('### Top Contributors');
    lines.push('');
    lines.push('Author identities are anonymized. Contact the deal team for raw mapping if needed.');
    lines.push('');
    lines.push('| Author | Lines | Share | Commits | First commit | Last commit | Status |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const c of topContributors.slice(0, 10)) {
      const firstD = c.firstCommitAt ? c.firstCommitAt.slice(0, 10) : '—';
      const lastD = c.lastCommitAt ? c.lastCommitAt.slice(0, 10) : '—';
      const status = c.likelyDeparted
        ? `**Likely departed** — ${c.daysSinceLastCommit}d ago`
        : 'Active';
      lines.push(`| ${c.displayLabel} | ${c.linesChanged.toLocaleString()} | ${c.linesChangedPct}% | ${c.commits} | ${firstD} | ${lastD} | ${status} |`);
    }
    lines.push('');
  }

  if (callouts?.length > 0) {
    lines.push('### Callouts');
    lines.push('');
    for (const callout of callouts) {
      lines.push(`- ${callout}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Hidden Dependency Map ──────────────────────────────────────────────

function buildDependencyMapSection(dependencyMap) {
  if (!dependencyMap || dependencyMap._error) {
    return '## Hidden Dependency Map\n\n_Section unavailable: analyzer error._';
  }

  const lines = ['## Hidden Dependency Map', ''];
  lines.push('Third-party libraries the buyer is inheriting. License classification, end-of-life flags, and risk callouts.');
  lines.push('');

  if (!dependencyMap.totalDependencies) {
    lines.push('No direct dependencies detected. No supported manifest files were found.');
    return lines.join('\n');
  }

  lines.push(`### Total Direct Dependencies: ${dependencyMap.totalDependencies}`);
  lines.push('');
  lines.push('Note: this audit scans direct dependencies only. Transitive dependency walking is deferred to a future audit version.');
  lines.push('');

  if (dependencyMap.riskCallouts?.length > 0) {
    lines.push('### Risk Callouts');
    lines.push('');
    for (const callout of dependencyMap.riskCallouts) {
      // Plain severity label — the reports.js convertToMarkdown post-processor
      // adds the emoji + bold wrapper. We DON'T pre-decorate the severity word
      // here because that produces a nested-bold collision in the MD output.
      const severityLabel = callout.severity === 'high' ? 'HIGH'
        : callout.severity === 'medium' ? 'MEDIUM'
        : 'LOW';
      lines.push(`### ${severityLabel} — ${callout.category.toUpperCase()}`);
      lines.push('');
      lines.push(callout.summary);
      lines.push('');
      if (callout.packages?.length > 0) {
        const preview = callout.packages.slice(0, 15).join(', ');
        const more = callout.packages.length > 15 ? `, ... +${callout.packages.length - 15} additional package(s)` : '';
        lines.push(`Affected packages: ${preview}${more}`);
        lines.push('');
      }
    }
  } else {
    lines.push('No license, EOL, or commercial-dependency risks detected in direct dependencies.');
    lines.push('');
  }

  return lines.join('\n');
}

// ── Modernization Roadmap ──────────────────────────────────────────────

function buildRoadmapSection(roadmap) {
  if (!roadmap || roadmap._error) {
    const errMsg = roadmap?._error || 'unavailable';
    return `## Modernization Roadmap\n\n_Section unavailable: ${errMsg}_`;
  }

  const lines = ['## Modernization Roadmap', ''];
  lines.push('Two scenarios for the buyer to consider: stabilize the inherited codebase, or rebuild from scratch.');
  lines.push('');
  lines.push(`**Recommendation: ${roadmap.recommendation}** (confidence: ${roadmap.confidence})`);
  lines.push('');

  // Stabilize-and-keep scenario
  if (roadmap.stabilizeAndKeep?.headline) {
    lines.push('### Stabilize and Keep');
    lines.push('');
    lines.push(`**${roadmap.stabilizeAndKeep.headline}**`);
    lines.push('');
    if (roadmap.stabilizeAndKeep.narrative) {
      lines.push(roadmap.stabilizeAndKeep.narrative);
      lines.push('');
    }
    if (roadmap.stabilizeAndKeep.sequencedSteps?.length > 0) {
      lines.push('### 90-Day Stabilization Plan');
      lines.push('');
      for (const phase of roadmap.stabilizeAndKeep.sequencedSteps) {
        lines.push(`**${phase.phase}**`);
        lines.push('');
        for (const item of (phase.items || [])) {
          lines.push(`- ${item}`);
        }
        lines.push('');
      }
    }
  }

  // Rebuild scenario
  if (roadmap.rebuildScope?.headline) {
    lines.push('### Rebuild Scope');
    lines.push('');
    lines.push(`**${roadmap.rebuildScope.headline}**`);
    lines.push('');
    if (roadmap.rebuildScope.narrative) {
      lines.push(roadmap.rebuildScope.narrative);
      lines.push('');
    }
    if (roadmap.rebuildScope.scopeRanges?.length > 0) {
      lines.push('### Rebuild Scope Ranges');
      lines.push('');
      for (const range of roadmap.rebuildScope.scopeRanges) {
        lines.push(`- ${range}`);
      }
      lines.push('');
    }
  }

  // Caveats
  if (roadmap.caveats?.length > 0) {
    lines.push('### Caveats and Assumptions');
    lines.push('');
    for (const caveat of roadmap.caveats) {
      lines.push(`- ${caveat}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Methodology ────────────────────────────────────────────────────────

function buildMethodologySection() {
  return [
    '## Methodology',
    '',
    'This Inheritance Audit was generated by Ghost Architect™ in audit mode. The report combines four analyzers:',
    '',
    '- **Stack Reality Check** parses package manifests and the file census to determine actual technology footprint independent of any seller representation.',
    '- **Key-Person Risk** parses git history to estimate authorship concentration and contributor stability. Author identities are anonymized in this report.',
    '- **Hidden Dependency Map** enumerates direct dependencies and flags license risk and end-of-life status. CVE scanning is not included in this report version; transitive dependency analysis is deferred to a future audit version.',
    '- **Modernization Roadmap** synthesizes the above into two prose scenarios (stabilize vs. rebuild) and a recommendation. The roadmap is generated by a large language model conditioned on the deterministic analyzer outputs. No dollar figures are included; scope is expressed in time and effort terms.',
    '',
    'This audit is a pre-engagement assessment based on the static contents of the inherited codebase. It does not constitute legal advice, a security audit, or a substitute for full operational due diligence. Findings should be validated by qualified personnel before any acquisition or modernization decision.',
    '',
    `Report format version ${REPORT_VERSION}. Generated by Ghost Architect™.`,
  ].join('\n');
}
