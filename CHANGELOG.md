# Changelog

All notable changes to Ghost Architect™ are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to semantic versioning.

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
