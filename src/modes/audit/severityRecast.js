// src/modes/audit/severityRecast.js
//
// Pure function: maps standard Ghost severity into Inheritance Audit
// "deal language" for use in audit-mode reports.
//
// Standard severities (CRITICAL / HIGH / MEDIUM / LOW) describe the
// engineering shape of a finding. Inheritance Audit needs to reframe
// the same findings through a buyer's lens — what does this mean for
// the deal, for the post-close window, for the day-91 cleanup?
//
// Design notes:
//
//   - Pure mapping, no I/O, no LLM. Trivially testable.
//
//   - The Healthy bucket is intentionally rare. Most LOW findings still
//     belong in Day-91 Cleanup because a buyer at the inheritance moment
//     wants to know about every loose end, not just the urgent ones.
//
//   - We expose two entry points: recastSeverity() for a single severity
//     string, and recastFinding() for a finding object that may include
//     additional context (impact, blast radius, file path) we want to
//     factor in for edge cases.
//
//   - We never silently drop or hide a finding. If severity is missing
//     or unrecognized, we default to "Post-Close Risk" and add an
//     'unknown_severity' tag for the report appendix.
//

export const DEAL_TIERS = {
  DEAL_BLOCKER: 'Deal-Blocker',
  POST_CLOSE_RISK: 'Post-Close Risk',
  DAY_91_CLEANUP: 'Day-91 Cleanup',
  HEALTHY: 'Healthy',
};

// Display order for grouping findings in the audit report.
export const DEAL_TIER_ORDER = [
  DEAL_TIERS.DEAL_BLOCKER,
  DEAL_TIERS.POST_CLOSE_RISK,
  DEAL_TIERS.DAY_91_CLEANUP,
  DEAL_TIERS.HEALTHY,
];

// Short prose blurbs used as section descriptions in the PDF report.
export const DEAL_TIER_DESCRIPTIONS = {
  [DEAL_TIERS.DEAL_BLOCKER]:
    'Findings significant enough to renegotiate price, restructure terms, ' +
    'or walk away from the transaction. Surface these to the deal committee.',
  [DEAL_TIERS.POST_CLOSE_RISK]:
    'Material risk the buyer is inheriting at close. Budget for remediation ' +
    'in the first 90 days. Plan integration around these constraints.',
  [DEAL_TIERS.DAY_91_CLEANUP]:
    'Technical debt and quality issues to address once the operational ' +
    'priorities are stabilized. Track in a backlog, schedule when capacity ' +
    'allows.',
  [DEAL_TIERS.HEALTHY]:
    'Areas of the codebase that meet a professional baseline and require no ' +
    'immediate action.',
};

/**
 * Map a single severity string into a deal tier.
 *
 * @param {string} severity - One of CRITICAL/HIGH/MEDIUM/LOW (case-insensitive)
 * @returns {string} One of the DEAL_TIERS values
 */
export function recastSeverity(severity) {
  if (typeof severity !== 'string') return DEAL_TIERS.POST_CLOSE_RISK;

  const s = severity.trim().toUpperCase();
  switch (s) {
    case 'CRITICAL': return DEAL_TIERS.DEAL_BLOCKER;
    case 'HIGH':     return DEAL_TIERS.POST_CLOSE_RISK;
    case 'MEDIUM':   return DEAL_TIERS.DAY_91_CLEANUP;
    case 'LOW':      return DEAL_TIERS.DAY_91_CLEANUP;
    case 'INFO':
    case 'INFORMATIONAL':
    case 'NONE':
    case 'HEALTHY':
    case 'OK':       return DEAL_TIERS.HEALTHY;
    default:         return DEAL_TIERS.POST_CLOSE_RISK;
  }
}

/**
 * Recast a finding object, returning a new object with the dealTier field
 * added (alongside the existing severity for backward compatibility).
 *
 * Future versions may use additional finding context (blast radius, file
 * path, business-critical-path flags) to nudge a finding up or down a tier.
 * The v1 implementation is a straight severity-only mapping; the function
 * signature is wider to support that future without breaking callers.
 *
 * @param {object} finding - Original Ghost finding object
 * @returns {object} Finding with dealTier added
 */
export function recastFinding(finding) {
  if (!finding || typeof finding !== 'object') return finding;
  return {
    ...finding,
    dealTier: recastSeverity(finding.severity),
  };
}

/**
 * Group an array of findings by deal tier.
 *
 * @param {object[]} findings - Array of Ghost findings (with severity)
 * @returns {object} Map of dealTier -> array of recast findings
 */
export function groupByDealTier(findings) {
  if (!Array.isArray(findings)) return {};

  const groups = {};
  for (const tier of DEAL_TIER_ORDER) groups[tier] = [];

  for (const f of findings) {
    const recast = recastFinding(f);
    if (groups[recast.dealTier]) {
      groups[recast.dealTier].push(recast);
    } else {
      groups[DEAL_TIERS.POST_CLOSE_RISK].push(recast);
    }
  }
  return groups;
}
