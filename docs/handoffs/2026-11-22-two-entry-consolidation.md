# Sentinel two-entry consolidation

Phase 1 report, 2026-11-22. The consolidation worktree is on
`consolidate/two-entry-modes`, based on development
`a896fa14b0e473106f8f2a4940326d6f3710b7dd`. This report records both existing
execution paths and the proposed integration. Implementation, environment
admission, branch cutover, and hosted acceptance are later phases.

## Branch inventory

| Ref                               | Exact commit                               | Commits unique since the common ancestor |
| --------------------------------- | ------------------------------------------ | ---------------------------------------: |
| `origin/development`              | `a896fa14b0e473106f8f2a4940326d6f3710b7dd` |                                      100 |
| `origin/claude/great-ride-tu5r70` | `9962a49014381c6795b317827f46470d4cbe5ecd` |                                      164 |
| Common ancestor                   | `9bfd577f92e923151ce1aed9a6b16ac8dbc294d4` |                                          |

`git merge-base`, `git rev-list --left-right --count`, and the two
ancestor-to-tip diffs establish the inventory. Development changed 294 paths.
The side branch changed 156 paths, of which 155 are additions. The only
intersection is `.github/workflows/supervisor.yml`. The 15 agent-job additions
eligible for source import are the two workflows, seven `ops/agent-jobs-*`
files, three host test files, `jobs/README.md`, `jobs/example.json`, and the
November 17 handoff. Preserve the 137 historical inbox requests and three
cleanup requests in the side ref's history. Import the eligible files
selectively so no prior request or deletion becomes a new event.
[Common ancestor](https://github.com/ubiquity-sentinel/sentinel/commit/9bfd577f92e9)
· [Side tip](https://github.com/ubiquity-sentinel/sentinel/commit/9962a4901438)

Preserve development's `supervisor.yml` byte for byte in this consolidation. The
side's four supervisor installer edits replace the existing
`@openai/codex@0.154.0` installations with `SENTINEL_CODEX_VERSION || 'latest'`.
The supervisor version and its native-review envelope behavior remain an
independent change. The agent-job workflow owns its existing installer and its
own `SENTINEL_AGENT_JOBS_CODEX_VERSION` setting.
[Development supervisor](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/.github/workflows/supervisor.yml#L339)
·
[Side supervisor](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/.github/workflows/supervisor.yml)
·
[Side installer](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/.github/workflows/agent-jobs.yml#L126)

## Existing issue entry

1. The dispatcher accepts schedule, workflow completion and manual dispatch
   events, resolves the protected launcher and may advance it using exact
   ancestry and CI evidence. `supervisor.yml` admits the protected ref.
   `maintenance` and `prepare` validate custody/runtime and work policy.
   `matrix_plan` uses the trusted state and exact runtime. `matrix_cell` runs
   eligible implementation work with read credentials. `repair_cell` uploads
   sealed read-only deltas. Trusted serial repair and finalization reconcile the
   matrix artifacts, publication and state under their existing identity checks.
   Runtime bootstrap disables model starts.
   [Dispatcher](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/.github/workflows/supervisor-dispatch.yml#L23)
   ·
   [Supervisor graph](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/.github/workflows/supervisor.yml#L45)
   ·
   [Matrix host](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/host/matrix-native-host.ts#L73)
2. Configured targets reach issue intake only after authoritative GitHub
   repository metadata admits them. Intake evaluates issue eligibility,
   dependencies and assignment against trusted state.
   `prepareImplementationStart` reserves each start durably and binds its
   evidence and candidate. Implementation results settle the attempt, preserve
   the operation-bound candidate and feed trusted publication. The issue PR
   carries `Resolves #N` and its exact head is reconciled before delivery.
   [Target loader](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/host/targets.ts#L472)
   ·
   [Issue intake](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/loop-intake.ts#L365)
   ·
   [Issue eligibility](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/issue-admission.ts#L17)
   ·
   [Start reservation](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/loop-implementation.ts#L563)
   ·
   [Implementation result](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/loop-implementation-result.ts#L260)
   ·
   [Publication state](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/loop-publication-state.ts#L43)
3. The issue adapter admits a native review, binds the PR, base/head, snapshot
   and current trusted issue text, and persists submission and result identity.
   `applyObservedReview` feeds effective P0s or a valid task rejection back into
   isolated correction. A changed head requires a newly bound result. An already
   satisfied exact base has a separate disposition. Qualifying issue delivery
   requires a completed current result, positive task acceptance, zero
   unresolved P0s and zero uncounted findings. Review rounds and CI-fix attempts
   remain durable accounting. Deadlines, provider cooldowns and genuine blockers
   still apply.
   [Review request](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/loop-review-request.ts#L112)
   ·
   [Review transport](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/github/review-transport-lifecycle.ts#L115)
   ·
   [Observed result](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/loop-review-result.ts#L235)
   ·
   [Correction feedback](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/loop-review-records.ts#L190)
   ·
   [Cap retirement](../DECISIONS.md#review-round-ceiling-and-ci-fix-cap-retired-2026-10-3031)
   ·
   [Base-repair limit](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/base-repair.ts#L54)
4. `executeMerge` and the GitHub adapter independently verify the receipt,
   current base/head, authority and applicable CI just before the expected-head
   merge. Pending, unavailable or stale evidence defers delivery. Verified
   backup CI substitutes only for target checks that never started on the exact
   candidate, and the normal issue flow retains P1–P3 for receipt-bound
   follow-up issues. The release controller remains a separate authority.
   [Merge coordinator](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/loop-merge.ts#L208)
   ·
   [GitHub merge guard](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/github/port-merge.ts#L236)
   ·
   [Follow-up pass](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/ops/hosted-autonomy-follow-up-pass.ts#L57)
   · [Master plan](../../MASTER-PLAN.md)

## Existing operator job entry

1. `sentinel-agent-jobs` uses the pushed head's added/modified
   `jobs/inbox/*.json` files on the side/experimental refs, or a JSON input on
   manual dispatch. GitHub requires the dispatch workflow to exist on the
   default branch. `planAgentJobs` validates job ID, target, prompt, optional
   base, setup, model/effort, runner and deadline, then groups jobs by owner and
   runner kind. The plan is uploaded with its artifact ID passed to each cell,
   including failed-only reruns.
   [Entry and plan workflow](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/.github/workflows/agent-jobs.yml#L21)
   ·
   [Planner](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-plan.ts#L143)
2. Each cell mints an owner/repository-scoped read App token and opens separate
   clones at resolved bases. `runAgentJobsCell` runs jobs concurrently using
   `runJob`, with isolated working directories, model credentials, retry
   telemetry and finite workflow/job time. On exit it captures the exact
   base/head, Git bundle, final message and result status. Current side behavior
   can bundle changes left by a timed-out or failed agent. It runs unsandboxed
   setup and Codex, and uses shared runner capacity with the issue supervisor.
   [Cell permissions and artifacts](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/.github/workflows/agent-jobs.yml#L93)
   ·
   [Job execution](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-cell.ts#L340)
   ·
   [Cell fan-out and child environment](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-cell.ts#L642)
3. The separate `publish` job mints the scoped write App token after model
   execution, checks bundle integrity and verifies the reported head descends
   from the recorded base. `publishOne` pushes non-force to
   `agent-jobs/<id>-<run>-<attempt>`. Explicit `pr:true` opens a draft PR.
   `pr:false` is the default and returns only the branch. This path currently
   records execution status and publishes without native review, task acceptance
   or automatic merge. The distinct cleanup workflow reads an explicit cleanup
   request, validates the dedicated result-branch namespace, and can delete or
   explicitly close a PR before deletion.
   [Publisher workflow](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/.github/workflows/agent-jobs.yml#L221)
   ·
   [Bundle and draft logic](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-publish.ts#L88)
   ·
   [Cleanup](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-cleanup.ts#L59)

**Runner and model configuration.** The planner maps `linux-x64` to
`ubuntu-latest`, `linux-arm64` to `ubuntu-24.04-arm`, `linux-arm64-26` to
`ubuntu-26.04-arm`, and `macos-arm64` to `macos-latest`. One cell shares an
owner, runner kind and App-token repository set. Defaults are four agents per
cell and 20 cells, with width before stacking. The GitHub matrix limit is 256
cells and its job timeout is 360 minutes. The cell budgets up to 350 minutes for
work. Per-job `model` overrides `SENTINEL_IMPLEMENTATION_MODEL_ID` or the
default `gpt-6.1-sol`. Per-job `reasoningEffort` defaults to `max` and remains
constant through model transport retries. These settings select the
implementation client only. Linux installs `ccache` and the best-effort cache
restores under the owner-and-runner prefix, saving with run/cell-specific keys.
Agent-written cache contents are performance inputs.
[Runner labels and bounds](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-plan.ts#L19)
·
[Cache and model configuration](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/.github/workflows/agent-jobs.yml#L170)
·
[Client arguments](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-cell.ts#L680)

**Request identity and reruns.** The existing push helper uses a fresh inbox
filename as a submission nonce and refuses to overwrite an existing one. The
workflow inspects additions/modifications in the pushed head commit. GitHub run
ID plus attempt distinguish output refs and cell artifacts. Failed-only reruns
reuse the original plan artifact ID. A publish-only retry still looks for a
bundle named with the new attempt, so current operator guidance uses a full
rerun, which starts the agents again. The consolidated path should keep retries
on their original request and reuse verifiable evidence when available.
[Rerun behavior](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/jobs/README.md#L18)
·
[Current artifact download](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/.github/workflows/agent-jobs.yml#L240)

**Progress and model traces.** `agentHeartbeat` reports elapsed time, commits
and uncommitted files, restarts and output silence roughly every five minutes.
`heartbeatNotice` adds bounded annotations and `agent-jobs-progress.mjs` uploads
best-effort progress text roughly every 15 minutes with liveness and commit
summaries. `startTraceProxy` forwards model traffic on loopback and summarizes
gateway/provider request IDs, timing, status, termination and incomplete
streams. The cell writes per-job attempt and trace telemetry and a status table.
The publisher summarizes branch, optional PR and publication status.
[Heartbeat and progress](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-cell.ts#L445)
·
[Progress uploader](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-progress.mjs#L15)
·
[Trace proxy](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-trace-proxy.ts#L80)
·
[Cell summary](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-cell.ts#L798)
·
[Publish summary](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-publish.ts#L241)

Historical evidence covers a branch-only smoke and four overlapping Codex
processes on one runner for 33.517 seconds. Both runs used the side entry and
established publication before any shared review existed.
[Smoke 44049612495](https://github.com/ubiquity-sentinel/sentinel/actions/runs/44049612495)
·
[Stacking 44050436813](https://github.com/ubiquity-sentinel/sentinel/actions/runs/44050436813)

The branch inventory observed run 45078841087 on a push to
`claude/great-ride-tu5r70` at `9962a49014381c6795b317827f46470d4cbe5ecd`. It
started at 22:38:19 UTC on 2026-11-22 and its cell was still running at 23:11
UTC. Delivery remained unverified at that observation.
[Side run 45078841087](https://github.com/ubiquity-sentinel/sentinel/actions/runs/45078841087)

## Proposed shared native review and disposition

- **Exact candidate.** Feed both entries through the trusted manifest and native
  reviewer using independently restored Git objects and a pristine checkout.
  Bind repository, exact base and head, snapshot digest, task digest, native
  review thread/turn/request/result, and custody to the disposition. Use
  `prepareReviewCheckout`, `GitReviewSnapshot.capture` and
  `CodexStructuredReviewer.prepare`, with native `review/start` and its
  entered/exited mode lifecycle. The existing issue transport owns its PR and
  trusted state. A separate trusted agent-job review job can review an
  unpublished commit and requires neither a PR nor App write authority.
  [Exact checkout](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/host/local-review-checkout.ts#L224)
  ·
  [Snapshot type](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/github/review-snapshot.ts#L93)
  ·
  [Snapshot capture](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/github/snapshot-capture.ts#L59)
  ·
  [Native reviewer](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/github/codex-reviewer.ts#L176)
  ·
  [Native start](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/github/reviewer-prepared.ts#L24)
  ·
  [Result binding](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/github/reviewer-support.ts#L178)
- **Exact task.** Keep the issue number and trusted live issue text in the
  existing issue adapter. Bind an operator job to its trusted request identity
  and exact original prompt before implementation, including the admitted
  repository and operation identity. Retries, model summaries and PR text cannot
  change that intent. Use a job-specific task identity at the shared seam, since
  the current issue statement and acceptance parser require an issue number.
  Both adapters should feed the same result evaluation.
  [Issue task contract](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/contracts/review-task-acceptance.ts#L12)
  ·
  [Issue receipt gate](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/review-gate.ts#L195)
- **Common disposition.** Require a completed current result with no uncounted
  findings, zero unresolved P0s, and independently positive acceptance of the
  exact supplied task. Keep lower-severity findings in the result. Distinguish
  rejected task acceptance, blocking P0s, and unavailable/stale evidence. Supply
  bounded receipt-bound feedback to an isolated correction without a write
  token, regenerate the snapshot for the new head, and review again within the
  job deadline. Numeric review and fix attempt counts are accounting. Leave
  incomplete results explicitly unresolved at the deadline and preserve their
  history. Preserve issue-specific CI, trusted custody, merge, follow-up and
  release gates.
  [Blocking severity contract](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/contracts/review-receipt.ts#L103)
  ·
  [Issue merge implementation](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/loop-merge.ts#L273)
- **Trusted delivery.** The operator job publisher verifies the admitted plan,
  artifact lineage and exact reviewed result before any authorized target write.
  Publish the verified head itself and record the verdict in the job result and
  commit status. Include it on the optional draft PR when requested. Preserve
  `pr:false` and operator-owned merging. Keep App write authority in the
  publisher, away from setup, implementation, review and correction. Emit a
  truthful blocked or unavailable result if any binding or review gate fails.
  [Current write boundary](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/.github/workflows/agent-jobs.yml#L220)

## Public visibility and cutover

The public controller admits only GitHub-proven public repositories. Apply the
same fail-closed decision to operator jobs before scheduling a cell or uploading
prompt-bearing plans. Enforce it again at the trusted publication boundary.
Unknown, unreadable, internal and private targets are refused with text-free
status. The side planner currently checks only the repository slug. Its plan
contains prompts, and its cell artifacts contain Git objects, messages and
telemetry. GitHub's App installation scope therefore does not establish public
visibility. Use GitHub repository metadata as authority, preserve the issue
deployment's existing behavior, and keep restricted data outside the public
entry and its artifacts.
[Visibility rule](https://github.com/ubiquity-sentinel/sentinel/blob/a896fa14b0e4/src/repair/target-visibility.ts#L41)
·
[Recorded decision](../DECISIONS.md#2026-11-18-private-targets-follow-the-host-repositorys-own-visibility)
·
[Current side planner](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-plan.ts#L143)

1. Import the lane source into development and update its entry and
   documentation for development. Keep the two workflow authorities distinct.
   Preserve old inbox/cleanup files in historical Git only. Bind any push intake
   to fresh requests on the admitted ref and each rerun to its original
   request/artifact identity. Audit and drain existing side runs before routing
   new submissions. Retain the side ref and delivery receipts during cutover to
   distinguish preserved history from eligible new work.
2. Development must contain the workflow before GitHub exposes manual dispatch.
   The observed `sentinel-supervisor` environment branch policies admit
   `sentinel-supervisor` (59833606) and `claude/great-ride-tu5r70` (67085800). A
   landed development workflow still needs owner admission of that exact ref
   before its protected jobs can run. Preserve existing rules during admission.
   Retiring the side trigger and its admission requires a separate, explicit
   cutover after in-flight jobs and retry eligibility are reconciled.
3. Keep the protected supervisor on its independently verified launcher/runtime.
   Auto-follow compares the whole `.github/workflows` tree, so adding the
   agent-job workflow files can require an authorized manual launcher advance
   even when the supervisor workflow itself stays byte-identical. Record exact
   development, launcher and runtime SHAs before and after. Exercise one bounded
   hosted operator job on the admitted ref and observe the ordinary issue path
   at its real authority boundary.
   [Workflow-tree rule](../DECISIONS.md#2026-11-22-one-unreachable-target-costs-only-that-target-a-pre-runtime-failure-loop-backs-off)
   ·
   [Side dispatch/environment](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/.github/workflows/agent-jobs.yml#L21)

The installed `sentinel-dispatch` helper's `scripts/dispatch.sh` currently
hardcodes the side branch and pushes a fresh inbox file. Update that helper at
cutover to dispatch the landed workflow on development. Read back the run
workflow, event and head SHA before treating a launch as adopted. After landing
and exact-ref admission, a fresh operator request can use the same dispatch path
directly.

```bash
gh workflow run agent-jobs.yml --repo ubiquity-sentinel/sentinel \
  --ref development -f "jobs=$(jq -c . /tmp/new-agent-jobs.json)"
```

## Live risks and proof still due

- **Artifact trust and reruns.** The current publisher casts `result.json`
  directly and downloads an attempt-named cell artifact. Verify strict
  correspondence to the trusted plan, attempt, cell, target, base/head and
  review receipt before granting publication. Plan artifact IDs already survive
  failed-only reruns. A failed publish can leave a branch behind before draft
  creation, so reconciliation must recognize the exact prior head before
  retrying.
  [Plan download](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/.github/workflows/agent-jobs.yml#L144)
  ·
  [Publish download](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/.github/workflows/agent-jobs.yml#L240)
  ·
  [Current publisher CLI](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-publish.ts#L197)
- **Credentials and capacity.** Side setup and agents run unsandboxed. The child
  environment omits the read token and runner artifact token, while the model
  client uses a token file in the job work directory and peers share a runner
  UID. Verify actual containment, prompt/log visibility, deadline margins for
  review and correction, and interaction with supervisor runner capacity.
  Snapshot and native-review compatibility with the selected installed Codex
  must be evidenced on the intended hosted ref.
  [Cell execution](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/ops/agent-jobs-cell.ts#L671)
  ·
  [Shared runner limits](https://github.com/ubiquity-sentinel/sentinel/blob/9962a4901438/jobs/README.md)
- **Delivery evidence.** The later lifecycle check must connect a fresh public
  operator request to implementation, a genuine native review, any necessary
  correction, and a result branch/status at the same accepted SHA. Verify an
  explicit draft request separately from the branch-only case and show the issue
  path still uses its existing current-head gates. The historical smoke and
  stacking results do not cover this integration, and the proposed
  branch/environment transition has not been exercised.
