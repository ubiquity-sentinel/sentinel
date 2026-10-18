# Merge queue implementation and activation design

Status: corrected implementation proposal, 2026-10-18. This document supersedes
the rollout and custody portions of handoff `research/design.md`. The original
design and its entire `research/critique.md` were read. No queue code, ruleset,
branch protection, App permission, target-repository write, or live state write
was performed to prepare this document.

An isolated implementation of the new pure/GitHub modules now exists on
`codex/merge-queue-pure`. The production integration, activation boundary,
runtime guards and owner steps remain separate. No live queue write was made.

The code baseline is the locally integrated generation 81 candidate in
`/workspace/worktrees/gen81-integration` (observed `a21dcd18ad310a291951924bba86b3e6d762b375`,
subsequently advancing during validation). The final implementation is rebased
on the accepted R81 commit before review. Runtime rollback remains R80
`e48e7e110`; no new serialized work, plan, cell, receipt, or stdout discriminator
is required by this design.

## 1. Shipping boundary

1. Finish and verify R81 before installing queue changes.
2. Ship the launcher and shared queue readers with a **code ceiling of `off`**.
   No repository variable is needed for this safe default. A variable can only
   lower the code ceiling. A later reviewed commit explicitly enables observe
   or enqueue mode. Invalid or unavailable configuration never raises it.
3. Queue observation and custody run first on every pass, even when enqueue is
   off, a release is nonterminal, a matrix receipt needs maintenance, or an
   earlier ordinary phase would otherwise return. Off prohibits new enqueue
   effects; it does not abandon existing custody, reconciliation, or booking.
4. Before real queue use, ship and accept R82 native guards before publication,
   base refresh, conflict publication, merge, and merge bookkeeping. A scan at
   the beginning of an R81 workflow does not protect a PR queued by an owner
   during its later 30–55 minute repair session. A non-expiring persisted hold
   protects known records; native reads protect this intervening enqueue race.
5. Obtain the owner steps only after the implementation, exact CI, review, and
   canary packet are concrete: App permission, an App-authenticated canary on
   `queue-canary`, and creation of the ai.ubq.fi development ruleset. Never
   create protection or a ruleset on ubiquity/sentinel. Never enable the target
   ruleset before Sentinel can enqueue. Keep sentinel-release disabled.

Dark shipping is useful independently of activation: it validates readers,
closed policy outcomes, R80 parse compatibility, first-pass ordering, and
workflow skip behavior without changing delivery policy.

Proof activation is an immutable source boundary, separate from mutable
enqueue mode. Initial `proofActivated=false`, mode off, authenticated no-rule
and no custody preserves the existing direct pipeline without queue-permission
APIs. Any positive queue custody/evidence overrides that fast path. The
activation commit sets `proofActivated=true` and pins the finite historical
witness manifest. Lowering mode to off later never lowers proof activation or
restores the weak legacy verifier.

## 2. Shared contracts

`interfaces.md` freezes the proposed in-memory fields and ownership boundaries.
None of these types is a new persisted state format. Unknown, unavailable,
incomplete, rate-limited, and conclusively absent are distinct outcomes.

Every queue capability is scoped to one authenticated repository. Production
mutations are restricted to `ubiquity/ai.ubq.fi`, configured base `development`.
The canary capability is a separate explicit branch and exact PR-number
allowlist, absent from ordinary production workers. No token or authoritative
write capability enters a model worker.

The queue entry's `pullRequest.headRefOid` is the candidate head H. Store native
`MergeQueueEntry.headCommit` and `baseCommit` separately. The public schema
calls these the entry head and base but does not document enough to equate the
entry head with either H or the final merged commit. The App canary must settle
that behavior. The final merge M comes from the merged PR and authenticated git
commit reads, not from a guessed queue-entry identity.

## 3. Custody before every other phase

The first prelude reads the entire native queue, not only entries enqueued by
Sentinel. It exhausts pagination and rejects duplicate PRs/entry IDs/positions,
missing identities, cursor loops, GraphQL partial errors, resource-bound
exhaustion, changed base-tip observations, and inconsistent repeated entry
reads. Platform and existing memory/time limits remain; exceeding a limit is
unavailable, never an empty queue. Reads are not a transactional snapshot: a
stable recheck narrows this race, and runtime guards close the mutation path.

