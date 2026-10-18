# Merge queue for `ubiquity/ai.ubq.fi` `development`: Sentinel design

Date: 2026-10-18. Owner decision (2026-10-18): use GitHub's merge queue on `ubiquity/ai.ubq.fi` `development` so green PRs are batch-tested and merged, instead of one merge per maintenance pass. Owner reply in this run: "Sure batching through merge queue seems fine".

Inputs: launcher `ops/` live at `87e28fd4a7796078adc4c930dd49d02651f82203` (`origin/development` = `origin/sentinel-supervisor`). Runtime `src/` is generation 80 (R80 `e48e7e110`). Generation 81 is being integrated now and is not pushed yet. Line references below are to `87e28fd`.

Status: design only. Nothing was modified, pushed, posted or configured. All GitHub reads were read-only.

How each fact was checked. The `WebFetch` tool could not resolve `docs.github.com` from this session, so docs.github.com articles were downloaded as markdown through `https://docs.github.com/api/article/body?pathname=…`. The public GraphQL schema came from `https://docs.github.com/public/fpt/schema.docs.graphql` and the REST OpenAPI description from `github/rest-api-description` (`api.github.com.json`). GraphQL itself cannot be called from this session. Commit shapes were checked by `git fetch` of the live `gh-readonly-queue/*` refs of public repositories that use the queue. Live `ai.ubq.fi` facts came from REST reads. Copies of everything are in `/tmp/claude-0/-home-user/c10997af-52cc-5780-962c-3522871e2f8f/scratchpad/research/`.

Each fact carries a tag:
- **[doc]**: GitHub documentation.
- **[schema]**: GraphQL schema or OpenAPI description.
- **[observed]**: seen in live git or API data.
- **[community]**: third-party reports, not confirmed by GitHub.
- **[canary]**: not confirmed yet; must be checked during rollout step 4a.

---

## 0. Decisions in one screen

1. **Ruleset settings.** Ruleset on `refs/heads/development` with:
   - `merge_queue`: `merge_method: MERGE`, `grouping_strategy: ALLGREEN`.
   - `required_status_checks`: `validate`, `mac-containment`, `darwin-native`, `verify-artifact`, each pinned to GitHub Actions (`integration_id: 15368`), `strict: false`.
   - `pull_request` with 0 approvals, plus `deletion` and `non_fast_forward`.
   - The owner is the only bypass actor. The Sentinel App is **never** a bypass actor. No ruleset is ever added to `ubiquity/sentinel` (AGENTS.md forbids it).
2. **Enqueue call.** `PUT /repos/ubiquity/ai.ubq.fi/pulls/{n}/merge-async` with `{"sha": H, "merge_action": "merge_queue", "bypass_rules": false}`, where H is the reviewed head (or the carried, refreshed head H1). GitHub has recommended this path since 2026-10-01. The fallback is GraphQL `enqueuePullRequest(pullRequestId, expectedHeadOid: H, jump: false)`. Never use `merge_action: "default"`: when no queue exists, it merges directly.
3. **Queue reads and dequeue use GraphQL.** Membership comes from `PullRequest.isInMergeQueue` / `mergeQueueEntry` and `Repository.mergeQueue(branch:"development")`. Dequeue is `dequeuePullRequest`. REST has neither.
4. **Durable claim before the external effect.** In one CAS state write, the launcher sets a *queue marker* on every record it is about to enqueue. The marker is an ordinary `backoff` wait of exactly 17 minutes, re-armed while the PR is queued. Only after that write does it call enqueue. R80 and R81 already parse this shape and skip waiting records (`src/repair/selection.ts:158-162`), so a rolled-back runtime never touches a queued PR.
5. **Delivery proof.** A queue merge counts as a verified delivery only under an exact change-set proof, which replaces `baseAndHeadAreMerged` and the carried `[T, H1]` parent proof. The proof requires:
   - the merge commit M has parents `[P, H]`;
   - the reviewed base B is an ancestor of P (or equal to it);
   - M is on `development`;
   - the tree changes P→M equal the reviewed merge-base patch B→H, by path, old and new mode, and old and new blob id (`sameTreeChanges`, which already exists);
   - M has a completed, successful `merge_group` run in which all four required checks are `success`;
   - M's author is `ubiquity-sentinel[bot]`, the enqueuer.

   The same predicate feeds the delivery, closure, follow-up and spent-adoption passes.
6. **Many enqueues per pass, bounded.** In queue mode there are no direct merges. Each pass enqueues up to `QUEUE_ENQUEUES_PER_PASS` reviewed, green, path-disjoint PRs (1 during probation, then 6), and the queue serializes them. Legacy mode keeps today's one-merge-per-pass bound unchanged.
7. **Delivery in two phases.**
   - **Phase 1 (launcher only):** works under R80 and R81.
   - **Phase 2 (runtime generation 82):** the runtime guards against pushing to a queued branch, turns a queue ejection into CI-correction evidence, and hands moved-base, path-disjoint records to the queue instead of refreshing them.

   Nothing goes into R81.

---

## 1. GitHub merge queue facts that matter

### 1.1 Enqueue and dequeue

| Fact | Tag / source | Consequence |
|---|---|---|
| `enqueuePullRequest(input: {pullRequestId: ID!, expectedHeadOid: GitObjectID, jump: Boolean, clientMutationId})` adds a PR to the queue and returns `mergeQueueEntry`. | [schema] `schema.docs.graphql` (EnqueuePullRequestInput, Mutation.enqueuePullRequest); https://docs.github.com/en/graphql/reference/mutations#enqueuepullrequest | `expectedHeadOid` binds the head. Sentinel always passes H and `jump: false`. |
| `dequeuePullRequest(input: {id: ID!})` removes a PR. There is **no** head binding. | [schema]; https://docs.github.com/en/graphql/reference/mutations#dequeuepullrequest | Dequeue only Sentinel's own entry, after re-reading that the entry's `headCommit.oid` is H. |
| `PullRequest.isInMergeQueue`, `PullRequest.isMergeQueueEnabled`, `PullRequest.mergeQueueEntry`, `PullRequest.mergeQueue`, `Repository.mergeQueue(branch)`. | [schema] | These are the only authoritative membership reads, and they are GraphQL-only. |
| `MergeQueueEntry` fields: `state`, `position`, `enqueuer: Actor!`, `enqueuedAt`, `headCommit`, `baseCommit`, `jump`, `solo`. `MergeQueueEntryState` is one of `AWAITING_CHECKS`, `LOCKED`, `MERGEABLE`, `QUEUED`, `UNMERGEABLE`. | [schema]; https://docs.github.com/en/graphql/reference/objects#mergequeueentry | `enqueuer.login == "ubiquity-sentinel[bot]"` and `headCommit.oid == H` are checked on every pass. |
| `MergeQueueConfiguration` fields: `checkResponseTimeout`, `maximumEntriesToBuild`, `maximumEntriesToMerge`, `minimumEntriesToMerge`, `minimumEntriesToMergeWaitTime`, `mergeMethod`, `mergingStrategy` (ALLGREEN/HEADGREEN). | [schema] | Cross-checked against the REST rule parameters (section 2.2). |
| Timeline events `AddedToMergeQueueEvent{actor, enqueuer}` and `RemovedFromMergeQueueEvent{actor, enqueuer, reason: String, beforeCommit}` are GraphQL-only. The REST issue-event docs list no merge-queue events. | [schema]; https://docs.github.com/en/rest/using-the-rest-api/issue-event-types | The ejection reason (and who dequeued) is read from GraphQL. |
| REST `PUT /pulls/{n}/merge-async` takes `sha` and `merge_action` (`default` / `direct_merge` / `merge_queue`). For a queue request the response says `expected_head_sha` is the "SHA that the pull request head must match for the enqueued merge to proceed". Responses: `202` pending with `uuid`; `200` immediately if already merged or already queued (`status: enqueued`); `409` with the existing uuid if a request is pending; `400 failed` if not mergeable. `GET …/merge-async/{uuid}` returns `pending` / `merged` / `enqueued` / `failed`. "An enqueued result is final … does not change when the merge queue later merges". The result is kept for 24 h. `bypass_rules` defaults to false. | [schema] OpenAPI `pulls/merge-async`, `pulls/get-merge-async-result`; https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously | The enqueue is idempotent, so a lost response is safe: re-sending gives 200 `enqueued` or 409 with the uuid. It is still not a membership read. |
| Async merge API GA on 2026-10-01: "the recommended path for programmatically merging pull requests instead of the synchronous REST endpoint or GraphQL mutations." | [doc] https://github.blog/changelog/2026-10-01-github-async-merge-api-generally-available | It is the primary enqueue path. The API is new, so GraphQL enqueue is kept as the fallback. |
| Mergify reports that GitHub's merge API honors only the `exempt` bypass mode. | [community] https://docs.mergify.com/changelog/2026-08-12-merge-github-stacked-pull-requests-with-the-merge-queue/ | Irrelevant to Sentinel, which never bypasses. Noted for owner tooling. |

