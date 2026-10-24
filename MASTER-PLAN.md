# Sentinel master plan

This plan records current scope, architecture, invariants and canonical lane identities. [AGENTS.md](AGENTS.md) governs work in this repository; [docs/DECISIONS.md](docs/DECISIONS.md) records current owner decisions; [docs/build-status.md](docs/build-status.md) is the sole task and acceptance ledger. Earlier plans, investigations and consumed permissions remain recoverable from Git history.

## Outcome and scope

Sentinel runs in GitHub Actions, with a five-minute autonomous dispatch of its protected supervisor (owner directive 2026-10-07) and explicit CLI dispatch still available. It discovers eligible work in configured repositories, preserves evidence and produced candidates, implements isolated issue repairs, obtains current-head structured review, validates and merges accepted work, and reconciles delivery through trusted controllers.

Use isolated concurrent issue workers across configured targets, with one trusted state/integration coordinator and a separate deterministic release controller that exclusively owns promotion. Provider and platform capacity remain real limits. Preserve durable admission and settlement for implementation, review, retry and continuation starts; no artificial hourly/weekly start, unfinished-PR, review-concurrency or review-drain cap is imposed.

The implementation is Deno and TypeScript. Model workers receive credential-free checkouts and bounded evidence; they cannot write authoritative state, change live admission policy, select credentials, merge unverified work or promote releases. Runtime model and review policies are in the decisions document and must not be changed by local worker selection.

The 2026-10-20 owner decision sets runtime implementation to `gpt-reserve` with the existing HTTP 429 fallback to `gpt-6-luna`, both at max reasoning, superseding the former `gpt-5.6-luna` runtime text. Development/orchestration workers use `gpt-6.1-sol`.

This effort's acceptance is green scheduled supervisor cycles plus at least one autonomous issue → PR → completed internal review → merge in each of `ubiquity-sentinel/sentinel`, `ubiquity/ai.ubq.fi`, and `ubiquity/passport.ubq.fi`. The AI and Passport scopes are issue repairs only for now. The public controller's committed target array includes all three; Passport remains private, but selecting it here makes its target state and logs subject to this public controller's visibility. The separate `ubiquity-sentinel/sentinel-passport` controller is not the active three-target controller. The original gateway capture/deployment and extended observation requirements below remain separate scope, with `sentinel-release` disabled.

Current work, readiness and hosted receipts belong in the ledger. The separately owned [memory and self-healing plan](docs/sentinel-memory-plan.md) retains its active implementation contract; this cleanup does not transfer that ownership or establish new live proof.

## Canonical goal identity

The original goal identifier remains stable after development moved to the VPS. Reconcile exact branches, worktrees, dirty state, active writers and accepted ancestry before assigning or resuming work; a recorded identity does not authorize creating, switching or deleting a lane.

| Field                   | Recorded value                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Original goal ID        | `/Users/nv/repos/ubiquity-sentinel/sentinel/MASTER-PLAN.md`                                            |
| Canonical plan          | `/home/codex/repos/ubiquity-sentinel/sentinel/.codex-worktrees/master-plan-gfa795549e5/MASTER-PLAN.md` |
| Repository root         | `/home/codex/repos/ubiquity-sentinel/sentinel`                                                         |
| Goal slug / suffix      | `master-plan` / `gfa795549e5`                                                                 |
| Canonical worktree      | `master-plan-gfa795549e5`                                                                     |
| Canonical worktree path | `/home/codex/repos/ubiquity-sentinel/sentinel/.codex-worktrees/master-plan-gfa795549e5`                |
| Canonical branch        | `codex/master-plan-gfa795549e5`                                                               |
| Initialization base     | `development` / `ec4bd82df4adfdb962e10332607ee4fbf539cdeb`                                    |
| Integration ownership   | Current primary integration owner, recorded in `docs/build-status.md`                         |

Preserve the recorded module identities below. Sentinel worktree paths use `<repository root>/.codex-worktrees/<lane>` and branches use `codex/<lane>`. The gateway module belongs to its own repository; its original recorded root is `/Users/nv/repos/ubiquity/ai.ubq.fi`, and current target ownership/path must be reconciled independently before work. Exact starting bases and current dispositions are ledger facts, not moving branch guesses.

| Module       | Repository           | Recorded lane                          | Surface                                                        |
| ------------ | -------------------- | -------------------------------------- | -------------------------------------------------------------- |
| m01-github   | `ubiquity-sentinel/sentinel`  | `master-plan-m01-github-a86bd3790da`   | `src/github/**`, `tests/github/**`                             |
| m02-evidence | `ubiquity-sentinel/sentinel`  | `master-plan-m02-evidence-afb9652dea8` | `src/adapters/gateway/**`, corresponding tests                 |
| m03-replay   | `ubiquity-sentinel/sentinel`  | `master-plan-m03-replay-ac17fc34d9a`   | `src/replay/**`, `tests/replay/**`                             |
| m04-repair   | `ubiquity-sentinel/sentinel`  | `master-plan-m04-repair-ac50ee9a0a3`   | `src/repair/**`, `tests/repair/**`                             |
| m05-release  | `ubiquity-sentinel/sentinel`  | `master-plan-m05-release-a2ebf3089f9`  | `src/release/**`, `tests/release/**`                           |
| m06-gateway  | `ubiquity/ai.ubq.fi` | `master-plan-m06-gateway-ad0aef5cd31`  | Incident/capture/replay producer and exact build/receipt seams |

