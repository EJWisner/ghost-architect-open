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
import { streamChat } from '../analyst/index.js';
import { showCostEstimate, showActualCost } from '../estimator.js';
import { getConfig } from '../config.js';
import { saveReport } from '../reports.js';
import { hasShownCallout, markCalloutShown } from '../cli/session-state.js';
import { requireTier } from '../license/tier-gates.js';
import { isBackKeyword } from '../cli/prompt-helpers.js';

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
async function streamAnswerWithRetry(codebaseContext, userQuestion) {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await streamChat(codebaseContext, [], userQuestion);
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

  const result = await streamAnswerWithRetry(codebaseContext, trimmed);

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
  const saved = await saveReport(content, 'ghost-question', saveLabel);
  console.log(chalk.green(`\n✓ Reports saved to ~/Ghost Architect Reports/`));
  console.log(chalk.gray(`  📄 ${saved.txtFile}  (plain text)`));
  console.log(chalk.gray(`  📋 ${saved.mdFile}  (Markdown — open in VS Code or any Markdown viewer)`));
  if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
  console.log('');
}
