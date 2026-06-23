# 👻 Ghost Architect™

> AI-powered codebase archaeology: understand what you inherited.

**v8.2.7** — Ghost Partner Profiles in the top-level menu. Executive Brief. Ghost Brief. White-label across all seven report types.

Ghost Architect™ is a CLI tool powered by Claude that helps developers, architects, and consultants deeply **understand** existing codebases. Not generate new code: illuminate what's already there. It works on any platform, any language, any stack.

The most expensive moments in any engagement are not writing new code. They are the first weeks on an inherited codebase, and the gut-check before every risky change. A senior architect spending 2-3 days reading legacy code before contributing costs $3,000 to $5,000 in billable time. Ghost Architect compresses that to minutes.

---

## Install

```bash
npm install -g ghost-architect-open
```

Then run it from any directory:

```bash
ghost
```

That's it. On first run, Ghost walks you through a one-time setup wizard (API key, optional GitHub token, model preference, billing rates, context size). Your config is saved locally and every future run goes straight to the main menu.

**Requirements:** Node.js 18 or higher, an Anthropic API key (pay-as-you-go, not the same as a Claude.ai subscription), and optionally a GitHub Personal Access Token for private repos.

---

## What's New in v8.2.5

**Ghost Partner Profiles — now in the top-level menu**

Ghost Partner Profiles white-label every Ghost Architect output under your firm name. Your branding. Your methodology. Your billing rates. Across all seven report types.

New in v8.2.5: Ghost Partner Profile is now accessible from the very first Ghost menu — no codebase selection required. Select a profile, activate it for your session, and every scan you run uses your branding automatically.

```bash
# Access from the top-level menu
ghost
# Select: Ghost Partner Profile
# Or create a profile directly
ghost --create-profile
# Or load a specific profile for one run
ghost --profile ~/.ghost/profiles/my-profile.yaml
# Set a profile as your default
ghost --set-default-profile my-profile-slug
```

**Executive Brief** — one-page business intelligence report for non-technical stakeholders. Health score 0-100, plain-language executive narrative, manual vs AI-assisted cost comparison table, three-phase remediation sequence. Available on Pro Max, Team Max, Enterprise Max.

**Ghost Brief** — after every scan, Ghost generates a prompt pack. One prompt per finding. Structured. Sequenced. Blast-radius-aware. Paste into any AI coding tool. Available on Pro Max, Team Max, Enterprise Max.

---

## What's New in v8.1.2

**Ghost Brief™ dogfood pass 4.** Six fixes: prompt injection via consultant profile fields (narrator.js), freemium quota bypass closed (tier-gates.js), seat registration verification race fixed (enterprise.js), silent Tier 2 detector failures now surface to stderr, GitHub Enterprise Server URL parsing fixed for team-sync, GitHub API rate limit retry with user-facing progress messages and continue/stop prompt.

---

## What's New in v8.1.0

**Ghost Brief™ dogfood pass 1 and 2.** Ghost Architect™ scanned its own codebase using Ghost Brief™ and Claude Code fixed 19 findings across two iterative passes. Zero critical findings remaining. Test suite expanded with 4 new smoke test files.

---

## What's New in v8.0.3

**Ghost Brief™ prompt quality overhaul.** Prompts now include full remediation context, fix steps, constraints, confidence score, and effort estimate extracted directly from scan findings. Validation hints are now finding-specific.

---

## What's New in v8.0.2

### Ghost Brief™

Convert any Ghost scan into a validated, blast-radius-aware Claude Code prompt pack. Feed `ghost-brief.json` directly into Claude Code, Cursor, or Copilot. Ghost briefs the AI. The AI fixes the code.

**Run it:**

```bash
ghost --brief --input=ghost-report.json
```

Or select Ghost Brief™ from the interactive menu after any scan.
Ghost auto-detects your most recent findings file and confirms
before generating.

Ghost reads your findings JSON, converts each finding into a structured prompt with blast-radius ordering, validation hints, and file context — and writes `ghost-brief.json` to disk. If Ghost Portal™ is configured, the Brief is pushed automatically.

Ghost Brief™ requires Ghost Pro Max or higher.

---

## Works on any codebase

Ghost is platform agnostic and language agnostic. Used in production on:

