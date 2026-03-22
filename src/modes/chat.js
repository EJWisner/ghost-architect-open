import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';
import { streamChat } from '../analyst/index.js';
import { saveReport } from '../reports.js';

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

async function streamChatWithRetry(codebaseContext, conversationHistory, trimmed) {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await streamChat(codebaseContext, conversationHistory, trimmed);
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

export async function runChatMode(codebaseContext) {
  console.log('\n' + boxen(
    chalk.cyan.bold('💬 CHAT MODE') + '\n\n' +
    chalk.gray(`${codebaseContext.loadedFiles} files processed\n`) +
    chalk.gray('Ask anything about this project in plain English.\n\n') +
    chalk.yellow('save') + chalk.gray('  — save this conversation to ~/Ghost Architect Reports/\n') +
    chalk.yellow('exit') + chalk.gray('  — return to main menu'),
    { padding: 1, borderColor: 'cyan', borderStyle: 'round' }
  ));

  const conversationHistory = [];
  const chatLog = [];
  let alreadySaved = false;

  while (true) {
    const { userInput } = await inquirer.prompt([{
      type: 'input',
      name: 'userInput',
      message: chalk.yellow('You:'),
      prefix: ''
    }]);

    const trimmed = userInput.trim();
    if (!trimmed) continue;

    // Exit
    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      console.log(chalk.gray('\nReturning to main menu...\n'));
      break;
    }

    // Save
    if (trimmed.toLowerCase() === 'save') {
      if (chatLog.length === 0) {
        console.log(chalk.gray('\n  Nothing to save yet — ask some questions first.\n'));
        continue;
      }
      await saveChatLog(chatLog);
      alreadySaved = true;
      continue;
    }

    const response = await streamChatWithRetry(codebaseContext, conversationHistory, trimmed);

    if (response) {
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
    if (saveOnExit) await saveChatLog(chatLog);
  }
}

async function saveChatLog(chatLog) {
  const { label } = await inquirer.prompt([{
    type: 'input',
    name: 'label',
    message: chalk.cyan('Chat label') + chalk.gray(' (project name, press Enter to skip):'),
  }]);

  const timestamp = new Date().toLocaleString();
  let content = `GHOST ARCHITECT — CHAT TRANSCRIPT\n`;
  content += `Saved: ${timestamp}\n`;
  content += `Exchanges: ${chatLog.length}\n`;
  content += `${'─'.repeat(60)}\n\n`;

  chatLog.forEach((entry, i) => {
    content += `Q${i + 1}: ${entry.q}\n\n`;
    content += `Ghost: ${entry.a}\n\n`;
    content += `${'─'.repeat(60)}\n\n`;
  });

  const saved = await saveReport(content, 'ghost-chat', label || 'conversation');
  console.log(chalk.green(`\n✓ Reports saved to ~/Ghost Architect Reports/`));
  console.log(chalk.gray(`  📄 ${saved.txtFile}  (plain text)`));
  console.log(chalk.gray(`  📋 ${saved.mdFile}  (Markdown — open in VS Code or any Markdown viewer)\n`));
}
