import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { getConfig, resolveApiKey } from '../config.js';
import { buildChatSystemPrompt, buildSystemPOI, SYSTEM_BLAST, buildSystemBlast } from '../../prompts/index.js';
import { createRequire } from 'module';
import { AUDIT_ROADMAP_SYSTEM, buildAuditRoadmapUserMessage } from '../../prompts/audit/v1.js';
import { narrateReport, narrateExecutiveSummary, scrubEmptyHeaders } from '../core/agent/narrator.js';
import { verifyReport } from '../core/verifier.js';
import { createLLMVerifier } from '../core/llm-verifier.js';
import { extractFindings as extractFindingsFromReport } from '../utils/finding-parser.js';
import { mergeRates } from '../profile/index.js';
import { getSamplingParams } from '../utils/sampling-params.js';

// Resolve the running version once (same package.json bin/ghost.js reads) so the
// chat system prompt can state accurate identity instead of the model guessing.
const _require = createRequire(import.meta.url);
const GHOST_VERSION = _require('../../package.json').version;

let client = null;

function getClient() {
  if (!client) {
    const apiKey = resolveApiKey();
    client = new Anthropic({ apiKey });
  }
  return client;
}

function getModel() {
  return getConfig().get('defaultModel') || 'claude-sonnet-4-6';
}

function getRates() {
  const cfg = getConfig();
  return { junior: cfg.get('rateJunior') || 85, mid: cfg.get('rateMid') || 125, senior: cfg.get('rateSenior') || 200 };
}

// ── Extract findings from raw POI/Blast text for narrator ─────────────────────

function extractFindings(rawText, _mode = 'poi') {
  // Use the shared finding parser — splits on '### ' headers, ignores
  // numbered fix-step bullets that the previous local regex was matching
  // as findings. See multipass.js for full context on why this matters.
  try {
    return extractFindingsFromReport(rawText);
  } catch {
    return [];
  }
}

// ── Chat ──────────────────────────────────────────────────────────────────────

// ── Question / Chat — request builder ──────────────────────────────────────────
//
// Factored out of streamChat so the streaming and batch (transport-menu) paths
// send byte-for-byte identical params. Returns { model, max_tokens, temperature,
// system, messages } — the codebase context is prepended to the first user
// message exactly as streamChat did inline.
export function buildQuestionRequest(codebaseContext, conversationHistory, userMessage, tier = 'open') {
  const messages = [...conversationHistory, { role: 'user', content: userMessage }];
  const contextualMessages = messages.map((msg, i) => {
    if (i === 0 && msg.role === 'user') {
      return { ...msg, content: `Here is the codebase to analyze:\n\n${codebaseContext.context}\n\n---\n\n${msg.content}` };
    }
    return msg;
  });
  return {
    model:       getModel(),
    max_tokens:  4096,
    ...getSamplingParams(0, getModel()),
    system:      buildChatSystemPrompt(GHOST_VERSION, tier),
    messages:    contextualMessages,
  };
}

export async function streamChat(codebaseContext, conversationHistory, userMessage, tier = 'open') {
  const anthropic = getClient();
  const req = buildQuestionRequest(codebaseContext, conversationHistory, userMessage, tier);

  process.stdout.write(chalk.cyan('\n👻 Ghost: '));
  let fullResponse = '';

  const stream = anthropic.messages.stream({
    model:       req.model,
    max_tokens:  req.max_tokens,
    temperature: req.temperature,
    system:      req.system,
    messages:    req.messages,
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      const text = chunk.delta.text;
      process.stdout.write(chalk.white(text));
      fullResponse += text;
    }
  }

  console.log('\n');

  // Capture usage from the SDK's final message. The answer already streamed
  // successfully by this point; if usage capture fails (network drop after
  // stream, malformed final message, SDK version mismatch), return null
  // tokens rather than block the response. Callers must handle null values
  // (skip cost display, not throw).
  let inputTokens = null;
  let outputTokens = null;
  try {
    const finalMsg = await stream.finalMessage();
    if (finalMsg?.usage) {
      inputTokens  = finalMsg.usage.input_tokens  ?? null;
      outputTokens = finalMsg.usage.output_tokens ?? null;
    }
  } catch (_) {
    // Usage capture failed. Answer was already delivered. Return null tokens.
  }

  return { text: fullResponse, inputTokens, outputTokens };
}

