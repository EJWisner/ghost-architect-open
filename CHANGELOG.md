# Changelog

All notable changes to Ghost Architect™ are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to semantic versioning.

### v9.4.34
- @ghost-verified annotation added to tokenizer.js countTokensExactImpl delegation -- Gemini/unknown cache-namespace isolation is an intentional performance trade-off, not a conflict
- SELF_REFUTING_RE extended with two new patterns: "not a runtime failure" and "performance issue, not a correctness" -- post-generation filter now catches self-refuting findings that slip past the prompt-side DO NOT FLAG rule

### v9.4.33
- tokenizer.js: fixed countTokensExact OpenAI delegation -- now calls countTokensImpl() directly instead of countTokens() to keep 'fast' and 'exact' cache namespaces genuinely isolated; removed dead resolveApiKey import
- Conflict Detection prompt: added self-refuting DO NOT FLAG rule -- findings that self-describe as "no current runtime failure", "no runtime impact", "correct behavior", or "redundancy rather than a conflict" are now suppressed at generation
- Prompt snapshots regenerated to match updated conflict prompt

### v9.4.32
- @ghost-verified annotation added to src/modes/prompt-triage.js import block -- confirmed false positive, all four functions (estimateMultiCallCost, formatCost, formatCostRange, calcActualCost) are correctly exported from src/core/estimator.js and imported directly; src/estimator.js barrel shim gap is latent, not live

### v9.4.31
- Finding lifecycle tracking: Ghost Watcher now computes a resolved/new delta on every run -- findings that disappear after a fix are marked Resolved in the portal with the commit they were fixed in; new findings are tracked as first-seen this commit. Branch-filtered so multi-branch repos stay clean.
- Ghost Portal: Resolved findings section added to Watch tab findings view (both portal-template.html and portal-ejwisner.html) -- collapsible green section showing fixed findings with commit reference
- verifiedFindings now written to STATE file -- closes gap where @ghost-verified findings disappeared from portal on state-only commits
- __GHOST_VERSION__ placeholder replaces brittle version-literal .replace() in enableWatch() -- eliminates silent desync risk on future releases
- claude-fable-5 added to temperature guard (sampling-params.js) and pricing table (estimator.js -- $10/$50 per million tokens)
- Pricing table completed: claude-opus-4-8 and claude-opus-5 added at $5/$25 per million tokens
- Wrangler upgraded to 4.106.0 (global)

### v9.4.30
- @ghost-verified annotation added to `src/license/clock.js` CLOCK_STATE_KEY (confirmed false positive -- no collision risk in scoped Conf namespace)
- GitHub Actions template updated to Node.js 24 (eliminates Node 20/22 deprecation warnings on CI runs)
- Conflict Detection JSON repair extended with two new tiers: trailing-comma sweep (Repair 4) and trailing-comma plus truncation combined (Repair 5) -- catches "Expected ',' or '}'" parse errors from model output
- Conflict Detection prompt tightened: speculation hard-suppressed at generation (DO NOT FLAG, CONFIDENCE RULE, SEVERITY RULE all updated to eliminate LOW carve-out for hypothetical findings)

## [9.4.29] - 2026-07-01

### Fixed
- **README blast_radius example.** The ghost-watcher.yaml example in README.md now shows the object form with enabled flag and skip_if_message_contains patterns. The plain boolean form silently omits the release-commit blast skip behavior added in v9.4.28.

## [9.4.28] - 2026-07-01

### Fixed
- **Blast radius skip on release commits.** ghost-watcher.yaml and buildWatchConfig now skip blast radius when the commit message starts with a version prefix (v9., v10., v11.). Release commits produce blast impact-analysis noise rather than actionable findings. Conflict Detection and Ghost Brief still run on all commits.
- **blast_radius config object form.** buildWatchConfig now emits blast_radius as an object with enabled flag and skip_if_message_contains patterns instead of a plain boolean. Regenerating ghost-watcher.yaml no longer reverts the skip config.
- **enabled:false object form wired.** All three blast_radius guard sites in watcher-commit.js now check blast_radius?.enabled !== false in addition to blast_radius !== false, so an object-form config with enabled:false correctly disables blast.
- **@ghost-verified annotations.** Added for corrected-file-generator 'ensures' prose filter (syntaxChars guard already protects real code lines) and batch-store Configstore split-access (different keys, atomic writes, non-racing paths).

## [9.4.27] - 2026-07-01

### Fixed
- **blast-multipass errored result handling.** The batch synthesis results loop now explicitly checks for result.type === 'errored' and throws with error details. Previously a failed synthesis batch request silently returned an empty report string with no error surfaced, causing a blank report to be saved to disk.
- **@ghost-verified annotations.** Added 4 annotations for confirmed false positives: getSamplingParams batch params shape, onUsage null-default guard, batch-submit formatClockTime import, getBranding logo_path consistency.

## [9.4.26] - 2026-07-01

### Fixed
- **Blast narrator streaming eliminated.** Ghost Watcher now calls narrateReportSync instead of narrateReport for blast narration. narrateReportSync uses messages.create (blocking, non-streaming) which has no streaming connection drop exposure. Removes the 180s timeout wrapper and retry logic that caused degraded-run emails on CI networks. The degraded-run fallback (raw findings + customer email) is preserved for genuine API failures.
- **blast-multipass synthesis batch.** The multi-pass blast synthesis call in blast-multipass.js converted from messages.stream to batch API (submit + poll). Consistent with how Blast Radius and Conflict Detection already operate. No client-side timeout risk.

## [9.4.25] - 2026-07-01

### Fixed
- **SELF_REFUTING_RE extended.** The self-refuting conflict filter now catches model-generated self-negations with adjectives between key words (e.g. 'not a concrete runtime conflict', 'no concrete failure path', 'no active cross-file call path exists'). Previously the regex required adjacent words and missed these phrasings. Five new test cases added to self-refuting-filter.smoke.mjs. Both the production regex in watcher-commit.js and the replicated copy in the smoke test are kept in sync.

## [9.4.24] - 2026-07-01

### Fixed
- **corrected-file-generator syntaxChars.** Added single and double quotes to the syntaxChars regex. Previously a patch line like `case 'foo':` ended with colon and had no recognized syntax chars, causing it to be incorrectly stripped as a prose header. Switch-case labels in patch instructions are now preserved correctly.
- **Workflow template version.** watch/index.js now replaces the hardcoded "version":"9.0.15" string in the fallback telemetry payload alongside the existing @latest replacement. Cancelled or failed Ghost Watcher runs now report the actual CLI version instead of 9.0.15.
- **dedup.js selectKeepers consistency.** GENERAL_DETECTORS rank lookup now uses both full detector ID and baseId (split on '/'), matching the behavior of classifyDetector. Prevents incorrect rank-99 fallback if a general detector ever emits a slash-suffixed ID.
- **dedup.js annotations.** Added @ghost-verified annotations for injectionStaticPattern slash-suffix comment and formatting/roleSeparation sub-detector classification notes.

## [9.4.23] - 2026-07-01

### Fixed
- **dedup.js GENERAL_DETECTORS restored.** Reverted the v9.4.21 promotion of ambiguousInstruction and underspecifiedConstraints to SPECIFIC_DETECTORS. The detector source files explicitly document these as less-specific fallbacks (ambiguousInstruction defers to conflictingInstructions on overlap). Promoting them to SPECIFIC caused selectKeepers() to emit both findings on overlap, producing duplicate signal. They are now correctly back in GENERAL_DETECTORS at ranks 1 and 2.
- **poi.js empty-scan payload.** Added @ghost-verified annotation to the intentionally-minimal publish payload in the no-local-save branch. buildPublishPayload fallbacks handle the absent fields correctly for zero-finding scans.

## [9.4.22] - 2026-07-01

### Fixed
- **projects.js scanRecord fields.** saveProjectIntelligence now writes all fields that buildPublishPayload reads at the top level of the scan record: resolved, reportText, version, txtFile, mdFile, pdfFile, newFindings (sourced from meta). Previously these were undefined when a scan record was loaded from disk, causing the mobile dashboard to show zero findings, zero severity counts, and empty finding lists.
- **diff-renderer verified.** computeUnifiedDiff @@ line number calculation confirmed correct via multi-hunk test. Separator-skipped lines are correctly applied via aLine += h.skipped before the next hunk flushes. @ghost-verified annotation added.
- **prompts-extracted snapshots.** Conflict detection snapshots (06-conflict-default.md, 07-conflict-with-profile.md) regenerated to reflect the v0.4 prompt content (STRICT REQUIREMENT, DO NOT FLAG, CONFIDENCE RULE sections).

