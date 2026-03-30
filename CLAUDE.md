# Ghost Architect™ — Claude Code Context

## Project Identity
- **Product:** Ghost Architect™ — AI-powered codebase triage for Adobe Commerce agencies
- **Version:** 4.6.0 (hardcoded in TWO places: `bin/ghost.js` line 18 and `package.json`)
- **Working folder:** `/Users/ejwisner/ghost/ghost-architect4`
- **Repo:** `https://github.com/EJWisner/ghost-architect.git` (private)
- **Runtime:** Node.js v25.8.2 — ESM modules (`"type": "module"`)
- **IDE:** PhpStorm (not VS Code)

## CRITICAL: Version Is Hardcoded in TWO Places
Always update both when bumping version:
1. `bin/ghost.js` line 18: `const VERSION = 'x.x.x'`
2. `package.json`: `"version": "x.x.x"`

## Architecture Overview
```
bin/ghost.js            — CLI entry point, version constant, startup banner
src/
  analyst/
    multipass.js        — Multipass scanning logic for large codebases
  projects.js           — Project management (local, ZIP, GitHub)
  estimator.js          — Token/cost estimation before multipass starts
  prioritizer.js        — Risk prioritization logic
  reports/              — PDF and TXT/MD report generation
prompts/
  index.js              — All Claude prompt templates
```

## Key Capabilities
- **Points of Interest scanning** — identifies risk areas in codebase
- **Blast Radius Analysis** — impact assessment for changes
- **Conflict Detection** — identifies conflicting customizations
- **Multipass scanning** — handles large codebases across multiple API calls
- **Checkpoint recovery** — resume interrupted scans
- **Branded PDF reports** — stakeholder-ready output
- **TXT/MD reports** — developer-ready output
- **Platform-agnostic** — Adobe Commerce, Salesforce CC, SAP, Laravel, C++, and more

## GitHub Integration
- Tree API for remote repo scanning (rate-limit safe)
- Root-level folder multi-select for remote repos
- GitHub token stored in config (NOT hardcoded)

## Scan Limits
- Oversized file protection: 50k token max per file
- Lock file exclusion (package-lock.json, composer.lock, etc.)
- Context limit detection with graceful handling
- Auto-retry on API overload: 15/30/60s delays

## Windows Compatibility
- ASCII fallbacks via SYM helper for PowerShell/CMD
- Mac/Linux keep Unicode symbols
- Windows gets [OK]/[X] equivalents

## Product Positioning
Ghost Architect is a **triage tool** — "Ghost triages your codebase — categorizes risk, prioritizes findings, gives your team a map of where to start."
- Does NOT replace engineers
- Does NOT run exploits or dynamic analysis
- Findings are pattern-based starting points
- Only tool in codebase intelligence vertical for Adobe Commerce agencies

## Privacy Story
- API-only, 7-day deletion, never trained on
- Runs locally, no data persistence

## Ghost Suite Connection
When paired with Ghost Listener (Ghost Suite), Ghost Architect findings are pre-loaded into the Claude system prompt. Ghost Listener then cross-references live meeting conversation against the known risk profile.

## Pricing (Locked)
- Free/BYOK | Pro $99/mo | Team $399/mo | Enterprise custom

## Business Infrastructure
- Domain: `ghostarchitect.dev` (Cloudflare)
- Support: `support@ghostarchitect.dev`
- Copyright: Case #1-15123488721
- Trademark: Class 042 pending (note: conflict exists with "Ghost Architect AI" — IP attorney review needed before enterprise sales)

## Running the Tool
```bash
cd /Users/ejwisner/ghost/ghost-architect4
node bin/ghost.js
```

## Version History
- **v4.6.0:** Est. time fix, GitHub rate limit fix (tree API), root folder multi-select, checkpoint recovery polish
- **v4.5.9:** Windows rendering fix — ASCII fallbacks for Unicode symbols
- **v4.5.x:** PDF rendering, auto-retry, checkpoint recovery, stream abort, oversized file protection

## Copyright
Copyright © 2026 Ghost Architect. All rights reserved.
