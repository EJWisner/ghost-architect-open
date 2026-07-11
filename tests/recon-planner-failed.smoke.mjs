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

if (failures > 0) {
  console.error(`recon-planner-failed.smoke: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('PASSED — all assertions ok');
