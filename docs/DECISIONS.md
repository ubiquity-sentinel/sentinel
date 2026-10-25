# Sentinel decisions

These are current owner decisions for Sentinel. [AGENTS.md](../AGENTS.md)
governs execution, [MASTER-PLAN.md](../MASTER-PLAN.md) defines scope and
invariants, and [build-status.md](build-status.md) records current ownership and
acceptance. Superseded choices, task-specific exceptions and consumed
permissions remain in Git history; current task authorization governs
continuation.

## Runtime and dispatch

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
review from native Codex review mode, with no unresolved P0/P1; (5) the
deterministic Deno controller exclusively owns promotion and `sentinel-release`
stays disabled.

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
coordinator to take over Sentinel. The sole primary integration owner is now the
current GPT-6.1 Sol coordinator; independent milestone audits use a fresh
GPT-6.1 Sol/max agent. This replaces the Astra-specific development ownership
and auditor restriction, not runtime model/review policy, credential custody,
CI, source/target identity or promotion ownership. Preserve existing dirty work
and recorded lane identities; only the primary writes the authoritative
build-status ledger. The owner reaffirmed the recorded takeover for this
continuation on 2026-10-14; actual coordinator model/effort is reported
separately from role ownership in the ledger and does not change the selected
execution route.

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

Owner decision 2026-10-18 supersedes the earlier runtime model selections below:
use `gpt-reserve` as the runtime implementation primary and `gpt-6-luna` for the
existing HTTP 429 failover, both with max reasoning. Set the existing trusted
`SENTINEL_IMPLEMENTATION_MODEL_ID` repository override to `gpt-reserve`; retain
`SENTINEL_MODEL_FAILOVER_ID`'s existing `gpt-6-luna` default, the same endpoint
and credentials, execution deadlines and durable admission/accounting. Preserve
the supported route interfaces below. Local coding-agent routing or a
task-scoped worker model does not change production routing, and this decision
alone does not prove the live route.

The trusted route configuration in
[src/host/model-route.ts](../src/host/model-route.ts) also supports the gateway
alias `gpt-reserve`, explicit `SENTINEL_MODEL_BASE_URL`/`SENTINEL_MODEL_ID`
configuration and the previously owner-authorized DeepSeek-direct route selected
by `SENTINEL_MODEL_FALLBACK=deepseek` with the existing scoped key. Those
interfaces are retained; this consolidation neither selects a route nor asserts
which route is live. Reconcile the approved policy and actual installed
configuration before a future route change. Invalid/incomplete configuration
refuses, and receipts bind the submitted model/provider to actual
thread/turn/routing evidence. Max reasoning remains required.

On 2026-10-17 the owner chose `gpt-6.1-sol` on the ai.ubq.fi gateway as the
implementation model, once generation 80 had six consecutive clean supervisor
runs. The supervisor workflow binds `SENTINEL_MODEL_ID` to
`vars.SENTINEL_IMPLEMENTATION_MODEL_ID || 'gpt-6.1-sol'` in the plan, cell and
repair jobs alike, so a nonempty `SENTINEL_IMPLEMENTATION_MODEL_ID` repository
variable overrides it. The older `SENTINEL_MODEL_ID` repository variable, which
held `gpt-reserve`, is no longer read and can be deleted. Reasoning stays `max`,
the 429 failover stays `gpt-6-luna` and reviews stay on `codex-auto-review`.

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
unresolved P0/P1 may pass the gate; changed candidate bytes need matching
evidence. The separate development-review preference above does not satisfy this
runtime gate.

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

The reviewer vendors `openai/codex` tag `rust-v0.162.0`,
`codex-rs/prompts/templates/review/rubric.md`, SHA-256
`ec60e7f36a1d1c2679ce095c0205ecc56f7dd8fb57707a13ef362072390f219f`. Do not edit
the vendored constant in
[src/github/codex-review-rubric.ts](../src/github/codex-review-rubric.ts).
Sentinel's read-only boundary and attached harness schema override the rubric's
output-format section. A re-sync needs a new upstream pin/hash and
current-candidate validation;
[the alignment note](codex-review-rubric-alignment-2026-10-08.md) gives
verification details.

Never add Sentinel branch protection rules or rulesets, or recreate deleted
rules. Applicable target protections still govern autonomous target merge.

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
`followup:deadline`), the launcher files one issue per merged PR in the target
repository for unresolved P2/P3 findings from its clean current-head review.
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
`<!-- sentinel:review-followup:v1 repo=<owner>/<name> pr=<pr> receipt=<receipt id> depth=<d> -->`.
Before any create, the repository's created-since listing is read. An observed
App-authored issue marker for the same repository and PR means already filed,
regardless of receipt or depth. A capped listing proves absence only for
candidates whose full ten-minute request/GitHub clock margin is strictly newer
than its oldest item; timestamp ties and older uncovered candidates remain
`listing_unproven`, while covered newer candidates can continue. Ambiguous
creates remain charged to the pass and are reconciled from the next listing.

Reviewer text is quoted inert (controls removed, no live mention, issue
reference or line-leading slash command) inside a tilde fence. Each finding
links its `path:a-b` at the reviewed head. Depths 1 and 2 remain ordinary
Sentinel-admissible issues; depth 3 is filed with the existing `sentinel:skip`
opt-out and is not automatically repaired. Limits remain two creates, four merge
checks and eight unfiled candidates per pass, five listing pages, a 60-second
budget, twenty findings of at most 1,500 characters, a 12,000-character body and
a 120-character title. The `followUpIssues` capability (repository-bound listing
GET, issue GET and issue POST with verified App creator) exists only on the
launcher's port, never in `src/github` or a model worker. An
administrator-deleted follow-up can be filed again because its remote marker is
the duplicate evidence; elapsed time alone never proves absence or refunds an
ambiguous reservation.

