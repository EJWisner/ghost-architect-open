# Ghost Architect — Points of Interest Report

| | |
|---|---|
| **Project** | Unnamed scan |
| **Generated** | 5/20/2026, 11:35:45 AM |
| **Files Analyzed** | 32 of 32 |
| **Total Files in Project** | 32 |
| **Analysis Cost** | $0.0568 |
| **Tool** | Ghost Architect v6.0.0 |
| **Copyright** | © 2026 Ghost Architect. All rights reserved. |

---

# Magento CLI Architecture Review

This codebase provides a local development wrapper around Magento's bin/magento command, leveraging embedded YAML task definitions and Docker Compose. **The most critical issue is a hardcoded default admin password (`admin123`) that will be used in any installation where developers don't explicitly override it.** While this is a development tool, weak defaults create attack surface when local instances are network-accessible or accidentally promoted to staging environments. Beyond that, the error handling around temporary file extraction is incomplete, allowing the tool to silently proceed with missing configuration files.


---


## Security: Weak Default Credentials

**Finding: Hardcoded default admin password in install task**  
**Files:** `tasks/_global.yaml`

The `install-password` parameter defaults to `admin123` in the global parameter definitions. Any developer running an install command without explicit credential overrides will create a Magento instance with this publicly-known password. The README and getting started documentation describe this parameter, making the default discoverable to anyone who can access the repository or published docs.

While this tool targets local development, developers routinely expose their workstations to local networks, share VPN access with contractors, or push pre-configured development databases to staging. A well-known default password becomes a trivial entry point.

**What to do:**  
Remove the default value from the `install-password` parameter definition. Require developers to supply `--install-password` explicitly at runtime, or generate a random password and echo it to the console during installation. Update the README and getting started guide to show this parameter as required and explain why. This forces conscious credential selection and eliminates a default attack vector.


---


## Operational Reliability: Silent Failures

### Swallowed file write errors

**Finding: Empty catch blocks swallow file write errors**  
**Files:** `main.go`

The `extractYamlToTemp` function walks embedded service YAML files and writes them to `.magento-cli/tmp/services/`. When file operations fail—disk full, permission denied, path too long—the error is printed but the walk callback returns `nil`, allowing execution to continue. The function never signals to `main()` that extraction failed, so `cmd.YAML(yaml)` proceeds with incomplete or missing service definitions.

The result: Docker Compose commands fail with cryptic "file not found" errors, or worse, execute with partial configurations that fail in unpredictable ways. Developers waste time troubleshooting what looks like a Docker issue when the root cause is a file write failure during initialization.

**What to do:**  
Change `extractYamlToTemp` to return an error instead of being void. Track failures in the walk callback—either return immediately on first error or collect all errors and return a combined result. In `main()`, check this error before calling `cmd.YAML(yaml)` and exit with `log.Fatal` if extraction failed. Add a test that simulates a write failure (e.g., read-only temp directory) and verifies the program exits cleanly with a clear error message.

### Deferred cleanup can leak temporary files

**Finding: Deferred cleanup can panic silently**  
**Files:** `main.go`

The `rmTemp()` function contains a deferred `os.RemoveAll(tempDir)` inside itself—a nested defer called from another defer in `main()`. If `os.RemoveAll` fails, the error is dropped silently. More critically, the nested structure can behave unpredictably if any code between the two defers panics, potentially leaving `.magento-cli/tmp` behind. Repeated runs accumulate orphaned directories, consuming disk space and occasionally causing name collisions.

**What to do:**  
Remove the `rmTemp()` wrapper entirely. In `main()`, place `defer os.RemoveAll(tempDir)` directly after the `extractYamlToTemp(services)` call. This simplifies the control flow and makes cleanup behavior explicit. Optionally log a warning if `os.RemoveAll` returns an error, though you cannot meaningfully handle it in a defer. Add a test that verifies the temp directory is removed after execution completes normally.


---


## Developer Experience: Missing Guardrails

### No validation that bin/magento exists

**Finding: No validation that bin/magento exists before passthrough**  
**Files:** `tasks/passthru.yaml`

