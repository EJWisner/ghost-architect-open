# Ghost Architect™, Claude Code Context

This file orients Claude (or any AI assistant) when working on the Ghost Architect™ codebase. It is operational context, not marketing. Read it before making changes.

## Project Identity

Ghost Architect™ is a Node.js CLI tool for AI-powered codebase triage and pre-engagement analysis. It scans an inherited or unfamiliar codebase, runs LLM passes against it (single-shot or multipass for large repos), and produces structured findings: points of interest, blast radius reports, conflict detection, recon sizing, and stakeholder-ready PDFs.

It is platform-agnostic. It works on any codebase, any language: Magento/Adobe Commerce, Laravel, Salesforce Commerce Cloud, Node, Python, Go, C++, mainframe COBOL. Same tool, same flow. Anything in the codebase that references Ghost Architect as a Magento-only or Adobe-Commerce-only tool is wrong and should be corrected.

- Working folder: `/Users/ejwisner/ghost/ghost-architect4` (the Pro branch worktree, `main`)
- Repo: `https://github.com/EJWisner/ghost-architect.git` (private)
- npm: `ghost-architect-open` (the Open tier publishes to npm; Pro, Team, and Enterprise are private distributions)
- Runtime: Node.js (ESM, `"type": "module"`)
- IDE: PhpStorm

## Branch Matrix and the TIER Constant

Ghost Architect™ ships from three branches in one repo. Each branch is a tier with different capabilities. The `TIER` constant in `bin/ghost.js` pins which tier the running build represents:

- `main` is the Pro tier, `TIER = 'pro'`, worktree at `/Users/ejwisner/ghost/ghost-architect4`
- `ghost-team` (worked through `ghost-team-merge`) is the Team tier, `TIER = 'team'`, worktree at `/Users/ejwisner/ghost/ghost-team-merge`
- `ghost-open` is the Open tier, `TIER = 'open'`, worktree at `/Users/ejwisner/ghost/ghost-architect-open`

Enterprise is not a separate branch. It is the Team build with extra features that gate on the team-sync repo name containing the string `enterprise`.

When cherry-picking changes that touch `bin/ghost.js` across branches, the `TIER` constant must be set per branch. This is the single most common merge mistake. Always re-check `TIER` after a cherry-pick.

## Version Is Hardcoded in Two Places

When bumping version, both must change or the tool will report inconsistent versions:

1. `bin/ghost.js`, the `VERSION` constant. The line number drifts as the file evolves. To find it: `grep -n "VERSION" bin/ghost.js | head -5`. As of v5.0.0 it is line 38 on main.
2. `package.json`, the `"version"` field, line 3.

The `--version` flag prints `ghost-architect v{VERSION} ({TIER})`, which is the canonical smoke test after any version bump.

## The Four Tiers

| Tier | Distribution | Context cap | Profile system | Team sync | Mobile publish | Enterprise features |
|------|--------------|-------------|----------------|-----------|----------------|---------------------|
| Open | npm public | 50K tokens | No | No | No | No |
| Pro | private | 100K tokens | Yes | No | No | No |
| Team | private | 150K tokens | Yes | Yes | Yes | No |
| Enterprise | Team build, repo-gated | 200K tokens | Yes | Yes | Yes | Yes (seats, audit, white-label) |

Tier caps live in `src/loader/tierCaps.js` (`TIER_CAPS`, `getTierCap`). The `--max-context N` flag soft-warns and clamps to the running tier's ceiling.

Pricing as of May 2026: Architect Pro $99/mo, Team $399/mo, Enterprise custom ($1,200 to $2,000/mo). Suite (Architect + Listener) Pro $149/mo, Team $599/mo. Open is free, BYOK (bring your own Anthropic API key).

## Architecture

Actual current layout (verified May 5, 2026):

