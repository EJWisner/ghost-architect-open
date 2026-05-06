# Fixture 21: expected to produce zero roleSeparation findings.
# A legitimate few-shot prompt with proper "Examples:" framing.
# Negative control for the few-shot suppression heuristic.

You are a sentiment classifier. For each input, output Positive, Negative,
or Neutral.

Examples:

User: I love this product! Five stars!
Assistant: Positive

User: It broke after a week. Returning it.
Assistant: Negative

User: It works as described.
Assistant: Neutral

Now classify the user's most recent message.
