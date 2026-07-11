# Changelog

All notable changes to Ghost Architect™ are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to semantic versioning.

## v11.0.3 -- July 10, 2026

### Audit 11 Remediation: Renewal Recovery Copy, Forecast Sidecar Parity, Revocation Read Routing, Session Listing Wired

**Ship blockers**
- The expired and revoked profile paywall boxes include the ghost --activate step. Both told a lapsed customer to renew or resubscribe with only a pricing link, but neither action restores access on its own: the revocation verdict is sticky until a fresh activation rewrites the record, and an expired token's hard stop is baked into its signed payload, so a customer who followed the box's instructions hit the same wall again. Both boxes now mirror the main-flow banner's "run ghost --activate with your new key" copy.
- Commit Forecast uses the reconciled Blast Radius report instead of the mid-narration draft. Both single-pass call sites discarded runBlastRadius's return value, which carries the reconciled cap disclosure, and no forecast path passed onSidecarFindings even though the multipass synthesis sidecar branch was built for it: on a change set past the narrator's cap, the saved forecast promised a complete findings sidecar while meta.findings held only the narrated subset. All four blast invocations (single-pass and multipass, interactive and non-interactive) now wire the sidecar callback through, and both save blocks prefer the full sidecar set for meta.findings, falling back to report parsing when the callback never fired.
- Revocation cache reads are license-aware, completing the v11.0.2 write routing. getRevocationCache always returned the installed record's entry when one existed, making the standalone slot write-only on a machine running an env-var license alongside an installed one: the env-var license's sticky revoked verdict was unreadable, so it re-probed the worker every run and failed open when the worker was unreachable. Reads now check both slots and return the entry whose license_id matches; the no-argument form keeps the legacy behavior for callers with no lid in hand.
- Activating or clearing a license only deletes the standalone revocation verdict when it belongs to that license. Both paths deleted the slot unconditionally, so activating or clearing installed key A erased env-var key B's sticky revoked verdict. The verdict now survives when both lids are known and differ; the delete still happens whenever ownership cannot be determined, preserving the resubscribe guarantee.

**Revenue and trust**
- New --list-sessions flag lists every resumable scan session with its label, pass progress, and start time, reading both the primary and OS-temp fallback session directories. The dual-directory enumeration shipped in v11.0.2 had no caller, so a fallback-directory session was resumable by label yet invisible to the user. Documented in --help under Session recovery.
- Watcher resume delivery is idempotent. If a delivered batch's record clear silently failed, the next run re-resumed the same batch, added its token usage to the portal figure a second time, and re-sent the PR comment and completion email. The delivery now stamps the batch id into the commit state's resumedBatchIds; a record whose batch is already stamped retries only the clear.
- A prompts record whose brief regeneration fails deterministically no longer emails "resume detected" on every subsequent run for up to 29 days. The record carries a regenAttempts counter; the first detection still emails, later retries run silently.
- ghost --export-ci-token prints a second stderr advisory when the exported token's tier is below the Max plans, since Ghost Brief™ in CI exits 1 on every run with a sub-Max token: the same silent-dead-runner shape the existing Watch advisory covers. The token still exports.
- The Recon report's Total files line shows the repository total instead of the loaded-file count, with an explicit "N loaded for sizing within the context budget" disclosure when the two differ. On a context-capped repo the sizing artifact's headline number contradicted its own meta header. The terminal summary box uses the repository total too, and the smoke test pins the capped, uncapped, and legacy renderings.
- A customer whose license file cannot be read (tampered or invalid state) sees a "License problem" box telling them to re-activate with their original key or contact support, instead of the "Activate a Pro license" purchase pitch for a feature they already own. The degrade mapping gains a 'license-problem' reason in both the startup resolve and the mid-session refresh, and the Reconfigure menu's license row shows it.
- The Reconfigure menu's GitHub token row distinguishes "(not set)" from "(bad credentials: needs update)". A fresh install with no token stored read as broken credentials.

**Technical**
- reconMetaCost prefers observed spend unconditionally. The planner reports usage on a successful API response before parsing it, so a billed-but-unparseable model response arrived with plannerFailed set and real spend, and the $0.0000 stamp under-reported actual billing on a sales-facing artifact: the same accuracy class the v11.0.2 fix targeted, in the opposite direction. A new smoke test case pins the billed figure winning over the flag.
- Per-pass cap-disclosure lines are stripped when the synthesis input is built, not only on the salvage path. The synthesizer could copy a per-pass disclosure into its output, where the reconciler rewrites only the first occurrence, leaving a second line pointing at a per-pass findings file that is never written on the multipass path.
- The double-failure path (verifier throws and the fallback sidecar also throws) logs what happened and strips the narrator's stale pre-verification disclosure instead of silently shipping a promise of findings that exist nowhere. Previously that inner catch swallowed without a trace and the regeneration gate never fired.
- The Recon full-scan cost estimate scales its per-pass rate by the configured model's pricing via getPricing, the same table the model picker and estimator use. The hardcoded Sonnet-era rate quoted an Opus or Fable configured install a full-scan figure several times below reality on a prospect-facing artifact. The planner and verification overhead estimates scale the same way.
- The watcher resume delivery is gated on the portal state push landing. pushWatchCommitState swallowed failures internally, so a failed push followed by a successful record clear stranded the portal on "Analyzing..." permanently with nothing left to retry. The helper now reports success; on failure the record stays pending and the whole delivery, PR comment and email included, reruns on the next watcher run, kept idempotent by the resumedBatchIds stamp.

**Quick wins**
- README What's New for v11.0.2 says three new test suites, matching what shipped.
- The four resume-path log lines that used em dashes now use colons.
- The Watch-enable cost box renders its dollar ranges with "to" instead of an en dash.
- When the synthesis output yields zero parseable findings, any cap-disclosure lines are stripped from it, since the warning on the same path just said no sidecar will be written.
- The stale comment claiming a setScanOptions call "right after parseArgs" (refactored away when the CLI overrides moved to a stash) now describes the actual seeding order.
- Session recovery messages report the pass the scan continues at instead of the completed count ("Resuming from pass 6 of 16" after 5 completed passes, not "pass 5").
- The pending-batch round-trip test documents that its source sweep covers watcher-commit.js, today's only storePendingBatch call-site file, and must be extended if a call site appears elsewhere.
- The headless profile paywall exits 1 on every refusal branch instead of 0, so scripted profile management no longer treats a revoked or expired license as success. Documented in place as a deliberate contrast with Ghost Watcher™'s never-block-a-commit exit 0.
- The non-timeout resume failure's fallback state carries tokenUsage and blastRadiusObservations with safe defaults, matching the shape Step 8b writes.
- A Blast Radius failure inside a Commit Forecast shows the partial COST BREAKDOWN for what was billed before the failure, on all four catch paths, matching the conflict scan's behavior. The spend already landed in meta.cost; now the screen agrees.

## v11.0.2 -- July 10, 2026

### Audit 10 Remediation: Recon Disclosure Made Live, Resume Coverage Honesty, Renewal Copy, Pending-Record Integrity

**Ship blockers**
- The Recon planner-failure fix shipped in v11.0.1 is now live. generatePlan set plannerFailed on its structural fallback, but runRecon builds its return object field by field and never copied the flag, so recon.js could never see it: a failed planner run still stamped $0.0500 of spend on the sales-facing artifact and presented heuristic output as live analysis with no disclosure. runRecon now propagates the flag, and a new smoke test (recon-planner-failed) drives the real failure path end to end: flag propagation, the $0.0000 stamp, and the structural-fallback disclosure in the saved markdown.
- An expired paying customer using the headless profile flags (--list-profiles, --set-default-profile, --create-profile) now sees renewal guidance instead of "Activate a Pro license to use profiles." The degrade-reason mapping gains an 'expired' state for non-trial hard stops (both the startup resolve and the mid-session refresh), the profile paywall branches on expired, revoked, and trial-ended reasons with the recovery action that actually applies, and the Reconfigure menu's license row shows the expired state with a renewal pointer.
- A failed brief regeneration during a prompts-batch resume no longer announces "detailed remediation prompts ready" with zero prompts. The old path stamped 'complete' with prompts: 0 over the nonzero basic-brief count Step 8b recorded, then cleared the pending record so nothing ever retried, leaving the customer a permanently empty Brief tab. The record is now left pending and the state untouched; the next run re-polls the batch (retrieval is free) and retries the regeneration, bounded by the 29-day batch expiry.

**Revenue and trust**
- The capped-report executive-summary regeneration also fires when the verifier errored. The gate required a verifier report card, but the verifier-failure path builds the unverified sidecar and reconciles the disclosure while leaving the card null, so page one could read "identified 28 findings" two lines above "All 65 findings ... in the accompanying .findings.json file" on exactly the runs that most need self-consistency.
- A resume that fails for a reason other than a timeout (batch expired past 29 days, all requests failed, deterministic API error) writes an honest 'incomplete' state for the original commit before clearing its pending record. It previously cleared the record and wrote nothing, so the portal showed "Analyzing..." for that commit forever with nothing left to retry.
- The multi-pass Blast synthesis-failure fallback strips every per-pass cap-disclosure line before concatenating the unmerged reports. Each pass could carry its own "All N findings ... in the accompanying .findings.json file" line, but no sidecar is written on the salvage path, so the deliverable promised findings files that exist nowhere.
- Session listing enumerates the OS-temp fallback directory as well as the primary one, deduplicated by label with primary winning. A scan that could only checkpoint to the fallback (full Reports volume, permission flip) was resumable by label yet invisible to any listing, reading as "my scan is gone."
- Forced session recovery (--recover-session) applies to exactly one load. The flag was never cleared, so every later load of the same label in the same interactive session also bypassed intact session files and reported "could not be recovered ... Starting fresh," defeating the rerun-without-the-flag advice Ghost itself prints.

