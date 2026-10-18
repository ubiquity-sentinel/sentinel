# Critique of the merge-queue design (`design.md`, 2026-10-18)

Scope: an adversarial review of `/tmp/claude-0/-home-user/c10997af-52cc-5780-962c-3522871e2f8f/scratchpad/merge-queue/design.md`. It checks the GitHub facts the design relies on, the Sentinel code it relies on (launcher `87e28fd`, runtime R80 `e48e7e110`), and live data. Nothing was modified, pushed, posted or configured. All GitHub calls were GETs. Generation 81 is not available on any branch, so R81 behaviour could not be checked; every R81 dependency below is stated as a gate.

Severity scale:
- **P0**: as written, the design breaks a stated invariant, or its Phase-1 safety claim, in normal operation. Fix before any code ships.
- **P1**: jams records, loses or mis-books deliveries, or voids a go/no-go gate under expected conditions. Fix before flag-on.
- **P2**: misbehaves in plausible cases, relies on a wrong or unsupported fact with operational impact, or lacks a bound. Fix before leaving probation.
- **P3**: accuracy, cost or hardening.

## Verdict

**Do not ship as written: 1 P0, 4 P1, 10 P2, 11 P3.** The GitHub facts are mostly right; the facts table is below. The design fails on Sentinel's own timing and on its own legacy verifier:

1. The 17-minute self-expiring marker assumes 5-minute passes. In reality the launcher runs every 32 to 66 minutes, and the runtime is live for up to 57 minutes after each launcher pass. So under R80/R81 the marker routinely expires while the PR is still queued. R80 then refreshes and pushes to queued branches, retires queue merges as "merged outside the trusted review path", or books them without any proof (P0-1).
2. `verifiedDelivery` tries the legacy verifier first, and that verifier already accepts mid-batch queue merges through the stale `base.sha`. The exact change-set proof is never reached, so the merges the design says "park as unproven" are booked (P1-1).
3. The canary runs as the coordinator, so it cannot settle the App-specific facts that the rollout's go/no-go depends on (P1-4).

---

## 1. GitHub fact check

✓ = confirmed against the cited source. ✗ = wrong, or the design's use of it is wrong. ? = undocumented; must be measured in the canary (section 4).

