# Sentinel project instructions

Read [MASTER-PLAN.md](MASTER-PLAN.md) and [docs/DECISIONS.md](docs/DECISIONS.md)
before changing behavior. The recorded canonical goal and module lane identities
are invariants. Preserve unrelated, dirty and user-owned work. Global
instructions and their routed procedures still apply.

## Architecture and authority

- Use Deno and TypeScript. Define shared contracts before independent
  implementation; shared contracts and cross-module wiring have one owner.
- Use isolated concurrent issue workers, one trusted state/integration
  coordinator and a separate deterministic release controller with exclusive
  promotion ownership.
- Artificial hourly/weekly model-start, unfinished-PR, review-concurrency and
  review-drain caps are lifted. Preserve durable reservations/settlement for
  implementation, review, retry and continuation starts. Provider/platform
  limits and configured session/deadline safeguards remain.
- Sentinel's protected supervisor is dispatched autonomously every five minutes
  (`supervisor-dispatch.yml`; owner directive 2026-10-07, commit `5aac94da8`,
  "Make it fully autonomous"); `observe.yml` and `repair.yml` remain manual
  through the installed `sentinel` CLI (`ops/sentinel-cli.ts`). Keep
  `sentinel-release` disabled as part of development.
- Preserve runtime implementation policy `gpt-reserve` primary with the existing
  HTTP 429 failover to `gpt-6-luna`, both with max reasoning. Supported trusted
  route aliases/configuration are documented in DECISIONS.md; local worker
  selection cannot change production policy or claim a live route.
- The 2026-10-20 owner decision supersedes the former `gpt-5.6-luna` runtime
  policy. Development/orchestration workers use `gpt-6.1-sol`; runtime routing
  remains separate.
- Ordinary hosted runtime updates use launcher self-install: launcher and
  runtime equal the exact CI-green development SHA, with a model-disabled
  bootstrap at generation+1 and exact recorded-prior rollback at a higher
  generation. Failed SHAs cannot reinstall. Dispatcher auto-follow fast-forwards
  `sentinel-supervisor` by verified CI and ancestry; `SENTINEL_AUTO_FOLLOW`
  defaults on (owner directive 2026-10-24, "make it end to end autonomous"), and
  the repository variable set to `off` disables it. A candidate whose workflow
  files differ from the launcher still needs a manual advance. Rollout rows,
  owner supersessions, custody revision floors and LF materialization are
  retired for these updates; actual custody, accounting and compatible
  historical readers remain required. Retained ceremony modules await deletion
  in DESIGN.md §4 order.
- Keep credentials, authoritative state writes, live admission changes and
  promotion authority out of model workers. Use the existing trusted supervisor
  and exact execution/pointer proofs.
- Commit only sanitized minimal regression fixtures. Restricted originals, raw
  diagnostics and credentials remain outside public Git and model checkouts.
- Never add Sentinel branch protection rules or branch rulesets, or recreate
  deleted rules.

## Development and runtime review

### Native Codex review mode is mandatory

Owner clarification, 2026-10-21: Codex review is a dedicated mode, not a normal
Codex session with a selected reviewer model. Invoke `codex review`,
`codex exec review`, or the supported app-server `review/start` entrypoint and
let Codex resolve its reviewer. Do not select an implementation/general model or
override reviewer model/effort to work around a review failure. A
`codex-auto-review` model alias, copied review rubric, JSON output schema, or a
prompt asking a normal `turn/start` to review does not enter review mode and
does not satisfy this requirement.

For app-server integration, preserve the native `enteredReviewMode` and
`exitedReviewMode` lifecycle and bind the actual review thread, turn, target and
result. An unavailable native review path must be diagnosed; it must not be
replaced with a model-selected normal turn. Keep existing current-head/base/task
acceptance, CI, accounting and merge gates. This clarification does not
authorize extra charged attempts, refunds or a changed review-round ceiling.
Routine reviewer selection is owned by Codex review mode and is not an owner
model-selection decision.

