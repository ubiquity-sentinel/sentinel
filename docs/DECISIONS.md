# Sentinel decisions

These are current owner decisions for Sentinel. [AGENTS.md](../AGENTS.md) governs execution, [MASTER-PLAN.md](../MASTER-PLAN.md) defines scope and invariants, and [build-status.md](build-status.md) records current ownership and acceptance. Superseded choices, task-specific exceptions and consumed permissions remain in Git history; they grant no fresh hosted approval.

## Runtime and dispatch

### Integration ownership after Muse retirement

On 2026-10-13, the owner stated that Muse is retired and directed the current coordinator to take over Sentinel. The sole primary integration owner is now the current GPT-6.1 Sol coordinator; independent milestone audits use a fresh GPT-6.1 Sol/max agent. This replaces the Astra-specific development ownership and auditor restriction, not runtime model/review policy, credential custody, CI, source/target identity, promotion ownership or per-attempt hosted approval. Preserve existing dirty work and recorded lane identities; only the primary writes the authoritative build-status ledger. The owner reaffirmed the recorded takeover for this continuation on 2026-10-14; actual coordinator model/effort is reported separately from role ownership in the ledger and does not change the selected execution route.

Sentinel runs in GitHub Actions. Per the owner directive of 2026-10-07 (commit `5aac94da8`, "Make it fully autonomous"), `supervisor-dispatch.yml` runs every five minutes and dispatches the exact protected `sentinel-supervisor` ref; `observe.yml` and `repair.yml` stay manual-only, and `sentinel-release` remains disabled. The installed trusted-host CLI stays available for explicit dispatch: `sentinel status`, `sentinel run observe`, `sentinel run supervisor`, and `sentinel receipts <run-id>`. The supervisor uses the exact protected `sentinel-supervisor` ref and authenticated execution receipts; neither time nor list order selects a runtime.

Every development-triggered hosted end-to-end/runtime/supervisor dispatch, retry or rerun needs explicit user approval for that identified attempt after local preparation; earlier activation/recovery permissions do not authorize this task's next attempt. The scheduled autonomous dispatcher and the runtime's own retries are runtime behavior, not development-triggered attempts.

## Source-only stabilization installer preparation

The 2026-10-14 takeover implementation prepares a separate fixed stabilization transition for immutable repaired runtime candidate `c8d2e87468399abb54cc9d9a749ae7b400835bbb` from the exact healthy generation-74 revision `4baeaf67d9677a317bc37831486c075b143fe68f`. The previous unconsumed candidate `2cf3a988313c12876faca8ff30fd85473073181c` failed native CI; the repaired candidate preserves the runtime bytes while fixing harness discovery and stale behavioral fixtures. Its two pending local cases and exact committed-tree size check now pass, with prior unchanged-input statics reused. Freeze runtime R before the later controller C is committed; C pins this exact R and still requires successful exact-R native CI and all installation gates. This is local controller preparation, not installation authority. Reuse the existing installer interfaces and native CI, ancestry, quiescence, prior-proof, expected-state and one-shot rollback gates; add no CLI, environment variable, credential, workflow input or persisted schema. Preserve all existing generation-75 retry constants and provenance as a distinct revision-bound transition. Changed live state must hold for reconciliation, not widen this transition. The primary records isolated module r28-stabilization-install in the stabilization handoff and integrates its source only after focused checks and an independent exact-delta audit. Publishing an installer-capable controller to sentinel-supervisor and each identified hosted attempt remain separately gated; release and the restricted bridge remain disabled/setup_only.

## Deterministic gateway source verification

