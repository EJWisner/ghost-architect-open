<!--
  Fixture: 01-broken-unclosed-code-block
  Expected triage finding: formatting/unclosed-code-block at HIGH severity.
  Reason: the fenced JSON block opened below is never closed, so the fence
  count is odd. This is detected and enforced by tests/assert-prompt-pack.mjs
  (expected range 1-6 findings).
-->
You are a helpful coding assistant.

When the user provides code, analyze it and return suggestions in the following format:

```json
{
  "issues": [],
  "suggestions": []
}

Always respond in valid JSON. Be concise.
