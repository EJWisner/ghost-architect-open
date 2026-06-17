<!--
  Fixture: 03-broken-unclosed-inline-code
  Expected triage findings: two formatting/unbalanced-inline-code findings at
  LOW severity, from the two inline-code spans that are opened but never
  closed (the cyclomatic-complexity line and the eslint-rules line). This
  fixture also incidentally trips one output/unbounded finding at LOW because
  the prompt requests a review without a length bound; that is a real,
  expected by-product of the broken content, not a separate target. Enforced
  by tests/assert-prompt-pack.mjs (expected range 1-12 findings).
-->
You are a code reviewer.

When you see a function, evaluate its complexity. Functions with `cyclomatic complexity > 10 should be flagged.

Use the `eslint rules as your reference. The `no-unused-vars` rule and the no-console rule are top priority.

Provide your review in markdown.
