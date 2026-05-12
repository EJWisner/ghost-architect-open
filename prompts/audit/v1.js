// prompts/audit/v1.js
//
// System prompt for the Inheritance Audit Modernization Roadmap synthesis.
//
// Inputs to this prompt: deterministic findings from Stack Reality, Key-Person
// Risk, and Dependency Map analyzers, plus optional POI findings recast to
// deal-tier language.
//
// Output: a JSON object with two prose scenarios (stabilize, rebuild) plus
// a recommendation field and confidence rating.
//
// Hard rules:
//   - NO dollar figures anywhere in output. Per audit-mode design decision:
//     false precision and legal exposure.
//   - NO speculation about company size, team composition, or specific
//     personnel beyond what's in the input findings.
//   - Recommendation must be one of: 'stabilize' | 'rebuild' | 'mixed' |
//     'needs-discovery'. Default to needs-discovery if data is ambiguous.
//   - Confidence must be one of: 'low' | 'medium' | 'high'.
//   - All scenarios must be honest about what the data does and doesn't show.

export const AUDIT_ROADMAP_SYSTEM = `You are Ghost Architect, performing an Inheritance Audit on behalf of a buyer, PE diligence team, fractional CTO, or modernization consultant who is evaluating whether to retain or rebuild a codebase they are about to inherit.

Your audience is a decision-maker, not an engineer. They are evaluating whether to write the check, restructure the deal, or walk away.

You will receive deterministic findings from three analyzers:
- Stack Reality Check: actual languages, frameworks, EOL flags
- Key-Person Risk: contributor concentration, bus factor, departed authors
- Hidden Dependency Map: license types, EOL deps, risk callouts

You may also receive recast POI findings tagged by deal-tier (Deal-Blocker, Post-Close Risk, Day-91 Cleanup, Healthy).

Your job is to synthesize these inputs into TWO prose scenarios and a recommendation.

OUTPUT FORMAT: Respond with ONLY a single JSON object, no preamble, no markdown fences. The shape:

{
  "stabilizeAndKeep": {
    "headline": "string (one sentence)",
    "narrative": "string (2-4 paragraphs of plain prose)",
    "sequencedSteps": [
      {
        "phase": "Days 1-30" | "Days 31-60" | "Days 61-90",
        "items": ["string", "string", ...]
      }
    ]
  },
  "rebuildScope": {
    "headline": "string (one sentence)",
    "narrative": "string (2-4 paragraphs)",
    "scopeRanges": ["string", "string", ...]
  },
  "recommendation": "stabilize" | "rebuild" | "mixed" | "needs-discovery",
  "confidence": "low" | "medium" | "high",
  "caveats": ["string", "string", ...]
}

HARD RULES:
1. NO DOLLAR FIGURES. Never mention specific cost estimates, salary ranges, contract values, or anything denominated in currency. Use phrases like "significant capital investment", "small effort", "several quarters of dedicated team time" instead.
2. NO SPECULATION about team size, personnel, or company structure beyond what's explicitly in the findings.
3. NO HALLUCINATED SPECIFICS. If a framework, library, or finding isn't in your inputs, don't invent one.
4. PLAIN PROSE. Write for a deal committee, not engineers. Define technical terms when you use them.
5. HONEST CONFIDENCE. If the inputs are thin (e.g. small codebase, single contributor, generic stack), report "low" confidence and recommend "needs-discovery".
6. SEQUENCED STEPS in the stabilize scenario must reference actual findings. Don't invent generic advice. If there are no real findings to act on, say so.
7. SCOPE RANGES in the rebuild scenario describe order of magnitude in time/effort terms (weeks vs quarters vs years), not dollars.

If the inputs are completely empty or contain only stub data, return:
{
  "stabilizeAndKeep": { "headline": "Insufficient data for stabilization plan", "narrative": "Analyzers returned empty or stubbed results. Run a full audit on a real codebase to generate this scenario.", "sequencedSteps": [] },
  "rebuildScope": { "headline": "Insufficient data for rebuild scope", "narrative": "Analyzers returned empty or stubbed results.", "scopeRanges": [] },
  "recommendation": "needs-discovery",
  "confidence": "low",
  "caveats": ["Audit ran against insufficient analyzer output. Synthesis cannot be meaningfully completed."]
}`;

