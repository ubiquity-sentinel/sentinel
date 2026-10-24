# Sentinel

Sentinel repairs eligible GitHub issues with isolated concurrent workers, durable candidate/accounting state, current-head structured review and trusted integration/release controllers. Current targets are `ubiquity-sentinel/sentinel`, `ubiquity/ai.ubq.fi` and `ubiquity/passport.ubq.fi`; AI and Passport are limited to issue repairs for now. Passport is a private target, so its target state, evidence and logs are subject to this public controller's visibility. Captured-incident and deployment activation remain separate scope. The implementation uses Deno and TypeScript; runtime workers cannot access credential, state or promotion authority.

Start with [the current master plan](MASTER-PLAN.md), [project instructions](AGENTS.md) and [owner decisions](docs/DECISIONS.md). [The build ledger](docs/build-status.md) is the sole source of current task ownership and acceptance; [the active memory plan](docs/sentinel-memory-plan.md) covers durable attempt memory and self-healing. Historical plans and receipts remain available in Git history.

The public repository is [ubiquity-sentinel/sentinel](https://github.com/ubiquity-sentinel/sentinel). A five-minute scheduled dispatcher invokes the protected supervisor; explicit trusted-host dispatch and receipt inspection remain available through the installed `sentinel` CLI:

```sh
sentinel status
sentinel run observe
sentinel run supervisor
sentinel receipts <run-id>
```

The 2026-10-20 owner grant authorizes the orchestrator's hosted workflow control, direct development pushes, launcher/runtime/state updates and gated autonomous merges for this effort without repeated approval. The default per-attempt boundary remains for future efforts without equivalent authorization; see the [hosted approval boundary](AGENTS.md#hosted-approval-boundary). Worker assignments retain their narrower permissions.

Runtime updates use exact CI-green launcher self-install and dispatcher auto-follow; `SENTINEL_AUTO_FOLLOW` defaults on since the 2026-10-24 owner directive; the repository variable set to `off` disables it. Runtime implementation uses `gpt-reserve` with `gpt-6-luna` fallback; autonomous PRs require current CI and completed gateway `codex-auto-review` structured review with no unresolved P0/P1. Acceptance is green scheduled cycles plus at least one issue → PR → review → merge per target. Source changes, bootstrap health and opened PRs alone do not establish that result; `sentinel-release` stays disabled.

[Shared contracts](docs/contracts.md) define records, ports, producer/consumer wire shapes and evidence custody. [The activation checklist](docs/activation-checklist.md) preserves target ownership, current VPS release boundaries and required live proofs. [Reviewer alignment](docs/codex-review-rubric-alignment-2026-10-08.md) identifies the vendored upstream rubric and strict harness schema. [Source adaptation pins](docs/third-party-reuse.md) and [license notices](THIRD_PARTY_NOTICES.md) cover reused components.

The read-only observer for `https://ai.ubq.fi` uses protected `SENTINEL_GATEWAY_AUTH_JSON` and `SENTINEL_REPLAY_KEY_B64` capabilities. It stores bounded encrypted captures and non-plaintext manifests, with one-day artifact retention; it receives no repair, model, state-write, replay-execution or deployment capability. The replay key is exactly 32 bytes represented as hexadecimal or standard/base64url text. The gateway-auth secret is a JSON object of header names/values. Keep both values out of Git, issues, PRs, artifact names and logs.

Local validation exercises real production consumers with fake external services and no paid/model calls or deployments. Use focused named checks with the 300-second bounds in AGENTS.md; whole-repository sweeps require a separate explicit request.
