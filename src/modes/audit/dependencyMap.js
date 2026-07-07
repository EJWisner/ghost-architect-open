// src/modes/audit/dependencyMap.js
//
// Hidden Dependency Map — Inheritance Audit analyzer #3
//
// Third-party libraries the buyer is inheriting. License type, end-of-life
// status, last release date. The category of risk that has killed
// transactions and surprised acquirers for years.
//
// v1 scope:
//   - YES: enumerate ALL direct dependencies from supported manifests
//   - YES: license type classification (permissive / copyleft / commercial / unknown)
//   - YES: EOL flagging via bundled data/eol-frameworks.json
//   - YES: risk callouts grouped by category
//   - NO:  CVE scanning (deferred to v1.1, will use OSV.dev free API)
//   - NO:  transitive dependency walking (direct deps only)
//   - NO:  license compatibility math (just listing types)
//   - NO:  network calls
//
// Manifests supported in v1:
//   - package.json (npm/Node)
//   - composer.json (PHP/Composer)
//   - requirements.txt (Python pip)
//   - Gemfile (Ruby Bundler)
//   - pom.xml (Java/Maven, best-effort regex)
//   - build.gradle (Java/Gradle, best-effort regex)
//
// License classification is heuristic. We look at common SPDX identifiers
// and well-known license strings. When no license metadata is in the
// manifest (which is the common case for package.json deps without a
// "license" field at the top level), we default to "unknown" and rely on
// the surprise-finding callout to flag the audit gap.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EOL_DATA_PATH = path.join(__dirname, 'data', 'eol-frameworks.json');

let _eolData = null;
function loadEolData() {
  if (_eolData) return _eolData;
  try {
    _eolData = JSON.parse(fs.readFileSync(EOL_DATA_PATH, 'utf8'));
  } catch {
    _eolData = {};
  }
  return _eolData;
}

// ── License classification ─────────────────────────────────────────────

// SPDX identifiers and common synonyms by risk category. Conservative —
// when in doubt, classify as "unknown" so the audit gap is visible.
const PERMISSIVE = new Set([
  'MIT', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache', 'Apache-2.0',
  'ISC', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0', '0BSD', 'WTFPL', 'Zlib',
  'BSL-1.0', 'NCSA', 'Python-2.0', 'PSF-2.0',
]);

const COPYLEFT = new Set([
  'GPL', 'GPL-2.0', 'GPL-3.0', 'AGPL', 'AGPL-3.0', 'LGPL', 'LGPL-2.1',
  'LGPL-3.0', 'GPLv2', 'GPLv3', 'AGPLv3', 'LGPLv3', 'EPL', 'EPL-1.0',
  'EPL-2.0', 'MPL', 'MPL-2.0', 'CDDL', 'CDDL-1.0', 'OSL', 'OSL-3.0',
]);

const COMMERCIAL_HINTS = [
  'commercial', 'proprietary', 'see license', 'all rights reserved',
];

export function classifyLicense(licenseString) {
  if (!licenseString || typeof licenseString !== 'string') return 'unknown';
  const normalized = licenseString.trim();
  if (!normalized) return 'unknown';

  // Try exact match first for SPDX-style identifiers
  if (PERMISSIVE.has(normalized)) return 'permissive';
  if (COPYLEFT.has(normalized)) return 'copyleft';

  // Fuzzy match — check if any known token appears in the string
  const upper = normalized.toUpperCase();
  for (const lic of PERMISSIVE) {
    if (upper.includes(lic.toUpperCase())) return 'permissive';
  }
  for (const lic of COPYLEFT) {
    if (upper.includes(lic.toUpperCase())) return 'copyleft';
  }

  const lower = normalized.toLowerCase();
  for (const hint of COMMERCIAL_HINTS) {
    if (lower.includes(hint)) return 'commercial';
  }

  return 'unknown';
}

// ── Manifest parsers ───────────────────────────────────────────────────
//
// Each parser takes (content, eolData) and returns an array of dependency
// records:
//   {
//     name: string,
//     version: string,
//     ecosystem: 'npm' | 'composer' | 'pypi' | 'rubygems' | 'maven' | 'gradle',
//     license: string | null,
//     licenseRisk: 'permissive' | 'copyleft' | 'commercial' | 'unknown',
//     eolFlag: boolean,
//     eolNote: string | null,
//     manifestPath: string,
//   }