## [9.4.21] - 2026-07-01

### Fixed
- **mobile-publish findingCount.** buildPublishPayload now reads findingCount and severity counts from scanRecord.meta fallback. Mobile portfolio dashboard no longer shows zero findings.
- **MODE2_THRESHOLD constant.** Extracted magic number 0.70 to named constant in corrected-file-generator.js.
- **analyst/index.js temperature guard.** All stream calls now use getSamplingParams instead of hardcoded temperature values.
- **dedup.js SPECIFIC_DETECTORS.** Promoted ambiguousInstruction and underspecifiedConstraints to SPECIFIC; removed their stale GENERAL_DETECTORS entries.
- **tokenLimit mayUseNetwork flag.** tokenLimitContextOverflow and tokenLimitExcessive registry entries now carry mayUseNetwork: true.
- **Conflict Detection prompt v0.4.** Tightened to require concrete runtime impact before flagging. Added STRICT REQUIREMENT list, DO NOT FLAG list, per-category runtime qualifiers, and CONFIDENCE RULE. Reduces false positive noise significantly.
- **@ghost-verified annotations.** Added 7 annotations for intentional design decisions that were recurring as false positives: capSeverity policy split, estimator dual-path import, compare.js keepLandmarks, enrichFindingsWithPrompts export, onUsage stage drop, fix_direction two-value confidence, audit/index.js CLI layer imports.
- **Portal degraded-run banner.** Now shows the affected commit short SHA(s) so customers know exactly which commit had the narrator failure.

## [9.4.20] - 2026-07-01

### Fixed
- **Narrator failure email.** When the blast narrator times out, Ghost Watcher now sends a degraded-run notice email instead of raw unnarrated blast findings. Customers see a clear message to rerun rather than confusing impact-analysis output.
- **Blast narrator timeout.** Increased from 90s to 180s to reduce timeout frequency on CI runners.
- **extractCandidates JSON escape repair.** Added a second repair tier that sanitizes invalid backslash escape sequences before falling back to dropping the fence. Recovers partial conflict results from responses containing regex patterns or other non-standard escapes.
- **dogfood detector IDs.** Replaced stale 'length/excessive' with 'tokenLimitExcessive' in audit-reports/dogfood-2026-05-11.json.
- **watcher-batch.js preflight.** preflightBatchCheck now spreads getSamplingParams into the preflight request for consistency with actual batch requests.
- **Portal commit ID filter.** Findings and Prompts tabs now show commit selector pills when multiple commits are in the date range. Selecting a commit scopes both tabs to that commit's data. Implemented in both portal-ejwisner.html and portal-template.html.
- **pulse-stats Cache-Control.** Removed Cloudflare Cache API layer from handlePulseStats and set Cache-Control: no-store so every request hits the live worker. Eliminates the edge-cache delay after signup-worker deploys.

## [9.4.19] - 2026-07-01

### Fixed
- **tokenLimit detector IDs.** tokenLimitContextOverflow and tokenLimitExcessive now emit camelCase detector fields matching the registry id and SPECIFIC_DETECTORS set. The slash-format IDs ('tokenLimit/contextOverflow', 'tokenLimit/excessive') caused classifyDetector() to return 'orthogonal' instead of 'specific', defeating dedup suppression.
- **corrected-file-generator Mode 2N guard.** tryMode2N now returns null for signature-shaped patches, deferring to the Mode 1 fallback instead of inserting a method body without its signature before the class closer.
- **reports.js confidence rescale removed.** The stale float-detection branch (<=1 → ×100) was removed. findingsFromResults has produced 0-100 integers since v9.4.14; the branch was dead code with an edge-case risk of misreading 1% confidence as 100%.
- **extractCandidates JSON truncation repair.** When a conflict batch response is truncated at max_tokens mid-JSON, extractCandidates now attempts a repair (closing open structures with ']}') before falling back to dropping the fence. Recovers partial results from truncated chunks.
- **dogfood-2026-05-11.json updated.** All 6 stale 'output/unbounded' detector ID references replaced with 'unboundedOutput' to match the v9.4.17 rename.

## [9.4.18] - 2026-07-01

### Fixed
- **integrationMismatch cap comment.** Updated JSDoc to reflect FINDINGS_CAP = 10, correcting the stale "5 per prompt" documentation left over from v9.4.17.
- **buildWatchConfig iterations opt-in.** maxIterations now defaults to null; the iterations block is only emitted when a caller explicitly passes a value. Previously the wizard baked a hidden iterations.max: 5 into every generated ghost-watcher.yaml, silently capping new Watch repos at 5 iterations despite v9.3.7 documenting that no config = no limit.

## [9.4.17] - 2026-06-30

### Fixed
- **unboundedOutput detector ID.** Changed emitted detector field from 'output/unbounded' to 'unboundedOutput' to match the dedup.js SPECIFIC_DETECTORS registry. The mismatch caused classifyDetector() to return 'orthogonal' instead of 'specific', so general findings were not suppressed as intended when unboundedOutput fired on the same range.
- **buildTokenUsage model.** Now accepts an optional model parameter defaulting to getWatcherModel() instead of a hardcoded 'claude-sonnet-4-6'. Cost estimates in the portal now reflect the actually-configured model.
- **integrationMismatch FINDINGS_CAP.** Changed from 5 to 10 to match all sibling Tier 2/3 detectors and prevent premature truncation.
- **tokenLimit tier labels.** Both tokenLimitContextOverflow and tokenLimitExcessive JSDoc sub-headings updated from 'Tier 2 / hybrid' to 'Tier 1 / hybrid' to match the registry and the one-line headers corrected in v9.4.15.
- **Telemetry privacy.** Removed the raw /tmp/ghost-watcher-telemetry.json temp file write that stored unhashed commitHash and repoHash. The pingWatcherRun() call (which hashes identifiers internally) is the sole telemetry path.

## [9.4.16] - 2026-06-30

### Fixed
- **Shared sampling-params utility.** Extracted getSamplingParams, modelRejectsTemperature, MODELS_WITHOUT_TEMPERATURE, and MODEL_PREFIXES_WITHOUT_TEMPERATURE into src/utils/sampling-params.js. narrator.js, watcher-commit.js, blast-multipass.js, and extractor.js all import from this single source -- eliminates three divergent copies and ensures all API callers correctly strip temperature for Sonnet 5 / Opus 4.7 / 4.8.
- **mobile-publish estimatedHours/Cost fallback.** buildPublishPayload now reads from scanRecord.meta.totalHours/totalCost when the top-level fields are absent, so the mobile app correctly shows cost estimates instead of always displaying dashes.
- **corrected-file-generator Heuristic 1.** Colon-terminated lines are now only stripped as prose headers when they contain no syntax characters -- switch-case labels, TypeScript annotations, and goto labels are preserved.
- **conflict.js dead guard removed.** Unreachable SESSION_PREFIX throw removed; _sessionType check is the sole collision guard.
- **enterprise.js getFileParsed.** Renamed getFileContent to getFileParsed to distinguish from getFileWithSha and prevent future confusion.
- **verifier.js LINE_NUMBER_RE tightened.** Now requires explicit line/lines keyword or file:N pattern -- cost ranges and effort ranges no longer produce false line-number citations.

## [9.4.15] - 2026-06-30

### Fixed
- **src/watch/index.js parseRepo.** Replaced naive github.com-only parseRepo with GHES-aware import from team-sync.js -- the last remaining naive parser in the codebase.
- **resolveContextCap default message.** Warning no longer references --max-context when the source is 'default' (user never passed that flag).
- **wizard.js dead import.** Removed unused import YAML from wizard.js.
- **capSeverity docstrings.** poorOrganization, poorDocumentation, inefficientFewShot docstrings corrected to reflect intentional HIGH→MEDIUM policy rather than stale v5.3 cap-removal claim.
- **corrected-file-generator docstring.** Prose-word list in cleanPatchInstruction header comment aligned to the actual current regex.
- **prompts-extracted snapshots regenerated.** Conflict prompt snapshots (06-conflict-default.md, 07-conflict-with-profile.md) now reflect current JSON output format instead of stale markdown format.