```
bin/
  ghost.js              CLI entry. VERSION constant, TIER constant, banner, flag parsing,
                        early-exit handlers for tier-specific flags, main interactive loop.

prompts/
  index.js              All Claude prompt templates.
  conflict.js           Conflict-mode-specific prompts.

src/
  config.js             User config: API key, default profile slug, team-sync workspace.
  loader/
    index.js            loadCodebase, setScanOptions, getScanOptions, buildContext.
                        Open also exports loadFromPath (for non-interactive --scan).
                        Pro and Team currently do not (Phase D gap).
    tierCaps.js         TIER_CAPS map and getTierCap helper.
    excludes.js         PRESETS, listPresets, resolveExcludePatterns, isExcluded, filterPaths.
  modes/
    chat.js             Free-form chat against loaded context.
    poi.js              Points of Interest scan.
    blast.js            Blast Radius analysis.
    conflict.js         Conflict Detection.
    recon.js            Sizing and engagement plan.
    compare.js          Before/after diff of two saved reports.
  core/
    multipass.js        Multipass scanning for codebases over the context cap.
    projects.js         Project storage, dashboard data, path-traversal-checked projectDir().
    estimator.js        Token and cost estimation.
    verifier.js         Regex-based finding verification.
    llm-verifier.js     LLM-based finding verification.
    conflict.js         Conflict-mode core logic.
    agent/
      loop.js           Agent loop driver.
      planner.js        Plan generation.
      narrator.js       Narrator pass (source-grounded, post-v4.8.0 hallucination fix).
      verifier.js       Verifier pass (paired with narrator).
      memory.js         Agent-loop memory.
      tools.js          Tool definitions for the agent.
      index.js          Public surface.
    team-sync.js        (Team and Enterprise only) GitHub-backed shared project repo.
    enterprise.js       (Enterprise only) Seat management, audit log, org config, white-label.
    mobile-publish.js   (Team only) Push scan data to private reports repo for Ghost Mobile.
  profile/
    index.js            loadProfile resolves YAML/MD/TXT into a profile object.
    extractor.js        LLM-driven extraction of methodology from free-text profile docs.
    wizard.js           Interactive profile wizard (--create-profile).
    writer.js           writeProfile, listProfiles, deleteProfile, profilePathFor, getProfilesDir.
  projects.js           CLI wrapper around src/core/projects.js. showProjectDashboard lives here.
  estimator.js          SessionCostTracker (re-export wrapper around core/estimator.js).
  redactor.js           Secret redaction. Wired into Open's loader. NOT wired into Pro or Team.
                        This is a Phase D gap: Pro and Team currently send unredacted content
                        to the API.
  prioritizer.js        Risk prioritization for findings.
  pdf-generator.js      PDF report generation. White-label hooks for Enterprise.
  reports.js            Report dispatch (TXT, MD, PDF).
  utils/
    errors.js           Custom error types.
    finding-parser.js   Shared finding parser (introduced v4.8.0 to deduplicate parsing).

assets/
  logo.jpeg

LICENSE
README.md
package.json
```

Known wart: `src/analyst/` exists alongside `src/core/`. This is dead code from a pre-v4.7 reorganization. The active multipass implementation is `src/core/multipass.js`. `src/analyst/multipass.js` is no longer imported anywhere on main and should be deleted in a future cleanup pass. Do not edit `src/analyst/` thinking you are changing behavior; you are not.

`fix-456.mjs` and `test-agent.js` at the repo root are ad-hoc scratch scripts, not part of the production surface. There is no jest config or test suite yet. Test infrastructure is on the future-work list.

## The Seven User-Facing Operations

The interactive menu surfaces seven things a user can do once a codebase is loaded:

1. Chat: free-form Q&A against the loaded context.
2. Points of Interest (POI): automated red-flag, landmark, dead-zone, and fault-line mapping.
3. Blast Radius: impact map and rollback plan for a proposed change.
4. Conflict Detection: finds contract mismatches, schema conflicts, config errors.
5. Recon: sizing and engagement plan, no analysis.
6. Compare Reports: before/after diff of two saved reports.
7. Project Dashboard: remediation progress across all stored projects.

Architecturally only the first six are mode files in `src/modes/`. Dashboard is a view function (`showProjectDashboard`) in `src/projects.js`, surfaced through the same menu. Both Open and Pro expose the first five plus Compare; Team and Enterprise add Dashboard and team-sync flows.

## Ghost Partner, the Profile System

Ghost Partner is a feature of Ghost Architect™, not a separate product. Never refer to it as a standalone tool. It lets a consultant or agency encode their methodology, voice, and branding into a profile, which Ghost Architect then applies to scans to produce branded triage reports.

