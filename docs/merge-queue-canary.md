# Owner-run merge queue canary

`queue-canary.yml` is a manual, separate trusted host. It does not run models,
write repair/release state, install runtimes, or produce production delivery
proof. All target effects are fixed to `ubiquity/ai.ubq.fi` PRs based on
`queue-canary`; there is no production branch override.

Fixture heads use `queue-canary-fixtures/` to avoid a Git ref conflict.

The source allowlist in `ops/queue-canary-pins.ts` is empty. No workflow input
can add a PR or raise permissions. Before adding a source grant, the owner
approves the runtime App's Merge queues permission, the canary ruleset and
fixtures, then the exact PR/node-ID/head, reviewed base, native App actor,
workflow ID/bytes and effective-rule digest. Code/source review precedes
publishing this grant. The entrypoint and its source grants require their own
review after the combined queue implementation review.

The existing pinned App-token action uses App ID 4682172 and the existing
`SENTINEL_SUPERVISOR_APP_PRIVATE_KEY` secret. The minted token is scoped to
`ai.ubq.fi` only. The CLI verifies the action's App slug and installation output
against the runtime installation, the authenticated installation-only repository
endpoint, and native Bot node identity. App ID authority comes from the pinned
mint action and existing key; there is no dependency on public App metadata
availability. A user PAT is refused; no `viewer` heuristic is used. The separate
`GITHUB_TOKEN` has Actions read for the current Sentinel workflow's replay
checks and prior-artifact metadata.

Run only the exact reviewed SHA on `sentinel-supervisor`. The workflow checks
repository, ref, event, source SHA and workflow SHA before minting credentials;
the CLI repeats those checks. Its process has a 290-second timeout plus at most
five seconds teardown, a 285-second internal network deadline, no subprocess
permission and network access only to `api.github.com`.

## One-shot authority

Each grant's stable binding is:

```ts
canonicalStringifySha256({
  domain: "sentinel.queue-canary-binding.v1",
  repository: "ubiquity/ai.ubq.fi",
  pullRequest: exactPrNumber,
  head: exactReviewedHead,
});
```

The workflow run name binds action and this digest. Before either mutation, a
complete authenticated Actions listing must show exactly this one dispatch for
the action/binding, with attempt one and exact current source. Failed or
cancelled earlier dispatches consume authority too. Source changes, caller
nonces, renamed branches or a repeated workflow dispatch cannot reset the same
PR/head binding. Concurrency prevents two jobs executing at once. Missing,
truncated, drifted or unavailable history refuses mutation. Do not delete canary
run history or reinterpret missing history as a new grant.

An ambiguous response is recorded and never automatically retried. `observe`
performs fresh read-only reconciliation. An explicit source-reviewed new head or
different canary PR is needed for another enqueue scenario; old native queue
events on the same grant also refuse initial enqueue. No polling error, 24-hour
async-result expiry, or elapsed time is retry permission.

`dequeue` additionally requires a source-reviewed prior enqueue observation:
exact run/source/request digest, artifact ID and SHA-256, and native entry ID.
Authenticated artifact metadata must bind that same enqueue request; fresh
membership must name the same PR/head/entry and exact App actor. The prior
artifact digest represents a manually reviewed native observation; the CLI does
not download or execute artifact contents. Foreign entries are never dequeued.

## Dispatch and evidence

Prepare a JSON file after source approval, with `action`, `binding_digest`, and
`expected_source_sha`. Actions are `preflight`, `enqueue`, `observe`, and
`dequeue`; runtime input only selects a source grant. Owner dispatch:

```bash
timeout -k 5 295 gh workflow run queue-canary.yml \
  --repo ubiquity-sentinel/sentinel --ref sentinel-supervisor --json \
  < /workspace/evidence/merge-queue/accepted-canary-dispatch.json
```

With the empty allowlist, preflight can capture verified installation identity
but reports `source_grant_missing` and performs no target effect. A
SHA-256-shaped binding input is still required. This refusal is not a failed
queue canary.

The artifact name is
`queue-canary-<run-id>-<attempt>-<canonical-request-digest>`. It contains the
exact operation request, actor identity, complete native queue/membership/event
reads, current workflow/rule facts, head checks, and any available merged
commit/tree/ancestry/group-run observations. Intent is written before the sole
effect, so the upload step can retain an ambiguous outcome after child failure.
The artifact explicitly states `productionDeliveryProof: false`.

Incomplete `preflight` or `observe` reads retain sanitized evidence with
`status: refused`, `reason: observation_unavailable`, and a nonzero CLI exit.
Only complete applicable native reads produce `observed` and exit zero. An
observed red check or rejected configuration remains a complete observation;
`observed` is not permission to enqueue or proof of delivery.

Free-text API errors are never logged. Unsafe text is explicitly omitted from
the sanitized artifact; such a field cannot become an accepted native reason
pin. No credential, private key, raw response body or target code is executed by
this job. An unknown removal reason or unmeasured `beforeCommit` semantics stays
unaccepted until reviewed evidence establishes it.

Use the owner packet at `/workspace/evidence/merge-queue/canary-owner-packet.md`
for success/failure scenarios and the complete evidence inventory. This minimal
entrypoint captures facts; independent canary acceptance and source pinning
remain required. It does not create rulesets, enable the development queue,
bypass rules, close PRs, delete branches, or enable `sentinel-release`.