## [9.4.14] - 2026-06-30

### Fixed
- **portal-publish.js parseRepo.** Replaced naive github.com-only parser with robust GHES-aware import from team-sync.js.
- **Shared Anthropic client.** tokenizer.js delegates to llmAuditClient.js getAnthropicClient() -- single singleton, shared failure state.
- **capSeverity HIGH enforcement.** poorOrganization, poorDocumentation, inefficientFewShot now clamp HIGH to MEDIUM at code level.
- **corrected-file-generator prose filter.** Removed before/after/it/the/to/in from prose list; added =<> to syntaxChars.
- **blast-multipass API key.** Uses resolveApiKey() + Sonnet 5 sampling guard.
- **Audit confidence scale.** findingsFromResults.js corrected from 0..1 float to 0-100 integer.
- **Dashboard severity null.** buildDashboardSidecar severity fallback changed to null.
- **dedup dead entry.** Removed stale injection/static-pattern legacy detector ID.
- **Conflict prompt barrel import.** watcher-commit.js imports through prompts/index.js.
- **tokenLimit tier labels.** File headers corrected to Tier 1.
- **skipTiers docs.** runAll updated to note Tier 1 token detectors may make API calls.
- **upsertFile encoding contract.** Normalized across portal-publish.js, mobile-publish.js, team-sync.js, enterprise.js -- all use shared encodeFileContent helper (Buffer/string/object-aware).
- **loader fileMap refactor.** buildContext no longer reassigns the fileMap parameter -- introduced activeFileMap for clarity.
- **Conflict session prefix hardened.** SESSION_PREFIX changed to conflictscan-- to prevent namespace collision with POI sessions.
- **SessionCostTracker stage tracking.** record() accepts optional stage param; getSummary() exposes byStage cost breakdown.
- **getSamplingParams explicit allowlist.** Replaced fragile substring matching with MODELS_WITHOUT_TEMPERATURE set and prefix list in narrator.js and watcher-commit.js.
- **codemaseRoot test fixture.** Fixed typo in test/ghostBrief.test.mjs.

## [9.4.13] - 2026-06-30

### Fixed

- **GitHub Enterprise Server URL parsing.** enterprise.js and mobile-publish.js now use robust parseRepo from team-sync.js (handles GHES hosts, subpaths, SSH URLs).
- **Dashboard remainingFindings slice bug.** buildDashboardSidecar slice(count-as-index) replaced with explicit zero-guarded tail slice; Jira export no longer dumps all findings when a project is 100% resolved.
- **storePendingBatch SHA conflict retry.** Concurrent runs no longer drop pending batch entries on 409 SHA mismatch.
- **Conflict detection separate POST per chunk.** Each conflict chunk now submits as its own batch POST (sub-900KB), eliminating the 2.41MB combined body that caused hung batches.
- **Cancel handler.** ghost --watcher-cancelled added; GitHub Actions cancel step pushes status:cancelled to portal so stuck ANALYZING state resolves instead of spinning forever.
- **Sonnet 5 / Opus 4.7 / 4.8 compatibility.** getSamplingParams guard strips temperature from all API calls when using models that reject sampling parameters. claude-sonnet-5 added to pricing table.
- **14 conflict-finding cleanups.** getModel renamed to getWatcherModel; stale cap-at-MEDIUM docstrings updated; injectionStaticPattern detector ID standardized; session type discriminator added to conflict.js; slugifyLabel consolidated to shared slugify; MODE_OUTPUT_ESTIMATES forecast modes added; pingWatcherRun JSDoc corrected; trial tier cross-reference comment added; resolveContextCap default source fixed; getFileContent return shape normalized in mobile-publish.js; compare.js keepLandmarks documented; sampling-params and conflict-chunking smoke tests added.

## [9.4.12] - 2026-06-30

### Fixed

- **Conflict Detection batch chunking.** Large codebases (>900 KB serialized context) are now split into multiple sub-900 KB batch requests instead of one 2.40 MB POST that caused CI network drops and hung batches. All chunk results are merged via `extractCandidates` before the verifier pass -- no findings dropped. `chunkFileMapForConflict` regression test added and wired into the npm test chain.

## [9.4.11] - 2026-06-30

### Fixed

- **Blast narrator retry on CI connection drops.** Added 90-second timeout and one automatic retry to the narrator streaming call in `blastFindingsFromRaw`. Transient "Premature close" errors now get a second attempt before falling back to raw findings.
- **Degraded-run transparency.** `narratorFailed: true` flag added to the portal findings payload when narrator fallback fires. Portal Watch tab now shows an amber warning banner ("Degraded Results on N Commits") with a rerun link when any commit in the filtered set has degraded findings. Applied to both `portal-ejwisner.html` and `portal-template.html`.
- **Widened self-refuting conflict filter.** `SELF_REFUTING_RE` now catches "rather than a runtime conflict" and "Runtime impact: none" phrasings that the original pattern missed. Fixed `values match` clause with negative lookahead so "values match but will conflict if X changes" is correctly kept as a real finding.
- **Self-refuting filter smoke test.** `tests/self-refuting-filter.smoke.mjs` added with 16 cases (11 drop, 5 keep) + 3 edge inputs. Wired into the npm test chain.

## [9.4.10] - 2026-06-30

### Fixed

- **Finding-quality hardening for Ghost Watcher™.** Junk file tokens (bare
  version strings like `9.4.9`, paren-contaminated paths such as
  `package.json (version field 9.4.9`) are now rejected from `Files:`
  extraction in `src/utils/finding-parser.js`. Rollback-plan report sections
  (Pre-Change Snapshot, Rollback Steps, Point of No Return, Who to Notify,
  Smoke Test After Rollback) are no longer mis-parsed as findings. Self-refuting
  conflict findings (the model flags a conflict then states "no actual
  conflict" / "values match" / "consistent") are dropped before surfacing in
  `src/modes/watcher-commit.js`. Wired `tests/finding-parser.smoke.mjs` into
  the npm test chain with a regression test asserting junk tokens are rejected.

## [9.4.9] - 2026-06-30

### Fixed

- **`scanForVerified` rejects non-source files via a `SOURCE_EXTENSIONS`
  allowlist** (`.md`, `.json`, `.yaml`, `.yml`, `.txt`, `.html`) -- closes
  false-positive verified findings on documentation files that contain the
  `@ghost-verified` marker as plain text.

## [9.4.8] - 2026-06-30

### Changed

- **Documentation-only: clarified Ghost Watcher™ timeout relationship and the
  token-usage rate source.** Added a comment in `ghost-watcher.yaml` above
  `batch.timeout_minutes: 90` explaining that the batch poll timeout is the
  actual limiting factor, the 360-minute Actions job timeout only prevents
  GitHub from killing the job early, and batches exceeding the limit are
  stored and resumed on the next push. Reworded the `buildTokenUsage` comment
  in `src/modes/watcher-commit.js` to state that rates come from `getPricing()`
  multiplied by `BATCH_DISCOUNT` rather than quoting hardcoded dollar amounts.
  No behavior change.

## [9.4.7] - 2026-06-30

### Fixed

- **`codemaseRoot` typo in `lib/ghostBrief.js` dropped the codebase root for
  most callers.** `generateBrief` destructured a misspelled `codemaseRoot`
  param, so every caller passing the correctly-spelled `codebaseRoot` (all three
  Ghost Watcher™ brief calls and the dashboard brief) had its value silently
  ignored and fell back to `process.cwd()`. The param is renamed to
  `codebaseRoot`, and the two callers in `bin/ghost.js` that used the typo are
  updated, so all six call sites now agree and the real codebase root flows
  through to the brief's `codebase_root` field.

- **`@ghost-verified` self-reference trap.** `scanForVerified` matched the bare
  marker string anywhere in a file, so the feature's own implementation (the
  `MARKER` constant, the PR-comment template text, and doc comments describing
  the marker) would falsely mark `ghost-verified.js` and `watcher-commit.js` as
  "verified" when Ghost Watcher™ scanned its own repo. Detection now requires
  the marker to sit in **comment context** — the text before it must end with a
  comment opener (`// `, `# `, `-- `, `/* `), which also adds Python/SQL/CSS
  comment support — and scans every occurrence so a string-literal hit no longer
  short-circuits a real comment elsewhere. The feature's own doc comments were
  reworded so they no longer lead with the bare marker. `redactor.js`'s genuine
  annotation is unaffected. Covered by new cases in
  `tests/ghost-verified.smoke.mjs`.

