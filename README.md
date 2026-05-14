# Ghost Architect™ — Open

> AI-powered codebase triage. Know what you are inheriting before you commit.

Ghost Architect scans your codebase, categorizes risk by severity, and gives your team a map of where to start. It does not replace your engineers. It tells them where to look.

**Ghost Open is free and full-featured.** Every scan mode is available. Every finding — Critical, High, Medium, Low — is in the report. PDF, Markdown, and TXT outputs are generated for every scan. The only thing Ghost Open does not do is track your scan history across runs — each scan overwrites the prior report. Project tracking, baselines, dashboards, and consultant profiles are part of Ghost Pro and the higher tiers.

---

## What It Does

Ghost triages your codebase — categorizes risk, prioritizes findings, gives your team a map of where to start.

Six scan modes are available:

- **Chat** — interactive Q&A with the codebase. Ask anything about the architecture, the conventions, the suspicious bits.
- **Points of Interest** — auto-map red flags, landmarks, dead zones, and fault lines across the whole codebase. Severity-scored, with effort estimates and recommended fixes.
- **Blast Radius** — pick a file, class, or method. Ghost maps every dependency that would be affected by a change, plus a complete rollback plan.
- **Conflict Detection** — find contract mismatches, schema conflicts, config key errors, and constant disagreements that no linter catches.
- **Recon** — sizing-only mode. Single planner call, ~$0.05. Tells you what a full scan would surface before you commit to running one.
- **Prompt Triage** — audit a folder of LLM prompts for defects: ambiguous instructions, conflicting directives, prompt-injection patterns, undefined output formats, token-budget overflows, and more. Backed by 15 detectors built on the Tian et al. (2025) prompt-defect taxonomy.

Every codebase scan produces report files in `~/Ghost Architect Reports/`:

- `ghost-poi.txt` / `ghost-poi.md` / `ghost-poi.pdf` — for Points of Interest
- `ghost-blast.txt` / `ghost-blast.md` / `ghost-blast.pdf` — for Blast Radius
- `ghost-conflict.txt` / `ghost-conflict.md` / `ghost-conflict.pdf` — for Conflict Detection
- `ghost-recon.txt` / `ghost-recon.md` / `ghost-recon.pdf` — for Recon

As of **v5.5.0**, every POI scan also writes a structured `ghost-poi.findings.json` sidecar — the same findings as the report, but machine-readable. Stable finding IDs, severity, file paths, effort estimates, and confidence scores. Feed it into your own dashboard, ticket tracker, or risk register. Ghost Platform™ portal customers get cross-scan Open / New / Fixed tracking, severity filtering, and remediation cost totals on top of this data automatically.

Reports overwrite the prior run for that mode. Chat is interactive only and does not save a transcript.

Prompt Triage saves a timestamped Markdown report (one per scan, never overwritten) to `~/Ghost Architect Reports/prompt-triage/prompt-triage-YYYYMMDD-HHMMSS.md`.

Reports run locally. Your code never leaves your machine. Analysis calls go directly from your machine to Anthropic's API using your own key.

---

## Platform and Language Support

Ghost Architect is language-agnostic and platform-agnostic. If Ghost can read it, Ghost can analyze it.

**Platforms:** Adobe Commerce, Magento 2, Salesforce Commerce Cloud, SAP Commerce (Hybris), Oracle Commerce (ATG), WordPress, Drupal, WooCommerce, and more

**Languages:** PHP, Python, Java / Spring, Node.js, Ruby on Rails, Go, .NET, C / C++, and more

**Frontend frameworks:** React, Vue, Angular, Next.js, and more

**Backend frameworks:** Laravel, Symfony, Django, FastAPI, and more

---

## Requirements

