# Ghost Architect — Points of Interest Report

| | |
|---|---|
| **Project** | Unnamed scan |
| **Generated** | 5/20/2026, 11:45:55 AM |
| **Files Analyzed** | 32 of 32 |
| **Total Files in Project** | 32 |
| **Analysis Cost** | $0.1238 |
| **Tool** | Ghost Architect v6.0.0 |
| **Copyright** | © 2026 Ghost Architect. All rights reserved. |

---

# GHOST ARCHITECT — POINTS OF INTEREST SCAN

## SCAN FRAMEWORK WALK

**Secrets and credentials:** checked, no issues found in the files provided.

**Input validation and injection surfaces:**
- Finding: The `loadYaml` function in `main.go` constructs file paths by concatenating `configDir + f.Name()` without normalization or validation. An attacker who can influence the `.magento-cli` directory contents could craft a filename like `../../etc/passwd.yaml` to cause the code to read arbitrary files outside the intended directory.
- Finding: In `tasks/install.yaml`, database credentials (db-user, db-pass) and admin credentials (install-password) are passed as command-line arguments to `bin/magento setup:install`. These arguments appear in process listings (`ps aux`) and shell history, exposing secrets to local users.
- Finding: The docker-compose project name (`{{ get "project" }}`) in multiple task files is interpolated directly into shell commands without quoting or escaping. A malicious project name could inject shell metacharacters.

**Authentication and authorization:** checked, no issues found in the files provided.

**Error handling and failure modes:**
- Finding: In `main.go`, the `extractYamlToTemp` function has multiple error paths (`os.Create`, `f.WriteString`, `f.Close`) that print the error but continue execution by returning `nil`. If file creation fails partway through, the tool will launch with a partial configuration and no indication to the user that something went wrong.
- Finding: In `main.go`, `loadYaml` calls `log.Fatal(err)` if `ioutil.ReadDir` fails, but silently ignores `ioutil.ReadFile` failures by leaving `content` empty and continuing. A missing or unreadable `.magento-cli/*.yaml` file will be silently skipped, potentially leaving the user with a broken configuration.
- Finding: The `rmTemp()` function uses `defer os.RemoveAll(tempDir)` at the end of `main()`. If `cmd.YAML(yaml)` panics or the tool is killed mid-execution, the deferred cleanup will not run, leaving `.magento-cli/tmp/` directories littering the filesystem.

**Concurrency and race conditions:**
- Finding: The `testMode` global variable in `main.go` is read and written without synchronization. While the current test suite is single-threaded, this is a footgun if tests become concurrent in the future.

**External integrations and contracts:**
- Finding: The `up.yaml` task sleeps for exactly 3 seconds after starting docker-compose services (`up -d && sleep 3`). This assumes database and Elasticsearch containers are ready within 3 seconds on all hardware. On slower machines or under load, the services may not be fully initialized, causing subsequent `install` or `configure` commands to fail with connection errors.
- Finding: The code embeds and extracts service YAML files to `.magento-cli/tmp/services/` at startup, but there is no version check or invalidation mechanism. If the `magento-cli` binary is updated while an old tmp directory exists, the tool will use stale service definitions until the user manually deletes `.magento-cli/tmp/`.

**Data lifecycle and persistence:** checked, no issues found in the files provided.

**Configuration and build:**
- Finding: In `tasks/_global.yaml`, the default admin password is `admin123`, which is hardcoded and widely known. Fresh installs using defaults will have a trivially guessable admin credential unless the user overrides it.
- Finding: The `php-bin-path` parameter in `_global.yaml` defaults to `/opt/homebrew/Cellar/php/` with a commented-out `$MAGECLI_PHP_VERSION/bin/` suffix. The path is incomplete and will not work as-is. The code relies on `php-bin-cmd` instead, but the presence of `php-bin-path` suggests an incomplete migration or dead configuration.
- Finding: The Elasticsearch and database images default to `elasticsearch:7.10.1` and `mysql:8.0-oracle`. Elasticsearch 7.10.1 was released in 2020 and is now EOL (end-of-life). Using an EOL image exposes users to unpatched security vulnerabilities.

**Dead code and abandoned features:**
- Finding: The `yamlExt` variable in `main.go` is declared (`var yamlExt string = ".yaml"`) but only used once in `loadYaml`. It could be inlined.
- Finding: The `php-bin-path` parameter in `_global.yaml` is defined but never referenced in any task file. It appears to be an abandoned feature or incomplete implementation.
- Finding: The `configure.yaml` task sets the Magento base URL but has a trailing slash in the URL template (`'http://{{ get "host" }}:{{ get "port" }}/`), which may or may not be intentional but looks like a typo.

