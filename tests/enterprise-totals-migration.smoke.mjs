import assert from 'node:assert/strict';
import { applyAuditEvent } from '../src/core/enterprise.js';

// Regression test for the Enterprise totals migration bug (Audit 7, finding 3.1).
//
// v10.0.17 introduced a monotonic `totals` accumulator alongside the capped
// 1000-event window in org/audit.json, and getUsageReport PREFERS persisted
// totals once they exist. The original seeding read `c?.totals || {scans: 0}`,
// ignoring every event already sitting in a legacy (pre-totals) window. Net
// effect: an org with 800 scans in its window reported "1 scan" after the
// first post-upgrade scan.
//
// The fix seeds the accumulator by summing the existing window's scan events
// (same "$0.0014" string-cost coercion as the report) the first time a write
// touches a pre-totals file. This test drives the real applyAuditEvent state
// transition, not a simulation.

function legacyScanEvent(i) {
  return {
    type: 'scan',
    seatId: `seat-${i % 5}`,
    // Every third event uses the legacy $-string cost format to prove the
    // migration seed applies the same coercion as the live accumulator.
    cost: i % 3 === 0 ? '$0.0100' : 0.01,
    findingCount: 2,
    timestamp: new Date(2026, 0, 1).toISOString(),
  };
}

// ── Scenario 1: legacy file (no totals), 800 scan events in the window ──────
const legacy = {
  events: Array.from({ length: 800 }, (_, i) => legacyScanEvent(i)),
  // Deliberately NO totals key: this is a pre-v10.0.17 audit file.
};

// A non-scan event triggers the migration seed without adding to scan totals.
const afterLogin = applyAuditEvent(legacy, { type: 'seat-login', seatId: 'seat-9' });
assert.equal(afterLogin.totals.scans, 800,
  `Migration seed must count the 800 legacy window scans, got ${afterLogin.totals.scans}`);
assert.equal(afterLogin.totals.findings, 1600,
  `Migration seed must sum legacy findings (800 x 2), got ${afterLogin.totals.findings}`);
assert.ok(Math.abs(afterLogin.totals.cost - 8.0) < 1e-9,
  `Migration seed must coerce $-string costs (800 x $0.01 = $8.00), got ${afterLogin.totals.cost}`);

// ── Scenario 2: the first post-upgrade SCAN lands on top of the seed ────────
const afterScan = applyAuditEvent(legacy, {
  type: 'scan', seatId: 'seat-new', cost: '$0.0500', findingCount: 7,
});
assert.equal(afterScan.totals.scans, 801,
  `First post-upgrade scan must read 801 (800 seeded + 1), NOT 1. Got ${afterScan.totals.scans}`);
assert.equal(afterScan.totals.findings, 1607, 'Findings must accumulate on top of the seed');
assert.ok(Math.abs(afterScan.totals.cost - 8.05) < 1e-9,
  `Cost must accumulate on top of the seed with coercion, got ${afterScan.totals.cost}`);

// ── Scenario 3: once totals exist they are trusted, never re-seeded ─────────
// Totals may legitimately EXCEED the window sum (events aged out of the cap).
// Re-seeding from the window would destroy that history.
const migrated = {
  events: Array.from({ length: 10 }, (_, i) => legacyScanEvent(i)),
  totals: { scans: 5000, cost: 123.45, findings: 9000 },
};
const afterNext = applyAuditEvent(migrated, { type: 'scan', cost: 0.01, findingCount: 1 });
assert.equal(afterNext.totals.scans, 5001,
  'Existing totals must be advanced, not re-seeded from the smaller window');
assert.equal(afterNext.totals.findings, 9001, 'Existing findings total must be preserved');

// ── Scenario 4: totals survive window truncation at the 1000-event cap ──────
const nearCap = {
  events: Array.from({ length: 1000 }, (_, i) => legacyScanEvent(i)),
  totals: { scans: 1000, cost: 10.0, findings: 2000 },
};
const overCap = applyAuditEvent(nearCap, { type: 'scan', cost: 0.01, findingCount: 2 });
assert.equal(overCap.events.length, 1000, 'Window must stay capped at 1000');
assert.equal(overCap.totals.scans, 1001,
  'Totals must exceed the truncated window count (that is their whole purpose)');

// ── Scenario 5: brand-new org file (no events, no totals) starts clean ──────
const fresh = applyAuditEvent(null, { type: 'scan', cost: 0.02, findingCount: 3 });
assert.equal(fresh.totals.scans, 1, 'Fresh org file starts at 1 after the first scan');
assert.equal(fresh.events.length, 1, 'Fresh org file carries the one event');

console.log('enterprise totals migration: PASS');
console.log('  legacy 800-event window seeds totals at 800, first scan reads 801 (not 1)');
console.log('  existing totals trusted over window; cap truncation does not regress totals');
