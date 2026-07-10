/**
 * Ghost Architect — Question mode
 *
 * Single-turn Q&A entry point. Open-tier inclusive (mode:question is true
 * for all tiers in src/license/tier-gates.js). User asks one question,
 * gets one answer streamed back from Claude, then chooses whether to save
 * the Q&A transcript. After the save decision (yes or no), returns to the
 * main menu.
 *
 * Design contract — vocabulary discipline:
 *   Open users reach this mode without ever needing to know that the
 *   underlying machinery shares code with the Pro+ multi-turn Chat mode.
 *   No user-visible string in this file mentions "chat" — the surface is
 *   self-contained around the "Question / Answer" framing. Pro+ users
 *   who see both Question and Chat in their menu get the natural product
 *   distinction; Open users get a coherent single-product flow.
 *
 * Differs from src/modes/chat.js by:
 *   - Single iteration (no while-loop, no slash commands, no exit semantics)
 *   - Always offers save after the answer (rather than save-on-/save-command)
 *   - Optional project-label prompt on Pro+ tier (Open users skip, no
 *     prompt at all — gated via requireTier('feature:project-tracking'))
 *   - Optional D3 callout pointing Pro users toward follow-up support
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { streamChat, buildQuestionRequest } from '../analyst/index.js';
import { showCostEstimate, showActualCost } from '../estimator.js';
import { getConfig, resolveApiKey } from '../config.js';
import { saveReport } from '../reports.js';
import { hasShownCallout, markCalloutShown } from '../cli/session-state.js';
import { requireTier } from '../license/tier-gates.js';
import { isBackKeyword } from '../cli/prompt-helpers.js';
import { resolveTransport } from '../lib/transport-menu.js';
import { buildStreamingTransport, buildBatchTransport } from '../lib/transport-meta.js';
import { addPendingBatch } from '../lib/batch-store.js';
import { deriveRepoName, submitBatchInteractive, formatBatchLabelDate } from '../lib/batch-submit.js';

const RETRY_DELAYS = [10, 30];

async function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

function isRateLimit(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  return msg.includes('rate limit') || msg.includes('429') ||
         (err.status === 429);
}

function isOverload(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  return msg.includes('overload') || (err.status === 529);
}

function friendlyError(err) {
  if (!err) return 'Unknown error.';
  if (isRateLimit(err)) return 'Rate limit reached. Try again in a minute.';
  if (isOverload(err)) return 'Model temporarily overloaded. Try again in a moment.';
  return err.message || String(err);
}

// Inline retry wrapper. Same shape as src/modes/chat.js's streamChatWithRetry
// but kept local here for low coupling (Question mode is intentionally
// self-contained). Returns the streamChat result object
// { text, inputTokens, outputTokens } on success, null on terminal error.
// A future post-v7-GA refactor can promote this to a shared helper;
// see TODO-promote-llm-retry-wrapper-shared.md.
async function streamAnswerWithRetry(codebaseContext, userQuestion, tier) {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await streamChat(codebaseContext, [], userQuestion, tier);
    } catch (err) {
      const isLast = attempt === RETRY_DELAYS.length;
      if (isRateLimit(err) || isOverload(err)) {
        if (isLast) {
          console.log('\n' + chalk.yellow(`  ⚠  ${friendlyError(err)}\n`));
          return null;
        }
        const wait = RETRY_DELAYS[attempt];
        process.stdout.write(chalk.gray(`\n  ⏳ Rate limit — waiting ${wait}s and retrying...`));
        await sleep(wait);
        process.stdout.write(chalk.gray(' retrying.\n\n'));
        continue;
      }
      console.log('\n' + chalk.yellow(`  ⚠  ${friendlyError(err)}\n`));
      return null;
    }
  }
}

export async function runQuestionMode(codebaseContext, options = {}) {
  // Tier resolution. Defaults to 'open' (fail-closed). Tier is plumbed
  // through purely for the D3 callout decision (Pro users don't need the
  // upsell); no other tier-conditional surface exists in this mode.
  const tier = options.tier || 'open';
  // Ghost Partner — consultant profile (null when --profile was not passed).
  // Threaded into saveReport's meta so the client-ready PDF carries the same
  // white-label branding that poi/blast/conflict/audit produce. Without this,
  // the PDF advertised below as "client-ready" rendered with default Ghost
  // branding only.
  const profile = options.profile || null;

  console.log('\n' + boxen(
    chalk.cyan.bold('❓ ASK A QUESTION') + '\n\n' +
    chalk.gray(`${codebaseContext.loadedFiles} files processed\n`) +
    chalk.gray('Ask one question about this project. Save the answer when done.'),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));

  const { userQuestion } = await inquirer.prompt([{
    type: 'input',
    name: 'userQuestion',
    message: chalk.yellow("What's your question?"),
    prefix: ''
  }]);

  const trimmed = userQuestion.trim();
  if (!trimmed) {
    console.log(chalk.gray('\n  No question entered. Returning to menu.\n'));
    return;
  }

  // Cost estimate + proceed-confirm. Matches the contract documented in
  // README ("Ghost shows a cost estimate before every scan and the actual
  // cost after. No surprises.") that other modes (POI, Blast, Conflict,
  // Audit) honor via showCostEstimate() + a Proceed gate. Mode-id is
  // 'question' (not 'chat') to preserve the vocabulary discipline
  // documented in this file's header — see MODE_OUTPUT_ESTIMATES in
  // src/core/estimator.js for the matching entry.
  const model = getConfig().get('defaultModel') || 'claude-sonnet-4-6';
  showCostEstimate(codebaseContext, 'question', model);

  const { proceed } = await inquirer.prompt([{
    type: 'confirm', name: 'proceed',
    message: chalk.cyan('Proceed?'), default: true
  }]);
  if (!proceed) {
    console.log(chalk.gray('\n  Cancelled. Returning to menu.\n'));
    return;
  }

  // ── Transport selection (streaming vs batch) ──────────────────────────────
  // Mirrors blast.js: after the proceed confirm, before the API call. --stream/
  // --batch, CI, and Ghost Watcher skip the menu. Batch submits and exits; the
  // user retrieves later via `ghost batch-retrieve <id>`. Streaming falls
  // through to the live answer below.
  const transport = await resolveTransport({
    flags:     options.flags || {},
    mode:      'question',
    modeLabel: 'Question',
    codebaseContext,
    model,
  });

  if (transport === 'batch') {
    await submitQuestionBatch({ codebaseContext, question: trimmed, tier, profile });
    return;
  }

  const result = await streamAnswerWithRetry(codebaseContext, trimmed, tier);

  // Trailing newline after the streamed answer for visual separation.
  console.log('\n');

  if (!result) {
    // streamAnswerWithRetry already printed the friendly error message.
    return;
  }

  const answer = result.text;

  // Actual cost after the LLM call. Completes the README contract
  // ("Ghost shows a cost estimate before every scan and the actual cost
  // after. No surprises.") for Question mode. Graceful degradation: if
  // the SDK failed to surface usage data (null inputTokens or
  // outputTokens), skip the display silently. The user got their answer;
  // session cost summary at exit will be missing this run's spend but
  // nothing breaks.
  if (result.inputTokens != null && result.outputTokens != null) {
    showActualCost(result.inputTokens, result.outputTokens, model);
  }

  // D3 soft-gate callout: only fires for tiers that would benefit from the
  // upsell (Open). Pro+ users picked Question deliberately while having
  // Chat available, so the upsell is irrelevant and noisy for them.
  // Throttled once per session via the shared markCalloutShown registry —
  // gate ID is unique to this mode so it doesn't compete with the existing
  // 'feature:project-tracking' callout used by other modes.
  if (tier === 'open' && !hasShownCallout('feature:multi-turn-conversation')) {
    console.log(chalk.cyan('💡 Pro tier supports follow-up questions in the same conversation.'));
    console.log('');
    markCalloutShown('feature:multi-turn-conversation');
  }

  const { saveAnswer } = await inquirer.prompt([{
    type: 'confirm',
    name: 'saveAnswer',
    message: chalk.cyan('Save the answer to ~/Ghost Architect Reports/?'),
    default: true
  }]);

  if (!saveAnswer) {
    console.log(chalk.gray('\n  Answer not saved. Returning to menu.\n'));
    return;
  }

  // Optional project-label prompt. Mirrors src/modes/chat.js's saveChatLog
  // pattern. D4 gate: feature:project-tracking is Pro+ only. On Pro+, the
  // prompt fires and accepts a label, 'back' for cancel, or Enter to skip.
  // On Open, no prompt at all (the D3 callout above already signals the
  // Pro upsell for multi-turn; the project-label tracking pitch lives on
  // the heavier modes' callouts and isn't worth re-displaying here —
  // intentionally keeping Question's Open flow lean per file-header
  // design contract).
  //
  // saveLabel resolution mirrors chat.js exactly: Pro+ falls back to
  // 'question' if user skipped (preserves UX nicety — bare-prefix save
  // would otherwise produce filenames like 'ghost-question-2026-...md'
  // and portal entries of 'question' rather than '(untitled)'); Open
  // stays null so label-gated side-effect blocks (team-sync,
  // mobile-publish, audit-log) in saveReport short-circuit. Portal-
  // publish is NOT label-gated post-Cycle-5 commit f481398 — it fires
  // whenever portal is configured, and a labeled Question save lands as
  // the project name instead of the '(untitled)' fallback that
  // buildManifestEntry would otherwise apply.
  const projectIntelGate = requireTier('feature:project-tracking', { tier });
  let label = null;
  if (projectIntelGate.allowed) {
    const promptResult = await inquirer.prompt([{
      type: 'input',
      name: 'label',
      message: chalk.cyan('Project label') + chalk.gray(" (publishes to your portal under this name; press Enter to skip, or 'back' to cancel save):"),
    }]);
    if (isBackKeyword(promptResult.label)) {
      console.log(chalk.gray('\n  Save cancelled.\n'));
      return;
    }
    label = promptResult.label;
  }

  // Build transcript content. Vocabulary discipline: header reads "QUESTION
  // AND ANSWER" not "chat transcript". Uses the same ASCII separator that
  // chat.js uses (PDFKit-safe — U+2500 box-drawing characters render as
  // '%' in saved PDFs because PDFKit's bundled font lacks the glyph).
  const timestamp = new Date().toLocaleString();
  const sep = '-'.repeat(60);
  let content = `GHOST ARCHITECT — QUESTION AND ANSWER\n`;
  content += `Saved: ${timestamp}\n`;
  content += `${sep}\n\n`;
  content += `Question: ${trimmed}\n\n`;
  content += `Answer: ${answer}\n\n`;
  content += `${sep}\n`;

  // saveLabel resolution: Pro+ gets 'question' fallback for UX nicety,
  // Open stays null so label-gated side-effects (team-sync, mobile-
  // publish, audit-log) short-circuit. Same D4 invariant shape as
  // chat.js's saveLabel ternary.
  const saveLabel = projectIntelGate.allowed ? (label || 'question') : null;
  // Transport metadata — this answer was produced live (streaming). Stamped into
  // findings.json and the report footer. See src/lib/transport-meta.js.
  const saved = await saveReport(content, 'ghost-question', saveLabel, { transport: buildStreamingTransport(), profile });
  console.log(chalk.green(`\n✓ Reports saved to ~/Ghost Architect Reports/`));
  console.log(chalk.gray(`  📄 ${saved.txtFile}  (plain text)`));
  console.log(chalk.gray(`  📋 ${saved.mdFile}  (Markdown — open in VS Code or any Markdown viewer)`));
  if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
  console.log('');
}

// ── Batch transport: submit ─────────────────────────────────────────────────
//
// Build the exact same chat request the streaming path sends (buildQuestionRequest)
// and submit it to the Message Batches API via submitBatchInteractive. Persist a
// pending-batch record in the local configstore (the question text + resolved
// save label are all a later `ghost batch-retrieve` needs to reproduce the saved
// transcript), print the retrieval instructions, and return — no polling.
//
// Save-label note: the streaming flow prompts for a project label AFTER the
// answer. Batch has no answer yet at submit time, so we resolve the same default
// the streaming path would use when the user skips the label prompt: 'question'
// on Pro+ (project-tracking), null on Open. A future enhancement could prompt
// for the label up front in the batch path.
async function submitQuestionBatch({ codebaseContext, question, tier, profile = null }) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.log(chalk.red('\n  ✗ No Anthropic API key configured — cannot submit a batch.'));
    console.log(chalk.gray('  Set ANTHROPIC_API_KEY or run `ghost` once to configure your key.\n'));
    return;
  }

  const req = buildQuestionRequest(codebaseContext, [], question, tier);

  const submittedAt = new Date().toISOString();
  const customId = `question-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  const requests = [{
    custom_id: customId,
    params: {
      model:       req.model,
      max_tokens:  req.max_tokens,
      temperature: req.temperature,
      system:      req.system,
      messages:    req.messages,
    },
  }];

  const spinner = ora({ text: chalk.gray('Submitting batch to Anthropic...'), color: 'cyan' }).start();
  let batchId;
  try {
    batchId = await submitBatchInteractive(apiKey, requests);
    spinner.succeed(chalk.green('Batch submitted'));
  } catch (err) {
    spinner.fail(chalk.red('Batch submission failed'));
    console.log(chalk.yellow(`  ${friendlyError(err)}\n`));
    return;
  }

  const derivedRepo = deriveRepoName(codebaseContext);
  const repo = derivedRepo ? derivedRepo.name : 'unknown-project';
  const projectIntelEnabled = requireTier('feature:project-tracking', { tier }).allowed;
  const saveLabel = projectIntelEnabled ? 'question' : null;

  try {
    addPendingBatch({
      id:          batchId,
      mode:        'question',
      repo,
      label:       `Question — ${repo} — ${formatBatchLabelDate(submittedAt)}`,
      submittedAt,
      status:      'pending',
      customId,
      // Persist the active profile so the deferred batch-retrieve save can
      // reproduce the same white-label PDF branding the streaming path applies.
      context: { question, saveLabel, profile },
    });
  } catch (err) {
    console.log(chalk.yellow(`\n  ⚠  Could not record the pending batch locally (${err.message}).`));
    console.log(chalk.yellow(`     Save this batch id to retrieve it later: ${batchId}\n`));
  }

  console.log('');
  console.log(chalk.green(`✓ Batch submitted — ID: ${batchId}`));
  console.log(chalk.gray('  Check status:        ') + chalk.cyan('ghost batch-status'));
  console.log(chalk.gray('  Retrieve when ready: ') + chalk.cyan(`ghost batch-retrieve ${batchId}`));
  console.log(chalk.gray('  Estimated ready: ~15 minutes'));
  console.log('');
}

// ── Batch transport: retrieve replay ────────────────────────────────────────
//
// Given the model's answer text from a retrieved batch plus the stored
// pending-batch entry, rebuild the same Q&A transcript the streaming path saves
// and saveReport it. The only difference from a live run is the transport
// metadata block (method: 'batch'). Called by `ghost batch-retrieve`.
//
// Returns { saved }.
export async function retrieveQuestionBatchResult(answerText, entry) {
  const ctx = (entry && entry.context) || {};
  const question = ctx.question || '(question unavailable)';
  const saveLabel = ctx.saveLabel || null;
  // White-label profile persisted at submit time (null for non-profile runs
  // and for legacy pending-batch records written before profile was stored).
  const profile = ctx.profile || null;

  // Same transcript shape the streaming save block builds.
  const timestamp = new Date().toLocaleString();
  const sep = '-'.repeat(60);
  let content = `GHOST ARCHITECT — QUESTION AND ANSWER\n`;
  content += `Saved: ${timestamp}\n`;
  content += `${sep}\n\n`;
  content += `Question: ${question}\n\n`;
  content += `Answer: ${answerText}\n\n`;
  content += `${sep}\n`;

  const meta = { transport: buildBatchTransport({ submittedAt: entry && entry.submittedAt }), profile };
  const saved = await saveReport(content, 'ghost-question', saveLabel, meta);
  return { saved };
}
