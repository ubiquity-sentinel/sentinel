# Sentinel stabilization and development feedback plan

Historical stabilization contract and checkpoint, retained at its recorded revisions; current task ownership, hosted authority and execution order are in the current build ledger and decisions. Its per-attempt approval, P0/P1 severity and fixed-controller installation wording is superseded by current scoped authority, P0-only severity policy and launcher self-install. Broader gateway activation requirements remain separate work.

Make Sentinel reliably carry eligible work through implementation, review, CI, merge, issue closure and the applicable deployment acceptance, while making defects reproducible and fixes cheap to verify locally. Start with failure diagnostics, offline reproduction and the measured Git state bottleneck; then repair lifecycle recovery, simplify trusted installation and prove delivery in production.

Extracted on 2026-10-11 from session `01a126e0-7f98-7373-ac0a-48e3e2dcdf62`, including its unfinished draft and command evidence, and reconciled on 2026-10-13 against source `8bebacbc05360a22580e1e83cba2b2c5c4868fcb` and pinned runtime evidence. The current user request authorizes updating this plan and starting local implementation. The 2026-10-13 takeover directive retires Muse and transfers Sentinel integration ownership to the current GPT-6.1 Sol coordinator. It does not grant a hosted attempt, live state change, target promotion transfer or production acceptance. [AGENTS.md](../AGENTS.md), [MASTER-PLAN.md](../MASTER-PLAN.md) and [DECISIONS.md](DECISIONS.md) govern execution; [build-status.md](build-status.md) remains the sole ownership and acceptance ledger.

## Current execution handoff

Continue the complete module-restoration outcome. The sole ledger records immutable runtime R `c8d2e87468399abb54cc9d9a749ae7b400835bbb`, its successful focused local acceptance and source-only publication on the original canonical branch, plus paired gateway candidate `9d83f306a92b11a0929c414b445fc8a1367e01d9`. Preserve the accepted module ancestry and original goal identity. Exact-R deterministic CI is the next source gate; r28 prepares a later fixed controller C that pins R, with independent affected validation and audit. Do not expand local checks into a whole-repository sweep without explicit authority. Gateway literal verification remains unaccepted under measured resource pressure and unresolved override ownership. Existing restricted bridge/key/environment/startup-guard authorizations are settled; setup remains run-disabled. Finish controller and exact canonical/shipping proof before any separately approved hosted attempt. Qualifying authenticated captured-request regression, actual target custody, retained-evidence/telemetry policy, two qualifying new deliveries, continued selection/interruption recovery, isolated promotion/continuous acceptance/exact rollback and six observed hours after activation remain distinct incomplete acceptance surfaces.

## Outcome and completion

The primary goal is the full project vision. A healthy supervisor, an implemented patch, a merged PR and an accepted deployment are separate results. Stabilizing issue processing is an intermediate milestone; the gateway incident, permanent regression, release and observation requirements remain part of the final outcome.

The secondary goal is a short development loop: changed-file checks within 10 seconds, affected tests and one offline lifecycle replay within 60 seconds, hosted CI within 6 minutes, and an approved runtime installation within 25 minutes. These are proposed performance targets to measure on declared hardware and workload, not existing guarantees or permission to skip checks.

Deliver these results in order:

1. Every failed model attempt and stalled phase has a safe, actionable diagnostic and a local reproduction where evidence permits.
2. State reads and writes preserve their integrity guarantees while avoiding repeated history downloads and one process per record.
3. Every blocked task has a verified terminal disposition, a concrete recovery condition, or a named human action; retries preserve evidence and accounting.
4. Target-specific checks, candidate preservation, current-head review, CI and issue closure work through the actual trusted controllers.
5. Installation and interruption recovery require bounded, repeatable procedures rather than a new hand-written controller branch for every release.
6. Exact runtime and target receipts demonstrate autonomous delivery, rollback and sustained operation through the original activation gates.

## Evidence and current starting point

The measurements below are historical observations from 2026-10-10, recovered from the requested session's persisted command results. They are useful baselines; they are not a fresh production status report.

| Observation | Recorded evidence | Planning consequence |
| --- | --- | --- |
| A production `readRepair()` took 33.761 s and 31.016 s for 258 work records. | Session command ordinal 659, exit 0. | Optimize the actual state store before restructuring the entire repair loop. |
| Fetching full state history took 11.308 s; depth-one fetch took 0.782 s. | Ordinal 590, exit 0; 27,144 commits were counted in ordinal 584. | Reuse a private workspace and fetch history only when the requested proof needs it. |
| Reading 931 blobs separately took 16.265 s; one batch took 0.094 s. | Ordinal 621, exit 0. | Batch object reads. The roughly 173-fold improvement concerns blob reading, not the entire pipeline. |
| The CI harness took about 21 minutes; three candidate-handoff tests consumed about 505 s. | CI run `38073383542`; ordinals 1181 and 1200, exit 0. | Profile the slow cases, retain their real-Git coverage, then shard the hermetic harness. |
| The local repair-loop file took 205.117 s for 98 passing tests. | Ordinal 1204, exit 0. | Add affected-test selection and split independently runnable cases after their owners finish. |
| The draft recorded 14 failed Sentinel-target cells at generation 73 and many blocks among open gateway issues. | Historical job/state analysis in the source session; generation 73 runtime `37c81e771cfedcf0b1e6b4cb70cbed04c8bb6e87`. | Reconcile current records and diagnose the model boundary; do not treat historical counts as today's workload or recovery eligibility. |
| Release requests remained pending while `sentinel-release` was disabled. | State inspection at ordinals 1224 and 1229; disabled release policy remains in current decisions. | Report merge progress separately and complete the target release contract before claiming deployment. |

