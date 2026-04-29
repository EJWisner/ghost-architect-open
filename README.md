# 👻 Ghost Architect

> AI-powered codebase intelligence — understand any complex system you've inherited

Ghost Architect is a CLI tool powered by Claude that helps developers, architects, and consultants deeply **understand** existing codebases — not generate new code, but illuminate what's already there. It works on any platform, any language, any stack.

The most expensive moments in any engagement are not writing new code — they are the first weeks on an inherited codebase, and the gut-check before every risky change. A senior architect spending 2-3 days reading legacy code before contributing costs $3,000–$5,000 in billable time. Ghost Architect compresses that to minutes.

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

## Five core modes

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

When a Ghost Partner™ profile is loaded, recon reads in the consultant's voice and emphasizes their methodology's priorities.

---

## 👥 Ghost Partner™ — White-label consultant profiles

Consultants and agencies can run scans on behalf of their client engagements with their own branding, methodology, and rates baked into the report.

A **Ghost Partner profile** is a YAML file describing the consultant — their priorities, anti-patterns, red flags, billing rates, brand color, and contact info. When a profile is loaded with `--profile`, Ghost:

- Applies the consultant's lens to the analysis (findings reflect their methodology)
- Renders the report in the consultant's voice (no Ghost Architect branding in the output)
- Uses the consultant's billing rates for cost estimates (per-tier overrides supported)
- Produces a fully white-labeled PDF with the consultant's logo, accent color, and footer

### Creating a profile — the easy way

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

# 2. Set a default — auto-applied to every scan
ghost --set-default-profile my-profile
ghost                                 # default profile loads automatically
ghost --no-profile                    # opt out of the default for one run
ghost --clear-default-profile         # remove the default

# 3. List what you have
ghost --list-profiles
```

When a profile is active, the main-menu input options show a `[profile: <name> ●]` annotation so you always know which lens is loaded before you scan.

### Editing a profile by hand

Profiles are plain YAML files in `~/.ghost/profiles/`. You can edit them in any editor. Profiles can also be authored as `.yml`, `.md`, or `.txt` — Markdown and plain-text profiles are extracted via Claude into the canonical schema and cached locally.

Example profile (what the wizard produces, with one human edit):

```yaml
name: "Magento & Shopify Performance, Security & Server Cost Audit"
author: "Satish Mantri"
organization: "OSCProfessionals"

priorities:
  - Site speed and Core Web Vitals on category and product pages
  - Server cost efficiency
  - Security exposure
  - Database query efficiency — N+1 patterns, missing indexes
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
  footer_text: "OSCProfessionals — Performance, Security & Server Cost Audit"
  confidentiality: "Confidential — Prepared for client engagement use only"
```

Profiles can be authored as `.yaml`, `.yml`, `.md`, or `.txt`. Markdown and plain-text profiles are extracted via Claude into the canonical schema and cached locally.

**Ghost Partner profiles are a paid-tier feature** (Pro, Team, Enterprise). The free Open tier produces neutral Ghost-branded reports.

---

## Privacy and security

**Your code never leaves the analysis moment.**

Ghost Architect works like a filter: your codebase goes in, the analysis comes out, and the code itself is immediately discarded. It is never stored on any server, never written to any database, never retained between sessions. Think of it as running your code through an expert analyst who reads it, gives you the report, and forgets everything they saw.

- **No code retention** — your codebase passes through Claude's analysis and is gone. Anthropic does not store API call content for training under standard API terms.
- **Local config only** — your API key and all settings are stored exclusively in a config file on your own machine. They are never transmitted anywhere except to Anthropic's API to authenticate your calls.
- **No third-party sharing** — Ghost connects only to Anthropic's API (and optionally GitHub for repo loading). No telemetry, no analytics, no phone-home.
- **Reports stay local** — saved reports are written to your machine only.
- **Source-available** — you can read every line of Ghost Architect's code and verify these claims yourself.

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

Ghost Architect uses the Anthropic API directly. This is **not** the same as a Claude.ai subscription — it is a separate pay-as-you-go developer account with no monthly fee.

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

Ghost shows a cost estimate **before** every scan and the actual cost **after** — no surprises.

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

A typical full session — one POI scan, two blast radius analyses, and several chat questions on a medium enterprise codebase — runs roughly **$1.50 to $3.00 total.**

Ghost uses **Claude Sonnet 4.5** by default. Switch to **Claude Opus** in settings for maximum analytical depth on the most complex codebases.

At the end of every session, Ghost displays a summary of every operation run and the total session cost.

---

## Installation

```bash
git clone https://github.com/EJWisner/ghost-architect.git
cd ghost-architect
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
- Context size limit (controls cost vs. coverage tradeoff)

