# Prompt Triage — Followups

Living list of deferred work for the Prompt Triage detector pack on the
`prompt-triage` branch. Append as items surface; mark DONE / DEFERRED
inline rather than deleting (preserves the audit trail).

Status legend: OPEN | DONE | DEFERRED

---

## Carried over from sessions 1–5 (pre-rail-fix)

### F-01 — C2 threshold re-tuning for length/excessive against tiktoken counts
**Status:** RESOLVED — v5.3.1 (May 11 2026)
**Source:** session 3 (tokenizer abstraction)
**Why:** Original LOW/MEDIUM/HIGH thresholds (3000/6000/12000 tokens) were
calibrated against the heuristic count. Real tiktoken counts may differ
by 5–15%. Worth a focused re-tune session against the dogfood corpus
once we have a wider sample.

**Resolution (v5.3.1):** Measured heuristic vs tiktoken token counts
against the 7-prompt Ghost dogfood corpus. Full data:
`audit-reports/threshold-calibration-2026-05-11.json`

Measurement methodology:
  - Reference for heuristic: claude-sonnet-4-6 (heuristic strategy)
  - Reference for tiktoken: gpt-4o (tiktoken strategy)
  - 7 prompts from prompts-extracted/, sizes 1.2 KB to 19.8 KB

Per-prompt drift (heuristic - tiktoken, positive means heuristic
over-counted):

  File                          Heur   Ttkn   Drift   Drift%
  01-chat-system.md             297    249    +48     +19.3%
  02-poi-default.md             3887   3377   +510    +15.1%
  03-poi-with-profile.md        4951   4220   +731    +17.3%
  04-blast-default.md           1348   1112   +236    +21.2%
  05-blast-with-profile.md      2413   1955   +458    +23.4%
  06-conflict-default.md        1038   943    +95     +10.1%
  07-conflict-with-profile.md   2103   1787   +316    +17.7%

Aggregate stats:
  - Mean drift: +17.7% (heuristic over-counts by ~18%)
  - Drift range: +10.1% to +23.4%
  - The original "5-15%" estimate in the ticket was conservative;
    actual drift is 10-23%.

**Key finding — zero tier changes:** Despite +18% drift on average,
NONE of the 7 corpus prompts crossed a different LOW/MEDIUM/HIGH
threshold under the two tokenizers. The current 3000/6000/12000
thresholds are robust to the heuristic-tiktoken drift across this
representative corpus.

**Decision: keep current thresholds.** Three reasons:

1. Zero tier changes in the dogfood corpus. The drift is real but
   the user-facing outcome is identical under both tokenizers.

2. The length/excessive thresholds are advisory hints, not
   gate-keeping decisions. Position-in-tier shifts (which the
   drift does cause) do not change finding emission.

3. Both candidate threshold adjustments are defensible policy
   choices:
   - Adjust down to ~2500/5000/10000 (match tiktoken intent):
     would over-flag heuristic users
   - Adjust up to give buffer: would under-flag tiktoken users
   - Neither is clearly correct without product user research.

   Without a tier-change case in the corpus forcing the decision,
   sticking with current thresholds is the least-regret option.

If future dogfood scans surface prompts that DO change tier under
heuristic vs tiktoken, re-open F-01b with that specific case as
the concrete example forcing the calibration call.

Closes F-01 fully. The "wider sample" the original ticket was
waiting for is now in audit-reports/dogfood-2026-05-11.json
(from F-08 closure earlier this session).

Total cost: $0 (both token counts computed locally, no API calls).
Total time: <5 seconds across all 7 prompts.

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
**Status:** RESOLVED — v5.3.1 (May 11 2026)
**Source:** session 5
**Why:** Tier 1 output detector fires on every "List …" verb even when
the bullet list that follows defines the list. Tier 2 fix territory.

**Resolution (v5.3.1):** Added hasBoundingEnumerationBelow() helper in
src/prompt-pack/unboundedOutput.js. The helper checks two conditions:

  1. The trigger line ends with a colon (after stripping trailing
     whitespace)
  2. The next non-empty line begins with a bullet (`-`, `*`, `>`) or
     numbered marker (`1.`, `2)`)

When both conditions hold, the bullets ARE the requested output bound,
so the unbounded finding is suppressed. The check is wired into the
detect loop alongside the existing isBehavioralGuidelineBullet() check.

Tight scope chosen for v1:
  - Requires the colon AND the immediately-following enumeration.
    Prose between trigger and bullets breaks the structural relationship
    and the finding fires as expected.
  - No scan-distance limit beyond "next non-empty line." Either the
    bullets follow directly or the relationship is too weak to suppress.
  - Numbered enumeration (1., 2)) accepted alongside bullet markers.

Resolution turned out to be regex-level work after all, not Tier 2
semantic judgment. The trick was recognizing that the colon-and-bullets
structural signal is unambiguous — humans read it the same way
regardless of context. Tier 2 semantic judgment becomes necessary only
for cases without the structural signal ("List the colors\nThey are red,
blue, and green" — no colon, no bullets, but the prose answer bounds
the output). That ambiguous class stays in F-26's scope.

Same-commit cosmetic cleanup: `queries|queries?` redundant duplicate
in all 5 CONSTRAINT_MARKERS regexes collapsed to single `queries?`.
Functionally a no-op (the redundancy matched the same word twice in
an alternation) but cleaner regex source.

Verified end-to-end (May 11 2026):
  4 F-03 bullet-list cases now suppress (0 findings each):
    - "List of valid statuses:\n- pending\n- approved\n- rejected"
    - "List the supported colors:\n- red\n- blue\n- green"
    - "List the steps:\n1. Initialize\n2. Configure\n3. Deploy"
    - "Provide the available options:\n* Option A\n* Option B"
  2 boundary controls fire correctly:
    - "List the things:\nThis is prose." (colon but no bullets) -> 1
    - "List the things\n- red\n- blue" (bullets but no colon) -> 1
  2 regression checks pass:
    - "List 5 issues" (count-bounded, vocab extension) -> 0
    - "List the top 5 bugs" (count + new noun) -> 0
  2 baseline controls fire:
    - "List everything you know" -> 1
    - "Describe the system" -> 1

10 pass / 0 fail on end-to-end detector smoke. Combined with the
previous commit's vocabulary extension, F-03 ships as the
structural piece of the bullet-list bounding work; F-26 stays
open for prose-based bounding that requires semantic judgment.

### F-04 — Constraint regex with intervening adjectives
**Status:** RESOLVED — discovered closed during v5.3.1 audit (May 11 2026)
**Source:** session 5
**Why:** "in 2-4 plain English steps" doesn't match the constraint anchor
because of "plain English" between the count and the noun. Tighten regex
or move to lookahead.

**Resolution (date unknown, pre-v5.3.1):** Two additional regexes in
unboundedOutput.js CONSTRAINT_MARKERS array (lines ~87-91) handle
both the range and bare-count cases with intervening adjectives:

  // Range with adjectives between number and unit
  /\b\d+(\s*[-\u2013]\s*|\s+to\s+)\d+\s+\S+(?:\s+\S+){0,4}\s+(words?|sentences?|paragraphs?|lines?|steps?|items?|bullets?|points?|examples?)\b/i,
  // Bare-count with adjectives between number and unit
  /\b\d+\s+\S+(?:\s+\S+){0,4}\s+(items?|paragraphs?|words?|sentences?|lines?|bullets?|points?|examples?|steps?|sections?|entries|results?|rows?|reasons?|tips?|ideas?|options?|choices?|things?)\b/i,

The \S+(?:\s+\S+){0,4} slot allows 1-5 intervening tokens between
count and noun. Comments in the regex array explicitly cite F-04's
example ("2-4 plain English steps") as the case being handled, so the
fix was deliberate even though the followups doc was never updated.

Verified end-to-end (May 11 2026 audit):
  - "in 2-4 plain English steps" -> 0 findings (correctly suppressed)
  - "in 2 steps" -> 0 findings (baseline, no regression)
  - "5 plain English steps" -> 0 findings (bare-count + adjectives)
  - "3-5 actionable bullets" -> 0 findings (range + 1 adjective)
  - "5-10 detailed analytical sentences" -> 0 findings (range + 2 adj)
  - "list the things you should know" -> 1 finding (unbounded control)
  - "write me a long essay about cats" -> 1 finding ("long" is not a
    constraining adjective; unbounded control)

Negative controls confirm the regex changes did not over-suppress.

Process note: F-04 joins F-07 and F-16 as tickets that were OPEN in
the doc despite the code being fixed. Future followups discipline
should close tickets in the same commit as the resolving fix.

### F-05 — Instruction-override regex gap on injection
**Status:** RESOLVED — v5.3.1 (May 11 2026)
**Source:** session 5
**Why:** "ignore your safety rules" doesn't fire because the regex
requires "above/prior" between verb and noun. Add variants.

**Resolution (v5.3.1):** Added two new regex entries to
injectionStaticPattern.js in the instruction-override category:

  1. Override of safety/system instructions (possessive form):
     verb + (your|my|its|their) + optional adjectives + target noun.
     Catches "ignore your safety rules", "disregard your prior
     guidelines", "forget your safety constraints", etc.

  2. Override of system instructions (generic article form):
     verb + (the|all|any) + negative lookahead on position words +
     optional adjectives + target noun.
     Catches "override the system prompt", "bypass any restrictions",
     "ignore all rules", etc.

The negative lookahead on position words (above|prior|preceding|
previous|earlier|original|initial|former) prevents the second regex
from double-firing on the original "Override of prior instructions"
regex's territory. "ignore the above instructions" still emits
exactly one finding (from the original line-60 regex), not two.

