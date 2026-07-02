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
// window. Anthropic's API returns 400 with these messages so the user gets a
// useful instruction ("trim files") instead of "Something went wrong. Please
// try again." which keeps them retrying a doomed request.
//
// KNOWN ANTHROPIC PHRASINGS (verified against @anthropic-ai/sdk 0.39.0, 2026).
// These are NOT a contract — the API can reword them at any time. If a new
// wording shows up, friendlyError() logs the unrecognized 400 to stderr (see
// below) so we know to add it here:
//   - "prompt is too long: N tokens > M maximum"
//   - "input length and `max_tokens` exceed context limit: ..."
//   - "...maximum context length..."
//   - "...this model's maximum context window..."
//   - "too many tokens"
export function isContextOverflow(err) {
  const msg = (err.message || '').toLowerCase();
  const status = err.status;
  // Only 400s (or status-less errors, where message matching is all we have).
  if (status !== 400 && status !== undefined) return false;
  // Billing and usage-limit 400s can also mention "tokens" + "limit"/"exceed"
  // (e.g. "usage limit exceeded"). They are NOT context overflows -- let them
  // fall through to the billing handler in friendlyError().
  if (msg.includes('usage limit') || msg.includes('billing limit') || msg.includes('regain access')) {
    return false;
  }

  if (msg.includes('prompt is too long') ||
      msg.includes('maximum context') ||
      msg.includes('context length') ||
      msg.includes('context window') ||
      msg.includes('too many tokens') ||
      msg.includes('exceed context limit')) {
    return true;
  }

  // Fallback heuristic: a 400 that mentions tokens alongside an
  // overflow-flavored word ("exceed"/"limit"). Catches reworded messages the
  // explicit list above misses. Gated on a real 400 status so a 429 rate-limit
  // message ("rate_limit ... tokens per minute") — which contains both
  // "tokens" and "limit" — can't be misclassified as a context overflow.
  if (status === 400 &&
      msg.includes('tokens') &&
      (msg.includes('exceed') || msg.includes('limit'))) {
    return true;
  }
  return false;
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
  // Programmer-error classes: always surface the real message so the user
  // and the developer get a useful signal. Never hide these behind a vague
  // 'try again' fallback — retrying a TypeError doesn't help, and silent
  // suppression means future regressions ship invisibly.
  //
  // Caught yesterday during v5.1.0 smoke testing: a TypeError in the
  // verifier step_cap evidence string `(result.filesAnalyzed || []).join`
  // (filesAnalyzed was a number, not an array) was suppressed by the
  // friendly fallback. The user retried, hit it again, retried, hit it
  // again — no signal that anything was broken in Ghost.
  if (isProgrammerError(err)) {
    const errName = (err.constructor && err.constructor.name) || err.name || 'Error';
    return `Internal error: ${errName}: ${msg || '(no message)'}\n  This is a Ghost Architect bug, not a transient issue. Retrying will not help.\n  Please report at: https://github.com/EJWisner/ghost-architect-open/issues`;
  }
  // Reaching here with a 400 means the API considers this a client-side error
  // we failed to classify. The most likely culprit is a context-overflow
  // message whose wording drifted out from under isContextOverflow()'s known
  // phrases (see that function's comment). Surface it on stderr so we notice
  // the drift and update the phrase list — the user still gets the generic
  // message below. Wrapped so diagnostics can never throw over the real error.
  if (err && err.status === 400) {
    try {
      console.error(`[ghost] unrecognized 400 from API — context-overflow phrase matching may be stale; message: ${msg || '(no message)'}`);
    } catch { /* never let diagnostics throw */ }
  }
  return 'Something went wrong. Please try again.';
}

// True when the error is a programmer-error class — a bug in Ghost itself,
// not an API/network/transient issue. Used by friendlyError to bypass the
// vague fallback for these errors so they surface visibly.
export function isProgrammerError(err) {
  if (!err || typeof err !== 'object') return false;
  const ctor = err.constructor && err.constructor.name;
  if (ctor === 'TypeError' ||
      ctor === 'ReferenceError' ||
      ctor === 'RangeError' ||
      ctor === 'SyntaxError' ||
      ctor === 'URIError') {
    return true;
  }
  // Some non-Anthropic errors set `name` but not a custom constructor.
  if (err.name === 'TypeError' ||
      err.name === 'ReferenceError' ||
      err.name === 'RangeError' ||
      err.name === 'SyntaxError') {
    return true;
  }
  return false;
}

export function showFriendlyError(err) {
  console.log('\n' + chalk.yellow(`  ⚠  ${friendlyError(err)}\n`));
}
