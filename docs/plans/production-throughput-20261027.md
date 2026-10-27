# Production throughput implementation, 2026-10-27

## Objective and authority

The owner requested: "Tag the current version as v1 release then work on all these suggestions." Preserve the current source baseline, then implement all five findings from the 2026-10-27 production audit and carry the integrated candidate through local, reviewed, hosted, installed and live acceptance. This task does not replace the original MASTER-PLAN.md goal or its module identities. The current primary coordinator owns this task's integration and docs/build-status.md; workers return evidence and proposed ledger updates only.

## Baseline and evidence

The v1 annotated tag object is 2f55efdd45c3525314089827b11c4edefe0bff30 and targets development f731b9602af55e54b7789e26134b1ce42eb3e7bd. GitHub release 425800187 is https://github.com/ubiquity-sentinel/sentinel/releases/tag/v1. The baseline is a source preservation release, not a new installation or an exact-head CI-green claim. Installed/protected runtime at bootstrap is 92a8fcb43050a431c4072f68a25695e497aaf77a, generation 121; ordinary execution was active, so live state must be reconciled again before installation.

The root checkout is stale at 395f54637ebba12e7faf8675028d094e63838a3e with unrelated tracked and untracked edits. The original canonical worktree also contains unrelated dirty state. Preserve both; use this task's isolated integration and module lanes. Initial reconciliation is /tmp/sentinel-throughput-implementation-20261027/bootstrap; the audit and exact-source manifests are /tmp/sentinel-throughput-audit-20261027. Evidence is time-sensitive and must be refreshed for hosted acceptance.

## Scope and shared contracts

Implement: (1) unchanged published-head/CI-wait deferral without repeated state writes; (2) exact-current-head backup CI demand, fair admission and prompt result ingestion with base-refresh readiness; (3) incremental historical producer reconciliation with durable derived progress and complete recovery; (4) authenticated completion-driven scheduling and overlapping independent target work while retaining one authoritative writer; (5) removal of the PR/push cancellation race without losing canonical or native-receipt checks.

The coordinator owns shared contract decisions and integration order. No worker may invent an authoritative status or weaken existing bindings. New derived maintenance metadata must remain separate from work, custody, reservation and settlement records. Completion events must bind trusted repository, workflow, ref, revision and result identity. Cross-repository check events do not automatically reach this controller; use the existing authenticated hosted surfaces and preserve bounded recovery where no authoritative event path exists. No new credentials, environment variables, configuration flags or CLI arguments are authorized by this plan.

Retain exact-head native review, current integrated CI, per-repository merge/base safety, expected-head CAS, durable accounting and single promotion ownership. Keep sentinel-release disabled. Do not purchase capacity, alter billing, weaken the target CI budget policy, bypass target protections, reset review rounds, refund starts, delete history or change retention. Session instructions requiring no unresolved P0/P1 take precedence over weaker source policy. Production model policy and existing effective route remain unchanged.

## Modules and integration order

Stable task module IDs are m01-ci-wait, m02-head-ci, m03-maintenance, m04-target-flow and m05-ci-trigger. Each receives a separately recorded isolated worktree and exact base. m01 owns repair-loop waiting/publication semantics; m02 owns backup demand planning and receipt consumption; m03 owns derived maintenance scan progress; m04 owns event workflows and shared host/target lifecycle wiring; m05 owns ordinary ci.yml trigger semantics and its existing consumer tests. Exact owned files and named checks are finalized before each writer starts. Shared files have one owner. All workers prohibit docs/build-status.md and docs/DECISIONS.md writes.

m01, m02, m03 and m05 may proceed on disjoint confirmed surfaces from the baseline foundation. m04 starts after its shared contract and dependency interfaces are settled; any required predecessor change lands on integration first, then m04 branches from that exact SHA. The primary integrates accepted clean worker commits with ancestry preserved and owns decision/ledger documentation. An independent fresh audit checks the integrated milestone; native development review uses the real supported review mode without caller model or effort overrides.

## Validation and evidence

Every local validation command has a 300-second deadline and bounded process-group teardown, registered through /Users/nv/.codex/agents/assets/test-evidence/evidence.ts. Preserve declared Deno permissions; use capture during editing and fresh for changed final inputs. Observe checks within 30 seconds and investigate 60 seconds without useful progress. No local test may use paid model calls, live credentials, GitHub writes or deployment. Whole-repository local sweeps remain outside this authorization; use scoped static checks, regression, affected module and directly affected consumer boundaries, then one named combined lifecycle on the integrated candidate.

