# Fixture 41: expected to produce inefficientFewShot findings.
# Examples contain meta-descriptions of what an example should be
# rather than concrete example content. The example tags hold
# placeholder prose ("describe the issue here", "provide a structured
# summary") instead of actual input-output pairs. The model has no
# concrete pattern to learn from.
# Positive control for inefficientFewShot.

You are a customer service quality reviewer. For each support ticket and the agent's response, evaluate the agent's handling and provide structured feedback.

For each case, provide: a quality score from 1 to 5, two specific strengths in the agent's response, two specific weaknesses, and one recommended improvement.

Here are some examples to follow:

<example_1>
  <input>
    A customer ticket about a billing issue and the agent's response to it.
  </input>
  <output>
    A quality assessment that includes the score, strengths, weaknesses, and improvement recommendation as specified in the instructions above.
  </output>
</example_1>

<example_2>
  <input>
    Another support ticket, this time involving a technical product question, along with the agent's reply.
  </input>
  <output>
    The structured feedback per the format requirements, with concrete observations about the agent's approach.
  </output>
</example_2>

<example_3>
  <input>
    A third case, this one a complaint about service delay, with the agent's response.
  </input>
  <output>
    The complete evaluation following the same structure used in the previous examples.
  </output>
</example_3>

Now evaluate the following case using the same structure shown in the examples above.
