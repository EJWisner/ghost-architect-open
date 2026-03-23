/**
 * Ghost Architect — Agent Memory
 * Intra-session state for the ReAct loop.
 * Tracks files read, decisions made, findings confirmed, and full action trace.
 * Pure data structure — no Chalk, no Inquirer, no console output.
 */

export class AgentMemory {
  constructor() {
    this.filesRead       = new Map();  // path → content or summary
    this.actionsHistory  = [];         // full ReAct trace
    this.findings        = [];         // confirmed findings from flagFinding()
    this.resolvedClasses = new Map();  // className → file path
    this.searchResults   = new Map();  // query → results array
    this.startedAt       = new Date().toISOString();
    this.stepCount       = 0;
  }

  // ── Record a completed action ─────────────────────────────────────────────

  record(action, input, result, reasoning = '') {
    this.stepCount++;
    const entry = {
      step:      this.stepCount,
      action,
      input,
      result:    typeof result === 'string' ? result.slice(0, 500) : JSON.stringify(result).slice(0, 500),
      reasoning: reasoning.slice(0, 300),
      timestamp: new Date().toISOString(),
    };
    this.actionsHistory.push(entry);

    // Side-effect caching by action type
    if (action === 'readFile' && input?.path) {
      this.filesRead.set(input.path, result);
    }
    if (action === 'summarizeFile' && input?.path) {
      this.filesRead.set(input.path, result); // summary counts as read
    }
    if (action === 'resolveClass' && input?.className && result?.path) {
      this.resolvedClasses.set(input.className, result.path);
    }
    if (action === 'searchFiles' && input?.query) {
      this.searchResults.set(input.query, result);
    }
  }

  // ── Add a confirmed finding ───────────────────────────────────────────────

  addFinding(finding) {
    this.findings.push({
      ...finding,
      id:          this.findings.length + 1,
      confirmedAt: new Date().toISOString(),
    });
  }

  // ── Get compressed history for context window efficiency ──────────────────
  // Returns last N actions — keeps context window usage manageable

  getHistory(limit = 10) {
    return this.actionsHistory.slice(-limit).map(e => ({
      step:      e.step,
      action:    e.action,
      input:     e.input,
      reasoning: e.reasoning,
      resultSummary: typeof e.result === 'string'
        ? e.result.slice(0, 200)
        : e.result,
    }));
  }

  // ── Check if a file has already been read ─────────────────────────────────

  hasRead(filePath) {
    return this.filesRead.has(filePath);
  }

  // ── Get cached file content ───────────────────────────────────────────────

  getCached(filePath) {
    return this.filesRead.get(filePath) || null;
  }

  // ── Check if a class has been resolved ───────────────────────────────────

  getResolvedClass(className) {
    return this.resolvedClasses.get(className) || null;
  }

  // ── Synthesize final output ───────────────────────────────────────────────
  // Called at end of agent run to produce the complete result object

  synthesize() {
    const elapsed = Math.round(
      (new Date() - new Date(this.startedAt)) / 1000
    );
    return {
      filesAnalyzed:    this.filesRead.size,
      findings:         this.findings,
      findingCount:     this.findings.length,
      stepCount:        this.stepCount,
      elapsedSeconds:   elapsed,
      auditTrail:       this.actionsHistory,
      resolvedClasses:  Object.fromEntries(this.resolvedClasses),
      startedAt:        this.startedAt,
      completedAt:      new Date().toISOString(),
    };
  }

  // ── Produce a summary string for logging/display ──────────────────────────

  summary() {
    return {
      filesRead:     this.filesRead.size,
      steps:         this.stepCount,
      findings:      this.findings.length,
      classesResolved: this.resolvedClasses.size,
    };
  }
}
