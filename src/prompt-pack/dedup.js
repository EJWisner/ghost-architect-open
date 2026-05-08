/**
 * src/prompt-pack/dedup.js
 *
 * Detector overlap dedup pass for Prompt Triage.
 *
 * THE PROBLEM
 *
 * Each Tier 2 detector's prompt is written defensively, telling the
 * LLM "do not flag X — that's another detector's job" with explicit
 * trip-wires (e.g., "if your finding uses the words 'conflicting',
 * 'contradictory', 'cannot both be satisfied', drop it"). But the
 * LLM doesn't reliably honor those trip-wires. The May 7 smoke run
 * on /tmp/ghost-prompt-smoke-rich/02-conflicting-instructions.md
 * produced 19 findings on 3 underlying defects:
 *
 *   - 6 detectors each flagged the length conflict (be brief vs be
 *     comprehensive)
 *   - 7 detectors each flagged the format conflict (JSON vs plain text)
 *   - 6 detectors each flagged the disclosure conflict (never reveal
 *     vs always disclose)
 *
 * 19 findings on 3 defects is 6:1 noise. Users glaze over.
 *
 * THE FIX
 *
 * The taxonomy IS already documented in each detector source file
 * (see "What this detector is NOT for" sections). This module pulls
 * that documented taxonomy into a structured specificity ranking and
 * enforces it at the orchestration layer instead of trusting the
 * LLM to do it.
 *
 * Detectors are categorized into three groups:
 *
 *   SPECIFIC — narrowly-scoped detectors that win on overlap.
 *     conflictingInstructions, undefinedOutputFormat, unboundedOutput,
 *     injectionStaticPattern, inefficientFewShot,
 *     tokenLimitContextOverflow, tokenLimitExcessive.
 *
 *   GENERAL — broadly-scoped detectors that get suppressed when a
 *     SPECIFIC fires on the same range.
 *     ambiguousInstruction, underspecifiedConstraints,
 *     overloadedPrompt, poorOrganization, poorDocumentation.
 *
 *   ORTHOGONAL — detectors that catch fundamentally different concerns
 *     (markup, byte counts, role hygiene). Never suppressed.
 *     formatting, length, roleSeparation.
 *
 * THE ALGORITHM
 *
 *   1. Group findings by overlapping location.
 *   2. Within each group: if any SPECIFIC detector fired, drop all
 *      GENERAL detectors. Keep all SPECIFIC and ORTHOGONAL.
 *   3. If only GENERAL detectors fired in a group, keep highest-
 *      specificity (or all of them if there's no clear winner — they
 *      may all be valid signals).
 *   4. ORTHOGONAL detectors are never grouped or suppressed.
 *   5. Annotate kept findings with `(also flagged by: X, Y)` metadata
 *      so cross-detector signal isn't lost — users can still see
 *      which detectors agreed.
 *
 * LOCATION OVERLAP HEURISTICS
 *
 * Detector findings reference locations in many shapes:
 *   - "lines 1-2" / "Lines 3 and 4" / "L5"
 *   - "first and second sentences" / "fifth and sixth instructions"
 *   - "third instruction" / "entire prompt"
 *   - location: { line: N, column: C } (Tier 1 detectors)
 *   - location: { hint: "third instruction" } (Tier 2 detectors)
 *   - location: null
 *
 * The normalizeLocation function extracts a comparable line range
 * (or sentence index range) from any of these shapes. Two findings
 * "overlap" when their normalized ranges intersect, OR when one is
 * "entire prompt" and the other isn't (whole-prompt findings overlap
 * everything).
 */

// Detectors that win on overlap. Each fires on a specific, narrowly-
// scoped defect that is documented in detail in its source file.
// When one of these fires on a location range, GENERAL detectors that
// fire on the same range are suppressed.
const SPECIFIC_DETECTORS = new Set([
  'conflictingInstructions',
  'undefinedOutputFormat',
  'unboundedOutput',
  'injectionStaticPattern',
  'injection/static-pattern',  // legacy detector ID format
  'inefficientFewShot',
  'tokenLimitContextOverflow',
  'tokenLimitExcessive',
]);