Development changes require no development PR for every edit. Make the scoped
change, immediately test it and deliver directly. The 2026-10-20 owner
preference for development review is GitHub `@codex review` first, with local
`codex review` / `codex-u review` as fallback; this supersedes the earlier
blanket development-review prohibition. It does not waive autonomous runtime
target PR review, CI or merge gates.

GitHub `@codex review` reviewer statements are retired for autonomous runtime
target PRs. The internal runtime review service must invoke native Codex review
mode and validate its structured result; selecting a gateway model named
`codex-auto-review` is not a substitute. Runtime code changes require a
completed current-head receipt with no unresolved P0 and current-head CI that is
not red before autonomous merge. Owner directive 2026-10-24: branch protection
rules and rulesets are not a merge requirement on any target, and the only
internal review policy is that every P0 is resolved (P1/P2/P3 never block); a
check the target's own CI skipped or marked neutral is not red.
Missing/stale/unavailable evidence cannot pass. Development reviews follow the
separate owner preference above.

Do not edit the vendored upstream rubric constant in
`src/github/codex-review-rubric.ts`. Its former harness output-schema override
belongs to the superseded ordinary-turn adapter; native review mode owns its
rubric and output protocol. Retain the historical pin/hash and Sentinel
read-only boundary. See
[the alignment note](docs/codex-review-rubric-alignment-2026-10-08.md).

## Fast local development

### Code locality and reads

Keep one cohesive responsibility per file; aim for source files at or below 500
lines and test groups at or below 800 lines where a natural boundary exists.
Review files above those targets. The physical ceilings are 1,000 lines for
source and 1,500 for tests, including comments and blank lines.
`deno task size:check` enforces every tracked code file and new nonignored code
file across the repository, including `ops/`; there is no grandfather baseline
or exemption.

Before reading an unfamiliar code file whole, use `deno task size:report` to
inspect its lines and bytes. Above 500 lines or 20 KB, locate symbols with `rg`
and read focused 100–200-line ranges. Treat truncated output as incomplete,
inspect imports/callers/tests before editing, and refresh symbol locations after
edits. Do not page mechanically through a whole file or split files into one
function each.

### Validation loop

- Use local reproduction and checks as the edit/test loop; hosted CI and live
  Sentinel runs are separate acceptance surfaces. Read existing failure evidence
  once and keep independent local work moving.
- Before editing, identify the changed module, affected callers/contracts and
  smallest observable failure. Prove the actual defect before the fix when a
  regression is useful; permission, type, dependency, dirty-checkout and timeout
  errors are setup failures.
- After a meaningful edit, run applicable file-scoped static checks and the
  smallest relevant named test, then its affected module/consumer boundary.
  Preserve declared Deno permissions. Do not default to `deno task test`,
  `test:integration`, `test:local` or an equivalent whole-repository sweep.
- Enforce a 300-second deadline on every task-owned local validation command,
  including final acceptance, with bounded process-group teardown. Register the
  bounded command through the existing evidence tool and retain command, status,
  elapsed time, exact candidate/diff and output reference. These bounds do not
  authorize terminating model sessions, shared services or other owners'
  processes.
- Observe running checks at intervals of at most 30 seconds. After 60 seconds
  without a completed case or concrete output, inspect the active
  case/command/children and narrow or repair the check. A live PID or elapsed
  time is not progress; never repeat an unchanged failure.
- Exercise production code through real consumers with fake external APIs/model
  ports, temporary Git/state and injected clocks. Advance
  retry/cooldown/observation time in tests. No paid/model calls, GitHub writes,
  credentials or deployment belong in the local harness.
- Validation order is failing local case, repaired case, affected module,
  directly affected integration boundary, then one named target-specific local
  lifecycle scenario on the same integrated candidate. Reuse connected evidence
  when it already covers that lifecycle; only add the missing boundary.
  Whole-repository sweeps need the user's explicit request for that workload.
  Documentation-only changes need documentation checks.