// ── POI Scan — single pass with narrator ─────────────────────────────────────

export async function runPOIScan(codebaseContext, onChunk, options = {}) {
  const anthropic = getClient();
  const rates     = mergeRates(getRates(), options.profile);

  // Step 1: Run scan silently — collect raw output
  // Temperature 0.3: reduces run-to-run variance so profile signal shows through.
  const profileReminder = options.profile
    ? `You are scanning on behalf of ${options.profile.author || 'the consultant'}. Apply their methodology as described in the CONSULTANT CONTEXT block of your system prompt — weight findings through their lens, name findings in their vocabulary, and organize the report around their priorities. Do not fabricate findings to match their priorities; apply them only where the code actually exhibits the pattern.\n\n`
    : '';
  const stream = anthropic.messages.stream({
    model: getModel(), max_tokens: 8096, ...getSamplingParams(0.3, getModel()), system: buildSystemPOI(rates, options.profile),
    messages: [{ role: 'user', content: `${profileReminder}Perform a full Points of Interest scan on this codebase:\n\n${codebaseContext.context}` }]
  });

  let rawOutput = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      rawOutput += chunk.delta.text;
    }
  }

  // Step 2: Narrator rewrites — streaming to user
  const findings = extractFindings(rawOutput, 'poi');

  if (findings.length === 0) {
    // No structured findings — stream raw output directly
    for (const char of rawOutput) onChunk(char);
    return rawOutput;
  }

  if (options.onNarratorStart) options.onNarratorStart();

  const memoryResult = {
    findings,
    findingCount:  findings.length,
    filesAnalyzed: codebaseContext.loadedFiles || 0,
    stepCount:     1,
    auditTrail:    [],
  };

  const narratedReport = await narrateReport(
    memoryResult,
    {
      projectLabel: options.projectLabel || 'project',
      mode: 'poi',
      rates,
      fileMap: options.fileMap || codebaseContext.fileMap,
      profile: options.profile,  // Ghost Partner — consultant lens for narrator voice
    },
    onChunk
  );

  let finalOutput = narratedReport || rawOutput;

  // Verifier — two-pass source-grounded check against fileMap.
  //   Pass 1: cheap regex check
  //   Pass 2: LLM semantic check
  if (options.fileMap || codebaseContext.fileMap) {
    try {
      if (options.onVerifierStart) options.onVerifierStart();
      const { annotatedReport, report: verifierCard } = await verifyReport(
        finalOutput,
        options.fileMap || codebaseContext.fileMap,
        { llmVerifier: createLLMVerifier() }
      );
      finalOutput = annotatedReport;
      if (options.onVerifierReport) options.onVerifierReport(verifierCard);
    } catch (err) {
      if (options.onVerifierReport) {
        options.onVerifierReport({ error: err.message, note: 'Verifier errored; report returned unverified.' });
      }
    }
  }

  // Final scrub — see synthesizeFinal() in multipass.js for full rationale.
  // Verifier removes false-positive findings without touching their parent
  // ## category headers. Scrub here to clean up empty sections.
  finalOutput = scrubEmptyHeaders(finalOutput);

  return finalOutput;
}

// ── Blast Radius — with narrator ──────────────────────────────────────────────
//
// `target` may be either:
//   - a string: a single file path, class name, or method name (legacy form)
//   - an array of strings: multiple file paths to analyze as a coordinated
//     change set. The prompt frames the analysis as "these files will be
//     modified together; show the combined blast radius and ONE rollback
//     plan that accounts for the coordinated change."
//
// The single-file form is preserved for the existing free-text workflow
// (typing a class name or method name). The change-set form is the new
// path that the picker UX uses when the user selects 2+ files.