The session's successful gateway HTTP responses do not prove that the matching Codex turn, receipt validation or candidate export succeeded. Output limits, sandbox failures, session settlement and routing identity were hypotheses, not established root causes. Long tests near two-minute multiples likewise do not prove real-clock sleeps. Profile the exact boundaries before choosing either fix.

The benchmark host exposed one CPU before a restart and two afterward; do not attribute all measurements to one fixed two-CPU machine. Retain hardware, cache state, exact input and command alongside new measurements.

At the 2026-10-13 reconciliation, the root checkout remains `development` at `d72df6d45e7f9f79a2b52ac907988f4df9cf7bac`, 72 commits behind freshly fetched source `8bebacbc05360a22580e1e83cba2b2c5c4868fcb`; both `origin/development` and `origin/sentinel-supervisor` resolve to that exact source. Preserve existing dirty `docs/build-status.md`, `ops/hosted-autonomy.ts` and `tests/host/hosted-autonomy_test.ts`. The two-file owner patch is still SHA-256 `922cd7c9d828ca1f6b7fbce7b578bb568fe9f79daacb755d1cf974d98f3694c1`. This plan was untracked; its prior verified content is preserved at `/tmp/sentinel-stabilization-refresh-20261013/previous-stabilization-plan.md`, SHA-256 `16a5c822b45532658474fbfe27fd4eb16842cea1791d8ed17ff7c38a33a97e41`. Do not update the stale root source or fold its owner patch into this implementation.

Pinned release-state head `ff04aa2cce62527de3686e655743883dc9e9650b` reports installed runtime `4baeaf67d9677a317bc37831486c075b143fe68f`, generation 74. Its latest completed healthy execution is `38340039691:1:repair`, completed at 2026-10-13 05:15:28 UTC, with launcher `67b413448728887a7ba96d500120de0ee5fddeb8`. At the read-only cutoff near 07:04 UTC, execution `38349425325:1:repair` is in progress with launcher `8bebacbc05360a22580e1e83cba2b2c5c4868fcb`; run `38358067697` is pending. This is installed identity and pipeline evidence, not a new delivery receipt or settled-current-run proof. Generation 75 is staged in source, not established as installed by this snapshot. Runtime facts must be refreshed before any proposed hosted attempt.

Pinned repair head `341a9c9ecb7be9f6053b1fdfb96b95f2ed1a156f` contains 258 work records: 211 blocked, 21 done, 18 work, 5 delivery and 3 review. Its 666 reservations include 394 ambiguous, 268 submitted and 4 reserved without settlement; there are 23 open release requests and one cancelled request. These are frozen counts, not recovery eligibility or permission to refund a reservation. Fresh GitHub metadata confirms bot PRs 1004 and 1001 merged for gateway issues 635 and 632; both state records remain at delivery. Issue closure, review receipts, deployed target identity and continuous acceptance were not independently established. Keep these proof gaps visible rather than treating merged source as completed deployment.

## Changes since the source session and remaining work

| Module | Current source evidence | Updated implementation consequence |
| --- | --- | --- |
| m00-contracts | Existing strict state, model, reservation, matrix and release contracts remain; cleanup split their files without granting new authority. | Reuse contracts. The first state-read slice needs only an internal Git transport addition; no public port or persisted schema change. |
| m01-diagnostics | `src/host/local-model-reason.ts` maps a small closed set; settled-child advisory `c7d8a4eda` and closed merge-port advisory `8bebacbc0` already landed. | Extend missing model receipt/identity/permission classifications and phase accounting; preserve and reuse the existing advisories. |
| m02-state-store | `src/state/state-codec.ts` still invokes `cat-file blob` once per manifest/record; `state-git.ts` still creates a fresh repository and fetches full history per operation. | Start with one binary-safe batch read. Workspace/cache, shallow historical proof and incremental writes are separate dependent slices. |
| m03-runtime-deploy | Installer responsibilities moved to `owner-install-*`; generation 74/75 pins are staged. | Do not repeat file splitting or assume staged code is installed. Mechanical rung generation and a proved generic trusted installer remain proposals. |
| m04-protocol-compat | Split `matrix-artifact-*` readers retain authenticated native and legacy custody. | Reuse those readers; build an explicit compatibility contract only when an exact failing upgrade proves the need. |
| m05-blocked-recovery | `runtime-mismatch-recovery-plan.ts`, trusted disposition and expected-head mismatch maintenance landed; producer terminality uses the self surface. | Reuse the native mismatch transition. General explanations and trusted target policies remain; preserve the existing M31 producer-recovery owner patch. |
| m06-lifecycle | A zero-wait single scan is already implemented and tested; supervisor workflow concurrency still serializes runs. | Measure current consumption before changing it. Cross-run overlap requires custody and writer-ownership proof; retain current concurrency meanwhile. |
| m07-ci-loop | Source/test splitting and `size:report`/`size:check` landed. Fast checks still use a direct diff, and CI still runs one hermetic `test-local` job. | Avoid another broad cleanup. Implement merge-base/affected selection, measured hermetic shards and the exact aggregate receipt after state profiling. |
| m08-replay | Existing lifecycle tests use real temporary Git and fake ports. | Reuse those fixtures and injection seams for a sanitized recording/replay driver and state/effect report; do not build a competing state machine. |
| m09-operator-tools | CLI status lists workflows and recent merges; explain, phase/backlog reporting and generic deploy are absent. | Add read-only reporting after report contracts exist; coordinate CLI writes with installer work. |
| Activation | Installed runtime differs from current source; release remains disabled and original target/VPS/rollback/observation gates remain open. | Keep installation, source publication, autonomous issue delivery and deployment acceptance separate. Request approval only for a fully prepared exact hosted attempt. |