| # | Design claim (section) | Verdict | Source |
|---|---|---|---|
| F1 | `PUT /pulls/{n}/merge-async` takes `sha`, `merge_action` (`default`/`direct_merge`/`merge_queue`), `bypass_rules` (default false). `default` merges directly when no queue is configured (1.1) | ✓ | OpenAPI `pulls/merge-async`; https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously |
| F2 | 200 if already merged or already queued; 409 with the existing uuid if one is pending; 400 `failed`; "enqueued is final"; results kept 24 h (1.1) | ✓ But the 200 "already in the merge queue" answer checks no head and no enqueuer, and the request stage runs no rules ("Branch protection rules and repository rules are not run at this stage"). Rule failures appear only in `GET …/merge-async/{uuid}` (see P2-3) | same, plus https://docs.github.com/en/rest/pulls/pulls#get-the-result-of-an-asynchronous-merge |
| F3 | `commit_title`/`commit_message` are "Only supported for direct merges" (2.1) | ✓ | OpenAPI `pulls/merge-async` request body |
| F4 | Async merge API GA 2026-10-01 and "the recommended path" (1.1) | ✓ | https://github.blog/changelog/2026-10-01-github-async-merge-api-generally-available |
| F5 | `merge_action: merge_queue` when no queue rule exists (implied safe, 0.2) | ? Undocumented. Only the `default` fallback is described | OpenAPI `merge_action` description |
| F6 | `PUT /pulls/{n}/merge` "does not support … merging with a merge queue"; non-bypass callers get 405 (1.2) | ✓ for the doc note; the 405 text is [community]. ? Whether a **bypass** actor's PUT merges directly | https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request |
| F7 | `enqueuePullRequest{pullRequestId, expectedHeadOid, jump}`, `dequeuePullRequest{id}` with no head binding (1.1) | ✓ | `schema.docs.graphql` `EnqueuePullRequestInput`, `DequeuePullRequestInput`; https://docs.github.com/en/graphql/reference/mutations#enqueuepullrequest |
| F8 | `MergeQueueEntry{state, position, enqueuer: Actor!, headCommit, baseCommit, …}` and the five `MergeQueueEntryState` values (1.1) | ✓ | https://docs.github.com/en/graphql/reference/objects#mergequeueentry |
| F9 | Fallback author binding via `AddedToMergeQueueEvent.enqueuer` (risk 2) | ✗ `enqueuer` is typed `User` (nullable), so it is null for a Bot. Use `actor: Actor` | https://docs.github.com/en/graphql/reference/objects#addedtomergequeueevent |
| F10 | `RemovedFromMergeQueueEvent.reason` gives the ejection class (2.8) | ✓ exists, but it is a free-text `String`; its values are undocumented | https://docs.github.com/en/graphql/reference/objects#removedfrommergequeueevent |
| F11 | `merge_group` trigger, `checks_requested` only, `GITHUB_SHA` = merge-group SHA; without the trigger the required checks never report (1.3) | ✓ | https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group; https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue |
| F12 | `destroyed` reason `invalidated` covers owner direct pushes (2.10) | ✗ The schema defines `invalidated` as "invalidated by an earlier queue entry being dequeued". How the queue reacts to a bypass push to the base is undocumented (?) | OpenAPI `webhook-merge-group-destroyed` |
| F13 | ALLGREEN: every entry's own merge commit must pass. HEADGREEN lets failing entries land (1.5) | ✓ | OpenAPI `repository-rule-merge-queue.grouping_strategy`; GraphQL `MergeQueueMergingStrategy`; managing-a-merge-queue ("Only merge non-failing pull requests") |
| F14 | Every entry is built on its own temporary branch; merge limits don't combine builds; FIFO; jump rebuilds everything (1.5) | ✓ | managing-a-merge-queue |
| F15 | A PR must pass the required checks before it can be queued (implicit) | ✓ "Once a pull request has passed all required branch protection checks, a user with write access … can add the pull request to the queue" | managing-a-merge-queue |
| F16 | `skipped`/`neutral` count as success; a job skipped by a conditional reports success; a job whose dependency failed is skipped (1.6) | ✓ | https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks; https://docs.github.com/en/pull-requests/reference/status-checks |
| F17 | All seven `merge_queue` rule parameters are required (1.6) | ✓ The `pull_request` rule also takes an optional `allowed_merge_methods` | https://docs.github.com/en/rest/repos/rules (OpenAPI `repository-rule-merge-queue`, `repository-rule-pull-request`) |
| F18 | `integration_id` pins a required check to an App (1.6) | ✓ | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets |
| F19 | Bypass actor types and modes; `OrganizationAdmin` ignores `actor_id`; `current_user_can_bypass` is "only returned when querying the repository-level endpoint" (1.7) | ✓ | OpenAPI `repository-ruleset-bypass-actor`, `repository-ruleset.current_user_can_bypass` |
| F20 | merge-async PUT and GET need Contents: write; rules and ruleset reads need Metadata: read (1.8) | ✓ The GET also needs **write** | https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps (Contents and Metadata tables) |
| F21 | A `merge_queues` App permission exists (1.8) | ✓ It is in the OpenAPI `app-permissions` schema. ? Which GraphQL fields and mutations need it is undocumented | OpenAPI `app-permissions.merge_queues` |
| F22 | Approving parked `merge_group` runs works like PR runs (2.4 step 2) | ? `POST /actions/runs/{id}/approve` is documented only "for a pull request from a public fork of a first time contributor" | https://docs.github.com/en/rest/actions/workflow-runs#approve-a-workflow-run-for-a-fork-pull-request |
| F23 | macOS concurrency is 5 on Free/Pro/Team and is the capacity constraint (3) | ✓ for the limit; ✗ as the constraint. The macOS jobs take 15 s (`mac-containment`) and about 3 min (`darwin-native`). The critical path is `validate` on `ubuntu-26.04-arm` (about 21 min) [observed run 39088273884], and job concurrency is shared org-wide with Sentinel's own matrix | https://docs.github.com/en/actions/reference/limits |
| F24 | `cancel-in-progress: false` for push runs makes "every development commit have finished CI" (3) | ✗ With the default `queue: single`, "any existing `pending` job or workflow in the same concurrency group will be canceled". Only `queue: max` or a per-commit group prevents this | https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency (copy in `critique-data/docs/concurrency.md`) |
| F25 | Queue MERGE commits have parents `[P, H]`, committer GitHub, author = enqueuer (1.4) | ✓ [observed]. Corroborated again: rust-lang/team `f283604` is authored by Ubiratan Soares for a PR from jieyouxu. ? Whether an App enqueue gives author login `ubiquity-sentinel[bot]` | probe repos in `research/` |
| F26 | A queued head branch is locked (GH006) (1.5) | ? [community]. Note that R80 classifies a GH006 rejection as `non_fast_forward`, because its text contains "rejected" (`src/github/git-executor.ts:466`) | — |
| F27 | Stacked PRs: merging an upstack PR "includes all open downstack pull requests" | ✓ Not in the design. Only hand-merge relevant, since Sentinel PRs target `development` | OpenAPI `pulls/merge-async` |

---

## 2. Findings

### P0-1: The 17-minute marker expires while the PR is still queued, and R80/R81 then act on the queued PR

**Design.** In 2.3 (lines 184-193) and 2.11 row 1, `QUEUE_MARKER_MS = 17 min`, re-armed "when `until - now < 10 min`, so about every second 5-minute pass". This is the whole Phase-1 guarantee that "a rolled-back runtime never touches a queued PR".