// Read license data from a sibling package-lock.json (npm lockfile v2/v3).
// package.json lists no per-dependency license, but the lockfile records a
// resolved `license` for every installed package under `packages`. We read it
// from disk (the lockfile is in the loader's IGNORED_FILES, so it never
// reaches the fileMap) using the scan's basePath plus the manifest's own
// directory. Returns a { depName: licenseString } map, or {} when no lockfile
// is reachable (ZIP/GitHub scans have no basePath; any read/parse error is
// swallowed so a malformed lockfile degrades to "unknown" rather than crashing
// the audit).
function readLockfileLicenses(basePath, manifestPath) {
  if (!basePath) return {};
  let lockData;
  try {
    const lockPath = path.resolve(basePath, path.dirname(manifestPath), 'package-lock.json');
    if (!fs.existsSync(lockPath)) return {};
    lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return {};
  }
  const lockLicenses = {};
  for (const [key, val] of Object.entries(lockData.packages || {})) {
    const name = key.replace('node_modules/', '');
    if (val && val.license) {
      lockLicenses[name] = Array.isArray(val.license)
        ? val.license.join(' OR ')
        : val.license;
    }
  }
  return lockLicenses;
}

function parsePackageJsonDeps(content, eolData, manifestPath, basePath) {
  const found = [];
  try {
    const json = JSON.parse(content);
    const deps = {
      ...(json.dependencies || {}),
      ...(json.devDependencies || {}),
      ...(json.peerDependencies || {}),
    };
    // package.json doesn't list per-dep licenses at the manifest level (those
    // live in each dep's own package.json), but a sibling package-lock.json
    // records a resolved license for every package. Load it once, then look
    // each dependency up; deps absent from the lockfile stay null -> unknown.
    const lockLicenses = readLockfileLicenses(basePath, manifestPath);
    for (const [name, version] of Object.entries(deps)) {
      const versionClean = stripVersion(version);
      const license = lockLicenses[name] || null;
      found.push({
        name,
        version: versionClean,
        ecosystem: 'npm',
        license,
        licenseRisk: classifyLicense(license),
        eolFlag: checkDepEol(name, versionClean, eolData, ecosystemFrameworkMap.npm),
        eolNote: getDepEolNote(name, versionClean, eolData, ecosystemFrameworkMap.npm),
        manifestPath,
      });
    }
  } catch {}
  return found;
}

function parseComposerJsonDeps(content, eolData, manifestPath) {
  const found = [];
  try {
    const json = JSON.parse(content);
    const reqs = {
      ...(json.require || {}),
      ...(json['require-dev'] || {}),
    };
    for (const [name, version] of Object.entries(reqs)) {
      // Composer can declare PHP runtime version as `php`; treat it as a
      // dependency for EOL purposes but skip non-package entries.
      if (name === 'php' || name.startsWith('ext-')) continue;
      const versionClean = stripVersion(version);
      // composer.json require/require-dev carry no per-dependency license
      // (that lives in each package's own composer.json), so license is null
      // and classifies as unknown until a parser populates it.
      const license = null;
      found.push({
        name,
        version: versionClean,
        ecosystem: 'composer',
        license,
        licenseRisk: classifyLicense(license),
        eolFlag: checkDepEol(name, versionClean, eolData, ecosystemFrameworkMap.composer),
        eolNote: getDepEolNote(name, versionClean, eolData, ecosystemFrameworkMap.composer),
        manifestPath,
      });
    }
  } catch {}
  return found;
}

function parseRequirementsTxtDeps(content, eolData, manifestPath) {
  const found = [];
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('-'));
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_\-.]+)\s*([=~<>!]=?[^\s;]+)?/);
    if (!m) continue;
    const name = m[1];
    const versionExpr = (m[2] || '').replace(/^[=~<>!]+/, '').trim();
    // requirements.txt lists no license per line, so license is null and
    // classifies as unknown until a parser populates it.
    const license = null;
    found.push({
      name,
      version: versionExpr,
      ecosystem: 'pypi',
      license,
      licenseRisk: classifyLicense(license),
      eolFlag: checkDepEol(name.toLowerCase(), versionExpr, eolData, ecosystemFrameworkMap.pypi),
      eolNote: getDepEolNote(name.toLowerCase(), versionExpr, eolData, ecosystemFrameworkMap.pypi),
      manifestPath,
    });
  }
  return found;
}

function parseGemfileDeps(content, eolData, manifestPath) {
  const found = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
    if (!m) continue;
    const name = m[1];
    const version = stripVersion(m[2] || '');
    // Gemfile lines carry no license, so license is null and classifies as
    // unknown until a parser populates it.
    const license = null;
    found.push({
      name,
      version,
      ecosystem: 'rubygems',
      license,
      licenseRisk: classifyLicense(license),
      eolFlag: checkDepEol(name, version, eolData, ecosystemFrameworkMap.rubygems),
      eolNote: getDepEolNote(name, version, eolData, ecosystemFrameworkMap.rubygems),
      manifestPath,
    });
  }
  return found;
}