// ── Blast Radius — request builder ─────────────────────────────────────────────
//
// Pulls the prompt/params construction OUT of runBlastRadius so the exact same
// request can be (a) streamed live, or (b) submitted to the Message Batches API
// and replayed later via processBlastRawOutput. Both paths MUST build the
// identical { model, max_tokens, system, messages } so batch output is
// indistinguishable from streaming output.
//
// Returns the request plus the derived targets / projectLabel / rates that
// post-processing needs, so a batch-retrieve (which has no codebaseContext)
// can persist them at submit time and reuse them at retrieve time.
export function buildBlastRequest(codebaseContext, target, options = {}) {
  const rates = mergeRates(getRates(), options.profile);

  // Normalize target into a consistent shape. We always work with an array
  // internally so the prompt branch is the same shape; we just decide the
  // framing based on length.
  const targets = Array.isArray(target)
    ? target.map(t => String(t).trim()).filter(Boolean)
    : [String(target || '').trim()].filter(Boolean);

  if (targets.length === 0) {
    throw new Error('Blast radius requires at least one target.');
  }

  const systemPrompt = buildSystemBlast(rates, options.profile);
  const profileReminder = options.profile
    ? `You are scanning on behalf of ${options.profile.author || 'the consultant'}. Apply their methodology as described in the CONSULTANT CONTEXT block of your system prompt — weight findings through their lens, name findings in their vocabulary, and organize the rollback plan around their priorities. Do not fabricate findings to match their priorities; apply them only where the code actually exhibits the pattern.\n\n`
    : '';

  const forecastPreamble = options.forecastMode
    ? `COMMIT FORECAST CONTEXT:\n` +
      `The files listed below as targets have NOT yet been committed. They represent ` +
      `proposed changes in the developer's working tree (or a folder of received files). ` +
      `The codebase context you receive already contains these proposed file versions — ` +
      `they have been overlaid on top of the production baseline.\n\n` +
      `Your job is to forecast: IF the developer commits and pushes these proposed changes ` +
      `right now, what is the blast radius? Frame every finding in terms of "if you push now" ` +
      `— not "if someone changes this someday." The developer is about to hit the push button. ` +
      `Tell them what breaks, what ripples, and what they must verify BEFORE they push.\n\n` +
      `Do NOT say "consider changing" or "you might want to" — say "if you push now, X breaks" ` +
      `or "pushing now will cause Y." The rollback plan is not theoretical; it is the literal ` +
      `steps the developer would need to execute immediately after a bad push.\n\n`
    : '';

  let userMessage;
  if (targets.length === 1) {
    userMessage = `${forecastPreamble}${profileReminder}Perform a blast radius analysis for: "${targets[0]}"\n\nCodebase:\n\n${codebaseContext.context}`;
  } else {
    const targetList = targets.map((t, i) => `  ${i + 1}. ${t}`).join('\n');
    userMessage =
      forecastPreamble +
      profileReminder +
      `Perform a blast radius analysis for the following coordinated change set ` +
      `(${targets.length} files that will be modified together as part of one engagement):\n\n` +
      targetList + '\n\n' +
      `IMPORTANT: Treat these files as a single coordinated change. Produce ONE unified ` +
      `blast radius report, not separate reports per file. The downstream impact map should ` +
      `show the COMBINED set of files, modules, and behaviors affected when ALL of these ` +
      `targets change together. Where dependencies overlap, call out the overlap explicitly ` +
      `("X depends on both A and B — touching either alone is risky; coordinating both ` +
      `lowers risk"). Produce ONE rollback plan that handles the coordinated change as a ` +
      `unit, not three separate plans. Where coordinating these changes reduces risk versus ` +
      `doing them separately, say so. Where coordinating compounds risk (e.g. all three ` +
      `touch the same shared dependency), call that out as a danger zone.\n\n` +
      `Codebase:\n\n${codebaseContext.context}`;
  }

  const projectLabel = targets.length === 1
    ? targets[0]
    : `change set of ${targets.length} files`;

  return {
    model:      getModel(),
    max_tokens: 8096,
    ...getSamplingParams(0, getModel()),
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userMessage }],
    targets,
    projectLabel,
    rates,
  };
}

