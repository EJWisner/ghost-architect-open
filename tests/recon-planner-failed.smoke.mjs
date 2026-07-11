// Recon plannerFailed propagation smoke test (Audit 10, finding 3.1).
//
// generatePlan's fallback sets plannerFailed: true when the planning API call
// fails, but runRecon builds its return object field by field, so the flag
// had to be copied explicitly. Before the fix, plan.plannerFailed was always
// undefined in recon.js: a failed planner run stamped $0.0500 of spend on a
// sales-facing artifact for a call that never succeeded, and the structural
// fallback disclosure never rendered.
//
// Offline by design: a syntactically valid key satisfies client construction
// (which happens outside generatePlan's try), and ANTHROPIC_BASE_URL pointing
// at an unroutable local port makes the planner call itself fail fast, which
// is exactly the failure path under test. No network is reached.

process.env.ANTHROPIC_API_KEY  = 'sk-ant-test-recon-planner-failed-smoke';
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';

const { runRecon } = await import('../src/core/agent/planner.js');
const { renderReconMarkdown, reconMetaCost } = await import('../src/modes/recon.js');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

console.log('recon-planner-failed.smoke: planner failure must be disclosed, not billed');

const fileMap = {
  'src/app/checkout/PaymentController.php': '<?php // payment flow',
  'src/app/Api/OrderApi.php':               '<?php // order api',
  'src/etc/di.xml':                          '<config/>',
  'README.md':                               '# fixture project',
};

const plan = await runRecon(fileMap, 'recon', {});

// Test 1: the flag survives runRecon's field-by-field return object.
check('Test 1: plannerFailed=true propagates through runRecon', plan.plannerFailed === true);

// Test 2: a failed planner run stamps $0.0000, never the 0.0500 estimate.
check('Test 2: failed planner stamps 0.0000 in meta cost', reconMetaCost(plan, 0) === '0.0000');

// Test 3: the saved markdown discloses the structural fallback.
const failedMd = renderReconMarkdown(plan, null, null);
check('Test 3: structural fallback disclosure renders in markdown',
  failedMd.includes('structural sizing heuristics'));

// Test 4: a successful plan renders no fallback disclosure.
const okMd = renderReconMarkdown({ ...plan, plannerFailed: false }, null, null);
check('Test 4: no fallback disclosure on a successful plan',
  !okMd.includes('structural sizing heuristics'));

// Test 5: succeeded-but-usage-unobservable keeps the 0.0500 estimate.
check('Test 5: unobservable-usage success keeps 0.0500 estimate',
  reconMetaCost({ plannerFailed: false }, 0) === '0.0500');

// Test 6: observed spend stamps the billed figure.
check('Test 6: observed spend stamps the billed figure',
  reconMetaCost({ plannerFailed: false }, 0.1234) === '0.1234');

// Test 7: the fallback plan still carries usable structural output.
check('Test 7: fallback plan carries structural sizing fields',
  plan.totalFiles === 4 && typeof plan.planSummary === 'string' && plan.planSummary.length > 0);

// Test 8: billed-but-unparseable (Audit 11, finding 3.4). The planner reports
// usage on a successful API response BEFORE parsing it, so a malformed model
// response arrives with plannerFailed=true AND observed spend. The billed
// figure must win over the 0.0000 stamp: the spend was real.
check('Test 8: observed spend wins even when plannerFailed is set',
  reconMetaCost({ plannerFailed: true }, 0.0512) === '0.0512');

// Test 9: repository-total disclosure (Audit 11, finding 2.4). plan.totalFiles
// is the LOADED count; when the caller passes the larger repository total,
// the Total files line must show the repo total and disclose the loaded
// subset instead of contradicting the meta header's "X of Y".
const cappedMd = renderReconMarkdown({ ...plan, plannerFailed: false }, null, null, 396);
check('Test 9a: capped repo shows repository total with loaded-subset disclosure',
  cappedMd.includes('**Total files:** 396 (4 loaded for sizing within the context budget)'));
const uncappedMd = renderReconMarkdown({ ...plan, plannerFailed: false }, null, null, 4);
check('Test 9b: uncapped repo shows the plain total with no disclosure',
  uncappedMd.includes('**Total files:** 4\n') && !uncappedMd.includes('loaded for sizing'));
const legacyMd = renderReconMarkdown({ ...plan, plannerFailed: false }, null, null);
check('Test 9c: omitted repo total falls back to the loaded count',
  legacyMd.includes('**Total files:** 4'));

if (failures > 0) {
  console.error(`recon-planner-failed.smoke: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('PASSED — all assertions ok');