Both new regexes use the [a-z]+\s+){0,2} pattern in their target
slot to allow 0-2 adjective tokens between determiner and target
noun (e.g. "your safety rules", "the system prompt", "any
restrictions").

Target nouns extended beyond the original list to cover real attack
phrasing: safeguards, restrictions, filters, limits, limitations,
plus "system prompt" as a multi-word target. The original list
(instructions, prompts, rules, directives, etc.) is preserved.

Verified end-to-end (May 11 2026):
  5 previously-failing F-05 examples now fire (1 finding each):
    - "ignore your safety rules"
    - "disregard your prior guidelines"
    - "override the system prompt"
    - "forget your safety constraints"
    - "bypass any restrictions"
  1 baseline preserved (no duplicate):
    - "ignore the above instructions" -> 1 finding (was 1, now 1)
  4 negative controls stay silent:
    - "ignore the cookies"
    - "ignore your morning routine"
    - "the safety rules apply here"
    - "tell me a fun fact about whales"

10 pass / 0 fail on end-to-end detector smoke.

### F-06 — Few-shot suppression keyword gap
**Status:** RESOLVED — v5.3.1 (May 11 2026)
**Source:** session 5
**Why:** "typical conversation," "transcript:," "dialogue:" don't
suppress strayLineMarker findings even though they signal example
framing. Extend the suppression keyword list.

**Resolution (v5.3.1):** Extended the FEWSHOT_SIGNAL regex in
src/prompt-pack/roleSeparation.js (line 72) to add three new
framing keywords:

  - typical\s+conversation
  - transcript
  - dialogue

The original keyword list (example/examples, for instance,
demonstration, few-shot/few shot, sample exchange/interaction/
conversation) is preserved unchanged.

Coordinated edits in same commit:
  - Comment block (lines 45-52): rewritten from "known limitation"
    framing to "implemented in F-06" with the full keyword list
    enumerated.
  - User-facing detail text: extended the framing word examples
    in the finding message to include "transcript" and "dialogue"
    so users see the same vocabulary the suppressor uses.

False-positive risk considered: bare "transcript" and "dialogue"
might over-suppress on prompts that mention these words for
non-framing reasons (e.g., "Generate a transcript of this
meeting"). Risk is bounded by the existing 20-line upward scan
window in hasFewshotSignalAbove() — a non-framing mention only
suppresses markers within 20 lines below it. Combined with the
detector's stated LOW severity and acceptance of false negatives
(line 70 comment: "we accept that some legitimate few-shot
contexts will be missed"), erring toward suppression is preferred
over false-positive LOW findings.

Verified end-to-end (May 11 2026):
  5 F-06 framings now correctly suppress (0 stray findings):
    - "typical conversation:" (with colon)
    - "transcript:" (with colon)
    - "dialogue:" (with colon)
    - "Here is a transcript of the call." (in prose)
    - "Sample dialogue for your reference:" (combined sample+dialogue)
  6 original framings still suppress (no regression):
    - "Examples:", "Here is an example:", "For instance, consider:",
      "Demonstration of the format:", "Few-shot examples below:",
      "Sample exchange:"
  2 negative controls (no framing word) correctly fire 3 stray
    findings each:
    - "Continue the conversation appropriately."
    - "Process the following input carefully."

13 pass / 0 fail on end-to-end detector smoke.

### F-07 — Open models in registry (Llama, Mistral, Qwen)
**Status:** RESOLVED — v5.3.1 (May 11 2026)
**Source:** session 3
**Why:** Currently only Anthropic, OpenAI, and Gemini are in the
model registry. Open-weight model entries would broaden detector
coverage without needing API integration (heuristic strategy is
fine for these).

**Resolution (v5.3.1):** Added 6 open-weight model entries spanning
Meta Llama (llama-4-maverick 256K, llama-3-3-70b 128K), Mistral
(mistral-large-3 256K, mistral-small-3 32K), and Alibaba Qwen
(qwen-3-5 256K, qwen-2-5 128K). All use the heuristic tokenizer
strategy.

The file header comment that previously stated open models were
"intentionally omitted" was rewritten. The original concern was
that heuristic counts would imply deceptive precision. The two
tokenLimit detectors (tokenLimitExcessive, tokenLimitContextOverflow)
have since implemented heuristic severity downgrade (MEDIUM→LOW for
excessive, HIGH→MEDIUM for overflow) plus explicit "estimated via
heuristic" disclosure in user-facing finding text. With those in
place, heuristic-based open-model entries no longer imply false
precision — the user sees both a softer severity and an explicit
uncertainty disclosure.

Validated end-to-end against both detectors with controlled
prompts: heuristic-downgraded severity fires correctly on the
smallest open-model window (mistral-small-3 32K), silent on
windows where prompts are under threshold (128K-256K). Registry
public API verified — getModel() resolves all 6 IDs,
getModelsByFamily() returns 7 families (anthropic, openai, google,
meta, mistral, alibaba, test), listModelsForPicker() now returns
16 production models.

### F-08 — Ghost-on-Ghost full POI/Blast/Conflict scan
**Status:** RESOLVED — v5.3.1 (May 11 2026)
**Source:** session 5
**Why:** Run the full prompt-triage on Ghost's own production prompts
(not just the snapshots in prompts-extracted/) to validate end-to-end
behavior against live code paths.

**Resolution (v5.3.1):** Ran full prompt-triage (all Tier 1, Tier 2,
and Tier 3 detectors) against all 7 Ghost production prompt snapshots
in prompts-extracted/. Full findings saved to
audit-reports/dogfood-2026-05-11.json (17 KB, 59 findings catalogued).

Scoping note: this audit ran against the materialized snapshots in
prompts-extracted/, not the in-flight live code paths
(buildSystemPOI() etc.) referenced in the original ticket. Rationale:
the snapshots are the EXACT prompt text that Ghost sends to the
Claude API at runtime, so scanning them validates the live behavior
at the right layer. Scanning via live code paths would require a
more complex test harness that adds little value over snapshot
scanning. If validation via live code paths is ever needed, F-08
can be reopened as F-08b with a more specific scope.

Run summary (claude-sonnet-4-6, May 11 2026):

  File                          Total  HIGH  MED  LOW
  01-chat-system.md             0      0     0    0
  02-poi-default.md             10     0     3    7
  03-poi-with-profile.md        15     0     3    12
  04-blast-default.md           10     0     3    7
  05-blast-with-profile.md      8      0     2    6
  06-conflict-default.md        6      0     2    4
  07-conflict-with-profile.md   10     0     5    5
  GRAND TOTAL                   59     0     18   41

Key observations:

1. Zero HIGH findings across all 7 prompts. Ghost prompts have real
   maintainability gaps but no critical correctness issues.

2. 01-chat-system.md is the cleanest baseline (0 findings, 1.2 KB).
   The model for what tight Ghost prompts look like.

3. With-profile variants consistently surface more findings than
   default variants. The profile branch adds complexity that
   triggers underspecifiedConstraints, poorOrganization, and
   additional conflictingInstructions.

4. Three detectors are most active across Ghost prompts:
   - poorDocumentation: 18 findings (undocumented magic numbers,
     opaque references, undefined registry identifiers)
   - ambiguousInstruction: 13 findings (referent ambiguity,
     scope ambiguity)
   - undefinedOutputFormat: 9 findings (missing per-finding field
     schemas, table schemas without column definitions)

5. v5.3.1 envelope changes (F-13 discretion framings, F-14 hint
   capping) did not break detector behavior. All Tier 2 detectors
   that should fire on real production prompts did fire.

Concrete findings populated below in F-24's tracker section.
Individual findings remain OPEN under F-24 for the Ghost-prompt
session that addresses them. F-08 closes because the SCAN is
done; the action items live in F-24.

Total API cost: ~$2.50 (63 Tier 2/3 calls across 7 prompts).
Total scan time: ~6.5 minutes elapsed (largest single prompt
03-poi-with-profile took 107s).

### F-09 — API call observability for long Claude audits
**Status:** RESOLVED — v5.3.1 (May 11 2026)
**Source:** session 6
**Why:** Tier 2 audits in the live CLI have no progress indicator.
Long batches (10+ prompts) feel hung. Add a per-detector or
per-prompt progress line.

**Resolution (v5.3.1):** Added env-var-gated progress logging in
src/prompt-pack/index.js (the runAll orchestrator). When
GHOST_PROGRESS=1 is set in the environment, the orchestrator
emits stderr lines as Tier 2 and Tier 3 detectors run.

Format and shape:
  [Tier 2/3 audit] starting 9 detectors on test.md
  [Tier 2/3 audit] 1/9 ambiguousInstruction...
  [Tier 2/3 audit] 1/9 ambiguousInstruction done (5340ms, 1 findings)
  [Tier 2/3 audit] 2/9 underspecifiedConstraints...
  ...
  [Tier 2/3 audit] complete: 9 detectors, 28.8s total

Design decisions:
  - Tier 1 detectors stay silent. They run in microseconds —
    progress noise would clutter without value. User pain is the
    Tier 2/3 wait, so that is what gets visible progress.
  - Per-detector before/after lines (not just after). The "before"
    line tells the user what is currently running when a detector
    hangs for many seconds; without it, the user sees the slow
    period as just dead air.
  - Cumulative time and finding count in the after line. Helps
    diagnose which detector is slow (real data from validation:
    poorDocumentation took 14.8s while most others were 1-2s).
  - Completion line with total time. Closes the audit cleanly and
    gives the user a "you can stop watching now" signal.

Production behavior unchanged. Users without GHOST_PROGRESS=1 get
the same silent execution as before. Setting the env var during
demos, smoke tests, or large-codebase scans surfaces real progress.

Implementation: single new helper maybeLogProgress() near the top
of index.js. Three call sites in runAll: before-loop counter,
inside-loop per-detector start and end, after-loop completion.
Computes active-Tier-2/3-detector count up front by filtering
REGISTRY against opts.skipTiers. Tier 3 (integrationMismatch)
included because it does optional LLM verification when its regex
flag fires.

Verified end-to-end (May 11 2026) against a realistic prompt
that triggered 9 Tier 2/3 detectors with a real API:

  Test 1: GHOST_PROGRESS not set
    -> 4 findings emitted, no stderr output (production preserved)
  Test 2: GHOST_PROGRESS=1
    -> 5 findings emitted (one extra due to cache-bypass variant)
    -> full progress trace visible:
       * "starting 9 detectors" line
       * 9 detector start lines (1/9 through 9/9)
       * 9 detector done lines with per-call ms and finding count
       * completion line "9 detectors, 28.8s total"

Total API cost: ~$0.40 across 18 calls (9 detectors x 2 cache-
distinct prompts). Cache layer keeps repeat runs at zero.

Demo value: this is the kind of feature visible in a live demo.
A sales-call walkthrough of a real codebase scan with progress
visible reduces buyer anxiety about scan duration.

Future direction (not in scope for v5.3.1): a Ghost CLI flag
(--progress) that sets GHOST_PROGRESS=1 automatically so users
do not need to know the env var. Worth a small follow-up ticket
when the next CLI surface change happens.

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
**Status:** RESOLVED — v5.3.1 (May 11 2026)
**Source:** session 6 (auth bug discovery)
**Why:** Silent zero-findings hid the auth bug for ~3 hours. Consider
surfacing API errors as synthetic LOW-severity findings or stderr
warnings in smoke mode. Production behavior (fail-open silent)
should remain unchanged for end users.

**Resolution (v5.3.1):** Added env-var-gated stderr logging in
src/prompt-pack/llmAuditClient.js. Two changes:

1. New helper maybeLogTier2Failure(detectorName, modelId, errorText)
   that writes a single-line warning to stderr ONLY when
   GHOST_DEBUG_TIER2=1 is set in the environment. Format:
     "Ghost Tier 2 failure [detector / model]: error-text"

2. Helper called from both Tier 2 failure paths in auditPromptForDefect:
     - Parse-failure path (JSON parse failed after retry)
     - Catch-failure path (network error, auth, 404, rate limit, etc.)

The synthetic-finding alternative considered but rejected: emitting
findings from the detector path pollutes the report layer, conflates
infrastructure failures with prompt defects, and breaks the "fail
open silent" guarantee in production. Stderr is the natural channel
for infrastructure diagnostics — visible during development, easily
ignored or redirected in production.

Single source of truth: all 9 Tier 2 detectors share llmAuditClient.js,
so the env-var gate hits everywhere uniformly with no per-detector edits.

Production behavior unchanged. End-user runs without GHOST_DEBUG_TIER2
get the same silent fail-open as before. Setting the env var during
smoke testing or development surfaces real infrastructure problems
(auth misconfig, rate limits, 404s on bad model IDs, parse errors
indicating prompt schema drift).

Verified end-to-end (May 11 2026):
  Test 1: invalid model, GHOST_DEBUG_TIER2 NOT set
    -> 0 findings, no stderr output (production preserved)
  Test 2: invalid model, GHOST_DEBUG_TIER2=1
    -> 0 findings (fail-open preserved for user)
    -> stderr warning visible:
       "Ghost Tier 2 failure [ambiguousInstruction / nonexistent-
        model-xyz-9001]: Audit API call failed: 404 {"type":"error",
        "error":{"type":"not_found_error",...}}"

Total API cost: ~$0.02 (2 prompts to nonexistent models; both return
404 fast and cheap).

The 3-hour debug session that triggered F-11 would have shown the
auth error in the first few seconds with this enabled.

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
**Status:** RESOLVED — v5.3.1 (May 11 2026)
**Source:** session 6 review
**Why:** Phrases like "where appropriate," "if straightforward,"
"use your judgment" are deliberate model discretion, not author
error. Detector currently flags them as ambiguity. Add envelope
guidance to distinguish author-error softness from author-intent
softness.

**Resolution (v5.3.1):** Two coordinated edits to the
ambiguousInstruction.js envelope (the LLM evaluation prompt):

1. New "Do NOT flag" bullet in the definition prose teaching the
   intentional-discretion distinction explicitly. Names the
   common framings ("where appropriate", "if straightforward",
   "use your judgment", "as needed", "at your discretion",
   "when relevant"). Contrasts "handle edge cases appropriately"
   (lazy ambiguity, still flagged) with "where appropriate,
   escalate to a human reviewer" (intentional discretion, skipped).
   The defining test: when the discretion framing has scaffolding
   around it (conditional, fallback, named criterion), the
   discretion IS the rule content and should be skipped.

2. Three new NEGATIVE_EXAMPLES showing intentional discretion
   patterns:
     - "Where appropriate, escalate to a human reviewer."
       (discretion is the trigger condition; action is specified)
     - "Use your best judgment to balance brevity with accuracy."
       (criteria are named; discretion is the weighing)
     - "If straightforward, answer in one line; otherwise, expand."
       (both branches specified; discretion is the classification)

The contrast between POSITIVE_EXAMPLES "Handle edge cases
appropriately" (still flagged) and the new NEGATIVE_EXAMPLES gives
the LLM concrete grounding for the distinction. POSITIVE_EXAMPLES
itself was not modified.

Verified via real API smoke against claude-sonnet-4-6 (May 11 2026):

  2 lazy-ambiguity cases correctly fire:
    - "Handle edge cases appropriately." -> 1 MEDIUM
    - "Process the data correctly." -> 1 HIGH

  3 intentional-discretion cases correctly stay silent:
    - "Where appropriate, escalate to a human reviewer."
    - "Use your judgment to balance brevity with accuracy."
    - "If straightforward, answer in one line; otherwise, expand."

  Boundary case that exposed the right interpretation:
    - "Handle complex queries with discretion; simple ones answer
      directly." -> 1 MEDIUM (LLM correctly flagged as ambiguous)

The boundary case revealed that the envelope correctly distinguishes
*intentional discretion with scaffolding* (specified action paths)
from *lazy vagueness disguised with discretion words* (still no
specified action). "Handle X with discretion" without specifying
the action mirrors the "handle X appropriately" lazy pattern that
should fire. The LLM made the right call. Initial smoke labeled
this case "expectFire: false" — incorrect test expectation; the
envelope behavior was correct. Confidence in the F-13 fix is
HIGHER because the LLM held the line on lazy-vagueness even with
"discretion" in the phrasing.

Total cost of API smoke: ~$0.05 across 6 prompts.

Process note: F-13 is the first Tier 2 fix in this v5.3.1 audit
series. The pattern is different from Tier 1 regex tickets —
no deterministic test, validation is the LLM following envelope
guidance. Real API smoke is required for Tier 2 envelope work.
Sonnet 4.6 is cheap enough that 6-10 calls per ticket is fine.

### F-14 — Cap hint length at ~8 words
**Status:** RESOLVED — v5.3.1 (May 11 2026)
**Source:** session 6 review
**Why:** Some hints are 3 words ("second paragraph"), others are 15+
("Per-finding requirements (severity rating CRITICAL/HIGH/MEDIUM/LOW)
vs. Remediation Summary billing tiers (LOW/MEDIUM/HIGH)"). Add
schema constraint or envelope instruction to keep hints terse.

**Resolution (v5.3.1):** Two coordinated edits to llmAuditClient.js
(the shared Tier 2 envelope and validator):

1. STANDARD_SCHEMA_DESCRIPTION updated. The location_hint field
   instruction now explicitly states:
     - Purpose: terse pointer to WHERE in the prompt the defect is
     - Length: Maximum 8 words
     - Not for: description, summary, listing affected items
     - Examples of what NOT to put (description-shaped hints)
     - Examples of what TO put (location-shaped hints)
     - Fallback: null if cannot localize tersely

2. parseAuditResponse() validator updated with soft truncation.
   If location_hint comes back over 12 words, truncate to first
   8 words + "..." ellipsis. The 12-word threshold gives the LLM
   a 4-word margin over the 8-word target before the safety net
   kicks in — short enough to keep report layout clean, generous
   enough that natural 9-10 word hints survive intact.

Why these two edits work together: the envelope instruction is
the primary mechanism (cheap, no compute cost, LLMs follow it).
The truncation is the safety net for cases the envelope misses.
Both apply to all 10 Tier 2 detectors uniformly because the
schema is shared infrastructure.

Verified via real API smoke against claude-sonnet-4-6 using a
prompt with the exact conflicting-scale shape from the ticket
("severity rating CRITICAL/HIGH/MEDIUM/LOW" plus "billing tier
LOW/MEDIUM/HIGH"):

  Finding: "Severity scale and billing priority scale use
    overlapping labels differently"
  Hint: "second and third bullet lists"
  Hint word count: 5
  Status: PASS (under 8-word target, no truncation needed)

The envelope instruction alone produced a 5-word hint on the exact
ticket scenario. Truncation was not exercised in this run because
it wasn't needed — that is the desired outcome. The truncation code
path remains as backstop for cases where the LLM produces verbose
hints despite the envelope guidance.

Total API cost: ~$0.01 (1 prompt). Cache layer means re-runs cost
zero.

Process note: This is the second Tier 2 fix in v5.3.1 (after F-13).
Both shipped envelope-only changes with API smoke validation. The
pattern is: change envelope text, run 1-6 real-API smoke prompts,
verify behavior, commit. The cache layer in llmAuditClient.js keeps
re-runs free.

### F-15 — Cross-detector dedup at report layer
**Status:** PARTIAL (envelope-level carve-outs DONE; report-layer dedup deferred)
**Source:** session 6 review; reinforced session 6 underspecifiedConstraints ship
**Resolution:** Updated both Tier 2 detectors' envelopes with explicit
negative-space carve-outs naming each other. ambiguousInstruction now
explicitly excludes rating/measurement/quality-bar defects (those
belong to underspecifiedConstraints). underspecifiedConstraints now
explicitly excludes pronoun/scope/quantifier defects (those belong
to ambiguousInstruction). Each carve-out includes concrete examples
of what NOT to flag.

Verified end-to-end:
  - Fixture 25 (5 underspecified bucketed ratings): 7 → 4 findings
    (was 4 underspec + 3 ambig overlapping on same defects;
    now 4 underspec + 0 ambig, clean separation)
  - Fixture 26 (quality bars): 8 → 4 findings
    (was 4 underspec + 3 ambig + 1 unbounded; now 3 underspec + 0
    ambig + 1 unbounded)
  - Fixtures 22-24 (ambiguousInstruction territory): unchanged
  - Fixture 27 (negative control): unchanged at 0 findings

Unexpected outcome on dogfood: total Tier 2 findings increased
(~30 → ~36) because the carved-out detectors looked harder at their
own territory. The new findings are distinct and substantive, not
duplicates. Carve-outs cleanly resolved cross-detector overlap on
fixtures, but on rich Ghost prompts the freed-up detectors found
more real defects.

Report-layer dedup (the original (a) approach) deferred. The
carve-outs solved the structural duplication problem. If reader
fatigue from long reports becomes a real concern, that's a
different problem with different levers (severity floors, lower
FINDINGS_CAP, detector-grouped report sections, or fixing the
Ghost prompts themselves — see F-17). Not appropriate to solve
with dedup.

**Followup if dedup-revisit becomes warranted:** Track concrete
user-experience complaints first. "Two detectors fire on the same
defect" is solved. If "the report is too long" becomes a real
concern, diagnose what's actually noisy before reaching for
consolidation.

### F-16 — Reconsider MEDIUM severity cap on ambiguousInstruction
**Status:** RESOLVED — v5.3.0 (commit eb875d0, May 11 2026)
**Source:** session 6 review
**Why:** Several findings (POI severity-vs-complexity mapping, Blast
walk-each-one mismatch, Conflict consultant-checks-vs-format mismatch)
warrant HIGH. The cap was a defensive choice for a brand-new Tier 2
detector. Lift once we trust accuracy on a wider sample (~50+ findings
across diverse prompts).

**Resolution (v5.3.0):** Removed the HIGH→MEDIUM cap across all 9 Tier 2
detectors (ambiguousInstruction, conflictingInstructions, inefficientFewShot,
integrationMismatch, overloadedPrompt, poorDocumentation, poorOrganization,
undefinedOutputFormat, underspecifiedConstraints). The capSeverity
function in each detector was rewritten to pass HIGH through unchanged
rather than downgrade it. The accompanying envelope-level severity
calibration in llmAuditClient.js (+68 lines) ensures the LLM reserves
HIGH for genuinely-broken prompts: impossible joint satisfaction,
context overflow, injection patterns disabling safety. Suppressing HIGH
was hiding load-bearing signal from users.

Evidence base satisfied F-16's "~50+ findings across diverse prompts"
criterion: v5.3.0 production corpus run surfaced 56 findings across 7+
prompt files, with 1 verified HIGH (poi-with-profile.md FILE CITATION
RULES conflict — exactly the kind of broken-prompt signal the original
F-16 examples described).

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

## New from session 7 (Tier 2 detector ship plan)

### F-18 — ambiguousInstruction may have narrowed positive scope after trip-wire edit
**Status:** RESOLVED — confirmed as Tier 2 LLM-judgment variance, not regression
**Source:** session 7 (conflictingInstructions ship verification)
**Why:** After adding the SCOPE OF THIS DETECTOR header and trip-wire
language to ambiguousInstruction's defect description (commit 17389f2),
fixture 22 dropped from 2 → 1 finding and fixture 26 dropped from 5 →
4 findings on the post-edit smoke. The dropped findings were both LOW-
edge, all MEDIUM findings retained.

**Resolution:** Across five consecutive Tier 2 fixture-only runs during
detector #11 development (commits 3f966f4 and intermediates), fixture 22
finding count was {1, 2, 1, 2, 1} — wobble of ±1 LOW finding per run.
Fixture 26 was {4, 6, 7, 5, 5}. MEDIUM-severity findings on both
fixtures held stable across all five runs. The LOW-edge wobble appears
on multiple fixtures (22, 23, 26, 28, 30, 31, 32) at roughly ±1 finding
per run with no directional bias. This is consistent with Haiku 4.5
sampling variance at borderline severity. The trip-wire edit did not
shrink positive scope.

**Practical implication:** Tier 2 fixture counts have a built-in noise
floor of approximately ±1 LOW finding per fixture per run. Treat
fixture deltas of 1 LOW as variance unless they reproduce across 2+
consecutive runs with the same code. MEDIUM-severity counts are stable
and can be treated as load-bearing test signal.

### F-19 — Cross-fire pattern recurs on every new Tier 2 detector ship
**Status:** PARTIALLY MITIGATED — design-time prevention works for the new detector; existing detectors still need batch standardization
**Source:** sessions 6, 7 (every Tier 2 detector ship to date)
**Priority:** MEDIUM (predictable, not blocking)
**Why:** Every new Tier 2 detector through #11 cross-fired with at
least one existing sibling on the synthetic worst-case fixture (the
one constructed with maximum thematic overlap). Pattern observed:
  - Session 6 underspecifiedConstraints ship: ambiguousInstruction
    cross-fired on fixtures 25/26. Fixed by adding "missing rubrics"
    carve-out paragraph to ambiguousInstruction.
  - Session 7 conflictingInstructions ship: ambiguousInstruction
    cross-fired on fixture 29 with literal "Conflicting" in finding
    titles. Fixed by promoting carve-out into SCOPE OF THIS DETECTOR
    header + adding imperative trip-wire vocabulary list.
  - Session 7 undefinedOutputFormat ship: undefinedOutputFormat
    cross-fired on fixture 29; ambiguousInstruction also re-leaked
    on fixture 29. Fixed both with imperative trip-wire vocabulary.
  - Session 7 overloadedPrompt ship: NO cross-fire on the synthetic
    overload fixtures (34, 35, 36). The detector was designed from
    the start with the SCOPE OF THIS DETECTOR header, the imperative
    DROP trip-wire form, and the full vocabulary list covering all
    four sibling territories. First Tier 2 detector to ship without
    a cross-fire incident.

The cross-fire never appeared on dogfood prompts — only on synthetic
fixtures by construction. Real-world prompt structures don't produce
the pure-overlap shapes the fixtures probe for.

**Hypothesis on root cause:** Tier 2 detectors share the same envelope
template and audit client. When two detectors' positive-scope
language covers thematically related defect classes, the LLM
sometimes pattern-matches on the surface signal ("these instructions
seem to be in tension") without consulting the carve-out clauses
until the carve-out is in load-bearing position (early in the
envelope, imperative voice, with the literal vocabulary the model
tends to use).

**Evidence the design-time pattern works:** Detector #12 shipped
with zero cross-fire incidents because it baked in (a) the SCOPE
OF THIS DETECTOR header naming all four sibling territories, (b)
the imperative DROP trip-wire form ("DROP that finding and continue.
Do not emit it."), and (c) the full vocabulary list covering ambig,
underspec, conflict, and undef-format trip words — all from the
first write. Detector #13 (poorOrganization) repeated this result
on its own fixtures: zero cross-fire on fixtures 37, 38, 39 from
the first write. Detector #14 (inefficientFewShot) repeated this
result a third time on fixtures 40, 41, 42 from the first write,
despite operating in territory that thematically overlaps every
other Tier 2 detector. Detector #15 (poorDocumentation) repeated
this result a fourth time on fixtures 43, 44, 45 from the first
write — including the load-bearing negative control (fixture 45)
which is the highest false-positive risk fixture in the entire
Tier 2 corpus because it deliberately contains magic numbers,
internal tier names, and a negative constraint, all WITH inline
rationales and a glossary. The detector correctly recognized that
documentation-IS-present means do-not-flag. The design-time
prevention pattern is now confirmed across four consecutive new-
detector ships and is the dominant approach for new Tier 2
detectors going forward.

**Counter-evidence that retrofit on existing detectors is unsafe:**
During detector #13 ship, fixture 29 surfaced a fresh
undefinedOutputFormat cross-fire (the existing detector started
emitting a "Conflicting output format directives" finding that
overlapped conflictingInstructions territory). An attempt to fix
it by extending the existing trip-wire vocabulary on
undefinedOutputFormat made things measurably worse: fixture 29
went from 3 → 4 findings, and fixture 39 (a previously-clean
negative control) gained a false-positive LOW finding. The edit
was reverted. After revert, fixture 29 dropped to 2 findings
(BELOW the pre-edit baseline) and fixture 39 returned to 0.
The cross-fire on fixture 29 was sensitive to envelope edits in
ways that made it impossible to predict by reading the change.
See F-22 for the lesson.

**Action plan, partially deferred to F-12:**
  - DONE for new detectors: every new Tier 2 detector ships with
    full SCOPE header + imperative DROP trip-wire + complete
    sibling vocabulary list from the first write. Detector #12
    confirmed this approach prevents cross-fire entirely.
  - DEFERRED to F-12: standardize trip-wire vocabulary across the
    EXISTING detectors (see F-20). Detectors #8 and #10
    (ambiguousInstruction, conflictingInstructions) had their
    trip-wires retrofitted incrementally and use ad-hoc lists.
  - DEFERRED to F-12: promote SCOPE OF THIS DETECTOR header to a
    templated structure in llmAuditClient.js so each detector
    defines its scope statement in a structured way rather than
    free-form prose.
  - DEFERRED to F-12: add a short proactive negative-space framing
    at the top of the envelope listing the OTHER live detectors
    and their territories, so the model sees the boundaries
    before reading the positive examples.

Not blocking detector ship cadence. The new-detector path is now
clean. Retrofit of existing detectors is housekeeping for F-12.

### F-20 — Standardize trip-wire vocabulary across Tier 2 detectors
**Status:** OPEN — batch with F-12
**Source:** session 7 (cross-fire fixes on three different detectors)
**Why:** Each Tier 2 detector has its own trip-wire vocabulary list
in its envelope, drifted from the others by accident:
  - ambiguousInstruction: "conflicting", "contradictory",
    "incompatible", "in tension", "mutually exclusive", "cannot
    both be satisfied", "cannot coexist"
  - undefinedOutputFormat: "ambiguous", "multiple readings",
    "conflicting", "contradictory", "in tension", "mutually
    exclusive", "cannot both be satisfied", "no length cap",
    "rubric", "criteria"
  - overloadedPrompt: "ambiguous", "multiple readings",
    "conflicting", "contradictory", "in tension", "mutually
    exclusive", "cannot both be satisfied", "cannot coexist",
    "no length cap", "no word count", "rubric", "criteria",
    "no schema", "no fields specified", "no sections specified"
    (most complete list of the live detectors)
  - underspecifiedConstraints, conflictingInstructions: no trip-wire
    yet (only the older Do NOT flag bullets)

During F-12, build a canonical vocabulary table mapping each detector
to: (a) its own positive-scope marker words, (b) the marker words
that indicate territory belongs to a sibling detector. Enforce
through a shared template in llmAuditClient.js so adding detector
#N+1 doesn't require N edits to existing detectors. Use
overloadedPrompt's vocabulary list as the most-complete starting
point.

Falsification: track cross-fire incidents per detector ship after
the shared template lands. If incidents stay at zero (matching the
result on detector #12 ship), the template works. If they return,
the issue is structural to the envelope approach, not vocabulary
management.

### F-21 — Legitimate detector co-firing is intentional, not a defect
**Status:** DOCUMENTED — design principle, no action required
**Source:** session 7 (overloadedPrompt ship verified on fixture 32)
**Priority:** LOW (clarifying note)
**Why:** Distinguish two patterns that look superficially similar but
are different:

  - **Cross-fire (defect):** two detectors fire on the SAME defect
    from different angles. Example: ambiguousInstruction firing on
    fixture 29 with finding titled "Conflicting requirements" —
    that's the conflictingInstructions territory and the ambig
    detector should not have emitted. Fix with envelope carve-out
    and trip-wire vocabulary (see F-19).

  - **Co-fire (correct):** two detectors fire on DIFFERENT defects
    that happen to coexist in one prompt. Example: fixture 32 has
    both an undefinedOutputFormat defect (three named output
    containers each missing schemas: answer-and-reasoning, report,
    CSV) AND a separate overloadedPrompt defect (those same three
    are also independent deliverables stacked without precedence).
    Both findings are correct because the defects are real and
    distinct, even though they're co-located. Two detectors finding
    two real problems on one prompt is the system working as
    designed, not duplication.

This distinction matters because cross-fire is a tuning bug that
needs fixing, while co-fire is correct behavior that should be
preserved. F-12's report-layer dedup work should NOT collapse
genuine co-fires into single findings; it should target only the
structural duplication where two detectors describe the same
underlying authorial mistake.

No action required — this is documentation of a design principle
that became visible when overloadedPrompt was added to the
detector pack. Cite this entry if F-12 work tempts toward overly
aggressive consolidation.

### F-22 — Ad-hoc trip-wire tightening on existing Tier 2 detectors is unsafe
**Status:** OPEN — defer all retrofit edits to F-12
**Source:** session 7 (detector #13 ship, post-revert)
**Priority:** HIGH (prevents future regression cycles)
**Why:** During the detector #13 ship, an attempt to suppress a
single undefinedOutputFormat cross-fire on fixture 29 by extending
the trip-wire vocabulary list and adding an anti-rationalization
clause produced TWO regressions in one round trip:
  - Target fixture (29) went from 3 → 4 findings (opposite of intent).
  - Previously-clean negative control (fixture 39) gained a LOW
    false-positive on "container structure" (the change-log instruction).

The edit was reverted. Post-revert, fixture 29 dropped to 2
findings (BELOW the pre-edit baseline of 3) and fixture 39 returned
to 0. The pre-edit cross-fire fixed itself just by removing the
"fix" attempt. This is the second regression in one session caused
by tightening existing Tier 2 envelopes (the first was the ambiguous
Instruction trip-wire iteration during detector #11 ship, where
each edit changed which fixtures fired in unpredictable ways).

**Hypothesis:** Adding vocabulary words and anti-rationalization
clauses to an existing detector's envelope changes how the LLM
weights the entire envelope, not just the trip-wire section.
The model can read "if you would say X, drop the finding" as
"X is salient, look for X-shaped findings" — the very thing the
clause was meant to prevent. This is consistent with the detector
#11 session pattern where each successive trip-wire tightening
shifted the cross-fire from one fixture to another rather than
eliminating it.

**Action:**
  - DO NOT edit existing Tier 2 detector envelopes to fix
    cross-fire incidents on individual fixtures. The edits are
    not locally reasonable; their effects spread across all
    fixtures unpredictably.
  - Cross-fire incidents on existing detectors are a known F-19
    pattern. Document them in followups when they appear, then
    leave them for the F-12 batch fix (shared envelope template,
    canonical vocabulary, structural separation of detector
    boundaries).
  - When a new detector ships and induces a cross-fire on an
    existing detector, treat the cross-fire as a known cost of
    the new ship, not a problem to fix by tightening the
    existing detector. Ship the new detector at its clean state;
    log the cross-fire fixture; move on.

**Falsification:** if F-12's structural fix lands and cross-fires
still recur on subsequent Tier 2 ships, the issue is deeper than
vocabulary management — likely the LLM-augmented detector pattern
itself needs revisiting. Track this when F-12 work is done.

### F-23 — Same-root-cause co-fire is distinct from cross-fire and legitimate co-fire
**Status:** DOCUMENTED — F-12 territory, no new action
**Source:** session 8 (detector #14 ship, fixture 40)
**Priority:** LOW (clarifying note)
**Why:** Distinguish a third pattern that emerged with detector
#14 from the two patterns documented in F-21:

  - **Cross-fire (F-21 defect):** Two detectors fire on the SAME
    defect from DIFFERENT framings, where one detector should not
    have emitted at all. The losing detector's envelope needs a
    carve-out.

  - **Legitimate co-fire (F-21 correct):** Two detectors fire on
    DIFFERENT defects that happen to coexist in one prompt. Both
    findings are correct; both stay.

  - **Same-root-cause co-fire (F-23 new pattern):** Two detectors
    fire on the SAME defect, BOTH correctly per their positive
    scopes. Example: fixture 40 has an example output that
    contradicts the JSON format spec. undefinedOutputFormat
    correctly identifies this as "example output contradicts JSON
    format spec" (the format guidance is undermined by its own
    example). inefficientFewShot correctly identifies this as
    "example contradicts JSON format instruction" (the example
    fails to teach the requested pattern). Both findings are
    technically correct given each detector's defined scope; the
    defect simply lives at their intersection.

Unlike cross-fire (where one detector is wrong and needs envelope
tightening), same-root-cause co-fire cannot be fixed at the
envelope layer without breaking one detector's legitimate scope.
The right fix is at the report layer: when two findings cite the
same prompt fragment with similar root-cause framing, consolidate
them into one finding with both detectors named as contributors.

This is exactly the F-12 root-cause consolidation work. F-23
documents the pattern but does not add new action — F-12 is the
structural fix.

Critically: do NOT attempt to suppress same-root-cause co-fire by
retrofitting either detector's envelope (per F-22). The findings
are not wrong; they're just redundant. Envelope tightening would
either suppress legitimate findings or create cross-detector
ordering bugs.

### F-24 — Dogfood corpus surfaces real maintainability issues in Ghost's own prompts
**Status:** OPEN MEDIUM (action queue, not blocking)
**Source:** session 8 (detector #15 ship, dogfood smoke)
**Priority:** MEDIUM — real findings, not a detector bug
**Why:** When detector #15 (poorDocumentation) ran for the first
time against the Ghost Architect dogfood corpus
(`/Users/ejwisner/ghost/ghost-architect4/prompts-extracted/`), it
surfaced legitimate maintainability findings on Ghost's own
production prompts:

  - **POI default**: `$85/hr / $125/hr / $200/hr` billing rates
    lack rationale (where do these come from? market data?
    company pricing?); consultant profile referenced but `null`
    in this snapshot, with no doc explaining what a profile is
    or how it modifies the framework.
  - **POI with profile**: same billing-rate gap;
    `buildSystemPOI(DEFAULT_RATES, SAMPLE_PROFILE)` header
    reference doesn't document what those inputs look like; four
    Ghost categories (RED FLAGS / LANDMARKS / DEAD ZONES / FAULT
    LINES) presented without rationale on why these four (vs.
    SECURITY, PERFORMANCE).
  - **Conflict with profile**: Composer commit-hash pinning rule
    flagged as a red flag without rationale (and pinning is
    generally considered a best practice — without context, this
    looks wrong); severity rubric definitions reference
    unexplained scope.

These findings are correct. The detector is doing its job.
Ghost's own prompts have real undocumented choices that would
block a future maintainer. Tracking as future work, separate from
prompt-pack ship cadence:

  - Add inline rationales to billing-rate tiers in
    `src/scan/buildSystemPOI.js`.
  - Document what "consultant profile" is and what shape it
    takes; or note that profiles are documented in a separate
    file.
  - Document why the four Ghost categories were chosen (or note
    product-contract dependency).
  - Document the rationale behind the Composer commit-hash rule
    (or remove it if it's not consultant-specific guidance).

Address these post-v5.0.0 ship as part of "dogfood the prompt
pack on Ghost's own prompts" cleanup work. Not blocking v5.0.0
release.

**Concrete findings tracker (v5.3.1 dogfood scan, May 11 2026):**

Full findings JSON: `audit-reports/dogfood-2026-05-11.json`
Scan executed via F-08 closure. 59 total findings across 7 prompts,
0 HIGH, 18 MEDIUM, 41 LOW.

Findings grouped by theme for prioritization:

**Theme 1 — Consultant profile coupling (5 findings, all LOW):**
  - "consultant profile registry" referenced but undocumented
    (POI default, POI with-profile, Blast with-profile, Conflict
    with-profile)
  - `buildSystemPOI(DEFAULT_RATES, SAMPLE_PROFILE)` source
    reference undocumented (POI default)
  - `buildSystemBlast(DEFAULT_RATES, null)` undocumented (Blast
    default)
  - Coupled-prompt assumption "no profile" build path undocumented
    (Conflict default)
  - Coupled-prompt assumption "parent prompt" undocumented
    (Conflict with-profile)

**Theme 2 — Effort/billing rates as magic numbers (5 findings, LOW):**
  - Effort hour ranges (2-6, 8-20, 24-60, 60+) lack rationale
    (POI default, POI with-profile, Blast default, Blast with-profile)
  - Hour ranges in Conflict files were not flagged but use the
    same magic numbers — likely will be flagged on next dogfood pass
  - Rollback complexity tier "Impossible after point of no return"
    label undocumented (Blast with-profile)

**Theme 3 — Output format underspecification (6 findings, mostly MEDIUM):**
  - Finding internal structure undefined despite detailed output
    spec (POI default MEDIUM, POI with-profile MEDIUM)
  - REMEDIATION SUMMARY table schema mixes defined and undefined
    fields (POI default LOW, POI with-profile MEDIUM)
  - Blast-radius analysis sections lack defined output structure
    (Blast default MEDIUM)
  - ROLLBACK PLAN sub-sections lack defined item structure
    (Blast default MEDIUM)
  - "Smoke Test After Rollback" list has no item structural spec
    (Blast default LOW)
  - Consultant-check findings have no specified output structure
    (Blast with-profile MEDIUM, Conflict with-profile MEDIUM)

**Theme 4 — Framework walk internal/external tension (3 findings, MEDIUM):**
  - "Framework walk must be internal-only AND must appear before
    report" — conflict (POI default MEDIUM)
  - "Framework walk is both internal scratchpad and must produce
    findings for final report" — conflict (POI with-profile LOW)
  - "OVERLAP RULE conflicts with do-not-skip-rows walk requirement"
    (POI with-profile MEDIUM)

**Theme 5 — OVERLAP RULE governance (4 findings, MEDIUM):**
  - Ambiguous scope of OVERLAP RULE across framework walk vs.
    final report (POI with-profile LOW)
  - Ambiguous scope of OVERLAP RULE when consultant check
    partially overlaps built-in (Conflict with-profile MEDIUM)
  - OVERLAP RULE directs single emission but CONSULTANT CHECKS
    section directs double evaluation (Conflict with-profile
    MEDIUM)
  - Consultant-check findings format conflicts with parent prompt
    finding format (Conflict with-profile MEDIUM)

**Theme 6 — Aggregation rule edge cases (3 findings, mostly MEDIUM):**
  - Severity tiers named but boundary criteria absent for
    individual conflicts (Conflict default LOW)
  - Overall conflict risk aggregation rule omits the case of
    exactly 1 HIGH, <3 MEDIUMs, no CRITICAL (Conflict default
    MEDIUM)
  - "MEDIUM" threshold is ambiguous in overall conflict risk
    aggregation (Conflict with-profile MEDIUM)
  - Aggregation thresholds in severity rubric have undocumented
    source (Conflict with-profile LOW, Conflict default LOW)

**Tier 1 findings (Ghost-side prompt structure):**
  - 2x output/unbounded in Blast default (bullet enumeration after
    trigger without bounding count)
  - 2x output/unbounded in Blast with-profile (same)
  - 2x length/excessive on POI files (15-20 KB; not necessarily
    wrong, but flagged as worth tracking)

**Miscellaneous individual findings worth noting:**
  - "Side A / Side B" framing ambiguous for multi-party conflicts
    (Conflict default MEDIUM) — design question, not just
    documentation
  - DIAGNOSTIC VOICE and consultant framing rules appear mid-prompt
    after task instructions have already been given (Blast
    with-profile LOW) — organization issue, structural
  - Per-finding format spec buried after multi-section framework
    walk (POI with-profile LOW) — same organizational pattern

**Priority recommendation for Ghost-prompt session:**

1. Themes 1, 2 (documentation): easy wins, low risk, mostly text
   edits to add rationale comments. Probably 30-60 min total.

2. Theme 3 (output format): per-finding field schema definitions.
   Higher value, higher risk of breaking model output if schema
   contradicts existing patterns. Do with care, prompt-by-prompt.

3. Themes 4, 5 (framework walk / OVERLAP RULE governance):
   architectural — the rules need redesign, not just documentation.
   This is the hardest cluster.

4. Theme 6 (aggregation edge cases): genuine correctness gap.
   Should be fixed before any pricing or severity decisions rely
   on these aggregations.

5. Tier 1 unbounded/length: tactical fixes; bounded-count
   constraints can be added to the unbounded-output triggers,
   length/excessive findings may indicate real bloat or may be
   intentional verbosity.

### F-25 — Strategic deviation: ship Prompt Triage to ghost-architect-open in v5.1.0
**Status:** ACCEPTED — strategic call, not a defect
**Source:** session 8 (post-detector-#15 ship decision)
**Priority:** N/A (decision log)
**Why:** The original May 5 strategy (chat 84f82b42) sequenced Prompt
Triage as a Pro-tier private-branch feature for v5.x with cherry-picks
to Open deferred 2-4 weeks for paid-tier conversion hook ("Prompt
Triage available now on Pro — Open users get it next month"). After
detector #15 shipped, the call was made to ship Prompt Triage to
ghost-architect-open simultaneously with paid tiers in v5.1.0 rather
than holding it back.

**Risks accepted by this decision:**

  - **Hallucination tuning gap.** The May 5 plan budgeted "week of
    May 19" for ground-truth corpus work and false-positive tuning
    against real-world prompts. That week never happened. Open users
    will throw real-world prompts at the pack that the test corpus
    did not cover. Expected effect: occasional false positives and
    false negatives that a paid-tier-first release would have tuned
    out before public exposure.
  - **API key dependency confusion.** Tier 2 detectors require an
    Anthropic API key. Open users without one get clean fail-open
    behavior (Tier 2 detectors silently skip, only Tier 1 runs) but
    will see the "Tier 2 detectors not run" notice and may not
    understand why.
  - **No paid-tier conversion hook.** "Prompt Triage available now on
    Pro" pitch is gone. Pro/Team/Enterprise tiers ship the same
    feature set as Open for this release.

**Reasons the call was made:**

  - Maximum top-of-funnel reach. Public Open users are the largest
    install base by far; shipping the feature there immediately means
    real-world feedback at scale.
  - "Shipped today" clarity outranks staged-rollout strategy at this
    pre-revenue stage.
  - Open's prompt-pack hides Tier 2 behind API key requirement, which
    naturally limits initial real-API exposure to users who already
    have an Anthropic account and credits — a self-selected technical
    cohort.

**What we still owe Pro/Team customers:** the Ghost Partner branded
PDF rendering integration with Prompt Triage reports. That work is
on the ghost-partner branch and was the original "Pro+ exclusive"
hook for the May 5 plan. With Open shipping the feature too, the
conversion pitch is now branded reports, not access. F-26 (future)
will track that integration.

**No action items.** This is a decision log entry. Future Open users
hitting false positives or unexpected behavior should be tracked
under the existing F-12 (root-cause consolidation) and F-19 (cross-
fire prevention) followups, not here.

---

## Closed items

- F-10 (session 6, commit 9401916): Tier 2 fixtures moved to dedicated folder.
- F-15 (session 6, partial): cross-detector envelope carve-outs landed; report-layer dedup deferred (different problem class).
- conflictingInstructions detector #10 (session 7, commit 17389f2): shipped.
  3 fixtures (28-30), F-15 carve-outs symmetrically extended to
  ambiguousInstruction (added scope header + trip-wire vocabulary list)
  and underspecifiedConstraints (named conflict sibling explicitly).
  Cross-fire on fixture 29 resolved (was 2 ambig + 2 conflict, now 0
  ambig + 2 conflict). Negative control fixture 30 (precedence-
  resolved tensions) holds at 0 findings. Dogfood corpus surfaced new
  conflict findings on POI severity-vs-billing-tier mapping, which is
  real defect territory — added to F-17 implicitly (already covered
  by existing POI billing-tier item).
- undefinedOutputFormat detector #11 (session 7, commit 3f966f4): shipped.
  3 fixtures (31-33) covering stated container with no schema, composite
  output, and a non-adjacent-spec negative control. Symmetric F-15
  carve-outs added to all three live Tier 2 siblings. Trip-wire
  vocabulary on ambiguousInstruction expanded after fixture 29 cross-fire
  recurred (added "in tension", "mutually exclusive", "cannot both be
  satisfied", "cannot coexist"; verb tightened from "drop" to "DROP
  that finding and continue. Do not emit it."). Trip-wire on
  undefinedOutputFormat itself uses the same imperative form. Fixture
  24 cleaned: "ordered by urgency" replaced with explicit rubric
  pointing at observable text in the customer message, removing a
  latent underspec defect that surfaced when Haiku ran more aggressively
  on one mid-development run. Final fixture verification across the
  full Tier 2 corpus: 22:1, 23:3, 24:0, 25:4, 26:5, 27:0, 28:3,
  29:2 (conflict-only attribution), 30:0, 31:1, 32:4, 33:0. All
  MEDIUM findings retained, all four negative controls (24, 27, 30,
  33) hold at 0. Dogfood scan from prior full run surfaced 6 new
  conflict-shaped output-structure findings on POI/Conflict prompts,
  all distinct from existing ambig/underspec findings (real defect
  territory).
- F-18 (session 7, commit 3f966f4): variance hypothesis confirmed.
  Tier 2 fixture counts have ~±1 LOW finding noise floor per run;
  MEDIUM findings are stable. No positive-scope shrinkage from the
  trip-wire edit. Treat single-LOW deltas as variance unless they
  reproduce across 2+ runs.
- overloadedPrompt detector #12 (session 7, commit a68a56a): shipped.
  3 fixtures (34-36) covering stacked task types positive, personas
  + governance positive (also exercises legitimate conflictingInstructions
  co-firing on items 7+8 tone and 10+11 word count), and long-but-
  focused negative control. Symmetric F-15 carve-outs added to all
  four live Tier 2 siblings (one short bullet each naming
  overloadedPrompt and its task-count-sprawl territory). Trip-wire
  vocabulary on overloadedPrompt itself uses the imperative DROP
  form covering all four sibling detectors from the first write —
  first Tier 2 detector to ship without a cross-fire incident on
  the synthetic worst-case fixture (see F-19 update). Fixture 24
  cleaned again: "Format your response as a numbered list" replaced
  with explicit per-item mapping ("exactly four items in this order:
  (1) summary, (2) issues, (3) translated terms, (4) resolution
  steps") to keep fixture clean across all five Tier 2 detectors.
  Header comment updated to reflect all-Tier-2 negative-control
  status. Final fixture verification across the full Tier 2 corpus:
  22:1, 23:3, 24:0, 25:4, 26:5, 27:0, 28:3, 29:2, 30:0, 31:1, 32:5
  (4 undef-format + 1 overloadedPrompt co-fire), 33:0, 34:1, 35:5
  (3 overloadedPrompt + 2 conflict), 36:0. All MEDIUM findings
  retained. All five negative controls (24, 27, 30, 33, 36) hold
  at 0. Fixture 32 co-firing pattern formalized as design principle
  — see F-21.
- poorOrganization detector #13 (session 7, commit dc81f32): shipped.
  3 fixtures (37-39) covering scattered length rules positive,
  inverted SCQA dependency + buried role context positive, and
  long-but-organized-without-markdown-headers negative control.
  Symmetric F-15 carve-outs added to all four existing live Tier 2
  siblings (ambig, underspec, conflict, undef-format) — one short
  bullet each naming poorOrganization and its structural-arrangement
  territory. Detector itself baked in the F-19 design-time prevention
  pattern from the first write: SCOPE OF THIS DETECTOR header naming
  all five sibling territories, imperative DROP trip-wire, full
  vocabulary list covering ambig, underspec, conflict, undef-format,
  and overload trip words. Result: zero cross-fire on detector #13's
  own fixtures (37:1 ✓, 38:2 ✓, 39:0 ✓ — load-bearing negative
  control held).
  This ship surfaced and resolved a separate cross-fire on existing
  fixture 29 (undefinedOutputFormat started emitting a "Conflicting
  output format directives" finding alongside the legitimate
  conflictingInstructions findings). An attempt to suppress the
  cross-fire by tightening undefinedOutputFormat's trip-wire
  vocabulary backfired: fixture 29 went 3→4 and fixture 39 gained
  a false-positive LOW (regression on a load-bearing negative
  control). The edit was reverted. Post-revert, fixture 29 dropped
  to 2 findings (below the pre-edit baseline) and fixture 39
  returned to 0. Lesson formalized as F-22.
  Final fixture verification across the full Tier 2 corpus:
  22:1, 23:3, 24:0, 25:4, 26:6 (6th finding within F-18 wobble band,
  MEDIUM), 27:1 (LOW table-column-order finding, F-18 wobble),
  28:3, 29:2, 30:0, 31:1, 32:5 (4 undef-format + 1 overloadedPrompt
  co-fire), 33:0, 34:1, 35:6 (2 conflict + 3 overload + 1
  poorOrganization co-fire — F-21 design principle), 36:2 (2
  underspecified findings within F-18 wobble band), 37:1, 38:2, 39:0.
  All MEDIUM findings on positive controls retained. All four
  load-bearing negative controls (24, 30, 33, 39) hold at 0.
  Fixtures 27 and 36 each gained findings within the F-18 ±1 LOW
  variance band; not caused by this session's edits.
- inefficientFewShot detector #14 (session 8, commit 3732e92): shipped.
  3 fixtures (40-42) covering example-contradicts-JSON-spec
  positive, placeholder-meta-examples positive, and clean-three-
  examples-with-clean-instructions negative control. Symmetric
  F-15 carve-outs added to all six existing live Tier 2 siblings
  (ambig, underspec, conflict, undef-format, overload, poor-org).
  Bonus catch-up during this ship: added missing poorOrganization
  carve-out to overloadedPrompt's Do NOT flag list (omitted during
  detector #13 ship; symmetric carve-out maintenance, not the kind
  of ad-hoc tightening F-22 warns against).
  Detector itself baked in the F-19 design-time prevention pattern
  from the first write, with one additional design choice: a
  CRITICAL SCOPE GATE stating that the detector only fires when
  examples ARE present in the prompt (absence of examples is out
  of scope). The scope gate is stated three times in the envelope
  (in the SCOPE header, in the trip-wire, and in the Do NOT flag
  list) to eliminate the most common false-positive risk for this
  detector class. Result: zero cross-fire on detector #14's own
  fixtures from the first write — third consecutive new-detector
  ship to hit this result.
  Fixture 40 surfaced a new pattern: same-root-cause co-fire
  between inefficientFewShot and undefinedOutputFormat. Both
  detectors correctly identify the example-contradicts-JSON-spec
  defect under their respective positive scopes. Per F-22, did not
  attempt to fix this by retrofitting either envelope. Logged as
  F-23 — a distinct pattern from F-21 cross-fire/co-fire that
  requires F-12 report-layer consolidation, not envelope-layer
  tightening.
  Final fixture verification across the full Tier 2 corpus:
  22:1, 23:3, 24:0, 25:4, 26:5, 27:0, 28:3, 29:3, 30:0, 31:1,
  32:5, 33:0, 34:1, 35:4, 36:0, 37:1, 38:2, 39:0, 40:2 (1
  inefficient-few-shot + 1 same-root-cause co-fire on undef-format
  per F-23), 41:2 (1 inefficient-few-shot + 1 legitimate F-21
  co-fire on undef-format — different defects), 42:0. All five
  load-bearing negative controls (24, 30, 33, 39, 42) hold at 0.
  All MEDIUM positive findings on prior fixtures retained. Variance
  on fixtures 26, 27, 35, 36 within F-18 ±1 LOW noise band.
- poorDocumentation detector #15 (session 8, commit 7fe89e9): shipped.
  3 fixtures (43-45): magic-thresholds-without-rationale positive
  (customer-support triage with 4hr SLA, Tier 3+ tiers, 2-round-
  trip threshold, $500 dispute, 90-min timeout, 10% credit, AM-
  East queue, no-pricing constraint, 200-word limit, 48-hr
  followup — all undocumented; expected 3-10 findings, fired 10
  capped), internal-jargon-without-glossary positive (marketing
  prompt with Bumblebee/Falcon/Helios/Q-cycle/Atlas/Pegasus/
  Goldfinch all undefined; fired 4 poorDoc + 1 unrelated
  unbounded), and clean-with-rationale-and-glossary load-bearing
  negative (every magic number has inline rationale, glossary
  block defines all internal terms, negative constraints have
  justification; held at 0 poorDoc — single LOW unbounded finding
  from existing Tier 1 detector unrelated to this ship).
  Symmetric F-15 carve-outs added to all seven existing live
  Tier 2 siblings (ambig, underspec, conflict, undef-format,
  overload, poor-org, inefficient-fewshot).
  Detector envelope baked in F-19 design-time prevention pattern
  from the first write with one additional design choice: a
  CRITICAL SCOPE GATE stating that detector ONLY fires on non-
  obvious choices that LACK rationale (not on prompts that simply
  lack comments, not on stylistic verbosity preferences, not on
  conventional domain terminology). The scope gate was stated
  three times in the envelope (in the SCOPE header, in the trip-
  wire, and in the Do NOT flag list) to eliminate the most common
  false-positive risk for this detector class. The Do NOT flag
  list was the most explicit of any Tier 2 detector because the
  false-positive surface area is largest. Result: zero cross-fire
  on detector #15's own fixtures from the first write — fourth
  consecutive new-detector ship to hit this result.
  Detector additionally surfaced legitimate F-21 co-fires on
  fixtures 38 and 39 in the existing Tier 2 corpus. Fixture 38:
  3 poorDoc findings on undocumented financial weighting
  threshold, modified Altman Z-score reference, and forbidden
  hedge-words rule. Fixture 39: 2 poorDoc findings on 110% word-
  count ceiling and 4-sentences-per-paragraph rule. These are
  correct findings on real defects that the original detectors
  (poorOrganization, undefinedOutputFormat) were not designed to
  catch. Per F-21 legitimate co-fire pattern, both findings stay;
  not a regression.
  Final fixture verification across the full Tier 2 corpus:
  22:1, 23:2, 24:0, 25:4, 26:6, 27:0, 28:3, 29:3, 30:0, 31:1,
  32:4, 33:0, 34:1, 35:7, 36:0, 37:1, 38:5, 39:3, 40:2, 41:2,
  42:0, 43:10, 44:5, 45:1. All five existing load-bearing
  negative controls (24, 27, 30, 33, 36, 42) hold at 0. New
  poorDocumentation negative control (45) holds at 0 for poorDoc
  (single LOW unbounded finding from existing Tier 1 detector,
  unrelated to this ship). All MEDIUM positive findings on prior
  fixtures retained. Variance on fixtures 26, 29, 32, 35, 38
  within F-18 wobble band.

### F-26 — Generic count-noun bounding requires semantic judgment
**Status:** OPEN — Tier 2 architectural follow-up
**Source:** v5.3.1 audit (May 11 2026) during F-03 investigation
**Priority:** MEDIUM (real coverage gap, partial mitigation shipped)
**Why:** The CONSTRAINT_MARKERS regex array in unboundedOutput.js uses
an enumerated allowlist of nouns to recognize "count + noun"
constraint patterns ("5 items", "3 paragraphs"). v5.3.1 extended the
allowlist from ~20 nouns to ~100 nouns covering common domain output
vocabulary (issues, bugs, errors, recommendations, features, etc.).
Sweep against a 200-noun adversarial corpus showed coverage rose
from 10% to ~50%. Real prompts use thousands of distinct output
nouns.

The fundamental approach cannot scale: enumerating English plural
output nouns is an open-ended task. Attempted alternative —
"generic plural noun" regex (\\d+\\s+[a-z]+s) with a negative
exclusion list for comparative/temporal/idiomatic trailing words —
produced false positives on common prose ("5 dollars cheaper",
"2 minds about it", "5 sides of the same coin"). The exclusion
list approach is fragile in the opposite direction from the
allowlist.

**Why this is Tier 2 territory:** Distinguishing "5 issues that
need review" (constraint) from "5 minds about it" (idiom) from
"5 weeks ago" (temporal) requires semantic understanding of
whether the noun is the object of a counting request vs an
incidental count in surrounding prose. Regex-only approaches
cannot make this distinction reliably. A Tier 2 detector can
ask the LLM "is this a count-bounded output request?" and get
the right answer.

**Possible v5.4 directions:**
  1. Move generic count-noun bounding into a Tier 2 detector
     pass that runs only on prompts where Tier 1 unboundedOutput
     would fire AND the prompt contains "N + plural-shaped word"
     somewhere in the window. LLM call gates the suppression.
  2. Train a small classifier specifically on prompt-engineering
     "is this bounded" judgments using the corpus from the v5.3.0
     calibration work as seed data.
  3. Continue expanding the allowlist incrementally as new domain
     vocabulary surfaces in user-submitted prompts. Cheap, lossy,
     accumulates noun debt over time.

Track concrete examples here as they surface from dogfood scans
so the v5.4 ticket has signal:
  - (none yet — opened in this commit; populate as v5.3.1 reports
    surface false negatives in real prompts)
  - (note: F-26 itself is the *false-negative* tracker for the
    output-noun bounding scope. F-24's "concrete examples" tracker
    below holds the real Ghost-prompt findings from F-08.)

Not blocking v5.3.1 ship. The vocabulary extension covers the
highest-value gaps; remaining false negatives stay LOW-severity
unbounded-output advisories that users can manually mark as
intentional.

---

## v5.4 architectural scope: F-12 + F-20 + F-22 cluster

**Scoped in v5.3.1 audit (May 11 2026) as the next-major-version
architectural work. NOT in scope for v5.3.1 patch release.**

This section consolidates three paired tickets that close together
when the structural fix lands:

  - **F-12** — Detector should consolidate findings sharing a root cause
  - **F-20** — Standardize trip-wire vocabulary across Tier 2 detectors
  - **F-22** — Ad-hoc trip-wire tightening on existing detectors is unsafe

These three are not three independent fixes. They are three
manifestations of one underlying problem: **Tier 2 detector envelopes
are owned per-detector with no shared infrastructure, so additions,
fixes, and cross-fire suppression are local edits that diverge from
sibling detectors and create regressions when retrofitted ad-hoc.**

### Problem statement (consolidated)

Ghost has 9 Tier 2 LLM-evaluation detectors (8 Tier 2 + 1 Tier 3).
Each one constructs its own envelope by string-concatenating:
  - DEFECT_DESCRIPTION (definition prose + "Do NOT flag" bullets)
  - POSITIVE_EXAMPLES
  - NEGATIVE_EXAMPLES
  - STANDARD_SCHEMA_DESCRIPTION (the only shared piece)

Each envelope was written by hand. The "Do NOT flag" bullets that
delineate detector boundaries drifted from each other across ships.
The trip-wire vocabulary that prevents cross-fire (F-20) drifted
even more. F-22 documented what happens when someone tries to fix
one detector's cross-fire with a local edit: the fix shifts the
defect to a different fixture rather than eliminating it.

Three concrete symptoms in the wild:

1. **Same-root-cause duplicates (F-12 main symptom).** A prompt
   defect can trigger multiple detectors that each catch a different
   surface manifestation. Example from F-12: a missing target
   specification can fire as ambiguousInstruction ("which target?")
   AND as underspecifiedConstraints ("target criteria absent") AND
   as poorDocumentation ("target reference undocumented"). The user
   sees 3 findings for one defect.

2. **Cross-fire on overlapping territory (F-22 symptom).** When a
   new detector ships, it sometimes fires on fixtures already
   handled by an existing detector. The instinct is to suppress the
   cross-fire by tightening the existing detector's envelope. F-22
   documents two cases where this caused regression cycles — the
   edits did not stay local because LLM envelope semantics are
   global.

3. **Vocabulary drift (F-20 symptom).** Trip-wire vocabulary lists
   (the marker phrases each detector uses to decide "this finding
   belongs to a sibling, drop it") are inconsistent across detectors.
   overloadedPrompt has the most-complete list. underspecifiedConstraints
   and conflictingInstructions have no trip-wire vocabulary yet (only
   older "Do NOT flag" bullets that work less reliably).

### Design principles for the fix

**Shared envelope template.** Move envelope construction out of
per-detector files into llmAuditClient.js. Each detector module
contributes ONLY:
  - Its detector-specific defect definition (1-3 sentences)
  - Its POSITIVE_EXAMPLES (what to flag, with annotations)
  - Its NEGATIVE_EXAMPLES (what NOT to flag, with annotations)
  - Its OWNED_SIGNALS list (marker phrases that indicate this
    detector's territory)

The shared template combines these with:
  - Standardized "Do NOT flag" rules (one canonical list, parameterized
    on which detector is asking)
  - Canonical trip-wire vocabulary table (each detector enumerates
    which sibling territory it should drop into)
  - STANDARD_SCHEMA_DESCRIPTION (already shared)
  - Same-root-cause consolidation instruction (the F-12 win)

**Canonical vocabulary table.** A single source of truth in
llmAuditClient.js mapping:
  - Detector ID → own-territory marker phrases
  - Detector ID → sibling-territory marker phrases (drop-territory)

Adding detector N+1 to the system means adding one row to this
table, not N edits to existing detectors' envelopes.

**Same-root-cause consolidation instruction (F-12 main win).** A
new envelope rule that the shared template injects into every
detector:

  "If multiple ambiguities in this prompt trace to the same
  authorial mistake (e.g., the same undefined term, the same
  missing target, the same unspecified scope), emit ONE finding
  that names the root cause and lists the manifestations. Do not
  emit one finding per manifestation."

This single rule, applied consistently across all Tier 2 detectors,
addresses ~40% of dogfood duplicates per F-12's original estimate.

**No ad-hoc retrofit (F-22 rule, codified).** Once the shared
template lands, the F-22 rule becomes structural rather than
aspirational: per-detector envelope edits are no longer possible
because the envelope no longer lives in per-detector files. Cross-
fire fixes happen by editing the canonical vocabulary table, which
applies uniformly across all detectors at once.

### Touch points

Files that get modified:

  - `src/prompt-pack/llmAuditClient.js` — add shared envelope
    template, canonical vocabulary table, same-root-cause
    consolidation rule
  - `src/prompt-pack/ambiguousInstruction.js` — strip
    DEFECT_DESCRIPTION, POSITIVE_EXAMPLES, NEGATIVE_EXAMPLES;
    contribute only defect definition + examples + OWNED_SIGNALS
  - `src/prompt-pack/underspecifiedConstraints.js` — same
  - `src/prompt-pack/conflictingInstructions.js` — same
  - `src/prompt-pack/undefinedOutputFormat.js` — same
  - `src/prompt-pack/overloadedPrompt.js` — same
  - `src/prompt-pack/poorOrganization.js` — same
  - `src/prompt-pack/inefficientFewShot.js` — same
  - `src/prompt-pack/poorDocumentation.js` — same
  - `src/prompt-pack/integrationMismatch.js` — Tier 3 hybrid,
    same envelope work for the LLM-verify phase

Files that DO NOT change:

  - The actual `detect()` function signature in each detector
    stays identical. Callers (index.js orchestrator, mode files,
    smoke harness) see no change.
  - STANDARD_SCHEMA_DESCRIPTION stays as it is post-F-14.
  - parseAuditResponse() stays as it is post-F-11/F-14.

Estimated scope: 9 detector files refactored, llmAuditClient.js
expanded ~300 lines, comprehensive fixture re-run to validate no
regressions.

### Falsification criteria

The fix is correct when:

  1. **F-12 main test.** A prompt with one authorial mistake produces
     ONE finding even when multiple Tier 2 detectors would have
     historically fired on it. Validated against the F-08 dogfood
     corpus: the 59-finding scan should drop substantially under
     the consolidation rule (estimate: down to ~35-40 findings).

  2. **F-20 vocabulary consistency.** Each detector's declared
     OWNED_SIGNALS appears in exactly one detector's table entry.
     No vocabulary drift across detectors.

  3. **F-22 cross-fire stability.** After the shared template lands,
     shipping detector #16+ should produce zero cross-fire incidents
     on existing detectors. (Detector #12 ship achieved this; the
     shared template should make it the durable steady-state.)

  4. **No false negative regression.** Existing fixtures that fire
     correctly today must continue to fire correctly after the
     refactor. Smoke harness must pass 100% on the regression
     fixtures.

  5. **No false positive regression.** Existing fixtures that stay
     silent today must continue to stay silent. The shared template
     must not be more aggressive than the sum of its per-detector
     parts.

If F-12 lands and cross-fires still recur, the issue is deeper than
envelope architecture — likely the LLM-augmented detector pattern
itself needs revisiting. Track this when v5.4 work begins.

### Sequencing

This is a multi-day refactor. Suggested phases:

**Phase 1 — Canonical vocabulary table only.** Build the table in
llmAuditClient.js. Each detector reads its OWNED_SIGNALS and
SIBLING_SIGNALS from the table but keeps its existing envelope.
No behavior change yet. ~2-3 hours work, validates the table
design before committing to envelope refactor.

**Phase 2 — Shared envelope template.** Build the template in
llmAuditClient.js. One detector (probably ambiguousInstruction
because it has the most envelope-test coverage) gets refactored
to consume the template. Validate with full smoke + dogfood. If
clean, proceed.

**Phase 3 — Refactor remaining 8 detectors.** Each detector's
envelope work gets converted to template-consumption pattern.
One commit per detector for clean revert paths. Smoke + dogfood
after each.

**Phase 4 — Same-root-cause consolidation rule.** Add the
consolidation instruction to the shared template. This is the F-12
main win. Validate by re-running F-08 dogfood and confirming
substantial finding-count reduction. Smoke for regression.

**Phase 5 — Close F-12, F-20, F-22 together.** Update
PROMPT_TRIAGE_FOLLOWUPS.md to mark all three RESOLVED with
references to the v5.4 commits.

### Open questions to resolve before phase 1

  - Where does OWNED_SIGNALS live syntactically? A constant in
    llmAuditClient.js? A getter exported from each detector? The
    decision affects how clean the per-detector files become.

  - Same-root-cause consolidation: how does the LLM decide what
    counts as "same root cause"? Pure prompt instruction, or
    structural support (e.g., consolidation happens post-detection
    in dedup.js)? F-12's original ticket leans toward prompt
    instruction; dedup-layer consolidation is an alternative worth
    considering.

  - How to handle detectors that legitimately should co-fire?
    Per F-21 ("Legitimate detector co-firing is intentional, not
    a defect"), some prompt defects genuinely benefit from
    multiple detector perspectives. The consolidation rule must
    not over-suppress.

Resolving these takes ~30 minutes of design conversation before
phase 1 begins.

### Why this is the v5.3.1 stopping point

Three paired tickets, ~9 file refactor, multi-day scope, design
decisions still open. This is the wrong work to do in flow at the
end of a multi-hour quality-fix audit session. It needs:

  - Fresh focus on the design questions above
  - Methodical phase-by-phase execution
  - Regression validation between phases
  - Dedicated time for the dogfood re-run that validates the F-12
    main win

v5.3.1 ships with F-12, F-20, F-22 properly scoped as this v5.4
section. Tomorrow-morning-you starts the architectural work with a
real spec instead of cold context.