- Node.js 18 or higher
- An Anthropic API key — [get one at console.anthropic.com](https://console.anthropic.com)

Ghost Architect is BYOK — bring your own key. You pay Anthropic directly for API usage. A typical scan costs cents.

---

## Installation

**Option A — npm (recommended)**

```bash
npm install -g ghost-architect-open
```

Then run `ghost` from anywhere.

**Option B — clone the repo**

```bash
git clone https://github.com/EJWisner/ghost-architect.git
cd ghost-architect
npm install
```

Then run `node bin/ghost.js`.

**Set your Anthropic API key**

```bash
export ANTHROPIC_API_KEY=your_key_here
```

To make this permanent, add it to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
echo 'export ANTHROPIC_API_KEY=your_key_here' >> ~/.zshrc
source ~/.zshrc
```

---

## Running a Scan

On launch, Ghost presents a menu. Pick how to load the codebase (local directory, ZIP file, or GitHub repository), then pick a scan mode.

Reports save to:

```
~/Ghost Architect Reports/
```

Each scan mode (POI / Blast / Conflict / Recon) produces three files (TXT, MD, PDF). Each run overwrites the prior run's reports for that mode.

---

## Running a Prompt Triage Audit

From the same launch menu, pick **🧪 Audit prompts (folder) — Prompt Triage scan**. Then provide:

1. **A folder containing prompt files** — Ghost recognizes `.md`, `.markdown`, `.txt`, `.yaml`, `.yml`, and `.json`
2. **Optional target model** — pick from Claude (Opus 4.7 / 4.6, Sonnet 4.6, Haiku 4.5), OpenAI (GPT-5, GPT-4o, GPT-4o mini, GPT-4.1), or Google (Gemini 2.5 Pro, Gemini 2.5 Flash). Specifying a target model unlocks 10 additional detectors that need it for accurate token counting and context-window analysis.

Ghost runs all 15 detectors against each prompt file and produces a Markdown report grouped by file, with each finding tagged by severity, detector name, location, and suggested fix.

**The 15 detectors** cover both Tier 1 defects (deterministic, structural — formatting, length, unbounded output, prompt-injection patterns, role separation, token-limit overflow, token-limit excessive) and Tier 2 defects (LLM-evaluated — ambiguous instruction, underspecified constraints, conflicting instructions, undefined output format, overloaded prompt, poor organization, inefficient few-shot, poor documentation).

**Detection methodology** is based on Tian et al. (2025), "A Taxonomy of Prompt Defects in LLM Systems" ([arXiv:2509.14404](https://arxiv.org/abs/2509.14404)). Tier 1 detectors run locally with no API calls; Tier 2 detectors call Claude (your default configured model) once per detector per prompt for evaluation. Cost typically lands at a few cents per prompt audited.

---

## Cost Controls

Ghost ships with three flags for controlling what gets scanned and how much context gets sent to the model. Use them to dial costs down on large codebases.

**`--max-context N`** — override the context cap in tokens. Ghost Open is capped at 50,000 tokens; higher values are clamped and warned.

```bash
ghost --max-context 40000
```

**`--exclude "glob"`** — skip files matching a glob pattern. Repeatable.

```bash
ghost --exclude "seeds/**" --exclude "*.fixture.js"
```

**`--exclude-presets name,name`** — apply curated exclusion bundles:

- `test-data` — seeds, migrations, fixtures, tests, spec folders, `*.test.js`, `*.spec.js`, `*.test.php`, `*Test.php`
- `generated` — `generated/`, `dist/`, `build/`, `.next/`, `out/`, `coverage/`
- `vendor-cache` — `var/`, `tmp/`, `.cache/`, `pub/static/`, `pub/media/`

```bash
ghost --exclude-presets test-data,generated
```

Combine flags freely:

```bash
ghost --exclude-presets test-data --exclude "legacy/**" --max-context 45000
```

Most large-repo scans come in 60–80% cheaper just by running with `--exclude-presets test-data`.

See all flags: `ghost --help`

---

## Ghost Open vs Ghost Pro and Higher Tiers

Ghost Open is the full scan engine. Pro, Team, Enterprise, and Partner add tracking, comparison, and white-label features on top of the same scans.

| Feature | Ghost Open | Ghost Pro | Team | Enterprise |
|---|---|---|---|---|
| Chat / POI / Blast / Conflict / Recon | ✅ all | ✅ all | ✅ all | ✅ all |
| Prompt Triage (15 detectors) | ✅ | ✅ | ✅ | ✅ |
| Reports save as MD/PDF/TXT | ✅ | ✅ | ✅ | ✅ |
| Project labels + history tracking | ❌ no labels | ✅ | ✅ | ✅ |
| Project Dashboard | ❌ | ✅ | ✅ | ✅ |
| Compare Reports (before/after diff) | ❌ | ✅ | ✅ | ✅ |
| Ghost Partner™ profiles + white-label | ❌ | ✅ | ✅ | ✅ |
| Per-profile billing rate overrides | ❌ | ✅ | ✅ | ✅ |
| Team sync features | ❌ | ❌ | ✅ | ✅ |
| Enterprise gating | ❌ | ❌ | ❌ | ✅ |
| Context cap | 50K | 100K | 150K | 200K |

[**Get Ghost Pro at ghostarchitect.dev**](https://ghostarchitect.dev)

---

## Privacy

Ghost Architect™ scans run locally on your machine. Your codebase is never uploaded, never stored on Ghost infrastructure, and never transmitted anywhere except directly to Anthropic's API using your own key. Analysis happens under your own data agreement with Anthropic. Your client's code stays yours.

The Ghost CLI itself does not transmit any code, scan results, or system information.

### First-run prompt and anonymous heartbeat

On first run, Ghost Architect Open asks once whether you'd like to receive occasional product updates. This is how we stay in touch with users — npm gives us no visibility into who installs the package.

The first-run prompt is fully optional. Pick "No" or "Skip" and Ghost saves a local config so it never asks again.

**Anonymous heartbeat.** Whether you opt in or not, Ghost sends an anonymous ping when you run the CLI — at most once per 24 hours per machine. The ping contains only a locally-generated random UUID, the Ghost version, a source tag (e.g. `cli-usage`, `cli-firstrun-no`, `cli-install`), and a timestamp. No email, no code, no system info, no IP-level tracking beyond what any HTTP request inherently carries. This lets us see how many people are actively using Ghost over time so we know where to invest. Disable entirely with `GHOST_NO_PING=1` in your environment.

If you opt in:
- We collect: your email address, the anonymous install ID (UUID), the Ghost version, and a timestamp.
- We do not collect: anything about the codebases you scan, scan results, IP addresses, system info, or browsing behavior.
- Storage: Cloudflare Worker + Airtable. Never sold, never shared with third parties.

Opt out anytime by emailing support@ghostarchitect.dev. To reset your local config (which re-triggers the prompt), delete `~/.ghost-architect/config.json`. To disable the anonymous heartbeat entirely, set `GHOST_NO_PING=1` in your shell environment.

---

## From the Blog

Real scans, real findings, and how to think about codebase triage:

- [What Does a Codebase Triage Actually Look Like? A Real Walkthrough](https://ghostarchitect.dev/blog/codebase-triage-walkthrough.html)
- [We Ran Ghost Architect on a Real Meta Magento Extension — 18 Findings in 10 Minutes](https://ghostarchitect.dev/blog/meta-extension-scan.html)
- [The $0.23 Audit: How Much Does AI Codebase Analysis Actually Cost?](https://ghostarchitect.dev/blog/cost-of-ai-codebase-analysis.html)
- [Why Claude Code Is Not Your Starting Point](https://ghostarchitect.dev/blog/why-claude-code-is-not-your-starting-point.html)
- [Magento 2.4.4 Hits End of Life — Here's What That Actually Means for Your Codebase](https://ghostarchitect.dev/blog/magento-244-eol.html)

---

## License

MIT — see [LICENSE](LICENSE)

---

*Ghost Architect™ is a product of Ghost Platform™*  
*© 2026 Ghost Architect. All rights reserved.*  
*[ghostarchitect.dev](https://ghostarchitect.dev)*
