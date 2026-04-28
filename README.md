# 👻 Ghost Architect — Open

> AI-powered codebase intelligence — free, fully featured, single-shot

Ghost Architect is a CLI tool powered by Claude that helps developers, architects, and consultants deeply **understand** existing codebases — not generate new code, but illuminate what's already there. It works on any platform, any language, any stack.

**Ghost Open is the free tier.** All five scan modes are available at full depth. Reports save as Markdown, PDF, and plain text. The only thing Open doesn't include is engagement-tracking infrastructure — project labels, history, dashboards, before/after comparison, and white-label consultant rendering. Those are paid-tier features. Everything else is here, and free.

The most expensive moments in any engagement are not writing new code — they are the first weeks on an inherited codebase, and the gut-check before every risky change. A senior architect spending 2-3 days reading legacy code before contributing costs $3,000–$5,000 in billable time. Ghost compresses that to minutes.

---

## Works on any codebase

Ghost is platform agnostic and language agnostic. Used in production on:

- **Adobe Commerce / Magento 2** (most common)
- **Shopify / Shopify Plus**
- **Oracle Commerce / ATG**
- **SAP Commerce (Hybris)**
- **Salesforce Commerce Cloud**
- **Microservices architectures** — distributed systems, event-driven platforms
- **Mobile apps** — React Native, Expo, Swift, Kotlin
- **Game engines and runtimes** — Unreal, raylib, EASTL
- **Any language** — PHP, Java, Python, Node.js, TypeScript, Ruby, Go, C++, C#, Swift, Kotlin

If it's code, Ghost reads it.

---

## Five core modes — all included in Open

**💬 Chat**
Ask anything about the codebase in plain English. Ghost answers like a senior architect who has read every file.

> *"Why does this integration use synchronous SOAP calls?"*
> *"What would happen if I removed this middleware?"*
> *"Walk me through the checkout pipeline, top to bottom."*

**🗺 Points of Interest Scan**
Auto-generates a structured intelligence report organized into four categories:
- 🔴 **Red Flags** — load-bearing technical debt, ticking time bombs, security risks
- 🏛️ **Landmarks** — core logic everything else orbits around
- ⚰️ **Dead Zones** — abandoned code nobody knows if they still need
- ⚡ **Fault Lines** — fragile seams where assumptions don't match

Every finding is severity-rated, includes effort and complexity estimates, a dollar-cost remediation range, and concrete fix steps. Findings are verified against actual source code — false positives are dropped or flagged before they reach the report.

**💥 Blast Radius Analysis + Rollback Plan**
Pick any file, class, method, or coordinated change set. Ghost maps the full impact — direct dependencies, ripple effects, danger zones, silent-failure risks — and produces a complete rollback plan so your team is protected if anything goes wrong.

The rollback plan includes:
- Pre-change snapshot of critical state
- Numbered step-by-step rollback instructions with time estimates
- Total rollback time estimate
- Point of No Return — exactly when rollback becomes harder or impossible
- Who to notify and what action they must take
- Smoke test checklist to confirm rollback succeeded

**⚡ Conflict Detection**
Scan a codebase for places where two or more parts make conflicting assumptions about the same thing — shared config keys, API contracts, database schemas, data shapes, constants. Each candidate conflict is verified against the source code and rated as confirmed, possible, or false positive.

Useful before deployments, integration work, or migrations.

**🔍 Recon — Sizing Only**
A pre-engagement sizing report. Single planner call (~$0.05), no full scan. Produces a markdown/PDF deliverable describing what a full scan would surface, sized against the actual codebase. Useful for:

- Quoting a fixed-fee engagement before committing scan budget
- Showing a prospect what pre-engagement diligence looks like
- Quick scoping during discovery calls

---

## How Open works

Open is **single-shot**: one person, one scan at a time, one project. Reports save with mode-based filenames in `~/Ghost Architect Reports/`:

