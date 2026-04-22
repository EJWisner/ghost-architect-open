/**
 * Ghost Architect™ — Finding Verifier
 *
 * Post-synthesis grounding check. Every claim in the report is cross-referenced
 * against the actual source code before the report is shown to the user.
 *
 * Why this exists:
 *   The narrator does not see source code directly — it works from summarized
 *   pass results. Prompt-level grounding rules reduce but do not eliminate
 *   fabricated specifics (invented method names, wrong line numbers, bugs
 *   "found" in code that already implements the recommended fix).
 *
 * What it does:
 *   1. Parses findings out of the final report.
 *   2. For each finding, extracts code claims: cited files, method names,
 *      quoted code strings, cited line numbers.
 *   3. Checks each claim against the real file content in fileMap.
 *   4. Classifies the finding as VERIFIED, UNVERIFIED, or FALSE_POSITIVE.
 *   5. Returns an annotated report plus a verification report card.
 *
 * This is the fix of last resort. Prompt rules can reduce hallucination
 * volume; this module catches what slips through.
 */

import { extractFindings } from '../utils/finding-parser.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Debug telemetry directory — written once per scan, used for diagnosing verifier behavior.
// Files here are NEVER shown to the user; they're for EJ's eyes only.
const DEBUG_DIR = path.join(os.homedir(), 'Ghost Architect Reports', '.debug');