function parsePomXmlDeps(content, eolData, manifestPath) {
  const found = [];
  // Best-effort regex against <dependency>...<groupId>...<artifactId>...<version>
  const depRegex = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match;
  while ((match = depRegex.exec(content)) !== null) {
    const block = match[1];
    const groupId = (block.match(/<groupId>([^<]+)<\/groupId>/) || [])[1] || '';
    const artifactId = (block.match(/<artifactId>([^<]+)<\/artifactId>/) || [])[1] || '';
    const version = (block.match(/<version>([^<]+)<\/version>/) || [])[1] || '';
    const name = artifactId ? (groupId ? `${groupId}:${artifactId}` : artifactId) : '';
    if (!name) continue;
    // <dependency> blocks carry no license (it lives in each artifact's own
    // POM), so license is null and classifies as unknown until populated.
    const license = null;
    found.push({
      name,
      version,
      ecosystem: 'maven',
      license,
      licenseRisk: classifyLicense(license),
      eolFlag: false,
      eolNote: null,
      manifestPath,
    });
  }
  return found;
}

function parseBuildGradleDeps(content, eolData, manifestPath) {
  const found = [];
  // Match: implementation 'group:artifact:version' or implementation "group:artifact:version"
  const depRegex = /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s+['"]([^:'"]+):([^:'"]+):([^'"]+)['"]/g;
  let match;
  while ((match = depRegex.exec(content)) !== null) {
    const [, group, artifact, version] = match;
    const name = `${group}:${artifact}`;
    // build.gradle dependency declarations carry no license, so license is
    // null and classifies as unknown until a parser populates it.
    const license = null;
    found.push({
      name,
      version,
      ecosystem: 'gradle',
      license,
      licenseRisk: classifyLicense(license),
      eolFlag: false,
      eolNote: null,
      manifestPath,
    });
  }
  return found;
}

// ── Dep-to-framework mapping (for EOL classification) ──────────────────
//
// Most deps don't map to an EOL framework. The mapping is small — only
// the major frameworks where we want EOL signal at the dep level.

const ecosystemFrameworkMap = {
  npm: {
    'react': 'react',
    'vue': 'vue',
    '@angular/core': 'angular',
  },
  composer: {
    'laravel/framework': 'laravel',
    'symfony/framework-bundle': 'symfony',
    'symfony/symfony': 'symfony',
  },
  pypi: {
    'django': 'django',
  },
  rubygems: {
    'rails': 'rails',
  },
  maven: {},
  gradle: {},
};

function checkDepEol(depName, version, eolData, mapping) {
  if (!mapping || !mapping[depName]) return false;
  const frameworkKey = mapping[depName];
  const entry = eolData[frameworkKey];
  if (!entry || !version) return false;
  for (const v of entry.versions) {
    try {
      if (new RegExp(v.match).test(version)) {
        return new Date(v.eol) < new Date();
      }
    } catch {}
  }
  return false;
}

function getDepEolNote(depName, version, eolData, mapping) {
  if (!mapping || !mapping[depName]) return null;
  const frameworkKey = mapping[depName];
  const entry = eolData[frameworkKey];
  if (!entry || !version) return null;
  for (const v of entry.versions) {
    try {
      if (new RegExp(v.match).test(version) && new Date(v.eol) < new Date()) {
        return v.note;
      }
    } catch {}
  }
  return null;
}

function stripVersion(s) {
  if (!s || typeof s !== 'string') return '';
  return s.replace(/^[\^~><=\s!*]+/, '').trim();
}

// ── Main analyzer ──────────────────────────────────────────────────────

const MANIFEST_PARSERS = [
  { filename: 'package.json', parser: parsePackageJsonDeps },
  { filename: 'composer.json', parser: parseComposerJsonDeps },
  { filename: 'requirements.txt', parser: parseRequirementsTxtDeps },
  { filename: 'Gemfile', parser: parseGemfileDeps },
  { filename: 'pom.xml', parser: parsePomXmlDeps },
  { filename: 'build.gradle', parser: parseBuildGradleDeps },
];

export async function runDependencyMap(codebaseContext, options = {}) {
  const fileMap = codebaseContext?.fileMap || {};
  const filePaths = Object.keys(fileMap);
  const eolData = loadEolData();

  const dependencies = [];

  for (const filePath of filePaths) {
    const basename = path.basename(filePath);
    for (const { filename, parser } of MANIFEST_PARSERS) {
      if (basename !== filename) continue;
      // basePath (set for local-directory scans) lets the npm parser read a
      // sibling package-lock.json from disk for license data. Other parsers
      // ignore the extra arg. It is undefined for ZIP/GitHub scans, where the
      // lockfile is not on disk and licenses fall back to "unknown".
      const deps = parser(fileMap[filePath], eolData, filePath, codebaseContext?.basePath);
      dependencies.push(...deps);
    }
  }

  // Roll up risk callouts by category
  const eolDeps = dependencies.filter(d => d.eolFlag);
  const copyleftDeps = dependencies.filter(d => d.licenseRisk === 'copyleft');
  const commercialDeps = dependencies.filter(d => d.licenseRisk === 'commercial');
  const unknownLicenseDeps = dependencies.filter(d => d.licenseRisk === 'unknown');

  const riskCallouts = [];

  if (eolDeps.length > 0) {
    riskCallouts.push({
      category: 'eol',
      count: eolDeps.length,
      packages: eolDeps.map(d => d.name),
      severity: 'high',
      summary: `${eolDeps.length} dependenc${eolDeps.length === 1 ? 'y is' : 'ies are'} past end-of-life. These no longer receive security patches.`,
    });
  }

  if (copyleftDeps.length > 0) {
    riskCallouts.push({
      category: 'copyleft',
      count: copyleftDeps.length,
      packages: copyleftDeps.map(d => d.name),
      severity: 'medium',
      summary: `${copyleftDeps.length} copyleft-licensed dependenc${copyleftDeps.length === 1 ? 'y' : 'ies'} (GPL/LGPL/AGPL family). May impose obligations on derivative or distributed works. Legal review recommended before resale.`,
    });
  }

  if (commercialDeps.length > 0) {
    riskCallouts.push({
      category: 'commercial',
      count: commercialDeps.length,
      packages: commercialDeps.map(d => d.name),
      severity: 'medium',
      summary: `${commercialDeps.length} commercially-licensed dependenc${commercialDeps.length === 1 ? 'y' : 'ies'}. Confirm license transfer is part of any acquisition.`,
    });
  }

  if (unknownLicenseDeps.length > 0 && unknownLicenseDeps.length >= dependencies.length * 0.7) {
    // Only flag this when MOST deps are unknown (i.e. a manifest with no
    // per-dependency license metadata). Otherwise it is noise.
    //
    // npm is a special case: package.json never carries per-dependency license
    // data (it lives in each dependency's own package.json), so "unknown
    // license" for npm deps is EXPECTED and benign, not a compliance red flag.
    // We only keep the audit-recommendation framing for non-npm ecosystems.
    const unknownNpm = unknownLicenseDeps.filter(d => d.ecosystem === 'npm');
    const unknownOther = unknownLicenseDeps.filter(d => d.ecosystem !== 'npm');
    const NPM_LICENSE_NOTE =
      'Note: npm package manifests do not include per-dependency license data. ' +
      '"Unknown license" for npm dependencies is expected and does not indicate a licensing problem. ' +
      'Use a tool such as license-checker for a full npm license inventory.';
    const plural = (n, has, have) => `${n} dependenc${n === 1 ? `y ${has}` : `ies ${have}`}`;

    let summary;
    if (unknownOther.length === 0) {
      // Pure npm: reframe as expected, not a red flag.
      summary = `${plural(unknownLicenseDeps.length, 'has', 'have')} no license field in the manifest. ${NPM_LICENSE_NOTE}`;
    } else if (unknownNpm.length > 0) {
      // Mixed: soften the npm portion, keep the compliance ask for the rest.
      summary =
        `${plural(unknownLicenseDeps.length, 'has', 'have')} no license metadata in the manifest, ${unknownNpm.length} of them npm. ` +
        `${NPM_LICENSE_NOTE} ` +
        `The remaining ${unknownOther.length} non-npm dependenc${unknownOther.length === 1 ? 'y' : 'ies'} should have license terms verified before any commercial transfer.`;
    } else {
      // No npm involved: a manifest that would normally carry license data does
      // not. This is a genuine signal, so keep the original framing.
      summary = `${plural(unknownLicenseDeps.length, 'has', 'have')} no license metadata in the manifest. License compliance audit recommended before any commercial transfer.`;
    }

    riskCallouts.push({
      category: 'unknown-license',
      count: unknownLicenseDeps.length,
      packages: unknownLicenseDeps.slice(0, 20).map(d => d.name),
      severity: 'low',
      summary,
    });
  }

  return {
    totalDependencies: dependencies.length,
    dependencies,
    riskCallouts,
    _stub: false,
  };
}
