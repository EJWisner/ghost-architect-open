import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { getConfig, resolveApiKey } from '../config.js';
import { SYSTEM_CHAT, buildSystemPOI, SYSTEM_BLAST } from '../../prompts/index.js';

let client = null;

function getClient() {
  if (!client) {
    const apiKey = resolveApiKey();
    client = new Anthropic({ apiKey });
  }
  return client;
}

function getModel() {
  return getConfig().get('defaultModel') || 'claude-sonnet-4-5';
}

export async function streamChat(codebaseContext, conversationHistory, userMessage) {
  const anthropic = getClient();
  const messages = [...conversationHistory, { role: 'user', content: userMessage }];

  const contextualMessages = messages.map((msg, i) => {
    if (i === 0 && msg.role === 'user') {
      return {
        ...msg,
        content: `Here is the codebase to analyze:\n\n${codebaseContext.context}\n\n---\n\n${msg.content}`
      };
    }
    return msg;
  });

  process.stdout.write(chalk.cyan('\n👻 Ghost: '));
  let fullResponse = '';

  const stream = anthropic.messages.stream({
    model: getModel(),
    max_tokens: 4096,
    system: SYSTEM_CHAT,
    messages: contextualMessages
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      const text = chunk.delta.text;
      process.stdout.write(chalk.white(text));
      fullResponse += text;
    }
  }

  console.log('\n');
  return fullResponse;
}

export async function runPOIScan(codebaseContext, onChunk) {
  const anthropic = getClient();
  const cfg = getConfig();
  const rates = {
    junior: cfg.get('rateJunior') || 85,
    mid:    cfg.get('rateMid')    || 125,
    senior: cfg.get('rateSenior') || 200,
  };

  const stream = anthropic.messages.stream({
    model: getModel(),
    max_tokens: 8096,
    system: buildSystemPOI(rates),
    messages: [{
      role: 'user',
      content: `Perform a full Points of Interest scan on this codebase:\n\n${codebaseContext.context}`
    }]
  });

  let fullResponse = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      const text = chunk.delta.text;
      onChunk(text);
      fullResponse += text;
    }
  }

  return fullResponse;
}

export async function runBlastRadius(codebaseContext, target, onChunk) {
  const anthropic = getClient();

  const stream = anthropic.messages.stream({
    model: getModel(),
    max_tokens: 8096,
    system: SYSTEM_BLAST,
    messages: [{
      role: 'user',
      content: `Perform a blast radius analysis for: "${target}"\n\nCodebase:\n\n${codebaseContext.context}`
    }]
  });

  let fullResponse = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      const text = chunk.delta.text;
      onChunk(text);
      fullResponse += text;
    }
  }

  return fullResponse;
}