Profile lifecycle:

- Profiles live in `~/.ghost/profiles/` as YAML files. The slug is the filename without extension.
- Source formats accepted: `.yaml`, `.yml`, `.md`, `.txt`. Markdown and plain text are passed through `src/profile/extractor.js`, which uses Claude to extract structured methodology, then cached.
- The wizard at `src/profile/wizard.js` walks a user through creating one interactively. Reachable via `--create-profile` (headless) or the "Manage Ghost Partner Profiles" main-menu entry.
- A default profile slug is stored in user config and auto-applied to every scan unless `--profile path` or `--no-profile` is passed.
- Resolution priority at startup: `--no-profile` beats `--profile <path>` beats config defaultProfileSlug beats none. Explicit `--profile` failures are fatal; default-profile failures degrade gracefully with a warning.

PDFs produced under a profile are white-labeled with the consultant's logo and accent color, with a "Powered by Ghost Partner" footer. The white-label hook lives in `src/pdf-generator.js`.

Available on Pro, Team, and Enterprise. Not on Open.

## Loader Subsystem

The loader (`src/loader/`) is responsible for turning a directory or zip or GitHub repo into a `codebaseContext` object that the modes consume. It applies tier caps, exclusion patterns, redaction (Open only, see below), and multipass batching for large codebases.

There are real implementation differences between branches that have not been reconciled and are tracked as Phase D work:

- **Redactor wiring.** Open imports `redactContent` and `showRedactionSummary` from `src/redactor.js` and runs all content through redaction in `buildContext`. Pro and Team do not. This means Pro and Team currently send unredacted content (including any secrets in the scanned codebase) to the Anthropic API. The redactor file exists in all three branches; only the wiring is missing on Pro and Team. This is a known gap, not a design choice.
- **IGNORED_DIRS / IGNORED_FILES.** Pro has the richer list (covers more language ecosystems and Magento-specific paths like `pub/static`). Open has a shorter list. Both work for what they're called to do; reconciliation is deferred.
- **Multi-segment ignore matching.** Pro handles `pub/static`-style multi-segment paths correctly. Open uses simpler substring matching.
- **`loadFromPath` export.** Open exports it (used by `--scan` non-interactive mode). Pro and Team do not. This means `--scan` is not available on Pro or Team yet.
- **Pre-scan default-excluded count display.** Pro shows it; Open doesn't.

CLI flags that drive the loader:

- `--max-context N` overrides the context cap (clamped to the tier ceiling).
- `--exclude "glob"` excludes paths matching a glob (repeatable).
- `--exclude-presets a,b` applies named exclusion presets (test-data, generated, vendor-cache).

## Narrator and Verifier Pipeline

The agent loop in `src/core/agent/` runs a narrator pass and a verifier pass to reduce hallucinated findings. The narrator is source-grounded: it cites specific files and line ranges. The verifier (regex-based in `src/core/verifier.js`, LLM-based in `src/core/llm-verifier.js`) checks each finding before it makes it into a report.

This pipeline was hardened in the v4.8.0 release (commit `fea6338`). Seven bug fixes landed: the narrator stopped getting cross-fed a skeleton from earlier passes, MD truncation was rewritten to not chop mid-sentence, and a shared finding parser (`src/utils/finding-parser.js`) replaced three separate parsing implementations that were drifting apart.

If you are touching the agent loop, narrator, or verifier, run a regression scan against the magento-2-seeder and meta-for-magento2 repos before committing. The v4.8.0 baseline was 7-of-7 survivors on magento-2-seeder. Anything below that is a regression.

## Team and Enterprise Features

Team adds shared project sync via a GitHub-backed repo. The user creates a private repo, generates a PAT, and runs `--configure-team`. Scans then push project metadata to that repo, and `--team-sync` pulls everyone else's. Implementation in `src/core/team-sync.js`.

Enterprise gates on the team-sync repo name containing the string `enterprise`. So the customer flow is: pay through Stripe, EJ creates a private repo with `enterprise` in the name, grants the customer access, customer runs `--configure-team` against it followed by `--enterprise-setup`. Enterprise unlocks:

