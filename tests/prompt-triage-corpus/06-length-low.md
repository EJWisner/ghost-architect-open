<!--
  Fixture 06-length-low.md
  Target word count: ~3401 words (108 numbered guideline lines)
  Severity tier: LOW
  Generated: 2026-06-17 by _generate-length-fixtures.mjs

  Expected triage finding: length/excessive at LOW severity.
  This is an intentionally bloated prompt, a long and repetitive
  instruction list whose token count clears the LOW length threshold (>3000) but stays below MEDIUM (6000).
  The body is duplicated instruction blocks with slight variation
  (a cycled pool of prompt-engineering guidelines, each line
  numbered), not one sentence repeated, so the file documents what
  real prompt bloat looks like.
-->

# Prompt engineering style guide (verbose, intentionally bloated)

1. A well-designed prompt sets clear context, defines the task with precision, specifies the output format, and supplies relevant examples without bloating the input or burying the operative instruction.
2. State the model role up front so it can adopt a consistent voice, then describe the audience and the goal before listing any constraints that the response must satisfy.
3. Put the single most important instruction near the top, because instructions buried in the middle of a long prompt compete for attention and are the first thing a model quietly drops.
4. When you provide examples, label the input and the expected output explicitly, and keep the formatting of those examples identical to the formatting you want the model to produce.
5. Prefer a short, ordered list of requirements over a dense paragraph; numbered constraints are easier for the model to track and easier for a reviewer to audit later for drift.
6. Specify the output format concretely: name the fields, the order, whether JSON or prose is expected, and what the model should do when a field has no value rather than leaving it open.
7. Tell the model what to do when it is uncertain, because a prompt that never mentions ambiguity invites confident guessing, and a guess that reads as fact is worse than an honest hedge.
8. Avoid stacking redundant instructions that say the same thing three different ways; each restatement adds tokens, adds cost, and gives the model one more place to find a contradiction.
9. Use delimiters to separate instructions from data, so that text the user pastes in cannot be mistaken for a command the author intended the model to follow during the request.
10. Keep the tone guidance specific: "plain, direct sentences" steers better than "be professional," which every model interprets differently and which therefore steers almost nothing at all.
11. Define the boundaries of the task as carefully as the task itself, naming what is out of scope so the model does not wander into adjacent work that the author never actually requested.
12. Re-read a long prompt as though you were the model: if two sections disagree, the one you notice last is the one that will silently win, so resolve the conflict before you ship it.
13. When a constraint really matters, state the consequence of violating it, because a rule with a stated reason survives summarization and paraphrase better than a bare imperative ever does.
14. Trim context that is no longer relevant on every revision; stale background accumulates quietly, and a prompt that grew by addition alone is almost always larger than the task requires.
15. Ask for the reasoning and the answer in clearly separated sections when you need both, so a downstream parser can take the answer without having to strip the surrounding explanation first.
16. Test the prompt against the edge cases you expect in production, not just the happy path, because the failure modes that matter are the ones the cheerful first draft never thought to cover.
17. A well-designed prompt sets clear context, defines the task with precision, specifies the output format, and supplies relevant examples without bloating the input or burying the operative instruction.
18. State the model role up front so it can adopt a consistent voice, then describe the audience and the goal before listing any constraints that the response must satisfy.
19. Put the single most important instruction near the top, because instructions buried in the middle of a long prompt compete for attention and are the first thing a model quietly drops.
20. When you provide examples, label the input and the expected output explicitly, and keep the formatting of those examples identical to the formatting you want the model to produce.
21. Prefer a short, ordered list of requirements over a dense paragraph; numbered constraints are easier for the model to track and easier for a reviewer to audit later for drift.
22. Specify the output format concretely: name the fields, the order, whether JSON or prose is expected, and what the model should do when a field has no value rather than leaving it open.
23. Tell the model what to do when it is uncertain, because a prompt that never mentions ambiguity invites confident guessing, and a guess that reads as fact is worse than an honest hedge.
24. Avoid stacking redundant instructions that say the same thing three different ways; each restatement adds tokens, adds cost, and gives the model one more place to find a contradiction.
25. Use delimiters to separate instructions from data, so that text the user pastes in cannot be mistaken for a command the author intended the model to follow during the request.
26. Keep the tone guidance specific: "plain, direct sentences" steers better than "be professional," which every model interprets differently and which therefore steers almost nothing at all.
27. Define the boundaries of the task as carefully as the task itself, naming what is out of scope so the model does not wander into adjacent work that the author never actually requested.
28. Re-read a long prompt as though you were the model: if two sections disagree, the one you notice last is the one that will silently win, so resolve the conflict before you ship it.
29. When a constraint really matters, state the consequence of violating it, because a rule with a stated reason survives summarization and paraphrase better than a bare imperative ever does.
30. Trim context that is no longer relevant on every revision; stale background accumulates quietly, and a prompt that grew by addition alone is almost always larger than the task requires.
31. Ask for the reasoning and the answer in clearly separated sections when you need both, so a downstream parser can take the answer without having to strip the surrounding explanation first.
32. Test the prompt against the edge cases you expect in production, not just the happy path, because the failure modes that matter are the ones the cheerful first draft never thought to cover.
33. A well-designed prompt sets clear context, defines the task with precision, specifies the output format, and supplies relevant examples without bloating the input or burying the operative instruction.
34. State the model role up front so it can adopt a consistent voice, then describe the audience and the goal before listing any constraints that the response must satisfy.
35. Put the single most important instruction near the top, because instructions buried in the middle of a long prompt compete for attention and are the first thing a model quietly drops.
36. When you provide examples, label the input and the expected output explicitly, and keep the formatting of those examples identical to the formatting you want the model to produce.
37. Prefer a short, ordered list of requirements over a dense paragraph; numbered constraints are easier for the model to track and easier for a reviewer to audit later for drift.
38. Specify the output format concretely: name the fields, the order, whether JSON or prose is expected, and what the model should do when a field has no value rather than leaving it open.
39. Tell the model what to do when it is uncertain, because a prompt that never mentions ambiguity invites confident guessing, and a guess that reads as fact is worse than an honest hedge.
40. Avoid stacking redundant instructions that say the same thing three different ways; each restatement adds tokens, adds cost, and gives the model one more place to find a contradiction.
41. Use delimiters to separate instructions from data, so that text the user pastes in cannot be mistaken for a command the author intended the model to follow during the request.
42. Keep the tone guidance specific: "plain, direct sentences" steers better than "be professional," which every model interprets differently and which therefore steers almost nothing at all.
43. Define the boundaries of the task as carefully as the task itself, naming what is out of scope so the model does not wander into adjacent work that the author never actually requested.
44. Re-read a long prompt as though you were the model: if two sections disagree, the one you notice last is the one that will silently win, so resolve the conflict before you ship it.
45. When a constraint really matters, state the consequence of violating it, because a rule with a stated reason survives summarization and paraphrase better than a bare imperative ever does.
46. Trim context that is no longer relevant on every revision; stale background accumulates quietly, and a prompt that grew by addition alone is almost always larger than the task requires.
47. Ask for the reasoning and the answer in clearly separated sections when you need both, so a downstream parser can take the answer without having to strip the surrounding explanation first.
48. Test the prompt against the edge cases you expect in production, not just the happy path, because the failure modes that matter are the ones the cheerful first draft never thought to cover.
49. A well-designed prompt sets clear context, defines the task with precision, specifies the output format, and supplies relevant examples without bloating the input or burying the operative instruction.
50. State the model role up front so it can adopt a consistent voice, then describe the audience and the goal before listing any constraints that the response must satisfy.
51. Put the single most important instruction near the top, because instructions buried in the middle of a long prompt compete for attention and are the first thing a model quietly drops.
52. When you provide examples, label the input and the expected output explicitly, and keep the formatting of those examples identical to the formatting you want the model to produce.
53. Prefer a short, ordered list of requirements over a dense paragraph; numbered constraints are easier for the model to track and easier for a reviewer to audit later for drift.
54. Specify the output format concretely: name the fields, the order, whether JSON or prose is expected, and what the model should do when a field has no value rather than leaving it open.
55. Tell the model what to do when it is uncertain, because a prompt that never mentions ambiguity invites confident guessing, and a guess that reads as fact is worse than an honest hedge.
56. Avoid stacking redundant instructions that say the same thing three different ways; each restatement adds tokens, adds cost, and gives the model one more place to find a contradiction.
57. Use delimiters to separate instructions from data, so that text the user pastes in cannot be mistaken for a command the author intended the model to follow during the request.
58. Keep the tone guidance specific: "plain, direct sentences" steers better than "be professional," which every model interprets differently and which therefore steers almost nothing at all.
59. Define the boundaries of the task as carefully as the task itself, naming what is out of scope so the model does not wander into adjacent work that the author never actually requested.
60. Re-read a long prompt as though you were the model: if two sections disagree, the one you notice last is the one that will silently win, so resolve the conflict before you ship it.
61. When a constraint really matters, state the consequence of violating it, because a rule with a stated reason survives summarization and paraphrase better than a bare imperative ever does.
62. Trim context that is no longer relevant on every revision; stale background accumulates quietly, and a prompt that grew by addition alone is almost always larger than the task requires.
63. Ask for the reasoning and the answer in clearly separated sections when you need both, so a downstream parser can take the answer without having to strip the surrounding explanation first.
64. Test the prompt against the edge cases you expect in production, not just the happy path, because the failure modes that matter are the ones the cheerful first draft never thought to cover.
65. A well-designed prompt sets clear context, defines the task with precision, specifies the output format, and supplies relevant examples without bloating the input or burying the operative instruction.
66. State the model role up front so it can adopt a consistent voice, then describe the audience and the goal before listing any constraints that the response must satisfy.
67. Put the single most important instruction near the top, because instructions buried in the middle of a long prompt compete for attention and are the first thing a model quietly drops.
68. When you provide examples, label the input and the expected output explicitly, and keep the formatting of those examples identical to the formatting you want the model to produce.
69. Prefer a short, ordered list of requirements over a dense paragraph; numbered constraints are easier for the model to track and easier for a reviewer to audit later for drift.
70. Specify the output format concretely: name the fields, the order, whether JSON or prose is expected, and what the model should do when a field has no value rather than leaving it open.
71. Tell the model what to do when it is uncertain, because a prompt that never mentions ambiguity invites confident guessing, and a guess that reads as fact is worse than an honest hedge.
72. Avoid stacking redundant instructions that say the same thing three different ways; each restatement adds tokens, adds cost, and gives the model one more place to find a contradiction.
73. Use delimiters to separate instructions from data, so that text the user pastes in cannot be mistaken for a command the author intended the model to follow during the request.
74. Keep the tone guidance specific: "plain, direct sentences" steers better than "be professional," which every model interprets differently and which therefore steers almost nothing at all.
75. Define the boundaries of the task as carefully as the task itself, naming what is out of scope so the model does not wander into adjacent work that the author never actually requested.
76. Re-read a long prompt as though you were the model: if two sections disagree, the one you notice last is the one that will silently win, so resolve the conflict before you ship it.
77. When a constraint really matters, state the consequence of violating it, because a rule with a stated reason survives summarization and paraphrase better than a bare imperative ever does.
78. Trim context that is no longer relevant on every revision; stale background accumulates quietly, and a prompt that grew by addition alone is almost always larger than the task requires.
79. Ask for the reasoning and the answer in clearly separated sections when you need both, so a downstream parser can take the answer without having to strip the surrounding explanation first.
80. Test the prompt against the edge cases you expect in production, not just the happy path, because the failure modes that matter are the ones the cheerful first draft never thought to cover.
81. A well-designed prompt sets clear context, defines the task with precision, specifies the output format, and supplies relevant examples without bloating the input or burying the operative instruction.
82. State the model role up front so it can adopt a consistent voice, then describe the audience and the goal before listing any constraints that the response must satisfy.
83. Put the single most important instruction near the top, because instructions buried in the middle of a long prompt compete for attention and are the first thing a model quietly drops.
84. When you provide examples, label the input and the expected output explicitly, and keep the formatting of those examples identical to the formatting you want the model to produce.
85. Prefer a short, ordered list of requirements over a dense paragraph; numbered constraints are easier for the model to track and easier for a reviewer to audit later for drift.
86. Specify the output format concretely: name the fields, the order, whether JSON or prose is expected, and what the model should do when a field has no value rather than leaving it open.
87. Tell the model what to do when it is uncertain, because a prompt that never mentions ambiguity invites confident guessing, and a guess that reads as fact is worse than an honest hedge.
88. Avoid stacking redundant instructions that say the same thing three different ways; each restatement adds tokens, adds cost, and gives the model one more place to find a contradiction.
89. Use delimiters to separate instructions from data, so that text the user pastes in cannot be mistaken for a command the author intended the model to follow during the request.
90. Keep the tone guidance specific: "plain, direct sentences" steers better than "be professional," which every model interprets differently and which therefore steers almost nothing at all.
91. Define the boundaries of the task as carefully as the task itself, naming what is out of scope so the model does not wander into adjacent work that the author never actually requested.
92. Re-read a long prompt as though you were the model: if two sections disagree, the one you notice last is the one that will silently win, so resolve the conflict before you ship it.
93. When a constraint really matters, state the consequence of violating it, because a rule with a stated reason survives summarization and paraphrase better than a bare imperative ever does.
94. Trim context that is no longer relevant on every revision; stale background accumulates quietly, and a prompt that grew by addition alone is almost always larger than the task requires.
95. Ask for the reasoning and the answer in clearly separated sections when you need both, so a downstream parser can take the answer without having to strip the surrounding explanation first.
96. Test the prompt against the edge cases you expect in production, not just the happy path, because the failure modes that matter are the ones the cheerful first draft never thought to cover.
97. A well-designed prompt sets clear context, defines the task with precision, specifies the output format, and supplies relevant examples without bloating the input or burying the operative instruction.
98. State the model role up front so it can adopt a consistent voice, then describe the audience and the goal before listing any constraints that the response must satisfy.
99. Put the single most important instruction near the top, because instructions buried in the middle of a long prompt compete for attention and are the first thing a model quietly drops.
100. When you provide examples, label the input and the expected output explicitly, and keep the formatting of those examples identical to the formatting you want the model to produce.
101. Prefer a short, ordered list of requirements over a dense paragraph; numbered constraints are easier for the model to track and easier for a reviewer to audit later for drift.
102. Specify the output format concretely: name the fields, the order, whether JSON or prose is expected, and what the model should do when a field has no value rather than leaving it open.
103. Tell the model what to do when it is uncertain, because a prompt that never mentions ambiguity invites confident guessing, and a guess that reads as fact is worse than an honest hedge.
104. Avoid stacking redundant instructions that say the same thing three different ways; each restatement adds tokens, adds cost, and gives the model one more place to find a contradiction.
105. Use delimiters to separate instructions from data, so that text the user pastes in cannot be mistaken for a command the author intended the model to follow during the request.
106. Keep the tone guidance specific: "plain, direct sentences" steers better than "be professional," which every model interprets differently and which therefore steers almost nothing at all.
107. Define the boundaries of the task as carefully as the task itself, naming what is out of scope so the model does not wander into adjacent work that the author never actually requested.
108. Re-read a long prompt as though you were the model: if two sections disagree, the one you notice last is the one that will silently win, so resolve the conflict before you ship it.