**Evidence (live and code).**
- **Pass cadence is not 5 minutes.**
  - `supervisor.yml:33-35` puts the whole workflow in one concurrency group, `sentinel-supervisor`.
  - Of the last 100 runs, 61 were `cancelled` while pending (superseded by later dispatches) and 37 succeeded.
  - Launcher passes (the `maintenance` job) started at 21:17:34, 22:04:15, 22:46:06, 23:52:00, 00:55:53 and 01:27:51 (2026-10-17/18). The gaps are 47, 42, 66, 64 and 32 minutes.
- **The runtime runs after the launcher, for a long time.** `repair` needs `prepare` and `matrix_plan` and has `timeout-minutes: 120` (`supervisor.yml:508-516`). Observed repair windows after the end of maintenance:

  | Maintenance ended | Repair window |
  |---|---|
  | 23:57:54 | 00:00:23 → 00:55:32 |
  | 22:56:01 | 22:58:04 → 23:51:36 |
  | 01:01:39 | 01:04:56 → 01:27:26 |

  The runtime loop reloads state and re-ranks on every iteration (`src/repair/loop-cycle.ts:79-83, 253`). A record is eligible as soon as `until` passes (`selection.ts:158-162`, `isEligible:205`).
- **The queue phase is not even guaranteed to run in a pass.** `retry` continues only on `retried` (`ops/hosted-autonomy-runner.ts:67-74`), and any other applied result, or a non-applied result before a write, ends the pass (`:286-294`).

**What R80 (`e48e7e110`) then does to a queued record:**
- **(a) Push to the queued head.** If the record has a merge intent and the base moved (the queue itself moves it every time an entry ahead lands), `reconcileMergeIntent` swaps in a `base_refresh` intent (`loop-merge.ts:536-557`). The refresh then pushes to the queued head. A refused push is `BASE_REFRESH_PUSH_DETAIL` (`loop-base-refresh.ts:355-364`), and after 3 failures the record is a terminal block (`loop-base-refresh-failure.ts:35`). If GitHub instead accepts the push and dequeues, a review round is spent and the queue benefit is lost.
- **(b) Retire the queue merge.** If the queue merges while that `base_refresh` intent is held, `reconcileRefreshPublication` blocks the record as "pull request was merged outside the trusted review path" (`loop-base-refresh.ts:423-447`, `selection.ts:36-37`). The delivery is lost.
- **(c) Book without proof.** If the queue merges while the merge intent is held, `reconcileMergeIntent` books a release request for any merge whose head equals the record head (`loop-merge.ts:478-492` → `handleMergeOutcome`). It checks no parents, change set, `merge_group` CI or author. So R80/R81 book queue merges that the launcher's proof would refuse.
- **(d) Erase the marker.** If the record has no intent, `executeMerge` writes one, the port refuses (`merge_queue` is not in `SUPPORTED_MERGE_RULE_TYPES`, `port-contracts.ts:91-98`, so the refusal fires at `port-merge-policy.ts:26` rather than `:34`), and `handleMergeOutcome` overwrites the wait with a 5-minute backoff (`loop-merge.ts:367/377`). The marker is gone, so step 2 of the queue pass no longer observes the record.

The live delivery records confirm R80 keeps cycling them: #1054 and #1089 hold merge intents with a 5-minute backoff last written at 22:45 (`sentinel-state/repair`).

**Fix.**
1. Make the hold one that R80/R81 can never see as elapsed: `wait = {reason: "backoff", since: <enqueue time>, until: null}`.
   - `isWaiting` returns true for any null `until` (`selection.ts:160`).
   - No runtime or launcher code writes `backoff` with a null `until` today; only `manual` and `review_pending` do. So the shape is unique and parses under R79-R81.
   - It needs no re-arm.
   - The launcher clears it only on a proven outcome (merged and booked or parked, ejected, dequeued, or rule absent).
   - A launcher-side maximum age, using `MergeQueueEntry.enqueuedAt`, for example 12 h, parks the record visibly instead of releasing it.
2. Run the queue observation (step 2) as an unconditional pre-phase before `closure-delivery` in every pass.
3. Add R81 contract tests for this exact shape: never re-planned, parked, charged or rewritten at `delivery` or `work`.
4. If R81's jam work cannot accept a null-`until` backoff, use a finite hold of at least 4 h instead (longer than maintenance 15 + prepare 10 + plan + repair 120 minutes). Then document that a launcher outage of more than 4 h re-exposes R80/R81.
5. R82 must not rely on the hold. Before any push, refresh, merge intent or booking for a Gateway record, it reads `PullRequest.isInMergeQueue` and refuses if the PR is queued.

### P1-1: The legacy verifier runs first and books mid-batch queue merges without the queue proof

**Design.** 2.6 (lines 247-250): `verifiedDelivery = verifiedMergedDelivery(…) ?? verifiedQueueDelivery(…)`, with "a merge is classified by its shape: `[B, H]` is legacy, anything else needs the queue proof" (line 264). 2.10 and risk 7 say an overlapping owner push makes the record "park as unproven, with no booking, closure or follow-up".