### 1.2 The REST merge endpoint once a merge-queue rule is active

- The OpenAPI note on `PUT /pulls/{n}/merge` reads: "This endpoint does not support stacked pull requests or merging with a merge queue." Its documented refusal is `405 Method Not Allowed if merge cannot be performed`; a sha mismatch gives `409`. [schema] https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request
- Callers without bypass report `405` with "Changes must be made through the merge queue". [community] https://github.com/renovatebot/renovate/discussions/25065, https://github.com/pascalgn/automerge-action/issues/235
- Effect on Sentinel today:
  - The launcher's `merge()` (`ops/hosted-autonomy-github.ts:573-588`) would get a non-2xx answer, so `delivery:<id>:merge_refused`. Because `mergeCalled` is already set, nothing else merges in that pass.
  - The runtime merge port already refuses before calling GitHub: `merge queue rules are active` (`src/github/port-merge-policy.ts:34-36`), so `blocked("protection_required")`, which sets a 5-minute backoff (`src/repair/loop-merge.ts:357-381`).

  So a merge-queue rule with no queue code means **no deliveries at all**. It does not mean wrong ones.

### 1.3 `merge_group` events and `gh-readonly-queue/*`

- The workflow trigger is `merge_group`, and only `checks_requested` exists for Actions. `GITHUB_SHA` is the "SHA of the merge group" and `GITHUB_REF` is the "Ref of the merge group". "You **must** use the `merge_group` event … Otherwise, status checks will not be triggered … The merge will fail as the required status check will not be reported." [doc] https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group, https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- Webhook `merge_group` carries `checks_requested` and `destroyed`. A `destroyed` event has `reason` ∈ {`merged`, `invalidated`, `dequeued`}. Its payload has `head_sha`, `head_ref`, `base_sha`, `base_ref`. A GitHub App needs "Merge queues" read to subscribe. [doc] https://docs.github.com/en/webhooks/webhook-events-and-payloads#merge_group. Sentinel is pass-based and does not subscribe; it reads the queue on each pass.
- **Temporary branch name** (observed in zed, posthog, cilium, servo, nixpkgs and rust-lang/team): `refs/heads/gh-readonly-queue/{base}/pr-{N}-{sha}`, where `{sha}` is that entry's **base commit**, meaning the previous entry's head or the branch tip. Example from zed: `pr-23179-dfc4faf…`, where `dfc4faf` is the head of the `pr-22995` group. [observed]
- **Stale queue refs linger.** `rust-lang/team` still has `gh-readonly-queue/main/pr-2355-3bd57a2…` → `5c9eb6e`, but PR #2355 merged as a different commit, `d79e0ee`. [observed] So ref existence is **never** treated as membership.
- The workflow definition comes from the merge group commit, which contains the base plus the PR. So the `merge_group` trigger must already be on `development` before the ruleset exists. A PR that removed the trigger would time out its own group.

### 1.4 What queue merge commits look like

- **MERGE method:** each entry's commit has two parents `[entry base P, PR head H]`. The committer is `GitHub <noreply@github.com>`. [observed]
  - rust-lang/team #2355 merged as `d79e0ee`, parents `[2beb179, 0f9dd29]`; `0f9dd29` is `refs/pull/2355/head`. Message: "Merge pull request #2355 from rust-lang/configure-all-merge-queues".
  - nixpkgs `157397e`: parents `[c46e6c9 (master tip), 7d1b761 (refs/pull/568753/head)]`.
- **SQUASH and REBASE** produce single-parent commits whose committer is GitHub (squash) or the original committer (rebase). [observed: zed, posthog, supabase, cloudflare/workers-sdk, mastodon, microsoft/terminal, flutter, servo (squash); cilium (rebase)] Sentinel requires MERGE so the two-parent proof works.
- **Author of a MERGE-method queue commit = the enqueuer, not the PR author.** In nixpkgs the commit author is `hesiod` while the PR head author is `R. Ryantm`. [observed] This is the same as a direct merge today: Sentinel's direct merges `430b203` (#1121) and `2756425` (#1007) have author `ubiquity-sentinel[bot]`, committer `GitHub`, parents `[B, H]`. [observed] **[canary]:** confirm that an App-enqueued commit's author login is `ubiquity-sentinel[bot]`.
- **The base branch fast-forwards to the group head.** "the temporary branch `main/pr-2` will be merged in to the target branch". [doc, managing-a-merge-queue] So each PR's `merge_commit_sha` is its own entry commit (rust-lang/team #2355 → `d79e0ee`). [observed] A PR in the middle of a batch has `P` = the previous entry's commit, not the tip it was reviewed on.
- **`merged_by`.** Since 2023 the changelog says "merges by the pull request merge queue are always attributed to the GitHub Merge Queue bot (`github-merge-queue[bot]`) … in the activity view and in push webhook events". [doc] https://github.blog/changelog/2023-06-21-merges-by-pull-request-merge-queue-now-attributed-to-the-github-merge-queue-bot. The REST `merged_by` on the PR is **not documented** for queue merges; the Kafka evaluation implies the enqueuer (https://cwiki.apache.org/confluence/display/KAFKA/INFRA-25932+GitHub+Merge+Queue+Evaluation). **[canary]** Sentinel accepts either value, but only together with the full queue proof (section 2.6).
- **`base.sha` on a merged PR is stale.** It is the base at the PR's last update, not the merge's first parent. Owner merges #1162 and #1163: `base.sha=b24353e5c` vs first parent `9f98f1315`, and `base.sha=3c12bc88a` vs first parent `b24353e5c`. [observed] The queue proof therefore uses the recorded reviewed base B and the commit's own parents, never `base.sha`.
- REST `GET /repos/{o}/{r}/activity` has `activity_type: merge_queue_merge` with the actor. It is optional audit evidence for "development advanced by the queue". [schema]

### 1.5 Batching, failure and ejection

- **Build concurrency** is 1-100 `merge_group` builds dispatched at once. **Merge limits** are min/max 1-100 PRs per merge plus a wait time. "Merge limits do not combine `merge_group` builds": every entry is built and tested on its own temporary branch, containing the base, all entries ahead, and itself. [doc, managing-a-merge-queue]
- **ALLGREEN vs HEADGREEN.** With ALLGREEN, "the merge commit created by merge queue for each PR in the group must pass all required checks". With HEADGREEN, "only the commit at the head of the merge group … must pass"; in the UI, unchecked "Only merge non-failing pull requests" lets failing PRs merge "as long as the last pull request in the group has passed". [schema; doc] **HEADGREEN would let an entry whose own merge commit is red land on `development`.** Sentinel refuses queue mode unless the rule says ALLGREEN.
- **Failure handling.** A PR is removed on failed required checks, conflicts with the base, a timeout, a user or API removal, or "Branch protection failure that could not automatically be resolved". The entries behind it are rebuilt without it. The PR timeline shows the reason. [doc, managing-a-merge-queue; merging-a-pull-request-with-a-merge-queue]
- **Jump:** "will cause a full rebuild of all in-progress pull requests". Sentinel never jumps. [doc]
- **A queued head branch is locked.** Pushes are refused with `GH006 … queued branches cannot be updated … dequeue`. [community] https://github.com/buster14a/buster/issues/1865, https://github.com/brandonapol/saddle/pull/446. **[canary]**
  - Consequence: an R80/R81 base refresh of a queued PR fails with `prepared candidate was not published` (`src/repair/loop-base-refresh-failure.ts:55`). After 3 consecutive failures the record is terminally blocked (`MAX_BASE_REFRESH_FAILURES = 3`, `:35`).
  - The queue marker (2.3) and the R82 guard (2.8) exist to prevent exactly this.

