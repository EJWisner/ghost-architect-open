/**
 * Smoke test for parseRepo() in src/core/team-sync.js.
 *
 * parseRepo() used to hard-strip the "https://github.com/" prefix. That worked
 * for github.com but left GitHub Enterprise Server URLs
 * (https://github.company.com/owner/repo) with the domain embedded in the
 * owner segment, producing an invalid owner/repo tuple that 404'd on every
 * Octokit call. Enterprise customers are the primary users of team-sync, so the
 * feature was effectively broken for its core audience.
 *
 * These tests lock in domain-agnostic parsing: the owner/repo pair is read from
 * the URL path regardless of host, github.com and Enterprise Server alike, and
 * malformed URLs throw a clear error instead of silently mis-parsing.
 *
 * Run: node tests/team-sync-parse-repo.smoke.mjs
 */

import { parseRepo } from '../src/core/team-sync.js';

let failures = 0;

function checkParse(label, url, expectedOwner, expectedRepo) {
  let result;
  try {
    result = parseRepo(url);
  } catch (err) {
    console.log('  !!  ' + label);
    console.log('       threw unexpectedly: ' + err.message);
    failures++;
    return;
  }
  if (result.owner === expectedOwner && result.repo === expectedRepo) {
    console.log('  OK  ' + label);
  } else {
    console.log('  !!  ' + label);
    console.log('       expected: ' + JSON.stringify({ owner: expectedOwner, repo: expectedRepo }));
    console.log('       got:      ' + JSON.stringify(result));
    failures++;
  }
}

function checkThrows(label, url) {
  try {
    const result = parseRepo(url);
    console.log('  !!  ' + label);
    console.log('       expected a throw, got: ' + JSON.stringify(result));
    failures++;
  } catch {
    console.log('  OK  ' + label);
  }
}

console.log('\nTest 1: github.com URLs still parse');
checkParse('plain https', 'https://github.com/EJWisner/ghost-reports', 'EJWisner', 'ghost-reports');
checkParse('https with .git', 'https://github.com/EJWisner/ghost-reports.git', 'EJWisner', 'ghost-reports');
checkParse('trailing slash', 'https://github.com/EJWisner/ghost-reports/', 'EJWisner', 'ghost-reports');

console.log('\nTest 2: GitHub Enterprise Server URLs parse (regression)');
checkParse('enterprise https', 'https://github.company.com/acme/team-sync', 'acme', 'team-sync');
checkParse('enterprise https with .git', 'https://github.company.com/acme/team-sync.git', 'acme', 'team-sync');
checkParse('enterprise deep subdomain', 'https://git.internal.corp.example/platform/reports', 'platform', 'reports');

console.log('\nTest 3: SSH URLs parse');
checkParse('ssh github.com', 'git@github.com:EJWisner/ghost-reports.git', 'EJWisner', 'ghost-reports');
checkParse('ssh enterprise', 'git@github.company.com:acme/team-sync', 'acme', 'team-sync');

console.log('\nTest 4: malformed URLs throw a clear error');
checkThrows('missing repo segment', 'https://github.com/owner');
checkThrows('not a url', 'definitely-not-a-url');
checkThrows('empty string', '');

console.log('');
if (failures === 0) {
  console.log('PASSED — all assertions ok\n');
  process.exit(0);
} else {
  console.log('FAILED — ' + failures + ' assertion(s) failed\n');
  process.exit(1);
}
