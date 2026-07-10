import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';
import { streamChat } from '../analyst/index.js';
import { saveReport } from '../reports.js';
import { isBackKeyword } from '../cli/prompt-helpers.js';
import { requireTier } from '../license/tier-gates.js';
import { hasShownCallout, markCalloutShown } from '../cli/session-state.js';
import { calcActualCost } from '../estimator.js';
import { getConfig } from '../config.js';

const RETRY_DELAYS = [15, 30, 60];

async function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

function isRateLimit(err) {
  const msg = err.message || '';
  return err.status === 429 ||
    msg.includes('429') ||
    msg.includes('rate_limit') ||
    msg.includes('rate limit') ||
    msg.includes('tokens per minute');
}

function isOverload(err) {
  const msg = err.message || '';
  return err.status === 529 || msg.includes('529') || msg.includes('overloaded');
}

function friendlyError(err) {
  const msg = err.message || '';
  if (isRateLimit(err))    return 'API rate limit reached. The codebase context is large — please wait 60 seconds and try again.';
  if (isOverload(err))     return 'Anthropic\'s API is temporarily overloaded. Please try again in a moment.';
  if (msg.includes('401')) return 'API key issue — go to Reconfigure in the main menu and re-enter your Anthropic API key.';
  if (msg.includes('50'))  return 'Anthropic\'s API is temporarily unavailable. Please try again in a moment.';
  if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) return 'Network connection issue. Check your internet and try again.';
  return 'Something went wrong. Please try again.';
}

