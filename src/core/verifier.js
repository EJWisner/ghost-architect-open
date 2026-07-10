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
import { runWithConcurrency } from '../utils/concurrency.js';
import { buildLineCitationRegex } from '../constants/code-extensions.js';

// Built once. Note the `g` flag makes RegExp objects stateful via lastIndex, but
// String.prototype.replace resets lastIndex on every call, so a module-level
// instance is safe here. Do not use this constant with .test() or .exec().
const LINE_CITATION_REGEX = buildLineCitationRegex();
import fs from 'fs';
import path from 'path';
import os from 'os';

// Verifier-specific policy: cap the LLM verifier pass to this many concurrent
// Anthropic calls so a large report doesn't rate-limit a BYOK low-tier key. The
// pool implementation is shared (src/utils/concurrency.js) and preserves order.
const CONCURRENCY_LIMIT = 4;

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
// Require explicit 'line(s)' keyword or file:N pattern to avoid matching
// cost ranges ($400-$800), effort ranges (2-4 hours), and version numbers.
const LINE_NUMBER_RE = /(?:(?:^|\s|[:.])\blines?\s+|[a-zA-Z0-9._-]+[:.])(\d{1,4})(?:[\u2013\-](\d{1,4}))?(?=\b|[.,\s])/gi;

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
 * Verify a set of finding objects against the source code.
 *
 * Split out of verifyReport so the same two-pass pipeline can run over findings
 * that never reached the report. The narrator caps prose rendering at
 * MAX_FINDINGS_FOR_PASS_2, so verifyReport (which parses findings back out of
 * the rendered markdown) only ever sees the findings that were detailed. The
 * findings ranked below the cap were previously never verified at all, which is
 * why they could not be written to the findings sidecar: an unverified finding
 * is not one we are willing to hand a buyer.
 *
 * @param {object[]} findings  — finding objects: { title, severity, detail, files, ... }
 * @param {object} fileMap     — { 'path/to/file.php': '<source code>' }
 * @param {object} options     — { llmVerifier?, debugLabel? }
 * @returns {Promise<{ results: object[], report: VerifierReport }>}
 *          results[i] = { finding, status, reasons, warnings }
 *          status is one of: verified | unverified | disputed | false_positive
 */