**Evidence.**
- `baseAndHeadAreMerged` (`ops/hosted-autonomy-delivery.ts:171-183`) does not classify by shape. It accepts any two-parent merge containing H whose first parent descends from B, as long as `pull.baseSha === base`.
- The design itself shows (1.4) that `base.sha` is the base at the PR's last update. Sentinel PR heads are created on B and not updated afterwards, so `base.sha == B` for every queued Sentinel PR.
- `verifiedMergedDelivery` (`:185-205`) has no `merged_by`, author, change-set or CI check.
- So the legacy path books three kinds of merge that the design says park:
  - a mid-batch queue merge whose drift overlapped a reviewed path;
  - an owner-enqueued Sentinel PR (commit author = owner);
  - a merge whose required jobs were `skipped`.
- The delivery pass books on exactly this predicate (`delivery-pass.ts:485-489`). Closure consumes it too (`closure-pass.ts:194, :358`), and checks `merged_by` only for `recovered` records (`:350-356, :490-496`). The design's statement in 2.1 and 2.11 that closure "requires merged_by == App" is therefore also inaccurate.

**Fix.**
- Put the queue proof first.
- For the Gateway, accept the legacy predicate only for Sentinel's own direct PUT merges: `merged_by == App`, exact parents `[B, H]`, and no `merge_group` run for M.
- Drop the `baseSha` descendant branch on the Gateway path, or prove it is needed and keep it only there.
- Add a lifecycle test: a mid-batch queue merge with overlapping drift and `base.sha == B` must park, not book.

### P1-2: Sentinel PRs queued by someone else, or misclassified, are left unprotected

**Design.** Step 2 of 2.4 treats "Queued" as `isInMergeQueue && headCommit.oid == H && enqueuer == App`. Everything else is "Neither merged nor queued: classify the ejection … and clear the marker". Step 3 does not check membership.

**Failure.**
- The owner clicks "Merge when ready" on a Sentinel PR, or dequeues and re-enqueues it, as owners do. The entry's enqueuer is the owner, so the marker is cleared while the PR is still queued, and the P0-1 consequences follow.
- A Sentinel PR that the owner enqueues directly never gets a marker at all.
- The launcher's own refresh-rearm pass can re-arm a base refresh for such a record.

**Fix.**
- On every pass, read the whole queue (`Repository.mergeQueue(branch:"development").entries`, paged).
- Hold every Sentinel record whose PR is in it, whoever enqueued it.
- Classify only after the PR has left the queue.
- A non-App enqueue ends as the existing hand-merge disposition, but is never a reason to release the hold while the PR is queued.

### P1-3: The receipt binds the change set only at enqueue, and owner and coordinator bypass merges are routine

**Evidence: `development` first-parent history, 2026-10-16..18.**
- Owner direct commits: `2c47de1` (20:03), `b24353e` (20:35), and the `lib/codex` bump.
- Merge bursts:
  - 12 `claude/issue-*` PRs in 42 s (10-16, 19:01:43-19:02:58);
  - 4 in 9 s (20:56);
  - 4 between 17:20 and 17:22 on 10-17;
  - 4 more between 18:52 and 19:40.
