// src/modes/audit/dependencyMap.js
//
// Hidden Dependency Map — Inheritance Audit analyzer #3
//
// Third-party libraries the buyer is inheriting. License type, end-of-life
// status, last release date. The category of risk that has killed
// transactions and surprised acquirers for years.
//
// v1 scope (per build-spec decision):
//   - License parsing only
//   - EOL flags from a bundled JSON dataset
//   - Last-release-date when manifests expose it
//
// v1 explicitly DOES NOT include:
//   - CVE scanning (deferred to v1.1; will use OSV.dev free API)
//   - Transitive dependency walking (only direct deps in v1)
//   - License compatibility analysis (just license type for now)
//
// Manifests supported:
//   - package.json (npm/Node)
//   - composer.json (PHP/Composer)
//   - requirements.txt (Python pip)
//   - Gemfile (Ruby Bundler)
//   - *.csproj (.NET)
//   - pom.xml (Java/Maven) — v1.1
//   - build.gradle (Java/Gradle) — v1.1
//
// Output shape:
//   {
//     totalDependencies: number,
//     dependencies: {
//       name: string,
//       version: string,
//       ecosystem: string,        // 'npm' | 'composer' | 'pypi' | etc.
//       license: string | null,
//       licenseRisk: 'permissive' | 'copyleft' | 'commercial' | 'unknown',
//       eolFlag: boolean,
//       lastReleaseAt: string | null,  // ISO date if known
//     }[],
//     riskCallouts: {
//       category: 'copyleft' | 'eol' | 'no-license' | 'commercial',
//       packages: string[],
//       count: number,
//     }[],
//   }
//
// v1 implementation is a STUB. Manifest parsing lands in the next pass.

export async function runDependencyMap(codebaseContext, options = {}) {
  return {
    totalDependencies: 0,
    dependencies: [],
    riskCallouts: [],
    _stub: true,
  };
}