// Detectors that get suppressed when a SPECIFIC detector fires on the
// same range. These detectors cover broad categories that frequently
// overlap with the more-specific defects above. The specificity rank
// (lower number = more specific, wins on overlap among GENERAL group).
const GENERAL_DETECTORS = new Map([
  ['ambiguousInstruction',      1],  // Single-instruction multiple readings
  ['underspecifiedConstraints', 2],  // Rating scales without rubrics
  ['overloadedPrompt',          3],  // Too many tasks at once
  ['poorOrganization',          4],  // Bad arrangement
  ['poorDocumentation',         5],  // Missing rationale
]);

// Detectors that never overlap with the others — they catch a
// fundamentally different concern (markup syntax, byte/token counts,
// system/user role hygiene). Never grouped, never suppressed.
const ORTHOGONAL_DETECTORS = new Set([
  'formatting',
  'length',
  'roleSeparation',
]);

/**
 * Classify a detector ID into one of three groups: 'specific',
 * 'general', 'orthogonal'. Returns 'unknown' for IDs we don't
 * recognize (defensive — unknown detectors are treated as orthogonal
 * so they never get suppressed).
 */
function classifyDetector(detectorId) {
  // Strip any trailing "/internal-error" suffix used for crash findings.
  const baseId = (detectorId || '').split('/')[0];
  // Some detectors ship with an explicit "/static-pattern" suffix —
  // check the full ID first, then the base.
  if (SPECIFIC_DETECTORS.has(detectorId) || SPECIFIC_DETECTORS.has(baseId)) {
    return 'specific';
  }
  if (GENERAL_DETECTORS.has(baseId)) {
    return 'general';
  }
  if (ORTHOGONAL_DETECTORS.has(baseId)) {
    return 'orthogonal';
  }
  // Unknown → treat as orthogonal (safer to keep than to drop).
  return 'orthogonal';
}

/**
 * Convert an English ordinal word ("first", "second", ..., "tenth")
 * to its 1-indexed integer. Returns null for unknown inputs.
 *
 * Used to normalize Tier 2 LLM-emitted location hints like "first and
 * second sentences" into integer ranges for comparison.
 */
function ordinalToInt(word) {
  const map = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  };
  return map[String(word || '').toLowerCase()] || null;
}

/**
 * Normalize a finding's location into a comparable structure:
 *
 *   { kind: 'range', start: N, end: M }       — discrete line/sentence range
 *   { kind: 'whole', start: 0, end: Infinity } — applies to entire prompt
 *   { kind: 'unknown' }                        — couldn't extract a range
 *
 * The range numbers are sentence/line/instruction ordinals — the
 * dedup logic only cares about whether two ranges INTERSECT, not
 * which dimension they're measured in. Findings that disagree on
 * dimension (one says "line 3", another says "third sentence") are
 * unlikely to actually overlap because the LLM tends to pick one
 * anchoring shape per prompt and stick with it.
 *
 * Falls back to scanning the title + detail text when the structured
 * `location` field is missing or unhelpful, since Tier 2 LLM findings
 * often put the location in the title (e.g., "Conflicting length
 * directives" with location.hint = "first and second sentences").
 */
