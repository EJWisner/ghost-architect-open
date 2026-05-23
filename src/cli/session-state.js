// src/cli/session-state.js
//
// In-memory session state for the ghost process lifetime. Reset on every
// ghost startup; persists for the duration of one invocation. No disk I/O.
//
// Currently houses:
//   - softGateShown: Set of gate IDs whose soft-gate callout has already
//     fired this session. Per D3 (locked 2026-05-23): hard gates show
//     paywall every time triggered; soft gates show a one-line "💡 Foo
//     available on Pro" callout exactly once per ghost invocation.
//
// Gate ID naming: aligned to TIER_POLICY keys ('feature:profiles',
// 'feature:project-tracking', etc.) per Q4 (2026-05-23). Single naming
// scheme across tier-gates + session-state — no two-namespace cognitive
// load when wiring soft-gate sites in Phase 2/3.
//
// Phase 1 ships the module but doesn't wire all call sites; the gate
// sites in mode files get adopted in Phase 2/3 as part of mode-file
// reconciliation. Having this module in place during Phase 1 means the
// callout pattern is ready when those edits land.

const softGateShown = new Set();

/**
 * Has the soft-gate callout for this gate ID already fired this session?
 *
 * @param {string} gateId  e.g. 'feature:profiles'
 * @returns {boolean}
 */
export function hasShownCallout(gateId) {
  return softGateShown.has(gateId);
}

/**
 * Mark a soft-gate callout as shown so subsequent invocations of the
 * same gate in this session are suppressed (per D3).
 *
 * @param {string} gateId
 */
export function markCalloutShown(gateId) {
  softGateShown.add(gateId);
}

/**
 * Test helper. Clears the session-scoped callout tracking. Not exposed
 * in CLI flags — only callable from code (used by tests + by any future
 * --reconfigure flow that wants to reset mid-process state).
 */
export function _resetSessionState() {
  softGateShown.clear();
}