## [9.4.6] - 2026-06-30

### Fixed

- **`ghost --configure-admin-token` header box now renders before the prompt.**
  The "Configure Admin Token" box was printed synchronously right before the
  masked `inquirer` prompt, but under inquirer v9's render timing the prompt
  could initialize before stdout flushed, drawing the box *after* the input. A
  one-tick event-loop yield (`setImmediate`) after the `console.log` ensures the
  header is flushed before inquirer takes over the TTY.

## [9.4.5] - 2026-06-30

### Added

- **Internal admin CLI commands for license management.** Founder-only,
  undocumented flags for operating the license worker from the CLI:
  `--configure-admin-token` (stores the admin bearer token in the local
  configstore, masked prompt), `--issue-license --tier <tier> --email <email>
  [--days <n>]` (mints a license via `/admin/issue`; runs headless when all
  flags are supplied, prompts otherwise; `--days` defaults to 365), and
  `--revoke-license --key <humanKey> [--reason <reason>]` (revokes via
  `/admin/revoke`). All hard-fail with a non-zero exit when the admin token is
  missing or inputs are invalid. Not shown in `--help`, the interactive menu, or
  the README; the security boundary is the admin token, not flag obscurity.

- **Ghost Portal @ghost-verified renderer.** The Ghost Watcher™ Findings tab now
  renders a collapsed "✅ Reviewed · Expected Behavior" section below active
  findings, populated from the scan file's `verifiedFindings[]`. Findings a
  developer marked `@ghost-verified` appear here (muted styling, no severity
  badge, optional reason) instead of cluttering the active list, and the section
  shows even when all of a commit's findings are verified.

## [9.4.4] - 2026-06-30

### Fixed

- **`trial` tier now has an explicit context cap.** `TIER_CAPS` in
  `src/loader/tierCaps.js` had no `trial` key, so a trial license fell back to
  Open's 50K via the `?? TIER_CAPS.open` default — the right value, but only by
  accident. `trial: 50000` is now explicit (trial shares Open's context cap; the
  trial upgrade adds Pro mode access, not context), with a matching
  `UPGRADE_HINTS` entry, and is locked in by `tests/tier-caps.smoke.mjs`.

- **`narrateConflictReport` temperature aligned with the report-narration
  family.** It generated prose at `temperature: 0` while every other report
  narrator (`narrateReportSync` and the render-pass functions) uses `0.3`. The
  conflict narrator is the conflict-mode sibling of `narrateReport`, so it now
  uses `0.3` for consistent prose variability. (The 0.2 planning passes and the
  deterministic executive-summary narrator are intentionally left as-is.)

## [9.4.3] - 2026-06-29

### Fixed

- **`@ghost-verified` findings no longer get Ghost Brief™ prompts.** Ghost Brief
  generation (Step 8 of the Ghost Watcher™ pipeline) built its adapted-findings
  set from the raw blast/conflict arrays, which still contained findings marked
  `@ghost-verified`. So a finding segregated out of the PR comment and scan file
  could still have a remediation prompt — and a Step 8e detailed prompt —
  generated for it, partially defeating the annotation. Both the brief input and
  the Step 8e `detailById` map now derive from the active finding set
  (`allFindings`), so verified findings are excluded end to end.

### Changed

- **`MAX_TIERS` in `bin/ghost.js` now derives from policy, eliminating gate
  drift.** A new `allowedTiers(gateId)` helper in `src/license/tier-gates.js`
  returns the tiers a gate allows (verdict `=== true`). `bin/ghost.js` now sets
  `MAX_TIERS = allowedTiers('mode:ghost-brief')` instead of a hardcoded array,
  so the Ghost Brief / Executive Brief gate can no longer diverge from the
  `TIER_POLICY` source of truth (the exact drift fixed in 9.4.1).

- **`test-loop-api-error.js` now runs in CI.** The agent-loop API-error test
  lived at the repo root and was never part of the `npm test` chain. It is moved
  to `tests/` and wired in as the final test, so the loop's `ok`/`apiError`
  result contract is now covered.

## [9.4.2] - 2026-06-29

### Fixed