- **Adobe Commerce / Magento 2** (most common)
- **Shopify / Shopify Plus**
- **Oracle Commerce / ATG**
- **SAP Commerce (Hybris)**
- **Salesforce Commerce Cloud**
- **Microservices architectures**: distributed systems, event-driven platforms
- **Mobile apps**: React Native, Expo, Swift, Kotlin
- **Game engines and runtimes**: Unreal, raylib, EASTL
- **Any language**: PHP, Java, Python, Node.js, TypeScript, Ruby, Go, C++, C#, Swift, Kotlin

If it's code, Ghost reads it.

---

## Nine modes

**💬 Question**
Ask anything about the codebase in plain English. Ghost answers like a senior architect who has read every file.

> *"Why does this integration use synchronous SOAP calls?"*
> *"What would happen if I removed this middleware?"*
> *"Walk me through the checkout pipeline, top to bottom."*

**🗺 Points of Interest Scan**
Auto-generates a structured intelligence report organized into four categories:
- 🔴 **Red Flags**: load-bearing technical debt, ticking time bombs, security risks
- 🏛️ **Landmarks**: core logic everything else orbits around
- ⚰️ **Dead Zones**: abandoned code nobody knows if they still need
- ⚡ **Fault Lines**: fragile seams where assumptions don't match

Every finding is severity-rated, includes effort and complexity estimates, a dollar-cost remediation range, and concrete fix steps. Findings are verified against actual source code; false positives are dropped or flagged before they reach the report.

**💥 Blast Radius Analysis + Rollback Plan**
Pick any file, class, method, or coordinated change set. Ghost maps the full impact (direct dependencies, ripple effects, danger zones, silent-failure risks) and produces a complete rollback plan so your team is protected if anything goes wrong.

The rollback plan includes:
- Pre-change snapshot of critical state
- Numbered step-by-step rollback instructions with time estimates
- Total rollback time estimate
- Point of No Return: exactly when rollback becomes harder or impossible
- Who to notify and what action they must take
- Smoke test checklist to confirm rollback succeeded

**⚡ Conflict Detection**
Scan a codebase for places where two or more parts make conflicting assumptions about the same thing: shared config keys, API contracts, database schemas, data shapes, constants. Each candidate conflict is verified against the source code and rated as confirmed, possible, or false positive.

Useful before deployments, integration work, or migrations.

**🔮 Commit Forecast**
Analyze your proposed changes against the production codebase and forecast the Blast Radius and Conflict impact before you commit or push. Ghost does not apply changes, does not commit, does not push — it shows you what *would* happen if you did.

Two entry surfaces:

- **Pre-commit:** Ghost auto-discovers your working-tree changes via `git diff --name-only HEAD`. Run it before every push. No arguments needed.
- **Offline / received files:** Point Ghost at a folder of proposed files that mirrors the repo structure. Covers the offshore-review use case: an architect receives files from an offshore team and wants to assess impact before accepting them.

> Cut your container-to-stage cycles from five to one. Ghost analyzes your proposed changes against the production codebase directly — before you push — so you find out in seconds, not after a failed deploy.

**🧪 Prompt Triage**
Audit prompts and prompt-driven workflows in your codebase for structural issues: missing context, ambiguous instructions, brittle assumptions, token bloat. Designed for teams building LLM-integrated applications who need to catch prompt drift before it reaches production.

**🔍 Recon (sizing only)**
A pre-engagement sizing report. Single planner call (~$0.05), no full scan. Produces a markdown or PDF deliverable describing what a full scan would surface, sized against the actual codebase. Useful for:

- Quoting a fixed-fee engagement before committing scan budget
- Showing a prospect what pre-engagement diligence looks like
- Quick scoping during discovery calls

When a Ghost Partner™ profile is loaded, recon reads in the consultant's voice and emphasizes their methodology's priorities.

**🔍 Compare Reports**
Diff two saved Ghost reports (before and after a refactor, upgrade, or fix cycle) to see exactly what moved: which findings were resolved, which are new, and where severity shifted. Quantifies remediation progress.

**📊 Project Dashboard**
Track remediation velocity across all your scanned projects. Shows critical/high/medium/low finding counts, resolved vs. remaining, and progress over time. Pro+ feature.

---

## 👥 Ghost Partner™: White-label consultant profiles

Consultants and agencies can run scans on behalf of their client engagements with their own branding, methodology, and rates baked into the report.