// ── Blast Radius — post-stream processing ──────────────────────────────────────
//
// Takes the model's RAW completion text (whether it arrived via streaming or a
// retrieved batch) and runs the identical narrator/findings pipeline, streaming
// the narrated report through onChunk. Shared so batch-retrieve produces output
// indistinguishable from a live streaming run.
//
// Deliberately does NOT depend on codebaseContext — only on the small set of
// derived values (targets, projectLabel, rates, loadedFiles) that a
// batch-retrieve can persist at submit time and reload later.
export async function processBlastRawOutput(rawOutput, {
  targets,
  projectLabel,
  rates,
  profile = null,
  loadedFiles = 0,
  onChunk = () => {},
  onNarratorStart,
  onUsage,
} = {}) {
  const findings = extractFindings(rawOutput, 'blast');

  if (findings.length === 0) {
    for (const char of rawOutput) onChunk(char);
    return rawOutput;
  }

  if (onNarratorStart) onNarratorStart();

  const memoryResult = {
    findings,
    findingCount:  findings.length,
    filesAnalyzed: loadedFiles || 0,
    stepCount:     1,
    auditTrail:    [],
  };

  const label = projectLabel || (Array.isArray(targets) && targets.length === 1
    ? targets[0]
    : `change set of ${Array.isArray(targets) ? targets.length : 1} files`);

  const narratedReport = await narrateReport(
    memoryResult,
    {
      projectLabel: label,
      mode: 'blast',
      rates,
      profile,  // Ghost Partner — consultant voice for narrator
    },
    onChunk
  );

  // Narrator cost estimate — character-count approximation, not real API usage.
  // (Same rationale as the streaming path: narrateReport has no aggregated usage.)
  if (onUsage && narratedReport) {
    const narratorInputEst  = Math.ceil(rawOutput.length / 4);
    const narratorOutputEst = Math.ceil(narratedReport.length / 4);
    // @ghost-verified: the stage argument passed to onUsage in processBlastRawOutput is intentionally dropped -- stage is baked into each tracker lambda (scan/verify/narrate); the 4th arg is a no-op by design
    onUsage(narratorInputEst, narratorOutputEst, getModel(), 'narrate');
  }

  return narratedReport || rawOutput;
}

export async function runBlastRadius(codebaseContext, target, onChunk, options = {}) {
  const anthropic = getClient();

  // Build the request via the shared builder so the streaming and batch paths
  // are byte-for-byte identical in what they send to the model.
  const req = buildBlastRequest(codebaseContext, target, options);
  const { targets, projectLabel, rates } = req;

  // Step 1: Run blast scan silently (streaming transport).
  const stream = anthropic.messages.stream({
    model:      req.model,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    system:     req.system,
    messages:   req.messages,
  });

  let rawOutput = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      rawOutput += chunk.delta.text;
    }
  }

  // Capture real token usage from the blast scan call.
  if (options.onUsage) {
    try {
      const blastFinal = await stream.finalMessage();
      if (blastFinal?.usage) {
        options.onUsage(
          blastFinal.usage.input_tokens  ?? 0,
          blastFinal.usage.output_tokens ?? 0,
          getModel()
        );
      }
    } catch (_) {
      // Usage capture failed — response already delivered. Non-fatal.
    }
  }

  // Step 2: Narrator rewrites — streamed to the caller via onChunk. Shared with
  // the batch-retrieve path so both produce identical output.
  return processBlastRawOutput(rawOutput, {
    targets,
    projectLabel,
    rates,
    profile:        options.profile,
    loadedFiles:    codebaseContext.loadedFiles || 0,
    onChunk,
    onNarratorStart: options.onNarratorStart,
    onUsage:         options.onUsage,
  });
}