Rollback: the written snapshots parse under R79 549c7a691, R79's own binding
binds them and its delivery step waits on the open request (no merge, no refresh
intent), the launcher L79 7e38d16a4 reports `already_recorded` and
`release_unavailable` over them and writes nothing, and R79's task-statement
check and intake opt-out reader admit the follow-up issues; the follow-ups write
no state and no matrix cell.

## Generation 80 installation (2026-10-17)

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

## 2026-10-25: observability lines, target rotation, outage notice and wedge report (redesign C5)

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
- Target order: `runActionsTargetCycles` runs the targets in the setting order
  rotated left by `runId % configs.length`, so Passport is not always last
  behind two review drains. Without a native run id the setting order is kept.
  `addressed` and `skipped` follow the rotated order, and the outcome is still
  the last addressed cycle's.
- CI outage notice: the state-free `ops/hosted-autonomy-outage-observation.ts`
  keeps one issue per foreign target on Sentinel's own tracker while that
  target's tip has only never-started checks. That means at least one
  never-started failure, nothing started and nothing undetermined; skipped and
  cancelled checks count nowhere. The first body line is
  `<!-- sentinel:ci-outage:<owner>/<repo> -->`. The body names the tip, the
  never-started count, the records waiting and one owner action: "restore
  Actions billing or raise the spending limit for <owner>".
  - The same facts write nothing, and changed facts update the body.
  - A started check closes the issue with one comment.
  - A pending or unreadable tip changes nothing.
  - The marker on someone else's issue prevents a duplicate and is never edited.
- The outage pass takes the never-started classification as an injected
  predicate (C2) and is wired into the maintenance runner separately (WP1.4 owns
  the runner). Intake never admits a notice Sentinel filed (as the App, or with
  the maintenance job's native-token fallback) as a repair task
  (`isCiOutageNotice`), because no code change fixes billing; the same first
  line on anyone else's issue is ordinary work. On recovery every notice
  Sentinel filed for the target closes.
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
  most 60 within 4,000 characters, the rest counted) and says: if the fix
  requires one of these paths, make no change and say
  `OWNER_LANDING_REQUIRED: <paths>`. The list reaches the port through the
  host's trusted target configs, never through the request, its digest or a
  receipt. A repository without configured prefixes gets the earlier prompt byte
  for byte. The candidate's own protected-path check stays the enforcement.
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
  proof, as before.
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
  looks at the base tip and those heads. Of each workflow it takes the newest
  run, and re-runs its failed jobs (the flake pass's existing
  `rerun-failed-jobs` request) when every failed job of its latest attempt never
  started. A run is asked at most once per 30 minutes: its `updated_at` must be
  that old. Only a latest attempt that took at most 60 seconds costs a job
  listing read. One pass reads at most 24 job listings and sends at most 8
  re-runs, inside 60 seconds, and never past GitHub's 30-day re-run window. It
  writes no state.
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
  second merge would land on a tree no CI ran on.
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
  pre-review fix, the pre-merge correction and the carried gate write) stands
  `waiting` and holds nobody, at any step. Once the hold is due it stands as
  before until its own step re-arms the hold or moves on
  ([src/repair/delivery-queue.ts](../src/repair/delivery-queue.ts)).
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

- 2026-10-25 status: filing ships off (`BASE_REPAIR_FILING_ENABLED = false`).
  The lane's adversarial review upheld a P1 (it filed for any failing tip check,
  including dispatch-only deploy jobs no pull request runs) and P2s (one
  unfiltered page of 100 open issues, no author check, a closed issue refiled
  for the same tip, a label Passport does not have). While off, the pass reads
  and files nothing; the runtime half changes nothing until a marked issue
  exists.

- Finding (live state, 2026-10-24 23:00 UTC): all 39 Passport records at `work`
  were held by the CI-first gate's `base_red` rule. Their failing check is red
  on Passport `main` too, so they back off uncharged until "a later base move".
  Two of them held the delivery line for the 22 reviewed Passport PRs behind
  them. A red base can only move by a merge, and no merge passes a red base, so
  nothing in Sentinel was assigned to fix it and the whole target stayed wedged.
- Decision: the launcher's maintenance pass reads the base tip of every foreign
  target with a record held in a timed `backoff` at `work` (the CI-first
  red-base hold), sharing the follow-up pass's one state read
  ([ops/hosted-autonomy-base-repair.ts](../ops/hosted-autonomy-base-repair.ts)).
  When a completed check on that exact commit failed (`failure`, `timed_out` or
  `startup_failure`), it files one issue labelled P0, titled
  `CI is failing on <branch>`, with `<!-- sentinel:base-repair:<branch> -->` as
  the first body line and the failing check names, unless an open issue already
  starts with that marker. It writes no state and never edits, closes or
  comments on an existing issue. The self scope is left to self-observation.
- The runtime admits the issue like any other; its P0 label selects it before
  ordinary work. For that task alone (P0, open, authored by the App, marker on
  the first line; `src/repair/base-repair.ts`), a `base_red` failure is the
  candidate's own failure: its head still fails the checks it was filed to fix,
  so it takes the ordinary charged CI fix route instead of the uncharged hold.
  Every other record keeps the hold, and an ordinary record is never read for
  it.
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
