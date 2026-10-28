# Maintenance throughput handoff, 2026-10-28 UTC

## Objective and present status

Reduce Sentinel's recurring maintenance delay by avoiding unrelated historical producer recovery and unnecessary closure reads, while preserving complete recovery, current source/custody checks, durable accounting, exact-head review/CI, target ownership, expected-head CAS and rollback safety. The owner authorized implementation with "okay proceed with performance optimization", then requested this handoff and goal. Continue the already-authorized task; no new chat or goal is required to execute it.

The concrete candidate is prepared but entirely unvalidated. Fourteen files change: nine production files and five test files. No typecheck, lint, formatter, test, benchmark, native review, publication, installation or runtime performance measurement has run on this candidate. Production remains on the previously accepted code. Do not interpret authored assertions, file hashes or this handoff as a passing gate.

The only new repository files from this preparation are this plan and its supporting handoff bundle. Existing source changes in the stale root checkout and previous worktrees remain untouched. The temporary candidate writers and profiler have settled, with no running descendants or background jobs. Planner/coordinator session is 01a1752a-4c5b-72d1-9ede-0782a06ccc21; its latest verified model was gpt-6-astra/max. Select future workers under the current installed model-routing procedure rather than treating that identity as a model change instruction.

## Canonical Goal Identity

Preserve this plan path and its derived identity. This is a bounded continuation of Sentinel's original MASTER-PLAN.md objective, not a replacement for its original goal/module identities. A recorded lane is planned authority to create that exact lane only after normal access and ownership reconciliation; no lane below existed at handoff capture.

| Field | Value |
| --- | --- |
| Stable goal/plan identifier | /Users/nv/repos/ubiquity/sentinel/docs/plans/maintenance-throughput-20261028.md |
| Repository root | /Users/nv/repos/ubiquity/sentinel |
| Goal slug / gid | maintenance-throughput-20261028 / ee28e37ed1 |
| Canonical worktree name | maintenance-throughput-20261028-gee28e37ed1 |
| Canonical worktree path | /Users/nv/repos/ubiquity/sentinel/.codex-worktrees/maintenance-throughput-20261028-gee28e37ed1 |
| Canonical branch | codex/maintenance-throughput-20261028-gee28e37ed1 |
| Exact source base | e6ac2213e27f124db21d13b757a9271066c434c9 |
| Base ref at capture | origin/development |
| Current state | Both recorded modules integrated locally on 2026-10-28 04:51 UTC; combined validation, native review, hosted CI, installation and live measurement pending |
| Integration and ledger owner | The current primary continuing this contract after reconciling ownership |

Goal: As orchestrator, read AGENTS.md and /Users/nv/repos/ubiquity/sentinel/docs/plans/maintenance-throughput-20261028.md, reconcile access and ownership, use canonical worktree maintenance-throughput-20261028-gee28e37ed1 at /Users/nv/repos/ubiquity/sentinel/.codex-worktrees/maintenance-throughput-20261028-gee28e37ed1 on branch codex/maintenance-throughput-20261028-gee28e37ed1, validate and integrate the prepared maintenance optimizations through the recorded worker lanes, then publish, install and prove reduced maintenance work without weakening recovery, custody, accounting, review, CI or merge gates.

## Read first

Read the applicable current AGENTS.md, MASTER-PLAN.md, relevant docs/DECISIONS.md and the current authoritative docs/build-status.md. Follow ~/.codex/agents/model-routing.md, delegation.md, engineering.md, git-coordination.md, task-control.md, test-evidence.md Core evidence and github-delivery.md when their routes apply. The primary alone owns decisions, ledger, integration, publication, scope and acceptance. The handoff cannot weaken higher-priority rules or authorize a sandbox bypass.

The prior implementation coordinator 01a17d5f-c856-74b0-9ab6-10080f4e3611 completed its turn at 2026-10-27 23:50 UTC. Its isolated canonical lane /Users/nv/repos/ubiquity/sentinel/.codex-worktrees/production-throughput-20261027-g4459c2249b was clean at e6ac2213. Preserve that lane and its module lanes; do not rename, reset, repurpose or write them for this task. Recheck sessions, worktrees, reservations, refs and any ready work before creating writers.