- Seat management (`--enterprise-seats`): register, promote to admin, remove.
- Usage reporting (`--enterprise-usage`): scans and cost by seat and project.
- Audit log (`--enterprise-audit`): recent scan activity.
- Org config (saved to sync repo): org-level Anthropic API key, white-label logo and org name.
- White-label PDF reports.

Implementation in `src/core/enterprise.js`. The `assertEnterprise()` helper is the gate; every enterprise CLI flag and menu entry calls it before doing work.

## Ghost Mobile Integration

Ghost Mobile is a separate product (React Native / Expo app). It reads scan data from a private GitHub reports repo and renders a portfolio dashboard. Ghost Architect™ Team publishes to that repo after each scan. Wiring lives in `src/core/mobile-publish.js`.

Setup: `--configure-publish` connects Architect to a reports repo (URL plus GitHub PAT). `--publish-status` shows connection state and project list. Once configured, every scan automatically pushes data.

Mobile is currently iOS only and in Apple App Review. Android is blocked pending Google Play Organization-account requirements. None of this affects Architect-side behavior; the publish wiring is stable.

## Ghost Suite

Ghost Suite is Ghost Architect™ plus Ghost Listener (a separate live-meeting-intelligence product) sold together. When the Suite is configured, Ghost Architect findings are pre-loaded into Ghost Listener's system prompt so Listener can cross-reference live meeting conversation against the known risk profile.

Ghost Partner is not part of the Suite. It is a feature of Architect only.

## Product Positioning

Ghost Architect™ is a pre-engagement triage tool. The differentiation, in plain terms:

