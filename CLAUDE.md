# Ghost Architect™ — Claude Code Context

## Project Identity
- **Product:** Ghost Architect™ — AI-powered codebase archaeology CLI
- **Version:** 4.6.0 (hardcoded in TWO places — always update both)
  - `bin/ghost.js` line 18: `const VERSION = 'x.x.x'`
  - `package.json`: `"version": "x.x.x"`
- **Working folder:** `/Users/ejwisner/ghost/ghost-architect4`
- **Repo:** `https://github.com/EJWisner/ghost-architect.git` (private)
- **Runtime:** Node.js v19.8.1 — ESM modules (`"type": "module"`)
- **IDE:** PhpStorm (not VS Code)

## Architecture Overview

```
bin/ghost.js          — CLI entry point, version constant, startup banner
src/
  loader/index.js     — File loading: local filesystem + GitHub API (getBlob tree API)
  analyst/
    index.js          — Single-pass analysis orchestration
    multipass.js      — Multi-pass scanning for large codebases
  core/
    agent/            — ReAct agent loop (index, loop, planner, tools, verifier, narrator, memory)
    conflict.js       — Conflict Detection mode core logic
    estimator.js      — Cost/token estimation
    multipass.js      — Core multipass logic (extracted layer)
    projects.js       — Project management and history
  modes/
    poi.js            — Points of Interest scan mode
    blast.js          — Blast Radius Analysis mode
    conflict.js       — Conflict Detection mode UI + session management
    chat.js           — Chat mode
    compare.js        — Before/after report comparison
  config.js           — Configstore wrapper (API key, GitHub token, settings)
  estimator.js        — Top-level estimator (delegates to core)
  prioritizer.js      — Finding prioritization logic
  projects.js         — Top-level project management
  redactor.js         — PII/sensitive data redaction
  reports.js          — Report generation (TXT, MD, PDF)
  pdf-generator.js    — Branded PDF report generation (pdfkit)
  utils/errors.js     — Error handling utilities
prompts/
  index.js            — Claude system prompts (POI, Blast, Chat)
  conflict.js         — Conflict Detection prompts
web/                  — React dashboard (port 4731) — separate from CLI
assets/logo.jpeg      — Ghost Architect brand logo
```

## Scan Modes
1. **Points of Interest (POI)** — Maps red flags, landmarks, dead zones, fault lines
2. **Blast Radius Analysis** — Impact map + rollback plan for a given change
3. **Conflict Detection** — Contract mismatches, schema conflicts, config errors
4. **Chat** — Free-form Q&A about the loaded codebase
5. **Compare Reports** — Before/after diff of two saved reports

## Key Technical Decisions
- **ESM only** — all imports use `import/export`, no `require()`
- **GitHub loading** uses `octokit.rest.git.getBlob()` (tree API, not `getContent`) to avoid rate limits
- **Multipass** runs multiple Claude API passes for codebases exceeding token limits
- **Checkpoint recovery** saves pass state so interrupted scans can resume
- **Context limit:** 50,000 token max per file; oversized files are skipped with a warning
- **Auto-retry:** 15/30/60s delays on Claude API overload errors
- **Windows rendering:** ASCII fallbacks for all Unicode symbols via SYM helper (Mac/Linux keep Unicode)
- **Folder multi-select:** Root-level folders shown as pre-selected checkboxes for GitHub repos
- **Est. time display:** Uses `Math.max(3, Math.round(estimatedPasses * 3.5))` multiplier in `src/core/agent/planner.js`

## Node.js Compatibility Notes (v19.8.1)
- Use `inquirer@9.2.x` — newer versions require Node 20+
- Use `configstore@6.0.0` — newer versions require Node 20+
- Avoid `sharp` — use `jimp` for image processing (pure JS, no native bindings)
- All packages must support Node 19 or install with `--legacy-peer-deps` if needed

## Configstore Keys
Stored at `~/.config/configstore/ghost-architect.json`:
- `anthropicApiKey` — Anthropic API key
- `githubToken` — GitHub Personal Access Token (repo scope)
- `projects` — saved project history

## Product Positioning (Do Not Change)
Ghost Architect is a **triage tool** — "Ghost triages your codebase — categorizes risk, prioritizes findings, gives your team a map of where to start."
- Does NOT replace engineers
- Does NOT run exploits or dynamic analysis
- Findings are pattern-based starting points
- Platform-agnostic: Adobe Commerce, Salesforce CC, SAP Commerce, Laravel, C++, and more

## Active Backlog (as of v4.6.0)
- Session resumability for Conflict Detection
- Ghost Suite integration with Ghost Listener
- v5.0 planned: Electron desktop app, PhpStorm plugin

## Report Output
Reports saved to `~/Ghost Architect Reports/` as `.txt`, `.md`, and `.pdf` files.

## Running the Tool
```bash
cd /Users/ejwisner/ghost/ghost-architect4
node bin/ghost.js
```

## Copyright
Copyright © 2026 Ghost Architect. All rights reserved.
US Copyright Case #1-15123488721
