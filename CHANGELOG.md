# Changelog

All notable changes to Ghost Architect Open are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to semantic versioning.

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
