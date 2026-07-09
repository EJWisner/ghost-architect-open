// src/modes/audit/stackReality.js
//
// Stack Reality Check — Inheritance Audit analyzer #1
//
// What the seller said vs. what's actually there. Deterministic, no LLM.
//
// Pulls data from:
//   - File extension census on codebaseContext.fileMap
//   - Package manifest detection + parsing (package.json, composer.json,
//     requirements.txt, Gemfile, *.csproj, pom.xml — best-effort regex,
//     no manifest-language-specific deps required)
//   - End-of-life flagging via the bundled data/eol-frameworks.json dataset
//
// v1 scope:
//   - YES: language LOC distribution, framework detection, EOL flagging
//   - YES: surprise findings prose ("70% PHP but no Composer manifest")
//   - NO:  multi-language framework detection edge cases (we'll add later)
//   - NO:  monorepo workspace traversal — we parse what we find at any level
//   - NO:  network calls — all data is bundled or on-disk

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EOL_DATA_PATH = path.join(__dirname, 'data', 'eol-frameworks.json');

// Lazy-loaded; reuse across calls within a process.
let _eolData = null;
function loadEolData() {
  if (_eolData) return _eolData;
  try {
    _eolData = JSON.parse(fs.readFileSync(EOL_DATA_PATH, 'utf8'));
  } catch (err) {
    _eolData = {};
  }
  return _eolData;
}

// ── Language classification ────────────────────────────────────────────

// Extension → language display name. Conservative mapping — when in
// doubt, we'd rather list a language than incorrectly merge two.
const LANGUAGE_MAP = {
  '.php': 'PHP',
  '.phtml': 'PHP',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript (React)',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript (React)',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.scala': 'Scala',
  '.go': 'Go',
  '.rs': 'Rust',
  '.cs': 'C#',
  '.vb': 'Visual Basic',
  '.fs': 'F#',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.c': 'C',
  '.h': 'C/C++ header',
  '.hpp': 'C++ header',
  '.swift': 'Swift',
  '.m': 'Objective-C',
  '.mm': 'Objective-C++',
  '.vue': 'Vue.js',
  '.svelte': 'Svelte',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sass': 'Sass',
  '.less': 'Less',
  '.sql': 'SQL',
  '.xml': 'XML',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.md': 'Markdown',
};

// Extensions we count as "real code" for percentage math (vs config/markup).
const CODE_EXTS = new Set([
  '.php', '.phtml',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.rb',
  '.java', '.kt', '.scala',
  '.go', '.rs',
  '.cs', '.vb', '.fs',
  '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
  '.swift', '.m', '.mm',
  '.vue', '.svelte',
]);

// ── Manifest detection ─────────────────────────────────────────────────

// Manifests we know how to parse. Each entry returns a list of detected
// framework records from the manifest text.
const MANIFEST_PARSERS = [
  {
    filename: 'package.json',
    ecosystem: 'npm',
    parse: parsePackageJson,
  },
  {
    filename: 'composer.json',
    ecosystem: 'composer',
    parse: parseComposerJson,
  },
  {
    filename: 'requirements.txt',
    ecosystem: 'pypi',
    parse: parseRequirementsTxt,
  },
  {
    filename: 'Gemfile',
    ecosystem: 'rubygems',
    parse: parseGemfile,
  },
  {
    filename: 'pom.xml',
    ecosystem: 'maven',
    parse: parsePomXml,
  },
  {
    filename: 'build.gradle',
    ecosystem: 'gradle',
    parse: parseBuildGradle,
  },
];

function parsePackageJson(content) {
  const found = [];
  try {
    const json = JSON.parse(content);

    // Node runtime version from "engines.node"
    if (json.engines && typeof json.engines.node === 'string') {
      found.push({
        name: 'node',
        version: stripVersionPrefix(json.engines.node),
        manifest: 'package.json',
      });
    }

    const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) };

    // Map well-known npm package names to framework keys in eol-frameworks.json
    const frameworkMappings = {
      'react': 'react',
      'vue': 'vue',
      '@angular/core': 'angular',
      'next': 'next',
      'nuxt': 'nuxt',
      'svelte': 'svelte',
      '@nestjs/core': 'nestjs',
    };

    for (const [pkg, frameworkKey] of Object.entries(frameworkMappings)) {
      if (deps[pkg]) {
        found.push({
          name: frameworkKey,
          version: stripVersionPrefix(deps[pkg]),
          manifest: 'package.json',
        });
      }
    }
  } catch {}
  return found;
}

