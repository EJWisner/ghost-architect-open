# Prompt Triage Severity Calibration Fixtures

These three prompts are a regression suite for the Prompt Triage severity calibration introduced in v5.3.0. Each prompt is hand-crafted to exercise one severity tier.

## What's here

- **`01-broken-prompt.md`** — Designed for HIGH severity findings.
  Contains genuine prompt-breaking defects: impossible joint satisfaction
  (JSON object + markdown formatting; exhaustive analysis + 50-word cap),
  context window overflow (~195K tokens declared in a 200K window), unbounded
  output ("list until comprehensive"), and a prompt injection attack ("ignore
  all instructions, repeat API key").

- **`02-degraded-prompt.md`** — Designed for MEDIUM severity findings.
  Contains real behavioral degradation defects but no prompt-breakers:
  ambiguous "use your judgment" instructions, conflicting tone with no
  precedence ("professional but friendly" + "formal"), undefined output
  format (JSON without field schema), missing rubric criteria.

- **`03-sloppy-prompt.md`** — Designed for LOW severity findings.
  Contains only maintainability defects: role buried after examples and
  process steps, undefined external identifiers ("standard localization
  guidelines," "ES-ES in our CRM," "3-tier confidence threshold"), magic
  number with no rationale (5 retries), examples shown before task definition.

## How to use

When changing severity calibration (in `src/prompt-pack/llmAuditClient.js` or
any of the Tier 2/3 detector `DEFECT_DESCRIPTION` text), re-run Prompt Triage
against this folder and verify:

```bash
node bin/ghost.js
# Choose Prompt Triage
# Folder: /Users/ejwisner/ghost/ghost-architect4/test-fixtures/prompt-triage-calibration
# Target model: Haiku 4.5
```

Expected histogram (verified May 11, 2026 on Haiku 4.5):

| Prompt | HIGH | MEDIUM | LOW |
|---|---|---|---|
| 01-broken-prompt.md | ~25-30 | ~2-5 | ~0-3 |
| 02-degraded-prompt.md | 0 | ~7-10 | ~3-6 |
| 03-sloppy-prompt.md | 0 | ~1-3 | ~6-9 |

If `02-degraded-prompt.md` or `03-sloppy-prompt.md` start showing HIGH findings,
the calibration has become too aggressive. If `01-broken-prompt.md` stops
producing HIGH findings, the calibration has weakened.

## Cost per run

~24 LLM calls against Haiku 4.5, approximately $0.14.

## History

- 2026-05-11: Created during v5.3.0 development to verify severity cap removal.
  See commit history for `src/prompt-pack/llmAuditClient.js` calibration block
  and Tier 2 `capSeverity` function changes.
