# prompts-extracted

Snapshot of Ghost Architect's top-level system prompts, rendered to 
standalone Markdown files. Used as the dogfood corpus for Prompt Triage 
detectors during v1 development.

Each `.md` file in this folder is the exact text the LLM sees when Ghost 
runs a scan in the corresponding mode. The leading HTML comment block 
identifies the source builder and generation timestamp.

## Contents

| File | Mode | Profile |
| --- | --- | --- |
| 01-chat-system.md | Chat | (none, static prompt) |
| 02-poi-default.md | Points of Interest | none |
| 03-poi-with-profile.md | Points of Interest | sample agency profile |
| 04-blast-default.md | Blast Radius | none |
| 05-blast-with-profile.md | Blast Radius | sample agency profile |
| 06-conflict-default.md | Conflict Detection | none |
| 07-conflict-with-profile.md | Conflict Detection | sample agency profile |

## How this corpus was generated

Run `node extract-prompts.mjs` from the repo root. The script imports the 
public prompt builders (`buildSystemPOI`, `buildSystemBlast`, 
`buildSystemConflict`) and `SYSTEM_CHAT`, calls each with default billing 
rates and either no profile or a representative sample agency profile, 
then writes the rendered output to this folder.

Re-run anytime the source prompts change. Treat this corpus as a snapshot, 
not a live mirror.

## Sample profile fields

The profile-aware variants use a generic agency-consultant profile (priorities 
around PCI, SAP integration, PII handling; anti-patterns around hardcoded 
credentials and direct DB access; etc.). The exact field values are in 
extract-prompts.mjs at the top of the file.

## Out of scope for v1

Not included in this corpus:

- Internal narrator/verifier prompts (require runtime findings + plans to render)
- Per-pass user messages (scan-specific, not "prompts" in the audit sense)
- Conflict per-pass user messages from buildConflictPrompt (same reason)

These may be added to v2 if the Prompt Triage scope expands to internal 
pipeline auditing.