There is one explicit dark-install fast path: mode is off, an authenticated
complete read proves no effective merge-queue rule on the configured production
branch, and no queue hold/intent exists in current state. This yields
`ready=true` with `queue:inactive_no_rule`; it does not claim an observed empty
queue. It needs no new Merge queues App permission and preserves the existing
healthy R81 pipeline before the owner grant. An active or unreadable rule, or
any existing custody, requires the queue read; absent permission then fails
closed. The no-rule proof is fresh each pass, never inferred from configuration
absence or a failed request. Deactivated queues with unresolved custody do not
use this path.

For every tracked real PR currently queued, regardless of its enqueuer, CAS
persist `{reason:"backoff", since:<original hold time>, until:null}` before
continuing. Preserve unrelated active intents and review/implementation
reservations. Do not turn a foreign enqueue into Sentinel ownership. Neither
receipt transport availability nor ordinary retry maintenance may clear this
hold. A held record may be reclassified only by the queue reconciler after an
authoritative queue read and terminal disposition.

`isQueueHeld` is not merely `backoff && until === null`: it also requires the
exact target repository and a positive target PR with an exact target head.
PR-less already-satisfied-at-base review uses the same wait value in R81 and
must never be treated as a queue entry. A queue-namespaced merge intent is a
stronger marker. An otherwise ambiguous indefinite PR hold is conservatively
protected and reported; a complete queue absence alone is insufficient to
erase a hold belonging to another operation.

If a whole-queue read or required hold CAS cannot complete, keep all known
holds and set `queueCustodyReady=false` through `GITHUB_OUTPUT`. Gate every
downstream prepare, plan, matrix execution and repair admission on this output.
No new stdout record or reason is added. Report a safe deferral, not “empty
queue”, successful work delivery, or an unhealthy installed runtime. Tests must
prove the skipped workflow starts no execution, leaves no orphan execution
reservation, and preserves the accepted healthy runtime.

The prelude returns the new state head/snapshot and protected record IDs to all
later phases. After any phase writes state, refresh those identities through
the existing CAS continuation machinery. Legacy retry, delivery, closure,
follow-up and adoption code must honor the protected set and queue classifier.

## 4. Native R82 guards before activation

Before a target mutation or booking, read the exact PR's native queue state
through the trusted coordinator port. Known membership or unknown membership
prohibits publication, refresh, conflict publication, and direct merge. A
native entry discovered after the first prelude receives the same durable hold
through ordinary authenticated state writes. A vanished entry alone does not
authorize booking: merged PRs require the shared delivery proof.

PR-less candidate creation is not blocked by an unrelated queue entry, but the
subsequent PR publication/merge path must use its exact current identity. The
guard must cover resume intents as well as new operations, and must not allow
an older generic “already merged” return to skip the queue proof. Unit and
workflow fixtures exercise an owner enqueue between the initial scan and each
guarded effect. An observation-only rollout is not evidence that this race is
safe.

## 5. Enqueue authorization

Only exact, current, fully eligible candidates reach the write boundary:

- Current source task is readable, open when required, not opted out, and
  matches the receipt's task statement digest. Use the latest applicable
  review receipt; require no P0/P1. Keep the existing maximum three review
  rounds and three CI fixes. P2/P3 remain follow-up work after delivery.
- Exact PR repository, base branch, head H, trusted publication author, intent,
  and target binding match. No incompatible active intent or in-flight review
  may be displaced. Every required head check is genuinely successful under
  the existing completeness rules before enqueue.
- The selected review is bound to B/H. Carried-review candidates additionally
  prove the original review B0/H0 and current B/H have identical complete tree
  changes, including modes and full blob IDs. No abbreviated diff is proof.
- During probation, require the existing phase-one base-tip condition. The
  later moved-base phase permits only a proven disjoint path set; a candidate
  that needs refresh follows bounded refresh/review behavior, never an
  indefinite “wait for phase two” retry loop.
- Read every entry ahead, including owner/coordinator entries. The candidate's
  complete changed-path set must be disjoint from changes since its reviewed
  base and from every preceding entry. Unknown/truncated trees fail closed.
  Changes under `.github/` or to the pinned workflow by this candidate, a
  preceding entry, or the intervening base suspend enqueue until the new
  workflow is independently accepted.
- Check the effective rules immediately before each enqueue: exact branch,
  MERGE, ALLGREEN, four required Actions contexts pinned to app 15368,
  non-strict base checking, no App bypass, and the reviewed settings. Recheck
  after enqueue; changed rules retain custody and trigger safe own-entry
  dequeue. The request itself always disables bypass.
