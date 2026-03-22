# 👻 Ghost Architect

> AI-powered codebase intelligence — understand any complex system you've inherited

Ghost Architect is a CLI tool powered by Claude AI that helps developers and engineering teams deeply **understand** codebases — not generate new code, but illuminate what already exists. It works on any enterprise platform, any language, any architecture.

---

## Works on any codebase — not just one platform

Ghost Architect is platform agnostic and language agnostic. It has been used on:

- **Adobe Commerce / Magento** — 2.x enterprise platforms
- **Oracle Commerce / ATG** — legacy enterprise systems
- **SAP Commerce (Hybris)** — enterprise B2B/B2C platforms
- **Salesforce Commerce Cloud** — SFCC / B2C Commerce
- **Microservices architectures** — distributed systems, API gateways, event-driven platforms
- **Any language** — PHP, Java, Python, Node.js, Ruby, Go, C++, C#, and more

If it's code, Ghost can read it.

---

## What it does

Most AI coding tools are built for greenfield development. Ghost Architect is built for the other 70% of developer time: understanding, navigating, and safely modifying existing systems.

The most expensive moments in any engagement are not writing new code — they are the first weeks on an inherited codebase, and the gut-check before every risky change. A senior architect spending 2-3 days reading legacy code before contributing costs $3,000–$5,000 in billable time. That cost repeats with every new project, every new developer, every platform migration. Ghost Architect compresses it to minutes.

### Three core modes

**💬 Chat Mode**
Ask anything about the codebase in plain English. Ghost answers like a senior architect who has read every file.

> *"Why does this integration use synchronous SOAP calls?"*
> *"What would happen if I removed this middleware?"*
> *"Explain what the checkout pipeline actually does, top to bottom."*

**🗺 Points of Interest Scan**
Auto-generates a structured intelligence report organized into four categories:
- 🔴 **Red Flags** — load-bearing technical debt, ticking time bombs, security risks
- 🏛️ **Landmarks** — core logic everything else orbits around
- ⚰️ **Dead Zones** — abandoned code nobody knows if they still need
- ⚡ **Fault Lines** — fragile seams between systems where assumptions don't match

**💥 Blast Radius Analysis + Rollback Plan**
Pick any file, class, or method. Ghost maps the full impact of changing it — direct dependencies, ripple effects, danger zones, silent failure risks, a full remediation plan, AND a complete rollback plan so your team is protected if something goes wrong.

The rollback plan includes:
- Pre-change snapshot of critical values
- Numbered step-by-step rollback instructions with time estimates
- Total rollback time estimate
- Point of No Return — exactly when rollback becomes harder or impossible
- Who to notify and what action they must take
- Smoke test checklist to confirm rollback succeeded

---

## Privacy and security

**Your code never leaves the analysis moment.**

Ghost Architect works like a filter: your codebase goes in, the analysis comes out, and the code itself is immediately discarded. It is never stored on any server, never written to any database, never retained between sessions. Think of it as running your code through an expert analyst who reads it, gives you the report, and forgets everything they saw.

Specifically:
- **No code retention** — your codebase passes through Claude's analysis and is gone. Anthropic does not store the content of API calls for training purposes under standard API terms.
- **Local config only** — your API key and all settings are stored exclusively in a config file on your own machine. They are never transmitted to anyone except directly to Anthropic's API to authenticate your calls.
- **No third-party sharing** — Ghost Architect does not connect to any service other than Anthropic's API. No telemetry, no analytics, no phone-home.
- **Your reports stay local** — any reports you save are written to your local machine only. Nothing is uploaded anywhere.
- **Open source** — you can read every line of Ghost Architect's code and verify these claims yourself.

This makes Ghost Architect safe to use on proprietary enterprise codebases, client work, and confidential systems.

---

## Before you install — getting your API key

Ghost Architect uses the Anthropic API directly. This is **not** the same as a Claude.ai subscription — it is a separate pay-as-you-go developer account with no monthly fee.

