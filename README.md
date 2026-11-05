# Sentinel

Sentinel repairs eligible GitHub issues with isolated concurrent workers, durable candidate/accounting state, current-head structured review and trusted integration/release controllers. Current targets are `ubiquity-sentinel/sentinel`, `ubiquity/ai.ubq.fi` and `ubiquity/passport.ubq.fi`; AI and Passport are limited to issue repairs for now. Passport is a private target, so its target state, evidence and logs are subject to this public controller's visibility. Captured-incident and deployment activation remain separate scope. The implementation uses Deno and TypeScript; runtime workers cannot access credential, state or promotion authority.

Start with [the current master plan](MASTER-PLAN.md), [project instructions](AGENTS.md) and [owner decisions](docs/DECISIONS.md). [The build ledger](docs/build-status.md) is the sole source of current task ownership and acceptance; [the active memory plan](docs/sentinel-memory-plan.md) covers durable attempt memory and self-healing. Historical plans and receipts remain available in Git history.

The public repository is [ubiquity-sentinel/sentinel](https://github.com/ubiquity-sentinel/sentinel). A five-minute scheduled dispatcher invokes the protected supervisor; explicit trusted-host dispatch and receipt inspection remain available through the installed `sentinel` CLI:

```sh
sentinel status
sentinel run observe
sentinel run supervisor
sentinel receipts <run-id>
sentinel report --since 2026-11-01 [--until 2026-11-07]
```

`sentinel report` is a read-only throughput readback: it fetches the `sentinel-state/metrics` ref (per-cycle metrics and daily rollups) and the repair state snapshot through their existing readers, writes nothing, and prints plain tables for an inclusive UTC window of at most 92 days: cycles, merges, refresh commits and target CI runs per merge, and model duty cycle (matrix cell minutes / controller minutes) per day; the planner refusal histogram; merges per day by repository; and the current delivery-queue depth, blocked-cause histogram and longest-waiting live records. A value the data does not record prints `n/a (not recorded)`, never zero. It needs only `--allow-run=git --allow-env=PATH --allow-read=<scratch> --allow-write=<scratch>` (scratch defaults to `/tmp`; `--remote <url-or-path>` selects another state remote) and refuses rather than prompts when a grant is missing.

The report ends with a Thresholds table: the throughput watchdog's own evaluation (`src/host/throughput-watchdog.ts`, limits in `src/host/throughput-watchdog-thresholds.ts`) printing `met`, `missed` or `insufficient_data` per #340 threshold. Finalize runs the same evaluation every cycle and, for a missed threshold, files at most one `priority:2` issue per cycle on this repository (second body line `<!-- sentinel:throughput-watchdog:<id> -->`) for Sentinel to repair like any other issue: never while a watchdog issue or a pull request referencing one is open, not again within 7 days of its issue closing, and edited only when the measured number moves by more than 10%. The repository variable `SENTINEL_SELF_IMPROVE` (default `on`) set to `off` stops the watchdog; review, CI, P0, accounting and auto-follow gates are unchanged.

The 2026-10-20 owner grant authorizes the orchestrator's hosted workflow control, direct development pushes, launcher/runtime/state updates and gated autonomous merges for this effort without repeated approval. The default per-attempt boundary remains for future efforts without equivalent authorization; see the [hosted approval boundary](AGENTS.md#hosted-approval-boundary). Worker assignments retain their narrower permissions.

Runtime updates use exact CI-green launcher self-install and dispatcher auto-follow, whose source default is on; an explicit repository override can hold it off and workflow changes require a manual advance. Documented implementation policy, source defaults, hosted configuration and actual routes are distinguished in [owner decisions](docs/DECISIONS.md#runtime-model-policy-and-trusted-route-configuration). Autonomous PRs require completed current-head native Codex review, positive task acceptance and current CI. P0 is the only severity-based merge blocker; P1 and lower findings remain receipt-bound issue follow-ups. Acceptance is green scheduled cycles plus an issue → PR → native review → merge per target; `sentinel-release` stays disabled.

[Shared contracts](docs/contracts.md) define records, ports, producer/consumer wire shapes and evidence custody. [The activation checklist](docs/activation-checklist.md) preserves target ownership, current VPS release boundaries and required live proofs. [Reviewer alignment](docs/codex-review-rubric-alignment-2026-10-08.md) identifies the historical vendored rubric pin and the current native-review path. [Source adaptation pins](docs/third-party-reuse.md) and [license notices](THIRD_PARTY_NOTICES.md) cover reused components.

Dated handoff packets, redesign and specification snapshots, and retained review artifacts preserve their original source and times; they do not restore superseded policy, ownership, permissions or acceptance. Current work starts from the sole build ledger.

The read-only observer for `https://ai.ubq.fi` uses protected `SENTINEL_GATEWAY_AUTH_JSON` and `SENTINEL_REPLAY_KEY_B64` capabilities. It stores bounded encrypted captures and non-plaintext manifests, with one-day artifact retention; it receives no repair, model, state-write, replay-execution or deployment capability. The replay key is exactly 32 bytes represented as hexadecimal or standard/base64url text. The gateway-auth secret is a JSON object of header names/values. Keep both values out of Git, issues, PRs, artifact names and logs.

Local validation exercises real production consumers with fake external services and no paid/model calls or deployments. Use focused named checks with the 300-second bounds in AGENTS.md; whole-repository sweeps require a separate explicit request.
