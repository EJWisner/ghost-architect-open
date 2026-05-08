/**
 * Smoke tests for src/utils/errors.js error classification.
 *
 * Covers isProgrammerError + friendlyError dispatch logic. The TypeError
 * regression yesterday (verifier step_cap `.join()` on a number) was
 * suppressed by friendlyError's vague fallback — these tests lock in the
 * fix so future programmer errors surface visibly.
 *
 * Run: node tests/error-classification.smoke.mjs
 */

import { isProgrammerError, friendlyError, isRateLimit, isOverload, isContextOverflow } from '../src/utils/errors.js';

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected: ' + e);
    console.log('       actual:   ' + a);
    failures++;
  }
}

function checkContains(label, value, substring) {
  if (typeof value === 'string' && value.includes(substring)) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected to contain: ' + JSON.stringify(substring));
    console.log('       got:                 ' + JSON.stringify(value));
    failures++;
  }
}

// Test 1: isProgrammerError correctly identifies bug-class errors
console.log('Test 1: isProgrammerError detection');
{
  check('TypeError', isProgrammerError(new TypeError('Cannot read property')), true);
  check('ReferenceError', isProgrammerError(new ReferenceError('foo is not defined')), true);
  check('RangeError', isProgrammerError(new RangeError('Maximum call stack')), true);
  check('SyntaxError', isProgrammerError(new SyntaxError('Unexpected token')), true);
  check('URIError', isProgrammerError(new URIError('URI malformed')), true);
  check('plain Error', isProgrammerError(new Error('something')), false);
  check('null', isProgrammerError(null), false);
  check('undefined', isProgrammerError(undefined), false);
  check('string', isProgrammerError('not an error'), false);
}
console.log('');

// Test 2: friendlyError surfaces TypeErrors instead of hiding them
console.log('Test 2: friendlyError surfaces programmer errors');
{
  const typeErr = new TypeError("(result.filesAnalyzed || []).join is not a function");
  const msg = friendlyError(typeErr);
  checkContains('mentions Internal error', msg, 'Internal error');
  checkContains('mentions TypeError', msg, 'TypeError');
  checkContains('mentions actual error message', msg, 'is not a function');
  checkContains('mentions Ghost bug', msg, 'Ghost Architect bug');
  checkContains('mentions issues link', msg, 'github.com/EJWisner/ghost-architect-open/issues');
  // Critical: must NOT fall back to the generic message
  if (msg === 'Something went wrong. Please try again.') {
    failures++;
    console.log('  !!  TypeError fell through to generic fallback (regression!)');
  } else {
    console.log('  OK  TypeError did NOT fall through to generic fallback');
  }
}
console.log('');

// Test 3: friendlyError still uses friendly handlers for known API errors
console.log('Test 3: known API errors still get friendly messages');
{
  const rateLimit = { status: 429, message: 'rate_limit_error' };
  check('isRateLimit catches it', isRateLimit(rateLimit), true);
  checkContains('rate limit message', friendlyError(rateLimit), 'rate limit reached');

  const overload = { status: 529, message: 'overloaded' };
  check('isOverload catches it', isOverload(overload), true);
  checkContains('overload message', friendlyError(overload), 'temporarily overloaded');

  const contextOverflow = { status: 400, message: 'prompt is too long' };
  check('isContextOverflow catches it', isContextOverflow(contextOverflow), true);
  checkContains('context overflow message', friendlyError(contextOverflow), 'context window');
}
console.log('');

// Test 4: friendlyError still uses generic fallback for unknown plain Errors
console.log('Test 4: unknown plain Errors still get generic fallback');
{
  const unknown = new Error('some weird API thing');
  const msg = friendlyError(unknown);
  check('falls through to generic', msg, 'Something went wrong. Please try again.');
}
console.log('');

// Test 5: order-of-precedence — programmer errors check AFTER known API patterns
// so an Error.message with 'rate limit' wording still gets the rate-limit handler
console.log('Test 5: known patterns take precedence over programmer-error check');
{
  // A plain Error with rate-limit wording — should be handled as rate limit, not programmer error
  const apiErr = new Error('rate_limit hit');
  apiErr.status = 429;
  checkContains('rate-limit handler runs', friendlyError(apiErr), 'rate limit reached');
}
console.log('');

if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
