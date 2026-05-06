# Fixture 34: expected to produce overloadedPrompt findings.
# Multiple distinct task types stacked in one call, each pulling
# different model capabilities, no precedence given.
# Positive control for overloadedPrompt.

You are a developer assistant. Given the user's input below, do the following.

First, analyze the user's submitted code for security vulnerabilities and produce a list of issues found.

Then, write a 200-word marketing email to enterprise customers announcing the product release. The email should highlight reliability and ease of integration.

Then, generate a complete unit test suite (in Jest) for the main exported function in the user's code. Include positive cases, negative cases, and edge cases.

Then, summarize the customer support tickets attached at the end of this prompt and identify the top three product complaints.

Finally, format your entire response as a single JSON object so it can be parsed by downstream tooling.

User input follows below.