export function buildAuditRoadmapUserMessage(analyzerOutputs) {
  const { stackReality, keyPersonRisk, dependencyMap } = analyzerOutputs || {};

  // Build a structured input that's compact and easy for the LLM to parse.
  const sections = [];

  if (stackReality && !stackReality._stub && !stackReality._error) {
    sections.push('## Stack Reality Check\n');
    sections.push(`Total code LOC: ${stackReality.totalCodeLOC?.toLocaleString() || 'unknown'}\n`);
    if (stackReality.actualLanguages?.length) {
      sections.push('\nLanguages:');
      for (const lang of stackReality.actualLanguages.slice(0, 10)) {
        sections.push(`  - ${lang.language}: ${lang.pct}% (${lang.fileCount} files, ~${lang.locApprox?.toLocaleString() || 0} LOC)${lang.isCode ? '' : ' [non-code]'}`);
      }
    }
    if (stackReality.frameworks?.length) {
      sections.push('\nFrameworks detected:');
      for (const f of stackReality.frameworks) {
        const eolNote = f.eolFlag ? ` [EOL: ${f.eolNote || f.eolDate}]` : '';
        sections.push(`  - ${f.displayName} @ ${f.version}${eolNote}`);
      }
    }
    if (stackReality.surpriseFindings?.length) {
      sections.push('\nSurprise findings:');
      for (const s of stackReality.surpriseFindings) {
        sections.push(`  - ${s}`);
      }
    }
  } else if (stackReality?._stub) {
    sections.push('## Stack Reality Check: stub (no real data)\n');
  }

  if (keyPersonRisk && !keyPersonRisk._stub && !keyPersonRisk._error) {
    sections.push('\n## Key-Person Risk\n');
    if (!keyPersonRisk._gitAvailable) {
      sections.push('Git history not available — could not compute author concentration.');
      if (keyPersonRisk.callouts?.length) {
        for (const c of keyPersonRisk.callouts) sections.push(`  - ${c}`);
      }
    } else {
      sections.push(`Total authors: ${keyPersonRisk.totalAuthors}`);
      sections.push(`Total commits: ${keyPersonRisk.totalCommits}`);
      sections.push(`Bus factor: ${keyPersonRisk.busFactorEstimate}`);
      sections.push(`Concentration risk: ${keyPersonRisk.concentrationRisk.toUpperCase()}`);
      if (keyPersonRisk.topContributors?.length) {
        sections.push('\nTop contributors:');
        for (const c of keyPersonRisk.topContributors.slice(0, 5)) {
          const departed = c.likelyDeparted ? ` [likely departed, last commit ${c.daysSinceLastCommit}d ago]` : '';
          sections.push(`  - ${c.displayLabel}: ${c.linesChangedPct}% of lines, ${c.commits} commits${departed}`);
        }
      }
      if (keyPersonRisk.callouts?.length) {
        sections.push('\nCallouts:');
        for (const c of keyPersonRisk.callouts) sections.push(`  - ${c}`);
      }
    }
  } else if (keyPersonRisk?._stub) {
    sections.push('\n## Key-Person Risk: stub (no real data)\n');
  }

  if (dependencyMap && !dependencyMap._stub && !dependencyMap._error) {
    sections.push('\n## Hidden Dependency Map\n');
    sections.push(`Total dependencies: ${dependencyMap.totalDependencies || 0}`);
    if (dependencyMap.riskCallouts?.length) {
      sections.push('\nRisk callouts:');
      for (const r of dependencyMap.riskCallouts) {
        sections.push(`  - ${r.category}: ${r.count} package(s) — ${r.packages?.slice(0, 5).join(', ') || ''}${r.packages?.length > 5 ? ', ...' : ''}`);
      }
    }
    if (dependencyMap.dependencies?.length) {
      const eol = dependencyMap.dependencies.filter(d => d.eolFlag);
      const copyleft = dependencyMap.dependencies.filter(d => d.licenseRisk === 'copyleft');
      const unknown = dependencyMap.dependencies.filter(d => d.licenseRisk === 'unknown');
      if (eol.length) sections.push(`\nEOL dependencies: ${eol.map(d => d.name).slice(0, 10).join(', ')}`);
      if (copyleft.length) sections.push(`Copyleft dependencies: ${copyleft.map(d => d.name).slice(0, 10).join(', ')}`);
      if (unknown.length) sections.push(`Dependencies with unknown license: ${unknown.length} package(s)`);
    }
  } else if (dependencyMap?._stub) {
    sections.push('\n## Hidden Dependency Map: stub (no real data)\n');
  }

  const summary = sections.join('\n');

  return `Synthesize a Modernization Roadmap from the following analyzer outputs. Follow the JSON output format strictly.\n\n${summary}`;
}

