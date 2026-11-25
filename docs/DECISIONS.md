# Sentinel decisions

## Daily ai.ubq.fi failure monitoring (2026-11-24)

The owner requested a daily GitHub Actions check for problems on ai.ubq.fi. Sentinel reads production health and bounded failure metadata, reports the observed coverage, and files recurring, actionable gateway failures in the target repository under the Sentinel App identity. These issues enter the existing issue intake and review process. Public reports contain fixed failure categories and aggregate observations. Customer requests and captured payloads stay in gateway custody.

## ai.ubq.fi source, auth, ops and tooling are ordinary work (2026-11-05)

Owner directive (2026-11-05, "remove the policy"): the gateway's protected-path
list no longer covers its source, authentication code (`src/auth/`,
`src/api-keys.ts`, `src/api-key-policy.ts`, `src/codex/auth*.ts`,
`src/config.ts`, `src/runtime-config.ts`, `src/kv.ts`), operations scripts
(`ops/`, `scripts/verify.sh` and the other verification scripts, `tools/lint/`)
or tooling configuration (`deno.json`, `deno.lock`, `package.json`, `bun.lock`,
`bunfig.toml`, `tsconfig*.json`, `knip.json`, `.prettierrc*`,
`file-size-baseline.json`). A Sentinel candidate changing them merges
autonomously once it has a completed current-head native review with no
unresolved P0 and green current-head CI, like any other change. Still
protected for ai.ubq.fi: `.env`, `.data/`, `.release/`, `.kv-migration/`,
`.github/workflows/`, `AGENTS.md`, `docs/DECISIONS.md`, the replay consumer
scripts, `tests/helpers/sentinel-recorded-upstream.ts`, `src/sentinel/` and
`src/codex/supervisor-secret.ts`; those publish as owner-landing PRs (or park
unpublished for workflows) under the entry below. The 2026-10-24 basis for
approving held CI runs is unchanged: workflows stay protected, and the gateway
workflow runs with `contents: read` and no secrets. Passport and the generic
template lists are unchanged.

## Hanging target pull requests: six delivery defects corrected (2026-11-05)

Audit of the eight open Sentinel pull requests on `ubiquity/ai.ubq.fi` (#1329,
#1330, #1331, #1345, #1346, #1347, #1349, #1350; state branch
`sentinel-state/repair` at `05cd91b0`, supervisor runs 41974809569 and
41980261187) found no PR waiting on a review request or a merge step. Each was
held by a defect in Sentinel's own lifecycle, all corrected on the integrated
candidate recorded in the build ledger. Policy consequences:

- **A review bot's check run is not CI evidence.** Since 2026-10-27 every
  ai.ubq.fi head carries a CodeRabbit check run concluded `skipped`, which
  `decideCiGate` read as green. Review was requested at once, no `ci_pending`
  wait was ever written, so the dispatch-based pre-merge CI never fired, and
  PRs #1348, #1353 and #1354 merged with no CI run on their heads (post-merge
  Gateway CI then failed on `development`). A head is now green only on positive
  evidence: at least one completed check concluded `success`, `skipped` or
  `neutral` from the GitHub Actions app (the target's own or dispatched
  workflow, whose skipped/neutral jobs are a CI decision per the 2026-10-24
  directive), from no app (legacy shape), or a verified backup-CI stand-in, and
  nothing failed. Checks from any other app
  (review bots, scanners, deploy previews) never make a head green; a failed
  one still blocks. A head with only such checks waits `ci_pending`, which is
  what makes the dispatch-based pre-merge CI fire; the launcher reads it as
  neither green nor red.
- **Protected-path candidates are published for the owner to merge.** A
  candidate changing a configured protected path (ai.ubq.fi `src/auth/`,
  `ops/`) used to park before publication; the only exit, `sentinel:retry`,
  re-ran the record from base and dropped the candidate, so paid work was never
  landable. The implementer prompt now says to make a required protected fix
  in place and never to substitute tests, an unapplied `.patch`/`.diff` file,
  a copy or a no-op. Such a candidate is pushed, CI-gated and natively reviewed
  like any other, carries the additive record flag `ownerLanding: { paths,
  since }`, and is never merged by Sentinel: the runtime merge gate writes no
  merge intent and polls the PR every 15 minutes (`manual` wait, cause
  `owner_merge`), and the launcher delivery pass, `preMergeGate`, carried gate
  and train members refuse `owner_merge_required`. One progress comment per
  ready head says the PR is ready for the owner; the owner's merge completes
  the record through the 2026-10-30 human-merge rule. A candidate touching
  `.github/`, `.git/`, env files, act/npm configuration or `sentinel.protected`
  still parks unpublished, preserving the 2026-10-24 basis for approving held
  CI runs. This supersedes the prompt wording and the "no exit" finding of the
  2026-10-25 protected-path entry.
- **An unapplied patch file is refused before review.** A candidate whose only
  non-test change is a `*.patch`/`*.diff` or `patches/` file is not reviewed:
  its implementation start settles ambiguous (charged, never refunded), the
  closed detail `ATTEMPT_DETAIL_UNAPPLIED_PATCH` is recorded and shown to the
  next start, and ordinary retry accounting applies. On the four affected
  issues this shape cost four review rounds and up to eight retry charges each.
- **A repeat-failure park re-arms once per implementer prompt change.** The
  "repeated identical failure; owner action required" park now records the
  implementer prompt template digest (`prompt=<12 hex>`); a changed digest, or
  a legacy park with none, grants exactly one counted retry. An identical
  failure re-parks under the new digest. Issue-edit and route-change re-arms
  are unchanged. Installs that keep the same prompt never re-arm.
- **A lost matrix cell is settled, not waited on forever.** A charged
  conflict-resolution cell whose run completed without its authenticated
  artifact (ai.ubq.fi 1176: launcher rejection `carrier_count`, charge
  `bdcee952…` reserved since 2026-11-01) settles `ambiguous` in the producer
  pass once the run is complete and the listing is authenticated, or after the
  8-day evidence expiry in the serial work step; the record returns to its
  pending base-refresh intent and the planner may re-grant. Never refunded.
  Each loss is recorded in attempt memory under the conflict's merge base; a
  second loss on the same merge base parks the record like a spent resolution
  (no third charge until the base moves), and losses count toward the 3x
  repeat-failure park.
- **A retired record's own open pull request is closed.** When a record retires
  because its source issue closed and its own unmerged `sentinel/repair/<task>`
  PR is still open, the maintenance pass closes the PR with one comment and
  records `retiredPullClosure`; the branch is kept. Foreign, merged or already
  closed PRs are untouched. Cold records in that shape are promoted by one
  bounded cold-tier scan per installed generation (`tierScans` row). A `work`
  or `blocked` record whose own PR a person merged is re-admitted to `review`
  and completes `done` through the human-merge rule, settling any reserved
  charge ambiguous. A retired record whose issue was reopened returns to
  `work` (outcome `reopened`, PR and charges kept). Probes that settle nothing
  stamp `pullProbe` and back off six hours, least recently probed first, so no
  record can starve the pass or cost a GitHub read every cycle.
- **The planner names every deferral.** The plan diagnostic carries
  `deferredByReason` on every pass and a bounded `deferredRecords` list.

Rollback: runtimes older than this candidate cannot read records carrying
`ownerLanding`, `retiredPullClosure`, `pullProbe` or the `tierScans` row (the additive-field
trade-off already taken for `stepInputs` and wait causes). `GATEWAY_PROTECTED_PATHS`
is unchanged; narrowing it remains an owner security decision.

## Human merges complete the record; the self-merge owner park is retired (2026-10-30/31)

Owner directive (2026-10-30): a pull request merged by a human is a completed
delivery. The record completes as `done` with human-merge provenance carrying
the merged head, even when the merged head is newer than the reviewed one (no
review receipt is bound and no release request is created from the unreviewed
head) and even when the base branch moved after review (a merge into the
record's own base branch is accepted; a merge into a different branch is still
refused). A human merge never held a Sentinel queue receipt, so the
queue-delivery hold does not apply to it; Sentinel's own trusted merge keeps the
exact-tip rule and the queue guard. The owner-gated `self_merge_requires_owner`
park and the "observed merged head identity mismatch" / "merge landed off its
reviewed base" parks are retired for human merges; the launcher re-admits
records parked that way once the retained pull is verified merged into the
record's base by a readable non-Sentinel actor. Commits `3e646eb0`, `be886969`,
`644b8d3f`. This supersedes the takeover custody park wording for
`self_merge_requires_owner` in the 2026-10-23 entry.

## Passport deployment check is not a merge gate; CI polling is two minutes (2026-10-30)

Owner directive (2026-10-30): the Passport deployment check (the Cloudflare
dry-run / deploy status) is excluded from the current-head CI aggregate that
gates an autonomous merge. The named native gate (`bun run check`), generated
types and the remaining CI jobs stay required; a deployment check that is
pending, skipped or failed does not block a merge. `CHECK_POLL_MS` is two
minutes (was five). Commit lane t2/t7 of the 2026-10-30/31 throughput work.

## Review-round ceiling and CI-fix cap retired (2026-10-30/31)

Owner directive: the review-round ceiling and the CI-fix attempt cap are
retired. Review rounds and CI-fix attempts are accounting only: they are
counted, never reset and never refunded, but a spent count never parks a record
and never withholds a re-admission, a correction, a conflict resolution, a
refresh or a review. A record keeps iterating (review -> fix -> review) until
its current head has a completed native review with no unresolved P0, or a
different blocker applies; only an unresolved P0 blocks a merge. The exact
fresh-head CI, native-review, task-acceptance, custody, durable accounting,
ownership and exclusive-promotion gates are unchanged.

`reviewRoundsLeft` therefore never returns zero, and no consumer may read it as
"no round available". The two facts that were wrongly carried by a zero are
separate predicates: `currentHeadReviewTerminal` (the current head already holds
the completed accepted review delivery needs) and `reviewedHeadCarried` (the
reviewed head is delivered by a carried refresh, its historical count spent).
`reviewRoundsSpentOut` keeps its historical meaning ("this head already holds
its accepted clean review; carry it") and still selects the carried-delivery
path. The `legacy_round_requires_ci_first` denial, the `review_rounds_spent`
denials and the `review_round_ceiling_reached` parks are retired;
`REVIEW_ROUND_CEILING_*` messages remain only to recognize historical parks and
the carried-delivery timeout/stall parks that share the prefix. If spend must be
bounded, use a bounded wait the record leaves on its own, never a permanent
state. The owner corrects the already-parked records by editing the state branch
directly.

This supersedes the ceiling statements in the 2026-10-29 merge-policy
clarification below and the "Current runtime task ceilings" paragraph; the dated
2026-10-16/17, 24 and 29 mechanics remain historical evidence, not current
authority.

## Passport work trial (2026-10-30)

The owner explicitly authorized the independent stability controller's
Passport-only trial: remove ordinary product-path restrictions and attempt-count
holds while retaining successful current CI and completed native review before
merge. Positive task acceptance, exact head/base, authenticated
original-candidate and intent custody, current ownership, durable
reservations/accounting, credentials/workflow authority isolation and all other
independent merge gates remain. Counters/history are preserved, not reset;
protocol/provider backoff and finite operation/session/deadline safeguards are
unchanged. This is a separate authorized trial, not a resumption of the paused
manual PR 221/m16 work or the original goal's status.

Use one exact-target predicate and the existing trusted maintenance/CAS
readmission paths. Other repositories keep their original policy. A historical
attempt allowance cannot substitute for an authentic original candidate/ref, a
unique settled current charge, or absence of unfinished work; missing-custody
records remain held. Published stale protected candidates are not dropped or
silently replaced by their current PR head. The new controller-owned helper
remains protected against self-modification, without inheriting that controller
inventory as a renewed Passport product-path ban.
Failed/unreviewed/task-unaccepted merges, generic blocker clearing, refunds and
credential/provider changes are not authorized.

The frozen source and all live trial gates belong in the sole build ledger.
Captured local eligibility projections are not live admissions or delivery.
Publication waits for native findings disposition and exact canonical CI;
installation retains exact prior rollback and is followed by one ordinary-cycle
observation with current task/head/ref/CI evidence and explicit remaining holds.
Release remains disabled. The independent stability controller owns its isolated
m19 writer and reserved native review, while the primary retains integration and
live publication ownership.

## Local production telemetry archive (2026-10-30)

The owner requested a quick local tool reporting exact deployed commit hashes,
production timeframes, run counts, percentage of good runs and delivery velocity
to inform rollback choices, then explicitly required saving and consolidating
observations on every invocation because GitHub Actions logs expire. This
telemetry-only work does not resume the paused manual throughput goal or PR
221/m16. Preserve that work and every existing gate; no rollback or runtime
behavior change is authorized by this request.

The first delivery is an on-demand read-only GitHub collector and local offline
report. Save fetched metadata, immutable run-attempt logs and relevant
source-bound runtime/install/delivery receipts in a private ignored
`.sentinel/telemetry/` archive. Retain observation time,
endpoint/run/attempt/source identity and content hashes; never replace prior
evidence with a later missing/expired response. Consolidate idempotently, retain
prior attempts and distinguish unknown evidence from zero. No automatic
deletion, expiry, upload, telemetry service, cron or credential storage is
introduced. The user explicitly authorizes this local archival storage; raw
provider/model artifacts outside the scorecard's evidence scope are not
implicitly collected.

Separate native ordinary health from workflow success and useful delivery. Full
runtime SHA/generation and production intervals come from actual execution and
journal proof, not default-branch or launcher substitution. Report health
numerator/denominator and evidence coverage, separate
bootstrap/cancellation/pending/unstarted attempts, preserve rerun history and
repeated deployments, and show fresh autonomous merge velocity separately from
owner/manual/existing/reconciled merges. If fresh merge provenance is
unavailable, show the limitation instead of inferring autonomy from the App
actor. Current exact journal prior is evidence for a potential rollback, not
permission to roll back or proof that a short idle sample is safest. No new
producer events or merge-path instrumentation are part of the first local
archive tool.

These are current owner decisions for Sentinel. [AGENTS.md](../AGENTS.md)
governs execution, [MASTER-PLAN.md](../MASTER-PLAN.md) defines scope and
invariants, and [build-status.md](build-status.md) records current ownership and
acceptance. Superseded choices, task-specific exceptions and consumed
permissions remain in Git history; current task authorization governs
continuation.

## Merge policy clarification (2026-10-29)

Owner correction at 23:14–23:15 UTC: wanted work must not be discarded. Content
equivalence alone does not authorize closing an unmerged wanted PR as redundant;
preserve its branch and commits and use the authorized review/fix/backlog/merge
path. The owner revoked the coordinator's closure of PR 211 and issue 207 and
explicitly requested a native review loop for PR 211, attempting fixes for every
substantiated problem, tracking unresolved findings as issues, and merging when
no unresolved P0 remains and all independent gates pass. PR 211 and issue 207
were reopened with their original head preserved. This owner-requested PR loop
is tracked separately from the consumed throughput development reviews; it does
not reset or erase any prior review, runtime reservation, retry or charge.

The owner reaffirmed that P0 is the only severity-based merge blocker; P1 and
lower findings do not block merges and must be retained and backlogged as issues
through the existing authorized issue workflow. The earlier P0-and-P1 selection
was accidental and withdrawn. This preserves the 2026-10-24 P0-only runtime
policy and does not require a severity-code change.

This clarification supersedes every earlier P0/P1 merge, rejection or correction
threshold in this document and contradictory task instructions. Dated earlier
thresholds below remain historical evidence, not current authority. Current-head
CI, completed native review, positive task acceptance, custody, durable
accounting and all other existing gates remain unchanged. Lower-severity
findings alone do not authorize another correction round. Existing review
ceilings remained intact at this date; the owner retired them on 2026-10-30/31
(see the entry at the top of this document).

Resume the original production-throughput goal and canonical module identities
with serial `gpt-6.1-sol/max` implementation, preserving the separate AI Rust
owner and keeping `sentinel-release` disabled. The acceptance ledger
distinguishes reviewed source, hosted CI, publication, installation and live
delivery; this clarification establishes no new runtime or delivery receipt.

## Documentation interpretation (2026-10-29)

Current documentation interpretation (2026-10-29): native Codex review mode owns
reviewer selection, rubric and output protocol; a gateway model alias alone does
not establish invocation mode or a runtime defect. Auto-follow defaults on in
current source, and explicit off is a separate configured hold. Branch
rules/rulesets are not required to exist; effective configured checks and
approvals remain honoured. Backup CI substitutes only verified never-started
target checks and never overrides a check that ran and failed. The current
primary role owner is recorded in the build ledger, separately from actual model
identity. Dated handoffs, redesign/spec snapshots and retained artifacts
preserve their original source/times and grant no current ownership, permissions
or acceptance. Queue proof remains dormant; the owner-run canary contract grants
no production activation. Retained ceremony modules remain until their consumers
are replaced and the integration owner supplies an approved dependency order;
DESIGN.md is absent from this checkout.

## Runtime and dispatch

### Maintenance throughput contract (2026-10-28)

The reconstructible maintenance index may retain the complete positive
reservation membership of an authenticated immutable producer plan. Membership
binds the exact execution, fresh source proof fingerprint, plan digest and
planner job. A fresh scan may avoid full recovery only when every current exact
pending reservation is disjoint from that complete membership. Matching, new,
unknown, missing, partial or invalid evidence retains ordinary recovery and
late-result handling. Contradictory metadata disables acceleration safely; it
cannot authorize absence, settlement, refunds, admission or authoritative state
writes. Reuse the existing matrix-cell bound without truncation and preserve
unknown sidecars, CAS/readback and older readers' full-recovery fallback.

Retirement may use an optional narrow pull-request status capability carrying
only the observed number, open/closed state and an explicit merged boolean. The
production capability uses one strict authenticated GET; it grants no ancestry
or delivery authority. An absent capability may project the existing full
reader's observed identity, while a present capability's refusal never falls
back. The final non-Gateway closure pass filters impossible exact review
receipts after historical publication reconstruction and before task reads.
Eligible final task rereads, full delivery ancestry, review, CI, ownership,
custody, accounting, CAS/readback and Gateway carried authorization remain
required.

Existing current-matrix walk diagnostics expose numeric membership hits/skips
and source checks alongside steps and producer recovery attempts. The completed
outcome requires ordinary iterator exhaustion or the existing
all-current-requests-covered stop after applied/deferred fences; parked,
applied-result and possible-write fences retain their original early-stop
behavior. Completion describes that pass's eligible request scope, while
historical cursor coverage, result settlement and delivery remain separate
evidence. Logical source checks are distinguished from underlying network I/O.
Controlled local consumer tests establish causal request reductions; exact
hosted inputs, state identities and phase timings establish operational behavior
separately. Keep the existing event-driven schedule, original deadlines,
protected installation and exact-prior rollback; measured bookkeeping work is
not new issue delivery or billed savings. Actual acceptance belongs in the sole
build-status ledger.

### Production throughput implementation contract (2026-10-27)

CI scheduling weights use conservative same-worker file-marker intervals from
successful native Linux runs, with retained source/file-blob/toolchain
provenance. These are historical scheduling costs, not current import-graph
execution proof, CPU time or billed savings; changed or unmeasured files keep
the existing fallback. The planner, worker count, private HOME/DENO_DIR
isolation and full-suite aggregate remain unchanged. Quality retains its exact
Deno static commands and runs in parallel with the shards; its unused Node/npm
setup is removed after an actual credential-free consumer proof, while every
shard keeps its pinned tools and dependencies. Cache seeding and
incremental/no-check validation are not adopted without measured benefit and
equivalent complete isolation/receipt evidence.

Consumed conflict results require a complete restart path, not only duplicate
detection. An at-work marked resolved `base_refresh` may derive one exact
original submitted and settled retry from its current
task/repository/attempt/base and retained publication descriptor, while
preserving the existing failure limit, timing and run deadlines. Its
full-row-bound routing identity supplies the existing reservation to maintenance
membership/discovery and the ordinary authenticated artifact reader; it is not
artifact or write authority. Revalidate the original checkout/merge base,
operation/result, native source/plan/job/archive/receipt/bundle and custody,
hydrate exact M, then preserve M through the existing validator, create-only
operation ref and fresh-store proof before scratch teardown. A third fresh
runtime must fetch that durable M and pass ordinary publication, CI and
native-review gates. Duplicate maintenance creates no new state, settlement,
charge or ref effect; terminal, ambiguous, stale, dedicated or otherwise
excluded work stays excluded. The new trusted predicate is included in the
existing authority-protected source inventory.

The normal three-failure autonomous bound remains unchanged. A separately
prepared exact coordinator intervention for already-produced historical work may
use the existing dated state-write/retry grant, but must retain every failed
attempt, charge and original timing, authenticate the complete
historical/current binding, serialize effects and rehearse crash/CAS/refusal
recovery before live use. Restoring a pre-terminal intent verbatim would erase
its final failed attempt and is prohibited. This permits neither generic
terminal re-admission nor a new model start, deadline reset, counter refund or
stale-proof merge. Source, installed and live acceptance remain separate ledger
facts.

The owner requested the current source be released as v1 before implementing all
five findings from the production throughput audit. Annotated tag v1 preserves
f731b9602af55e54b7789e26134b1ce42eb3e7bd; it does not change the installed
runtime or claim exact-head CI acceptance. The implementation contract is
docs/plans/production-throughput-20261027.md and the current acceptance ledger
remains build-status.md.

Unchanged publication and CI-wait observations must not generate repeated
authoritative state writes or retain a runner through repeated selection. A
genuine persisted wait may yield its record while retaining progress accounting;
preserve the original CI deadline, exact head/base, current reads, reservations
and all failure paths. Completion notifications prompt trusted observation and
never constitute CI or review evidence themselves.

Backup CI prioritizes current, delivery-relevant exact-head demand using stable
ordering and the existing capacity bounds. Base refreshes reuse delivery
readiness so background refreshes do not invalidate proof faster than it can be
consumed. Only newly accepted result entries committed and read back through
expected-head CAS emit receipt_advanced; planning, in-flight, calibration and
unchanged stores cannot produce wake loops. Preserve native target CI priority,
real failures, calibrated backup fidelity and the target's closed/manual Actions
policy.

Ordinary backup candidates advance in durable least-recently-observed rounds
using existing commit-file updatedAt metadata. Current-head priority and
oldest-wait order break ties inside a round; confirmation and calibration retain
absolute precedence. An observation-only row records an attempted read, grants
no coverage/result, and cannot advance receipts. This preserves fairness past an
unplannable urgent prefix without increasing the twelve-read bound or
permanently caching unavailable evidence. Both PR identity checks use the
existing trusted publication-author policy, including supported legacy authors.

Historical producer discovery may use a reconstructible derived index in
sentinel-state/maintenance-index, separate from strict repair/release records.
It binds the controller and release identity, verified anchor/cursor ranges and
immutable producer proof locations. Every selected producer still passes fresh
custody, artifact and accounting checks. Missing or corrupt acceleration cannot
authorize skipped evidence; no negative artifact cache, retention change, new
credential or model-visible authority is introduced.

Cached producer reads pass the same traversal-budget check as uncached reads,
including unavailable/error paths, so parked recovery cannot consume the reserve
for ordinary in-flight work. Concurrent native drains are joined individually:
one coordinator runs each settled target's continuation immediately, while
retaining ownership of every unfinished sibling and collecting failures until
all drains settle. Final dispositions preserve configured target order.

Readiness reuses the existing exact releaseRequestMatchesDelivery predicate to
exclude already-booked deliveries, including release-disabled targets; unmatched
requests cannot free a live contender. Matrix consumption hydrates every
available bundle in one authenticated scan before advancing target lifecycles,
then advances ready work before the next protocol observation wait. This
preserves hydration-before-preservation without restoring the old all-producer
or twenty-minute barrier.

The live C3 backup completion event did not propagate for
native-token-dispatched legs. The trusted backup parent now uses the existing
official self App installation's scoped actions:write token solely for the fixed
backup-leg dispatch POST. Native read/ref/store/receipt-wake operations remain
separate, the untrusted leg VM retains read-only permissions, and its
execution/result bytes and runner revision remain unchanged. Native observations
accept the exact official App bot identity and the historical GitHub Actions
actor only with all existing plan/unit/repository/ref/SHA/attempt/job bindings.
Missing dispatch authority refuses before new ref/admission effects; there is no
native-token dispatch fallback. No App registration, permission grant, secret,
calibration reset or result schema is changed.

The review-owner channel observes its reply promise immediately, before awaiting
atomic request publication. An owner may reply after rename but before
publication resolves; synchronous observation prevents a transient unhandled
rejection while preserving publication-error precedence and rethrowing the
original custody refusal to the caller. No custody predicate, timeout or
caller-visible outcome is weakened.

Development delivery retains its scoped local and hosted gates after the three
completed native review rounds; no fourth review is requested and no native
verdict is claimed for the final transport correction. The owner-directed
direct-development policy is distinct from autonomous target repair review,
which still requires exact current-head native evidence under the current
P0-only severity policy, with positive task acceptance, current CI and all other
gates retained. This records the scope of existing policy rather than waiving a
runtime merge gate.

Independent target producers and native reviewers may overlap while one
coordinator serializes authoritative lifecycle advances and every owned session
is settled. Authenticated controller completion events request protected
ingestion and reconciliation; active-run requests coalesce into the existing
handoff. Foreign target events have no implicit controller ingress, so the
existing bounded recovery remains until an actual authenticated event path
exists. Keep original deadlines, exact integrated CI/native review/merge gates
and exclusive promotion ownership; sentinel-release stays disabled.

The shared drain replaces earlier-target serial drains. Matrix observation
therefore removes only the obsolete two-drain reservation for three targets; it
retains the full twenty-minute review bound, existing five-minute operation
margins, per-target preparation lead and original absolute deadline. A
three-target fifty-five-minute local consumer case proves a ten-minute
observation window without renewing tokens, resetting invocation origin or
lowering configured safeguards.

Ordinary CI runs automatically for PRs and canonical master/development pushes.
Explicit workflow dispatch supports branch checks; automatic codex/** pushes are
redundant and removed. Event-qualified concurrency prevents a branch run from
cancelling the PR-only native receipt producer, while preserving development-run
protection. These decisions are an implementation contract; actual local,
hosted, installed and live acceptance belongs only in the ledger.

### Gateway pre-merge CI dispatch and authority inventory (2026-10-23)

`ubiquity/ai.ubq.fi` runs `Gateway CI` (`.github/workflows/deno-deploy.yml`)
only on a closed pull request or a manual `workflow_dispatch` (its 2026-10-21
Actions-quota decision), and the workflow exposes `base_ref`,
`sentinel_pr_author` and `scope_base` inputs meant to select the complete check
set for a Sentinel App pull request (correction 2026-10-23 23:00 UTC: at
`31ba5a15` the workflow maps those inputs onto `GITHUB_BASE_REF` and
`GITHUB_PR_AUTHOR` only, while `scripts/test-scope.ts` grants the complete set
for `merge_group`, `push` to `development` and `pull_request` events alone; a
dispatched run therefore executes the scoped set and reports the other jobs as
`skipped`, which Sentinel's required-CI gate reads as failed. Extending that
rule to an opted-in `workflow_dispatch` is an `ubiquity/ai.ubq.fi` change for
the owner, recorded in Sentinel issue #181; Sentinel does not relax `skipped` to
green). Sentinel refuses to review or merge without current-head CI, so the
trusted repair host now sends at most one `workflow_dispatch` per target per
pass for a published head whose record waits on `ci_pending`
(`src/host/actions-premerge-ci.ts`): the live pull request must be open,
authored by the App login, on the target's own repository, at the recorded head
SHA, head ref and configured base; any existing run of the workflow on that
exact head (any event or status) skips it; the dispatching token's mint grant
must name the repository with `actions: write`; every request passes the shared
cooldown gate and the absolute run deadline. A dispatch is a request for
evidence, never evidence: it writes no record, wait, counter or receipt, and the
delivery gate keeps reading the check runs of the exact head.
`workflow_dispatch` takes a ref, so a head that moves before GitHub resolves it
yields a run on another SHA, which the exact-head gate ignores and the next pass
re-dispatches. Only the gateway carries this policy; Passport's CI runs on its
pull requests itself.

The same change protects the token-bearing scheduled entrypoint
(`src/host/supervisor-dispatch.ts`, run every five minutes from the default
branch with `actions: write` and `contents: write`), the new dispatcher, the
merge-gate evaluation modules, the queue policy/reconcile/intent/writer modules
and their trusted read facts, the protected-tree proof, the base integration
executor, the authority identity keys, the per-run credential and binding
modules and the vendored rubric as host-owned authority. The self repository no
longer falls back to the `ubiquity` installation token when its own token is
absent (the native token is the fallback), a reviewer reroute notification of
any kind makes a native review unavailable (Codex owns reviewer selection; a
gateway failover onto an implementation route is the forbidden substitution),
and review custody refuses `baseInstructions`/`developerInstructions` on
`thread/start`.

Launcher handoff correction (2026-10-23 23:00 UTC): the 2026-10-21 migration
bound the child's grant parse to the live `SENTINEL_TARGET_INSTALLATION_ID` but
left the launcher's parent-side verification
(`src/host/hosted-runtime-principal-handoff.ts`) on the durable default, so
every live grant (installation `173913802`) failed that parse and the grant
never crossed into the runtime child: the hosted App principal context was never
composed after the migration and the dispatcher would answer `grant_refused`.
The launcher now binds the handoff to the same live installation the child reads
(absent keeps the durable default; a malformed value refuses the grant), and
`composeHostedAppGitHub` compares a foreign target's durable scope with
`SENTINEL_APP_INSTALLATION_ID`, as the native membership proof already does,
instead of with the grant's live installation.

Gateway delivery under activated queue proof (finding 2026-10-23 23:10 UTC,
owner decision open, Sentinel issue #180):
`src/host/hosted-custody-capability.json` ships `queue.proofActivated: true`
since the 2026-10-18 standing approval for the queue canary and production
cutover, but the canary was never accepted, the queue authority pins are empty,
`QUEUE_MODE_CEILING` is `off` and `ai.ubq.fi` `development` carries no
`merge_queue` rule. Under activated proof every gateway record is strict: the
launcher's delivery pass routes it into the queue booking draft and never
reaches `preMergeGate` or the merge; a direct merge by any actor cannot be
booked (`direct_provenance_missing`) and the runtime turns it into a permanent
custody hold; a strict observation failure parks a record permanently. No
autonomous ai.ubq.fi merge can complete until the owner either deactivates the
proof until the canary lands or finishes the queue rollout. Sentinel does not
change that custody boundary on its own.

Self-path corrections (2026-10-23 23:55 UTC, review round 1): `ci.yml`'s
`test-local` has been a `needs: [quality, test-shards]` aggregate since
`b19882bb8c` (2026-10-20), so GitHub creates its check run only once those jobs
finish; the self CI-first gate used to read no expectation for the self scope
and could admit a review in that gap. It still reads no base (the tip's
supervisor and dispatcher listings are large) but now expects `test-local` on a
head whose own `ci.yml` jobs (`quality`, `test-shards (…)`) already report,
waiting like running CI until the aggregate exists; a head without those jobs
keeps the old rule. The self merge port's pre-write refusals (CI pipeline
identity, preserved CI binding, tested tree or trusted source mismatch) used to
re-arm a five-minute `unavailable` wait on every cycle for the life of the base;
they now park the record for the owner with the port's own detail and clear the
merge intent, since only a new base or candidate can clear them. Transport
failures keep the bounded wait and the durable intent. The earlier "one named
`test-local` job (ci.yml, no `needs:`)" wording in this document is superseded
by the aggregate description above.

Passport cannot merge under the existing gate: its private repository on the
current GitHub plan cannot carry branch rules (`/rules/branches/main` answers
403 "Upgrade to GitHub Pro or make this repository public"), so every reviewed,
CI-green Passport candidate blocks at `protection_required` and parks in
`backoff`. The owner decides between a plan/visibility change with rulesets on
`main` and a trusted-policy gate for plan-limited private repositories; no
merge-authority change was made for it here.

### Three-target scope including private Passport (2026-10-23)

The owner directed this public controller to target all three repositories:
`ubiquity-sentinel/sentinel`, `ubiquity/ai.ubq.fi`, and the private
`ubiquity/passport.ubq.fi`. The committed `sentinel.targets.json` is
authoritative. The existing split self/target App installations provide access.
Passport remains a private repository, but this selection makes its target
source, runtime state, review evidence and logs subject to this public
controller's visibility. The separate `ubiquity-sentinel/sentinel-passport`
controller is not the active three-target controller. Target selection is not a
delivery claim; current CI, native review and merge gates still apply.

### Dedicated organization migration (2026-10-21)

The owner moved Sentinel into the dedicated `ubiquity-sentinel` organization to
isolate its GitHub Actions allowance. The public controller moved from
`ubiquity/sentinel` to `ubiquity-sentinel/sentinel`, and the private Passport
controller moved from `ubiquity/sentinel-passport` to
`ubiquity-sentinel/sentinel-passport`. Repository ids, issues, pull requests,
refs, secrets, variables, visibility and environment branch policies were
preserved. Current self identity is the new organization. The permanently
retired `ubiquity/sentinel` identity is accepted only while reading
pre-migration state and is normalized to the current identity in memory; no
protected state ref is rewritten by this migration. Derived repair ids and
candidate refs retain the retired identity as their stable internal namespace,
so existing work remains addressable after the external rename.

The owner made the `ubiquity-sentinel` GitHub App public so one App can be
installed on both organizations. The new-org self installation is `173834540`;
the original-owner installation is `173913802` and is enabled for all `ubiquity`
repositories, though every dispatched token is still narrowed to the committed
target repositories. Self writes use the self installation; foreign targets use
the `ubiquity` installation. No installation token is shared across owners. The
old installation id `155687488` remains the durable logical foreign-target scope
for existing state and refs, while the workflows pass the live credential
installation ids separately as `SENTINEL_TARGET_INSTALLATION_ID` and
`SENTINEL_SELF_INSTALLATION_ID`. Do not rewrite historical state to the new
installation ids. The release-state ruleset's App bypass is restored with the
self installation. `ubiquity/ai.ubq.fi` remains a target under its original
owner. The five-minute dispatcher and the disabled `sentinel-release` workflow
retain their existing states.

### Post-transfer scheduler recovery (2026-10-22)

The 2026-10-21 organization transfer did not preserve GitHub's cron registration
for `supervisor-dispatch.yml`. Changing the cron line and re-enabling the
workflow did not restore scheduled runs. A minimal `sentinel-scheduler.yml` now
invokes the existing dispatcher every five minutes; the dispatcher remains the
sole owner of stale-run recovery and the protected-ref dispatch.
`SENTINEL_AUTO_FOLLOW` is temporarily off because the native dispatcher token
cannot fast-forward a ref to a commit that changes a workflow file. Runtime
advances are manual until the follow path has a workflow-capable trusted token.
This does not change model, review, merge, release or promotion authority.

### Self-installed runtime handoff and CI-first recognition (2026-10-22)

GitHub stops a `workflow_run` chain after three levels. The completed supervisor
run `39834202668` produced no dispatcher run even though the dispatcher trigger
existed on the default branch. The supervisor finalize job now sends one
`workflow_dispatch` handoff to `supervisor-dispatch.yml` with its own run ID;
the dispatcher waits for that parent run to complete, then runs the existing
active-run, stale-recovery and fixed-protected-ref guards. This is not another
`workflow_run` level, and it preserves the scheduler as a fallback. A dispatcher
handoff is chained even when finalization or an earlier job fails, so recovery
remains live.

The installed runtime `c019bcd5833eff5551201d1b46039a0996841b8b` is a
self-installed generation-89 runtime with a settled healthy proof but no
historical rollout row. The launcher now recognizes an exact healthy
self-installed runtime at generation 82 or later as CI-first, while retaining
the exact allowlists for generation 80/81 and excluding the known pre-CI-first
R76-R79 revisions. This restores moved-base pre-review re-admission for the
existing AI parks. It changes no review-round, charge, CI, review, merge,
promotion or model policy, and it does not rewrite state or accounting.

### Private Passport controller isolation (2026-10-21)

The owner's request to add `ubiquity/passport.ubq.fi`, followed by the explicit
completion goal, authorizes completing its private execution path. The dedicated
private `ubiquity-sentinel/sentinel-passport` controller owns only Passport; the
public controller retains Sentinel and AI. Private target code, artifacts,
runtime state, review evidence and logs must remain private. Seed source
ancestry only, never public runtime state or accounting. Provision the existing
App/model credentials exclusively in the private controller's
`sentinel-supervisor` environment restricted to that branch; no credential
replacement, audience expansion, branch ruleset or product-release activation is
authorized. The private dispatcher and product release remain disabled during
preparation; native private CI, controller-bound bootstrap, target authorization
and real reviewed delivery precede activation claims.

### Native review mode owns reviewer selection (2026-10-21)

The owner explicitly clarified: "CODEX REVIEW IS NOT A NORNAL CODEX SESSION THAT
YOU SELECT THE MODEL". This corrects the continuation's proposed switch to
`gpt-6.1-sol/max`. That proposal is withdrawn; reviewer selection is not a
pending owner choice for fixing the current failure.

Sentinel must enter native Codex review mode through `codex review`,
`codex exec review`, or the supported app-server `review/start` request. Codex
resolves the reviewer. Do not override reviewer model or effort, inherit an
implementation model as a substitute, or use a normal `turn/start` with review
instructions. A gateway alias named `codex-auto-review`, the review rubric, and
a structured output schema do not establish native review mode. Existing text
naming that alias is not authority to replace the mode with a generic model
invocation.

The app-server integration must support and correlate the native
`enteredReviewMode` and `exitedReviewMode` events, actual review-thread/turn
identity, target and structured result. Keep trusted read-only execution, exact
head/base/task binding, current CI, durable reservations/settlement and normal
merge gates. An unavailable review remains unavailable. This correction changes
neither the hard review-round ceiling nor past charges and does not authorize an
additional paid attempt. Diagnose and repair the invocation before considering
any further run.

At source `e0c4cd07c643c9828d811e61c48e5b9c136e6182`, the runtime reviewer uses
`turn/start` with explicit model/effort/output schema; its custody RPC allowlist
omits `review/start`, and its reviewer event filter rejects native review-mode
items. Those are concrete implementation mismatches. Documentation clarification
does not itself fix or validate the runtime path. Official protocol reference:
https://learn.chatgpt.com/docs/app-server#review.

### Owner grant, scope and acceptance (2026-10-20 UTC)

The dated grant remains in force for this effort. Its two-target acceptance
scope was expanded by the 2026-10-23 three-target directive; current severity
policy is the 2026-10-29 clarification, while all independent gates and
historical receipts remain.

For this Sentinel autonomy effort, the owner grants the orchestrator blanket
authority to dispatch, rerun, cancel, enable and disable hosted Sentinel
workflows; push directly to `development`; update launcher pins and runtime
pointers; write state branches; and merge autonomous PRs after their gates pass.
This dated grant supersedes the per-attempt hosted-run approval boundary for
this effort, including corrected candidates and retries. Keep that default
boundary for future efforts without equivalent authorization. The existing
0x4007 PAT may set secrets as a stopgap; no credential reaches a model worker.

Simplify aggressively while preserving five invariants: (1) credentials,
authoritative state writes and promotion authority never reach model workers;
(2) record exact revision SHAs and never select by time or list order; (3)
durable admission/reservation precedes every model start and settlement follows
it; (4) autonomous merge requires current CI and a completed internal structured
review from native Codex review mode, with no unresolved P0 and receipt-bound
issue follow-ups for P1 and lower; (5) the deterministic Deno controller
exclusively owns promotion and `sentinel-release` stays disabled.

Runtime implementation uses `gpt-reserve` with the existing HTTP 429 fallback to
`gpt-6-luna`, both at max reasoning; this supersedes the former `gpt-5.6-luna`
runtime text and reaffirms the 2026-10-18 policy. Development/orchestration
workers use `gpt-6.1-sol`; worker selection does not change runtime routing. For
development review, the owner prefers GitHub `@codex review` first, with local
`codex review` / `codex-u review` as fallback. That preference is separate from
the mandatory internal runtime PR reviewer; it does not require a development PR
for every edit.

Acceptance for this effort is green scheduled supervisor cycles plus at least
one autonomous issue → PR → completed review → merge in each of
`ubiquity-sentinel/sentinel` and `ubiquity/ai.ubq.fi`. The ai.ubq.fi scope is
issue repairs only for now. Gateway capture, VPS deployment, release activation
and the original broader gateway observation gates remain separate work.
Bootstrap health and opened PRs alone do not satisfy this acceptance.

### Incident and operational unblock (2026-10-20 UTC)

From 2026-10-18 15:51 to 2026-10-20 08:41 UTC, all 151 supervisor runs failed
with `issue source unavailable`. L81 was
`00b6649eeff51a9754bf3748f793137db9bf8605`; runtime generation 81 was
`da98f5f49c45b57cfa97a45fe647c36b1021f302`. Its 16,384-character issue-body
ceiling rejected ai.ubq.fi issue #1213's 23,807-character body and thereby
rejected the whole issue listing. Pending self-release
`f4374801275ca250d0df1d1b4c798e792b0608bf68f81711fa0139adeeaff6f5`, candidate
`1838df313105bab219d71602695a7f758a65125e` (merged Sentinel PR #172), retried
failed PRIOR verification indefinitely, blocking ordinary work and installation.

At 08:41 UTC, the owner-approved unblock moved #1213's body verbatim to a
comment and re-enabled dispatch. Run `39396626543` proved PRIOR healthy; run
`39397013439` proved candidate `1838df313105bab219d71602695a7f758a65125e`
healthy and installed it at generation 82. Ordinary run `39399339935` planned
nine matrix cells; autonomous ai.ubq.fi PRs #1254 and #1255 opened. These
receipts establish recovery and resumed issue work, not completed two-target
acceptance. The earlier W6 proposal to install
`ff8763f901b6d0bb8b47b0e71a76222e124c2206` was not the transition executed.

Investigation and implementation evidence is in the orchestrator scratchpad:
`PLAN.md`, `w3/report.md`, `w6/report.md`, `w8/DESIGN.md`, `w10/W10-REPORT.md`,
`w11/report.md`, `w12/report.md` and `w7/report.md`. Current identities and
remaining acceptance belong in the ledger; worker-local original commit SHAs
differ from the integrated cherry-picks recorded there.

### Bounded hosted verification and launcher installation (2026-10-20)

Hosted PRIOR and candidate verification each admit at most N=2 exact executions.
Unsuccessful settlement consumes the release budget, including `not_started`.
Exhausted PRIOR is abandoned; a failed candidate preserves its proof and
restores the recorded prior before terminal abandonment. Abandonment preserves
accounting and never claims task delivery. Ordinary work interleaves with
verification and may use durable degraded admission after two settled failed
verifications of its installed generation; degraded admission never fabricates
healthy evidence.

The terminal `abandoned` phase records a reason: `prior_verification_exhausted`,
`candidate_verification_exhausted`, `candidate_verification_failed` or
`included_in_successor`. Preserve the request, exact proof identities and
charges; unknown settlement or an unresolved pointer effect remains pending. A
pending self-release no longer globally blocks ordinary work. A fresh
installation cannot use degraded admission to bypass bootstrap.

For ordinary hosted updates, CI-verified fast-forward launcher self-install
replaces the owner-install ceremony: rollout rows, owner supersessions, custody
revision floors and LF materialization. The launcher and installed runtime
become the same exact CI-green development SHA at generation+1. An idle pointer
and exact successful `test-local` check are required; intent, generation
movement, model-disabled bootstrap and included-release abandonment use
expected-head CAS. Failed bootstrap restores only the recorded previous revision
at the next generation, with restoration verification; generations never
decrease. Failed SHAs remain journaled and cannot reinstall. Actual task
custody, reservations, current-head internal structured review and CI before
autonomous PR merge remain required. `sentinel-release` stays disabled.

The dispatcher's auto-follow controller walks the captured development
first-parent ancestry and fast-forwards `sentinel-supervisor` to the newest
eligible CI-green ancestor by exact SHA, never by timestamp or API list order.
It verifies complete CI run/attempt/job evidence, expected-old ref, non-force
update and readback before exact-ref dispatch. `SENTINEL_AUTO_FOLLOW` defaults
off; keep it off until the first controlled advance and self-install are
verified, then enable it and verify automatic advancement. W11 uses the
dispatcher's exact checked-out workflow SHA; DESIGN.md's separate immutable U
control anchor is not implemented and must not be claimed as installed.

The integrated source is pending native CI and hosted installation. New journals
and `abandoned` records require compatible rollback readers before new writes;
old R81 exact-key parsers cannot read them. Preserve historical state
readability and prove the actual prior runtime's compatibility before claiming
exact rollback safety. Owner-install modules remain in the tree, unreferenced
from prepare, pending deletion in DESIGN.md §4 order: owner-install;
owner-successor acceptance; rollout/authority/floor machinery; then historical
recovery only after its accounting obligations are settled or supported by the
generic consumer.

Diagnostics isolate malformed/over-bound issue entries while retaining
structured, sanitized error context. The advisory `hosted_runtime_summary` is
the per-run summary line; existing authenticated terminal proof remains
separate. W12 currently emits once per child invocation, so workflow-wide
finalizer aggregation remains unwired. Unknown counts stay null and summaries
grant no health, accounting or merge authority. CI now has five test jobs behind
the always-running `test-local` aggregate, with 30-minute test-job timeouts; all
shard and quality prerequisites must succeed. Two production defects are fixed
in source: protected-entry validation exhausted its deadline by rereading shared
ancestors, and settled Git commands retained deadline timers that kept workers
alive. Worker checks do not establish a complete green Linux CI run.

### Recovery of the generation-83 continuation (2026-10-20)

The resumed continuation found the generation-83 bootstrap had emitted one exact
healthy native terminal, but its authenticated log line arrived 1,227 ms after
the terminal's own finish. Log emission is not clock skew: accept delayed
emission only inside the authenticated step, job and observation windows,
retaining the existing 999 ms timestamp-precision tolerance, exact
execution/controller identity and unique-terminal requirement. A later prepare
must settle that saved bootstrap through the normal trusted consumer before
installing a successor; never clear its execution or fabricate a healthy proof
manually.

Launcher self-install must work without the retired runtime and source-profile
allowlists. Maintenance retains native writer and state custody checks. The
default App-source path binds the installed execution to the exact trusted
launcher revision, clean checkouts and matching source manifests; native mint
metadata, repository scope and per-effect authority checks remain mandatory.
Every extracted installation, verification, admission, rollback and recovery
authority module belongs in the protected-path policy, including the trusted
local dispatcher action.

Legacy execution compatibility uses the existing restricted state projection for
an exact healthy ordinary fallback as well as a journaled rollback. Healthy
ordinary admission must identify the current execution, revision and generation;
historical degraded admission cannot veto a different model-disabled rollback
bootstrap. The authoritative state and accounting are preserved. A requested
installation retains its original immutable CI receipt while revalidating
complete current successful CI for the same exact candidate SHA; a new check-run
ID alone cannot permanently strand it.

An authenticated historical retry carrying an existing published candidate may
be consumed only through its exact producer, artifact, plan, planner, result,
intent and reserved charge. Use normal bundle validation and accounting
settlement; a protected correction stays refused. A separate trusted maintenance
pre-pass may recover the original published candidate only from the adjacent
authoritative historical transition and verified immutable preservation, managed
branch, owned open PR, issue and current publication policy. Preserve every
charge, counter, review and rejected-candidate provenance. Require green
current-head CI when the base is unchanged; when the base strictly advanced,
restore only bookkeeping and let normal base refresh precede the new head's CI
and internal review. This grants no forbidden-candidate retry, model start,
push, refund or merge authority to recovery itself.

GitHub PR base snapshots can lag the live branch: recovery checks the exact base
branch name and independently reads and revalidates the live tip and ancestry.
It must not require the recorded PR base SHA to equal that tip before allowing
normal base refresh. Historical result recovery may also resume after its exact
retry charge is already submitted, but only through the same authenticated
result and ordinary idempotent settlement; it preserves the existing charge and
timestamp.

Individual `readRepairAt` calls may reuse one private, bounded fetched
repository per state-store instance. Every such call still requires fresh entry
and exit checks of the exact expected remote head, ancestry proof, and complete
current and historical state validation. Validated decoding may be reused only
after exact fresh byte equality; returned state must remain independently
cloned. Expiry, corruption, ref movement and failed initialization invalidate
retained state, and cleanup is limited to the owned cache directory.

Independent read-only state proofs may run concurrently when all operations
settle before return and the original error precedence is preserved. This
optimization changes neither the public state port nor the recovery walk's
120-second and 256-ancestor limits. Local throughput evidence does not establish
live maintenance or autonomous delivery acceptance.

The ordinary latest-repair cache experiment (`1faffea` and `786685f4`) remains
preserved in Git history but is not accepted for shipping. Candidate `d60aa9c8`
introduced one candidate-publication state-read failure and four
matrix-uncertainty custody failures in native CI; the same unchanged cases
passed on `2081f978`, and the exact local publication reproduction passed
without exposing an underlying error. Return ordinary state reading to the
byte-exact known-green `2081f978` implementation instead of adding an unproved
patch or relaxing guards. This does not revert the accepted repair-history cache
or anchored history view. Retain the necessary task-acceptance prefilters and
the documented bounded-upkeep deadline fix. Reintroducing ordinary reuse would
require separate demonstrated lifecycle/custody compatibility and native
acceptance; the failed profiles are not delivery proof.

Bulk original-candidate recovery may use a separately named optional anchored
repair-history view. Its anchor is the authoritative read result's head, never
the payload's parent `snapshot.stateHead`. The view validates one complete fetch
and strict immutable ancestor records locally; all reads settle and the view
closes on every exit. Before returning any proof, a fresh complete repair read
must match both the original observed head and full snapshot within the
unchanged 120-second/256-ancestor budget. Existing `readRepairAt` semantics
remain intact. Only an absent view capability uses the old method; a supported
view's failure is not bypassed. Final restoration still requires fresh
ownership/ref checks and expected-head CAS/readback.

Delivery may reject proven no-op work before expensive reads. CI approval
excludes only exact terminal retired-source records and exact rejected,
unpublished protected-path candidates; a blocked state or head mismatch alone is
insufficient. Strict Gateway booking may return null early for an exactly
matching release request or a missing/dirty latest completed App review, using
the same immutable input snapshot as the eventual authority predicate. A cheap
positive check never authorizes delivery. All later
current-head/full-snapshot/row checks, review/task/CI proofs and CAS guards
remain required, and a refreshed pass considers newly valid reviews normally.

The existing maintenance admission cutoff applies to no-write passes as well as
continuation after a write. Delivery and CI-rerun loops must check the same
absolute cutoff before admitting another record, read batch or effect. An
admitted operation and its mandatory verification/readback finish before
deferral; no whole-phase promise race or abandoned effects are permitted. A
no-write deadline exit is the existing no-change/deferred outcome so protected
prepare and repair can continue; prior applied state writes retain their
aggregate result. Unvisited records and charges remain untouched and eligible
next pass. The existing pass deadline and phase reserve are unchanged; checks
are cooperative and do not claim cancellation of unbounded Git operations.

Queue booking may also refuse an issue-backed receipt before expensive reads
when its task acceptance is absent, names another issue, or is not fulfilled.
These are necessary failures of the existing later authorization predicate.
Carried head/base identity and live task-digest verification remain unchanged; a
positive early check never authorizes a merge.

Maintenance progress diagnostics use a closed set of fixed phase names,
start/finish events and observational monotonic elapsed time, bounded to 50
records per invocation. They expose no state, identifiers, errors, URLs or
credentials and never read a business clock. A finish event means the boundary
exited, including an error, and cannot establish health, settlement or delivery.

### Explicit prepromotion owner supersession (historical; superseded 2026-10-20)

The following ceremony records historical contracts and receipt semantics. The
2026-10-20 launcher self-install decision supersedes its requirements for
ordinary hosted updates; retain old state readers and actual
task-acceptance/accounting evidence until their consumers are safely replaced.

`SEMANTICS-10.md` preserves a genuinely completed and charged successor review
when the trusted acceptance append is deferred. Prepare holds read-only while
that exact review's native settlement proof is needed; it cannot start an
ordinary run that overwrites the proof. Finalization may retry the authenticated
append, and normal preparation resumes after independent readback of acceptance.
Initial bootstrap/review and authenticated capable correction/recovery remain on
their existing paths; no forged review, health proof or delivery is admitted.

`SEMANTICS-8.md` requires truthful owner_successor registration, durable
running-readback, arm and settlement through the existing native review-owner
channel and custody broker. Normal PR and base-task semantics stay unchanged; a
merged delivery-pending task cannot use a false PR or already_satisfied_at_base
envelope. Production-composition proof must include the actual local GitHub
factory, channel, broker, reviewer and durable acceptance consumers, faking only
external session/API ports. No unregistered reviewer path or alternate
credential/model route is accepted.

A distinct committed, source-authenticated owner-supersession intent is required
for the still-wanted requested release f437. Issue closure, age, failure,
ancestry or an install marker supplies no cancellation authority. The frozen
owner-supersession contract and `SEMANTICS-3.md`, `SEMANTICS-6.md` and
`SEMANTICS-7.md` require a distinct private authority ahead of both generic
nonterminal recovery refusals; generic future recovery retains its phase
restrictions and authentication predicates.

One trusted non-force expected-head App transaction persists the immutable owner
disposition and installs accepted capable F with the real prepare-bound
model-disabled bootstrap only after all source, CI, profile, custody,
native-drain and unchanged-head gates pass. Preserve the original request, proof
slots, disposition history, reservations and charges. The release remains
truthfully `owner_superseded`; pointer movement or bootstrap success alone does
not discharge its delivery obligation. No unsupported state may reach an R81
reader.

Native `39167387867:1:repair` remains failed, settled PRIOR bound to the
original release. If its old saved-state `observedAt` is unavailable, the
existing native proof reader may authenticate a genuine fresh full observation:
exclude only `observedAt` from the immutable fingerprint, retain the actual
first fresh observation, and require immutable-field equality and monotonic
observation on revalidation. Never reconstruct an old saved receipt or
reclassify the original PRIOR. The latest active failure and historical healthy
witness retain their exact full saved-proof, digest and head bindings and all
existing native/source/CI/custody gates.

Task delivery requires a fresh, reserved, charged and settled actual internal
structured review of the installed successor against the unchanged source task,
bound to its exact snapshot, native execution, health, CI and accounting.
Persist the intent/running/completed owner-review journal in the distinct
optional `ownerSuccessorReviews` collection through the existing repair
expected-head writer; normal PR review receipts remain unchanged. The trusted
release/App controller verifies the produced evidence, appends a separate
immutable `ownerAcceptance` receipt through normal App CAS and full readback,
and the original task consumes it through existing delivery bookkeeping. A
successor link, old PR review, prior successor review, bootstrap or pointer
alone cannot authorize delivery.

First-F bootstrap failure stays failed and held unless the distinct
supersession-aware route reaches the existing full source-authenticated issuer
for an exact CI-verified capable recovery successor. Carrying the wanted task to
F2 or a healthy corrected successor requires positive exact source
successor/task intent and an immutable binding appended in the same capable
pointer/bootstrap transaction. Each successor waits for its own health and
produces its own fresh structured task review; missing binding and ancestry
alone cannot inherit acceptance. Preserve the original disposition, proof/review
history and accounting. An old supersession record must not permanently block
authenticated normal capable correction or exact healthy-capable rollback and
restoration. Direct R81 rollback remains refused.

Credential routes, runtime model configuration, generic recovery refusals and
release health rules remain unchanged.

### Standing approval for the migration rollout

On 2026-10-18 at 13:33–13:34 UTC, the owner explicitly approved the prepared
isolated queue canary, then directed: "Always approved" and "Finish the job you
can always cut over production". For this resumed Sentinel stability,
outstanding-issue repair, existing-PR takeover and merge-queue job, the
coordinator has standing approval for the canary and production cutover and must
not request those approvals again. This supersedes the earlier pending canary
and separate production approval steps for this task. Complete the required
current CI, source audit, exact runtime/launcher binding, queue and existing-PR
custody floors, trusted App/state/promotion controls, readiness and exact
rollback checks before the corresponding effects. The App permission grant is
already complete. This authorization does not itself establish any execution or
acceptance result.

At 20:39 UTC on 2026-10-18, after the coordinator reported the later Mac
coordination approval hold, the owner explicitly replied: "Why the fuck is it
blocked. You’re approved". This clears the pending exact e16 source-CI attempt
and reaffirms continuation of the already authorized migration rollout. Do not
turn the earlier coordination-only hold into repeated generic approval requests.
Record each concrete workflow, target, candidate, expected duration and
assertion before execution, and continue the authorized publication,
verification, corrections and guarded rollout. Missing real processing evidence
remains an evidence problem to resolve, not an unanswered approval; source,
credential, custody, accounting, CI, readiness, promotion and rollback gates
still apply.

### First-fixture UOS processing evidence

The approved safeguard requires the same first PR to survive real UOS processing
before more fixtures; it does not require the original opened event's private
log, a particular historical delivery ID or a literal304 receipt. Independent
provenance audit `uos-current-audit-2041/decision.md` identifies
original-event-only as an added interpretation, superseding that restriction in
the older canary gate assessment. A genuine later edited invocation on the same
PR may establish the safeguard after an observable truthful handler outcome is
available. Preserve its head/base/author, non-closing body, manual task custody
and current OPEN readback. Silence, elapsed time or CI alone still cannot prove
actual processing. The narrow necessary receipt change belongs to the existing
UOS ownership handler and its tests, with idempotence, safe App-owned comment
handling, preserved role/start/close rules and no new
credential/workflow/flag/environment interface. Reconcile and verify the
existing main/Deno producer deployment before one meaningful non-closing title
edit; Azure is a disabled legacy route. Do not fabricate historical results or
start further fixtures before real same-PR processing is accepted.

### Raw issue discovery and model admission bounds

The live R81 issue reader rejects an entire valid response when one issue body
exceeds the shared 16,384-unit review-statement bound. Reproduction on
2026-10-18 isolates AI issue1213 at 23,807 units; HTTP and transport-size gates
pass and the other issues parse. Separate only the raw GitHub issue-read ceiling
using the existing finite wire-text bound. Preserve full text and complete
pagination; keep shared `MaxText.body`, pull-request bounds and frozen
review/receipt/matrix/stdout contracts unchanged. Before any implementation
reservation, validate the already-read full issue with the existing review-task
statement validator and digest. Unsupported statements use the existing retained
bounded unavailable wait, so other work remains selectable and no unsupported
model start, charge reset, truncation or fabricated statement occurs. This
source fix needs its own connected local/native and installed evidence; the
current failure cannot be attributed to the new development base merely by
timing.

### Failed legacy predecessor recovery

The primary accepts the bounded first-transition recovery contract under
`production-cutover-preparation/legacy-first-recovery-contract/proposal.md` in
the migration evidence workspace. Reuse the existing seven-key source-only
recovery row and private issuer for exact immutable R81/generation81 to one
accepted capable successor/generation82, requiring both explicit matching
migration grants, both active custody floors, the exact nonrollback install
rung, and exclusion of R80/R81 from both accepted lists. Authenticate committed
capability data and revalidate the privately issued move at planning, snapshot
and immediately before trusted App CAS. Retain strict future-runtime membership
for every other recovery, full native failure/earlier own-health/witness
evidence, chronology, source/CI/ancestry/drain and accounting. Preserve all
schemas and default empty recovery data. Persist only the monotonic successor
pointer and actual-prepare-bound model-disabled bootstrap; genuine successor
health remains required. The newest failure and active execution must be freshly
reconciled after quiescence before any live row is prepared; older snapshots are
historical. This decision authorizes isolated implementation and validation, not
a fabricated health reset or an old-runtime execution/fallback exception.

The independent contract audit additionally requires revision-first refusal: the
future recovery issuer always rejects R80, and R81 at any generation except the
exact legacy transition cannot fall through to generic recovery. Maintenance may
emit the existing migration-only target only after authenticating exact clean
source, committed rollout/capability data, both grants/floors, matching
failure/earlier own-health digests and idle/drained unchanged state. That
read-only output carries no movement authority or health. The existing trusted
prepare issuer must still authenticate full native
failure/health/witness/CI/source evidence before App CAS; existing workflow
predicates restrict the eventual repair child to the same exact model-disabled
successor bootstrap. No workflow, schema, flag or default activation changes are
needed.

### Isolated canary ref namespace

Keep `queue-canary` as the isolated canary base and use `queue-canary-fixtures/`
as the fixture head prefix. Git cannot store the original base together with
heads under `queue-canary/`. The initially proposed base rename is rejected
because the approved AI baseline grants the full PR CI scope only for base
`queue-canary`; the head-only correction preserves that real consumer and fixed
baseline. Change only the Sentinel head-prefix validator, directly affected head
fixtures and versioned prepared head-ref fields. Preserve all
base/projection/ruleset literals, nine patch/blob bytes and paths, workflow
hashes, actor/proof/one-shot gates and production branch boundaries. Keep
rejected local evidence for provenance. Local actual-Git and consumer checks
plus exact native CI remain required before their corresponding effects;
standing approval already covers this correction.

### Future runtime pins before the queue fallback freeze

The queue rollout must finish moving future runtime identities into the existing
reviewed rollout-data mechanism before freezing F. Add independent required
`acceptanceCorrection` and `legacyReview` revision arrays to source-only
`HostedRuntimeRollout` version 1, using its bounded, unique, lowercase Git-SHA
parser and deep freezing; both shipped defaults are empty. The
acceptance-correction default combines existing R81 with only
`acceptanceCorrection`; the legacy cutoff combines existing R80/R81 with only
`legacyReview` and retains the single immutable cutoff `1792256700000`. Missing
or malformed fields refuse, and one feature list never implies another. Later
LF/LA revision pin updates must change authenticated data rather than TypeScript
source, preserving the previously accepted F/A launcher code profiles. This
source preparation does not activate a floor, admission, queue or installation.
F-first failure recovery must be proved through an existing trusted controller
path before cutover; the old-runtime execution fence cannot be weakened to
provide a rollback.

### Future recovery and complete native CI

Failed first-F installation has no executable fix-forward path. A later
connected controller probe corrected the initial helper-only rollback
assessment: a generic fresh-generation bootstrap producer exists, but restored
tuples can reach unrelated source selection first and failed restored tuples can
fall through to another generic bootstrap. Before strict F installation, add
explicit reviewed source-only recovery rows that bind the exact failed
pointer/execution proof, genuine historical healthy proof and authoritative
witness ancestor to one exact CI-verified successor. Normal preplanned F-to-A
admission remains blocked after failure. Reuse the existing trusted state-writer
identity, expected-head CAS and serialized shapes; atomically persist only a
model-disabled bootstrap execution, never invented health or refunded charges.
Give exact restored tuples bootstrap priority and failed-restored holds,
preserving the existing generic producer, both custody floors and the
old-runtime fence. The original contract is
`production-cutover-preparation/recovery-module-contract.md` under migration
evidence, SHA-256
`61856f7334597f576c69939833b4ca0cf5e56eb9bbb4c72f779e2fdf8e344fe7`; its approved
addendum and connected-consumer correction take precedence over the original
missing-producer wording.

Native source CI `39131885021` exhausted its 45-minute job limit while tests
were still progressing: its log records 2,892 successful top-level cases, three
failures and 72 ignores before the final repair-module start, without a terminal
aggregate. The failures took 2 ms, 1 ms and 668 ms and did not cause the
timeout; 607 cases completed after the last failure. Repair the three exact
cases locally and increase only the credential-free source-CI job bound from 45
to 60 minutes so the expanded harness can finish. Preserve the full harness,
required `test-local` identity, every assertion and all supervisor/model/session
deadlines; do not rerun the unchanged failed candidate.

### Integration ownership after Muse retirement

On 2026-10-13, the owner stated that Muse is retired and directed the current
coordinator to take over Sentinel. The then-current GPT-6.1 Sol coordinator
received integration ownership; the current primary role owner is recorded in
the authoritative build ledger. Independent milestone audits use a fresh GPT-6.1
Sol/max agent. This replaces the Astra-specific development ownership and
auditor restriction, not runtime model/review policy, credential custody, CI,
source/target identity or promotion ownership. Preserve existing dirty work and
recorded lane identities; only the primary writes the authoritative build-status
ledger. The owner reaffirmed the recorded takeover for this continuation on
2026-10-14; actual coordinator model/effort is reported separately from role
ownership in the ledger and does not change the selected execution route.

Sentinel runs in GitHub Actions. Per the owner directive of 2026-10-07 (commit
`5aac94da8`, "Make it fully autonomous"), `supervisor-dispatch.yml` runs every
five minutes and dispatches the exact protected `sentinel-supervisor` ref;
`observe.yml` and `repair.yml` stay manual-only, and `sentinel-release` remains
disabled. The installed trusted-host CLI stays available for explicit dispatch:
`sentinel status`, `sentinel run observe`, `sentinel run supervisor`, and
`sentinel receipts <run-id>`. The supervisor uses the exact protected
`sentinel-supervisor` ref and authenticated execution receipts; neither time nor
list order selects a runtime.

On 2026-10-15, the owner removed the repeated approval rule for hosted execution
and changed candidates. This supersedes the former attempt-specific confirmation
requirement. Within an authorized Sentinel task, continue through protected
publication, hosted end-to-end verification, runtime/supervisor dispatch and
necessary corrected candidates, retries or reruns without repeated approval.
Complete applicable local checks first, retain exact workflow/target/SHA and
result evidence, and diagnose failures before retrying. Preserve integrity,
custody, durable accounting, review/CI, target ownership and exclusive promotion
authority. Independent credential, security and numeric retention approvals and
explicit whole-repository local-sweep authorization remain required. The
scheduled autonomous dispatcher and the runtime's own retries retain their
existing runtime behavior.

## Source-only stabilization installer preparation

The 2026-10-14 takeover implementation prepares a separate fixed stabilization
transition for immutable repaired runtime candidate
`c8d2e87468399abb54cc9d9a749ae7b400835bbb` from the exact healthy generation-74
revision `4baeaf67d9677a317bc37831486c075b143fe68f`. The previous unconsumed
candidate `2cf3a988313c12876faca8ff30fd85473073181c` failed native CI; the
repaired candidate preserves the runtime bytes while fixing harness discovery
and stale behavioral fixtures. Its two pending local cases and exact
committed-tree size check now pass, with prior unchanged-input statics reused.
Freeze runtime R before the later controller C is committed; C pins this exact R
and still requires successful exact-R native CI and all installation gates. This
source-preparation decision preserves installer identity, custody and readiness
gates. Reuse the existing installer interfaces and native CI, ancestry,
quiescence, prior-proof, expected-state and one-shot rollback gates; add no CLI,
environment variable, credential, workflow input or persisted schema. Preserve
all existing generation-75 retry constants and provenance as a distinct
revision-bound transition. Changed live state must hold for reconciliation, not
widen this transition. The primary records isolated module
r28-stabilization-install in the stabilization handoff and integrates its source
only after focused checks and an independent exact-delta audit. Protected
publication and hosted verification follow authorized task continuation in
AGENTS.md; release and the restricted bridge retain their disabled/setup_only
boundaries.

## Deterministic gateway source verification

The integration owner selects the existing fixed ordinary code-CI workflow to
execute the gateway aggregate command `sh scripts/verify.sh` on immutable
integrated recovery source `bfa99c93e4dedd08c36d8dfd34e15b037baacac5`. The
earlier exact9d83 source passed native literal verification after its local
resource interruption; that baseline proof does not cover the changed recovery
source. Repin only the six source SHA literals and three derived identity
labels, preserving the workflow mechanism and requiring a fresh exact-source
native result. The gateway lint-migration note limiting CI changes applies to
that earlier task; this scoped stabilization decision leaves its existing CI and
production behavior intact. Reuse the existing Sentinel m07-ci-loop lane and add
only `.github/workflows/gateway-source-verify.yml`; its push trigger is
restricted to the canonical coding branch and changes to that file. Use existing
pinned public checkout/setup actions, exact source verification, a clean
allowlisted child environment, public lock-pinned tooling, and no credentials,
dotenv discovery, deployment, live E2E, model calls or runtime/supervisor
invocation. The exact gateway coding branch may be normally published as an
unaccepted source carrier before its gate runs; that publication grants no
shipping, readiness, promotion or target authority. The native job must retain
exact controller/source identity, runtime versions, unchanged tracked inputs and
the actual literal command result. Keep runtime R and controller C immutable.
Native source CI, the interrupted production-isolation receipt, source shipping,
protected publication and original live/capture/rollback acceptance remain
separate; hosted continuation follows the authorized task and its preserved
authority boundaries.

## VPS settlement and telemetry recovery

The 2026-10-14 actual local review of gateway9d83 produced six findings that
were independently reproduced through real driver and terminal-log consumers.
One paired r12 owner owns Gateway driver/journal/receipt semantics and their
Sentinel wire/controller/trusted-verifier consumers; one disjoint gateway r18
owner owns terminal admission logging and metrics. Existing VPS sample fields
and phase/action literals stay fixed. The accepted m08 verifier files
`src/host/vps-release.ts` and `tests/host/vps-release-host_test.ts` transfer
only for this correction to r12 after current clean-tip/ancestry/holder
reconciliation; no other m08 scope or live authority transfers.

Prepared failed settlement is a narrow no-promotion path: require the CAS-bound
prepared sequence1 receipt with null intent, health, restoration, settlement and
error, and trusted committed failed state carrying the exact same driver and a
fail intent. The derived sequence2 failed receipt keeps all identity fields,
retains null driver intent, and carries the verified failed settlement and
existing acceptance_insufficient error. Both parsers must accept only this
narrow null-intent terminal form; journal rules must not permit stripping an
existing intent.

Terminal cleanup retries retain exact current CAS, operation/request identity,
terminal phase/disposition and the original stored settlement tuple.
Authenticate that tuple against its original release-state commit, directly when
current or through existing readReleaseAt bound to a freshly fixed head with
proven ancestry. Reconstruct only the known terminal patch from the
authenticated predecessor, including sequence increment and bounded observed
timestamp, then require exact equality of every remaining identity, intent, pin
and native-proof field. Missing or changed evidence keeps the pin. After
verification, retry only the existing idempotent pin removal and return the
unchanged terminal receipt; do not rewrite its journal, restart, select a
release or invent new settlement state. Controller reconciliation must retry
observed terminals with their original tuple and continue to later work after
success rather than starving requests.

The same driver owner adds bounded exact loopback listener readiness after
candidate and prior restarts, using existing deployment limits, and resumes an
outstanding rollback restart independently of selector equality. Preserve strict
public proof, unrelated-selector refusal, CAS, daemon-reload-refusal
zero-restart behavior and nondestructive post-ingress retries. No model receives
service, credential or state authority.

Terminal logging gains the internal field admission_stage with values
pre_admission or accepted, propagated at the actual acceptance boundary. The
rejection wrapper must receive an explicit stage because it is called both
before and after acceptance. Metrics may exclude only positively tagged
pre-admission orphans; unknown/accepted orphans, invalid stage values and
contradictions remain incomplete. Legacy terminal rows with matching acceptance
remain valid. Journal-loss detection must match actual loss notices, not
ordinary application rate-limit field names. This adds no OpenAI response field,
endpoint, environment variable or VPS sample-schema field.

Previously proved R and C remain immutable and uninstalled. Changed Sentinel
consumer bytes require a new frozen runtime candidate and later fixed installer
pin with fresh applicable local/native proof before protected publication; the
old source-green controller is not final installation readiness for these
corrections. Preserve the same healthy74 predecessor, monotonic rollback,
custody and exact installation evidence under authorized task continuation.

### Deferred telemetry cohorts

The fixed one-interval terminal lookahead cannot cover supported healthy
requests: buffered inference can last 30 minutes and progressing streams have no
finite total-duration cap. The local correction keeps the existing VPS sample
wire fields and authentic acceptance-event timestamps, observes exact health
every 30 seconds, and joins later terminals through bounded journal slices.
Unresolved cohorts remain collecting and never count as complete; missing or
contradictory evidence remains unavailable, and a real observation gap still
restarts coverage. Acceptance still requires the complete baseline, 60
consecutive complete cohorts, unchanged denominators, thresholds and inference
proof.

One paired owner will implement the private query/progress/checkpoint contract
after the r12 bridge correction integrates. Reuse RetentionPolicyV1 and existing
scoped encryption-key capabilities, with no new environment variable, CLI option
or live default. Queries share a bounded per-tick budget; private encrypted join
metadata uses authenticated operation/revision/policy binding and CAS, contains
no prompt, response body or raw log message, and cannot discard unresolved
requests to fit bounds. Absent policy/capabilities, expiry, corruption and
overflow remain unavailable. The detailed implementation contract is frozen at
/tmp/sentinel-resume-20261014/gateway/observation-window-check/supported-lifetimes/implementation-contract.md,
SHA-256 37b8923df3ca7d9b0b3f8af7474599fe3077ebadc6fca8a7b415e51fabbcbb9d; it is
implementation guidance, not a second task ledger or activation authority.

Local tests may inject explicit policies. The proposed live telemetry-artifact
bounds of 48 hours and 64 MiB per operation are unapproved and uninstalled; they
do not change journald retention or request timeouts. Activation requires the
owner's numeric policy approval and existing scoped key/source proof under the
activation checklist. Complete source and local checks before requesting that
numeric policy approval.

Bridge adoption (sentinel#150, generation 81). ubiquity/ai.ubq.fi#1027 (merged
at e50c298b) shipped that contract as a new bridge-facing `VpsJournalMetrics`
interface. The bridge selects the interface from the owner-pinned, hash-verified
`ops/vps-release-metrics.ts` itself (`vpsMetricsInterface`,
`src/release/vps-metrics.ts`): the window shape (5-argument constructor,
`sample` only, generic `run(program, args, cwd)`) of the currently pinned driver
ai.ubq.fi 21e4a2a9 composes exactly as before and the controller keeps its old
per-slot rules; the joined shape (6-argument constructor,
`beginTick`/`progress`, exported `runVpsJournalCommand`) is composed with its
five options (owner `telemetry.retention` and `telemetry.cipher`, a `context`
read from committed release state that binds the unique monitoring operation and
re-reads a saved checkpoint at its own state revision, the pinned tree's
`createVpsJoinFileStorage`, and the run deadline), the bounded
`(args, limits, cwd)` journal runner, and a controller that begins one tick per
monitoring run before sampling, samples only exact 30 s slots, waits on a
collecting slot instead of treating it as a gap, and holds acceptance while a
baseline slot is collecting. Any other shape, or a joined driver without owner
telemetry custody, is unavailable. So the change activates exactly with a driver
re-pin and needs no coordinated Sentinel release. The loader refuses, before
evaluating any module, a driver, metrics or join-storage graph that names a
`bun:` module (`assertDenoLoadableVpsGraph`). At e50c298b, and at ai.ubq.fi
`development` as of 2026-10-17, `ops/vps-release-driver.ts` and
`ops/vps-metrics-storage.ts` both reach `ops/deploy-lock.ts` (`bun:ffi`), and
the driver's `runVpsCommand` uses `Bun.spawn`. The Deno bridge therefore cannot
run any driver past e50c298b until the driver offers a Deno-loadable deploy lock
and command runner. Such a pin is refused with
`trusted VPS driver needs a host that can load Bun-only modules`, as before but
now named. `tests/host/vps-release-driver-interface_test.ts` runs the exact
upstream metrics bytes of both revisions (vendored under
`tests/fixtures/vps/ai.ubq.fi/`, each checked against its Git blob id) through
the real loader and controller, so an interface mismatch fails CI. No state
field, stdout code or bridge result shape changes; `sentinel-release` stays
disabled.

Bridge acceptance of ai.ubq.fi #1155 and #1162 (2026-10-24, sentinel#161,
sentinel#162). The pin test now also runs the exact upstream bytes of ai.ubq.fi
6c3afe42, the #1162 merge, which comes after #1155 (2de00a80). They are vendored
under `tests/fixtures/vps/ai.ubq.fi/6c3afe42/` and checked against their Git
blob ids. The installed driver pin is unchanged. The rules:

- Journal runner. The bridge composes the reader with the pinned tree's own
  `runVpsJournalCommand`, which accepts only the six-argument argv with `--all`
  that its reader builds. Sentinel neither builds nor checks that argv. The
  release bridge refuses a capabilities host that carries a `platform`
  substitute (`capability_unavailable`, before authentication), so a copied
  five-argument check or a runner from another tree cannot replace it. The pin
  test fails if the reader's argv, the runner's check, the checkpoint
  `schema: 2`, the storage signature or the Deno lock changes.
- Storage. The bridge calls `createVpsJoinFileStorage` with five arguments and
  accepts the upstream 10 s `stateReadMs` default. It passes one owner
  `telemetry.retention` to both the storage and the metrics. Each save prunes
  `.data/sentinel-vps-metrics` by that `evidenceMaxAgeMs`, so every bridge that
  shares the target root must install the same retention. Schema-1 checkpoints
  are refused and not migrated. None should exist, because no #1027 driver has
  run under the bridge.
- Host grants. These are an owner installation step, not code. The forced
  command must add `--allow-sys=uid`, unscoped `--allow-run`,
  `--allow-read=<root>`, `--allow-write=<root>/.data` and
  `--allow-env=NODE_V8_COVERAGE` (plus `PATH` for sparse preparation). It must
  also run a Deno with `FsFile.prototype.tryLockSync`. These grants are recorded
  in `VPS_RELEASE_BRIDGE_DRIVER_GRANTS` (`src/host/release-bridge-grants.ts`)
  and in the activation checklist.
  `tests/host/vps-release-bridge-grants_test.ts` runs the exact 6c3afe42 lock,
  checkpoint storage, journal runner and command runner in a child Deno under
  exactly those flags, and checks that removing any one fails with `NotCapable`.
  The read grant on the root (beyond `.data`) covers the release store's
  `realpath(<root>)` check. It was found by probing, not listed in #162.
- Preparation. The bridge passes an owner `host.preparePayload` unchanged to
  `createVpsDeploymentDriver`; a non-function one is unavailable. Release
  preparation stays Bun-only through 6c3afe42. Until ubiquity/ai.ubq.fi#1178
  item 1 ships a Deno-safe `preparePayload` and the owner installs it, the
  bridge can drive only candidates already prepared under
  `<root>/.data/releases/<sha>`.
- Not yet adoptable. ai.ubq.fi `development` 3393df1 (2026-10-24) has moved past
  6c3afe42. Its checkpoint is `schema: 3`. Its Deno lock opens a `/dev/fd/<n>`
  alias, which Deno 2.9.8 permits only under `--allow-all`. On Deno its store
  defaults to `bindBunVpsPayload`, which runs the installed Bun runtime in
  sparse mode with the target root as its working directory. Sparse mode creates
  its temporary directory there, so it would also need write on the target root.
  That may be the #1178 item 1 preparation; it is not verified here. Do not
  re-pin there without a new pin test and an upstream lock that works under the
  scoped grants.

Re-pinning stays an owner action, and `sentinel-release` stays disabled.

## Concurrent issue processing

Use isolated concurrent issue workers across configured targets, one trusted
state/integration coordinator and exclusive serialized merge/promotion
ownership. Artificial hourly/weekly model-start, unfinished-PR,
concurrent-review, review-drain and ordinary hourly-delay caps are lifted.
GitHub/provider capacity and configured session/deadline safeguards still apply.

The trusted start-limit policy is
`liveStartLimits: { perHour: null, perSevenDays: null }`; a wholly null or
invalid policy does not enable inference. Preserve unique task/admission
identity, durable reservations and ambiguous/submitted history, source
freshness, exact-head semantic review/CI and credential/state separation. No
manual quota or state rewriting is authorized.

Matrix planning reserves the existing five-minute operation margin for native
job handoff. Stop reading further candidates when a full configured session and
completion margin no longer fit. Preserve the shared execution start/deadline
and cell-side refusal; planner throughput is not permission to shorten
safeguards.

## Runtime model policy and trusted route configuration

The declared 2026-10-18/20 implementation policy is `gpt-reserve` primary with
the existing HTTP-429 `gpt-6-luna` failover, at max reasoning. The resolver
default is `gpt-reserve`; the supervisor workflow supplies
`vars.SENTINEL_IMPLEMENTATION_MODEL_ID || 'gpt-6.1-sol'`. The captured
repository override at 2026-10-29 20:22:45 UTC is `gpt-6.1-sol`, so configured
submission selection differs from the declared policy. These are separate
policy, source-default and configuration facts; none proves an actual executed
model/provider/effort without bound execution evidence. Documentation
maintenance does not change that override, either default, credentials or
production routing.

Owner decision 2026-10-18 supersedes the earlier runtime model selections below:
use `gpt-reserve` as the runtime implementation primary and `gpt-6-luna` for the
existing HTTP 429 failover, both with max reasoning. That decision directed the
trusted `SENTINEL_IMPLEMENTATION_MODEL_ID` repository override to `gpt-reserve`;
it is historical policy provenance, not an instruction to overwrite later
configured values during documentation maintenance. Retain the existing
`gpt-6-luna` failover default, endpoint, credentials, execution deadlines and
durable admission/accounting. Preserve the supported route interfaces below.
Local coding-agent routing or a task-scoped worker model does not change
production routing, and this decision alone does not prove the live route.

The trusted route configuration in
[src/host/model-route.ts](../src/host/model-route.ts) also supports the gateway
alias `gpt-reserve`, explicit `SENTINEL_MODEL_BASE_URL`/`SENTINEL_MODEL_ID`
configuration and the previously owner-authorized DeepSeek-direct route selected
by `SENTINEL_MODEL_FALLBACK=deepseek` with the existing scoped key. Those
interfaces are retained; this consolidation neither selects a route nor asserts
which route is live. Reconcile the approved policy and actual installed
configuration before a future route change. Trusted configuration retains its
existing consumer validation and route-resolution refusal/fallback behaviour,
and receipts bind the submitted model/provider to actual thread/turn/routing
evidence. Max reasoning remains required.

Historical configuration provenance: on 2026-10-17 the owner chose `gpt-6.1-sol`
on the ai.ubq.fi gateway as the implementation model, once generation 80 had six
consecutive clean supervisor runs. The supervisor workflow binds
`SENTINEL_MODEL_ID` to `vars.SENTINEL_IMPLEMENTATION_MODEL_ID || 'gpt-6.1-sol'`
in the plan, cell and repair jobs alike, so a nonempty
`SENTINEL_IMPLEMENTATION_MODEL_ID` repository variable overrides it. The older
`SENTINEL_MODEL_ID` repository variable, which held `gpt-reserve`, is no longer
read and can be deleted. Reasoning stays `max`, the 429 failover stays
`gpt-6-luna`. Reviewer model naming does not establish invocation mode: the
current actual path uses native Codex review, with selection owned by Codex.

## Review and development delivery

Development changes require no development PR for every edit: make the scoped
change, immediately run applicable local checks and deliver directly. The
2026-10-20 owner preference for development review is GitHub `@codex review`
first, falling back to local `codex review` / `codex-u review`; it supersedes
the former blanket development-review prohibition. Autonomous runtime target
repairs retain their PR, completed current-head review, CI and merge gates.
Mandatory runtime review scope excludes changes limited to tests, fixtures, boot
scripts, development tooling, documentation or other non-runtime files.

A qualified `already_satisfied_at_base` review permits a distinct guarded
terminal-satisfaction path, not fulfilled acceptance, a new repair, merge
authorization or a release request. Persist the exact-bound closure intent
before effects; preserve the original verdict, candidate, accounting and
provenance. The trusted controller closes only its own exact unmerged PR and the
digest-bound source issue, reconciles ambiguous effects and retries partial
closure without repeating a confirmed PR close. Missing native review, task,
head/base, CI, ownership or closure-capability evidence cannot authorize
completion. Ordinary fulfilled delivery retains its existing merge and release
gates.

GitHub PR closure has no atomic expected-head merge-style CAS. The terminal path
relies on trusted serialized intent, an immediate identity read and
response/readback identity checks; it must not claim server-side atomicity.
Already-blocked historical records do not become eligible merely because this
forward path is installed; they require a separately verified native recovery
transition, not a manual state rewrite.

GitHub `@codex review` reviewer statements are retired for autonomous runtime
target PRs. Those PRs use native Codex review mode through the internal review
service, with reviewer selection delegated to Codex as clarified above. A model
alias and a normal review-prompted turn do not meet that contract. Silence, a
reaction or absence of comments does not establish a completed review. No
unresolved P0 may pass the severity gate; P1 and lower findings remain in their
original receipts and use the existing authorized issue-backlog workflow.
Positive task acceptance and every independent gate remain required; changed
candidate bytes need matching evidence. The separate development-review
preference above does not satisfy this runtime gate.

Historical: runtime task ceilings were selected by `reviewRoundCeilingFor` (five
for eligible CI-first-era records, three for legacy or unknown-era records). The
owner retired the review-round ceiling and the CI-fix cap on 2026-10-30/31 (see
the entry at the top of this document); `reviewRoundCeilingFor` is retained only
as accounting history (`ordinaryReviewRoundsSpent`), and no count gates a
review, a fix or a merge. The dated mechanics below preserve their original
source; their severity thresholds, universal-three-round claims and
branch-protection-existence requirements are superseded by the 2026-10-24/29
decisions.

### Historical 2026-10-16–17 review and carried-delivery record

Review rounds are capped at three per task, hard, everywhere (owner decision
2026-10-16, after ai.ubq.fi issue 684 / PR 1059 reached 44 rounds). A task's
spent rounds are the larger of its `review_request` admissions in the durable
ledger (any head, pull request or generation; ambiguous and in-flight admissions
count, a proven `confirmed_not_submitted` refund does not) and its counter less
those refunds. With no round left, no review is requested and nothing is
refreshed, corrected, published or re-admitted for a further review: the runtime
parks the record with an `other` blocker under the fixed prefix
`review round ceiling reached:` (no completed review of the current head,
unresolved P0/P1, no task acceptance, a base moved after the last review, or a
reviewed head awaiting delivery), keeping its pull request, head, receipts and
charges. A park is never handed back for review. Only the REVIEWED and
BASE_MOVED parks, matched by exact message, may merge, and only through the
spent-round delivery rule, which itself requires the latest completed review of
the exact head and base to leave no unresolved P0/P1 and the head's required CI
to be green; a BASE_MOVED park merges only through its moved-base rule. The
spent-round rule admits exactly those two parks
(`isDeliverableReviewRoundCeilingPark`) on every repository, the Gateway
included; while the moved-base rule ships disabled a BASE_MOVED park is
`base_moved` and, like every undeliverable park, stays idle and spends nothing.
The one-time legacy exception covers ai.ubq.fi records whose rounds were spent
under the old review-before-CI order and whose CI is red: an issue record parked
`CI checks failed…` with at least three rounds spent. At the decision-time state
(sequence 36388) that class is exactly the owner's twelve (595, 597, 605, 610,
618, 668, 672, 673, 680, 694, 698 and 879); generation 79 keeps parking records
into it while it reviews before CI (nine more by sequence 37449: 137, 575, 602,
634, 638, 678, 679, 693 and 754; seven more by sequence 38912,
2026-10-17T09:07Z: 583, 615, 617, 629, 633, 650 and 1128). Membership is a rule,
not a table (round-1 recheck P2 [1]; `legacyReviewRoundPin` in
`src/repair/review-round-cap.ts`), evaluated against ONE cutoff C no later than
the FIRST CI-first runtime's activation. C is pinned once
(`LEGACY_REVIEW_CUTOFF.activatedNotBefore`: the instant of the launcher commit
that pins generation 80's install, set by that same commit, null until then) and
never moves: every later CI-first runtime is appended to
`LEGACY_REVIEW_CUTOFF.revisions` by the commit that pins its install and reuses
generation 80's C, never its own instant (round-2 recheck P2: with one cutoff
row per revision, the next CI-first runtime pinned at its own instant turned
records new under generation 80 into legacy ones and gave them a fourth round).
C is handed only to runs of a pinned CI-first revision, and only while it is no
later than every recorded execution of ANY pinned revision (the current run and
every execution release custody still records: hosted release proofs and the
runtime's intent and retained proofs, as `refreshFixActivation` reads them), so
a C moved past an earlier CI-first activation that custody still shows is
refused for every revision and nothing is legacy. The launcher hands C to the
runtime through one child environment key (`SENTINEL_LEGACY_REVIEW_CUTOFF`,
`src/host/legacy-review-cutoff-env.ts`, checked against the release custody the
launcher read the execution from), which the runtime reads into its existing
cycle dependencies: no state field is added and R79 never sees it. A record
whose first review admission is after C is legacy under no CI-first runtime
(`tests/host/legacy-review-cutoff_test.ts`). An ai.ubq.fi issue record is legacy
when at least one of its counted review admissions was created before C and its
pin, its spent rounds less its counted review admissions created at or after C,
reaches three. Its one final round is open while no review was admitted for it
at or after C (only a CI fix may be admitted on that alone) and armed for a
review only once a CI fix (a counted `retry` admission) was charged at or after
C, so the final review is always of a CI-fixed head; a member whose head is
green, or whose latest review left an unresolved P0/P1, gets no further review.
A record with no review admission before C is never legacy, so a record new
under generation 80 can never get a fourth round, whatever its counter; no
cutoff (none pinned, a malformed value, another revision, R79) means no record
is legacy. The rule covers the records in flight at the install, which no
install-time table could (live 645, 646, 657, 663 and 1140 were in review on red
heads under R79 at sequence 39670; at fresh state 07023736b, sequence 40040, all
five are parked `CI checks failed: …` with pins 6, 6, 6, 5 and 3 and an open
final round). The owner's twelve and the sixteen R79 parked afterwards are
members by the same rule (`tests/repair/ci-first-legacy_test.ts` derives the
class from the cut state 18369d9b9 and from fresh state 3bbd4b9f5). Whether the
class is the rule rather than the owner's list of twelve still needs the owner's
confirmation. This replaces round 1's table and its install-time regeneration
gate. Drift is still never silent: every maintenance pass reports each record of
the owner's class shape (`legacyReviewRoundClassPin`: parked `CI checks failed…`
with three rounds spent) that the rule leaves without its final round under the
installed runtime's cutoff (`legacyReviewRoundClassDrift`, as
`retry:<id>:denied:legacy_class_unpinned:…` or `legacy_class_pin_mismatch:…`, at
most 12 per pass and a count of the rest), and, under a proven CI-first runtime
without a pinned cutoff, only their count
(`retry:legacy_class:denied:cutoff_unpinned=<n>`); under any other runtime no
final round is granted to anyone and nothing is reported. A spent record whose
base moved reads its own head's CI before anything else: a red head keeps the
merge gate's `CI checks failed: …` blocker, so a legacy record stays in the
class (live 649 and 1128 sat spent and red in `delivery` and would otherwise
have left it as BASE_MOVED parks), except that a legacy record whose final round
is open and whose red head its own change did not break (its reviewed base red
too, a base check still running, or no usable base evidence) never takes that
blocker: it waits, bounded, while a base check is still running, takes the
uncharged carried refresh once the tip is green, and otherwise parks with a
non-correctable blocker, `CI checks failed on the red reviewed base: …` or
`CI checks failed without base evidence: …`, still in the class. On a moved base
no rule re-admits that park, so it parks until the owner acts and the launcher
reports it on every pass (issue #155, below; round-2 recheck P3: with the
generic blocker the launcher's correction rule re-admitted it as a CI correction
on every pass and `correctFailedHeadBeforeRefresh` declined the fix every time,
one correction slot per pass and no progress;
`tests/repair/ci-first-legacy-moved-base_test.ts`), a pending head waits in
`delivery` and parks
`review round ceiling reached: the reviewed head's required CI did not finish within 6 hours: …`
past that bound (round-1 recheck P3 [4]: no check runs, or a check that never
completes, re-armed `ci_pending` forever), and a green head takes the carried
refresh below when its latest completed review authorizes it, otherwise it parks
BASE_MOVED. The CI-first legacy rule uses the same rule. The historical "review
rounds exhausted without an accepted verdict (…)" block is no longer re-armed
into review.

Delivery line (generation 80, runtime). A reviewed head whose base moved needs a
refreshed head, which needs a review round of its own; when several reviewed
records of one repository wait on one tip, every merge moves the base of all the
others, so refreshing them together cost each of them a round per merge and the
third merge left the rest at the ceiling (8 of the 17 ai.ubq.fi PRs merged since
2026-10-16T00:00Z needed four or more reviewed heads, all reviews clean). The
delivery step therefore refreshes such a record only at the front of its
repository's line (`deliveryQueueAhead`, `src/repair/delivery-queue.ts`).
Generation 81 orders the line by delivery readiness, then pull request number
(JAM J3, live 2026-10-17/18: ordered by number alone, red heads awaiting a CI
fix and CI-fixed heads on the tip awaiting their CI before their final review
held it for hours ahead of 698 and 879, PRs 1112 and 1120, green, reviewed and
spent). Each reviewed, unmerged issue task of the repository with a round spent
stands in one place (`lineStanding`): landing (a carried refresh in flight,
reviewed on the tip waiting to merge, a carried refreshed head on the tip),
ready (deliverable now on a moved base: spent, latest review clean, its next
step the mechanical refresh: its reviewed head in `delivery` with no CI wait, or
a carried head whose base moved again), re-review (heading for a review round on
the tip: a refresh in flight with a round left, a head on the tip waiting for
its CI or its review at `work`, a review in flight there), reviewed (a round
left, in `delivery` on a moved base) or waiting (a reviewed head back at `work`
for its CI fix or correction, a reviewed head whose CI is pending, a head
awaiting its CI or review on a moved base, a spent record without a clean
review). A spent record (deliverable now: its step read its reviewed head green
and its latest review authorizing it, or it is a carried head) waits only behind
a landing contender or a ready one with a lower number; nothing that still needs
a review, a CI fix or its CI holds it, so it takes the line as soon as it is
deliverable. A record with a round left also waits behind every ready contender,
a re-review and a reviewed one with a lower number (two refreshed heads racing
for one tip would cost one of them a round); a waiting contender holds nobody.
One record lands at a time, so the launcher's one merge per pass moves the base
once. The step that reads a spent reviewed head green clears a `ci_pending` wait
left from an earlier poll once before it defers, so the line sees it ready (a
head whose CI turned green otherwise lost its place to every higher number);
every later deferral writes nothing. Otherwise the step defers with nothing
charged, refreshed or requested and, but for that one clear, nothing written;
the stale merge intent of a reconciled merge is kept. A stuck contender holds
nobody, so it never blocks the line: one with 12 or more consecutive executions
without durable progress (`counters.stalled`; live 594 re-armed one wait 104
times) or one nothing has written for 2 hours (a step that defers without a
write every run; live 647 and 604 sat untouched in review for 81 and 33 hours).
A spent record whose latest completed review is clean is a contender too, and
takes its carried refresh (below) only at the front. The line adds no state
shape: generation 79 refreshes every such record at once exactly as before, and
under generation 80, the rollback target of 81, a refresh this line admitted is
a base-refresh intent or a carried refreshed head on the tip, which that
runtime's own line holds every other record behind. The line serialises only
moved-base refreshes: a published candidate with no review yet is no contender,
so a new candidate reviewed on the same tip can merge before the front record
and cost it a round, as does a base move from outside the line (an owner merge,
the launcher's spent merge). It bounds the rounds the queue's own refreshes
spend; it does not make every merge free (round-1 recheck P3 [3]), and a record
that still reaches the ceiling on a moved base takes the carried refresh below
instead of parking for good.

Spent records on a moved base (owner decision 2026-10-16 (2); the coordinator's
choice under it, recorded here in place of round 1's "owner decision required
before generation 80 is installed" gate). The hard ceiling and the exact-base
merge rule together left a spent record whose base moved with no path to merge
but the moved-base merge (D3). Decision (2) says such a PR merges ("the 3 rounds
are spent with no unresolved P0/P1, the PR merges") and forbids turning
`development` red. Of the options, (a) D3 merges a result no CI ran on (the
head's checks ran against its old base, the tip's against the tip alone), so it
can turn `development` red, which decision (2) forbids; (c) leaving the records
parked contradicts "the PR merges"; (b) keeps every merged result CI-tested and
the merged patch exactly the reviewed one. The coordinator therefore chooses
(b), and D3 stays disabled. The rule (runtime half
`src/repair/loop-carried-delivery.ts`, launcher half `carriedMergeGate` in
`ops/hosted-autonomy-spent-delivery.ts`): a spent record whose latest completed
review authorizes its head H0 on base B0 (no unresolved P0/P1, nothing
uncounted, the App reviewer, the live task accepted) and whose base moved to tip
T gets one mechanical, conflict-free refresh: the runtime's existing
deterministic base refresh merges T into H0, with no model and no charge,
counted neither as a review round nor as a CI fix attempt. The refreshed head H1
carries H0's authorization only when the pull request's own patch is unchanged:
the merge-base patches `git diff B0...H0` and `git diff T...H1`, each from its
unique merge base (a criss-cross history is no proof), rendered with every
option fixed (`--binary --full-index --no-renames`, no external diff or
textconv) and compared by the SHA-256 of their raw bytes together with each
side's raw listing `git diff --raw --no-abbrev -z --no-renames`
(`src/github/git-carried-patch.ts`). Full blob ids on every index line bind a
content change, but a mode-only change prints no index line (#156); the listing
names both modes and both full blob ids of every changed path, so equal digests
mean equal contents, modes, renames and binary payloads, and a base change
touching a reviewed path fails the proof even when it merges cleanly. The
runtime re-derives that proof from git on every step; no state field is added,
so R79 parses everything generation 80 writes. The merge itself is the
launcher's (round-2 recheck P1): the runtime's merge port refuses every merge on
a branch without enforced strict up-to-date checks
(`evaluateEffectiveProtections`, `protection_required` before any write), and
live ai.ubq.fi's `development` has no rules, rulesets or classic protection, so
every ai.ubq.fi merge is made by the launcher's delivery pass at the exact base
(2026-10-17: `merge:issue-ubiquity-ai.ubq.fi-664:pr=1067`, `…-688:pr=1115`). A
carried merge through the runtime's port could therefore never land, and the
record would have refreshed and held its repository's delivery line on every
base move. So the runtime never merges a carried head and adds no merge path of
its own (the round-1 carried parameter of the port is gone): once H1's own
required CI is green and the task is still accepted, the record holds the
carried-merge marker at `work` for the launcher: a `backoff` wait of exactly
`CARRIED_MERGE_MARKER_MS` (4 minutes) from its `since`, written only by this
step (`carriedMergeMarker`, `src/repair/carried-review.ts`), a length no other
generation-79 or generation-80 wait has (the CI fix marker is zero-length, the
merge port's refusal backoff at `delivery` is 5 minutes, every red-base backoff
at least 30 minutes), so it adds no state field. The launcher's delivery pass
then merges H1 only (a) for a spent record at `work` that holds that exact
marker (round-2 recheck P3: any `backoff` at `work` used to count, so a
model-written CI fix waiting on the CI-first red-base hold read as proved; any
other wait is `carried_awaiting_runtime`), whose head has no completed review of
its own and whose LATEST completed review of the pull request (any head, the App
reviewer) is a clean one of an earlier head H0, authorized for the live task as
of H0's identity (`carriedMergeReceipt`, `carriedAuthorizingReceipt`); (b) at
exactly T: the tip it reads is the record's base, T is a strict ancestor of H1
(compare `T...H1` `ahead`), and the tip re-read UNCACHED as the last read before
the merge call is still T (round-2 recheck P3: the tip was read once per pass,
before up to a dozen reads, and GitHub's merge API guards only the head), so the
merge result is H1's own tree, the one its CI tested; a merge commit whose
parents are not exactly [T, H1] is never booked: the pass reports
`delivery:<id>:carried_merged_off_tip:sha=…` and, on the Gateway, parks the
record
`review round ceiling reached: the carried merge landed off its tip: merge … has parents …, not <T>,<H1>`
(undeliverable, so later passes leave it alone; a self record is never rewritten
by the pass, and its runtime reads the merge commit's parents and parks it with
the same blocker at its next step, #156), the same for a lost-write adoption of
such a merge, decided on the parents before any patch proof is read; (c) on H1's
own green required CI (every check run on the exact head completed successfully;
`test-local` for the self scope); (d) when the exact patch proof re-derived from
GitHub's Git data holds (round-2 recheck P3: the rendered compare diffs it used
to compare carry 9-hex abbreviated blob ids, fold renames and render a binary
change as "Binary files ... differ", so two binary payloads whose abbreviated
ids collide rendered alike): the full sets of (path, old mode, old blob id, new
mode, new blob id) of merge-base(B0, H0) -> H0 and of T -> H1 are equal, each
read from the recursive Git Trees API of the merge base GitHub's compare names
and of the head (`mergeBaseTreeChanges`, `ops/hosted-autonomy-github-trees.ts`;
compare `files[]` carry only the new blob id, with no mode or old blob), and T
is the refreshed side's own merge base; a tree GitHub truncates (past its entry
or size limit) or any unreadable answer is no proof
(`carried_proof_unavailable`). Full blob ids make equal sets mean equal
contents, text or binary, and modes, and the old side binds the base content
each change applies to, as the runtime's raw listing and patch proof do (#156);
the merge base is the one GitHub names, and a criss-cross history (several merge
bases) is refused by the runtime's git proof, which must hold before it writes
the marker. GitHub's rendered diffs are still read, as evidence only; and (e)
every ordinary spent gate holds (source issue open, a Gateway release request
that will bind, the foreign base ref, the final task re-read and opt-out, one
merge call per pass). The proof (H0, B0, H1, T, the receipt, the SHA-256 and
size of the shared exact change set, both rendered diff digests as evidence and
H1's green workflow runs) is the merge commit's message and the pass's action
line
`delivery:<id>:carried_merge:pr=…:reviewed=<H0>@<B0>:receipt=…:refreshed=<H1>@<T>:changes=<sha256>/<paths>:patch=<d0>/<d1>:ci=<runs>`
(`unrendered` for a diff GitHub would not render). The record then moves to
`delivery` beside a production release request that names H0's receipt with H1
and T as its source (`carriedRequestBindsDelivery`), and later passes report it
as
`delivery:<id>:carried:pr=…:reviewed=<H0>@<B0>:receipt=…:merged=<H1>@<T>:sha=…`;
the follow-up filing uses that receipt. Every other launcher merge re-reads the
tip uncached before its merge call too and merges nothing once it moved
(`base_moved`); GitHub still has no base compare-and-swap, so only the moments
between that read and the call remain. A carried head the runtime awaits is read
on EVERY pass while it holds its repository's delivery line (round-2 recheck P2:
in the rotating spent window of eight it waited up to two hours at live sizes,
holding the line, and each tip move meanwhile discarded its green CI and spent
one of its refreshes): at most the line's front such record per self or Gateway
repository, on top of the window and taking none of its slots
(`spentReadWindow`, `holdsDeliveryLine`). A carried merge whose state write was
lost is adopted by the next pass only with the App as merger, green CI on H1,
the verified merge and the patch proof again; a self record's request is written
without rewriting the record, and the runtime then moves it to `delivery` itself
once it sees the merged pull request and that request. A carried merge is made
only for the self scope and the Gateway, whose bookkeeping the pass writes
(`carried_unsupported` otherwise). Bounds, all derived without a state field: at
most one refresh per record per base tip (the refresh intent key binds the pull
request, the head and the observed tip, and a refreshed record waits its turn
again in the delivery line); at most `CARRIED_REFRESH_LIMIT` (6) refreshes per
reviewed head, counted from git as the first-parent distance from H0 to the
current head, so the refresh that clears every wait cannot reset it (round-2
recheck P1: the 6-hour bound restarted on every base move); and every wait parks
after 6 hours: H1's CI pending
(`…the refreshed head's required CI did not finish within 6 hours: …`), the
proof unavailable, the pull request still reporting the head H1 was refreshed
from (GitHub reports a push asynchronously; round-2 recheck P2: one stale read
used to park the record UNREVIEWED for good, now only a foreign head, a closed
pull request or an unmerged close parks), or the delivery record after a merge
each keep their `since`; the launcher's merge, whose marker restarts its `since`
on every poll so its shape stays exact, counts its 6 hours from H1's own
required CI completion (`…the carried delivery stalled for 6 hours: …`). The
base moving again after the limit parks
`review round ceiling reached: the base moved again after the carried refresh limit: …`.
A refresh conflict keeps the refresh's own terminal
`base refresh has conflicts at <T>` block; a differing patch parks
`review round ceiling reached: the refreshed head does not carry the reviewed patch: …`
with both identities and digests; a red H1 parks
`…the refreshed head's required CI failed: …` (no CI fix: any fix changes the
patch, so it could never carry the review, and the CI-fix allowance stays
unspent). None of these parks is deliverable, none spends anything further, and
a parked record is no delivery-line contender; a record waiting on the launcher
stops holding the line after 12 polls without progress
(`DELIVERY_QUEUE_STALL_LIMIT`). No merge intent is written for a carried merge
(R79 would execute it against a head the receipt does not name and stop with a
state error). As generation 80 shipped, a carried delivery could never be
accepted or closed by the release path (round-2 rechecks P3):
`gatewayRequestBindsDelivery` requires the request's receipt to name the
record's own head and base (H0 is not H1), so R80's `observeGatewayVpsDelivery`
and the launcher's closure gate answer `wait` before reading any release state,
and for the self scope `acceptRelease` refuses through `deliveryTaskRefusal`,
whose authorizing receipt needs the exact head, and blocks the merged record
`missing_evidence`; R79 answers the same. While `sentinel-release` is disabled
that wait is every request's, but once releases are enabled it would be
permanent for carried deliveries. That required follow-up is done (Sentinel
#152; "2026-10-24: carried release acceptance and closure" below): release
acceptance and closure accept a carried request only through the carried
binders, which re-derive the patch proof and authorize the task as of
`reviewedIdentity`; R79 and R80 still answer `wait` for a carried Gateway
request (the rollback answer). Meanwhile a carried merge's source issue still
closes through GitHub's own closing reference on the merge: the pull request
body carries `Resolves #<issue>` and the App merges into the default branch, as
for every launcher merge (verified live 2026-10-17: ai.ubq.fi issues 600, 664,
684 and 688 were closed `completed` by the merging App 1 to 2 seconds after it
merged PRs 1052, 1067, 1059 and 1115 into `development`, the default branch,
with no App-performed closure event, while their release requests are still
open), but the record itself stays in `delivery` beside its open request. The
launcher returns a spent record whose head it read green on a moved base to the
runtime's `delivery` step only under a proven CI-first runtime (a `:green` plan,
never a CI correction slot). Live, fresh state 9dba8b8aa (sequence 40150,
2026-10-17T13:59Z; ai.ubq.fi `development` at 365035981): the 16 spent records
the recheck named (600, 616, 674, 589, 880, 651, 670, 682, 686, 683, 594, 661,
649, 599, 609, 641) and 684 (PR 1059, 70 rounds) were merged by the sentinel App
through the launcher's delivery pass (PRs 1052, 1070, 1096, 1104, 1121, 1013,
1093, 1058, 1114, 1100, 1051, 1064, 1012, 1091, 1110, 1007 and 1059) and wait in
`delivery` beside their open release requests, so generation 80 refreshes none
of them and no carried merge is pending. 647 (PR 1011, at `review` on its
unbound review intent `review:1011:d632c224…:attempt-4`, counter 3, ledger 4,
never a completed review) has nothing to carry and never parks (round-2 recheck
P3): its intent is the `reviewRounds + 1` one, so `observeReview` defers it
("review intent has no exact bound journal") without a write on every run, under
R79 and R80 alike (unchanged at fresh state 1937e2825, sequence 40384, last
written 2026-10-14T00:12Z); idle for more than 2 hours, it holds no one's
delivery line.

### Vendored rubric provenance and current native execution

The historical reviewer vendors `openai/codex` tag `rust-v0.162.0`,
`codex-rs/prompts/templates/review/rubric.md`, SHA-256
`ec60e7f36a1d1c2679ce095c0205ecc56f7dd8fb57707a13ef362072390f219f`. Do not edit
the vendored constant in
[src/github/codex-review-rubric.ts](../src/github/codex-review-rubric.ts). The
pin/hash and read-only boundary remain provenance. Native review mode owns its
rubric and output protocol; the former ordinary-turn adapter's schema override
is superseded. A model alias alone does not establish invocation mode. A re-sync
still requires a new upstream pin/hash and current-candidate validation;
[the alignment note](codex-review-rubric-alignment-2026-10-08.md) gives
verification details.

Never add Sentinel branch protection rules or rulesets, or recreate deleted
rules. Effective configured target checks and approvals remain honoured; branch
rules and rulesets are not required to exist.

## GitHub identity and target scope

Repository-visible autonomous Sentinel activity uses the existing
`ubiquity-sentinel` App, App ID `4682172`, bot login `ubiquity-sentinel[bot]`:
candidate pushes, PR creation/merge, review publication, issue closure and CI
approval. Existing durable state refs use the native Actions token. App private
keys and installation tokens remain trusted-host capabilities; workers receive
neither.

`sentinel.targets.json` is the only target source. Minted installation-token
scope must include every committed target; App installation selection alone does
not widen a token narrowed by `repositories`. Each target uses its own default
branch, authenticated mirror, review checkout and Git objects. Self-scope
installation ID `0` is the explicit reserved local scope; foreign targets use
their own verified App installation. Target preparation failures must be
reported as failed rather than addressed.

Eligibility is default-on for open issues, with opt-out only through the
standalone first-line `<!-- sentinel:skip -->` body comment or `sentinel:skip`
label. Re-read source before admission; gaining either opt-out revokes
eligibility before a start is charged. No author, assignment, estimate, template
or file-hint admission gate is added.

Issue-backed repair PR bodies are exactly `Resolves #N`; a record without an
issue reference keeps a descriptive non-closing body. A failed closure is
retried as closure only. Source merge/closure does not substitute for
runtime/deployment acceptance receipts.

## Failure accounting and diagnostics

An authenticated terminal interruption whose only failed bound is output size
and whose candidate/bundle are both absent may enter the existing
failed-implementation consumer. Preserve the original over-limit metrics, all
identity/carrier/request/model/duration checks and original charge. Settlement
is AMBIGUOUS/BLOCKED with the original intent; it grants no import, publication,
refund, fabricated result or weakened output bound. Other invalid, successful or
candidate-bearing over-limit receipts remain rejected.

Numeric GitHub pagination aliases are accepted only after authenticating the
same repository ID/name and retaining host/path/query/page guards.
Native-carrier reads stay scoped to their exact run; custody and per-request
dispositions must survive runtime upgrades. Generation or age alone cannot
retire unresolved preservation authority.

Gateway unavailable diagnostics retain numeric HTTP status without response
bodies, URLs, authentication headers or credentials. Error kind and fail-closed
observation remain unchanged; the status alone does not establish a producer
root cause.

A settled hosted child that reports state_error or source_error surfaces its own
bounded authored detail as one advisory line beside the terminal, so a failed
hosted run names its closed failure instead of collapsing to the static
settled-failed text. The advisory never carries raw stderr, credentials or model
text and never changes the terminal, health, settlement or exit status.

A failed delivery port call emits one closed sentinel_merge_event (event kind,
PR number, closed port error kind, allow-listed detail code) beside the
unchanged unavailable wait, and the launcher forwards each accepted event as a
hosted_merge_event advisory. The event never carries a message, body, URL, path
or credential, and it never changes the wait, intent, terminal or exit status.

A bound review attempt whose own settle deadline passed without an accepted
verdict is provably dead: an interrupted owner, a lost submission response or an
unreadable pending journal can never produce the polled record. The observation
step recovers it — a surviving review_request intent is counted once and
cleared, a plain observation wait only clears — and requests a fresh uniquely
admitted round instead of re-arming the transient wait forever.

Native review terminal diagnostics (2026-10-21): retain only exact matched
request/invocation/owner/thread/turn identities, `terminalStatus`, bounded
duration and closed typed error fields. Never emit provider prose, output or
additional details. The hosted launcher accepts only a strict exact-key,
owner-bound, capped advisory projection and forwards it through captured-result
CLI output; malformed or foreign advisories cannot affect the authoritative
child result. Advisory fields must not use top-level `status`, which is reserved
by child-result detection. These diagnostics do not complete an unavailable
review, change its null execution receipt, select a route, admit a model start,
restore a spent round or authorize a merge.

## Blocked-work recovery and decomposition (2026-10-15)

Historical source/generation record. Its P0/P1 severity thresholds and
then-current review ceilings do not govern current operation; apply the current
P0-only severity decision. Positive task acceptance remains an independent gate,
and original findings, blockers, counters and charges remain unchanged. The old
200-reservation and six-reservation descriptions below are dated behaviour, not
current admission limits.

Only unresolved P0/P1 findings reject a reviewed head, send it to correction,
fail task-acceptance recovery or qualify a historical correction review for a
legacy-loss proof, exactly as the merge gate decides; unresolved P2/P3 findings
never spend a correction round.

The maintenance retry pass may re-admit a blocked implementation whose outcome
is uncertain ("implementation outcome uncertain…", "authenticated historical
matrix manifest rejected:…") only when the record holds no produced candidate
(no head, pull request or preservation state), its retained intent, if any, is
an implementation intent whose own charge for that task is settled ambiguous,
and its producing matrix evidence is past retention: eight days after that
charge was created (after the blocker was set when no intent is retained), while
supervisor.yml retains matrix artifacts for seven. The original charge stays
settled and is never refunded; the new attempt is a separately charged admission
with the next monotonic identity, and the existing closed-issue, retry-budget,
attempt-memory and pull-request gates still apply. Unresolved candidate
preservation is never retired by age: those records stay with the
preserved-candidate recovery and mismatch disposition, which require native ref,
producer and pull-request evidence.

An issue-backed merge intent at least one poll old whose pull request is
observed open and unmerged after the configured base moved is replaced by the
durable base-refresh intent, so the candidate is refreshed and re-reviewed
instead of re-arming a refused merge; a more recent intent keeps the exact merge
reconciliation because its own merge may still be landing.

A session interrupted at its configured duration bound, or settled by the host
timeout at that bound, counts as one time-bound exhaustion like a matrix host
timeout; matrix ingestion of such a cell keeps the count, and a maintenance
retry preserves it. One exhaustion decomposes a whole, unproduced issue (no
candidate head or pull request) into serial parts; a correction record keeps its
candidate and is never decomposed. A part keeps its `<issue id>:part-<i>-of-<n>`
work id, and its candidate branch maps the colon to a hyphen
(`sentinel/repair/<issue id>-part-<i>-of-<n>`), because git refs cannot contain
colons; every colon-free id keeps its exact branch. Decomposition is currently a
scoped retry, accepted by the owner on 2026-10-15: each part publishes a pull
request that resolves the whole issue and is reviewed against the whole issue,
so a split issue delivers only when part 1 fulfills it; a part refused by review
parks the issue with its open pull request for manual follow-up. Part-aware
acceptance, non-closing part pull requests and merge-satisfied part dependencies
are a later generation. A failed generation 76 rolls back once to da9d6b437,
whose candidate branches keep the colon, so a part created under 76 cannot
publish after that rollback.

A runtime-mismatch-parked preserved candidate whose deterministic
`sentinel-candidates` preservation ref already holds its exact recorded head is
restored through the trusted preserver and the same compare-and-swap write as
artifact recovery (owner-delegated to the coordinator, 2026-10-15): the exact
head SHA on that owned ref is sufficient content evidence, the preserver
re-proves it in a fresh object store and re-checks protected paths, and nothing
is charged, refunded or started. A blocker-bound producer whose plan artifact is
expired or unlisted is unrecoverable from artifacts: maintenance records it as a
typed skip that writes nothing, and its records stay blocked for an
evidence-based disposition, never an age-based one.

The same exact-ref restore covers candidates the generation-63 matrix custody
parked as "candidate preservation unresolved" (2026-10-16). Such a parked
candidate is disposed only on native proof that it is gone: its preservation ref
and managed branch are exact 404s, no pull request was opened from the branch,
the exact head commit is an exact 404 while the record's base commit reads back,
and its producing artifact is past retention. A "candidate preservation
validation refused" candidate (the trusted validator's deterministic refusal) is
disposed only after the base advanced, at least 24 hours after the refusal, and
while its task holds fewer than 6 durable reservations. A disposed record takes
the runtime's own proven-absence shape (no intent, candidate descriptor or head)
with a `candidate preservation unrecoverable` blocker the retry pass owns. Its
consumed charge stays untouched and the retry gates still apply, and a record
whose charge a dedicated matrix recovery owns is left to that recovery.
Separately, the generation-77 publication validator bounds only the base edge of
a commit whose parents include the trusted base, because every other entry of
that commit is trusted base content. Before this, any base refresh over a base
movement wider than the changed-path bound was a deterministic structural
refusal (ai.ubq.fi 649, PR 1012). Once a runtime whose exact revision is
allowlisted as corrected (`HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES`, empty until
the generation-77 launcher names R77) is installed, maintenance re-arms such a
refused refresh at most once a day, only when the refusal predates that
runtime's activation, and only when the candidate's branch, preservation ref and
single open trusted pull request all still name the exact head; the runtime's
own refresh then runs from `delivery`.

Each re-entry of a refused candidate buys a fresh charged model run, and a
refusal can recur at every new base, so the retry pass's 200-reservation budget
is no bound for it: the base advance, a 24-hour wait from the refusal and a cap
of 6 reservations per task (every purpose and outcome, the retry budget's unit)
limit a candidate the validator keeps refusing to a few runs (2026-10-16). The
refresh re-arm never trusts a generation number, because a rollback advances it
too (a failed 77 restores 41bb853a1 at generation 78, which would otherwise
re-arm, refuse and re-block PR 1012 daily). Its activation instant comes only
from the launcher's pinned bounds and release custody that never moves forward:
each allowlist entry's `activatedNotBefore` (the instant of the launcher commit
that pins it, which precedes the owner install that commit performs), every
hosted-release proof of an allowlisted runtime, and each pointer settlement of a
generation earlier than the installed one; the earliest wins. The installed
generation's own settlements change on every run and never count. A pinned bound
later than any recorded execution of its own revision is provably wrong and
never counts. When nothing qualifies, nothing is re-armed. The pinned bound is
required because an owner install, the installed runtime's bootstrap and that
bootstrap's settlement all happen in one supervisor run after that run's
maintenance, so no maintenance ever observes the earlier generation's settlement
under the new pointer (2026-10-16).

A refreshed candidate the trusted publication validator refuses is parked for
the owner, never retried, re-armed or detached (JAM B11, sentinel issue 157 / PR
160, 2026-10-17). Root cause: R79 (549c7a691) implemented and preserved
784e233ec for issue 157 at d5cc84402; it edits
`ops/hosted-autonomy-follow-ups.ts`, `ops/hosted-autonomy-follow-up-pass.ts` and
`ops/hosted-autonomy-github-issues.ts`, and R79 published it as PR 160; those
three files are among the owner-protected paths R80 (e48e7e110, installed at
18:16Z) added. When `development` moved to 614a4fa02, R80 regenerated the
deterministic refresh merge 18cceb957 and the validator refused it: "a protected
entry does not match the trusted base tree" (reproduced byte-identically
offline; R79's validator accepts both heads, R80's refuses both). That refusal
is correct policy, but R80 counted the deterministic `invalid` verdict as a
transient failure, re-ran the same doomed refresh twice (70 minutes), dropped
the reason, blocked through `markTerminalBlocked`, which cleared `target.pr` and
left PR 160 bound to no record, and the re-arm pass then reported
`refresh:...:retained:activation` on every pass, because a refusal at or after
the corrected validator's activation is never re-armed. The runtime now parks
the first deterministic preservation verdict of an unmarked refresh (`invalid`
with one of `DETERMINISTIC_PUBLICATION_DETAILS`) at once as "base refresh
refused by trusted validation; owner action required (land the change by hand or
close the issue): <reason>", the reason being "candidate touches a protected
path" for a protected-entry verdict and the closed validator detail otherwise; a
malformed request and a marked conflict-resolution refresh keep the bounded
failure accounting. The park and the bounded failure block both keep the
still-open pull request as `target.pr` (`markBlocked`, not
`markTerminalBlocked`); the identity-contradiction and closed-publication blocks
still clear it. The launcher's re-arm pass parks an R80-written refusal at or
after the activation (or with no provable activation) in one CAS write: the same
prefix with the original message after it, and the PR binding restored from the
same native publication facts a re-arm verifies; an unverified publication is
parked without a binding and bound by one later write once it verifies, never
guessed. Every park is named on every later pass
(`refresh:<id>:owner_required:pr=<n|unverified>`), a bound one without a read or
a write, an unbound one after a read-only re-verification. No retry,
re-admission, CI or delivery rule matches the prefix, so nothing charges,
refunds, pushes, reviews, merges, closes a pull request or deletes a branch for
it; the owner lands the change by hand (or edits the protected policy) or closes
the issue, after which closure leaves it as every other closed-issue block. A
fresh implementation was not chosen: the issue's own fix lives in protected
launcher files, so any model candidate would be refused again. Every shape
parses under R80's own parser and R80's selection skips it.

A parked runtime-mismatch candidate whose exact head the trusted preserver
refuses with a deterministic publication verdict, for the record's own
deterministic preservation ref, is recorded instead of silently skipped, and
only while that ref reads back absent: an exact candidate already at its ref
keeps custody. A protected-entry verdict (the candidate edits an owner-protected
path, as ai.ubq.fi 587, 608, 764, 785 and 905 do) takes the runtime's own
terminal "candidate touches a protected path" block, which no retry rule or
disposition class re-admits, so the owner handles it. Any other deterministic
verdict takes the runtime's "candidate preservation validation refused" block,
which the REFUSED class above owns. Either way the intent is cleared, the
target, head and descriptor are kept, the consumed charge is never refunded, and
the walk reports `current-matrix:preservation-protected:N` or
`current-matrix:preservation-refused:N` (2026-10-16).

## Generation 77 installation (2026-10-16)

Generation 77 is R77 ab3613e02, the merge of the live launcher with the
integrated runtime lanes, pinned by the launcher commit that adds its
owner-install rung. Only an exact healthy 41bb853a1 generation-76 proof with no
failed proof installs it at 77; a failed 77 restores that recorded 76 proof once
at 78, and a rolled-back 41bb853a1 at 78 is outside the installation chain, so a
rollback never re-installs R77. The refresh re-arm trusts R77 by exact revision
with an activation bound of the pinning commit's instant, never by generation
number. The CI-rejection correction route stays closed in hosted runs (empty
runtime allowlist) because the generation-76 rollback target refuses its matrix
cell. Review custody events are delivered strictly in the owner's counter order;
a counter still missing one deadline after the last delivered progress is
skipped with a content-free diagnostic, which keeps a refused owner frame
confined to its own review.

## Generation 78 installation (2026-10-16)

Generation 78 is R78 474f87eb6, the live launcher 3779f76aa plus three reviewed
runtime lanes (the hosted CI-correction route opened, base-refresh conflict
resolution carried with its hosted route closed, and the own-cell job-log settle
deferral), pinned by the launcher commit that adds its owner-install rung. Only
an exact healthy ab3613e02 generation-77 proof with no failed proof installs it
at 78; a failed 78 restores that recorded 77 proof once at 79, waiting when it
is no longer retained, and a restored ab3613e02 at 79 is outside the
installation chain, so a rollback never re-installs R78. The launcher names R78
by exact revision in the CI-correction runtime allowlist (which also requires
R78's own healthy proof at its installed generation) and in the refresh re-arm
allowlist with the pinning commit's instant; the conflict-resolution allowlist
stays empty, so its hosted route opens only in a later generation whose rollback
target is R78.

Generation 78 opens the CI-rejection correction route in hosted runs
(2026-10-16). Its rollback target R77 runs the same consumer, which accepts the
planned cell (a head reviewed clean against the record's exact base, the
planner's CI finding first) and isolates it as an authenticated runtime
mismatch: the record is blocked with its original charge retained, never
refunded. Every other state the open route writes is inert under R77 or ends in
R77's own legacy CI block, except a reviewed head returned to `work` to await
its correction, for which R77 re-publishes the same head and requests one more
review: one charged review round per such record, never a model start, a refund
or a merge without review. The launcher re-admits at most 12 CI corrections per
pass (4 until 2026-10-17, raised to work the CI-red backlog while the owner's
Codex quota allows), which bounds how many records can await a correction when a
rollback lands; only corrections whose pull request it verified open count, so
closed or unreadable pull requests never hold a slot. The launcher re-admits a
CI-parked head for correction only under an exact allowlisted runtime of
generation 78 or later with its own healthy proof (R77, including R77 restored
at 79, is excluded by revision), and only once the head's single flake re-run
can no longer act: the head was re-run, has nothing re-runnable, holds more
failed runs than one pass re-runs, sits outside the re-run shape, or its base
moved; an unreadable listing waits. The runtime's own "CI checks failed without
base evidence" block keeps the free re-run and green re-admission, never a
correction. Each record still gets at most `3 − reviewRounds` charged
corrections, each one `retry` reservation, one cell and one review round, under
the 200-reservation task budget.

## Generation 79 installation (2026-10-16)

Generation 79 is R79 549c7a691, the live launcher d69c4cba6 plus four reviewed
lanes: refused CI re-runs settle (dce2885bd), an in-flight candidate
preservation finishes from its exact producer (5fb5e33bb, also published alone
as a launcher update), the hosted conflict-resolution route opens (55999a660),
and a late conflict cell is finished in maintenance with at most 4 resolutions
in flight, a lost cell holding its slot for at most 8 days (549c7a691). It is
pinned by the launcher commit that adds its owner-install rung: only an exact
healthy 474f87eb6 generation-78 proof with no failed proof installs it at 79; a
failed 79 restores that recorded 78 proof once at 80, waiting when it is no
longer retained, and a restored 474f87eb6 at 80 is outside the installation
chain. The launcher names R79 by exact revision in the CI-correction, refresh
re-arm and conflict-resolution runtime allowlists (each requiring R79's own
healthy proof at its installed generation); R78 keeps the hosted conflict route
closed and is never listed for it, so a rollback stops new resolutions.

## Generation 79 hosted conflict resolution (2026-10-16)

Generation 79 opens the base-refresh conflict-resolution route in hosted runs
(`HOSTED_CONFLICT_RESOLUTIONS`): a refresh conflict on an in-shape published
candidate H writes the uncharged pending refresh intent with the conflict marker
(PR kept) instead of the terminal block, the trusted matrix planner re-confirms
the base tip and branch and grants one `retry` charge per (task, base tip) as a
cell continuing H with the base B to merge (at most 4 such resolutions in
flight; a pending resolution past that cap stays pending, uncharged, for a later
wave), the cell's trusted host commits the merge M with exactly the parents H
and B, the ingest proves H and B are ancestors of M and preserves M under the
refresh binding of (PR, H, B) before it consumes the receipt, and the hosted
loop reconciles that preservation and lease-pushes M over H so the open pull
request is re-reviewed against B. Each hosted job has its own mirror and M
cannot be regenerated, so the preservation comes first: a later job, or the
rollback target, publishes M from an empty mirror by reconciling that ref. A
transient preservation failure (unavailable, rate limited, credential, a thrown
port) keeps the receipt unconsumed, writing nothing (the one charge stays
`reserved`, the marked implementation intent stays bound), so a later scan of
the retained artifact retries in its own mirror; that holds for 24 hours after
the admission, after which, and on a definite refusal, the receipt is consumed
as before and the publication's bounded failure accounting owns the outcome. A
merge touching a protected path is never preserved. Its rollback target R78
474f87eb6 keeps the hosted route closed, and tests that run R78's own extracted
code show it handles or isolates everything the open route writes: its parsers
accept every snapshot and the planner's `mergeBase` request; its hosted loop
terminal-blocks a pending resolution uncharged and unpushed, leaves an in-flight
resolution and its `reserved` charge untouched (fresh or stale), publishes a
resolved merge exactly like generation 79, and writes nothing for an advanced
merge or a charged, blocked resolution; its consumer authenticates the bound
conflict cell and isolates it as a runtime mismatch with the marked intent and
the `reserved` charge retained, never refunded. Such an isolated record stays
blocked for the owner: the mismatch disposition retains it (a candidate head is
present) and no retry or re-admission rule matches it. That is why the in-flight
set is bounded: at most 4 conflict resolutions in flight, and at most 4 conflict
resolutions returned per maintenance pass, so a rollback strands at most a
wave's handful, never every parked conflict at once.

The launcher re-admits a candidate parked on a refresh conflict only under an
exact allowlisted conflict-resolution runtime of generation 79 or later holding
its own healthy proof, and only for a block written before that runtime's pinned
activation. One maintenance pass returns at most 4 conflict resolutions
(`HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS`), counting the moved-tip
re-pends below and these re-admissions together and only those whose pull
request it verified open, so a dropped one never holds a slot; one past the cap
is not read and waits for a later pass. This bounds both the rollback exposure
and the burst on the model route when the opening runtime is first pinned (about
29 parked conflicts qualified on 2026-10-16). The allowlist stays empty until
the commit that pins generation 79 names it (that commit also names it in the
CI-correction and refresh re-arm allowlists, or installing it switches those
passes off); R77 and R78 keep the hosted route closed and are never listed, so
either one restored at any generation is excluded by revision, and a test proves
every listed revision present locally opens the route in its own tree.

The retry table's conflict-marker guard refuses a marked record only while the
resolution's own charge is settled charged (`submitted` or `ambiguous`, never
refunded) and the configured base tip is unreadable or still the marked tip:
that tip's one charge is spent, whatever the record's age, generation or blocker
class. Once the target moved past the marked tip, a record whose blocker class
the table already retries returns to a plain refresh at the new tip (no marker,
the pull request, attempt floor and charges kept; the retry pass still requires
the pull request open, the class's evidence-expiry wait still applies and a
record with no review round left stays blocked), so a renewed conflict costs at
most one charge at that new tip, and under R78 that refresh terminal-blocks
uncharged. A resolution blocked for touching a protected path, or with any other
class the table never retries, writes no attempt memory, so re-pending it would
charge one more resolution per base move: it stays owner-terminal at every tip
(`conflict_resolution_protected`, `conflict_resolution_terminal`), like the same
block without a marker. A charge that is not a settled charge of this task
(still `reserved` in flight or isolated, missing, or `confirmed_not_submitted`
by the runtime's own refund path) leaves the record's own class in charge, whose
settled-intent rule refuses an unsettled implementation charge; a settled charge
bound to another task, repository or purpose is refused. A never-started
conflict cell is settled `ambiguous` by ingest and is treated like any spent
charge, so it never buys a second charge at the same tip.

The in-flight bound counts every conflict resolution a rollback could still
isolate, a record at `work` whose marked implementation intent still holds its
own `reserved` charge (an earlier wave's unconsumed cell, or a receipt kept
unconsumed while its merge is not yet preserved) and started, by that intent's
own `startedAt` (the admission), less than 8 days before the planner's read
(`CONFLICT_CELL_EVIDENCE_EXPIRY_MS`: the cell artifacts' `retention-days: 7`
plus a day, the launcher's evidence-expiry horizon), before the planner grants
another, so no more than 4 are ever in flight, not 4 per wave, and one rollback
strands at most 4. A resolution R78 already isolated frees its slot: R78's
isolation refuses any record not at `work`, so it cannot be isolated again, and
nothing automatic settles its `reserved` charge (it stays blocked for the owner,
never refunded), so counting it would only close the route for good after a
rollback and a roll-forward. Each further rollback strands at most another 4. A
record at `work` whose cell evidence was lost (its cell artifact never uploaded:
a cancelled or timed-out job, a lost runner) also keeps its charge `reserved`
with nothing to settle it, and state alone cannot tell it from a cell not yet
consumed, so it keeps its slot until its admission is 8 days old; past that no
consumer and no rollback can authenticate or isolate its cell, so it leaves the
count, and only the count: the record, its `reserved` charge (never refunded)
and any preservation stay byte-identical, since leaving a concurrency count is
not a retirement. Lost cells can therefore hold the route closed for at most 8
days, not for good. When the cap is full the planner's zero-cell diagnostic
counts every held-back pending resolution as `conflictResolutionCap` and names
the cap and the ids of the records holding it. A late conflict cell is usually
consumed by maintenance, so the launcher's candidate port also opens the exact
refresh-binding ref of an in-flight conflict resolution's merge (the record's
own pull request and head H with its marked base B; the preserver still
re-proves the whole binding before any remote read): maintenance preserves M on
the remote before it consumes the receipt, inside the 24-hour window and past
it. Its gate used to refuse that ref, so maintenance deferred its walk on the
cell for 24 hours and then consumed the receipt with M only in its own discarded
mirror; a genuinely transient preservation failure keeps the existing 24-hour
rule. A consumed conflict cell clears the record's timeout streak through its
resolved intent, bound by the cell's merge request and the receipt head, so it
is reported `ingested` and never defers the launcher's producer walk.

## Spent-round delivery and review follow-ups (2026-10-16, launcher only)

Historical source/generation record. Its P0/P1 severity thresholds and
then-current review ceilings do not govern current operation; apply the current
P0-only severity decision. Positive task acceptance remains an independent gate,
and original findings, blockers, counters and charges remain unchanged.

Owner decision 2026-10-16: review rounds are capped at three, CI comes before
review, a PR merges once its latest completed current-head review has no
unresolved P0/P1 (or its three rounds are spent with none), its remaining P2/P3
findings are filed as new issues, and a PR whose required CI is red never
merges. The launcher (`ops/`, so it may ship before any runtime) implements the
merge and follow-up halves for records the runtime already parked.

A record whose ordinary review rounds are spent (the runtime's own count over
the durable ledger, `ordinaryReviewRoundsSpent`) and that is parked in `work` or
`blocked` is merged through the trusted delivery path only in the closed spent
shape (`spentDeliveryAdmissible`): no open intent, PR, head, base and an issue
source, no newer candidate than the reviewed head, and when blocked one of the
allowlisted (kind, prefix) blockers (`HOSTED_AUTONOMY_SPENT_DELIVERY_BLOCKERS`:
the merge-gate CI failure, the unattributed CI block, the retired review-rounds
quota block) or the runtime's REVIEWED or BASE_MOVED review-round ceiling park,
by exact message. Task-acceptance, retired, hand-merged,
preservation-unrecoverable, conflict, release and attempt-budget blocks are
never merged (`spent_not_admissible`). Every delivery-pass merge, spent or not,
is decided by the LATEST identity-bound completed review of the exact PR, head
and base by the sentinel App reviewer (by completion time, then observation
time, then id): a later P0/P1 or uncounted finding refuses
(`latest_review_blocking`) even after an earlier clean review. Before the one
external merge per pass the source issue must be open (`issue_not_open`),
required CI must be green on the exact head (`checks_pending`; self
`test-local`, a target every check run) and, on the Gateway, the runtime's own
`gatewayRequestBindsDelivery` must bind a provisional request to the record as
it will be written (`request_unbindable`), so a merge whose release request
could never be recorded is impossible. The Gateway record is then written with
the runtime's own `advanceToDelivery` (wait and blocker cleared; counters,
evidence, intent and target unchanged) beside one open production request, the
same shapes the eleven live delivered Gateway records hold; releases stay
disabled, nothing fabricates a release, later passes report `already_recorded`
and `release_unavailable`, and the source issue closes through the PR body's
closing keyword. An already-merged spent PR (the lost-write window) is adopted
only from the App's own verified merge with green CI on its head; a hand merge
is `merged_outside_trusted_path` and nothing is recorded. At most eight parked
spent records are read per pass, from an offset that rotates every five minutes;
a record an earlier write of the same maintenance pass settled takes no slot and
waits for the next pass. Beside the eight, a carried head the runtime awaits is
read on every pass while it holds its repository's delivery line, at most the
line's front one per self or Gateway repository (generation 80, see the carried
merge above). The delivery pass, which the continuation runner runs at most once
per maintenance pass, calls merge at most once: from the moment it calls merge,
whatever the answer (merged, refused, lost or thrown) and whatever fails after
it (the post-merge pull read, the opt-out read, the request binding), every
later open pull request in that pass is `merge_deferred` before any gate is
read, because the base tip and its CI were read once for the pass and that merge
may have moved the tip to a commit whose CI nobody has checked; an
already-merged pull request is still settled read-only in the same pass.

The retry pass's green CI rule, which returns a CI-parked head that turned green
on its unchanged reviewed base to the runtime's `delivery` step under any
runtime, leaves a head whose ordinary review rounds are spent (a legacy record
included) to this rule: under a proven CI-first runtime the retry pass reads the
CI of at most 16 spent CI-parked heads per pass
(`HOSTED_AUTONOMY_SPENT_CI_READS_PER_PASS`), and a green one on its exact
reviewed base is denied `green_spent_left_to_delivery` and merged by the
delivery pass of the same maintenance pass at that base, or refused. A spent
head is planned as a CI correction only when its CI was read this pass and is
not green, so a green legacy head is never handed to the runtime as a correction
(round-1 recheck P3 [2]); a green one on a moved base returns to `delivery` only
under a proven CI-first runtime, for the carried refresh above; an unread one is
not planned at all. The retry phase runs before the delivery phase and the
delivery pass skips a record an earlier write of the pass settled, so the
hand-off used to settle these records for the pass: no launcher merge, and once
the base moved before the runtime's step, R79 refreshed and reviewed the head a
fourth time (a legacy record spent its one final round on a head whose CI nobody
had read) and R80 parked it. Green 618, 698 and 879 merge on their existing
clean review, with no final round, only through this rule
(`tests/host/hosted-autonomy-spent-green-chain_test.ts` runs the whole chain),
and no green re-admission hands a spent record to any runtime but a proven
CI-first one, whose delivery step only carries its review, so the green rule is
not a path to a legacy final review either.

Moved-base merge (decision D3, `HOSTED_AUTONOMY_SPENT_MOVED_BASE_MERGE`) ships
DISABLED (`false`), and stays disabled under the coordinator's choice of option
(b) above, because the merged result is never CI-tested. The runtime refreshes
any candidate whose base moved, which creates a new head and costs another
review round (ai.ubq.fi 684 reached 50 rounds that way); D3 would instead merge
a spent Gateway record whose reviewed base B moved onto the current tip T when B
is a strict ancestor of T (compare `ahead`), the pull still records B as its
base, GitHub reports it mergeable, the exact head is green and T's own CI is
complete and green (`base_moved`, `mergeability_pending`, `merge_conflicted`,
`base_ci_pending` otherwise). None of those checks tests T plus the head: the
head's green check runs ran on `refs/pull/N/merge` against B, and T's CI covers
T alone. Live, PR 1071's green run tested base 8a99ecbe, 110 commits and 72
files behind the tip; PR 1120's drift edits a file the PR also edits; PR 1011's
head CI ran 384 commits behind with 2 of the current workflow's 4 jobs
(`darwin-native` and `mac-containment` never ran), yet every check run on its
head is green. Such a merge can turn `development` red, which the owner rule
forbids, and R79 then parks every refreshed candidate on the red base. While the
flag is false every record keeps the exact-base rule and a moved base is
`base_moved` with no compare or tip-CI read; R79's own merges always refresh
onto the current tip, so its PR CI ran against that tip. Before D3 is enabled
the gate must also require that the head's green check names include every check
name on T (a stale-workflow head like PR 1011 refuses), refuse a B...T drift
that touches any file the PR changes or any dependency, lockfile or CI file, and
bound how far T is ahead of B; spent records on a moved base are instead rescued
through the carried refresh above. The self scope keeps the exact-base rule
either way.

Once per maintenance pass, after the whole chain including every phase it
continued to (unless it failed), and never starting a read or create later than
`HOSTED_AUTONOMY_PASS_DEADLINE_MS` after the pass started (otherwise
`followup:deadline`), the launcher files one issue in the target repository per
unresolved P1/P2/P3 finding from each merged PR's clean current-head review. The
2026-10-31 owner directive supersedes the original combined-issue behavior.
Candidates include production requests (open or fulfilled) and carried off-tip
parks with a bound App review and recorded merge revision, created at or after
2026-10-16T00:00Z. The fixed epoch preserves work older than 72 hours when the
launcher first runs. Candidates are processed newest first and deduplicated by
repository and PR. Off-tip candidate request values are local proof inputs; this
pass does not write a synthetic release request or authoritative state.

Each candidate is re-verified through the existing native direct/queue delivery
proof, including its exact head, merge, review/request identity, trusted App
actors, branch and integration evidence. Hand or owner merges do not qualify.
The body's first line is
`<!-- sentinel:review-followup:v2 repo=<owner>/<name> pr=<pr> receipt=<receipt id> finding=<finding key> depth=<d> -->`.
Before any create, the repository's created-since listing is read. An observed
App-authored v2 marker for the same repository, PR, receipt and finding means
that finding is already filed, regardless of depth. A legacy v1 combined-issue
marker for the same repository and PR covers every finding, regardless of
receipt or depth. A capped listing proves absence only for candidates whose full
ten-minute request/GitHub clock margin is strictly newer than its oldest item;
timestamp ties and older uncovered candidates remain `listing_unproven`, while
covered newer candidates can continue. Ambiguous creates are reconciled from the
next listing.

Reviewer text is quoted inert (controls removed, no live mention, issue
reference or line-leading slash command) inside a tilde fence. Each finding
links its `path:a-b` at the reviewed head. Depths 1 and 2 remain ordinary
Sentinel-admissible issues; depth 3 is filed with the existing `sentinel:skip`
opt-out and is not automatically repaired. There is no per-pass create-count
cap. Remaining limits are four merge checks and eight unfiled candidates per
pass, five listing pages, a 60-second budget, at most 1,500 characters per
finding, a 12,000-character body and a 120-character title. The `followUpIssues`
capability (repository-bound listing GET, issue GET and issue POST with verified
App creator) exists only on the launcher's port, never in `src/github` or a
model worker. An administrator-deleted follow-up can be filed again because its
remote marker is the duplicate evidence; elapsed time alone never proves absence
or refunds an ambiguous reservation.

Rollback: the written snapshots parse under R79 549c7a691, R79's own binding
binds them and its delivery step waits on the open request (no merge, no refresh
intent), the launcher L79 7e38d16a4 reports `already_recorded` and
`release_unavailable` over them and writes nothing, and R79's task-statement
check and intake opt-out reader admit the follow-up issues; the follow-ups write
no state and no matrix cell.

## Generation 80 installation (2026-10-17)

Historical source/generation record. Its P0/P1 severity thresholds and
then-current review ceilings do not govern current operation; apply the current
P0-only severity decision. Positive task acceptance remains an independent gate,
and original findings, blockers, counters and charges remain unchanged.

Generation 80 is R80 e48e7e110, the live launcher 413f9eff6 plus the reviewed
generation-80 lanes: the hard three-round review ceiling on every review path
(125d184b4), the launcher's spent-round merge on green CI with review follow-up
issues (b9ae9534f), CI first, then review, with CI fixes charged as retries
(f9c59b834), one legacy final review round on a green head (ed975acb3), the
delivery line that serialises moved-base refreshes (319ee6fdd), the carried
refresh of a spent record on a moved base under the legacy cutoff rule
(f1c7ddaa2, 0cac1abfe), and the exact carried-merge marker and tree proof with
an uncached tip before every launcher merge (d99ed7570, which also reverts the
macOS lane 12af5da8a), and two test-only CI fixes (d5cc84402 formats a JSON
fixture; e48e7e110 guards two rollback-parse checks on the generation-79 source
being present). It is pinned by the launcher commit that adds its owner-install
rung: only an exact healthy 549c7a691 generation-79 proof with no failed proof
installs it at 80; a failed 80 restores that recorded 79 proof once at 81,
waiting when it is no longer retained, and a restored 549c7a691 at 81 is outside
the installation chain. The launcher names R80 by exact revision in the
CI-correction, refresh re-arm, conflict-resolution and CI-first runtime
allowlists (each requiring R80's own healthy proof at its installed generation),
the refresh re-arm and conflict-resolution rows with the pinning commit's
instant 2026-10-17T17:05:00Z (1792256700000), and the same commit pins the one
legacy review cutoff C (`LEGACY_REVIEW_CUTOFF`) at that instant with R80 as its
first revision, so C is no later than generation 80's first activation. The
CI-first fix allowlist stays empty (R80 keeps `HOSTED_PRE_REVIEW_CI_FIXES` false
because R79 refuses that cell). R79 is never listed as a CI-first runtime and
receives no cutoff, so a rollback grants no legacy final round.

## Generation 80 CI-first pipeline (2026-10-16)

Owner decision 2026-10-16: CI first, then review, then merge. `requestReviewFor`
gates every review request on the exact fresh head's required CI
(`src/repair/loop-ci-first.ts`), after its freshness gate and before any
reservation: green proceeds; running or absent checks wait at `work` in a
`ci_pending` wait that keeps its `since` and parks after 6 hours
(`CI did not finish before review within 6 hours: ...`); a red base backs off 30
minutes uncharged; a failure no base evidence attributes (a cancelled, absent or
inconclusive base check, or a head check that never concluded) proves nothing
about the candidate, so it waits like running CI, uncharged and bounded, and
parks as
`CI did not finish before review within 6 hours: ... without base evidence`,
which the launcher's re-run and green rules re-admit, never a terminal block; a
candidate-caused failure takes the existing CI correction for a head reviewed
clean on its base, the CI fix marker (a zero-length `backoff` at `work`) for a
never-reviewed head where the pre-review route is open, and otherwise parks
(`CI red before review; awaiting a CI fix: ...`). A head already reviewed clean
on its base by a change-only verdict (the missing task acceptance re-request,
the only reviewed head that asks for another review) waits for its CI at
`review` and is never parked: at `work` it would read as awaiting a CI
correction whose non-failing exit delivers it to a merge gate that refuses the
missing acceptance on every run, and a CI correction whose failure is gone
returns such a head to `review` instead of delivery. A candidate-caused failure
on such a head still takes the charged CI correction at `work`; R79 consumes
that state as the same correction while the failure persists, and only a failure
that clears between a rollback and the correction's admission would reach R79's
own non-failing exit into its refusing merge gate, which needs a change-only
verdict (none completed live since 2026-10-02). No non-green path reserves a
review or counts a round, so every corrected head, refreshed head and conflict
resolution passes CI before its next review.

A CI fix is charged in the existing `counters.retries` (`countRetry`, also
counting `attempts`) and never counts a review round: at most 3 per record,
never lowered, a refunded never-submitted admission included; then the record
parks with `CI fix attempts exhausted (3 of 3): ...`, which no fix or refresh
re-admits (from generation 81 the once-per-head re-run and the green rule take
the pre-review gate's park of a never-reviewed head, see below). A fix also
needs a review round for the fixed head, counted by the hard ceiling's own rule
over the durable ledger (`reviewRoundsLeft`; CI fix charges are not
`review_request` admissions and never count): fewer than 3 spent, or the
one-time legacy final review of the owner's legacy class, whose ceiling is its
pin + 1: every ai.ubq.fi issue record whose rounds reached three under the old
review-before-CI order, by the cutoff rule above (the twelve the owner named,
595, 597, 605, 610, 618, 668, 672, 673, 680, 694, 698 and 879, the sixteen R79
parked the same way afterwards, 137, 575, 583, 602, 615, 617, 629, 633, 634,
638, 650, 678, 679, 693, 754 and 1128, and the records in flight at the
install). Its open final round admits the CI fix; the fix arms it for the
review. One rule under one cutoff serves every check (`legacyReviewRoundPin`,
`legacyFinalRoundOpen`, `legacyFinalRoundArmed` in
`src/repair/review-round-cap.ts`), and every launcher read that counts rounds
takes the same cutoff: the correction planner, the flake re-run's settled read
that every correction plan requires (`readCiRerunSettled`; round-2 recheck P1:
read without the cutoff it settled no legacy record, so 645, 646, 657, 663 and
1140 would never have got their CI fix or final review, silently, since a record
pinned at its spent count reports no drift;
`tests/host/hosted-autonomy-legacy-settled_test.ts` runs the real retry pass on
the 645 shape) and the conflict re-admission. So the CI fix admission, the
review-round ceiling and the launcher's legacy re-admission can never disagree
on who gets the final review. The hosted pre-review fix route stays closed in
generation 80 (`HOSTED_PRE_REVIEW_CI_FIXES`): R79, its rollback target, refuses
that cell generically; generation 80's consumer accepts it so a later generation
can open it. Every refreshed head is a head no review has completed on, so this
park is not limited to new candidates: a reviewed record whose base moved and
whose refreshed head is red (live, most refreshes onto 2756425c16, 973bb2f and
ded498f failed validate on prettier and eslint drift: 645, 646, 649, 1128, 583,
615, 617, 629, 633) parks `CI red before review; awaiting a CI fix: ...` in a
hosted generation-80 run with no route out, where R79 reviewed it and then
corrected it (`tests/repair/ci-first-refresh-red_test.ts`). The coordinator
accepts this for generation 80 (its round-2 choice): such a park waits for
generation 81, a follow-up, not a ship condition of generation 80, scheduled
once R80 is healthy: R80 as its rollback target, `HOSTED_PRE_REVIEW_CI_FIXES`
true and its runtime pinned in `HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES`, whose
fix rule re-admits exactly these parks through the CI fix marker (the same test
pins that route). The launcher approves held CI runs for published heads at
`work` and for pre-review parks, re-runs a red pre-review park once, returns a
green one to `work` under any runtime, and re-admits a red one with the fix
marker only under an allowlisted fix runtime (none yet); the legacy final-review
re-admission runs only under an allowlisted CI-first runtime
(`HOSTED_AUTONOMY_CI_FIRST_RUNTIMES`, which names R80 from its install pin and
counts it only once R80 holds its own healthy proof). The legacy final round is
the same single round everywhere: a CI-fixed legacy head whose refresh conflicts
keeps it for the resolved merge (`conflictResolutionShape` counts
`reviewRoundsLeft` alone; live 597 and 668 conflict), and no launcher
re-admission hands it to a runtime not proven CI-first
(`legacyFinalRoundAdmissible`, denial `legacy_round_requires_ci_first`): the
retry table's work, review and conflict re-pend grants, the pre-review CI-first
returns (which also need a review round left), the CI correction's legacy rule,
and the base-refresh, conflict and refresh re-arm re-admissions. R79 reviews
before CI, so under it that round would be spent on a red head; under R79 a
pending resolution generation 80 wrote for such a record is refused by R79's own
shape (three or more rounds), so R79 runs the ordinary refresh, which blocks on
the same conflict uncharged.

## Generation 81 pre-review CI fixes (2026-10-17, issue #153)

Generation 81 has R80 e48e7e110 as its rollback target and opens the hosted
pre-review CI fix route that generation 80 kept closed
(`HOSTED_PRE_REVIEW_CI_FIXES` true, runtime): R80's consumer isolates every
pre-review fix cell generation 81 plans, a never-reviewed candidate's and a
reviewed record's refreshed head's alike, as an authenticated runtime mismatch
with the charge kept reserved (`tests/host/matrix-ci-first-gen79_test.ts`, run
against R80's own source), and R80's own loop parks the CI fix marker precisely
and uncharged (`tests/repair/ci-first-rollback-gen80_test.ts`). So a red head no
completed review binds, including every red refreshed head of a reviewed record
(645, 646, 649, 1128, 583, 615, 617, 629, 633 at the integration review; 13 of
18 candidate heads at the cifix review), takes the CI fix marker at the
runtime's gate instead of parking: a CI fix charged in `counters.retries`, never
a review round, at most 3 per record, then the exhausted park. No new state
shape, cell kind or stdout line: every hosted write parses under R80.

Launcher (ops/, may ship before the runtime, correct under R80): under a proven
CI-first runtime (R80 included) a red or pending pre-review park whose base
moved returns to `work` with nothing charged and no marker
(`retry:<id>:grant=0:...:base-moved`): the runtime's freshness gate refreshes it
deterministically and its CI gate runs before any review. It needs a review
round left by the ceiling's own count, since the runtime's ceiling gate would
otherwise park it before the refresh; an open legacy final round is a CI fix's
to arm, so a legacy record whose round is still unarmed waits for the fix rule.
The unchanged-base condition stays only on the green rule, which serves any
runtime. The pre-review gate's exhausted park of a head no completed review
binds now gets the once-per-head re-run and the green rule (a flake green again
on its unchanged base returns for its review); it never gets a fix or a
moved-base refresh. The merge gate writes the same message for a reviewed head,
whose green head belongs to delivery rather than to another review, so that park
keeps generation 80's terms. The fix rule re-admits a red park R80 wrote on its
unchanged base through the CI fix marker only under a fix runtime:
`HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES` stays empty here and generation 81's own
pin commit lists R81 there and in the CI-first and CI-correction allowlists;
`ciFirstFixRuntimeProven` counts a listed revision only at generation 81+, as a
proven CI-first runtime with its own healthy proof, and a test proves
`HOSTED_PRE_REVIEW_CI_FIXES` true in every listed revision's tree. Under R80 a
moved-base return of a candidate-caused red head parks again on the refreshed
head, at most once per base move per record, until R81 is installed.

Live at repair sequence 41064 (2026-10-17T20:18Z, R80 installed at generation
80): two ai.ubq.fi records sit in the CI-red pre-review park and none in the
pending or exhausted park. 1148 (PR 1149, never reviewed) parked on 3650359812
while development moved to e25d09cd09: L80 never re-admits it, while this
launcher returns it under R80 at once for its uncharged refresh. 575 (legacy,
its final round armed by R80's CI correction, one round left) parked on the tip:
it waits for its base to move (refresh), for a green head (the green rule), or
for a pinned R81 to take its fix once its re-run settles. At sequence 40627 (R79
installed) no record sat in these parks. The 36 ai.ubq.fi merge-gate CI parks
there (all legacy, none on the tip) reach the pre-review gate only through R80's
CI correction, which arms the final round; this launcher returns every such red
park on a moved base for its refresh under R80, where L80 returned none.

## Generation 81 CI failure evidence for corrections (2026-10-17)

Owner request 2026-10-17: a CI correction (post-review and pre-review CI fix
alike) must carry enough failure context to fix any kind of CI failure. Live, 38
of 49 open Sentinel PRs on ubiquity/ai.ubq.fi were red on their `validate` job
while the finding named only the check; their annotations carry nothing useful
(a Node.js deprecation warning and "Process completed with exit code N") and
their check output is empty, so the job log is the evidence.

The trusted matrix cell collects the evidence when it prepares a CI correction
cell (the planner's CI finding first, `checkoutBase` set, no `mergeBase`), after
every admission and reservation check and before its final start-bound check
(`src/host/matrix-cell-ci-evidence.ts`), with the cell's scoped read-only App
token through the target's cooldown gate (the cell gate records nothing). The
reader (`src/github/client-ci-evidence.ts`) is repository-scoped and never
throws: per failing check (at most 8 named, logs for at most 4) the identity,
workflow name and file, job, failing steps, annotations (at most 10) and, for
Actions jobs, a bounded excerpt of the signed job log, read through the existing
trusted results-host check without credentials in explicit 4 MiB ranges: the
first 32 MiB, then the last 256 KiB with the gap marked; other check runs give
their output, commit statuses their description. The excerpt is generic first
(`src/repair/ci-evidence-excerpt.ts`): the failing step (the one with
`##[error]`, else the last step), kept whole when it fits its share; otherwise
its header and tail, windows around the strong failure markers above the tail
that shrink to fit (40/8 down to bare markers, then first and last alternately),
and the rest of the share filled nearest first: the markers' after-context,
their before-context, the contiguous run after the first marker, weak windows
(only for unrecognized failures), then the step's start and end alternately. The
scanner keeps each step's first and last 16 KiB and the 16 KiB after its first
strong marker for this, so a key line with no failure word in the middle of a
step (a generated-file diff header, a Jest expected/received diff, the last line
of a traceback) survives (`synthetic-gen-drift.txt`, `synthetic-jest-diff.txt`,
`synthetic-traceback-mid.txt`; review P2). Formatter, linter, compiler and
test-name hints are optional summaries. Every line is cleaned (timestamps, ANSI,
control, bidi), made repository-relative, redacted of credential shapes (never
40/64-hex SHAs or paths) and capped at 400 characters; the content sits between
two markers carrying a fresh 128-bit nonce, scrubbed of the nonce, the marker
label and code fences, under a header that it is UNTRUSTED output of the
candidate's code, to be used only as a description of the failure. Budgets: 32
KiB of fenced content, 4 to 16 KiB per check, at most 36,000 characters for the
section (`MAX_CI_EVIDENCE_PROMPT_CHARS`), 60 s and 64 requests per correction,
and the first rate limit stops every later read (a cell records none); over the
38 live logs of 20:26Z and the 39 red heads of 23:00Z every true error line is
kept, through the real reader, at a 16, 8 or 4 KiB share (a small failing step
is kept whole in about 500 characters; the 1.9 MB logs fill about 15,000 of a 16
KiB share). The label "candidate" or "likely infrastructure" is advisory (all 39
live red heads are "candidate", none "likely infrastructure"); correction and
round policy are unchanged.

Nothing new is persisted or planned: the evidence travels beside the
digest-bound request as `runModel(request, { untrustedCiEvidence })` into the
user turn's input only (the role paragraph stays last), never into the Codex
thread's system-level `baseInstructions`, which keep the prompt without
evidence, so CI output never arrives with instruction authority and is sent once
(review P2); and never into state, the plan, a receipt or stdout. The finding
keeps its prefix and only drops "; no CI log text is available", so R80 (the
rollback target) parses every request and carrier this generation writes
(`tests/host/ci-evidence-r80_test.ts`). Any failure (permission, rate limit,
timeout, expired or oversized log, no spare time) degrades to a one-line reason
in the prompt and one plain stderr line
(`sentinel ci-evidence: <reason> <owner/name>`); it never blocks, refuses or
re-charges the cell. Every hosted implementation prompt now also tells the
implementer to read the repository's CI workflows and run the fast checks that
apply to its changes when they work offline in the checkout; the host itself
never runs the target's toolchain (that would execute candidate code in a
credentialed process). The model sandbox has no network and no installed
dependencies, so for ai.ubq.fi (prettier, eslint and tsc from `node_modules`)
the model cannot run those gates itself: a trusted, read-only dependency tree
installed credential-free from the base lockfile with scripts disabled is a
separate owner decision. The matrix cell's App token mint adds
`permission-actions: read` (`.github/workflows/supervisor.yml`); without it the
jobs and logs of a foreign target answer 403 and the evidence holds identity and
annotations with the reason `forbidden_actions_read`.

## Generation 81 task acceptance corrections (2026-10-17, JAM B6)

Historical source/generation record. Its P0/P1 severity thresholds and
then-current review ceilings do not govern current operation; apply the current
P0-only severity decision. Positive task acceptance remains an independent gate,
and original findings, blockers, counters and charges remain unchanged.

Owner rules: an unaccepted candidate never merges and only P0/P1 block a merge,
so a completed review whose only refusal is a `not_fulfilled` task acceptance,
bound to the record's own source issue and to its trusted live text, is a P1.
The runtime (`src/repair/acceptance-correction.ts`, `applyObservedReview`) keeps
the receipt with every reviewer finding verbatim and the reviewer's acceptance
verbatim, and normalizes the verdict into one leading unresolved P1 finding (id
`task-acceptance-not-fulfilled`, the reviewer's acceptance evidence, at most
2,000 characters). The record then continues exactly as a P0/P1 verdict does:
while a review round is left (`reviewRoundsLeft`) it returns to `work` for the
ordinary charged correction, whose first finding is that statement (B6a); with
none left, or when the receipt already holds the most findings a receipt may, it
parks once with the receipt as
`task acceptance not fulfilled and no correction can follow: owner decision required`
(B6b), which no runtime path and no launcher rule re-admits. The three-round
ceiling, charging, refunds and every merge gate are unchanged. A head whose
latest completed review carries that acceptance P1 is rejected even when an
earlier receipt of the same head is listed first (`rejectedReceipt`; every other
verdict keeps the first-listed rule): the missing-acceptance recovery re-reviews
the same head, and its earlier change-only receipt must not turn the rejected
head into one awaiting a CI correction that bounces between `work` and `review`
without end.

Rollback to R80 (e48e7e110): the receipt is a strict R80 receipt, and R80's own
loop and planner predicates read the P1 as the P1 it is and start the same
correction with the same first finding
(`tests/repair/acceptance-rollback-r80_test.ts`, run against R80's own source);
R80's plan parser accepts the planned cell
(`tests/host/matrix-acceptance-correction_test.ts`), and R80's matrix consumer
accepts it by the same rule as any P0/P1 correction (a completed review with
unresolved findings binds the checked-out head). Storing the verdict without the
P1 would not be safe: R80 would read a clean-findings head at `work` as awaiting
a CI correction whose green exit reaches its merge gate, which refuses the
acceptance with a run-level state error on every run (the rollback test's
control). The owner-gated park is idle under R80, and a head whose change-only
receipt R80 lists first is returned to review and blocked again by R80, never a
state error.

Launcher (`ops/hosted-autonomy-acceptance.ts`): a record R80 blocked with
exactly
`task acceptance not fulfilled: the candidate does not satisfy the source issue`
while an ordinary round is left returns to `review` with only its blocker
cleared (`retry:<id>:grant=0:other:task acceptance not fulfilled:review`), on
its open issue and verified-open pull request, so the runtime re-observes the
standing completed review (no new review, nothing charged) and corrects it. It
runs only under an allowlisted acceptance-correction runtime at generation 81+
with its own healthy proof (`HOSTED_AUTONOMY_ACCEPTANCE_CORRECTION_RUNTIMES`,
empty until generation 81's pin commit lists R81; a test checks every listed
revision's tree): R80 would block the same verdict again on every pass. Under
any other runtime the retry pass names each such record
(`retry:<id>:denied:acceptance_correction_requires_runtime`). The owner-gated
park and the R80 refusal once its ordinary rounds are spent, on a source issue
the pass did not read closed, are skipped by the delivery pass without a read
and named once per pass in its result line
(`owner_gate:task_acceptance_not_fulfilled:n=<count>:<ids>`), replacing
`delivery:<id>:spent_not_admissible` on every pass; nothing is written for them
and no GitHub write is added. The two sets are split by the ordinary round count
and the runtime writes the R80 refusal never again, so no record cycles between
them.

Live at repair sequence 41474 (2026-10-17T21:40Z, R80 installed): ai.ubq.fi 576
(PR 1069, 2 rounds), 653 (PR 1014, 1 round) and 660 (PR 1063, 2 rounds) are B6a,
re-admitted on the first pass after R81 is pinned and proven, and corrected on
the runtime's next review observation and matrix plan; 611 (PR 1107), 1127
(PR 1145) and 118 (PR 1113, 22 rounds) are B6b, owner-gated from the first pass
of this launcher. 112 (PR 1085) and 596 (PR 1088) carry the same spent refusal,
but the owner merged both pull requests by hand and closed both issues on
2026-10-16, so they are not named and keep their existing `spent_not_admissible`
line. R80 kept none of their refusing receipts, so the B6b records carry no
stored acceptance statement; the owner reads it on each pull request's submitted
Sentinel review (`Task acceptance (issue #<n>): not_fulfilled` and its
evidence).

## Retained macOS local mode and issue #100 (2026-10-17)

Owner context 2026-10-17: Sentinel's intended runtime is GitHub Actions on
Linux; the retained macOS local-supervisor mode is not used. Issue #100 (the
native Codex cannot apply its own Seatbelt profile inside the macOS local
supervisor's child sandbox) concerns that retained local mode only and has no
Actions impact, so it is closed as not planned for now. Generation 80 ships no
macOS change: the opt-in Codex exemption of the local supervisor's child profile
and the `check:macos-boundary` owner check (12af5da8a) are reverted, and the
local supervisor, its child profile and their tests are byte-identical to the
live launcher 413f9eff6. If the local mode is used again, #100 is reopened, and
a supervisor-owned broker, not an exemption that lets repair-host code reach an
unconfined Codex, is the route.

## Required CI coverage (issue #154, generation 81)

Required CI is green only when every expected check exists. `decideCiGate`
judges the check runs that exist, and GitHub creates a check run only when its
job starts: ai.ubq.fi's `verify-artifact`
(`needs: [validate, mac-containment, darwin-native]`) has none until those
finish. Live, the carried head f0008beb62 of PR 1064 (a refresh onto 9cdc76dc)
showed three of three runs green from 08:41:53Z to 08:41:58Z, so a CI-first poll
would have requested a review, a carried poll written the carried-merge marker,
and a launcher read in the same window merged a head whose required job never
ran. The expected checks are those of the base the head is tested against, but
only the base check suites that share a check name with the head
(`missingExpectedChecks`, `src/repair/ci-coverage.ts`): sentinel `development`
carries a `dispatch` run from every five-minute schedule in its own suite, which
no pull request head ever runs (live 9a1b1d924: `dispatch` and `test-local`), so
the base's raw name set would hold every self head forever. A commit status (no
suite) is never expected. The runtime port reads a base for this rule through
its own lenient read, `readCheckSuites` (name and `check_suite.id` of each check
run, never persisted; the exact-head binding and the item bound stay, a
malformed suite is a parse failure, commit statuses are not read), not through
the strict CI read: that read bounds a check name at 64 characters, and live
sentinel `development` (fast-forwarded with `sentinel-supervisor`, so its tip
also carries the supervisor.yml runs) holds 78-character
`matrix_cell (<cellId>)` runs: 7 of 22 runs on L80 9a1b1d924, 33 of 75 on the
tip 3f041b46d. Read strictly, every self base was unreadable and every self head
was deferred forever at the review gate, the ceiling's refresh and the carried
step. The strict CI read (`readChecks`) is unchanged from R80 and reads no
suite. The sentinel self scope reads no base at all, as the launcher's retry
pass and its self merge gate do: its gate is the one named `test-local` job
(ci.yml, no `needs:`), and its tip gains a `dispatch` run every five minutes.

Runtime (generation 81): the CI-first review gate requires coverage of the
record's base before it requests a review, and waits like running CI
(`ci_pending`, `since` kept, uncharged) until the bound parks
`CI did not finish before review within 6 hours: verify-artifact(absent)`; the
ceiling's moved-base read requires the reviewed head to cover its reviewed base
before its one refresh (waits at `delivery`, parks under
`REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX`); the carried step requires H1
to cover T before it writes the carried-merge marker (parks under
`REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX`). A base listing that cannot be
read is awaited like running CI at each of the three steps (the same
`ci_pending` wait, `since` kept, and the same park with `base checks unreadable`
in place of the absent names), never a deferral without a write: such a deferral
sets no wait, bound or park, so no launcher rule could re-admit the record, and
a self record stalled at the tip also held the repository's delivery line
(`deliveryQueueAhead`) until it counted as stuck. An unreadable head listing
still defers, as in R80; so does the red path's strict base read for failure
attribution (`loop-ci-first.ts`, R80's own, out of this change). The runtime's
own merge gate (`gateDeliveryOnChecks`, also its release and closure gates) and
the self merge port keep their rule: their heads passed the CI-first gate before
review, the self CI is the single `test-local` job, and the runtime's port
refuses every ai.ubq.fi merge, which the launcher makes.

Launcher (`ops/`, may ship before the runtime; it imports only the pure rule):
`hasAllChecksGreen(head, base?)` is tri-state: true for a complete, non-empty,
all-success listing that covers `base` when one is named; false for a readable
listing that does not; null when the head's or the base's listing cannot be read
and proven complete, is malformed, or the head has no check run. Every launcher
merge passes the base the head was tested against (`preMergeGate` the reviewed
base, `carriedMergeGate` T), so a marker written in the gap by R80, which reads
no base, merges nothing (`checks_pending`). The retry pass reads foreign
CI-parked heads against their record base (a self head keeps the head-only read;
the self merge gate is its one named `test-local` job), records a head in
`ciReadHeads` only after a successful non-empty listing, and plans no CI
correction and no CI fix for a head whose listing was unreadable
(`ciUnreadHeads`; the issue's case: a rate-limited listing of green legacy 618
read as red and, its re-run settled, took one of the four correction slots).
Reads of a tip's own CI (the re-run's base read, the disabled moved-base rule),
the closure gate and the lost-write adoption keep the head-only rule.

Accepted residuals: a whole workflow with no check run on the head yet is not
inferred (no shared name); a self workflow that gains a `needs:` job is not
covered by this rule in either the runtime or the launcher; a base read inside
the base's own gap expects that gap's names only (both five-second windows would
have to overlap); a pull request that renames or removes a job of its own
workflow would wait and park (`.github/workflows/` is a protected path).
Rollback: every write is a shape R80 writes itself (`ci_pending` at `work`,
`review` or `delivery`, and parks under the existing prefixes); the tests parse
every write under R80 e48e7e110 and run R80's own `preReviewCiParked` over the
park, which R80's launcher re-admits like its own pending park. Under R80 a
waiting head is reviewed or carried as R80 always did. L80's boolean read is the
launcher rollback.

## Release-deferred Gateway delivery (JAM B12)

A merged ai.ubq.fi delivery whose source issue closed through its closing
keyword waits at `delivery` beside its open production release request, and the
Sentinel release path stays disabled (the VPS release contract is an open owner
decision, Sentinel #10, #13, #152), so the release ref holds no VPS release
record and `observeGatewayVpsDelivery` can only answer `wait`. R80 re-armed a
five-minute `unavailable` wait for every such record on every runtime cycle
(live 670 rewrote it 138 times; 348 of 632 repair-state commits between
2026-10-17T16:34Z and 20:36Z were these re-arms of 25 records, each spending a
delivery-bucket step), and the launcher's closure-delivery pass ran the full
closure gate (source task, opt-out, pull and two release reads) for each and
printed one `delivery:<id>:release_unavailable` line per record per pass. The
record is not marked done: `src/release/vps-controller.ts` begins open requests
from the repair state without consulting the record, but only the record
consumes the outcome, through the runtime's `observeReleaseAcceptance`
(accepted: the closure intent and its reconciliation of the already-closed
issue; failed or rolled back: `release <phase>` block) and the launcher's
`gatewayClosureGate` (closure intent, `reconcile:<id>:already_closed`, or
`blockGatewayDelivery`), both of which bind only a record at `delivery`
(`gatewayRequestBindsDelivery`), while a done record never moves again;
merged-but-not-deployed work is never reported as delivered (stabilization
plan). Next runtime generation (rollback target R80): when the open request has
no VPS release record on a positively read release ref
(`gatewayReleaseDeferred`), the delivery step writes once an open-ended
`unavailable` wait at `delivery` (`deferRelease`; no generation-80 path writes
an open-ended `unavailable` wait, so the shape adds no state field), which
selection skips, so the record costs no step and no write afterwards. Once per
run, and only when such a record exists, the runtime reads the release ref once
(`resumeDeferredRelease`); a deferred record whose request the release ref now
records, whose request is no longer open, or that holds an intent has its wait
released and is observed on the same run; nothing else is written, and each
record is looked at once per run. A cancelled or failed request is never
deferred. The launcher counts such a delivery (Gateway, `delivery`, no intent,
one open matching request without a VPS release record in the pass's release
snapshot) in one line per pass,
`release-deferred:count=<n>:release_path=disabled` (`queued` once the release
ref holds VPS release records but not these requests' records), and spends no
read on it in the closure-delivery, retirement and foreign-closure loops (its
request was recorded only after its merge, so it is never closed unmerged); the
decision reads the snapshots, never the wait, so it holds for R80's re-armed
waits and the new shape alike, and the full gate runs again on the first pass
after the release ref records the request. Rollback: R80 parses the deferred
shape and skips it (`isWaiting`), so it writes nothing over it; the live
launcher 3f041b46d, which never reads the wait, reports `release_unavailable`
over it and writes nothing, and an accepted, failed or rolled-back release is
still consumed by any launcher's closure gate (an accepted release closes the
deferred record out to `done`). Live, fresh state 31e7cc24a (sequence 42434,
2026-10-17T23:51Z): 26 records (577, 579, 589, 592, 594, 595, 598, 599, 600,
609, 616, 618, 641, 649, 651, 659, 661, 664, 670, 674, 682, 683, 684, 686,
688, 880) are deferred on the new runtime's first ordinary pass (no hosted step
limit) and are then not rewritten; 618's request is a carried delivery that does
not bind under R80; the carried binders bind it (#152, 2026-10-24, below).

## Durable memory and self-healing

Sentinel records machine-readable attempt memory and a deterministic lesson
digest in the existing Git repair state; trusted writers own every write and
model workers never write state. Bounded records carry the attempt fingerprint,
the stage reached, a closed failure class, counts and the runtime revision.
Unchanged replays of a recorded failure are refused with a precise reason, and
the implementer prompt carries verified prior attempts, cross-task repository
lessons and regression facts.

The system is version-controlled and regression-aware: a recorded success stores
the exact runtime revision that produced it, and a failure mode that previously
succeeded at an older revision is reported as a regression (worked before,
broken now) in the lesson digest and the implementer prompt, which must prefer
restoring the older working behavior over re-implementing. Under the 2026-10-20
decision, rollback authority stays with trusted launcher self-install and its
exact installation journal: a failed candidate restores only the recorded proven
predecessor at a higher generation and verifies restoration. No model worker may
pin, roll back or promote a runtime revision.

Bounded self-upkeep passes defer instead of failing the run: exhausting a
recovery pass's budget, absent custody or an unavailable producer is reported
with an explicit bounded reason, writes nothing and lets prepare, matrix_plan
and delivery continue. Only integrity faults (tampered, conflicting or changed
custody) fail closed.

One maintenance pass continues after a write (2026-10-16). Since generation 78
most cells finish after their own repair job's consumer stopped, so nearly every
pass began with the history walk's ingest and returned on it, and conflict
re-admissions, merges and release requests starved behind it. After an applied
maintenance write, a delivery-bookkeeping retirement or closure, an ordinary
retry grant or re-admission, or a release request, the pass re-reads repair and
release state, requires exactly the head that write left and runs the remaining
phases there in the same order (delivery-bookkeeping closure, retry, delivery,
closure), each at most once and each with its own expected-head compare-and-swap
and readback. A record an earlier write of the pass touched (its row or one of
its charges) waits for the next pass, so no record is re-granted, merged,
retired or closed in the pass that just wrote it, and every other record gets
the decision a pass without that write would make on the same state; each source
issue is still read once per pass. The candidate-ref revalidation, the mismatch
and preservation dispositions, the refresh re-arm and a Gateway release block or
closure intent still end the pass. A refused compare-and-swap, a moved head, a
nonterminal release, a thrown error, or a continued phase that would start more
than 600 s into the pass (`HOSTED_AUTONOMY_PASS_DEADLINE_MS` 840 s, inside the
job's 15 minutes with a minute of setup, less the 240 s
`HOSTED_AUTONOMY_PHASE_RESERVE_MS`) stops it as a deferral with the writes
already made; integrity faults still fail closed. The pass prints one
`hosted_autonomy` line with the same keys and closed reasons (the first write's
before head, the last write's applied head and reason, every action in order and
one `continuation:<phase>:<outcome>` action when it stopped early) and one
`sentinel_autonomy_continuation` timing line (integer offsets or null, no
`status` key). Retry and delivery still run once per pass, so the per-pass
bounds hold: one external merge, the CI-correction cap and at most 4 conflict
resolutions. Issue closures and retirements can reach 5 in the
delivery-bookkeeping closure and 5 in the final closure, always on different
records. No state shape changes: every write is one the installed runtime and
its rollback target already parse and validate.

The progressive matrix consumer treats a cell of its own in-progress run whose
job has completed but whose native job log, or the cell marker in it, is not
served yet like a still-running cell (generation 78): for up to five minutes
after the job's authenticated completion the whole wave is skipped for that
scan, nothing is ingested and every producer stays charged and unresolved. A
served log that conflicts, a log of any other run, and a log still unserved past
that bound keep the plain fail-closed refusal.

A release request the trusted controller cancelled or marked failed is terminal
delivery evidence: the affected delivery record is parked blocked with the
recorded failure reason instead of waiting for release acceptance that can no
longer exist.

A trusted already-merged pull request is verified by its exact head binding plus
the recorded base's proven ancestry, not by first-parent equality: the base
branch may advance between the reviewed snapshot and an external trusted merge,
and the merge is still the reviewed delivery. A divergent, unproven or
differently-parented merge is refused.

Identical implementation failures are bounded across bases (JAM B10,
2026-10-17). Attempt memory is keyed by (task, base, runtime), so it never
refused ai.ubq.fi 300, whose base moved with every merge: 53 identical "model
run failed (unavailable)" outcomes over 23 bases, each a charged reservation.
Root cause: every recent 300 cell's diagnostic reads
`model_candidate_unchanged_base` (run 39073338516); the issue was already fixed
upstream (ai.ubq.fi 0c120c11f6, before its first charge), the model completed
without changing its checkout, the trusted committer refused `unchanged_base`,
and the port reported that as `unavailable`. The runtime now settles that exact
refusal as its own no-progress outcome, "model run completed without any change
to its checkout" (stage `model`, class `semantic_no_progress`), still charged
`ambiguous`, never refunded; every other port error keeps "model run failed
(<kind>)". The launcher's retry pass (`ops/hosted-autonomy-repeat-failure.ts`)
reads the task's attempt memory base- and runtime-independently: the signature
is the blocker kind plus 16 hex of the SHA-256 of the normalized message (case,
whitespace, hex identities and numbers folded); the streak stops at the newest
different outcome and at the newest recorded success, and an entry straddling
that boundary counts once. Three identical outcomes (the review-round cap; one
past the no-progress tolerance) park the record, a transient-class streak only
once it also spans the six-hour transient decay window, so a provider outage
shorter than that never parks the fleet. The park is one CAS write that only
replaces the blocker with "repeated identical failure; owner action required
(...): <n>x <kind>|<sig> issue=<digest12> route=<route12>: <original>"; intent,
counters, charges and memory are untouched, no retry rule of any launcher
matches it, and every later pass names it (`repeat_failure_parked`) without
writing. An edited source issue (its canonical task digest changed) or a changed
model route (the maintenance step now receives the non-secret `SENTINEL_MODEL_*`
selector variables, never a key or failover override) re-arms it once as an
ordinary work grant through every existing gate except the same-base equivalence
refusal; an identical failure after that re-parks at once, and a different
signature resets the streak. Age, generation or a base move never re-arm. An
issue whose digest cannot be read is withheld without a park
(`repeat_failure_unverified_issue`), and the 200-reservation cap is now named
(`retry_budget_exhausted`) instead of skipped silently. The park and the new
detail parse under R80's own parsers.

## Evidence, target release and local development

Sentinel adapts the Ubiquity physical file-size policy from
`ubiquity/ts-template` revision `fc5add134e8ed3728a3da981d298d0a92eb27ac8` with
Deno-native `size:report` and `size:check` tasks. Source ceilings are 1,000
lines and test ceilings are 1,500, counting comments and blanks; 500/800 are
review triggers. All tracked and new nonignored code, including operations
scripts, is covered without a grandfather baseline or exemptions. Keep Deno's
existing formatter, linter and lockfile; the cheap size gate also runs in
`test-local.ts` before typechecks/tests. This adaptation does not add an
ESLint/Node toolchain or broaden local/hosted validation authority.

Use fast module checks and directly affected production-consumer boundaries with
fake external transports, temporary Git/state and injected clocks. Enforce a
300-second deadline on each local validation command. One named
changed-lifecycle scenario is final local acceptance; whole-repository sweeps
require a separate explicit request. [AGENTS.md](../AGENTS.md) defines
observation, teardown and evidence rules.

Preserve candidate durability, exact reviewed heads, independent state/promotion
ownership, healthy prior identity and exact rollback. Gateway deployment follows
its current trusted VPS contract; Deno target receipts cannot establish VPS
delivery. Finite encrypted evidence retention, objective telemetry and
uninterrupted acceptance coverage remain activation requirements in
[activation-checklist.md](activation-checklist.md).

## Frozen Bun reader compatibility

The 2026-10-15 gateway deployment prerequisite permits a trusted, exact-source
registry to select the frozen causal reader's runtime. Legacy captures retain
their recorded Git SHA and Deno binding. Bun captures require the pinned Linux
ARM64 Bun binary, authenticated schema-3 artifact, lockfile and
dependency/native graphs, and the fixed pre-import confinement bootstrap.
Unknown bindings or unsupported platforms refuse; dotenv loading and dependency
installation remain disabled.

The Bun reader applies the existing gateway Landlock/seccomp helper before
importing captured source and verifies source, helper, configuration and graph
identity at every launch. Acceptance requires the actual original/composed
causal pair, production `prepareReplayRequest` proof consumption, and native
read/write/network/process denial evidence bound to the selected final gateway
artifact. This prerequisite does not change repaired-candidate execution, target
policy, model routing or Sentinel runtime promotion; the broader recovery task
remains paused.

Sanitized v2 upstream attempts use a fixed positive synthetic clock origin of 1
because the frozen gateway reader rejects zero absolute attempt timestamps.
Preserve relative durations, chunk offsets and null fields, and refuse unsafe
integer results. New fixture digests describe the new canonical bytes; existing
stored refs, proofs and captured-source identities are never rewritten, and a
recomposition mismatch continues to refuse.

## Historical retry disposition (consumed)

The sixteen historical retry admissions stuck by the missing-artifact matrix
wave 37354374590 are consumed. All sixteen bound retry reservations settled
`ambiguous` on 2026-10-09, the records were re-admitted, and issue 398 and issue
541 were delivered by the runtime and closed (PRs 955 and 958); the remaining
entries carry their own fresh intents or blockers.
[ops/historical-retry-disposition.ts](../ops/historical-retry-disposition.ts)
reports `already_applied` and writes nothing once every bound reservation is
settled `ambiguous`, regardless of later record movement, and the one-shot
maintenance step was removed from
[supervisor.yml](../.github/workflows/supervisor.yml).

The three C63 rows (issues 576, 616 and 618) were the exception: their failed
C63 admissions stayed charged and blocked with the retained intent, and the
retry pass excluded them because historical C63 recovery failed closed on any
row that moved. Their C63 cells are authenticated failures that can settle
nothing more, so (2026-10-16) the ordinary retry authority now retries them like
any other "model run did not complete" record, and
[ops/hosted-autonomy-historical-recovery.ts](../ops/hosted-autonomy-historical-recovery.ts)
treats a row whose bound charge is settled `ambiguous` and whose record no
longer carries that admission's intent as consumed. The original charges stay
charged, and any other drift from the exact binding still fails closed.

## Generation 81 throughput and owner visibility

The 2026-10-18 owner directive lifts the incidental per-pass counts for closures
and retirements (five), spent-record reads (eight), CI reruns (three), and
conflict resolutions (four per maintenance pass and per runtime wave), plus the
generic 200-reservation retry refusal. Every eligible spent record is read on
each pass. Charged reservation history remains intact; the three review rounds,
three CI fixes per task, same-base conflict charge rule, deterministic
preservation-refusal guard, storage bounds, configured deadlines and one merge
per pass remain in force. The retained numeric conflict and rerun policy
surfaces use `Number.MAX_SAFE_INTEGER`, preserving existing diagnostic contracts
without a reachable throughput throttle. This supersedes the older count
descriptions above.

The maintenance job appends all blocked task identities and their PR bindings to
the native GitHub Actions run summary, including task-acceptance,
repeated-failure, protected-path, refresh-refusal, review-ceiling and CI-attempt
parks. Unknown blocker classes also appear, so a new owner-gated park cannot
silently disappear from the summary. Only closed reason labels are emitted,
never raw blocker diagnostics. The summary is a read of final repair state and
grants no admission or state-write authority; unavailable state is reported
explicitly, and a summary failure cannot interrupt the live pipeline.

## Maintenance candidate recovery uses each target's own credential

Finding (2026-10-24): every matrix-produced candidate for the Sentinel
repository itself had stayed in flight (`candidate_preservation` intent,
`preserved: null`, no ref) since 2026-10-18, while foreign targets' candidates
from the same waves were preserved. The maintenance current-matrix walk
([ops/hosted-autonomy-matrix-adapters.ts](../ops/hosted-autonomy-matrix-adapters.ts))
built every target's candidate-recovery port, mirror refresh and default-branch
read with the `ubiquity` installation token, which cannot read or push
`ubiquity-sentinel/sentinel`. The runtime repair job reads only its own run's
artifacts by design, so its preservation of such a record finds no objects and
waits `unavailable` forever; maintenance is the only pass that can finish it.

Decision: a maintenance pass binds each committed target to the credential that
reaches it, `maintenanceTargetToken`: the self scope uses the self token, every
foreign target keeps the App token. Unfinished preservations are no longer
silent: the trusted tail logs `sentinel_candidate_preservation_unfinished` (task
id plus the preserver's static verdict) and the pass reports
`current-matrix:preservation-unfinished:<n>`. No charge, custody or review
boundary changes. Correction (02:10 UTC): the Passport retry successors
(42/49/50/53/59) that looked wedged were preserved by the 00:41 UTC maintenance
run once its walk reached their producer wave (`current-matrix:ingested:9`), so
the published-head ancestry theory recorded for #184 was wrong; #184 is closed
as not a defect and the delay belongs to the walk budget. Also open (issue
#185): the walk's 300-second history budget (`deferred_budget`, 975 snapshots
read per pass) limits each maintenance run to roughly one producer wave.

## Owner directive 2026-10-24: no branch-rule requirement, only P0 blocks

The owner directed (2026-10-24 02:50 UTC): "remove branch rules; the only
internal policy is resolve all P0". Applied as follows.

- An autonomous merge requires a completed native review receipt for the exact
  current head with no unresolved P0 finding (`hasBlockingSeverity`,
  `BLOCKING_SEVERITIES = ["P0"]` in `src/contracts/review-receipt.ts`), the
  positive task acceptance already required, and current-head CI that is not
  red. Unresolved P1/P2/P3 findings never block a merge and never spend a
  correction round.
- Branch protection rules and rulesets are not required on any target
  (`src/github/port-merge.ts`): the active rules are still read so required
  checks and approvals a target does configure are honoured, but an unreadable,
  empty, unsupported, merge-queue or bypassable policy is treated as no
  protections (`noEffectiveProtections`) and never refuses a merge. The self
  path no longer requires authenticated empty rules.
- A check the target's own CI did not run (`skipped`) or marked `neutral` is
  green (`GREEN_CONCLUSIONS` in `src/repair/ci-rejection.ts`, used by
  `failedChecks`, `requiredChecksState` and the launcher's `hasAllChecksGreen`);
  failure, timed_out, cancelled, action_required and stale stay red; pending
  still waits. This supersedes the 2026-10-23 note that Sentinel reads
  ai.ubq.fi's skipped dispatched jobs as failed (#181 becomes an ai.ubq.fi-side
  improvement, not a Sentinel blocker).
- The activated merge-queue proof (`queue.proofActivated` in
  `src/host/hosted-custody-capability.json`, #180) is off by owner directive
  (2026-10-24, "fix the leftover safety flag thing, just unblock"; #180 option
  2). The strict native queue guard no longer parks ai.ubq.fi records on a
  transient observation failure, and the launcher delivers them on the legacy
  direct path. With the proof dormant, admission off and an authenticated
  negative `merge_queue` rule, the queue prelude
  (`ops/hosted-autonomy-queue-pass.ts`, `releaseDormantHolds`) returns a bare
  open-ended hold on an unbooked gateway pull (no queue intent, provenance,
  native entry or matching release request) to a transient wait, which releases
  the four open PR records held since 2026-10-21. Merged records waiting on the
  disabled release path stay held. A future `merge_queue` rule still fails
  closed with `activation_unaccepted`.
- Review follow-up filing (`ops/hosted-autonomy-follow-ups.ts`) now files every
  unresolved P1/P2/P3 finding of a merged PR as follow-up work; before the
  directive it filed only P2/P3 because a P1 could not merge.
- A historical review whose only unresolved finding is a P1 is a clean review
  under this rule. The legacy base-refresh loss bridge therefore restores only a
  head an unresolved P0 rejected; a P1-only historical rejection is refused like
  any other non-rejecting review.
- Exact current-head CI, native review receipts, task acceptance, durable
  accounting and the custody of credentials are unchanged.

## Owner directive 2026-10-24: other people's pull requests never hold Sentinel

The owner directed (2026-10-24): ignore other contributors' pull requests
completely and remove the existing-PR hold, even for the owner's own open pull
requests. This supersedes the existing-PR takeover part of the 2026-10-18
standing approval above. Applied as follows.

- Sentinel always opens and drives its own pull request on its fixed
  `sentinel/repair/<task>` branch. Existing-PR discovery is never activated: the
  hosted App composition already ships `takeover.activated` false, and the local
  composition in `src/host/actions-repair-host.ts` no longer reads the takeover
  source routing, whose `unknown` answer used to switch discovery on. With
  discovery off, the router and the PR-creation boundary guard stand down, so no
  `existing PR hold` is written and Sentinel's own PR creation is never refused
  for another pull request.
- The parks discovery already wrote are released in one checked transition
  (`releaseExistingPrHolds` in `src/repair/loop-existing-pr.ts`) on any record
  whose port has discovery off: issue records without takeover custody or a
  bound PR whose blocker is an `existing PR hold: <discovery reason>` park or
  the takeover queue-preflight hold return to `work`. Intent, target, counters,
  evidence and reservations are kept and nothing is charged or refunded. This
  re-admits Passport issues 87–108 and ai.ubq.fi issues 300 and 1281–1283.
- Sentinel's handling of its own branch, PR and head is unchanged, including
  own-branch reuse and the author check in `src/github/port-publication.ts`. The
  native merge-queue guard for Sentinel's own ai.ubq.fi effects stays.
- Takeover custody parks (`closed_publication`, `self_merge_requires_owner`) and
  records with takeover custody keep their existing handling; no live record
  carries takeover custody. Deleting the dormant adoption and custody modules is
  a separate cleanup.
- Where an outside pull request and Sentinel's own both target an issue,
  whichever merges first closes the issue, and the other Sentinel record then
  retires as "source issue is closed".

## 2026-10-24: merge-time protected paths and the held-run approval trade-off (#158)

- The launcher's merge gates refuse a protected-path change at merge time, not
  only at publication. `preMergeGate` lists the pull request's files (a rename's
  previous path included) for a head about to merge and refuses
  `protected_path`, or `protected_path_unverified` when the listing is unproven.
  The carried gate checks the exact patch it already proves. The list is
  `selectTrustedTargetPolicyV1(...).protectedPaths`, the same list runtime
  publication refuses.
- Under CI first, the launcher approves GitHub-held CI runs of model-authored
  heads before any review (`ciFirstApprovalEligible`). This is accepted because
  every target's `.github/workflows/` is a protected path: a model candidate can
  neither publish nor merge a workflow change, so an approved run executes only
  owner-authored workflow definitions. Sentinel's `ci.yml` runs with
  `contents: read` and no secrets (checked 2026-10-24); ai.ubq.fi
  `deno-deploy.yml` did at the 2026-10-17 audit in #158. The owner accepts the
  exposure if they later add a secret or a write permission to such a workflow:
  model code would then run with it before review. An automatic refusal for that
  case is an owner decision and is not implemented.

## 2026-10-24: generation-80 rollout guards (#159)

- The zero-cell matrix plan diagnostic now checks review rounds the same way the
  readiness predicate does. A record at `work` with no review round left is
  counted as `review_rounds_spent` instead of being explained as ready.
- The two generation-79 rollback exposures of the legacy route are accepted and
  no longer reachable. A conflict re-pend could end in R79's terminal conflict
  block. A legacy record left at `work` could be published and reviewed before
  CI. Both needed R79 as a rollback target. Ordinary updates now self-install
  the exact CI-green development SHA, and rollback restores the exact recorded
  prior runtime, so R79 is never a target.
- No consistency test was added for the CI-first, CI-correction,
  conflict-resolution and refresh re-arm allowlists. Those lists belong to the
  retired rollout ceremony that DESIGN.md §4 schedules for deletion, and no
  future pin appends to them.
- Whether the legacy class is the cutoff rule or the owner's list of twelve
  still needs the owner's answer.

## 2026-10-24: carried and spent delivery precision (#156)

- A merge the launcher's delivery pass makes is booked only when the merge
  commit's parents are exactly [the tip re-read immediately before the merge
  call, the head] (`mergedExactlyOn`). GitHub has no compare-and-swap on the
  base, so a commit that lands in between makes the merge a tree no CI ran on;
  the pass reports `delivery:<id>:merged_off_tip:sha=<merge sha>` and writes
  nothing. The refusal is durable (review finding, upheld 3 of 3): while the
  moved-base merge rule (D3) is off, an App-made merge of a non-carried record
  is booked in any pass only on exactly [its reviewed base, its head], so a
  later pass never adopts the refused merge as an outside merge. A queue merge
  keeps its own proof, an owner's merge is not the App's, and with D3 on an App
  merge onto a moved tip is intended, so only the same-pass check applies.
- A carried merge already landed off its tip is decided on its parents before
  the patch proof is read (a queue merge keeps the proof). The runtime reads the
  merge commit's parents itself (`GitHubPort.readCommitParents`, optional;
  absent, the bounded wait stays): a merged carried head not booked whose
  commit's parents are not exactly [T, H1] parks at once with the launcher's own
  `…the carried merge landed off its tip: merge … has parents …` blocker instead
  of holding the delivery line for 6 hours and parking as a generic stall. A
  native queue target (ai.ubq.fi) is left to the launcher, which parks it
  itself.
- `carriedRecordAwaited` still counts every `unavailable` wait at `work`: the
  runtime writes it for a merged pull request awaiting the launcher's record,
  but also before any merge (an unavailable patch proof or base ref, a pull
  request still reporting the refreshed-from head), and the record carries no
  merged fact. The pass therefore reads such a record's pull request first and
  stops there with `carried_awaiting_runtime` unless it is merged (no task
  read).
- The runtime's carried patch digest is the SHA-256 of the length-prefixed raw
  listing `git diff --raw --no-abbrev -z --no-renames <merge base> <head>`
  followed by the patch bytes. A mode-only change prints no index line, so the
  patch alone did not bind that path's content; the listing names both modes and
  both full blob ids of every changed path, the same sets the launcher's
  Git-tree proof compares.
- `executeCarriedDelivery` reads H1's own CI before the tip. A red H1 its own
  change caused is never refreshed onto a moved tip: it parks
  `…the refreshed head's required CI failed: …`. A red the base caused, or one
  no base evidence attributes yet, keeps the refresh path, since a refresh onto
  a fixed tip can cure it (review finding, upheld 3 of 3); without a moved tip
  it keeps its bounded wait.
- Each repository's tip is read once before the spent read window. While D3 is
  off, a spent record reviewed on its own head whose base is not that tip is
  left out of the window (`spentOnTip`): only its pull request is read, so the
  lost write of a merge that moved the tip itself is still adopted, and an
  unmerged one reports `base_moved` without the task read. A carried head on a
  moved base keeps its own exemption. Nothing here merges anything the gates
  refused before, refunds or moves a reservation, or relaxes a review, CI or
  protected-path gate.

## 2026-10-24: an unready ai.ubq.fi queue observation no longer holds all maintenance

- The maintenance preflight still reads ai.ubq.fi's branch rules and merge queue
  first. A failed or inconsistent read now holds maintenance only while queue
  proof is active. With queue proof off (owner directive of 2026-10-24, #180),
  maintenance continues for every target. The runner's queue custody prelude
  then protects every ai.ubq.fi native-queue record and grants no
  protected-write authority (#188).
- Live, the read failed on every maintenance pass from 16:43 UTC, so no closure,
  retry, delivery or follow-up pass ran for any target.

## 2026-10-24: gateway base CI evidence for check attribution

- `ubiquity/ai.ubq.fi` runs `Gateway CI` only on `pull_request: [closed]` and
  `workflow_dispatch`, and a closed-PR run reports its check runs on the PR
  head, not on the merge commit. The `development` tip (`3393df1e`, the merge of
  PR 1258) had no check run, so the CI-first gate (`attributeFailedChecks` in
  `src/repair/ci-rejection.ts`) found no same-name check on the record base,
  every red gateway head stayed `unattributed` and waited `ci_pending` until the
  6-hour pre-review bound parked it (live: PRs 1295 and 1256).
- The trusted pre-merge dispatcher (`src/host/actions-premerge-ci.ts`) now also
  requests base evidence. When no pending head needs a dispatch in the pass, the
  pass's single dispatch may go to `ref: development` for a bound head that
  already has a run, when its record base equals the live pull request base and
  that base SHA has no run of the workflow (any event or status). The inputs are
  `base_ref: development`, the App login and `scope_base` set to the base
  itself. That empty changed-path scope makes the gateway's test scope run
  everything (`runAll`); a first-parent scope would report `success` for gates
  it never ran and blame a pre-existing base failure on the candidate (review
  finding, upheld 2 of 3). The pass reads the tip through the branch
  (`GET /commits/development`) and dispatches only while that tip is still the
  exact base, so a branch that already moved (`<pr>:base_moved`) never draws a
  dispatch on every pass; an unreadable tip skips the base. Head dispatches keep
  priority, a base SHA that has any run is never dispatched again, and the same
  grant, cooldown gate, deadline and refusal-ends-the-pass rules apply.
  Decisions are `<pr>:base_stale`, `<pr>:base_run_exists`,
  `<pr>:base_runs_unreadable`, `<pr>:base_moved`, `<pr>:base_tip_unreadable`,
  `<pr>:base_dispatch_refused:<reason>` and
  `<pr>:base_dispatched:confirmed|pending_visibility|unconfirmed`; the pass
  reports `base_dispatched`.
- A dispatch is a request for evidence, never evidence: it writes no record,
  wait, counter or receipt. A base branch that moves before GitHub resolves the
  ref yields a run on another SHA, which is reported as `pending_visibility` and
  never retried in the pass.
- A full-scope run still skips `docs` and `verify-artifact`. Their attribution
  needs the owner's ai.ubq.fi change tracked in Sentinel issue #181 (the
  complete check set for an opted-in dispatch run); until then a head check the
  base run skips stays unattributed exactly as before.

## 2026-10-24: a pending commit status no longer holds a finished head's CI (#192)

- The head CI read (`readChecks` in `src/github/client-reads.ts`) still folds
  the head's commit statuses into its check runs, and each status context is
  judged by its latest status (newest `created_at`). A context whose latest
  status is `pending` is advisory once the head reports at least one check run,
  every check run has completed, and the last run completed at least 30 minutes
  ago (`PENDING_STATUS_GRACE_MS`): it is then left out of the read. The grace
  keeps waiting for a status that resolves shortly after the runs, so one that
  is about to fail still blocks review and merge. A third-party status that
  never reports, such as a stale integration or a preview deployment, therefore
  no longer holds the CI-first gate in `ci_pending` until the six-hour park, nor
  the delivery and merge gates that read the same list.
- A failed or errored status still counts as a failure, and a successful one
  still passes. A pending status still waits while any check run is running, and
  when the head has no check run at all, because the statuses are then the only
  CI. Leaving a status out adds no observation, so it never turns a red check
  run green.
- A name-filtered read (the base attribution of given head failures) returns its
  statuses as recorded. A required check a target's own branch rules name stays
  required (`requiredChecksState`): an omitted pending context reads as absent,
  which is pending. No target configuration names required status contexts. The
  launcher's `hasAllChecksGreen` reads check runs only and is unchanged.

## 2026-10-24: dispatcher auto-follow on by default

- Owner directive (2026-10-24): "make it end to end autonomous". The
  dispatcher's `auto-follow` input now defaults to `on`
  (`vars.SENTINEL_AUTO_FOLLOW || 'on'`); setting the repository variable to
  `off` turns it off again. The condition for enabling it (a verified controlled
  advance and self-install) has held since generation 100: every manual advance
  today bootstrapped and ran green.
- Without auto-follow, every Sentinel self-merge left a `requested` hosted
  release that only a manual launcher advance cleared, so the runtime never
  installed its own merged fixes.
- The 2026-10-22 reason for keeping it off was that the native dispatcher token
  cannot move a ref onto a commit whose workflow files differ. The follow now
  compares the `.github/workflows` tree id of the launcher and of each candidate
  (git trees API) and skips a differing candidate, taking an older eligible one
  or deferring as `workflow_change_needs_owner_advance`. It never attempts a ref
  write GitHub would refuse, so the dispatcher stays green and keeps dispatching
  the current launcher. A workflow change still needs one manual advance.
- Unchanged: exact first-parent ancestry, complete CI evidence for the exact
  SHA, failed-bootstrap exclusion, the expected-old non-force ref update and its
  readback, and the model-disabled bootstrap at generation+1.

## 2026-10-24: up to five review rounds for CI-first-era records

- Owner decision (2026-10-24): "For your triage you can have up to five
  reviews." It answers the finding that native reviews returned an unparseable
  result on about one attempt in three today (PR 211 and ai.ubq.fi 1258,
  `json_syntax`), each spending one of three rounds.
- `MAX_REVIEW_ROUNDS` is five for a record of the CI-first era: created at or
  after the pinned CI-first cutoff (2026-10-17 17:05 UTC) with no review
  admitted before it (`reviewRoundCeilingFor`). A record from before the cutoff,
  one with an earlier review admission, and one whose creation time is unknown
  keep the 2026-10-16 ceiling of three (`LEGACY_REVIEW_ROUND_CEILING`). The
  legacy exception, its final round and the spent-round delivery rules are
  defined against three, so they keep their exact membership and behavior.
- The launcher re-admits a record the runtime's ceiling gate parked under the
  old ceiling (no completed review, an unresolved P0, no task acceptance, or a
  moved base) once its durable ledger leaves a round: it returns to `work`
  uncharged (`other:review_rounds_raised`), and the runtime gates, refreshes,
  corrects or reviews it on its ordinary path. A reviewed head awaiting delivery
  is not re-admitted (it needs no round), and nothing is refunded, re-counted or
  charged.
- The current-head review, CI and P0 gates are unchanged.

## 2026-10-25: observability lines, outage notice and wedge report (redesign C5)

- Plan diagnostic: a zero-cell plan prints one `sentinel_matrix_plan_diagnostic`
  line after its carrier, with per-repository `skippedByReason` and
  `notReadyByReason` counts. The keys are a closed vocabulary: an intent is
  named by its key family only (`intent=impl`, never its reservation id), and an
  unknown reason counts as `other`. The launcher re-parses the line against the
  verified wave and keeps only known keys with non-negative integer counts. A
  foreign, duplicated or malformed line is dropped, a rejected carrier carries
  none, and the sanitized line is re-emitted after the carrier. The carrier, its
  exact keys and its readers are unchanged. The queue-custody empty plan prints
  one with `cause: "queue_custody_idle"`; a plan with cells prints none, because
  the planner keeps a diagnostic only for zero cells.
- Step line: `runRepairCycle` prints one advisory `sentinel_step` line per
  selected step: `recordId`, `step` (the record's `nextStep`), `outcome` (the
  step result kind) and `elapsedMs` (monotonic wall time; the injected run clock
  is never read). A cycle prints at most 1,000 lines and the launcher re-emits
  at most 2,000 strictly re-parsed lines before the carrier and the terminal.
  The line has no `status` key, so the child-status scan never reads it, and a
  failed print is swallowed.
- Target order is unchanged (the setting order). A rotation by run id was built
  and withdrawn the same day: the real bootstrap child and the matrix
  review-window tests pin the setting order, and stage 4 runs targets
  concurrently, which makes the rotation unnecessary.
- CI outage notice: the state-free `ops/hosted-autonomy-outage-observation.ts`
  keeps one issue per foreign target on Sentinel's own tracker while that
  target's tip has only never-started checks. That means at least one
  never-started failure, nothing started and nothing undetermined; skipped and
  cancelled checks count nowhere. The first body line is
  `<!-- sentinel:ci-outage:<owner>/<repo> -->`. The body names the tip, the
  never-started count, the records waiting and one owner action: "restore
  Actions billing or raise the spending limit for <owner>".
  - The same facts write nothing, and changed facts update the body.
  - A started check closes the issue, then adds one comment once the close is
    confirmed, so a close that keeps failing adds no comment per pass.
  - The notice is filed with the `sentinel:skip` label, which every runtime's
    intake honours, so a runtime installed before `isCiOutageNotice` (a rollback
    or a pending install) never admits it as a repair task (stage-1 review,
    2026-10-25).
  - A pending or unreadable tip changes nothing.
  - The marker on someone else's issue prevents a duplicate and is never edited.
- The outage pass takes the never-started classification as an injected
  predicate (C2: the target surface's `classifyTipStart`). It runs with the
  self-observation pass, only on a maintenance pass that wrote nothing, so a
  pass that delivered never touches the self scope, and a self surface without
  the tracker files nothing and reports nothing. Intake never admits a notice
  Sentinel filed (as the App, or with the maintenance job's native-token
  fallback) as a repair task (`isCiOutageNotice`), because no code change fixes
  billing; the same first line on anyone else's issue is ordinary work. On
  recovery every notice Sentinel filed for the target closes.
- Wedge report v0: finalize reads the repair state once (advisory, with a
  60-second bound) and adds `wedges` to `hosted_runtime_run_summary`. It has
  three classes:
  - `holder_not_runnable`: a `holdsDeliveryLine` record that cannot move now (an
    unexpired wait other than `ci_pending`, or an implementation in flight)
    while another published record of its repository waits;
  - `open_ended_wait`: `until: null` on a live row outside the allowlist
    (`backoff` at any step; `unavailable` at `delivery`);
  - `stalled`: `counters.stalled >= 24`, except a row whose release request is
    recorded (the disabled release path is its named exit).
- Healthy jobs with any wedge make the run `degraded`; `failed` and
  `unavailable` keep precedence. An unreadable state gives `wedges: null` and
  changes nothing. The report decides nothing.

## 2026-10-25: protected paths named in the prompt, and the `sentinel:retry` exit

- Finding (redesign 2026-10-25, C6): 96 records were parked "candidate touches a
  protected path" (44 ai.ubq.fi, 43 Sentinel, 9 Passport; of these, 6, 2 and 9
  had an open issue on 2026-10-25). The prompt said "do not modify protected
  paths" without naming them, and no rule could ever re-admit such a park.
- The implementer prompt's role paragraph now names the exact trusted configured
  prefixes of the requested repository (deduplicated, sorted, JSON-quoted, at
  most 60 within 4,000 characters, the rest counted) and says to fix the issue
  without changing them where it can, since a candidate that changes one is
  parked for the repository owner to land. (Superseded 2026-11-05: a required
  protected fix is made in place and published for the owner to merge; see the
  entry at the top of this document.) (Corrected 2026-10-25 by the stage-1
  review: the first wording, "make no change and say
  `OWNER_LANDING_REQUIRED:
  <paths>`", sent a compliant run into the no-change
  base-review lane, which has no exit: Passport deferred forever and ai.ubq.fi
  and Sentinel parked outside the `sentinel:retry` exit. Nothing read the
  marker.) The list reaches the port through the host's trusted target configs,
  never through the request, its digest or a receipt. A repository without
  configured prefixes gets the earlier prompt byte for byte. The candidate's own
  protected-path check stays the enforcement.
- Owner exit: the launcher retry pass lists each target's open issues labelled
  `sentinel:retry` once per pass. For a record blocked with exactly that
  message, in the fresh park shape (no PR, no published head, no review), whose
  issue is listed, it removes the label first and re-admits the record only if
  GitHub confirms the removal. The re-admission is an ordinary uncharged work
  plan in the pass's one batch write: the protected head, checkpoint and
  candidate state are dropped (the runtime's own proven-absence target shape),
  so the next start is charged normally and begins at the current base. A failed
  removal, a closed or unlisted issue, or a lost state write re-admits nothing;
  after a lost write the owner labels the issue again, so one label is at most
  one re-admission. A park over a published pull request is not touched by this
  exit and keeps its label.
- No stored shape is added; nothing is pushed, refunded or re-counted.

## 2026-10-24: backup CI in the ubiquity-sentinel org (owner decision)

- Owner decision (2026-10-24): "primary path is to use the org's own ci but
  backup path is to use ubiquity-sentinel org as the backup".
- Finding: since 06:40 UTC GitHub has not started any Actions job in the private
  `ubiquity/passport.ubq.fi`. Every check run completes in about one second with
  conclusion `failure`, no runner, no steps and the annotation "The job was not
  started because recent account payments have failed or your spending limit
  needs to be increased". Under "current-head CI not red", 61 of the 71 open
  Passport issues cannot be reviewed or merged.
- Primary path, unchanged: the target's own CI on the exact head decides.
- Backup path: when a required check on the exact head never started (an Actions
  job with no runner and no steps), Sentinel runs that job of the target's own
  workflow file, as committed at the head, in the ubiquity-sentinel org on the
  exact pull request merge tree (the commit whose parents are exactly the
  reviewed base and the head). It runs in an isolated job with no Sentinel
  credential and only a read token for the target. The trusted host verifies the
  result's binding (repository, pull request, head, base, merge tree, workflow
  file blob, job, run identity) before it counts, and a verified success stands
  in for exactly that never-started check. A check that ran and failed is never
  overridden, and missing, stale or unverifiable backup evidence never passes.
- Activation (2026-10-25, owner directive "Get them unstuck"): the act pin is
  `v0.2.89` (released 2026-06-01, the newest release at least 14 days old). Its
  `act_Linux_x86_64.tar.gz` sha256 `0191d6f1…24c0` comes from the release's
  `checksums.txt` and matched the downloaded asset. The calibration list holds
  eight Passport commits whose `deno` check ran natively before 06:40 UTC on
  2026-10-24: six green, and two (`84557beb`, `8908b8e4`) that failed
  `bun run check` on every push and pull request run. The planner now skips
  calibration commits the runner already settled or has in flight, so later
  commits are reached; before, it re-offered only the first two, and a runner
  could never collect the five agreements the gate needs.
- The mode defaults to `on`: unset `vars.SENTINEL_BACKUP_CI` reads as `on`,
  `shadow` only observes, and any other value (`off`) disables dispatch,
  planning and consumption, like `SENTINEL_AUTO_FOLLOW`. The session cannot
  write repository variables (the Actions variables path is refused by its
  proxy). The skipped shadow stage is covered by the calibration gate: no backup
  result stands in until the runner has at least five agreements with native CI,
  one of them a failure, no false green and at most one false red. A false green
  suspends the runner automatically.
- The pass's target read token now also has `statuses: read`. Without it the
  combined status read failed, so every commit's observations read as null and
  the first live passes (2026-10-25 03:57 UTC) planned nothing and logged
  nothing. A null observation read and an unreadable repository are now logged
  (`observations_unavailable`, `repository_unavailable`).
- Planner fairness (finding 2026-10-25): every backup pass on launcher
  `e5a888244c` reported `backup-ci:plan:p=2:free=2` and planned zero units
  although runner `916ad9eaff49fe9d` was calibrated at 7 agreements. The live
  state held 17 Passport delivery heads and 53 blocked pre-review parks. The old
  planner concatenated candidates by priority and stopped after 12 reads, so the
  delivery class consumed the bound and no blocked head was examined; its
  per-head rotation was erased by the following priority/id sort. The planner
  now applies the bound to a round-robin over present priority classes
  (`backupCiScanOrder`), one candidate per class per round, with each class's
  cursor advanced by `GITHUB_RUN_ID`. p0/p1 still lead each round; no store,
  state or gate shape changes. This is a fair-scan fix, not permission to merge
  without the current-head CI, review or P0 gates.
- The first live legs failed in their install, and a hosted audit (six lenses
  with three skeptics per finding, real act v0.2.89 and the real
  download-artifact action) found the next failures before any further live
  attempt. Fixed: the install no longer chmods the act path (Deno refuses writes
  to a path granted in `--allow-run`), and `act --version` runs with a scratch
  HOME (act exits fatally without HOME and creates `~/.config/act`). Prepare
  reads the tree from `in/backup-tree-<unit>/`, where download-artifact by
  artifact id puts it. Only an actual act configuration file refuses; the
  image's `XDG_CONFIG_HOME` does not. The service drops `--gid=runner`; without
  a Group= systemd uses the user's primary group. `BACKUP_CI_LEG_REVISION` is 2,
  so the fixed leg is a new runner id: it calibrates afresh and inherits no
  backoff from the failed legs. Open (minor): a `status_only` step skipped on a
  green run leaves no act record (act logs skips at Debug), so such a green
  reads `act_inconsistent`; Passport has no such step.

## 2026-10-24: the runtime never merges a tree no CI ran on (base compare-and-swap)

- Finding (live state and GitHub, 2026-10-24): the runtime merged two Passport
  pull requests off their reviewed bases. PR 154 (record
  `issue-ubiquity-passport.ubq.fi-49`) was reviewed on `7194280c` and its merge
  commit `862a9162` has parents `95765554`,`8dbaa9fc`; PR 171 (record
  `issue-ubiquity-passport.ubq.fi-77`) was reviewed on `95765554` and merged 26
  seconds later onto PR 154's merge (`2cf5050f`, parents `862a9162`,`aa11683f`).
  Both were booked as delivered. GitHub's merge API guards only the head, the
  pull request's reported base is not updated when the base branch moves, and
  since branch rules stopped gating merges (owner directive 2026-10-24) nothing
  checked that the base still was the reviewed base at the merge call. The
  post-drain continuation (`src/repair/loop-post-drain.ts`) also called
  `executeMerge` without the moved-base refresh guard the ordinary delivery step
  runs first. The launcher already refused this (`merged_off_tip`, #156).
- Decision: the port's REST merge path (`src/github/port-merge.ts`) re-reads the
  base branch tip, uncached, as the last read before the merge call and returns
  the existing blocked `base_mismatch` outcome, with no merge call, unless it is
  exactly the reviewed base; an unreadable tip is a typed error, never a merge.
  The REST merge makes a merge commit (Passport allows it and merges that way),
  so after a merge, and when a pull request is found already merged, the port
  reads the merge commit's parents and returns `merged` only on exactly
  [reviewed base, reviewed head]. Any other landing is the new `merged_off_tip`
  outcome (merge SHA and parents), and an unreadable commit is `ambiguous`. A
  merge this call did not make on the native queue target keeps the queue's own
  proof only while the queue can merge (queue mode ceiling not `off`, or queue
  delivery proof activated; `queueMayHaveMerged`). Corrected 2026-10-25 by the
  stage-1 review: with both off, Sentinel merges ai.ubq.fi through the REST
  path, so an off-tip merge whose response was lost was otherwise booked on
  reconciliation.
- The loop parks a `merged_off_tip` outcome with its intent cleared, blocked
  `other` with the fixed `MERGED_OFF_TIP_PREFIX` message naming the merge SHA,
  its parents and the expected [base, head] pair; nothing is booked, no release
  request is written and Sentinel does not close the issue. Merge-intent
  reconciliation applies the same proof to a pull request it observes merged
  (`src/repair/merge-off-tip.ts`, through the optional `readCommitParents`; an
  unreadable commit waits one poll with the intent kept). A `base_mismatch`
  keeps its existing path: the merge intent backs off one poll and the next
  run's reconciliation replaces it with the durable base refresh.
- The post-drain continuation's fresh merge now passes the same moved-base guard
  as the delivery step (`refreshMovedBaseBeforeMerge` in
  `src/repair/loop-work.ts`): a moved base persists the refresh intent, which a
  later run executes; the continuation still never executes a refresh.
- Unchanged: current-head native review, the P0 merge block, current-head CI,
  task acceptance, custody, durable accounting and the self path's source CAS.
  No state shape changes (the outcome is a port result, never persisted; the
  park is an existing blocked transition), and the pinned generation-80 parser,
  generation 81's rollback target, parses the parked records in the tests. The
  two merges already booked stay booked; this changes no historical record.

## 2026-10-24: a GitHub Actions job that never started is not CI evidence

- Finding (live, 2026-10-24): Passport is private and its Actions payments
  failed, so GitHub has started no Passport job since 06:40 UTC. Every check run
  still appears and completes about a second later with conclusion `failure`,
  runner id 0, an empty runner name, no step and the annotation "The job was not
  started because recent account payments have failed or your spending limit
  needs to be increased". Sentinel read these as real red checks: head and base
  were both red, so every Passport record waited in the CI-first gate's
  `base_red` backoff with no end. Once billing returns and only the base re-runs
  green, the head's stale failure would be attributed to the candidate and
  charge a CI fix round. The new base-repair pass would also have filed a P0
  code-fix issue for a billing stop.
- Decision: a GitHub Actions check run that completed `failure` while its job
  (`GET /actions/jobs/{id}`; an Actions check run's id is its job's id) reports
  no step and a runner id of 0 or null, on the exact job id and commit, never
  started
  ([src/github/never-started-job.ts](../src/github/never-started-job.ts)). The
  runtime check read (`readChecks`) marks such a run with an optional
  `neverStarted` flag. Only failed Actions runs are read, the latest run of each
  name first and at most 8 per check read; a client keeps each completed job's
  verdict, and an unreadable or mismatched job keeps the run exactly as before.
- A never-started run is no evidence on either side: it is pending on the head
  (`checkPending`, never in `failedChecks`) and attributes nothing on the base
  (`unattributed`, never `base_red` and never `candidate`). The CI-first gate
  therefore waits on it in the existing bounded, uncharged `ci_pending` path and
  parks it after six hours under the pending prefix (`deno(not_started)`), which
  the launcher's re-run and green rules already re-admit. A CI fix marker on
  such a head is dropped uncharged at admission.
- The launcher's base-repair read (`failedChecks`) applies the same job rule,
  and judges only the latest run of each name, so a billing stop files no
  base-repair issue.
- A new maintenance pass resumes the CI by itself
  ([ops/hosted-autonomy-ci-resume.ts](../ops/hosted-autonomy-ci-resume.ts)). For
  each foreign target with a head waiting on CI (a live `ci_pending` or
  `backoff` wait, or a pre-review CI park, outside merge queue custody), it
  looks at the base tip and those heads. It re-runs the failed jobs of every run
  of a head (the flake pass's existing `rerun-failed-jobs` request) whose failed
  jobs of its latest attempt all never started. A run is asked at most once per
  30 minutes: its `updated_at` must be that old. Only a latest attempt that took
  at most 60 seconds costs a job listing read. One pass reads at most 32 job
  listings and sends at most 16 re-runs, inside 60 seconds, and never past
  GitHub's 30-day re-run window. Corrected 2026-10-25 by the stage-1 review:
  GitHub allows 50 re-runs per run, and a stop longer than about a day would
  have spent them all, so CI could never resume. A run at attempt 40 or more is
  now never asked again. While no run of the repository listed in the pass ran a
  job within the last hour, the wait doubles per attempt (30 minutes up to 12
  hours). The base tip is listed first and is the canary: once its re-run starts
  again, every waiting head is asked at the plain 30 minutes. Every run of a
  head is now re-run, not only the newest per workflow, because the launcher's
  green read needs every check run green and a Passport head has a pull_request
  run and two push runs of one workflow. It writes no state. Corrected
  2026-11-12: the wait now doubles up to 24 hours. At 12 hours a run reached
  attempt 40 after about 18 days, inside GitHub's 30-day window, and was never
  asked again, so a stop that lasted until the monthly minute reset (Prospector
  and Passport from 2026-11-05; the owner pays for no CI) left every pre-review
  park on `<check>(not_started)` without a fresh run on its exact head, which
  the green and CI-fix rules need to re-admit it. At 24 hours a run ends the
  window near attempt 35; the 40-attempt cap, the per-pass bounds and the
  CI-minute admission of each re-run are unchanged.
- Unchanged: the merge gate's required-check verdict (`requiredChecksState`, a
  protected path) still never treats a never-started run as green; the
  launcher's green read (`hasAllChecksGreen`) is unchanged; every CI fix is
  still charged only at its own admission after the failure is re-derived from
  live checks. A run the resume pass re-runs is past attempt 1, which the
  once-per-head flake re-run already reads as re-run, whoever re-ran it. Nothing
  new is persisted, so the generation-80 and 81 rollback readers parse every
  state this writes.

## 2026-10-25: maintenance throughput caps and the `retried` status

- Finding (maintenance runs 40133653940, 40136967547 and 40137557976 on
  2026-10-24): the `hosted_autonomy` status read `skipped`, reason `retried`,
  with no write. The only `retry:` line in each was the read-only denial
  `retry:issue-ubiquity-ai.ubq.fi-1213:denied:repeat_failure_parked:…`, which is
  named on every pass while the record stays parked, and any `retry:` line made
  a pass `retried`. The real class of all three was `already_recorded`. Two
  artificial per-pass bounds also survived the owner directive that lifted caps:
  at most 12 CI correction re-admissions per maintenance pass
  (`HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS`), and at most one launcher merge
  per pass across all repositories, so one target's merge deferred every
  reviewed green head in the other targets to a later pass.
- Decision: `HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS` is
  `Number.MAX_SAFE_INTEGER`, the way the conflict-resolution throttle was
  retired. The constant stays for importers. Every correction candidate whose
  pull request reads open is re-admitted in the same pass.
- The delivery pass calls merge at most once per repository per pass (a set of
  scope keys). A merge moves only its own repository's tip, so another
  repository's reviewed head still merges in the same pass. Each merge keeps
  every gate: the uncached tip re-read right before the call, green CI on the
  exact head, the current-head receipt with no unresolved P0, the task re-read
  and the merge-commit parent check. Within one repository the bound is
  unchanged: once merge was called there, whatever it answered, every later open
  pull request of that repository is `merge_deferred` for the pass, because a
  second merge would land on a tree no CI ran on. Correction (stage-1 review,
  2026-10-25): this holds for foreign targets only. A Gateway or self merge or
  booking writes the delivery state and ends the delivery phase for the pass
  (`ops/hosted-autonomy-delivery-pass.ts`), and records are visited in id order,
  so an ai.ubq.fi booking still defers the Passport and Sentinel merges to the
  next pass. This costs throughput only; every per-merge gate holds.
- `retried` is decided only from the three lines the retry pass pushes after its
  own verified write: `retry:<id>:grant=<n>:…`, `retry:<id>:readmit:…` and
  `retry:<id>:parked:repeat_failure:…`
  ([ops/hosted-autonomy-retry-actions.ts](../ops/hosted-autonomy-retry-actions.ts)).
  A repeated `denied:` or `skipped:` line no longer makes a pass `retried`. A
  pass that wrote nothing reports its own class, a delivery write after only
  denials reports `applied`, and an unreadable self tip reports `base_moved`.
- A non-carried review or delivery record outside the Gateway, whose reviewed
  base is not the tip this pass already read for its repository, now has only
  its pull request read, like a spent record behind the tip (#156). An unmerged
  pull request reports `base_moved` without the source-issue read. Every gate it
  could reach refuses it `base_moved` before any effect, because the moved-base
  rule is Gateway-only. A merged pull request goes on to the ordinary booking
  path, so the lost write of a merge that moved the tip itself is still booked.
  No tip is read early for this rule, and a self delivery that is already
  recorded keeps its read-free `already_recorded`. The only visible difference
  is the label of a no-effect refusal: such a record now reports `base_moved`
  where it could report a task or author refusal before.
- Unchanged: review rounds, durable reservations and their settlement, the
  proven-runtime rule for corrections, current-head CI and review, the P0 merge
  block, custody and the historical readers. Nothing is refunded, re-counted or
  charged by these changes.

## 2026-10-25: a head held by its red base holds no delivery line; retired records cost no read

- Finding (live state, 2026-10-24 23:13 UTC): Passport records 13 (PR 161) and
  14 (PR 162) sat at `work` on the tip with their refreshed heads held by the
  CI-first gate's `base_red` backoff and stood `re_review` in the delivery line,
  so all 22 reviewed Passport records with a round left deferred behind them for
  18 hours. The hold waits for a base move, only a merge moves the tip, and the
  line held every record whose merge could move it; only the stall rule (12
  re-arms of a 30-minute hold) ever released it.
- Finding (same state): 115 of the 388 non-done records were already retired
  (`HOSTED_AUTONOMY_RETIRED`). Every maintenance pass still read each one's
  source issue, one sequential read each (the context phase that runs these
  reads took 85 seconds), and the closure pass read the pull request of the 24
  that had one, although the retirement plan never plans a retired record again
  and no rule acts on a retired record's issue or pull.
- Decision: a contender on the tip whose wait is a red base's hold still running
  (`isRedBaseHold`: a `backoff` that rechecks `RED_BASE_RECHECK_MS` or more
  after its start, which only the red-base holds of the CI-first gate, the
  pre-review fix, the pre-merge correction and the carried gate write) and that
  would otherwise stand `re_review` (a round left) stands `waiting` and holds
  nobody. Once the hold is due it stands as before until its own step re-arms
  the hold or moves on
  ([src/repair/delivery-queue.ts](../src/repair/delivery-queue.ts)). Corrected
  2026-10-25 by the stage-1 review: a spent carried head or a delivering head
  keeps standing `landing` under the hold. Releasing the records behind it would
  refresh each spent deliverable record onto the red tip, where the carried
  gate's six-hour bound parks it for good.
- A running CI wait (`ci_pending`) keeps holding: the wait records neither the
  checks nor whether its jobs started, so one whose jobs never started cannot be
  told from running CI, and the line on the tip must keep holding behind running
  CI. Such a wait is bounded by the stall rule at the five-minute poll (about an
  hour). The never-started billing failure itself completes as `failure` and
  lands in the red-base hold.
- Cost: while a base stays red, reviewed records refresh onto it one at a time
  and wait there; once a merge repairs the base they refresh and are reviewed
  again in parallel, which the line used to delay until the stall release. A
  record whose own change passes on the red base, or a base-repair pull request
  whose base moved, no longer waits behind a head that cannot move.
- Decision: the launcher reads no source issue for a retired record and no pull
  request in the closed-unmerged scan for one
  ([ops/hosted-autonomy-closed-issues.ts](../ops/hosted-autonomy-closed-issues.ts)).
  A retired record's issue is still read while a record that is not retired
  shares its issue (a decomposition part). No verdict changes: on the pre-change
  code a retired record's whole pass was identical whether its issue read
  closed, open or unreadable. The remaining issue reads run at most four at a
  time, started and applied in record order (the same facts, `seen` ids and
  actions).
- Unchanged: the line writes nothing (under generation 80, the rollback target,
  the line holds behind such a head again, which is only slower), the CI fix
  marker, the carried-merge marker and every standing on a moved base,
  current-head CI, native review, the P0 merge block, custody and accounting.

## 2026-10-24: a red target base gets its own repair (base-repair lane)

- 2026-10-25 status: the review findings below are fixed; filing stays off
  (`BASE_REPAIR_FILING_ENABLED = false`) until the reworked lane's own
  adversarial re-review passes. The lane's adversarial review had upheld a P1
  (it filed for any failing tip check, including Passport's dispatch-only
  `Workers Standby Deploy` and `deploy-standby` jobs that no pull request runs,
  so a charged task could loop), P2s (one unfiltered page of 100 open issues
  with no author check; a closed issue refiled for the same tip; a stale open
  issue suppressing every later one; a P0 label Passport does not have and
  ai.ubq.fi does not use; the lane's files unprotected) and P3s (an unavailable
  issue read read as "not a base-repair task", secondary cancelled checks and a
  "passed on its base" claim in the fix finding, a conversion on a base that had
  already moved, untrusted check names in the issue, a red set unlike the
  runtime's, and a wrong note on the self scope). Filing was off from 027ecbbea0
  until this change.

- Finding (live state, 2026-10-24 23:00 UTC): all 39 Passport records at `work`
  were held by the CI-first gate's `base_red` rule. Their failing check is red
  on Passport `main` too, so they back off uncharged until "a later base move".
  Two of them held the delivery line for the 22 reviewed Passport PRs behind
  them. A red base can only move by a merge, and no merge passes a red base, so
  nothing in Sentinel was assigned to fix it and the whole target stayed wedged.
- Decision: the launcher's maintenance pass looks at every foreign target with a
  record the CI-first gate holds on a red base (at `work` with a published head,
  in a running red-base hold, `isRedBaseHold`), sharing the follow-up pass's one
  state read
  ([ops/hosted-autonomy-base-repair.ts](../ops/hosted-autonomy-base-repair.ts)).
  It reads the base tip; only held records whose base is that tip count (a
  record on an older base refreshes onto the tip first). It reads the tip's
  failed checks with the runtime's red-base conclusions (`RED_BASE_CONCLUSIONS`:
  `failure`, `timed_out`, `action_required`) and the failed checks of the first
  three such held heads in record-id order with the head conclusions a red base
  can hold (`CANDIDATE_CONCLUSIONS`: `failure`, `timed_out`). Both reads take
  the latest run of each name and leave out a job that never started. Only a
  check failing on the tip and on a held head holds anything, so the issue lists
  only those, through the runtime's trusted check-name shape
  (`trustedCheckName`), and nothing is filed when there is none
  (`base-repair:<repo>:no_held_check`). Any unreadable tip, head or listing
  files nothing.
- The issue is titled `CI is failing on <branch>`, carries no label, and its
  first body line is `<!-- sentinel:base-repair:<branch>@<tip> -->`. Before
  filing, the pass reads every issue the App created in that repository
  (`GET /issues?creator=ubiquity-sentinel[bot]&state=all`, oldest first, up to
  20 pages of 100; another creator, a repeated or malformed item, or a full page
  at the bound refuses the whole listing). It files nothing when any App issue,
  open or closed, already carries the marker for this tip, so a tip gets at most
  one issue. While an App issue marked for an older tip of the branch (or with
  the first, tip-less marker) is open, a new issue is filed only once every
  record of that issue is parked or done; an issue with no record yet still
  counts as live. The pass writes no state and never edits, closes or comments
  on an issue. The self scope has no base-repair lane: the pass never reads or
  files for it.
- The runtime admits the issue like any other, at the ordinary priority of an
  unlabelled issue. For that task alone (the issue the App authored with the
  marker on its first body line; no label, no severity and no other check;
  `src/repair/base-repair.ts`), a `base_red` failure is the candidate's own
  failure on the current tip: its head still fails the checks it was filed to
  fix, so it takes the ordinary charged CI fix route instead of the uncharged
  hold. The fix names exactly the checks red on both (never a secondary
  cancelled one). The issue is read only for a `base_red` disposition and once
  per run. An unavailable issue read or tip read defers through the callers'
  existing unavailable path without a write. A record whose base is no longer
  the tip keeps `base_red`, so a moved base refreshes it first, uncharged
  (before a refresh the delivery gate corrects only a candidate failure). A
  closed issue is still refused before any charge, as every task is
  (`readIssueForModel`).
- The fix finding has its own opening,
  `Required CI checks failed on this
  candidate and on its red base`, which
  `isCiCorrectionFinding` recognises beside the ordinary one, so it never claims
  that the checks passed on the base. A hosted fix runs as a matrix cell that a
  later run may consume under the rollback target's code, and a consumer that
  does not recognise the opening refuses the cell generically, which fails every
  later repair run (the R79 precedent). Hosted runs therefore keep the ordinary
  opening until the installed rollback target is a runtime at or after this
  change (`HOSTED_BASE_REPAIR_FINDING`, off); in process the own opening is
  always used. Under a rollback to the previous runtime nothing else changes: it
  recognises the task only with a P0 severity (a `P0` label), which the issue is
  not filed with, so it keeps the uncharged hold; an issue a person labels P0
  gets that runtime's earlier conversion with the ordinary opening.
- `src/repair/base-repair.ts` (with the CI-first gate) and
  `ops/hosted-autonomy-base-repair.ts` (with the App-token issue filing) are
  protected paths, so a model-authored candidate never changes the lane.
- Unchanged: current-head CI, native review, the P0 merge block, custody and
  accounting. The fix merges through the ordinary gates; its pull request closes
  the issue, and every held record then refreshes onto the green base.

## 2026-10-24: private state clones skip git's background maintenance

- Finding (CI flake on `ca87acea8a`, reproduced): git 2.55 on the CI runners
  (and on the hosted runtime's runners) detaches `git maintenance run --auto`
  after a fetch, and since 2.54 its geometric repack may still be deleting loose
  objects in Sentinel's private state scratch clone while the repair history
  cache measures it (`diskBytes` NotFound). The read then reports
  `historical repair cache unavailable`. Locally git 2.43 never runs it; under
  git 2.56 with the repack condition forced, four history-cache tests fail.
- Decision: the state transport's fetch passes `--no-auto-gc`, as
  `src/host/actions-candidates-proof.ts` already does for its stores. The
  scratch clones are read once and deleted, so skipping their maintenance
  changes nothing else. Every live caller of `readRepairAt` (queue provenance,
  existing-PR takeover, maintenance publication, matrix recovery, matrix
  uncertainty) stops seeing the spurious unavailable read.

## 2026-10-24: recover the native review envelope's escaping slips

- Finding: Codex 0.154.0 runs review mode without an output schema
  (`final_output_json_schema: None` in `core/src/tasks/review.rs`) and returns
  the reviewer's free-text `overall_explanation`. Sentinel's envelope JSON sits
  inside that string, so the reviewer escapes it by hand. A missed or doubled
  escape made the strict parse fail (`json_syntax`) on about one review in three
  today (PR 211 twice, ai.ubq.fi 1258), and each failure spent a round.
- Decision: when the strict parse of the envelope fails, the parser retries it
  on deterministic rewrites of those slips
  ([src/github/native-review-envelope-repair.ts](../src/github/native-review-envelope-repair.ts)):
  one whole extra layer of string escaping (decoded tolerantly, so a second slip
  inside it is still rewritten), raw control characters inside a string, a
  double quote inside an object member's string value that no JSON delimiter
  follows, an invalid escape (`\u` without four hex digits included; kept as a
  literal backslash), and a trailing comma. An unescaped quote inside an array
  element is not rewritten: it could split or merge `taskAcceptance.evidence`
  entries, which nothing cross-checks, so such a text stays refused.
- Every candidate goes through the same strict parser, so duplicate keys and
  trailing content still refuse. The exact envelope keys, the snapshot binding,
  the strict result shape and the native findings cross-check are unchanged. A
  text no rewrite recovers, and a recovered text that a later check refuses,
  keep the fixed `json_syntax` category.
- The review request also asks the reviewer to keep every RESULT string, and
  each native finding's title and body, free of double quote characters. That
  request is Sentinel's own text in `review/start`; the vendored rubric and
  native review mode are unchanged.
- Adversarial review: three lenses with three skeptics per finding upheld eight
  P3 findings on the first version (array splits, `\u`, category drift, the
  instruction's scope, a doubled layer with a second slip); all are fixed and
  each has a regression test that fails without its fix.

## 2026-10-24: one fresh proof store per target per maintenance pass (#185)

- Finding: the maintenance `current_matrix` walk preserved about one candidate
  every 15 s and ended on its 300 s budget (`deferred_budget`), so each run
  recovered roughly one producer wave. Every preservation's durability proof
  (`freshStoreProof`,
  [src/host/actions-candidates-proof.ts](../src/host/actions-candidates-proof.ts))
  ran `git init --bare` and fetched the target's full history into a new empty
  store.
- Decision: each producer pass (`recoverHostedMatrixProducer`) owns one
  `CandidateProofPassV1`, and builds its ingest cycle and every preservation of
  a target with it (`cycleFor(config, proofPass)`). The first proof of the pass
  for a target creates ONE new empty bare store in the run's private scratch and
  pays the history fetch. Every later proof of that pass fetches its own exact
  operation ref into the same store, which transfers only the objects the store
  lacks: each fully proved head is recorded there as a private
  `refs/sentinel-proved/<head>` negotiation ref.
- Every per-candidate check still runs for every proof in that store:
  `FETCH_HEAD` equals the head; no shallow, replace or alternate masking; the
  exact head, base and published-head commits; ancestry; and credential-free
  publication validation. The source-mirror import and validation are unchanged.
- The store only receives objects fetched from the fixed target remote during
  that pass, and automatic gc is off for those fetches. A failed proof ends the
  store's reuse the way a one-off store ends: it is removed when every child
  settled, and kept for diagnosis after an unproved settlement or a validator
  refusal. The next proof starts over in a new empty store. The pass closes its
  stores when it ends, so a store is never reused across passes or runs.
- The proof still shows that the remote's exact ref holds the head and that the
  head's full graph is present. Objects an earlier proof of the same pass
  fetched came from the same remote, which confirmed the common commits during
  negotiation; this is accepted as equivalent to a per-candidate empty store.
- Every other caller (runtime preservation, published-refresh validation, the
  `existing_candidate_refs` phase and the closed-C ingest) still creates one
  store per proof. The walk budget is unchanged; letting preservation continue
  past the walk deadline under its own bound was not needed.

## 2026-10-24: one in-place retry for a bootstrap that never started (#191)

- A launcher self-install bootstrap that never reached its startup-ready marker
  no longer burns the SHA. That covers a `not_started` settlement, and a failed
  run whose child never attested `startupReady`: runner loss, a cancellation
  before start, a failed fetch or a failed Codex preflight. The installation
  journals that first settlement as `retriedBootstrapProof` and stays
  `bootstrapping`, with models still stopped. The next supervisor run of the
  same launcher starts exactly one more model-disabled bootstrap of the same SHA
  at the same pointer. The generation stays `previousGeneration + 1`, because a
  revision never changes generation. A new execution id rebinds
  `bootstrapExecutionId`.
- A run that reached startup-ready and then failed actually executed. It
  journals the exact recorded-prior rollback immediately, as before. The retry
  journals the rollback on any outcome other than healthy, including a second
  run that never started. Rollback still restores the recorded prior at
  `previousGeneration + 2`, and the failed SHA still cannot reinstall.
- The retry cannot repeat. The state validator rebinds the execution only while
  the journaled first attempt still owns it, at the exact candidate pointer and
  with an idle runtime. Once journaled, the retry proof never changes. A record
  that never retried keeps its earlier exact shape. The dispatcher's follow
  reader and the rollback child's projection (which omits installations) read
  retried journals unchanged.

## 2026-10-24: carried release acceptance and closure (#152)

- A carried merge books a production release request that names the receipt of
  an earlier head H0 on B0 and gives the merged refreshed head H1 on tip T as
  its source ("Spent records on a moved base" above). Release acceptance and
  issue closure now accept such a request only through the carried binders:
  `carriedGatewayRequestBindsDelivery` (Gateway, beside the exact binder in
  `src/repair/vps-delivery.ts`) and `releaseDeliveryTaskRefusal` (the carried
  variant of `deliveryTaskRefusal`, `src/repair/carried-release.ts`). The
  receipt must be a completed review of an earlier head of the same pull request
  in the same repository, by the fixed reviewer (the runtime port's
  `reviewerIdentity`; on the launcher, the App), with nothing uncounted and no
  unresolved P0, that accepted the record's own issue (`carriedReleaseReceipt`).
- Each binder re-derives the patch proof between H0/B0 and H1/T with the
  caller's existing proof: the runtime's git proof (`proveCarriedPatch`, decided
  by `carriedPatchHolds`) or the launcher's exact tree proof
  (`carriedPatchRefusal` over `mergeBaseTreeChanges`). It then authorizes the
  task through the shared predicate as of `reviewedIdentity(record, receipt)`
  and the trusted live task. The runtime derives the proof at most once per
  step, the launcher at most once per pass.
- The runtime uses the carried binders in `observeGatewayVpsDelivery` (its
  optional `carried` prover), in `acceptRelease` for the self and Gateway
  scopes, and in `retryClosure`. The launcher uses them in `gatewayClosureGate`,
  and its closure pass authorizes a carried Gateway delivery through
  `releaseAuthorizingReceipt` (`ops/hosted-autonomy-carried-release.ts`). Every
  Gateway closure write still follows a `gatewayClosureGate` call that
  re-derives the proof.
- A request whose patch no longer proves is refused. This covers changed digests
  or change sets, a refreshed head that is not on its tip, and on the launcher a
  protected path. A Gateway request then does not bind and its record waits
  beside it. A self delivery is blocked `missing_evidence` with
  `MERGE_WITHOUT_REVIEW_DETAIL`, as any unauthorized delivery is. An unreadable
  proof waits, and a runtime without the proof capability never binds a carried
  request.
- Non-carried requests are unchanged. The exact binders run first, exactly as
  before. The carried binder never binds a receipt of the record's own head and
  reads no proof for one.
- Both new modules (`src/repair/carried-release.ts`,
  `ops/hosted-autonomy-carried-release.ts`) join the hosted-authority protected
  paths beside `src/repair/vps-delivery.ts`, the gateway delivery binding #158
  protects, so a model candidate can neither publish nor merge a change to them.
- Not changed: the launcher's self closure (`planHostedClosures`) keeps the
  exact authorization, and the runtime's `acceptRelease` closes a carried self
  delivery. The native-queue authority keeps the exact binder, because no
  carried merge goes through the queue.
- No state shape is added. The writes are the closure intent and the `done` and
  blocked transitions the exact path already writes. Rollback: R79, R80 and
  earlier launchers keep their exact binder and answer `wait` for a carried
  Gateway request before any release read, as before (the runtime re-arms its
  release wait; a closure intent this runtime wrote is kept and never consumed).
  For an accepted carried self delivery they block the record
  `missing_evidence`, as before.
- `sentinel-release` stays disabled and nothing is enabled. Until the release
  ref records a carried request, it is release-deferred like any other (JAM
  B12).

## 2026-10-24: definitely unsent queue admissions are reconciled without losing custody (#169)

- A gateway queue admission whose every attempt the native client proved
  `not_submitted` (first admission, no refusal, queue failure, re-admission or
  dequeue marker, native request or result identity) no longer holds its pull
  until the six-hour `admission_unresolved` owner park once a later preflight
  refuses it. When the fresh authorization decision is a refusal (`hold`) and a
  fresh read of the effective `merge_queue` rule is authenticated negative, the
  queue prelude (`reconcileNotSubmitted` in
  `ops/hosted-autonomy-queue-reconcile.ts`) clears the queue intent and returns
  the open-ended hold to the transient wait #180 uses, so the ordinary runtime
  path re-observes the record. Under an active or unknown rule the record keeps
  its retryable unsent custody: the runtime's direct path would refuse it
  `queue_required` and hold it with no intent for good (review finding, upheld 3
  of 3). A later native entry is taken into custody again by the next complete
  scan.
- The pull must be absent from every read of that pass: the pass's initial queue
  snapshot, one more fresh queue scan, the membership read and the coordinator's
  authorization membership (`hasConsistentQueueAbsence` in
  `ops/hosted-autonomy-queue-policy.ts`). An entry in any one of them, a merged
  revision, a moved head or another pull identity, an incomplete read or
  authorization fact, durable queue provenance, a matching release request or
  the pass deadline keeps strict custody.
- The submission (`ops/hosted-autonomy-queue-submit.ts`) is the only place that
  knows no effect followed its freshly committed intent. When its own preflight
  refuses (an authenticated negative `merge_queue` rule or a `hold` decision)
  and the same four reads agree on absence, it records `not_submitted` for a
  first admission or a retry of a not-submitted result; otherwise the pre-effect
  `unresolved`/`ambiguous` mark stays. An unknown rule, a lost CAS on the
  recording write and a late enqueue response that could not be recorded after a
  moved state head stay uncertain, never reconciled, and reach the owner park as
  before.
- An authorized unsent admission keeps its bounded retry (six-hour admission
  age, three definitive refusals); a kill switch alone is not a refusal; elapsed
  time never clears an intent. Reservations stay charged and are never refunded,
  and review rounds, CI-fix limits and the at-most-once enqueue are unchanged.
  The production queue stays disabled (`queue.proofActivated` off, empty
  authority pins), so this path cannot run until a reviewed queue rollout.

## 2026-10-24: exits from the review ceiling's silent dead ends (#155)

- Legacy head red through its base, on a moved base. This is a legacy record
  whose final round is open and whose red reviewed head is red because its
  reviewed base B0 is red, or because no base evidence attributes the failure.
  B0 is a fixed commit and never turns green. Once the development tip is
  complete and green, the head takes the same uncharged mechanical refresh a
  green spent head takes, carrying its review (`holdUncorrectableLegacyHead`,
  `carryReviewedHead` in `src/repair/loop-carried-delivery.ts`). The refreshed
  head's own CI then decides through the existing carried delivery: green goes
  to the launcher's carried merge, and red parks under the ceiling prefix as for
  every carried head. Nothing is charged and no review round is spent.
- While the tip is red or pending, the record waits at `delivery` in a
  `ci_pending` wait, so it holds nobody in the delivery line. The wait is
  bounded by 6 hours. A head whose latest review does not authorize carrying it,
  or one still waiting at the bound, parks with a precise blocker:
  `CI checks failed on the red reviewed base: …` when base evidence exists, or
  `CI checks failed without base evidence: …`. Both stay in the legacy class
  shape. No rule re-admits either park on a moved base, so the record parks
  until the owner acts. Every maintenance pass names it as
  `retry:<id>:denied:legacy_base_red` or `retry:<id>:denied:legacy_unattributed`
  (the unattributed one only while its base is not the tip). At most 12 are
  named per pass, then `retry:legacy_held:denied:held_more=<n>`.
- Item 2 (a no-verdict attempt spends the legacy final round) is not
  implemented. A one-re-request rule was built, but its adversarial review (five
  claims upheld 3 of 3, all P3) found that, combined with the raised-ceiling
  re-admission of 2026-10-24, it reopened records already parked UNREVIEWED
  outside the CI-first gating, ran before the final review's own receipt was in
  the snapshot, and left a concluded intent in place. The legacy final round
  stays spent by its admission, verdict or not, like every round; the five-round
  ceiling of CI-first-era records already absorbs no-verdict attempts there.
  Whether legacy records get the re-request is an owner decision.
- A review intent in flight at the ceiling no longer defers forever. A
  `review_request` intent whose own journal concluded without a verdict, or one
  started 6 hours ago or more, is recovered as `recoverExpiredReviewAttempt`
  does. Its round is counted once and the intent is cleared, with its charge
  kept: never refunded or moved. The record parks in the same write with the
  fixed ceiling message its reviews select (`reviewRoundCeilingGate`,
  `src/repair/loop-review-round-cap.ts`). Other intents still finish first. This
  covers live 264's shape (counter 0, three charges) and a 647-shaped record
  (counter 3, four charges) holding an already counted intent
  (`tests/repair/review-round-cap-intent_test.ts`).
- CI fix budgets are lifetime counts. `counters.retries` was written by older
  generations and was not reset at the CI-first activation. A row that carries
  retries from them starts generation 80 with those CI fixes spent: at state
  719d8f30d issue-ubiquity-sentinel-61 (retries 3) gets none, sentinel-76 (2)
  gets one and sentinel-21 (1) gets two. Counting only `retry` charges admitted
  after the activation is not derivable safely. Every implementation admission
  after the first is a `retry` charge, whether it is a P0 correction, a conflict
  resolution, a retried implementation or a CI fix. The comment in
  `src/repair/ci-first-policy.ts` is corrected. Resetting such rows is an owner
  decision.

## 2026-10-25: isolated CI workers

The owner requested faster CI with lower runner use.

- `modules` and the three host shards run four worker processes each.
- `integration` keeps one worker.
- Each worker gets a temporary `HOME` and `DENO_DIR`.
- Every worker invokes `test-local.ts` for its assigned files.
- The planner checks exactly-once file coverage and balances the file costs.
- `SENTINEL_TEST_JOBS` selects the worker count.
- The `test-local` aggregate keeps all existing quality and shard gates.
- Superseded PR and non-development runs are cancelled.
- A newer run does not cancel running `development` CI.

PR #217 and its measured CI results are recorded in `build-status.md`.

## 2026-10-31: no per-pass, per-repository merge count in the delivery pass

Owner directive (2026-10-31, throughput): deliveries per hour must rise. The
launcher delivery pass used to merge at most once per repository per pass while
a maintenance pass takes 25-55 minutes.

- Supersedes the delivery-pass bullets of "2026-10-25: maintenance throughput
  caps and the `retried` status" (`docs/DECISIONS.md:3378-3385`: "The delivery
  pass calls merge at most once per repository per pass (a set of scope keys) …
  every later open pull request of that repository is `merge_deferred` for the
  pass") and of "Spent-round delivery and review follow-ups (2026-10-16,
  launcher only)" (`docs/DECISIONS.md:1973-1982`: "calls merge at most once …
  every later open pull request in that pass is `merge_deferred` before any gate
  is read"). The `mergedRepositories` set, the `merge_deferred` action and the
  count they enforced are gone.
- Records are visited oldest first (`createdAt`, then the record id as the
  tie-break), never list position, so two passes over the same snapshot attempt
  the same candidates in the same sequence.
- Every merge keeps every gate unchanged: current-head CI on the exact head not
  red, the completed current-head native review with no unresolved P0, task
  acceptance, queue custody, the exact reviewed head and the merge-commit parent
  check. Durable admission and settlement (reservations, charges, accounting
  rows) stay per merge.
- The replaced count is base re-verification. A merge call, whatever it answers
  (merged, refused, lost or thrown), may have moved that repository's tip, so
  the pass drops its cached `deliveryTips` and `tipGreen` entries for the scope
  at the call, and the next candidate re-reads its own repository's tip and re-
  reads it uncached immediately before its merge call. A candidate whose
  reviewed base is not that tip is refused by the existing `base_moved` (or
  `carried_base_moved`) gate and waits for a later pass; it never merges onto a
  commit whose CI nobody checked. Candidates in different repositories are
  independent, and a refused merge no longer defers its own repository's other
  candidates.
- The only per-pass bound left in this phase is the run window: the deadline
  check at the top of every iteration, which defers the rest instead of an
  artificial count.
- Unchanged: a Gateway or self merge/booking still writes delivery state and
  ends the delivery phase for that pass, so it is still one delivery write per
  pass on those targets (the correction in the 2026-10-25 entry); that write
  owns the release request and is not another count.
- Model check: `mergeSlotFairness` in `tests/model/fleet.ts` no longer anchors a
  merge slot. It pins the cache invalidation that replaces it and shows the
  refused record's sibling merging in the same pass, and
  `J3:delivery:no-merge-slot` is no longer a known jam. The moved-tip refusal is
  proved by `tests/host/hosted-autonomy-merge-per-repository_test.ts`.

## 2026-11-05: throughput plan implementation (#340)

Owner tracking issue #340 (2026-11-04 productivity audit) maps sixteen child
issues. This entry records the policy each child changes; the integrated
candidate, its local evidence and the open hosted assertions are in
`docs/build-status.md`. Every child keeps one trusted writer per state
surface, no model access to state, credentials or promotion, durable
reservations and accounting, the current-head review and CI gates, and no new
scheduled or background mechanism beyond the five-minute dispatch and the
`workflow_run` chain.

### State-shape changes and rollback (applies to every child below)

The repair state and its sidecars gain new optional keys and directories:
the `deployment` wait reason (#337), attempt-memory `inputs` (#334),
`targetCapabilities/` (#332), `repair-archive/` (#324, #325), work-record
`stepInputs` (#326), wait `cause` (#335), and the metrics sidecar ref
`refs/heads/sentinel-state/metrics` (#338, #327). A runtime from before this
revision rejects a tree that carries them. This is acceptable under the
launcher self-install sequence: a new revision installs with a
model-disabled bootstrap that is now a health pass writing no record (#336),
and automatic rollback happens only when that bootstrap fails, before any
ordinary pass has written the new shapes. A later manual rollback past this
revision requires promoting the cold tier and removing the new rows first;
the integration owner records that rule here rather than adding a version
bump to every contract.

### #327 deferred upkeep never fails the run

`historical_quarantine_incomplete` is split. A fixed allowlist of
missing-input refusals ("unavailable", "unproven", absent custody, raised
before any settlement or block write) is a deferred upkeep result: the
maintenance job reports `skipped` / `deferred_historical_quarantine`, writes
nothing and exits 0, so prepare, planning, repair and delivery continue.
Changed bindings or custody, an outside witness, ambiguous artifact
provenance, redacted or unknown errors, and any refusal after a write started
still fail closed. Maintenance publishes `upkeepDeferral`; finalize (which now
needs `maintenance`) keeps a bounded streak on the metrics sidecar and claims
exactly one non-sensitive notice (title, reason code, run id) on the third
consecutive deferral, through an injected notice port whose only adapter is a
log and step-summary line. A real ntfy adapter needs an owner topic/secret
decision.

### #338 throughput metrics and #339 report

Finalize writes one strict `ThroughputMetricsRecordV1` per cycle to
`refs/heads/sentinel-state/metrics` (`throughput/<UTC date>.jsonl`, newest
2,000 kept; older folded into `throughput/daily.jsonl`, 400 days). Records
are at most 1,024 bytes with 32-character strings and no URL-shaped values;
writes are expected-head and non-force and a duplicate cycle is never written
twice. Unobserved fields are null, never invented. `sentinel report --since
<date> [--until <date>]` is read-only over that ref and the repair snapshot
and prints `n/a (not recorded)` for anything the data does not carry.

### #335 planner refusal and wait causes

The planner records one refusal reason per pass (`deadline_margin`,
`no_ready_records`, `reservation_denied`, `provider_unavailable`,
`target_unavailable`) and the count of ready records it did not plan, on the
plan diagnostic line that finalize reads. `backoff`/`unavailable` waits carry
an optional bounded `cause` (port, status class, reason code; no bodies or
URLs), enabled for hosted runs; the per-cycle record carries a bounded
`waitCauses` histogram.

### #326 batched live reads and changed-input stepping

The step loop reads live inputs once per repository per pass through one
read-only GraphQL request (`readLiveInputs`); a failed batch is unavailable
and the per-record reads are used instead. Each stepped or deferred record is
stamped with an input fingerprint (`stepInputs {digest, deadline}`) in the
pass's existing expected-head write; a record whose fingerprint is unchanged
before its deadline (the earlier of its wait deadline and 30 minutes) is
skipped with no write and no charge, and the skip reason is counted on the
`sentinel_repair_pass` line. Records woken by a completed review are always
stepped.

### #324 hot and cold repair state, #325 release-deferred disposition

Cold records live under `repair-archive/<collection>/` on the same ref. The
hot read (`readRepair`, `readRepairAt`, history views) never lists or parses
the cold subtree; readers that need the full ledger use `readRepairTiered`.
The trusted writer demotes whole families (work record, reservations,
completed reviews, terminal release requests) only when the record is done
or blocked with no intent, its issue is absent from a complete open-issue
listing, nothing hot depends on it, every reservation is terminal and outside
the 7-day accounting window, and no id is protected; moves re-point the same
blob ids and the candidate is re-read before push. Demotion is budgeted and
deferred; promotion of a reopened family is never deferred. While the release
path is disabled, a family holding an open release request (a done record, or
a delivery record waiting only on that request) is demoted unchanged under
the same guards; ai.ubq.fi delivery records stay hot until the merge-accepted
step completes them. When the release path is enabled the same writer
promotes those families unchanged, bounded per pass and only after reading
each target tip; a promoted open request whose revision is no longer the tip
is recorded `cancelled` with reason "release request superseded", which the
existing cancelled/failed path treats as terminal delivery evidence. Nothing
is deleted, refunded or rewritten.

### #333 pre-reservation checks and #334 identical-attempt refusal

Deterministic admission checks run before `reserveModelStart`
(`src/repair/pre-reservation-checks.ts`): repository and task identity, base
SHA, source freshness, the `<!-- sentinel:skip -->` marker, candidate ref
naming, denylist and session-bound validity, reservation collisions and the
budget transition. A refused record is blocked as `model admission refused:
pre-reservation <check>: <reason>` with nothing reserved or charged;
post-inference refusals name their check. The implementer prompt carries the
protected-path denylist and the publication bounds. Attempt memory gains an
optional `inputs` fingerprint over base tip, candidate head identity, latest
review findings digest and runtime revision; the second identical fingerprint
is refused before reservation as `identical_attempt_refused: prior attempt
<id>` and the next distinct attempt's prompt carries that fact. A refused
record is re-granted to `work` only when its inputs have changed.

### #332 target capability

Targets without a named policy are verified once per default-branch tip and
runtime generation (`targetCapabilities`). Capable means a `pull_request`
workflow exists; a local verify command or backup-CI listing alone is
recorded but is not capability, because backup CI only re-runs the target's
own workflow. An incapable target admits no records and gets exactly one
owner-action issue (first line `<!-- sentinel:skip -->`, second line
`<!-- sentinel:target-capability -->`), created once, found again by its
marker when the recording write was lost, and edited only when the missing
list changes. When capability appears, no-CI parks without an intent return
to `work` with counters and charges unchanged.

### #329 just-in-time refresh, #330 delivery trains, #331 squash, #337 delivery checks

A reviewed head keeps its reviewed base until it is next to land. The line is
ordered oldest first by `createdAt`, then id; a base-refresh intent, or a
head refreshed onto the tip since its latest review, holds every other
record of the repository until it merges, stalls, idles or is held by its red
base, and siblings refresh, push and request nothing. `CARRIED_REFRESH_LIMIT`
(6) and the 6-hour carried wait bound only head-of-line refreshes. This
supersedes the "waits only behind a landing contender or a ready one with a
lower number" wording and the PR-number line order.

For a foreign, non-Gateway target, the ready reviewed records of one
repository land as one validated train per pass, extending the 2026-10-31
entry: T' = tip ⊕ p1…pk is composed by the deterministic merge-tree
executor, each member joins only when its reviewed patch is carried byte for
byte, T' is published on `refs/heads/sentinel-trains/<op>` with intent
persisted first, and CI runs once on it. On green the members merge in line
order, each with its own expected-head merge, persisted intent and verified
landing (parent = previous landing, tree = train tree); per-merge
reservations and accounting are unchanged. On red the newest member is
dropped with the run id and check name as its wait reason and the train
retries once in the same pass, with no second bisect; unavailable CI is not
red. Conflicting members leave the train and keep the single head-of-line
refresh. While a train is open no other merge is made in that repository.
Self and Gateway merges still write delivery state and end the delivery
phase.

Target pull requests are delivered by squash under the trusted per-target
policy `mergeMethod: "squash" | "merge"` (`src/contracts/target-delivery.ts`,
default squash, never in `sentinel.targets.json`), only where the repository
reports `allow_squash_merge: true`; a target that forbids squash keeps merge
commits, and an invalid value or unreadable setting refuses the merge and
never falls back. The squash commit is the PR title plus its `Resolves #N`
line; the reviewed head SHA is still the merge input and the expected-head
guard is unchanged. The post-merge check accepts a squash commit whose single
parent is exactly the reviewed base and whose tree equals the reviewed head's
tree; anything else is `merged_off_tip`, and an unread tree is never booked.

Per-target policy `requiredForDelivery` names checks beyond the required
set (`src/host/target-delivery-checks.ts`, default empty). After every
closure proof holds, the closure pass reads those checks on the merge commit:
pending is a `deployment` wait (2 hours from the earliest check start);
failed or overdue parks the record with check name, conclusion and id,
reopens the issue once if GitHub closed it by that merge (a human close is
never reopened), then posts one progress comment; passing closes as before.
Review and merge gates are unchanged. The table stays empty until the owner
records exact check names, so production behaviour is unchanged until then.

### #336 bootstrap health pass

A repair-job bootstrap reads release state, runtime pins, custody and
contract versions, verifies compatibility and writes the same
healthy/settled proof; it steps, prepares, polls, composes and writes no
record. Intake, pre-ranking reconcilers, candidate-preservation stepping, the
initial matrix artifact scan and pre-merge CI run in the next ordinary
bounded pass. A failed health check still fails bootstrap and triggers the
journaled restoration. The launcher summary carries `bootstrapDurationMs` and
`bootstrapOutcome`.

### #328 repair fan-out with one trusted writer

Repository cells run the unchanged step loop on a private fork of the hot
state at the planned head. Every effect (GitHub write, model start, replay,
reservation, cooldown write) is blocked; a step that needs one is dropped and
its record is deferred to the trusted path. A cell returns a sealed delta:
replacement rows for its own existing records only, its base head and a
digest of its repository's projection of the state. Its authenticity is the
Actions artifact identity, as for matrix cells; the seal alone proves
nothing. A delta may not reserve, charge, refund, create records or touch
implementation or replay intents. Finalize, the only writer, accepts a delta
only while that repository's projection is unchanged (not strict global head
equality, which the concurrent serial pass would always break) and applies
all accepted deltas in one expected-head write through the existing writer;
a rejected delta writes nothing and is recomputed next pass. The serial
repair job steps only the records the plan leaves to the trusted path. The
deadline, the five-minute margin and accounting are unchanged.

## 2026-11-05: throughput watchdog (self-improvement)

Owner request (2026-11-05): let Sentinel work on its own throughput. Sentinel
already repairs itself through the ordinary issue → PR → native review → merge
→ auto-follow install loop; this entry closes the feedback side.

Finalize (trusted stage only) evaluates the threshold table in
`src/host/throughput-watchdog-thresholds.ts` over the metrics sidecar plus the
cycle's own record: maintenance+repair median ≤ 8 min over the latest 30
cycles (#324); repair median ≤ 5 min over cycles with `recordsRead` ≥ 60
(#326); bootstrap median ≤ 5 min over the last 3 (#336); no cycle with ready
work, no planner refusal and zero cells (#324/#335); refresh commits per merge
≤ 1 over 7 days (#329); target CI runs per merge ≤ 3 over 7 days (#330);
owner notices informational only (#327). Each verdict is `met`, `missed` or
`insufficient_data`; missing data is never `missed` (fewer than 10 cycles, or
3 for bootstrap, or under 7 days / no merges for weekly ratios).

For a missed threshold, finalize files through the existing trusted App issue
port one issue on `ubiquity-sentinel/sentinel` with the marker
`<!-- sentinel:throughput-watchdog:<id> -->` on the second body line, no skip
marker and label `priority:2`, carrying the measurement, window, cycle count,
metric fields, the #340 child it derives from and a "what to investigate"
section. Sentinel then repairs it like any issue and the merged fix
self-installs. Guardrails: at most one new issue per cycle; none while any
watchdog issue, or an open PR referencing one, is open; a 7-day re-file
cooldown after an observed close, recorded in `throughput/watchdog.json` on
the metrics ref by the same expected-head non-force writer; edits only when
the measured number changes by more than 10%; an issue whose recording write
was lost is found by its marker and adopted; a repeated finalize of the same
cycle acts once; a 60 s bound; it never throws into the run. The cycle record
carries `watchdogIssuesFiled`, and `sentinel report` prints the same
evaluation as a Thresholds table. Kill switch: repository variable
`SENTINEL_SELF_IMPROVE=off` (default on). Review, CI, P0, task-acceptance,
accounting, custody and auto-follow gates are unchanged; the watchdog has no
model access and no state authority beyond the metrics sidecar.

## 2026-11-05: two integration lanes on development

Owner decision (2026-11-05): the throughput lane (this session) and the
hanging-PR lane may both push to `development` and advance
`sentinel-supervisor`. Rule: each lane merges the current `development` into
its candidate, validates the merged result, and pushes fast-forward only;
whichever candidate is CI-green last installs, through auto-follow when the
workflow files are unchanged or through that lane's manual advance when they
changed. Neither lane rewrites the other's history or force-moves the
launcher. The other owner answers of the same day: the deferral-streak notice
is delivered as an owner issue (see the entry recorded with that change);
repository cells are widened beyond observe-only records, with every write
still owned by finalize; and this session reads the Passport and router
repositories to record the exact required-for-delivery check names.

## 2026-11-05: throughput watchdog guardrails, second set

Owner decision (2026-11-05, "improve"): the first guardrail set in the entry
above is superseded. Guardrails now: one issue per missed threshold, several
in one cycle; none while that threshold's watchdog issue is open or an open
PR references it (per threshold, not global); after its issue is observed
closed, finalize records the measurement and the runtime (generation and SHA)
installed at close and does not re-file that threshold until 10 cycles ran on
a runtime newer than that one (later generation, different SHA) and it is
still missed, or at once if the measurement is more than 10% worse than at
close; an open issue is edited only when its window advanced 10 cycles; at
most 3 watchdog issues per UTC day (attempts counted, `createBlocked:
"daily_bound"` logged). State is `throughput/watchdog.json` version 2 on the
metrics ref, written by the same expected-head, non-force finalize writer;
the reader lifts the historical version 1 file with an unknown runtime at
close, so the next known runtime becomes the baseline. An issue whose
recording write was lost is adopted by its marker; a repeated finalize of one
cycle acts once; 60 s bound; never throws into the run; kill switch
`SENTINEL_SELF_IMPROVE=off`. The 7-day cooldown, the one-issue-per-cycle rule
and the >10% edit rule are retired.

## 2026-11-05: upkeep-deferral notice as an owner issue (#327)

Owner decision (2026-11-05): the upkeep-deferral notice is one owner issue on
`ubiquity-sentinel/sentinel`, filed by finalize through the trusted App issue
port with the self App token the watchdog uses. The body's first line is
`<!-- sentinel:skip -->` and its second is `<!-- sentinel:upkeep-deferral -->`;
the title is "Upkeep deferred for N consecutive supervisor cycles"; the body
carries only the closed reason codes, the streak's run ids (most recent 30),
the streak start and this pointer. A deferral means the bounded self-upkeep
pass was skipped without writing and the run stayed green. The third
consecutive deferral opens the issue; later claims (each +3 to the streak) or
a new streak edit the open marker issue, preferring the number recorded in
`throughput/upkeep-streak.json` (version 2; version 1 is lifted on read);
Sentinel never closes it. When the issue is not delivered the log line is the
fallback, the finalize line records the adapter, and the run outcome is
unaffected. A runtime before this revision rejects a version 2 streak file;
the #340 rollback rule applies.

## 2026-11-05: repository cells widened to read-only waits and verdict reads (#328)

Owner decision (2026-11-05, "delegate more"): a serial step that only
re-arms a running read wait (`backoff`, `unavailable`, `deployment`,
`ci_pending`, `review_pending`) of an intent-free record, changing nothing
but the wait and the no-progress counter, settles like a deferral and is
stamped, with the stamp deadline equal to the wait's `until`. The existing
plan rule therefore delegates waiting records and review/CI result reads to
repository cells. A cell keeps only work-row wait/verdict transitions; a step
needing a GitHub write, reservation, model start or review receipt is dropped
and unstamped, so the next plan returns it to the serial path. Deltas carry
an optional bounded step summary; finalize reports per-kind kept/deferred/
elapsed counts and the delegated/serial-owned record counts on
`sentinel_repair_fanout`, and the metrics record carries optional
`fanoutDelegated`/`serialOwned`. Transition rule, accounting, deadline and
margin are unchanged.

## 2026-11-05: closed issues retire records with open Sentinel pulls

Live defect: #324–#339 were closed while Sentinel's own candidate pulls
#341–#358 stayed open, because retirement required a closed-unmerged pull and
the retired-pull pass required a retirement. The closure pass now retires a
record on any unmerged pull (closed or open), keeping the queue-custody,
unsettled-implementation-intent, self-merge and preservation-uncertainty
guards and every charge and counter. The next maintenance pass closes
Sentinel's own pull under the existing one-write-per-cycle rule; a reopened
issue returns the record to `work`. A `pullProbe` stamp alone does not settle
a record within a pass, and a probe no later than the retirement does not
delay the first retired-pull read. Intake now reports every open issue it
lists but leaves without a record as a `skippedIssues` row `not_admitted`
with a reason (`ci_outage_notice`, `native_parent`, `native_open_blockers`,
`github_cooldown`, `base_unavailable`, `run_deadline`); the run-deadline case
no longer stops silently. Issues opted out by the skip marker or label are
still filtered before intake.

## 2026-11-06: conservative private CI pacing with no paid usage

The owner requested that private CI stay within a 2,000-minute monthly scheduling budget, authorized deployment and explicitly rejected paying for CI. The accepted source policy allocates 1,450 managed minutes, 150 security minutes and 400 minutes for other or unknown activity per UTC calendar month. Existing correctness, current-head/base, review, custody and merge gates remain required; calendar holds preserve produced work. The independent provider zero-paid-spend budget remains the spending backstop. This policy does not promise uninterrupted availability against unmanaged organization activity or a measured full-month result.

The supported standard Linux jobs reserve 25 or 35 minutes as conservative execution estimates. These are not proved billing ceilings. Started jobs retain their estimated debit when consumed-minute metering is unavailable or unqualified; a timing response reporting zero is not a refund. Authenticated never-started proof is distinct. Proven terminal earlier-month execution retains its historical estimated charge without being treated as unresolved execution forever; incomplete, ambiguous and cross-month exposure remains carried. Increased exposure is recorded as debt rather than clamped away. Timestamps may identify execution periods or increase a clearly labelled estimate; they do not establish billed quantities.

The policy is accepted in protected source and checked against authenticated workflow, job, runner and timeout facts. Both trusted runtime and maintenance compositions share the existing private state-only CAS ledger and retain their existing authority checks. Initial accounting conservatively withholds the current month's allowance rather than inventing unused minutes. Durable bounded discovery and reconciliation continue through existing native turns; no new workflow, scheduler, daemon, runner, environment flag, token or permission scope is introduced. State branches have no PR and contain no application history; private proofs, cursors and usage stay outside public artifacts and logs.

When a current month has no ledger, recovery reads the latest earlier calendar ledger from the same validated current private state tree, including across skipped months. It preserves unresolved identities and debt until authenticated terminal evidence closes their exposure. The existing finite tree and byte bounds remain; corrupt, unreadable or unknown tree rows refuse recovery rather than becoming empty accounting. Recovery does not traverse commit history or invent an age cutoff.

Full-catalog refreshes span bounded existing native turns. Incomplete slices hold managed effects until a complete pass is available, which can delay admission across many turns. A ready observation may serve later reserves only within its native composition's fixed deadline, policy and UTC month; every reserve still revalidates effect facts and current CAS debits. No updated-since API, retirement cutoff or atomic organization-wide snapshot is assumed.

Source publication, canonical CI, deterministic installation and live guard acceptance are separate gates. The scoped CI integration coordinator reconciles concurrent source by ancestry-preserving fast-forward publication; the existing release controller retains exclusive pointer installation and exact-prior rollback authority. Publication requires verified sanitized task history with the same final tree as the accepted source; preserve original private preparation tips outside the publication graph and verify their sanitized counterparts. Other owners' work and runtime model policy remain unchanged.

## 2026-11-14: hand-backs stepped in the same run

A repository cell's delta now carries no row of a record it hands back, and
its base digest binds only the records it kept; finalize drops the stamps of
an applied delta's hand-backs itself. Once every `repair_cell` job of the run
attempt has completed, the serial repair job reads the cells' deltas,
authenticated exactly as finalize authenticates them, and wakes each
handed-back record the plan delegated to that cell, so its step runs in the
same run instead of on the next plan (about 33 minutes later). The read is
bounded (the consumer window or ten minutes, at most four authenticated
reads); one advisory `sentinel_repair_handback` line counts the records
woken. Every effect stays in the serial trusted path, with every CI, review,
refresh-line, custody, accounting and CI-minute gate unchanged. A hand-back
not read in time, not authenticated, or of a target whose cycle already ended
falls back to finalize's hand-back and the next plan, as before.

Version skew: a finalize from before this change rejects a delta carrying
hand-backs through the existing path (`base_moved`; that cell's records are
unstamped and handed back). A delta sealed by an earlier cell (whole-scope
digest, stamp drop as a transition) still applies while that scope is
unchanged; its row of a handed-back record may only drop that record's stamp.
Known limits: a review started by a takeover can extend that run's serial job
by up to one review, and in a rare window a cell keeps a `base_refresh` or
`merge` intent while the takeover steps the front of the same line. The
serial job's no-delegation line now carries `outcome` instead of `status`,
which the launcher's child-status scan read as a second result record.

Made under the owner's 2026-11-12 throughput grant; this supersedes only the
"next plan" timing in the 2026-11-05 repository-cells entry. Rollback: revert
these commits; no repair-state format changed.

## 2026-11-14: refresh line front is the oldest record that can act

The per-repository refresh line that a published head on a moved base asks
before its review (`ciRefreshAhead`, `src/repair/ci-readiness.ts`) now takes as
its front the first record in line order (oldest `createdAt`, then id) that can
act, no longer the one whose leftover wait ranks first: a moved-base head asks
the line before its CI gate and its deferral writes nothing, so its wait is an
earlier step's (live sentinel 2026-11-13/14: 271, 386 and 398 refreshed ahead of
268 and 397). Every head behind the front defers (`ci_line`) and writes, charges
and refreshes nothing.

Bounds: the six-hour pre-review CI bound and the stall rule (12 executions
without progress) release only a head on the tip; on a moved base both describe
an earlier tip and the next step is the refresh, so the head keeps its place by
age. A head whose wait never ends (a native queue-custody hold) and that nothing
has written for two hours (`DELIVERY_QUEUE_IDLE_MS`) holds nobody. Idleness
alone releases no other front: a head idle only because the line held it looks
the same, and releasing one let a younger head refresh first and the older one
beside it (ai.ubq.fi 1176 and 1211).

Unchanged: one record per repository at a time through the refresh line, the
delivery line, current-head CI, native review with no unresolved P0, custody and
accounting; no state shape, write, charge or refund is added. Known gap, also
unchanged: a review request on the tip consults no line, so a candidate
published on the tip, or an older head that refreshes beside a younger front
once its hold ends, can still take a charged review on the front's tip.
Rollback: revert these commits; no repair-state format changed.

## 2026-11-15: throughput watchdog files once per missed threshold

Owner decision (2026-11-15, relayed by the round's coordinator): stop the
throughput watchdog from filing the same missed threshold over and over; its
measurement and log lines stay. Live record, 2026-11-14 to 2026-11-15: #405,
#408, #410, #411 and #414 (PRs #407, #409, #412, #413, #415) were all filed for
`maintenance_repair_median` and `repair_median`. Each cost a charged
implementation and one or two charged native reviews, and each merged fix
parallelised a few reads: idle cycle wall time 1262 s → 1266 s,
maintenance+repair 13.7 → 13.1 min against the 8.0 limit. The issue carries only
the threshold and its median, and the outcome check re-filed whenever a
threshold was still missed after 10 cycles on a newer runtime, with no limit. On
the metrics ref at 2026-11-15 19:31Z, #411 and #414 were closed with 48 and 31
newer cycles, held only by the daily bound until the next UTC day, and neither
threshold was met in any of the 505 stored cycle records.

Rule: once a threshold's issue is observed closed (merged fix or any other
close; the watchdog does not read why), a still-missed threshold is filed again
only on a material change: it was `met` in at least one cycle since the close
and is missed again once 10 cycles ran on a newer runtime (a genuine
regression), or at once when the measurement is more than 10% worse than at
close (kept from the 2026-11-05 second guardrail set). "Met since the close" is
judged by the same evaluation over the stored hot cycle records
(`thresholdMetSinceV1`), each record over the records up to it; a met cycle no
longer among the newest 2,000 records reads as never met, so the bound fails
toward filing nothing. Otherwise the threshold stays `outcome_pending` in every
cycle's `sentinel_throughput_watchdog` line. Thresholds are tracked
independently; the first filing, the open-issue and open-PR exclusions, edits of
an open marker issue, adoption of a reopened or unrecorded issue (the owner's
way to ask for another attempt) and the 3-per-UTC-day bound are unchanged. This
supersedes only the "re-file once 10 newer cycles ran and it is still missed"
clause of the 2026-11-05 second set.

Unchanged: what is measured and logged per cycle (the metrics record, the
watchdog line, its keys and closed values) and `throughput/watchdog.json`, still
version 2 with the same keys, so an older runtime reads it unchanged. The issue
body's outcome-rule sentence now states this rule. Phase and target attribution
was not added: finalize keeps only each job log's runtime summary, not its
`sentinel_host_phase`/`sentinel_target_timing` lines, and the stored records
carry only job-level phases, so medians over the window would need new plumbing
and a new stored shape. Rollback: revert these commits; no state format changed.

Addendum (2026-11-15, review follow-up): one met window no longer re-arms a
closed threshold. "Met since the close" now means met in 10 consecutive
evaluations since the close (`THROUGHPUT_WATCHDOG_MET_RUN`), still computed by
`thresholdMetSinceV1` from the stored records; a missed or insufficient
evaluation ends a run. Only a cycle its window is taken from counts (one whose
repair job did not run re-judges the previous window, so it neither extends nor
breaks a run), and a met window over fewer cycles than its full window (the
oldest kept records, when the close is older) counts as not met. Reason: the
repair median, 5.25 against 5.0 and falling, moves about ±6% with which cycles
fill the window; the review fed the last 60 live repair durations scaled to
1.03× the limit, the median dipped to met once (4.98) and the next miss (5.05)
filed. Accepting one window at ≤ 0.9× the limit as an alternative was not
adopted: the stored maintenance+repair series has single-window median dips of
15% of the limit. The more-than-10%-worse clause, the stored state and its
version are unchanged; the issue body's outcome-rule sentence states the run.

## 2026-11-15: self-merge no longer refuses ops/ changes

Live record: Sentinel PRs #385, #402, #409, #412 and #415, the Sentinel PRs that
touched `ops/` (each one or two `ops/` files plus tests), were each refused by
the serial repair job's self merge with
`{"event":"merge_port_error","errorKind":"invalid","detailCode":null}`, re-armed
the two-minute wait and were squash-merged by the next cycle's maintenance
delivery pass 7–10 minutes later, each with a clean current-head review and
green head CI. Cause, reproduced through the real port and real Git
(`tests/github/self-merge-ops_test.ts`): `executeSelfMerge` compared the objects
at `.github`, `ops`, `deno.json` and `deno.lock` between the PR's base and the
commit CI tested and refused any difference as "self merge trusted CI pipeline
changed"; the whole `ops` tree counted, so every launcher edit was refused. The
check exists so that a PR cannot change what CI runs and make its own head CI
pass vacuously.

Owner decision (2026-11-15, asked "Self-merge for ops/ PRs: drop the check that
refuses them? Today they get refused, then merged a cycle later by another path
anyway"): "drop it". Scope: launcher and maintenance code under `ops/`, which CI
tests like any other code; not what CI runs. The pinned set
(`SELF_MERGE_TRUSTED_PIPELINE`, `src/github/self-merge-git.ts`) is now the
`.github` tree, the shard runner `ops/ci-shards.ts` and its
`ops/ci-test-timings.json`, the size gate `ops/code-size.ts`, `deno.json` and
`deno.lock`; the workflow, harness and emitter (`.github/workflows/ci.yml`,
`test-local.ts`, `ops/native-ci-proof.ts`) must still equal the base's. A test
ties the set to every `ops/` file `ci.yml` and `test-local.ts` run. Every other
self merge gate is unchanged: native CI evidence read fresh and again before the
`development` push, the exact-head review receipt, task acceptance, ref custody,
the deterministic merge identity and its durable proof.

Still refused, and where: a change to what CI runs is refused by the self merge
before any write. A Sentinel candidate changing `.github/workflows/**` (or the
two protected actions) reaches neither path: for the self target it is an
unpublishable protected path parked before publication ("candidate touches a
protected path"), and the maintenance delivery pass refuses it too
(`protected_path`). Open for the owner, unchanged here: that pass has no
equivalent of this check (a green `test-local` run and the self protected paths
only), so a reviewed PR changing `test-local.ts`, `ops/native-ci-proof.ts`,
`ops/ci-shards.ts`, `ops/ci-test-timings.json`, `ops/code-size.ts`, `deno.json`,
`deno.lock` or an unprotected `.github` file is still refused here and
squash-merged by it one cycle later.

Diagnosis: every `invalid` self merge refusal now logs a fixed code
(`src/repair/merge-event-codes.ts`; the launcher accepts exactly these codes),
never the detail text. This refusal logs `self_merge_ci_pipeline_changed`; a
pinned source mismatch logs `self_merge_ci_source`. Unchanged here: such a
refusal re-arms the two-minute `unavailable` wait and keeps the merge intent
(`loop-merge.ts`, `tests/repair/self-merge-refusal_test.ts`), which the
2026-10-23 "Self-path corrections" wording (the refusal parks the record for the
owner and clears the intent) does not match. Rollback: revert these commits; no
state format changed.

## 2026-11-15: one-time release of parked sentinel issues

Owner decision (2026-11-15): asked "Which parked sentinel issues should I
release? Thirteen are parked and never come back by themselves", the owner
answered "all". Live sentinel-state/repair 554559876818 (sequence 96323) holds
those thirteen open, parked issue records of `ubiquity-sentinel/sentinel`;
intake skips an issue that has a record, so nothing re-admits them. Each was
read in full with its charges and attempt memory and judged by what its normal
path would do next. A state rewrite that only buys charges for the same park is
not a release.

Released by code: `issue-ubiquity-sentinel-177` alone
(`ops/hosted-autonomy-owner-releases.ts`). Its exact park (record id,
repository, blocker kind, message and `since` 2026-11-05T12:38:50Z: four
transient "model run failed (unavailable)" outcomes, five charges) re-arms once
through the repeat-failure bound's own trigger (`owner_release`), written by the
retry pass as the ordinary uncharged work grant in its one CAS write. Only
`nextStep`, `blocker`, `wait`, `intent` and `updatedAt` change; every charge,
counter, attempt-memory row and the target stay. The runtime then refreshes the
record's 2026-10-18 base (uncharged) and admits one start, attempt 6, at the
tip: one implementation charge, then the ordinary bounds (an independent review
ran the live rows through the real planner and ingester: an identical failure
re-parks after that one charge; three no-change runs cost three charges before
the no-change park; failures alternating between two kinds are charged each
round and are not parked by the repeat-failure rule, an existing gap that
applies to every unparked record). Every later charge is an ordinary grant
through unchanged gates. An identical failure re-parks it at once with a later `since`, which the
release never matches, so it applies at most once with no new persisted field.
The same park on any other record (ubiquity-dollar 997 shares its signature,
route, prompt and second) stays parked.

Not released, and why (owner actions are closures or edits; no charge was
refunded or reset):

- 240, 270, 277 (candidate touches a protected path; 5, 3 and 3 charges): the
  fix is protected by definition. 240 asks to extend the protected set itself;
  the base reviews of 270 and 277 name `.github/workflows/supervisor.yml` and
  `src/host/supervisor-dispatch.ts`. A release regenerates a protected candidate
  and parks again after one charge. The owner lands or declines these directly.
  240's shape still matches the `sentinel:retry` exit, at the same cost.
- 383, 406 (protected path; 3 charges each): one-off self-observations (finalize
  failed in its setup-deno step, run 42564269285; the repair cells of run
  43597250279 failed, the log read showing the launcher's `carrier_count`
  rejection). Their base reviews were "uncertain" and the observed failures sit
  in workflow and launcher code; close, or re-file with the failing step.
- 239, 266 (base review found work still needed after 3 no-change outcomes; 7
  charges each): `MAX_NO_CHANGE_BASE_REVIEWS` (3) is an accounting bound.
  Lifting it re-opens the round trip, at most one implementation and one base
  review charge per extra round per record. 239's reviews alternate between
  uncertain and not fulfilled, and one (2026-11-13) found it already satisfied
  at base; close it. 266's not-fulfilled review names a concrete defect: the
  self-defect log read keeps only the first 262,144 bytes, so a long failure
  reaches the generic fallback. Filing that as a new issue gives the implementer
  the verdict the record never passed it; close 266.
- 218 (base review did not establish acceptance; 2 charges): its memory holds 16
  no-change outcomes from one charge, over the same bound, so the 2026-11-13
  historical re-arm already refused it; a one-off self-observation of
  2026-10-25; close.
- 176, 234 (historical matrix runtime mismatch; 2 and 1 charges): their
  admissions settled ambiguous and their producer plans (41140349630:1,
  41181358196:1) are past retention. Returning them to their no-change hold
  would put expired producers in front of the current-matrix walk; the only
  other release is a fresh charged start on a stale 2026-10-19 checkpoint (176)
  or a single 2026-10-31 test-shards exit (234). Close both.
- 249 (candidate preservation validation refused; 6 charges):
  `PRESERVATION_REFUSED_MAX_RESERVATIONS` (6) is an accounting bound; each extra
  allowed refusal is at most one more charge, and the park predates the
  check-named refusal message, so the failing check is unknown. The fix is
  documentation only (the follow-up pass header, and a superseding note for the
  2026-10-16 follow-up entry); land it directly or approve one more charge.
- 288 with PR 307 (review round ceiling, refreshed head red on test-local and
  test-shards; 8 charges): b236f3a479 (2026-11-01) already fixed the defect;
  close the issue and the pull request.

Not changed: passing a base review's verdict text to the implementer needs a
runtime read of the digest-bound result comment (the runtime GitHub port has
none), a new request input and, if the prompt prose changes, a new template
digest that re-arms all six fleet repeat-failure parks once; it is left for its
own decision. Rollback: revert these commits; a released record is an ordinary
work record and an unreleased park stays parked.

## 2026-11-16: CI-fix cap for base-repair tasks, landed ahead of filing

The second review of the base-repair enablement for ai.ubq.fi held that the cap
and the filing must not land together: filing runs in the launcher, the cap in
the installed runtime, and an install's rollback target is the runtime installed
before it. Landed as one batch, a rollback leaves the launcher filing while a
runtime without the cap charges CI fixes without limit (a reproduction reached
12 in a row). The cap therefore lands first, alone, with filing still off.

- Cap, PENDING THE OWNER'S CONFIRMATION: `BASE_REPAIR_CI_FIX_CAP` = 3 charged CI
  fixes per base-repair task
  ([src/repair/base-repair.ts](../src/repair/base-repair.ts)). 3 is the review's
  suggestion ("I suggest 3, then it parks"), not an approval; the owner's number
  replaces it. Only a base-repair task (`isBaseRepairTask`: the App's issue with
  the marker on its first line) is capped, counted in the existing
  `counters.retries`, which only a CI fix's admission moves. At that admission
  (`prepareImplementationStart`, shared by the serial loop and the hosted matrix
  planner) a task already at the cap parks, uncharged, with
  `base-repair CI fix cap reached: 3 charged CI fixes spent; owner action required`;
  no launcher rule re-admits it, and the owner ends it by closing its issue.
  Every other task's CI fixes stay uncapped (2026-10-30), pinned by tests.
- Inert while filing is off: `BASE_REPAIR_FILING_ENABLED` stays false for every
  target, so no base-repair issue is filed and nothing can be capped. No record
  in sentinel-state/repair at `c6fa9868` (2026-11-16) carries a base-repair
  trace, and filing has been off since 027ecbbea0. Landing with the cap, and
  equally inert: the hosted fix finding of a base-repair task says its base is
  red (`HOSTED_BASE_REPAIR_FINDING`; generation 253 on 9c91a87f77 and its
  rollback target 176b596f86 both recognise that opening), and the launcher's
  base-repair check read is strict (a failed job it did not judge files
  nothing).
- Why first: once this runtime has been installed for a full generation it is
  also the rollback target of the next install, so the later change that turns
  filing on cannot be rolled back onto a runtime without the cap.
- Rollback: revert these commits. Filing stays off either way; no state format
  changed.

## 2026-11-16: a pass whose every target read failed defers instead of failing

Live record: supervisor run 43790005563 (02:05Z, generation 253 on 9c91a87f77)
failed in its serial `repair` job with the early failure `targets_empty`
("committed target setting lists no repository"); the runs before and after on
the same SHA were green. `loadTargetConfigsV1` skips each committed target
whose default-branch or tree-facts read cannot prove an answer, and the host
threw `STATIC_TARGETS_EMPTY` whenever none remained, so a GitHub read burst
(five of the run's repository cells reported `issue_source_http_error`) read as
an empty setting and turned the run red. Reproduced through the real
`runActionsRepairHost` with every target read unavailable
(`tests/host/actions-targets-deferral_test.ts`).

- A setting that lists no repository (absent, empty or invalid) still refuses
  with `targets_empty`, unchanged.
- When it lists repositories and every one was skipped, the pass prints one
  text-free `sentinel_targets_deferral` line (`reasonCode` `targets_unavailable`
  and the `listed`, `branchUnavailable`, `factsUnavailable` and `transient`
  counts; no slug, status or message), which the launcher strictly re-parses
  and re-emits.
- Only a failure that looks transient may defer. An observer on the target
  resolvers' transports (`src/host/target-read-observer.ts`) keeps one boolean
  per target: whether its last read was a thrown request (network failure,
  deadline, refused redirect or durable-cooldown refusal), a 5xx, a 429 or a
  403 with rate-limit evidence (`retry-after`, `x-ratelimit-remaining: 0` or
  GitHub's secondary-limit message). Any other failure (401, 404, a 403
  without that evidence, a 2xx answer the resolver could not use) fails every
  job red with `targets_unavailable`, so a lost credential or installation
  never reads green. Observation never changes a request, response or throw;
  a partial failure behaves exactly as before.
- An ordinary serial pass whose every failure looked transient then settles
  healthy with the idle outcome "every committed target read was unavailable;
  the pass deferred", after the actual startup probe (an unready startup still
  fails it). Nothing after the target load runs (CI-minute reconciliation,
  queue custody, owner-successor review, target cycles, ingestion, CI
  approval, model starts), so it writes no state. The launcher labels the
  job's runtime summary `targets_unavailable` from the child's own deferral
  outcome (the line alone labels nothing), and finalize's run summary is then
  `degraded` with a next action naming the deferral, never `healthy` with
  "None".
- At most one green deferral in a row, with no persisted field
  (`src/host/targets-deferral-bound.ts`): before the serial pass defers it
  reads the release record's `hostedRuntimes[0].lastExecutionProof`, the
  previous execution's settlement. Only a run proof whose exact repair-job log
  (job id, the job's native token, the existing bounded signed-log reader,
  read-only: a rate limit it meets fails the read and is never recorded)
  hashes to the settled `logDigest` and names no `sentinel_targets_deferral`
  line lets it defer. No settlement, a `not_started` settlement, an unreadable
  or different log, or any line naming the kind fails the pass red with
  `targets_unavailable`. The launcher re-emits the line for a red pass too, so
  after one green deferral every following unavailable pass stays red until a
  pass reads its targets again. This assumes the launcher re-emits the line,
  as the launcher and runtime of an ordinary update are the same SHA.
- On the same transient failures the matrix planner publishes the queue-custody
  hold's empty zero-grant plan with plan diagnostic cause `targets_unavailable`.
  A repository cell writes its refusal and marker exactly as a cell whose own
  target is not configured; finalize counts it refused and hands its records
  back to the serial pass.
- A verification execution (bootstrap, prior, candidate, rollback) and an
  admitted matrix cell still fail, now with the early-failure reason
  `targets_unavailable`: unavailable evidence never passes an install or
  rollback gate, and a granted cell that cannot run keeps its charge
  unreconciled for the existing recovery instead of writing a charged
  `not_started` park.

Not from this path: that run's 21 `stalled`+1 writes (20 prospector records and
ubiquity-dollar 927, each re-armed with a two-minute `unavailable` wait) came
from the six repository cells' sealed deltas, applied by finalize at 02:19:58
(`sentinel_repair_fanout`: 6 deltas, 48 transitions). The serial job threw
before any cycle and wrote nothing, as a deferred pass writes nothing. Each
cell's batched issue listing failed, so the unchanged-input gate could not skip
the records; each stepped record met the unavailable read and counted one
non-advancing execution. That accounting is unchanged here.

Open for the owner: a bootstrap whose every target read is unavailable still
fails and restores the journaled prior (that SHA cannot reinstall), although
its health pass reads no target. The matrix planner is not bounded itself: on a
second unavailable run in a row it still publishes its empty plan, and the
serial pass of that run is the red job. Rollback: revert this change's commits;
no state format changed, and an older runtime under this launcher keeps
reporting `targets_empty`.
## 2026-11-16: base-repair filing for ai.ubq.fi (owner decision 2026-11-15)

Owner decision (2026-11-15, relayed by the round's coordinator), answering "Turn
on base-repair for ai.ubq.fi? … Turning this on lets Sentinel file an issue
there and spend charged attempts fixing it": "yes". It names
`ubiquity/ai.ubq.fi` only. It does not cover `ubiquity/uusd.ubq.fi`,
`ubiquity/permit2-rpc-manager` or any other target.

Live record (`sentinel-state/repair` at `55455987`, 2026-11-15): five ai.ubq.fi
records (PRs #1345, #1346, #1347, #1349 and #1350) wait at `work` in the
CI-first gate's red-base hold on `development` at `002fe15f`, held since
2026-11-13; uusd.ubq.fi (five records on `eb0386e0`) and permit2-rpc-manager
(three on `9f570db0`) are in the same state. Nothing assigned a fix: filing had
been off for every target since 027ecbbea0 (2026-10-25), and the `base_repair`
phase read and filed nothing on every pass.

It lands only after the change of the 2026-11-16 entry "CI-fix cap for
base-repair tasks, landed ahead of filing" has been the installed runtime for at
least one full generation (so it is also the rollback target of the install that
brings this one) and the owner has confirmed the cap's value. The runtime gate
below enforces the installed-runtime half in code, by reading the installed
runtime's own source, which must also carry this entry's per-issue count, so
filing starts only once this change itself is the installed runtime.

- Mechanism: `BASE_REPAIR_FILING_ENABLED` is replaced by
  `BASE_REPAIR_FILING_TARGETS`, an exact `owner/name` allowlist holding only
  `ubiquity/ai.ubq.fi`
  ([ops/hosted-autonomy-base-repair.ts](../ops/hosted-autonomy-base-repair.ts)).
  A held record of any other target is skipped before any GitHub read, so those
  targets behave as before: nothing read, nothing filed. The test-only `filing`
  override is removed, so no caller can file for an unlisted target.
- What is filed (unchanged): one unlabelled issue titled
  `CI is failing on <branch>`. Its body is fixed text with
  `<!-- sentinel:base-repair:<branch>@<tip> -->` on the first line, the branch,
  the tip SHA and at most 20 failing check names, each in the runtime's trusted
  check-name shape (`trustedCheckName`) or else the fixed stand-in
  `check with an unsupported name`. Only checks red on both the tip and one of
  the first three held heads are listed, and none files nothing. A default
  branch that is not a plain ref name (`^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$`)
  files nothing. No issue, pull request, comment, log or check-output text is
  read into it. No state is written and no issue is edited, closed or commented.
- Bounds, each failing toward not filing (an unreadable or short read files
  nothing):
  - Runtime gate
    ([ops/hosted-autonomy-base-repair-runtime.ts](../ops/hosted-autonomy-base-repair-runtime.ts)):
    the launcher files only while no installation is in flight
    (`runtime_installing`) and the installed runtime's OWN source carries the
    cap: `src/repair/base-repair.ts` and `src/repair/loop-implementation.ts`,
    read from the Sentinel repository at exactly the release state's runtime
    revision (the contents API, each file checked against its blob id), must
    declare `BASE_REPAIR_CI_FIX_CAP` once, from 1 to this launcher's value,
    count an issue's fixes across its parts (`baseRepairCiFixesSpent`), and call
    the capped check over the run's records at the CI-fix admission
    (`runtimeSourceCarriesCap`; the first cap, 33789b2a90, fails this);
    otherwise `runtime_uncapped`, or `runtime_unreadable` when the pointer or a
    file cannot be read. The third review (2026-11-16) filed on a runtime that
    descended from the cap's commit with the cap reverted: the first version of
    this gate proved only that ancestry, from a pinned commit id
    (`BASE_REPAIR_CAP_REVISION`, removed with its compare read, so a wrong pin
    can no longer stop filing under a transient-looking reason). A test pins the
    facts to this checkout, so a change that moves the cap fails CI instead of
    silently stopping filing. The gate holds new filings only: a later install
    of a runtime without the cap stops filing, but an issue already filed is
    then worked without it (close the issue to stop its charges).
  - Listing proof: the App listing (`creator=ubiquity-sentinel[bot]`) must
    answer, as the App's own pull requests, every pull request of the records
    held on the tip (`listing_unproven`; `held_pull_foreign` when GitHub names
    another author for a missing one, so the proof cannot pass while that record
    is held; `issues_over_bound` when the App has more items than the bounded
    listing reads).
  - Per tip and per open issue (content-based, extra holds only): an issue
    marked for this tip, open or closed, holds it (`filed_before`); an open
    issue with a base-repair marker or the exact title holds every new one
    (`open`).
  - Hard bound, under one named switch, `BASE_REPAIR_BOUND_POLICY`
    ([ops/hosted-autonomy-base-repair-bounds.ts](../ops/hosted-autonomy-base-repair-bounds.ts)),
    AN OPEN OWNER DECISION: no filing while the App listing holds
    `BASE_REPAIR_ISSUE_LIMIT` = 1 issue the switch counts, created within
    `BASE_REPAIR_ISSUE_WINDOW_MS` = 14 days, open or closed (`recent`).
    - `"strict"`: every issue the App opened in the target, whatever its title
      or body (the second review's bound: before it, rewriting both refiled at
      the next pass). The third review found its cost: the App opens one review
      follow-up per finding in the target, and on ai.ubq.fi's history the window
      would have left filing possible for about 7 hours a month.
    - `"relaxed"`, THE DEFAULT until the owner decides: only the App's
      base-repair issues, by the marker on their first line, or by the exact
      title once the marker was edited away. A person rewriting both lifts it
      for that issue; the bounds that read no text still hold: one filing a UTC
      day (the daily brake) and no third while two are open (the open ceiling).
    - Every other hold is the same in both modes. The maintenance pass always
      files under the switch; the pass takes a mode only so that tests run both.
  - Daily brake, content-independent and independent of the App listing: no
    filing on a UTC day (from midnight less ten minutes of skew) on which the
    created-since listing, read without the `creator` filter, shows an issue the
    App opened in the target (any title or body), or an issue with a base-repair
    marker on its first line that an owner, member or collaborator of the target
    opened (GitHub's `author_association`, `BASE_REPAIR_TRUSTED_ASSOCIATIONS`):
    a create answered under another author, since Sentinel's only credentials
    for a target are the App's and, as a stopgap, the owner's (`filed_today`).
    Nobody else's issue holds anything: the third review found that any GitHub
    user could suppress filing for a day with an issue carrying the base-repair
    title or marker, and a member's report in its own words holds nothing
    either. A listing that cannot be read, does not reach back past that
    instant, or holds a marked issue whose creator GitHub does not place, files
    nothing (`day_unproven`). Within one run each repository gets one create
    attempt a UTC day, whatever GitHub answered and under however many
    installation ids its records are held (`attempted_this_run`); a create
    answered under an outsider's login, possible only with an outsider's
    credential in Sentinel's secrets, is held by that run's attempt alone.
  - Open ceiling, content-independent
    ([ops/hosted-autonomy-base-repair-bounds.ts](../ops/hosted-autonomy-base-repair-bounds.ts),
    third review): no filing while `BASE_REPAIR_OPEN_LIMIT` = 2 issues this pass
    may have filed are open: every open issue the App opened in the target, at
    any age (the complete App listing), and every open issue that holds the
    daily brake (the App's, or a trusted creator's marked one) among those the
    created-since listing shows within `BASE_REPAIR_OPEN_WINDOW_MS` = 14 days
    (`open_ceiling`). Only the App's review follow-ups, recognised by their own
    marker naming this target (one issue per finding, so many), are left out; a
    person never types one by accident. The review found two ways to more than
    one open base-repair issue: rewriting both the title and the first line of
    the open one, so that no hold recognises it once the hard bound's window has
    passed, and a create answered under another author, which the App listing
    never shows (one more open issue a day). A rewritten issue now counts while
    it is open, at any age; such a create counts for the window. The cost: the
    capability issue the App keeps open on a target counts too, so with it open
    a single rewritten issue holds filing. The one created-since read now
    reaches back over the window (up to 10 pages of 100): one that does not, or
    holds a marked issue in it whose creator GitHub does not place, files
    nothing (`ceiling_unproven`).
  - Checks: the tip and held-head reads are strict, so a failed Actions job the
    read did not judge makes the commit unreadable (`checks_unreadable`,
    `head_checks_unreadable`), and more failed Actions jobs than the eight it
    judges is its own condition (`checks_over_bound`, `head_checks_over_bound`).
- Issues filed, at most: one per target per 14 days in normal operation, in
  either mode, so at most 27 a year on ai.ubq.fi, the only target. Worst cases,
  where only the bounds that read no text hold (the daily brake and the open
  ceiling: one a UTC day, 365 a year, while the earlier ones are closed, and no
  third while two filed within 14 days are open): the creator listing silently
  returned only pull requests; a create was answered under an owner's, member's
  or collaborator's login; or, in the relaxed mode only, a person rewrote both
  the title and the first line of each issue (in the strict mode a rewritten
  issue still holds its 14 days). Deleting the App's issue removes GitHub's only
  record of it, so each deletion allows one more filing.
- Charged attempts per filed issue, at most: `BASE_REPAIR_CI_FIX_CAP` = 3
  charged CI fixes (owner's number pending; see the cap entry), then the
  uncharged park; with the base and every new head red no review is requested.
  The 3 are counted across the issue's task and every part a timeout splits it
  into (`baseRepairCiFixesSpent` over the run's records, which the CI-fix
  admission passes; the gate above requires both in the installed source). The
  third review found that each part, created with zero counters
  (`createDecompositionChildren`), took its own 3: up to 4 x 3 = 12 for one
  issue. The sum needs no new field: only a CI fix's admission moves
  `counters.retries`, a part starts only once the part before it is done, and an
  open issue's records stay hot. Implementation starts are not capped here: the
  whole issue's start, the retries the ordinary rules allow (the repeat-failure
  park after three identical failures, the identical-attempt refusal) and, once
  a timeout splits it (`MATRIX_DECOMPOSE_AFTER_TIMEOUTS` = 1), one start per
  part (2 to `MATRIX_DECOMPOSE_MAX_PARTS` = 4, never split again) under the same
  rules. As for any task, a base moved by someone else's merge can cost one
  conflict resolution per base tip, and once a head turns green review rounds
  and P0 corrections stay uncapped (2026-10-30). The task is admitted as an
  ordinary unlabelled issue and merges only through the ordinary gates (green
  current-head CI, a completed current-head native review with no unresolved P0,
  task acceptance, custody, accounting); its merge closes the issue
  (`Resolves #N`) and the held records refresh onto the new tip.
- Reason codes appear only in the run's result line
  (`base-repair:<owner>/<name>:<reason>`); no workflow, run summary or other
  reader parses or allow-lists them.
- Not addressed (none P0 or P1): an issue whose tip went green before admission
  still costs an implementation; in the strict mode the hard bound also counts
  the App's other issues in the target.
- Another target needs its own owner decision recorded here and its full name
  added to `BASE_REPAIR_FILING_TARGETS`.

This supersedes, for ai.ubq.fi only, the "filing stays off" status of the
2026-10-24 base-repair entry. Rollback: revert these commits; filing is then off
for every target again and no state format changed. A revert does not close an
issue already filed on ai.ubq.fi and does not stop a task already admitted from
it: the runtime still recognises and works it as a base-repair task, with its CI
fixes still capped (the cap is the earlier entry's and stays), though again per
record, so each part of a task split by a timeout gets its own 3. Close the
issue by hand to stop its charges.

Correction to the cap's entry above ("CI-fix cap for base-repair tasks, landed
ahead of filing"), whose text stays as written: its rollback sentence, "Filing
stays off either way", held only while filing was off for every target. Once
this entry is in, roll back in order: revert this entry's commits first (filing
off for every target), close any open base-repair issue, and only then revert
the cap's. Reverted alone, the cap leaves the installed runtime at the next
install, so the gate above files nothing new, but a base-repair task already
filed is then worked with uncapped charged CI fixes. Its "Why first" also no
longer carries the guarantee alone: the gate reads the installed source instead
of relying on the install order.

## 2026-11-16: sentinel 249 one more attempt, and the secret-shape false positive behind its refusals

Owner decision (2026-11-16), answered "OK" to the question asked in these words:
"#249 one more attempt (cap 6→7)". It is the only accounting change here: no cap
is raised generally, no other record or park gains a charge, nothing is
refunded. Rows from live sentinel-state/repair 048efadb4e7d (sequence 96671),
re-read unchanged at 5581f19e3d (sequence 96688).

What 249 holds: `issue-ubiquity-sentinel-249` ("Follow-up pass docs still
describe combined issues and a create bound") holds six submitted charges
(attempts 1 to 6, 2026-11-01 to 2026-11-07; counters 6/0/0), is parked
"candidate preservation validation refused" since 2026-11-12T23:08:40.682Z with
its sixth candidate cef3f89f on base 838d5c62, and the preservation disposition
retains it at `PRESERVATION_REFUSED_MAX_RESERVATIONS` (6),
`retained:reservation_cap`.

Why the six were refused: the 2026-11-06 refusal was recorded as
`secret_shaped_text`. The trusted publication validator that candidate
preservation runs scans every newly exposed blob and commit message whole with
`containsSecretShapedText` (`src/replay/fixture.ts`). Its pattern
`sk-[A-Za-z0-9_-]{20,}` had no left boundary, so in the finding id
task-acceptance-not-fulfilled (the "Generation 81 task acceptance corrections"
entry above) the `sk-` that ends "task-", followed by the 24 characters
"acceptance-not-fulfilled", read as a key. That id was the only match in this
file at all six attempt bases and at the current base, so every candidate that
changed this file, which issue 249 asks for, was refused.

The detector fix (the commit before this entry's): an `sk-` key must begin a
token. The prefix may not continue an ASCII letter, unless that letter ends an
escape that can sit right before a key in encoded text (a backslash escape such
as `\n` or `\x3d`, a unicode, percent or quoted-printable byte, a terminal colour
or erase code). The key alphabet and length and the six other patterns are
unchanged; there is no allowlist or path exemption. Over every tracked file
three verdicts change, each from refused to accepted on the same kind of id:
this file, `docs/build-status.md` and `src/repair/acceptance-correction.ts`. A
synthetic real-format secret of every pattern family is still refused in 26
positions (line start, mid-line, after punctuation, after a hyphen, after
escapes, right after a false-prefix word).

The allowance (this entry's commit): `OWNER_PRESERVATION_ALLOWANCES_2026_11_16`
(`ops/hosted-autonomy-owner-releases.ts`) names 249's exact park (record id,
repository, blocker kind, message and since) with cap 7, read through
`preservationRefusedCap`. The disposition's own gates still decide (consumed
charge, unpublished shape, a day's pacing, an advanced base): it re-enters 249
once, the ordinary retry grant returns it to work uncharged, and the runtime
refreshes the base and charges one start, the seventh. The re-entry rewrites the
park, so the allowance never matches again; a later refusal meets the ordinary
cap with seven charges held and is retained, so there is no eighth. Run through
the real disposition pass over the whole live snapshot (473 records), the
allowance changes exactly one verdict, 249's, from `retained:reservation_cap` to
`unrecoverable:refused`, and `preservationRefusedCap` is 6 for every other
record. The pass disposes at most 12 records per run in id order, so on a run
with that many other disposals 249 can take a slot another record would have
had; that record waits one run.

Charge bound: one more implementation charge, the seventh, at this park. If
that candidate passes preservation and publishes a pull request, the ordinary
native review charges per round follow under the unchanged gates (no unresolved
P0, current-head CI not red, native Codex review mode). The seventh is expected
to be meaningful only with the detector fix installed. The preservation
validator runs in the installed runtime; the disposition runs in the launcher's
maintenance pass, which need not be the installed runtime. Under launcher
self-install both are the same exact SHA, and this commit sits on the fix, so an
installed runtime equal to this launcher carries it. Nothing else ties the two:
while the runtime is older (self-install not yet done, or a failed bootstrap
that restored the prior revision with model starts enabled), the seventh charge
runs under the old pattern, a candidate that edits this file is refused again,
and 249 stays retained with seven charges. Check that the installed runtime is
this launcher's SHA before counting on the seventh.

Open, unchanged here: `taskReservationCount` counts live reservations only. Once
the live ledger exceeds 2,048 rows, compaction archives the oldest submitted
rows, which would lower the count the cap reads; the ledger holds 1,679 rows.
This file is 354 KB; the validator refuses a blob above 512 KB.

Rollback: revert either commit; they touch disjoint files and revert
independently in either order. Reverting the allowance before the disposition
writes leaves 249 retained at six; after it wrote, 249 is in the ordinary
retryable class or at work, which the previous code handles normally. Reverting
the detector restores the previous pattern, and candidates that edit this file
are refused again. No state format or persisted field changes.

## 2026-11-17: a base-repair task's no-change hold parks at once on its red base

Live record (`sentinel-state/repair` at c7fbe96f30): ai.ubq.fi issue 1370, the
App's base-repair issue for `development` at 002fe15f, was admitted and its
first implementation (matrix run 43985877863, 00:27-00:34Z) completed without
any change to its checkout (`model_candidate_unchanged_base`); the admission
settled ambiguous (one charge) and the record entered the no-change hold
(`holdNoChange`, until 2026-11-18T00:39:20Z). That hold's only exit is a base
review, and `inspect` refuses one unless the exact base's CI is green
(`BASE_REVIEW_CI_NOT_GREEN`). A base-repair task's base is red by
construction, so every cycle deferred until the 24-hour bound and the record
then parked under the generic "base review did not complete within its hold
bound". Reproduced through the real repair loop with fake GitHub and review
ports and an injected clock (`tests/repair/base-repair-no-change_test.ts`):
24 hourly deferrals, then that park; no charge either way.

- Change: when `inspect` answers `BASE_REVIEW_CI_NOT_GREEN` for a record held
  with its implementation intent and `isBaseRepairTask` (App author, marker on
  the first line) is true, the base-satisfaction step parks it at once,
  uncharged, with `BASE_REPAIR_NO_CHANGE_DETAIL` ("base-repair implementation
  made no change while its base CI is not green; owner action required"), kind
  `other`. No launcher retry prefix takes it (pinned by the lane test); the
  owner ends it by closing the issue. An unreadable issue defers with no write
  (as before); every other task's hold is byte-identical (pinned).
- Not chosen: returning the outcome to the ordinary no-change retry. The first
  start already carried the red base and the failing check names (the issue
  body, `baseRepairIssue`, within `MAX_ISSUE_BODY_CHARS`); a retry at the same
  base and runtime is refused as identical (#334) and, on a new runtime, the
  prior no-change fact is no longer carried, so each retry would be a charged
  replay of the same inputs. What the first start lacks, compared with a CI
  fix, is the fenced CI failure evidence (and its sandbox has no network to
  reproduce the checks); giving a first start that untrusted text is a new
  prompt channel and is left for the owner.
- Charges: none added and none refunded. The no-change branch now costs the
  one charged start that produced it; the bound of the 2026-11-16 filing entry
  (implementation starts under the ordinary rules plus 3 charged CI fixes) is
  unchanged. 1370 holds one charge and gets no second.
- 1370 after install: its next base-satisfaction step parks it as above, or,
  if the install comes after its hold's bound, under the generic hold-bound
  park; both uncharged. Its open issue keeps filing held until it is closed.
- The runtime gate (`runtimeSourceCarriesCap`) is unchanged and passes on this
  tree; it guards the CI-fix cap's charges, and this park adds no charge path.

Rollback: revert the commit. No state format or persisted field changes; a
record already parked keeps a blocker no rule re-admits under either runtime.

## 2026-11-17: base-repair starts carry their red base's CI evidence; no-change retries under the existing bounds

Decision relayed by the round's coordinator under the owner's standing
instruction to fix blockers: the park-at-once of the entry above is right as
the end state, but alone it would park ai.ubq.fi 1370 and leave the target
wedged. This entry supersedes that entry's "parks at once" and its "Not
chosen" paragraph; its blocker text is unchanged and is now the end state.

- Evidence on a base-repair start
  ([src/repair/base-repair-start.ts](../src/repair/base-repair-start.ts)): a
  fresh start of a base-repair task (`isBaseRepairTask`; nothing is read for
  a body without the marker) carries the checks its base fails (merge-gate
  checks, `failure`/`timed_out`, trusted names only) as the base-repair CI
  finding (`ciCorrectionFinding` with `redBase`). A matrix cell keys its
  existing CI failure evidence read on that opening (`ciCorrectionHead`), for
  the red base itself: the same reader, fence, size bounds and sanitising as
  a CI fix; nothing new is persisted or put in the request. The finding is
  not a CI fix: the start counts `counters.attempts`, never
  `counters.retries`, and is not capped. An unread issue or base check read
  defers the start, uncharged, and so does a base with no completed red
  check while one is still running or none is reported yet
  (`baseCheckState`; review follow-up), so it never starts without the
  finding. Ordinary requests and prompts are byte-identical (digests pinned
  from the previous runtime).
- Not done: the log text is read in the cell after the admission, exactly as
  for a CI fix, and an unreadable log degrades there to the fixed one-line
  reason, as it does for a CI fix. Deferring at that point is not uncharged
  (the ingester settles a cell's `not_started` ambiguous), and an
  availability read before admission would be a new planner-side log read.
- The prompt's "there is no network" is truthful (the hosted permission
  profile sets `network.enabled = false`, `src/host/local-client.ts`);
  unchanged, as is the sandbox policy.
- No-change route
  ([src/repair/base-repair-no-change.ts](../src/repair/base-repair-no-change.ts)):
  when the base review of a base-repair task's no-change hold refuses with
  `BASE_REVIEW_BASE_REPAIR_RED`, the record returns to
  implementation, uncharged, while the issue's no-change outcomes are below
  `MAX_NO_CHANGE_BASE_REVIEWS` = 3 (`issueNoChangeOutcomes`: attempt memory
  summed over the issue's records, its split parts included) and the next
  start would not be refused as identical (`identicalAttemptRefusalV1` at the
  current base and runtime). That start is admitted and charged by the
  ordinary gates and carries the evidence above. Otherwise it parks with
  `BASE_REPAIR_NO_CHANGE_DETAIL`, uncharged. No field is added.
  The review answers that refusal, instead of `BASE_REVIEW_CI_NOT_GREEN`,
  only when the issue it read is the App's with the marker
  (`isBaseRepairIssue`, `isBaseRepairTask`'s own check) and the exact base
  has a completed `failure`/`timed_out` merge-gate check (review follow-up:
  `BASE_REVIEW_CI_NOT_GREEN` also covers a pending base and a required check
  not reported yet, such as a person's fix still in CI, which now defers
  exactly as before). It decides from the reads `inspect` already makes, so
  the hold of any other task reads nothing more.
- Charges per base-repair issue, at most: 3 charged starts that end without a
  change, for the whole issue and its parts together (on one runtime and an
  unmoved base, 1: the retry would be identical, so it parks instead; a base
  that moves admits a retry even on one runtime, up to the same 3); other
  start outcomes under the ordinary rules (the whole issue's start, launcher
  retries of transient failures under their existing bounds, one start per
  split part, 2 to 4);
  3 charged CI fixes (`BASE_REPAIR_CI_FIX_CAP`); and, once a head is green,
  the ordinary review rounds. Through the real loop with a red base and a
  model that never changes anything, a new runtime on every pass gives 3
  charged starts, the park and nothing more
  (`tests/repair/base-repair-no-change_test.ts`). No refunds.
- 1370 (one charge, held until 2026-11-18T00:39:20Z): while its base stays
  red, the new runtime's next base-satisfaction step returns it to
  implementation (a pending base defers it, a green one takes its base
  review as before); its second start
  (`retry`, attempt 2) carries its red base's evidence. On a no-change
  outcome it parks on the next step on the same runtime: 2 charges; 3 at
  most, if a different runtime is installed between that start and its next
  step. If this runtime is installed only after the hold's bound, the
  previous runtime parks it first under the generic hold-bound blocker,
  which no rule re-admits.
- The launcher's runtime gate (`runtimeSourceCarriesCap`) is unchanged and
  passes on this tree. It need not require this behaviour: a runtime without
  it charges no more (the 24-hour hold, then the generic park).
- Skipped: a text-free deferral reason line. `sentinel_repair_pass` is
  re-parsed with an exact key set, so extending it is a cross-version
  contract change.

Rollback: revert the commits in reverse order. Reverting the route alone
restores the park-at-once; reverting the evidence alone leaves the retries
bounded but without the finding or evidence. No state format or persisted
field changes, and an older runtime reads every record shape written here.

## 2026-11-17: the implementer prompt names the never-published protected prefixes

- Before: the role named every configured protected prefix and said that a
  fix which genuinely requires one is made in place because the owner lands
  it (2026-11-05). That holds only for owner-landing prefixes. A change under
  a prefix the publication gate refuses outright (`unpublishablePath`,
  [src/repair/owner-landing.ts](../src/repair/owner-landing.ts): CI-executable
  paths and Sentinel's authority files) parks `candidate touches a protected
  path` unpublished after a full charged run. The live repair state held 11
  such parks on 2026-11-17 (Sentinel #177, #240, #270, #277, #383, #406;
  ai.ubq.fi 1370, whose attempt 2 changed `.github/workflows/deno-deploy.yml`
  after a 767 s run; four generic-target records). For Sentinel, Passport and
  the fixed generic boundary every configured prefix is of that kind, so the
  old text invited exactly that change.
- Now ([src/repair/model-port-prompt.ts](../src/repair/model-port-prompt.ts)):
  right after the configured list, one fixed sentence names those of the same
  configured prefixes the gate's own predicate never publishes, and says:
  never change them incidentally; prefer a solution that does not touch
  them; change one only when the task cannot be solved otherwise, since such
  a candidate is parked unpublished and the repository owner must make that
  change themselves, so keep it minimal and complete. The in-place rule and
  the gate are unchanged.
- The 2026-10-25 withdrawal of a no-change instruction stands. The sentence
  asks for no no-change outcome, no candidate without the needed protected
  part and no final-response report. The first draft of this change did ask
  for that; review reproduced through the real loop that a compliant
  no-change run costs more (an ordinary issue from 1 charge to up to 6: three
  implementations and three charged base reviews; a base-repair task from 1
  to 3), loses the protected signal on its park, lets a base review that
  answers "already satisfied" close the issue, and that nothing reads the
  final response. The follow-up commit replaced that clause.
- Unchanged: a prompt whose configured prefixes include none never published
  is byte-identical, and so is the implementer prompt template digest
  (`29921b7659c5…`, which does not cover this sentence), so no repeat-failure
  park re-arms and this change re-admits or re-charges no parked record.
  `GOLDEN_HOSTED_PROTECTED` is re-pinned: its paths include
  `.github/workflows/`.

Rollback: revert the two commits in reverse order. No state format or
persisted field changes.

## 2026-11-17: backup CI enrols every ubiquity target and calibrates itself

Owner, 2026-11-17 (verbatim), on 22 Prospector PRs and a Passport PR waiting on
CI because the `ubiquity` org has no Actions minutes: "regarding actions minutes
it should be able to fallback to its own org i thought".

- Finding: enrolment was manual. Each target needed an owner-edited row in
  `sentinel.backup-ci-targets.json` with its numeric repository id (it binds
  every store file to one repository, so a reused slug cannot inherit receipts)
  and owner-picked calibration commits in `ops/backup-ci-calibration.json`
  (commits where the job ran natively, including a red, which the leg re-runs
  and compares). Only Passport was listed, so Prospector's
  `validation(not_started)` parks had no backup path. `backup-ci.yml` already
  scopes the target read token to exactly the rows of that file (owner
  `ubiquity`), so listing a target there needs no workflow change; the
  supervisor already mints the same App for all 30 committed targets.
- Enrolment: every `ubiquity/*` target of `sentinel.targets.json` is listed (a
  test pins the equality). A row may carry `id: null`; its id is resolved ONCE,
  on the first pass with stand-in demand and a free leg slot, from the target's
  own read, only when that read answers exactly the configured full name and a
  public repository (closed `enrol:` reasons `renamed`, `private_repository`,
  `unverified_name`, `repository_unavailable`; a calibration or check file of
  another id refuses with `unsupported:repository_id`). Backup legs publish the
  target tree and logs in a public repository, and only Passport carries a
  recorded visibility decision (its committed id). The commit step pins the id
  in `v1/<owner>/<repo>/enrolment.json`; ingest and the supervisor's reader bind
  every file of the row to the pin without another read.

Independent review of the first three commits (2026-11-17) found the automatic
path could produce wrong stand-ins and heavy always-on load. Its named fixes are
part of this change:

- MUST 1, one false green excludes everywhere: runner `916ad9eaff49fe9d`
  (falseGreens 1, a Passport-scoped `false_green` suspension) comes from the
  global leg pins, so the same runner would have calibrated and stood in on 28
  more targets, where no native run is left to catch a repeat. A `false_green`
  suspension of any scope, or `falseGreens > 0` in any calibration or check
  file, now excludes the runner from calibrating and standing in on every target
  until its id changes (leg revision or act pin). The trusted pass then ingests
  but plans nothing (`sentinel_backup_ci_runner` `excluded`); the stand-in rule
  refuses `runner_excluded:<check>`. Consequence: backup CI stands in for
  NOTHING until this false green is diagnosed and the leg is revised.
- MUST 2, calibration bound to what is stood in for: a stand-in for (context,
  workflow path, check name) needs that runner's agreements on exactly that
  check and context in `v1/<owner>/<repo>/checks.json`: at least five distinct
  commits, at least one green and one red, no false green, at most one false
  red. A comparison counts only when the native run is of the unit's event and,
  for `pull_request`, merged against the unit's base (read from the native job's
  own first-step checkout log); a red agreement needs a genuine failure at the
  same workflow step on both sides (native `failure` of a started job, not
  `timed_out`; backup `failure` whose excerpt is no missing-tool error;
  setup-action failures were already no evidence). A false green counts unless
  the event or base provably differs. `pull_request` jobs calibrate on past
  same-repository pull requests whose native checkout binds a base that is an
  ancestor of the head (so the leg's merge tree is the tree the native job
  tested); forks never.
- MUST 3, cost: no target read without a live record whose head waits on CI
  (`ci_pending`, or a pre-review CI park naming `not_started`); demand targets
  are planned longest-wait first, within an 8-minute pass deadline; ingest runs
  first from pins only; no timestamp-only or empty rows, so an idle pass commits
  nothing (the urgent scan window rotates with the run id instead of aging
  through writes); the default-branch tip is a candidate only when a record
  needs it; any client stops for the pass once throttled and the target client
  also below 1000 remaining requests (it shares the supervisor's App limit).
  Calibration legs: one per target and two in all per pass, six per target and
  24 in all per day, counted from every admitted leg in
  `v1/calibration-legs.json` (48 hours), whatever its outcome; sampling reads
  are bounded per target and pass.
- MUST 4, availability during an outage: sampling skips failed runs shorter than
  30 seconds (never started, which fill the newest pages) without a read or a
  leg and pages back up to three pages; only the current runner's entries skip a
  commit, so a new runner after a revision recalibrates on the same history.
  Without a red in reach nothing is planned.
- SHOULD 6: the checkout input code table is read by own keys only. Listing a
  target changes the supervisor's read of it: a never-started run no stand-in
  covers makes `hasAllChecksGreen` return null (no evidence) instead of false,
  so retries treat the head as unread and plan no CI correction or fix for it;
  the read costs the job reads that classify never-started runs, an anonymous
  store read, and, when the store holds a file for the head, the full check-run,
  workflow-run and status listings.
- Closed logs: `sentinel_backup_ci_calibration` per demanded check (`greens`,
  `reds`, `of` 5, reason `calibrated`, `unusable`, `daily_cap`, `unreadable`,
  `no_native_history`, `no_native_red`, `no_native_green`, `unbound`, `budget`,
  `sampling`); `sentinel_backup_ci_incomparable` with `native_missing`,
  `native_event`, `native_base`, `native_unbound`, `native_not_started`,
  `native_not_genuine`, `backup_not_genuine`, `step_mismatch`; a refused
  `actions/checkout` input as `checkout_input=<code>` (the stored reason stays
  `checkout_inputs`).
- Store stall (read-only: sentinel `backup-ci` runs 2184-2188 and store tip
  `7cd1692a7d`): no defect. Every run succeeds and logs Passport
  `{"current":0,"skipped":4,"selected":0}`; all its candidates are final, so the
  pass has no changes and the commit step is skipped. The last writes were
  `updatedAt`-only rows of four candidates that have since left the set.
- Passport false green (`1cfa6ad6`, a `pull_request` peer, leg run 41364279374
  job 125021026580): the leg ran all ten planned steps and each succeeded.
  Native check run 125012919402 was created at about 23:20 UTC (bracketed by
  Sentinel job ids 125010878039 at 23:11:57 and 125017959099 at 23:40:39), when
  the supervisor's 23:11 repair step had just made progress on that record,
  consistent with `1cfa6ad6` being published then. The comparison bound neither
  the native run's event (the planner took the last observation of the group
  across push and pull_request) nor its merge base; both are now refused. Which
  applied here is readable only with the target token, so it is not proven: the
  leg revision is not bumped and the suspension stands. While the runner is
  excluded, each pass logs `sentinel_backup_ci_false_green_probe` (native event,
  job start, failing step number, `sameBase`); a different event or base would
  show the false green compared different code and justify the revision bump.
- Residuals: the workflow mints one target token for all 29 repositories, so one
  repository the App cannot reach fails the mint and stops backup CI for every
  target. A target added later to `sentinel.targets.json` also needs a row here
  (the test fails until it has one) unless `backup-ci.yml` is changed to read
  the committed target setting, which this change does not do.

Rollback: revert the commits in reverse order. No `sentinel-state` field
changes. Store: commit files, `calibration.json` and suspensions keep their
shapes; new files (`checks.json`, `enrolment.json`, `calibration-legs.json`) are
never read by older code, so a reverted runtime ignores them.

## 2026-11-18: the backup CI false green is not yet explained; a held runner revision

Owner, 2026-11-18 (verbatim): "actions minutes restore next month so stop
asking about it" and "should be falling back to the other org to run the ci as
we discussed". Until then backup CI in the ubiquity-sentinel org is the only
source of CI evidence for `ubiquity/*` targets (22 Prospector PRs, job
`validation`, and a Passport PR, job `deno`, never started).

- Evidence: `backup-ci.yml` runs only at `refs/heads/sentinel-supervisor`
  (first attempt) and checks out `github.sha`; that ref equals `development`
  (`afe9c309bd`). Its runs 44216009869 and 44217483301 (01:28 and 01:40 UTC)
  logged `sentinel_backup_ci_runner {"runnerId":"916ad9eaff49fe9d","state":
  "excluded"}`, then `sentinel_backup_ci_false_green_probe
  {"receipt":"bci1:ubiquity/passport.ubq.fi@1cfa6ad61ccf:.github/workflows/ci.yml#deno:pull_request:7003bfe6aa76:a1",
  "legContext":"pull_request","nativeEvent":"push","nativeStarted":true,
  "nativeConclusion":"failure","nativeFailingStep":9,"legBase12":"7003bfe6aa76",
  "nativeBase12":null,"sameBase":null}`, then `backup-ci:plan:skipped`: the
  exclusion stops planning before enrolment, so no target (Prospector
  included) was enrolled, shape-checked or sampled, and the store holds no
  `v1/ubiquity/prospector/` file.
- Verdict (corrected in review): not yet explained. The suspension's native
  check run 125012919402 belongs to a `push` suite and the leg was a
  `pull_request` unit (store commit file: parents `7003bfe6`, `1cfa6ad6`), but
  the leg's synthetic merge carries the head's own tree
  (`syntheticMerge` in `ops/backup-ci-materialize.ts`), so both tested the
  same tree of `1cfa6ad6`. Native step 9, the job's eighth step "Validate all
  retained and native runtimes", failed on push; the leg ran it and it passed
  (leg job 125021026580). Event dependence, a flake and an environment
  difference are not yet separated. Decision rule, from the native
  `pull_request` run of `deno` on `1cfa6ad6` that probe version 2 reports:
  it passed step 9, or never started, then the bump is justified; it failed at
  step 9, then do not bump (the leg missed a genuine failure on that tree).
- Remedy, prepared and held: `BACKUP_CI_LEG_REVISION` 2 to 3 (runner id
  `ea2aacfd1f033045`) is a separate commit that is not installed with this
  change. Installed only under the rule above, the new runner starts
  uncalibrated and calibrates per check under the current rules; the old
  runner stays excluded by its suspension and its `falseGreens: 1` row; no
  suspension or row is edited, and one false green of a runner excludes it
  everywhere again.
- Probe version 2: while the runner is excluded the probe also reports, as
  closed facts, the native `pull_request`-event runs of the same check on the
  evidence commit (at most three: started, conclusion, failing step number,
  the merge base their checkout logged; the workflow blob of those runs is in
  no listing the probe reads). `probe.json` becomes version 2; a stored
  version 1 answer is read once more and replaced, then replayed.
- Only this launcher's runner may stand in: the supervisor derives the
  current runner as the trusted pass does (committed pins and leg revision),
  the store reader puts it on every read, and the stand-in rule refuses a
  receipt of any other runner with the closed code `runner_retired`.
- Fixed with it: 90917aaad6 (visibility re-read every pass) refused every
  private answer, so Passport, private by the 2026-10-23 acceptance recorded
  as its committed id, would get no leg; seven plan-commit and pipeline cases
  failed. Now only an automatically enrolled target (an `id: null` row pinned
  in `enrolment.json`, admitted as public) that turns private is refused.
- Pull request calibration samples (2026-11-18 review): only a merged pull
  request, or one authored by the owner (`0x4007`, id 4975670) or the Sentinel
  App (`ubiquity-sentinel[bot]`, id 319834869), login and id both bound; at
  most four pull reads per target and pass; refusals log `untrusted_pull`. The
  native first step must be `actions/checkout` at a release tag or a full SHA,
  otherwise the run is unbound (calibration, comparison and probe alike).
- Calibration bound to the job definition (2026-11-18 review): a definition
  is hex64 of the workflow file's blob, the job key and the matrix, all bound
  in every unit and result entry (planned steps carry no run text, so the
  blob also catches script changes). Agreements are also kept per definition
  in the new file `v1/<owner>/<repo>/check-defs.json`; disagreements stay in
  `checks.json`. A stand-in needs both the per-check gate and agreements
  under its own receipt's definition, so an older or different definition
  never calibrates the current one and a workflow change recalibrates that
  check. The trusted pass treats a check as calibrated only under every
  definition its demand heads planned, and seeks the green or red the first
  uncalibrated definition still lacks. Residual: a sampled native commit's
  definition is unknown until its leg is planned, so a leg on another
  definition is spent and counts only for that definition; a local action's
  own file (`uses: ./...`) is outside the definition.
- Passport `deno` stays blocked after the bump: its PR head `fe7f6b75` (PR
  215) carries a final `no_evidence` `unsupported:checkout_inputs` (workflow
  blob `f2c61d69`; since 2026-11-05 its `actions/checkout` has a `with:` input
  outside the v1 shape), so the head is never planned and demands no
  calibration. Which input is not stored; the plan of a new head logs
  `checkout_input=<code>`. No stand-in until the leg can reproduce that input
  or the workflow drops it.
- Supervisor cost once store files exist for Prospector heads: each CI read
  of such a head takes three listings (the `filter=all` check runs and the
  workflow runs, both reused for 60 s per process, and the commit statuses,
  always fresh), about 66 for 22 heads on a cold cycle. No code change.
- Prospector `validation`: the row has `id: null`; first enrolment happens on
  the first pass with demand and a free leg slot, once the runner is not
  excluded. Its workflow shape, visibility and native history are not yet
  known to Sentinel (never read). Then the demanded check needs five
  calibration legs at one per target and pass (six a day) before any
  stand-in, from native runs within three pages that started; the never
  started runs of the outage are skipped without a read.

Rollback: revert the commits in reverse order. Once the current-runner gate
is installed, reverting a revision or pin bump leaves the newer runner's
receipts inert by code (`runner_retired`); reverting below that gate needs an
operator suspension of the newer runner, because older readers check neither
the current runner nor the definition. Store: no file changes
shape; `v1/<owner>/<repo>/probe.json` and `v1/<owner>/<repo>/check-defs.json`
are new and older code never reads them (a reverted reader ignores the
definitions and keeps its per-check gate).

## 2026-11-17: protected-path candidates publish and merge (owner: "give sentinel full access")

Owner directive (2026-11-17, verbatim, answering whether Sentinel should open
a pull request when its fix touches a workflow file instead of parking it
invisibly; ai.ubq.fi #1370 and pay.ubq.fi #509 were stuck on exactly that):
"dude give sentinel full access please this is unnecessarily nerfed". Earlier
the same day, about the 1370 fix: "Verified just keep moving forward."

- Changed, at its single source
  ([src/repair/owner-landing.ts](../src/repair/owner-landing.ts)): on every
  target other than Sentinel itself a candidate that changes a configured
  protected path (`.github/workflows/` included; on ai.ubq.fi also its
  owner-landing set: `AGENTS.md`, `docs/DECISIONS.md`, `src/sentinel/`, the
  replay consumer, `.data/`, `.release/`, `.kv-migration/`,
  `src/codex/supervisor-secret.ts`; on generic targets also a target's own
  `sentinel.protected` entries) is published as an ordinary pull request
  and merged through the unchanged gates: current-head CI not red, a
  completed native review with no unresolved P0, task acceptance, custody
  and accounting. Publication validation, the conflict-resolution check
  and the launcher's merge-time gate (`sentinelNeverMerges`) use the same
  predicate. This supersedes the "park unpublished" half of the 2026-11-05
  owner-landing entry, the 2026-11-05 ai.ubq.fi owner-landing list and the
  2026-11-17 never-published prompt entry.
- Kept, never published (`credentialPath`: `.git/`, `.env*`, `.npmrc`, the
  act files `.secrets`, `.actrc`, `.vars`, `.input`, and
  `sentinel.protected`), but only where the target's own configured
  protected list covers the path, exactly as before this entry (corrected
  2026-11-18; the earlier text said "on any target"): Sentinel's own
  repository lists none of them, so this rule refuses nothing there; on
  ai.ubq.fi it covers only `.env`; on Passport `.env`, `.git/`, `.npmrc` and
  the act files, so `.env.local`, `config/.env.prod` and
  `sentinel.protected` publish there; a generic target covers its fixed
  list (`.env` and four named variants, `.git/`, `.npmrc`, the act files,
  `sentinel.protected`), the whole `.env*` family and its own
  `sentinel.protected` entries. The secret-shaped-text detector and the
  publication bounds are unchanged; key and certificate files are refused
  only by that detector (no basename rule existed before or was added).
- Kept on Sentinel's own repository: every configured protected prefix
  (`SENTINEL_AUTHORITY_PATHS`: credential minting and selection, write-token
  dispatch, the merge gate, promotion, the protected-path policy itself and
  `.github/`) is now published, CI-gated and natively reviewed, but only the
  owner merges it (owner-landing: `owner_merge` wait, one progress comment,
  the human merge completes the record). Reason: the self-merge executor
  proves CI with the base's pinned pipeline (`SELF_MERGE_TRUSTED_PIPELINE`
  and `SELF_MERGE_TRUSTED_SOURCES`: `.github/`, `.github/workflows/ci.yml`,
  `test-local.ts`, `ops/native-ci-proof.ts`, `ops/ci-shards.ts`,
  `ops/ci-test-timings.json`, `ops/code-size.ts`, `deno.json`,
  `deno.lock`), and the ordinary launcher path would judge such a PR with
  its own modified CI; an autonomous merge of the policy or merge-gate
  files would also let one reviewed PR lift that proof for the next. The
  same prefixes enforce the AGENTS.md hard rules (credentials and promotion
  out of model workers; `sentinel-release` stays disabled through
  `.github/`). The pipeline files outside the configured list (`deno.json`,
  `deno.lock`, `test-local.ts`, `ops/ci-shards.ts`, `ops/ci-test-timings.json`,
  `ops/code-size.ts`, `ops/native-ci-proof.ts`) are unchanged by this entry:
  they publish and the executor still refuses their merge
  (`self_merge_ci_pipeline_changed`). No branch protection rule or ruleset
  is added anywhere.
- Prompt: the never-published sentence now lists only the credential
  prefixes and says that a change to any other listed prefix is published as
  an ordinary pull request through the same CI and review gates, never
  incidentally, and in place when the task needs it. Sentinel's own list has
  no credential prefix, so its prompt returns to the 2026-11-05 text. The
  template digest (`29921b7659c5…`) is unchanged, so none of the 5 live
  repeat-failure parks re-arms; `GOLDEN_HOSTED_PROTECTED` returns to its
  2026-11-05 value.
- The one safeguard kept, and why: a candidate that changes any `.github/`
  path (`ciExecutablePath`: workflows, composite actions, repository
  automation) is pushed only when its issue was opened by the Sentinel App
  (its capability notices and base-repair issues) or by an author GitHub
  reports as `OWNER`, `MEMBER` or `COLLABORATOR` at read time
  ([src/repair/workflow-trust.ts](../src/repair/workflow-trust.ts)).
  Sentinel pushes its candidate branch into the target repository itself,
  so a changed workflow runs on `push`/`pull_request` with that
  repository's Actions secrets before any review, and the implementer
  prompt carries the issue title and body, which anyone can write on a
  public repository. A leaked secret is not undone by a revert, so this is
  not part of the nerf the owner lifted. An outsider's issue parks with
  "candidate touches a protected path: workflow change from an untrusted
  issue author; owner action required" (the owner lands it, or re-files the
  issue); an unreadable author fails closed into the plain protected park.
  Issue comments never reach the prompt (title and body only), and only the
  author or a collaborator can edit the body. A candidate that changes no
  CI-executable path costs no read and publishes as above. The check runs
  after the charged run: whether a candidate will touch `.github/` is not
  known before it.
- App `workflows` permission: GitHub refuses a push that creates or updates
  `.github/workflows/*` when the installation lacks it. The executor read
  that "[remote rejected]" text as a non-fast-forward conflict; it is now a
  closed status, and publication and preservation park the record with
  "app lacks workflows permission; owner action required" (intent cleared,
  charge kept, no retry and no further charged run; the ordinary blocked
  progress comment names it once). No existing data says whether the
  permission is granted; only the refusal does, so it cannot be detected
  before the charged start.
- The CI integrity rule for a head that changes a CI-executable path: its
  own CI runs its own modified workflow, and a job that workflow skipped or
  marked neutral is not red (2026-10-24), so a workflow whose jobs are all
  skipped would read as green and test nothing. Such a head is green only
  with at least one job its own CI ran to `success` on the exact head
  (GitHub Actions or no app; never a skipped or neutral job, another app's
  check or a backup-CI stand-in, which runs the same modified workflow from
  the merge tree and so proves nothing the head's own run does not).
  Runtime ([src/repair/ci-success-rule.ts](../src/repair/ci-success-rule.ts),
  `decideCiGate(..., { requireSuccess })`): the CI-first review gate spends
  no review round on such a head; it waits `ci_pending` and parks after the
  6-hour bound with the CI-first success park; the delivery and carried
  gates wait. (Superseded: the changed paths are read whenever such a gate
  would proceed, and how is in the 2026-11-18 entry below; the earlier text
  here said they were read only for a head with no passing job.) Launcher
  ([ops/hosted-autonomy-pull-file-gates.ts](../ops/hosted-autonomy-pull-file-gates.ts)):
  `preMergeGate` and the carried proof refuse `ci_success_required` unless
  `hasTargetCiSuccess` proves such a job; an unreadable read refuses. A head
  that changes no such path, or that has a passing job, is judged exactly as
  before, with no extra read.
- Delivery trains: the production train (`hosted-autonomy-delivery-train.ts`)
  never carries a CI-executable change (`train_ci_executable`): the member
  keeps the per-record path, so it is not stranded. Through the real
  delivery pass the others land as one train and it waits at `delivery`
  behind the moved tip, like a conflicting member, for its refresh and its
  own merge gate. `computeTrainOverlayV1` (`src/repair/train-overlay.ts`,
  `ejected:protected`) has no production caller; it is unchanged.
- Unchanged residual refusers, and what each means now: the original-
  candidate recovery pass skips a candidate touching any configured
  protected path (that record keeps the ordinary flow, which now publishes
  it); existing-PR takeover refuses to adopt a foreign pull request that
  touches one (`protected_path` hold: a person's own PR is never adopted
  with a workflow change); local-mode publication (`local-github.ts`)
  validates against the full configured list (a local run still refuses);
  the owner re-admission tool recognises only the exact unpublished
  protected park (the untrusted-issue park is deliberately not re-admitted:
  a retry would re-run the same untrusted task).
- Residual risk, stated plainly: a model-written pull request, on a trusted
  issue, can now change a target's CI workflow and merge once that changed
  CI passes the CI integrity rule on its head and native review finds no P0
  (P1 and lower never block). The rule's 2026-11-18 form and its residuals
  are in the 2026-11-18 entry below; this entry's "at least one job" was
  superseded twice. Code an existing workflow
  step runs with secrets (tests, scripts) was already ordinary candidate
  work before this entry.
- Open, not changed here: the 11 records parked "candidate touches a
  protected path" all carry `candidateState.preserved: null`: no preserved
  candidate survives to publish without a new charged run, so each needs the
  owner's `sentinel:retry` (or a release list) to proceed; this entry
  releases none. Records already flagged `ownerLanding` on a target keep
  waiting for the owner (the flag is never re-classified). Sentinel's own
  capability notice ("no pull_request CI workflow", pay.ubq.fi #509) is not
  admitted as a task: its first body line is the intake skip marker, and
  `no_ci_and_no_local_verify` parks every record of such a target before
  review. Working it needs intake to admit exactly that App-authored issue
  (one bounded task per repository) and the review gate to exempt its
  candidate when it adds a pull_request workflow, whose own first run on
  the head is then its CI evidence under the rule above.

Rollback: `git revert` the commits in reverse order. No persisted field or
state format changes (the issue wire's `authorAssociation` is an optional
in-memory field, and the new port and surface reads are optional);
older runtimes read every record written here. Launcher (ops/) and runtime
(src/) may roll back separately: an older launcher refuses at merge time
(`protected_path`) what a newer runtime published, and merges a workflow
pull request without the success read (the runtime gate still holds it
before review); an older runtime parks again before publication.

## 2026-11-17: only the owner's and the App's issues are worked; CI trust by provenance; push and merge backstops

Owner directive (2026-11-17, verbatim): "i guess sentinel should only
automatically handle issues that are either authored by me 0x4007 or the
sentinel". This entry also answers a native review of the previous entry's
commits and corrects that entry where stated; the previous entry is kept as
written.

- Admission ([src/repair/issue-admission.ts](../src/repair/issue-admission.ts)):
  on every target an issue is worked only when its author is the owner
  account, bound by login `0x4007` AND numeric user id 4975670
  (`ADMITTED_ISSUE_OWNER`, the one constant: a renamed or recycled login, or
  a response without the id, does not match), or the Sentinel App
  (`ubiquity-sentinel[bot]`, the identity `isBaseRepairIssue` checks; GitHub
  reserves `[bot]` logins for Apps). Intake decides from the listing's own
  author fields (no extra read): any other author's open issue gets no
  record, no comment and no charge, and is reported in the intake line's
  `skippedIssues` with the closed reason `author_not_admitted`. An existing
  record of such an issue parks uncharged with "issue author is not
  admitted; owner action required" at its next model start (implementation,
  retry, CI fix: the pre-start issue read; corrected 2026-11-18: the
  existing-head continuation and closed-publication recovery,
  `loop-existing-head-continuation.ts`, read no issue, so such a record may
  have its replacement pull request re-opened, uncharged and with no model
  run, and then parks at its review request), review request
  (the task-statement read) or Sentinel merge decision (the delivery task
  read, before any merge intent); nothing is pushed or reserved. Its blocked
  progress comment says why once: "Sentinel works only on issues opened by
  its owner or by Sentinel itself; the owner can re-file this issue to have
  it worked." A person's merge of such a pull request is still recorded
  (human-merge, release and closure bookkeeping do not read admission).
- Live state: work records persist no issue author (`source` is
  `{kind, id, revision}`), so the records this affects cannot be counted from
  `sentinel-state`. From the first cycle after install, each live issue
  record whose author is not admitted parks at its next model start, review
  request or Sentinel merge decision; a record waiting on CI or already
  parked changes nothing until then. The intake line names every skipped
  issue.
- CI-executable changes are trusted by the provenance of the text the model
  worked from, not by GitHub's author association (this supersedes the
  previous entry's `OWNER`/`MEMBER`/`COLLABORATOR` rule;
  [src/repair/workflow-trust.ts](../src/repair/workflow-trust.ts)):
  - the owner (login and id): trusted;
  - an App issue of a structured kind whose text Sentinel writes from its
    own facts is trusted: base-repair (the `isBaseRepairIssue` shape) and the
    target capability notice (`<!-- sentinel:skip -->` then
    `<!-- sentinel:target-capability -->`); a review follow-up (its first
    line is the follow-up marker for this repository) inherits its original
    issue's trust (`- Original issue: #N` in its header, before the first
    finding; at most four hops; no origin, a self-reference or an origin
    that does not exist is untrusted); every other App kind (CI outage
    notice, throughput watchdog, anything else) is untrusted;
  - an incident is untrusted without a read (its text comes from logs and
    models);
  - any other author, and the owner's login with a different or missing id,
    is untrusted;
  - an unreadable source is `unavailable` and parks nothing: the
    implementation result continues, and the push guard re-reads it at the
    push and sends nothing while it stays unreadable (a transient read
    failure defers).
  An untrusted source parks "candidate touches a protected path: workflow
  change from an untrusted issue author; owner action required". Its public
  progress comment now says "The fix changes CI workflow files, which
  Sentinel publishes only when the task text comes from its owner or from
  Sentinel's own base-repair or CI capability issues (a review follow-up
  counts as its original issue); the repository owner can land this change
  by hand." The earlier wording promised publication for any issue Sentinel
  opened.
- Changed paths cannot hide from the predicates: the model checkout lists
  `git diff --no-renames --name-only -z` (raw and NUL-separated; without
  `-z` git C-quotes a path with a quote, backslash, control or non-ASCII
  byte, such as `".github/workflows/d\303\251ploy.yml"`, which no prefix
  predicate recognised). Every predicate fails closed on a path it cannot
  classify (`unsafeChangedPath`: empty, a leading `/`, a quote, backslash or
  control character, an empty, `.` or `..` segment): such a path counts as
  CI-executable and is never published or merged on any repository.
- Push backstop
  ([src/github/push-content-guard.ts](../src/github/push-content-guard.ts)):
  every push of model-written content re-derives the paths it carries from
  the actual `base..head` tree diff in the pusher's own object store (`-z`,
  never a receipt's list) and applies the same decision. Task-branch
  publication and base refresh (a conflict resolution included) pass it
  through the port's `pushHead` guard (`recordPushGuard`); every
  `sentinel-candidates/*` preservation passes it in the hosted candidate
  preserver, before validation. On Sentinel's own repository any
  CI-executable path is refused (the port's own repository fact, never the
  caller's claim); elsewhere the source's trust decides; an unreadable diff
  or source sends nothing.
- Every publication route and its gate:
  1. implementation, retry, CI-fix and continuation results: the
     implementation-result gate (`ownerLandingTouch` and trust), the
     preserver backstop, the push guard at publication;
  2. conflict resolution: the trust gate at preservation and at the
     receipt, the preserver backstop, the push guard at the base-refresh
     push;
  3. mechanical and carried base refresh: the push guard;
  4. legacy direct publication: the push guard;
  5. the launcher's candidate port and matrix bundles: the preserver
     backstop, then route 1;
  6. original-candidate recovery: republishes only an already-preserved
     original candidate and skips any configured protected change; no new
     model content;
  7. existing-PR takeover: pushes a person's own pull request head, not
     model content; unchanged (it still refuses to adopt a pull request
     that touches a protected path).
- Sentinel's own `.github/` is unpublishable exactly as before the directive
  (this supersedes the previous entry's statement that Sentinel's
  `.github/` publishes for the owner): the implementation result, the
  publication check (`publicationProtectedPaths` always adds `.github/`
  there), the push guard and the self merge (its base-pinned `.github` tree)
  each refuse it. Sentinel's other authority files still publish for the
  owner and are never merged by Sentinel.
- Merge executors: no caller is the only barrier. The GitHub merge port
  re-reads the exact `base...head` comparison at merge time and refuses
  what Sentinel never merges (`sentinelNeverMerges`: `protection_required`)
  and a CI-executable change that fails the CI rule below
  (`checks_pending`); an unreadable or possibly truncated comparison refuses
  `checks_pending` (a reviewed head has at most the review snapshot's 128
  paths, below the comparison's 300). The native self merge applies the same
  never-merge verdict on its local tree diff after its pipeline pin, until
  its source write (a proof past it settles a merge already on the base):
  `self_merge_protected_path`. The launcher's merge-time gate keeps its shape
  and shares that predicate.
- Authority paths added (on Sentinel's own repository only its owner merges
  a change to them): issue admission and workflow trust with their inputs
  (`base-repair.ts`, `wire.ts`, `wire-issue-author.ts`), the push guard and
  its executors (`push-guard.ts`, `push-content-guard.ts`,
  `port-publication.ts`, `git-executor.ts`, `actions-candidates-preserve.ts`),
  the CI rule
  (`ci-success-rule.ts`), the merge executors' gate (`merge-content-gate.ts`,
  `port-self-merge.ts`) and the launcher's file gates and train
  (`ops/hosted-autonomy-pull-file-gates.ts`,
  `ops/hosted-autonomy-train-members.ts`). The repair-loop files that call
  them, the target policy lists and the launcher's GitHub adapter stay
  ordinary work under the 2026-10-30 decision (existing tests pin that).
  Corrected 2026-11-18: the earlier text said each call is backed by an
  executor gate above; that was false for admission until the 2026-11-18
  merge-executor check, and remains false for the launcher (see that
  entry's residuals). Residual: a weakening of one of those ordinary
  callers is a natively reviewed Sentinel pull request that Sentinel may
  merge.
- CI integrity rule, corrected (this supersedes the previous entry's "at
  least one job"): only GitHub Actions check runs count, never a commit
  status or app-less run, another app's check, a skipped or neutral job, or
  a backup-CI stand-in. (Superseded 2026-11-18, below: the expected names
  no longer come from the base commit, whose push-only jobs no pull
  request head runs, and "the base has none" was not a first CI workflow on
  a repository with pull_request-only CI or a skipped or status-only base.)
  Runtime ([src/repair/ci-success-rule.ts](../src/repair/ci-success-rule.ts)):
  the CI-first review gate and the delivery and carried gates apply it only
  on positive knowledge, when the exact comparison lists a CI-executable
  path; any other head, including one whose comparison is unreadable or
  possibly truncated, decides exactly as before (no false park text), and
  the merge executor holds the unknown case. An unreadable base read waits.
  Launcher (`ciSuccessRefusal`): `targetCiSuccessNames` of the head and the
  base, reduced by the protected gate module (`actionsSuccessNames`); an
  unreadable listing or a head without its base refuses. The launcher gate
  needs no runtime cooperation, so it holds after a runtime rollback.
  Residual: a runtime rolled back to before this entry merges the pull
  requests it merges itself through its own port without the rule.
- Correction (credential paths): `credentialPath` refuses a change only where
  a configured protected prefix covers it. (Corrected again 2026-11-18: the
  earlier text here said every shipped target lists `.git/`, `.env`,
  `.npmrc`, the act files and `sentinel.protected`; it does not. What is
  refused where is stated in the previous entry's corrected "Kept" item.) A
  key or certificate file is refused only by the secret-shaped-text
  detector, as before.

Rollback: revert these commits in reverse order. No persisted field or state
format changes (`authorId` is an optional in-memory wire field). An older
launcher skips an intake summary line that carries the new
`author_not_admitted` reason and does not know the new merge-event code
`self_merge_protected_path`; the runtime and launcher may roll back
separately, with the residuals above.

## 2026-11-18: the CI rule compares like with like; admission and trust edges

A second independent review of the two 2026-11-17 entries found no way to
push or merge an untrusted `.github/` change and no secret exposure, and
named these fixes; each reproduced case is now a test that failed before
its fix. The two entries above are corrected in place where they were
false (marked "corrected 2026-11-18").

- CI integrity rule, redesigned
  ([src/repair/ci-success-rule.ts](../src/repair/ci-success-rule.ts)). For
  a head that changes a CI-executable path, the expected jobs are the UNION
  of the names GitHub Actions ran to `success` (latest run of each name) on
  the heads of the five most recently merged pull requests into the same
  base branch (third review: the union, so a docs-only last merge whose
  path-filtered workflows ran only `lint` cannot shrink the set): the same
  pull-request context, where a push-only or conditional job (a deploy
  skipped on pull request heads) never runs. Only when none of those five
  (or of every merged pull request there is, when fewer exist) has an
  Actions success is there "no prior CI": then the base commit's own
  Actions successes are expected, and only when the base has none either is
  it a first CI workflow, which needs at least one Actions job to succeed on
  the head. Every expected name must conclude
  `success` on the candidate head. No name is exempt, absent, skipped,
  neutral or renamed: anything a workflow-changing head controls could
  produce that state, so an exemption would be the head's own choice.
  Anything unreadable, or a listing that cannot be proven (below), is
  `unknown` and waits (runtime: the
  6-hour CI-first park, now "CI-first: the head changes a CI-executable path
  and its own CI did not run to success every job the last five merged pull
  requests passed; owner action required"; launcher: `ci_success_required`).
  Only GitHub Actions check runs count, as before (never a status, another
  app's check or a backup-CI stand-in). This fixes the two review findings:
  a base whose push-only deploy job passed made every workflow pull request
  wait for ever (probably the motivating ai.ubq.fi #1370, which edits
  `deno-deploy.yml`), and a base without an Actions success
  (pull_request-only CI, a `[skip ci]` or status-only base) let one trivial
  job pass on a repository that does have CI.
- Reads: the listing of the closed pull requests into the base branch,
  `GET /pulls?state=closed&base=<branch>&sort=updated&direction=desc&
  per_page=30&page=N`, read page by page until the five most recently
  merged are proven: a pull request's update time is never before its
  merge, so once five merged ones are seen and the fifth merged at or after
  the last update time read, no unread pull request merged later. Anyone
  can comment on a closed pull request (moving its update time), so a flood
  can only push the proof past the bound (8 pages, 240 pull requests):
  then the rule waits; it can never make an older pull request the
  reference (third review). The parse and proof are shared by the runtime
  client and the launcher adapter
  ([src/github/merged-pull-heads.ts](../src/github/merged-pull-heads.ts)),
  then one check-run listing per walked head (up to five) and the base's
  only in the no-prior-CI case. Read only for a head known to change a
  CI-executable path, at the CI-first, delivery and carried gates and at the
  merge executors. The runtime gates, the runtime merge executor
  (`merge-content-gate.ts`) and the launcher (`ciSuccessRefusal`) share the
  walker (`readCiExpectation`), the verdict (`ciExpectationSatisfied`) and
  the success-name reduction (the launcher reads each raw run as the
  runtime's check shape and calls the runtime's `actionsSuccessNames`), so
  they cannot disagree. Ordinary heads decide exactly as before.
- How "changes a CI-executable path" is known
  ([src/github/changed-paths-read.ts](../src/github/changed-paths-read.ts)):
  the port's change-set read diffs its own local mirror first (`git diff
  --no-renames --name-only -z base head`, raw, never truncated, no API
  read). The mirror holds both commits for every Sentinel head on a target:
  each cycle's foreign-target mirror is a full clone (every branch, so every
  published task-branch head and the base branch history), Sentinel's own
  checkout fetches with full depth, and a head published in the same cycle
  was built in it. Only a head the mirror lacks pays the one exact
  comparison. The extra compare read the reviewer measured on every
  proceeding CI gate and every merge attempt is gone for those heads, and an
  ordinary head is no longer held when the comparison fails or 404s. A head
  neither read lists whole is unknown: the CI gates decide as before and the
  merge executor holds it (`checks_pending`), because it may change CI;
  that hold parks 6 hours after its first unreadable observation (below). The publication-time paths of the push backstop
  are not persisted (no state format change); they are recomputed this way.
- Admission backstop: the runtime merge executor (`port-merge.ts`, already
  owner-merged) reads the issue the pull request's closing link (or its
  acceptance) names immediately before the merge, as before; it now refuses
  `protection_required` when that issue's author is neither the owner
  account (login and id) nor the Sentinel App, whatever its caller decided.
  The native self merge passes the same check. No extra read. The many
  callers (`loop-intake.ts`, `loop-task-context.ts`, `loop-implementation.ts`,
  `loop-review-request.ts`, `loop-merge.ts`, `loop-carried-delivery.ts`,
  `client-issues.ts`, `client-reads.ts`, `client-checks.ts`,
  `ops/hosted-autonomy-github.ts`) stay ordinary work.
- Owner-merged on Sentinel's own repository from this entry (in addition to
  the 2026-11-17 list): `src/repair/trust-markers.ts` (the capability
  notice's two marker lines, split out of `target-capability.ts`, which
  re-exports them and stays ordinary), `src/github/merged-pull-heads.ts` and
  `src/github/changed-paths-read.ts` (extracted from `client-reads.ts` and
  `port-base.ts`, which stay ordinary). The rules and their defining inputs
  were already owner-merged: `issue-admission.ts` (the owner login and id),
  `wire-issue-author.ts` (the author id parse), `workflow-trust.ts`,
  `base-repair.ts`, `ci-success-rule.ts`, `merge-content-gate.ts`,
  `port-merge.ts`, `push-content-guard.ts`, `push-guard.ts`, the launcher's
  `ops/hosted-autonomy-pull-file-gates.ts`. Making every caller owner-merged
  would make most Sentinel self-work owner-merged; it was weighed and not
  done.
- Residuals, stated plainly. A workflow change that keeps a job's name but
  hollows it out (an `echo`), or marks the real step `continue-on-error`,
  still passes the CI rule: native review (P0) and the source rule (only the
  owner's and the App's structured issues may steer a `.github/` change)
  are the remaining barriers. A path-filtered or event-conditional job the
  last merged pull request ran but this head does not trigger makes the
  rule wait and park (fail closed; the owner lands it). A repository whose
  real CI reports only commit statuses or another app's checks is a first
  CI workflow to this rule (statuses never count); its statuses still gate
  through the ordinary rule (red blocks, pending waits) but are not
  required by name. Accepted liveness costs, fail closed (safety over
  liveness): a job only some pull requests trigger (a path filter) is
  required of every workflow-changing head once any of the last five merges
  ran it, so such a head waits and parks and the owner lands it; and anyone
  who comments on more than 240 closed pull requests can hold every
  workflow-changing pull request of that repository in that wait (denial
  of service, never a weaker reference). When the target's own Actions
  cannot start jobs (billing), a workflow-changing head cannot merge
  (stand-ins never count). An owner's or App issue that quotes an
  outsider's text is trusted by the owner's rule: provenance is the
  issue's author, not the origin of every sentence in it. An ordinary
  Sentinel pull request can still weaken an ordinary caller: skip an
  admission park in the repair loop (the runtime merge executor and the
  launcher gates still refuse the merge; an ordinary change for a
  non-admitted issue may be pushed and reviewed, and a `.github/` change
  still needs owner or App provenance at the push); or make
  `client-reads.ts`, `port-base.ts`, `ops/hosted-autonomy-github.ts` or
  `ops/hosted-autonomy-source-reads.ts` answer wrongly (corrected, third
  review: the earlier text said only "the reads are then wrong"). A wrong
  change-set read (an empty list) switches OFF the never-merge verdict and
  the CI rule for that head, and a wrong listing or issue read switches off
  the CI rule's reference or the launcher's admission, so those ordinary
  files are part of what a natively reviewed Sentinel pull request could
  weaken; the owner-merged modules define the rules and parse the inputs,
  not every transport that fetches them.
- Launcher admission (third review, must): the launcher job runs BEFORE the
  runtime job every cycle and merges through its own adapter (`PUT
  /pulls/{n}/merge`), never through `port-merge.ts`, so a not-admitted
  record holding a clean review could merge before the runtime parked it.
  The owner-merged gate module
  ([ops/hosted-autonomy-pull-file-gates.ts](../ops/hosted-autonomy-pull-file-gates.ts),
  `sourceAdmissionRefusal`) reads the source issue's author live
  (`readIssueFacts`, parsed by the owner-merged
  `ops/hosted-autonomy-issue-facts.ts` with the runtime's author-id parse)
  and refuses `issue_not_admitted` (another author, or the owner's login
  with another id) or `issue_author_unverified` (unreadable: no merge, the
  record waits); nothing is charged. `preMergeGate` (delivery and spent
  delivery), `carriedMergeGate` and `trainMemberGate` (before a train is
  built and before every train merge) call it, one issue read per merge
  attempt. A record with no source issue (an incident) is no issue's work.
  The runtime's native self merge resumed from a saved proof
  (`port-merge.ts`) skips the read: a proof is written only after the full
  gate, admission included, passed in an earlier attempt (not a one-line
  change; a proof written by a runtime before admission existed settles a
  merge that runtime had already authorised).
- Unreadable change set, bounded (third review; clock corrected in the
  fourth): the merge executor holds `checks_pending` a head whose change set
  neither the mirror nor the comparison can list, and the delivery CI gate
  proceeds on such a head, so nothing else ended the wait. On each such
  refusal the delivery step reads the change set; while it stays
  unreadable the record waits `ci_pending` marked by the wait's existing
  `cause` (`github`/`unknown`/`change_set`, no new field), and that hold's
  own 6-hour clock starts at the FIRST unreadable observation (an earlier
  ordinary CI wait's `since` never counts; a CI wait in between drops the
  mark and restarts the clock, which only delays the park). Six hours after
  that first observation it parks "change set unreadable; owner action
  required" (`loop-merge.ts`); the CI-path text is never used for it.
- Native merge queue (fourth review): the queue submission
  (`ops/hosted-autonomy-queue-submit.ts`, `PUT /pulls/{n}/merge-async`;
  dormant behind `SENTINEL_MERGE_QUEUE`, ai.ubq.fi only, owner-switchable)
  applies the same `sourceAdmissionRefusal` before its intent write: a
  not-admitted or unverified source is not enqueued, nothing is written or
  charged (`pre_effect_issue_not_admitted`,
  `pre_effect_issue_author_unverified`).
- Accepted residual (fourth review): the launcher's approval pass (approving
  parked fork or first-time workflow runs) and its CI re-run pass still act
  for a not-admitted record's head; they spend CI minutes only and never
  merge (every merge path above refuses it).
- Smaller fixes: a `.github/` path in any letter case is CI-executable
  (`ciExecutablePath`; a case-insensitive checkout runs `.GitHub/`). The
  missing-acceptance review recovery (`loop-review-result.ts`) parks a
  not-admitted issue uncharged instead of deferring with an issue read every
  cycle. A source number GitHub answers with another issue (a transfer) is
  untrusted, not unavailable: a workflow change on it parks with the
  untrusted-source text instead of deferring for ever (the text names an
  untrusted author; the owner re-files the issue in this repository).

Rollback: revert these commits in reverse order. No persisted field or state
format changes. The runtime (src/) and launcher (ops/) may roll back
separately: an older launcher compares a workflow pull request with its base
commit again (the push-only-job wait and the trivial-job pass return there),
an older runtime does the same and reads the comparison again for every
proceeding gate.

## 2026-11-17: one-time release of the eleven protected-path parks; the App's own CI notices stay owner work for now

Owner directives (2026-11-17, verbatim, in order): "dude give sentinel full
access please this is unnecessarily nerfed"; then, after being told that the
11 protected-path parks each need a new charged run and that Sentinel skips
its own "no PR CI" notices: "dude so confusing just make sentinel close out
all my issues". Earlier: "all" (2026-11-15, releasing parked sentinel
issues), "Ok for all" and "Huh just fix it" (2026-11-16). Read as authority
to re-admit parked work through the normal gates at the normal charges where
a new attempt can now succeed; not to weaken the P0 review gate, current-head
CI not red, native review mode, the credential-path refusal, the
trusted-author gate for `.github/` changes or custody, and not to refund
anything.

Released by code (`OWNER_PROTECTED_RELEASES_2026_11_17` in
[ops/hosted-autonomy-owner-releases.ts](../ops/hosted-autonomy-owner-releases.ts),
mechanism
[ops/hosted-autonomy-protected-release.ts](../ops/hosted-autonomy-protected-release.ts)),
each exact park (record id, repository, blocker kind, "candidate touches a
protected path", `since`) from sentinel-state/repair b53e355a4571 (sequence
97103); every one holds `candidateState.preserved: null`:

- No pull request and no published head (the protected head is dropped as
  the `sentinel:retry` exit drops it; base, branch, evidence and counters
  kept): sentinel 177 (6 charges), 240 (5), 270 (2), 277 (2), 383 (2), 406
  (2); ai.ubq.fi 1370 (2; the App's base-repair task, so the trust gate passes
  and `BASE_REPAIR_CI_FIX_CAP` and its no-change park still bound it);
  deno-deploy-workflow 25 (2). 270, 277, 383, 406 and deno-deploy-workflow 25
  keep their base-review receipt and round, as the runtime itself returns a
  "work needed" base review to `work`.
- An open pull request whose published head the parked correction would
  have replaced: arbitrage-bot 7 (PR 20, 8 charges), demo.ubq.fi 23 (PR 51,
  7), notifications.ubq.fi 13 (PR 33, 6). Dropping the record's pull request
  (the label exit's shape) would orphan an open PR, and returning it to `work`
  with the unpublished head kept leaves it deferred forever ("candidate
  preservation descriptor unavailable"). Only the unpublished correction head
  is dropped: the record returns to its own recorded published head, the
  existing-published-head continuation the runtime re-proves against the live
  PR before anything is charged. Released only while that PR is open,
  unmerged, App-authored, on the base branch and at exactly that head;
  otherwise it stays parked (`owner_release_pull_unverified`).

The release is the retry pass's ordinary uncharged work plan (grant 0) in its
one CAS write. No reservation, attempt-memory row or `target.base` changes, so
`producerRequests`, the duplicate-replay guard and the current-matrix walk see
nothing new. A released record has no blocker and any later park carries a
later `since`, so each entry fires at most once with no new field. Run over all
474 live work rows, the planner names exactly these eleven.

Ordering: a release re-run under a runtime without this policy parks again on
the old rule. The release takes effect only while the release state names the
installed runtime, no installation is in flight, and that revision's own
source (owner-landing.ts, loop-implementation-result.ts, workflow-trust.ts and
loop-publication.ts, read at that commit) carries the policy: only a
credential path unpublishable, `sentinelNeverMerges` on the same touch, the
park decided by that touch and the trust read, the App's issue trusted, and a
refused workflow push parked. Anything unproven holds it
(`runtime_unreadable`, `runtime_installing`, `runtime_without_policy`).

Charge bound: one charge per record to start, then the ordinary bounds
(identical-attempt refusal, repeat-failure park, no-change base reviews,
review rounds as accounting, rule C's park on a refused workflow push, the
base-repair cap for 1370). The eight unpublished records each take one
implementation start; the three pull-request records take one CI-fix start if
their head is red or one review round if it is green. First round: at most
eleven charges. On Sentinel's own repository a candidate that touches an
authority path publishes and waits for the owner's merge (`owner_merge`).
What code cannot give: the ubiquity organisation's Actions minutes (a head
whose own CI never runs cannot prove the success a CI-changing head needs),
the App's `workflows` permission (the first refused push parks after one
charge) and a red ai.ubq.fi base.

Not implemented here, design only: working the App's own "no pull_request CI"
capability notices (pay.ubq.fi 509 and the notices of
prospector-chrome-extension, stake.ubq.fi, prospector-monorepo and xp.ubq.fi,
whose 73 records are parked `no_ci_and_no_local_verify`). The opt-out marker
is read in at least nine places (pre-reservation, matrix cell, base review,
queue delivery, published refresh, delivery, closure, queue policy and
intake), the planner parks every record of an incapable target before any
reservation, and the review-only merge is refused for such a target. A bounded
change needs the notice to become an App-authored task (marker first, fixed
task statement), an exemption at the planner park and merge evidence for
exactly that task, and a reader landed before the writer for rollback. Until
then the owner action is a pull_request CI workflow in each repository; the
existing re-check then re-admits the parked records.

Rollback: revert the release commit. Before its write the eleven stay parked;
after it, each released record is an ordinary `work` record (or an
existing-published-head continuation) the previous code handles normally. No
persisted field or state format changes; older runtimes read every record.

## 2026-11-18: the one-time protected release checks admission and provenance trust

The 2026-11-17 release entry above was written before issue admission and
provenance trust landed. Integrated onto them (2026-11-18):

- The installed-runtime source gate now proves the policy as it finally
  stands (`runtimeSourceCarriesPublicationPolicy`, six installed files read
  at the installed revision): a credential path is the only unpublishable
  path and `sentinelNeverMerges` is the same touch (`owner-landing.ts`); the
  park is that touch or an untrusted source (`trust === "untrusted"`,
  `loop-implementation-result.ts`); trust follows provenance (the owner's
  issue trusted, any other author untrusted, of the App's only the
  base-repair and capability shapes, `workflow-trust.ts`); a refused
  workflow push parks (`loop-publication.ts`); only the owner account (login
  `0x4007` and id 4975670) and the App are admitted (`issue-admission.ts`);
  a not-admitted record parks uncharged before its start
  (`loop-implementation.ts`). The two shapes the earlier gate required and
  the final source no longer has (`trust !== "trusted"` and the blanket "an
  App issue is trusted" rule) are gone from it.
- Each release now reads its source issue live over its own repository
  (`readIssueFacts`, the runtime's author-id parse) and applies the
  runtime's own rules (`issueAuthorAdmitted`, `recordCiTrust`): a record
  whose author is not admitted, or, on a target, whose provenance is not
  trusted, or whose source cannot be read, stays parked with
  `owner_release_not_admitted`, `owner_release_untrusted` or
  `owner_release_source_unreadable`: no write and no charge, instead of a
  charged run that would park again. The parked candidates are gone, so
  whether a target's fix needs `.github/` is unknown and every target
  release needs trust; on Sentinel's own repository trust is never consulted
  (its `.github/` never publishes; an authority change lands for the owner).
- The eleven, offline (work records persist no author): Sentinel 177, 240,
  270 and 277 are the owner's issues and 383 and 406 the App's
  self-observation issues (from the reviewer's issue listing): all admitted;
  trust is not consulted on Sentinel. ai.ubq.fi 1370 is the App's
  base-repair issue: admitted, and trusted by provenance while its body
  keeps the base-repair marker on its first line (a test pins both, and that
  the same App issue without the marker is untrusted). deno-deploy-workflow
  25, demo.ubq.fi 23, arbitrage-bot 7 and notifications.ubq.fi 13: their
  authors are not in state and no other repository was read, so each is
  decided by the live read at release time and released only when it is the
  owner's (or a structured App issue).
- Sentinel 270 is removed from the release (third review): its issue,
  "finalize always chains supervisor-dispatch", needs Sentinel's own
  `.github/workflows/`, which never publishes, so a release would only
  spend a charged run that parks again; it stays parked for the owner. Ten
  records are released. Sentinel 383 and 406 (the App's self-observation
  issues for the supervisor's `finalize` and `repair_cell` jobs) are kept:
  the code those jobs run lives mostly in Sentinel's `src/host/` authority
  files, which now publish for the owner's merge, and nothing in state says
  their parked candidates touched `.github/`; if one did, the cost is one
  charge and the ordinary park, bounded.

Rollback: revert this commit; the release then gates on the earlier shapes,
which the final source does not carry, so it holds every release
(`runtime_without_policy`).

## 2026-11-18: no private repositories in backup CI (owner decision)

- Owner decision (2026-11-18), after being told that a backup leg publishes a
  private target's whole tree as a one-day public Actions artifact and full
  public job logs in this public repository: "So moving forward let's simplify
  the logic: no private repos. Ci must run on the private repo I guess."
- This supersedes, for backup CI, the 2026-10-23 Passport visibility
  acceptance (three-target scope) and the Passport use of the 2026-10-24
  backup decision, and withdraws the 2026-11-18 committed-id exemption
  ("keep Passport's committed visibility decision on the re-check",
  `59098d4c23`). There are no exceptions.
- Private targets get CI evidence only from their own repository's CI. While
  their organization has no Actions minutes, their pull requests wait (a
  never-started check reads as no evidence, never as red). Sentinel still
  writes, reviews and merges their pull requests under the unchanged gates.
- Trusted pass (`ops/backup-ci-pass.ts`): every target, committed id or
  enrolment pin, has its visibility read on every pass with the repository
  read the planner already makes; private plans nothing (no stand-in,
  confirm, peer or calibration leg, no tree materialised or uploaded) and logs
  `backup-ci:<repo>:private_repository`; an unreadable answer plans nothing
  (`repository_unavailable`). A committed id is identity only. Ingest of legs
  already dispatched is unchanged and harmless: their results stand in for
  nothing.
- Stand-in rule (`selectBackupCiForCommit`, shared by the supervisor's check
  read and the runtime's): the target's own workflow-run listing, which the
  rule already reads for the suite map, carries GitHub's current
  `repository.private`. A stand-in or peer needs every run to say `false`;
  `true` refuses the commit with the closed code `private_repository`, and a
  missing or malformed field with `visibility_unknown`. No new read, store
  file or state field; the store is neither deleted nor rewritten, so
  Passport's older receipts stay on the branch and are inert.
- Configuration: `sentinel.backup-ci-targets.json` keeps every ubiquity
  target listed (the two-file sync with `sentinel.targets.json` holds), so
  a private target's never-started runs keep reading as no evidence instead
  of red; Passport keeps its committed id as identity only. Passport's eight
  calibration commits are removed from `ops/backup-ci-calibration.json`.
  Prospector and every other private `id: null` row stay refused at
  enrolment as before.

Rollback: revert the commits; Passport then plans legs again and its older
receipts stand in again, which this decision forbids.

## 2026-11-18: Sentinel works no private target repository (owner decision)

- An audit found that ordinary supervisor runs, which execute in this public
  repository, publish private target content: Actions artifacts kept seven
  days and downloadable by any signed-in user (`sentinel-matrix-plan-*`
  `plan.json` with each cell's model request, issue title and full body;
  `sentinel-matrix-cell-*` with `result.json` and a `git bundle` holding the
  full contents of every file the model added or changed) and review receipts
  on the public `sentinel-state/repair` branch (prose summaries with
  file:line descriptions). Asked "should Sentinel stop working prospector and
  passport until the exposure in its normal runs is fixed? I recommend yes.",
  the owner answered, verbatim: "2 ok". Earlier the same day: "So moving
  forward let's simplify the logic: no private repos."
- One predicate, one owner-merged authority file
  ([src/repair/target-visibility.ts](../src/repair/target-visibility.ts),
  added to `HOSTED_AUTHORITY_PROTECTED_PATHS`): `sentinelWorksRepositoryV1`
  accepts a repository only when GitHub's own answer on the repository read
  says it is public (`private: false`, and `visibility: "public"` when sent).
  `private: true`, `visibility` `private` or `internal` is private; a missing
  or malformed field is unknown and is never treated as public. There is no
  owner switch: a future deployment that may work private repositories
  replaces this predicate.
- Where it applies: target load (`loadTargetConfigsV1`, `src/host/targets.ts`)
  reads the visibility from the same `GET /repos/{owner}/{name}` answer that
  already gives the default branch (`resolveRepository`; no extra read). A
  private target is never configured (`privateTargets`); an unknown answer
  skips the target like an unreadable default branch. Every caller of the
  loader uses it: the runtime's serial repair job, the matrix planner and
  cells and repair cells (`runActionsRepairHost`), the launcher's
  closed-matrix recovery (`ops/hosted-autonomy-matrix-adapters.ts`), the
  maintenance publication and the local host. A record of an unconfigured
  target is already skipped by every runtime cycle (`selection.ts`
  `unconfigured`, existing-PR reconciliation, the planner's ranking), so a
  private target gets no issue listing into a plan, no model request, no
  cell, no bundle, no review, no receipt, no progress comment and no state
  row from the runtime. The runtime prints one text-free line
  `{"kind":"sentinel_private_targets","reason":"private_repository",
  "skipped":N,"listed":M,"configured":K}`.
- A private skip is never a read failure: the "every committed target read
  was unavailable" deferral counts only the targets that are not private, so
  a deployment whose public targets load runs normally. Private plus
  unreadable with nothing configured defers or fails exactly as the
  unreadable targets alone would. A setting whose every target is private
  configures nothing and refuses as an empty setting (`targets_empty`, red),
  as a setting that authorizes no work always has.
- Existing private-target records (prospector, passport and any other
  private target; the runtime and the launcher decide live, no list is
  written) are not parked, rewritten, charged, commented on, merged or
  closed; their pull requests and unsettled reservations stay as they are
  and resume untouched if the predicate is later replaced.
- Launcher ([ops/hosted-autonomy-private-targets.ts](../ops/hosted-autonomy-private-targets.ts)):
  the maintenance passes walk repair-state records, not the target setting,
  so `runHostedAutonomy` reads and writes state, and resolves repository
  surfaces, only through one gate per run, which the production
  composition (`hosted-autonomy-main.ts`) also hands the merge-queue
  coordinator and its publication. Closed-matrix recovery and uncertainty
  maintenance take the gated state from the runner (and closed-matrix
  recovery and the maintenance publication load target configs, which never
  include a private target); backup CI already refuses a private target.
  - A read hides every row of a repository the same predicate does not
    accept, in every repair-snapshot collection that names a repository
    (`incidents`, `evidence`, `work`, `reservations`, `reservationArchive`,
    `reviews`, `ownerSuccessorReviews`, `replays`, `releaseRequests`,
    `attemptMemory`, `lessons`, `targetCapabilities`; `githubCooldowns` and
    `tierScans` name none). The classification is typed over the contract's
    own keys, so a new collection does not compile unclassified. An optional
    collection (`reservationArchive`, `ownerSuccessorReviews`,
    `targetCapabilities`) whose every row is hidden is left out of the view,
    exactly as in a snapshot that never had one, because the contract refuses
    an empty one. A write puts it back with its hidden rows. The contract's
    only cross-collection rule (an id is never both live and archived) holds
    in the view, since hiding is by repository in both collections.
  - Every hidden view is checked with the contract parser
    (`parseRepairStateSnapshotV1`) before a pass sees it. The run's first
    read goes through that check before any pass runs. A view the parser
    refuses ends the run there: `skipped`, `snapshot_invalid`, action
    `private_targets:view_invalid`, no GitHub read or write, and the queue
    custody output not ready. That first read is handed to the first state
    reader (queue custody), so the check costs no extra state read.
  - A write through the view gets the hidden rows back byte-identical (the
    exact rows of the snapshot at the expected head), each after as many
    visible rows as preceded it, so a pass that keeps its rows in place
    leaves every hidden row at its index. A write that names a hidden
    repository in any row, or that would make the store compact a
    reservation ledger holding hidden rows, is refused
    (`private_repository_row:<collection>`,
    `private_repository_compaction:reservations`) and nothing is written.
  - A write against a head the gate read or wrote this run costs no extra
    state read; the store's own compare-and-swap answers a head that has
    since moved, and that conflict comes back unchanged. A write against a
    head the gate never saw reads the state once; a moved head there is
    answered the same way, as a conflict with nothing written.
  - A full hot+cold ledger read through the gate falls back to the hidden hot
    view, and the repair tiers never list a hidden repository, so no tier
    pass selects its rows by its open issues and none demotes them. Hidden
    rows' content never changes, but the rows may still move. Tier promotion
    can carry them between cold and hot as byte-identical tree moves:
    through a promote-all scan, a release seed, or a hot row's dependency.
    The store's own reservation-ledger compaction, which runs on a runtime
    write past the ledger bound, can archive a settled private reservation
    unchanged. History reads (`openRepairHistory`) stay raw: a pass that
    tried to write a hidden row recovered from history would be refused.
  - `githubFor` answers null (the documented unreadable surface: the record
    is skipped, nothing changes) for any repository not proven public this
    run, so no merge, comment, issue, CI re-run or approval, notice or
    backup-CI demand reaches it.
  - Visibility is one `GET /repos/{owner}/{name}` per distinct repository
    the hot state names, per run, cached for the run on the launcher
    surface, which now also serves every later default-branch read of the
    run from that answer (each pass scope used to read it again). The hot
    state of 2026-11-18 holds 479 work records over 25 repositories
    (prospector 77, passport 14, Sentinel itself 95, never read): at most
    24 reads per run, under 300 an hour at one run every five minutes,
    against the App installation's 5,000 an hour, and partly offset by the
    repeated reads it replaces. Unknown or unreadable hides the repository
    for the run. Sentinel's own repository is never read or hidden, since
    it is the public repository the launcher runs in. A failed visibility
    read hides only the repository it was for, so it cannot stop Sentinel's
    own delivery, self-observation or the owner-merge flow; a launcher test
    fails every foreign read and Sentinel's delivery still merges and writes.
    A hidden view the contract parser refuses is different: it stops the
    whole run before any pass, Sentinel's own work included, until the state
    is repaired. With the empty-collection rule above no such view is known.
  - One text-free line per run that hid anything:
    `{"kind":"sentinel_private_targets_hidden","reason":"private_repository",
    "repositories":N,"rows":M,"refusedWrites":K,"invalidViews":V}`.
  - Derived counters see only the visible rows: delivery and tier metrics,
    the throughput watchdog inputs (durations, planned cells, refresh and CI
    runs per merge, owner notices; no threshold counts merges), CI-outage
    and capability notices, base-repair filing and CI resume (all derived
    from visible waiting records), and uncertainty maintenance (a hidden
    unsettled reservation stays as it is). None files an issue, raises an
    alarm or fails the run because rows are hidden. The runtime watchdog's
    ready-but-unplanned count is the planner's ready set, ranked over the
    configured targets only, so a private record in the raw state is skipped
    as unconfigured and never counted as ready work. The park summary and the
    memory digest still read the raw state and list private parks by id, as
    before.
- Already published artifacts and state history are not deleted (the owner
  declined deletion), and no workflow is changed here. A later workflow
  change should shorten matrix artifact retention and stop uploading
  `plan.json` and cell bundles in the clear (encrypt them or keep them out
  of artifacts).

Rollback: revert the commits; private targets are then configured, planned
and run again, and the launcher steps their records again, which this
decision forbids.

## 2026-11-18: private targets follow the host repository's own visibility

- Owner, 2026-11-18, on a second, private deployment of the same code
  (`ubiquity-sentinel-private/sentinel`, kept in sync by fast-forwarding from
  this repository's `development`): "can you please just handle all that".
  Both deployments run identical code, so the public-only rule above now
  depends on the deployment, never on a code difference or a setting.
- Rule, in the same authority file
  ([src/repair/target-visibility.ts](../src/repair/target-visibility.ts)):
  `sentinelWorksRepositoryV1(visibility, host)`. A host is private only when
  GitHub's answer on a read of the run's own repository (`GITHUB_REPOSITORY`,
  already bound to the committed controller by the native identity check)
  says private, and the committed setting does not list that repository
  (`resolveSentinelHostV1`). A host proven private works private and internal
  targets and ONLY those; every other host (public, unreadable, unstated, or
  one that lists itself) is exactly the public-only rule. Unknown target
  visibility is skipped on every host. There is no variable: no env, file or
  fixture can make a public host work a private target, and no opt-in is
  added on a private host (it would need a workflow edit, which stops
  runtime auto-follow, and adds no safety beyond the host's own visibility).
- Public host (this deployment): it lists `ubiquity-sentinel/sentinel`, so
  the host is never read. Loads, reads, log lines, skips and state are
  unchanged; no extra GitHub read.
- Private host: the runtime (`runActionsRepairHost`) reads the host once per
  job on the self credential (`SENTINEL_SELF_TOKEN`, else `GITHUB_TOKEN`),
  configures private targets, lists public ones in `publicTargets` (never a
  read failure) and prints the same text-free line with reason
  `public_repository`. The launcher gate decides the host once per run
  (local read of the checkout's setting; the self surface's cached repository
  read only when it does not list itself), shows rows and surfaces of
  repositories proven private and hides public and unknown ones (line
  reason `public_repository`). Public targets, Sentinel's own repository
  included, stay with the public deployment, so no target is double-worked;
  the private mirror is not in the setting and is never a target.
- Unchanged: backup CI still refuses private repositories
  (`private_repository`). Closed-matrix recovery and the maintenance
  publication load targets without a host, so on a private host they stay
  public-only (fail closed). A private deployment cannot run yet: the
  controller binding (`hosted-controller-deployment.ts`,
  `hosted-supervisor.ts`) and many self references are fixed to
  `ubiquity-sentinel/sentinel`, so its launcher and runtime refuse their
  identity first.

Rollback: revert the commit; every host is then public-only again, as in the
entry above.

## 2026-11-18: two committed controller deployments, selected by GitHub's own repository name

- Owner, 2026-11-18, on the second, private deployment
  (`ubiquity-sentinel-private/sentinel`, same code, kept in sync by
  fast-forward): "can you please just handle all that". The single committed
  controller binding becomes a committed closed list of exactly two entries in
  the same owner-merged authority file
  ([src/contracts/hosted-controller-deployment.ts](../src/contracts/hosted-controller-deployment.ts),
  already in `HOSTED_AUTHORITY_PROTECTED_PATHS`):
  - `public`: `ubiquity-sentinel/sentinel`, byte-for-byte the former
    constants (branches `development` / `sentinel-supervisor`, supervisor
    workflow 357012162, CI workflow 353613034), and the retired
    `ubiquity/sentinel` names for state reads, as before;
  - `private`: `ubiquity-sentinel-private/sentinel`, same branches and
    workflow paths, no retired names, the App's installation on the
    `ubiquity-sentinel-private` org (183425201) recorded as its self scope,
    and both workflow ids `null` until GitHub registers its workflows.
- Selection: a process that may read `GITHUB_REPOSITORY` (GitHub's own
  value) selects the entry with exactly that name; any other name, or none,
  or a process without that grant, selects the public entry, whose native
  identity checks refuse anything but the public repository exactly as
  before. The recorded invariant is restated, not relaxed: neither an
  environment variable nor target configuration can add, alter or otherwise
  choose an entry; GitHub's repository name only picks one of the two
  committed entries, and the existing checks (workflow ref, run reads through
  the selected repository's API path, committed workflow ids) then verify the
  run against it. Every existing consumer of the binding (runtime and
  launcher identity, state remote, refs, workflow ids, auto-follow, dispatch,
  bootstrap) reads the selected entry with no code change of its own.
- Fail closed: selecting the private entry refuses to start (module load
  throws `hosted controller binding refused: <reason> <repository>`) while
  either workflow id is `null` (`workflow_ids_unfilled`) and while the
  private role is not wired (`private_role_unwired`, a committed `false` in
  the same file). The private role's wiring is a later change: Sentinel self
  passes turned off rather than re-pointed at the private repository;
  release, install promotion and backup CI refused; state only on its own
  `sentinel-state/*` branches; its dispatcher and auto-follow able to read
  `GITHUB_REPOSITORY`; its self-token mint scoped to its own organization.
  Filling the ids alone therefore does not start it.
- Public host: unchanged. Its processes either read `GITHUB_REPOSITORY` as
  `ubiquity-sentinel/sentinel` or cannot read it; both select the public
  entry, whose values are the former constants. No new read, request, state
  field or workflow edit.

Rollback: revert the commit; the public deployment is unaffected either way,
and the private one again cannot select itself.

## 2026-11-18: the private role turns Sentinel-only paths off; each deployment mints its own self token

- Follows the entry above (two committed controller deployments). On the
  private role every path that works Sentinel itself, or a service only the
  public deployment runs, reports the closed reason `private_deployment` or
  refuses before any read, instead of being re-pointed at the private
  repository. This deployment's own infrastructure (state, maintenance index,
  runs and logs, install API, writer quiescence, native principal, runtime
  policy sources read at the active revision) keeps reading the selected
  entry, which is its own repository. The public role takes every former
  branch unchanged.
  - Self-observation and CI-outage notices: the launcher pass that wrote
    nothing records `self-observation:skipped:private_deployment` and
    resolves no Sentinel surface.
  - Finalize: no throughput-watchdog issues (the step summary names the
    reason); the upkeep-deferral notice is its log line, never an issue.
  - Backup CI: the committed targets file lists nothing on the private role,
    so no store reader is composed (no fetch of the public backup branch)
    and the launcher demands nothing; the backup pass already refuses any
    repository but the public one before any request.
  - Owner development install: its repository is the public one literally
    (public history), so a private host refuses its identity before any
    read; its remote was already the public literal.
  - Target load: a host proven private never reads or works a committed
    Sentinel deployment (public or private); it is listed in
    `publicTargets`, left to the public deployment.
  - App principal: the self controller port follows the selected entry
    (`isHostedControllerRepository`), not the public literal.
  - Self installation: a deployment that commits one (the private entry,
    183425201) refuses any other `SENTINEL_SELF_INSTALLATION_ID`, so a self
    token minted for another organization never reaches its state.
  - Auto-follow (`deno task follow:run`) may read `GITHUB_REPOSITORY`, so it
    selects its own deployment.
- Proof through real consumers (`tests/host/private-deployment-role_test.ts`):
  a copy of this tree with the private entry bound (test ids) and wired runs
  as the private deployment and passes seven cases: its own identity and
  remotes; the committed self installation only; no backup CI and no git
  operation; owner install refused; the hosted runtime (real Git state,
  release custody and native identity) configures only its private target
  and sends no request naming `ubiquity-sentinel/sentinel`; the launcher
  merges a reviewed target pull request through that target's surface only;
  a quiet launcher pass reports the closed reason and never resolves
  Sentinel. The issue-to-pull-request half (intake, implementation,
  publication, review request) has no private-role proof yet, so the
  committed `PRIVATE_ROLE_WIRED` stays `false` and the private deployment
  still refuses to start, with or without its workflow ids.
- Workflows (own commit): every self-token mint in `supervisor.yml` (seven
  jobs) names `owner: ${{ github.repository_owner }}` and
  `repositories: ${{ github.event.repository.name }}` instead of the public
  literals, so each deployment mints its own repository's token (on the
  public repository these are `ubiquity-sentinel` and `sentinel`; the
  supervisor runs only on `workflow_dispatch`, whose payload carries the
  repository, and a test pins that trigger). The dispatcher's dispatch step
  may read `GITHUB_REPOSITORY`. This changes the `.github/workflows` tree, so
  auto-follow will not advance `sentinel-supervisor` to it: one manual
  advance is needed. Not changed (listed for the operator): `backup-ci.yml`
  self mint (public-only; inert with `SENTINEL_BACKUP_CI=off`), `repair.yml`
  literal dispatch path (manual), `queue-canary.yml` (guarded to the public
  repository).

Rollback: revert the commits; the private role then re-points the Sentinel
paths at its own repository again (it cannot start either way), and the
workflow mints the public repository's self token again.

## 2026-11-22: the vanished `ubiquity/passport.ubq.fi` leaves the committed target files

- Outage: from 2026-11-20 02:50Z every `supervisor.yml` run failed at "Mint
  the scoped sentinel App token" (and every `backup-ci.yml` run at "Mint the
  target read token") with HTTP 422 "There is at least one repository that
  does not exist or is not accessible to the parent installation". Both mints
  take their repository list only from the committed files
  (`sentinel.targets.json` through "Resolve the committed target
  repositories", `sentinel.backup-ci-targets.json` through "Read the backup
  targets"), so one name the installation cannot resolve fails the whole mint
  and the run before the runtime starts.
- Cause: `ubiquity/passport.ubq.fi` no longer exists under that name (the
  organization's repository listing no longer has it). It was private and,
  since the 2026-11-18 "no private repos" decision, not worked here.
- Change: that one name is removed from both files (29 committed targets: 28
  foreign mint names and 28 backup rows; the two-file sync holds). Nothing
  else changes: no workflow edit, so auto-follow can install it, and the
  Passport-specific policy code (named policy, work trial, deploy-check
  filter, CI-minute policy rows) stays, inert without the target. No other
  name is added.
- Existing records (its work rows, receipts and any other rows in state) are
  left untouched: not rewritten, parked, charged, commented on, merged or
  closed. The runtime never reads or configures a repository the setting does
  not list, so its records rank `unconfigured`. The launcher's private-target
  gate still reads each repository the state names once per run; for this
  one that read now answers 404 (the name is gone, and outside the minted
  token), so its visibility is unknown and it is hidden for the run: no
  surface, no write, its rows restored byte-identical on every write, no
  `view_invalid`, and no second read in the run
  (`tests/host/removed-target-records_test.ts`).
- Re-adding the repository under any name, a renamed one included, is an
  owner decision, made in both committed files.

Rollback: `git revert` the commit. The name then returns to both files, and
every mint fails again until GitHub resolves it.

## 2026-11-22: one unreachable target costs only that target; a pre-runtime failure loop backs off

Owner, verbatim: "Make it more resilient so this problem never crashes it
again", then "Don't notify me just handle it automatically" (no issue or
notice is filed; the run carries on without the target and logs it).

- Where the 2026-11-20 outage came from: the first job of every supervisor run
  (`maintenance`) and the jobs after it mint the foreign App token with the
  pinned upstream `actions/create-github-app-token` (maintenance, prepare,
  matrix_cell, repair_cell, finalize, and `backup-ci.yml`) or the vendored
  `.github/actions/sentinel-app-token` (matrix_plan, repair), always for every
  committed name. GitHub refuses the whole list (HTTP 422) when one name was
  renamed, deleted, transferred or removed from the installation, so no
  runtime code ran. Every failed run still chained the next dispatcher run,
  which looped about every 90 s until the API quota ran out.
- Auto-follow compares only the `.github/workflows` tree id
  (`hosted-runtime-follow-api.ts` `workflowsTree`), so a change under
  `.github/actions/` installs automatically; a change under
  `.github/workflows/` still needs one manual launcher advance.
- Dispatcher backoff (code only; the dispatcher runs from `development`, so
  it is live without a launcher advance): `supervisor-dispatch-backoff.ts`
  reads the newest completed supervisor runs once. Three or more newest
  `failure`/`startup_failure` runs, each completed within 3 minutes of its
  start (the outage's failures took 38-50 s; a green idle run can take about
  nine minutes), at the launcher SHA the follow step just read make the next
  dispatch due 5, 10, 20, then at most 30 minutes after the newest of them.
  Before it is due the hop first dispatches the dispatcher workflow itself
  (the chain can never end; GitHub's cron has run 4-9 h apart) and then holds
  at most 150 s inside its 5-minute job. Each hop runs auto-follow first, so
  a fix is installed within one hop, and a new launcher SHA or one success has
  no streak and dispatches at once. An unreadable or malformed listing, or a
  refused self-dispatch, fails open to the ordinary dispatch. The saving is
  about two failing supervisor runs an hour instead of forty; the dispatcher
  itself still hops about 15-17 times an hour (a few GITHUB_TOKEN reads and
  one dispatch each). One text-free `dispatch_backoff` line names the
  decision, a closed reason and the streak. The module joins the protected
  authority paths with the dispatcher.
- Tolerant mint (vendored action, code under `.github/actions/`; explicit
  opt-in input `tolerate-inaccessible-repositories: "true"`): the upstream
  request pair runs first, so a reachable list is byte-identical with no
  extra request. Only GitHub's refusal of the list (422 "not accessible to
  the parent installation", or a first-name installation lookup that is
  missing or belongs to another account) starts a bisection by probe mints
  for subsets of the same list with the same permissions (at most 64, each
  masked and revoked at once), always against the requested owner's own
  installation: lookups never follow a redirect and are accepted only when
  `account.login` is the requested owner, because a repository transferred to
  another account where this App is installed would otherwise yield that
  account's token. A token naming any repository outside the request is
  revoked and fails. The token covers exactly the reachable names, never
  more; permissions are unchanged; `unavailable-repositories` and one warning
  line (`repositories_unavailable`, the count and the listed slugs) name the
  dropped ones. Ceiling: at most 3 names and at most a quarter of the list may
  be dropped (one rename, transfer, deletion or uninstall costs one name;
  more is an installation-wide change or a partial GitHub view, so the mint
  fails as before instead of silently shrinking the fleet). No reachable name
  or a spent probe bound also fails. Self mints never select it, so an
  unreachable Sentinel repository fails closed. The seed's closed action file
  list (`SELF_ACTION_FILES`) gains `lib/tolerant-mint.js`, without which
  every self-test dependency seal would refuse.
- Cost: with the ceiling, one tolerant mint of the 28 foreign names spends at
  most about 26 token POSTs (and about 12 revocations) when 3 names are bad,
  about 12 for one. Only maintenance searches: it publishes its dropped names
  as a job output, and every later supervisor job passes them as the
  `known-unavailable` hint (it can only remove listed names; a stale hint
  costs only that target for one run), so each later job mints directly with
  one POST. Worst case per run: about 26 POSTs in maintenance's first seconds,
  then one per job (up to 20 cells 6 s apart, about 10 a minute); backup CI
  searches alone, at most about 26 POSTs a pass. Even both searches in one
  minute stay under GitHub's 80-per-minute content guidance.
- A dropped target is excluded for the run explicitly, closed reason
  `token_scope` (`src/host/target-token-scope.ts`), because a read alone does
  not prove it: an installation token can read any public repository, so a
  public target removed from the installation would otherwise be configured,
  planned and charged until the native App principal refused at publication.
  The runtime jobs (matrix_plan, repair) take the token's repository names
  from the same-mint grant they already hold
  (`SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT`) and skip an uncovered foreign
  target before any read; maintenance takes its own mint's
  `unavailable-repositories` (`SENTINEL_UNAVAILABLE_TARGETS`) and the launcher
  gate hides it without a read (no surface, rows restored byte-identical,
  nothing parked or charged). Each prints one text-free
  `sentinel_target_token_scope` line. Without that evidence (an older
  workflow, no grant names, an unset variable) nothing is excluded: today's
  behaviour. A target that is simply unreadable is still skipped by the
  loader and hidden by the gate as before. Following a rename to a new name is
  out of scope (state is keyed by the old name): renaming or removing it in
  `sentinel.targets.json` and `sentinel.backup-ci-targets.json` stays an owner
  decision.
- Workflows (own, final commit; needs one manual launcher advance): every
  foreign mint in `supervisor.yml` (seven jobs) and the `backup-ci.yml` target
  read mint use the vendored action with the opt-in; the six supervisor jobs
  after maintenance pass its hint; maintenance's autonomy step receives
  `SENTINEL_UNAVAILABLE_TARGETS`. maintenance, prepare, finalize and backup-ci
  gain a credential-free locked `npm ci` step with three bounded attempts (the
  runner's own npm; no setup-node, which the maintenance contract forbids).
  There is no committed bundle of the action and the mint path needs its
  locked dependencies, so the first job of every run now also needs the npm
  registry. Self mints are unchanged. Until that advance only the backoff
  protects: an unreachable name still fails every run before the runtime, but
  at the cost above, and the chain survives to install the next fix.
- Expected side effect, by design: an open Sentinel self-target pull request
  whose `.github/actions/sentinel-app-token` files differ from the launcher's
  cannot prepare its self-test dependencies (the seed compares them) until it
  is refreshed onto `development`; #307, #421 and #424 need that refresh.

Rollback: revert the commits newest first (the workflow commit first; it
needs the same manual launcher advance). Reverting the backoff restores the
immediate re-dispatch; reverting the action restores the all-or-nothing mint;
reverting the scope exclusion restores read-only target selection.

## 2026-11-22: separate issue and operator entries share native review

- The protected supervisor continues to discover configured issue repairs and owns its current CI and expected-head merge gates. Operators submit a separate JSON job to the development workflow for a GitHub-proven public target with Sentinel App access. The planner pins its base ref, base SHA, and original prompt before implementation. The protected environment needs owner admission of the exact development ref. Existing producers on `claude/great-ride-tu5r70` stay on that ref until explicitly migrated, and their historical inbox and cleanup inputs remain there.
- Both entries use the native Codex review and exact snapshot path. A changed operator candidate needs a completed, current bound verdict with positive task acceptance and no unresolved P0. An isolated correction and fresh review can repeat within the original deadline. Counts record attempts. The job's explicit `review:false` applies only when Git proves an empty diff against the pinned base. With default review, an empty diff needs an already-satisfied native verdict.
- Trusted operator publication writes the exact accepted SHA, an authenticated App verdict comment attached to it, the workflow result with the comment URL, and an optional draft PR. An operator owns any merge and target CI verification. Operator job App write credentials stay in trusted publication and the explicit cleanup workflow. This policy records the code contract. Hosted admission and acceptance are established separately in the build ledger. [Operator guide](../jobs/README.md) · [Consolidation inventory](handoffs/2026-11-22-two-entry-consolidation.md)

## 2026-11-22: the private deployment runs on GitHub's free tier: one cycle a day, a weekly fast-forward, its own CI

The 2026-11-24 decision below supersedes this entry's daily cadence, private cell ceilings and budget estimates.

- Owner, verbatim: "Private deploy if it isn't free then no go. If theee is a
  free tier then lets do it". GitHub Free gives an organization 2,000 Actions
  minutes a month for private repositories; with no payment method the
  spending limit is $0, so runs stop when the minutes run out and nothing is
  billed. Measured on the public deployment: an idle supervisor cycle is
  about 30 billed minutes (10 jobs, each rounded up), a `ci.yml` push run
  about 37. Agreed: one supervisor cycle a day and a code sync about once a
  week.
- Code (auto-installs on the public deployment; public behaviour unchanged):
  - Proof first (`tests/host/private-deployment-lifecycle_test.ts`): a bound
    copy run as the private deployment takes one private target's owner
    issue (`ubiquity/auth.ubq.fi`) through the real planner (intake), an
    isolated cell with a fake model port in the target's real Git mirror
    (implementation), the aggregate (publication, native review request) and
    the next run's aggregate (completed review with no finding, merge). Every
    HTTP request is recorded; the state and target remotes are temporary Git
    directories; no request, remote or composed surface names
    `ubiquity-sentinel/sentinel`. Then `PRIVATE_ROLE_WIRED` became `true`; the
    committed private entry still refuses at module load while either
    workflow id is `null` (`workflow_ids_unfilled`).
  - `ubiquity/auth.ubq.fi` (the renamed Passport, private) joins
    `sentinel.targets.json` and, because the two-file sync test requires it,
    `sentinel.backup-ci-targets.json` (id null; backup CI refuses private
    repositories). On the public host it reads private and is skipped; the
    old `passport.ubq.fi` rows are untouched.
  - Free-tier cell ceilings, private role only, in the authority file
    (`PRIVATE_CYCLE_CELLS`, `HOSTED_CONTROLLER_CYCLE_CELLS`; null on the
    public role, so the platform bounds stay there): at most ONE
    implementation (matrix) cell per planner pass and at most TWO repository
    repair cells per fan-out plan. One implementation cell is the smallest
    number that lets an issue start each day; review observation, CI reads
    and merges of records already in flight are stepped by repair cells or,
    beyond the second repository, by the trusted serial pass (a record no
    cell takes stays with it), so an issue moves implement → review → merge
    across days. Proven on the private role: three ready issues, one grant,
    one reservation (`private-deployment-lifecycle_test.ts`); the fan-out
    ceiling keeps the first cells and delegates nothing else
    (`tests/repair/repair-fanout-cycle-cells_test.ts`).
  - Launcher install on the private role (`actions-supervisor-controller.ts`,
    `PRIVATE_LAUNCHER_NOT_INSTALLED`): a launcher is installed only when its
    own repository's `test-local` check is complete and successful
    (`verifyLauncherCi`, unchanged). When it is not (skipped, absent, still
    running or red) and the launcher is not the installed runtime, the
    private role starts NOTHING: no ordinary, bootstrap or release execution
    and no state write; prepare ends with that closed hold, so the cycle
    costs maintenance, prepare and finalize only. On the public role the
    same input still runs ordinary work on the installed revision, as
    before. Proven by `private-deployment-install_test.ts` (green private
    check: generation+1 model-disabled bootstrap, then ordinary, every read
    on the private repository; the four other cases: hold, no write) and
    `hosted-supervisor-launcher-mismatch_test.ts` (public unchanged).
- Workflows (final commit; needs one manual launcher advance on the public
  repository):
  - Every automatically triggered job is gated to the public repository by
    prefixing `github.repository == 'ubiquity-sentinel/sentinel' &&` to its
    former condition (or adding only that condition): the five-minute crons
    (`supervisor-dispatch.yml` both jobs, `release.yml`,
    `sentinel-scheduler.yml`), the `workflow_run` completions,
    `gateway-source-verify.yml` (push), and the dispatch-only `backup-ci.yml`,
    `backup-ci-leg.yml` and `repair.yml` (`queue-canary.yml` was already
    gated). On the public repository the prefix is true, so each condition is
    exactly today's; a skipped job takes no runner and bills 0 minutes.
  - `ci.yml` (three jobs) runs on the public repository exactly as before
    (`public || ...` is true there) and on the private one only for a push to
    `development` (`github.event_name == 'push' && github.ref ==
    'refs/heads/development'`): no pull requests, no other branch. The weekly
    fast-forward pushes `development` with an App token, which starts that
    run, so each launcher the private deployment installs has its own green
    `test-local`. Nothing in that run depends on the public repository, a
    secret or `GITHUB_REPOSITORY`: the shards and the harness are
    credential-free, and `ops/native-ci-proof.ts` reads
    `GITHUB_REPOSITORY` only for a `pull_request` event (a push ends after
    the aggregate status), so the same SHA that is green on the public
    repository goes green on the private one unless a test is flaky.
  - The finalize step "Chain the next dispatcher run" also requires the
    public repository, so the private deployment never chains.
  - The seven self mints in `supervisor.yml` name `owner: ${{
    github.repository == 'ubiquity-sentinel-private/sentinel' &&
    'ubiquity-sentinel-private' || 'ubiquity-sentinel' }}`, a closed choice of
    two committed non-empty literals (exactly `ubiquity-sentinel` on the
    public repository); `repositories: sentinel` stays literal (both
    repositories are named `sentinel`), so no mint can omit the list and get
    every repository of an installation.
  - `matrix_cell` stops at 120 minutes on the private repository
    (`timeout-minutes: ${{ github.repository ==
    'ubiquity-sentinel-private/sentinel' && 120 || 300 }}`; expressions are
    allowed in a job's `timeout-minutes`, and on the public repository it is
    300, as before). Every other runtime job already stops at 120. They are
    not shortened further: every runtime job keeps its 110-minute run window
    (`RUN_DEADLINE_MS`), so a shorter job timeout would kill a model session
    or a review wait mid-step; the monthly guard bounds the cost instead.
  - `private-daily.yml` (03:41 UTC and manual; private only): it loads the
    committed binding first, and while the ids are unfilled the day ends
    green with one line and no further step (no failure notice). Then, each
    ending the day green: no second supervisor run created this UTC day; the
    launcher (`sentinel-supervisor`) must have its own complete, successful
    `test-local` (a red or still-running CI waits for the next day: the sync
    runs Sunday 02:17, its CI takes about 15-20 minutes, so it is normally
    green by 03:41; a red one waits for a re-run or the next sync); and the
    month's billed minutes must be under 1,800, summed from GitHub's own run
    and job listings (`supervisor.yml` and `ci.yml` jobs, each rounded up to
    the minute, plus one per daily and sync run; `actions: read` on
    `GITHUB_TOKEN`). Every listing is captured before a loop or a sum uses
    it, so a failed read (an HTTP error with or without a body, a timeout, a
    failed later page) or a non-numeric answer ends the day green with one
    line and never dispatches (fails closed; `private-daily-guard_test.ts`
    runs the step with a fake `gh`). Only then it dispatches
    `supervisor.yml` at `sentinel-supervisor`.
  - `private-sync.yml` (Sunday 02:17 UTC and manual; private only): it reads
    the public `sentinel-supervisor` SHA with no credential and
    fast-forwards the private `development` and `sentinel-supervisor` to it in
    one atomic, never-forced push, only when both are ancestors (on
    divergence it fails and nothing moves). The token is minted with the
    pinned upstream action for `ubiquity-sentinel-private`/`sentinel` only,
    with contents and workflows write (the default `GITHUB_TOKEN` cannot push
    a commit that changes `.github/workflows`); a missing Workflows
    permission on that installation fails the mint red and nothing moves. It
    uses no environment.
- Install rule, corrected: private CI IS needed. The private launcher is
  always a SHA the public launcher already runs (green on the public
  `ci.yml`), and the private deployment installs it only after its OWN
  `test-local` for that SHA is green, exactly as `verifyLauncherCi` demands
  of every deployment; then the unchanged release state gives it a
  model-disabled bootstrap at generation+1 on the next daily cycle and
  ordinary work the day after, and a SHA that failed there cannot reinstall.
  Auto-follow never runs on the private deployment (its dispatcher job is
  gated off), so `ciWorkflowId` only identifies its own `ci.yml`.
- Budget, billed minutes a month on the private repository (CI 4 x 37 =
  148, daily 30 x 1 = 30, sync about 4 x 1 = 4, all gated workflows 0):
  - idle (every cycle idle, about 30): about 1,082;
  - one working cell every day (assumed about 90 a cycle: an idle cycle plus
    about 40 of model session and 20 more in the aggregate): about 2,882, so
    the guard stops new cycles at 1,800: the last on about day 19 (without
    it, 2,000 runs out during about day 21);
  - worst case, every job at its private timeout (15 + 10 + 120 + 120 +
    2 x 120 + 120 + 10 = 635, plus the daily minute): the guard admits days
    1-3 (about 0, 673 and 1,309 before each, counting one CI run) and
    refuses day 4 (about 1,945). Without the guard 2,000 runs out during day
    4's cycle. A worst-case cycle started just under 1,800 can still reach
    2,000; then GitHub stops the remaining jobs and nothing is billed.
- Prospector: in the rig its work step defers with the exact decision
  `{"kind":"unavailable","reason":"private_ci_authority_unavailable"}` for
  its `head_push` CI effect: prospector is a CI-minute policy target
  (`ACCEPTED_CI_MINUTE_POLICY`), every CI effect of it needs the App
  principal's private CI capability (`createHostedPrivateCiCapabilities`),
  and the rig composes no principal. On the private deployment the native
  principal exists, but the accepted policy's second row still names
  `ubiquity/passport.ubq.fi` (repositoryId 1254699258, workflowBlob
  `f2c61d693d8439a7f42b47d35ebaedb37173b1c7`, job `deno`, 30 minutes). The
  reconciliation lists each policy target's runs by name
  (`/repos/ubiquity/passport.ubq.fi/actions/runs`; no redirect is followed and
  the name is outside the minted token), so it cannot complete, and an
  incomplete reconciliation holds every CI effect for five minutes (`held`,
  `reconciliation`): prospector's pull requests would be held on every run,
  and an implemented prospector issue could keep the day's one cell busy
  for nothing. The reconciler half is pinned by
  `tests/host/ci-minute-vanished-target_test.ts` (an unreadable policy
  target keeps every turn incomplete; readable targets complete); the hold
  on an incomplete reconciliation is the controller's existing rule. The smallest change
  is an owner decision on the owner-merged policy rows
  (`src/contracts/ci-minute-budget.ts`): replace the Passport row with
  `ubiquity/auth.ubq.fi` (its id, CI workflow blob, job and timeout read from
  GitHub) or remove it, and confirm prospector's own row (blob
  `bacb73da71714a27d76918771d06ff4ce1f45b82`, job `validation`, 20 minutes)
  still matches. `ubiquity/auth.ubq.fi` is no policy target by name, so its
  CI effects are `inactive` (neither refused nor accounted); the
  reconciliation's ceiling lookup by repository id matters only once a row
  names it.
- Operator, in order: on the private repository add the repository secrets
  `SENTINEL_SUPERVISOR_APP_PRIVATE_KEY`, `UOS_AI_TOKEN` and
  `SENTINEL_DEEPSEEK_API_KEY` (repository secrets, readable by the
  supervisor jobs that name an environment too) and the repository
  variables `SENTINEL_BACKUP_CI=off` and `SENTINEL_AUTO_FOLLOW=off`; check
  the App's installation on `ubiquity-sentinel-private` has Contents and
  Workflows write; after the public launcher advance, fast-forward the
  private `development` and `sentinel-supervisor` once by hand to the public
  `sentinel-supervisor` SHA; make `development` the default branch; enable
  Actions; read the two ids (`GET
  /repos/ubiquity-sentinel-private/sentinel/actions/workflows`, the entries
  whose path is `.github/workflows/supervisor.yml` and
  `.github/workflows/ci.yml`) and commit them as the private entry's
  `supervisorWorkflowId` and `ciWorkflowId` on the public `development` (a
  two-number edit of an owner-merged authority file); after the public
  install, run `sentinel-private-sync` (or wait for Sunday), let its CI go
  green, then run `sentinel-private-daily` (or wait for 03:41 UTC).
- Known limits: the gateway merge-queue custody pass still reads the public
  `ubiquity/ai.ubq.fi` branch rules on every host; a launcher whose install
  failed after green CI holds (about 5 minutes a day) until the next sync.

Rollback: revert the workflow commit first (it needs the same manual
launcher advance), then the code commits. The public deployment is unchanged
either way; the private one then refuses to start again.

## 2026-11-23: the special CI-minute policy is removed (owner decision)

- Owner, verbatim: "Remove the special policy. We will deploy a private
  sentinel for all private repos". This settles the prospector blocker in
  the entry above.
- Removed: every target row of the CI-minute policy, both the accepted one
  (`ACCEPTED_CI_MINUTE_POLICY`: `ubiquity/prospector`, repository 1337190500,
  and `ubiquity/passport.ubq.fi`, 1254699258) and the inactive proposal
  (`INACTIVE_CI_MINUTE_POLICY`). No row is renamed or replaced.
- Kept, inert: the controller, store, reconciler and private CI composition.
  A policy without a target row manages nothing (`ciMinutePolicyInactive`):
  `createCiMinuteController` and `composePrivateCiMinutes` (the runtime's
  `runtimeCiMinutes` and the launcher's composition) return the inactive
  coordinator before any capability, store, clock, read or write, so every
  CI effect of every repository is `inactive` and every work step proceeds
  under the normal rules only (P0 review, current-head CI not red, custody,
  accounting). The policy validator still refuses an empty list, and no
  production path digests one. The empty policy has no digest, and nothing
  persisted is checked against the current policy digest outside the
  ledger, which is no longer read.
- Ledger history: untouched. Nothing reads, writes or deletes
  `sentinel-state/ci-minutes` on `ubiquity/prospector` any more; its rows stay
  as they are, inert.
- Public deployment: its targets' effects were already `inactive` (they had
  no row) and stay so. What stops: every runtime job and launcher run used to
  reconcile the ledger (reads of prospector and its `sentinel-state/ci-minutes`
  branch, and writes to it); now none does. Proof: the public role's effect
  for a public target is identical with the retired rows and without
  (`ci-minute-policy-removed_test.ts`, which also shows nothing is touched).
- Private deployment: prospector goes from intake to a reviewed merge like
  any other private target (`private-deployment-lifecycle_test.ts`).
- Tests: the machinery's own tests use the retired rows as a test fixture
  (`tests/state/retired-ci-minute-policy.ts`), never production source.
- Other repository special cases, left as they are because none prevents or
  distorts work on the private deployment (each matches the exact old name
  `passport.ubq.fi`, which is no committed target, or is reachable only
  through the removed policy): the Passport work trial
  (`src/repair/passport-work-trial.ts` and its launcher passes), the named
  Passport verify policy (`src/host/target-policy.ts`), the dependency
  preparer (`src/host/passport-dependencies.ts`), the Passport merge-gate
  check filter (`src/repair/merge-gate-checks.ts`), the base-review CI read
  (`src/github/base-review-ci.ts`, `base-review-service.ts`,
  `client-reads.ts`), telemetry names (`ops/telemetry-*.ts`), and the
  private CI capability for prospector (`src/host/hosted-app-principal.ts`,
  `hosted-app-principal-native.ts`, `ops/hosted-autonomy-main.ts`), which is
  no longer called. `ubiquity/auth.ubq.fi` gets none of them and is worked
  with the generic policy from its own tree; whether its dispatch-only
  deployment checks need the Passport merge-gate filter is not verified.

Rollback: revert the commit; the rows return and prospector is held again
until the Passport row is repaired.

## 2026-11-23: the private deployment targets every non-archived private ubiquity repository

- Owner, verbatim: "Yah so we will make a sentinel for private repos only
  and yeah target only ubiquity private repos" and, on the App installation
  in the `ubiquity` organization, "App installed to all".
- Added to `sentinel.targets.json` and, for the two-file sync,
  `sentinel.backup-ci-targets.json` (id null; backup CI refuses private
  repositories): `ubiquity/google-apps-script`, `ubiquity/arbitrage-uusd`,
  `ubiquity/ubiquibot-config`. The private list is then seven: prospector,
  prospector-chrome-extension, prospector-monorepo, auth.ubq.fi and these
  three. Not added: `ubiquity/uad-ui-archived` (archived) and
  `ubiquity/.github-private`: the committed slug rule (`parseTargetSlugsV1`)
  accepts only names that start with a letter or digit and refuses the whole
  setting otherwise, which would leave both deployments with no target;
  supporting it needs a slug-rule change that is not made here.
- Public host: each new name reads private and is skipped (the
  `sentinel_private_targets` counts grow); nothing else changes. The foreign
  mints list 32 names (GitHub accepts up to 500 repositories in one
  installation-token request; the committed setting allows 64), and the
  installation covers all of them, so the tolerant mint drops none.
- A new target without a CI workflow or a local verify parks as
  `no_ci_and_no_local_verify` on the private deployment (existing rule).

Rollback: revert the commit; the three names leave both files.

## 2026-11-23: the private deployment needs no variable and two secrets (owner decision)

- Owner, verbatim: "Fuck your secrets no secrets it's too god damn
  complicated just hard code in the behavior we need". Credentials are never
  committed, so the private deployment (`ubiquity-sentinel-private/sentinel`)
  takes no repository variable and the two secrets below. No production code
  or workflow changes: every non-secret behaviour its role needs is already
  the committed value an absent variable yields (the workflow's own `||`
  fallback, an empty string, or the role gate).
  `tests/host/private-zero-config_test.ts` pins every `vars.*` and
  `secrets.*` read of the workflows that run there (`supervisor.yml`,
  `private-daily.yml`, `private-sync.yml`, `ci.yml`) with its absent value.
- Variables, absent on the private repository:
  - `SENTINEL_BACKUP_CI`: `on` by the workflow fallback, and inert there:
    the private role's backup targets list nothing, so no consumer is
    composed (`readBackupCiTargets`; the role proof runs it with `on`), and
    every backup job and dispatch step is gated to the public repository.
  - `SENTINEL_AUTO_FOLLOW`: read only by the dispatcher's follow step
    (`supervisor-dispatch.yml`, gated to the public repository); the daily
    cycle, runtime and finalize never read it.
  - Model route (`SENTINEL_MODEL_BASE_URL`, `SENTINEL_MODEL_FALLBACK`,
    `SENTINEL_REVIEW_MODEL_ID` empty; `SENTINEL_IMPLEMENTATION_MODEL_ID`
    gives `gpt-6.1-sol`): gateway `https://ai.ubq.fi/v1`, `gpt-6.1-sol`, 429
    failover `gpt-6-luna`, max reasoning, key `UOS_AI_TOKEN`; review is
    native Codex review mode (no hosted path selects a reviewer model; the
    review id is read but unused). That is the public deployment's route
    with its variables unset; whether its configured variables equal it is
    not visible here (the 2026-10-29 capture was `gpt-6.1-sol`).
  - Also read, never listed: `SENTINEL_MERGE_QUEUE` (empty; lower-only under
    the committed ceiling `off`) and `SENTINEL_SELF_IMPROVE` (`on`; the
    private role files no watchdog issue).
- Secrets:
  - `SENTINEL_SUPERVISOR_APP_PRIVATE_KEY`, required: every App token mint
    of `supervisor.yml` and `private-sync.yml`; an empty key fails the mint.
  - `UOS_AI_TOKEN`, required: the model gateway token for implementation
    and native review; the runtime launcher refuses all four runtime jobs
    without it (`hosted runtime launcher credentials are unavailable`).
  - `SENTINEL_DEEPSEEK_API_KEY`, not needed: only the DeepSeek routes
    (`SENTINEL_MODEL_BASE_URL` set, or `SENTINEL_MODEL_FALLBACK=deepseek`)
    use it; absent, it is an empty step variable that is never forwarded or
    required (its `--allow-env` grant just reads an empty value).
  - `SENTINEL_GATEWAY_AUTH_JSON`, `SENTINEL_REPLAY_KEY_B64`: not needed;
    only the manual `observe.yml` reads them.
  - Neither required value can be committed: the repository is public, and
    the App key signs write tokens for every installation of the App while
    the gateway token spends paid model capacity.
- Environment: the supervisor jobs keep `environment: sentinel-supervisor`.
  GitHub's documentation says a GitHub Free organization cannot configure
  environments or environment secrets in private repositories, that a
  referenced missing environment is created, and that the rules and secrets
  of environments in a repository made private are ignored; nothing
  documents a refusal, and repository secrets reach every job either way. Not verified on the private
  repository. If its first cycle shows a job refused for the environment,
  the smallest fix is `name: ${{ github.repository ==
  'ubiquity-sentinel/sentinel' && 'sentinel-supervisor' || '' }}` in the
  seven jobs (public: today's name; an empty name's meaning is
  undocumented too) with the two tests that pin the literal updated; no
  OIDC claim or native check reads the environment.
- Default branch: still a manual setting. `schedule` and `workflow_dispatch`
  need the workflow file on the default branch, and `main` (unrelated
  history) can take neither a fast-forward nor a force push, so
  `development` must be made the default branch by hand.
- Workflow ids: still committed by hand. Path-resolved identity would be as
  strong on the private role (every id comparison is paired with the exact
  path, repository, event, branch and head SHA), but the ids are
  module-load constants read synchronously by persisted proof parsers and
  run checks in every supervisor process (maintenance, prepare, finalize,
  launcher, runtime child), so resolving them at run time needs network
  access at module load (which the credential-free daily binding check does
  not have) or a resolution in each entrypoint; not small, not done.

Rollback: revert the commit; nothing else changes.

## 2026-11-24: pace private supervisor cycles against the GitHub Free allowance

- Owner, verbatim: "the only limitation im concerned about is the private free tier github actions" and "Raise Sentinel cadence". The private deployment has 2,000 included Actions minutes per month and a $0 spending limit. On November 24 it had used 63 minutes and had about 180 open issues across its targets. The daily supervisor limit and single-cell planner ceiling let one private issue start per UTC day.
- Measured on the private deployment: one implementation cycle cost 17 billed minutes (maintenance 2, prepare 1, matrix_plan 4, matrix_cell 7 including a five-minute model session, repair 2, finalize 1). An idle cycle cost 5. This working cycle had about 10 fixed minutes and 7 marginal minutes per implementation. Batching shares the fixed cost. Every matrix job is billed separately, rounded up to the minute, so running cells concurrently saves elapsed time while their billed minutes add up.
- `PRIVATE_CYCLE_CELLS` allows six implementation cells and four repository repair cells per cycle. Records outside the repair fan-out stay with the trusted serial pass. The public role uses the platform bounds. The private lifecycle test exercises six durable implementation grants from seven ready issues in one real planner pass and leaves the seventh ready for another pass. [Private lifecycle](../tests/host/private-deployment-lifecycle_test.ts) · [Repair fan-out](../tests/repair/repair-fanout-cycle-cells_test.ts)
- `private-daily.yml` checks every six hours UTC at an off-peak minute and on manual dispatch. It waits while a supervisor run is queued or in progress and checks the binding and the launcher's successful `test-local`. It dispatches only when estimated month-to-date usage is below `min(1800, 60 * UTC day of month)`. Unused allowance carries forward within that month. The estimate sums the rounded job minutes for supervisor and CI, plus one minute per private daily and sync run. An unreadable listing ends the check without dispatch. [Private dispatch](../.github/workflows/private-daily.yml)
- The 1,800-minute threshold governs admission. A cycle admitted below the threshold can finish above it, and the GitHub account's $0 spending limit is the hard billing boundary. Weekly private sync and the private launcher's exact green CI install requirement continue to apply.

Rollback: revert the cadence and cell-ceiling change to restore the previous daily schedule and limits.

## 2026-11-25: recover late cells on the deployment that admitted them

The repair job runs alongside implementation cells. Its App-token deadline can leave time for just the initial artifact scan. Cells that finish later upload their bundles to the producer run. A later maintenance pass authenticates the producer and its artifacts, imports each matching candidate and preserves it for publication and native review.

The November 18 public-only default for the closed-matrix adapter predated the active private controller. That adapter also serves ordinary producer recovery. Its missing host input filtered out the private repositories whose grants it was trying to settle. The adapter now reads the bound controller's visibility on its self credential and resolves listed targets on their respective credentials using the planner's visibility rule. When none of the pending requests matches a configured target, maintenance reports `no_matching_target_config` with counts and the producer run identity.

The private lifecycle regression runs repair before the implementation finishes, then exercises the real maintenance target loader, artifact reader, bundle importer and state transitions between runs. It follows the preserved commit through publication, a native review request and a reviewed merge using temporary Git repositories and fixture services. [Private lifecycle test](../tests/host/private-deployment-lifecycle_test.ts)

## 2026-11-25: one deployment profile governs hosted behavior

Owner, verbatim: "i thought the logic should be identical for sentinel public and private... so we shouldnt have these sort of operational issues?" and "it makes sense to have the repo be self aware if its public or private and then switch its behavior. make sure that the logic is all consolidated together."

The protected controller binding now supplies a frozen profile for each deployment. GitHub's native repository selects the committed binding. The existing independent native checks still authenticate the workflow, repository, revision and installation. The profile owns the target class. A GitHub visibility read confirms the class and cannot switch it. This supersedes the November 18 rule that a private or unreadable host read could select a different target set. [Deployment authority](../src/contracts/hosted-controller-deployment.ts)

A positive host visibility mismatch refuses the operation before foreign target loading or a launcher pass. An unknown host cannot authorize private work. On the public deployment an unknown answer retains the public-only target filter, including the existing per-target unavailability and deferral rules. A private controller listed as its own target refuses. Refusals throw a typed error and emit a bounded `sentinel_deployment_refused` line with the reason, bound repository, expected visibility and observed visibility. The runtime launcher admits this diagnostic through its child-output parser. Unknown target visibility is skipped on both deployments. Private/internal targets still require affirmative private target evidence.

The hosted planner, repair jobs and late-cell recovery all use the required deployment-scoped target loader. A listed public controller reuses its ordinary self target read. An unlisted controller is read on its self credential. The launcher's state and GitHub gate uses its cached self surface before processing foreign records. Local repair and the existing-PR custody reader for `ubiquity/ai.ubq.fi` explicitly request the fixed public-only target contract they already used. [Target loaders](../src/host/targets.ts)

| Switch | Former decision sites | Source and effect |
| --- | --- | --- |
| Native identity, API and state remote, refs, runtime ID, workflow IDs, retired identities | Controller binding, hosted supervisor and install readers | Selected profile and binding projections retain the committed per-repository values and the historical public-only aliases. |
| Target class and controller targets | `src/repair/target-visibility.ts`, `src/host/targets.ts`, `actions-repair-host.ts`, `ops/hosted-autonomy-{main,private-targets,matrix-adapters}.ts` | `targetVisibility`, `worksControllerTargets`, `verifyDeploymentTargetScopeV1` and `deploymentWorksTargetV1`. Public works public targets including itself. Private works private/internal foreign targets and excludes both controller slugs. |
| Fixed public consumers and scope-zero proofs | `local.ts`, `maintenance-existing-pr-publication.ts`, named target policy, local release, self merge, CI, owner-successor and historical proof readers | `loadPublicTargetConfigsV1` for the two public-only loads. Public identity predicates preserve each caller's original name, case and installation checks. Selected-controller predicates still identify each deployment's infrastructure. |
| Implementation and repository repair ceilings | `matrix-planner.ts`, `repair-fanout-host.ts` | `cycleCells` retains the platform bounds on public and six implementation / four repair cells on private. |
| Self-observation, CI-outage notices, throughput and upkeep issues | `ops/hosted-autonomy-runner.ts`, `src/host/actions-supervisor-host.ts` | `selfObservation` enables public tracker work. Private keeps its skip and log-only outcomes. |
| Release and install | Release workflow and bridge, `owner-install-run.ts`, `actions-supervisor-controller.ts` | `release` and `ownerDevelopmentInstall` retain the public-only paths. `requireInstalledLauncher` holds a mismatched private launcher until its own exact-green installation. |
| Backup CI, agent jobs, canary, gateway monitor | `backup-ci-compose.ts`, `ops/backup-ci-main.ts`, agent-job admission and publication, queue canary and projection, daily gateway reporter, workflow gates | `backupCi`, `agentJobs`, `queueCanary`, `gatewayMonitor` and the public target predicate preserve the previously fixed service scopes. |
| Self token owner and installation | Seven supervisor mints, private sync, `hosted-app-credentials.ts` | `selfTokenOwner` and `selfInstallationId` retain the deployment's own organization and the private installation pin 183425201. |
| Cadence, sync, chain, CI triggers and cell timeout | Private daily and sync workflows, CI, supervisor finalize and matrix cell, scheduler and dispatch workflows | `privateCadence`, `chaining`, `developmentPushCiOnly`, `matrixCellTimeoutMinutes` and the committed workflow table retain both schedules, private pacing, public chaining and the 300/120-minute cell timeouts. |
| Workflow admissions and other repository-derived values | GitHub Actions expressions and scripts | `HOSTED_CONTROLLER_WORKFLOW_TABLE` inventories all 32 jobs in 18 workflows, their conditions, inherited role gates and repository-dependent fields. The workflow test reads and compares the actual YAML. |
| Exceptions to the source guard | Closed GitHub visibility decoder, public VPS network-surface parser, standalone native CI emitter, historical issue #48 proofs and shared App slug proof | Only the listed expressions have exceptions. The proof emitter cannot import runtime code without changing its attested source closure. Fixtures can exercise both roles. [Source guard](../tests/host/deployment-profile-guard_test.ts) |

The same intake, plan, implementation cell, maintenance recovery, publication, native review request and reviewed merge cases now run under both native repository identities. They use temporary Git repositories, persisted state and fixture GitHub/model services. The matrix includes a cell that finishes after repair and a planner pass at the role's cell bound. [Lifecycle matrix](../tests/host/private-deployment-lifecycle_test.ts) · [Workflow table test](../tests/host/hosted-workflow-private-gating_test.ts)

Two existing workflow details are visible in the inventory. Manual `observe` is offered on both repositories although the documented private setup omits its observer credentials. The CI development-push clause also admits a development push on another repository carrying the workflow. Both conditions are preserved.

Rollback: restore the tree at `3d080ed1b326946c59674d089c48f8c22301afcf`, the PR #432 base, by reverting the deployment-profile changes together. This restores the prior loader API and visibility behavior. No state migration or workflow edit is required.