## Baseline and measured problem

The last verified shipping base (2026-10-27 23:48 UTC) is e6ac2213e27f124db21d13b757a9271066c434c9 is a ledger-only child of installed f2f1d5da53e4a3b868cc39ff6702d347367fb8c4, generation 123. The installed revision passed all seven canonical CI jobs in run 40600520027, then accepted model-disabled bootstrap 40601446648. The separate App-dispatch completion fix is already live and proved completion-to-router in 2 seconds and completion-to-durable-receipt in 72.398 seconds. Do not redo that fix or include it as this candidate's new success. Refresh current live refs/pointer before publication; these are dated identities.

The read-only profile captured between 00:09 and 00:17 UTC on 2026-10-28 shows the remaining cost persists with populated indexes:

| Ordinary run / maintenance job | Maintenance | Historical scan | Closure | Retry |
| --- | ---: | ---: | ---: | ---: |
| 40602899220 / 122535183002 | 609s | 302.224s | 115.386s | 41.779s |
| 40605360063 / 122543388062 | 639s | 302.310s | 109.687s | 58.321s |

The index grew from 436 to 437 producers and its anchor from sequence 2601 to 2603, but its historical cursor remained 1256. Both passes exhausted their history budget after 24 and 23 producer passes. History scan plus closure account for roughly 67–70% of observed autonomy runtime; this is not a forecast that the patch removes all that time. No endpoint-level total is exposed by those logs. Private raw receipts remain outside public Git at /tmp/sentinel-maintenance-perf-20261028/live-profile/profile.json and /tmp/sentinel-throughput-implementation-20261027; recapture if unavailable.

Root-cause evidence: producer discovery is cached, but unresolved work still asks every historical producer for its full authenticated wave before intersecting reservations. The positive plan itself is immutable and already authenticated on a successful recovery. Separately, retirement uses a full PR reader merely to inspect state/merged status; a merged PR costs four GETs including ancestry comparisons. Final non-Gateway closure reads a task before learning that no exact completed review can authorize it. The original full-reader test documents the four-GET path; the retained Passport diagnostic cohort had 27 impossible task-read candidates; those were not 27 actionable issues.

## Durable candidate bundle

The required source and continuation instructions are preserved under /Users/nv/repos/ubiquity/sentinel/docs/handoffs/maintenance-throughput-20261028, outside volatile /tmp. These files are currently uncommitted. The bundle contains authored source/test diffs and documentation only; do not add raw private logs, target source, credentials or full diagnostic snapshots to public Git.

| Artifact | Role / SHA-256 |
| --- | --- |
| [candidate.patch](../handoffs/maintenance-throughput-20261028/candidate.patch) | Combined 14-file patch; b1236d5e835510639f8823485fe4268de4f86f6bf0538c96c5b743bc6cfdca68 |
| [candidate-manifest.json](../handoffs/maintenance-throughput-20261028/candidate-manifest.json) | Every baseline/candidate file hash; f6641b9e0eec51c5c776609facf6d54dc4a4271699f67aab148e270ba2ca255f |
| [producer-membership-handoff.md](../handoffs/maintenance-throughput-20261028/producer-membership-handoff.md) | Detailed history contract, exact scope, limitations and reconstruction notes |
| [producer-membership-prepared-evidence.json](../handoffs/maintenance-throughput-20261028/producer-membership-prepared-evidence.json) | Proposed bounded recorder registrations/runs, never executed |
| [closure-handoff.md](../handoffs/maintenance-throughput-20261028/closure-handoff.md) | Closure contract, exact scope, negative cases and proposed recorder commands |
| [access-blockers.json](../handoffs/maintenance-throughput-20261028/access-blockers.json) | Actual commands, exit statuses and access failures |
| [bundle-manifest.json](../handoffs/maintenance-throughput-20261028/bundle-manifest.json) | Bundle hashes and deterministic module identities |