**Architectural load-bearing components:**
- Finding: The `loadYaml` function is the single point where all task and override configuration is assembled. It walks embedded files, then walks `.magento-cli/*.yaml` overrides, concatenating them into one giant YAML string. If this function produces malformed YAML (e.g. by concatenating incompatible structures), the entire tool fails to parse configuration and becomes unusable.
- Finding: The `extractYamlToTemp` function writes service definitions to `.magento-cli/tmp/` every time `main()` runs. Every docker-compose task references these extracted files with hardcoded paths (`.magento-cli/tmp/services/database.yaml`). If extraction fails or is interrupted, all docker-compose commands break with "file not found" errors.


---


# 🔴 RED FLAGS

## Unquoted docker project name allows shell injection
**Framework:** Input validation and injection surfaces  
**Files:** `tasks/up.yaml`, `tasks/down.yaml`, `tasks/logs.yaml`

The `{{ get "project" }}` template variable is interpolated directly into shell commands in docker-compose tasks without quoting. A malicious project name like `foo; rm -rf /` would execute arbitrary shell commands. While the project name defaults to "localhost" and is user-configurable, an attacker who can influence the configuration (e.g. by committing a `.magento-cli.yaml` file to a shared repository) can inject commands.

**Severity:** 🟠 **HIGH**  
**Effort:** 2–4 hours | Complexity: Low  
**Recommended fix:**
1. Wrap all `{{ get "project" }}` interpolations in single quotes in shell commands.
2. Audit all other user-controlled template variables (`{{ get "host" }}`, `{{ get "db-name" }}`, etc.) for similar injection risks.
3. Consider using a YAML templating library that escapes shell metacharacters by default.

**Example:**
```yaml
# Before — unquoted interpolation
- docker-compose --project-name {{ get "project" }} -f ...

# After — single-quoted to prevent injection
- docker-compose --project-name '{{ get "project" }}' -f ...
```

**Priority:** 1


---


## Admin credentials exposed in process listings
**Framework:** Input validation and injection surfaces  
**Files:** `tasks/install.yaml`

Database and admin passwords are passed as command-line arguments to `bin/magento setup:install`. On Unix systems, command-line arguments are visible to all users via `ps aux` and are logged to shell history. An attacker with local access or access to process monitoring tools can harvest credentials. This includes the default admin password `admin123` (already weak) and any database password a user sets.

**Severity:** 🟠 **HIGH**  
**Effort:** 6–10 hours | Complexity: Medium  
**Recommended fix:**
1. Refactor `install.yaml` to write credentials to a temporary environment file (e.g. `.magento-cli/tmp/install.env`) with restrictive permissions (0600).
2. Modify the `bin/magento setup:install` invocation to source credentials from the environment file or use stdin.
3. Delete the temporary file immediately after the install completes.
4. Document this change in the upgrade guide so users know credentials will no longer appear in shell history.

**Priority:** 2


---


## Path traversal in config override loading
**Framework:** Input validation and injection surfaces  
**Files:** `main.go`

In the `loadYaml` function, the code constructs file paths by concatenating `configDir + f.Name()` without normalizing or validating `f.Name()`. An attacker who can place a file named `../../etc/passwd.yaml` in the `.magento-cli` directory could cause the tool to read arbitrary files outside the intended directory. While `ioutil.ReadFile` would fail on directories, it would succeed on readable files, leaking their contents into the YAML configuration blob (and potentially into logs or error messages).

**Severity:** 🟠 **HIGH**  
**Effort:** 4–6 hours | Complexity: Low  
**Recommended fix:**
1. After reading `f.Name()`, call `filepath.Clean()` to normalize the path.
2. Verify the cleaned path still starts with `configDir` using `strings.HasPrefix()`.
3. If the path escapes `configDir`, skip the file and log a warning.
4. Add a test case with a malicious filename to ensure the validation works.

**Example:**
```go
// Before — unchecked concatenation
content, _ := ioutil.ReadFile(configDir + f.Name())

// After — path validation
cleanName := filepath.Clean(f.Name())
fullPath := filepath.Join(configDir, cleanName)
if !strings.HasPrefix(fullPath, configDir) {
    log.Printf("Skipping malicious override file: %s", f.Name())
    continue
}
content, _ := ioutil.ReadFile(fullPath)
```