- It runs once, before an engagement starts, on a codebase the user just inherited or is about to bid on.
- It does not replace engineers. It gives them a map.
- It does not run dynamic analysis or prove exploits. Findings are pattern-based starting points.
- It is not a continuous PR-review tool (that is Kodus's category, with a different lifecycle moment, different buyer, different output artifact).
- It is local-first. The codebase never leaves the user's machine except for the LLM API calls, which are subject to Anthropic's standard 7-day deletion and no-training policy.

Output is a branded PDF that an agency founder, fractional CTO, or executive can hand to a stakeholder. That is the artifact. Everything else in the tool serves producing that artifact.

## Standing Rules When Working on This Codebase

These are EJ's standing preferences and have been violated by past Claude sessions. They apply globally:

- No em dashes anywhere in Ghost Architect copy. This includes README, LinkedIn posts, npm description, website, in-tool messages, and code comments that will be user-visible. Use commas, parentheses, periods, colons, or rephrase.
- Always append ™ to "Ghost Architect" and "Ghost Platform" in user-facing copy.
- Ghost Partner is a feature of Ghost Architect, not a separate product. Pricing and marketing should never list it as standalone.
- Ghost Architect is platform-agnostic. Never describe it as Magento-only or Adobe-Commerce-only.
- The `TIER` constant in `bin/ghost.js` is branch-specific. Always confirm after a cherry-pick.
- Version bumps require touching both `bin/ghost.js` (VERSION constant) and `package.json` (version field). Use `grep -n "VERSION" bin/ghost.js` to confirm the current line.
- No double-quote-wrapped LinkedIn copy. EJ writes posts without surrounding quotes.
- Do not pitch Ghost Architect on thought-leadership posts. Pitch only on posts that directly describe Ghost's use case.
- Kodus is not a competitor in the same category. Do not engage Kodus-authored LinkedIn posts.

## Recent Version History (v4.7 to v5.0.0)

- **v4.7.x (April 12 to 20, 2026):** Ghost Team and Enterprise features built on the `ghost-team` branch. Enterprise gating by repo-name-contains-`enterprise` shipped. Three-device cross-platform test (iMac, MacBook, Surface) confirmed the team-sync flow.
- **v4.8.0 (April 22, 2026):** Hallucination fixes via regex and LLM verifiers. Narrator source-grounding. Shared finding parser introduced. `.npmignore` tightened (20MB to 165kB tarball). Validated 7/7 on magento-2-seeder. Commit `fea6338`.
- **v4.9.0 (April 24, 2026):** Three CLI flags added: `--max-context` (with tier-clamping), `--exclude` (glob), `--exclude-presets` (test-data, generated, vendor-cache). New files `src/loader/tierCaps.js` and `src/loader/excludes.js`. Published to npm as `ghost-architect-open@4.9.0`.
- **Ghost Partner spec (April 24, 2026):** Designed on the `ghost-partner` branch from v4.9.0. Profile library, YAML/MD/TXT formats, interactive picker with mandatory "None, use Ghost defaults" option, white-label PDF reports.
- **v5.0.0 (May 5, 2026):** Reconciliation across all three branches. All branches now report v5.0.0 with no suffixes. Path-traversal check from Team backported to Pro's `projectDir()` as defense-in-depth. Team's update-checker guard switched from version-string suffix sniffing to `TIER !== 'open'` (since suffixes were dropped). Open verified clean and tagged. Commits: `6ec7157` on main, `6144c15` on ghost-team-merge, `891b440` on ghost-open.

## Phase D, Outstanding Reconciliation Work

These are known gaps after the v5.0.0 reconciliation. They are scheduled after Prompt Triage v1 ships, probably late May or June 2026:

1. **Loader redactor port to Pro and Team.** Wire `redactContent` into Pro's and Team's `buildContext`, fail-closed checks, regression tests. The redactor file already exists in both branches; only the wiring is missing. This is a real security gap: Pro and Team currently send unredacted content to the API. Estimated 2 to 3 hours plus testing.
2. **`loadFromPath` port to Pro and Team, plus `--scan` flag enablement.** Open exports `loadFromPath` for non-interactive scans; Pro and Team don't. Enabling `--scan` requires the export plus flag wiring. Estimated 30 to 60 minutes.
3. **NPM update-checker code parity to Pro and Team.** The update-check function exists on Open but not Pro or Team. Pure hygiene: the new `TIER !== 'open'` guard means it would early-return anyway, but the function should still be present for code parity. Estimated 30 minutes.
4. **Reconcile `IGNORED_DIRS` / `IGNORED_FILES` and multi-segment matching across branches.** Pro's implementation is more complete; Open should adopt it. Estimated 30 minutes plus testing.

Together, these four items would land Pro, Team, and Open at true code parity for the loader subsystem.

## Other Known Issues Logged for Future Work

- 13 abandoned `ghost-architect*` worktree directories on the iMac need a cleanup pass.
- `ghost-team` and `ghost-team-merge` branch deduplication.
- Test infrastructure (jest config plus tests) for Pro and Team. Currently no automated tests.
- Phase 2 architectural refactor: collapse three branches into one with `TIER`-driven build flags. Would eliminate the cherry-pick-and-update-TIER pattern entirely.
- Profile schema extension to support Prompt Triage findings.
- Configstore namespace collision: `ghost-open` and Pro both write to the same `'ghost-architect'` Configstore key. Settings can leak between tiers if a user has multiple installed.
- Dead `src/modes/compare.js` in Open's worktree (Compare requires features Open doesn't have).
- `src/analyst/` directory is dead code (see Architecture section).

## Running the Tool

```bash
cd /Users/ejwisner/ghost/ghost-architect4   # or ghost-team-merge or ghost-architect-open
node bin/ghost.js                            # interactive
node bin/ghost.js --version                  # smoke test
node bin/ghost.js --help                     # full flag reference
```

Smoke tests after any change to `bin/ghost.js`, `src/loader/`, `src/modes/`, or `src/core/`:

1. `node bin/ghost.js --version` must print `ghost-architect v{VERSION} ({TIER})`.
2. `node bin/ghost.js --help | head -3` header line must include `(v{VERSION}, {TIER} tier)`.
3. `node bin/ghost.js` banner must render with correct version and tier label, input method menu must populate.
4. Run a real scan against a known repo before committing anything that touches the agent loop, narrator, or verifier.

## Business Infrastructure

- Domain: `ghostarchitect.dev` (Cloudflare DNS, GitHub Pages plus Cloudflare for the marketing site)
- Support: `support@ghostarchitect.dev` (Cloudflare Email Routing to Gmail)
- Copyright: US registration Case #1-15123488721
- Trademark: Class 042 pending. Conflict exists with "Ghost Architect AI"; IP attorney review needed before enterprise sales scale up.
- LLC formation: on hold; revisit when an enterprise contract is imminent.

## Copyright

Copyright © 2026 Ghost Architect. All rights reserved.