### 1.6 Required checks in rulesets

- REST rule `merge_queue.parameters`: `check_response_timeout_minutes`, `grouping_strategy` (ALLGREEN|HEADGREEN), `max_entries_to_build`, `max_entries_to_merge`, `merge_method` (MERGE|SQUASH|REBASE), `min_entries_to_merge`, `min_entries_to_merge_wait_minutes`. All are required. [doc] https://docs.github.com/en/rest/repos/rules
- `required_status_checks` can pin each context to an App (`integration_id`); then "if the status is set by any other person or integration, merging won't be allowed". [doc] https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging. GitHub Actions' app id on `ai.ubq.fi` is `15368` (check runs on `c930c525`). [observed]
- **`skipped` and `neutral` count as success for required checks**, and "A job depends on a failed job → the dependent job is skipped and may not block merging". [doc] https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks, https://docs.github.com/en/pull-requests/reference/status-checks. `verify-artifact` `needs` the other three jobs, so **all four** jobs must be required. Sentinel's own predicate accepts only `success`.
- Branch protection does not allow merge queue with wildcard patterns. [doc] The ruleset therefore uses the exact `refs/heads/development`.

### 1.7 Bypass actors

- Actor types: `Integration`, `OrganizationAdmin`, `RepositoryRole`, `Team`, `DeployKey`, `User`. Modes: `always`, `pull_request`, `exempt`.
- `GET /rulesets/{id}` returns `current_user_can_bypass` (`always|pull_requests_only|never|exempt`), and `bypass_actors` only to callers allowed to see them. [doc] https://docs.github.com/en/rest/repos/rules, https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset
- Sentinel requires `current_user_can_bypass == "never"` for its own token. The owner gets `always` so they can keep pushing directly.

### 1.8 What the GitHub App installation token needs

| Operation | Permission | Tag / source |
|---|---|---|
| `PUT /pulls/{n}/merge-async`, `GET …/merge-async/{uuid}`, `PUT /pulls/{n}/merge` | Contents: write | [doc] https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps (Contents table) |
| `GET /repos/{o}/{r}/rules/branches/{branch}`, `GET /rulesets`, `GET /rulesets/{id}` | Metadata: read | [doc] same page (Metadata table) |
| GraphQL `enqueuePullRequest` | Reported: Merge queues **write** + Contents write + Pull requests write | [community] https://github.com/EldritchDynasty/EldritchDynasty/pull/489 |
| GraphQL `dequeuePullRequest` | Reported: Merge queues write | [community] https://github.com/JovieInc/Jovie/pull/20177 |
| GraphQL `mergeQueue` / `mergeQueueEntry` reads, `merge_group` webhook | Merge queues read | [doc] webhooks page; the `merge_queues` permission exists in the OpenAPI installation-token schema |
| Approve parked workflow runs, list runs and check runs | Actions write; Checks read (both already used) | existing launcher behavior |

- The `ubiquity-sentinel` App mints without `permission-*` inputs, so its token inherits the whole installation grant: "contents, pull requests, issues, actions, checks, statuses" (`.github/workflows/supervisor.yml:109-120`). This session cannot read the App's live grant (`/apps/*` is out of this session's scope), so it is unverified here.
- **The owner must add "Merge queues: Read and write"** to the App and approve the updated permissions on the `ubiquity` installation. GitHub Actions' own token has `merge_queues: write`. [observed: check-suite app records]

---

## 2. Sentinel changes

### 2.1 How `ai.ubq.fi` merges today

- **The runtime never merges `ai.ubq.fi`.** `evaluateEffectiveProtections` requires an enforced strict ruleset, and `ai.ubq.fi` has none (`rules/branches/development` returns `[]` and the branch is unprotected [observed]). The self-merge path is limited to `ubiquity/sentinel` (`src/host/actions-repair-host.ts:472-474`).
- A `delivery` record cycles merge intent → `protection_required` → 5-minute backoff (`src/repair/loop-merge.ts:238-381`). When the base moves, `reconcileMergeIntent` replaces the merge intent with a base refresh (`:520-557`), serialized by the delivery line (`src/repair/delivery-queue.ts`).
- **The launcher delivery pass is the merger** (`ops/hosted-autonomy-delivery-pass.ts`):
  - it merges with `PUT /pulls/N/merge {sha: H, merge_method: merge}` (`ops/hosted-autonomy-github.ts:573-588`);
  - at most once per pass (`mergeCalled`, `:176`, `:280`, `:386`);
  - after an uncached tip re-read;
  - and books one Gateway delivery per pass (`writeDeliveryState`).
- Verification:
  - `baseAndHeadAreMerged` / `verifiedMergedDelivery` (`ops/hosted-autonomy-delivery.ts:171-205`);
  - the carried merge must have parents exactly `[T, H1]` (`delivery-pass.ts:438-484`);
  - the carried evidence is written into the merge commit message (`spent-delivery.ts:710-729`). The queue cannot carry a custom message (`commit_title`/`commit_message` are "Only supported for direct merges" [schema]).
