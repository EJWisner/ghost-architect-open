import assert from 'node:assert/strict';
import { isScannablePath } from '../src/loader/index.js';

// Regression fixture for Git-hook file scanning.
// Extensionless Git hook files (pre-commit, post-checkout, commit-msg, ...)
// have no code extension, so the CODE_EXTENSIONS filter used to skip them --
// a scan pointed at a .git/hooks directory only picked up README.md.
// isScannablePath must include a file when its extension is a known code type
// OR its basename is a known Git hook, and must skip everything else.

// 1-3: extensionless Git hooks are included by basename
assert.equal(isScannablePath('.git/hooks/pre-commit'), true, 'pre-commit hook must be scanned');
assert.equal(isScannablePath('.git/hooks/post-checkout'), true, 'post-checkout hook must be scanned');
assert.equal(isScannablePath('.git/hooks/commit-msg'), true, 'commit-msg hook must be scanned');

// 4: a code-extension file in the hooks dir is still included (via extension)
assert.equal(isScannablePath('.git/hooks/README.md'), true, 'README.md (code extension) must be scanned');

// 5: the default *.sample hooks are NOT real hook names and have no code
//    extension, so they must be skipped (avoids scanning Git's shipped samples)
assert.equal(isScannablePath('.git/hooks/pre-commit.sample'), false, 'pre-commit.sample must be skipped');

// 6-7: ordinary source files honor CODE_EXTENSIONS
assert.equal(isScannablePath('src/index.js'), true, 'a .js source file must be scanned');
assert.equal(isScannablePath('src/styles.css'), false, 'a .css file (not in CODE_EXTENSIONS, not a hook) must be skipped');

console.log('git-hooks scanning: PASS');
console.log('  extensionless hooks included, .sample skipped, code-ext honored, non-code skipped');