The passthrough task directly invokes `php bin/magento $CMD` without checking whether `bin/magento` exists in the current working directory. If a developer runs `magento-cli cache:flush` in a non-Magento directory—or in a fresh checkout before running `composer install`—the command fails with a PHP fatal error that looks like a bug in magento-cli rather than user error.

This degrades the developer experience and makes troubleshooting harder. New team members especially struggle to distinguish tool issues from environment setup problems.

**What to do:**  
Add a pre-execution check in the passthrough task (or in `main.go` before invoking variant) that verifies `bin/magento` exists and is executable. If the file is missing, print a friendly error: "Error: bin/magento not found. Are you in a Magento project directory?" Exit with a non-zero status code to signal failure cleanly. Add a test that simulates running magento-cli in an empty directory and verifies the error message is displayed.

### Implicit contract between tasks and service files

**Finding: Environment variable substitution requires Docker Compose invocation**  
**Files:** `tasks/_global.yaml`, `tasks/up.yaml`, `tasks/down.yaml`, `tasks/logs.yaml`

The service YAML files use environment variable placeholders like `${MAGECLI_DB_IMAGE}` and `${MAGECLI_ES_TAG}`, which are exported by the `&envvars` script block before each `docker-compose` invocation. This works when running `magento-cli up`, but if a developer tries to manually run `docker-compose -f .magento-cli/tmp/services/database.yaml up` for debugging, the variables are undefined and Docker Compose silently substitutes empty strings, causing image pull failures.

The contract between tasks and service files is implicit and undocumented. Developers troubleshooting Docker issues won't realize the service files are templates that require specific environment variables to be set.

**What to do:**  
Generate a `.env` file in `extractYamlToTemp` that writes all `MAGECLI_` variables to `.magento-cli/tmp/.env` using parameter defaults from `_global.yaml`. Update Docker Compose invocations to include `--env-file .magento-cli/tmp/.env`. Add comments in the service YAML files explaining that variables are sourced from the generated `.env` file. Update documentation to show how developers can override these variables for local debugging.


---


## Code Quality: Unused Scaffolding

**Finding: testMode global is write-only**  
**Files:** `main.go`, `main_test.go`

The `testMode` global variable is set in `main_test.go` to skip calling `cmd.YAML(yaml)` during tests, but the test itself (`TestMain`) only verifies that `main()` returns without panicking. It doesn't validate YAML parsing, task execution, or parameter resolution. The variable exists solely to prevent test execution of the variant framework, but no meaningful assertions replace that execution.

This is scaffolding for a test suite that was never built. The conditional adds complexity without providing value.

**What to do:**  
Delete the `testMode` global and its conditional guard. Refactor `main()` to call a new `run() error` function that returns an error instead of calling `os.Exit` or `log.Fatal`. Rewrite `TestMain` to call `run()` and assert on the error, or test specific helper functions like `loadYaml` and `extractYamlToTemp` directly. This makes the code more testable and removes dead conditional logic.


---


## REMEDIATION SUMMARY

| Finding | Severity | Complexity | Hours | Cost |
|---------|----------|------------|-------|------|
| Hardcoded default admin password | 🟠 **HIGH** | 🟢 **LOW** | 1.0 | $85 |
| Swallowed file write errors | 🟠 **HIGH** | 🟡 **MEDIUM** | 2.5 | $313 |
| Deferred cleanup can leak files | 🟡 **MEDIUM** | 🟢 **LOW** | 0.5 | $43 |
| No validation for bin/magento | 🟡 **MEDIUM** | 🟢 **LOW** | 1.0 | $85 |
| Implicit environment variable contract | 🟡 **MEDIUM** | 🟡 **MEDIUM** | 2.0 | $250 |
| Unused testMode scaffolding | 🟢 **LOW** | 🟢 **LOW** | 0.5 | $43 |
| **TOTAL** | | | **7.5** | **$819** |

**Rate card:** 🟢 **LOW** complexity $85/hr | 🟡 **MEDIUM** $125/hr | 🟠 **HIGH**/🔴 **CRITICAL** $200/hr

The total remediation effort is approximately 1 developer-day. Prioritize the credential default and file write error handling first, as these have the most immediate operational impact.

---

*Generated by Ghost Architect — AI-powered codebase intelligence*  
*ghostarchitect.dev*