function parseComposerJson(content) {
  const found = [];
  try {
    const json = JSON.parse(content);

    // PHP runtime version from "require.php"
    if (json.require && typeof json.require.php === 'string') {
      found.push({
        name: 'php',
        version: stripVersionPrefix(json.require.php),
        manifest: 'composer.json',
      });
    }

    const reqs = { ...(json.require || {}), ...(json['require-dev'] || {}) };

    const frameworkMappings = {
      'laravel/framework': 'laravel',
      'symfony/framework-bundle': 'symfony',
      'symfony/symfony': 'symfony',
      'magento/product-community-edition': 'magento',
      'magento/magento2-base': 'magento',
    };

    for (const [pkg, frameworkKey] of Object.entries(frameworkMappings)) {
      if (reqs[pkg]) {
        found.push({
          name: frameworkKey,
          version: stripVersionPrefix(reqs[pkg]),
          manifest: 'composer.json',
        });
      }
    }
  } catch {}
  return found;
}

function parseRequirementsTxt(content) {
  const found = [];
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const frameworkMappings = {
    'django': 'django',
    'flask': 'flask',
    'fastapi': 'fastapi',
  };
  for (const line of lines) {
    // requirements.txt: "package==1.2.3" or "package>=1.2,<2.0" etc.
    const m = line.match(/^([A-Za-z0-9_\-.]+)\s*([=~<>!]=?[^\s;]+)?/);
    if (!m) continue;
    const pkg = m[1].toLowerCase();
    const versionExpr = (m[2] || '').replace(/^==?\s*/, '');
    if (frameworkMappings[pkg]) {
      found.push({
        name: frameworkMappings[pkg],
        version: versionExpr,
        manifest: 'requirements.txt',
      });
    }
  }
  return found;
}

function parseGemfile(content) {
  const found = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
    if (!m) continue;
    const gem = m[1];
    const version = m[2] || '';
    if (gem === 'rails') {
      found.push({ name: 'rails', version: stripVersionPrefix(version), manifest: 'Gemfile' });
    }
  }
  return found;
}

function parsePomXml(content) {
  const found = [];
  // Best-effort regex against XML. Look for spring-boot version.
  const sbMatch = content.match(/<artifactId>spring-boot[^<]*<\/artifactId>[\s\S]*?<version>([^<]+)<\/version>/);
  if (sbMatch) {
    found.push({ name: 'spring-boot', version: sbMatch[1], manifest: 'pom.xml' });
  }
  // Look for Java version from <java.version> or maven-compiler-plugin source/target.
  const javaMatch = content.match(/<java\.version>([^<]+)<\/java\.version>/);
  if (javaMatch) {
    found.push({ name: 'java', version: javaMatch[1], manifest: 'pom.xml' });
  }
  return found;
}

function parseBuildGradle(content) {
  const found = [];
  const sbMatch = content.match(/['"]org\.springframework\.boot['"]\s+version\s+['"]([^'"]+)['"]/);
  if (sbMatch) {
    found.push({ name: 'spring-boot', version: sbMatch[1], manifest: 'build.gradle' });
  }
  return found;
}

// ── Helpers ────────────────────────────────────────────────────────────

function stripVersionPrefix(versionString) {
  if (!versionString || typeof versionString !== 'string') return '';
  // Strip common semver prefixes (^, ~, >=, etc.) and whitespace
  return versionString.replace(/^[\^~><=\s!]+/, '').trim();
}

// Composer (and some others) accept multi-version constraint syntax like
// "8.1.0||~8.2.0||~8.3.0||~8.4.0" meaning "any of these versions."
// Raw, that's noise in a deal-grade report. Normalize to a clean form:
//   - Strip per-segment semver prefixes (~, ^, >=, etc.)
//   - Take the lowest version as the floor
//   - Take the highest version as the ceiling
//   - If floor === ceiling, just show that version
//   - If multiple distinct versions, show "floor – ceiling" or "floor+" if no ceiling
// Returns a tuple { displayVersion, floorVersion } so EOL classification
// can still match against the floor (most conservative reading).
function normalizeVersionConstraint(versionString) {
  if (!versionString || typeof versionString !== 'string') {
    return { displayVersion: '', floorVersion: '' };
  }
  // Split on || (Composer/npm OR syntax) or , (and-constraint), then strip
  // each segment.
  const segments = versionString.split(/\|\||,/).map(s => stripVersionPrefix(s)).filter(Boolean);
  if (segments.length === 0) return { displayVersion: versionString, floorVersion: versionString };
  if (segments.length === 1) return { displayVersion: segments[0], floorVersion: segments[0] };
  // Sort by semver-ish numeric comparison (major.minor.patch)
  const parsed = segments.map(s => {
    const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return {
      raw: s,
      key: m ? [parseInt(m[1] || '0', 10), parseInt(m[2] || '0', 10), parseInt(m[3] || '0', 10)] : [0, 0, 0],
    };
  });
  parsed.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    }
    return 0;
  });
  const floor = parsed[0].raw;
  const ceiling = parsed[parsed.length - 1].raw;
  return {
    displayVersion: floor === ceiling ? floor : `${floor} – ${ceiling}`,
    floorVersion: floor,
  };
}