Current code locality rules aim for 500 source lines and 800 test lines, with physical ceilings of 1,000 and 1,500. Use the installed size-report task before unfamiliar whole-file reads and the cheap size gate on the final candidate. Changed-file checks and named consumer tests remain the default; this plan does not authorize a whole-repository test sweep.

## Authority and preserved lane identities

The original project canonical identity remains `master-plan-gfa795549e5`, at `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/master-plan-gfa795549e5`, branch `codex/master-plan-gfa795549e5`. It is not replaced by this plan. The active ledger also records separately owned memory, recovery and terminal-closure work; reconcile their latest handbacks before assigning overlapping paths.

The source session already derived the following proposed stabilization lane. Preserve that mapping if adopted; creating or using it requires reconciliation with the project's integration owner. No stabilization lane was created during this extraction.

| Field | Recorded value |
| --- | --- |
| Plan path P | `/home/codex/repos/ubiquity/sentinel/docs/stabilization-plan.md` |
| Repository root | `/home/codex/repos/ubiquity/sentinel` |
| Goal slug / gid10 | `stabilization-plan` / `fb96206486` |
| Proposed worktree name | `stabilization-plan-gfb96206486` |
| Proposed worktree path | `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/stabilization-plan-gfb96206486` |
| Proposed branch | `codex/stabilization-plan-gfb96206486` |
| Original planning base | `development` / `d72df6d45e7f9f79a2b52ac907988f4df9cf7bac` |
| State and owner | Mapping preserved; the current request authorizes an isolated local implementation candidate. Project ledger, preserved owner work, runtime and promotion ownership do not transfer. |
| Execution base | First local candidate starts at verified `8bebacbc05360a22580e1e83cba2b2c5c4868fcb`; module bases are exact candidate commits containing the updated plan and required predecessors. |

The stabilization lane, if adopted, integrates its modules and returns accepted ancestry to the established project canonical and shipped branch. It does not acquire another owner's runtime, state, target or promotion authority.

## Stage 0 Reconcile and freeze the implementation baseline

The integration owner reads the active ledger, current project rules, source refs, worktree state, active writers and their exact handbacks. Compare the proposed work below with changes already integrated since the planning base, especially installer, memory, recovery and source-file splitting work. Mark each proposed change as still needed, already covered, or requiring another owner's handoff in the existing ledger.

Record the exact accepted base and the current launcher, installed runtime, generation, healthy prior, in-flight executions, reservations and target owners. Read-only inspection grants no dispatch authority. Do not hard-code generation 74, select the previous generation by number, reset the dirty root, or create replacement lanes for existing work.

Before assigning writes, freeze shared contracts: diagnostic codes, phase events, any protocol compatibility record, recovery dispositions and deployment request/receipt fields. Use existing contracts where possible. The coordinator owns cross-module wiring; children own only their recorded surfaces.

Exit: one reconciled base, an explicit owner for every overlapping surface, and no unresolved assumption that the old root or the old runtime is current.

## Stage 1 Explain failures and reproduce decisions locally

Modules: `m00-contracts`, `m01-diagnostics`, `m08-replay`, with read-only presentation in `m09-operator-tools`.

Add closed diagnostic codes at the model-port, Codex transport and hosted-result boundaries in `src/repair/model-port.ts`, `src/repair/codex-transport.ts` and `src/host/local.ts`. Preserve the original failure category and exact receipt validation. Classify missing identity, wrong route or permission profile, missing output evidence, receipt mismatch, process settlement failure and transport closure separately. Unknown terminal classes remain explicit `unknown`; arbitrary exception text, paths, URLs, prompts and credentials must not enter public logs.

Emit a phase event for maintenance, preparation, target intake, planning, cell checkout/model/export, artifact ingestion, review, delivery and finalize. Include elapsed time and state read/write, Git process and GitHub request/wait counts. Distinguish nested work from exclusive time so overlapping spans are not double-counted. Add one delivery summary with admitted, completed, failed-by-class, published, reviewed and merged counts; keep pipeline health separate from delivery health.

Build the smallest offline replay first. Seed temporary bare Git repositories from a frozen, sanitized state fixture; inject a clock, scripted model results, target mirrors and recorded GitHub/artifact responses into the production entrypoints. Replay must deny external network and real side effects, fail on unrecorded requests, and report intended effects plus the resulting state diff. Restricted original captures stay outside public Git and model checkouts. A later read-only capture mode is a separate trusted tool, not a network-enabled test mode.

Use the resulting failure class and a sanitized fixture to distinguish output/session bounds, target-specific permissions, transport/identity validation and candidate-export failures. Prove the exact local failure, apply the smallest correction and replay it through the real consumer. Never increase limits or substitute a model solely because a run returned `unavailable`.

Extend `sentinel status` to show phase timings, installed identity, delivery health, pending releases and backlog by disposition. Add read-only `sentinel explain <owner/repo>#<issue>` to show the source, current record, attempts, reservations, selection decision, blocker and next required evidence. Both tools must distinguish unavailable data from an empty successful result.

