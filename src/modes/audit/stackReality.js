// src/modes/audit/stackReality.js
//
// Stack Reality Check — Inheritance Audit analyzer #1
//
// What the seller said vs. what's actually there. Deterministic, no LLM.
//
// Pulls data from:
//   - File extension census (already computed during codebase load)
//   - Package manifests (package.json, composer.json, requirements.txt,
//     Gemfile, *.csproj, pom.xml, build.gradle)
//   - Framework version detection from manifest dependencies
//   - End-of-life flags from a bundled JSON dataset (added in v1.1)
//
// Output shape:
//   {
//     declaredStack: string[],    // what the seller's pitch said
//     actualLanguages: {           // computed from file census
//       language: string, locApprox: number, fileCount: number, pct: number
//     }[],
//     frameworks: {                // detected from manifests
//       name: string, version: string, eolFlag: boolean, eolNote: string|null
//     }[],
//     surpriseFindings: string[],  // human-readable callouts e.g. "Product
//                                  // described as .NET; 30% of LOC is VB.NET"
//   }
//
// v1 implementation is a STUB. Returns empty arrays so the audit pipeline
// can be wired and tested end-to-end before this analyzer is real.

export async function runStackRealityCheck(codebaseContext, options = {}) {
  return {
    declaredStack: [],
    actualLanguages: [],
    frameworks: [],
    surpriseFindings: [],
    _stub: true,
  };
}