**Priority:** 3


---


## Hardcoded default admin password
**Framework:** Configuration and build  
**Files:** `tasks/_global.yaml`

The default admin password is `admin123`, which is trivially guessable and widely documented in Magento tutorials. Fresh installs using defaults will create an admin account with this password. An attacker who discovers a default-configured instance can gain full admin access, modify products, exfiltrate customer data, or inject malicious scripts.

**Severity:** 🔴 **CRITICAL**  
**Effort:** 2–4 hours | Complexity: Low  
**Recommended fix:**
1. Remove the default value for `install-password` in `_global.yaml`, making it a required parameter.
2. Modify the `install` task to check if `install-password` is empty or equals `admin123`, and if so, prompt the user to set a secure password interactively.
3. Emit a loud warning if the user explicitly sets `admin123`.
4. Document the change in the upgrade guide and getting-started docs.

**Priority:** 4


---


## End-of-life Elasticsearch image
**Framework:** Configuration and build  
**Files:** `tasks/_global.yaml`, `services/elasticsearch.yaml`

The default Elasticsearch image is `elasticsearch:7.10.1`, released in 2020 and now end-of-life. Using an EOL image exposes users to unpatched security vulnerabilities in Elasticsearch itself (CVE-2021-22145, for example) and prevents users from upgrading to newer Magento versions that require Elasticsearch 7.17+ or OpenSearch.

**Severity:** 🟠 **HIGH**  
**Effort:** 2–3 hours | Complexity: Low  
**Recommended fix:**
1. Update the default `es-image-tag` in `_global.yaml` to `7.17.9` (the latest 7.x release as of early 2024) or `8.6.0` if Magento 2.4.6+ is the target.
2. Test the `install` task against both tags to ensure compatibility.
3. Add a note in the docs about how to pin to older Elasticsearch versions if needed.

**Priority:** 5


---


## Silent failure in config file extraction
**Framework:** Error handling and failure modes  
**Files:** `main.go`

In the `extractYamlToTemp` function, multiple error paths (`os.Create`, `f.WriteString`, `f.Close`) print the error but return `nil`, allowing execution to continue. If file creation fails partway through (e.g. due to disk full, permissions, or I/O error), the tool will launch with a partial configuration and no indication to the user that something went wrong. Subsequent docker-compose commands will fail with "file not found" errors, but the root cause (failed extraction) will be invisible.

**Severity:** 🟡 **MEDIUM**  
**Effort:** 3–5 hours | Complexity: Low  
**Recommended fix:**
1. Change error-handling branches in `extractYamlToTemp` to return the error instead of `nil`.
2. Check the return value of `fs.WalkDir` in `main()` and call `log.Fatal(err)` if non-nil.
3. Add a test case that mocks a filesystem error (e.g. by making `tempDir` read-only) and verifies the tool exits with a clear error message.

**Example:**
```go
// Before — error swallowed
if err != nil {
    fmt.Println(err)
    return nil
}

// After — error propagated
if err != nil {
    return fmt.Errorf("failed to write %s: %w", path, err)
}
```

**Priority:** 6


---


## Hardcoded 3-second service startup delay
**Framework:** External integrations and contracts  
**Files:** `tasks/up.yaml`

The `up` task runs `docker-compose up -d && sleep 3` with a hardcoded 3-second delay. This assumes database and Elasticsearch containers are ready within 3 seconds on all hardware. On slower machines, under heavy load, or with cold image pulls, services may not initialize in time. Subsequent commands (`install`, `configure`) will fail with connection errors, but the user has no visibility into why.

**Severity:** 🟡 **MEDIUM**  
**Effort:** 6–10 hours | Complexity: Medium  
**Recommended fix:**
1. Replace the `sleep 3` with a polling loop that checks service health (e.g. `docker exec <container> mysqladmin ping` for MySQL, `curl localhost:9200/_cluster/health` for Elasticsearch).
2. Poll every 1 second with a 30-second timeout.
3. Emit progress messages ("Waiting for database...", "Database ready") so the user knows what's happening.
4. If the timeout is reached, fail with a clear error message pointing to `docker-compose logs`.

**Priority:** 7


---


# 🏛️ LANDMARKS

## Central YAML configuration assembler
**Framework:** Architectural load-bearing components  
**Files:** `main.go`