```
ghost-poi-2026-04-28T15-37-43.md
ghost-poi-2026-04-28T15-37-43.pdf
ghost-poi-2026-04-28T15-37-43.txt
ghost-blast-2026-04-28T16-02-11.md
ghost-conflict-2026-04-28T17-15-22.md
ghost-recon-2026-04-28T14-30-05.md
```

Run as many scans as you want. Save them, share them, post them — they're yours. There's no project-tracking infrastructure, no dashboard, no before/after comparison built in. Open is the analysis itself, free.

If you need engagement-tracking workflows — project labels that build history over time, before/after comparison, dashboards across multiple projects, or white-label consultant rendering with your own brand and methodology — that's [Ghost Pro / Team / Enterprise](https://ghostarchitect.dev).

---

## Privacy and security

**Your code never leaves the analysis moment.**

Ghost works like a filter: your codebase goes in, the analysis comes out, and the code itself is immediately discarded. It is never stored on any server, never written to any database, never retained between sessions. Think of it as running your code through an expert analyst who reads it, gives you the report, and forgets everything they saw.

- **No code retention** — your codebase passes through Claude's analysis and is gone. Anthropic does not store API call content for training under standard API terms.
- **Local config only** — your API key and all settings are stored exclusively in a config file on your own machine. They are never transmitted anywhere except to Anthropic's API to authenticate your calls.
- **No third-party sharing** — Ghost connects only to Anthropic's API (and optionally GitHub for repo loading). No telemetry, no analytics, no phone-home.
- **Reports stay local** — saved reports are written to your machine only.
- **Source-available** — Ghost Open is open source. You can read every line and verify these claims yourself.

This makes Ghost safe to use on proprietary enterprise codebases, client work, and confidential systems.

---

## Tier comparison

| Feature | Open (free) | Pro | Team | Enterprise |
|---|---|---|---|---|
| Chat | ✅ | ✅ | ✅ | ✅ |
| Points of Interest scan | ✅ | ✅ | ✅ | ✅ |
| Blast Radius + Rollback | ✅ | ✅ | ✅ | ✅ |
| Conflict Detection | ✅ | ✅ | ✅ | ✅ |
| Recon sizing | ✅ | ✅ | ✅ | ✅ |
| Reports saved as MD / PDF / TXT | ✅ | ✅ | ✅ | ✅ |
| Project labels + history tracking | — | ✅ | ✅ | ✅ |
| Project Dashboard | — | ✅ | ✅ | ✅ |
| Compare Reports (before/after) | — | ✅ | ✅ | ✅ |
| Ghost Partner™ profiles | — | ✅ | ✅ | ✅ |
| White-label PDF rendering | — | ✅ | ✅ | ✅ |
| Per-profile billing rate overrides | — | ✅ | ✅ | ✅ |
| Team sync features | — | — | ✅ | ✅ |
| Custom enterprise gating | — | — | — | ✅ |
| Context cap | 50K tokens | 100K | 150K | 200K |
| Pricing | Free, BYOK | $99/mo | $399/mo | $1,200–$2,000/mo |

The free Open tier is fully featured for individual scans. Project history, before/after comparison, white-label consultant rendering, and team sync are paid-tier capabilities.