The original combined source snapshot is /tmp/sentinel-maintenance-perf-20261028/combined-candidate. It is a plain archive, not a Git worktree. Nothing depends on its survival: recreate the exact base from Git and apply the preserved patch. Original scratch paths inside the bundled manifests/handbacks are provenance; use the durable files above if /tmp is absent. Patch content and per-file hashes must match before adoption.

## Access blockers and first continuation action

Normal worktree creation failed, exit 255, when Git could not create /Users/nv/repos/ubiquity/sentinel/.git/refs/heads/codex/maintenance-throughput-20261028-gee28e37ed1.lock: Operation not permitted. The planned branch and path were not created. Evidence registration failed, exit 1, opening /Users/nv/.local/state/dsh-evidence/cc48556d9d6816f2605c36c352452867e2de5be694f7aa26c8a9330e9268c576/managed.lock. Registration did not execute validation. The installed recorder fixes storage beneath ~/.local/state/dsh-evidence and has no documented storage override.

The immediate step is to confirm the receiving session has legitimate write access to this repository's Git metadata and the fixed evidence directory. GitHub CLI publication also needs network access; the last terminal probe was blocked, although an authenticated browser was available for read-only status. Do not widen access yourself, redirect HOME/CODEX_HOME, edit the recorder, use protected daemon sockets, replace credentials, run raw tests to evade evidence requirements, or use hosted CI as a substitute edit loop. Report the exact remaining enforced limitation if access is still absent. The owner has already authorized the implementation and ordinary scoped hosted actions; this is an access problem, not a request for routine task approval.

After access is available, re-anchor pwd, top-level, branch, status, worktrees, active writers and live refs. Create the recorded canonical worktree from exact e6ac2213 only if its path and branch are absent and unclaimed. If development advanced, preserve this baseline, inspect the delta, and record an exact reconciled predecessor before applying corrections; never silently retarget a lane or overwrite another owner's work. Copy this plan/bundle into canonical without deleting their root copies. Register the new task and acceptance state in the sole ledger before source integration.

## Module ownership and integration order

Both module source candidates are disjoint and based on exact e6ac2213. They may prepare and validate independently after their recorded lanes are created; the shared evidence tool serializes managed command execution. Integrate m01 first, then m02 with ancestry preserved, then freeze writers for combined validation. The coordinator owns all shared documentation and any conflict. No worker creates another lane or broadens its scope without a new recorded assignment.

| Module | Lane / branch / absolute path | Exact base / dependency |
| --- | --- | --- |
| m01-producer-membership | maintenance-throughput-20261028-m01-producer-membership-a3194030afe; codex/maintenance-throughput-20261028-m01-producer-membership-a3194030afe; /Users/nv/repos/ubiquity/sentinel/.codex-worktrees/maintenance-throughput-20261028-m01-producer-membership-a3194030afe | e6ac2213e27f124db21d13b757a9271066c434c9; owns positive-membership shared contract |
| m02-closure-reads | maintenance-throughput-20261028-m02-closure-reads-ad2bfd0b8f9; codex/maintenance-throughput-20261028-m02-closure-reads-ad2bfd0b8f9; /Users/nv/repos/ubiquity/sentinel/.codex-worktrees/maintenance-throughput-20261028-m02-closure-reads-ad2bfd0b8f9 | e6ac2213e27f124db21d13b757a9271066c434c9; disjoint source, integrates after m01 |

m01 owns src/contracts/maintenance-index.ts; ops/hosted-autonomy-current-scan.ts; ops/hosted-autonomy-current-recovery.ts; ops/hosted-autonomy-producer-recovery.ts; ops/hosted-autonomy-producer-requests.ts; tests/state/maintenance-index_test.ts; and new tests/host/hosted-autonomy-producer-membership_test.ts. It owns no closure/status interfaces or shared fixture changes.

