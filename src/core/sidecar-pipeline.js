// src/core/sidecar-pipeline.js
//
// The post-verification findings-sidecar pipeline, shared by every scan path
// that narrates a capped report:
//
//   split at the narrator's cap → verify the undetailed remainder → dedupe →
//   rewrite the cap disclosure with the TRUE sidecar count → hand the full
//   verified set to the caller for meta.findings.
//
// Why shared: v10.0.17 built this pipeline inside multipass synthesizeFinal
// only, which left the single-pass POI and Blast paths shipping the exact
// defect the pipeline exists to kill — a report promising "All N findings are
// in .findings.json" over a sidecar holding at most the ~30 narrated ones
// (Audit 7, finding 3.4). One module, three consumers, no drift.

import { splitFindingsAtCap, rewriteCapDisclosure } from './agent/narrator.js';
import { verifyFindings, survivedVerification } from './verifier.js';
import { createLLMVerifier } from './llm-verifier.js';

// Titles are the only stable identity a finding carries across the raw-memory
// form and the narrated-then-reparsed form. Normalize the way the verifier's
// own fuzzy table matcher does: casefold, collapse whitespace, drop punctuation.
export function normalizeTitleForDedupe(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// First occurrence wins, so a detailed finding (which carries the narrator's
// effort and cost estimates) beats the raw-memory copy of the same finding.
//
// Matching is exact-normalized-title PLUS fuzzy containment: the narrator is
// explicitly allowed to polish titles ("or a polished version of it"), so a
// detailed "Hardcoded database credentials in config loader" and its raw twin
// "Hardcoded database credentials" must collapse to one entry. Containment
// only counts when the shorter title is longer than 10 characters, mirroring
// the verifier's fuzzy matcher, so short generic titles ("Dead code") cannot
// swallow unrelated findings.
export function dedupeFindingsByTitle(findings) {
  const seenKeys = [];
  const out = [];
  for (const f of findings) {
    const key = normalizeTitleForDedupe(f.title);
    if (!key) continue;
    const isDupe = seenKeys.some((seen) => {
      if (seen === key) return true;
      const shorter = seen.length <= key.length ? seen : key;
      const longer  = seen.length <= key.length ? key : seen;
      return shorter.length > 10 && longer.includes(shorter);
    });
    if (isDupe) continue;
    seenKeys.push(key);
    out.push(f);
  }
  return out;
}

/**
 * Verify the undetailed remainder of a capped finding set, merge with the
 * already-verified detailed survivors, and reconcile the report's cap
 * disclosure with the true sidecar count.
 *
 * @param {object} args
 * @param {object[]} args.allFindings      — the FULL raw finding set (pre-cap)
 * @param {object[]} args.detailedResults  — verifyReport's per-finding results
 *   for the rendered (detailed) findings; [] when no verification ran on them
 * @param {object}  args.fileMap           — source map for the remainder pass
 * @param {string}  args.reportText        — the narrated/annotated report
 * @param {string}  [args.debugLabel]
 * @returns {Promise<{ sidecarFindings: object[], reportText: string }>}
 */
export async function buildVerifiedSidecar({ allFindings, detailedResults, fileMap, reportText, debugLabel = 'undetailed-remainder' }) {
  const { undetailed, cap } = splitFindingsAtCap(allFindings);

  const detailedSurvivors = (detailedResults || [])
    .filter(survivedVerification)
    .map(r => ({ ...r.finding, detailed: true }));

  let undetailedSurvivors = [];
  if (undetailed.length > 0) {
    const { results: remainderResults } = await verifyFindings(
      undetailed,
      fileMap,
      { llmVerifier: createLLMVerifier(), debugLabel }
    );
    undetailedSurvivors = remainderResults
      .filter(survivedVerification)
      .map(r => ({
        ...r.finding,
        // These were never narrated, so the planner never estimated effort
        // for them. Report that honestly rather than defaulting to 0 hours,
        // which reads as "free to fix".
        effortHours: null,
        detailed: false,
      }));
  }

  // Dedupe by normalized title. The legacy narrator fallback path does not
  // apply the cap, so on that path the "undetailed" remainder can already be
  // present in the rendered report. Without this, those findings would appear
  // twice in the sidecar.
  const sidecarFindings = dedupeFindingsByTitle([...detailedSurvivors, ...undetailedSurvivors]);

  // The narrator rendered the disclosure before verification ran, so its
  // count was an upper bound. Restate it with the number that actually
  // reached the sidecar, or remove it if verification dropped enough
  // findings that the report is no longer capped.
  return {
    sidecarFindings,
    reportText: rewriteCapDisclosure(reportText, sidecarFindings.length, cap),
  };
}

/**
 * Fallback for when verification could not run at all (verifier threw, or no
 * fileMap exists). The honest sidecar is then the FULL unverified set: a
 * partial artifact beats a disclosure pointing at findings that exist nowhere
 * (Audit 7, finding 3.6). Findings above the cap keep their narrator
 * estimates; the remainder is marked undetailed with no effort claim. The
 * disclosure is rewritten to the set's real size so report and sidecar agree.
 *
 * Synchronous and network-free by design: this runs on failure paths.
 */
export function buildUnverifiedSidecar({ allFindings, reportText }) {
  const { detailed, undetailed, cap } = splitFindingsAtCap(allFindings);
  const sidecarFindings = dedupeFindingsByTitle([
    ...detailed.map(f => ({ ...f, detailed: true })),
    ...undetailed.map(f => ({ ...f, effortHours: null, detailed: false })),
  ]);
  return {
    sidecarFindings,
    reportText: rewriteCapDisclosure(reportText, sidecarFindings.length, cap),
  };
}
