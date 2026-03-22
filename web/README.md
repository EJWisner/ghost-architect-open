# Ghost Architect — Web UI

Next.js dashboard that runs alongside the CLI. Reads from `~/Ghost Architect Reports/`.

## Setup

```bash
cd web
npm install
npm run dev
```

Open http://localhost:4731

## Features

- **Dashboard** — recent reports + project progress at a glance
- **New Scan** — upload a ZIP, pick a mode, stream results in real-time
- **Reports** — browse and read all saved reports with syntax highlighting
- **Project Intelligence** — remediation progress tracked across scans

## Scan Modes

- 🗺 Points of Interest — red flags, landmarks, dead zones, fault lines
- ⚡ Conflict Detection — contract mismatches, schema errors, config bugs
- 💥 Blast Radius — impact map + rollback plan

## API Key

Set `ANTHROPIC_API_KEY` in your environment, or paste it into the scan form.

## Works alongside CLI

The web UI reads the same `~/Ghost Architect Reports/` folder the CLI writes to.
Run CLI scans as normal — they automatically appear in the web dashboard.