export async function verifyFindings(findings, fileMap, options = {}) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return { results: [], report: emptyReport() };
  }
  if (!fileMap || Object.keys(fileMap).length === 0) {
    return { results: [], report: emptyReport('No fileMap provided — verification skipped') };
  }

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

  // Findings the LLM verifier never actually judged (transport failure, malformed
  // response, or a thrown error). These are EXEMPT from the DISPUTED sweep below:
  // the sweep drops findings the verifier contradicted, and a verifier that never
  // ran contradicted nothing. Without this exemption a single transient 429
  // silently deletes a real, source-confirmable finding from a paid report.
  const verifierUnavailable = new Set();   // finding indices

  // Second pass: LLM verifier (expensive, only on findings that passed the regex pass).
  // The LLM verifier catches semantic fabrications the regex pass can't — e.g.
  // "this method throws on empty input" when the method actually returns.
  if (typeof options.llmVerifier === 'function') {
    // One task per finding, run through the bounded pool (max CONCURRENCY_LIMIT
    // in-flight) instead of all-at-once, so a large report doesn't rate-limit a
    // BYOK key. runWithConcurrency preserves finding order.
    const verifierTasks = results.map((r, idx) => async () => {
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
          if (verdict.verdict === 'error') {
            // The verifier never reached a judgement (rate limit, 5xx, malformed
            // response). Leave the finding exactly as the regex pass left it, mark
            // it exempt from the DISPUTED sweep, and keep the raw failure text OUT
            // of `warnings` — warnings are rendered into the customer's report and
            // "LLM verifier call failed: 429 {...}" is not a consultant deliverable.
            // The reason still lands in `reasons`, which is internal/debug only.
            verifierUnavailable.add(idx);
            return {
              ...r,
              reasons: [...(r.reasons || []), `LLM verifier unavailable: ${verdict.reason || 'unknown error'}`],
            };
          }
          if (verdict.verdict === 'contradicts') {
            // LLM read the source and saw it contradict the finding.
            // High-confidence drop — the finding is wrong.
            return {
              ...r,
              status: 'false_positive',
              reasons: [
                'LLM verifier: finding is contradicted by the source code. ' + (verdict.reason || ''),
                ...r.reasons,
              ],
              warnings: [],
            };
          }
          if (verdict.verdict === 'not_supported') {
            // LLM couldn't find evidence FOR the finding in the source, but
            // absence of evidence is not evidence of absence — the finding
            // might be about a pattern the LLM missed in the truncated context.
            // Annotate, don't drop. Lets a thoughtful reviewer judge.
            return {
              ...r,
              status: 'unverified',
              warnings: [
                ...(r.warnings || []),
                '⚠ LLM verifier could not confirm this finding from the source code provided. ' + (verdict.reason || 'Treat as a starting point for investigation rather than a confirmed issue.'),
              ],
              reasons: [
                ...(r.reasons || []),
                'LLM verifier marked as not_supported: ' + (verdict.reason || ''),
              ],
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
          if (verdict.verdict === 'supports') {
            // The LLM read the actual source and confirmed the finding is real.
            // Mark it verified and clear ONLY the cheap Pass-1 snippet-mismatch
            // warning (the "does not appear verbatim" heuristic): source-level
            // confirmation overrules it. Left in place, that warning phrase would
            // be matched by the DISPUTED sweep below and a source-confirmed
            // finding would be silently dropped.
            return {
              ...r,
              status: 'verified',
              warnings: (r.warnings || []).filter(w => !/do not appear verbatim/i.test(w)),
            };
          }
          return r;
        } catch (err) {
          llmVerdicts[idx] = {
            title:   r.finding.title,
            errored: err.message,
          };
          // Same contract as the 'error' verdict above: a verifier that threw
          // never judged the finding, so it cannot be treated as disputing it.
          verifierUnavailable.add(idx);
          return { ...r, reasons: [...r.reasons, `LLM verifier errored: ${err.message}`] };
        }
    });
    const llmResults = await runWithConcurrency(verifierTasks, CONCURRENCY_LIMIT);
    results = llmResults;
  }

  // ── DISPUTED reclassification ──────────────────────────────────────────────
  // An UNVERIFIED verdict means "could not confirm" — absence of evidence. But
  // when the verifier's own reasons/warnings say the cited code does not appear
  // verbatim or cannot be verified from the source, the verifier is actively
  // CONTRADICTING the citation, not merely failing to confirm it. Those are
  // false positives: reclassify them DISPUTED and drop them entirely (not shown
  // to the user, not counted as unverified), logged at debug level only. This
  // removes the noise where the verifier disputes the finding rather than simply
  // being unable to confirm it.
  const DISPUTED_PHRASES = [
    'specific code snippets cited do not appear verbatim',
    'cannot be verified from the source file',
    'cited in this finding do not appear',
  ];
  results = results.map((r, idx) => {
    if (r.status !== 'unverified') return r;
    // A finding the LLM verifier never judged cannot have been disputed by it.
    // Dropping it here would delete a real finding on a transient API failure.
    if (verifierUnavailable.has(idx)) return r;
    const haystack = [...(r.reasons || []), ...(r.warnings || [])]
      .join(' ')
      .toLowerCase();
    if (DISPUTED_PHRASES.some(p => haystack.includes(p))) {
      // One INFO line per dropped finding, always shown (not gated behind
      // GHOST_DEBUG) so the user understands why a finding is absent from the
      // report rather than wondering where it went.
      console.info(
        '[Ghost] Finding dropped (DISPUTED): ' +
        (r.finding.id || r.finding.title) + ' -- verifier contradicted cited code.'
      );
      return { ...r, status: 'disputed' };
    }
    return r;
  });

  // If the LLM verifier was unavailable for any finding, say so once, on stderr,
  // to the operator. Silence here is how a degraded verification pass gets
  // mistaken for a clean one: the findings still print, just unconfirmed.
  if (verifierUnavailable.size > 0) {
    console.info(
      `[Ghost] LLM verification unavailable for ${verifierUnavailable.size} of ${findings.length} finding(s). ` +
      `Those findings were kept and marked unverified rather than dropped. Re-run to verify them.`
    );
  }

  const report = {
    totalFindings:  findings.length,
    verified:       results.filter(r => r.status === 'verified').length,
    unverified:     results.filter(r => r.status === 'unverified').length,
    disputed:       results.filter(r => r.status === 'disputed').length,
    falsePositives: results.filter(r => r.status === 'false_positive').length,
    verifierUnavailable: verifierUnavailable.size,
    details:        results.map(r => ({
      title:    r.finding.title,
      status:   r.status,
      reasons:  r.reasons,
    })),
  };

  // ── Debug telemetry (instrumentation only, no effect on output) ──────────
  // Writes a JSON file with per-finding regex + LLM verdicts so we can diagnose
  // false-positives and missed-catches without guessing. File lives in
  // ~/Ghost Architect Reports/.debug/ and is NEVER shown to the user.
  try {
    const debugPayload = {
      timestamp:      new Date().toISOString(),
      scope:          options.debugLabel || 'report',
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

  return { results, report };
}

// A finding survives verification when the verifier did not actively reject it.
// `disputed` and `false_positive` are the two rejecting verdicts, and both are
// removed from the report body by applyAnnotations' isDropped. `verified` and
// `unverified` both survive: unverified means "could not confirm", which is an
// absence of evidence, not evidence of absence.
export function survivedVerification(result) {
  return result.status !== 'disputed' && result.status !== 'false_positive';
}

/**
 * Verify all findings in a report against the source code, and annotate it.
 *
 * @param {string} reportText  — the full markdown report
 * @param {object} fileMap     — { 'path/to/file.php': '<source code>' }
 * @param {object} options     — { llmVerifier?: async (finding, source) => {verdict, reason} }
 * @returns {Promise<{ annotatedReport: string, report: VerifierReport, results: object[] }>}
 */
export async function verifyReport(reportText, fileMap, options = {}) {
  if (!reportText) return { annotatedReport: reportText, report: emptyReport(), results: [] };
  if (!fileMap || Object.keys(fileMap).length === 0) {
    return {
      annotatedReport: reportText,
      report: emptyReport('No fileMap provided — verification skipped'),
      results: [],
    };
  }

  const findings = extractFindings(reportText);
  const { results, report } = await verifyFindings(findings, fileMap, options);
  const annotatedReport = applyAnnotations(reportText, results);

  return { annotatedReport, report, results };
}

/**
 * Rewrite the report to:
 *   - Drop false-positive findings entirely (prose AND remediation table row)
 *   - Prefix unverified findings with a [⚠ UNVERIFIED] marker and inline warning
 *   - Leave verified findings untouched
 *   - Renumber the table's Priority column after drops
 * Also strips invented line numbers (narrator sometimes smuggles them through).
 */
function applyAnnotations(reportText, results) {
  let out = reportText;

  // Collect dropped titles up front so we can also strip table rows. Both
  // false-positive and disputed findings are dropped from the user-facing report.
  const isDropped = (r) => r.status === 'false_positive' || r.status === 'disputed';
  const droppedTitles = results
    .filter(isDropped)
    .map(r => r.finding.title);

  // Drop false positives and disputed findings: replace the whole ### section
  // with nothing so neither the prose nor the table row survives.
  for (const r of results) {
    if (!isDropped(r)) continue;
    out = removeFindingSection(out, r.finding.title);
  }

  // Strip remediation table rows for any dropped finding, then renumber
  // the Priority column so it remains 1..N. This keeps the table and the
  // prose in sync — a row in the table without a finding above it is the
  // most embarrassing kind of consultant-deliverable defect.
  if (droppedTitles.length > 0) {
    out = stripDroppedRowsFromTable(out, droppedTitles, droppedTitles.length);
  }

  // Annotate unverified findings
  for (const r of results) {
    if (r.status !== 'unverified' || r.warnings.length === 0) continue;
    out = annotateFindingSection(out, r.finding.title, r.warnings);
  }

  // Strip bare line-number citations like "(line 42)", "lines 42-55", "file.php:42"
  // These are pervasive fabrications and the narrator cannot be trusted on them.
  //
  // The per-extension pass used to be three hardcoded replaces (.php/.js/.ts).
  // The loader accepts twenty-plus extensions, so a fabricated "Service.py:120"
  // or "Main.kt:88" survived untouched into the customer's report. Derive the
  // pattern from the shared extension list instead, so adding a language to the
  // loader cannot silently reopen this hole.
  out = out.replace(/\s*\(lines?\s+\d+[\u2013\-]?\d*\)/gi, '');
  out = out.replace(LINE_CITATION_REGEX, '$1');

  return out;
}

/**
 * Find the remediation table in the report and remove rows whose Finding
 * column matches any of the dropped titles. After removal, re-sort the
 * surviving rows by severity (CRITICAL > HIGH > MEDIUM > LOW > INFO) and
 * renumber the Priority column 1..N. This keeps the highest-severity items
 * at the top regardless of where the LLM originally placed them, which
 * matters because the verifier can drop any finding regardless of severity
 * and leave Dead Zones at Priority 1 by accident.
 *
 * Matching is fuzzy: we normalize whitespace and punctuation, then check
 * whether the dropped title appears as a substring in the row's Finding
 * cell (or vice versa). This handles cases where the narrator slightly
 * polished the title between the prose and the table.
 *
 * Severity for each row is looked up from the prose section that matches
 * the row's Finding cell. If a row's severity can't be resolved, it gets
 * sorted to the bottom (treated as INFO).
 *
 * The disclaimer count uses `totalDroppedCount` (the number of prose
 * sections the verifier removed), not the count of rows actually removed
 * from the table. This matters because the narrator sometimes renders
 * findings as prose without a corresponding table row (e.g. architectural
 * observations with Effort: N/A) — those still get verified and dropped
 * but show up only in prose. The user-facing disclaimer should reflect
 * the verifier's actual decision, not the table's bookkeeping.
 */
function stripDroppedRowsFromTable(report, droppedTitles, totalDroppedCount) {
  const lines = report.split('\n');
  const dropped = droppedTitles.map(t => normalizeForFuzzy(t)).filter(Boolean);

  // Locate the remediation table. Heuristics:
  //   - A header line containing "Priority" and "Finding" and "|" delimiters
  //   - Followed by a separator line of dashes
  //   - Followed by zero or more data rows starting with "|"
  let headerIdx = -1;
  let separatorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) continue;
    if (!/Priority/i.test(l) || !/Finding/i.test(l)) continue;
    // Next non-blank line should be the separator
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j < lines.length && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[j])) {
      headerIdx = i;
      separatorIdx = j;
      break;
    }
  }
  if (headerIdx < 0 || separatorIdx < 0) return report;

  // Collect data rows: from separatorIdx+1 until first non-pipe line
  const dataStart = separatorIdx + 1;
  let dataEnd = dataStart;
  while (dataEnd < lines.length && /^\s*\|/.test(lines[dataEnd])) dataEnd++;

  // Build a lookup: normalized finding title -> severity, parsed from the
  // prose above the table. We'll use this to sort surviving rows by severity
  // before renumbering. If a finding's severity can't be resolved we fall
  // back to INFO so it sorts to the bottom.
  const proseAboveTable = lines.slice(0, headerIdx).join('\n');
  const severityByTitle = buildSeverityLookup(proseAboveTable);

  const kept = [];
  let removedCount = 0;
  for (let i = dataStart; i < dataEnd; i++) {
    const row = lines[i];
    const cells = row.split('|').map(c => c.trim());
    // Expected shape: ["", priority, finding, category, effort, complexity, cost, ""]
    // The Finding column is index 2 (after the leading empty from leading "|").
    const findingCell = cells[2] || '';
    const findingNorm = normalizeForFuzzy(findingCell);
    if (!findingNorm) {
      kept.push(row);
      continue;
    }
    const isDropped = dropped.some(d =>
         findingNorm === d
      || (findingNorm.includes(d) && d.length > 10)
      || (d.includes(findingNorm) && findingNorm.length > 10)
    );
    if (isDropped) {
      removedCount++;
      continue;
    }
    kept.push(row);
  }

  if (removedCount === 0) return report;

  // Re-sort surviving rows by severity (CRITICAL first, INFO last). This
  // correction matters because the LLM-built table is ordered by priority
  // assigned at synthesis time, and the verifier can drop any finding —
  // so a Dead Zone (LOW) can end up at Priority 1 if all the Criticals
  // above it were dropped. After sorting, Priority is renumbered 1..N
  // matching the new order.
  const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4, BLOCKING: 0 };
  const sortedSurvivors = [...kept].sort((a, b) => {
    const cellsA = a.split('|').map(c => c.trim());
    const cellsB = b.split('|').map(c => c.trim());
    const titleA = normalizeForFuzzy(cellsA[2] || '');
    const titleB = normalizeForFuzzy(cellsB[2] || '');
    const sevA = severityByTitle.get(titleA) || 'INFO';
    const sevB = severityByTitle.get(titleB) || 'INFO';
    const rankA = SEVERITY_RANK[sevA] ?? 99;
    const rankB = SEVERITY_RANK[sevB] ?? 99;
    return rankA - rankB;
  });

  // Renumber the Priority column on surviving rows so it remains 1..N.
  const renumbered = sortedSurvivors.map((row, idx) => {
    const cells = row.split('|');
    if (cells.length < 3) return row;
    // cells[0] is leading empty, cells[1] is priority
    cells[1] = ' ' + (idx + 1) + ' ';
    return cells.join('|');
  });

  // Splice the new data rows back in
  const before = lines.slice(0, dataStart);
  const after  = lines.slice(dataEnd);
  let result = [...before, ...renumbered, ...after].join('\n');

  // The totals lines below the table are now stale. Strip them — they say
  // "Total findings = N" with the pre-drop N — and replace with a small
  // disclaimer. We don't try to recompute the dollar total because the
  // remaining rows are still valid line items; an inaccurate total is
  // worse than no total.
  result = result.replace(
    /^\*\*Total findings:\*\*\s*\d+/m,
    '**Total findings:** ' + renumbered.length
  );
  result = result.replace(
    /^Total findings\s*=\s*\d+/m,
    'Total findings = ' + renumbered.length
  );
  // Append a verifier note so the user knows the totals reflect post-verification counts.
  // Use totalDroppedCount (verifier's actual drop count) instead of removedCount
  // (table rows actually removed) because some findings are rendered in prose without
  // table rows (e.g. architectural observations with N/A cost). The disclaimer should
  // reflect what the verifier actually did, not bookkeeping artifacts.
  const disclaimerCount = (typeof totalDroppedCount === 'number' && totalDroppedCount > 0)
    ? totalDroppedCount
    : removedCount;
  if (!/_Verifier dropped/.test(result)) {
    const noteAnchor = result.indexOf('## Risk');
    const note = '\n\n_Verifier dropped ' + disclaimerCount + ' finding' + (disclaimerCount === 1 ? '' : 's') + ' as not supported by the source code. The remediation table above reflects the verified set, sorted by severity._\n';
    if (noteAnchor > 0) {
      result = result.slice(0, noteAnchor) + note + '\n' + result.slice(noteAnchor);
    } else {
      result = result + note;
    }
  }

  return result;
}