**Step 1 — Create an Anthropic API account**
Go to [console.anthropic.com](https://console.anthropic.com) and sign up. You can use the same email as a Claude.ai account — they are just separate accounts under the same company.

**Step 2 — Add a payment method and load credits**
The API is pure pay-as-you-go. Add $5–$10 to get started — that is enough for many full test sessions.

**Step 3 — Generate an API key**
In the console, go to **API Keys → Create Key**. Name it something memorable (e.g. `ghost-architect`). Copy the key immediately — it starts with `sk-ant-` and is only shown once.

> **Important:** Your Claude.ai subscription balance and your API credits are completely separate billing accounts. One does not fund the other even if you use the same email address.

---

## Two ways to provide your API key

**Method 1 — Setup wizard (recommended for most users)**
Just run `ghost` and the interactive wizard handles everything on first launch. Your key is stored locally, masked during entry, and never displayed again.

**Method 2 — Environment variable (for power users and CI/CD)**
Set `ANTHROPIC_API_KEY` before running and Ghost skips the wizard entirely — goes straight to the main menu:

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

When running via environment variable, Ghost shows a green indicator in the banner and hides the Reconfigure option from the menu since there is nothing to configure.

---

## What does it cost to use?

Ghost Architect shows you a cost estimate **before** every scan and the actual cost **after** — no surprises, no hidden charges.

| Operation | Codebase size | Est. cost (Sonnet) |
|---|---|---|
| Points of Interest Scan | Small (~50 files) | ~$0.05 |
| Points of Interest Scan | Medium (~150 files) | ~$0.15 |
| Points of Interest Scan | Large (~500 files) | ~$0.25 |
| Blast Radius Analysis | Any | ~$0.05–$0.20 |
| Chat exchange | Any | ~$0.02–$0.08 |

**The real comparison:** A senior architect doing the same analysis manually bills $3,000–$5,000 in time. Ghost Architect delivers comparable depth in minutes for under a dollar.

A typical full session — one POI scan, two blast radius analyses, and several chat questions on a medium enterprise codebase — runs roughly **$0.50 to $1.50 total.**

Ghost uses **Claude Sonnet** by default (best balance of quality and cost). Switch to **Claude Opus** in settings for maximum analytical depth on the most complex codebases.

At the end of every session, Ghost displays a summary of every operation run and the total session cost.

---

## Installation

```bash
git clone https://github.com/yourusername/ghost-architect
cd ghost-architect
npm install
npm link        # makes 'ghost' available globally anywhere on your machine
```

## Usage

```bash
ghost
```

On first run, Ghost walks you through a one-time setup wizard:
- Anthropic API key (required — see above)
- GitHub token (optional — for private repos)
- Model preference (Sonnet recommended)
- Context size limit (controls cost vs. coverage tradeoff — 50,000 tokens recommended)

After setup, your config is saved locally and every future run goes straight to the main menu.


---

## Workflows

### New Project Onboarding
The most common use case. You've just inherited a codebase you've never seen before.

```
1. Download or clone the project to your machine
2. Run Ghost → Load project from → Local directory or ZIP file
3. Run Points of Interest Scan
4. Save the report — label it with the project name
5. Read the findings before writing a single line of code
```

**Result:** In minutes you understand what's fragile, what's critical, what's dead weight, and where not to touch without a plan. What used to take a senior architect 2-3 weeks now takes Ghost 90 seconds.

---

### Before / After Validation
Use Ghost to confirm your changes actually improved the codebase — and didn't introduce new problems.

```
Round 1 — Before:
1. Run Ghost → Load project → Points of Interest Scan
2. Save report — label it "pre-refactor" or "pre-fix"
3. Note all findings and their severity

Make your code changes.

Round 2 — After:
1. Run Ghost → Load the same project → Points of Interest Scan
2. Save report — label it "post-refactor" or "post-fix"
3. Open both MD reports in VS Code side by side
4. Confirm resolved issues are gone
5. Check no new issues were introduced
```

**Result:** A clear before/after record of code quality improvement. Every finding resolved is documented. Every new issue introduced is caught before it reaches production. This can be required as part of your team's definition of done on any major change.

---

### Pre-Change Risk Assessment
Before touching anything significant — a shared interface, a payment class, a core configuration file — run a Blast Radius Analysis first.

```
1. Run Ghost → Load project → Blast Radius Analysis
2. Enter the file, class, or method you're about to change
3. Read the full impact map and rollback plan
4. Make your change with full awareness of consequences
5. Follow the rollback plan if anything goes wrong
```

**Result:** No more surprise production incidents from "minor" changes. The rollback plan means you're never stuck at 2am with no path back.

---

### Ongoing Technical Debt Tracking
Run a POI scan at the start of every sprint or major milestone. Save each report with a date label.

```
ghost-poi-project-name-sprint-1-2026-03-01.txt
ghost-poi-project-name-sprint-5-2026-05-01.txt
ghost-poi-project-name-sprint-10-2026-07-01.txt
```

**Result:** A timestamped record of how technical debt is growing or shrinking over time. Useful for client reporting, delivery reviews, and justifying refactoring investment to stakeholders.

---

### Client Technical Audit
Use Ghost to produce a professional technical assessment for a new client engagement.

```
1. Client provides codebase access (repo or ZIP)
2. Run Ghost → Points of Interest Scan
3. Save the PDF report (Ghost Architect Reports folder)
4. Review findings with your team
5. Present the PDF to the client as your technical assessment
```

**Result:** A branded PDF technical audit report produced in minutes. Identifies security risks, technical debt, remediation costs, and recommended fix order. A deliverable agencies typically charge $3,000–$10,000 to produce manually.

---

## Input methods

- **Local directory** — point at any folder on your machine using a path or drag-and-drop into Terminal
- **ZIP file** — load a codebase archive directly
- **GitHub repo** — any public repo, or private repos with a GitHub token

---

## Report outputs

Every Ghost Architect analysis saves two files automatically to `~/Ghost Architect Reports/`:

**📄 Plain text (.txt)**
Terminal-friendly raw output. Opens anywhere. Works in email, Slack, any system. The universal fallback that will always be readable regardless of software.

**📋 Markdown (.md)**
Beautifully formatted document with proper headers, bold text, severity badges, and tables. Opens and renders in VS Code, GitHub, Obsidian, Notion, or any Markdown viewer. Ideal for developer wikis, pull request documentation, and internal knowledge bases.

**📑 PDF (coming in v2.3)**
Branded professional report with Ghost Architect logo, color-coded severity sections, formatted remediation summary table, page numbers, and copyright footer. Opens in any browser or PDF viewer — no software required. The client-ready deliverable. Agencies use this as a formal technical audit document.

All three formats are saved simultaneously. Every report is timestamped and labeled with your project name for easy organization and comparison across scans.

---

## Private repository access

Ghost Architect supports private GitHub repositories via a Personal Access Token.

**Setup:**
1. Go to `github.com/settings/tokens`
2. Click **Generate new token (classic)**
3. Select the **repo** scope
4. Copy the token (starts with `ghp_`)
5. Run Ghost → **Reconfigure Ghost Architect**
6. Enter your token when prompted

Once configured, Ghost automatically authenticates all GitHub API requests. Your token is stored locally in your config file and never transmitted anywhere except GitHub's API.

**Alternative for large or private repos:** Download as ZIP and use the ZIP file loader. No authentication required and often faster for large codebases.

---

## Requirements

- Node.js 18+
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com)) — pay-as-you-go, no subscription required
- GitHub token (optional — only needed for private repos)

