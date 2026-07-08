// src/core/usage-tracker.js
//
// Process-scoped accumulator for REAL Anthropic token usage during a single
// scan. Every API call site in the scan pipeline reports its response.usage
// here so the mode layer can bill the ACTUAL cost instead of a char/4 estimate
// (which historically undercounted a full POI scan by ~9x because it only
// measured the codebase context once, ignoring the N scan passes, synthesis,
// narrator, and per-finding verifier calls).
//
// This is a leaf module with no imports, so any pipeline file (multipass,
// analyst, narrator, verifier) can record into it without creating a circular
// dependency. A scan runs sequentially in one process, so a module-scoped sink
// is safe: the mode brackets the scan with beginUsageCapture()/endUsageCapture()
// and every call site in between records into the active sink. When no capture
// is active (blast/conflict modes, tests, non-scan calls) recordUsage() is a
// no-op, so this cannot affect any code path that does not opt in.

let sink = null;

// Start a fresh capture window. Any prior window is discarded.
export function beginUsageCapture() {
  sink = { inputTokens: 0, outputTokens: 0, calls: 0 };
}

// Record one API call's real token usage. No-op unless a capture is active.
// Non-numeric / missing values coerce to 0 so a malformed usage object can
// never poison the running total.
export function recordUsage(inputTokens, outputTokens) {
  if (!sink) return;
  sink.inputTokens  += Number(inputTokens)  || 0;
  sink.outputTokens += Number(outputTokens) || 0;
  sink.calls += 1;
}

// Peek at the running total without ending the window.
export function getCapturedUsage() {
  return sink ? { ...sink } : null;
}

// End the capture window and return the accumulated total (or null if no
// window was active). Callers use `calls > 0` to decide whether to trust the
// captured figure or fall back to an estimate.
export function endUsageCapture() {
  const total = sink ? { ...sink } : null;
  sink = null;
  return total;
}