Validation: diagnostic mapping and redaction cases, phase accounting on success and failure, and one frozen failing-cell or stranded-task lifecycle with zero network. Exit: a reproducible decision and a specific next action for each sampled failure; no null/unexplained diagnostic is treated as healthy delivery.

## Stage 2 Remove the measured Git state cost

Module: `m02-state-store`. Main surfaces: `src/state/**`, `tests/state/**` and a proposed `ops/bench-state.ts`. This can proceed alongside Stage 1 after shared instrumentation interfaces are frozen.

1. Batch blob reads before changing higher-level lifecycle logic. Read tree entries once, use `git cat-file --batch`, and retain strict record and whole-snapshot parsing. The first candidate owns `src/state/state-codec.ts`, `src/state/state-git.ts`, a cohesive internal batch parser if needed, and directly related `tests/state/**`. Add an internal optional binary stdin/output transport boundary while retaining existing injected runner behavior. Parse batch headers, object IDs/types and exact byte lengths; refuse missing, truncated, wrong-object/type, unexpected or trailing output. Preserve manifest/record canonical bytes, directory/file modes, filename digests, commit parent and complete-snapshot validation. Use real repair and release reads with multibyte records, transport errors and tampered frames, plus a counted Git runner to prove bounded blob-process count independently of elapsed time.
2. Replace a fresh repository for every operation with a private workspace per store instance. Serialize its operations, isolate indexes, and separate cache entries by remote, state ref and exact head. Do not share one scratch directory between independently writing processes.
3. Check the authoritative ref before reusing a cached snapshot. On the same authenticated head, return an isolated clone; on a changed head, fetch shallow state, read changed objects and validate the complete new snapshot. Failed reads remain unavailable. Validate the fetched identity if the ref moves between lookup and fetch.
4. Preserve parent and ancestry proofs. Shallow traversal can hide parents: verify the raw commit header where appropriate and deepen only for proof operations such as historical reads. Missing proof must fail closed.
5. Reuse the validated expected-head snapshot for incremental writes. Seed a private index, update changed blobs, create one state commit and retain the existing non-force push and exact readback reconciliation for applied, conflict, ambiguous and unavailable outcomes. Cache advancement follows proven application, not a successful subprocess alone.
6. Keep reservation persistence and external-effect intents at their existing boundaries. Batch independent transitions only after demonstrating that crash recovery and effect ordering remain equivalent; do not begin by rewriting `persistTransition` and the repair state machine.

Validation uses real temporary bare repositories: unchanged reads, foreign concurrent writes, corrupt blobs, forged state-head links, historical ancestry, ref movement during fetch, cache isolation, ambiguous push/readback and interrupted operations. Exercise both repair and release store consumers. The existing state contract tests remain the baseline, followed by the connected candidate-handoff lifecycle.

Benchmark a declared synthetic workload, proposed as 1,000 records and 3,000 commits, separating setup from measurements and reporting cold/warm p50/p95. Initial targets are unchanged read at most 1 s, changed read at most 2 s and write at most 3 s on the declared development host. Re-measure candidate-handoff tests and hosted phase timings after an approved installation; blob microbenchmarks alone do not satisfy acceptance.

## Stage 3 Make local and CI feedback fast without weakening isolation

Module: `m07-ci-loop`; task/config changes go through `m00-contracts`. Slow-test restructuring waits for the current test owners and Stage 2 measurements.

Make `deno task fast` and the proposed affected-test runner use an explicit merge-base comparison with the development source branch, including staged, unstaged and untracked inputs. Build reverse dependencies from Deno's module graph. Include config, lockfile, fixture and runtime-read dependencies that import graphs miss; invalidate cached maps when any relevant input changes. Unknown coverage must be visible and select the necessary conservative boundary, not silently report no tests.

Profile `candidate-handoff_test.ts` first, then the repair-loop and hosted-autonomy cases. Replace real waits only when profiling proves them, using injected clocks; retain actual Git persistence and interruption checks. Split oversized test files by coherent scenario after their owning modules settle. Report slow cases before enforcing any newly proposed performance ceiling.

Shard CI by measured durations, with six shards as an initial experiment rather than a fixed requirement. Preserve the credential-free `test-local.ts` environment, temporary HOME/cache isolation, existing Deno permissions, system dependencies and teardown in every shard. A direct `deno test --parallel` inheriting the CI environment is not an equivalent replacement. `--no-check` is acceptable only when a separate required static job covers those exact inputs.

Retain the exact aggregate check name `test-local` required by the installer. It must fail if any required static/shard result fails, is cancelled, is missing or is unexpectedly skipped. Every test file appears exactly once. Docs-only filtering must not skip executable contracts/configuration or manufacture the installer's success receipt. Cache dependencies with runtime/platform/config/lockfile identity; dependency caching is separate from reusing test results.

Validate changed-file selection with renames, deletions, staged/untracked changes, fixture-only changes and shared-config changes; test shard coverage and aggregate failure behavior. Parallel test experiments start with affected files. A whole-repository local run still requires its explicit workload authorization.

Exit: changed-file checks within 10 s, affected-module tests within 60 s on a declared workload, and CI p50 within 6 min across ten real runs after the changes land. Retain a correctness-preserving fallback when a workload exceeds a target.

## Stage 4 Recover work through proved lifecycle transitions

Modules: `m00-contracts`, `m04-protocol-compat`, `m05-blocked-recovery`. Reuse the separately owned memory/self-healing implementation and trusted terminal-closure paths; do not create competing state writers or rewrite their history.

Introduce a pure blocked-disposition classifier using structured codes or exact exported legacy reasons. Its output explains the required next proof; it is not itself permission to mutate state. Unknown cases require investigation. Use a dry-run report on a frozen state snapshot before any migration or maintenance write.