Integration-owner scope clarification, 2026-10-28 04:33 UTC: m01 also owns the focused exact-event-key and successful-completion assertions in tests/host/hosted-autonomy-history-reach_test.ts because the existing current_matrix_walk event gains numeric membership/source-check counters for the requested live measurement. It may update those assertions and format this additional touched test within the existing two-pass maximum. Keep existing event outcomes and add one completed-walk event; counters expose observations only, with no identifiers, authority, scheduling or request-policy change. The original fourteen-file artifact remains preserved unchanged; this is a separately recorded validation/observability correction.

m02 owns ops/hosted-autonomy-types.ts; ops/hosted-autonomy-github.ts; ops/hosted-autonomy-scopes.ts; ops/hosted-autonomy-closure-pass.ts; tests/host/hosted-autonomy-retirements_test.ts; tests/host/hosted-autonomy-retirement-intents_test.ts; and new tests/host/hosted-autonomy-closure-prefilter_test.ts. It owns no producer/index changes or retry expansion. Existing shared fixtures remain unchanged.

Apply only each module's listed paths from the combined patch in its recorded lane, or construct an exact module patch from those entries; verify after hashes against candidate-manifest.json. The coordinator may apply the combined patch once for a single-writer integration rehearsal, but must not let that compete with module writers or represent it as accepted ancestry. Native workers may commit only assigned source/test files after their required checks; no worker pushes, dispatches, edits decisions/ledger, handles credentials, mutates authoritative state, or changes runtime policy. DSH is not requested. Formatting authorization after access is limited to each worker's exact touched TypeScript files, at most two deno fmt passes; capture them separately from checks.

## Contracts that must survive correction

History membership is a positive complete set of reservation IDs from an authenticated immutable plan, bound to exact producer execution, fresh source proofFingerprint, plan digest and planner job. Skip full recovery only when every current exact pending reservation is disjoint. Matching/new/unknown plans retain original recovery and late-result behavior. Missing, partial, unavailable, expired or unlisted evidence teaches no absence. Never truncate membership; reuse the existing MAX_MATRIX_CELLS bound. Invalid or contradictory metadata disables acceleration safely without corrupting source, authoritative state or fresh consumer results. Old sidecars remain readable; old readers' safe fallback must be verified before rollback claims.

Closure status carries only exact observed PR number, open/closed state and explicit merged boolean; it is never delivery evidence. Production uses one strict authenticated GET. Legacy ports may project their existing full-reader result only when the optimized capability is absent, retaining the observed number; a present capability's refusal never falls back. Full delivery ancestry reads remain unchanged. The final non-Gateway task-read prefilter follows historical publication reconstruction and cannot replace an eligible record's fresh authorization, review, CI, ownership, custody, accounting, CAS or readback. Gateway carried authorization remains unchanged.

Preserve event-driven scheduling, existing deadlines and protected authority. Do not add cron/polling, arbitrary start/retention/lifetime caps, negative artifact caches, new credentials/options/environment variables, billing changes, branch protection/rulesets, model-route changes or source-policy reorganizations. Keep sentinel-release disabled. Raw restricted evidence stays outside public Git and model credentials.

## Validation matrix and known unproved assumptions

All commands require the existing recorder, a 300-second deadline and bounded process-group teardown. Inspect installed gtimeout/Deno paths before using the prepared registrations; their paths were discovered on this Mac and may drift. Preserve declared permissions, monitor active cases within 30 seconds, diagnose 60 seconds without useful output, and retain actual command/exit/elapsed/candidate/output references. Do not run a whole-repository local sweep or repeat a failed unchanged command.

