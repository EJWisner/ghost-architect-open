# tests/ad-hoc

Scratch tests kept for regression value. Not part of the main smoke suite.
Run individually with `node tests/ad-hoc/<file>`.

- `blast-multipass-import.test.mjs` — verifies dynamic Anthropic import works in ESM context
- `blast-multipass-chunking.test.mjs` — verifies blast-multipass.js chunks fileMap correctly and synthesis pass produces coherent output (makes real API calls, ~$0.01)