| Block family | Required handling |
| --- | --- |
| Source closed, trusted external merge or already satisfied at base | Reconcile source, ownership, exact PR/head/base and the applicable guarded terminal path; a textual reason alone cannot retire the record. |
| Runtime mismatch or artifact incompatibility | Authenticate original producer/run/attempt, plan, request, reservation, candidate and artifact digests; resume only through an explicit compatible transition. |
| Missing artifact, uncertain outcome or pending preservation | Preserve intent, candidate identity, custody and charged reservations; recover the original artifact/ref or name the missing proof. A changed runtime or base alone does not justify regeneration. |
| Verified transient implementation failure | Use the existing bounded retry/admission policy and non-equivalent attempt evidence after source freshness and absence of competing work are proven. |
| Protected-path requirement | Use the approved target policy, explain the necessary owner action and preserve the work; do not relax protection from model output or issue content. |
| Base-refresh conflict | Preserve the previous candidate, refresh exact source/base evidence and use the existing accounted correction path if eligible; prove the real conflict lifecycle locally. |
| Identity, digest or custody conflict | Fail closed and identify the integrity failure; no automatic settlement or re-admission. |
| Cancelled or failed release request | Retain the terminal release evidence and explicit delivery blocker according to current decisions. |

Protocol versioning can describe compatibility, but matching versions cannot replace execution authentication or erase the producer revision. Define a reviewed producer/consumer compatibility table and legacy policy first. Same-version/different-revision artifacts must still satisfy every original integrity binding; mismatches remain retained with a reason. No generic `ambiguous`-then-`work` conversion is part of the default plan.

Give each target trusted validation commands and protected paths appropriate to its repository. Verify the exact ai.ubq.fi commands against that target's current configuration rather than adopting names from the old draft. Target slugs, issue content and worker output cannot supply executable commands or remove protections. In credential-free cells, run the approved deterministic checks before publication; use bounded, accounted corrections within existing session/deadline safeguards and feed verified prior attempts and relevant CI findings into the prompt.

Validation: classifier cases, tampered/expired/missing artifacts, compatible upgrades, legacy refusal, still-live reservations, preserved candidate recovery, source opt-out, existing PRs, interruption before/after an effect, idempotent repeated maintenance and real-Git conflict repair. Each case must prove the production controller's state transition and unchanged accounting. Do not accept recovery by requiring an arbitrary number of historical blocks to disappear.

Exit: every sampled blocked task has an evidence-backed terminal disposition, recovery condition or named owner action; recoverable tasks advance without losing candidate custody or submitting an equivalent failed attempt again.

## Stage 5 Simplify trusted runtime installation and scheduling

Modules: `m03-runtime-deploy`, then `m06-lifecycle`, with `m00-contracts` owning shared fields. These changes are separate from the target application's deployment controller.

First remove repetitive authoring while retaining today's authority: a mechanical rung generator can produce the exact candidate/prior constants and tests from an approved identity tuple. Evaluate a data-driven installer as the next change, keeping all current proof checks. The proposed `sentinel deploy <full-sha>` and `deploy_revision` workflow input are interfaces to build, not commands that already exist.

For a data-driven installer, trusted code verifies the exact approved candidate, required CI and source ancestry; records the request identity and healthy prior before switching; performs an expected-head transition; authenticates the new execution; and rolls back once to the recorded proven prior if the defined failure condition occurs. Repeated or ambiguous requests reconcile existing intent. No input means no installation. Worker code cannot choose the revision, move the pointer or obtain credentials. Remove old rungs only after the replacement's equivalence and cutover are proved.

Keep the five-minute autonomous dispatcher. After state performance and cross-run artifact recovery are proven, replace long repair polling with one bounded scan where a later authenticated consumer can reliably finish ingestion. Retain unsettled reservations and durable producer evidence. A scan that finds no completed artifact must not become a successful empty settlement or allow preparation to overwrite custody.

Change workflow concurrency only after testing controller ownership across overlapping runs. Moving a workflow-level group onto individual jobs is insufficient by itself: it can permit cross-run phase interleaving and reordered writes. Preserve one trusted state/integration coordinator and exclusive promotion ownership with a proved handoff/lease and expected-head protocol. Test duplicate planning, delayed cells, cancellation, expired custody, out-of-order finalize and bootstrap interacting with old producers before any live overlap.

Validation: installer install/hold/refusal/rollback tables, exact workflow capability boundaries, recorded-prior restoration, retry idempotence and overlapping-run replay. Obtain the required fresh read-only GPT-6.1 Sol/max audit before installer/concurrency cutover. Exit: one approved installation with exact receipts, then measured cycle improvement without duplicate admission, lost custody or conflicting promotion.

## Stage 6 Prove actual autonomous delivery and activation

The trusted integration/release owners follow [activation-checklist.md](activation-checklist.md). Keep `sentinel-release` disabled during development. Report merged-but-not-deployed work accurately; do not set it to accepted delivery merely because the current release controller is unavailable.

Complete the gateway VPS release contract: exact healthy prior and candidate, durable promotion intent, exclusive existing deployment lock, immutable release identity, acceptance and interrupted-monitoring rules, and exact rollback/restoration receipts. Reconcile the target's current owner and approved capabilities before transfer. Deno deployment receipts cannot prove VPS delivery; retain the target's real authenticated acceptance surface and its applicable Cloudflare policy.