Pricing details and sign-up at [ghostarchitect.dev](https://ghostarchitect.dev).

---

## Before you install — getting your API key

Ghost uses the Anthropic API directly. This is **not** the same as a Claude.ai subscription — it is a separate pay-as-you-go developer account with no monthly fee.

**Step 1 — Create an Anthropic API account.**
Go to [console.anthropic.com](https://console.anthropic.com) and sign up. You can use the same email as a Claude.ai account — they are separate accounts under the same company.

**Step 2 — Add a payment method and load credits.**
The API is pay-as-you-go. Add $5–$10 to get started — that's enough for many full sessions.

**Step 3 — Generate an API key.**
In the console, go to **API Keys → Create Key**. Name it (e.g. `ghost-architect`). Copy the key — it starts with `sk-ant-` and is only shown once.

> **Important:** Your Claude.ai subscription balance and your API credits are separate billing accounts. One does not fund the other even if you use the same email address.

---

## Two ways to provide your API key

**Method 1 — Setup wizard (recommended for most users).**
Run `ghost` and the interactive wizard handles everything on first launch. Your key is stored locally, masked during entry, and never displayed again.

**Method 2 — Environment variable (power users and CI/CD).**
Set `ANTHROPIC_API_KEY` before running and Ghost skips the wizard entirely.

```bash
# One-time in your current terminal session
export ANTHROPIC_API_KEY=sk-ant-xxxx
ghost

# Inline for a single run
ANTHROPIC_API_KEY=sk-ant-xxxx ghost

# Permanent — add to your shell profile
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

Ghost shows a cost estimate **before** every scan and the actual cost **after** — no surprises. The cost goes to Anthropic for the API calls; Ghost Open itself is free.

| Operation | Codebase size | Est. cost (Sonnet) |
|---|---|---|
| Recon (sizing only) | Any | ~$0.05 |
| Points of Interest scan | Small (~50 files) | ~$0.15 |
| Points of Interest scan | Medium (~150 files) | ~$1.50 |
| Points of Interest scan | Large (~500 files) | ~$4.00 |
| Blast Radius Analysis | Any | ~$0.10–$0.30 |
| Conflict Detection | Medium | ~$0.50–$1.50 |
| Chat exchange | Any | ~$0.02–$0.08 |

**The real comparison:** A senior architect doing the same analysis manually bills $3,000–$5,000. Ghost delivers comparable depth in minutes for under a few dollars.

A typical full session — one POI scan, two blast radius analyses, and several chat questions on a medium enterprise codebase — runs roughly **$1.50 to $3.00 total** in API costs, paid directly to Anthropic.

Ghost uses **Claude Sonnet 4.5** by default. Switch to **Claude Opus** in settings for maximum analytical depth on the most complex codebases.

At the end of every session, Ghost displays a summary of every operation run and the total session cost.

---

## Installation

```bash
git clone https://github.com/EJWisner/ghost-architect-open.git
cd ghost-architect-open
npm install
npm link        # makes 'ghost' available globally on your machine
```

## Usage

```bash
ghost
```

On first run, Ghost walks you through a one-time setup wizard:

- Anthropic API key (required)
- GitHub token (optional — for private repos)
- Model preference (Sonnet recommended)
- Default billing rates (junior / mid / senior — used in remediation cost estimates)
- Context size limit (Open is capped at 50,000 tokens)

After setup, your config is saved locally and every future run goes straight to the main menu.

### Command-line flags

```bash
ghost [options]

Options:
  --max-context <N>          Override the context cap in tokens.
                             Clamped to the Open tier limit (50,000).

  --exclude "<glob>"         Exclude files matching a glob pattern.
                             Repeatable. Example: --exclude "seeds/**"

  --exclude-presets a,b      Apply named exclusion preset(s).
                             Run `ghost --help` to see available presets.

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
4. Save the report
5. Read the findings before writing a line of code
```

**Result:** In minutes you understand what's fragile, what's critical, what's dead weight, and where not to touch without a plan. Two weeks of senior-architect ramp-up, compressed.

---

### Pre-Change Risk Assessment
Before touching anything significant — a shared interface, a payment class, a core configuration file — run a Blast Radius Analysis first.

```
1. Run Ghost → Blast Radius Analysis
2. Enter the file, class, or method (or pick multiple for a coordinated change set)
3. Read the full impact map and rollback plan
4. Make your change with full awareness of consequences
5. Follow the rollback plan if anything goes wrong
```

**Result:** No more surprise production incidents from "minor" changes. The rollback plan means you're never stuck at 2am with no path back.

---

### Pre-Deployment Conflict Audit
Run Conflict Detection before any major release, integration, or migration.

```
1. Run Ghost → Conflict Detection
2. Verify confirmed conflicts before deployment
3. Resolve config / schema / contract mismatches first
4. Save the report as part of the release record
```

**Result:** Catches contract drift, config-key mismatches, and schema disagreements before they become production incidents.

---

### Quick Codebase Sizing
Got a codebase you might bid on, evaluate, or take over? Run Recon first.

```
1. Run Ghost → Recon
2. Get a sizing report in 30 seconds for ~$0.05
3. Read it, decide whether to commit to a deeper scan
```

**Result:** A cheap, fast read on what you'd be taking on, before you commit time or money to deeper analysis.

---

## Input methods

- **Local directory** — point at any folder using a path or drag-and-drop into Terminal
- **ZIP file** — load a codebase archive directly
- **GitHub repo** — any public repo, or private with a GitHub token

---

## Report outputs

Every scan saves three formats simultaneously to `~/Ghost Architect Reports/`:

**📄 Plain text (.txt)** — terminal-friendly raw output. Opens anywhere, works in any system.

**📋 Markdown (.md)** — beautifully formatted document with severity badges, tables, and proper structure. Renders in VS Code, GitHub, Obsidian, Notion, or any Markdown viewer.

**📑 PDF (.pdf)** — branded professional report with cover page, color-coded severity sections, formatted remediation table, page numbers, and footer. Open reports carry Ghost Architect branding. (For fully white-labeled reports with your own brand, methodology, and rates, see [Ghost Pro](https://ghostarchitect.dev).)

Open reports save with mode-based filenames — no project labels. To get project labels, history tracking, and the Project Dashboard for engagement work, upgrade to Pro.

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

**Alternative:** For very large or sensitive private repos, download as ZIP and use the ZIP file loader. No authentication required and often faster.

---

## Requirements

- Node.js 18+
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com)) — pay-as-you-go, no subscription
- GitHub token (optional — only needed for private repos)

---

## Philosophy

Ghost Architect is a **thinking accelerator**, not a code generator.

The goal is to help developers and their organizations think more deeply about systems they own. Every enterprise codebase contains institutional knowledge — patterns, decisions, warnings, traps — that lives nowhere but the code itself. When the developer who built it leaves, that knowledge disappears. Ghost surfaces it before it's gone, and makes it available to everyone who comes after.

It is not here to replace senior architects. It is here to give them a running start.

---

## Why Open is free

The Open tier exists because pre-engagement codebase intelligence shouldn't be locked behind a SaaS subscription. Anyone evaluating an inherited system, scoping a refactor, or considering a takeover should be able to run a scan and see what they're dealing with.

What's behind the paywall isn't capability — it's engagement infrastructure. Project history, before/after comparison, white-label consultant branding, team sync — those are tools for running a practice or a team, and they're priced for businesses that bill clients. Individual analysis is free, forever.

---

## Built with

- [Claude API](https://anthropic.com) — Anthropic Sonnet 4.5
- [Inquirer.js](https://github.com/SBoudrias/Inquirer.js) — interactive CLI prompts
- [Octokit](https://github.com/octokit/octokit.js) — GitHub API integration
- [Chalk](https://github.com/chalk/chalk) + [Figlet](https://github.com/patorjk/figlet.js) — terminal UI
- [Configstore](https://github.com/yeoman/configstore) — local config management
- [Ora](https://github.com/sindresorhus/ora) — terminal spinners
- [ADM-ZIP](https://github.com/cthackers/adm-zip) — ZIP file extraction
- [PDFKit](https://github.com/foliojs/pdfkit) — PDF report generation

---

*"The best architects don't write all the code. They help you understand what you have."*

---

## License

Ghost Architect Open is licensed under the Business Source License 1.1 (BUSL-1.1).

Free for personal, non-commercial, and small team use (up to 5 users).
Commercial use beyond these limits requires a paid license — see [ghostarchitect.dev](https://ghostarchitect.dev).
After 4 years from each version's release date, the code converts to GPL v3.

See [LICENSE](./LICENSE) for full terms.

---

**Copyright © 2026 Ernst J. Wisner. All rights reserved.**

Ghost Architect is proprietary software. Unauthorized use, reproduction, or distribution beyond the BUSL-1.1 terms is strictly prohibited.

*Not a code generator. A thinking accelerator.*

*Ghost Architect v4.9.0 — Open tier (free)*