| Gate | Required evidence |
| --- | --- |
| Artifact adoption | Patch SHA and every before/after file hash; exact lane/base/status; no unrelated edits |
| Baseline regressions | Producer restart repeats unrelated work and fails the intended progress assertion; impossible closure receipt incurs the unnecessary task read; existing full reader documents four GETs |
| Repaired focused cases | New membership consumer and strict status/prefilter cases pass on identical inputs; actual endpoint/request counts show the intended reduction |
| History boundaries | Real temporary Git/state/index plus actual authenticated artifact transport, fake native HTTP/ZIP/markers and injected clock; restart, old sidecar, newly appended work, late matching result, corrupt/mismatched metadata, source/custody drift and original budget/CAS controls |
| Closure boundaries | Real fetch/status path and temporary Git/state retirement/closure; full reader still proves ancestry; unavailable/wrong identity/uncertain merged status refuses; eligible final task rereads and Gateway carried checks survive |
| Scoped static checks | Typecheck, lint, format-check on exact changed files; cheap current size and whitespace constraints through recorded commands |
| Combined lifecycle | Frozen integrated candidate exercises both paths with unchanged charges, source/custody proofs, CAS/readback and late result recovery; count real selected calls, not implementation-mirroring mocks |
| Hosted CI | Exact canonical SHA and, where relevant, its actual merge input pass native CI; Linux-specific packaging gaps remain separate from local success |
| Installed/live | Exact candidate/prior journal, model-disabled healthy accepted bootstrap, ordinary cycles, phase timings and useful outcomes; no fabricated review or delivery receipt |

The authored membership regression injects native settlement as a strict external port while the real artifact transport authenticates attempts/jobs/markers/ZIP; its separate named real candidate-recovery lifecycle remains required. Fake response shapes, injected timing, type/lint/format behavior and expected state transitions are all unexecuted. A baseline --no-check proposal exists only to avoid an additive metadata type blocking the semantic red case; candidate commands must typecheck normally, and a setup failure cannot count as the intended regression. No speedup, request reduction or passing test is yet claimed for this patch.

Review must use the real native mode if invoked; never substitute a general-model chat or relabel an unavailable verdict. Apply current project development-review/delivery policy and the applicable bounded review sequence. Earlier throughput reviews covered earlier revisions and do not review this patch or authorize a fourth round in that prior loop. Autonomous runtime target PRs still require exact current-head native review evidence under the session's P0/P1 requirement.

## Publication, installation and live acceptance

After local validation and correction, integrate accepted worker tips into canonical with ancestry preserved and update DECISIONS/build-status under one primary. Complete the required current-head hosted gate before any runtime advance. Existing Sentinel authority covers scoped pushes, dispatch/rerun/cancel/enable/disable and protected rollout actions without repeated generic approval; independent new credential/security/billing/retention changes remain outside this scope. Before each hosted attempt record exact workflow, target, SHA, expected duration and remaining hosted-only assertion.

Refresh current production pointer, refs, active runs, pending effects, target ownership and exact healthy prior immediately before installation. Use the existing launcher self-install and model-disabled bootstrap; failed candidates restore only the journaled prior at a higher generation. Derived-index compatibility must preserve full recovery and unknown data on rollback; do not reset state, reservations, accounting, calibration or retention for convenience.

Measure at least one cold and subsequent warm ordinary maintenance path on the installed candidate, recording exact input/state/ref/workload identity, current_matrix_scan and closure durations, index cursor advancement, producer passes/skips/hits, source/task/PR/ancestry reads where observable, and successful processing of a matching late result. Compare identical local controlled inputs for causal counts and live samples separately for operational latency. Report remaining producer/state I/O and source/CI blockers; faster bookkeeping is not a new issue delivery or billed savings. Keep existing delivery checks and useful issue-to-merge evidence visible.

## Completion and preservation

The work is complete only after the scoped candidate is validated, integrated, published, safely installed and measured. If an enforced blocker prevents a named step, preserve the candidate and evidence and report the task as incomplete. Prove all accepted tips are ancestors of the shipping branch. Final reporting must distinguish local checks, native review availability, merged source, installed runtime and measured live behavior, with exact receipts and genuine limitations.

Preserve root checkout 395f54637ebba12e7faf8675028d094e63838a3e and its pre-existing dirty .github/workflows/ci.yml, docs/DECISIONS.md, ops/ci-shards.ts, src/host/actions-repair-host.ts, src/host/local-config.ts, tests/host/ci-shards_test.ts, untracked actions-premerge-ci source/test, private .codex-evidence-pr-backlog-20261018 and existing docs/plans. Preserve prior production-throughput worktrees, the unaccepted AI Rust candidate and all unrelated owners. Do not delete remote branches or clean the root to make adoption easier.