The integration owner selects one fixed ordinary code-CI workflow to execute the gateway aggregate command `sh scripts/verify.sh` on immutable gateway source `9d83f306a92b11a0929c414b445fc8a1367e01d9`. The local literal attempt remains resource-interrupted, and fresh bounded capacity evidence does not admit another local attempt. The gateway lint-migration note limiting CI changes applies to that earlier task; this scoped stabilization decision leaves its existing CI and production behavior intact. Reuse the existing Sentinel m07-ci-loop lane and add only `.github/workflows/gateway-source-verify.yml`; its push trigger is restricted to the canonical coding branch and changes to that file. Use existing pinned public checkout/setup actions, exact source verification, a clean allowlisted child environment, public lock-pinned tooling, and no credentials, dotenv discovery, deployment, live E2E, model calls or runtime/supervisor invocation. The exact gateway coding branch may be normally published as an unaccepted source carrier before its gate runs; that publication grants no shipping, readiness, promotion or target authority. The native job must retain exact controller/source identity, runtime versions, unchanged tracked inputs and the actual literal command result. Keep runtime R and controller C immutable. Native source CI, the interrupted production-isolation receipt, source shipping, protected publication and original live/capture/rollback acceptance remain separate; no new hosted runtime/E2E approval is implied.

## Concurrent issue processing

Use isolated concurrent issue workers across configured targets, one trusted state/integration coordinator and exclusive serialized merge/promotion ownership. Artificial hourly/weekly model-start, unfinished-PR, concurrent-review, review-drain and ordinary hourly-delay caps are lifted. GitHub/provider capacity and configured session/deadline safeguards still apply.

The trusted start-limit policy is `liveStartLimits: { perHour: null, perSevenDays: null }`; a wholly null or invalid policy does not enable inference. Preserve unique task/admission identity, durable reservations and ambiguous/submitted history, source freshness, exact-head semantic review/CI and credential/state separation. No manual quota or state rewriting is authorized.

Matrix planning reserves the existing five-minute operation margin for native job handoff. Stop reading further candidates when a full configured session and completion margin no longer fit. Preserve the shared execution start/deadline and cell-side refusal; planner throughput is not permission to shorten safeguards.

## Runtime model policy and trusted route configuration

Preserve the runtime implementation policy `gpt-5.6-luna` with max reasoning. Local coding-agent routing or a task-scoped worker model does not change production routing.

The trusted route configuration in [src/host/model-route.ts](../src/host/model-route.ts) also supports the gateway alias `gpt-reserve`, explicit `SENTINEL_MODEL_BASE_URL`/`SENTINEL_MODEL_ID` configuration and the previously owner-authorized DeepSeek-direct route selected by `SENTINEL_MODEL_FALLBACK=deepseek` with the existing scoped key. Those interfaces are retained; this consolidation neither selects a route nor asserts which route is live. Reconcile the approved policy and actual installed configuration before a future route change. Invalid/incomplete configuration refuses, and receipts bind the submitted model/provider to actual thread/turn/routing evidence. Max reasoning remains required.

## Review and development delivery

Development changes require no development PR or Codex review: make the scoped change, immediately run the applicable local checks and deliver directly. Autonomous runtime target repairs retain their PR, completed current-head review, CI and merge gates. Review scope excludes changes limited to tests, fixtures, boot scripts, development tooling, documentation or other non-runtime files.

A qualified `already_satisfied_at_base` review permits a distinct guarded terminal-satisfaction path, not fulfilled acceptance, a new repair, merge authorization or a release request. Persist the exact-bound closure intent before effects; preserve the original verdict, candidate, accounting and provenance. The trusted controller closes only its own exact unmerged PR and the digest-bound source issue, reconciles ambiguous effects and retries partial closure without repeating a confirmed PR close. Missing native review, task, head/base, CI, ownership or closure-capability evidence cannot authorize completion. Ordinary fulfilled delivery retains its existing merge and release gates.

GitHub PR closure has no atomic expected-head merge-style CAS. The terminal path relies on trusted serialized intent, an immediate identity read and response/readback identity checks; it must not claim server-side atomicity. Already-blocked historical records do not become eligible merely because this forward path is installed; they require a separately verified native recovery transition, not a manual state rewrite.

