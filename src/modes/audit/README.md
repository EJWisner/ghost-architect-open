# Inheritance Audit Mode

Deal-grade codebase audit, sibling to the standard Ghost Architect modes
(Chat / POI / Blast / Conflict / Recon / Prompt Triage). Purpose-built
for the inheritance moment: an agency taking over a client codebase, a PE
diligence team scoping a target, a fractional CTO walking into a new
engagement, a modernization consultancy scoping a rebuild.

This is the v5.4.0 anchor feature.

## What makes Inheritance Audit different from POI

POI ("Points of Interest") is a triage tool for engineers. Output is a
list of findings keyed off engineering severity (CRITICAL / HIGH / MEDIUM
/ LOW) and intended for the team that owns the code.

Inheritance Audit is a deal tool for buyers and consultants. Output is a
deal-grade PDF organized by acquisition impact (Deal-Blocker / Post-Close
Risk / Day-91 Cleanup / Healthy) and intended for the decision-maker
who's deciding whether to write the check.

Same scan engine. Different lens. Different presentation.

## Architecture

```
src/modes/audit/
├── index.js              Mode entry point — orchestrates analyzers
├── stackReality.js       Analyzer 1: declared stack vs actual stack
├── keyPersonRisk.js      Analyzer 2: author concentration from git log
├── dependencyMap.js      Analyzer 3: third-party libs, licenses, EOL
├── roadmapStub.js        Analyzer 4: LLM synthesis (stabilize vs rebuild)
└── severityRecast.js     Pure mapping: severity → deal tier
```

Each analyzer is independent. The first three are deterministic (no LLM).
The fourth synthesizes the first three plus the existing POI findings
into prose recommendations via a single LLM call.

## Severity recast

`severityRecast.js` exports the deal-language mapping that every analyzer
and the PDF template draws from:

| Engineering Severity | Deal Tier         | What it means to a buyer       |
|----------------------|-------------------|--------------------------------|
| CRITICAL             | Deal-Blocker      | Renegotiate or walk away       |
| HIGH                 | Post-Close Risk   | Budget remediation for 90 days |
| MEDIUM               | Day-91 Cleanup    | Backlog after stabilization    |
| LOW                  | Day-91 Cleanup    | Loose end worth knowing about  |
| INFO / OK            | Healthy           | No action required             |

Pure function. No LLM, no I/O. Trivially testable.

## v1 scope decisions

These were deliberately scoped OUT of the v1 build:

- **CVE scanning** — Deferred to v1.1. Will use OSV.dev free API.
- **Transitive dependency walking** — Direct deps only in v1.
- **License compatibility analysis** — Just license type in v1.
- **Dollar figures in rebuild scope** — Never. False precision and legal exposure.
- **Author de-anonymization** — Author emails hashed in all output.

These were deliberately scoped IN for v1:

- **Stack reality** (file census + manifest parsing, no LLM)
- **Key-person risk** (git log parsing, no LLM)
- **Hidden dependency map** (license + EOL flags, no LLM)
- **Modernization roadmap stub** (single LLM call over the three above)
- **Severity recast** (pure function, no LLM)
- **Deal-grade PDF template** (separate file: src/report/templates/audit-pdf.js)

## Current implementation status

v0.1.0 — all four analyzers are stubbed. The mode is wired into ghost.js
and reachable via the menu. Running it produces a banner, invokes the
stubs in sequence (which each return `{ _stub: true }`), and reports
completion. Enough to validate the contract before shipping real logic.

## Build sequence

- ✓ Day 1: Scaffolding, severityRecast.js, four analyzer stubs, index.js, bin/ghost.js wiring, version bump
- Day 2: Real implementation of stackReality.js + keyPersonRisk.js
- Day 3: Real implementation of dependencyMap.js + roadmapStub.js
- Day 4: Deal-grade PDF template (src/report/templates/audit-pdf.js)
- Day 5: End-to-end testing on 3 sample repos, prompt iteration

## Tier gating

During development, no licensing enforcement. The audit-mode branch is
manually gated by TIER constant in bin/ghost.js — only pro/team/enterprise
see the menu entry. Open users are blocked at the menu level. Real
licensing infrastructure (Ghost-native key format, hardware fingerprint,
UTC validation, kill switch) comes in the next sprint after audit-mode
ships.

## CLI surface (planned)

```
ghost                            # interactive — Audit Mode appears in mode menu
ghost --mode audit [path]        # direct invocation (NOT YET IMPLEMENTED)
ghost --inheritance-audit [path] # alias                  (NOT YET IMPLEMENTED)
```

The direct-invocation flags arrive in a later pass. v0.1.0 only supports
interactive invocation through the standard menu.

---

*Ghost Architect™ — Inheritance Audit Mode*  
*Part of Ghost Platform™*  
*© 2026 Ghost Architect. All rights reserved.*