// ── Audit Mode — Modernization Roadmap synthesis ───────────────────────────────
//
// Single-shot synthesis call for Inheritance Audit Mode. Takes the
// outputs of the three deterministic analyzers (Stack Reality + Key-Person
// Risk + Dependency Map) and asks the model to produce two prose scenarios
// (stabilize-and-keep, rebuild scope) plus a recommendation and confidence.
//
// The model is instructed to return strict JSON. We parse it; on parse
// failure we return a structured error result the caller can render.
//
// Temperature is set low (0.2) for consistency across runs — we want
// similar inputs to produce similar narrative shape. The same scan
// shouldn't read differently on Tuesday vs Wednesday.
//
// No streaming — the JSON has to be parsed in one shot. The caller can
// show a spinner while this runs.

export async function runAuditSynthesis(analyzerOutputs, options = {}) {
  const anthropic = getClient();

  const userMessage = buildAuditRoadmapUserMessage(analyzerOutputs);

  let rawOutput = '';
  try {
    const response = await anthropic.messages.create({
      model: options.model || getModel(),
      max_tokens: 3000,
      ...getSamplingParams(0.2, options.model || getModel()),
      system: AUDIT_ROADMAP_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
    });

    // The Anthropic SDK returns content as an array of blocks. We want
    // the concatenated text from any text blocks.
    for (const block of response.content || []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        rawOutput += block.text;
      }
    }
  } catch (err) {
    return {
      _error: `LLM call failed: ${err.message}`,
      stabilizeAndKeep: {
        headline: 'Synthesis unavailable',
        narrative: `The modernization roadmap synthesis could not run: ${err.message}`,
        sequencedSteps: [],
      },
      rebuildScope: {
        headline: 'Synthesis unavailable',
        narrative: 'See above.',
        scopeRanges: [],
      },
      recommendation: 'needs-discovery',
      confidence: 'low',
      caveats: [`LLM call failed: ${err.message}`],
    };
  }

  // Attempt to parse JSON output. Tolerant to surrounding markdown fences
  // even though the system prompt forbids them.
  let parsed;
  try {
    const cleaned = rawOutput
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```\s*$/m, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      _error: `JSON parse failed: ${err.message}`,
      _rawOutput: rawOutput.slice(0, 500),
      stabilizeAndKeep: {
        headline: 'Synthesis returned non-JSON output',
        narrative: 'The model returned text that could not be parsed as JSON. Raw output preserved in _rawOutput for debugging.',
        sequencedSteps: [],
      },
      rebuildScope: {
        headline: 'Synthesis returned non-JSON output',
        narrative: 'See above.',
        scopeRanges: [],
      },
      recommendation: 'needs-discovery',
      confidence: 'low',
      caveats: ['Synthesis output was malformed.'],
    };
  }

  // Normalize the shape so downstream renderers can rely on all fields existing.
  return {
    stabilizeAndKeep: {
      headline: parsed.stabilizeAndKeep?.headline || 'No stabilization headline returned',
      narrative: parsed.stabilizeAndKeep?.narrative || '',
      sequencedSteps: Array.isArray(parsed.stabilizeAndKeep?.sequencedSteps) ? parsed.stabilizeAndKeep.sequencedSteps : [],
    },
    rebuildScope: {
      headline: parsed.rebuildScope?.headline || 'No rebuild headline returned',
      narrative: parsed.rebuildScope?.narrative || '',
      scopeRanges: Array.isArray(parsed.rebuildScope?.scopeRanges) ? parsed.rebuildScope.scopeRanges : [],
    },
    recommendation: parsed.recommendation || 'needs-discovery',
    confidence: parsed.confidence || 'low',
    caveats: Array.isArray(parsed.caveats) ? parsed.caveats : [],
  };
}