- Closure (`closure-pass.ts:355`, `:494`), follow-ups (`follow-up-pass.ts:61`) and spent adoption (`spent-delivery.ts:408`) all require `merged_by == ubiquity-sentinel[bot]`.
- Live snapshot (`sentinel-state/repair`): 300 records. `ai.ubq.fi` has 30 in `delivery` (most already merged and in release-wait `unavailable`; #1054 and #1089 hold R80 merge intents on base `27fcf4ed9`, #1112 and #1120 have no intent), 3 in `review` and 11 in `work`. [observed]
- Of the last five completed `development` push runs, 4 were `cancelled` by `cancel-in-progress` (`c930c525`, `6c3afe42`, `9f98f131`, `2c7f1378`). [observed] Section 3 shows why that matters.

### 2.2 Mode, flag and rule detection (ships dark)

New `ops/hosted-autonomy-merge-queue.ts`, pure, about 220 lines:

```ts
export type HostedMergeQueueMode = "off" | "observe" | "on";
export const HOSTED_AUTONOMY_MERGE_QUEUE_MODE: HostedMergeQueueMode = "off"; // flipped by one launcher commit
export const QUEUE_ENQUEUES_PER_PASS = 1;      // probation; raised to 6 after the first verified group
export const QUEUE_SENTINEL_ENTRIES_MAX = 10;  // Sentinel entries in the queue at once
export const QUEUE_REQUIRED_CHECKS = ["validate", "mac-containment", "darwin-native", "verify-artifact"] as const;
```

- **Test override:** `deps.mergeQueueMode`, the same pattern as `deps.spentMovedBaseMerge`.
- **Kill switch:** the repository variable `vars.SENTINEL_MERGE_QUEUE`, bound into the maintenance step env and `--allow-env` of `supervisor.yml`. It can only **lower** the mode (`off` beats `observe` beats `on`) and can never raise it. Owner rollback therefore needs no code push.
- **Detection, once per repository per pass:** `GET /repos/ubiquity/ai.ubq.fi/rules/branches/development`, parsed with the runtime's own `parseBranchRuleWire` (`src/github/wire.ts`), then `GET /rulesets/{id}` for `current_user_can_bypass`. Verdict:
  - `absent`: no `merge_queue` rule. The legacy path runs unchanged in every mode.
  - `valid`: exactly one active `merge_queue` with `merge_method MERGE`, `grouping_strategy ALLGREEN`, `check_response_timeout_minutes ≥ 30` and `max_entries_to_build ≥ 1`. One `required_status_checks` rule whose contexts include all of `QUEUE_REQUIRED_CHECKS`, each with `integration_id 15368` or unset. No `pull_request` rule requiring approvals (`required_approving_review_count > 0` would make bot PRs unenqueueable). `current_user_can_bypass == "never"`.
  - `unsupported(reason)`: anything else, such as HEADGREEN, SQUASH or REBASE, a missing check, Sentinel able to bypass, or an unreadable rule.

| Mode \ verdict | absent | valid | unsupported / unreadable |
|---|---|---|---|
| `off` | legacy (as today) | **paused**: no merges, no enqueues; drain only | paused |
| `observe` | legacy, plus `queue:would_enqueue:*` lines | paused, plus the read-only verifier logs queue-merge facts | paused |
| `on` | legacy | **queue** | paused, with `queue_rule_unsupported:<reason>` |

"Paused" means: no PUT merge (it would only 405), but existing queue markers are still tracked, re-armed and booked, so a pause never strands a queued Sentinel PR. Queue-merge *recognition* (2.6) is mode-independent: once shipped, it always books Sentinel-enqueued merges.

### 2.3 The queue marker (durable claim; works with R80 and R81)

New shared pure module `src/repair/merge-queue-policy.ts` (about 250 lines). The launcher uses it in Phase 1 and the runtime from R82.

```ts
export const QUEUE_MARKER_MS = 17 * 60_000; // unique: carried 4m, CHECK_POLL 5m, REVIEW_POLL 15m, RED_BASE >=30m, CI-fix 0
export function queueMarker(now: number): WorkWaitV1 { return { reason: "backoff", since: now, until: now + QUEUE_MARKER_MS }; }
export function isQueueMarker(w: WorkWaitV1 | null): boolean { return w?.reason === "backoff" && w.until !== null && w.until - w.since === QUEUE_MARKER_MS; }
```

- **Why a plain wait.** It adds no field, enum value or key, so the R80/R81 parsers accept it. `rankEligibleWork` skips any record whose wait has not elapsed, so no runtime generation selects, refreshes, corrects or merges a marked record. A unit test enumerates every wait length written in `src/` and `ops/` to keep 17 minutes unique, as `CARRIED_MERGE_MARKER_MS` does today.
- **Writer.** Only the launcher's queue phase writes it, in the same CAS write that precedes the enqueue call. It re-arms the marker while the PR is queued (when `until - now < 10 min`, so about every second 5-minute pass, with `since` and `updatedAt` restarting). It clears the marker on merge, ejection, dequeue or rule removal.
- **What the marker keeps.** `nextStep`, `intent` (an R80 merge intent for the same `pr`/`expectedHead` may stay), counters, evidence, reservations and target are untouched. Only `wait` and `updatedAt` change.
- **Exemptions.** Every other launcher pass that rewrites waits or re-plans skips records for which `isQueueMarker` holds: retry, refresh-rearm, evidence-expiry, mismatch, current/historical recovery and ci-rerun.

### 2.4 Where enqueue replaces the direct merge

- New phase `queue` in `ops/hosted-autonomy-runner.ts`'s `PHASES`, between `retry` and `delivery`, with `continues: () => true`.
- New files: `ops/hosted-autonomy-queue-pass.ts` (about 450 lines) and `ops/hosted-autonomy-queue-github.ts` (about 300 lines). The second holds the surface additions: `readBranchRules`, `readRuleset`, `enqueue` (merge-async), `readAsyncMerge`, the GraphQL `readQueueEntry` / `readQueueEntries` / `dequeue`, `listMergeGroupRuns`, `readCommit` (parents, author login, committer) and `treeChangesBetween(a, b)` (a direct tree diff built from the existing `parseRecursiveTree` and `treeChanges`).
- In queue or paused mode, `runHostedDeliveryPass` skips open, unmerged `ai.ubq.fi` pulls with `delivery:<id>:queue_mode` and never calls `merge()`. Its legacy merged-pull bookkeeping branch stays.

Each queue pass does the following, for the Gateway repository only:

1. **Rule verdict** (2.2). If it is not `valid`, run only steps 2 and 4 (drain).
2. **Observe marked records.** For each record with the queue marker, read the pull and `readQueueEntry(pr)`:
   - **Merged:** run the queue proof (2.6). On success, book it: Gateway release request plus `advanceToDelivery` for a spent record, exactly the bytes the delivery pass writes today, up to `QUEUE_BOOKINGS_PER_PASS = 8`. On failure, park with `markBlocked("other", "merge queue: merged <M> unproven: <reason>")`. There is then no booking, no closure and no follow-up.
   - **Queued** (`isInMergeQueue` with `headCommit.oid == H` and `enqueuer == App`):
     - re-read the trusted task (`readTrustedTask`) and the Gateway opt-out, and check that the latest review still authorizes;
     - if authorization lapsed, call `dequeue` and clear the marker (`queue:<id>:dequeued:task_drift`);
     - otherwise re-arm the marker when it is due;
     - if any parked `merge_group` run is `action_required` for this entry, approve it (bounded, as the existing approve pass does).
   - **Neither merged nor queued:** classify the ejection (2.8) and clear the marker.
   - **Membership unreadable:** keep the marker and do nothing. A marker is never cleared on an unknown.
3. **Select new candidates**, in delivery-line order (`lineBefore`: PR number, then id), up to `QUEUE_ENQUEUES_PER_PASS` and `QUEUE_SENTINEL_ENTRIES_MAX`. A record must pass every gate the direct merge requires today:
   - `deliveryEligible`, and not settled earlier in this pass;
   - the PR is open with head H and a trusted author, and `pull.baseRef` is the declared base branch;
   - authorization: `latestAuthorizingReceipt` (or `carriedAuthorizingReceipt` for a carried record holding the runtime's carried-merge marker); only P0/P1 or uncounted findings block;
   - the trusted task statement is accepted, and for Gateway the issue is not opted out;
   - the spent gates (`spentMergeRefusal`) for parked records;
   - all checks green on H (`hasAllChecksGreen`, which requires every run to be `success`).

   Plus queue-specific gates:
   - intent is `null`, or an R80 merge intent for exactly this `pr`/`expectedHead` (never `base_refresh`, `review_request`, `push` or another kind);
   - no review reservation in flight for the PR;
   - **the reviewed base B is an ancestor of the uncached tip T, or equal to it**, using the compare shape `revisionIntegratedIntoBase`;
   - **Phase 1:** B == T (exact base, as today), except that carried records need T_carried == T;
   - **Phase 2:** B ⊑ T with path-disjoint drift (2.7);
   - **path-disjoint** from every entry already in the queue ahead (Sentinel's own records, whose B and H are known, and foreign entries from `readQueueEntries`, using `mergeBaseTreeChanges(entry.baseCommit, entry.headCommit)`) and from every record selected earlier in this pass. `ai.ubq.fi` has 1,210 tree entries, not truncated [observed], so tree reads are cheap and memoized per commit per pass;
   - the tip's required checks are not failed. Every entry would fail on a red base; a pending tip is allowed because the queue tests on top of it;
   - not externally dequeued and not CI-ejected twice for this head (counted from GitHub, 2.8).
4. **One state write**, with expected-head CAS and byte-for-byte readback (the `writeDeliveryState` discipline). It contains bookings, marker clears, parks, new markers and re-arms. On a conflict or an unverified readback, no enqueue is sent.
5. **External effects, only after a verified write.** For each newly marked record: re-read the trusted task and opt-out once more, and if accepted call `enqueue(pr, H)`. Record `queue:<id>:enqueue:pr=N:head=H:status=<pending|enqueued|failed>:uuid=…`. A `failed` or refused enqueue leaves the marker, and the next pass resolves it: not queued, not merged, no `merge_group` run, so `enqueue_refused` clears the marker and the record returns to the ordinary path.

Crash windows:
- Marker written, enqueue lost: the next pass sees not queued and not merged, and the async request is either unknown or pending. It re-sends (200 `enqueued` or 409 uuid is idempotent), or polls `merge-async/{uuid}` while it exists (24 h).
- Enqueued but the state write failed: impossible, because the write precedes the effect.

### 2.5 The review receipt still binds exactly the head that merges

- **Enqueue binds the head.** `sha` / `expectedHeadOid` = `record.target.head`, which is `receipt.pullRequest.head` for an ordinary record, or the refreshed head H1 for a carried record whose receipt is bound to H0 with the git and tree patch proof already held. GitHub "cancels" the request if the head moves before it executes [schema], and the head branch is locked while queued [community]. The post-merge proof then requires `parents[1] == H`.
- **The queue merge binds the change set, not just the head.** The receipt authorizes the patch Δ(B→H). A queue merge is accepted only if Δ(P→M) == Δ(B→H) exactly (2.6). For every path the PR touches, the merged content equals the reviewed content. For every other path, the merge took P's content, which arrived through its own review or the owner. This is the same standard the carried review uses (`carriedPatchRefusal`, `sameTreeChanges`, which include the old side, so a base move that touched a reviewed path changes the set).
- **The re-read window grows.** Today the task statement is re-read seconds before the PUT merge. With the queue, the merge happens up to the queue latency later (about 25-60 min). Mitigation: re-read on every pass while queued, and dequeue on drift, opt-out, closed issue or a newer blocking review. A failed dequeue is reported loudly (`queue:<id>:dequeue_refused`); the authorization held at enqueue time. **This is an accepted residual risk that the owner should acknowledge.**

### 2.6 Verifying a queue merge as a delivery

`ops/hosted-autonomy-delivery.ts` gains `verifiedQueueDelivery(record, pull, facts)` and a single entry point:

```ts
export function verifiedDelivery(record, pull, baseBranch, queueFacts?): HostedMergedDeliveryV1 | null {
  return verifiedMergedDelivery(record, pull, baseBranch)            // legacy shape: parents [B, H] or the stack rule
      ?? (queueFacts ? verifiedQueueDelivery(record, pull, baseBranch, queueFacts) : null);
}
```

The pure predicate lives in `src/repair/merge-queue-policy.ts` as `queueDeliveryProof`. It holds only if all of the following hold:

1. `pull.merged`, `pull.mergeCommitSha = M`, `pull.headSha == H` (the record head), the author is in `HOSTED_AUTONOMY_TRUSTED_AUTHORS`, and `pull.baseRef == development`.
2. `GET commits/M`: exactly two parents, `parents[1] == H`, `P = parents[0]`; the committer is GitHub (`noreply@github.com`); **the author login is `ubiquity-sentinel[bot]`**, which binds Sentinel's own enqueue. An owner-enqueued Sentinel PR is a hand merge, as today.
3. The recorded reviewed base B is an ancestor of P, or equal to it: `revisionIntegratedIntoBase(compare(B...P), B)`. For a carried record, the refreshed base T is used in place of B.
4. M is integrated into `development`. This is the existing `revisionOnBaseBranch` (`compare(M...development)`).
5. **Exact change set:** `sameTreeChanges(mergeBaseTreeChanges(B, H).changes, treeChangesBetween(P, M))`. A truncated tree or any failed read is no proof. For a carried record, B and H are T and H1, and `carriedPatchRefusal` must also still hold for (B0, H0) → (T, H1).
6. **Required CI on the merged revision:** a completed `merge_group` workflow run with `head_sha == M` and conclusion `success` (`GET actions/runs?head_sha=M&event=merge_group`). Its check runs (matched by `check_suite.id`) include every `QUEUE_REQUIRED_CHECKS` name with conclusion `success`. `skipped` and `neutral` are refused, even though GitHub would accept them.
7. A trusted merger. `pull.mergedBy` is `ubiquity-sentinel[bot]`, or (pending the [canary]) `github-merge-queue[bot]`; the latter is accepted only together with items 2-6.

This replaces the three old proofs:
- the `baseAndHeadAreMerged` shape for queue merges. The legacy shape stays for legacy merges, and a merge is classified by its shape: `[B, H]` is legacy, anything else needs the queue proof;
- the carried `[T, H1]` parent equality and the `carried_merged_off_tip` park, which becomes the queue-proof failure park;
- every `mergedBy === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR` test, which becomes a single `trustedMerge(pull, proof)`:
  - `closure-pass.ts:355` and `:494` use `verifiedDelivery` and `trustedMerge`. The queue pass hands evidence to closure through `context.foreignMerged`, keyed by `hostedDeliveryKey`, so closure re-checks cheap facts (1, 2, 4) and does not repeat the tree and run reads;
  - `follow-up-pass.ts:61` (`followUpMergeVerified`) uses `trustedMerge` plus `verifiedDelivery`, with the revision taken from the release request;
  - `spent-delivery.ts:408` (`adoptableSpentMerge`) adopts a queue merge only through the full proof.

Evidence does not move into the commit message. The proof goes into the action line (`queue_merged:pr=N:sha=M:parents=P,H:changes=<sha256>/<paths>:group_run=<id>:checks=…`), and the Gateway release request keeps `revision = M` and the receipt ids as today. The merge-group artifact `ai-ubq-fi-source-M` is bound to the exact `development` revision. The release path stays disabled.

### 2.7 The per-pass merge cap and the delivery line

- **Legacy mode:** unchanged. One external merge per pass; the uncached tip re-read stays; one Gateway booking per pass.
- **Queue mode:**
  - No merge calls. The tip-staleness concern behind `mergeCalled` does not apply to an enqueue, because every entry's merged tree gets its own `merge_group` CI under ALLGREEN.
  - Bounds: `QUEUE_ENQUEUES_PER_PASS` (1 during probation, then 6), `QUEUE_SENTINEL_ENTRIES_MAX = 10`, `QUEUE_BOOKINGS_PER_PASS = 8`, and one state write per pass.
  - The queue serializes the merges. `development` advances only through queue groups, which are CI-tested, and owner bypass pushes.
- **Phase 1 (launcher only):** enqueue records whose reviewed base equals the tip. All PRs reviewed on the same tip go in together, if their paths are disjoint, and merge as one batch without a refresh, a new review round or a merge per pass. Records on moved bases keep today's runtime path: the delivery line refreshes them one at a time and reviews again, or carries the review.
- **Phase 2 (R82 + launcher):** the queue makes the D3 idea safe. D3 was rejected because "the merged result … is never CI-tested" (`spent-delivery.ts:70-90`); queue CI now tests it. The runtime's moved-base step, `deliveryQueueDeferral` (`src/repair/loop-delivery-queue.ts`), gains a queue branch. When queue mode is detected (the runtime already reads `mergeQueueActive`) and the record's patch is path-disjoint from the drift B..T (git: `diff --name-only B T` ∩ `diff --name-only B H` = ∅), the runtime does **not** refresh. It defers with `delivery queue: merge queue delivers <id>`, and the launcher enqueues the record at its reviewed head (gate "B ⊑ T with disjoint drift"). Only records whose drift overlaps their reviewed paths still refresh through the line. This removes the refresh, CI and review round per base move that `delivery-queue.ts:6-15` describes ("8 of the 17 ai.ubq.fi PRs … needed four or more reviewed heads").
- **Line contenders.** Queued records keep holding the line for overlapping refreshes: their `updatedAt` restarts on every re-arm, so they stay inside `DELIVERY_QUEUE_IDLE_MS`, and they never execute, so they never become `stalled`. That is the right behavior: an overlapping record should refresh after the queued PR lands, not before.
- **Spent records on a moved base** (owner decision 2026-10-16 (2)): in Phase 2, a spent record with a clean latest review and disjoint drift is enqueued at its reviewed head with no carried refresh. The carried path stays for overlapping drift. This sits under its own sub-flag (`QUEUE_SPENT_MOVED_BASE`, default false) because it changes which route spent records take.

### 2.8 Ejection (queue CI red) and the CI-correction path

The launcher classifies a marked record that is neither merged nor queued from GraphQL `RemovedFromMergeQueueEvent{actor, reason}` plus the `merge_group` runs whose temporary branch is `gh-readonly-queue/development/pr-N-*` and whose commit has `parents[1] == H`. It finds those runs with `GET actions/runs?event=merge_group`, using the complete-listing helper, bounded pages:

| Class | Launcher (Phase 1, R80/R81) | Runtime R82 |
|---|---|---|
| `ci_failed`: a group run on M_g failed, the dequeue actor is the queue | Clear the marker. If the tip moved, the runtime refreshes as today, and the refreshed head's PR CI (`refs/pull/N/merge` against the new tip) reproduces the combined failure, which leads to the existing CI-first correction, charged as a retry. If the tip did not move (the PR's own CI was green but the group was red), re-enqueue once; on the second `ci_failed` for the same head, park with `merge queue: head H ejected twice (groups M1,M2; failed: <checks>)`. The retry pass re-pends this blocker only when the tip moves. | Feed the group failure into correction directly. Extend gen-81's "CI evidence for any CI failure in corrections" with a `merge_group` source: failed check names and job-log excerpts from the run on M_g, attributed against the group base P's checks through `attributeFailedChecks`. A red P means a red base, so defer (`RED_BASE_RECHECK_MS`). A green P means the candidate is at fault in combination, so a correction round runs on a refreshed head. No refresh is wasted just to reproduce the failure. |
| `timeout` (`check_response_timeout_minutes`) | Re-enqueue once if the tip CI is green; the second time, park as above. | Same. |
| `conflict` / branch-protection failure | Clear the marker. The runtime refresh and the gen-79 conflict-resolution route take over. | Same. |
| `dequeued_external` (an actor other than the App) | Clear the marker and park with `merge queue: dequeued by <actor>`. Owner disposition; never re-enqueued automatically. | Same. |
| `dequeued_self` (2.4 step 2) | Already handled. | Same. |
| `queue_disabled` (rule verdict `absent`) | Clear the marker with no park. The legacy path resumes. | Same. |

- **Counts come from GitHub, not from state.** The number of failed `merge_group` runs per head is derived the same way `CARRIED_REFRESH_LIMIT` is counted from git, so no new state field exists and nothing resets on a rollback.
- **Reservations stay charged.** An enqueue charges and releases nothing. CI corrections go through the existing charged, monotonic retry admission.

### 2.9 In-flight records at cutover

| Record state at flag-on | Behavior |
|---|---|
| `delivery` with an R80 merge intent (for example #1054, #1089) on base == tip | Enqueued (the intent is left as is). Once it merges, the launcher books it, or R80's own `reconcileMergeIntent` books it once the marker is cleared. Both produce the same `releaseRequestId(repo, M, pr)`, which is deduplicated by id. |
| `delivery` or `review`, clean receipt, on a moved base | Phase 1: unchanged (the runtime refreshes it through the line). Phase 2: enqueued if path-disjoint. |
| `base_refresh` intent or review in flight | Not touched until the refresh or review settles. |
| Carried (spent, H1 at `work` with the runtime's 4-minute carried-merge marker) | Enqueued at H1 when T == tip, with the queue proof replacing `[T, H1]`. The queue marker replaces the carried marker while queued. R80/R81 would otherwise park after `CARRIED_WAIT_BOUND_MS = 6h`, so re-arming protects it. |
| Already merged and waiting for bookkeeping (legacy shape) | The legacy verifier books it, unchanged. |
| Merged and in release-wait (most of the 30 `delivery` records) | Unaffected. |

### 2.10 Manual PRs and owner pushes

- **Owner direct pushes:** the ruleset gives the owner bypass `always`, so pushes keep working. The queue rebuilds groups on the new base (destroyed reason `invalidated` [doc]). If an owner push touches a path a queued Sentinel PR changes, the post-merge proof (2.6, item 5) fails and the record parks as unproven, with no booking, closure or follow-up. Owner practice: when the queue holds Sentinel entries, push changes that do not overlap them, or dequeue first.
- **Coordinator `claude/issue-*` PRs and owner PRs:** these must also go through the queue. The owner can use the UI "Merge when ready". The coordinator cannot use GraphQL from Claude Code sessions (observed 403), so it uses `PUT /pulls/{n}/merge-async` with `{"sha": <head>, "merge_action": "merge_queue", "bypass_rules": false}`. The `claude` App has `contents: write` [observed] and merge-async needs only Contents write [doc].
- Manual PRs have no Sentinel receipt. When one shares the queue, Sentinel treats it as a foreign entry for path-disjointness (2.4 step 3) and never books it. Linked issues close through GitHub's `Resolves #N` on merge, as today. A Sentinel record for that issue gets the existing hand-merge disposition (`merged_outside_trusted_path`).
- Sentinel never jumps the queue, never dequeues foreign entries, and has no code that closes PRs or deletes branches. GitHub creates and deletes the `gh-readonly-queue/*` branches; `delete_branch_on_merge` stays `false`.

### 2.11 Rollback compatibility with R80 and R81

| Situation | R80/R81 behavior | Safe? |
|---|---|---|
| Queued PR whose record holds the 17-minute marker | `isWaiting`, so the record is skipped by selection, the matrix and post-drain. No refresh push, no merge-port call. | Yes |
| Marker expired while the PR is still queued (launcher down for more than 17 min) | `reconcileMergeIntent` → base moved → refresh → push refused (GH006) → after 3 failures, terminal block. Or, if GitHub dequeues on push instead [canary], the refreshed head re-enters review. | Not a wrong merge, but a jam risk. Launcher rollback must drain the queue first (section 4, step 5 rollback). R82 adds a hard guard. |
| PR merged by the queue, R80 reconciles its own merge intent | `pull.state == merged && head == record.head`, so it books a release request with `mergeSha = M`, the same id the launcher writes. | Yes |
| Runtime merge port, rule active | `merge queue rules are active` → `protection_required` → backoff. Never calls GitHub. | Yes |
| Self repo `ubiquity/sentinel` | No ruleset ever, so self-merge is unchanged. | Yes |
| CI-first and correction reads on PR heads | Unchanged. `merge_group` runs attach to M_g, not H. | Yes |
| Tip and base attribution reads (`readChecks(base)`) | A group head can carry both `merge_group` and `push` runs. With the section 3 concurrency fix, push runs complete instead of being cancelled, so latest-per-name is never a stale `cancelled`. | Yes, with the section 3 change |
| R81 jam fixes (B5/B6/B10-B12/J3) and output bound | Must not classify a re-armed `backoff` at `delivery` or `work` as a jam. Add one contract test to R81's integration suite: "a record holding `queueMarker` is never re-planned, parked or charged". | To verify during gen-81 integration |
| Launcher rolled back to `87e28fd` while entries are queued | The old launcher re-arms nothing, so markers expire within 17 minutes. Its PUT merge gets 405 (`merge_refused`). Queue merges still land: the old delivery pass books the non-parked ones (`baseAndHeadAreMerged` can pass because `base.sha == B` for an unchanged head), but closure and follow-ups refuse whenever `merged_by` ≠ App. Bookkeeping is lost, but nothing wrong merges. | Only after draining: disable the rule first (section 4) |

### 2.12 Files, sizes and tests

- **Phase 1 (launcher):**
  - new: `ops/hosted-autonomy-merge-queue.ts`, `ops/hosted-autonomy-queue-github.ts`, `ops/hosted-autonomy-queue-pass.ts`, `src/repair/merge-queue-policy.ts`;
  - edits: `hosted-autonomy-runner.ts` (phase), `hosted-autonomy-delivery-pass.ts` (queue-mode skip, `verifiedDelivery`), `hosted-autonomy-delivery.ts`, `hosted-autonomy-closure-pass.ts`, `hosted-autonomy-follow-up-pass.ts`, `hosted-autonomy-spent-delivery.ts`, `hosted-autonomy-types.ts`, marker exemptions in the retry, refresh-rearm, evidence-expiry, mismatch, recovery and ci-rerun passes, and `.github/workflows/supervisor.yml` (kill-switch env);
  - every file stays under the 500-line target (`hosted-autonomy-github.ts` is already 590 lines, so the new surface goes in its own file);
  - about 1,500 source lines and about 1,400 test lines.
- **Phase 2 (R82):**
  - `src/repair/loop-base-refresh.ts` (queued guard before any push);
  - `src/repair/loop-delivery-queue.ts` and `delivery-queue.ts` (disjoint moved-base handoff);
  - `src/repair/loop-ci-correction.ts` and `ci-rejection.ts` (`merge_group` evidence);
  - `src/repair/loop-merge.ts` (`reconcileMergeIntent`: queued means defer);
  - GitHub port: `readMergeQueueEntry`, `readMergeGroupFailure`;
  - about 350 source lines and about 600 test lines.
- **Local tests (fake GitHub, temporary state, injected clock):**
  - the mode × verdict table;
  - marker uniqueness, and R80/R81 parse plus `isWaiting` skip;
  - the queue proof: front of queue (P == B); mid-batch (P = M_prev, disjoint); overlapping drift refused; owner push overlap leading to an unproven park; squash-shaped and single-parent commits refused; HEADGREEN or `skipped` required check refused; owner-enqueued commit (author ≠ App) treated as a hand merge; `merged_by=github-merge-queue[bot]` accepted only with the proof;
  - ejection classes and counts from runs;
  - task drift leading to a dequeue, and a refused dequeue being reported;
  - crash windows (lost enqueue, 409 pending, unreadable membership keeps the marker);
  - one named lifecycle scenario: three Gateway PRs reviewed on one tip → one pass enqueues three → the fake queue merges a group of three → the next pass books three release requests → closure closes three issues → follow-ups filed.

---

## 3. `ai.ubq.fi` changes

**Inventory.** `GET repos/ubiquity/ai.ubq.fi/contents/.github/workflows` returns **one** workflow, `deno-deploy.yml` ("Gateway CI"). Its triggers are `push: [development]`, `pull_request` and `workflow_dispatch`. Its jobs, and so its check names, are:
- `validate` (ubuntu-26.04-arm);
- `mac-containment` (macos-latest);
- `darwin-native` (macos-15);
- `verify-artifact` (`needs` all three).

Every one of these must be required.

**Change: one PR to `ai.ubq.fi`.** Workflow paths are protected for Sentinel, so the coordinator drafts the PR and the owner merges it **before** the ruleset exists:

```yaml
on:
  push:
    branches: [development]
  pull_request:
  merge_group:
    types: [checks_requested]
  workflow_dispatch:

concurrency:
  group: ai-ubq-fi-ci-${{ github.ref }}
  # Only a superseded PR run is cancelled. Push and merge-group runs always complete, so every
  # development commit has finished CI (4 of the last 5 completed push runs were cancelled) and a
  # cancelled push run never shadows a green merge_group run on the same commit (Sentinel reads
  # the newest observation per check name).
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

**What the jobs assume about the `pull_request` context.** Audited by `git grep` over `.github/`, `scripts/`, `ops/`, `tests/` and `src/`:

- **No `github.event.pull_request.*`, `github.head_ref`, `github.base_ref`, `GITHUB_HEAD_REF`, `GITHUB_BASE_REF` or `GITHUB_EVENT_PATH`.** The workflow uses only `github.sha`, `github.ref`, `github.run_id` and `github.repository`. The scripts use `GITHUB_SHA` only: an env passthrough in `scripts/test-runner.ts:23`, and the revision label in `scripts/ubq-ai-core.ts:239`.
- **`git archive "$GITHUB_SHA"` and the baked `RELEASE_GIT_SHA`.** In `pull_request` runs, `GITHUB_SHA` is the synthetic `refs/pull/N/merge` commit. In `merge_group` runs it is the group commit, a real commit that `actions/checkout` fetches from `gh-readonly-queue/…`, so `fetch-depth: 0`, `git archive` and the artifact name `ai-ubq-fi-source-${{ github.sha }}` all work. Under MERGE plus fast-forward it is **exactly the commit that lands on `development`**, which is a stronger binding than today's PR artifacts (the release path stays disabled).
- `actions/download-artifact` with `run-id: ${{ github.run_id }}` is the same run, so it is unaffected. Workflow `permissions: contents: read` and `verify-artifact`'s `actions: read` are sufficient.
- `concurrency` keyed on `github.ref`: every queue entry has a unique ref (`…/pr-N-<base>`), so merge-group runs never cancel each other. GitHub destroys stale groups itself (`destroyed: invalidated`), but those runs keep using runners until they finish. That is a cost, not a correctness issue.
- `ops/deploy.ts` and `ops/vps-release-driver.ts` require `branch --show-current == development` on the VPS, not in CI. The tests that run git use fixture repositories (`tests/vps-deploy-guards.test.ts`).
- Things that must **not** be done: adding `paths`/`branches` filters that could skip a required workflow (it stays "Pending" and times out the group); a job-level `if:` that skips a required job on `merge_group` (the check would be `skipped`, which Sentinel treats as red); renaming a job without changing the ruleset in the same window.
- **Capacity.** Each group build uses 2 macOS jobs. GitHub-hosted macOS concurrency is 5 on Free, Pro and Team plans (50 on Enterprise) [doc] https://docs.github.com/en/actions/reference/limits. Recent Gateway CI takes 21-22 minutes [observed]. Start with `max_entries_to_build: 2` and `check_response_timeout_minutes: 60`.

---

## 4. Rollout order

The coordinator is the GPT-6.1 Sol / Claude integration owner. The owner is the person who controls App settings and `ai.ubq.fi` settings. Sentinel code never creates rulesets or changes settings.

| # | Step | Who | Exact action | Verify | Rollback |
|---|---|---|---|---|---|
| 0 | App permission | Owner | GitHub → Settings → Developer settings → GitHub Apps → `ubiquity-sentinel` (App 4682172) → Permissions → Repository → **Merge queues: Read and write** → Save. Then org `ubiquity` → Installed GitHub Apps → `ubiquity-sentinel` → accept the new permissions. | The next supervisor run's minted token works with GraphQL `repository{mergeQueue(branch:"development"){id}}` (read-only probe in observe mode). | Remove the permission (harmless while the mode is off). |
| 1 | Code dark (Phase 1) | Coordinator | After gen-81's launcher changes integrate: implement 2.2-2.12 Phase 1 with mode `off`, run the local tests, push to `development` and fast-forward `sentinel-supervisor`. | No behavior change while the rule is absent; action lines identical except `queue:rule_absent` in observe. | Revert the commit (`off` with the rule absent equals legacy). |
| 2 | CI triggers on `ai.ubq.fi` | Coordinator drafts; owner (or coordinator) merges directly (no ruleset yet) | PR with the section 3 YAML diff. | The PR's own `pull_request` CI is green; after the merge, the `push` CI on `development` completes green and is not cancelled. | Revert the PR. Without a queue, `merge_group` never fires. |
| 3 | Observe | Coordinator | Set `HOSTED_AUTONOMY_MERGE_QUEUE_MODE = "observe"` (one-line launcher commit). | `queue:would_enqueue:*` lines match the records the legacy pass would merge, plus same-tip batch-mates. | Set it back to `off`. |
| 4a | Canary queue (development untouched) | Owner creates the ruleset; coordinator runs the canary | Owner: create branch `queue-canary` from `development`, plus the section 4.1 ruleset with `include: ["refs/heads/queue-canary"]`. Coordinator: two trivial PRs into `queue-canary` that touch disjoint docs paths; enqueue both with `merge-async {sha, merge_action: merge_queue}`. | Record, for the observe-mode verifier and this design: `merged_by` value; commit author = enqueuer; parents `[P, H]`; PR `merge_commit_sha` = group commit; the second PR's `P` = the first PR's commit; `merge_group` runs present for all four checks; push to a queued head refused (GH006) or dequeued; `RemovedFromMergeQueueEvent.reason` text for a forced failure (add a failing third PR). | Owner deletes the canary ruleset and branch. |
| 4b | Ruleset on `development` | Owner | Create the section 4.1 ruleset (enforcement `active`, owner bypass). From this moment Sentinel is **paused** (observe mode: no PUT merge, no enqueue). Keep 4b → 5 short (minutes). | `rules/branches/development` shows `merge_queue` + `required_status_checks` + `pull_request`. The verdict line shows `valid`. An owner direct push still works (bypass). | Owner sets the ruleset enforcement to `disabled` (or deletes it). Sentinel returns to legacy automatically (verdict `absent`). |
| 5 | Flag on | Coordinator | `HOSTED_AUTONOMY_MERGE_QUEUE_MODE = "on"` with `QUEUE_ENQUEUES_PER_PASS = 1` (probation). After the first verified booking, closure and follow-up, raise it to 6 in a second commit. | First pass: `queue:<id>:enqueue:…:status=enqueued`. About 25 min later: `queue_merged:…` proof line, release request booked, issue closure, follow-ups. | Fast path: owner sets repository variable `SENTINEL_MERGE_QUEUE=off`, so no new enqueues while draining (queued entries still merge, are verified and booked). Full rollback: wait for no Sentinel entries in the queue (or owner dequeues them in the UI), then step 4b rollback, then step 3/1 rollback. Never roll the launcher back before the queue is empty or the rule is disabled (2.11). |
| 6 | Runtime R82 (Phase 2) | Coordinator | Integrate 2.7 (disjoint moved-base handoff), the 2.8 `merge_group` correction evidence, and the push guard on top of R81. Normal install rung after R81 is healthy. Enable `QUEUE_SPENT_MOVED_BASE` separately afterwards. | No GH006 push failures in any run; moved-base disjoint records enqueue without a refresh; an ejection opens a correction carrying `merge_group` evidence. | Install rung back to R81. This is compatible: markers are plain waits, and R81 refreshes moved-base records itself, which is slower but safe. |
| 7 | Tune | Owner and coordinator | Raise `max_entries_to_build` to 3 if the macOS queue time stays under 10 min; consider `max_entries_to_merge` 5 → 10. | Queue time-to-merge (GraphQL `nextEntryEstimatedTimeToMerge`), timeout ejections. | Lower the values (ruleset edit). |

### 4.1 Ruleset the owner creates

The owner runs this; Sentinel and Claude must not:

```bash
gh api -X POST repos/ubiquity/ai.ubq.fi/rulesets --input - <<'JSON'
{
  "name": "development merge queue",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/development"], "exclude": [] } },
  "bypass_actors": [
    { "actor_type": "OrganizationAdmin", "actor_id": null, "bypass_mode": "always" }
  ],
  "rules": [
    { "type": "merge_queue", "parameters": {
        "merge_method": "MERGE",
        "grouping_strategy": "ALLGREEN",
        "max_entries_to_build": 2,
        "min_entries_to_merge": 1,
        "max_entries_to_merge": 5,
        "min_entries_to_merge_wait_minutes": 5,
        "check_response_timeout_minutes": 60 } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "validate",        "integration_id": 15368 },
          { "context": "mac-containment", "integration_id": 15368 },
          { "context": "darwin-native",   "integration_id": 15368 },
          { "context": "verify-artifact", "integration_id": 15368 } ] } },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
JSON
```

Notes on these settings:
- `OrganizationAdmin` ignores `actor_id` [doc]. If only the owner should bypass, use `{"actor_type": "User", "actor_id": <owner user id>}` instead.
- Do **not** add the `ubiquity-sentinel` App (Integration 4682172) to `bypass_actors`.
- `strict` is false because the queue provides the up-to-date guarantee.
- `pull_request` with 0 approvals blocks direct pushes by non-bypass actors without blocking bot PRs.

---

## 5. Effort, risk and generation fit

**Effort**

| Item | Estimate |
|---|---|
| Phase 1 launcher (detection, marker, queue phase, verifier, pass integration, tests, one independent audit) | 3-4 coordinator days |
| `ai.ubq.fi` workflow PR | 0.5 day (one 22-min CI run) |
| Owner steps 0, 4a, 4b | about 30-45 min total, plus one canary CI cycle |
| Phase 2 runtime R82 (guard, handoff, `merge_group` CI evidence, tests) plus install rung and live acceptance | 2-3 days after R81 is healthy |

**Overall risk: medium.** The design keeps every invariant:
- only P0/P1 (and uncounted findings) block, through the same `latestAuthorizingReceipt`;
- a red required-CI head never merges: the head is green before enqueue, and the merged revision must be green under ALLGREEN with all four checks;
- the receipt binds exactly the change set that merges;
- reservations are untouched;
- no PR closing or branch deletion;
- release stays disabled;
- queue merges are recognised by delivery, closure and follow-up.

The residual risks are mostly unverified GitHub behavior, which step 4a exists to settle before `development` is touched.

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| 1 | REST `merged_by` for queue merges is `github-merge-queue[bot]` | Likely / closure and follow-ups refuse | `trustedMerge` accepts it only with the full proof; confirmed in 4a. |
| 2 | An App-enqueued MERGE commit's author is not `ubiquity-sentinel[bot]` | Low / every queue merge is unproven | Confirmed in 4a. Fallback binding: GraphQL `AddedToMergeQueueEvent.enqueuer`/`actor == App` for the PR. |
| 3 | The App token is refused for merge-async or enqueue, or GraphQL reads lack permission | Medium / no deliveries (paused, never wrong) | Step 0 permission. Fallback from REST async to GraphQL enqueue. Observe-mode probes. |
| 4 | Branch lock vs dequeue-on-push; R80/R81 pushing after the marker expires | Low / terminal block after 3 refresh failures | Re-armed marker. Drain-first rollback. R82 guard. |
| 5 | macOS contention: CI doubles (PR plus group) and causes timeouts | Medium / ejections and latency | `max_entries_to_build: 2`, 60-min timeout, ejections counted and re-enqueued once. |
| 6 | Task-statement drift during queue latency | Low / a merge authorized against text that changed 25-60 min earlier | Re-read on every pass plus dequeue. The owner acknowledges the window. |
| 7 | Owner bypass push overlapping a queued Sentinel PR | Low / unproven merge, parked | Exact change-set proof; owner practice note (2.10). |
| 8 | Misconfigured rule (HEADGREEN, SQUASH, a missing check, Sentinel able to bypass) | Low / untested merges | The detection verdict refuses and pauses. |
| 9 | Gen-81 jam fixes reading the re-armed marker as a jam | Medium / re-plan churn | A contract test in gen-81 integration; marker exemptions in all launcher passes. |
| 10 | merge-async is new (GA 2026-10-01) and its error shapes are not battle-tested | Medium / enqueue refusals | Idempotent semantics, 24h result reads, GraphQL fallback. |

**Generation fit**
- **Not generation 81.** It is being integrated now and touches the same surfaces (delivery-line ordering, CI-first fixes, expected-check coverage, CI evidence, output bound, jam fixes). Adding the queue would widen an in-flight integration.
- **Phase 1 is a launcher change** on `sentinel-supervisor`, built on top of the gen-81 launcher and `src/` once they integrate. It is compatible with R80 and R81 runtimes because it writes only shapes they already parse.
- **Phase 2 is generation 82** (runtime R82), installed through the normal rung after R81 is healthy.

---

## Sources

- Managing a merge queue: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- Merging a PR with a merge queue: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue
- About protected branches, "Require merge queue": https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-merge-queue
- Events that trigger workflows, `merge_group`: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group
- Webhook `merge_group`: https://docs.github.com/en/webhooks/webhook-events-and-payloads#merge_group
- GraphQL mutations `enqueuePullRequest` / `dequeuePullRequest`: https://docs.github.com/en/graphql/reference/mutations#enqueuepullrequest
- GraphQL `MergeQueue` / `MergeQueueEntry`: https://docs.github.com/en/graphql/reference/objects#mergequeueentry
- Public GraphQL schema file: https://docs.github.com/public/fpt/schema.docs.graphql
- REST merge and async merge: https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request, https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously
- REST OpenAPI description: https://github.com/github/rest-api-description (`descriptions/api.github.com/api.github.com.json`)
- REST repository rules and rulesets: https://docs.github.com/en/rest/repos/rules
- Available rules for rulesets: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
- Ruleset bypass: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository
- Troubleshooting required status checks: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
- Status checks: https://docs.github.com/en/pull-requests/reference/status-checks
- Permissions required for GitHub Apps: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- Actions limits: https://docs.github.com/en/actions/reference/limits
- Changelog, async merge API GA: https://github.blog/changelog/2026-10-01-github-async-merge-api-generally-available
- Changelog, merge queue bot attribution: https://github.blog/changelog/2023-06-21-merges-by-pull-request-merge-queue-now-attributed-to-the-github-merge-queue-bot
- Community and third-party reports:
  - Renovate discussion #25065: https://github.com/renovatebot/renovate/discussions/25065
  - automerge-action #235: https://github.com/pascalgn/automerge-action/issues/235
  - buster #1865: https://github.com/buster14a/buster/issues/1865
  - saddle #446: https://github.com/brandonapol/saddle/pull/446
  - EldritchDynasty #489: https://github.com/EldritchDynasty/EldritchDynasty/pull/489
  - Jovie #20177: https://github.com/JovieInc/Jovie/pull/20177
  - Kafka merge queue evaluation: https://cwiki.apache.org/confluence/display/KAFKA/INFRA-25932+GitHub+Merge+Queue+Evaluation
  - Mergify changelog: https://docs.mergify.com/changelog/2026-08-12-merge-github-stacked-pull-requests-with-the-merge-queue/
- Observed git and API data (read-only): `gh-readonly-queue/*` commits in rust-lang/team, NixOS/nixpkgs, zed-industries/zed, PostHog/posthog, flutter/flutter, servo/servo, cilium/cilium, supabase/supabase, cloudflare/workers-sdk, mastodon/mastodon and microsoft/terminal; `ubiquity/ai.ubq.fi` PRs #1007/#1121/#1162/#1163, the check runs on `c930c525`, the `development` push runs, `rules/branches/development` (`[]`), and the repository merge settings.