First prove promotion, monitoring and rollback in the approved isolated environment. Then, for each hosted attempt under the applicable existing authorization, bind the tested source SHA, launcher/runtime identity and target to real receipts. Record completed current-head native review, positive task acceptance, current CI, exact expected-head merge and issue closure. P0 is the only severity-based merge blocker; P1 and lower findings remain receipt-bound issue follow-ups. Review/merge correctness remains required even if cycle-time targets are missed.

Observe two distinct previously undelivered eligible tasks, including one captured-request permanent regression, continued eligible selection and interruption recovery. Preserve continuous 30-minute acceptance with 30-second samples, restart coverage after a monitoring gap, and complete the original six-hour observation after activation. Confirm finite encrypted retention, scoped keys and approved metric thresholds before activation. Missing telemetry is unavailable.

The draft's additional proposed stabilization milestone is ten autonomous deliveries across both targets and 48 consecutive hours of measured delivery health. It can strengthen confidence after the owner adopts its workload and thresholds; it does not replace the original activation gates or justify declaring the full project complete earlier.

## Performance and reliability measurements

| Measure | Proposed target | Evidence and denominator |
| --- | --- | --- |
| Diagnostic completeness | Every terminal failed cell has a closed reason or explicit unknown classification; unexplained nulls are zero. | All admitted cells in the stated observation window, including interrupted and unavailable outcomes. |
| Model effectiveness | At least 80% yield a trusted completed candidate in a declared eligible cohort. | Report candidate successes separately from legitimate terminal/no-change outcomes and classified failures; classification is not success. |
| Productive cycle latency | p50 at most 15 min; p95 at most 25 min. | Maintenance start through finalize, including queue/wait time reported separately, exact runs and sample count. |
| Recoverable backlog | No task remains eligible for a proved recovery for more than two completed cycles. | Exact recoverable cohort and source freshness; human/integrity blockers remain visible rather than being counted as recovered. |
| Throughput | Proposed median eligible-issue-to-merge at most 6 h. | Report arrivals, completed deliveries and age distribution; falling total backlog alone is invalid when arrivals change. |
| Developer loop | Static 10 s; affected tests and replay 60 s; CI p50 6 min; approved runtime installation 25 min. | Exact candidate, command, hardware, cold/warm state, workload and completion receipt. |
| Stability | Proposed ten deliveries and 48 h observation, plus all original activation gates. | Minimum sample sizes, failure thresholds and target mix must be adopted before the window starts. |

## Decisions that remain explicit

Planning requires none of these decisions to be made immediately. Complete the relevant local candidate and evidence before requesting an operational approval.

| Proposal in the source draft | Disposition in this plan |
| --- | --- |
| D1 Data-driven runtime installation | Design and validate the generic trusted path; adopt it explicitly through current owner decisions. Mechanical rung generation preserves the existing path meanwhile. |
| D2 Standing approvals and live local model probes | No standing approval is assumed or requested here. Each development-triggered hosted attempt still needs the identified workflow, target, SHA, duration and remaining assertion. A paid/live local model probe is separately scoped, never disguised as offline testing. |
| D3 Protocol equality replaces revision equality | Retain protocol negotiation only alongside authenticated provenance and an explicit compatibility policy. Do not discard original execution identity. |
| D4 Generic re-admission of unprovable outcomes | Excluded from the default implementation. Missing evidence or a changed fingerprint is insufficient; require a native, evidence-bound recovery transition under current rules. |
| D5 Target-specific commands and protected paths | Implement a trusted target-policy contract; exact commands and protection changes require target-owner reconciliation. No model-defined policy. |
| D6 Bot needs-human comments and labels | Keep read-only explanations first. External comments/labels require explicit authorization and an idempotent App-owned effect contract. |
| D7 Merge-only delivery completion | Do not weaken the full project outcome. Track merge as an intermediate result; release acceptance stays separately unresolved until proved. |
| New circuit breaker and fixed retry/review caps | Optional admission-policy proposals, not adopted limits. Preserve current uncapped policy, provider/platform limits, durable accounting and configured deadlines unless the owner explicitly changes the policy. |

## Modules and integration order

The source session's module IDs and derived lane names are retained below. Every worktree path is `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/<lane>` and every branch is `codex/<lane>`; the suffix after `-a` is the recorded `aid10`. These are planned mappings, not evidence that lanes exist or ownership has transferred.