- Check that `.github/workflows/deno-deploy.yml` is active and its blob at the
  observed base is the reviewed workflow manifest. It must actually include
  `merge_group: types: [checks_requested]`, all four jobs on that event, and
  deploy only for approved push events. A text substring does not establish
  these facts. PR/merge-group runs never deploy. Non-PR concurrency includes
  the event and commit/run identity so pending base runs are not replaced.

Persist the exact enqueue intent and non-expiring hold, verify canonical
readback, then send the write. If the state CAS fails, send no write. Refresh
the current PR, task, base, rules and queue identity immediately before sending
within the existing operation deadline. A changed identity restarts evidence
collection without consuming a review round or refunding a reservation.

## 6. Protocol, crash recovery and refusal bounds

Primary request: REST `PUT /repos/ubiquity/ai.ubq.fi/pulls/N/merge-async` with
`{sha:H, merge_action:"merge_queue", bypass_rules:false}`. Never omit
`merge_action` and never invoke a default/direct merge as fallback. GraphQL
enqueue, if required by the App canary, uses `expectedHeadOid:H` and
`jump:false`. Choose the supported transport in a reviewed capability manifest;
do not attempt a second mutation after an ambiguous first mutation.

Read/write code retains HTTP status and typed errors; the existing launcher
helper that reduces non-2xx responses to null is insufficient because a 409
may carry a recoverable operation UUID. Use the shared authenticated HTTP
boundary and cooldown gate. GraphQL errors are errors even with HTTP 200.

202 pending and 409 known-operation responses persist the exact async UUID in
`intent.requestId` immediately. 200 “already enqueued/merged” is only a hint:
independently prove actual PR head, native entry ownership or final merge.
Polling `enqueued` proves admission only, not delivery. Poll `pending` within
the current bounded deadline, then defer; do not block a worker for the
lifetime of the queue. API operations may expire after 24 hours, so native
membership and merged PR reads remain the recovery authority.

Queue custody uses the existing `merge` intent shape:

```
kind: "merge"
key: "merge-queue:v1:<PR>:<H>"
startedAt: first intent timestamp (never reset on retries)
branch: exact candidate branch
expectedHead: H
observedBase: B
pr: exact positive PR
requestId: async UUID or null
resultId: native queue-entry ID or null
failure?: {kind:"merge_queue_v1", detail:<closed constant>, atMs, attempts}
```

Do not put JSON, proof objects, raw GitHub errors, model text, or credentials in
`failure.detail`. Its closed constants distinguish definitive refusal,
ambiguous submission, missing async operation, and observed queue ejection.
`failure.attempts` counts consecutive failed executions of this exact intent,
not successful pending polls. A new namespace is permitted only after tests
actually parse and round-trip it under R80; enum permissiveness is not assumed.

Three definitive refusals at one unchanged PR/head/base/task/rules binding
produce a visible owner park. An ambiguous write is never automatically
resubmitted until conclusive native evidence proves it did not apply. If this
cannot be established, keep the hold and report the owner action. A six-hour
maximum unresolved *admission* age, measured from the original persisted
`startedAt`, converts a pending/unknown admission to a visible owner park but
does not release custody. This is an operation-resolution bound, not a queue
wait timeout: a genuinely queued entry can legitimately wait longer. The
normal queue timeout is the configured platform check-response timeout.

The existing state record cannot safely host a second simultaneous intent.
Foreign-enqueued PRs keep their original intent and only acquire a wait hold.
Sentinel never automatically dequeues a foreign-owned entry. On removal, a
fresh exact read restores only the original operation's rightful continuation;
it does not invent merge ownership or spend new work while outcome is unknown.

## 7. Per-pass drift and ejection handling

Every pass rechecks every held entry's current task digest, opt-out state,
current head, latest authorizing review and P0/P1 verdict, and complete changed
paths against the current base and every entry now ahead. Queue jumps and
foreign entries can change this ordering. A prior disjoint verdict is not
cached across passes. An own entry with a conclusively invalid authorization
is dequeued. Unknown evidence retains the hold, blocks new enqueue as needed,
and produces a named summary; it never authorizes a merge.

Before dequeue, freshly read PR node ID, head, entry ID and enqueuer. Only an
entry proved to belong to the App's exact intent may be dequeued. The mutation
has no expected-head CAS, so reread after it. A response loss or changed
identity keeps custody until authoritative absence is proved. A queued PR is
never closed and its branch is never deleted.

