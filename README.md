# Ghost Architect™ — Open

> AI-powered codebase triage. Know what you are inheriting before you commit.

Ghost Architect scans your codebase, categorizes risk by severity, and gives your team a map of where to start. It does not replace your engineers. It tells them where to look.

**Ghost Open is free.** Reports are limited to Critical and High findings. Full output — Medium, Low, multipass, project intelligence, PDF — is Ghost Pro.

---

## What It Does

Ghost triages your codebase — categorizes risk, prioritizes findings, gives your team a map of where to start.

- Scans your codebase for security, performance, and architecture risk
- Rates every finding by severity: Critical, High, Medium, Low
- Outputs TXT, Markdown, and PDF reports
- Runs locally. Your code never leaves your machine.

**Ghost Open output:** Critical and High findings only, in TXT and Markdown format.  
**Ghost Pro output:** All findings, multipass analysis, project intelligence, PDF, and more. [ghostarchitect.dev](https://ghostarchitect.dev)

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

**1. Clone the repo**

```bash
git clone https://github.com/EJWisner/ghost-architect-open.git
cd ghost-architect-open
```

**2. Install dependencies**

```bash
npm install
```

**3. Set your Anthropic API key**

```bash
export ANTHROPIC_API_KEY=your_key_here
```

To make this permanent, add it to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
echo 'export ANTHROPIC_API_KEY=your_key_here' >> ~/.zshrc
source ~/.zshrc
```

**4. Run Ghost Architect**

```bash
node bin/ghost.js
```

---

## Running a Scan

On launch, Ghost presents a menu. Select **Scan a local directory** and point it at your codebase or a module directory.

Ghost will analyze the files, score findings by severity, and save reports to:

```
~/Ghost Architect Reports/
```

Three files are generated per scan: `.txt`, `.md`, and `.pdf`.

**Ghost Open reports include Critical and High findings only.**

---

## Upgrading to Ghost Pro

Ghost Open shows you the surface. Ghost Pro shows you everything.

| Feature | Ghost Open | Ghost Pro |
|---|---|---|
| Critical & High findings | ✅ | ✅ |
| Medium & Low findings | ❌ | ✅ |
| Multipass analysis | ❌ | ✅ |
| Project intelligence | ❌ | ✅ |
| Full PDF report | ❌ | ✅ |
| Priority support | ❌ | ✅ |

[**Get Ghost Pro at ghostarchitect.dev**](https://ghostarchitect.dev)

---

## Privacy

Ghost Architect™ runs locally on your machine. Your codebase is never uploaded, never stored, and never transmitted to Ghost servers — because there are no Ghost servers. Analysis calls go directly from your machine to Anthropic's API using your own key, under your own data agreement. Your client's code stays yours.

Ghost Architect does not collect telemetry. It does not phone home.

---

## License

MIT — see [LICENSE](LICENSE)

---

*Ghost Architect™ is a product of Ghost Platform™*  
*© 2026 Ghost Architect. All rights reserved.*  
*[ghostarchitect.dev](https://ghostarchitect.dev)*
