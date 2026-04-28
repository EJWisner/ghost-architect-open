# Ghost Architect™ — Open

> AI-powered codebase triage. Know what you are inheriting before you commit.

Ghost Architect scans your codebase, categorizes risk by severity, and gives your team a map of where to start. It does not replace your engineers. It tells them where to look.

**Ghost Open is free and full-featured.** Every scan mode is available. Every finding — Critical, High, Medium, Low — is in the report. PDF, Markdown, and TXT outputs are generated for every scan. The only thing Ghost Open does not do is track your scan history across runs — each scan overwrites the prior report. Project tracking, baselines, dashboards, and consultant profiles are part of Ghost Pro and the higher tiers.

---

## What It Does

Ghost triages your codebase — categorizes risk, prioritizes findings, gives your team a map of where to start.

Five scan modes are available:

- **Chat** — interactive Q&A with the codebase. Ask anything about the architecture, the conventions, the suspicious bits.
- **Points of Interest** — auto-map red flags, landmarks, dead zones, and fault lines across the whole codebase. Severity-scored, with effort estimates and recommended fixes.
- **Blast Radius** — pick a file, class, or method. Ghost maps every dependency that would be affected by a change, plus a complete rollback plan.
- **Conflict Detection** — find contract mismatches, schema conflicts, config key errors, and constant disagreements that no linter catches.
- **Recon** — sizing-only mode. Single planner call, ~$0.05. Tells you what a full scan would surface before you commit to running one.

Every scan produces three files:

- `ghost-poi.txt` / `ghost-poi.md` / `ghost-poi.pdf` — for Points of Interest
- `ghost-blast.txt` / `ghost-blast.md` / `ghost-blast.pdf` — for Blast Radius
- `ghost-conflict.txt` / `ghost-conflict.md` / `ghost-conflict.pdf` — for Conflict Detection
- `ghost-recon.txt` / `ghost-recon.md` / `ghost-recon.pdf` — for Recon

Reports save to `~/Ghost Architect Reports/` and overwrite the prior run for that mode. Chat is interactive only and does not save a transcript.

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

Each mode produces three files (TXT, MD, PDF). Each run overwrites the prior run's reports for that mode.

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

Ghost Architect™ runs locally on your machine. Your codebase is never uploaded, never stored, and never transmitted to Ghost servers — because there are no Ghost servers. Analysis calls go directly from your machine to Anthropic's API using your own key, under your own data agreement. Your client's code stays yours.

Ghost Architect does not collect telemetry. It does not phone home.

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
