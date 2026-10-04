# 👻 Ghost Architect™

> AI-powered codebase archaeology: understand what you inherited.

Ghost Open™ is the free edition of Ghost Architect™. It is free for one person, with every single-user feature unlocked: no quotas, no trial clock, no license key. It runs on your own Anthropic API key, so the only cost is the model usage you already control.

We built Ghost Architect™ to help developers, architects, and consultants deeply **understand** existing codebases. Not generate new code: illuminate what's already there. It works on any platform, any language, any stack.

The most expensive moments in any engagement are not writing new code. They are the first weeks on an inherited codebase, and the gut-check before every risky change. A senior architect spending 2-3 days reading legacy code before contributing costs $3,000 to $5,000 in billable time. Ghost Architect™ compresses that to minutes.

---

## What's New

### v12.0.0
- Ghost Open™ is now free for one person. Every single-user mode is unlocked with no limits: Question, Chat, Recon, Points of Interest, Blast Radius™, Conflict Detection™, Prompt Triage™, Inheritance Audit, Ghost Brief™, Executive Brief, Commit Forecast™, and Fix Forecast.
- Every scan gets the full 200K-token context cap, and `--skip-redaction` is available to anyone who explicitly asks for it.
- No license key, no activation, no trial, no paywall. The license commands are gone.
- Reports always carry Ghost Architect™ branding. Methodology profiles and project names move up to Ghost Architect™ Local 8. Team, sync and publishing features (team sync, Ghost Watcher™, the web portal, mobile publishing, project tracking) are not part of Ghost Open™. See [Need more?](#need-more).

Full version history: [CHANGELOG.md](CHANGELOG.md)

---

## Install

```bash
npm install -g ghost-architect-open --location=global
```

Then run it from any directory:

```bash
ghost
```

That's it. On first run, Ghost walks you through a one-time setup wizard (API key, optional GitHub token, model preference, billing rates, context size). Your config is saved locally and every future run goes straight to the main menu.

**Important:** run `ghost` from any directory. When prompted, enter the full path to the codebase you want to analyze. Do not navigate into the target folder first.

**Requirements:** Node.js 18 or higher, an Anthropic API key (pay-as-you-go, not the same as a Claude.ai subscription), and optionally a GitHub Personal Access Token for private repos.

---

## Ghost Triple Crown™: Three Passes. One Complete Picture.

**Leg 1: Blast Radius™**
Maps every file that breaks if you change something. Know the impact before you touch the code.

**Leg 2: Conflict Detection™**
Finds where two sides of the codebase expect different things. Catches contract mismatches before they hit production.

**Leg 3: Ghost Brief™**
Generates a developer-ready remediation prompt for every finding. Paste directly into Claude Code, Cursor, Copilot, or any AI coding tool.

Run all three from the mode menu whenever you need them. Commit Forecast™ runs legs 1 and 2 against your uncommitted changes before you push.

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

## The modes

Every mode below is included in Ghost Open™, with no run limits.

**❓ Question**
Ask anything about the codebase in plain English. Ghost answers like a senior architect who has read every file.

> *"Why does this integration use synchronous SOAP calls?"*
> *"What would happen if I removed this middleware?"*
> *"Walk me through the checkout pipeline, top to bottom."*

**💬 Chat**
Multi-turn conversation over the loaded codebase. Where Question is single-shot, Chat keeps the thread: ask a follow-up, drill into a file, challenge an answer, and Ghost holds the full context of the conversation. Shows the real API cost of each exchange and the running session total as you go.

**🗺 Points of Interest Scan**
Auto-generates a structured intelligence report organized into four categories:
- 🔴 **Red Flags**: load-bearing technical debt, ticking time bombs, security risks
- 🏛️ **Landmarks**: core logic everything else orbits around
- ⚰️ **Dead Zones**: abandoned code nobody knows if they still need
- ⚡ **Fault Lines**: fragile seams where assumptions don't match

Every finding is severity-rated, includes effort and complexity estimates, a dollar-cost remediation range, and concrete fix steps. Findings are verified against actual source code; low-signal findings are dropped or flagged before they reach the report.

**💥 Blast Radius™ Analysis + Rollback Plan**
Pick any file, class, method, or coordinated change set. Ghost maps the full impact (direct dependencies, ripple effects, danger zones, silent-failure risks) and produces a complete rollback plan so you are protected if anything goes wrong.

The rollback plan includes:
- Pre-change snapshot of critical state
- Numbered step-by-step rollback instructions with time estimates
- Total rollback time estimate
- Point of No Return: exactly when rollback becomes harder or impossible
- Who to notify and what action they must take
- Smoke test checklist to confirm rollback succeeded

**⚡ Conflict Detection™**
Scan a codebase for places where two or more parts make conflicting assumptions about the same thing: shared config keys, API contracts, database schemas, data shapes, constants. Each candidate conflict is verified against the source code and rated as confirmed, possible, or low-signal.

Useful before deployments, integration work, or migrations.

**🔮 Commit Forecast™**
Analyze your proposed changes against the production codebase and forecast the Blast Radius™ and Conflict Detection™ impact before you commit or push. Ghost does not apply changes, does not commit, does not push. It shows you what *would* happen if you did.

Two entry surfaces:

- **Pre-commit:** Ghost auto-discovers your working-tree changes via `git diff --name-only HEAD`. Run it before every push. No arguments needed.
- **Offline / received files:** Point Ghost at a folder of proposed files that mirrors the repo structure. Covers the offshore-review use case: an architect receives files from an offshore team and wants to assess impact before accepting them.

> Cut your container-to-stage cycles from five to one. Ghost analyzes your proposed changes against the production codebase directly, before you push, so you find out in seconds, not after a failed deploy.

**🩹 Fix Forecast**
Pick findings from a saved Conflict Detection™ scan. Ghost writes a corrected file for each and forecasts what the fix itself would conflict with, before you apply it.

**🧪 Prompt Triage™**
Audit prompts and prompt-driven workflows for structural issues: missing context, ambiguous instructions, brittle assumptions, token bloat. Built for anyone shipping LLM-integrated applications who needs to catch prompt drift before it reaches production.

**🔍 Recon (sizing only)**
A pre-engagement sizing report. Single planner call (~$0.05), no full scan. Produces a markdown or PDF deliverable describing what a full scan would surface, sized against the actual codebase. Useful for:

- Quoting a fixed-fee engagement before committing scan budget
- Showing a prospect what pre-engagement diligence looks like
- Quick scoping during discovery calls

**🔍 Compare Reports**
Diff two saved Ghost reports (before and after a refactor, upgrade, or fix cycle) to see exactly what moved: which findings were resolved, which are new, and where severity shifted.

**📋 Ghost Brief™**
Turns the findings from a saved scan into a validated, blast-radius-aware prompt pack (JSON plus an HTML report) for Claude Code or your coding agent of choice.

**📊 Executive Brief**
A one-page business-intelligence PDF: health score, findings summary, cost comparison, and a plain-language narrative for non-technical stakeholders.

**📋 Inheritance Audit**
The deal-grade report. Full section below.

---

## 📋 Inheritance Audit: the deal-grade report

The Inheritance Audit is the mode built for the moment money changes hands: buy-side technical diligence, PE portfolio evaluation, fractional CTO onboarding, and modernization scoping. Where a POI scan tells an engineer what to fix, the Inheritance Audit tells a buyer or an executive what they are inheriting and what it will take to modernize it.

One run produces a client-ready PDF built from four analyzers:

- **Stack Reality**: what the codebase actually runs on, versus what the seller or the wiki claims. Framework versions, EOL exposure, dependency drift.
- **Key-Person Risk**: concentration analysis of who wrote what. Surfaces the modules only one person has ever touched, before that person leaves the deal.
- **Dependency Map**: the load-bearing external dependencies and how deeply they are wired in.
- **Modernization Roadmap**: a sequenced 90-day plan for bringing the codebase forward, sized against what the other three analyzers found.

Cost honesty: the first three analyzers run locally and cost nothing. The Modernization Roadmap synthesis is the audit's only billed API call (typically a few cents), you pick the model for it per run (including Claude Fable 5 for the deepest synthesis on an important deal), Ghost shows you the estimate before spending, and reports the real cost after.

When to reach for it: before a term sheet, before signing an SOW on an inherited platform, in the first week of a fractional CTO engagement, or any time someone asks "what are we actually buying?"

---

## Privacy and security

**Your code never leaves the analysis moment.**

Ghost Architect™ works like a filter: your codebase goes in, the analysis comes out, and the code itself is immediately discarded. It is never written to any database and never retained between sessions.

- **No code retention:** your codebase passes through Claude's analysis and is gone. Anthropic does not store API call content for training under standard API terms.
- **Local config only:** your API key and all settings are stored exclusively in a config file on your own machine. They are never transmitted anywhere except to Anthropic's API to authenticate your calls.
- **No third-party sharing of your code:** Ghost sends your codebase only to Anthropic's API for analysis (and optionally GitHub for repo loading). Your code and your findings are never sent anywhere else.
- **Anonymous usage telemetry (opt out any time):** when you run a mode, Ghost sends one small, anonymous ping so we can see which features are used. It carries only a randomly generated install ID (a UUID created and kept locally on your machine), the Ghost version, and the mode name. It never includes your code, your findings, your file paths, your API key, or any personal data. To turn it off completely, set GHOST_NO_PING=1 in your environment.
- **Secrets are redacted before anything is sent:** API keys, credentials, and private keys are stripped from file contents first. If redaction fails on a file, the scan stops before anything reaches the API, unless you explicitly pass `--skip-redaction`.
- **Reports stay local:** saved reports are written to your machine only.
- **Source-available:** you can read every line of Ghost Architect™ code and verify these claims yourself.

This makes Ghost safe to use on proprietary enterprise codebases, client work, and confidential systems.

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

Ghost Open™ itself is free. The only cost is your own Anthropic API usage, and Ghost shows a cost estimate **before** every scan and the actual cost **after**. No surprises.

| Operation | Codebase size | Est. cost (Sonnet 4.6) |
|---|---|---|
| Recon (sizing only) | Any | ~$0.05 |
| Question exchange | Any | ~$0.05 to $0.35 |
| Commit Forecast™ | Any | ~$0.15 to $0.60 |
| Points of Interest scan | Small (~50 files) | ~$0.15 |
| Points of Interest scan | Medium (~150 files) | ~$1.50 |
| Points of Interest scan | Large (~500 files) | ~$4.00 |
| Blast Radius™ Analysis | Any | ~$0.10 to $0.30 |
| Conflict Detection™ | Medium | ~$0.50 to $1.50 |

Larger codebases fill more of the 200K-token context cap and cost more per scan. Use `--max-context` or `ghost --reconfigure` to set a lower ceiling if you want cheaper, narrower scans. Blast Radius™ and Question can also run through the half-price Message Batches API (`--batch`).

**The real comparison:** a senior architect doing the same analysis manually bills $3,000 to $5,000. Ghost delivers comparable depth in minutes for a few dollars.

Ghost uses **Claude Sonnet 4.6** by default. The model picker in settings also offers **Claude Sonnet 5**, **Claude Opus 4.8**, and **Claude Fable 5** (the deepest synthesis) for the most complex codebases, with real per-million-token rates shown next to each choice.

At the end of every session, Ghost displays a summary of every operation run and the total session cost.

---

## Command-line flags

For a complete, always-current flag reference, run `ghost --help` in your terminal. `--help` is the source of truth for every supported flag.

```bash
ghost [options]

Options:
  --max-context <N>          Override the context cap in tokens.
                             Clamped to the 200,000-token maximum.

  --exclude "<glob>"         Exclude files matching a glob pattern.
                             Repeatable. Example: --exclude "seeds/**"

  --exclude-presets a,b      Apply named exclusion preset(s).
                             Run `ghost --help` to see available presets.

Commit Forecast™ (non-interactive / CI):
  --baseline <path> --proposed <path> --modes blast,conflict [--no-verify]

Ghost Brief™:
  --brief [--input=<findings.json>] [--output=<ghost-brief.json>]

Transport:
  --stream | --batch         Skip the streaming-vs-batch menu.
  ghost batch-status         List submitted batches.
  ghost batch-retrieve <id>  Save a finished batch as a normal report.

Misc:
  --skip-redaction           Continue past a redaction failure (secrets in the
                             affected files may be sent unredacted).
  --reconfigure              Open the Reconfigure menu, then exit.
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

**Result:** in minutes you understand what's fragile, what's critical, what's dead weight, and where not to touch without a plan. Two weeks of senior-architect ramp-up, compressed.

---

### Pre-Engagement Diligence (consultants)
Before quoting an engagement, run Recon to size the codebase and identify high-risk areas. Then if the prospect commits, run the full scans.

```
1. Recon scan → ~$0.05, ~30 seconds
2. Send the recon PDF to the prospect
3. On engagement, run full POI / Blast Radius™ / Conflict Detection™ scans
```

**Result:** a pre-engagement deliverable that establishes your value before you've billed an hour.

---

### Before / After Validation
Confirm changes actually improved the codebase, and didn't introduce new problems.

```
Round 1, Before:
1. Run POI scan and save the report

Make your code changes.

Round 2, After:
1. Run POI scan on the same project and save the report
2. Run Compare Reports on the two saved reports
3. Confirm resolved issues are gone
4. Check no new issues were introduced
```

**Result:** a clear before/after record of code quality improvement.

---

### Pre-Change Risk Assessment
Before touching anything significant (a shared interface, a payment class, a core configuration file) run a Blast Radius™ Analysis first.

```
1. Run Ghost → Blast Radius™ Analysis
2. Enter the file, class, or method (or pick multiple for a coordinated change set)
3. Read the full impact map and rollback plan
4. Make your change with full awareness of consequences
5. Follow the rollback plan if anything goes wrong
```

**Result:** no more surprise production incidents from "minor" changes.

---

### Pre-Deployment Conflict Audit
Run Conflict Detection™ before any major release, integration, or migration.

```
1. Run Ghost → Conflict Detection™
2. Verify confirmed conflicts before deployment
3. Resolve config / schema / contract mismatches first
4. Save the report as part of the release record
```

**Result:** catches contract drift, config-key mismatches, and schema disagreements before they become production incidents.

---

### Pre-Push Commit Forecast™
Before every push, know what your changes will break.

```
1. Make your changes in your working directory (as normal)
2. Run Ghost → Commit Forecast™ → Pre-commit
3. Ghost auto-detects your changed files via git diff
4. Read the blast radius and conflict forecast
5. Fix anything critical before you push
```

**Result:** you find out what breaks before the push, not after a failed deploy.

---

## Input methods

- **Local directory:** point at any folder using a path or drag-and-drop into Terminal
- **ZIP file:** load a codebase archive directly
- **GitHub repo:** any public repo, or private with a GitHub token

---

## Report outputs

Every scan saves its formats simultaneously to `~/Ghost Architect Reports/`:

**📄 Plain text (.txt):** terminal-friendly raw output. Opens anywhere, works in any system.

**📋 Markdown (.md):** formatted document with severity badges, tables, and proper structure. Renders in VS Code, GitHub, Obsidian, Notion, or any Markdown viewer.

**📑 PDF (.pdf):** Ghost Architect™ branded professional report with cover page, color-coded severity sections, formatted remediation table, page numbers, and footer.

**🧾 Findings (.findings.json):** the structured findings behind the report. Ghost Brief™ and the Executive Brief read it.

Every report is timestamped, so a re-scan never overwrites an earlier report.

---

## Private repository access

Ghost supports private GitHub repositories via a Personal Access Token.

**Setup:**
1. Go to `github.com/settings/tokens`
2. Click **Generate new token (classic)**
3. Select the **repo** scope
4. Copy the token (starts with `ghp_`)
5. Run Ghost → **Reconfigure Ghost Architect™** → **Run full setup wizard**, or set `GITHUB_TOKEN`

Your token is stored locally and never transmitted anywhere except GitHub's API.

**Alternative:** for very large or sensitive private repos, download as ZIP and use the ZIP file loader. No authentication required and often faster.

---

## Need more?

Ghost Open™ is free for one person. For deeper scans, teams, and your own AI model on your own hardware, there is Ghost Architect™ Local 8, currently in early access beta: [ghostarchitect.dev/beta.html](https://ghostarchitect.dev/beta.html).

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
Documentation and product info: [ghostarchitect.dev](https://ghostarchitect.dev)

---

## License

Ghost Architect™ is source-available under the Business Source License 1.1 (see [LICENSE](LICENSE)). The Additional Use Grant lets you use Ghost Open™ in production free of charge as a single individual, on your own machines, for your own work or your employer's or clients' work. Production use by an organization through a shared, multi-user, or hosted deployment needs a commercial license (Ghost Architect™ Local or Ghost Architect™ Cloud).

Four years after each version's release date, that version converts to the GNU General Public License v3.0.

Copyright © 2026 Ghost Architect™. All rights reserved.

*Not a code generator. A thinking accelerator.*