Never post `@codex review` or otherwise invoke the hosted Codex GitHub app. Runtime target PRs use only the internal structured reviewer through gateway `codex-auto-review`. Silence, a reaction or absence of comments does not establish a completed review. No unresolved P0/P1 may pass the gate; changed candidate bytes need matching evidence.

The reviewer vendors `openai/codex` tag `rust-v0.162.0`, `codex-rs/prompts/templates/review/rubric.md`, SHA-256 `ec60e7f36a1d1c2679ce095c0205ecc56f7dd8fb57707a13ef362072390f219f`. Do not edit the vendored constant in [src/github/codex-review-rubric.ts](../src/github/codex-review-rubric.ts). Sentinel's read-only boundary and attached harness schema override the rubric's output-format section. A re-sync needs a new upstream pin/hash and current-candidate validation; [the alignment note](codex-review-rubric-alignment-2026-10-08.md) gives verification details.

Never add Sentinel branch protection rules or rulesets, or recreate deleted rules. Applicable target protections still govern autonomous target merge.

## GitHub identity and target scope

Repository-visible autonomous Sentinel activity uses the existing `ubiquity-sentinel` App, App ID `4682172`, bot login `ubiquity-sentinel[bot]`: candidate pushes, PR creation/merge, review publication, issue closure and CI approval. Existing durable state refs use the native Actions token. App private keys and installation tokens remain trusted-host capabilities; workers receive neither.

`sentinel.targets.json` is the only target source. Minted installation-token scope must include every committed target; App installation selection alone does not widen a token narrowed by `repositories`. Each target uses its own default branch, authenticated mirror, review checkout and Git objects. Self-scope installation ID `0` is the explicit reserved local scope; foreign targets use their own verified App installation. Target preparation failures must be reported as failed rather than addressed.

Eligibility is default-on for open issues, with opt-out only through the standalone first-line `<!-- sentinel:skip -->` body comment or `sentinel:skip` label. Re-read source before admission; gaining either opt-out revokes eligibility before a start is charged. No author, assignment, estimate, template or file-hint admission gate is added.

Issue-backed repair PR bodies are exactly `Resolves #N`; a record without an issue reference keeps a descriptive non-closing body. A failed closure is retried as closure only. Source merge/closure does not substitute for runtime/deployment acceptance receipts.

## Failure accounting and diagnostics

An authenticated terminal interruption whose only failed bound is output size and whose candidate/bundle are both absent may enter the existing failed-implementation consumer. Preserve the original over-limit metrics, all identity/carrier/request/model/duration checks and original charge. Settlement is AMBIGUOUS/BLOCKED with the original intent; it grants no import, publication, refund, fabricated result or weakened output bound. Other invalid, successful or candidate-bearing over-limit receipts remain rejected.

Numeric GitHub pagination aliases are accepted only after authenticating the same repository ID/name and retaining host/path/query/page guards. Native-carrier reads stay scoped to their exact run; custody and per-request dispositions must survive runtime upgrades. Generation or age alone cannot retire unresolved preservation authority.

Gateway unavailable diagnostics retain numeric HTTP status without response bodies, URLs, authentication headers or credentials. Error kind and fail-closed observation remain unchanged; the status alone does not establish a producer root cause.

A settled hosted child that reports state_error or source_error surfaces its own bounded authored detail as one advisory line beside the terminal, so a failed hosted run names its closed failure instead of collapsing to the static settled-failed text. The advisory never carries raw stderr, credentials or model text and never changes the terminal, health, settlement or exit status.

A failed delivery port call emits one closed sentinel_merge_event (event kind, PR number, closed port error kind, allow-listed detail code) beside the unchanged unavailable wait, and the launcher forwards each accepted event as a hosted_merge_event advisory. The event never carries a message, body, URL, path or credential, and it never changes the wait, intent, terminal or exit status.