- Before publication, check cheap current file-size/static constraints on the
  exact candidate and its current-base merge input wherever CI tests that merge.
  Reuse unchanged-input evidence; this is not a new whole-suite gate or policy
  ceiling.

### Hosted approval boundary

Default for future efforts without equivalent owner authorization: after local
preparation, obtain approval for each development-triggered hosted attempt,
identifying workflow, target, exact SHA, expected duration and remaining
hosted-only assertion.

Exception for this effort (owner grant, 2026-10-20 UTC): the orchestrator has
blanket authority for hosted dispatch/rerun/cancel/enable/disable, direct pushes
to `development`, launcher pin and runtime pointer updates, state-branch writes
and gated autonomous PR merges. This supersedes the default per-attempt boundary
for this effort and includes corrected candidates and retries; do not request
approval again for those authorized actions. Workers retain their narrower
assignment permissions. The 0x4007 PAT may set secrets as a stopgap.

Within an authorized Sentinel task, continue through protected publication,
hosted end-to-end verification and runtime/supervisor dispatch, including
necessary corrected candidates, retries and reruns, without repeated user
approval.

First complete the locally reviewable candidate and applicable checks. Before
each hosted execution, record the exact workflow, target, SHA, expected duration
and remaining hosted-only assertion; retain the resulting evidence. Keep local,
hosted, installed and live acceptance separate.

After a failure, retain its logs, diagnose and reproduce/fix locally, and repeat
only affected validation before the next attempt. When reproduction requires the
hosted environment, identify the exact gap and use the smallest proving probe
within the authorized task. Preserve integrity, custody, durable accounting,
current-head review and CI, target ownership and exclusive promotion authority.
Independent credential/security actions outside the dated grant and numeric
retention approvals remain required, and whole-repository local sweeps still
require explicit authorization. Include these boundaries in worker assignments
and continuations.

## Ownership and acceptance

`docs/build-status.md` is the single authoritative task and acceptance ledger.
Only the current primary integration owner may edit it or change scope, status,
acceptance, evidence disposition or write ownership. The owner directive of
2026-10-13 retires Muse and transfers this role to the current GPT-6.1 Sol
coordinator. Other workers return evidence and proposed updates; they do not
create another authoritative task list.

A fresh integration owner reads the active register first and reconciles exact
Git/process ownership, reservations, current refs and existing evidence before
writes. READY, elapsed time and cached success do not establish integration or
acceptance. Integrate, reject or assign a concrete owner/next action to ready
work promptly; preserve original goals and accounting.

Before a major milestone or resuming after repeated failure/no useful progress,
obtain a read-only audit from a fresh GPT-6.1 Sol/max agent without inherited
worker history. Supply the authoritative task, exact candidate diff and evidence
references. The owner records its independent pass/corrections/blocker; the
auditor does not become another writer. Do not request an audit per edit or a
development Codex review.

Use recorded module scopes and explicit isolated ownership. DSH workers do not
commit or push; the primary validates, commits and integrates with accepted
ancestry preserved. Freeze writers for final validation and acceptance. The
canonical lane and shipped branch must contain accepted worker tips.

Reconcile and explicitly transfer target ownership before live writes. Never run
Sentinel against a target still owned by the embedded prototype. Exact
candidate/prior revision identity, verified promotion, objective acceptance and
exact rollback are mandatory. Never select revisions by time or list order;
preserve the target's Cloudflare 403 policy and current VPS/Deno receipt
distinction.

Separate local checks, reviewed code, merged code, installed runtime and live
delivery proof. Health/bootstrap/workflow success alone is not issue delivery.
Report genuine unresolved boundaries and one concrete next action, with concise
checkpoints rather than unchanged polling or full historical dumps.

Acceptance for the 2026-10-20 effort is green scheduled supervisor cycles and at
least one autonomous issue → PR → completed internal review → merge per target
(`ubiquity-sentinel/sentinel`, `ubiquity/ai.ubq.fi`,
`ubiquity/passport.ubq.fi`). The AI and Passport scopes are issue repairs only
for now; `sentinel-release` stays disabled.