A **Ghost Partner™ profile** is a YAML file describing the consultant: their priorities, anti-patterns, red flags, billing rates, brand color, and contact info. When a profile is loaded with `--profile`, Ghost:

- Applies the consultant's lens to the analysis (findings reflect their methodology)
- Renders the report in the consultant's voice (no Ghost Architect branding in the output)
- Uses the consultant's billing rates for cost estimates (per-tier overrides supported)
- Produces a fully white-labeled PDF with the consultant's logo, accent color, and footer

### Creating a profile: the easy way

Don't hand-write YAML. Use the built-in profile wizard:

```bash
ghost --create-profile
```

Ghost walks you through a short interactive flow asking for your name, firm, brand color, optional logo path, top priorities, anti-patterns, red flags, and per-profile billing rates. The wizard saves a fully-formed YAML file to `~/.ghost/profiles/{slug}.yaml` and prints the path you'll use to invoke it.

You can also reach the wizard from the main menu:

- Run `ghost`
- Pick **Manage Ghost Partner Profiles**
- Pick **Create new profile**

The same menu lets you edit existing profiles, set a default profile (auto-applied to every scan unless overridden), open a profile in your `$EDITOR` for fine-grained YAML edits, or delete profiles you no longer need.

### Using a profile

Three ways, in priority order:

```bash
# 1. Per-run, explicit path
ghost --profile ~/.ghost/profiles/my-profile.yaml

# 2. Set a default: auto-applied to every scan
ghost --set-default-profile my-profile
ghost                                 # default profile loads automatically
ghost --no-profile                    # opt out of the default for one run
ghost --clear-default-profile         # remove the default

# 3. List what you have
ghost --list-profiles
```

When a profile is active, the main-menu input options show a `[profile: <name> ●]` annotation so you always know which lens is loaded before you scan.

### Editing a profile by hand

Profiles are plain YAML files in `~/.ghost/profiles/`. You can edit them in any editor. Save your changes and the next scan picks them up: no rebuild step.

### Bring your own methodology document

If you already have a written methodology (a Google Doc, a one-pager, a Notion page, a markdown audit guide) you don't need to use the wizard. Save the document as a `.md` or `.txt` file anywhere on your machine and point Ghost at it directly:

```bash
# Markdown methodology: Ghost looks for ## Priorities, ## Anti-patterns,
# ## Red flags, and ## Branding sections, plus optional YAML frontmatter
ghost --profile ~/Documents/my-audit-methodology.md

# Plain text: Ghost extracts the structure via Claude and caches the result
ghost --profile ~/Documents/my-audit-methodology.txt
```

Ghost auto-detects the format from the file extension:

- **`.yaml` / `.yml`**: parsed directly. Free, instant. (This is what the wizard produces.)
- **`.md` / `.markdown`**: Ghost looks for YAML frontmatter (between `---` markers at the top) and recognized section headings (`## Priorities`, `## Anti-patterns`, `## Red flags`, `## Branding`). Bullets under those headings become list entries; key/value lines under `## Branding` become the branding object. Anything else is preserved as prose context for the scan. Free, instant.
- **`.txt` / anything else**: full prose extraction via Claude. Ghost reads the document, extracts the canonical schema, and caches the result at `~/.ghost/profiles/.cache/{hash}.json`. The extraction LLM call costs a few cents the first time; subsequent scans with the same file are free (the cache is keyed on content hash, so editing the file invalidates the cache automatically).

**Recommended location:** save imported methodology files in `~/.ghost/profiles/` alongside wizard-generated profiles. They'll show up in `ghost --list-profiles` and in the menu's profile picker, and you can manage them all from the same place.

**Recommended workflow:** start with whatever doc you already have. Run a scan with `--profile` pointing at it. Review the report. If you want to tighten the methodology, run `ghost` → **Manage Ghost Partner Profiles** → **Edit existing profile** to refine the structured fields, or open the cached YAML in your editor for direct edits.

### Profile schema

Example of the canonical YAML schema (what the wizard produces, what `.md` and `.txt` files get extracted into):