/**
 * Walk the prose above the remediation table and build a Map of
 * normalized finding title → severity. Used by stripDroppedRowsFromTable
 * to sort surviving rows by severity after the verifier has dropped some.
 *
 * The prose format is consistent: each finding has a `### Title` header
 * followed (within a few lines) by `**Severity:** CRITICAL` (or HIGH/MEDIUM/LOW).
 * We pair them by walking forward from each ### header until we find the
 * Severity line or hit the next ### header.
 *
 * Severity-line parsing strategy: many narrator outputs include a colored
 * emoji and nested asterisks (e.g. `**Severity:** 🟠 **HIGH**`). Rather than
 * write one regex that handles every formatting permutation, we strip
 * markdown emphasis and emoji from the line first, then look for the
 * keyword. This is more permissive and easier to reason about than the
 * earlier inline regex, which was failing silently on common variants and
 * letting all findings fall back to INFO.
 */
function buildSeverityLookup(prose) {
  const map = new Map();
  if (!prose) return map;

  const SEVERITY_KEYWORDS = ['CRITICAL', 'BLOCKING', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

  const lines = prose.split('\n');
  let currentTitle = null;
  for (const raw of lines) {
    const line = raw.trim();

    // New finding header — capture the normalized title, reset
    const headingMatch = line.match(/^###\s+(?:\d+\.\s+)?\*?\*?(.+?)\*?\*?$/);
    if (headingMatch) {
      // Strip leading [⚠ UNVERIFIED] etc. that the verifier may have added
      const cleaned = headingMatch[1].replace(/^\[[^\]]*\]\s*/, '').trim();
      currentTitle = normalizeForFuzzy(cleaned);
      continue;
    }

    // Severity line — only first one wins per finding. Detect by checking
    // whether the line starts with "Severity" (after stripping markdown
    // emphasis), then look for a known severity keyword anywhere in the
    // remainder. Stripping asterisks and emoji up front means we don't have
    // to enumerate every formatting permutation in a single regex.
    if (currentTitle && !map.has(currentTitle)) {
      const stripped = line
        .replace(/\*+/g, '')                        // remove all asterisks
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')     // remove emoji
        .replace(/\s+/g, ' ')                       // collapse whitespace
        .trim();
      // Match "Severity: <word>" or "Severity <word>" (loose).
      const sevHeader = stripped.match(/^[Ss]everity\s*:?\s*(.+)$/);
      if (sevHeader) {
        const remainder = sevHeader[1].toUpperCase();
        for (const kw of SEVERITY_KEYWORDS) {
          if (remainder.includes(kw)) {
            map.set(currentTitle, kw);
            break;
          }
        }
      }
    }
  }
  return map;
}

function normalizeForFuzzy(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    totalFindings:       0,
    verified:            0,
    unverified:          0,
    disputed:            0,
    falsePositives:      0,
    verifierUnavailable: 0,
    details:             [],
    note,
  };
}

/**
 * Human-readable summary of the verifier's report card — for CLI display.
 */
export function formatVerifierReport(report) {
  if (!report) return '';
  // BOTH false_positive and disputed findings are removed from the report body
  // (see applyAnnotations' isDropped). Reporting only falsePositives meant the
  // numbers never added up: 10 findings shown as "6 grounded, 1 unverified,
  // 1 dropped" left 2 disputed findings silently unaccounted for. Sum the two
  // drop reasons into one honest count so verified + unverified + dropped
  // always equals totalFindings.
  const dropped = (report.falsePositives || 0) + (report.disputed || 0);
  const lines = [
    `  Verification: ${report.verified}/${report.totalFindings} grounded` +
      (report.unverified > 0 ? `, ${report.unverified} unverified` : '') +
      (dropped           > 0 ? `, ${dropped} low-confidence dropped` : '') +
      (report.verifierUnavailable > 0 ? `, ${report.verifierUnavailable} could not be verified` : '') +
      (report.note ? `. ${report.note}` : ''),
  ];
  return lines.join('\n');
}
