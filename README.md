# Sentinel

Sentinel runs coding work on GitHub-hosted runners through two entries. Both use Deno and TypeScript and review exact candidate commits in native Codex review mode.

## Issue mode

Open an eligible GitHub issue in a public repository configured for the supervisor. The protected supervisor discovers it on its scheduled run and publishes a repair PR from a deterministic `sentinel/repair/issue-*` branch. Follow the issue and PR for progress. Sentinel merges qualifying repairs through its review and CI gates. [Supervisor targets](sentinel.targets.json) · [Branch naming via `candidateBranch`](src/repair/keys.ts#L62)

## On-demand mode

Submit a JSON request on `development` after the repository owner admits that ref to the protected environment. Name an admitted public repository, the task and any specific base branch. Sentinel returns an accepted result branch and an optional draft PR. You control the merge. [Operator job guide](jobs/README.md)

## Review and delivery

Both entries capture and review the exact candidate against the task that authorized it. Issue repair uses the live issue statement. Operator jobs use the original, pinned request prompt. Changed candidates need completed native Codex review with a positive task assessment and all findings accounted for. P0 is the only severity-based blocker. Lower-severity findings remain visible in the outcome, and issue repair files receipt-bound follow-ups through its existing path. A P0 or negative task assessment can trigger isolated correction and another review within the deadline. Review rounds and ordinary CI-fix attempts are accounting, with a separate three-attempt CI-fix limit for base repair. [Review policy](docs/DECISIONS.md#review-round-ceiling-and-ci-fix-cap-retired-2026-10-3031) · [Base-repair policy](src/repair/base-repair.ts)

Issue repair requires current-head review and applicable CI at the expected-head merge. Operator jobs report the verdict in the run result. Accepted changes also carry an authenticated Sentinel App verdict comment on the exact published SHA and the verdict on the optional draft PR. To merge an operator result, check that the reviewed SHA still matches the result, verify the target's CI and requirements, and merge it yourself. [Operator job results](jobs/README.md#results)

## Supervisor operation

The supervisor runs isolated issue workers and keeps durable candidate and accounting state. Trusted controllers own GitHub writes and release decisions. Captured-incident and deployment activation follow separate gates.

Start with [the current master plan](MASTER-PLAN.md), [project instructions](AGENTS.md) and [owner decisions](docs/DECISIONS.md). [The build ledger](docs/build-status.md) is the sole source of current task ownership and acceptance; [the active memory plan](docs/sentinel-memory-plan.md) covers durable attempt memory and self-healing. Historical plans and receipts remain available in Git history.

The public and private controllers run the same source. GitHub's repository identity selects a committed deployment profile. Public works public targets, and private works private or internal foreign targets after checking its own visibility. Planning, repair and late-cell recovery use the same target-loading rule. The profile also records the workflow differences and cell ceilings. [Deployment profile](src/contracts/hosted-controller-deployment.ts) · [Deployment rules and inventory](docs/DECISIONS.md#2026-11-25-one-deployment-profile-governs-hosted-behavior)

The public repository is [ubiquity-sentinel/sentinel](https://github.com/ubiquity-sentinel/sentinel). A five-minute scheduled dispatcher invokes the protected supervisor; explicit trusted-host dispatch and receipt inspection remain available through the installed `sentinel` CLI:

```sh
sentinel status
sentinel run observe
sentinel run supervisor
sentinel receipts <run-id>
sentinel report --since 2026-11-01 [--until 2026-11-07]
```

`sentinel report` is a read-only throughput readback: it fetches the `sentinel-state/metrics` ref (per-cycle metrics and daily rollups) and the repair state snapshot through their existing readers, writes nothing, and prints plain tables for an inclusive UTC window of at most 92 days: cycles, merges, refresh commits and target CI runs per merge, and model duty cycle (matrix cell minutes / controller minutes) per day; the planner refusal histogram; merges per day by repository; and the current delivery-queue depth, blocked-cause histogram and longest-waiting live records. A value the data does not record prints `n/a (not recorded)`, never zero. It needs only `--allow-run=git --allow-env=PATH --allow-read=<scratch> --allow-write=<scratch>` (scratch defaults to `/tmp`; `--remote <url-or-path>` selects another state remote) and refuses rather than prompts when a grant is missing.

The report ends with a Thresholds table: the throughput watchdog's own evaluation (`src/host/throughput-watchdog.ts`, limits in `src/host/throughput-watchdog-thresholds.ts`) printing `met`, `missed` or `insufficient_data` per #340 threshold. Finalize runs the same evaluation every cycle and files one `priority:2` issue per missed threshold on this repository (second body line `<!-- sentinel:throughput-watchdog:<id> -->`) for Sentinel to repair like any other issue, several in one cycle when several are missed: never while that threshold's issue or a pull request referencing it is open; after its issue closes, not again until 10 cycles ran on a runtime newer than the one installed at close and the threshold is still missed, or at once if the measurement got more than 10% worse than at close; an open issue is edited only when its window advanced 10 cycles; at most 3 watchdog issues per UTC day. The state lives in `throughput/watchdog.json` on the metrics ref. The repository variable `SENTINEL_SELF_IMPROVE` (default `on`) set to `off` stops the watchdog; review, CI, P0, accounting and auto-follow gates are unchanged.

The 2026-10-20 owner grant authorizes the orchestrator's hosted workflow control, direct development pushes, launcher/runtime/state updates and gated autonomous merges for this effort without repeated approval. The default per-attempt boundary remains for future efforts without equivalent authorization; see the [hosted approval boundary](AGENTS.md#hosted-approval-boundary). Worker assignments retain their narrower permissions.

Runtime updates use exact CI-green launcher self-install and dispatcher auto-follow, whose source default is on; an explicit repository override can hold it off and workflow changes require a manual advance. Documented implementation policy, source defaults, hosted configuration and actual routes are distinguished in [owner decisions](docs/DECISIONS.md#runtime-model-policy-and-trusted-route-configuration). Operational acceptance is green scheduled cycles plus an issue → PR → native review → merge per target. `sentinel-release` stays disabled.

[Shared contracts](docs/contracts.md) define records, ports, producer/consumer wire shapes and evidence custody. [The activation checklist](docs/activation-checklist.md) preserves target ownership, current VPS release boundaries and required live proofs. [Reviewer alignment](docs/codex-review-rubric-alignment-2026-10-08.md) identifies the historical vendored rubric pin and the current native-review path. [Source adaptation pins](docs/third-party-reuse.md) and [license notices](THIRD_PARTY_NOTICES.md) cover reused components.

Dated handoff packets, redesign and specification snapshots, and retained review artifacts preserve their original source and times; they do not restore superseded policy, ownership, permissions or acceptance. Current work starts from the sole build ledger.

The read-only observer for `https://ai.ubq.fi` uses protected `SENTINEL_GATEWAY_AUTH_JSON` and `SENTINEL_REPLAY_KEY_B64` capabilities. It stores bounded encrypted captures and non-plaintext manifests, with one-day artifact retention; it receives no repair, model, state-write, replay-execution or deployment capability. The replay key is exactly 32 bytes represented as hexadecimal or standard/base64url text. The gateway-auth secret is a JSON object of header names/values. Keep both values out of Git, issues, PRs, artifact names and logs.

Generic target policies protect `.env*` basenames at any directory depth, except the exact template names `.env.example`, `.env.sample` and `.env.template`. These templates remain repairable unless explicitly covered by a protected path (including entries in the target's `sentinel.protected` list or a protected parent directory). Other `.env*` names, such as `.env.example.local`, stay protected. Named target policies are unchanged.

Local validation exercises real production consumers with fake external services and no paid/model calls or deployments. Use focused named checks with the 300-second bounds in AGENTS.md; whole-repository sweeps require a separate explicit request.