- **GitHub Actions job timeout no longer cuts off long Ghost Watcher™ runs.**
  The Actions job `timeout-minutes` was raised to 360 (GitHub's 6-hour maximum)
  in both the generator template (`src/watch/github-actions-template.yml`) and
  the live workflow (`.github/workflows/ghost-watcher.yml`). The template was
  set to 20 minutes and the live workflow to 90 — the latter matched the batch
  poll budget (`batch.timeout_minutes: 90`) exactly, leaving no headroom for
  cleanup and result write, so a large-codebase scan could be killed at the
  finish line and trigger an unnecessary incomplete-run email. The Actions job
  is now intentionally not the limiting factor: the batch poll timeout and the
  store-and-resume logic own time management, and on a batch timeout the run is
  stored and resumed on the next push, so work is never lost.

## [9.4.1] - 2026-06-29

### Fixed

- **Ghost Brief™ and Executive Brief interactive/CLI gating now Max-only,
  matching policy and docs.** Two divergent `BRIEF_TIERS` arrays in
  `bin/ghost.js` (the mode-selector menu and the `--brief` CLI handler) wrongly
  included non-Max `team` and `enterprise`, so a Team or Enterprise user could
  generate a Ghost Brief interactively or via `ghost --brief` even though the
  authoritative `mode:ghost-brief` policy in `src/license/tier-gates.js`, the
  Ghost Watcher pipeline, and the README/CHANGELOG all restrict it to the Max
  tiers (`pro-max`, `team-max`, `enterprise-max`). Both arrays are replaced with
  a single shared `MAX_TIERS` constant. The same `BRIEF_TIERS` array also gated
  the Executive Brief menu item, so this closes the identical leak there too.
  `WATCH_TIERS` is unchanged — Ghost Watcher deliberately requires Team or
  higher, a separate gate from Brief.

## [9.4.0] - 2026-06-29

### Added

- **`@ghost-verified` annotation system for Ghost Watcher™.** Developers can
  mark a finding's file as reviewed-and-accepted by dropping an in-code comment
  marker, with an optional reason:

  ```
  // @ghost-verified
  // @ghost-verified: legacy adapter is intentional, reviewed 2026-06-29
  ```

  During a watcher run, findings whose files carry the marker are segregated out
  of the active set (so they stop nagging on every commit) but are NOT dropped:
  they surface in a "✅ Reviewed · Expected Behavior" section of the PR comment
  and under a `verifiedFindings[]` key in the portal scan file, keeping the
  suppression auditable and reversible. File-level scope; a finding is verified
  when any of its files carries the marker.

  New module `src/watch/ghost-verified.js` exposes `scanForVerified()` and
  `partitionFindings()`. Detection uses `indexOf` scanning (not regex),
  mirroring the stateful PEM/cert parsers in `src/redactor.js`, so it is
  ReDoS-immune and runs on files of any size. Wired into the Step 7 merge in
  `src/modes/watcher-commit.js`; every downstream consumer (Ghost Brief,
  detailed prompts, portal push, PR comment, telemetry) operates on the active
  set unchanged. Covered by `tests/ghost-verified.smoke.mjs`.

## [9.3.9] - 2026-06-29

### Fixed

- **Max tier licenses now activate via the CLI.** The license worker
  understood the Max tiers (`pro-max`, `team-max`, `enterprise-max`), but the
  CLI's local parser and token validator did not, so `ghost --activate` on a
  Max key (e.g. `GA-2026-TMX-...`) failed with "Token must have 3 parts, got 1":
  `tryParseKey()` rejected the unknown `PMX`/`TMX`/`EMX` segment, and the key
  fell through to the signed-token path. Two fixes:
  - `src/license/format.js` now recognizes the `PMX`/`TMX`/`EMX` key codes via
    bidirectional `CODE_TO_TIER`/`TIER_TO_CODE` maps (mirroring the license
    worker), replacing the hand-rolled tier-normalization ternary. Unmapped
    codes now throw instead of silently falling through.
  - `src/license/token.js` adds `pro-max`, `team-max`, `enterprise-max` to the
    token payload's valid-tier set, so the signed token returned by the
    activation server passes local verification.

  Tier gating (`tier-gates.js`), context caps (`loader/tierCaps.js`), and
  session resolution already supported the Max tiers; only the parser and
  validator were missing.

## [9.3.8] - 2026-06-29

### Changed

- **Ghost Brief™ tier gate now enforced, Max tiers only.**
  `mode:ghost-brief` was defined in `TIER_POLICY` but never consulted,
  so every tier (including Open) could generate a Ghost Brief. The gate
  is now wired at the interactive dispatch in `bin/ghost.js` and in the
  Ghost Watcher pipeline (`src/modes/watcher-commit.js`), and the policy
  is restricted to the Max tiers: `pro-max`, `team-max`, `enterprise-max`.
  Non-Max tiers skip both the basic brief and the Step 8e detailed
  prompts, since the detailed-prompts step only re-generates the brief.

- **Redactor PEM replacement strings extracted to named constants.**
  `PRIVATE_KEY_REPLACEMENT` and `CERTIFICATE_REPLACEMENT` are now defined
  at the top of `src/redactor.js`, separated from the PEM marker strings
  in the variants array. Behavior is unchanged; redaction output is
  identical.

### Added

- **`conflict_verify` verifier wired into Ghost Watcher™.**
  When `scans.conflict_verify: true` in `ghost-watcher.yaml`, conflict
  candidates run through the same agent verifier the interactive Conflict
  mode uses, in `quick` mode (single call per candidate, headless-safe).
  CONFIRMED and POSSIBLE findings are kept; FALSE_POSITIVE and
  INSUFFICIENT are dropped before findings reach the report. Opt-in and
  default-off; with no config, conflict findings flow through unchanged.

- **`detailed_prompts` key in `ghost-watcher.yaml`.**
  Documents the existing Step 8e behavior (LLM-authored remediation
  prompts per finding) as an explicit config key, default `true`.

### Fixed

- **`buildTokenUsage` batch rates derive from the pricing table.**
  The hardcoded `$1.50`/`$7.50` per-1M batch rates in
  `src/modes/watcher-commit.js` are replaced with
  `getPricing('claude-sonnet-4-6')` standard rates from
  `src/core/estimator.js` multiplied by the `BATCH_DISCOUNT` constant in
  `src/lib/cost-estimator.js`. Computed values are identical
  ($1.50/$7.50), now sourced from the single pricing source of truth.

## [9.3.7] - 2026-06-29

### Fixed

- **Max-tier context caps.**
  Pro Max, Team Max, and Enterprise Max now correctly receive 100K,
  150K, and 200K token context caps respectively. Previously these
  tiers were absent from the canonical `TIER_CAPS` table in
  `src/loader/tierCaps.js` and silently fell back to the Open 50K
  cap, under-capping paying Max customers.

- **FREE_QUOTA duplication.**
  Removed the duplicated `FREE_QUOTA` constant from
  `src/freemium.js`; the quota now imports `SCAN_QUOTA` from
  `src/license/tier-gates.js`, the single policy source of truth.

### Changed

- **Ghost Watcher™ iteration limit is now opt-in.**
  The Step 1c iteration guard fires only when `iterations.max` is
  explicitly set in `ghost-watcher.yaml`. With no config, no limit is
  applied and Watch runs on every push. The prior hardcoded default
  of 10 is removed.

### Added

- **`shouldSkipForIterationLimit` exported pure helper.**
  The iteration-limit predicate is extracted from `runWatchCommit`
  into an exported, unit-testable function in
  `src/modes/watcher-commit.js`, with a dedicated smoke test
  (`tests/watcher-iteration-limit.smoke.mjs`). A tier-caps smoke test
  (`tests/tier-caps.smoke.mjs`) covering all seven tiers and the Open
  fallback was added alongside the cap fix.

## [9.3.6] - 2026-06-29

### Added

- **Token and cost telemetry in the Ghost Watcher™ writer.**
  All batch paths (Blast Radius, Conflict Detection, detailed prompts,
  and resume) now record `inputTokens`, `outputTokens`, and
  `estimatedCostUsd` at Anthropic batch API rates ($1.50 input /
  $7.50 output per 1M tokens). Unit tests added for `buildTokenUsage`
  and `sumBatchUsage`.

## [9.3.5] - 2026-06-28

### Fixed

- **Ghost Watcher™ PR comments are now fully markdown-escaped.**
  Finding titles and branch names can no longer inject markdown into
  GitHub PR comments.

### Maintenance

- Versions 9.3.2, 9.3.3, and 9.3.4 were release-sync bumps with no
  functional changes (version string and README hero line only).

## [9.3.1] - 2026-06-26

### Added

- **Ghost Watcher™ email notifications.**
  Ghost Watcher™ now emails the customer after every scan. A findings
  email reports per-finding detail (severity badge, title, affected
  files, description) plus a severity summary (critical / high /
  medium / low counts). A clean-scan email confirms when a commit
  produced zero findings. Both emails are fire-and-forget and never
  block the CI pipeline.

## [9.3.0] - 2026-06-26

### Added

- **Streaming vs Batch transport menu.**
  Every scan mode that calls the Anthropic API now opens with a
  cost-aware choice: run live (streaming) for real-time results, or
  submit to the Message Batches API for half-price processing
  retrieved when ready. The menu shows loaded file count, a token
  estimate, and streaming vs batch cost side by side. `--stream` and
  `--batch` skip the menu; CI and Ghost Watcher™ runs default to batch.

- **Batch retrieval commands.**
  `ghost batch-status` lists every pending batch and whether it is
  ready. `ghost batch-retrieve <id>` pulls a finished batch and
  produces the same report files a live run would have.

- **Dynamic pending-batch menu rows.**
  The main menu injects a row per pending batch, grayed out while
  processing and selectable once ready.

- **Transport metadata in every artifact.**
  The `findings.json` sidecar carries a transport block (method,
  timestamps, version), and the PDF, Markdown, TXT, and Ghost Brief™
  HTML each carry a one-line transport footer.

- **Question mode batch support.**
  Question mode joins Blast Radius in supporting the transport menu,
  batch submission, and batch retrieval.

### Fixed

- **Deterministic output.**
  Every Anthropic call site now sets temperature 0, so repeated scans
  of the same codebase produce consistent results.

- **Setup wizard tier cap.**
  The first-run wizard now defaults context size to the actual tier
  cap (Open 50K, Pro 100K, Team 150K, Enterprise 200K) instead of a
  hardcoded 50K, sourced from the single canonical tier-cap table.

- **Accurate source identity.**
  The loader records the source of every scan (ZIP path for archive
  loads, owner and repo for GitHub loads), and batch repository names
  are derived from the git remote origin rather than the current
  directory name.

## [9.2.3] - 2026-06-25

### Fixed

- **Ghost Brief™ generates after batch Blast Radius.**
  Raw batch output is now passed through the narrator before finding
  extraction, replicating the old streaming path. Ghost Brief™
  receives findings with populated file arrays and generates prompts
  correctly.

## [9.2.2] - 2026-06-25

### Fixed

- **Replaced Anthropic SDK batch transport with native fetch.**
  The SDK's internal HTTP client drops connections on GitHub Actions
  runners when calling `/v1/messages/batches`. Native Node.js fetch
  succeeds reliably. All four batch operations (submit, poll, cancel,
  preflight) now use native fetch directly.

## [9.2.1] - 2026-06-25

### Added

- **Preflight reachability check.**
  Before uploading the full codebase context, Ghost Watcher™ sends a
  tiny 1-token test batch to verify the Anthropic Batches API is
  reachable. If unreachable, the run exits cleanly with a clear
  diagnostic instead of burning a 0.6MB upload.

- **Body size logging.**
  The batch request body size is logged on every submission so CI
  logs show the real payload size.

### Fixed

- **submitBatch retry with backoff.**
  Batch submissions now retry up to 4 times with exponential backoff
  (2s, 4s, 8s) on transient connection errors (Premature close,
  ECONNRESET, socket hang up).

## [9.2.0] - 2026-06-25

### Added

- **Anthropic Message Batches API.**
  Ghost Watcher™ submits Blast Radius and Conflict Detection scans as
  async batch requests processed server-side. No streaming connection
  to drop, no Premature close errors regardless of codebase size.

- **Auto-resume.**
  If a GitHub Actions job is interrupted before results arrive, Ghost
  Watcher™ automatically retrieves and delivers the results on the
  next commit push.

- **Incomplete run emails.**
  When a run is interrupted, the customer receives an email explaining
  what happened and confirming results will be delivered automatically.

- **Resume notification emails.**
  When Ghost Watcher™ detects and resumes an incomplete scan, the
  customer receives emails at resume-detected and resume-complete
  milestones.

- **Pending portal state.**
  Ghost Portal™ shows a pending entry immediately when a batch is
  submitted, rather than silence while processing.

- **Configurable batch settings.**
  Poll interval and timeout are controllable via the `batch` section
  of `ghost-watcher.yaml`.

### Fixed

- **GitHub Actions timeout raised to 90 minutes** to accommodate the
  batch polling window.

## [9.1.4] - 2026-06-25

### Fixed

- **Premature close on Blast Radius and Conflict Detection in CI.**
  All three Anthropic API stream calls in the analyst are switched to
  non-streaming (`stream: false`) in CI environments, eliminating
  mid-response stream closure on large context windows. Local dev
  still uses streaming.

## [9.1.3] - 2026-06-25

### Fixed

- **Premature close in CI.**
  Ghost Watcher™ now detects CI environments and switches to
  non-streaming API calls (`stream: false`), eliminating stream
  timeouts on large context windows (150K Team, 200K Enterprise).
  Local dev still uses streaming.

## [9.1.2] - 2026-06-25

### Fixed

- **Ghost Watcher™ CI context cap.**
  Team tier now uses 150K tokens in CI (was incorrectly clamped to
  the 50K Open default). Enterprise now uses 200K. Added an
  `ignoreSavedContext` flag to bypass stale configstore values on
  ephemeral CI runners.

- **Stream retry on transient errors.**
  Premature close, ECONNRESET, and socket hang up errors now retry up
  to 2 times with exponential backoff before failing, reducing false
  zero-findings runs caused by network blips in CI.

### Maintenance

- Version 9.1.1 was a Ghost Watcher™ validation-trigger run with no
  functional changes.

## [9.1.0] - 2026-06-24

### Fixed

- **Dogfood pass 10.**
  Ghost Architect™ scanned its own codebase using Ghost Brief™ and
  fixed 7 issues; Ghost Watcher™ confirmed zero findings after the
  push. Prompt-injection defense hardened in consultant profile
  sanitization (Unicode NFC normalization, zero-width rejection,
  bidirectional override blocking). Temp directory leak in Commit
  Forecast closed with try-finally cleanup on all exit paths. API
  error masking in the agent loop fixed (`ok` field added, test
  coverage added). LLM plan validation now prevents findings from
  being silently dropped from reports. Manifest concurrent-write race
  closed with post-write content verification. Audit-log failure
  threshold lowered from 3 to 1.

## [9.0.8] - 2026-06-23

### Fixed

- Team and Enterprise tiers now correctly apply the 150,000 token
  context cap in CI.
- License validation works on ephemeral GitHub Actions runners
  (fingerprint bypass in CI).
- Custom branches added in the Enable Watch wizard now correctly
  appear in the GitHub Actions workflow trigger.
- PR comment portal link now uses the correct lowercase slug.
- The Enable Watch wizard version-pins the workflow to the installed
  Ghost version.

### Maintenance

- Versions 9.0.1 through 9.0.5 were publish and version-sync bumps
  with no functional changes.

## [9.0.0] - 2026-06-23

### Added

- **Ghost Watcher™, automatic commit monitoring.**
  A headless CI pipeline that runs inside GitHub Actions. When a
  developer pushes to GitHub, Ghost Watcher™ analyzes changed files
  against the full codebase, surfaces findings, generates a Ghost
  Brief™ prompt pack, pushes results to Ghost Portal™, and posts a PR
  comment summary. Includes a portal Watch tab, a CLI menu, and a
  cost estimator. Available on Ghost Team and Ghost Enterprise
  memberships.

## [8.2.5] - 2026-06-22

### Added

- **Ghost Partner™ Profiles in the top-level menu.**
  Ghost Partner™ Profile is now accessible from the first Ghost menu
  with no codebase selection required. Select a profile, activate it
  for the session, and every scan uses your branding automatically.

### Maintenance

- Versions 8.2.6 and 8.2.7 were version-sync bumps across platforms
  with no functional changes.

## [8.2.2] - 2026-06-20

### Added

- **White-label branding across all report types.**
  Ghost Partner™ branding (company name, accent color, footer,
  confidentiality line) is applied consistently across every report
  type, not just the PDF.

## [8.2.0] - 2026-06-20

### Added

- **Executive Brief.**
  A one-page business-intelligence report for non-technical
  stakeholders: health score 0 to 100, a plain-language executive
  narrative, a manual vs AI-assisted cost comparison table, and a
  three-phase remediation sequence. Available on Pro Max, Team Max,
  and Enterprise Max.

## [8.1.2] - 2026-06-17

### Fixed

- **Ghost Brief™ dogfood pass 4.**
  Six fixes: prompt injection via consultant profile fields
  (`narrator.js`), freemium quota bypass closed (`tier-gates.js`),
  seat registration verification race fixed (`enterprise.js`), silent
  Tier 2 detector failures now surface to stderr, GitHub Enterprise
  Server URL parsing fixed for team-sync, and GitHub API rate-limit
  retry with user-facing progress messages plus a continue/stop prompt.

### Maintenance

- Versions 8.1.3 through 8.1.9 were version-sync bumps with no
  functional changes.

## [8.1.0] - 2026-06-17

### Fixed

- **Ghost Brief™ dogfood passes 1 and 2.**
  Ghost Architect™ scanned its own codebase using Ghost Brief™ and
  Claude Code fixed 19 findings across two iterative passes. Zero
  critical findings remaining. Test suite expanded with 4 new smoke
  test files.

## [8.0.3] - 2026-06-17

### Changed

- **Ghost Brief™ prompt quality overhaul.**
  Prompts now include full remediation context, fix steps,
  constraints, confidence score, and effort estimate extracted
  directly from scan findings. Validation hints are now
  finding-specific.

## [8.0.2] - 2026-06-16

### Added

- **Ghost Brief™.**
  Convert any Ghost scan into a validated, blast-radius-aware Claude
  Code prompt pack. Ghost reads the findings JSON, converts each
  finding into a structured prompt with blast-radius ordering,
  validation hints, and file context, and writes `ghost-brief.json`
  to disk. Feed it into Claude Code, Cursor, or Copilot. If Ghost
  Portal™ is configured, the Brief is pushed automatically. Requires
  Ghost Pro Max or higher.

## [8.0.0] - 2026-06-16

### Added

- **Ghost Brief™ launch.**
  First release of the Ghost Brief™ prompt-pack pipeline. Initial
  `--brief --input=<path>` flag and post-scan menu entry land here;
  the prompt-quality overhaul follows in 8.0.3.

## [7.2.0] - 2026-06-04

### Notes

- Working-session rollup bump. No standalone changelog content was
  authored for this version; functional changes are captured in the
  surrounding 7.1.x and 8.0.x entries.

## [7.1.0] - 2026-05-29

### Added

- **Commit Forecast mode.**
  New ninth mode in Ghost Architect™. Analyzes a set of proposed file
  changes against the production baseline and forecasts the Blast Radius
  and Conflict impact of accepting those changes — before the developer
  commits or pushes. Ghost does not apply changes, does not commit, does
  not push. It shows what *would* happen if the developer did.

  Two entry surfaces, one code path:

  - **Pre-commit forecast** — Ghost auto-discovers working-tree changes
    via `git diff --name-only HEAD` plus staged and untracked files.
    No arguments required. The developer's working directory *is* the
    proposed folder.

  - **Offline / received-files forecast** — Developer points Ghost at
    an explicit folder of proposed files that mirrors the repo's relative
    directory structure. Covers the offshore-review use case (architect
    receives files from an offshore team and wants to assess impact before
    accepting them).

  Core design:

  - **Synthesis primitive** (`src/core/forecast-overlay.js`): builds an
    in-memory overlay where proposed files overwrite their baseline
    counterparts and Ghost falls back to the baseline for everything else.
    Proposed files go through the same redaction pipeline as baseline files.
    Path resolution uses mirror-structure matching with bidirectional
    fuzzy fallback for teams that send loose files without full directory
    structure. Changed files are front-loaded in the context string so
    they're always included under the token cap.

  - **Analyst framing**: Blast Radius and Conflict Detection prompts are
    reframed when called from Commit Forecast. The model is told these
    files are not committed yet and to frame every finding as "if you push
    now, X breaks" — not generic architectural observations.

  - **Inline diff renderer** (`src/utils/diff-renderer.js`): optional
    per-file diff shown before analysis runs. LCS-based line diff with
    context hunks, hunk separators, and hard caps (60 changed lines per
    file, 8 files in detail) to prevent wall-of-text on large change sets.

  - **Tier gating**: Open gets one free Commit Forecast per install,
    tracked under a separate `ghostOpenForecastCount` key (isolated from
    the 4-scan POI/Blast/Conflict quota — Forecast is designed to run
    many times per day and would drain the shared quota in minutes).
    Pro/Team/Enterprise are unlimited.

  - **Menu**: `🔮 Commit Forecast` appears between Conflict Detection and
    Recon in the mode menu.

  - **Marketing angle**: "Cut your container-to-stage cycles from five to
    one." Commit Forecast closes the container-vs-production gap by
    analyzing the developer's proposed changes against the actual
    production codebase before they push.

  - **Smoke test suite**: 36 checks covering tier gate logic, forecast
    counter, synthesis primitive path mapping, error handling, conflict
    prompt framing, git repo detection, and diff renderer edge cases.

## [7.0.0] - 2026-05-26

First public release of `ghost-architect-open` on npm. Install with
`npm install -g ghost-architect-open`.

### Added

- **Question mode.**
  Single-question Q&A surface for Open users. Ask anything about
  the codebase in plain English, get an answer, optionally save it.
  Replaces the prior Chat surface on the Open tier (Chat remains
  available on Pro+ for ongoing multi-turn conversation). Vocabulary
  is unified across all seven Open-facing surfaces: menu items,
  cost telemetry, saved reports, and documentation all use
  "Question and Answer" consistently.

- **Worker-driven promo banner.**
  The no-license banner shown to Open users can now display a
  server-driven promotional line that updates without a CLI
  redeploy. EJ edits the `PROMO_TEXT` constant in the signup
  worker, runs `wrangler deploy`, and every Open install on next
  run sees the new text within the 60-second edge cache window.
  Empty, null, missing, or malformed responses suppress the line
  silently — the banner renders cleanly without it. Two-second
  timeout on the fetch. The CLI is a passive renderer; the worker
  is the source of truth.

- **Prompt Triage mode visible at top level.**
  Now grouped under its own "Prompt analysis" header in the input
  method menu so users can find it without searching the mode
  menu. Audits a folder of LLM prompts for structural defects:
  missing context, ambiguous instructions, brittle assumptions,
  token bloat.

- **Inheritance Audit mode (Pro+).**
  Deal-grade codebase audit for buyers, PE diligence teams,
  fractional CTOs onboarding to engagements, and modernization
  consultancies scoping rebuilds. Four analyzers (Stack Reality
  Check, Key-Person Risk, Hidden Dependency Map, Modernization
  Roadmap) combine into a 5-page deal-grade PDF plus TXT and MD.
  Runs 30 to 60 seconds at $0.02 to $0.04 in API charges. Open
  tier shows an information panel; no partial run.

- **Ghost Partner™ white-label consultant profiles.**
  Consultants and agencies can run scans with their own branding,
  methodology, and rates baked into the report. Profiles are
  YAML, Markdown, or plain-text documents loaded with `--profile`.
  The profile wizard (`ghost --create-profile`) walks users
  through priorities, anti-patterns, red flags, billing rates,
  and branding interactively. Default-profile support means a
  loaded profile auto-applies to every scan unless overridden
  per-run. Paid-tier feature; Open produces neutral Ghost-branded
  reports.

- **CLI flag set for context, exclusion, and profile control.**
  `--max-context <N>` clamps to tier limit. `--exclude <glob>`
  is repeatable. `--exclude-presets` applies named exclusion
  bundles (test-data, generated, vendor-cache). `--profile`,
  `--no-profile`, `--create-profile`, `--list-profiles`,
  `--set-default-profile`, and `--clear-default-profile` cover
  the consultant-profile lifecycle.

- **License activation flow.**
  `ghost --activate <key-or-token>` handles both human-typeable
  keys (POST to activation server, signed token returned) and
  pre-signed tokens (verified locally, no network). Fingerprint
  binding ensures licenses can't be moved between machines
  without reissuance. `ghost --license` shows current status
  offline. `ghost --license-clear` removes the installed license.
  `ghost --start-trial` activates a 14-day evaluation trial,
  one per machine.

### Changed

- **Default model: Claude Sonnet 4.6 (was Sonnet 4.5).**
  All new wizard configurations pick Sonnet 4.6 as the recommended
  default. Existing users with a saved configuration keep their
  previously-selected model until they reconfigure. Pricing
  unchanged ($3 input / $15 output per million tokens).

- **Premium model: Claude Opus 4.7 (was Opus 4.5).**
  Wizard and audit-mode model picker now offer Opus 4.7 as the
  premium choice. Pricing: $5 input / $25 output per million tokens.

- **Pricing table consolidated.**
  `src/core/estimator.js` is the single source of truth for
  per-model pricing across the entire codebase. Modes and detector
  infrastructure all import from this table. Includes current
  generation (Opus 4.7/4.6, Sonnet 4.6, Haiku 4.5) plus backward
  compat entries for users still on prior models.

- **README rewritten for npm.**
  Install command (`npm install -g ghost-architect-open`)
  prominently positioned at the top. Six modes documented
  (Question, POI, Blast, Conflict, Prompt Triage, Recon) plus
  the Pro+ Inheritance Audit. Tier comparison table reflects
  current capabilities. Cost expectations and pricing table
  updated to Sonnet 4.6.

### Fixed

- **`bin` field validation.**
  `package.json` `bin` value normalized from `"./bin/ghost.js"`
  to `"bin/ghost.js"` so npm doesn't strip the entry during
  publish. Earlier 7.0.0 ship attempts triggered an npm warning
  about the leading `./` being invalid; the binary would have
  been removed from the installed package on platforms where the
  warning escalated to an error. Users who install 7.0.0 from npm
  now get `ghost` correctly available on their PATH.

- **Vocabulary leak in trial-start banner.**
  The trial-start success banner previously listed `Recon, Chat`
  as still-working modes. Now correctly lists `Recon, Question`
  in line with Question mode being the Open-tier Q&A surface.

### Notes

- Three-tier internal release: Open (`7.0.0`, public npm), Pro
  and Team (via git+https from umbrella repo). Pro and Team will
  receive the v7.0.0 promo banner and model-default updates in a
  follow-up release; today's launch is Open-only on npm.
- Cumulative changes since v5.4.0 (the last documented version)
  represent the v6.x series (License Worker, Stripe integration,
  enterprise customer flow) plus the v7 series unifications
  (Question mode rename, Inheritance Audit launch, promo banner).
  Intermediate version entries will be backfilled in a future
  CHANGELOG pass.

## [5.4.0] - 2026-05-12

### Added

- **Inheritance Audit Mode (Pro+).**
  A new mode purpose-built for deal-grade codebase audits. Audience:
  agency founders running pre-engagement diligence, fractional CTOs
  onboarding to new engagements, PE/M&A diligence teams, and
  modernization consultancies scoping rebuilds. Produces a 5-page
  deal-grade PDF (plus TXT and MD) combining four analyzers:
  Stack Reality Check (language census, framework detection, EOL
  flagging), Key-Person Risk (git history parsing, bus factor,
  contributor concentration, departed-author flagging), Hidden
  Dependency Map (license risk, EOL exposure, commercial
  encumbrances), and Modernization Roadmap (LLM-synthesized
  stabilize-vs-rebuild recommendation with 90-day plan and
  confidence rating). Runs in roughly 30 to 60 seconds at roughly
  $0.02 to $0.04 per audit in API charges. Validated end-to-end
  against magento/meta-for-magento2 in three configurations:
  local clone (666 files, 68 deps, multi-author KPR), GitHub
  capped (198 files, 8 deps, graceful KPR degradation), GitHub
  full (669 files, 68 deps, complete coverage matching local).

- **Per-run model picker in Audit Mode.**
  Inquirer list prompt between project label and cost estimate.
  Default selection respects the user's global defaultModel config
  so pressing Enter is the happy path. Audit is a high-stakes
  deliverable; users may want Opus for an important deal even if
  they run POI on Sonnet day-to-day. Cost estimate reflects the
  per-run model choice, not the global config.

- **Save prompt in Audit Mode.**
  `Save this audit to ~/Ghost Architect Reports/?` confirm before
  saveReport runs. Default Yes (audit is the deliverable). User can
  bail if the synthesis came back weak. Matches POI/Blast convention.

- **GitHub loader file-count prompt for large repos.**
  When the GitHub loader detects more than 200 code files in the
  user's selected folders, pause before fetching and ask whether
  to fetch all or sample the first 200. Default Yes (fetch all)
  since senior users running deal-grade audits expect complete
  coverage. The prompt tells the user the cost estimate fires
  inside the mode before the report runs, so they get a second
  chance to bail at no cost. Behavior applies to every mode that
  loads from GitHub, not just Audit.

### Tier gating

- **Audit Mode is Pro+ entirely.**
  On Ghost Open, selecting Inheritance Audit shows a clean
  information panel explaining what the feature does, what it
  costs, and how to upgrade. No partial run, no analyzers, no
  API charges. The user picks 'Back to mode menu' (default) or
  'Open pricing page in browser' and the flow continues. The
  paywall takes the same fail-closed posture as the existing
  Pro+ Project Intelligence gating from v5.2.1: tier defaults
  to 'open' if any caller forgets to pass it.

- **Why no stripped-down free version of Audit Mode.**
  A stripped-down free version misrepresents the product. An
  Open user either thinks "that's all it does" (damaging
  Ghost's reputation for what Audit IS) or feels held hostage.
  Audit Mode is a deal-grade artifact; Open gets the honest
  information panel and an explicit upgrade path.

### Notes

- Audit Mode v0.4.0 ships with all four analyzers live and
  deal-grade reports saving. Future enhancements scheduled for
  later versions: audit-over-time comparison (Team tier
  differentiator), custom PDF branding (Enterprise tier
  differentiator), transitive dependency walking, CVE scanning.

- Stack Reality framework dedup: composer.json files in each
  Magento module previously triggered duplicate PHP detections.
  Fixed via dedup map keyed on (name, version).

- Version constraint normalization: Composer multi-version
  syntax `8.1.0||~8.2.0||~8.3.0||~8.4.0` previously leaked into
  deal-grade reports. Normalized to clean range `8.1.0 – 8.4.0`.

## [5.2.1] - 2026-05-10

### Fixed

- **Project Intelligence in Prompt Triage is now correctly tier-gated.**
  Prompt Triage now respects the same Pro+ entitlement that has always
  applied to Project Intelligence in POI, Blast, Conflict, and Recon.
  On Pro, Team, and Enterprise the project label prompt and baseline
  comparison continue to work exactly as in 5.2.0. On Open the project
  label prompt is skipped and no project history is written, matching
  how Open already hides the Project Dashboard and Compare Reports
  menu items. The mode now accepts a `tier` option which defaults to
  `'open'` (fail-closed) so that any caller that forgets to pass a
  tier does not leak a paid feature.

## [5.2.0] - 2026-05-10

### Added

- **Prompt Triage detector pack v1 is complete (16 detectors).**
  Tier 3 `integrationMismatch` detector ships, closing the original
  Tian et al. 2025 taxonomy mapping. Hybrid regex + LLM verification
  catches integration-shape contract drift inside prompts (output
  format declarations vs few-shot examples, tool schema field-name
  drift, envelope mismatches, parameter-vs-instruction tension).

- **Cost pre-flight in Prompt Triage.**
  Before any Tier 2 LLM calls fire, the user sees a cost band
  estimate and confirms y/n. Actual cost reported after the scan
  completes. Brings Prompt Triage into parity with POI/Blast/Conflict
  which already had cost pre-flight.

- **Project intelligence in Prompt Triage.**
  Prompt Triage scans now optionally accept a project label and
  participate in the same baseline/comparison/velocity tracking
  POI uses. Re-running Prompt Triage on the same prompts shows
  resolved findings, new findings, and remediation progress.

- **Assertion-based test harness (`tests/assert-prompt-pack.mjs`).**
  30 cheap assertions covering Tier 1 fixture detection, F-34 loader
  filtering, production prompt baselines, and integrationMismatch
  regex pre-filter. Runs sub-second, deterministic, no LLM calls.
  Replaces eyeball-only smoke for regression detection. The smoke
  harness (`tests/smoke-prompt-pack.mjs`) remains for manual
  Tier 2 verification with `SMOKE_TIER2=1`.

### Changed

- **Loader file-type filtering (F-34).**
  `loadPromptSource` no longer treats project metadata files as
  prompts. CLAUDE.md, package.json, package-lock.json, tsconfig.json,
  ESLint/Prettier configs, and `*_FOLLOWUPS.md`/`*_PLAN.md` files
  are now excluded. Repo-root scans go from ~59 noise files to 52
  legitimate prompt files.

- **`unboundedOutput` detector tuned (F-37).**
  Extended `CONSTRAINT_MARKERS` to recognize bounded verbs
  (format-as-template, range-with-adjectives, bare-count-with-
  adjectives) and added behavioral-guideline-bullet heuristic to
  suppress findings on rule-list bullets that are not output
  directives. Cleared 3 false positives in production prompts.

- **POI prompt overhaul (F-38 to F-51, 14 fixes).**
  Severity rubric defined with per-tier criteria. Effort hour
  anchors locked: Low 2-6 hrs @$85/hr, Medium 8-20 hrs @$125/hr,
  High 24-60 hrs @$200/hr, Requires architect 60+ hrs @$200/hr
  (billing rates unchanged). Complexity tiers defined. Priority
  ordering criteria explicit. Rate sourcing default specified.
  No-profile naming fallback added. "Straightforward" defined as
  "<10 lines in single file". 4-tier severity to 3-tier billing
  mapping documented. Placeholder template replaced with schema +
  concrete row example. Consultant-checks overlap rule added.
  Landmarks effort N/A exception noted. Profile identifier
  annotated. "Thorough but ruthless" rewritten for clarity.

- **Blast prompt overhaul (F-52 to F-60, 9 fixes).**
  REMEDIATION PLAN gets inline rubrics for effort/complexity/risk.
  ROLLBACK PLAN gets time/complexity rubrics. Target source made
  explicit. Smoke test selection criteria defined across 3
  dimensions. Rollback steps placeholder described. Consultant-
  checks rewritten mode-agnostic.

- **Conflict prompt fixes (F-61 and F-62, 2 fixes).**
  Overall risk aggregation rule added. Per-finding output
  structure templated.

- **Pricing canonicalized.**
  `src/core/estimator.js` is now the SINGLE SOURCE OF TRUTH for
  model pricing. Includes Opus 4.7/4.6/4.5 ($5/$25 post Nov 2025
  price drop), legacy Opus 4/4.1 ($15/$75), Sonnet 4.6/4.5
  ($3/$15), Haiku 4.5 ($1/$5).

### Deferred to v5.3

- **F-12 detector threshold tuning**: needs 3 or more calibration scans
  for a data-driven retune; today's dogfood is n=1. Detectors
  performed well at current thresholds, so deferring rather than
  shipping noise as signal.

- **Cross-system integration mismatch detection**: v5.2's Tier 3
  detector handles prompt-internal consistency only. Detecting
  mismatches against calling code or downstream parsers requires
  Ghost to analyze both sides; that's a v5.3+ extension.

### Notes

- Three-tier release: Pro (`5.2.0-pro`), Team (`5.2.0-team`),
  Open (`5.2.0`).
- npm publish: Open tier only, as `ghost-architect-open`.
- All 26 prompt fixes cleared in dogfood validation; production
  prompts now produce 0-2 Tier 1 findings each (was 1-15).
- Calibration data point: May 10 dogfood scan, 472 LLM calls
  on 52 prompts against Opus 4.7, $18.58 actual vs $17.70
  estimated (within 5%).