function normalizeLocation(finding) {
  const loc = finding.location;
  const title = String(finding.title || '');
  const detail = String(finding.detail || '');
  const haystack = [
    typeof loc === 'object' && loc !== null && loc.hint ? loc.hint : '',
    title,
    detail,
  ].join(' ');

  // Whole-prompt findings: phrases like "entire prompt", "the prompt
  // as a whole", "throughout the prompt" mean this finding overlaps
  // with everything.
  if (/\b(entire|whole|overall|throughout)\s+(?:the\s+)?prompt\b/i.test(haystack)) {
    return { kind: 'whole', start: 0, end: Infinity };
  }

  // Structured line+column from Tier 1 detectors.
  if (loc && typeof loc.line === 'number') {
    return { kind: 'range', start: loc.line, end: loc.line };
  }

  // "L5" / "line 5" / "lines 1-2" / "lines 1 and 2" / "Lines 3 and 4"
  // Also matches "sentences 1 and 2" / "instructions 3 and 4" /
  // "directives 5 and 6" since Tier 2 LLM detectors emit any of these
  // noun forms. Anchored to word boundary so "lines" isn't matched
  // mid-word.
  const lineRangeM = haystack.match(/\bL(\d+)(?:[-–](\d+))?\b/i)
                  || haystack.match(/\b(?:lines?|sentences?|instructions?|directives?)\s+(\d+)\s*(?:[-–]|and|to|,)\s*(\d+)\b/i)
                  || haystack.match(/\b(?:lines?|sentences?|instructions?|directives?)\s+(\d+)\b/i);
  if (lineRangeM) {
    const start = parseInt(lineRangeM[1], 10);
    const end   = lineRangeM[2] ? parseInt(lineRangeM[2], 10) : start;
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return { kind: 'range', start: Math.min(start, end), end: Math.max(start, end) };
    }
  }

  // "first two sentences" / "first three instructions" — count-based
  // shorthand. "first N" maps to range [1, N]. Tier 2 LLM detectors
  // sometimes emit this shape instead of "first and second".
  const firstNM = haystack.match(
    /\bfirst\s+(two|three|four|five|six|seven|eight|nine|ten)\s+(?:sentences?|instructions?|lines?|directives?)\b/i
  );
  if (firstNM) {
    const numWord = firstNM[1].toLowerCase();
    const numWordToInt = {
      two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    };
    const n = numWordToInt[numWord];
    if (n) return { kind: 'range', start: 1, end: n };
  }

  // Ordinal word ranges: "first and second sentences", "third and
  // fourth instructions", "fifth and sixth lines"
  const ordinalRangeM = haystack.match(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+and\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:sentences?|instructions?|lines?|directives?)\b/i
  );
  if (ordinalRangeM) {
    const a = ordinalToInt(ordinalRangeM[1]);
    const b = ordinalToInt(ordinalRangeM[2]);
    if (a && b) {
      return { kind: 'range', start: Math.min(a, b), end: Math.max(a, b) };
    }
  }

  // Single ordinal: "third instruction", "fifth sentence"
  const singleOrdinalM = haystack.match(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:sentences?|instructions?|lines?|directives?)\b/i
  );
  if (singleOrdinalM) {
    const n = ordinalToInt(singleOrdinalM[1]);
    if (n) return { kind: 'range', start: n, end: n };
  }

  return { kind: 'unknown' };
}

/**
 * Return true if two normalized locations overlap.
 *
 * Two ranges overlap if they intersect numerically. A 'whole'-prompt
 * location overlaps with anything that has a known range. 'unknown'
 * locations don't overlap with anything (we err on the side of
 * keeping findings rather than incorrectly grouping them).
 */
export function locationsOverlap(a, b) {
  if (!a || !b) return false;
  if (a.kind === 'unknown' || b.kind === 'unknown') return false;
  if (a.kind === 'whole' || b.kind === 'whole') return true;
  // Both 'range': numeric intersection.
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Group findings whose locations overlap. Returns an array of
 * arrays — each inner array is a cluster of findings that all
 * overlap (transitively) with each other.
 *
 * ORTHOGONAL detectors are excluded from grouping — they're returned
 * as singleton clusters so they're never affected by suppression
 * logic downstream.
 */
function groupByLocation(findings) {
  const orthogonal = [];
  const groupable = [];

  for (const f of findings) {
    const klass = classifyDetector(f.detector);
    if (klass === 'orthogonal') {
      orthogonal.push(f);
    } else {
      groupable.push({ finding: f, loc: normalizeLocation(f), classification: klass });
    }
  }

  // Cluster groupable findings by transitive location overlap.
  const clusters = [];
  const used = new Set();

  for (let i = 0; i < groupable.length; i++) {
    if (used.has(i)) continue;
    const cluster = [groupable[i]];
    used.add(i);
    // Transitively grow: any other groupable that overlaps with any
    // current cluster member joins. Loop until stable.
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < groupable.length; j++) {
        if (used.has(j)) continue;
        for (const member of cluster) {
          if (locationsOverlap(member.loc, groupable[j].loc)) {
            cluster.push(groupable[j]);
            used.add(j);
            grew = true;
            break;
          }
        }
      }
    }
    clusters.push(cluster);
  }

  // Add orthogonal findings as singleton clusters.
  for (const f of orthogonal) {
    clusters.push([{ finding: f, loc: { kind: 'orthogonal' }, classification: 'orthogonal' }]);
  }

  return clusters;
}

