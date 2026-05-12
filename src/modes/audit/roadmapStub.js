// src/modes/audit/roadmapStub.js
//
// Modernization Roadmap Stub — Inheritance Audit analyzer #4
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
//     dollar figures. (Per build-spec decision: dollar figures introduce
//     false precision and legal exposure.)
//
// Implementation:
//   - Single LLM call with all upstream analyzer output as context
//   - Uses the audit-v1 prompt pack (see prompts/audit-v1.md)
//   - Verifier wrapping to suppress hallucinated specifics
//   - Skeleton cross-feeding stays disabled (per v4.8.0 hallucination fix)
//
// Output shape:
//   {
//     stabilizeAndKeep: {
//       headline: string,
//       narrative: string,           // paragraphs
//       sequencedSteps: {
//         phase: 'Days 1-30' | 'Days 31-60' | 'Days 61-90',
//         items: string[],
//       }[],
//     },
//     rebuildScope: {
//       headline: string,
//       narrative: string,
//       scopeRanges: string[],       // prose-only, NO dollar figures
//     },
//     recommendation: 'stabilize' | 'rebuild' | 'mixed' | 'needs-discovery',
//     confidence: 'low' | 'medium' | 'high',
//     caveats: string[],
//   }
//
// v1 implementation is a STUB. The LLM synthesis pipeline ships in the
// next build pass (Day 3 of the audit-mode plan).

export async function runRoadmapStub(analyzerOutputs, options = {}) {
  return {
    stabilizeAndKeep: {
      headline: 'Stabilization plan not yet generated',
      narrative: 'Audit Mode is in early development. The modernization roadmap synthesis will be implemented in a subsequent build pass.',
      sequencedSteps: [],
    },
    rebuildScope: {
      headline: 'Rebuild scope not yet generated',
      narrative: 'Coming in the next build pass.',
      scopeRanges: [],
    },
    recommendation: 'needs-discovery',
    confidence: 'low',
    caveats: ['Audit Mode v0.1.0 — analyzers are stubbed pending full implementation'],
    _stub: true,
  };
}