function classifyEol(frameworkKey, version, eolData) {
  const entry = eolData[frameworkKey];
  if (!entry || !version) return null;

  for (const v of entry.versions) {
    let pattern;
    try {
      pattern = new RegExp(v.match);
    } catch {
      continue;
    }
    if (pattern.test(version)) {
      const eolDate = new Date(v.eol);
      const now = new Date();
      return {
        displayName: entry.displayName,
        matchedVersion: version,
        eolDate: v.eol,
        eolFlag: eolDate < now,
        note: v.note,
      };
    }
  }
  return {
    displayName: entry.displayName,
    matchedVersion: version,
    eolDate: null,
    eolFlag: false,
    note: 'Version not in dataset',
  };
}

function approxLOC(content) {
  if (!content || typeof content !== 'string') return 0;
  // Count non-empty, non-pure-comment-bracket lines. Good-enough for percentages.
  let loc = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[/*}{)(\[\]<>\-]+$/.test(trimmed)) continue;
    loc++;
  }
  return loc;
}

// ── Main analyzer ──────────────────────────────────────────────────────

export async function runStackRealityCheck(codebaseContext, options = {}) {
  const fileMap = codebaseContext?.fileMap || {};
  const filePaths = Object.keys(fileMap);
  const eolData = loadEolData();

  // 1. Language census ─────────────────────────────────────────────────
  const langStats = new Map(); // language → { fileCount, locApprox, isCode }
  let totalCodeLOC = 0;
  let totalAllLOC = 0;

  for (const filePath of filePaths) {
    const ext = path.extname(filePath).toLowerCase();
    const lang = LANGUAGE_MAP[ext];
    if (!lang) continue;
    const loc = approxLOC(fileMap[filePath]);
    const isCode = CODE_EXTS.has(ext);
    if (!langStats.has(lang)) {
      langStats.set(lang, { fileCount: 0, locApprox: 0, isCode });
    }
    const s = langStats.get(lang);
    s.fileCount++;
    s.locApprox += loc;
    totalAllLOC += loc;
    if (isCode) totalCodeLOC += loc;
  }

  // Code languages get their percentage relative to total code LOC.
  // Non-code (markdown, JSON, YAML, etc.) get their percentage relative
  // to total all-files LOC and are tagged so the renderer can group
  // them visually. This avoids the >100% total bug from mixing denominators.
  const actualLanguages = Array.from(langStats.entries())
    .map(([language, { fileCount, locApprox, isCode }]) => ({
      language,
      fileCount,
      locApprox,
      isCode,
      pct: isCode
        ? (totalCodeLOC > 0 ? Math.round((locApprox / totalCodeLOC) * 100) : 0)
        : (totalAllLOC > 0 ? Math.round((locApprox / totalAllLOC) * 100) : 0),
    }))
    .filter(l => l.fileCount > 0)
    .sort((a, b) => {
      // Code languages first, then non-code, each group sorted by LOC desc.
      if (a.isCode && !b.isCode) return -1;
      if (!a.isCode && b.isCode) return 1;
      return b.locApprox - a.locApprox;
    });

  // 2. Framework detection from manifests ──────────────────────────────
  const rawFrameworks = [];

  for (const filePath of filePaths) {
    const basename = path.basename(filePath);
    for (const parser of MANIFEST_PARSERS) {
      let matches = false;
      if (parser.filename === '*.csproj') {
        matches = basename.endsWith('.csproj');
      } else {
        matches = basename === parser.filename;
      }
      if (!matches) continue;
      const detections = parser.parse(fileMap[filePath]);
      for (const d of detections) {
        // Normalize multi-version constraint syntax before EOL classification.
        // The floor version is what we match against the EOL dataset — most
        // conservative reading. The display version is what appears in the
        // report (clean prose, no Composer/npm OR syntax leaking through).
        const { displayVersion, floorVersion } = normalizeVersionConstraint(d.version);
        const classification = classifyEol(d.name, floorVersion, eolData);
        rawFrameworks.push({
          name: d.name,
          displayName: classification?.displayName || d.name,
          version: displayVersion,
          floorVersion,
          manifest: d.manifest,
          manifestPath: filePath,
          eolFlag: classification?.eolFlag || false,
          eolDate: classification?.eolDate || null,
          eolNote: classification?.note || null,
        });
      }
    }
  }

  // Dedup: the same framework + version combination can be detected across
  // many manifest files (e.g. a Magento extension repo with one composer.json
  // per module, all declaring the same PHP version requirement). Roll those
  // up to one entry per (name, version) pair, with a manifestCount field
  // so the renderer can show "PHP 8.1 (declared in 5 manifests)" if useful.
  const dedupMap = new Map();
  for (const f of rawFrameworks) {
    const key = `${f.name}|${f.version}`;
    if (!dedupMap.has(key)) {
      dedupMap.set(key, { ...f, manifestCount: 1, manifestPaths: [f.manifestPath] });
    } else {
      const existing = dedupMap.get(key);
      existing.manifestCount++;
      existing.manifestPaths.push(f.manifestPath);
    }
  }
  const detectedFrameworks = Array.from(dedupMap.values());

  // 3. Surprise findings — heuristic prose callouts ────────────────────
  const surprises = [];

  // Heuristic 1: A language dominates LOC but no matching manifest detected
  if (actualLanguages.length > 0) {
    const top = actualLanguages[0];
    const hasComposer = filePaths.some(p => path.basename(p) === 'composer.json');
    const hasPackageJson = filePaths.some(p => path.basename(p) === 'package.json');
    const hasGemfile = filePaths.some(p => path.basename(p) === 'Gemfile');
    const hasRequirements = filePaths.some(p => path.basename(p) === 'requirements.txt');

    if (top.language === 'PHP' && top.pct >= 30 && !hasComposer) {
      surprises.push(
        `${top.pct}% of code is PHP but no composer.json was found -- dependency management may be ad-hoc or vendored.`
      );
    }
    if ((top.language === 'JavaScript' || top.language === 'TypeScript') && top.pct >= 30 && !hasPackageJson) {
      surprises.push(
        `${top.pct}% of code is ${top.language} but no package.json was found -- dependency management may be missing.`
      );
    }
    if (top.language === 'Ruby' && top.pct >= 30 && !hasGemfile) {
      surprises.push(
        `${top.pct}% of code is Ruby but no Gemfile was found -- dependency management may be missing.`
      );
    }
    if (top.language === 'Python' && top.pct >= 30 && !hasRequirements) {
      surprises.push(
        `${top.pct}% of code is Python but no requirements.txt was found -- dependency declarations may be missing or in pyproject.toml (not yet parsed in v1).`
      );
    }
  }

  // Heuristic 2: Any EOL framework flagged
  const eolFrameworks = detectedFrameworks.filter(f => f.eolFlag);
  for (const f of eolFrameworks) {
    surprises.push(
      `${f.displayName} ${f.version} is past end-of-life (${f.eolDate}). ${f.eolNote || ''}`.trim()
    );
  }

  // Heuristic 3: Multiple competing front-end frameworks
  const frontendFrameworks = detectedFrameworks
    .filter(f => ['react', 'vue', 'angular', 'svelte'].includes(f.name))
    .map(f => f.displayName);
  if (frontendFrameworks.length > 1) {
    const unique = [...new Set(frontendFrameworks)];
    if (unique.length > 1) {
      surprises.push(
        `Multiple front-end frameworks detected: ${unique.join(', ')}. Investigate whether this is intentional (gradual migration) or accidental fragmentation.`
      );
    }
  }

  return {
    declaredStack: [],  // populated by caller if they pass declaredStack in options
    actualLanguages,
    totalCodeLOC,
    totalAllLOC,
    frameworks: detectedFrameworks,
    surpriseFindings: surprises,
    _stub: false,
  };
}