The `loadYaml` function is the heart of the configuration system. It walks embedded `tasks/*.yaml` files (via `embed.FS`), concatenates them into a single YAML string, then walks `.magento-cli/*.yaml` overrides and appends those. The resulting YAML blob is fed to the variant CLI parser. Every task definition, every parameter, and every override flows through this function. If `loadYaml` produces malformed YAML (e.g. by concatenating incompatible structures or missing a newline), the entire tool fails to parse configuration and becomes unusable.

**Severity:** N/A (landmark)  
**Effort:** N/A | Complexity: N/A  

The function is simple but critical. It has two potential failure modes: (1) embedded files not being readable (should never happen in a compiled binary), and (2) user override files being malformed or unreadable (handled by silently skipping them, which is a separate finding). The concatenation strategy is brittle — it assumes all YAML files are top-level maps that can be merged by simple string concatenation. If a future task file introduces a YAML list at the root or a scalar, the concatenation will break.

**Recommended observability:** Add a debug flag (`--debug-config`) that prints the final concatenated YAML to stdout before parsing, so users can diagnose configuration issues.


---


## Service YAML extraction pipeline
**Framework:** Architectural load-bearing components  
**Files:** `main.go`

The `extractYamlToTemp` function writes embedded service definitions (database, Elasticsearch) to `.magento-cli/tmp/services/` every time `main()` runs. Every docker-compose task references these extracted files with hardcoded paths (`.magento-cli/tmp/services/database.yaml`, `.magento-cli/tmp/services/elasticsearch.yaml`). If extraction fails or is interrupted, all docker-compose commands break with "file not found" errors.

**Severity:** N/A (landmark)  
**Effort:** N/A | Complexity: N/A  

This design choice enables users to override service definitions by creating `.magento-cli/services/*.yaml` files, but it introduces a runtime dependency on filesystem state. The extraction happens on every invocation (not just `up`), which is wasteful but ensures the files are always fresh. The `defer os.RemoveAll(tempDir)` cleanup means the files are ephemeral, but this also means the tool cannot be run in a read-only filesystem.

**Recommended evolution:** Consider caching extracted files in a content-addressed directory (e.g. `.magento-cli/cache/<hash>/services/`) and only re-extracting when the embedded content changes. This would reduce filesystem I/O and enable read-only deployments.


---


# ⚰️ DEAD ZONES

## Unused yamlExt variable
**Framework:** Dead code and abandoned features  
**Files:** `main.go`

The `yamlExt` variable is declared globally (`var yamlExt string = ".yaml"`) but only used once in `loadYaml` to filter override files. It could be inlined as a constant at the usage site, reducing cognitive load for readers.

**Severity:** 🟢 **LOW**  
**Effort:** 2 hours | Complexity: Low  
**Recommended fix:**
1. Remove the global `yamlExt` declaration.
2. Inline the literal `".yaml"` in the `filepath.Ext(f.Name()) == ".yaml"` check in `loadYaml`.

**Example:**
```go
// Before — global variable used once
var yamlExt string = ".yaml"
...
if filepath.Ext(f.Name()) == yamlExt {

// After — inlined literal
if filepath.Ext(f.Name()) == ".yaml" {
```

**Priority:** 8


---


## Orphaned php-bin-path parameter
**Framework:** Dead code and abandoned features  
**Files:** `tasks/_global.yaml`

The `php-bin-path` parameter is defined in `_global.yaml` with a default of `/opt/homebrew/Cellar/php/` and a commented-out suffix `#$MAGECLI_PHP_VERSION/bin/`. It is never referenced in any task file — all tasks use `php-bin-cmd` instead. This suggests an incomplete migration from a path-based approach to a command-based approach. The parameter adds clutter to the `magento --help` output and may confuse users.

**Severity:** 🟢 **LOW**  
**Effort:** 2 hours | Complexity: Low  
**Recommended fix:**
1. Search all task YAML files for references to `php-bin-path`. If none exist, delete the parameter from `_global.yaml`.
2. If the parameter was intended for a future feature, move it to a "roadmap" document or feature branch rather than shipping it in the default config.

**Priority:** 9


---


## Trailing slash in configure task URL
**Framework:** Dead code and abandoned features  
**Files:** `tasks/configure.yaml`

The `configure` task sets the Magento base URL with a trailing slash: `'http://{{ get "host" }}:{{ get "port" }}/'`. Magento's `setup:store-config:set` typically expects base URLs without trailing slashes, and the rest of the codebase (e.g. `install.yaml`) omits the slash. This inconsistency suggests the slash is a typo or copy-paste error rather than intentional.

