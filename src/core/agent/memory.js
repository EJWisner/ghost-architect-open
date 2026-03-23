/**
 * Ghost Architect — Agent Memory
 * Intra-session state for the ReAct loop.
 * Tracks files read, decisions made, findings confirmed, and full action trace.
 * Pure data structure — no Chalk, no Inquirer, no console output.
 */

export class AgentMemory {
  constructor(options = {}) {
    this.filesRead       = new Map();  // path → content or summary (LRU capped)
    this.actionsHistory  = [];         // ReAct trace (trimmed periodically)
    this.findings        = [];         // confirmed findings from flagFinding()
    this.resolvedClasses = new Map();  // className → file path
    this.searchResults   = new Map();  // query → results array
    this.startedAt       = new Date().toISOString();
    this.stepCount       = 0;

    // LRU caps — prevent memory exhaustion on large codebases
    this.maxCachedFiles  = options.maxCachedFiles  || 50;   // ~2.5MB at 50KB avg
    this.maxHistorySize  = options.maxHistorySize  || 50;   // keep last 50 actions
    this.maxSearchCache  = options.maxSearchCache  || 20;   // keep last 20 searches
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

    // Trim history — keep last N actions to prevent unbounded growth
    if (this.actionsHistory.length > this.maxHistorySize) {
      this.actionsHistory = this.actionsHistory.slice(-this.maxHistorySize);
    }

    // Side-effect caching by action type — with LRU eviction
    if ((action === 'readFile' || action === 'summarizeFile') && input?.path) {
      this.filesRead.set(input.path, result);
      // LRU eviction — remove oldest entry when cap exceeded
      if (this.filesRead.size > this.maxCachedFiles) {
        const oldestKey = this.filesRead.keys().next().value;
        this.filesRead.delete(oldestKey);
      }
    }
    if (action === 'resolveClass' && input?.className && result?.path) {
      this.resolvedClasses.set(input.className, result.path);
    }
    if (action === 'searchFiles' && input?.query) {
      this.searchResults.set(input.query, result);
      // Cap search cache
      if (this.searchResults.size > this.maxSearchCache) {
        const oldestKey = this.searchResults.keys().next().value;
        this.searchResults.delete(oldestKey);
      }
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
    // Approximate heap usage for this memory instance
    const approxHeapMB = Math.round(
      (this.filesRead.size * 50 + this.actionsHistory.length * 2) / 1024
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
      approxHeapMB,
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
