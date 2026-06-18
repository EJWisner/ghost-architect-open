/**
 * Smoke test for error handling in src/prioritizer.js.
 *
 * scoreFile() and prioritizeFileMap() used to have no guard around malformed
 * input: a null/non-string content value threw on content.split('\n') (and a
 * non-string path threw on filePath.toLowerCase()), which aborted the entire
 * scan. scoreFile() now wraps its body in try-catch, returning score 0 with a
 * stderr warning on any exception. prioritizeFileMap() skips entries it can't
 * score, again warning on stderr, so one bad file never takes down the map.
 *
 * Run: node tests/prioritizer-error-handling.smoke.mjs
 */

import { scoreFile, prioritizeFileMap } from '../src/prioritizer.js';

let failures = 0;

function checkTrue(label, cond) {
  if (cond) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    failures++;
  }
}

// Capture stderr so we can assert warnings are emitted without polluting output.
function captureStderr(fn) {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => { captured += chunk; return true; };
  try {
    const result = fn();
    return { result, captured };
  } finally {
    process.stderr.write = original;
  }
}

console.log('Test: scoreFile returns 0 and warns on malformed input');
{
  const { result: nullScore, captured: nullWarn } = captureStderr(() => scoreFile('foo.js', null));
  checkTrue('null content scores 0', nullScore === 0);
  checkTrue('null content warns on stderr', nullWarn.includes('skipping unscorable file'));

  const { result: badPathScore } = captureStderr(() => scoreFile(null, 'some content'));
  checkTrue('non-string path scores 0', badPathScore === 0);

  // A normal file still scores as before — no regression.
  const payment = scoreFile('src/PaymentService.js', 'import x from "y";\nconst a = 1;\n');
  checkTrue('valid high-risk file still scores > 0', payment > 0);
}
console.log('');

console.log('Test: prioritizeFileMap excludes the null-content entry and returns the valid map');
{
  const fileMap = {
    'src/auth.js': 'import a from "a";\nconst x = 1;\n',
    'src/broken.js': null,
    'src/index.js': 'const y = 2;\n',
  };

  const { result: prioritized, captured } = captureStderr(() => prioritizeFileMap(fileMap));

  checkTrue('null-content entry excluded from result', !('src/broken.js' in prioritized));
  checkTrue('valid auth.js retained', prioritized['src/auth.js'] === fileMap['src/auth.js']);
  checkTrue('valid index.js retained', prioritized['src/index.js'] === fileMap['src/index.js']);
  checkTrue('exactly the two valid entries returned', Object.keys(prioritized).length === 2);
  checkTrue('warns about the skipped file', captured.includes('src/broken.js'));

  // Highest-scoring file (auth.js — high-risk pattern) comes first.
  checkTrue('auth.js ranked ahead of index.js', Object.keys(prioritized)[0] === 'src/auth.js');
}
console.log('');

console.log('Test: prioritizeFileMap tolerates null/undefined fileMap');
{
  const { result } = captureStderr(() => prioritizeFileMap(null));
  checkTrue('null fileMap returns empty object', result && Object.keys(result).length === 0);
}
console.log('');

if (failures > 0) {
  console.log('FAILED — ' + failures + ' assertion(s) did not pass');
  process.exit(1);
} else {
  console.log('PASSED — all assertions ok');
  process.exit(0);
}