**Severity:** 🟢 **LOW**  
**Effort:** 2 hours | Complexity: Low  
**Recommended fix:**
1. Remove the trailing slash from the base URL template in `configure.yaml` to match the `install.yaml` pattern.
2. Test `magento configure` to ensure Magento accepts the URL without a trailing slash.

**Example:**
```yaml
# Before — trailing slash
--base-url='http://{{ get "host" }}:{{ get "port" }}/'

# After — consistent with install.yaml
--base-url='http://{{ get "host" }}:{{ get "port" }}'
```

**Priority:** 10


---


# ⚡ FAULT LINES

## Stale service definitions after binary upgrade
**Framework:** External integrations and contracts  
**Files:** `main.go`

The `extractYamlToTemp` function writes embedded service YAML files to `.magento-cli/tmp/services/` on every invocation, but there is no version check or invalidation mechanism. If a user upgrades the `magento-cli` binary (e.g. via `brew upgrade`) while an old `.magento-cli/tmp/` directory exists from a previous run, the tool will continue using the old service definitions until the user manually deletes `.magento-cli/tmp/`. This can cause subtle mismatches between the binary's expectations and the actual docker-compose configuration.

**Severity:** 🟡 **MEDIUM**  
**Effort:** 8–12 hours | Complexity: Medium  
**Recommended fix:**
1. Embed a version identifier (e.g. the git commit hash from build-time variables) in the binary.
2. Write a `.magento-cli/tmp/.version` file during extraction containing the embedded version.
3. At startup, check if `.magento-cli/tmp/.version` matches the current binary version. If not, delete `.magento-cli/tmp/` and re-extract.
4. Add a test case that simulates a version mismatch and verifies the stale directory is cleaned up.

**Priority:** 11


---


## Deferred cleanup fails on panic or kill signal
**Framework:** Error handling and failure modes  
**Files:** `main.go`

The `rmTemp()` function uses `defer os.RemoveAll(tempDir)` at the end of `main()`. If `cmd.YAML(yaml)` panics or the tool is killed via SIGKILL mid-execution, the deferred cleanup will not run, leaving `.magento-cli/tmp/` directories littering the filesystem. Over time, these orphaned directories accumulate, wasting disk space and potentially causing confusion when users inspect the `.magento-cli/` directory.

**Severity:** 🟢 **LOW**  
**Effort:** 6–10 hours | Complexity: Medium  
**Recommended fix:**
1. Move the temp directory creation to a function that registers a signal handler (SIGINT, SIGTERM) to clean up on exit.
2. Alternatively, change `tempDir` to a unique name per invocation (e.g. `.magento-cli/tmp-<pid>-<timestamp>`) and add a startup routine that deletes any `tmp-*` directories older than 24 hours.
3. Add a `magento clean` command that explicitly removes stale temp directories, so users can reclaim space manually.

**Priority:** 12


---


## Silent skip of unreadable config overrides
**Framework:** Error handling and failure modes  
**Files:** `main.go`

In the `loadYaml` function, the code silently ignores `ioutil.ReadFile` failures when reading `.magento-cli/*.yaml` override files. A missing or unreadable file (e.g. due to permissions or corruption) will be skipped with no warning to the user. If the user intended to override a critical parameter (e.g. database password) and the override file is unreadable, the tool will fall back to the default, potentially causing the user to connect to the wrong database or use weak credentials.

**Severity:** 🟡 **MEDIUM**  
**Effort:** 3–5 hours | Complexity: Low  
**Recommended fix:**
1. Change the `content, _ := ioutil.ReadFile(...)` line to check the error explicitly.
2. If the error is `os.ErrNotExist`, skip the file silently (this is expected for directories without overrides).
3. For any other error (permissions, I/O), log a warning: `log.Printf("Warning: failed to read override %s: %v", f.Name(), err)`.
4. Add a test case with a read-protected override file and verify the warning is emitted.

**Example:**
```go
// Before — error silently ignored
content, _ := ioutil.ReadFile(configDir + f.Name())
data = data + string(content) + "\n"

// After — errors logged
content, err := ioutil.ReadFile(configDir + f.Name())
if err != nil {
    if !os.IsNotExist(err) {
        log.Printf("Warning: failed to read override %s: %v", f.Name(), err)
    }
    continue
}
data = data + string(content) + "\n"
```