```yaml
name: "Magento & Shopify Performance, Security & Server Cost Audit"
author: "Satish Mantri"
organization: "OSCProfessionals"

priorities:
  - Site speed and Core Web Vitals on category and product pages
  - Server cost efficiency
  - Security exposure
  - Database query efficiency: N+1 patterns, missing indexes
  # ...

anti_patterns:
  - Custom code overriding Magento core without preference patterns
  - Direct database queries bypassing the ORM
  # ...

red_flags:
  - Missing Magento security patches
  - Admin URL using the default /admin path with no IP allowlist
  # ...

# Per-profile billing rates (optional, partial overrides supported)
rates:
  junior: 50
  mid: 90
  senior: 150

# White-label branding
branding:
  company_name: "OSCProfessionals"
  accent_color: "#0B5394"
  footer_text: "OSCProfessionals: Performance, Security & Server Cost Audit"
  confidentiality: "Confidential: Prepared for client engagement use only"
```

Profiles can be authored as `.yaml`, `.yml`, `.md`, or `.txt`. Markdown and plain-text profiles are extracted via Claude into the canonical schema and cached locally.

**Ghost Partner™ profiles are a paid-tier feature** (Pro, Team, Enterprise). The free Open tier produces neutral Ghost-branded reports.

---

## Privacy and security

**Your code never leaves the analysis moment.**

Ghost Architect™ works like a filter: your codebase goes in, the analysis comes out, and the code itself is immediately discarded. It is never stored on any server, never written to any database, never retained between sessions. Think of it as running your code through an expert analyst who reads it, gives you the report, and forgets everything they saw.

- **No code retention:** your codebase passes through Claude's analysis and is gone. Anthropic does not store API call content for training under standard API terms.
- **Local config only:** your API key and all settings are stored exclusively in a config file on your own machine. They are never transmitted anywhere except to Anthropic's API to authenticate your calls.
- **No third-party sharing:** Ghost connects only to Anthropic's API (and optionally GitHub for repo loading). No telemetry, no analytics, no phone-home.
- **Reports stay local:** saved reports are written to your machine only.
- **Source-available:** you can read every line of Ghost Architect's code and verify these claims yourself.

This makes Ghost safe to use on proprietary enterprise codebases, client work, and confidential systems.

---

## Tier comparison

| Feature | Open (free) | Pro | Pro Max | Team | Team Max | Enterprise | Ent. Max |
|---|---|---|---|---|---|---|---|
| Question | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Points of Interest scan | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Blast Radius + Rollback | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Conflict Detection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Commit Forecast | 1 free / install | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Prompt Triage | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Recon sizing | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reports saved as MD / PDF / TXT | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Project labels + history tracking | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Project Dashboard | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Compare Reports (before/after) | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Inheritance Audit (deal-grade) | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ghost Partner™ profiles | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| White-label PDF rendering | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Per-profile billing rate overrides | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Ghost Brief™** | — | — | ✅ | — | ✅ | — | ✅ |
| **Unified Brief (all seats)** | — | — | — | — | ✅ | — | ✅ |
| **Ghost Partner co-engagement** | — | — | — | — | — | — | ✅ |
| Team sync features | — | — | — | ✅ | ✅ | ✅ | ✅ |
| Custom enterprise gating | — | — | — | — | — | ✅ | ✅ |
| Context cap | 50K tokens | 100K | 100K | 150K | 150K | 200K | 200K |
| Pricing | Free, BYOK | $99/mo | $199/mo | $399/mo | $799/mo | $1,200/mo+ | $2,500/mo+ |

**Ghost Brief™ tiers at a glance:**

| Tier | Price | Ghost Brief™ |
|---|---|---|
| Ghost Open | Free | ❌ |
| Ghost Pro | $99/mo | ❌ |
| Ghost Pro Max | $199/mo | ✅ |
| Ghost Team | $399/mo | ✅ |
| Ghost Team Max | $799/mo | ✅ Unified Brief |
| Ghost Enterprise | $1,200/mo | ✅ |
| Ghost Enterprise Max | $2,500/mo | ✅ + Ghost Partner |

The free Open tier is fully featured for individual scans. Project history, before/after comparison, white-label consultant rendering, deal-grade Inheritance Audit, and team sync are paid-tier capabilities. Ghost Brief™ is available on Pro Max and above.

