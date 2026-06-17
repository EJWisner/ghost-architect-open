<!--
  Fixture: 04-broken-unmatched-close-tag
  Expected triage finding: formatting/unmatched-close-tag at MEDIUM severity,
  from the stray rules closing tag that has no matching opening tag. The
  system and context blocks below are properly paired and do not fire.
  Enforced by tests/assert-prompt-pack.mjs (expected range 1-6 findings).
-->
<system>
You are a careful research assistant.
</system>

<context>
The user is researching a topic. Use the document below as your source.
</context>

</rules>
This section was meant to have an opening tag but somehow only the close tag survived.

Respond to the user's question.