---

## Philosophy

Ghost Architect is a **thinking accelerator**, not a code generator.

The goal is to help developers and their organizations think more deeply about the systems they own. Every enterprise codebase contains institutional knowledge — patterns, decisions, warnings, and traps — that lives nowhere but the code itself. When the developer who built it leaves, that knowledge disappears. Ghost surfaces it before it's gone, and makes it available to every developer who comes after.

It is not here to replace senior architects. It is here to give them a running start.

Ghost Architect works equally well across all major enterprise platforms and languages — Adobe Commerce, Oracle ATG, SAP Hybris, Salesforce Commerce Cloud, Laravel, .NET/C#, C++ game engines, microservices, and more. If it's code, Ghost reads it.

---

## Built with

- [Claude API](https://anthropic.com) — the brain (Anthropic Sonnet 4.5)
- [Inquirer.js](https://github.com/SBoudrias/Inquirer.js) — interactive CLI prompts
- [Octokit](https://github.com/octokit/octokit.js) — GitHub API integration
- [Chalk](https://github.com/chalk/chalk) + [Figlet](https://github.com/patorjk/figlet.js) — terminal UI and banner
- [Configstore](https://github.com/yeoman/configstore) — local config management
- [Ora](https://github.com/sindresorhus/ora) — terminal spinners
- [ADM-ZIP](https://github.com/cthackers/adm-zip) — ZIP file extraction

---

*"The best architects don't write all the code. They help you understand what you have."*

---

## License

Ghost Architect is licensed under the Business Source License 1.1 (BUSL-1.1).

Free for personal, non-commercial, and small team use (up to 5 users).
Commercial use beyond these limits requires a paid license from the author.
After 4 years from each version's release date, the code converts to GPL v3.

See [LICENSE](./LICENSE) for full terms.

---

**Copyright © 2026 Ernst J. Wisner. All rights reserved.**

Ghost Architect is proprietary software. Unauthorized use, reproduction, or distribution is strictly prohibited.

*Not a code generator. A thinking accelerator.*

---

## Copyright

Copyright © 2026 Ernst J. Wisner. All rights reserved.

Ghost Architect is proprietary software protected under copyright law. Unauthorized use, reproduction, modification, or distribution of this software or its documentation, in whole or in part, is strictly prohibited without the express written permission of Ernst J. Wisner.

For licensing inquiries contact the author directly.

*Ghost Architect v1.7.0 — Created March 18, 2026*
