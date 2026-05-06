# Prompt Triage — Followups

Living list of deferred work for the Prompt Triage detector pack on the
`prompt-triage` branch. Append as items surface; mark DONE / DEFERRED
inline rather than deleting (preserves the audit trail).

Status legend: OPEN | DONE | DEFERRED

---

## Carried over from sessions 1–5 (pre-rail-fix)

### F-01 — C2 threshold re-tuning for length/excessive against tiktoken counts
**Status:** OPEN
**Source:** session 3 (tokenizer abstraction)
**Why:** Original LOW/MEDIUM/HIGH thresholds (3000/6000/12000 tokens) were
calibrated against the heuristic count. Real tiktoken counts may differ
by 5–15%. Worth a focused re-tune session against the dogfood corpus
once we have a wider sample.

### F-02 — Ghost prompt audit (separate session, not detector work)
**Status:** OPEN
**Source:** session 4–5 dogfood unboundedOutput findings; reinforced by
session 6 ambiguousInstruction findings
**Why:** The dogfood findings from output/unbounded and ambiguousInstruction
surface real questions about Ghost's POI/Blast/Conflict prompts. Treat as
prompt-quality work. Do NOT modify Ghost prompts during detector
development. See F-15 for the specific list of substantive Ghost
prompt fixes identified.

### F-03 — Bullet-list semantics false positive on unboundedOutput
**Status:** OPEN
**Source:** session 5
**Why:** Tier 1 output detector fires on every "List …" verb even when
the bullet list that follows defines the list. Tier 2 fix territory.

### F-04 — Constraint regex with intervening adjectives
**Status:** OPEN
**Source:** session 5
**Why:** "in 2-4 plain English steps" doesn't match the constraint anchor
because of "plain English" between the count and the noun. Tighten regex
or move to lookahead.

### F-05 — Instruction-override regex gap on injection
**Status:** OPEN
**Source:** session 5
**Why:** "ignore your safety rules" doesn't fire because the regex
requires "above/prior" between verb and noun. Add variants.

### F-06 — Few-shot suppression keyword gap
**Status:** OPEN
**Source:** session 5
**Why:** "typical conversation," "transcript:," "dialogue:" don't
suppress strayLineMarker findings even though they signal example
framing. Extend the suppression keyword list.

### F-07 — Open models in registry (Llama, Mistral, Qwen)
**Status:** OPEN
**Source:** session 3
**Why:** Currently only Anthropic, OpenAI, and Gemini are in the
model registry. Open-weight model entries would broaden detector
coverage without needing API integration (heuristic strategy is
fine for these).

### F-08 — Ghost-on-Ghost full POI/Blast/Conflict scan
**Status:** PARTIAL (defensive POI test done, full scan still pending)
**Source:** session 5
**Why:** Run the full prompt-triage on Ghost's own production prompts
(not just the snapshots in prompts-extracted/) to validate end-to-end
behavior against live code paths.

### F-09 — API call observability for long Claude audits
**Status:** OPEN
**Source:** session 6
**Why:** Tier 2 audits in the live CLI have no progress indicator.
Long batches (10+ prompts) feel hung. Add a per-detector or
per-prompt progress line.

---

## New from session 6 (rail-fix and Tier 2 verification)

### F-10 — Fixtures 22-24 unused in current smoke setup
**Status:** DONE (commit 9401916, session 6)
**Source:** session 6
**Resolution:** Moved fixtures 22-24 to tests/prompt-triage-corpus-tier2/
targeting claude-haiku-4-5 (cheap Claude). Smoke runner adds a third
folder gated by tier2Only flag, only scanned when SMOKE_TIER2=1.
Verified end-to-end: fixtures 22 (2 findings) and 23 (3 findings) fire
as designed; fixture 24 produces zero findings as the clear-control.

### F-11 — Tier 2 fail-open is too quiet during development
**Status:** OPEN
**Source:** session 6 (auth bug discovery)
**Why:** Silent zero-findings hid the auth bug for ~3 hours. Consider
surfacing API errors as synthetic LOW-severity findings or stderr
warnings in smoke mode. Production behavior (fail-open silent)
should remain unchanged for end users.

### F-12 — Detector should consolidate findings sharing a root cause
**Status:** OPEN
**Source:** session 6 review
**Priority:** HIGH (largest accuracy improvement available)
**Why:** ~40% of findings on dogfood are duplicates expressing one root
cause from multiple angles (Landmarks-vs-actionable, target-unspecified-
vs-pronoun-referent, etc.). Update the detector envelope to instruct:
"If two ambiguities trace to the same authorial mistake, emit one
finding that names both manifestations." This is the single biggest
tuning win available.