**Technical**
- Pending watcher batch records survive the read-back intact. retrievePendingBatches returns records through a field whitelist that never mapped batchIds or changedFiles, so the multi-chunk conflict resume always fell back to polling chunk 1 and silently dropped chunks 2..N (the v11.0.0-era every-chunk fix was inert on the read side, and the v11.0.1 partial-chunk record was stored but never read back), and every blast resume narrated with an empty changed-file list. Both fields now map through, and a new round-trip smoke test (pending-batch-roundtrip) stores a record carrying every field any call site writes, asserts each survives retrieval, and sweeps the watcher source so a field added at a store site without a matching map entry fails the build instead of vanishing.
- Resumed scan results no longer overstate coverage. Pending records persist an expected-scans snapshot (which of blast and conflict the original run was going to perform) and a partial marker on records holding only the chunks that survived a submission failure. A resume covering less than the expected set writes 'incomplete' with an explanatory message instead of 'complete', notes the coverage gap in the PR comment, and leaves the consecutive-incomplete-run counter intact so the three-strikes setup warning still fires. Legacy records keep the old behavior.
- The scan-batch resume adds its usage to the commit's recorded token totals instead of overwriting them, matching the prompts-resume fix from v11.0.1: a blast completion whose tokens Step 8b persisted no longer loses them when the conflict resume rewrites the state.
- Non-interactive Commit Forecast meta carries the four severity counts and totalHours, computed exactly as the interactive save block does. The mobile-publish scan record reads those fields directly, so a scripted Team-tier forecast published zeroed severity data to Ghost Mobile™ while the findings sidecar beside it carried the real counts.
- Exact-title sidecar dedupe treats one-side-empty file lists as overlap, so the narrator-polish twin (the detailed copy carries files from the rendered report's Files line, its raw twin carries none) collapses to one entry instead of shipping twice and over-counting the disclosure. The stricter shared-file rule stays on the fuzzy containment branch, preserving the distinct-modules protection, and a new smoke test (sidecar-dedupe) locks in both behaviors.
- Both Commit Forecast surfaces own their conflict cost tracker and pass it into runConflictScan, matching the blast pattern, so a conflict scan that throws mid-run (rate limit between passes, API error during verification) still lands its already-billed passes in meta.cost and shows them in the COST BREAKDOWN. The old result.tracker read only existed on success, contradicting the "failed scans still add their partial spend" comment beside it.
- The early tier resolve consults the offline sticky revocation cache. skipRevocationCheck also skipped that cache, so a cancelled customer with a cached revoked verdict resolved as valid and kept paid-tier profile flags until hard stop, roughly 36 days, while the 'revoked' arm of the degrade mapping was unreachable. The cache check is synchronous and offline, so --help and --version stay fast.
- Multi-pass Blast logs one warning when a non-empty synthesis yields zero parseable findings (previously indistinguishable from a clean scan when format drift broke the parser) and logs the error when the sidecar build throws instead of swallowing it. Observability only; the report still ships.
- A revocation verdict for an env-var license on a machine with a different installed license routes to the standalone cache key instead of overwriting the installed record's cached verdict. Key A no longer loses its sticky verdict and TTL to key B's CI run, and key B's verdict lands where its env-var contract reads it.

**Quick wins**
- ghost --export-ci-token prints a stderr advisory when the exported token's tier is below Team, since Ghost Watcher™ CI scanning requires Team or above and exits advisory on every commit, so a Pro token previously configured a runner that silently never scanned. The token still exports.
- The Blast Radius COST BREAKDOWN itemizes plan, scan, and narrate stages the way Conflict Detection does, instead of collapsing all spend into one row.
- The lone temperature 0.3 in multi-pass synthesis is documented in place as the deliberate historical value for long-form narrative synthesis; every analysis and verification surface remains at 0.
- Dead code removed: the unused isWarning import left by the v11.0.1 export-ci-token rewrite, and the ignored 'blast' string argument to extractFindings in the analyst (the same dead-argument pattern removed from the watcher in v11.0.1).
- package-lock.json regenerated: it was roughly 30 releases stale, still naming ghost-architect at 9.4.40.

## v11.0.1 -- July 10, 2026

### Audit 9 Remediation: Model-Aware Sampling Sweep, CI Token Integrity, Ghost Watcher™ Contract Fixes, Cost Accuracy

**Ship blockers**
- Sonnet 5, Opus 4.8, and Fable 5 no longer fail Conflict Detection, multi-pass synthesis, Recon planning, Executive Brief, the agent loop, quick verification, and the LLM verifier. Seven call sites passed a hardcoded temperature these models reject with HTTP 400 (conflict.js, multipass.js, planner.js, loop.js, llm-verifier.js, executive-brief.js, verifier.js); all seven now route through getSamplingParams, the same model-aware guard the other six call sites already used. The sampling-params smoke suite gains a source sweep that fails the build if a bare temperature literal reappears outside sampling-params.js.
- ghost --export-ci-token validates the exact stored token it exports. It previously validated via validateLicense(), which prefers the GHOST_LICENSE_KEY env var, so on a machine with the env var set (the documented supported scenario) a revoked stored token could pass validation and export a dead token to CI, and a stale env token could block a healthy export. The flow now decodes and verifies the record token directly, checks its hard stop and revocation (fail-open), and keeps stdout token-only with all guidance on stderr.
- A malformed skip_if_message_contains value in ghost-watcher.yaml (a scalar instead of a list, or non-string entries) no longer throws and exits nonzero, which blocked the customer's commit in violation of the watcher's never-block contract. The value is normalized to a string list before use.
- The prompts-batch resume no longer upgrades an 'incomplete' or 'cancelled' commit state to 'complete'. Only a state that was 'pending' or already 'complete' may read 'complete' after detailed prompts arrive; anything else keeps its status and message, so a run whose conflict scan failed can no longer flip to a false green when its prompts batch resumes.

**Revenue and trust**
- ghost --reconfigure is a real flag: it opens the Reconfigure menu (API key, GitHub token, license, scan model) directly and is documented in ghost --help. Three customer-facing recovery messages (pending-batch API key advisory, both context-cap clamp notices) pointed at the flag while parseArgs rejected it with "Unknown flag: --reconfigure (ignored)".
- A cancelled customer whose first run after cancelling comes after hard stop now gets the resubscribe copy instead of expiry copy with a re-activation hint that cannot work for a revoked key: the grace/expired revocation probe no longer stops at the hard-stop boundary. Same fail-open contract, 24-hour TTL cache; on any network fault the hard-stop behavior is unchanged.
- Commit Forecast saves stamp the run's real tracked spend into meta.cost on both the interactive and non-interactive surfaces, so the saved artifact records what the on-screen COST BREAKDOWN boxes showed instead of carrying no cost at all. Omitted when zero, matching the batch-retrieve convention.
- Recon stamps $0.0000 instead of the $0.0500 estimate when the planner call failed and nothing was billed, and the saved report discloses that the sizing used structural heuristics rather than a live analysis.
- A zero-findings Executive Brief shows 0 AI-assisted hours instead of "~1 hrs" beside 0 manual hours and $0 estimated cost.
- The "Both --stream and --batch were passed" notice moved to stderr so it can never prefix the token in a piped ghost --export-ci-token invocation.

**Technical**
- Conflict chunks submitted before a mid-loop submission failure are persisted as a pending record for the next run's resume instead of being orphaned: they were live and billed on the Batches API but never stored, never polled, never resumed. The failing run still reports incomplete rather than presenting partial chunk coverage as a finished scan.
- Checkpoint writes are atomic (tmp file plus rename, mirroring session persistence), so a crash mid-write can no longer corrupt the salvage artifact whose sole purpose is surviving crashes. A checkpoint missing its timestamp now fails the 24-hour staleness gate instead of passing it forever (NaN compared false against the age limit).
- Re-activating or clearing a license also deletes the standalone (env-var/CI) revocation cache entry, extending the "re-activation must not inherit the old verdict" guarantee to both storage paths. A customer whose revocation was reversed by support could previously stay sticky-blocked on the machine that had cached the verdict.
- Blocking-state licenses (hard-stopped, tampered, invalid) degrade to Open at the early tier resolve, mirroring the session-refresh degrade. The profile-management flags (--list-profiles, --set-default-profile, --create-profile) exit before the main enforcement gate and previously kept paid-tier access on such licenses indefinitely.
- The prompts-batch resume adds its usage to the commit's recorded token totals instead of overwriting them, so the portal's per-commit cost keeps the blast and conflict spend after a prompts resume.
- The executive-summary regeneration gate also fires on capped-but-clean scans (the sidecar carries more findings than the body details), so the page-one summary agrees with the cap disclosure even when the verifier changed nothing.
- Exact-title sidecar dedupe requires file overlap, matching the v11.0.0 containment fix: identical generic titles in different modules are distinct findings and no longer collapse silently. Findings with no file info on either side still collapse (the narrator-polish case).
- Four narrator prompt builders guard confidence with Number.isFinite, so a legitimate confidence of 0 no longer renders as "Confidence: 90%" in the prompts fed to the model.
- Multi-pass Blast fires onSidecarFindings with the finding set extracted from the synthesis output and reconciles its cap disclosure, so multipass Commit Forecast reports carry the same findings sidecar single-pass runs get. The synthesis-failure fallback path deliberately fires no callback (the concatenation carries cross-pass duplicates).
- The Blast planner preview call is recorded in the session cost tracker under a 'plan' stage; it was a real billed API call that appeared in no COST BREAKDOWN and no meta.cost.
- Pending watcher batch records persist the original run's branch and developer, and resumes stamp those onto the original commit's portal state instead of the resuming run's identity, protecting the branch-filtered finding-lifecycle delta. Legacy records fall back to current values.
- Ghost Brief™ telemetry reports intent with the same gates Step 8 applies (Max tier and a non-empty finding set) instead of the bare config flag, which overstated brief usage in Pulse.
- Dead code removed: the unused --watcher-commit parseArgs branch (the module-level dispatch reads process.argv directly and always exits), a vacuous always-true PAT prompt validator in Enable Watch, and a dead 'blast' argument to extractFindings in the watcher. The forced-recovery failure message no longer claims previous progress is lost when an intact main session file may still exist on disk.

## v11.0.0 -- July 10, 2026

### Major: Audit 7 + Audit 8 Remediation. Checkpoint Salvage Integrity, Watch Paywall Honesty, Cancel-Coast Closure, Input Parity, CI Token Export, Session Refresh

**Audit 8 ship blockers**
- Checkpoint salvage no longer corrupts recovered findings. The pass loop checkpoints merged groups as plain strings, and the merge template read .fileCount/.findings off every entry, so any salvaged scan of six or more passes rendered its already-merged findings as the literal string "undefined" while telling the user their API spend was recovered. writeCheckpoint now wraps string entries as structured merged-group records, salvage normalizes pre-v11.0.0 checkpoints on read, and the merge formatter (formatPassResultsForMerge, exported for testing) renders every shape. New checkpoint-salvage smoke suite pins the contract end to end.
- The upgrade paywall's free-trial CTA now renders only where the trial actually unlocks the gate. paywallFor() carries a trialUnlocks flag derived from the tier policy table, and the renderer also suppresses the trial pitch for users already on a paid tier or on the trial itself. The Ghost Watcher™ paywall previously pitched a 7-day Pro Max trial that re-blocked the user at the identical paywall, at the highest-intent moment in the Team funnel. The "Or upgrade at" line adjusts when the trial CTA is absent. New paywall-trial-cta smoke suite.
- Activating an expired or revoked signed token no longer prints a green "License activated" box and then silently runs the session as Open. The signed-token path validates after saving and prints a yellow "License saved, but it is not currently usable" box with the validator's own recovery guidance; the reconfigure flow adds a line stating the session remains on the Open tier and how to restore access.

**Audit 8 revenue and trust**
- README: the 145-line Ghost Watcher™ setup section moved above the License block. It sat below the copyright footer, where anyone skimming npm or GitHub concluded the flagship Team feature had no docs. The Ghost Triple Crown™ opener now says "up to three passes" and names the Max-plan requirement up front instead of retracting the claim eleven lines later. The Sonnet 5 picker blurb ties "least expensive" to the introductory-pricing window that ends Aug 31, 2026. The last two en dashes are gone, and four bare Ghost Architect mentions gained their ™ (README, the Reconfigure menu label and submenu prompt, and the package.json copyright, fixed as pairs so docs and UI stay in sync).
- The --batch "streaming at standard rates" notice now also fires for Commit Forecast, Fix Forecast, and Executive Brief; users expecting half-price batch on those modes previously paid full price with zero notice.
- Ghost Watcher™ exits cleanly with "nothing to scan for this commit" when every scan is disabled or skip-patterned, instead of posting a red "could not complete this scan" PR comment and writing a permanent incomplete portal state for a configured outcome. Scan enablement is now computed once, above the Batches preflight, and shared by the preflight (which no longer burns a preflight batch for a run that submits nothing), the pending state, both scan steps, the completeness accounting, and the telemetry ping, which previously reported skip-patterned blasts as run.
- The watcher resume path applies the same action/observation split as fresh runs across the commit state, the PR comment (with a separate no-action-required observations line), and the resume-complete email; a customer whose CI run timed out previously got "N findings require your attention" for pure impact observations.
- The prompts-batch resume no longer overwrites the completed commit state: it merges into the state Step 8b wrote (new fetchWatchCommitState helper), preserving the detailed findings, observations, verified set, and lifecycle fields it previously replaced with an empty findings list and observation-inflated counts. The pending record itself now stores action-only counts.
- Batch-retrieved Blast reports stamp the real billed cost into the saved meta: the scan portion priced from the retrieved batch usage at batch rates plus the retrieve-time narrator spend at streaming rates. The submit path stores the model so retrieve can price it. The batch artifact previously shipped a blank Analysis Cost row and the narrator call was billed with no line item.
- On capped scans, the regenerated executive summary counts the full sidecar set ("identified 65 findings; the top 28 by severity are detailed below") instead of contradicting the cap disclosure two lines below it on page one.
- Full-mode conflict verification prints each verdict line once; the duplicate onVerified emission inside verifyOne is removed and the batch loop is the single emitter for both modes.
- A revoked license past its hard stop now gets the resubscribe copy instead of expiry copy with a "run ghost --activate <your key>" hint that cannot work for a revoked key.
- ghost --export-ci-token validates the stored token before exporting: a revoked, hard-stopped, or invalid token exports nothing (stderr guidance, exit 1), and a grace-window token exports with a renew-soon advisory. Stdout still carries the token and nothing else. The flag is now documented in ghost --help.
- Revoked and trial-ended sessions fetch the worker-driven promo text, so the highest-intent re-conversion audience sees the same paywall promos as never-paid Open users; the comment claiming degraded states never reach the paywall renderers was wrong and is corrected.
- The double-wrapped quota error ("Scan quota update failed: Quota counter update failed. Please contact support@ghostarchitect.dev if this persists.. Check disk space...") shown to Open users right after a successful forecast is gone; the counter's single customer-ready error propagates untouched.

**Audit 8 technical**
- Cancel-then-coast is closed. The validator's grace and expired branches now probe revocation (same fail-open contract, 24-hour TTL cache, no probe past hard stop) when no cached verdict exists, so a customer who cancels and never runs Ghost before token expiry no longer keeps full paid-tier access through the entire grace window.
- One per-file size policy across all three input methods: oversized files are truncated with a visible marker everywhere. ZIP and GitHub loads previously skipped files over roughly 200KB silently while the directory walk truncated at 120K characters, so the same repo produced different file sets, findings, and costs depending on how it was fed to Ghost. The nested .env.example exception (under a dotted parent directory) now also matches across all three paths.
- runMultipassBlast uses runBlastRadius's post-processed return value instead of only the streamed chunks, so completeness-patcher splices (which are never streamed) and reconciled cap disclosures reach multipass Commit Forecast reports; onSidecarFindings is plumbed through on the single-pass path, and the raw "Single-pass scan, skipping batch synthesis" debug line is removed from customer output.
- Resumed conflict batches run the same finishing pipeline as fresh runs via a shared helper: the self-refuting filter always applies, and the opt-in quick verifier applies when codebase context is loaded. A timed-out CI job previously produced more findings, including model-admitted noise, than the same commit scanned fresh.
- Non-interactive Commit Forecast wraps the conflict scan in the same protective catch the interactive path has, so a transient API error no longer destroys the completed, already-billed blast output on the scripted/CI surface.
- Sidecar containment dedupe now requires file overlap in addition to title containment, so a generic detailed title ("missing error handling") can no longer silently swallow distinct verified findings in other files; findings with no file info on either side still collapse (the narrator-polish case).
- The Executive Brief PDF renderer escapes <, >, and & in the narrative before ReportLab parses it; any "< 30 days" in the LLM output previously failed the entire brief. New executive-brief-pdf smoke suite drives the real python3 renderer with hostile input and skips cleanly where reportlab is absent.
- The revocation cache persists under a standalone configstore key for env-var (CI) licenses, so the 24-hour TTL and the sticky-revoked guarantee now hold on CI runners, which previously re-probed on every gated run and could never stick a revoked verdict.
- Fix Forecast gains a dispatch-level quota gate (with its own paywall) before the telemetry ping, matching Commit Forecast, so paywalled Open selections stop inflating Pulse's mode-usage numbers.
- Checkpoint salvage honors readCheckpoint's 24-hour staleness gate, which was dead code; a stale checkpoint now logs why it was skipped instead of "recovering" weeks-old work.
- session-refresh and the startup degrade re-seeds spread the resolved tier last, so no overrides object can ever defeat the freshly validated tier. GHOST_CLOCK_TOLERANCE parses with an explicit radix and a Number.isFinite guard, warning and falling back to the 300-second default instead of a NaN silently disabling the rollback rejection. A mid-session refresh landing on a missing license clears the stale degrade reason instead of showing "revoked" for a machine with no license installed.
- The cap-disclosure rewrite regex matches a fully de-italicized disclosure line (trailing emphasis is now optional, like the leading anchor), with a regression case added to the cap-disclosure suite.

**Audit 8 quick wins**
- Recon: declining the save prompt now offers the unsaved-report recovery path like every sibling mode instead of silently discarding the engagement-plan prose, and the saved artifact's Analysis Cost row shows real planner spend (the fixed $0.0500 remains only as the fallback when usage is unobservable). Inheritance Audit: a failed save offers the unsaved-report recovery while the report content is still in hand.
- ghost batch-status applies the same 29-day retention prune and 404 removal as the menu path, and no longer says "check again in a few minutes" about batches that are permanently gone. Pending-batch menu rows explain a missing API key in one actionable line instead of rendering "checking..." forever. The batch-retrieve fallback copy now names Question alongside Blast Radius.
- Windows rendering: the Ghost Partner Profile row shows the same tier-aware suffix as other platforms, and the profiles submenu, pending-batch rows, and first-run Open notice route through the IS_WINDOWS/SYM conventions.
- Commit Forecast's pre-commit meta records the real working-tree root instead of a ghost-precommit staging temp dir that is deleted before the save prompt fires. Dead code removed: listReports() (zero callers; would have double-listed every report) and an unused model read in the non-interactive forecast runner. Verified, no fix needed: the v10.0.18 dead-code sweep in the non-interactive forecast left no dangling token-usage references; its cost surfaces run entirely through session cost trackers.

**Audit 8 tests**
- Three new suites wired into npm test: checkpoint-salvage (string merged groups render intact, no "undefined", legacy checkpoints normalize), paywall-trial-cta (Watch paywall renders no trial pitch; trial-eligible gates keep it; paid tiers never see it), and executive-brief-pdf (real renderer, narrative with <, >, and &). The cap-disclosure suite gained the de-italicized variant. Full suite green at every group boundary.

### Audit 7 Remediation (same release): CI Token Export, Session Refresh, Enterprise Totals Migration, Sidecar On All Paths

**Ship blockers**
- New `ghost --export-ci-token` command prints the installed signed license token to stdout (pipe-safe; guidance goes to stderr) for CI secret setup. Ghost Watcher™ and Ghost Brief™ now detect a GA- license key in GHOST_LICENSE_KEY up front and print exactly how to fix it, pointing at the new command; the watcher stays advisory (exit 0) and Ghost Brief™ stays fail-closed (exit 1). Previously every doc surface told customers to set the GA- key itself, which the validator can never verify, so the Team tier's flagship feature silently skipped every commit. The README secrets table, the Enable Watch next-steps copy, and the GitHub Actions template header now all document the export command. A runtime key-for-token exchange was evaluated and deliberately NOT built: the license worker re-mints tokens only for the activating machine's hardware fingerprint, so a CI exchange would fail for activated licenses and would permanently bind a pending license to a throwaway runner.
- License changes now take effect mid-session. A new refreshLicenseSession() (src/license/session-refresh.js) re-validates, updates the active session, and re-seeds the loader's tier cap in one call; it runs after in-menu activation (with a confirmation line naming the new tier) and after first-run onboarding activation, before the setup wizard. Previously "License activated" printed while the banner, every tier gate, and the context cap kept treating the customer as Open until restart, and the wizard persisted the Open 50K cap into config for brand-new paying customers. A blocking validation result degrades the session to Open instead of granting the payload tier. The startup degrade blocks now re-seed the loader at the degrade site itself.
- resolveContextCap warns when a saved settings value sits below the plan's cap ("Your saved context limit (50,000 tokens) is below your plan's cap (100,000). Run ghost --reconfigure to update it."), closing the silent half-context trap for upgraders carrying an old saved value.
- Enterprise usage totals now migrate correctly. The monotonic totals accumulator introduced in v10.0.17 seeded from zero on pre-totals audit files, and getUsageReport prefers persisted totals, so an org with 800 scans in its window reported one scan after the first post-upgrade write. The first write against a legacy file now seeds the accumulator by summing the existing window's scan events with the same string-cost coercion, which is now a single shared helper. The audit-event state transition is exported as applyAuditEvent for direct testing.

**Revenue and trust**
- GHOST_LICENSE_VERIFY_FORCE=1 can now clear a sticky revoked verdict: a forced probe that gets a fresh non-revoked worker answer overwrites the cache, so support can tell a resubscribed customer "run this once" and it works. Force never fails open; every probe path that learns nothing keeps the sticky verdict, including with GHOST_NO_LICENSE_VERIFY=1.
- The revoked message, the revoked degrade box, and all three expiry states now name the actual recovery: run ghost --activate with your key. A still-paying subscriber whose token aged out was previously sent to the pricing page with no hint that re-activation restores access.
- A license with a cached revoked verdict no longer keeps full paid access through its grace window; the validator consults the sticky cache (offline-cheap, no network) before returning grace or expired.
- The Reconfigure menu's license row now reads live session state on every render and carries the degrade reason, so a cancelled customer sees "revoked: run ghost --activate <key> to restore" instead of "open: unknown", and the row updates immediately after an in-menu activation.
- The five Ghost Watcher™ menu rows and the Ghost Partner Profile row are selectable at every tier with a gray plan suffix, gated at dispatch with a real upgrade paywall, matching the Brief rows' dead-end fix. The Watcher paywall now says "Ghost Watcher™", not "watch", and Ghost Partner Profiles has a rendered paywall with its own display name. The profile row also tested the global TIER instead of the function's tier parameter; fixed.
- Commit Forecast's decline-save branch now offers the unsaved-report recovery path like POI, Blast, and Conflict, instead of silently dropping the rendered report.
- The Ghost Watcher™ "analyzing" pending state and PR comment now fire for every config that will run at least one scan, before any submission. Conflict-only configs (and release commits matching a blast skip pattern) previously showed nothing until results landed. The blast/conflict/completeness run conditions are derived once and shared.
- The Open quota paywall no longer promises "all modes"; it names what every paid tier actually unlocks. The in-file Audit fallback paywall now leads with the free-trial CTA like every other paywall.
- README top-of-funnel rebuilt: the product pitch is the first thing a visitor reads, one What's New entry remains with a CHANGELOG link, and roughly 330 lines of version-history stubs are gone. The Ghost Triple Crown™ section no longer dangles Pro Max automatic commit scanning (leg 3 requires a Max Watcher plan; Pro Max gets Ghost Brief™ on manual scans). The watcher cost table now quotes Message Batches API pricing, half the old figures, matching the Enable Watch wizard. Inheritance Audit has a full section (what it does, the four analyzers, cost honesty, when to use it, tier). Chat is documented in the mode list and tier table, so the Question-mode upsell points at something a buyer can verify; Ghost Watcher™ has its own tier-table row. The stale "Switch to Claude Opus 4.7" line now describes the real model picker, the Question cost range reflects full-context questions, and every em dash in the README is gone.

**Technical**
- Resumed multi-chunk conflict scans now retrieve every chunk. The pending-batch record persists all chunk batch IDs; the resume path polls each and merges results before extraction. Previously only the first chunk's ID was stored, so exactly the large codebases most likely to time out delivered a "results retrieved" state covering a fraction of the repo.
- Session checkpoint recovery is real: writeCheckpoint is wired into the pass loop next to persistSession, so salvageSessionFromCheckpoints and --recover-session finally have something to read. deleteSession now removes the primary session file, its .bak sibling, and the os.tmpdir() fallback, and clears the checkpoint, so completed or restarted scans stop offering to resume themselves.
- The full-findings sidecar pipeline (split at the narrator's cap, verify the undetailed remainder, dedupe, rewrite the disclosure to the true count) is extracted to src/core/sidecar-pipeline.js and now runs on single-pass POI and on Blast (streaming and batch retrieve), not just multipass. Blast, whose findings are impact analyses with no verifier pass, emits the full raw set with the disclosure reconciled. When the verifier fails, the report now ships the full set unverified with a matching disclosure instead of a stale count over a short sidecar.
- Found during this work, beyond the audit list: the single-pass POI path discarded runPOIScan's return value and saved the chunk-streamed buffer, which is the narrator's PRE-verifier draft. Verifier annotations, false-positive drops, and header scrubbing never reached the saved single-pass report. Both Blast paths had the same shape. All three now prefer the finished return value.
- Sidecar title dedupe now uses fuzzy containment matching (shorter title inside longer, minimum 11 characters) in addition to exact normalized equality, so a narrator-polished title and its raw twin collapse to one entry.
- Blast synthesis batch submission and polling moved inside the salvage try block: a transient network error during any of the up-to-41 calls now falls back to the unmerged per-pass reports instead of discarding them. A timed-out synthesis batch is canceled server-side best-effort so the customer is not billed for an abandoned batch.
- quickVerify validates the model's verdict against the Verdict enum (case-normalized; unknown values map to INSUFFICIENT) so an off-enum string no longer makes a finding vanish from every report bucket, and its confidence uses Number.isFinite so a legitimate 0 survives.
- Resumed blast batches run the same narration and file-enrichment path as fresh runs (changedFiles persisted in the pending record), restoring the per-finding Files lines Ghost Brief™ needs.
- The freemium counter documentation now tells the truth: reads fail closed, writes fail open by call-site policy on the saved-report paths, and the stderr message no longer claims a scan was blocked when it completed. Behavior is unchanged; the description was wrong.
- Blast and Conflict failure paths now print the per-stage spend the failed run already billed, mirroring POI. Blast's displayed cost uses real captured narrator token usage (plan pass, prose pass, patcher, vocab extraction) instead of a character-count estimate that systematically undercounted, with the char/4 fallback kept for capture-empty paths.
- The minified-bundle filter now applies to ZIP and GitHub loads, and dot-path handling is one contract across all three input methods: dotted files and directories are excluded everywhere with a targeted .env.example exception, matching the directory walk's documented behavior. ZIP and GitHub previously loaded .github/.husky/.circleci config and minified bundles the directory path never would, so cost and findings differed by input method.
- The cap-disclosure rewrite regex tolerates emphasis decoration, so a Pass 2 restyled disclosure line still gets the true post-verification count spliced in.
- Ghost Watcher™ finding counts are consistent across all three surfaces: the commit state, the resolved-findings lifecycle, and the findings email all use the action/observation split the sidecar and PR comment already used. Blast observations no longer inflate "N require your attention" or churn the resolved-findings delta, and the commit state carries them in their own blastRadiusObservations bucket.

**Quick wins**
- Recon reports stamp the real package version instead of a hardcoded 4.7.0; Blast meta carries real cost and version on both transports, and Audit meta carries the real roadmap-synthesis cost and version, so the portal manifest and MD cost rows stop rendering blank for those modes.
- Prompt Triage no longer fabricates confidence 85 in the portal sidecar (absent stays null; 0 survives) and its project-history file count excludes redaction-skipped prompts, matching the terminal count.
- The Commit Forecast cost panel says "Commit Forecast", not "Blast Radius Analysis", at the payment-consent moment. The enterprise upgrade message reads its price from the PRICING constant.
- The --batch notice fires only for the API-calling scan modes (no more false "streaming at standard rates" for Recon, no raw mode ids), with friendly labels for Audit and Chat.
- Reconfigure verifies a pasted Anthropic API key against the API before the save prompt (authenticated, free models endpoint; advisory on network failure) instead of confidently saving a truncated paste. Passing both --stream and --batch now prints one line saying streaming wins.
- One model picker everywhere: the Audit picker uses getModelChoices() (it was a hardcoded, unpriced duplicate with a stale comment), picker labels are built at call time from getPricing() so the Sonnet 5 introductory price flips correctly on September 1, 2026, and the intro-pricing blurb is date-aware. Executive Brief honors the configured default model instead of pinning Sonnet 4.6, and its AI-remediation economics are named, documented constants instead of magic numbers in a client deliverable.
- The combined Fix Forecast report renders as "Fix Forecast" in PDFs and markdown instead of the generic "Report".
- @ghost-verified extensions derive from the shared CODE_EXTENSIONS list (minus a doc/data denylist), so Swift, Kotlin, C, C++, C#, Vue, and Svelte files accept the annotation the release that made them scannable; doc-block continuation lines (" * @ghost-verified") now anchor. Regression fixtures added for opener whitespace tolerance (none, tab, multi-space), the near-miss warning, JSDoc style, and Swift/Kotlin.
- The PDF finding-block lookahead tests the lookahead line for section headers instead of the outer line's flag (pagination estimate only).
- Raw terminal glyphs routed through the shared SYM map (with Windows fallbacks) across the loader, tier caps, five modes, and the Audit paywall's emoji header. Dead code removed: an accumulated-but-never-read resume array in the watcher, unused token estimates in Commit Forecast, and an uncalled colorizeOutput in three modes.

**Tests**
- Three new suites wired into npm test: enterprise-totals-migration (legacy 800-event window seeds totals at 800, not 1), ci-license-key (GA- key in GHOST_LICENSE_KEY produces actionable guidance from the real CLI, watcher exit 0 and brief exit 1), and session-refresh (mid-session activation updates tier and scan options without restart; blocking licenses degrade). The license-revocation suite gained the forced re-probe cases; the ghost-verified suite gained six new fixtures. Full suite green at every group boundary during the remediation.

## v10.0.17 -- July 10, 2026

### Patch: Entitlement Enforcement, Verifier Integrity, Cost Accuracy, Claude Fable 5

**Licensing and entitlements**
- License revocation checking added. A new POST /verify endpoint on the license worker reports a license's status, and the CLI consults it before running gated modes. Previously the client had no revocation check of any kind: a signed token verifies offline forever, so a cancelled subscription kept working until the token's natural expiry, up to a year. The check fails open on every network fault (timeout, 5xx, 404, proxy, offline CI runner) and blocks only on an explicit revoked verdict, which is then cached locally so going offline after a cancellation does not restore access.
- Ghost Watcher™ and Ghost Brief™ now honor the license blocking state. Both read the tier straight from the token payload and never asked whether the license was usable, so an expired or hard-stopped license still ran Ghost Watcher™ on every commit indefinitely.
- A revoked license degrades to Ghost Open rather than blocking the CLI outright, matching the existing lapsed-trial behavior. Question and Recon stay free.
- Clock skew no longer masks license expiry. The clock_skew and clock_offline_grace_exceeded branches returned a non-blocking warning before the expiry state machine ran, so an expired license on a machine with a drifted clock never reached hard stop.
- The license last-seen ratchet is now written only from a clock that passed validation.
- A lapsed trial or revoked license now re-seeds the loader's context cap. The tier degrade happened after the loader was seeded, so a lapsed Ghost Pro Max trial kept the trial's 100K context cap while running as Open at 50K.
- Commit Forecast quota bypass closed. The "Run another Commit Forecast?" prompt re-entered the mode function directly, behind the dispatch-level gate, giving Ghost Open unlimited free Forecasts. The gate now runs on every entry.
- Trial and paid scans no longer drain the Ghost Open free-scan quota. The counter in saveReport and Prompt Triage incremented on every tier though only Open reads it, so a lapsed 7-day trial landed on the Open paywall for quota it never spent.
- Ghost Watcher™ tier entitlement now derives from the policy table via a new mode:watch gate. bin/ghost.js carried two independent literal copies of the allowed-tier array.
- shouldBlockMode removed from freemium.js. It had no callers, and its comment described a fail-closed entitlement contract that nothing enforced.
- Both upgrade CTAs corrected from /upgrade, which is a 404, to /pricing.

**Verifier**
- The verifier no longer silently deletes real findings when the LLM verifier is unavailable. A transport failure, a malformed response, and an unknown verdict all returned a "partial" verdict, which left the Pass-1 snippet-mismatch warning in place, which the DISPUTED sweep then matched, which dropped the finding entirely. A single transient 429 could remove a source-confirmable finding from a paid report with no trace. Those three paths now return a distinct error verdict that is exempt from the sweep.
- Raw API error text no longer reaches customer-facing reports. "LLM verifier call failed: 429" was spliced into the report as a finding warning.
- Findings the verifier could not reach are now reported to the operator rather than passing as a clean verification.
- Verification summary arithmetic now reconciles. Disputed findings are dropped from the report exactly like false positives but were absent from every summary, so verified plus unverified plus dropped never summed to the total.
- The executive-summary regeneration gate now fires on disputed findings, which are removed from the report body and could otherwise leave a stale summary describing findings no longer present.
- Unstated confidence no longer promotes a finding to CONFIRMED. The flagFinding tool defaulted an omitted confidence to 90 and the verifier maps 90 and above to CONFIRMED, so a model that never asserted confidence was awarded the maximum. Unstated confidence now falls to POSSIBLE. An explicit confidence of 0 is also no longer rewritten to 75.
- Fabricated line-number citations are now stripped for every supported language. The scrub covered only .php, .js, and .ts, so a hallucinated Service.py:120 or Main.kt:88 shipped to the customer. The extension list is now shared with the loader.
- The finding-cap disclosure is no longer duplicated in every capped report. The presence check searched for a phrase the disclosure never contained, so the line was always spliced in on top of the one the model already wrote.
- The findings JSON sidecar now contains the full uncapped, verified finding set. The narrator details at most 30 findings, and the verifier reparsed its input out of that rendered report, so every finding ranked below the cap was never verified and never written anywhere. A 71-finding scan produced a report that told the buyer about 71 findings while only 30 existed in any artifact, and a cap disclosure pointing at a JSON file that did not contain the rest. The pipeline now verifies the undetailed remainder and writes every survivor. Each sidecar entry carries a `detailed` flag; undetailed findings report `effortHours: null` rather than 0, because they were never estimated.
- The cap disclosure now states the count that is actually in the sidecar. The narrator renders it before verification runs, so the count was an upper bound; the pipeline restates it once the surviving total is known, and removes it entirely if verification drops enough findings that the report is no longer capped.

**Ghost Watcher™**
- Ghost Watcher™ no longer publishes a false clean portal state. On a silent scan failure the portal write ran anyway, marking the commit complete with zero findings and stamping every previously open finding as resolved by that commit. Both the clean-state write and the resolved-finding delta are now gated on a genuinely complete run, and the incomplete-run counter is no longer reset on a failed run.
- The watch sidecar now carries scanFailed and incompleteScans so it matches what the pull-request comment reports.
- The onboarding cost estimate now applies the 50% Message Batches discount that the billing math already applied. The stated "both scans" streaming reference was also wrong and is corrected from $1.50-$3.00 to $0.95-$1.80.
- The Watch Status and Watch Disable prompts offer "back" to cancel and accept it in validate, then tested it with the list-choice sentinel predicate, trapping the user in a token prompt. Both now use the keyword predicate.

**Cost accuracy**
- Persisted scan cost now reflects the model that ran. POI hardcoded Sonnet's $3/$15 per-million rate into the saved artifact regardless of model, understating an Opus scan by 1.7x and a Claude Fable 5 scan by 3.3x.
- Stale hardcoded version stamps (4.5.0, 4.7.0, 4.1.1) in POI and Conflict artifact metadata now derive from package.json.
- The Inheritance Audit now records and reports the cost of its one billed API call. The Modernization Roadmap synthesis never recorded token usage, which is why audit imported showActualCost and could never meaningfully call it.
- The per-pass cost estimate is now a single constant. The pre-scan quote used a bare $0.25 while session recovery used $0.40 for the same passes, and a comment claimed both used $0.25.
- Chat mode now shows per-exchange and running session cost. It is the most expensive mode per turn and had no cost surface at all.
- A mid-scan POI failure now reports the cost of the passes that completed instead of discarding the usage capture silently.
- The Executive Brief now uses the configured senior rate instead of a hardcoded $200/hr, so it agrees with every other Ghost deliverable from the same scan.
- The POI grand-total last-resort fallback was removed. It took the last dollar figure anywhere in the report, which is a single finding's cost rather than the grand total, and stamped it onto the report, the portal, and Ghost Mobile as the cost of the whole engagement.
- Telemetry now fires after the paywall gate, not before, so Pulse no longer counts paywalled selections as scans that ran.
- The Enterprise usage report no longer understates after 1000 events. Totals were computed by summing a 1000-event window, so lifetime scans, cost, and findings silently stopped growing. A monotonic aggregate is persisted alongside the window, with a fallback for legacy files.

**Scans and reports**
- Partial POI scans no longer claim 100% coverage. The saved artifact reported "N of N" files analyzed on a capped run while the honest coverage figure was printed to the terminal and discarded.
- Blast multipass now salvages per-pass reports on a synthesis timeout. The 20-minute timeout was thrown from outside the salvage block, so the most likely failure on a large repo was the one path that discarded the paid work. Two error messages claiming the reports were preserved in a session file were removed; Blast multipass writes no session file.
- Declining the save prompt no longer silently destroys a paid report. POI, Blast, and Conflict buffer the report, print the cost, then ask whether to save. Answering no dropped the only copy. Ghost now writes the report to a clearly named file in the reports directory, prints the path, and offers to open it in the system viewer. The report is never dumped to the terminal: a large scan is thousands of lines of markdown and would bury the cost line and verification summary in scrollback.
- Swift and Kotlin are now scannable (.swift, .kt, .kts). The README claimed support and the loader produced zero files.
- The .env.example entry in the loader allowlist was unreachable on two counts. path.extname returns .example for it, so the extension check could never match; and the directory walker's glob does not enumerate dot-prefixed entries, so the file was never offered to the allowlist in the first place. Both are fixed, the second without sweeping .github, .husky, and .circleci into every scan.
- ZIP and GitHub loads now report how many files the default excludes skipped, matching the directory path.
- Failed and expired Message Batches no longer become permanent menu entries that fire an API call on every render. A batch that ended with no successful result is removed, a 404 batch is pruned, and entries past the 29-day retention window are dropped without an API call.
- The --batch flag now says so when it is ignored. It is implemented for Blast Radius and Question only; on POI, Conflict, and Audit it silently ran a full-price streaming scan. The help text is corrected and the CLI prints a notice.

**Prompt Triage**
- Selecting a non-Claude target model no longer silently produces an incomplete audit. Tier 2 and Tier 3 detectors call the Anthropic API, so all 12 non-Claude targets failed not-found and failed open with zero findings. Ghost now tells the user, skips those tiers, and still runs Tier 1 with the correct per-model tokenizer. The picker labels non-Claude models Tier 1 only.
- Redaction-skipped files are no longer counted as scanned.
- Files carrying a prompt extension that the loader's basename heuristic filtered out are now reported rather than silently skipped.
- LOW severity now renders green, matching every other mode. It was blue.

**Claude Fable 5**
- claude-fable-5 added to the setup wizard model picker, to a new Change scan model item in the Reconfigure menu, to the Inheritance Audit synthesis picker, and to the Prompt Triage target-model registry. claude-sonnet-5 and claude-opus-4-8, both already priced, were also missing from the pickers and are now selectable.
- The model picker derives from MODEL_RATES and shows each model's real per-million rates, so a priced model can never again be unreachable, and a picker entry with no rate fails loudly instead of silently quoting Sonnet prices.
- Claude Fable 5 bills at $10/$50 per million tokens standard. Batch mode applies the existing 50% discount, giving $5/$25. Pre-scan estimates reflect the selected model.

**Copy, docs, and platform**
- The README no longer implies 16 free scans. The four scan-mode rows each read "4 free scans" against a single shared pool of 4.
- The README Ghost Triple Crown™ section now states that leg 3, Ghost Brief™, requires a Max plan. Plain Team and Enterprise Ghost Watcher™ customers get legs 1 and 2.
- A phantom watcher iterations YAML example was removed from the README, and two source comments promising a --no-default-excludes flag that was never implemented were corrected.
- Ghost Brief™ and Executive Brief menu items are now selectable below their tier so the upgrade paywall renders. As disabled rows they could not be chosen, so the gate never fired and the paywall never showed.
- A mistyped license key in the Reconfigure menu no longer kills the app. Every activation failure path called process.exit; the interactive path now returns to the menu.
- Windows consoles no longer receive raw check, cross, and warning glyphs. Nine files each declared a private two-key SYM object, so any other glyph was hardcoded inline. SYM is now one shared module and 45 console call sites route through it.
- The Manage Team and Configure Watch placeholders no longer advertise "coming in Ghost Watcher v9.0.1", a version that shipped long ago.
- Question and Chat PDFs now carry white-label branding. The active profile was never threaded into their saveReport metadata, so a PDF advertised as client-ready rendered unbranded.
- Profile names containing an apostrophe no longer truncate in --list-profiles.
- The PDF severity badge no longer discards Effort, Complexity, and Cost when the metadata line is not bold.
- @ghost-verified annotations now tolerate whitespace variation, and a marker that is present but not comment-anchored warns rather than failing silently.
- The billing-error branch now matches the singular "usage limit" as well as the plural, so a singular message no longer falls through to a generic error.
- Stale comments corrected: parseKey's claim of hyphen-less tolerance, the keys.js claim that trials block Audit mode, the setScanOptions two-call protocol note, the watcher batch-cost note, and four Ctrl+C recovery blocks that cannot fire against inquirer 9.3.8, which re-raises SIGINT.

**Tests**
- New: tests/license-revocation.smoke.mjs pins the fail-open and sticky-revoked contract, including the case that actually matters, a stale cache plus an unreachable worker.
- New: tests/cap-disclosure.smoke.mjs pins getCapDisclosure against the presence regex that must detect it, pins the narrator's cap partition, and asserts the sidecar count equals the full uncapped finding count on a capped run.
- New: tests/watch-onboarding.smoke.mjs covers the Ghost Watcher™ cost estimate and config builder, which had no coverage.
- New: tests/loader-excludes.smoke.mjs covers default excludes on every input method, custom patterns and presets stacking on top of the defaults rather than replacing them, and the ZIP path reporting its skipped-file count instead of dropping files silently.
- New: tests/context-cap-clamping.smoke.mjs covers per-tier cap enforcement measured by files actually loaded, --max-context honored and clamped at the tier ceiling, the Ghost Watcher™ CI guard ignoring a developer's saved sub-tier override, and a lapsed trial re-seeding the loader at the Open cap rather than the trial's.
- loadFromZipPath is now exported so the ZIP loading path is reachable from a test. The interactive loadFromZip prompts and delegates, mirroring loadFromPath and _loadFromDirPath.

**Known limitations**
- The --batch flag is still not implemented for POI, Conflict, and Audit. Those modes are multipass and need a per-mode batch transport. Ghost now discloses this instead of ignoring the flag.

## v10.0.16 -- July 9, 2026

### Patch: Ghost Watcher Trust and Display

**Verifier / Cost**
- PRICING export in src/core/estimator.js renamed to MODEL_RATES, eliminating the name collision with src/constants/pricing.js PRICING (tier subscription prices). Any file importing PRICING from the wrong module would have silently received a table of incompatible shape. Ghost Watcher flagged this HIGH on two consecutive runs.
- SessionCostTracker.record() argument order corrected in blast.js. Stage was being passed as mode, so per-stage cost breakdowns always showed scan regardless of actual stage. Fixed to record('blast', i, o, m, stage).
- resolveContextCap in forecast-overlay.js now passes null explicitly as userRequested with the source label 'forecast-overlay', documenting that the overlay legitimately has no live CLI override in scope.

**Ghost Watcher Display**
- Blast Radius findings separated from action-required findings in PR comments and portal payload. Previously all findings appeared in a flat list, making blast impact observations look identical to confirmed defects.
- PR comment now shows two groups: action-required findings (severity-ranked, PHASE 1/2) and a new section at the bottom labeled exactly: "Blast Radius Observations -- No Action Required" with subtext explaining these are files that import from modules touched by the commit, not broken code.
- Portal payload findings field now contains only action-required findings. A new blastRadiusObservations field carries the blast entries separately. findingCount and severityCounts reflect action-required findings only.

## v10.0.15 -- July 9, 2026

### Patch: Chat Response Calibration

**Chat / Question Mode**
- System prompt rewritten to scale response length and depth to the question asked. Simple factual questions now get one direct sentence. Analysis questions get full senior-architect treatment. Previously every question received the same verbose checklist treatment regardless of complexity.
- Meta questions about Ghost itself (version, tier, mode) now resolve in one line from the identity header without touching the codebase context.
- Unsolicited codebase overviews and summaries suppressed. Ghost now answers the question asked rather than volunteering a full project tour on first input.
- Opening framing changed from analyze this project to answer questions on demand, one at a time. Removes the structural pull toward comprehensive dumps.
- Em dashes removed from system prompt.

## v10.0.14 -- July 9, 2026

### Patch: Report Polish, Verifier Trust, and Copy Accuracy

**Reports**
- Em dashes removed from all customer-facing report output strings across reports.js, pdf-generator.js, profile/index.js, stackReality.js, and reportBuilder.js. Replaced with double hyphen per standing copy rule.
- Ghost Architect trademark symbol added to all report headers, footers, PDF metadata, and title strings where bare name appeared.
- assets/ added to package.json files whitelist. Ghost logo now ships in the npm tarball so PDF headers are not blank on npm installs.
- PDF clean() function no longer rewrites !' to ->.

**Verifier**
- Source-confirmed findings no longer dropped. When the LLM verifier returns supports (the finding is real), the snippet-mismatch warning is cleared so the DISPUTED sweep does not silently remove a verified finding.
- AWS secret redactor no longer rewrites 40-char git SHAs. Added negative lookahead to exclude pure-hex strings. Fixes hundreds of false [REDACTED:AWS_SECRET] hits in Magento codebases with composer.lock. Env-secret rule now preserves colon separators.

**CLI**
- Windows menu descriptions restored. Ternary precedence bug caused mode descriptions to display only on non-Windows systems. Fixed for all nine affected menu entries.
- Reconfigure menu now always visible. Previously hidden when ANTHROPIC_API_KEY was set in the environment, blocking access to license and GitHub token management. API key row is now disabled within the submenu instead.
- Enable Watch wizard now accepts blank or back to cancel at the repo URL and PAT prompts instead of trapping the user.
- --force-clear-markers no longer prints Unknown flag warning before running.
- --recover-session and --sessions-dir added to --help output.

**License**
- Clock-skew and offline-grace warnings no longer blank the license panel. Customer name, tier, and expiry now display correctly during clock-degraded states. Trial countdown restored for offline trial users.
- Pro Max or higher copy corrected for Ghost Brief and Executive Brief. These features require a Max plan (Pro Max, Team Max, or Enterprise Max). Team Max and Enterprise Max customers were previously shown an incorrect upgrade prompt.

**Audit**
- Dependency effort hours key mismatch fixed. unknown-license (hyphen) normalized to unknown_license (underscore) so the 2h effort estimate applies instead of the 8h default. Commercial license category now has a correct 4h effort mapping.
- severityRecast.js marked with TODO at both the module and its pipeline integration point.

**Mobile / Team**
- Mobile publish resolved list now carries finding id. The cf.id === bf.id equality test was always failing, over-reporting every baseline finding as resolved.
- Team sync now fetches files over 1MB via download_url instead of writing 0-byte files.
- Blast batch synthesis now falls back to per-pass reports on canceled or expired batch states instead of returning empty.
- Narrator Promise.race abandoned rejection consumed. A slow-network late rejection from the losing API call can no longer kill the process mid-scan via unhandledRejection.

**Telemetry**
- GHOST_NO_PING now opts out on any set value, not only the string 1.
- Duplicate MODEL_RATES table removed from llmAuditClient.js. Now derived from the single source of truth in estimator.js.

**Tests**
- loadFromPath.test.mjs now self-contained. Fixture is created in a temp dir and cleaned up. No longer requires a pre-existing /tmp/ghost-e2e-fixture directory.

**Copy**
- low-signal findings replaces false positives in conflict.js, watcher-commit.js, and README.md product copy.

## v10.0.13 -- July 9, 2026

### Patch: Scan Quality and Audit Pricing

**Loader**
- assets/ directory added to the default scan excludes alongside node_modules, vendor, build artifacts, and lock files. Any code kept under assets/ is now skipped by default; pass --no-default-excludes to include it.
- Common binary asset extensions (.png, .jpg, .gif, .svg, .woff, .ttf, .eot, .ico, .mp4, .mp3, .pdf, and related image, font, audio, video, and archive types) are now excluded by an explicit denylist enforced ahead of the code allowlist. These were already skipped by the code-extension allowlist; the explicit denylist documents the intent and keeps them out even if a binary type is ever added to the allowlist.

**Inheritance Audit**
- Audit paywall pricing corrected. The Open-tier Audit upsell listed Ghost Pro at $99/mo when Pro is $25/mo. Prices now read from the canonical pricing constants in src/constants/pricing.js so a price change lands in one place and cannot drift across surfaces.

## v10.0.12 -- July 9, 2026

### Patch: Session Recovery, Publish Reliability, License Copy, and Email Polish

**Inheritance Audit**
- License detection methodology copy corrected. The v10.0.6 fix (classifyLicense wired, package-lock.json read for npm deps) is confirmed in place for local directory scans. The methodology footer now accurately states that ZIP and GitHub scan paths fall back to unknown where the lockfile is unavailable.

**Session Management**
- loadSession() now checks both the primary sessions directory and the OS temp fallback path. Previously a session saved to the fallback on primary write failure was never found on resume, silently restarting from pass 0 and wasting API quota already spent.
- --sessions-dir flag added for users who need a custom sessions location.

**Batch Submission**
- deriveRepoName() now emits a stderr warning when falling back past tier 3 (zip path). Returns null instead of the cwd basename when all real source signals fail, preventing wrong repo names in batch records.

**Mobile Publish**
- updateIndex() now uses SHA-based optimistic locking. Concurrent publishes from two seats no longer silently overwrite each other. On SHA conflict, retries up to 3 times with exponential backoff.
- GitHub PAT lookup now checks GHOST_PUBLISH_TOKEN environment variable first, then OS keychain, then plaintext fallback with explicit warning. Users in CI or container environments can set the env var instead of relying on keychain availability.

**License**
- Clock state now validated on read. A corrupted or malformed clock state object now returns a sentinel value that forces a network check rather than silently resetting the offline grace counter to 0. Clock state corruption can no longer bypass offline validation.

**Ghost Watcher Email**
- Em dashes removed from all Ghost Watcher email subject lines and body strings. Replaced with double hyphen per standing copy rule.

**Narrator**
- Patcher timeout now surfaces a visible warning when findings are dropped due to API timeout or error. Previously only visible with GHOST_DEBUG=1. Users now see how many findings could not be enriched without enabling debug mode.

## v10.0.11 -- July 9, 2026

### Patch: Clock Tolerance, Session Safety, Publish Recovery, and Error Visibility

**License**
- Clock ratchet rejection window widened from 60 seconds to 5 minutes. GHOST_CLOCK_TOLERANCE env var added for CI and container environments with non-monotonic clocks. NTP corrections and VM snapshot restores no longer trigger false license validation failures.
- Clock ratchet boundary unit tests added covering 59s behind (pass), 301s behind (reject), and 25h future (reject).

**Audit Mode**
- basePath now trimmed before validation. Trailing newlines from user input no longer abort the Inheritance Audit.
- InvalidBasePathError typed error added. Audit orchestrator catches it, logs a warning, and continues without Key Person Risk rather than halting the entire audit.
- Unhandled rejection in audit synthesis wrapped. roadmapStub.js now returns a structured error result instead of crashing with a stack trace.

**Session Management**
- Session salvage now filters checkpoints by project label. Previously salvage picked the freshest checkpoint regardless of project, potentially mixing findings from two unrelated codebases.

**Mobile Publish**
- Interrupted publish recovery no longer loops forever. Stale marker is now cleared in the recovery catch block before logging the warning. Markers older than 1 hour are cleared automatically.
- --force-clear-markers CLI flag added for operators to manually clear stale markers.

**Reliability**
- safeIncrementCount callers now throw actionable errors including the config file path instead of a generic support prompt.
- Sudo ownership reconciliation failures now logged to stderr with the actual error and a recovery command. Post-chown verification warns if file remains root-owned.
- Unhandled rejection in multipass CLI wrapped. Users see clean error message instead of stack trace on scan failure.
- DISPUTED finding drops now logged at INFO level without requiring GHOST_DEBUG=1.
- Ghost Watcher email now shows auto-verified count: "N findings (M verified, X need attention)."

## v10.0.10 -- July 8, 2026

### Patch: License Ratchet, Quota Safety, Verifier Quality, and Reliability

**License**
- Monotonic clock ratchet now rejects timestamps more than 60 seconds behind the stored value. Previously only future timestamps were rejected. Coordinated clock-rollback and configstore attacks can no longer extend trial periods.

**Quota System**
- Quota counter reads and writes now fail-closed. Previously a corrupted config file caused getStore() to throw, leaving counters at zero and granting infinite free scans. Now read failures return MAX_SAFE_INTEGER (quota exhausted) and write failures block the scan with a clear error message.

**Verifier Quality**
- Findings where the verifier actively disputes the cited code snippets are now classified as DISPUTED and dropped from the report entirely. Previously they appeared as UNVERIFIED findings, creating false positives. Set GHOST_DEBUG=1 to see dropped findings in stderr.

**Narrator**
- Finding cap raised from 25 to 30.
- When cap fires, user sees a clear note before the scan completes: total finding count, cap applied, and confirmation that all findings are in the JSON file.
- PDF report includes the same note when cap fires.

**Reliability**
- Batch checkpoint write failures now surface a visible warning instead of failing silently. Processing continues without resume capability.
- Planner API failures now logged to stderr and surfaced to the user as a warning with plannerFailed flag in the fallback result.
- basePath in keyPersonRisk.js now validated before passing to git. Null bytes, newlines, control characters, and relative paths rejected.
- Direct callers of redactContent() now check the partialRedaction flag. Large files that bypass redaction now prepend a visible marker to the output.

## v10.0.9 -- July 8, 2026

### Patch: Reliability, Data Integrity, and Credential Safety

**Enterprise**
- assertEnterprise() error message now uses PRICING.ENTERPRISE.monthly instead of a hardcoded $1,200 string. Price and error message can no longer drift apart silently.
- Audit log write failures now write a durable record to a local file (~/.config/ghost-architect/audit-failures.json) that survives even when the sync repo is unreachable. On the next successful audit write, accumulated failures are pushed to org/audit-failures.json in a batch and the local file is cleared.
- Added ghost enterprise audit-status command that surfaces any unsynced audit failures from the local failure log.

**Inheritance Audit**
- Manifest parser loop in runDependencyMap() now wraps every parser call in try/catch. A single malformed package.json, pom.xml, or build.gradle can no longer crash the entire Inheritance Audit. Failed manifests are skipped with a warning and counted in the audit result.

**Credential Safety**
- All callers of redactCodebase() now check the partialRedaction flag before using the output. Previously a file over 500KB bypassed redaction silently. Now callers throw unless GHOST_ALLOW_PARTIAL=1 is set explicitly.

**License**
- updateLastSeenUtc() now rejects timestamps more than 24 hours in the future. A timestamp from year 3000 could previously lock the monotonic ratchet permanently. Rejected timestamps are logged to stderr.

**Mobile Publish**
- publishProject() now writes a _pending.json marker before starting the three-file write sequence and deletes it on success. On the next publish, an existing marker triggers completion of the interrupted write before starting fresh.
- All Octokit API calls now wrapped in withRateLimit(). GitHub 403 rate-limit errors now wait for the reset time and retry once instead of failing immediately with a cryptic error.

**Batch Store**
- mutatePendingBatches() now uses optimistic locking with a version counter. Concurrent writes retry up to 3 times before falling back to last-write-wins with a warning. Batch records can no longer be silently lost from concurrent CLI invocations.

## v10.0.8 -- July 8, 2026

### Patch: Reconfigure Menu, Session Recovery, Verifier, Audit, and Profile Extraction

**Reconfigure Menu**
- GitHub reports token reconfigure now always prompts for repo URL after token verification, showing the current value as default. Previously the repo prompt was skipped on subsequent reconfigures, leaving stale values in place.
- Repo URL now accepts owner/repo shorthand and auto-expands to https://github.com/owner/repo before saving. Previously the short form was stored as-is and caused a cryptic parse error at publish time.

**Session Recovery**
- Ghost now logs what was recovered when a previous session is salvaged, including the pass range and estimated API cost already spent. Previously salvage ran silently with no user visibility.
- When salvage fails and a scan restarts from pass 0, Ghost now warns the user explicitly that previous progress is lost.
- Added --recover-session <label> CLI flag to force salvage from checkpoints even when the main session file exists.

**Verifier**
- Executive summary regeneration now fires when any findings are marked UNVERIFIED, not only when findings are dropped entirely. Previously the executive summary could reference findings that were annotated UNVERIFIED but not removed.

**Audit Mode**
- Confirmed the audit roadmap JSON parse is already guarded: the parse in the audit synthesis caller is wrapped in try/catch with markdown-fence stripping and a schema-correct fallback, so a malformed LLM response degrades gracefully rather than crashing. No code change needed.

**Profile Extraction**
- extractProfile() now validates that the configured model is a Claude model before calling the API. Previously a non-Claude default model caused a cryptic API error with no hint about the real cause.

**Enterprise**
- Audit-log write failures now also write a durable failure record to org/audit-failures.json in the sync repo (best-effort), and the usage report data now includes an audit-failures summary when records exist.

## v10.0.7 -- July 8, 2026

### Hotfix: Reconfigure Menu Crash and SCAN_QUOTA Single Source of Truth

- Reconfigure Ghost no longer crashes with "ReferenceError: licenseResult is not defined." The selective reconfigure menu (added in v10.0.6) referenced a variable that was out of scope at the call site; it now reads the active license state from the session module.
- FREE_QUOTA constant removed from freemium.js entirely. Previously CC2 imported SCAN_QUOTA from tier-gates.js but left FREE_QUOTA as a parallel constant alongside it. Ghost Watcher correctly flagged the split twice. FREE_QUOTA now has zero references anywhere in the codebase. SCAN_QUOTA from tier-gates.js is the only quota constant. Enforcement gate and paywall copy can no longer drift apart.

## v10.0.6 -- July 8, 2026

### Patch: Cost Reporting, Reconfigure Menu, Security, and Reliability

**Cost Reporting**
- Points of Interest scan cost reporting fixed (previously ~9x low on multi-pass scans). The scan passes were the only calls counted; the synthesis, narrator, and per-finding verifier calls were invisible, and the single-pass path estimated cost from character counts rather than real usage. All API calls in the POI pipeline (both single-pass and multi-pass engines) now record real token usage into a shared usage tracker, and the reported cost reflects the actual Anthropic bill. Blast and Conflict already tracked their own usage.

**Reconfigure Menu**
- Reconfigure Ghost now shows a selective update menu instead of replaying the full first-run wizard. Each configurable item shows its current status. Updating one setting no longer risks clearing another. Every sub-option has a Back choice that returns to the reconfigure menu without saving changes.
- GitHub reports token update now tests the token against the GitHub API before saving. Invalid tokens are rejected before storage with a clear error message.

**Security**
- GitHub reports token now stored in OS keychain when available (macOS Keychain, Windows Credential Manager, Linux Secret Service). Falls back to chmod-600 plaintext with explicit warning when keychain is unavailable. Existing tokens migrate automatically on first read.
- Consultant profile fields now go through a two-stage prompt architecture. Stage 1 extracts vocabulary in a sandboxed LLM call with no codebase access before Stage 2 uses the sanitized list in the main analysis. Injection attempts are detected and logged.
- Original fileMap nulled after redaction to prevent unredacted content from persisting in memory.
- writeRedactionFailureLog now falls back to stderr when the debug directory is unwritable so diagnostic details are never silently lost.

**Reliability**
- Race condition in saveProjectIntelligence fixed with optimistic locking. Concurrent scans on the same project no longer silently overwrite each other. Atomic file writes prevent metadata corruption on crash.
- Tier 2 detector failures now preserve the original error stack trace. Set GHOST_DEBUG_TIER2=1 to log full stack traces to stderr.
- Enterprise audit log failure counter now persists across process boundaries. Admins see cumulative failure counts instead of always seeing "1 consecutive failure."
- SCAN_QUOTA now imported from tier-gates.js into freemium.js. One source of truth -- enforcement gate and paywall copy can no longer drift apart.

## v10.0.5 -- July 8, 2026

### Patch: Executive Brief, Ghost Brief, and Install

**Executive Brief**
- Executive Brief no longer errors when the findings array is empty. It now renders a professional "no significant findings" summary (health score 100, zero remediation effort) appropriate for a deal-grade deliverable, and skips the unnecessary narrative API call on an empty scan. The caller also stops conflating a valid zero-finding scan with a malformed input file.

**Ghost Brief**
- ghost --brief --output is now wired through to the brief generator for both flag forms. Previously only the --output=path form was honored; the space-separated --output path form (as shown in the help examples) was silently ignored and fell back to the default output path. Both forms now work, for --input as well.

**Install and Docs**
- README install command updated to: npm install -g ghost-architect-open --location=global.

## v10.0.4 -- July 7, 2026

### Patch: Cost Transparency, Paywall Copy, Pricing, and Prompt Triage Redaction

**Cost and Session**
- Dead session cost summary removed. The top-level SessionCostTracker was never populated by any mode and always rendered zeros. Removed the dead showSummary() calls rather than showing a misleading empty summary.

**First-Run Experience**
- Keyless users no longer replay the full wizard on every launch. isConfigured() now checks a wizardComplete flag set at wizard completion, not API key presence. Recon-only users (no API key by design) now land directly in the main menu.

**Paywall Copy**
- Ghost Brief and Chat mode now show a proper upgrade paywall ("Ghost Brief requires Pro Max") instead of the quota paywall ("You've used your 4 free reports") when tier-blocked. The quota copy was factually wrong for these modes.

**Pricing Constants**
- TEAM_MAX ($799/mo) and ENTERPRISE_MAX ($2,500/mo) added to src/constants/pricing.js.
- Forecast paywalls now include Pro Max in the upgrade tier list.
- First-run wizard now uses PRICING.TRIAL_DAYS instead of hardcoded "7-day" string.
- mode:executive-brief added to TIER_POLICY so it is properly gated via flag as well as menu.

**POI Output**
- "N false positives dropped" removed from POI output. Rule violation -- customers do not need to know what was filtered.
- Em dashes removed from poi.js and estimator.js customer-facing strings.

**Prompt Triage**
- Prompt Triage now runs redactContent() on every prompt file before sending to the Claude API. Previously raw file content including any secrets went directly to Anthropic. Fix is fail-closed -- a redactor failure surfaces an error rather than falling back to raw content. All three API call sites patched.

**Ghost Watcher**
- actions/checkout and actions/setup-node bumped to @v5 in both ghost-watcher.yml and the customer template. This silences the "Node 20 is being deprecated" warning which came from the action runtime, not the node-version input.

## v10.0.3 -- July 7, 2026

### Patch: Trust, Trial Funnel, Profile, and License Detection

**Trust and Legal**
- README privacy section corrected: "No telemetry, no analytics, no phone-home" replaced with honest copy describing the anonymous usage ping and the GHOST_NO_PING=1 opt-out.
- LICENSE replaced with real Business Source License 1.1 text. The previous LICENSE was all-rights-reserved proprietary text that contradicted the README's BUSL-1.1 claim and caused procurement auto-block.
- "never stored on any server" copy removed from README and config.js per standing copy rule.

**Ghost Watcher**
- Ghost Watcher no longer posts "Safe to merge" or sends a clean-scan email when scans failed to run. Scan tracking added: a submission failure or API outage now renders an explicit error PR comment instead of a false green signal.
- Default Watch config no longer ships skip_if_message_contains patterns to customer repos. Every new Ghost Watcher install now fires the full Triple Crown on release commits.

**Trial Funnel**
- Trial hard-stop now degrades to Open tier instead of process.exit(1). A Day 8 trial user sees a conversion banner and keeps Question and Recon.
- Trial expiry messages now say "Your Ghost Pro Max trial has ended" instead of "Renew your subscription."
- trialDaysRemaining() now wired -- active trial users see "Trial: X days remaining" on every launch.

**Profile Management**
- Interactive profile creation no longer crashes or silently discards input. Both broken handlers now route to runProfilesMenu() which persists correctly. Edit and delete paths are now reachable.

**Inheritance Audit**
- classifyLicense() now exported and wired into all six ecosystem parsers. Previously hardcoded to unknown regardless of license data.
- npm parser now reads package-lock.json for resolved license data. AGPL and GPL dependencies now correctly surface as copyleft findings in local directory scans.

**README and Docs**
- Tier matrix Open column corrected: POI, Blast, Conflict, and Prompt Triage now show "4 free scans" instead of unqualified checkmarks.
- "Fully featured" Open tier description replaced with accurate copy.

**Tests**
- dedup.smoke.mjs fixed (stale detector id).
- 9 previously unwired test suites added to npm test: dedup, assert-prompt-pack, banner-promo, commit-forecast, conflict-extractor, verifier-stepcap, license/test-fingerprint-matching, license/test-fingerprint-windows, license/test-trial. Total: 30 to 39 test invocations.

**Website**
- 549 customer-facing em dashes replaced across 34 HTML pages.
- 38 meta and OG tags converted from em dash to --.
- 10 title tags with awkward double-colon or ?: punctuation fixed.

## v10.0.2 -- July 6, 2026

### Patch: License Key Generation, Watch Setup, and Cost Estimator

**License**
- generateKey() in format.js now accepts canonical tier strings ('pro', 'pro-max', 'team', etc.) in addition to 3-char code keys ('PRO', 'PMX', 'TEM'). Previously any caller passing a canonical tier string (as returned by getActiveTier()) would throw Invalid tier: pro.

**Ghost Watcher Setup**
- enableWatch branch injection now normalizes CRLF to LF before applying the branch regex, then restores CRLF if the source file used it. Previously a Windows git checkout with CRLF line endings caused the regex to silently fail, deploying Ghost Watcher with wrong branch triggers.

**Cost Estimator**
- MENU_OUTPUT_TOKENS in cost-estimator.js now has explicit entries for audit (8000), prompt-triage (3000), recon (2000), and forecast (4000). Previously these modes silently fell back to the generic 4000 default, underestimating audit output by 50 percent.

## v10.0.1 -- July 6, 2026

### Patch: Trial Funnel, Ghost Brief, Watcher Regex, and Paywall Fixes

**Trial and Conversion**
- Trial tier now has full Pro Max parity: Audit and Ghost Brief unlocked, context cap raised to 100K. The "Start a free 7-day Ghost Pro Max trial" CTA now delivers what it promises.
- Trial CTA added to the Open tier welcome banner so users discover the free trial on first launch, not only after hitting a paywall.
- Paywall copy corrected: Pro Max added to "What Pro, Pro Max, Team, and Enterprise unlock" lists. Audit paywall now accurately states Ghost Brief requires Pro Max.
- Missing trademark symbol added to "Ghost Architect reports" in quota paywall.
- Stale "2 free runs" comment corrected to "4 free scans."
- --license panel now instructs customers to use their GA- license key instead of "signed-token-from-email."

**Ghost Brief and Chat**
- ghost --brief no longer crashes with ReferenceError: profile is not defined. The flagship Pro Max flag works.
- Chat mode no longer invents its version number. VERSION and tier are now injected into the system prompt so "what version are you running?" returns the real answer.

**Ghost Watcher**
- Self-refuting filter regex fixed: the pattern consistent\b was matching inside "inconsistent," silently deleting findings phrased as "inconsistent X between A and B." Fixed with a negative lookbehind.

**Audit Mode**
- "v0.4.0 development" banner and "Audit Mode Development Status" box removed. Paying customers no longer see dev scaffold after every audit run.

**Fix Forecast**
- Fix Forecast now generates previews against the proposed-changes version of the file instead of the baseline. Previously it silently reverted uncommitted work.

**UI Polish**
- Banner now renders [Pro Max] instead of [Pro-max] for all hyphenated tiers.

## v10.0.0 -- July 6, 2026

### Full Audit Remediation (32 findings)

Ghost Architect v10.0.0 is a complete remediation of a 32-finding dogfood audit conducted against the v9.4.x codebase using Opus 4.8. Every finding has been addressed.

**Conversion & Trust**
- Pricing corrected across all four CLI paywalls, README, and website FAQ. Single source of truth in src/constants/pricing.js
- Trial CTA now appears as the first CTA in every paywall
- Dead local trial module (trial.js) removed
- Portal PR comment link fixed (missing .html causing 404)
- Setup wizard no longer hard-blocks without an API key
- Tilde path expansion now works on all scan prompts
- Markdown report severity badges no longer corrupt prose

**Customer Experience**
- Grace/hard-stop language removed from healthy licenses
- Fingerprint mismatch message now includes recovery steps
- Clock skew degrades to warning instead of hard block
- Bus factor jargon replaced with consequence language
- "unparsed" replaced with "not declared in manifest"
- Concentration percentages now include denominators
- npm unknown license callout includes explanatory note
- console.clear() no longer wipes activation confirmation
- Top-level errors route through friendlyError()
- Config wizard copy corrected (key is not encrypted)
- --version output now shows Ghost Architect™ vX (Tier)
- Em dashes removed from all customer-facing CLI output
- Four minor buyer-facing noise items cleaned up

**Technical**
- Verifier concurrency bounded to 4 (was unbounded Promise.all)
- Agent loop now surfaces dropped steps instead of ok:true
- synthesizeFinal routes through callClaude retry wrapper
- Extraction shortfall no longer discards real findings
- CI telemetry step sending hardcoded zeros removed
- HTTP 400 no longer misclassified as context limit error
- Activation cross-checks key format tier vs server tier
- Blast single-pass short-circuits batch synthesis
- Tier-1 prompt detectors guarded against non-string input
- Redactor mis-signal on timeout fixed
- DB password regex no longer mangles docker/git -p flags
- runWithConcurrency extracted to src/utils/concurrency.js

## [9.4.40] -- 2026-07-05

### Fixed
- multipass SYM declaration bug: `const IS_WINDOWS` and `const SYM` in src/analyst/multipass.js were trapped inside the opening JSDoc block comment instead of live code, so every multipass display path (passComplete, batchMerged, coverage reporting) threw `ReferenceError: SYM is not defined`. Both declarations moved below the closing comment marker. Caught by Ghost Watcher automated conflict detection on commit 0bf83ef.

## [9.4.39] -- 2026-07-05

### Added
- Guided analysis prompt: after file processing, the mode menu opens with "Ready to analyze N files. What would you like Ghost to do?" instead of an abrupt drop into the list. Suggested by Alex Artiukh (summusforge) during his trial session.
- First-run license flow: the first-run onboarding (before the setup wizard) now asks "Do you have a Ghost license key?" -- the yes path activates the key immediately, the no path points to the free 7-day trial or Ghost Open. Activation failures warn and fall through to setup rather than killing the first-run session.

### Changed
- README: added an Important note in the Install section -- run ghost from any directory and enter the full path to the codebase when prompted, rather than navigating into the target folder first.

## [9.4.38] -- 2026-07-05

### Fixed
- Cross-platform configstore path resolution: on Linux, `sudo ghost --activate` wrote the license to /root/.config while a normal relaunch (as the user) read ~/.config and found nothing, silently falling back to Open tier. config.js now resolves the invoking user's real home (SUDO_USER via getent / /etc/passwd) and writes there, with automatic chown (SUDO_UID/SUDO_GID) so later non-root writes never EACCES. macOS, Windows, and non-sudo runs are unchanged.
- Consolidated five independent Configstore('ghost-architect') instances (config, freemium, mobile-publish, portal-publish, pulse) into a single getConfig() singleton -- one source of truth, no split-brain path resolution on any platform.
- Root-without-SUDO_USER activation now warns explicitly instead of silently misdirecting the license store.

### Added
- Git hook file scanning: extensionless hook files (pre-commit, post-checkout, commit-msg, and 13 others) are recognized by basename across all three loader paths (directory, ZIP, GitHub) via a shared isScannablePath() helper, so a scan pointed at a .git/hooks directory analyzes the hooks, not just README.md.
- tests/git-hooks-scanning.smoke.mjs -- validates isScannablePath across extensionless hooks, code extensions, .sample skip, and non-code files (test suite now 30 tests).

## [9.4.37] -- 2026-07-03

### Fixed
- Count reconciled: v9.4.35 POI self-audit resolved 14 findings (not 13 -- corrected in CHANGELOG and README)

### Added
- tests/forecast-context-cap.smoke.mjs -- regression fixture for resolveContextCap .effective extraction (CC-87 fix); asserts .effective is a positive number per tier and that the object itself is not directly usable as a number

## [9.4.36] -- 2026-07-02

### Fixed
- forecast-overlay.js: resolveContextCap() return object was used as a number instead of extracting .effective -- tier context cap was silently never enforced on large change sets. Ghost Watcher caught this on the v9.4.35 release commit (run #94, finding #1). Fixed by extracting .effective so the budget loop correctly stops adding files at the tier ceiling.

## [9.4.35] -- 2026-07-02

### Fixed
Ghost scanned Ghost. POI self-audit identified and resolved 14 latent findings across error handling, concurrency, and silent failure paths -- none affecting the happy path, all affecting edge-case reliability.

- Always-exit-0 CI contract: handleIncompleteRun wrapped in try/catch at both BatchTimeoutError sites
- Billing-limit error classification: isContextOverflow no longer misclassifies spend-cap 400s
- GitHub workflow-scope error: enableWatch re-throws non-scope errors instead of misleading advice
- Atomic project writes: saveProjectMeta and scan records use temp+rename to survive crashes
- Batch-store lost-update: mutatePendingBatches centralizes read-modify-write with fresh re-read
- Rate-limit retry: cumulative counter across files, non-rate-limit skips now logged
- Octokit throttle callbacks: notify-only, manual retry loop stays authoritative
- Portal-write SHA retry: upsertPortalFile retries up to 4x on 409/422 conflicts
- Pending-file concurrency: mutatePendingFile helper covers all 5 portal-file mutators
- Enrichment index fallback: post-narration re-enrich uses position-based fallback when title lookup misses
- PDF stderr surfacing: python3 ENOENT and reportlab missing now produce actionable error messages
- Diff hunk numbering: leading-offset underflow fixed, @@ starts correct for deep-in-file changes
- Sonnet-5 pricing auto-switch: getPricing auto-returns standard rate from Sep 1 2026, no manual edit needed
- Enterprise org-file CAS: all four org mutators now use bounded SHA-conflict retry via mutateOrgFile

### Added
- tests/diff-renderer-hunk-numbering.smoke.mjs -- regression fixture for hunk-start underflow
- tests/estimator-sonnet5-pricing.smoke.mjs -- guards Sonnet-5 intro/standard pricing switch
- tests/enterprise-org-concurrency.smoke.mjs -- CAS retry fixture, retry path confirmed exercised

### v9.4.34
- @ghost-verified annotation added to tokenizer.js countTokensExactImpl delegation -- Gemini/unknown cache-namespace isolation is an intentional performance trade-off, not a conflict
- SELF_REFUTING_RE extended with two new patterns: "not a runtime failure" and "performance issue, not a correctness" -- post-generation filter now catches self-refuting findings that slip past the prompt-side DO NOT FLAG rule

### v9.4.33
- tokenizer.js: fixed countTokensExact OpenAI delegation -- now calls countTokensImpl() directly instead of countTokens() to keep 'fast' and 'exact' cache namespaces genuinely isolated; removed dead resolveApiKey import
- Conflict Detection prompt: added self-refuting DO NOT FLAG rule -- findings that self-describe as "no current runtime failure", "no runtime impact", "correct behavior", or "redundancy rather than a conflict" are now suppressed at generation
- Prompt snapshots regenerated to match updated conflict prompt

### v9.4.32
- @ghost-verified annotation added to src/modes/prompt-triage.js import block -- confirmed false positive, all four functions (estimateMultiCallCost, formatCost, formatCostRange, calcActualCost) are correctly exported from src/core/estimator.js and imported directly; src/estimator.js barrel shim gap is latent, not live

### v9.4.31
- Finding lifecycle tracking: Ghost Watcher now computes a resolved/new delta on every run -- findings that disappear after a fix are marked Resolved in the portal with the commit they were fixed in; new findings are tracked as first-seen this commit. Branch-filtered so multi-branch repos stay clean.
- Ghost Portal: Resolved findings section added to Watch tab findings view (both portal-template.html and portal-ejwisner.html) -- collapsible green section showing fixed findings with commit reference
- verifiedFindings now written to STATE file -- closes gap where @ghost-verified findings disappeared from portal on state-only commits
- __GHOST_VERSION__ placeholder replaces brittle version-literal .replace() in enableWatch() -- eliminates silent desync risk on future releases
- claude-fable-5 added to temperature guard (sampling-params.js) and pricing table (estimator.js -- $10/$50 per million tokens)
- Pricing table completed: claude-opus-4-8 and claude-opus-5 added at $5/$25 per million tokens
- Wrangler upgraded to 4.106.0 (global)

### v9.4.30
- @ghost-verified annotation added to `src/license/clock.js` CLOCK_STATE_KEY (confirmed false positive -- no collision risk in scoped Conf namespace)
- GitHub Actions template updated to Node.js 24 (eliminates Node 20/22 deprecation warnings on CI runs)
- Conflict Detection JSON repair extended with two new tiers: trailing-comma sweep (Repair 4) and trailing-comma plus truncation combined (Repair 5) -- catches "Expected ',' or '}'" parse errors from model output
- Conflict Detection prompt tightened: speculation hard-suppressed at generation (DO NOT FLAG, CONFIDENCE RULE, SEVERITY RULE all updated to eliminate LOW carve-out for hypothetical findings)

## [9.4.29] - 2026-07-01

### Fixed
- **README blast_radius example.** The ghost-watcher.yaml example in README.md now shows the object form with enabled flag and skip_if_message_contains patterns. The plain boolean form silently omits the release-commit blast skip behavior added in v9.4.28.

## [9.4.28] - 2026-07-01

### Fixed
- **Blast radius skip on release commits.** ghost-watcher.yaml and buildWatchConfig now skip blast radius when the commit message starts with a version prefix (v9., v10., v11.). Release commits produce blast impact-analysis noise rather than actionable findings. Conflict Detection and Ghost Brief still run on all commits.
- **blast_radius config object form.** buildWatchConfig now emits blast_radius as an object with enabled flag and skip_if_message_contains patterns instead of a plain boolean. Regenerating ghost-watcher.yaml no longer reverts the skip config.
- **enabled:false object form wired.** All three blast_radius guard sites in watcher-commit.js now check blast_radius?.enabled !== false in addition to blast_radius !== false, so an object-form config with enabled:false correctly disables blast.
- **@ghost-verified annotations.** Added for corrected-file-generator 'ensures' prose filter (syntaxChars guard already protects real code lines) and batch-store Configstore split-access (different keys, atomic writes, non-racing paths).

## [9.4.27] - 2026-07-01

### Fixed
- **blast-multipass errored result handling.** The batch synthesis results loop now explicitly checks for result.type === 'errored' and throws with error details. Previously a failed synthesis batch request silently returned an empty report string with no error surfaced, causing a blank report to be saved to disk.
- **@ghost-verified annotations.** Added 4 annotations for confirmed false positives: getSamplingParams batch params shape, onUsage null-default guard, batch-submit formatClockTime import, getBranding logo_path consistency.

## [9.4.26] - 2026-07-01

### Fixed
- **Blast narrator streaming eliminated.** Ghost Watcher now calls narrateReportSync instead of narrateReport for blast narration. narrateReportSync uses messages.create (blocking, non-streaming) which has no streaming connection drop exposure. Removes the 180s timeout wrapper and retry logic that caused degraded-run emails on CI networks. The degraded-run fallback (raw findings + customer email) is preserved for genuine API failures.
- **blast-multipass synthesis batch.** The multi-pass blast synthesis call in blast-multipass.js converted from messages.stream to batch API (submit + poll). Consistent with how Blast Radius and Conflict Detection already operate. No client-side timeout risk.

## [9.4.25] - 2026-07-01

### Fixed
- **SELF_REFUTING_RE extended.** The self-refuting conflict filter now catches model-generated self-negations with adjectives between key words (e.g. 'not a concrete runtime conflict', 'no concrete failure path', 'no active cross-file call path exists'). Previously the regex required adjacent words and missed these phrasings. Five new test cases added to self-refuting-filter.smoke.mjs. Both the production regex in watcher-commit.js and the replicated copy in the smoke test are kept in sync.

## [9.4.24] - 2026-07-01

### Fixed
- **corrected-file-generator syntaxChars.** Added single and double quotes to the syntaxChars regex. Previously a patch line like `case 'foo':` ended with colon and had no recognized syntax chars, causing it to be incorrectly stripped as a prose header. Switch-case labels in patch instructions are now preserved correctly.
- **Workflow template version.** watch/index.js now replaces the hardcoded "version":"9.0.15" string in the fallback telemetry payload alongside the existing @latest replacement. Cancelled or failed Ghost Watcher runs now report the actual CLI version instead of 9.0.15.
- **dedup.js selectKeepers consistency.** GENERAL_DETECTORS rank lookup now uses both full detector ID and baseId (split on '/'), matching the behavior of classifyDetector. Prevents incorrect rank-99 fallback if a general detector ever emits a slash-suffixed ID.
- **dedup.js annotations.** Added @ghost-verified annotations for injectionStaticPattern slash-suffix comment and formatting/roleSeparation sub-detector classification notes.

## [9.4.23] - 2026-07-01

### Fixed
- **dedup.js GENERAL_DETECTORS restored.** Reverted the v9.4.21 promotion of ambiguousInstruction and underspecifiedConstraints to SPECIFIC_DETECTORS. The detector source files explicitly document these as less-specific fallbacks (ambiguousInstruction defers to conflictingInstructions on overlap). Promoting them to SPECIFIC caused selectKeepers() to emit both findings on overlap, producing duplicate signal. They are now correctly back in GENERAL_DETECTORS at ranks 1 and 2.
- **poi.js empty-scan payload.** Added @ghost-verified annotation to the intentionally-minimal publish payload in the no-local-save branch. buildPublishPayload fallbacks handle the absent fields correctly for zero-finding scans.

## [9.4.22] - 2026-07-01

### Fixed
- **projects.js scanRecord fields.** saveProjectIntelligence now writes all fields that buildPublishPayload reads at the top level of the scan record: resolved, reportText, version, txtFile, mdFile, pdfFile, newFindings (sourced from meta). Previously these were undefined when a scan record was loaded from disk, causing the mobile dashboard to show zero findings, zero severity counts, and empty finding lists.
- **diff-renderer verified.** computeUnifiedDiff @@ line number calculation confirmed correct via multi-hunk test. Separator-skipped lines are correctly applied via aLine += h.skipped before the next hunk flushes. @ghost-verified annotation added.
- **prompts-extracted snapshots.** Conflict detection snapshots (06-conflict-default.md, 07-conflict-with-profile.md) regenerated to reflect the v0.4 prompt content (STRICT REQUIREMENT, DO NOT FLAG, CONFIDENCE RULE sections).

## [9.4.21] - 2026-07-01

### Fixed
- **mobile-publish findingCount.** buildPublishPayload now reads findingCount and severity counts from scanRecord.meta fallback. Mobile portfolio dashboard no longer shows zero findings.
- **MODE2_THRESHOLD constant.** Extracted magic number 0.70 to named constant in corrected-file-generator.js.
- **analyst/index.js temperature guard.** All stream calls now use getSamplingParams instead of hardcoded temperature values.
- **dedup.js SPECIFIC_DETECTORS.** Promoted ambiguousInstruction and underspecifiedConstraints to SPECIFIC; removed their stale GENERAL_DETECTORS entries.
- **tokenLimit mayUseNetwork flag.** tokenLimitContextOverflow and tokenLimitExcessive registry entries now carry mayUseNetwork: true.
- **Conflict Detection prompt v0.4.** Tightened to require concrete runtime impact before flagging. Added STRICT REQUIREMENT list, DO NOT FLAG list, per-category runtime qualifiers, and CONFIDENCE RULE. Reduces false positive noise significantly.
- **@ghost-verified annotations.** Added 7 annotations for intentional design decisions that were recurring as false positives: capSeverity policy split, estimator dual-path import, compare.js keepLandmarks, enrichFindingsWithPrompts export, onUsage stage drop, fix_direction two-value confidence, audit/index.js CLI layer imports.
- **Portal degraded-run banner.** Now shows the affected commit short SHA(s) so customers know exactly which commit had the narrator failure.

## [9.4.20] - 2026-07-01

### Fixed
- **Narrator failure email.** When the blast narrator times out, Ghost Watcher now sends a degraded-run notice email instead of raw unnarrated blast findings. Customers see a clear message to rerun rather than confusing impact-analysis output.
- **Blast narrator timeout.** Increased from 90s to 180s to reduce timeout frequency on CI runners.
- **extractCandidates JSON escape repair.** Added a second repair tier that sanitizes invalid backslash escape sequences before falling back to dropping the fence. Recovers partial conflict results from responses containing regex patterns or other non-standard escapes.
- **dogfood detector IDs.** Replaced stale 'length/excessive' with 'tokenLimitExcessive' in audit-reports/dogfood-2026-05-11.json.
- **watcher-batch.js preflight.** preflightBatchCheck now spreads getSamplingParams into the preflight request for consistency with actual batch requests.
- **Portal commit ID filter.** Findings and Prompts tabs now show commit selector pills when multiple commits are in the date range. Selecting a commit scopes both tabs to that commit's data. Implemented in both portal-ejwisner.html and portal-template.html.
- **pulse-stats Cache-Control.** Removed Cloudflare Cache API layer from handlePulseStats and set Cache-Control: no-store so every request hits the live worker. Eliminates the edge-cache delay after signup-worker deploys.

## [9.4.19] - 2026-07-01

### Fixed
- **tokenLimit detector IDs.** tokenLimitContextOverflow and tokenLimitExcessive now emit camelCase detector fields matching the registry id and SPECIFIC_DETECTORS set. The slash-format IDs ('tokenLimit/contextOverflow', 'tokenLimit/excessive') caused classifyDetector() to return 'orthogonal' instead of 'specific', defeating dedup suppression.
- **corrected-file-generator Mode 2N guard.** tryMode2N now returns null for signature-shaped patches, deferring to the Mode 1 fallback instead of inserting a method body without its signature before the class closer.
- **reports.js confidence rescale removed.** The stale float-detection branch (<=1 → ×100) was removed. findingsFromResults has produced 0-100 integers since v9.4.14; the branch was dead code with an edge-case risk of misreading 1% confidence as 100%.
- **extractCandidates JSON truncation repair.** When a conflict batch response is truncated at max_tokens mid-JSON, extractCandidates now attempts a repair (closing open structures with ']}') before falling back to dropping the fence. Recovers partial results from truncated chunks.
- **dogfood-2026-05-11.json updated.** All 6 stale 'output/unbounded' detector ID references replaced with 'unboundedOutput' to match the v9.4.17 rename.

## [9.4.18] - 2026-07-01

### Fixed
- **integrationMismatch cap comment.** Updated JSDoc to reflect FINDINGS_CAP = 10, correcting the stale "5 per prompt" documentation left over from v9.4.17.
- **buildWatchConfig iterations opt-in.** maxIterations now defaults to null; the iterations block is only emitted when a caller explicitly passes a value. Previously the wizard baked a hidden iterations.max: 5 into every generated ghost-watcher.yaml, silently capping new Watch repos at 5 iterations despite v9.3.7 documenting that no config = no limit.

## [9.4.17] - 2026-06-30

### Fixed
- **unboundedOutput detector ID.** Changed emitted detector field from 'output/unbounded' to 'unboundedOutput' to match the dedup.js SPECIFIC_DETECTORS registry. The mismatch caused classifyDetector() to return 'orthogonal' instead of 'specific', so general findings were not suppressed as intended when unboundedOutput fired on the same range.
- **buildTokenUsage model.** Now accepts an optional model parameter defaulting to getWatcherModel() instead of a hardcoded 'claude-sonnet-4-6'. Cost estimates in the portal now reflect the actually-configured model.
- **integrationMismatch FINDINGS_CAP.** Changed from 5 to 10 to match all sibling Tier 2/3 detectors and prevent premature truncation.
- **tokenLimit tier labels.** Both tokenLimitContextOverflow and tokenLimitExcessive JSDoc sub-headings updated from 'Tier 2 / hybrid' to 'Tier 1 / hybrid' to match the registry and the one-line headers corrected in v9.4.15.
- **Telemetry privacy.** Removed the raw /tmp/ghost-watcher-telemetry.json temp file write that stored unhashed commitHash and repoHash. The pingWatcherRun() call (which hashes identifiers internally) is the sole telemetry path.

## [9.4.16] - 2026-06-30

### Fixed
- **Shared sampling-params utility.** Extracted getSamplingParams, modelRejectsTemperature, MODELS_WITHOUT_TEMPERATURE, and MODEL_PREFIXES_WITHOUT_TEMPERATURE into src/utils/sampling-params.js. narrator.js, watcher-commit.js, blast-multipass.js, and extractor.js all import from this single source -- eliminates three divergent copies and ensures all API callers correctly strip temperature for Sonnet 5 / Opus 4.7 / 4.8.
- **mobile-publish estimatedHours/Cost fallback.** buildPublishPayload now reads from scanRecord.meta.totalHours/totalCost when the top-level fields are absent, so the mobile app correctly shows cost estimates instead of always displaying dashes.
- **corrected-file-generator Heuristic 1.** Colon-terminated lines are now only stripped as prose headers when they contain no syntax characters -- switch-case labels, TypeScript annotations, and goto labels are preserved.
- **conflict.js dead guard removed.** Unreachable SESSION_PREFIX throw removed; _sessionType check is the sole collision guard.
- **enterprise.js getFileParsed.** Renamed getFileContent to getFileParsed to distinguish from getFileWithSha and prevent future confusion.
- **verifier.js LINE_NUMBER_RE tightened.** Now requires explicit line/lines keyword or file:N pattern -- cost ranges and effort ranges no longer produce false line-number citations.

## [9.4.15] - 2026-06-30

### Fixed
- **src/watch/index.js parseRepo.** Replaced naive github.com-only parseRepo with GHES-aware import from team-sync.js -- the last remaining naive parser in the codebase.
- **resolveContextCap default message.** Warning no longer references --max-context when the source is 'default' (user never passed that flag).
- **wizard.js dead import.** Removed unused import YAML from wizard.js.
- **capSeverity docstrings.** poorOrganization, poorDocumentation, inefficientFewShot docstrings corrected to reflect intentional HIGH→MEDIUM policy rather than stale v5.3 cap-removal claim.
- **corrected-file-generator docstring.** Prose-word list in cleanPatchInstruction header comment aligned to the actual current regex.
- **prompts-extracted snapshots regenerated.** Conflict prompt snapshots (06-conflict-default.md, 07-conflict-with-profile.md) now reflect current JSON output format instead of stale markdown format.

## [9.4.14] - 2026-06-30

### Fixed
- **portal-publish.js parseRepo.** Replaced naive github.com-only parser with robust GHES-aware import from team-sync.js.
- **Shared Anthropic client.** tokenizer.js delegates to llmAuditClient.js getAnthropicClient() -- single singleton, shared failure state.
- **capSeverity HIGH enforcement.** poorOrganization, poorDocumentation, inefficientFewShot now clamp HIGH to MEDIUM at code level.
- **corrected-file-generator prose filter.** Removed before/after/it/the/to/in from prose list; added =<> to syntaxChars.
- **blast-multipass API key.** Uses resolveApiKey() + Sonnet 5 sampling guard.
- **Audit confidence scale.** findingsFromResults.js corrected from 0..1 float to 0-100 integer.
- **Dashboard severity null.** buildDashboardSidecar severity fallback changed to null.
- **dedup dead entry.** Removed stale injection/static-pattern legacy detector ID.
- **Conflict prompt barrel import.** watcher-commit.js imports through prompts/index.js.
- **tokenLimit tier labels.** File headers corrected to Tier 1.
- **skipTiers docs.** runAll updated to note Tier 1 token detectors may make API calls.
- **upsertFile encoding contract.** Normalized across portal-publish.js, mobile-publish.js, team-sync.js, enterprise.js -- all use shared encodeFileContent helper (Buffer/string/object-aware).
- **loader fileMap refactor.** buildContext no longer reassigns the fileMap parameter -- introduced activeFileMap for clarity.
- **Conflict session prefix hardened.** SESSION_PREFIX changed to conflictscan-- to prevent namespace collision with POI sessions.
- **SessionCostTracker stage tracking.** record() accepts optional stage param; getSummary() exposes byStage cost breakdown.
- **getSamplingParams explicit allowlist.** Replaced fragile substring matching with MODELS_WITHOUT_TEMPERATURE set and prefix list in narrator.js and watcher-commit.js.
- **codemaseRoot test fixture.** Fixed typo in test/ghostBrief.test.mjs.

## [9.4.13] - 2026-06-30

### Fixed

- **GitHub Enterprise Server URL parsing.** enterprise.js and mobile-publish.js now use robust parseRepo from team-sync.js (handles GHES hosts, subpaths, SSH URLs).
- **Dashboard remainingFindings slice bug.** buildDashboardSidecar slice(count-as-index) replaced with explicit zero-guarded tail slice; Jira export no longer dumps all findings when a project is 100% resolved.
- **storePendingBatch SHA conflict retry.** Concurrent runs no longer drop pending batch entries on 409 SHA mismatch.
- **Conflict detection separate POST per chunk.** Each conflict chunk now submits as its own batch POST (sub-900KB), eliminating the 2.41MB combined body that caused hung batches.
- **Cancel handler.** ghost --watcher-cancelled added; GitHub Actions cancel step pushes status:cancelled to portal so stuck ANALYZING state resolves instead of spinning forever.
- **Sonnet 5 / Opus 4.7 / 4.8 compatibility.** getSamplingParams guard strips temperature from all API calls when using models that reject sampling parameters. claude-sonnet-5 added to pricing table.
- **14 conflict-finding cleanups.** getModel renamed to getWatcherModel; stale cap-at-MEDIUM docstrings updated; injectionStaticPattern detector ID standardized; session type discriminator added to conflict.js; slugifyLabel consolidated to shared slugify; MODE_OUTPUT_ESTIMATES forecast modes added; pingWatcherRun JSDoc corrected; trial tier cross-reference comment added; resolveContextCap default source fixed; getFileContent return shape normalized in mobile-publish.js; compare.js keepLandmarks documented; sampling-params and conflict-chunking smoke tests added.

## [9.4.12] - 2026-06-30

### Fixed

- **Conflict Detection batch chunking.** Large codebases (>900 KB serialized context) are now split into multiple sub-900 KB batch requests instead of one 2.40 MB POST that caused CI network drops and hung batches. All chunk results are merged via `extractCandidates` before the verifier pass -- no findings dropped. `chunkFileMapForConflict` regression test added and wired into the npm test chain.

## [9.4.11] - 2026-06-30

### Fixed

- **Blast narrator retry on CI connection drops.** Added 90-second timeout and one automatic retry to the narrator streaming call in `blastFindingsFromRaw`. Transient "Premature close" errors now get a second attempt before falling back to raw findings.
- **Degraded-run transparency.** `narratorFailed: true` flag added to the portal findings payload when narrator fallback fires. Portal Watch tab now shows an amber warning banner ("Degraded Results on N Commits") with a rerun link when any commit in the filtered set has degraded findings. Applied to both `portal-ejwisner.html` and `portal-template.html`.
- **Widened self-refuting conflict filter.** `SELF_REFUTING_RE` now catches "rather than a runtime conflict" and "Runtime impact: none" phrasings that the original pattern missed. Fixed `values match` clause with negative lookahead so "values match but will conflict if X changes" is correctly kept as a real finding.
- **Self-refuting filter smoke test.** `tests/self-refuting-filter.smoke.mjs` added with 16 cases (11 drop, 5 keep) + 3 edge inputs. Wired into the npm test chain.

## [9.4.10] - 2026-06-30

### Fixed

- **Finding-quality hardening for Ghost Watcher™.** Junk file tokens (bare
  version strings like `9.4.9`, paren-contaminated paths such as
  `package.json (version field 9.4.9`) are now rejected from `Files:`
  extraction in `src/utils/finding-parser.js`. Rollback-plan report sections
  (Pre-Change Snapshot, Rollback Steps, Point of No Return, Who to Notify,
  Smoke Test After Rollback) are no longer mis-parsed as findings. Self-refuting
  conflict findings (the model flags a conflict then states "no actual
  conflict" / "values match" / "consistent") are dropped before surfacing in
  `src/modes/watcher-commit.js`. Wired `tests/finding-parser.smoke.mjs` into
  the npm test chain with a regression test asserting junk tokens are rejected.

## [9.4.9] - 2026-06-30

### Fixed

- **`scanForVerified` rejects non-source files via a `SOURCE_EXTENSIONS`
  allowlist** (`.md`, `.json`, `.yaml`, `.yml`, `.txt`, `.html`) -- closes
  false-positive verified findings on documentation files that contain the
  `@ghost-verified` marker as plain text.

## [9.4.8] - 2026-06-30

### Changed

- **Documentation-only: clarified Ghost Watcher™ timeout relationship and the
  token-usage rate source.** Added a comment in `ghost-watcher.yaml` above
  `batch.timeout_minutes: 90` explaining that the batch poll timeout is the
  actual limiting factor, the 360-minute Actions job timeout only prevents
  GitHub from killing the job early, and batches exceeding the limit are
  stored and resumed on the next push. Reworded the `buildTokenUsage` comment
  in `src/modes/watcher-commit.js` to state that rates come from `getPricing()`
  multiplied by `BATCH_DISCOUNT` rather than quoting hardcoded dollar amounts.
  No behavior change.

## [9.4.7] - 2026-06-30

### Fixed

- **`codemaseRoot` typo in `lib/ghostBrief.js` dropped the codebase root for
  most callers.** `generateBrief` destructured a misspelled `codemaseRoot`
  param, so every caller passing the correctly-spelled `codebaseRoot` (all three
  Ghost Watcher™ brief calls and the dashboard brief) had its value silently
  ignored and fell back to `process.cwd()`. The param is renamed to
  `codebaseRoot`, and the two callers in `bin/ghost.js` that used the typo are
  updated, so all six call sites now agree and the real codebase root flows
  through to the brief's `codebase_root` field.

- **`@ghost-verified` self-reference trap.** `scanForVerified` matched the bare
  marker string anywhere in a file, so the feature's own implementation (the
  `MARKER` constant, the PR-comment template text, and doc comments describing
  the marker) would falsely mark `ghost-verified.js` and `watcher-commit.js` as
  "verified" when Ghost Watcher™ scanned its own repo. Detection now requires
  the marker to sit in **comment context** — the text before it must end with a
  comment opener (`// `, `# `, `-- `, `/* `), which also adds Python/SQL/CSS
  comment support — and scans every occurrence so a string-literal hit no longer
  short-circuits a real comment elsewhere. The feature's own doc comments were
  reworded so they no longer lead with the bare marker. `redactor.js`'s genuine
  annotation is unaffected. Covered by new cases in
  `tests/ghost-verified.smoke.mjs`.

## [9.4.6] - 2026-06-30

### Fixed

- **`ghost --configure-admin-token` header box now renders before the prompt.**
  The "Configure Admin Token" box was printed synchronously right before the
  masked `inquirer` prompt, but under inquirer v9's render timing the prompt
  could initialize before stdout flushed, drawing the box *after* the input. A
  one-tick event-loop yield (`setImmediate`) after the `console.log` ensures the
  header is flushed before inquirer takes over the TTY.

## [9.4.5] - 2026-06-30

### Added

- **Internal admin CLI commands for license management.** Founder-only,
  undocumented flags for operating the license worker from the CLI:
  `--configure-admin-token` (stores the admin bearer token in the local
  configstore, masked prompt), `--issue-license --tier <tier> --email <email>
  [--days <n>]` (mints a license via `/admin/issue`; runs headless when all
  flags are supplied, prompts otherwise; `--days` defaults to 365), and
  `--revoke-license --key <humanKey> [--reason <reason>]` (revokes via
  `/admin/revoke`). All hard-fail with a non-zero exit when the admin token is
  missing or inputs are invalid. Not shown in `--help`, the interactive menu, or
  the README; the security boundary is the admin token, not flag obscurity.

- **Ghost Portal @ghost-verified renderer.** The Ghost Watcher™ Findings tab now
  renders a collapsed "✅ Reviewed · Expected Behavior" section below active
  findings, populated from the scan file's `verifiedFindings[]`. Findings a
  developer marked `@ghost-verified` appear here (muted styling, no severity
  badge, optional reason) instead of cluttering the active list, and the section
  shows even when all of a commit's findings are verified.

## [9.4.4] - 2026-06-30

### Fixed

- **`trial` tier now has an explicit context cap.** `TIER_CAPS` in
  `src/loader/tierCaps.js` had no `trial` key, so a trial license fell back to
  Open's 50K via the `?? TIER_CAPS.open` default — the right value, but only by
  accident. `trial: 50000` is now explicit (trial shares Open's context cap; the
  trial upgrade adds Pro mode access, not context), with a matching
  `UPGRADE_HINTS` entry, and is locked in by `tests/tier-caps.smoke.mjs`.

- **`narrateConflictReport` temperature aligned with the report-narration
  family.** It generated prose at `temperature: 0` while every other report
  narrator (`narrateReportSync` and the render-pass functions) uses `0.3`. The
  conflict narrator is the conflict-mode sibling of `narrateReport`, so it now
  uses `0.3` for consistent prose variability. (The 0.2 planning passes and the
  deterministic executive-summary narrator are intentionally left as-is.)

## [9.4.3] - 2026-06-29

### Fixed

- **`@ghost-verified` findings no longer get Ghost Brief™ prompts.** Ghost Brief
  generation (Step 8 of the Ghost Watcher™ pipeline) built its adapted-findings
  set from the raw blast/conflict arrays, which still contained findings marked
  `@ghost-verified`. So a finding segregated out of the PR comment and scan file
  could still have a remediation prompt — and a Step 8e detailed prompt —
  generated for it, partially defeating the annotation. Both the brief input and
  the Step 8e `detailById` map now derive from the active finding set
  (`allFindings`), so verified findings are excluded end to end.

### Changed

- **`MAX_TIERS` in `bin/ghost.js` now derives from policy, eliminating gate
  drift.** A new `allowedTiers(gateId)` helper in `src/license/tier-gates.js`
  returns the tiers a gate allows (verdict `=== true`). `bin/ghost.js` now sets
  `MAX_TIERS = allowedTiers('mode:ghost-brief')` instead of a hardcoded array,
  so the Ghost Brief / Executive Brief gate can no longer diverge from the
  `TIER_POLICY` source of truth (the exact drift fixed in 9.4.1).

- **`test-loop-api-error.js` now runs in CI.** The agent-loop API-error test
  lived at the repo root and was never part of the `npm test` chain. It is moved
  to `tests/` and wired in as the final test, so the loop's `ok`/`apiError`
  result contract is now covered.

## [9.4.2] - 2026-06-29

### Fixed

- **GitHub Actions job timeout no longer cuts off long Ghost Watcher™ runs.**
  The Actions job `timeout-minutes` was raised to 360 (GitHub's 6-hour maximum)
  in both the generator template (`src/watch/github-actions-template.yml`) and
  the live workflow (`.github/workflows/ghost-watcher.yml`). The template was
  set to 20 minutes and the live workflow to 90 — the latter matched the batch
  poll budget (`batch.timeout_minutes: 90`) exactly, leaving no headroom for
  cleanup and result write, so a large-codebase scan could be killed at the
  finish line and trigger an unnecessary incomplete-run email. The Actions job
  is now intentionally not the limiting factor: the batch poll timeout and the
  store-and-resume logic own time management, and on a batch timeout the run is
  stored and resumed on the next push, so work is never lost.

## [9.4.1] - 2026-06-29

### Fixed

- **Ghost Brief™ and Executive Brief interactive/CLI gating now Max-only,
  matching policy and docs.** Two divergent `BRIEF_TIERS` arrays in
  `bin/ghost.js` (the mode-selector menu and the `--brief` CLI handler) wrongly
  included non-Max `team` and `enterprise`, so a Team or Enterprise user could
  generate a Ghost Brief interactively or via `ghost --brief` even though the
  authoritative `mode:ghost-brief` policy in `src/license/tier-gates.js`, the
  Ghost Watcher pipeline, and the README/CHANGELOG all restrict it to the Max
  tiers (`pro-max`, `team-max`, `enterprise-max`). Both arrays are replaced with
  a single shared `MAX_TIERS` constant. The same `BRIEF_TIERS` array also gated
  the Executive Brief menu item, so this closes the identical leak there too.
  `WATCH_TIERS` is unchanged — Ghost Watcher deliberately requires Team or
  higher, a separate gate from Brief.

## [9.4.0] - 2026-06-29

### Added

- **`@ghost-verified` annotation system for Ghost Watcher™.** Developers can
  mark a finding's file as reviewed-and-accepted by dropping an in-code comment
  marker, with an optional reason:

  ```
  // @ghost-verified
  // @ghost-verified: legacy adapter is intentional, reviewed 2026-06-29
  ```

  During a watcher run, findings whose files carry the marker are segregated out
  of the active set (so they stop nagging on every commit) but are NOT dropped:
  they surface in a "✅ Reviewed · Expected Behavior" section of the PR comment
  and under a `verifiedFindings[]` key in the portal scan file, keeping the
  suppression auditable and reversible. File-level scope; a finding is verified
  when any of its files carries the marker.

  New module `src/watch/ghost-verified.js` exposes `scanForVerified()` and
  `partitionFindings()`. Detection uses `indexOf` scanning (not regex),
  mirroring the stateful PEM/cert parsers in `src/redactor.js`, so it is
  ReDoS-immune and runs on files of any size. Wired into the Step 7 merge in
  `src/modes/watcher-commit.js`; every downstream consumer (Ghost Brief,
  detailed prompts, portal push, PR comment, telemetry) operates on the active
  set unchanged. Covered by `tests/ghost-verified.smoke.mjs`.

## [9.3.9] - 2026-06-29

### Fixed

- **Max tier licenses now activate via the CLI.** The license worker
  understood the Max tiers (`pro-max`, `team-max`, `enterprise-max`), but the
  CLI's local parser and token validator did not, so `ghost --activate` on a
  Max key (e.g. `GA-2026-TMX-...`) failed with "Token must have 3 parts, got 1":
  `tryParseKey()` rejected the unknown `PMX`/`TMX`/`EMX` segment, and the key
  fell through to the signed-token path. Two fixes:
  - `src/license/format.js` now recognizes the `PMX`/`TMX`/`EMX` key codes via
    bidirectional `CODE_TO_TIER`/`TIER_TO_CODE` maps (mirroring the license
    worker), replacing the hand-rolled tier-normalization ternary. Unmapped
    codes now throw instead of silently falling through.
  - `src/license/token.js` adds `pro-max`, `team-max`, `enterprise-max` to the
    token payload's valid-tier set, so the signed token returned by the
    activation server passes local verification.

  Tier gating (`tier-gates.js`), context caps (`loader/tierCaps.js`), and
  session resolution already supported the Max tiers; only the parser and
  validator were missing.

## [9.3.8] - 2026-06-29

### Changed

- **Ghost Brief™ tier gate now enforced, Max tiers only.**
  `mode:ghost-brief` was defined in `TIER_POLICY` but never consulted,
  so every tier (including Open) could generate a Ghost Brief. The gate
  is now wired at the interactive dispatch in `bin/ghost.js` and in the
  Ghost Watcher pipeline (`src/modes/watcher-commit.js`), and the policy
  is restricted to the Max tiers: `pro-max`, `team-max`, `enterprise-max`.
  Non-Max tiers skip both the basic brief and the Step 8e detailed
  prompts, since the detailed-prompts step only re-generates the brief.

- **Redactor PEM replacement strings extracted to named constants.**
  `PRIVATE_KEY_REPLACEMENT` and `CERTIFICATE_REPLACEMENT` are now defined
  at the top of `src/redactor.js`, separated from the PEM marker strings
  in the variants array. Behavior is unchanged; redaction output is
  identical.

### Added

- **`conflict_verify` verifier wired into Ghost Watcher™.**
  When `scans.conflict_verify: true` in `ghost-watcher.yaml`, conflict
  candidates run through the same agent verifier the interactive Conflict
  mode uses, in `quick` mode (single call per candidate, headless-safe).
  CONFIRMED and POSSIBLE findings are kept; FALSE_POSITIVE and
  INSUFFICIENT are dropped before findings reach the report. Opt-in and
  default-off; with no config, conflict findings flow through unchanged.

- **`detailed_prompts` key in `ghost-watcher.yaml`.**
  Documents the existing Step 8e behavior (LLM-authored remediation
  prompts per finding) as an explicit config key, default `true`.

### Fixed

- **`buildTokenUsage` batch rates derive from the pricing table.**
  The hardcoded `$1.50`/`$7.50` per-1M batch rates in
  `src/modes/watcher-commit.js` are replaced with
  `getPricing('claude-sonnet-4-6')` standard rates from
  `src/core/estimator.js` multiplied by the `BATCH_DISCOUNT` constant in
  `src/lib/cost-estimator.js`. Computed values are identical
  ($1.50/$7.50), now sourced from the single pricing source of truth.

## [9.3.7] - 2026-06-29

### Fixed

- **Max-tier context caps.**
  Pro Max, Team Max, and Enterprise Max now correctly receive 100K,
  150K, and 200K token context caps respectively. Previously these
  tiers were absent from the canonical `TIER_CAPS` table in
  `src/loader/tierCaps.js` and silently fell back to the Open 50K
  cap, under-capping paying Max customers.

- **FREE_QUOTA duplication.**
  Removed the duplicated `FREE_QUOTA` constant from
  `src/freemium.js`; the quota now imports `SCAN_QUOTA` from
  `src/license/tier-gates.js`, the single policy source of truth.

### Changed

- **Ghost Watcher™ iteration limit is now opt-in.**
  The Step 1c iteration guard fires only when `iterations.max` is
  explicitly set in `ghost-watcher.yaml`. With no config, no limit is
  applied and Watch runs on every push. The prior hardcoded default
  of 10 is removed.

### Added

- **`shouldSkipForIterationLimit` exported pure helper.**
  The iteration-limit predicate is extracted from `runWatchCommit`
  into an exported, unit-testable function in
  `src/modes/watcher-commit.js`, with a dedicated smoke test
  (`tests/watcher-iteration-limit.smoke.mjs`). A tier-caps smoke test
  (`tests/tier-caps.smoke.mjs`) covering all seven tiers and the Open
  fallback was added alongside the cap fix.

## [9.3.6] - 2026-06-29

### Added

- **Token and cost telemetry in the Ghost Watcher™ writer.**
  All batch paths (Blast Radius, Conflict Detection, detailed prompts,
  and resume) now record `inputTokens`, `outputTokens`, and
  `estimatedCostUsd` at Anthropic batch API rates ($1.50 input /
  $7.50 output per 1M tokens). Unit tests added for `buildTokenUsage`
  and `sumBatchUsage`.

## [9.3.5] - 2026-06-28

### Fixed

- **Ghost Watcher™ PR comments are now fully markdown-escaped.**
  Finding titles and branch names can no longer inject markdown into
  GitHub PR comments.

### Maintenance

- Versions 9.3.2, 9.3.3, and 9.3.4 were release-sync bumps with no
  functional changes (version string and README hero line only).

## [9.3.1] - 2026-06-26

### Added

- **Ghost Watcher™ email notifications.**
  Ghost Watcher™ now emails the customer after every scan. A findings
  email reports per-finding detail (severity badge, title, affected
  files, description) plus a severity summary (critical / high /
  medium / low counts). A clean-scan email confirms when a commit
  produced zero findings. Both emails are fire-and-forget and never
  block the CI pipeline.

## [9.3.0] - 2026-06-26

### Added

- **Streaming vs Batch transport menu.**
  Every scan mode that calls the Anthropic API now opens with a
  cost-aware choice: run live (streaming) for real-time results, or
  submit to the Message Batches API for half-price processing
  retrieved when ready. The menu shows loaded file count, a token
  estimate, and streaming vs batch cost side by side. `--stream` and
  `--batch` skip the menu; CI and Ghost Watcher™ runs default to batch.

- **Batch retrieval commands.**
  `ghost batch-status` lists every pending batch and whether it is
  ready. `ghost batch-retrieve <id>` pulls a finished batch and
  produces the same report files a live run would have.

- **Dynamic pending-batch menu rows.**
  The main menu injects a row per pending batch, grayed out while
  processing and selectable once ready.

- **Transport metadata in every artifact.**
  The `findings.json` sidecar carries a transport block (method,
  timestamps, version), and the PDF, Markdown, TXT, and Ghost Brief™
  HTML each carry a one-line transport footer.

- **Question mode batch support.**
  Question mode joins Blast Radius in supporting the transport menu,
  batch submission, and batch retrieval.

### Fixed

- **Deterministic output.**
  Every Anthropic call site now sets temperature 0, so repeated scans
  of the same codebase produce consistent results.

- **Setup wizard tier cap.**
  The first-run wizard now defaults context size to the actual tier
  cap (Open 50K, Pro 100K, Team 150K, Enterprise 200K) instead of a
  hardcoded 50K, sourced from the single canonical tier-cap table.

- **Accurate source identity.**
  The loader records the source of every scan (ZIP path for archive
  loads, owner and repo for GitHub loads), and batch repository names
  are derived from the git remote origin rather than the current
  directory name.

## [9.2.3] - 2026-06-25

### Fixed

- **Ghost Brief™ generates after batch Blast Radius.**
  Raw batch output is now passed through the narrator before finding
  extraction, replicating the old streaming path. Ghost Brief™
  receives findings with populated file arrays and generates prompts
  correctly.

## [9.2.2] - 2026-06-25

### Fixed

- **Replaced Anthropic SDK batch transport with native fetch.**
  The SDK's internal HTTP client drops connections on GitHub Actions
  runners when calling `/v1/messages/batches`. Native Node.js fetch
  succeeds reliably. All four batch operations (submit, poll, cancel,
  preflight) now use native fetch directly.

## [9.2.1] - 2026-06-25

### Added

- **Preflight reachability check.**
  Before uploading the full codebase context, Ghost Watcher™ sends a
  tiny 1-token test batch to verify the Anthropic Batches API is
  reachable. If unreachable, the run exits cleanly with a clear
  diagnostic instead of burning a 0.6MB upload.

- **Body size logging.**
  The batch request body size is logged on every submission so CI
  logs show the real payload size.

### Fixed

- **submitBatch retry with backoff.**
  Batch submissions now retry up to 4 times with exponential backoff
  (2s, 4s, 8s) on transient connection errors (Premature close,
  ECONNRESET, socket hang up).

## [9.2.0] - 2026-06-25

### Added

- **Anthropic Message Batches API.**
  Ghost Watcher™ submits Blast Radius and Conflict Detection scans as
  async batch requests processed server-side. No streaming connection
  to drop, no Premature close errors regardless of codebase size.

- **Auto-resume.**
  If a GitHub Actions job is interrupted before results arrive, Ghost
  Watcher™ automatically retrieves and delivers the results on the
  next commit push.

- **Incomplete run emails.**
  When a run is interrupted, the customer receives an email explaining
  what happened and confirming results will be delivered automatically.

- **Resume notification emails.**
  When Ghost Watcher™ detects and resumes an incomplete scan, the
  customer receives emails at resume-detected and resume-complete
  milestones.

- **Pending portal state.**
  Ghost Portal™ shows a pending entry immediately when a batch is
  submitted, rather than silence while processing.

- **Configurable batch settings.**
  Poll interval and timeout are controllable via the `batch` section
  of `ghost-watcher.yaml`.

### Fixed

- **GitHub Actions timeout raised to 90 minutes** to accommodate the
  batch polling window.

## [9.1.4] - 2026-06-25

### Fixed

- **Premature close on Blast Radius and Conflict Detection in CI.**
  All three Anthropic API stream calls in the analyst are switched to
  non-streaming (`stream: false`) in CI environments, eliminating
  mid-response stream closure on large context windows. Local dev
  still uses streaming.

## [9.1.3] - 2026-06-25

### Fixed

- **Premature close in CI.**
  Ghost Watcher™ now detects CI environments and switches to
  non-streaming API calls (`stream: false`), eliminating stream
  timeouts on large context windows (150K Team, 200K Enterprise).
  Local dev still uses streaming.

## [9.1.2] - 2026-06-25

### Fixed

- **Ghost Watcher™ CI context cap.**
  Team tier now uses 150K tokens in CI (was incorrectly clamped to
  the 50K Open default). Enterprise now uses 200K. Added an
  `ignoreSavedContext` flag to bypass stale configstore values on
  ephemeral CI runners.

- **Stream retry on transient errors.**
  Premature close, ECONNRESET, and socket hang up errors now retry up
  to 2 times with exponential backoff before failing, reducing false
  zero-findings runs caused by network blips in CI.

### Maintenance

- Version 9.1.1 was a Ghost Watcher™ validation-trigger run with no
  functional changes.

## [9.1.0] - 2026-06-24

### Fixed

- **Dogfood pass 10.**
  Ghost Architect™ scanned its own codebase using Ghost Brief™ and
  fixed 7 issues; Ghost Watcher™ confirmed zero findings after the
  push. Prompt-injection defense hardened in consultant profile
  sanitization (Unicode NFC normalization, zero-width rejection,
  bidirectional override blocking). Temp directory leak in Commit
  Forecast closed with try-finally cleanup on all exit paths. API
  error masking in the agent loop fixed (`ok` field added, test
  coverage added). LLM plan validation now prevents findings from
  being silently dropped from reports. Manifest concurrent-write race
  closed with post-write content verification. Audit-log failure
  threshold lowered from 3 to 1.

## [9.0.8] - 2026-06-23

### Fixed

- Team and Enterprise tiers now correctly apply the 150,000 token
  context cap in CI.
- License validation works on ephemeral GitHub Actions runners
  (fingerprint bypass in CI).
- Custom branches added in the Enable Watch wizard now correctly
  appear in the GitHub Actions workflow trigger.
- PR comment portal link now uses the correct lowercase slug.
- The Enable Watch wizard version-pins the workflow to the installed
  Ghost version.

### Maintenance

- Versions 9.0.1 through 9.0.5 were publish and version-sync bumps
  with no functional changes.

## [9.0.0] - 2026-06-23

### Added

- **Ghost Watcher™, automatic commit monitoring.**
  A headless CI pipeline that runs inside GitHub Actions. When a
  developer pushes to GitHub, Ghost Watcher™ analyzes changed files
  against the full codebase, surfaces findings, generates a Ghost
  Brief™ prompt pack, pushes results to Ghost Portal™, and posts a PR
  comment summary. Includes a portal Watch tab, a CLI menu, and a
  cost estimator. Available on Ghost Team and Ghost Enterprise
  memberships.

## [8.2.5] - 2026-06-22

### Added

- **Ghost Partner™ Profiles in the top-level menu.**
  Ghost Partner™ Profile is now accessible from the first Ghost menu
  with no codebase selection required. Select a profile, activate it
  for the session, and every scan uses your branding automatically.

### Maintenance

- Versions 8.2.6 and 8.2.7 were version-sync bumps across platforms
  with no functional changes.

## [8.2.2] - 2026-06-20

### Added

- **White-label branding across all report types.**
  Ghost Partner™ branding (company name, accent color, footer,
  confidentiality line) is applied consistently across every report
  type, not just the PDF.

## [8.2.0] - 2026-06-20

### Added

- **Executive Brief.**
  A one-page business-intelligence report for non-technical
  stakeholders: health score 0 to 100, a plain-language executive
  narrative, a manual vs AI-assisted cost comparison table, and a
  three-phase remediation sequence. Available on Pro Max, Team Max,
  and Enterprise Max.

## [8.1.2] - 2026-06-17

### Fixed

- **Ghost Brief™ dogfood pass 4.**
  Six fixes: prompt injection via consultant profile fields
  (`narrator.js`), freemium quota bypass closed (`tier-gates.js`),
  seat registration verification race fixed (`enterprise.js`), silent
  Tier 2 detector failures now surface to stderr, GitHub Enterprise
  Server URL parsing fixed for team-sync, and GitHub API rate-limit
  retry with user-facing progress messages plus a continue/stop prompt.

### Maintenance

- Versions 8.1.3 through 8.1.9 were version-sync bumps with no
  functional changes.

## [8.1.0] - 2026-06-17

### Fixed

- **Ghost Brief™ dogfood passes 1 and 2.**
  Ghost Architect™ scanned its own codebase using Ghost Brief™ and
  Claude Code fixed 19 findings across two iterative passes. Zero
  critical findings remaining. Test suite expanded with 4 new smoke
  test files.

## [8.0.3] - 2026-06-17

### Changed

- **Ghost Brief™ prompt quality overhaul.**
  Prompts now include full remediation context, fix steps,
  constraints, confidence score, and effort estimate extracted
  directly from scan findings. Validation hints are now
  finding-specific.

## [8.0.2] - 2026-06-16

### Added

- **Ghost Brief™.**
  Convert any Ghost scan into a validated, blast-radius-aware Claude
  Code prompt pack. Ghost reads the findings JSON, converts each
  finding into a structured prompt with blast-radius ordering,
  validation hints, and file context, and writes `ghost-brief.json`
  to disk. Feed it into Claude Code, Cursor, or Copilot. If Ghost
  Portal™ is configured, the Brief is pushed automatically. Requires
  Ghost Pro Max or higher.

## [8.0.0] - 2026-06-16

### Added

- **Ghost Brief™ launch.**
  First release of the Ghost Brief™ prompt-pack pipeline. Initial
  `--brief --input=<path>` flag and post-scan menu entry land here;
  the prompt-quality overhaul follows in 8.0.3.

## [7.2.0] - 2026-06-04

### Notes

- Working-session rollup bump. No standalone changelog content was
  authored for this version; functional changes are captured in the
  surrounding 7.1.x and 8.0.x entries.

## [7.1.0] - 2026-05-29

### Added

- **Commit Forecast mode.**
  New ninth mode in Ghost Architect™. Analyzes a set of proposed file
  changes against the production baseline and forecasts the Blast Radius
  and Conflict impact of accepting those changes — before the developer
  commits or pushes. Ghost does not apply changes, does not commit, does
  not push. It shows what *would* happen if the developer did.

  Two entry surfaces, one code path:

  - **Pre-commit forecast** — Ghost auto-discovers working-tree changes
    via `git diff --name-only HEAD` plus staged and untracked files.
    No arguments required. The developer's working directory *is* the
    proposed folder.

  - **Offline / received-files forecast** — Developer points Ghost at
    an explicit folder of proposed files that mirrors the repo's relative
    directory structure. Covers the offshore-review use case (architect
    receives files from an offshore team and wants to assess impact before
    accepting them).

  Core design:

  - **Synthesis primitive** (`src/core/forecast-overlay.js`): builds an
    in-memory overlay where proposed files overwrite their baseline
    counterparts and Ghost falls back to the baseline for everything else.
    Proposed files go through the same redaction pipeline as baseline files.
    Path resolution uses mirror-structure matching with bidirectional
    fuzzy fallback for teams that send loose files without full directory
    structure. Changed files are front-loaded in the context string so
    they're always included under the token cap.

  - **Analyst framing**: Blast Radius and Conflict Detection prompts are
    reframed when called from Commit Forecast. The model is told these
    files are not committed yet and to frame every finding as "if you push
    now, X breaks" — not generic architectural observations.

  - **Inline diff renderer** (`src/utils/diff-renderer.js`): optional
    per-file diff shown before analysis runs. LCS-based line diff with
    context hunks, hunk separators, and hard caps (60 changed lines per
    file, 8 files in detail) to prevent wall-of-text on large change sets.

  - **Tier gating**: Open gets one free Commit Forecast per install,
    tracked under a separate `ghostOpenForecastCount` key (isolated from
    the 4-scan POI/Blast/Conflict quota — Forecast is designed to run
    many times per day and would drain the shared quota in minutes).
    Pro/Team/Enterprise are unlimited.

  - **Menu**: `🔮 Commit Forecast` appears between Conflict Detection and
    Recon in the mode menu.

  - **Marketing angle**: "Cut your container-to-stage cycles from five to
    one." Commit Forecast closes the container-vs-production gap by
    analyzing the developer's proposed changes against the actual
    production codebase before they push.

  - **Smoke test suite**: 36 checks covering tier gate logic, forecast
    counter, synthesis primitive path mapping, error handling, conflict
    prompt framing, git repo detection, and diff renderer edge cases.

## [7.0.0] - 2026-05-26

First public release of `ghost-architect-open` on npm. Install with
`npm install -g ghost-architect-open`.

### Added

- **Question mode.**
  Single-question Q&A surface for Open users. Ask anything about
  the codebase in plain English, get an answer, optionally save it.
  Replaces the prior Chat surface on the Open tier (Chat remains
  available on Pro+ for ongoing multi-turn conversation). Vocabulary
  is unified across all seven Open-facing surfaces: menu items,
  cost telemetry, saved reports, and documentation all use
  "Question and Answer" consistently.

- **Worker-driven promo banner.**
  The no-license banner shown to Open users can now display a
  server-driven promotional line that updates without a CLI
  redeploy. EJ edits the `PROMO_TEXT` constant in the signup
  worker, runs `wrangler deploy`, and every Open install on next
  run sees the new text within the 60-second edge cache window.
  Empty, null, missing, or malformed responses suppress the line
  silently — the banner renders cleanly without it. Two-second
  timeout on the fetch. The CLI is a passive renderer; the worker
  is the source of truth.

- **Prompt Triage mode visible at top level.**
  Now grouped under its own "Prompt analysis" header in the input
  method menu so users can find it without searching the mode
  menu. Audits a folder of LLM prompts for structural defects:
  missing context, ambiguous instructions, brittle assumptions,
  token bloat.

- **Inheritance Audit mode (Pro+).**
  Deal-grade codebase audit for buyers, PE diligence teams,
  fractional CTOs onboarding to engagements, and modernization
  consultancies scoping rebuilds. Four analyzers (Stack Reality
  Check, Key-Person Risk, Hidden Dependency Map, Modernization
  Roadmap) combine into a 5-page deal-grade PDF plus TXT and MD.
  Runs 30 to 60 seconds at $0.02 to $0.04 in API charges. Open
  tier shows an information panel; no partial run.

- **Ghost Partner™ white-label consultant profiles.**
  Consultants and agencies can run scans with their own branding,
  methodology, and rates baked into the report. Profiles are
  YAML, Markdown, or plain-text documents loaded with `--profile`.
  The profile wizard (`ghost --create-profile`) walks users
  through priorities, anti-patterns, red flags, billing rates,
  and branding interactively. Default-profile support means a
  loaded profile auto-applies to every scan unless overridden
  per-run. Paid-tier feature; Open produces neutral Ghost-branded
  reports.

- **CLI flag set for context, exclusion, and profile control.**
  `--max-context <N>` clamps to tier limit. `--exclude <glob>`
  is repeatable. `--exclude-presets` applies named exclusion
  bundles (test-data, generated, vendor-cache). `--profile`,
  `--no-profile`, `--create-profile`, `--list-profiles`,
  `--set-default-profile`, and `--clear-default-profile` cover
  the consultant-profile lifecycle.

- **License activation flow.**
  `ghost --activate <key-or-token>` handles both human-typeable
  keys (POST to activation server, signed token returned) and
  pre-signed tokens (verified locally, no network). Fingerprint
  binding ensures licenses can't be moved between machines
  without reissuance. `ghost --license` shows current status
  offline. `ghost --license-clear` removes the installed license.
  `ghost --start-trial` activates a 14-day evaluation trial,
  one per machine.

### Changed

- **Default model: Claude Sonnet 4.6 (was Sonnet 4.5).**
  All new wizard configurations pick Sonnet 4.6 as the recommended
  default. Existing users with a saved configuration keep their
  previously-selected model until they reconfigure. Pricing
  unchanged ($3 input / $15 output per million tokens).

- **Premium model: Claude Opus 4.7 (was Opus 4.5).**
  Wizard and audit-mode model picker now offer Opus 4.7 as the
  premium choice. Pricing: $5 input / $25 output per million tokens.

- **Pricing table consolidated.**
  `src/core/estimator.js` is the single source of truth for
  per-model pricing across the entire codebase. Modes and detector
  infrastructure all import from this table. Includes current
  generation (Opus 4.7/4.6, Sonnet 4.6, Haiku 4.5) plus backward
  compat entries for users still on prior models.

- **README rewritten for npm.**
  Install command (`npm install -g ghost-architect-open`)
  prominently positioned at the top. Six modes documented
  (Question, POI, Blast, Conflict, Prompt Triage, Recon) plus
  the Pro+ Inheritance Audit. Tier comparison table reflects
  current capabilities. Cost expectations and pricing table
  updated to Sonnet 4.6.

### Fixed

- **`bin` field validation.**
  `package.json` `bin` value normalized from `"./bin/ghost.js"`
  to `"bin/ghost.js"` so npm doesn't strip the entry during
  publish. Earlier 7.0.0 ship attempts triggered an npm warning
  about the leading `./` being invalid; the binary would have
  been removed from the installed package on platforms where the
  warning escalated to an error. Users who install 7.0.0 from npm
  now get `ghost` correctly available on their PATH.

- **Vocabulary leak in trial-start banner.**
  The trial-start success banner previously listed `Recon, Chat`
  as still-working modes. Now correctly lists `Recon, Question`
  in line with Question mode being the Open-tier Q&A surface.

### Notes

- Three-tier internal release: Open (`7.0.0`, public npm), Pro
  and Team (via git+https from umbrella repo). Pro and Team will
  receive the v7.0.0 promo banner and model-default updates in a
  follow-up release; today's launch is Open-only on npm.
- Cumulative changes since v5.4.0 (the last documented version)
  represent the v6.x series (License Worker, Stripe integration,
  enterprise customer flow) plus the v7 series unifications
  (Question mode rename, Inheritance Audit launch, promo banner).
  Intermediate version entries will be backfilled in a future
  CHANGELOG pass.

## [5.4.0] - 2026-05-12

### Added

- **Inheritance Audit Mode (Pro+).**
  A new mode purpose-built for deal-grade codebase audits. Audience:
  agency founders running pre-engagement diligence, fractional CTOs
  onboarding to new engagements, PE/M&A diligence teams, and
  modernization consultancies scoping rebuilds. Produces a 5-page
  deal-grade PDF (plus TXT and MD) combining four analyzers:
  Stack Reality Check (language census, framework detection, EOL
  flagging), Key-Person Risk (git history parsing, bus factor,
  contributor concentration, departed-author flagging), Hidden
  Dependency Map (license risk, EOL exposure, commercial
  encumbrances), and Modernization Roadmap (LLM-synthesized
  stabilize-vs-rebuild recommendation with 90-day plan and
  confidence rating). Runs in roughly 30 to 60 seconds at roughly
  $0.02 to $0.04 per audit in API charges. Validated end-to-end
  against magento/meta-for-magento2 in three configurations:
  local clone (666 files, 68 deps, multi-author KPR), GitHub
  capped (198 files, 8 deps, graceful KPR degradation), GitHub
  full (669 files, 68 deps, complete coverage matching local).

- **Per-run model picker in Audit Mode.**
  Inquirer list prompt between project label and cost estimate.
  Default selection respects the user's global defaultModel config
  so pressing Enter is the happy path. Audit is a high-stakes
  deliverable; users may want Opus for an important deal even if
  they run POI on Sonnet day-to-day. Cost estimate reflects the
  per-run model choice, not the global config.

- **Save prompt in Audit Mode.**
  `Save this audit to ~/Ghost Architect Reports/?` confirm before
  saveReport runs. Default Yes (audit is the deliverable). User can
  bail if the synthesis came back weak. Matches POI/Blast convention.

- **GitHub loader file-count prompt for large repos.**
  When the GitHub loader detects more than 200 code files in the
  user's selected folders, pause before fetching and ask whether
  to fetch all or sample the first 200. Default Yes (fetch all)
  since senior users running deal-grade audits expect complete
  coverage. The prompt tells the user the cost estimate fires
  inside the mode before the report runs, so they get a second
  chance to bail at no cost. Behavior applies to every mode that
  loads from GitHub, not just Audit.

### Tier gating

- **Audit Mode is Pro+ entirely.**
  On Ghost Open, selecting Inheritance Audit shows a clean
  information panel explaining what the feature does, what it
  costs, and how to upgrade. No partial run, no analyzers, no
  API charges. The user picks 'Back to mode menu' (default) or
  'Open pricing page in browser' and the flow continues. The
  paywall takes the same fail-closed posture as the existing
  Pro+ Project Intelligence gating from v5.2.1: tier defaults
  to 'open' if any caller forgets to pass it.

- **Why no stripped-down free version of Audit Mode.**
  A stripped-down free version misrepresents the product. An
  Open user either thinks "that's all it does" (damaging
  Ghost's reputation for what Audit IS) or feels held hostage.
  Audit Mode is a deal-grade artifact; Open gets the honest
  information panel and an explicit upgrade path.

### Notes

- Audit Mode v0.4.0 ships with all four analyzers live and
  deal-grade reports saving. Future enhancements scheduled for
  later versions: audit-over-time comparison (Team tier
  differentiator), custom PDF branding (Enterprise tier
  differentiator), transitive dependency walking, CVE scanning.

- Stack Reality framework dedup: composer.json files in each
  Magento module previously triggered duplicate PHP detections.
  Fixed via dedup map keyed on (name, version).

- Version constraint normalization: Composer multi-version
  syntax `8.1.0||~8.2.0||~8.3.0||~8.4.0` previously leaked into
  deal-grade reports. Normalized to clean range `8.1.0 – 8.4.0`.

## [5.2.1] - 2026-05-10

### Fixed

- **Project Intelligence in Prompt Triage is now correctly tier-gated.**
  Prompt Triage now respects the same Pro+ entitlement that has always
  applied to Project Intelligence in POI, Blast, Conflict, and Recon.
  On Pro, Team, and Enterprise the project label prompt and baseline
  comparison continue to work exactly as in 5.2.0. On Open the project
  label prompt is skipped and no project history is written, matching
  how Open already hides the Project Dashboard and Compare Reports
  menu items. The mode now accepts a `tier` option which defaults to
  `'open'` (fail-closed) so that any caller that forgets to pass a
  tier does not leak a paid feature.

## [5.2.0] - 2026-05-10

### Added

- **Prompt Triage detector pack v1 is complete (16 detectors).**
  Tier 3 `integrationMismatch` detector ships, closing the original
  Tian et al. 2025 taxonomy mapping. Hybrid regex + LLM verification
  catches integration-shape contract drift inside prompts (output
  format declarations vs few-shot examples, tool schema field-name
  drift, envelope mismatches, parameter-vs-instruction tension).

- **Cost pre-flight in Prompt Triage.**
  Before any Tier 2 LLM calls fire, the user sees a cost band
  estimate and confirms y/n. Actual cost reported after the scan
  completes. Brings Prompt Triage into parity with POI/Blast/Conflict
  which already had cost pre-flight.

- **Project intelligence in Prompt Triage.**
  Prompt Triage scans now optionally accept a project label and
  participate in the same baseline/comparison/velocity tracking
  POI uses. Re-running Prompt Triage on the same prompts shows
  resolved findings, new findings, and remediation progress.

- **Assertion-based test harness (`tests/assert-prompt-pack.mjs`).**
  30 cheap assertions covering Tier 1 fixture detection, F-34 loader
  filtering, production prompt baselines, and integrationMismatch
  regex pre-filter. Runs sub-second, deterministic, no LLM calls.
  Replaces eyeball-only smoke for regression detection. The smoke
  harness (`tests/smoke-prompt-pack.mjs`) remains for manual
  Tier 2 verification with `SMOKE_TIER2=1`.

### Changed

- **Loader file-type filtering (F-34).**
  `loadPromptSource` no longer treats project metadata files as
  prompts. CLAUDE.md, package.json, package-lock.json, tsconfig.json,
  ESLint/Prettier configs, and `*_FOLLOWUPS.md`/`*_PLAN.md` files
  are now excluded. Repo-root scans go from ~59 noise files to 52
  legitimate prompt files.

- **`unboundedOutput` detector tuned (F-37).**
  Extended `CONSTRAINT_MARKERS` to recognize bounded verbs
  (format-as-template, range-with-adjectives, bare-count-with-
  adjectives) and added behavioral-guideline-bullet heuristic to
  suppress findings on rule-list bullets that are not output
  directives. Cleared 3 false positives in production prompts.

- **POI prompt overhaul (F-38 to F-51, 14 fixes).**
  Severity rubric defined with per-tier criteria. Effort hour
  anchors locked: Low 2-6 hrs @$85/hr, Medium 8-20 hrs @$125/hr,
  High 24-60 hrs @$200/hr, Requires architect 60+ hrs @$200/hr
  (billing rates unchanged). Complexity tiers defined. Priority
  ordering criteria explicit. Rate sourcing default specified.
  No-profile naming fallback added. "Straightforward" defined as
  "<10 lines in single file". 4-tier severity to 3-tier billing
  mapping documented. Placeholder template replaced with schema +
  concrete row example. Consultant-checks overlap rule added.
  Landmarks effort N/A exception noted. Profile identifier
  annotated. "Thorough but ruthless" rewritten for clarity.

- **Blast prompt overhaul (F-52 to F-60, 9 fixes).**
  REMEDIATION PLAN gets inline rubrics for effort/complexity/risk.
  ROLLBACK PLAN gets time/complexity rubrics. Target source made
  explicit. Smoke test selection criteria defined across 3
  dimensions. Rollback steps placeholder described. Consultant-
  checks rewritten mode-agnostic.

- **Conflict prompt fixes (F-61 and F-62, 2 fixes).**
  Overall risk aggregation rule added. Per-finding output
  structure templated.

- **Pricing canonicalized.**
  `src/core/estimator.js` is now the SINGLE SOURCE OF TRUTH for
  model pricing. Includes Opus 4.7/4.6/4.5 ($5/$25 post Nov 2025
  price drop), legacy Opus 4/4.1 ($15/$75), Sonnet 4.6/4.5
  ($3/$15), Haiku 4.5 ($1/$5).

### Deferred to v5.3

- **F-12 detector threshold tuning**: needs 3 or more calibration scans
  for a data-driven retune; today's dogfood is n=1. Detectors
  performed well at current thresholds, so deferring rather than
  shipping noise as signal.

- **Cross-system integration mismatch detection**: v5.2's Tier 3
  detector handles prompt-internal consistency only. Detecting
  mismatches against calling code or downstream parsers requires
  Ghost to analyze both sides; that's a v5.3+ extension.

### Notes

- Three-tier release: Pro (`5.2.0-pro`), Team (`5.2.0-team`),
  Open (`5.2.0`).
- npm publish: Open tier only, as `ghost-architect-open`.
- All 26 prompt fixes cleared in dogfood validation; production
  prompts now produce 0-2 Tier 1 findings each (was 1-15).
- Calibration data point: May 10 dogfood scan, 472 LLM calls
  on 52 prompts against Opus 4.7, $18.58 actual vs $17.70
  estimated (within 5%).