/**
 * Within a cluster of overlapping findings, pick the keepers and
 * mark the rest as suppressed.
 *
 * Rules:
 *   - If the cluster contains any SPECIFIC findings, keep ALL specific
 *     and orthogonal findings; suppress all general findings.
 *   - If the cluster contains only GENERAL findings, keep the
 *     highest-specificity general finding (lowest specificity rank).
 *     Suppress the rest.
 *   - ORTHOGONAL findings are always kept (they're already in their
 *     own singleton clusters from groupByLocation, but defensive).
 *
 * Returns { keepers: [...], suppressed: [...] } where each keeper
 * has an `alsoFlaggedBy` array of detector IDs that fired on the
 * same range and were suppressed.
 */
function selectKeepers(cluster) {
  const specifics   = cluster.filter(c => c.classification === 'specific');
  const generals    = cluster.filter(c => c.classification === 'general');
  const orthogonals = cluster.filter(c => c.classification === 'orthogonal');

  let keepers   = [];
  let suppressed = [];

  if (specifics.length > 0) {
    // SPECIFIC fires → keep all specifics + orthogonals, drop generals.
    keepers   = [...specifics, ...orthogonals];
    suppressed = generals;
  } else if (generals.length > 0) {
    // Only GENERAL fired → keep highest-specificity (lowest rank).
    const sorted = [...generals].sort((a, b) => {
      const ra = GENERAL_DETECTORS.get(a.finding.detector) || 99;
      const rb = GENERAL_DETECTORS.get(b.finding.detector) || 99;
      return ra - rb;
    });
    keepers   = [sorted[0], ...orthogonals];
    suppressed = sorted.slice(1);
  } else {
    keepers = orthogonals;
  }

  // Annotate keepers with the list of suppressed detector IDs that
  // fired on the same range. This preserves cross-detector signal
  // without polluting the report with duplicate findings.
  const suppressedDetectorIds = [...new Set(suppressed.map(s => s.finding.detector))];

  return {
    keepers: keepers.map(k => ({
      ...k.finding,
      alsoFlaggedBy: suppressedDetectorIds.length > 0 ? suppressedDetectorIds : undefined,
    })),
    suppressed: suppressed.map(s => s.finding),
  };
}

/**
 * Public API: dedup a flat array of findings by enforcing the
 * documented detector taxonomy.
 *
 * Returns { findings, suppressedCount } where:
 *   - findings: the deduped list with alsoFlaggedBy annotations
 *   - suppressedCount: total findings dropped (for telemetry/stats)
 *
 * Pure function. No I/O. Safe to call any time.
 */
export function dedupFindings(allFindings) {
  if (!Array.isArray(allFindings) || allFindings.length === 0) {
    return { findings: [], suppressedCount: 0 };
  }

  // Group findings by file first — we never want to dedup findings
  // across different prompt files even if their locations overlap
  // numerically.
  const byFile = new Map();
  for (const f of allFindings) {
    const key = f.file || '__no_file__';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(f);
  }

  const keepers = [];
  let suppressedTotal = 0;

  for (const [, fileFindings] of byFile) {
    const clusters = groupByLocation(fileFindings);
    for (const cluster of clusters) {
      const { keepers: clusterKeepers, suppressed } = selectKeepers(cluster);
      keepers.push(...clusterKeepers);
      suppressedTotal += suppressed.length;
    }
  }

  return { findings: keepers, suppressedCount: suppressedTotal };
}

// ── Exports for testing ──────────────────────────────────────────────────

export {
  classifyDetector,
  normalizeLocation,
  groupByLocation,
  selectKeepers,
  ordinalToInt,
  SPECIFIC_DETECTORS,
  GENERAL_DETECTORS,
  ORTHOGONAL_DETECTORS,
};