### F-13 — Recognize intentional-discretion framings
**Status:** OPEN
**Source:** session 6 review
**Why:** Phrases like "where appropriate," "if straightforward,"
"use your judgment" are deliberate model discretion, not author
error. Detector currently flags them as ambiguity. Add envelope
guidance to distinguish author-error softness from author-intent
softness.

### F-14 — Cap hint length at ~8 words
**Status:** OPEN
**Source:** session 6 review
**Why:** Some hints are 3 words ("second paragraph"), others are 15+
("Per-finding requirements (severity rating CRITICAL/HIGH/MEDIUM/LOW)
vs. Remediation Summary billing tiers (LOW/MEDIUM/HIGH)"). Add
schema constraint or envelope instruction to keep hints terse.

### F-15 — Cross-detector dedup at report layer
**Status:** OPEN
**Source:** session 6 review; reinforced session 6 underspecifiedConstraints ship
**Priority:** HIGH (now visible on every dogfood prompt with rating dimensions)
**Why:** Multiple detectors fire on the same underlying defect from different
angles. Concrete examples observed in session 6 with both Tier 2 detectors
active:
  - ambiguousInstruction's 'unbounded quantifier' findings overlap with
    unboundedOutput's line-level findings
  - ambiguousInstruction reads 'Risk level: LOW/MEDIUM/HIGH/CRITICAL' as
    'ambiguous categorization' while underspecifiedConstraints reads the
    same text as 'rubric missing' — both detectors fire, two findings per
    constraint defect
  - On fixture 25 (5 underspecified bucketed ratings), the test produces
    7 total findings: 4 from underspecifiedConstraints + 3 from
    ambiguousInstruction, all naming the same defects from different
    angles
This nearly doubles report length without doubling signal. As more Tier 2
detectors ship, the overlap will get worse. Solutions to consider:
  (a) Report-layer consolidation: when two detectors fire on overlapping
      location hints, merge into one finding with both detector tags.
  (b) Detector-level suppression: e.g. ambiguousInstruction skips when
      underspecifiedConstraints already fires on the same span.
  (c) Prompt envelope shaping: tell each Tier 2 detector to ignore
      defects that would be the responsibility of another named detector.
F-12 (consolidate findings within one detector) and F-15 (consolidate
across detectors) are different problems. F-15 is the larger ergonomic
problem now that we have N>1 Tier 2 detectors.

### F-16 — Reconsider MEDIUM severity cap on ambiguousInstruction
**Status:** OPEN
**Source:** session 6 review
**Why:** Several findings (POI severity-vs-complexity mapping, Blast
walk-each-one mismatch, Conflict consultant-checks-vs-format mismatch)
warrant HIGH. The cap was a defensive choice for a brand-new Tier 2
detector. Lift once we trust accuracy on a wider sample (~50+ findings
across diverse prompts).

### F-17 — Substantive Ghost prompt fixes (NOT detector work)
**Status:** OPEN — separate prompt-quality session
**Source:** session 6 dogfood findings
**Why:** Six genuine prompt bugs surfaced. Catalog them here so they
don't get lost; do not address during detector development.

POI:
- Define billing-tier mapping for CRITICAL severity (currently
  CRITICAL has no defined rate; only LOW/MEDIUM/HIGH/architect)
- Clarify whether Landmarks appear in the "Recommended fix order"
  list (table marks them N/A; fix order says "all actionable
  findings" — Landmarks aren't actionable, but it's not stated)

Blast:
- Establish how the change target is conveyed to the model (prompt
  references "a specific file, class, or method" the developer
  identified, but never says where that target appears — system
  message? user message? file content?)
- Define criteria for effort/complexity/risk tiers (currently the
  prompt asks for these but doesn't define what each bucket means)
- Fix the "walk each one like the default checks above" copy-paste
  from POI (in Blast, default checks are report sections, not
  per-item rows — the instruction is incoherent in this context)

Conflict:
- Specify where consultant-check one-liners ("checked, no issue
  found") appear in output (Conflict has no equivalent of POI's
  framework-walk-before-categories framing)
- Fix the consultant-checks-vs-conflict-format mismatch (consultant
  checks are mostly single-point security issues; Conflict's
  framework requires two-sidedness; the prompt asks the model to
  walk consultants checks "like the default checks" without
  adapting the format)

---

## Closed items

- F-10 (session 6, commit 9401916): Tier 2 fixtures moved to dedicated folder.