Pricing details and sign-up at [ghostarchitect.dev](https://ghostarchitect.dev).

---

## Before you install: getting your API key

Ghost Architect™ uses the Anthropic API directly. This is **not** the same as a Claude.ai subscription: it is a separate pay-as-you-go developer account with no monthly fee.

**Step 1: Create an Anthropic API account.**
Go to [console.anthropic.com](https://console.anthropic.com) and sign up. You can use the same email as a Claude.ai account: they are separate accounts under the same company.

**Step 2: Add a payment method and load credits.**
The API is pay-as-you-go. Add $5 to $10 to get started: that's enough for many full sessions.

**Step 3: Generate an API key.**
In the console, go to **API Keys → Create Key**. Name it (e.g. `ghost-architect`). Copy the key: it starts with `sk-ant-` and is only shown once.

> **Important:** Your Claude.ai subscription balance and your API credits are separate billing accounts. One does not fund the other even if you use the same email address.

---

## Two ways to provide your API key

**Method 1: Setup wizard (recommended for most users).**
Run `ghost` and the interactive wizard handles everything on first launch. Your key is stored locally, masked during entry, and never displayed again.

**Method 2: Environment variable (power users and CI/CD).**
Set `ANTHROPIC_API_KEY` before running and Ghost skips the wizard entirely.

```bash
# One-time in your current terminal session
export ANTHROPIC_API_KEY=sk-ant-xxxx
ghost

# Inline for a single run
ANTHROPIC_API_KEY=sk-ant-xxxx ghost

# Permanent: add to your shell profile
echo 'export ANTHROPIC_API_KEY=sk-ant-xxxx' >> ~/.zshrc
source ~/.zshrc
```

You can also set `GITHUB_TOKEN` the same way for private repo access:

```bash
export GITHUB_TOKEN=ghp_xxxx
```

> **Priority rule:** Environment variables always take precedence over the stored wizard config. Useful for switching keys between projects or clients without reconfiguring.

---

## What does it cost to use?

Ghost shows a cost estimate **before** every scan and the actual cost **after**. No surprises.

| Operation | Codebase size | Est. cost (Sonnet 4.6) |
|---|---|---|
| Recon (sizing only) | Any | ~$0.05 |
| Question exchange | Any | ~$0.02 to $0.08 |
| Commit Forecast | Any | ~$0.15 to $0.60 |
| Points of Interest scan | Small (~50 files) | ~$0.15 |
| Points of Interest scan | Medium (~150 files) | ~$1.50 |
| Points of Interest scan | Large (~500 files) | ~$4.00 |
| Blast Radius Analysis | Any | ~$0.10 to $0.30 |
| Conflict Detection | Medium | ~$0.50 to $1.50 |

**The real comparison:** a senior architect doing the same analysis manually bills $3,000 to $5,000. Ghost delivers comparable depth in minutes for under a few dollars.

A typical full session (one POI scan, two blast radius analyses, and several questions on a medium enterprise codebase) runs roughly **$1.50 to $3.00 total.**

Ghost uses **Claude Sonnet 4.6** by default. Switch to **Claude Opus 4.7** in settings for maximum analytical depth on the most complex codebases.

At the end of every session, Ghost displays a summary of every operation run and the total session cost.

---

## Command-line flags

For a complete, always-current flag reference, run `ghost --help` in your terminal. `--help` is the source of truth for every supported flag.

```bash
ghost [options]

Options:
  --max-context <N>          Override the context cap in tokens.
                             Clamped to your tier limit.

  --exclude "<glob>"         Exclude files matching a glob pattern.
                             Repeatable. Example: --exclude "seeds/**"

  --exclude-presets a,b      Apply named exclusion preset(s).
                             Run `ghost --help` to see available presets.

Ghost Partner™: white-label consultant profiles:
  --profile <path>           Load a profile from .yaml/.yml/.md/.txt and apply
                             the consultant's lens + branding to all scans.
  --no-profile               Run without any profile, even if a default is set.
  --create-profile           Launch the interactive profile wizard, save the
                             result to ~/.ghost/profiles/, then exit.
  --list-profiles            List profiles in ~/.ghost/profiles/ and show which
                             one is currently the default. Then exit.
  --set-default-profile <slug>
                             Set the default profile by slug (filename without
                             .yaml). Auto-applied to every scan unless
                             --profile or --no-profile overrides it.
  --clear-default-profile    Remove the default profile setting.

Misc:
  --version, -v              Print version.
  --help, -h                 Print help.
```

When flags are omitted, Ghost runs interactively and uses your configured defaults.

---

## Workflows

### New Project Onboarding
You've inherited a codebase you've never seen.

```
1. Clone or download to your machine
2. Run Ghost → Local directory or ZIP
3. Run Points of Interest scan
4. Save the report, label it with the project name
5. Read the findings before writing a line of code
```

**Result:** in minutes you understand what's fragile, what's critical, what's dead weight, and where not to touch without a plan. Two weeks of senior-architect ramp-up, compressed.

---

### Pre-Engagement Diligence (consultants) *(Pro+)*
Before quoting an engagement, run Recon to size the codebase and identify high-risk areas. Then if the prospect commits, run a full scan with your Ghost Partner™ profile loaded.

```
1. Recon scan with --profile loaded → ~$0.05, ~30 seconds
2. Send the recon PDF to the prospect (white-labeled, your branding)
3. On engagement, run full POI / Blast / Conflict scans with the same profile
4. Reports go to the client carrying your name, your methodology, your rates
```

**Result:** a pre-engagement deliverable that establishes your value before you've billed an hour. Ghost's planner reads the codebase through your methodology lens and produces a sizing report the prospect can use to scope the engagement.

---

### Before / After Validation *(Pro+ for the Compare feature)*
Confirm changes actually improved the codebase, and didn't introduce new problems.

```
Round 1, Before:
1. Run POI scan, save report with label "pre-refactor"
2. Note all findings and their severity

Make your code changes.

Round 2, After:
1. Run POI scan on the same project
2. Save report with label "post-refactor"
3. Open both MD reports side by side (or use Compare Reports)
4. Confirm resolved issues are gone
5. Check no new issues were introduced
```

**Result:** a clear before/after record of code quality improvement. Every finding resolved is documented. Every new issue introduced is caught before it reaches production.

---

### Pre-Change Risk Assessment
Before touching anything significant (a shared interface, a payment class, a core configuration file) run a Blast Radius Analysis first.

```
1. Run Ghost → Blast Radius Analysis
2. Enter the file, class, or method (or pick multiple for a coordinated change set)
3. Read the full impact map and rollback plan
4. Make your change with full awareness of consequences
5. Follow the rollback plan if anything goes wrong
```

**Result:** no more surprise production incidents from "minor" changes. The rollback plan means you're never stuck at 2am with no path back.

---

### Pre-Deployment Conflict Audit
Run Conflict Detection before any major release, integration, or migration.

```
1. Run Ghost → Conflict Detection
2. Verify confirmed conflicts before deployment
3. Resolve config / schema / contract mismatches first
4. Save the report as part of the release record
```

**Result:** catches contract drift, config-key mismatches, and schema disagreements before they become production incidents.

---

### Pre-Push Commit Forecast
Before every push, know what your changes will break.

```
1. Make your changes in your working directory (as normal)
2. Run Ghost → Commit Forecast → Pre-commit
3. Ghost auto-detects your changed files via git diff
4. Read the blast radius and conflict forecast
5. Fix anything critical before you push
```

**Result:** container-to-stage cycles drop from five to one. You find out what breaks before the push, not after a failed deploy. The offshore version of the same workflow — point Ghost at a folder of received files instead of your working tree, and assess impact before accepting the changes.

---

### Ongoing Technical Debt Tracking *(Pro+)*
Run a POI scan at the start of every sprint or major milestone. Save each report with a date label. The Project Dashboard then shows your debt trajectory over time.

```
ghost-poi-project-name-sprint-1-2026-03-01.txt
ghost-poi-project-name-sprint-5-2026-05-01.txt
ghost-poi-project-name-sprint-10-2026-07-01.txt
```

**Result:** a timestamped record of how technical debt is growing or shrinking. Useful for client reporting, delivery reviews, and justifying refactoring investment.

---

## Input methods

- **Local directory:** point at any folder using a path or drag-and-drop into Terminal
- **ZIP file:** load a codebase archive directly
- **GitHub repo:** any public repo, or private with a GitHub token

---

## Report outputs

Every scan saves three formats simultaneously to `~/Ghost Architect Reports/`:

**📄 Plain text (.txt):** terminal-friendly raw output. Opens anywhere, works in any system.

**📋 Markdown (.md):** beautifully formatted document with severity badges, tables, and proper structure. Renders in VS Code, GitHub, Obsidian, Notion, or any Markdown viewer.

**📑 PDF (.pdf):** branded professional report with cover page, color-coded severity sections, formatted remediation table, page numbers, and footer. The client-ready deliverable. When a Ghost Partner™ profile is loaded, the PDF is fully white-labeled with the consultant's branding.

Every report is timestamped. Reports are automatically organized by project label (paid tiers) for easy comparison across scans.

---

## Private repository access

Ghost supports private GitHub repositories via a Personal Access Token.

**Setup:**
1. Go to `github.com/settings/tokens`
2. Click **Generate new token (classic)**
3. Select the **repo** scope
4. Copy the token (starts with `ghp_`)
5. Run Ghost → **Reconfigure Ghost Architect**, enter your token

Your token is stored locally and never transmitted anywhere except GitHub's API.

**Alternative:** for very large or sensitive private repos, download as ZIP and use the ZIP file loader. No authentication required and often faster.

---

## Philosophy

Ghost Architect™ is a **thinking accelerator**, not a code generator.

The goal is to help developers and their organizations think more deeply about systems they own. Every enterprise codebase contains institutional knowledge (patterns, decisions, warnings, traps) that lives nowhere but the code itself. When the developer who built it leaves, that knowledge disappears. Ghost surfaces it before it's gone, and makes it available to everyone who comes after.

It is not here to replace senior architects. It is here to give them a running start.

---

## Built with

- [Claude API](https://docs.claude.com) by Anthropic
- [Inquirer.js](https://github.com/SBoudrias/Inquirer.js) for interactive CLI prompts
- [Octokit](https://github.com/octokit/octokit.js) for GitHub API integration
- [Chalk](https://github.com/chalk/chalk) and [Figlet](https://github.com/patorjk/figlet.js) for terminal UI
- [Boxen](https://github.com/sindresorhus/boxen) for terminal panels
- [Configstore](https://github.com/yeoman/configstore) for local config management
- [Ora](https://github.com/sindresorhus/ora) for terminal spinners
- [ADM-ZIP](https://github.com/cthackers/adm-zip) for ZIP file extraction
- [PDFKit](https://github.com/foliojs/pdfkit) for PDF report generation

---

## Support

Questions: [support@ghostarchitect.dev](mailto:support@ghostarchitect.dev)
Pricing and upgrades: [ghostarchitect.dev/pricing](https://ghostarchitect.dev/pricing)
Documentation and product info: [ghostarchitect.dev](https://ghostarchitect.dev)

---

## Ghost Portal™

Ghost Portal™ is a web-based dashboard that displays your scan reports in a living, shareable interface — organized by mode, project, and severity. Every scan you run automatically pushes its artifacts to your private GitHub repository and appears in your Portal within seconds.

**Activate Ghost Portal™ (Pro and above)**

1. Visit [ghostarchitect.dev/portal-setup](https://ghostarchitect.dev/portal-setup)
2. Click **Connect GitHub** — Ghost will request permission to create one private repository in your account
3. Your Portal goes live immediately at `ghostarchitect.dev/portal-{your-github-username}`
4. Run any Ghost scan — reports push automatically, no additional configuration needed

**What your Portal includes**

- All scan modes: Points of Interest, Blast Radius, Conflict Detection, Commit Forecast, Fix Forecast, Inheritance Audit, Prompt Triage, and more
- Per-project remediation tracking with progress over time
- Client-ready PDF reports accessible from any browser
- No file attachments — share a URL, not a document

Ghost Portal™ is available on Ghost Pro, Team, and Enterprise tiers. Ghost Open users can upgrade at [ghostarchitect.dev/pricing](https://ghostarchitect.dev/pricing).

---

*"The best architects don't write all the code. They help you understand what you have."*

---

## License

Ghost Architect™ is licensed under the Business Source License 1.1 (BUSL-1.1).

Free for personal, non-commercial, and small team use (up to 5 users).
Commercial use beyond these limits requires a paid license: see [ghostarchitect.dev](https://ghostarchitect.dev).
After 4 years from each version's release date, the code converts to GPL v3.

See [LICENSE](./LICENSE) for full terms.

---

**Copyright © 2026 Ghost Architect. All rights reserved.**

Ghost Architect™ is proprietary software. Unauthorized use, reproduction, or distribution is strictly prohibited.

*Not a code generator. A thinking accelerator.*

## What's New in v9.0.5

### 🔭 Ghost Watcher™ — Automatic commit monitoring

Ghost Watcher™ monitors every commit automatically. When a developer pushes to GitHub, Ghost fires — analyzing changed files against the full codebase, surfacing findings, and generating a Ghost Brief™ prompt pack. Results land in Ghost Portal before the PR reviewer opens the tab.

**Available on Ghost Team and Ghost Enterprise memberships.**

---

## 🔭 Ghost Watcher™

Ghost Watcher™ is a headless CI pipeline that runs inside GitHub Actions. Every commit your team pushes triggers a full Ghost Architect™ scan automatically — no manual runs, no forgotten reviews.

### The loop
Developer commits → GitHub Actions fires → Ghost Watcher™ runs

→ Blast Radius + Conflict Detection on changed files

→ Ghost Brief™ generates AI remediation prompts

→ Results pushed to Ghost Portal

→ PR comment posted with findings summary

→ Developer copies prompts into Claude Code, Cursor, or any AI tool

→ AI executes fixes → developer commits fixes → Ghost Watcher™ fires again

→ Loop continues until findings reach zero

### Requirements

- Ghost Team or Ghost Enterprise membership
- GitHub repository (public or private)
- Anthropic API key (BYOK — charged to your own account)
- Ghost Portal configured

### Setup

Run Ghost and select **Ghost Watcher™ → Enable Watch** from the menu:

```bash
ghost
```

The wizard will ask:
1. Which GitHub repo to watch
2. Which branches to monitor
3. Which scans to run (Blast Radius, Conflict Detection, Ghost Brief)
4. Whether to post PR comments
5. Email notification addresses
6. Your GitHub Personal Access Token (repo + workflow scope)
7. Estimated commits per day (for cost estimation)

Ghost pushes `ghost-watcher.yaml` and `.github/workflows/ghost-watcher.yml` to your repo automatically.

### GitHub Secrets

After running the wizard, add these four secrets to your GitHub repo under **Settings → Secrets and variables → Actions**:

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `GHOST_LICENSE_KEY` | Your Ghost Team or Enterprise license key |
| `GHOST_PORTAL_REPO` | Your ghost-reports repo URL |
| `GHOST_PORTAL_TOKEN` | GitHub PAT with repo write scope |

### Monitoring runs

Every commit triggers a GitHub Actions job. To watch it:

1. Go to your GitHub repo
2. Click the **Actions** tab
3. Click the **Ghost Watcher™** workflow
4. Click any run to see the live log
5. Green checkmark = scan complete, results in Ghost Portal

### Viewing results in Ghost Portal

After each run completes, open Ghost Portal and click **Ghost Watcher™** to see:

- **Commits tab** — every watched commit with severity chips. Click any commit to expand findings and prompts.
- **Findings tab** — all findings aggregated across all commits, sorted by severity
- **Prompts tab** — all Ghost Brief™ prompts ready to copy into your AI coding tool

### PR comments

When a commit is part of a pull request, Ghost Watcher™ posts a comment directly on the PR with:

- Findings count and severity breakdown
- Phase 1 findings (Critical + High — fix first)
- Phase 2 findings (Medium + Low — fix second)
- Link to Ghost Portal to copy prompts

### Cost expectations

Ghost Watcher™ uses your own Anthropic API key. Estimated cost per commit:

| Scans enabled | Est. cost per commit |
|---------------|---------------------|
| Blast Radius only | $0.15 – $0.30 |
| Blast Radius + Conflict Detection | $0.95 – $1.80 |

The Enable Watch wizard shows a cost estimate before you confirm setup.

### Skipping a scan

Add `[ghost-skip]` to any commit message to bypass Ghost Watcher™ for that commit:

```bash
git commit -m "docs: fix typo in README [ghost-skip]"
```

### Disabling Watch

Run Ghost and select **Ghost Watcher™ → Disable Watch** from the menu. This sets `enabled: false` in `ghost-watcher.yaml` without removing the workflow file — re-enable anytime.

### Configuration file

`ghost-watcher.yaml` in your repo root controls Ghost Watcher™ behavior:

```yaml
ghost_watcher:
  version: 1.0
  enabled: true
  trigger:
    branches:
      - main
      - develop
      - 'feature/**'
  scans:
    blast_radius: true
    conflict_detection: true
    ghost_brief: true
  notifications:
    pr_comment: true
  iterations:
    max: 10
```

### Ghost Watcher™ never blocks a commit

Ghost Watcher™ is advisory only. Findings are surfaced for remediation — they never prevent a commit from going through. Exit code is always 0.
