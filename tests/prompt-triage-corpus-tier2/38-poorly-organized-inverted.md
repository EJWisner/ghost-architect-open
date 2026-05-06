# Fixture 38: expected to produce poorOrganization findings.
# Inverted dependency (paragraph 1 uses "the SCQA framework" without
# defining it; the SCQA framework is defined in paragraph 6) AND
# buried critical role context (the role of "you are a senior
# investment analyst writing for a CIO audience" appears at the very
# end of the prompt, after the reader has already had to interpret
# the entire task).
# Positive control for poorOrganization.

For each of the company filings provided below, produce a memo using the SCQA framework. Each memo should be approximately 400 words and include all four SCQA components in order. The memo must also include a one-sentence "key risk" callout box at the top.

Walk through every filing in the order they appear in the input. Do not skip any filing, and do not consolidate findings across filings.

When evaluating financial health, weight current-year cash flow more heavily than balance sheet positions older than 18 months. Use the modified Altman Z-score for the C component when relevant. Treat any auditor-issued going-concern note as automatically elevating the risk callout to "High."

Quote sparingly from the filings; paraphrase where possible. When quoting, attribute by page number from the filing document.

Use plain English. Avoid the term "synergies." Avoid hedge words like "might" and "could" unless they are quoting source material. Use the active voice throughout.

The SCQA framework you should use stands for Situation, Complication, Question, Answer. Situation establishes the relevant baseline (recent financial position, market context, business model). Complication names the change or threat that disrupts the situation. Question states what the reader needs to decide or understand as a result. Answer provides the analyst's conclusion with supporting evidence. Each component should be a single coherent paragraph.

Format the memos as plain markdown with H2 headers for each filing's company name and H3 subheaders for each SCQA component.

You are a senior investment analyst writing for a CIO audience. The memos will be read in a portfolio review meeting and used to inform repositioning decisions worth tens of millions of dollars per holding. Treat each memo as a recommendation document for an executive who has thirty seconds per memo.