## Architecture and runtime order

The repair coordinator reads saved progress, reconciles incomplete external effects, reads authoritative sources, selects eligible actions, reserves any model start, executes bounded work and saves progress. Pending reviews do not hold an agent. A failed source read is unavailable, never a successful empty result. No sleeping model or unchanged busy polling is required.

Prioritize delivery bookkeeping, active production incidents by impact/severity and oldest first-seen time, P0/P1 corrections, other reproducible unresolved 5xx groups, existing Sentinel PR repairs, then issues/review backlog by highest recognized numeric priority and oldest creation time. Use stable repository/source tie-breaks; missing priority sorts last. Preserve dependencies, source integrity and contributor ownership; repeated identical incidents identify one task.

Targets come only from the protected `sentinel.targets.json` array. Each target uses its own default branch, authenticated Git remote, source mirror, review checkout and candidate objects. Trusted configuration supplies commands and protected paths; a repository slug cannot add commands or remove protections. Invalid/absent/empty target configuration refuses rather than choosing a fallback repository.

One absolute execution deadline spans coordinated work. Reserve enough time for model completion, validation, publication and native handoff before starting a session. Matrix planning preserves the existing five-minute operation margin; task-owned cells retain their configured session and completion refusal bounds.

The deterministic release controller reconciles durable requests, identifies an exact candidate and proven healthy prior revision, records intent, promotes, monitors, and accepts or restores the exact prior revision. It uses no model. Repair workers cannot write release state; release controllers cannot edit application code or repair accounting.

The protected hosted supervisor separates preparation, model repair and finalization capabilities. Only trusted controller stages receive supervisor/state authority. Hosted runtime pointer and execution proofs are distinct from target deployment receipts. Bootstrap health alone does not prove autonomous issue delivery.

Under the 2026-10-20 fix-forward decision, release verification is bounded to N=2 per phase with reasoned terminal `abandoned` records. Ordinary work interleaves with pending self-release verification and can use durable degraded admission after two failed verifications of its installed generation; a fresh install still requires healthy bootstrap. Preserve settlement, exact proof identities and every charge.

Ordinary runtime updates now use launcher self-install and dispatcher auto-follow, replacing rollout rows, owner supersessions, custody revision floors and LF materialization. The dispatcher selects the newest CI-green development ancestor by exact first-parent ancestry and complete CI evidence, then fast-forwards `sentinel-supervisor`. Launcher = runtime = that exact SHA at generation+1; bootstrap is model-disabled. Failed bootstrap restores only the journaled previous revision at a higher generation and verifies restoration; failed SHAs cannot reinstall. `SENTINEL_AUTO_FOLLOW` defaults on since the 2026-10-24 owner directive (the repository variable set to `off` disables it); a candidate whose workflow files differ from the launcher defers for a manual advance. Keep compatible historical readers and actual task custody/accounting. Owner-install modules remain unreferenced from prepare, pending deletion in DESIGN.md §4 dependency order; native CI, compatible rollback and hosted acceptance remain separate gates recorded in the ledger.

## Contracts and durable state

[docs/contracts.md](docs/contracts.md) defines strict records, parsers, digest domains, ports and producer/consumer wire contracts. Shared contracts and cross-module wiring have one owner; changing them requires revalidating their actual consumers. No worker invents a status, digest or receipt variant.

Use the Git-backed `sentinel-state/repair` and `sentinel-state/release` records with one trusted writer per surface and expected-head, non-force writes. On conflict, reread and resolve explicitly. Model workers receive no state repository or state-writing credential.

Persist operation intent before candidate publication, PR creation, review, merge or promotion. Reconcile the exact remote object after an ambiguous response before repeating. Preserve candidate identity separately from the observed published head. A produced candidate must pass publication checks, survive in its operation-bound remote ref, and be fetchable from a fresh object store before durability is claimed.

Durable reservations precede every implementation, retry, continuation and review start. Ambiguous submissions remain charged unless proven never submitted. Preserve terminal work and historical accounting; missing evidence cannot justify regeneration, refund, state rewriting or an unchanged retry. Retention cleanup is a separate decision.

## Evidence and permanent regressions

The gateway adapter is read-only and must exhaust supported pagination, authenticate artifact identity/integrity and report missing coverage or expiry. Source, fixture, ciphertext and Git identities use distinct digests. Original identities cannot be rewritten to match a resumed run.

