# Sentinel two-entry consolidation

Consolidation handoff, 2026-11-22–23. Phase 1 mapped both entry paths against development `a896fa14b0e473106f8f2a4940326d6f3710b7dd` on `consolidate/two-entry-modes`. Its inventory and proposed design below are historical. Phase 2 implementation, draft publication, verification and owner cutover follow.

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
   the operation-bound candidate and feed trusted publication. Issue work uses
   the deterministic `sentinel/repair/issue-*` branch assigned by `candidateBranch`.
   The issue PR carries `Resolves #N` and its exact head is reconciled before delivery.
   [Branch naming](../../src/repair/keys.ts#L62) ·
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

## Proposed public visibility and cutover

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

## Phase 1 risks and proof requirements

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

## Phase 2 implementation

- The phase 1 report is committed at `87e4323c23`. The ancestry merge `80040f7186` retains the side tip and selectively imports its lane source. The 137 historical inbox requests and three cleanup requests remain in side-ref history. Development's `.github/workflows/supervisor.yml` is byte-identical to its baseline.
- On-demand intake on `development` selects fresh push additions across the event's before-to-after range or accepts explicit JSON dispatch. Trusted admission confirms each repository is public and resolves its exact base before model work. The original prompt and dispatch identity bind the review task. The planner rejects prompts longer than 16,384 UTF-16 code units and records the first trusted admission timestamp. Queue and setup consume the original job deadline. [Operator guide](../../jobs/README.md) · [Entry workflow](../../.github/workflows/agent-jobs.yml)
- Inbox, cleanup and manual requests enter through the authorized human GitHub account with write access to `development` used by the live coding agent. The intake decision follows GitHub's authenticated `User` sender. App and bot events are ignored by on-demand intake, so issue-mode App auto-merges retain their existing authority. [Operator submission](../../jobs/README.md#submit-a-request)
- The workflow initially checks out `refs/heads/sentinel-supervisor` as its controller and records its exact Git HEAD. A separate push checkout at the event's exact `github.sha` supplies request data. The run pins the controller SHA across planning, implementation, review and publication. Cleanup likewise pins its controller SHA between plan and deletion. A protected revision without the lane fails closed. The consolidated authority list adds `jobs/inbox/`, `jobs/cleanup/` and the privileged on-demand code, with workflow definitions already covered. It feeds issue-mode `ownerLandingTouch` and `neverMergedChange` and the operator review gate's publication guard for the Sentinel repository. [Authority policy](../../src/host/hosted-authority-protected-paths.ts) · [Issue merge guard](../../src/github/merge-content-gate.ts)
- The delivery workflow separates implementation, review and publication. The gate verifies the plan, Git objects and pinned base. Before native review it consolidates the candidate tree into one commit whose only parent is the pinned base. The target branch contains that exact accepted commit, while the public Actions cell bundle can retain intermediate implementation commits. Both entries use the same native review and disposition. Changed jobs require a completed native verdict, positive exact-task acceptance and zero unresolved P0s. A rejected task or P0 feeds an isolated correction and a fresh native review within the remaining deadline. Attempt counts record starts. `review:false` is allowed only for a Git-verified empty diff, which produces a result without a branch. [Delivery workflow](../../.github/workflows/agent-jobs-delivery.yml) · [Shared disposition](../../src/repair/review-disposition.ts)
- Trusted publication uses the exact accepted commit and records an authenticated Sentinel App verdict comment on that SHA. The publication result carries the comment URL. `pr:false` remains the default. An explicit `pr:true` creates or reuses a draft that carries the verdict. The issue supervisor owns its current CI and expected-head merge. The on-demand operator owns CI verification and any merge. Public target visibility is rechecked before publication. [Publisher](../../ops/agent-jobs-publish.ts) · [Shared review and delivery](../../README.md#review-and-delivery)

## Draft publication and native CI

GitHub REST published draft #428 against `development`. Native CI run `45087695922` attempt 1 passed at 00:23:05 UTC on 2026-11-23 for code head `25e1cd2a6e389a83cff95156feb25d55c4cd87eb`, base `a896fa14b0e473106f8f2a4940326d6f3710b7dd`, and pull request merge SHA `f9252254481347358dd7f79a9ac7f6e92c96567d`. All seven jobs passed on seven distinct `ubuntu-latest` runners. The `test-local` aggregate emitted `sentinel_native_ci_v1` for the exact merge and tree `55c43470b452d0467fee64a9d161527c7537e5c4`. The five shards covered 894 files and 2,343 test steps with 5,584 passed, zero failed and 88 ignored. Quality checked 1,846 files for formatting, 1,771 for lint and 1,970 for size with zero violations, and completed 21 type checks. [Draft PR #428](https://github.com/ubiquity-sentinel/sentinel/pull/428) · [Passing native CI](https://github.com/ubiquity-sentinel/sentinel/actions/runs/45087695922) · [Exact aggregate proof](https://github.com/ubiquity-sentinel/sentinel/actions/runs/45087695922/job/137412260286)

| Shard       | Passed | Failed | Ignored |
| ----------- | -----: | -----: | ------: |
| Modules     |  2,645 |      0 |      47 |
| Integration |    105 |      0 |       0 |
| Host 1      |    980 |      0 |      14 |
| Host 2      |    893 |      0 |      19 |
| Host 3      |    961 |      0 |       8 |

Initial code head `bf2247c089150cb87a2223a62c48560af9a8a6c8` ran native CI `45086691656` attempt 1 on pull request merge SHA `ac27e9259fee1351ab0a7e5c08132779657dbd45`. The run concluded failure at 00:13:44 UTC on 2026-11-23. Across 894 files, 5,583 tests passed, one failed and 88 were ignored. Quality, integration and all three host shards passed. The modules shard had 2,644 passed, one failed and 47 ignored. The `test-local` aggregate exited 1 and emitted no CI proof. The failure was a stale `p.acceptanceCorrection` source anchor in `tests/model/decision-matrix_test.ts:110`. It still expected `if (refusal === TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL) {` in `src/repair/loop-review-result.ts` after that decision moved to the shared review path. [Initial native CI run](https://github.com/ubiquity-sentinel/sentinel/actions/runs/45086691656) · [Modules shard](https://github.com/ubiquity-sentinel/sentinel/actions/runs/45086691656/job/137406838783) · [Aggregate job](https://github.com/ubiquity-sentinel/sentinel/actions/runs/45086691656/job/137409355746)

The correction at `592d52b1e2f328e50192cf80aa0c1c8a05679d15` changes only the model anchor to the actual issue path, `const corrected = await withAcceptanceFinding(receipt);`. The same offline model harness first exited 1 with 11 passed and one failed, then exited 0 with all 12 passed in 33.092 seconds. Evidence `26c6cf008cdb65262171683ae1ea38a8d64599b2af1465c5a12b58783e7d521d/f59a73ba-1694-4597-9ad8-e8cdfe1aff80` and `26c6cf008cdb65262171683ae1ea38a8d64599b2af1465c5a12b58783e7d521d/6404f4cd-14a2-485f-a867-d0b8f0385de0`.

```sh
timeout --kill-after=3s 297s deno run --frozen --allow-env=PATH --allow-run=deno,git --allow-write test-local.ts --tests tests/model/decision-matrix_test.ts
```

For a subsequent draft head, the Checks tab lists its `sentinel-ci` run. Verify the exact pull request merge SHA and successful `test-local` aggregate, which requires quality and all five shards. [Draft check history](https://github.com/ubiquity-sentinel/sentinel/pull/428/checks)

## Local verification

Eight standard agent-job suites passed on the exact published code SHA `bf2247c089150cb87a2223a62c48560af9a8a6c8`. The offline harness exited 0 with 35 passed, zero failed and one ignored real-listener canary in 39.198 seconds. Coverage uses real temporary Git repositories and fake app-server, GitHub and model ports where appropriate. Evidence `26c6cf008cdb65262171683ae1ea38a8d64599b2af1465c5a12b58783e7d521d/fa4647ba-0ceb-47ee-8511-ae3551bc97f6`.

```sh
timeout --kill-after=3s 297s /usr/local/bin/deno run --allow-env=PATH --allow-run=deno,git --allow-write test-local.ts --tests \
  tests/host/agent-jobs-cleanup_test.ts tests/host/agent-jobs-correct_test.ts \
  tests/host/agent-jobs-native-review_test.ts tests/host/agent-jobs-plan_test.ts \
  tests/host/agent-jobs-review_test.ts tests/host/agent-jobs-trace-proxy_test.ts \
  tests/host/agent-jobs-workflow_test.ts tests/host/agent-jobs_test.ts
```

The correction fixtures initially ran outside the standard read allowlist, causing five failures on `257a02d14e`. Moving the fixture directory inside the working tree passed five of five with the standard harness and led to `bf2247c089`. The earlier direct test with extra temporary-directory read grants is excluded. Standard harness command `timeout --kill-after=3s 297s deno run --frozen --allow-env=PATH --allow-run=git,deno --allow-write test-local.ts --tests tests/host/agent-jobs-correct_test.ts` exited 0 in 49.144 seconds. Initial red and corrected receipts are `26c6cf008cdb65262171683ae1ea38a8d64599b2af1465c5a12b58783e7d521d/6d8c0da3-762e-4f1e-b604-e2dd6fe08006` and `26c6cf008cdb65262171683ae1ea38a8d64599b2af1465c5a12b58783e7d521d/5da31e84-d2d8-4f38-a6cc-24cafba1f92f`.

Static checks on `257a02d14e72527e3038b2fbd3dac4ff5b5ed76b` exited 0 in 105.532 seconds. Format checked 1,846 files, lint checked 1,771, 21 entrypoints type-checked, and size checked 1,970 with zero violations. The fixture directory change in `tests/host/agent-jobs-correct_test.ts` is the entire diff to the published code SHA. Evidence `26c6cf008cdb65262171683ae1ea38a8d64599b2af1465c5a12b58783e7d521d/ea4c6962-8471-4d6e-9206-632cf1acb5c7`.

```sh
timeout --kill-after=3s 297s deno run --frozen --allow-env=PATH --allow-run=git,deno --allow-write test-local.ts --checks
```

Earlier receipts on the same implementation lineage are listed below. The namespace is `26c6cf008cdb65262171683ae1ea38a8d64599b2af1465c5a12b58783e7d521d`.

| Surface                          | Source                                          | Result                                                                                                                                                 | Receipt suffix                                                                                                         |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Shared native review             | `2865701a01`                                    | Four fake app-server cases and 51 issue/consumer cases passed. Two composed issue lifecycle tests passed on the committed SHA.                         | `e62d1e19-6279-465a-ad5f-ec38deeb6206`, `16a68aaa-6b2b-4dd8-9441-915f9b40c041`, `b0fa3a53-4503-42e9-84b9-a7b2dbea9cfc` |
| Review gate                      | `6ae7016cec`                                    | Four real-Git lifecycle tests passed on the module overlay.                                                                                            | `b53a30d8-33cd-40fa-a4b5-dc9e0a291b95`                                                                                 |
| Commit-comment publication       | `77d52a520a` on exact base `0bb8404f9a`         | 18 connected tests passed.                                                                                                                             | `e91c34ba-e91b-444e-b8fa-e2529a2ef4ba`                                                                                 |
| Admission deadline and App scope | `80d5d7c81c` on exact base `0bb8404f9a`         | 14 workflow, plan and job tests passed.                                                                                                                | `2ed04c37-70b1-40a1-9229-b7d26da0e6bf`                                                                                 |
| Offline trace proxy              | `c2d1746982`                                    | Four cases passed and one real-listener canary skipped under declared permissions.                                                                     | `2bb6f8da-9174-4334-b752-7b89a3daab78`                                                                                 |
| Locked App action setup          | Tree `209653b35a61e7656b2903c62bcb9b722e37545f` | `npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix .github/actions/sentinel-app-token` added 24 packages in 2.322 seconds and exited 0. | `5e4b2135-76ad-427d-9a03-92ca7e29c746`                                                                                 |

The original trace-proxy test failed when it tried to open a loopback listener under the offline harness. The accepted trace fixture uses fake transport. Temporary-grant diagnostic runs are outside acceptance and CI test permissions stay as declared. Original receipt `26c6cf008cdb65262171683ae1ea38a8d64599b2af1465c5a12b58783e7d521d/ff99415e-ec8a-42dc-9826-afee6f5c6862`.

```text
NotCapable: Requires net access to "127.0.0.1:0", run again with the --allow-net flag
```

## Full local suite and host limits

The pre-final local CI-equivalent sweep at `0bb8404f9a2953413cacfb3ad6bef3aba32b0af8` reported results for 423 of 894 distinct files. Eleven primary batches settled, including two deadline cutoffs. The owner stopped the superseded sweep once the exact hosted CI had passed. The wrapper exited 143 on SIGTERM and its detached test process group was empty. Six files completed in the interrupted Host 1 batch without a new failed test. An untracked fixture remained in the isolated checkout and tracked source stayed clean. Interrupt receipt `1f073b6f2ac733285076b64632d272c9a04adba7ececd449078810724a7c50a7/a42bcf48-ad54-4fa8-b894-a36fcde1e5f4`.

Static quality passed. The first two module batches passed 271 and 401 cases. Modules-3 had 333 pass, two fail and four ignored in 251.543 seconds. Both failures were in unchanged `tests/replay/dependency-cache_test.ts` cases at lines 117 and 194. Local `/usr/local/bin/node` resolves outside the harness allowlist. Modules-4 and Modules-5 exited 124 at the local 297-second deadline. The three-file Modules-4 suffix passed all 14 cases in isolation. Modules-5 stopped during `tests/repair/loop-incident-intake_test.ts` with no failed case before cutoff. Evidence namespace `1f073b6f2ac733285076b64632d272c9a04adba7ececd449078810724a7c50a7`, suffixes `47efa645-f562-4ed6-8043-41b7eabcf0cb`, `19647190-8847-4e7b-ab3e-045017341dea`, `23144637-cae3-4a98-9c5d-e5cc16eb1821` and `ef2f5790-692c-4ab9-918c-e6a361843b36`.

```text
NotCapable: Requires read access to "/opt/node-lts/bin/node", run again with the --allow-read flag
```

The older sweep also reproduced the modeled acceptance-correction anchor failure documented above. Receipt `1f073b6f2ac733285076b64632d272c9a04adba7ececd449078810724a7c50a7/ac8c39f9-f9ae-48a2-b25d-e8bcd16acad6`.

The local Host 1 dependency-preparation batch on `0bb8404f9a` had 98 passed and six failed in unchanged `tests/host/self-dependency-preparation_test.ts`. The cases reported `Error: self checkout dependencies unavailable` when dependency preparation refused the host's symlinked `/usr/local/bin/node`. The hosted workflow installs real binaries and its Host 1 shard passed. Local receipt `1f073b6f2ac733285076b64632d272c9a04adba7ececd449078810724a7c50a7/cfb5d42e-a45a-4020-abfd-9013bb068931`.

The full-history local Host 1 rollback batch had 48 passed and one failed with two failing steps. The unchanged development baseline `a896fa14b0e473106f8f2a4940326d6f3710b7dd` reproduced both assertions under the standard one-file harness in 22.689 seconds, exit 1, zero passed and one failed with two failing steps. Candidate receipt `1f073b6f2ac733285076b64632d272c9a04adba7ececd449078810724a7c50a7/7d1a209a-ef6d-47d4-951f-cb9b353214fb`. Baseline receipt `26c6cf008cdb65262171683ae1ea38a8d64599b2af1465c5a12b58783e7d521d/284a328f-8440-467c-824f-42272fd29aa5`.

```text
tests/host/matrix-ci-correction-rollback_test.ts:169 AssertionError: [object Object]
tests/host/matrix-ci-correction-rollback_test.ts:191 AssertionError: Error: matrix artifact provenance unavailable or conflicting
```

Local Codex CLI `0.171.0` initialized and failed at restricted correction-thread startup, before any model turn. Evidence `26c6cf008cdb65262171683ae1ea38a8d64599b2af1465c5a12b58783e7d521d/ee644fc4-10e2-46f9-b019-f0757f4184cb`.

```text
error creating thread: failed to load AGENTS.md instructions for environment `local`: fs sandbox helper failed with status exit status: 1: bwrap: Can't mount on symlink destination /usr/local/bin/bun
```

The separate scratch-config diagnostic is outside acceptance. Host Node and Bun paths are symlinks, and host Node 24.20.0 differs from the CI pin of 24.19.0. The Docker feasibility read returned the exact error below. Dependency setup used host tools.

```text
permission denied while trying to connect to the docker API at unix:///run/docker.sock
```

## Owner cutover

1. Merge the reviewed consolidation draft into `development` when its acceptance checks pass. [Draft PR #428](https://github.com/ubiquity-sentinel/sentinel/pull/428)
2. Separately advance the trusted `sentinel-supervisor` launcher to the exact approved CI-green revision containing the on-demand controller. The workflow tree changed, so existing auto-follow requires manual advancement. Apply the existing protected-path rules and verify the protected ref, installed runtime SHA and generation, model-disabled bootstrap and required rollback evidence. An old launcher lacking the operator lane refuses the run. [Master plan](../../MASTER-PLAN.md)
3. Admit the exact `development` branch to the publisher and cleanup environment, retaining the existing policies. The observed environment policies admit `sentinel-supervisor` and `claude/great-ride-tu5r70`. Use the existing App permissions. Live App metadata matched the workflow client ID and reported Contents write, Pull requests write, Statuses read and Checks read. The on-demand verdict is an App commit comment using existing Contents access. The publisher and cleanup mint from the selected environment's App key. The on-demand caller forwards repository or organization-scoped `UOS_AI_TOKEN` only to implementation and review. A repository-scoped secret was observed. [GitHub App Contents permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#repository-permissions-for-contents)
4. Submit a fresh request on the admitted development ref, then check the pinned controller SHA, exact published head, and App comment identity and URL. Keep existing inbox producers and their history on `claude/great-ride-tu5r70` until explicitly migrated. A migrated helper uses a dedicated checkout and only fresh requests. [Helper cutover and stdin dispatch](../../jobs/README.md#submit-a-request)

Operator results are manually merged. A future request for job-authorized auto-merge needs an explicit request opt-in, authorized target and base scope, a current CI rule and a trusted expected-head merge owner.

This consolidation changed no live supervisor, launcher or runtime pointer. Validation used repository CI and local fixtures. It did not dispatch the supervisor or operator workflows or call a hosted model. Operator end-to-end delivery, exact-SHA comment and draft readback, and continued natural supervisor acceptance remain to be established on the admitted refs.