After definitive removal, inspect merged status before clearing a hold.
Matched CI-failure/timeout removals may re-enter once after the existing CI
gate is green; a second identical group failure parks for the owner. Count
distinct native queue admissions/groups, not every re-run job as a new failure.
Keep refusal counts and ejection counts separate. Unknown removal-reason text
is not classified as CI failure. Manual dequeue, changed head, changed task,
or changed base has a documented route back through authorization; a permanent
unqualified “queue ejected” park would strand valid work.

An observed missing-trigger or non-success required-check timeout suspends new
enqueue for that exact workflow blob/rules binding while existing entries
continue through reconciliation. The retained bounded queue intent/hold and
native event evidence make this circuit breaker survive process restarts. If
those facts cannot be reconstructed, fail closed rather than treating the
breaker as cleared. A reviewed workflow change plus successful canary/evidence
rearms it. Skipped, neutral, cancelled, and missing checks are never success.

## 8. One proof resolver for all consumers

The resolver classifies queue custody/evidence **before** attempting any direct
merge verification. Any queue marker, current or historical native queue
event, native entry, async queue operation, or merge-group run makes the queue
path mandatory. Unavailable classification and failed queue proof never fall
through to the legacy direct verifier.

Queue proof for reviewed B/H and merged commit M requires all of:

1. Exact repository/PR/current H, trusted publication author, reviewed task and
   receipt bindings, base branch, and authenticated merged PR identity.
2. Native queue provenance tying the PR/head to the App's enqueue operation;
   native actor attribution, final merged actor and git commit author follow
   the exact App canary-approved behavior. A queue-branch name is only a hint.
3. M is reachable from current development and has **ordered** parents P,H.
   B is P or a proved ancestor of P. The stale REST `base.sha` is not proof of
   the actual first parent or tested integration base.
4. The complete tree change set `mergeBase(B,H) -> H` equals `P -> M`, with full
   paths, old/new modes and blob IDs. Carried review additionally proves the
   B0/H0 receipt binding equals B/H. Tree truncation, missing objects or an
   unexplained path change rejects proof.
5. A complete authenticated Actions listing contains the canonical workflow
   run with `event=merge_group`, `head_sha=M`, correct repository/workflow
   identity and check suite. The four required checks are from GitHub Actions
   app 15368 and all actually conclude success on M. The latest applicable
   attempts must be complete; a prior green run cannot hide a later failed or
   pending attempt. A PR run on H never substitutes for group CI on M.

Return one discriminated `VerifiedDelivery` with the complete identity binding
and a digest of its normalized authenticated evidence. Share it across
delivery, closure, follow-up creation, spent-round adoption, foreign-merged
adoption and runtime bookkeeping. Cache only within the pass, keyed by
repository/PR/B/H/M/review/task/proof identities, never by PR number alone.

The old `baseAndHeadAreMerged` merely accepts two parents containing H and can
accept a stale REST base. It cannot be a queue proof. Every caller of
`verifiedMergedDelivery`, `baseAndHeadAreMerged`, `followUpMergeVerified`, and
`adoptableSpentMerge` must migrate to the resolver or a deliberately self-only
legacy path. The sentinel repository keeps its existing unprotected direct
merge policy; this queue rollout changes only ai.ubq.fi.

### Exact historical direct transition

Absence of a `merge_group` run is not proof of direct merge: indexing can lag
and runs can expire. Post-cutover direct delivery requires an authenticated
successful result from the existing trusted exact-head direct-merge operation,
bound to B,H,M, the App actor and ordered parents B,H. A null/ambiguous result
followed by “PR is merged” is not that witness. Once queue-required rules are
active, this legacy direct path is never used for new ai.ubq.fi candidates.

Before activation, inventory exact existing trusted direct-delivery bindings
from an immutable, authenticated state snapshot. Accepted/open release requests
already written by the trusted direct path may supply an exact historical
witness keyed by repository, PR, request ID, receipt ID, B,H,M and snapshot
commit. For unbooked merged work, include only exact authenticated direct
operation receipts/log evidence, not “merged before time T” or missing CI.
Freeze this finite manifest by digest in the activation commit. No subsequent
record can join it automatically. Historical delivery/closure remains live for
these exact identities. Unknown old merges visibly park for evidence instead
of weakening the new classifier. Any positive queue evidence overrides a
historical candidate grant and requires queue proof.