| Module | Recorded lane | Owned deliverable and surfaces | Dependency and integration boundary |
| --- | --- | --- | --- |
| m00-contracts | `stabilization-plan-m00-contracts-af625b198df` | Shared contracts/types, `deno.json`, `docs/contracts.md` and coordinated wiring. | First; integrate each necessary foundation before dependent writers start. |
| m01-diagnostics | `stabilization-plan-m01-diagnostics-a187b751da5` | Model/transport reason mappings, pure phase helpers and their tests. | Frozen m00 interfaces; callers outside these surfaces are wired by their owner. |
| m02-state-store | `stabilization-plan-m02-state-store-ad25616005a` | `src/state/**`, `tests/state/**`, state benchmark and state counters. | Frozen instrumentation contract; independent of model diagnosis. |
| m03-runtime-deploy | `stabilization-plan-m03-runtime-deploy-a5495c41d25` | Installer, installer tests, supervisor deployment input and CLI deploy command. | m00, replay install/rollback seam and owner decision; serialize workflow and CLI ownership. |
| m04-protocol-compat | `stabilization-plan-m04-protocol-compat-ade03a9f718` | Matrix artifact/provenance readers and historical/modern compatibility tests. | m00 compatibility contract and the existing custody owner's handoff. |
| m05-blocked-recovery | `stabilization-plan-m05-blocked-recovery-af3e0633408` | Disposition classifier, authorized maintenance/loop transitions, target policy and corresponding tests. | m00 and m04; explicit handoff for existing memory, terminal and maintenance work. |
| m06-lifecycle | `stabilization-plan-m06-lifecycle-a8a69566257` | Matrix consumer timing and supervisor concurrency, with overlap tests. | m02, m04 and m03 workflow handback; explicit coordinator ownership proof. |
| m07-ci-loop | `stabilization-plan-m07-ci-loop-a16398d454f` | CI, hermetic harness sharding, affected-test/duration tools and fast-lane runner. | m00 tasks; later file splits wait for their source/test owners and m02 benchmarks. |
| m08-replay | `stabilization-plan-m08-replay-a8bf5ffd9a5` | Offline replay harness, recorded transport and replay tests. | m00 injection contracts; deliver the minimum fixture seam early, optimize after m02. |
| m09-operator-tools | `stabilization-plan-m09-operator-tools-a17f1c1c53c` | CLI status/explain and an optional separately authorized local-cell probe. | m00 report contracts; serialize CLI changes with m03; offline status can precede installer work. |

For every module, the exact starting SHA is the canonical integration commit containing all its accepted predecessors, recorded before launch. No module starts from another module's dirty tree or a moving branch. Shared `ops/hosted-autonomy.ts`, repair-loop, workflow, CLI and test files have one writer at a time; instrumentation is not an exception. Work outside the listed surfaces returns to the coordinator for assignment.

Historical 2026-10-13 first action, now superseded by the current execution handoff: save and verify this updated plan, then start the isolated m02 batch-read slice from the exact current source without changing public contracts. Follow with workspace/cache as a separately measured dependent slice. Diagnostics and minimum replay can proceed after their shared interfaces are frozen; begin m07 selection/sharding once the hermetic harness seams settle. Recovery and installer work reuse the landed native transitions and require their corresponding owner handbacks/local proof. Scheduler overlap remains behind artifact compatibility and exclusive-writer proof. Operator reporting follows available contracts.

Workers may not dispatch hosted workflows, change live state/admission, access credentials, change the runtime model policy, promote releases, edit the authoritative ledger, alter the vendored review rubric or add branch protections. Each handback provides module/lane/base/head identity, owned changes, exact commands, exit codes, elapsed times, evidence references, pending proofs and settled child processes. Accepted tips must remain ancestors of the stabilization integration result, project canonical and shipped branch.

## Validation and handoff

### R28 source-only guarded installation transition

Current code does not select the restored candidate: healthy generation 74 returns no_change, and the historical generation-75 retry still targets the predecessor. Prepare module `r28-stabilization-install` without treating r03's accepted fixed-predecessor work as a generic deployment interface. Stable plan P remains `/home/codex/repos/ubiquity/sentinel/docs/stabilization-plan.md`; aid10 is `efa0ab5952`, lane `stabilization-plan-r28-stabilization-install-aefa0ab5952`, path `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/stabilization-plan-r28-stabilization-install-aefa0ab5952`, branch `codex/stabilization-plan-r28-stabilization-install-aefa0ab5952`. Its original source predecessor was canonical `2cf3a988313c12876faca8ff30fd85473073181c`; its recorded launch base was `8334e104d73ec7c9095da2fbfa0f89e988ca0d9d`. The primary later fast-forwarded that same lane to repaired runtime R `c8d2e87468399abb54cc9d9a749ae7b400835bbb` without altering the frozen five-file patch, then integrated the validated repin with ancestry preserved; the ledger records the exact worker and merge tips. The primary integration/acceptance surface remains the original master-plan canonical lane, not a replacement goal.

Current CI repair continuation (2026-10-14 05:51 UTC): immutable candidate2cf failed its deterministic CI (1,980 passed, eight failed), so it remains unaccepted and must not be installed. Reuse settled module r20-cache-test-permissions and r27-merge-vps-fixture lanes from exact canonical8334 for disjoint harness-exclusion and behavioral lifecycle repairs. Preserve their original stable identities; the primary extends only these explicitly assigned owning surfaces and keeps all security/terminal/review/current-head gates. Once their exact patches integrate, freeze one repaired runtime SHA, record the specific installer pin change in DECISIONS.md and rerun only affected local consumers before deterministic CI publication; this is not a generic revision selector or hosted/runtime approval.

One isolated worker owns only `src/host/owner-install-runtime-pins.ts`, `src/host/owner-install-plan-memory.ts`, `tests/host/owner-install-stabilization_test.ts`, `tests/host/owner-development-install_test.ts` and `tests/host/owner-install-runtime75_test.ts`, with the existing-test scope restricted to the fixed forward-transition expectations and preserved legacy fixtures. The primary also authorizes only the final healthy-generation-74 expectation in the existing `tests/host/owner-development-install_test.ts` case at lines 833-850, strengthening it with exact selected candidate/generation assertions; its failure-74 rollback and every legacy-generation-75 assertion remain unchanged. Append a separately named fixed transition to repaired runtime candidate `c8d2e87468399abb54cc9d9a749ae7b400835bbb`, preserve the exact healthy `4baeaf67d9677a317bc37831486c075b143fe68f`/generation-74 prior and every legacy retry tuple, and restore only the recorded prior once after an authenticated failed candidate. Reuse existing interfaces, reason/status variants, record shapes and producer proof; no generic CLI, environment, schema, credential, workflow or source-selection fallback is authorized. If a direct existing consumer requires changed expectations for the new forward transition, return that exact conflict to the primary before editing outside owned scope. Live state drift holds for reconciliation; no runtime authority is inferred from this source change.

