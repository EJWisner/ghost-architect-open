# Changelog

All notable changes to Ghost Architect Open are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to semantic versioning.

## [5.4.1] - 2026-05-13

### Fixed

- **Non-interactive telemetry.** Anonymous install pings and 24-hour
  heartbeats now also fire when the CLI runs in non-TTY contexts
  (Docker containers, CI runners, piped scripts, the Claude Code
  plugin's `--scan` path). Previously these contexts silently exited
  the first-run flow with no ping, which made install counts and
  active-user metrics undercount real-world usage by a wide margin.

  Behavior is unchanged for interactive terminal users — the email
  signup prompt still fires once on first run and is fully optional
  (Y/N/S). Non-interactive contexts never see the prompt, only a
  single anonymous ping per install plus the existing 24-hour
  heartbeat. Pings include a source field tagged with the detected
  environment (Docker, GitHub Actions, GitLab CI, CircleCI, Jenkins,
  Buildkite, Travis, Bitbucket, Azure Pipelines, Claude Code plugin,
  generic CI, or generic non-interactive).

  Opt out by setting `GHOST_NO_PING=1`. All failures stay silent and
  never block the CLI.

## [5.4.0] - 2026-05-12

### Added

- **Inheritance Audit Mode (Pro feature).** The Inheritance Audit menu
  entry is now visible on Ghost Open, and selecting it shows a clean
  paywall panel describing what the audit produces, who it's for, and
  how to upgrade. The panel offers two actions: return to the mode menu
  (default) or open the pricing page in your default browser. No
  analyzers run on Open, no API charges, no degraded sample audit.

  Inheritance Audit is a deal-grade codebase audit for buyers, PE
  diligence teams, fractional CTOs, and modernization consultants. It
  combines four analyzers (Stack Reality Check, Key-Person Risk, Hidden
  Dependency Map, Modernization Roadmap) into a 5-page deal-committee
  PDF in roughly 30 to 60 seconds at roughly $0.02 to $0.04 per audit
  in API charges. Available on Ghost Pro ($99/mo), Ghost Team ($399/mo),
  and Ghost Enterprise. Sign up at https://ghostarchitect.dev/pricing.

- **GitHub loader file-count prompt for large repos.** When a selected
  GitHub repo's folders contain more than 200 code files, the loader now
  pauses and asks whether you want to fetch all of them or stay with the
  default cap of 200. Senior users running deal-grade audits need the
  full set; casual exploratory scans are fine with the sample. Either
  way you choose, not us. An accurate cost estimate fires inside the
  mode you pick afterward, before any cost is incurred, based on the
  file count you just picked.

## [5.3.1] - 2026-05-11

### Added

- **First-run email capture.** On the initial CLI invocation, Ghost
  Architect Open prompts once for an optional email signup. Fully
  optional: press N to decline, S to skip, or just enter Y and provide
  an email to opt in. The prompt never re-fires on subsequent runs.
  This is how we stay in touch with users since npm does not share
  install data.

  Data collected (only if you opt in): email, anonymous install ID,
  version. Stored at signup.ghostarchitect.dev and synced to a private
  Airtable. Never sold, never shared. Opt-out anytime by emailing
  support@ghostarchitect.dev.

  All failures are silent. Network errors, signal interrupts, or
  endpoint outages never block the CLI. Local config at
  `~/.ghost-architect/config.json` records the choice and retries
  failed syncs on the next run.

## [5.3.0] - 2026-05-11

### Added

- **Prompt Triage free in Open.** The full Prompt Triage detector
  pack is now available at the Open tier with no gating. Same 16
  detectors, same accuracy as paid tiers. Only Project Intelligence
  features (baseline comparison, velocity tracking) remain Pro-only.

### Improved

- **Report clarity.** Deduplication now annotates findings with
  "Also flagged by:" so you can see which detectors corroborate
  each issue. Severity recalibration cut MEDIUM noise by 63%
  (76 → 28) across the calibration corpus while surfacing one new
  verified HIGH (poi-with-profile.md FILE CITATION RULES conflict).
  Total findings dropped 52% (116 → 56) with no loss of true
  positives. Cost per scan rose slightly ($0.41 → $0.43) due to
  the added cross-detector dedup pass.

## [5.2.0] - 2026-05-10

### Added

- **Prompt Triage detector pack v1 is complete.** All 16 detectors
  from the Tian et al. 2025 taxonomy are now wired in. The new
  Tier 3 `integrationMismatch` detector catches integration-shape
  contract drift inside prompts: output format declarations vs
  few-shot examples, tool schema field-name drift, envelope
  mismatches, and parameter-vs-instruction tension.

- **Cost pre-flight in Prompt Triage.** Before any LLM-backed Tier 2
  detector fires, you see a cost band estimate and confirm y/n.
  Actual cost is reported after the scan completes. Brings Prompt
  Triage into parity with POI, Blast, and Conflict which already had
  cost pre-flight.

### Improved

- **Prompt taxonomy detection accuracy.** 26 prompt-pack fixes
  including better severity tuning for `unboundedOutput`, sharper
  ambiguity calls, fewer false positives in `injectionStaticPattern`,
  and tighter contract checks across the Tier 2 detectors.

- **Loader filter (F-34).** Project metadata files no longer leak
  into prompt scans. The loader now correctly filters out files
  that are not actual prompts.

### Notes for Open users

- Prompt Triage in Open runs as a one-shot audit. You get a full
  report on every scan with no time-tracking. The Project
  Intelligence features (baseline comparison, velocity tracking,
  Project Dashboard) remain Pro-only across all modes including
  Prompt Triage. Open users get the complete detector pack and the
  same accuracy as paid tiers; the gating is on workflow features,
  not on detector access.

- Cost pre-flight only triggers when you specify a target model
  (which enables the Tier 2 LLM-backed detectors). Without a target
  model only Tier 1 regex detectors run, which incur no LLM cost.
