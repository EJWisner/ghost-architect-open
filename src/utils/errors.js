import chalk from 'chalk';

export function isRateLimit(err) {
  const msg = err.message || '';
  return err.status === 429 ||
    msg.includes('429') ||
    msg.includes('rate_limit') ||
    msg.includes('rate limit') ||
    msg.includes('tokens per minute');
}

export function isOverload(err) {
  const msg = err.message || '';
  return err.status === 529 ||
    msg.includes('529') ||
    msg.includes('overloaded');
}

// True when the prompt + max_tokens + overhead exceeds the model's context
// window. Anthropic's API returns 400 with messages like 'prompt is too long'
// or 'maximum context length' — we match the recognizable phrasings so the
// user gets a useful instruction ("trim files") instead of "Something went
// wrong. Please try again." which keeps them retrying a doomed request.
export function isContextOverflow(err) {
  const msg = (err.message || '').toLowerCase();
  if (err.status !== 400 && err.status !== undefined) return false;
  return msg.includes('prompt is too long') ||
         msg.includes('maximum context') ||
         msg.includes('context length') ||
         msg.includes('context window') ||
         msg.includes('too many tokens') ||
         (msg.includes('tokens') && msg.includes('exceed'));
}

export function friendlyError(err) {
  const msg = err.message || '';
  if (isRateLimit(err)) {
    return 'API rate limit reached. The codebase context is large — please wait 60 seconds and try again.';
  }
  if (isOverload(err)) {
    return 'Anthropic\'s API is temporarily overloaded. Please try again in a moment.';
  }
  if (isContextOverflow(err)) {
    return 'This pass exceeds the model context window. Try `--exclude-presets test-data,generated` to drop fixtures and build artefacts, or scan a subfolder rather than the whole repo.';
  }
  if (msg.includes('401') || msg.includes('authentication')) {
    return 'API key issue — go to Reconfigure in the main menu and re-enter your Anthropic API key.';
  }
  if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
    return 'Anthropic\'s API is temporarily unavailable. Please try again in a moment.';
  }
  if (msg.includes('network') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
    return 'Network connection issue. Check your internet connection and try again.';
  }
  if (msg.includes('usage limits') || msg.includes('regain access') || msg.includes('billing limit')) {
    const match = msg.match(/regain access on (.+?) UTC/);
    const when  = match ? `Resets ${match[1]} UTC.` : 'Check console.anthropic.com/settings/limits.';
    return `Monthly API spend limit reached. ${when} Increase your limit at console.anthropic.com/settings/limits.`;
  }
  return 'Something went wrong. Please try again.';
}

export function showFriendlyError(err) {
  console.log('\n' + chalk.yellow(`  ⚠  ${friendlyError(err)}\n`));
}