After setup, your config is saved locally and every future run goes straight to the main menu.

### Command-line flags

For a complete, always-current flag reference, run `ghost --help` in your terminal — `--help` is the source of truth for every supported flag.

```bash
ghost [options]

Options:
  --max-context <N>          Override the context cap in tokens.
                             Clamped to your tier limit.

  --exclude "<glob>"         Exclude files matching a glob pattern.
                             Repeatable. Example: --exclude "seeds/**"

  --exclude-presets a,b      Apply named exclusion preset(s).
                             Run `ghost --help` to see available presets.

Ghost Partner™ — white-label consultant profiles:
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
4. Save the report — label it with the project name
5. Read the findings before writing a line of code
```

**Result:** In minutes you understand what's fragile, what's critical, what's dead weight, and where not to touch without a plan. Two weeks of senior-architect ramp-up, compressed.

---

### Pre-Engagement Diligence (Consultants) *(Pro+)*
Before quoting an engagement, run Recon to size the codebase and identify high-risk areas. Then if the prospect commits, run a full scan with your Ghost Partner profile loaded.

```
1. Recon scan with --profile loaded → ~$0.05, ~30 seconds
2. Send the recon PDF to the prospect (white-labeled, your branding)
3. On engagement, run full POI / Blast / Conflict scans with the same profile
4. Reports go to the client carrying your name, your methodology, your rates
```

**Result:** A pre-engagement deliverable that establishes your value before you've billed an hour. Ghost's planner reads the codebase through your methodology lens and produces a sizing report the prospect can use to scope the engagement.

---

### Before / After Validation *(Pro+ for the Compare feature)*
Confirm changes actually improved the codebase — and didn't introduce new problems.

```
Round 1 — Before:
1. Run POI scan, save report with label "pre-refactor"
2. Note all findings and their severity

Make your code changes.

Round 2 — After:
1. Run POI scan on the same project
2. Save report with label "post-refactor"
3. Open both MD reports side by side (or use Compare Reports)
4. Confirm resolved issues are gone
5. Check no new issues were introduced
```

**Result:** A clear before/after record of code quality improvement. Every finding resolved is documented. Every new issue introduced is caught before it reaches production.

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

### Ongoing Technical Debt Tracking *(Pro+)*
Run a POI scan at the start of every sprint or major milestone. Save each report with a date label. The Project Dashboard then shows your debt trajectory over time.

```
ghost-poi-project-name-sprint-1-2026-03-01.txt
ghost-poi-project-name-sprint-5-2026-05-01.txt
ghost-poi-project-name-sprint-10-2026-07-01.txt
```

**Result:** A timestamped record of how technical debt is growing or shrinking. Useful for client reporting, delivery reviews, and justifying refactoring investment.

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

**📑 PDF (.pdf)** — branded professional report with cover page, color-coded severity sections, formatted remediation table, page numbers, and footer. The client-ready deliverable. When a Ghost Partner profile is loaded, the PDF is fully white-labeled with the consultant's branding.

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

Ghost Architect is licensed under the Business Source License 1.1 (BUSL-1.1).

Free for personal, non-commercial, and small team use (up to 5 users).
Commercial use beyond these limits requires a paid license — see [ghostarchitect.dev](https://ghostarchitect.dev).
After 4 years from each version's release date, the code converts to GPL v3.

See [LICENSE](./LICENSE) for full terms.

---

**Copyright © 2026 Ernst J. Wisner. All rights reserved.**

Ghost Architect is proprietary software. Unauthorized use, reproduction, or distribution is strictly prohibited.

*Not a code generator. A thinking accelerator.*

*Ghost Architect v4.9.0 — Pro tier*
