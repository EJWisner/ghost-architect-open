/**
 * Ghost Architect — Agent Verifier
 * Phase 2 of Conflict Detection: takes flagged candidates and verifies
 * each one using a mini ReAct loop before surfacing in the report.
 * Eliminates false positives. Pure async — no Chalk, no Inquirer.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getConfig, resolveApiKey } from '../../config.js';
import { AgentMemory }              from './memory.js';
import { buildTools }               from './tools.js';
import { runMiniLoop }              from './loop.js';

function getClient() { return new Anthropic({ apiKey: resolveApiKey() }); }
function getModel()  { return getConfig().get('defaultModel') || 'claude-sonnet-4-5'; }

// ── Verdict types ─────────────────────────────────────────────────────────────

export const Verdict = {
  CONFIRMED:      'CONFIRMED',       // Definite conflict — include in report
  POSSIBLE:       'POSSIBLE',        // Likely conflict but needs human review
  FALSE_POSITIVE: 'FALSE_POSITIVE',  // Not actually a conflict — drop from report
  INSUFFICIENT:   'INSUFFICIENT',    // Not enough data to determine — surface with caveat
};

// ── Single conflict verification ──────────────────────────────────────────────

async function verifyOne(candidate, fileMap, callbacks = {}) {
  const { onVerifying, onVerified } = callbacks;

  if (onVerifying) onVerifying({ candidate });

  // Each verification gets its own mini memory and tools
  const memory = new AgentMemory();
  const tools  = buildTools(fileMap, memory);

  // Build a targeted verification task
  const task = `Verify whether this is a REAL conflict or a false positive.

CANDIDATE CONFLICT:
Type: ${candidate.type || 'unknown'}
Severity: ${candidate.severity || 'unknown'}
Files involved: ${(candidate.files || []).join(', ')}
Description: ${candidate.description || candidate.title || 'No description'}

YOUR JOB:
1. Use the tools to examine the files involved
2. Check: Are both sides actually active? Same scope/context? Correct sort order?
3. Look for conditions, guards, or scope limits that might prevent the conflict
4. Conclude with flagFinding (if CONFIRMED or POSSIBLE) then finish

Verification criteria:
- CONFIRMED: The conflict will definitely manifest in normal usage
- POSSIBLE: The conflict could manifest under certain conditions
- FALSE_POSITIVE: There is no real conflict (e.g., one side is disabled, different scope, correct sort order)

Flag the finding if CONFIRMED or POSSIBLE. Then call finish with your verdict in the summary.`;

  // Run mini loop — max 3 steps per conflict
  const result = await runMiniLoop(task, tools, memory, 3);

  // Determine verdict from what the agent did
  let verdict    = Verdict.INSUFFICIENT;
  let evidence   = '';
  let confidence = 50;

  if (result.findings.length > 0) {
    // Agent flagged a finding — it's confirmed or possible
    const finding = result.findings[0];
    confidence    = finding.confidence || 75;
    evidence      = finding.detail || '';
    verdict       = confidence >= 80 ? Verdict.CONFIRMED : Verdict.POSSIBLE;
  } else {
    // Agent didn't flag anything — check finish summary for verdict
    const finishAction = result.auditTrail?.find(a => a.action === 'finish');
    const summary      = finishAction?.result?.summary || finishAction?.resultSummary || '';

    if (/false.positive|not a conflict|no conflict|disabled|different scope/i.test(summary)) {
      verdict    = Verdict.FALSE_POSITIVE;
      evidence   = summary;
      confidence = 85;
    } else if (/confirmed|definitely|will break/i.test(summary)) {
      verdict    = Verdict.CONFIRMED;
      evidence   = summary;
      confidence = 80;
    } else if (/possible|might|could|may/i.test(summary)) {
      verdict    = Verdict.POSSIBLE;
      evidence   = summary;
      confidence = 60;
    } else {
      verdict    = Verdict.INSUFFICIENT;
      evidence   = summary || 'Verification inconclusive';
      confidence = 40;
    }
  }

  const verified = {
    ...candidate,
    verdict,
    evidence,
    confidence,
    stepsUsed:   result.stepCount,
    filesChecked: result.filesAnalyzed,
    auditTrail:  result.auditTrail,
  };

  if (onVerified) onVerified({ verified });

  return verified;
}

// ── Batch verification ────────────────────────────────────────────────────────
/**
 * Verify a batch of conflict candidates.
 * Runs verifications sequentially to avoid overwhelming the API.
 *
 * @param {array}   candidates  — array of { type, severity, files, description }
 * @param {object}  fileMap     — loaded file map
 * @param {object}  callbacks   — { onVerifying, onVerified, onProgress }
 * @returns {object}            — { confirmed, possible, falsePositives, insufficient, all }
 */
export async function verifyConflicts(candidates, fileMap, callbacks = {}) {
  const { onProgress } = callbacks;
  const results = [];

  for (let i = 0; i < candidates.length; i++) {
    if (onProgress) onProgress({ current: i + 1, total: candidates.length });

    const verified = await verifyOne(candidates[i], fileMap, callbacks);
    results.push(verified);
  }

  // Partition by verdict
  const confirmed      = results.filter(r => r.verdict === Verdict.CONFIRMED);
  const possible       = results.filter(r => r.verdict === Verdict.POSSIBLE);
  const falsePositives = results.filter(r => r.verdict === Verdict.FALSE_POSITIVE);
  const insufficient   = results.filter(r => r.verdict === Verdict.INSUFFICIENT);

  return {
    confirmed,
    possible,
    falsePositives,
    insufficient,
    all: results,
    stats: {
      total:         candidates.length,
      confirmed:     confirmed.length,
      possible:      possible.length,
      falsePositives: falsePositives.length,
      insufficient:  insufficient.length,
      eliminated:    falsePositives.length,
      surfaced:      confirmed.length + possible.length,
    },
  };
}

// ── Quick single-call verification (cheaper alternative) ─────────────────────
// For when you want to verify without a full agent loop — one Claude call

export async function quickVerify(candidate, fileMap) {
  const anthropic = getClient();

  // Get relevant file content (first 1000 chars each)
  const fileContents = (candidate.files || [])
    .filter(f => fileMap[f])
    .map(f => `=== ${f} ===\n${fileMap[f].slice(0, 1000)}`)
    .join('\n\n');

  if (!fileContents) {
    return {
      ...candidate,
      verdict:    Verdict.INSUFFICIENT,
      evidence:   'Files not available for verification',
      confidence: 0,
    };
  }

  const prompt = `Is this a real conflict or a false positive?

CONFLICT CANDIDATE:
${JSON.stringify(candidate, null, 2)}

RELEVANT FILE EXCERPTS:
${fileContents}

Respond with JSON only:
{
  "verdict": "CONFIRMED|POSSIBLE|FALSE_POSITIVE",
  "confidence": 0-100,
  "evidence": "one sentence explanation"
}`;

  try {
    const response = await anthropic.messages.create({
      model:      getModel(),
      max_tokens: 256,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw    = response.content[0]?.text || '{}';
    const clean  = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      ...candidate,
      verdict:    parsed.verdict    || Verdict.INSUFFICIENT,
      confidence: parsed.confidence || 50,
      evidence:   parsed.evidence   || '',
      method:     'quick',
    };
  } catch {
    return {
      ...candidate,
      verdict:    Verdict.INSUFFICIENT,
      evidence:   'Quick verification failed',
      confidence: 0,
      method:     'quick',
    };
  }
}