The pure resolver requires both the immutable manifest digest and exact
manifest entries; a caller-provided matching digest alone is not a grant. Its
digest is canonical SHA-256 of
`{domain:"sentinel.queue-historical-direct.v1", witnesses:<ordered entries>}`,
where each entry is `{binding:QueueBinding,revision,witnessDigest}`. Duplicate
exact binding/revision entries and malformed identities fail closed. The
existing snapshot-record bound limits manifest memory. The resolver recomputes
the digest and checks exact tuple membership.

This is an identity cutover, not a broad date or ancestor bypass. The inventory
is made reviewable before the ruleset step; no manual state rewrite is needed.

### Proof retention

The current ReleaseRequest V1 and EvidenceRef V1 have no valid queue-proof
payload slot. Do not add fields or masquerade queue proof as a review receipt.
Initially rederive native proof for later closure/adoption; expired or
unavailable proof parks with a named reason. The queue booking's canonical
release request and exact trusted state commit remain auditable evidence of
the earlier decision, but cannot fabricate missing native checks for a new
booking. If durable proof replay is required before rollout, introduce an
explicit reviewed trusted evidence store contract and R80 compatibility test;
do not smuggle it into `failure.detail`. This availability limit is explicit.

## 9. Throughput and operational limits

Probation allows one newly submitted enqueue per pass. After at least two
fully verified bookings across at least three healthy supervisor runs, a
reviewed change removes that probation limit. Do not add the old proposed caps
of six enqueues, ten queued records, or eight bookings. Process all eligible
entries within existing deadline, storage, pagination and GitHub platform
limits. Queue bookings do not consume the legacy one-direct-merge-per-pass
effect cap. Keep three review rounds and three CI fixes.

Summary lines name all protected/owner-gated outcomes, including unreadable
queue, unresolved admission, refusal exhaustion, foreign entry drift, unknown
ejection, missing group CI, proof unavailable, and historical direct evidence
missing. Use closed labels, exact safe record/PR identity, and no upstream raw
error text. A held queue is expected work, not a runtime-health failure.

## 10. Owner packet and activation sequence

Prepare concrete reviewed artifacts before asking the owner to perform:

1. Grant the ubiquity-sentinel App “Merge queues: Read and write” and accept
   the installation permission update. Reuse the App's existing trusted
   authentication; no new credentials go to model workers.
2. Create/authorize the isolated `queue-canary` branch and its scoped ruleset,
   then execute the reviewed allowlisted canary **with the App**. A human PAT
   test does not prove App actor identity, permission, or dequeue behavior.
3. After all evidence passes, create the reviewed ai.ubq.fi development ruleset
   in coordination with the enqueue-capable code activation. Do not create a
   Sentinel ruleset. The code is ready before direct merges begin returning
   405. The variable is an optional kill switch, not a prerequisite for dark
   safety.

Ruleset proposal: MERGE, ALLGREEN, the four check contexts bound to app 15368,
strict false, deletion/non-fast-forward protection, no unnecessary
`pull_request` review rule, no App bypass, and the narrow owner bypass chosen
by the owner. Build concurrency 3–4 and check-response timeout 60 minutes are
platform settings; raise timeout to 90 only if measured runner delay warrants
it. Pin/revalidate the exact accepted rule response before every enqueue.

The canary records: REST/GraphQL enqueue/poll/dequeue behavior and UUID/status
shapes; group and final commit identities/parents; exact App/merged-by actors;
queued-head push lock or automatic dequeue; explicit queue action with rules
absent never directly merging; rule removal effects; owner bypass push
rebuild/ejection behavior; parked-run approval; CI-failure/timeout/manual/head
push removal reasons; missing-trigger timeout; skipped/neutral rejection; and
uncancelled push/group runs across three merges. A separate coordinator token
check establishes how owner bypass behaves. No hosted Codex review is invoked.

After activation, coordinator merges use the queue. Owner practice is to route
changes through the queue or ensure no Sentinel entry is queued before a direct
push. Per-pass drift rechecks cannot eliminate an owner push between checks
and an automatic merge. The measured authorization window remains about
30–90 minutes and can exceed two hours under bursts; report this concrete
limitation to the owner rather than claiming continuous authorization.

Rollback: lower mode to off; continue custody/proof/drain; observe all tracked
entries out of the queue and resolve their holds; owner disables the target
ruleset; only then roll back launcher/runtime. Emergency R80 rollback retains
non-expiring holds and suppresses unsafe downstream work. Never clear holds
with manual state edits. Keep reservations charged on ambiguous outcomes.