A bound review attempt whose own settle deadline passed without an accepted verdict is provably dead: an interrupted owner, a lost submission response or an unreadable pending journal can never produce the polled record. The observation step recovers it — a surviving review_request intent is counted once and cleared, a plain observation wait only clears — and requests a fresh uniquely admitted round instead of re-arming the transient wait forever.

## Durable memory and self-healing

Sentinel records machine-readable attempt memory and a deterministic lesson digest in the existing Git repair state; trusted writers own every write and model workers never write state. Bounded records carry the attempt fingerprint, the stage reached, a closed failure class, counts and the runtime revision. Unchanged replays of a recorded failure are refused with a precise reason, and the implementer prompt carries verified prior attempts, cross-task repository lessons and regression facts.

The system is version-controlled and regression-aware: a recorded success stores the exact runtime revision that produced it, and a failure mode that previously succeeded at an older revision is reported as a regression (worked before, broken now) in the lesson digest and the implementer prompt, which must prefer restoring the older working behavior over re-implementing. Rollback authority stays with the owner-development install chain: a healthy proof moves generations, a failed candidate restores the recorded proven predecessor once, and no model, worker or recovery pass may pin, roll back or promote a runtime revision.

Bounded self-upkeep passes defer instead of failing the run: exhausting a recovery pass's budget, absent custody or an unavailable producer is reported with an explicit bounded reason, writes nothing and lets prepare, matrix_plan and delivery continue. Only integrity faults (tampered, conflicting or changed custody) fail closed.

A release request the trusted controller cancelled or marked failed is terminal delivery evidence: the affected delivery record is parked blocked with the recorded failure reason instead of waiting for release acceptance that can no longer exist.

A trusted already-merged pull request is verified by its exact head binding plus the recorded base's proven ancestry, not by first-parent equality: the base branch may advance between the reviewed snapshot and an external trusted merge, and the merge is still the reviewed delivery. A divergent, unproven or differently-parented merge is refused.

## Evidence, target release and local development

Sentinel adapts the Ubiquity physical file-size policy from `ubiquity/ts-template` revision `fc5add134e8ed3728a3da981d298d0a92eb27ac8` with Deno-native `size:report` and `size:check` tasks. Source ceilings are 1,000 lines and test ceilings are 1,500, counting comments and blanks; 500/800 are review triggers. All tracked and new nonignored code, including operations scripts, is covered without a grandfather baseline or exemptions. Keep Deno's existing formatter, linter and lockfile; the cheap size gate also runs in `test-local.ts` before typechecks/tests. This adaptation does not add an ESLint/Node toolchain or broaden local/hosted validation authority.

Use fast module checks and directly affected production-consumer boundaries with fake external transports, temporary Git/state and injected clocks. Enforce a 300-second deadline on each local validation command. One named changed-lifecycle scenario is final local acceptance; whole-repository sweeps require a separate explicit request. [AGENTS.md](../AGENTS.md) defines observation, teardown and evidence rules.

Preserve candidate durability, exact reviewed heads, independent state/promotion ownership, healthy prior identity and exact rollback. Gateway deployment follows its current trusted VPS contract; Deno target receipts cannot establish VPS delivery. Finite encrypted evidence retention, objective telemetry and uninterrupted acceptance coverage remain activation requirements in [activation-checklist.md](activation-checklist.md).

## Historical retry disposition (consumed)

The sixteen historical retry admissions stuck by the missing-artifact matrix wave 37354374590 are consumed. All sixteen bound retry reservations settled `ambiguous` on 2026-10-09, the records were re-admitted, and issue 398 and issue 541 were delivered by the runtime and closed (PRs 955 and 958); the remaining entries carry their own fresh intents or blockers. [ops/historical-retry-disposition.ts](../ops/historical-retry-disposition.ts) reports `already_applied` and writes nothing once every bound reservation is settled `ambiguous`, regardless of later record movement, and the one-shot maintenance step was removed from [supervisor.yml](../.github/workflows/supervisor.yml).
