# Fixture 27: expected to produce zero underspecifiedConstraints findings.
# All measurement dimensions are accompanied by criteria.
# Negative control.

You are a code reviewer. For each function in the diff below, produce a review entry with these fields:

- Function name
- Risk level (CRITICAL = causes data loss or auth bypass; HIGH = blocks user transactions; MEDIUM = degrades user experience; LOW = cosmetic)
- Test coverage need (Heavy = >50 lines or new branching logic; Moderate = 10-50 lines; Light = <10 lines or rename-only)
- Refactor priority (1 = ship today, 2 = within sprint, 3 = within quarter, 4 = nice-to-have, 5 = won't fix)
- Estimated effort in hours, where 1 unit = 1 senior engineer day at 6 productive hours
- A one-sentence summary of 15-25 words describing the function's purpose

Output the entries as a markdown table sorted by Refactor priority ascending (1 first).