Use existing production installer fixtures with fake API/state and injected clocks: prove the missing selected transition on the original base, repaired exact selection, pending/wrong CI and source ancestry refusal, exact prior proof/quiescence/cooldown/release guards, changed expected head and ambiguous readback, preserved legacy generation-75 behavior, and one-shot exact rollback. Run changed-file fmt/lint/type/size checks, the named new test, directly affected owner-development-install and runtime75 consumer boundaries, then one connected installer lifecycle on the integrated candidate; reuse unchanged-source evidence and never start a whole-suite or actual hosted/model/deployment run. Commands are registered with the installed evidence tool, bounded to 300 seconds and observed at most every 30 seconds. Worker returns an uncommitted owned patch, exact base/file hashes/receipts and settled jobs; only the primary commits/integrates and writes the authoritative ledger. A fresh read-only GPT-6.1 Sol/max auditor checks the exact controller delta before the installation-preparation milestone. Its later protected-ref publication, native execution, installed-runtime proof, target delivery and activation remain separate, unapproved operational surfaces.

For each implementation change, use the smallest observable failing case, repaired case, affected module, direct consumer boundary and one named local lifecycle on the integrated candidate. Use fake external ports, real temporary Git/state and injected clocks. Register commands through the installed evidence tool; enforce a 300-second deadline with bounded process-group teardown and observe progress at most every 30 seconds. Preserve the exact declared Deno permissions and hermetic environment. Reuse unchanged-input evidence and never repeat an unchanged setup failure.

Documentation checks apply to the refreshed planning deliverable, followed by registered, bounded local checks for the authorized implementation candidate. Whole-suite sweeps, development-triggered hosted attempts, live state writes and deployment require their separate authority. Development requires no development PR or Codex review; autonomous runtime target changes retain their current-head internal review, CI and merge gates. Under the owner's takeover directive, the current primary coordinator alone records evidence and acceptance in the sole ledger; execution workers do not edit it.

Before a major cutover or final acceptance, the integration owner obtains the required fresh read-only GPT-6.1 Sol/max audit against the exact candidate and evidence. Record local validation, source integration, installed runtime, target deployment and observed autonomous delivery separately in the sole ledger. Any remaining blocker names one owner and the next concrete action.

Immediate continuation action: complete final canonical controller acceptance and exact-R/controller native deterministic CI, then publish source to development with accepted tips preserved before preparing the exact separately approved hosted installation attempt. Keep target custody and all original live acceptance gates intact.

Conditional goal sentence, usable only after that ownership and base reconciliation:

Goal: As orchestrator, use the approved stabilization worktree stabilization-plan-gfb96206486 at /home/codex/repos/ubiquity/sentinel/.codex-worktrees/stabilization-plan-gfb96206486 on branch codex/stabilization-plan-gfb96206486, read AGENTS.md and /home/codex/repos/ubiquity/sentinel/docs/stabilization-plan.md in full, deliver its stabilization and fast-feedback work through the recorded isolated module lanes and exact evidence gates, preserve the established master-plan canonical identity and accepted ancestry, and complete the original end-to-end activation outcome without bypassing per-attempt hosted approval.

## Source provenance

The original session is `01a126e0-7f98-7373-ac0a-48e3e2dcdf62`; its verified extraction is `01a12b27-fbb3-76d0-b525-552184e3d99b`. The local read-only history projection and, at this reconciliation, the original JSONL provide scoped source evidence. Original user ordinals 9, 62 and 1383 establish the planning scope, continued effort and request to finish; command ordinals 1353 and 1362 created the draft and lane mapping. Those original requests were plan-only. The current 2026-10-13 request separately authorizes updating the plan and starting implementation.

The original draft SHA-256 is `f8ae0bb4969647b859ddf6a2303c50df19f7d96f44f742f2dd4234dcd82781dd`; its unchanged backup is `/tmp/sentinel-session-plan-extract-01a126e0/original-stabilization-plan.md`. Original raw diagnostics and state fixtures are not copied into this document. Production claims must be refreshed through current authenticated evidence before execution.

## Fixed gateway native code gate

Reuse recorded m07-ci-loop (aid16398d454f) at `/home/codex/repos/ubiquity/sentinel/.codex-worktrees/stabilization-plan-m07-ci-loop-a16398d454f`, branch `codex/stabilization-plan-m07-ci-loop-a16398d454f`, after a preserving fast-forward to exact controller C `d954c49edb5e23b481864acca2447856dce0dc10`. Its only new owned source is `.github/workflows/gateway-source-verify.yml`; primary owns DECISIONS.md, ledger, Git publication and acceptance. Add a fixed credential-free ordinary code-CI invocation of `sh scripts/verify.sh` against exact gateway `9d83f306a92b11a0929c414b445fc8a1367e01d9`, triggered only by changes to this file on the canonical coding branch. Preserve recorded gateway lane/branch and publish its exact source as a provisional carrier only after fresh custody and cheap unchanged-input checks; no target development/ref/promotion write is part of preparation. Validate only the new workflow syntax, fixed pins, trigger/permission/environment/source identity and literal-command contract locally under registered 300-second bounds, then capture the exact native command/result and unchanged source. Keep C/R fixed and all source, production-isolation, hosted attempt, target custody/capture/delivery/rollback and observation gates distinct.
