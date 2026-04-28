# Ghost Architect™ — Open — Claude Code Context

## Project Identity
- **Product:** Ghost Architect™ Open — free tier of the Ghost Architect codebase intelligence platform
- **Version:** 5.0.0 (hardcoded in TWO places: `bin/ghost.js` and `package.json`)
- **Working folder:** `/Users/ejwisner/ghost/ghost-architect-open` (worktree of `ghost-architect4`)
- **Branch:** `ghost-open` on `https://github.com/EJWisner/ghost-architect.git` (private repo)
- **npm package:** `ghost-architect-open` (public)
- **Runtime:** Node.js 18+ — ESM modules (`"type": "module"`)
- **IDE:** PhpStorm (not VS Code)

## CRITICAL: Version Is Hardcoded in TWO Places
Always update both when bumping version:
1. `bin/ghost.js` — `const VERSION = 'x.x.x'` (search for the constant; line number drifts)
2. `package.json` — `"version": "x.x.x"`

## v5.0.0 Reframe (April 28, 2026)

Ghost Open was reframed from "Critical+High teaser" to "free, full-featured, no project tracking." Key changes from v4.9.0:

- All five modes (Chat, POI, Blast, Conflict, Recon) are in the menu and produce full reports
- No severity-gated truncation in saved reports
- No project labels, no project intelligence baseline tracking
- No Compare Reports, no Project Dashboard (removed from menu, not locked)
- Reports overwrite by mode name: `ghost-poi.{txt,md,pdf}`, `ghost-blast.{txt,md,pdf}`, `ghost-conflict.{txt,md,pdf}`, `ghost-recon.{txt,md,pdf}` — single set of files per mode, prior runs are overwritten
- Multipass session resume keyed by MD5 hash of working directory (since project labels are gone)
- Chat is interactive only and does not save a transcript

## Architecture Overview
```
bin/ghost.js            — CLI entry point, version constant, banner, menu
src/
  config.js             — API key + settings management
  loader/
    index.js            — Load from local dir / ZIP / GitHub
    excludes.js         — --exclude and --exclude-presets logic
    tierCaps.js         — Open=50K, Pro=100K, Team=150K, Enterprise=200K
  modes/
    chat.js             — Interactive Q&A (no save)
    poi.js              — Points of Interest scan
    blast.js            — Blast Radius analysis
    conflict.js         — Conflict Detection
    recon.js            — Recon-only sizing mode
  analyst/
    index.js            — Single-pass POI / Blast / Chat
    multipass.js        — Pass builder for large codebases
  core/
    multipass.js        — Multi-pass orchestration + session resume
    verifier.js         — Regex-based source-grounding check
    llm-verifier.js     — LLM semantic check
    conflict.js         — Core conflict detection logic
    estimator.js        — Token / cost estimation
    agent/
      planner.js        — Recon planner (used by all scan modes)
      narrator.js       — Senior-architect rewrite of raw findings
  reports.js            — TXT/MD/PDF save logic (overwriting filenames)
  pdf-generator.js      — Branded PDF rendering
  redactor.js           — API-key/secret stripping before send
  utils/
    finding-parser.js   — Shared finding extraction
    errors.js           — Friendly error messages
prompts/
  index.js              — All Claude prompt templates
```

## Differences from `main` (Pro) Branch

What's NOT on Open:
- `src/profile/` directory (Ghost Partner™ profile loader + extractor)
- `src/projects.js` calls in mode files (`promptProjectLabel`, `handleProjectIntelligence`, `showProjectDashboard`)
- `src/modes/compare.js` calls in `bin/ghost.js`
- `runReconMode`'s `profile` parameter
- The `--profile` CLI flag

What IS on Open:
- `core/projects.js` — file infrastructure stays, just isn't called
- `src/modes/compare.js` and dashboard logic — files exist but unreachable from menu

## Scan Limits
- Tier cap (Open): 50,000 tokens — clamps `--max-context` overrides
- Per-pass limit: 45,000 tokens (multipass triggers above this)
- Oversized file protection: 50K token max per file
- Lock file exclusion (package-lock.json, composer.lock, etc.)
- Auto-retry on API overload: 15/30/60s delays

## Update Checker
On startup, hits `https://registry.npmjs.org/ghost-architect-open/latest` once per 24h and displays "v{newer} available" in the banner if behind. Cached in Configstore.

## Windows Compatibility
- ASCII fallbacks via SYM helper for PowerShell/CMD
- Mac/Linux keep Unicode symbols
- Windows gets [OK]/[X] equivalents

## Product Positioning
Ghost Architect is a **pre-engagement triage tool** — "Ghost triages your codebase — categorizes risk, prioritizes findings, gives your team a map of where to start."
- Does NOT replace engineers
- Does NOT run exploits or dynamic analysis
- Findings are pattern-based starting points
- Platform-agnostic — Adobe Commerce / Magento is one example among many

## Privacy Story
- Runs locally, BYOK, no telemetry
- Anthropic 7-day deletion, never trained on
- No data persistence beyond local report files

## Pricing (Locked)
- **Open:** Free / BYOK
- **Pro:** $99/mo
- **Team:** $399/mo
- **Enterprise:** $1,200/mo custom

## Business Infrastructure
- Domain: `ghostarchitect.dev` (Cloudflare)
- Support: `support@ghostarchitect.dev`
- Copyright: Case #1-15123488721
- Trademark: Class 042 pending

## Running the Tool
```bash
cd /Users/ejwisner/ghost/ghost-architect-open
node bin/ghost.js
```

Or after `npm install -g ghost-architect-open`:
```bash
ghost
```

## Copyright
Copyright © 2026 Ghost Architect. All rights reserved.
