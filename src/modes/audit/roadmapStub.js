// src/modes/audit/roadmapStub.js
//
// Modernization Roadmap — Inheritance Audit analyzer #4
//
// LLM-driven synthesis over the outputs of the three deterministic
// analyzers (Stack Reality, Key-Person Risk, Dependency Map) plus the
// recast findings from standard triage. Produces two scenarios in plain
// prose:
//
//   - Stabilize-and-keep: 90-day plan for the buyer who decides to retain
//     the codebase. Sequenced fixes, ownership transitions, immediate
//     dependency upgrades.
//
//   - Rebuild scope: what the buyer is walking away from if they decide
//     not to retain the codebase. Order-of-magnitude only — never specific
//     dollar figures.
//
// Architecture: delegates the actual LLM call to runAuditSynthesis in
// src/analyst/index.js, which holds all the model/API key/retry/error
// machinery for the rest of Ghost's modes. This module just sequences
// the call and adds audit-mode specific guards (skip when all inputs
// are stubs, etc.).
//
// Hard rule from the build spec: NO dollar figures in output. Enforced
// in the system prompt; if a buggy model emits one anyway it will be
// rendered verbatim — we don't post-process synthesis output yet.

import { runAuditSynthesis } from '../../analyst/index.js';

export async function runRoadmapStub(analyzerOutputs, options = {}) {
  // Guard: if all upstream analyzers are stubbed or errored, don't waste
  // an LLM call. Return a clear "insufficient data" result instead.
  const allStubbed = isAllStubsOrErrors(analyzerOutputs);
  if (allStubbed) {
    return {
      stabilizeAndKeep: {
        headline: 'Insufficient analyzer data for stabilization plan',
        narrative: 'All upstream analyzers returned stubbed or empty results. The modernization roadmap synthesis requires real analyzer output to produce meaningful scenarios.',
        sequencedSteps: [],
      },
      rebuildScope: {
        headline: 'Insufficient analyzer data for rebuild scope',
        narrative: 'See above.',
        scopeRanges: [],
      },
      recommendation: 'needs-discovery',
      confidence: 'low',
      caveats: ['Upstream analyzers returned no real findings — synthesis cannot be meaningfully completed.'],
      _stub: false,
      _skippedLLM: true,
    };
  }

  // Real call. The analyst module handles model selection, API key
  // resolution, JSON parsing, and error normalization.
  const result = await runAuditSynthesis(analyzerOutputs, options);

  return {
    ...result,
    _stub: false,
  };
}

function isAllStubsOrErrors(outputs) {
  if (!outputs) return true;
  const { stackReality, keyPersonRisk, dependencyMap } = outputs;
  const flag = (o) => !o || o._stub || o._error;
  return flag(stackReality) && flag(keyPersonRisk) && flag(dependencyMap);
}