function writeDebugLog(name, payload) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(DEBUG_DIR, `verifier-debug-${ts}-${name}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  } catch (err) {
    // Never let debug logging fail the verifier.
    return null;
  }
}

// ── Patterns used by the verifier ────────────────────────────────────────────

// Method calls like ->methodName( or ::methodName(
const METHOD_CALL_RE = /(?:->|::)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

// Backtick-quoted code in markdown: `someCode`, `$var->method()`, `FILE_CONST`
const BACKTICK_RE = /`([^`\n]+?)`/g;

// Line number citations in various forms:
//   file.php:42
//   file.php:42-55
//   line 42
//   lines 42-55
const LINE_NUMBER_RE = /(?:^|\s|[:.])(?:lines?\s+)?(\d{1,4})(?:[\u2013\-](\d{1,4}))?(?=\b|[.,\s])/gi;

// Common English words that look like method names but aren't code claims
const COMMON_WORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'with', 'from', 'when', 'will',
  'should', 'could', 'would', 'have', 'been', 'does', 'used', 'uses', 'using',
  'call', 'calls', 'called', 'function', 'method', 'value', 'data', 'code',
  'type', 'state', 'screen', 'service', 'settings', 'error', 'result', 'return',
  'check', 'handle', 'handler', 'missing', 'field', 'param', 'props', 'store',
  'true', 'false', 'null', 'undefined', 'none', 'yes', 'no', 'ok', 'nok',
  'may', 'can', 'not', 'are', 'was', 'but', 'all', 'its', 'via', 'any',
  'get', 'set', 'add', 'put', 'new', 'one', 'two', 'run',
]);

// Escape a user-supplied string so it's safe to use inside a RegExp constructor.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Phrases that indicate the narrator is recommending a fix that may already exist
const RECOMMENDED_FIX_PATTERNS = [
  /\b(replace|switch|use|migrate|change|update|refactor)\b.{0,60}\bwith\b/i,
  /\binstead of\b/i,
  /\bshould use\b/i,
  /\brecommend(?:ed|ation)?\b/i,
];

// Code patterns that, if present in the source, indicate the "fix" is already in place.
// Used to detect false positives where the report flags a non-existent bug.
const SAFE_PATTERNS = {
  // Fix: parameterized queries / escaped strings
  'var_export':        [/\bvar_export\s*\(/],
  'prepared':          [/->prepare\s*\(/, /PDO::/, /\bbind(?:Param|Value)\s*\(/],
  'escapeLike':        [/->quoteInto\s*\(/, /->quote\s*\(/, /\bescapeLike\s*\(/, /addslashes\s*\(/],
  // Fix: path service instead of hardcoded path
  'directoryList':     [/DirectoryList::/, /->directoryList->/, /->getPath\s*\(/, /\$this->filesystem->/],
  // Fix: encryption service instead of plaintext
  'encryption':        [/->encryptor->/, /->encrypt\s*\(/, /random_bytes\s*\(/, /bin2hex\s*\(/],
  // Fix: configuration service instead of hardcoded secret
  'configService':     [/->scopeConfig->/, /->getConfig\s*\(/],
  // Fix: transaction wrapping (catches "missing transaction" false positives)
  'transactionWrapper':[/->beginTransaction\s*\(/, /->commit\s*\(/, /->rollBack\s*\(/, /TransactionFactory/, /->transactionFactory/],
  // Fix: exception handling (catches "swallows exceptions" false positives when try/catch IS present)
  'exceptionHandling': [/\btry\s*{/, /\bcatch\s*\(/, /->logger->error/, /->logger->critical/],
  // Fix: input validation (catches "no validation" false positives)
  'validation':        [/->validate\s*\(/, /InvalidArgumentException/, /throw new/, /instanceof/],
  // Fix: stock/inventory assignment (catches "no stock" false positives when setStockData IS present)
  'stockAssignment':   [/->setStockData\s*\(/, /StockRegistryInterface/, /->stockRegistry->/],
};

// ── Claim extraction ─────────────────────────────────────────────────────────

/**
 * Given a finding object (from extractFindings), pull out everything it claims
 * about the source code so we can check each claim.
 */
function extractClaims(finding) {
  const text = `${finding.title}\n${finding.detail}`;

  // Files it says the bug is in
  const files = [...(finding.files || [])];

  // Method names it references (from backticks and from ->/:: patterns in the text)
  const methodNames = new Set();
  for (const match of text.matchAll(METHOD_CALL_RE)) {
    const name = match[1];
    if (!COMMON_WORDS.has(name.toLowerCase()) && name.length > 2) {
      methodNames.add(name);
    }
  }
  for (const match of text.matchAll(BACKTICK_RE)) {
    const quoted = match[1].trim();
    // Treat `someMethod()` or `ClassName::method` as a method claim
    const methodInQuoted = quoted.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*\)?$/);
    if (methodInQuoted && !COMMON_WORDS.has(methodInQuoted[1].toLowerCase()) && methodInQuoted[1].length > 2) {
      methodNames.add(methodInQuoted[1]);
    }
  }

  // Backtick-quoted code strings (SQL, regex, literal strings, etc)
  // These are substantive enough to check literally against source
  const codeStrings = [];
  for (const match of text.matchAll(BACKTICK_RE)) {
    const quoted = match[1].trim();
    // Skip trivial quotes — single words or very short strings aren't "claims"
    if (quoted.length < 8) continue;
    // Skip lines that are pure prose ("a fix")
    if (/^[a-zA-Z\s]+$/.test(quoted) && quoted.split(/\s+/).length < 3) continue;
    codeStrings.push(quoted);
  }

  // Line numbers the report cites
  const lineNumbers = [];
  for (const match of text.matchAll(LINE_NUMBER_RE)) {
    const start = parseInt(match[1]);
    const end   = match[2] ? parseInt(match[2]) : start;
    if (start > 0 && start < 10000 && end >= start) {
      lineNumbers.push({ start, end, raw: match[0].trim() });
    }
  }

  return { files, methodNames: [...methodNames], codeStrings, lineNumbers };
}

// ── File resolution ──────────────────────────────────────────────────────────

/**
 * Given a claimed file path, find the actual key in fileMap that matches.
 * Handles path variations (relative, absolute, different separators).
 * Returns the fileMap key or null if no match.
 */
function resolveFile(claimedPath, fileMap) {
  if (!claimedPath) return null;
  const clean = claimedPath.replace(/^`|`$/g, '').trim();
  if (!clean) return null;

  // Exact match
  if (fileMap[clean]) return clean;

  // Basename match (report cites "ProductHandler.php", filemap has "src/EntityHandler/ProductHandler.php")
  const basename = clean.split('/').pop().split('\\').pop();
  for (const key of Object.keys(fileMap)) {
    if (key === clean) return key;
    if (key.endsWith(`/${clean}`) || key.endsWith(`\\${clean}`)) return key;
    if (key.split('/').pop() === basename || key.split('\\').pop() === basename) return key;
  }

  return null;
}

// ── Claim verification ───────────────────────────────────────────────────────

/**
 * True if the given method name appears as a real method in source — either
 * declared (`function name(`) or called (`->name(`, `::name(`, JS object shorthand).
 * Substring matching alone is too loose (`add` matches inside `addOption`).
 */
function methodAppearsInSource(methodName, source) {
  const m = escapeRegex(methodName);
  const patterns = [
    new RegExp(`\\bfunction\\s+${m}\\s*\\(`),   // function declaration
    new RegExp(`->${m}\\s*\\(`),                 // instance call
    new RegExp(`::${m}\\s*\\(`),                 // static call
    new RegExp(`\\b${m}\\s*:\\s*function`),      // JS object-literal shorthand
    new RegExp(`\\b${m}\\s*=\\s*(?:async\\s+)?(?:function|\\()`), // JS arrow/expression
  ];
  return patterns.some(re => re.test(source));
}

/**
 * Check a single finding against source. Returns:
 *   { status: 'verified' | 'unverified' | 'false_positive',
 *     reasons: string[],     // details for report card
 *     warnings: string[] }   // user-facing hedges to inject into the finding
 */
function verifyFinding(finding, fileMap) {
  const claims   = extractClaims(finding);
  const reasons  = [];
  const warnings = [];
  const flaws    = { missingMethods: [], missingStrings: [], badLineNumbers: [], outOfBoundsLines: [] };

  // 1. File resolution
  const resolvedFiles = claims.files
    .map(f => ({ claimed: f, resolved: resolveFile(f, fileMap) }))
    .filter(x => x.claimed);

  const unresolvableFiles = resolvedFiles.filter(x => !x.resolved);
  if (resolvedFiles.length > 0 && unresolvableFiles.length === resolvedFiles.length) {
    return {
      status: 'false_positive',
      reasons: [`Cited file(s) not found in scanned codebase: ${unresolvableFiles.map(x => x.claimed).join(', ')}`],
      warnings: [],
    };
  }
  if (unresolvableFiles.length > 0) {
    reasons.push(`Some cited files not found: ${unresolvableFiles.map(x => x.claimed).join(', ')}`);
  }

  // Join contents of all resolved files — we check claims against any of them
  const combinedContent = resolvedFiles
    .filter(x => x.resolved)
    .map(x => fileMap[x.resolved])
    .join('\n\n=== FILE BOUNDARY ===\n\n');

  if (!combinedContent) {
    // Finding references no files — it's a thematic observation. Can't verify, can't refute.
    return { status: 'verified', reasons: ['No file citation — accepted as thematic'], warnings: [] };
  }

  // 2. Method name verification — word-boundary aware (no more substring false positives)
  flaws.missingMethods = claims.methodNames.filter(m => !methodAppearsInSource(m, combinedContent));
  if (flaws.missingMethods.length > 0) {
    reasons.push(`Method(s) cited but not found in source: ${flaws.missingMethods.join(', ')}`);
    warnings.push(`⚠ The following method names cited in this finding were not found in the source: ${flaws.missingMethods.join(', ')}. The finding may be based on inferred rather than verified code.`);
  }

  // 3. Code string verification (substantive quoted snippets)
  const missingStrings = claims.codeStrings.filter(s => {
    // Normalize whitespace for match
    const normSrc   = combinedContent.replace(/\s+/g, ' ');
    const normClaim = s.replace(/\s+/g, ' ');
    return !normSrc.includes(normClaim);
  });
  // Only flag if the missing string looks like code (has special chars) vs prose
  flaws.missingStrings = missingStrings.filter(s => /[(){}\[\];=<>$\\]/.test(s));
  if (flaws.missingStrings.length > 0) {
    reasons.push(`Code snippet(s) cited but not found in source: ${flaws.missingStrings.slice(0, 3).map(s => `"${s.slice(0, 40)}..."`).join(', ')}`);
    warnings.push(`⚠ Specific code snippets cited in this finding do not appear verbatim in the source file(s). Treat the specifics as illustrative rather than literal.`);
  }

  // 4. Line number verification
  if (claims.lineNumbers.length > 0) {
    const lineCount = combinedContent.split('\n').length;
    flaws.outOfBoundsLines = claims.lineNumbers.filter(ln => ln.start > lineCount);
    if (flaws.outOfBoundsLines.length > 0) {
      reasons.push(`Cited line number(s) beyond end of file (file has ${lineCount} lines): ${flaws.outOfBoundsLines.map(x => x.raw).join(', ')}`);
      warnings.push(`⚠ Cited line numbers do not exist in the source file.`);
    }
    flaws.badLineNumbers = claims.lineNumbers;
    reasons.push(`Line numbers cited (narrator should avoid these): ${claims.lineNumbers.map(x => x.raw).join(', ')}`);
  }

  // 5. "Already fixed" detection — the most damaging false positive.
  // If the finding recommends a fix AND the source already uses the safe pattern, drop it.
  const isRecommendationFinding = RECOMMENDED_FIX_PATTERNS.some(re => re.test(finding.detail));
  if (isRecommendationFinding) {
    for (const [safeName, patterns] of Object.entries(SAFE_PATTERNS)) {
      const sourceUsesSafePattern = patterns.some(re => re.test(combinedContent));
      if (!sourceUsesSafePattern) continue;

      // Does the finding's own remediation recommend this safe pattern?
      const recommendsThisPattern = patterns.some(re => {
        const term = re.source.replace(/[\\bs()\[\]\*\+\?\.]/g, '').slice(0, 16);
        return term.length > 3 && new RegExp(escapeRegex(term), 'i').test(finding.detail);
      });

      if (recommendsThisPattern) {
        return {
          status: 'false_positive',
          reasons: [`Code already uses the '${safeName}' safe pattern that this finding recommends adding. Finding describes a bug that is already fixed in the source.`],
          warnings: [],
        };
      }
    }
  }

  // 6. Multi-flaw drop rule (April 22 2026):
  //    A single issue → annotate as UNVERIFIED.
  //    Two or more independent flaws → drop the finding entirely.
  const flawCount =
      (flaws.missingMethods.length   > 0 ? 1 : 0)
    + (flaws.missingStrings.length   > 0 ? 1 : 0)
    + (flaws.outOfBoundsLines.length > 0 ? 1 : 0);

  if (flawCount >= 2) {
    return {
      status: 'false_positive',
      reasons: [
        'Finding has multiple independent grounding flaws (missing methods, missing code, and/or bad line numbers). Dropped as likely fabricated.',
        ...reasons,
      ],
      warnings: [],
    };
  }

  // 7. Very high specific-claim density with one flaw → also drop.
  if (claims.methodNames.length >= 3 && flaws.missingMethods.length >= 2) {
    return {
      status: 'false_positive',
      reasons: [
        `Finding cited ${claims.methodNames.length} methods, ${flaws.missingMethods.length} of which do not exist in source. Dropped as likely fabricated.`,
      ],
      warnings: [],
    };
  }

  const status = warnings.length === 0 && reasons.every(r => r.startsWith('No file citation'))
    ? 'verified'
    : warnings.length > 0
      ? 'unverified'
      : 'verified';

  return { status, reasons, warnings };
}

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * Verify all findings in a report against the source code.
 *
 * @param {string} reportText  — the full markdown report
 * @param {object} fileMap     — { 'path/to/file.php': '<source code>' }
 * @param {object} options     — { llmVerifier?: async (finding, source) => {verdict, reason} }
 * @returns {Promise<{ annotatedReport: string, report: VerifierReport }>}
 */
export async function verifyReport(reportText, fileMap, options = {}) {
  if (!reportText) return { annotatedReport: reportText, report: emptyReport() };
  if (!fileMap || Object.keys(fileMap).length === 0) {
    return { annotatedReport: reportText, report: emptyReport('No fileMap provided — verification skipped') };
  }

  const findings = extractFindings(reportText);

  // First pass: regex verifier (cheap, always runs)
  let results = findings.map(f => ({ finding: f, ...verifyFinding(f, fileMap) }));

  // Capture regex-pass result separately so we can diff it against LLM-pass verdicts in the debug log.
  const regexResults = results.map(r => ({
    title:    r.finding.title,
    severity: r.finding.severity,
    files:    r.finding.files,
    status:   r.status,
    reasons:  [...r.reasons],
  }));

  // Track LLM verdicts in parallel so the debug log can show both what the LLM said
  // and what the final verifier decision was (they can differ when the regex pass already failed).
  const llmVerdicts = [];   // array of { title, verdict, reason, errored?, skipped? }

  // Second pass: LLM verifier (expensive, only on findings that passed the regex pass).
  // The LLM verifier catches semantic fabrications the regex pass can't — e.g.
  // "this method throws on empty input" when the method actually returns.
  if (typeof options.llmVerifier === 'function') {
    const llmResults = await Promise.all(
      results.map(async (r, idx) => {
        // Skip if already dropped by the regex pass — no point paying to re-check
        if (r.status === 'false_positive') {
          llmVerdicts[idx] = {
            title:   r.finding.title,
            skipped: 'already dropped by regex pass',
          };
          return r;
        }

        // Resolve source for the LLM check
        const resolved = (r.finding.files || [])
          .map(f => resolveFile(f, fileMap))
          .filter(Boolean);
        if (resolved.length === 0) {
          llmVerdicts[idx] = {
            title:   r.finding.title,
            skipped: 'no resolvable files cited',
          };
          return r;   // thematic, nothing to verify semantically
        }

        const source = resolved
          .map(k => `=== FILE: ${k} ===\n${fileMap[k]}`)
          .join('\n\n');

        try {
          const verdict = await options.llmVerifier(r.finding, source);
          llmVerdicts[idx] = {
            title:   r.finding.title,
            verdict: verdict?.verdict || '(none)',
            reason:  verdict?.reason  || '',
            resolvedFiles: resolved,
            sourceChars:   source.length,
          };
          if (!verdict) return r;
          if (verdict.verdict === 'contradicts' || verdict.verdict === 'not_supported') {
            return {
              ...r,
              status: 'false_positive',
              reasons: [
                `LLM verifier: finding is ${verdict.verdict === 'contradicts' ? 'contradicted by' : 'not supported by'} the source code. ${verdict.reason || ''}`.trim(),
                ...r.reasons,
              ],
              warnings: [],
            };
          }
          if (verdict.verdict === 'partial') {
            return {
              ...r,
              status: 'unverified',
              warnings: [...(r.warnings || []), `⚠ LLM verifier: ${verdict.reason || 'finding is only partially supported by the source.'}`],
              reasons:  [...(r.reasons  || []), `LLM verifier marked as partial: ${verdict.reason || ''}`],
            };
          }
          return r;
        } catch (err) {
          llmVerdicts[idx] = {
            title:   r.finding.title,
            errored: err.message,
          };
          return { ...r, reasons: [...r.reasons, `LLM verifier errored: ${err.message}`] };
        }
      })
    );
    results = llmResults;
  }

  const report = {
    totalFindings:  findings.length,
    verified:       results.filter(r => r.status === 'verified').length,
    unverified:     results.filter(r => r.status === 'unverified').length,
    falsePositives: results.filter(r => r.status === 'false_positive').length,
    details:        results.map(r => ({
      title:    r.finding.title,
      status:   r.status,
      reasons:  r.reasons,
    })),
  };

  const annotatedReport = applyAnnotations(reportText, results);

  // ── Debug telemetry (instrumentation only, no effect on output) ──────────
  // Writes a JSON file with per-finding regex + LLM verdicts so we can diagnose
  // false-positives and missed-catches without guessing. File lives in
  // ~/Ghost Architect Reports/.debug/ and is NEVER shown to the user.
  try {
    const debugPayload = {
      timestamp:      new Date().toISOString(),
      totalFindings:  findings.length,
      finalCounts: {
        verified:       report.verified,
        unverified:     report.unverified,
        falsePositives: report.falsePositives,
      },
      fileMapSize:    Object.keys(fileMap).length,
      llmVerifierEnabled: typeof options.llmVerifier === 'function',
      findings: findings.map((f, idx) => ({
        title:        f.title,
        severity:     f.severity,
        files:        f.files,
        regexResult:  regexResults[idx],
        llmVerdict:   llmVerdicts[idx] || null,
        finalStatus:  results[idx]?.status,
        finalReasons: results[idx]?.reasons || [],
      })),
    };
    writeDebugLog('scan', debugPayload);
  } catch { /* never let debug logging break the scan */ }

  return { annotatedReport, report };
}

/**
 * Rewrite the report to:
 *   - Drop false-positive findings entirely
 *   - Prefix unverified findings with a [⚠ UNVERIFIED] marker and inline warning
 *   - Leave verified findings untouched
 * Also strips invented line numbers (narrator sometimes smuggles them through).
 */
function applyAnnotations(reportText, results) {
  let out = reportText;

  // Drop false positives: replace the whole ### section with nothing
  for (const r of results) {
    if (r.status !== 'false_positive') continue;
    out = removeFindingSection(out, r.finding.title);
  }

  // Annotate unverified findings
  for (const r of results) {
    if (r.status !== 'unverified' || r.warnings.length === 0) continue;
    out = annotateFindingSection(out, r.finding.title, r.warnings);
  }

  // Strip bare line-number citations like "(line 42)", "lines 42-55", "file.php:42"
  // These are pervasive fabrications and the narrator cannot be trusted on them.
  out = out.replace(/\s*\(lines?\s+\d+[\u2013\-]?\d*\)/gi, '');
  out = out.replace(/\.php:\d+(?:[\u2013\-]\d+)?/g, '.php');
  out = out.replace(/\.js:\d+(?:[\u2013\-]\d+)?/g, '.js');
  out = out.replace(/\.ts:\d+(?:[\u2013\-]\d+)?/g, '.ts');

  return out;
}

function removeFindingSection(report, title) {
  const lines = report.split('\n');
  const esc   = escapeRegex(title.slice(0, 40));
  const headerRe = new RegExp(`^###\\s+(?:\\d+\\.\\s+)?\\*?\\*?.*${esc}`, 'i');

  const startIdx = lines.findIndex(l => headerRe.test(l));
  if (startIdx === -1) return report;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##+\s+/.test(lines[i])) { endIdx = i; break; }
  }

  lines.splice(startIdx, endIdx - startIdx);
  return lines.join('\n');
}

function annotateFindingSection(report, title, warnings) {
  const lines = report.split('\n');
  const esc   = escapeRegex(title.slice(0, 40));
  const headerRe = new RegExp(`^(###\\s+(?:\\d+\\.\\s+)?)(\\*?\\*?.*${esc})`, 'i');

  for (let i = 0; i < lines.length; i++) {
    if (!headerRe.test(lines[i])) continue;
    lines[i] = lines[i].replace(headerRe, '$1[⚠ UNVERIFIED] $2');
    lines.splice(i + 1, 0, '', `> ${warnings.join(' ')}`, '');
    break;
  }

  return lines.join('\n');
}

function emptyReport(note = '') {
  return {
    totalFindings:  0,
    verified:       0,
    unverified:     0,
    falsePositives: 0,
    details:        [],
    note,
  };
}

/**
 * Human-readable summary of the verifier's report card — for CLI display.
 */
export function formatVerifierReport(report) {
  if (!report) return '';
  const lines = [
    `  Verification: ${report.verified}/${report.totalFindings} grounded` +
      (report.unverified     > 0 ? `, ${report.unverified} unverified`         : '') +
      (report.falsePositives > 0 ? `, ${report.falsePositives} false positives dropped` : '') +
      (report.note ? ` — ${report.note}` : ''),
  ];
  return lines.join('\n');
}