async function streamChatWithRetry(codebaseContext, conversationHistory, trimmed, tier) {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await streamChat(codebaseContext, conversationHistory, trimmed, tier);
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

/**
 * Print available chat-mode commands. Invoked via /help. Matches the
 * universal-escape pattern: slash-prefixed commands are the canonical form,
 * but bare-word `exit` and `save` are preserved for backward compatibility
 * with users who learned them before slash support landed.
 */
function printChatHelp() {
  console.log('\n' + boxen(
    chalk.cyan.bold('Chat commands') + '\n\n' +
    chalk.yellow('/help') + chalk.gray('         — show this list\n') +
    chalk.yellow('/save') + chalk.gray('         — save the conversation so far to ~/Ghost Architect Reports/\n') +
    chalk.yellow('/exit') + chalk.gray(' or ') + chalk.yellow('/quit') + chalk.gray(' — return to the main menu\n') +
    chalk.yellow('/back') + chalk.gray('         — same as /exit (return to main menu)\n\n') +
    chalk.gray('Bare-word ') + chalk.yellow('exit') + chalk.gray(', ') + chalk.yellow('quit') + chalk.gray(', and ') + chalk.yellow('save') + chalk.gray(' also work (backward compat).'),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));
}

export async function runChatMode(codebaseContext, options = {}) {
  // Tier resolution. Defaults to 'open' (fail-closed) so any caller that
  // forgets to pass tier does not leak the paid project-tracking feature.
  // bin/ghost.js is the single source of truth — it passes TIER (resolved
  // from active license at line 1311) into this options object. Mirrors
  // the Phase 2 adoption pattern from commits 2d813bb, 5cfe7db, b38c0cb.
  // Chat itself is free across all tiers (TIER_POLICY 'mode:chat' is true
  // for all tiers); tier is plumbed through to saveChatLog where the only
  // tier-conditional surface lives (the project-label prompt on /save).
  const tier = options.tier || 'open';
  // Ghost Partner — consultant profile (null when --profile was not passed).
  // Threaded into saveChatLog -> saveReport meta so the client-ready PDF
  // carries the same white-label branding poi/blast/conflict/audit produce.
  const profile = options.profile || null;
  // Chat is the most expensive mode per turn (full codebase context is
  // re-prepended and the whole conversation history is resent every turn), yet
  // it previously showed no cost. Resolve the model for cost math. The caller
  // (bin/ghost.js) does not currently pass a model into this mode's options, so
  // fall back to the same default model the rest of the app uses (see
  // question.js). Do NOT reach into bin/ghost.js to add one.
  const model = options.model || getConfig().get('defaultModel') || 'claude-sonnet-4-6';

  console.log('\n' + boxen(
    chalk.cyan.bold('💬 CHAT MODE') + '\n\n' +
    chalk.gray(`${codebaseContext.loadedFiles} files processed\n`) +
    chalk.gray('Ask anything about this project in plain English.\n\n') +
    chalk.yellow('/save') + chalk.gray('  — save this conversation to ~/Ghost Architect Reports/\n') +
    chalk.yellow('/exit') + chalk.gray('  — return to main menu  ') + chalk.gray('(') + chalk.yellow('/help') + chalk.gray(' for all commands)'),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));

  const conversationHistory = [];
  const chatLog = [];
  let alreadySaved = false;
  // Running API spend across this chat session. streamChat() returns the real
  // token counts per turn; we accumulate and surface them so the cost of a
  // long conversation is never invisible.
  let sessionCost = 0;

  while (true) {
    const { userInput } = await inquirer.prompt([{
      type: 'input',
      name: 'userInput',
      message: chalk.yellow('You:'),
      prefix: ''
    }]);

    const trimmed = userInput.trim();
    if (!trimmed) continue;

    const cmd = trimmed.toLowerCase();

    // Universal-escape: slash-prefixed commands are canonical, bare-word
    // exit/quit/save preserved for muscle-memory backward compat.
    if (cmd === '/help') {
      printChatHelp();
      continue;
    }

    // Exit — return to main menu (selectMode level, codebase still loaded).
    if (cmd === 'exit' || cmd === 'quit' || cmd === '/exit' || cmd === '/quit' || cmd === '/back') {
      console.log(chalk.gray('\nReturning to main menu...\n'));
      break;
    }

    // Save — save the conversation so far. /save is the canonical form;
    // bare 'save' is backward compat.
    if (cmd === 'save' || cmd === '/save') {
      if (chatLog.length === 0) {
        console.log(chalk.gray('\n  Nothing to save yet — ask some questions first.\n'));
        continue;
      }
      // saveChatLog returns false if user cancels at the label prompt via
      // 'back' keyword. Only set alreadySaved when the save actually completed.
      const saved = await saveChatLog(chatLog, tier, profile);
      if (saved !== false) alreadySaved = true;
      continue;
    }

    const result = await streamChatWithRetry(codebaseContext, conversationHistory, trimmed, tier);

    if (result) {
      const response = result.text;
      if (conversationHistory.length === 0) {
        conversationHistory.push({
          role: 'user',
          content: `Here is the codebase to analyze:\n\n${codebaseContext.context}\n\n---\n\n${trimmed}`
        });
      } else {
        conversationHistory.push({ role: 'user', content: trimmed });
      }
      conversationHistory.push({ role: 'assistant', content: response });
      chatLog.push({ q: trimmed, a: response });

      // Per-exchange and running-session cost. Graceful degradation: if the
      // SDK did not surface usage (null token counts) skip the line silently —
      // the answer already printed and nothing should break over telemetry.
      if (result.inputTokens != null && result.outputTokens != null) {
        const { totalCost } = calcActualCost(result.inputTokens, result.outputTokens, model);
        sessionCost += totalCost;
        console.log(
          chalk.gray('  ─ this exchange: ') +
          chalk.gray(result.inputTokens.toLocaleString() + ' in / ' + result.outputTokens.toLocaleString() + ' out  ') +
          chalk.green('$' + totalCost.toFixed(4)) +
          chalk.gray('  │  session total: ') +
          chalk.green('$' + sessionCost.toFixed(4)) +
          '\n'
        );
      }
    }
  }

  // Offer to save on exit
  if (chatLog.length > 0 && !alreadySaved) {
    const { saveOnExit } = await inquirer.prompt([{
      type: 'confirm',
      name: 'saveOnExit',
      message: chalk.cyan(`Save this conversation (${chatLog.length} exchanges) to ~/Ghost Architect Reports/?`),
      default: true
    }]);
    if (saveOnExit) await saveChatLog(chatLog, tier, profile);
  }
}

async function saveChatLog(chatLog, tier, profile = null) {
  // D4 gate: project-tracking is Pro+ only. Drives both the label prompt
  // below AND the saveLabel fallback at the saveReport call site (the
  // 'conversation' synthetic fallback would otherwise re-leak the four
  // side-effect blocks even after gating the label prompt — identical
  // shape to blast's saveLabel-fallback fix in commit b38c0cb). Gate ID
  // is shared with prompt-triage/conflict/blast so D3 callout
  // suppression spans all four modes (one display per ghost invocation).
  const projectIntelGate = requireTier('feature:project-tracking', { tier });
  const projectIntelEnabled = projectIntelGate.allowed;

  // On Pro+: prompt for label, with 'back' keyword preserved as a save-
  // cancel escape. On Open: skip the prompt entirely (D4 gate firing)
  // and fire the D3 soft-gate callout once per session. The 'back'
  // keyword cancellation becomes Pro+ only by natural extension — Open
  // users see no prompt, so there is nothing to cancel; if they want to
  // abort a save on Open, they can just not type /save in the first
  // place. Open users still get the saved conversation (with bare
  // filename per the saveLabel = null branch below).
  let label = null;
  if (projectIntelEnabled) {
    const promptResult = await inquirer.prompt([{
      type: 'input',
      name: 'label',
      message: chalk.cyan('Chat label') + chalk.gray(" (project name, press Enter to skip, or 'back' to cancel save):"),
    }]);

    // Universal-escape: 'back' keyword cancels the save. Caller catches this
    // by checking the return value — returns false on cancel, true on saved.
    // The current call sites just await this without checking, which is fine:
    // on cancel we print a notice and return; the chat loop continues either
    // way and any "already saved" flag stays false so the exit-prompt will
    // re-offer save.
    if (isBackKeyword(promptResult.label)) {
      console.log(chalk.gray('\n  Save cancelled.\n'));
      return false;
    }
    label = promptResult.label;
  } else if (!hasShownCallout('feature:project-tracking')) {
    // D3 soft-gate callout: one line, once per session, gentle. Open users
    // still get the saved conversation — this just signals what they'd
    // gain on Pro. Shared gate ID coalesces with prompt-triage, conflict,
    // and blast so the callout displays once per ghost invocation across
    // all four modes.
    console.log(chalk.cyan('💡 Project tracking available on Pro. Scans run as one-shots on Open.'));
    markCalloutShown('feature:project-tracking');
  }

  const timestamp = new Date().toLocaleString();
  let content = `GHOST ARCHITECT — CHAT TRANSCRIPT\n`;
  content += `Saved: ${timestamp}\n`;
  content += `Exchanges: ${chatLog.length}\n`;
  // ASCII '-' instead of U+2500 box-drawing character because PDFKit's bundled
  // font has no glyph for U+2500 and substitutes '%' for every cell, rendering
  // '──────' as '%%%%%%' in saved PDFs. Fix originally in Open `891b440`.
  const sep = '-'.repeat(60);
  content += `${sep}\n\n`;

  chatLog.forEach((entry, i) => {
    content += `Q${i + 1}: ${entry.q}\n\n`;
    content += `Ghost: ${entry.a}\n\n`;
    content += `${sep}\n\n`;
  });

  // saveLabel resolution: on Pro+, fall back to 'conversation' if the user
  // skipped the label prompt (preserves existing UX for paid tiers). On
  // Open, saveLabel stays null so the four `if (label && isXConfigured())`
  // side-effect blocks in saveReport (team-sync, mobile-publish, portal-
  // publish, audit log) short-circuit. Same fix shape as blast commit
  // b38c0cb. The 'conversation' fallback is a UX nicety for paid tiers,
  // not a freshness mechanism that should override D4.
  const saveLabel = projectIntelEnabled ? (label || 'conversation') : null;
  // Ghost Partner profile drives white-label PDF/MD branding; null falls back
  // to default Ghost branding in the renderers.
  const saved = await saveReport(content, 'ghost-chat', saveLabel, { profile });
  console.log(chalk.green(`\n✓ Reports saved to ~/Ghost Architect Reports/`));
  console.log(chalk.gray(`  📄 ${saved.txtFile}  (plain text)`));
  console.log(chalk.gray(`  📋 ${saved.mdFile}  (Markdown — open in VS Code or any Markdown viewer)`));
  if (saved.pdfFile) console.log(chalk.cyan(`  📑 ${saved.pdfFile}  ← client-ready PDF`));
  console.log('');
}
