// src/modes/audit/findingsFromResults.js
//
// Normalize the programmatic risk outputs from Audit's four analyzers
// (dependencyMap, stackReality, keyPersonRisk, roadmap) into the canonical
// findings schema that reports.js writes to the sibling .findings.json
// file. This is the bridge between Audit's structured analyzer outputs
// and the portal/mobile consumers that read findings.json.
//
// The canonical findings schema (per src/utils/finding-parser.js):
//   {
//     id: string,
//     title: string,
//     severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW',
//     files: string[],
//     effortHours: number,        // 0 if not estimable
//     confidence: number | null,  // 0-100 integer (matches finding-parser.js and portal-publish.js)
//     detail: string,
//   }
//
// Unlike POI/Blast/Conflict which model-generate findings as markdown and
// parse them out via extractFindings(), Audit's findings are produced
// programmatically by deterministic analyzers. confidence is high (100)
// because these are not LLM judgments — they are direct observations from
// the codebase (manifest files, git history, dependency tree).

const SEVERITY_NORMALIZE = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

function normalizeSeverity(s) {
  return SEVERITY_NORMALIZE[s] || 'MEDIUM';
}

// Effort estimates per finding category. These are heuristic anchors,
// not promises. The Audit report itself provides more nuanced effort
// guidance; this is to give the portal a sortable number per finding.
const EFFORT_HOURS_BY_CATEGORY = {
  eol_framework: 40,        // EOL framework upgrade is multi-week work
  eol_dependency: 8,        // single EOL dep package upgrade
  copyleft_license: 4,      // legal review per finding
  commercial_license: 4,    // confirm commercial/proprietary license transfer
  abandoned: 8,             // replace abandoned package
  security: 8,              // security-sensitive dep audit
  unknown_license: 2,       // verify license manually
  contributor_concentration: 16, // knowledge transfer plan
  framework_fragmentation: 24,   // consolidate framework choice
  surprise: 4,              // generic stack surprise, varies
};

function effortFor(category, multiplier = 1) {
  return Math.round((EFFORT_HOURS_BY_CATEGORY[category] || 4) * multiplier);
}

/**
 * Build the canonical findings array from Audit analyzer results.
 *
 * @param {object} results - The `results` object from audit/index.js,
 *   containing { stackReality, keyPersonRisk, dependencyMap, roadmap }.
 * @returns {Array<object>} - Array of canonical findings objects.
 */
export function findingsFromAuditResults(results) {
  const findings = [];
  let idCounter = 1;
  const nextId = () => `audit-${String(idCounter++).padStart(3, '0')}`;

  // 1. EOL frameworks from stackReality. Each EOL-flagged framework
  //    becomes its own HIGH finding. The manifest paths are the files.
  if (results?.stackReality?.frameworks && !results.stackReality._error) {
    const eolFrameworks = results.stackReality.frameworks.filter(f => f.eolFlag);
    for (const f of eolFrameworks) {
      const displayName = f.displayName || f.name;
      const ver = f.version || 'unknown version';
      const eolDate = f.eolDate || 'past EOL';
      findings.push({
        id: nextId(),
        title: `EOL framework: ${displayName} ${ver}`,
        severity: 'HIGH',
        files: Array.isArray(f.manifestPaths) ? f.manifestPaths : [],
        effortHours: effortFor('eol_framework'),
        confidence: 100,
        detail: `${displayName} ${ver} reached end-of-life on ${eolDate}. ${f.note || 'No further security patches or upstream support.'} Upgrade path required before any commercial transfer or new feature work.`,
      });
    }
  }

  // 2. Dependency risk callouts from dependencyMap. Each callout becomes
  //    one finding, scoped to the manifest file (package.json/composer.json)
  //    that declared the dependencies.
  if (results?.dependencyMap?.riskCallouts && !results.dependencyMap._error) {
    const manifestFiles = [];
    if (Array.isArray(results.dependencyMap.dependencies)) {
      const manifests = new Set();
      for (const d of results.dependencyMap.dependencies) {
        if (d.manifestPath) manifests.add(d.manifestPath);
      }
      manifestFiles.push(...Array.from(manifests));
    }

    for (const callout of results.dependencyMap.riskCallouts) {
      const sev = normalizeSeverity(callout.severity);
      const category = callout.category || 'unknown';
      const packages = Array.isArray(callout.packages) ? callout.packages : [];
      const count = callout.count || packages.length || 0;

      // Map dependency category to effort key
      const effortKey =
        category === 'eol' ? 'eol_dependency' :
        category === 'copyleft' ? 'copyleft_license' :
        category === 'commercial' ? 'commercial_license' :
        category === 'abandoned' ? 'abandoned' :
        category === 'security' ? 'security' :
        category === 'unknown_license' ? 'unknown_license' :
        'eol_dependency';

      findings.push({
        id: nextId(),
        title: `Dependency risk (${category}): ${count} package${count === 1 ? '' : 's'}`,
        severity: sev,
        files: manifestFiles,
        effortHours: effortFor(effortKey, count),
        confidence: 100,
        detail: `${callout.summary} Affected packages: ${packages.slice(0, 12).join(', ')}${packages.length > 12 ? `, and ${packages.length - 12} more` : ''}.`,
      });
    }
  }

  // 3. Surprise findings from stackReality. These are heuristic prose
  //    callouts — multiple frontends detected, version mismatches, etc.
  //    Each becomes a MEDIUM finding scoped to the codebase manifests.
  if (Array.isArray(results?.stackReality?.surpriseFindings)) {
    for (const surprise of results.stackReality.surpriseFindings) {
      findings.push({
        id: nextId(),
        title: 'Stack reality surprise',
        severity: 'MEDIUM',
        files: [],
        effortHours: effortFor('framework_fragmentation'),
        confidence: 90,
        detail: typeof surprise === 'string' ? surprise : String(surprise),
      });
    }
  }

  // 4. Contributor concentration risk from keyPersonRisk. Only emit a
  //    finding when concentration is medium or high — 'low' is healthy
  //    and doesn't need to surface as a finding.
  if (results?.keyPersonRisk && !results.keyPersonRisk._error) {
    const kpr = results.keyPersonRisk;
    const conc = kpr.concentrationRisk;
    if (conc === 'high' || conc === 'medium') {
      const sev = conc === 'high' ? 'HIGH' : 'MEDIUM';
      const keyPersonNote = kpr.busFactorEstimate != null ? `Only ${kpr.busFactorEstimate} contributor${kpr.busFactorEstimate === 1 ? '' : 's'} account for most code changes.` : '';
      const calloutText = Array.isArray(kpr.callouts) && kpr.callouts.length > 0
        ? ` ${kpr.callouts.join(' ')}`
        : '';
      findings.push({
        id: nextId(),
        title: `Contributor concentration: ${conc.toUpperCase()}`,
        severity: sev,
        files: [],
        effortHours: effortFor('contributor_concentration'),
        confidence: 100,
        detail: `Codebase shows ${conc} concentration of code authorship. ${keyPersonNote}${calloutText} Knowledge-transfer plan recommended before key contributors depart.`.trim(),
      });
    }
  }

  return findings;
}