Required scenarios include: unchanged pending CI does not republish or commit repeatedly; matching completion resumes exactly once; stale/duplicate/out-of-order completion cannot advance; original CI deadlines still hold; current-head demand is not starved by obsolete or lower-value work; receipt ingestion preserves provenance and real failures; a historical recovery restart resumes without rescanning settled producers or losing late evidence; a slow target does not delay another ready target; every review/session settles; same-target merges always refresh authoritative evidence; PR and push events cannot cancel the only native receipt producer.

Before each authorized hosted execution record workflow, target, exact SHA, expected duration and remaining hosted-only assertion. Keep local, code review, canonical publication, installed pointer and actual issue delivery evidence separate. First preserve logs and fix failures locally; rerun only affected validation before the next hosted attempt. Install only an exact CI-green candidate through the existing model-disabled bootstrap and exact-prior rollback path. Prove the installed candidate's scheduled supervisor operation and current-head reviewed delivery, with before/after useful transitions, waiting-state writes, CI dwell, runner-seconds and delivery evidence; do not equate outer workflow success with target success or estimate billed savings.

## Completion

All five modules must have an integrated or explicitly evidence-backed disposition; report genuine unresolved external boundaries rather than claiming completion. Every accepted worker tip must be reachable from this task's integration tip and published development. Preserve all pre-existing state and record task-created lane disposition. The final report identifies v1, shipped/installed revisions, meaningful checks, live results and any remaining limitation.

## Task lane identity

The task contract path is /Users/nv/repos/ubiquity/sentinel/docs/plans/production-throughput-20261027.md, slug production-throughput-20261027 and task gid4459c2249b. Repository root is /Users/nv/repos/ubiquity/sentinel. Integration is branch codex/production-throughput-20261027-g4459c2249b at .codex-worktrees/production-throughput-20261027-g4459c2249b, created by the primary from exact v1 commit f731b9602af55e54b7789e26134b1ce42eb3e7bd. This bounded task lane does not rename or replace the original MASTER-PLAN.md goal or its occupied canonical lane.

| Module | Worker lane under .codex-worktrees (branch is codex/<lane>) | Owned surfaces and dependency |
| --- | --- | --- |
| m01-ci-wait | production-throughput-20261027-m01-ci-wait-ad14302f76a | loop-publication.ts, loop-ci-first.ts, minimal loop-types.ts/loop-cycle.ts applied-and-yield contract and focused repair tests; first shared scheduler foundation |
| m02-head-ci | production-throughput-20261027-m02-head-ci-ab2c44e8ecd | backup CI demand/planning/receipt consumers, pre-review refresh readiness and dedicated helper/tests; one owner for the common readiness contract; no workflow edits |
| m03-maintenance | production-throughput-20261027-m03-maintenance-a72899f9948 | current producer recovery, derived index/cursor schema/store and trusted maintenance wiring/tests; one cohesive owner for its storage capability |
| m04-target-flow | production-throughput-20261027-m04-target-flow-a8fac890508 | resumable invocation, main/host/matrix/target scheduling, native completion plumbing and event workflow integration/tests; branch after m01 and needed m02 interfaces integrate |
| m05-ci-trigger | production-throughput-20261027-m05-ci-trigger-a7d2faa72da | .github/workflows/ci.yml and tests/host/ci-workflow-events_test.ts only |

All module lanes start from the recorded integration foundation commit unless the coordinator records an exact predecessor base. Native implementation workers may commit only owned files; they may not push, dispatch, change production or write shared ledger/decision documents. The coordinator alone publishes and installs. Formatting authorization is limited to deno fmt on each worker's exact touched TypeScript files, at most two passes after edits; workflow formatting must preserve semantic values. Every validation uses the installed /Users/nv/.codex/bin/gtimeout --kill-after=5s 300s wrapper registered in the evidence tool. Workers inspect the wrapper before trusting its process-group bound.

Derived scan storage must use an isolated trusted sidecar capability rather than adding fields to strict historical snapshots. Its schema/storage implementation has m03 ownership and must be finalized before its consumers change. It is reconstructible acceleration: invalid or unavailable data never authorizes skipping required evidence, and no negative artifact cache or retention change is permitted. New completion events only prompt existing trusted exact-identity reads; active-supervisor wakes coalesce into the existing finalize handoff, with no claim of an unavailable cross-repository in-process event.