Restricted encrypted originals and raw diagnostics stay outside public Git, issue bodies, PRs and model credentials. Commit only minimal sanitized fixtures with the fix, wired into the target's actual CI. The regression must fail on the recorded original revision for the intended defect and pass on the candidate; upstream responses are replayed locally without paid inference. Lost evidence blocks with `evidence_expired` rather than an invented fixture.

Finite retention/storage bounds, an existing scoped key source and objective stability metrics must be confirmed before activation. Preserve provenance, capture lifetime and sampling gaps. A fixture/helper test does not establish the production producer/consumer boundary.

## Review, merge and release safety

Runtime code changes require native Codex review mode through the internal runtime review service: `codex review`, `codex exec review`, or app-server `review/start`, with reviewer selection owned by Codex. A normal `turn/start` with a selected model, copied rubric or output schema is not review mode, even when the model alias is `codex-auto-review`. Bind the native review lifecycle and completed current-head receipt; require no unresolved P0/P1, fulfilled applicable task acceptance, current deterministic CI and applicable target branch protections before expected-head merge. Missing, stale, malformed or unavailable review evidence cannot pass. Do not propose a general-model substitution to fix an invocation failure. GitHub `@codex review` reviewer statements are retired for autonomous runtime PRs. Development needs no PR for every edit; the 2026-10-20 owner preference for development review is GitHub `@codex review` first, then local `codex review` / `codex-u review` as fallback.

Base movement requires validation of the current integrated candidate. Changed bytes require matching current-head evidence. Human-owned PRs stay untouched unless delegated. Issue-backed repair PR bodies are exactly `Resolves #N`; delivery acceptance still requires its own receipts.

Never select a deployment revision by time, list order or moving branch tip. Persist exact healthy prior/candidate identity and promotion intent before switching. Missing execution settlement or identity remains pending. Refuse to overwrite a newer unrelated pointer or target revision; rollback restores only the recorded prior and requires fresh restoration proof.

The Deno release adapter retains its exact-build, promotion, managed/custom-origin identity and rollback contract. An identified Cloudflare 403 can be a warning only after managed identity passes; any HTTP 200 identity mismatch fails. Preserve continuous 30-minute acceptance with 30-second samples and declared metrics, denominators, baseline, minimum samples and owner-approved thresholds. An interrupted monitor restarts coverage; missing telemetry is unavailable.

The gateway now uses its own trusted VPS deployment path. Deno receipts cannot establish VPS release delivery. [docs/activation-checklist.md](docs/activation-checklist.md) retains the separate target ownership, VPS release-contract and isolated rollback gates; no new deployment or promotion authority is implied here.

## Development ownership and acceptance

Shared foundation owns contracts, state, accounting and toolchain. Module writers own explicitly assigned isolated surfaces. The integration owner alone owns `docs/build-status.md`, integration, scope/disposition and acceptance. DSH workers return uncommitted changes; current local worker selection follows the applicable global routing and explicit task instruction.

### Wave C

Cross-module integration owns actual entrypoints, workflow/config permissions, trusted host composition and connected acceptance. Tests exercise production consumers with fake external services, real temporary Git/state and injected clocks. They contain no paid/model calls, GitHub writes or deployments. Reconcile and freeze writers before final checks; accepted worker tips must remain ancestors of canonical and the shipped branch.

Use the focused local sequence and 300-second command bounds in AGENTS.md. Documentation changes need documentation checks. Whole-repository local sweeps require explicit authorization. Continue authorized hosted work under AGENTS.md through protected publication, verification and necessary corrected candidates or retries without repeated approval; reuse existing evidence on unchanged inputs.

The default per-attempt hosted approval boundary remains for future efforts without equivalent authorization. For this effort, the 2026-10-20 owner grant supersedes it: the orchestrator may dispatch/rerun/cancel/enable/disable Sentinel workflows, push directly to `development`, update launcher pins/runtime pointers, write state branches and merge gated autonomous PRs. The 0x4007 PAT may set secrets as a stopgap. Exact evidence, five invariants and workers' narrower assignment limits still apply.

Operational acceptance requires exact source/candidate/fixture identities, before/after regressions, PR head/review/CI/merge evidence, installed runtime/deployment receipts and observed delivery. Keep local, merged, installed and live evidence separate. Original gateway completion requires two distinct previously undelivered eligible tasks, including a captured-request regression, continued eligible selection, interruption recovery, exact isolated rollback and six observed hours after activation. Old prototype #136 does not count as a new delivery; preserved terminal work is not reset to manufacture throughput.

## Continuation

Start from the active register and latest completed handback; reconcile the recorded lane, owner and evidence before writes. Record accepted/rejected/blocked dispositions in the sole ledger, preserve unrelated work and accepted ancestry, and return a concrete next action for each unresolved boundary. This plan contains current requirements; continue the authorized task under the hosted execution and independent authority boundaries in AGENTS.md.