**Priority:** 13


---


## Testmode global variable without synchronization
**Framework:** Concurrency and race conditions  
**Files:** `main.go`, `main_test.go`

The `testMode` global variable is read in `main()` and written in `TestMain()` without synchronization. While the current test suite is single-threaded, this is a footgun if tests become concurrent in the future (e.g. via `go test -parallel`). A data race would cause unpredictable behavior, such as `cmd.YAML(yaml)` executing in some test runs but not others.

**Severity:** 🟢 **LOW**  
**Effort:** 4–6 hours | Complexity: Low  
**Recommended fix:**
1. Replace the `testMode` global with an environment variable (e.g. `MAGECLI_TEST_MODE=1`).
2. Check the environment variable in `main()` instead of reading a global.
3. Set the environment variable in `TestMain()` using `os.Setenv("MAGECLI_TEST_MODE", "1")`.
4. This eliminates the shared mutable state and makes the code race-free.

**Example:**
```go
// Before — global variable
var testMode = false
func main() {
    if !testMode { cmd.YAML(yaml) }
}

// After — environment variable
func main() {
    if os.Getenv("MAGECLI_TEST_MODE") == "" { cmd.YAML(yaml) }
}
```

**Priority:** 14


---


## 📊 REMEDIATION SUMMARY

| Category | Count | Est. Hours | Complexity | Est. Cost |
|----------|-------|-----------|------------|-----------|
| 🔴 Red Flags | 6 | 22–37 hrs | Mixed | $3,320 – $5,740 |
| 🏛️ Landmarks | 2 | N/A | N/A | N/A |
| ⚰️ Dead Zones | 3 | 6 hrs | Low | $510 |
| ⚡ Fault Lines | 5 | 24–38 hrs | Mixed | $3,260 – $5,460 |
| **TOTAL** | **16** | **52–81 hrs** | | **$7,090 – $11,710** |

**Recommended fix order:**
1. **Hardcoded default admin password** — Immediate security risk; trivial to exploit on default installs — Est. 2–4 hours @ $200/hr = $400 – $800
2. **Admin credentials exposed in process listings** — Leaks secrets to local attackers; fix before documenting install flow — Est. 6–10 hours @ $125/hr = $750 – $1,250
3. **Path traversal in config override loading** — Arbitrary file read vulnerability; fix before publicizing override feature — Est. 4–6 hours @ $200/hr = $800 – $1,200
4. **Unquoted docker project name allows shell injection** — Shell command injection; quick win to eliminate entire class of risk — Est. 2–4 hours @ $200/hr = $400 – $800
5. **End-of-life Elasticsearch image** — EOL software exposes users to CVEs; quick default change — Est. 2–3 hours @ $200/hr = $400 – $600
6. **Silent failure in config file extraction** — Partial config failures cause cryptic errors; quick fix improves debuggability — Est. 3–5 hours @ $125/hr = $375 – $625
7. **Hardcoded 3-second service startup delay** — Reliability issue; fix before docs tell users to rely on `up` — Est. 6–10 hours @ $125/hr = $750 – $1,250
8. **Unused yamlExt variable** — Dead code cleanup; quick win — Est. 2 hours @ $85/hr = $170
9. **Orphaned php-bin-path parameter** — Dead code cleanup; quick win — Est. 2 hours @ $85/hr = $170
10. **Trailing slash in configure task URL** — Cosmetic inconsistency; quick fix — Est. 2 hours @ $85/hr = $170
11. **Stale service definitions after binary upgrade** — Silent config drift after upgrades; fix before v1.0 — Est. 8–12 hours @ $125/hr = $1,000 – $1,500
12. **Deferred cleanup fails on panic or kill signal** — Filesystem litter; low urgency but fix before scale — Est. 6–10 hours @ $125/hr = $750 – $1,250
13. **Silent skip of unreadable config overrides** — Silent config failure; low urgency but fix for debuggability — Est. 3–5 hours @ $125/hr = $375 – $625
14. **Testmode global variable without synchronization** — Future-proofing for concurrent tests; low urgency — Est. 4–6 hours @ $125/hr = $500 – $750

**Risk if left unaddressed:** Default installs will ship with trivially guessable admin credentials and leaked database passwords, exposing users to account takeover and data exfiltration on day one.

---

*Generated by Ghost Architect — AI-powered codebase intelligence*  
*ghostarchitect.dev*