- These merges are by `0x4007` (`merged_by` on #1162 is `0x4007`), which is also the identity that coordinator sessions act as (`gh` here authenticates as `0x4007`).
- Under the proposed `OrganizationAdmin`/`always` bypass, a `PUT /merge` or the MCP `merge_pull_request` tool from that identity bypasses the queue (F6, ?).

**Failure.** Each bypass merge moves `development` under the queued Sentinel entries. If it touches a reviewed path and merges cleanly, the Sentinel entry merges content no receipt reviewed.
- The design detects this only after the merge (2.6 item 5), and P1-1 bypasses even that check.
- The per-pass recheck covers task text, not drift.
- Passes are 32-66 minutes apart.

**Fix.**
1. Every pass, for every held entry, dequeue if the drift from B to the current tip, or a foreign entry now ahead (after a jump), touches any reviewed path. Use the same tree predicate as the proof.
2. Coordinator rule for `ai.ubq.fi`: never use `PUT /merge` or MCP `merge_pull_request`. Always use `merge-async` with `{merge_action: "merge_queue", bypass_rules: false}`. Never batch-merge by bypass.
3. Owner practice: push directly only when no Sentinel entry is queued, or dequeue first.
4. An unproven queue merge is a visible park with an owner-facing action line.

### P1-4: The canary cannot settle the App-specific facts that the go/no-go depends on

**Design.** Step 4a has the coordinator enqueue the canary PRs. The risk table (risks 1-3) says these risks are "confirmed in 4a".

**Problem.** Every open fact is about the Sentinel App's token:
- whether the App can enqueue (merge-async is documented as Contents: write only, F20, but the GraphQL permissions are undocumented, F21);
- the commit author login for an App enqueue (item 2 of the proof binds it);
- REST `merged_by` for an App enqueue;
- GraphQL reads with an installation token.

The coordinator identity cannot call GraphQL (design 2.10), and it is a bypass actor under `OrganizationAdmin`. If an App-enqueued commit's author is not `ubiquity-sentinel[bot]`, every real queue merge parks.

**Fix.** Run the canary through the supervisor with the App token, using a one-shot launcher canary mode limited to `queue-canary` and an explicit allowlist of canary PR numbers. Coordinator-identity behaviour (bypass PUT merge) is a separate, second canary item.

### P2-1: The CI concurrency change still cancels pending push runs

**Problem.** The section 3 YAML keeps `group: ai-ubq-fi-ci-${{ github.ref }}` with `cancel-in-progress` false for push. With the default `queue: single`, a newer push cancels the pending one (F24); the supervisor's own 61% pending-cancel rate is the same mechanism. Several queue merges or owner pushes close together still leave `development` commits with a `cancelled` latest run. Sentinel reads the latest run per check name, so it sees a red base.

**Fix.**

```yaml
concurrency:
  # Pull requests: one group per PR ref; superseded runs are cancelled.
  # push / merge_group / workflow_dispatch: one group per commit, so no run for a
  # development or merge-group commit is ever cancelled or replaced while pending.
  group: ai-ubq-fi-ci-${{ github.event_name == 'pull_request' && github.ref || format('{0}-{1}', github.event_name, github.sha) }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Verify on 3 consecutive `development` commits.

### P2-2: `merge_group` CI that never reports, or reports "skipped", is not gated before enqueue

**Failure cases.**
- **No run at all.** The workflow is disabled in the UI, or an owner push or PR removes the `merge_group` trigger. The checks stay Pending. Each Sentinel entry costs 2 × `check_response_timeout`, and then the "ejected twice" park applies to every record.
- **A foreign entry edits the workflow.** If a foreign entry ahead changes `.github/workflows/**` (for example with an `if:`), Sentinel's own entry behind it is built with that workflow. The skipped jobs report success (F16), GitHub merges, and Sentinel's success-only proof refuses only after the merge. That breaks "a red required-CI head never merges" in spirit.
- **Runs parked for approval.** Parked `merge_group` runs (F22) wait for the next pass (32-66 min) and then hit the 60-minute timeout.

**Fix.**
- Before each enqueue:
  - `GET /actions/workflows/deno-deploy.yml` returns `state: active`;
  - the file at the tip contains `merge_group`;
  - no entry ahead touches `.github/`.
- Add a circuit breaker: after N timeouts with no CI run, stop enqueueing and report, without parking records.
- Add "are `merge_group` runs parked, and can the App approve them?" to the canary.

### P2-3: Enqueue refusals are invisible and unbounded

**Problem.**
- Rule failures appear only in the async result (F2), and the uuid is kept only in an action line, not in state.
- No REST or GraphQL timeline event exists for a refused enqueue.
- So "counts come from GitHub" (2.8) cannot bound refusals. Each pass marks, enqueues, fails, clears, and repeats. The crash-window text also contradicts itself: it says re-send in one place and `enqueue_refused` clears in another.

**Fix.**
- Poll `GET …/merge-async/{uuid}` within the same pass for a bounded number of seconds.
- Carry a `failed` result into the next pass's write.
- Bound refusals per head (for example 3). Use the hold's `since` and age, or an R82 field, and then park with the GitHub message.

### P2-4: Ejected records have no way back

**Problem.**
- `dequeued_external` parks with "never re-enqueued automatically" (2.8), and nothing defines how the park is released. An owner's temporary dequeue (for example, to push a fix) strands the record permanently.
- There is no `head_moved` class for a dequeue caused by a push.

**Fix.**
- Re-pend the record when the tip moves or after 24 h, through the existing retry-pass mechanism.
- Map a push-caused dequeue (`head_moved`) to: clear the hold, then let the runtime's existing foreign-head path handle it.

### P2-5: The authorization window is understated

**Design.** It assumes 25-60 minutes with a recheck on every pass.

**Reality.**
- Rechecks happen 32-66 minutes apart, so a PR often merges with no recheck at all after enqueue.
- Queue time grows with manual bursts: 12 entries at `max_entries_to_build: 2` × about 22 minutes is about 2.2 h.

**Fix.** The owner decision needs these numbers. Also consider:
- enqueueing only when `nextEntryEstimatedTimeToMerge` is below a bound;
- raising build concurrency (F23: macOS is not the bottleneck).

### P2-6: The ruleset can change between Sentinel's verdict read and its enqueue

**Problem.**
- The rule verdict is read once per pass, and the enqueues happen after the state write. An owner edit in between (HEADGREEN, SQUASH or disabling the rule) is missed.
- `merge_action: merge_queue` with no queue configured is undocumented (F5). If it fell back to a direct merge, the PR would land on a tip whose combined result no CI ran, which is the exact thing `mergeCalled` exists to prevent.

**Fix.**
- Re-read `rules/branches/development` immediately before each enqueue call.
- Canary: `merge_queue` on a branch with no rule must fail.
- Owner practice: edit the ruleset only while no Sentinel entry is queued.

### P2-7: Rollout sequencing errors

- **Step 4b → 5 cannot be "minutes".** A launcher commit takes effect at the next supervisor run (32-66 min), and a pending run may still execute the old ref. Instead, ship mode `on` gated by the owner's kill-switch variable, so the owner flips it in the same sitting as the ruleset (see section 3).
- **Step 0 cannot be verified when it runs.** Its verification needs step 3's GraphQL probe.
- **R81 is not gated.** There is no gate for R81 being installed and healthy, or for the marker contract tests being in R81 before flag-on.
- **The rollback depends on an unmeasured behaviour.** The rollback disables the ruleset while entries are queued, but what happens to queued entries then is undocumented. Measure it in the canary.

### P2-8: The `pull_request` rule is unnecessary and adds blockers that are not P0/P1

**Problem.**
- The `merge_queue` rule already forces merges through the queue, and `required_status_checks` blocks unchecked pushes.
- The `pull_request` rule documents "If someone chooses the Request changes option in a review, then that person must approve the pull request before the pull request can be merged" (available-rules page, F18). Whether that applies with 0 required approvals is unclear, and if it does, it is a block on something other than P0/P1. Sentinel posts only `COMMENT` reviews (`src/github/client.ts:116`), so the risk is human reviews.
- AGENTS.md says "never … recreate deleted rules". The owner previously removed a `pull_request` rule (comment at `supervisor.yml:89-95`, commit `ca99629a2`), probably on the sentinel repository.

**Fix.** Omit the rule. Or keep it only after the canary shows that a "Request changes" review with 0 required approvals does not block enqueue, and after the owner explicitly confirms it.

### P2-9: The Phase-2 deferral can livelock

**Problem.** R82 defers moved-base, disjoint records with "merge queue delivers <id>", writes nothing, and relies on the launcher to enqueue them. If the launcher never does (foreign overlap, red tip, a skipped pass, the flag off, or the kill switch), the record never refreshes.

**Fix.** Bound the deferral (for example 2 passes or 2 h) and then fall back to the ordinary refresh. Make the R82 deferral shape parseable by R81.

### P2-10: Frequent owner pushes may keep the queue from ever landing

**Problem.** In active hours, `development` changes about every 15 minutes (P1-3 data), and `validate` takes about 21 minutes. If GitHub rebuilds groups after a bypass push (F12, ?), entries may not land until the owner pauses.

**Fix.** Measure rebuild behaviour in the canary, and document it as an owner-practice item.

### P3 notes

1. **Port refusal reason.** The R80 port refuses with "unsupported active rules: merge_queue" (`port-merge-policy.ts:26`), not `:34`. The outcome is the same.
2. **Launcher rollback row in 2.11.** It is wrong for closure: closure does not refuse when `merged_by` ≠ App unless the record is recovered (P1-1). Follow-ups do refuse (`follow-up-pass.ts:61`).
3. **Delivery-line holding.** R80/R81 hold the delivery line for every higher-numbered moved-base record, not only overlapping ones (`delivery-queue.ts:146-158`). The hold is released on merge or after `DELIVERY_QUEUE_IDLE_MS` (2 h), so it is not a jam, but the sentence in 2.7 ("for overlapping refreshes") is wrong.
4. **Free-text ejection reasons.** Classification by `reason: String` is brittle. Record the exact strings in the canary, and map an unknown string to "clear the hold, no park".
5. **Carried proof durability.** The carried proof no longer lands in a durable commit message, and action lines expire with job logs. Put the proof digest in the release request, or keep it in state.
6. **Marker uniqueness test.** A test that enumerates written constants cannot cover computed waits: `waitSince` keeps an old `since`, so a red-base backoff's `until - since` can be any value of at least 30 minutes (`loop-ci-first.ts:267`, `loop-ci-correction.ts:194`). This is moot with a null-`until` hold.
7. **Bookings per pass.** Raising bookings from 1 to 8 per pass is fine while releases are disabled. Revisit before enabling them.
8. **Phase-2 disjointness.** It uses `git diff --name-only`, which folds renames. Use `--no-renames`, or reuse the launcher's tree predicate, so that both sides agree.
9. **Duplicated policy module.** The launcher's copy of `src/repair/merge-queue-policy.ts` and R82's copy can diverge. Pin one source by hash in a test.
10. **Capacity sizing.** Size the timeout and build concurrency on `validate`'s about 21 minutes and on org-wide job concurrency shared with Sentinel's matrix (up to 11 cells observed, `timeout-minutes: 300`). macOS is not the constraint. `max_entries_to_build: 2` is conservative.
11. **GraphQL transport.** Reuse the runtime's GraphQL transport and its cooldown gate (`src/github/client-issues.ts:91-101`) instead of a new client.

### Invariant cross-check after the fixes

| Invariant | Design as written | With the fixes |
|---|---|---|
| Only P0/P1 block merge | GitHub "Request changes" may block through the `pull_request` rule (P2-8) | `pull_request` rule omitted |
| A red required-CI head never merges | H is green at enqueue and ALLGREEN applies to M; `skipped` lands through a foreign workflow edit (P2-2) | Pre-enqueue workflow and `.github` gate |
| Receipt authorizes exactly what merges | Only at enqueue; unproven merges are booked anyway (P1-1, P1-3, P0-1c) | Per-pass drift dequeue, queue-proof-first, R80 never sees a queued or merged-unbooked record |
| Reservations stay charged | Holds | Holds |
| No PR-closing or branch-deleting code | Holds | Holds |
| Release path disabled | Holds | Holds |
| Queue merges recognised as verified delivery | Too permissive (P1-1), and the R80 runtime path is unguarded (P0-1) | Single proof, applied first |

---

## 3. Corrected rollout

### Gate A: before any code is written

Revise the design for:
- P0-1: null-`until` hold, unconditional pre-phase, R82 guard;
- P1-1: queue proof first, restricted legacy path;
- P1-2: whole-queue scan, hold regardless of enqueuer;
- P1-3 (1): per-pass drift dequeue;
- P2-1: the corrected YAML;
- P2-2 and P2-3: pre-enqueue gates and bounds.

### Gate B: before the ruleset exists on `development`

- The installed runtime is R81, healthy, with the null-`until` contract tests in its suite. Or the owner explicitly pins R80 and the tests ran against R80.
- The canary go/no-go (step 5) passed.

### Steps

| # | Step | Who | Verify | Rollback |
|---|---|---|---|---|
| 0 | Add "Merge queues: Read and write" to App 4682172 and accept it on the `ubiquity` installation. | Owner | Deferred to step 3. | Remove the permission. |
| 1 | `ai.ubq.fi` CI PR: add `merge_group: types: [checks_requested]` (no `branches` filter) and the P2-1 concurrency block. Merge it while no ruleset exists. | Coordinator drafts; owner merges | The PR's own CI is green. The next 3 `development` commits each have a completed, not cancelled, push run. PR runs still cancel superseded ones. | Revert the PR. |
| 2 | Owner first creates the repository variable `SENTINEL_MERGE_QUEUE=off`. Then ship the launcher with code mode `on` (the variable lowers it to `off`), plus all Gate A fixes. | Owner, then coordinator | Action lines match legacy exactly. The hold pre-phase line prints on every pass. | Revert the commit. |
| 3 | Owner sets the variable to `observe`. | Owner | The GraphQL `mergeQueue` probe with the App token succeeds, which verifies step 0. `queue:would_enqueue` lines appear. Gate B's runtime contract tests are green. | Set the variable to `off`. |
| 4 | Owner creates the `queue-canary` branch and a canary ruleset scoped to it. | Owner | `rules/branches/queue-canary` shows the rules. | Delete the canary ruleset and the branch. |
| 5 | **Canary through the App.** A one-shot launcher canary mode, with an allowlist of coordinator-opened PRs into `queue-canary`, enqueues them with the App token. A separate coordinator-identity pass covers item 10. | Coordinator, owner | Every item in the canary checklist (section 4). | Same as step 4. |
| 6 | Pre-flight: no `claude/issue-*` burst is planned, the coordinator merge rule (P1-3 (2)) is in force, and the owner knows the practice for direct pushes. | Owner, coordinator | — | — |
| 7 | Owner creates the `development` ruleset (corrected JSON below) and, in the same sitting, deletes `SENTINEL_MERGE_QUEUE`. The effective mode becomes `on` with probation of 1 enqueue per pass. | Owner | Next pass: verdict `valid`; the hold is written in the same state write that precedes the enqueue; `status=enqueued`. Within 1-2 runs: the `queue_merged` proof line and a booking. The runtime never touches the held record. | Set the variable to `off` (drain), then follow the rollback order below. |
| 8 | After at least 2 verified bookings across at least 3 supervisor runs with no runtime action on held records, raise the per-pass limit to 6. | Coordinator | No new `push to queued branch` or `merged outside the trusted review path` lines. | Lower the limit. |
| 9 | R82: runtime queue guard, the Phase-2 handoff with a bounded deferral, and `merge_group` correction evidence. Enable `QUEUE_SPENT_MOVED_BASE` separately afterwards. | Coordinator | No GH006 lines; no deferral older than its bound. | Install rung back to R81. Safe with null-`until` holds. |

### Rollback order (always)

1. Set the variable to `off`. No new enqueues; held entries still merge, get verified and get booked.
2. Wait until the queue holds no Sentinel entry, or the owner dequeues them. One pass must then observe "not queued" and clear the holds.
3. Owner disables the ruleset.
4. Only then revert the launcher or the runtime.

With null-`until` holds, an emergency launcher rollback leaves held records waiting. That is safe and visible, and the owner or the restored launcher clears them.

### Corrected ruleset

Compared with the design's section 4.1 JSON:
- **Remove** the `pull_request` rule (P2-8), or keep it only after the canary result and explicit owner confirmation.
- **Bypass:** `{"actor_type": "User", "actor_id": <0x4007's user id>, "bypass_mode": "always"}` is narrower than `OrganizationAdmin`. Either way, the coordinator acts as `0x4007` and so inherits the bypass. The P1-3 coordinator rule is therefore mandatory, not optional.
- **`max_entries_to_build`:** 3-4 is reasonable (F23). Keep `check_response_timeout_minutes` at 60, and raise it to 90 if canary queue waits for runners exceed 15 minutes.
- Everything else as in the design: MERGE, ALLGREEN, all four checks pinned to `integration_id 15368`, `strict` false, `deletion`, `non_fast_forward`, and no ruleset on `ubiquity/sentinel`.

---

## 4. Canary checklist (step 5)

Items 1-9 run with the App token. Each item is a go/no-go.

1. **Enqueue path.** Does `merge-async {sha, merge_action: merge_queue}` with only Contents: write succeed? Do `enqueuePullRequest` and `dequeuePullRequest` succeed with the new permission? Does a GraphQL `mergeQueue` read succeed?
2. **Commit identity.** Author login of the queue commit (it must be `ubiquity-sentinel[bot]`); REST `merged_by`; `merge_commit_sha` equals the entry commit; the second PR's first parent is the first PR's commit.
3. **Branch lock.** A push to a queued head is either refused (GH006) or dequeues the PR. If it is **neither**, abort the rollout.
4. **No-queue behaviour.** After the rule is disabled, does `merge_action: merge_queue` fail? (It must not merge directly.) What happens to entries that were queued when the rule was disabled?
5. **Bypass pushes.** When the owner pushes directly to `queue-canary` with entries queued: rebuild, eject, or failure? How many extra CI runs does it cost?
6. **Parked runs.** Are `merge_group` runs ever `action_required`? If so, can the App approve them?
7. **Removal reasons.** The exact `RemovedFromMergeQueueEvent.reason` strings for a forced CI failure, a timeout (set a short canary timeout), a manual dequeue and a head push.
8. **Missing trigger.** A forced missing `merge_group` trigger, applied on the canary base, must produce a timeout, not a merge.
9. **Pending-cancel.** The P2-1 concurrency block leaves no `cancelled` push or `merge_group` run across a burst of 3 merges.
10. **Coordinator identity.** Does a `PUT /merge` as `0x4007` merge directly (bypass) or return 405? Does `merge-async` with `bypass_rules: false` enqueue? If `pull_request` is kept: does a "Request changes" review with 0 approvals block enqueue?

---

## 5. Owner decisions, restated with measured numbers

1. **Authorization window.** Expect 30-90 minutes from enqueue to merge, and more than 2 h behind manual bursts, often with **no** recheck in between, because launcher passes run every 32-66 minutes. Per-pass dequeue on task drift and on base drift narrows the window but does not close it.
2. **Owner direct pushes.** The bypass keeps them working, but each one invalidates the in-flight groups and can overlap queued Sentinel PRs. Practice: push directly only when no Sentinel entry is queued, or route owner changes through "Merge when ready".
3. **Coordinator merges.** Always use `merge-async` with `merge_queue`. Bursts become a queue drain of about 22 minutes per `max_entries_to_build` entries.
4. **Ruleset.** Choose whether to keep the `pull_request` rule, the bypass actor (`User` or `OrganizationAdmin`), and the build concurrency (3-4 recommended).

---

## 6. Evidence collected for this critique

All under `/tmp/claude-0/-home-user/c10997af-52cc-5780-962c-3522871e2f8f/scratchpad/critique-data/`:
- `maint-<run>.log`: maintenance job logs for supervisor runs 39054898059, 39069593721, 39073338516, 39076299304, 39080597401 and 39082934785.
- `dev-commits.tsv`: `development` commits since 2026-10-16. The first-parent history comes from the clone in `fp/r.git`.
- `docs/concurrency.md`: the GitHub concurrency doc, fetched through `docs.github.com/api/article/body`.
- `sentinel-prs.txt` and `sentinel-pr-files.txt`: recent Sentinel PRs and their file paths. Overlap is moderate, so batching is viable.
- `aiubq/repo`: shallow clone of `ai.ubq.fi` `development` at `0d7268741`, used for the workflow and script audit. No `pull_request` context use was found, which confirms the design's audit.

The GitHub sources are the design's own downloads in `/tmp/claude-0/-home-user/c10997af-52cc-5780-962c-3522871e2f8f/scratchpad/research/` (`rest.json`, `schema.docs.graphql`, `app-perms.md`, `mq-managing.md`, `mq-merging.md`, `events.md`, `rules.md`, `trouble.md`, `status-checks.md`, `limits.md`, `async-cl.html`), re-read for this check.

Live reads were all GETs: supervisor and Gateway CI run and job timings, PR #1121 and #1162 merge facts, commit `430b203`, the repository merge settings, `rules/branches/development` (`[]`), and records #1054, #1089, #1112 and #1120 in `sentinel-state/repair`.