The disabled release workflow stays disabled. Live probation proves queue
merge and verified release-request booking; it does not claim deployed release
acceptance or source closure that depends on disabled release evidence. The
full closure lifecycle is tested with authenticated fixtures.

## 11. Test and review matrix

- R80/current parser and canonical round trips for null-backoff holds, positive
  PR queue intents, every failure constant, requestId UUID, resultId entry ID,
  absent optional fields, and maximum bounded values. R80 runtime-selection
  tests keep both queue holds and PR-less already-satisfied holds asleep.
- Full queue pagination, duplicate/cursor/partial/error/drift rejection,
  foreign enqueuers, queue head vs PR head, and an entry arriving after scan.
- Unconditional prelude ordering before matrix/release/early return; failed
  hold CAS sends no enqueue; queueCustodyReady skip creates no execution or
  reservation and preserves runtime health.
- Dark off with proved absent effective queue rule and no custody remains
  healthy without Merge queues permission; unknown/active rule or any custody
  fails closed on the same permission error.
- Exact pre-enqueue head CI/workflow/rules/source/review/opt-out/path gates;
  queue jumps, foreign `.github` changes and owner base drift.
- Async 202/200/409/400/401/403/404/405/429/5xx/lost responses, persisted UUID,
  operation expiry, cooldown, deadline, no accidental direct fallback, no
  second mutation after ambiguity, three refusal and six-hour age boundaries.
- Own dequeue identity race/response loss; foreign ownership retained;
  ejection recovery and source/head changes without unbounded retry loops.
- Adversarial middle-of-batch proof: legacy verifier would pass but changed
  parent/tree or missing group CI fails. Ordered parents, exact tree modes/blob
  IDs, queue actor, all four latest successful checks, and expired evidence.
- Every delivery/closure/follow-up/adoption consumer shares queue-first proof;
  positive queue evidence cannot use a historical direct grant. Missing run
  never proves direct provenance. Exact preactivation manifest identities stay
  live, later or mismatched identities fail closed.
- New modules use meaningful pure/HTTP fixtures, then repository fmt including
  JSON, lint, size, test-local checks, full authorized tests, and depth-one clone
  tests. Commands remain bounded at 300 seconds; tests never read/chdir /tmp.
- One combined adversarial review covers queue policy, storage semantics,
  consumers, workflow gating, native guards, rollout and owner packet before
  activation. Only unresolved P0/P1 block merge; record P2/P3 follow-ups.

## 12. Critique disposition

| Finding | Concrete correction |
| --- | --- |
| P0-1 expiring marker | Indefinite backoff hold, first prelude, downstream gate, native R82 mutation guards before activation. |
| P1-1 legacy verifier first | Mandatory queue-first discriminator and one proof resolver for every consumer. |
| P1-2 foreign enqueuer | Complete whole queue scan and hold every tracked entry; ownership controls dequeue only. |
| P1-3 enqueue-only receipt/drift | Revalidate task/review/head/paths/order every pass; own dequeue; explicit owner bypass practice and residual window. |
| P1-4 wrong canary identity | App-authenticated exact-branch/PR-allowlist canary and separate coordinator bypass test. |
| P2-1 pending push cancellation | Event+commit/run concurrency identity; three uncancelled post-merge base runs. |
| P2-2 missing/skipped group CI | Accepted workflow manifest + active workflow + strict group check success + restart-safe breaker. |
| P2-3 invisible refusals | Durable existing merge intent, closed failure constants, three refusals and admission-age owner park. |
| P2-4 stranded ejections | Authoritative membership/removal classification, one CI reentry, changed-binding reauthorization. |
| P2-5 understated window | Preserve measured 30–90 minute / over-two-hour disclosure. |
| P2-6 rules race | Pre/post enqueue exact rules validation, bypass false, custody on mismatch. |
| P2-7 sequencing | Healthy R81, dark code ceiling off, accepted native guards, App canary, then production rules/activation. |
| P2-8 unnecessary reviews | Omit pull_request rule; preserve P0/P1-only review policy. |
| P2-9 phase-two livelock | Explicit bounded refresh/review path, not indefinite feature-phase deferral. |
| P2-10 owner push starvation | Queue owner/coordinator work and inspect measured rebuild/run pressure before leaving probation. |

Remaining uncertainties are App-specific GitHub behavior, actual historical
direct witnesses at activation, proof availability after native evidence
expiry, and final R81 API locations. They are explicit gates or fail-closed
outcomes, not permissive implementation guesses.
