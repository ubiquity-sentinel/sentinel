# Sentinel merge queue: owner action packet

Prepared 2026-10-18 for `ubiquity/sentinel#164`. **Production activation is not ready.** The queue implementation was accepted at [`2b32bdbd449cbc615c239af40474941cefcb0c55`](https://github.com/ubiquity/sentinel/commit/2b32bdbd449cbc615c239af40474941cefcb0c55), tree `95db9ee1ac2b850cc70e28923548722a7fdac008`. The independently audited input tree is `7d16f08bf97802e6206965481b9e67e925feb78c`; the publication receipt proves the post-review delta changes only the acceptance ledger. Exact push CI [39117211579](https://github.com/ubiquity/sentinel/actions/runs/39117211579), attempt 1, passed and is accepted from its retained exact-input terminal receipt. The native harness passed 3,218 tests and 1,298 steps with zero failures; all ten cases from the prior failed run now pass. Earlier `de496e6d3c71cb4794153e4876e51f1da2acf2df` CI39108047074 failed. Candidate `433305649937fab57a11e33a70aef0178061ea48` CI39113299822 also failed; neither failed run can satisfy acceptance. The queue remains disabled, all canary grants and capability/migration/witness pins remain empty, and no queue runtime is installed. Current Sentinel development is [`9b7c3e5cec4d45c4e0985ab28bd524b4bb69237b`](https://github.com/ubiquity/sentinel/commit/9b7c3e5cec4d45c4e0985ab28bd524b4bb69237b), tree `52168e7686dd1a07dcefd8cb354e8a1b3e4d150d`, after the normal merge of the existing PR160. Its ordered parents are the accepted queue base `2b32bdbd449cbc615c239af40474941cefcb0c55` and reviewed PR head `21384b8a9c4b80278f1e613096a7d2e3d3c3eadf`. The resulting tree equals tested carrier `60b80fde43f88a9dafdb09ae3e8f6dd1c8a52659`: [PR CI39117497198](https://github.com/ubiquity/sentinel/actions/runs/39117497198) passed 3,225 tests / 1,305 steps and all 32 required cases before the current-head assessment found no findings. This PR proof is distinct from the queue-base push proof above. No accepted postmerge-push CI is claimed for `9b7c3e5c`; the trusted canary S/S2 source still requires its own exact review, CI and supervisor promotion before dispatch. The retained original branch and historical repair-state identity were not rewritten. No issue157 closure claim is made here.

Runtime R81 `da98f5f49c45b57cfa97a45fe647c36b1021f302` is installed at generation81. The retained root acceptance for ordinary supervisor [run39114941481](https://github.com/ubiquity/sentinel/actions/runs/39114941481) verifies 16 agreement gates, 21 successful native jobs and 16 successful matrix jobs. The launcher remains L81 `00b6649eeff51a9754bf3748f793137db9bf8605` at that observation. This establishes runtime health; it does not establish autonomous delivery. Fresh refs/health/rules remain a trusted publication boundary. This packet has created no fixtures, rulesets or queue effects; the owner-reserved canary has not been requested or authorized.

Target workflow prerequisite [ai.ubq.fi PR1207](https://github.com/ubiquity/ai.ubq.fi/pull/1207): head `1ade164ef78e7fa919ec5a502a6f3c42864e790c`, tree `d7959c13e3546fc39a1f519c3cb22509510ff717`, exact [CI39114035828](https://github.com/ubiquity/ai.ubq.fi/actions/runs/39114035828) attempt 1, checkout carrier `65e9ff8ed8424cc26d0a8fe31c1213eb0f7b25bf` over `6414f35c46b90e9e4d9ed6efe13ad86d96d60aae`. The retained receipt proves all seven real checks succeeded; current-head review followed CI. The SHA-pinned normal merge is `730218b0c89d479b141c4a2fa17ad5ee363f161a`; the accepted merged workflow baseline is `730218b0c89d479b141c4a2fa17ad5ee363f161a`, tree `d7959c13e3546fc39a1f519c3cb22509510ff717`. The final applicability receipt binds each of the nine unchanged documentation patches and their union to that accepted tree, preserves every original mode/blob entry, and proves exact negative/inverse restoration. Its exact development push [CI39116165207](https://github.com/ubiquity/ai.ubq.fi/actions/runs/39116165207) also passed all seven jobs. Fresh native development is `984aa8a63183d60a15036321d2dc7aefd8e5d1b3`, tree `7218790ddaf4837c5cdc40243883a72402c49f11`, which is the proposed fixture starting point. Its delta from the accepted workflow merge changes only `src/catalog/index.ts` and `tests/openrouter-catalog.test.ts` (the normal merge of existing PR1101). The new structural fixture proof preserves every original entry at this exact newer tree and proves the same negative/inverse restoration. Workflow, selector and runner/wrapper sources are byte-identical, so the 18 selector observations and ordinary-owner control are reused by hash. The accepted push-CI receipt remains bound to `730218b0`; no passing push CI is claimed for the newer fixture baseline. Baseline/restoration workflow SHA-256 is `20754408dfdeb02d36bb050bb132e737f2c1a6a1d53f45796ec3e2d864cae0ac`; the separately scoped missing-trigger variant is `c27de8bf57c612a77214a159a22b854c4dd77afcea1349c68cf5204c18596c9e`. These byte identities are not production pins. Native workflow identity/active state, current refs/PR inventory, operator assignment and actual first-PR-open state must be observed at their execution boundaries. See [final preparation](canary-final-preparation/README.md). The [current nine-fixture plan](canary-final-preparation/final-fixture-plan.json) binds the unchanged document patches to that proposed baseline while retaining null native identities and empty grants. Native read-only observations at 2026-10-18T10:46:03.228321+00:00 confirmed active workflow215764630 with those exact bytes, no matching canary refs or existing canary PRs, no AI repository/inherited rulesets or effective development/canary rules, and automatic branch deletion disabled. The authenticated operator is `0x4007`, with admin role in both repositories; Sentinel #164 remains open, assigned to that account and labeled `sentinel:skip`. These are finite observations to recheck before creation. App-authenticated scope and first-fixture-open behavior remain execution-time evidence, not claims established by owner credentials.

The current concrete canary proposal is the corrected **nine-fixture** plan in
[sequencing-addendum/README.md](canary-fixture-preparation/sequencing-addendum/README.md),
manifest `3204c6351bcd6aa69cb27547b56f865fac58d56c19f98b3679c44204f6227b63`.
It supersedes the earlier eight-fixture outline: three final successful PRs,
one cancellation, App dequeue, head update/foreign entry, rule removal,
no-rule refusal and missing-trigger timeout. The App-dequeue phase uses a
separately pinned finite min2/wait360 window with exactly one entry. The
missing-trigger phase changes only the isolated canary branch, uses a separate
five-minute timeout, and restores the exact original workflow bytes before the
success burst. Baseline projection and production rule bodies remain unchanged.
Native evidence, observed entry deadlines and source-reviewed grants remain
mandatory; these prepared files do not authorize execution.

Fixture ownership is prepared separately in
[ownership-preparation/proposal.md](canary-fixture-preparation/sequencing-addendum/ownership-preparation/proposal.md).
The operator is `0x4007`; existing open tracking issue #164 is already assigned
to that account. No new tracking issue or repeated assignment is proposed.
Native identity, roles, assignment and existing matching PRs are rechecked
before creation, and the first fixture must remain open before continuing.
Bot authentication alone is not treated as an exemption. Existing eligible
fixture PRs will be reused; no replacement PR is created on a closure race.

The completed base-run continuity evidence is
[postmerge continuity](../ci-base-runs/postmerge-continuity/20261018T072121Z/README.md):
three genuine development push revisions (`624466337`, `6eea5d81c`, `cedc71df2`)
each have all four native jobs/checks green on attempt 1. No cancellation was
observed. This proves those push runs only; merge-group concurrency and queue
behavior remain native canary assertions.

## The three reserved owner steps

1. **Runtime App permission — owner confirmed granted and accepted.** Native
   App-authenticated verification remains pending; do not repeat the permission
   request. The exact setting is retained here for reference. In
   [GitHub App settings](https://github.com/settings/apps) (or the
   organization's App settings if it owns the App), grant **Merge queues: Read
   and write** to `ubiquity-sentinel`, App **4682172**. Accept the permission
   update on
   [installation 155687488](https://github.com/organizations/ubiquity/settings/installations/155687488).
   This is separate from the restored ChatGPT connector. No token or key needs
   to be sent to anyone.
2. **Canary on `queue-canary`.** After reviewed source publication, use the
   [manual canary workflow](https://github.com/ubiquity/sentinel/actions/workflows/queue-canary.yml)
   with the supplied exact source SHA and source-reviewed PR/head binding.
   Approve the concrete branch-only fixtures and ruleset, first disabled, then
   activate that same canary object to collect native disabled→active evidence.
   Complete success/failure/removal scenarios; preserve run history and use
   read-only observation after ambiguity. Development remains unchanged.
3. **Production ruleset, staged disabled.** After the canary, create the
   supplied development-only body in
   [ai.ubq.fi rulesets](https://github.com/ubiquity/ai.ubq.fi/settings/rules)
   with **enforcement disabled**. Its observed IDs and native canary mapping
   must yield a source-reviewed expected active digest. The coordinator installs
   and verifies proof-active, enqueue-off fallback **F**, then enqueue-capable
   **A** with that same digest and exact healthy F fallback. After the
   coordinator verifies the wired selector on while rules remain disabled,
   activate that exact production ruleset.

Before asking the owner to authorize the isolated canary, the coordinator
supplies the published reviewed source SHA, concrete fixture diffs, disabled
ruleset bodies and bounded execution plan. The owner-reserved canary scope
includes fixture creation and hosted execution. After approval, before each
actual dispatch, the coordinator supplies and verifies the resulting native
PR/head grants, exact source and run commands; absent native identities are
never placeholders in a live grant. Production activation additionally needs the native projection,
expected digest, installed F/A/launcher pins and F health proof. **The production parser intentionally omits conditions; the separate pure
projection compiler is accepted locally, but no native profile or production
expected digest is accepted.** Selector
and exact runtime-capability wiring are implemented and audited at `3c51706f`;
future accepted revision/migration pins remain empty. Projection and native
acceptance are blockers, not values for the owner to guess. If projection cannot be proved,
leave production disabled; there is no enable-then-pin fallback.

No ruleset or branch protection is allowed on `ubiquity/sentinel`.
`sentinel-release` stays disabled. These remain the three owner-reserved steps;
the permission step is recorded in `owner-app-permission.json`, and this packet
does not request the remaining execution steps yet. Normal source review and CI
remain the existing user requirements.

<details>
<summary>Technical evidence, exact canary scenarios, bounded commands and rollout sequence</summary>

## Scope and source of truth

- Original design: `/workspace/handoff/handoff/2026-10-18/research/design.md`.
- Adversarial critique:
  `/workspace/handoff/handoff/2026-10-18/research/critique.md`.
- Corrected implementation proposal:
  `/workspace/evidence/merge-queue/implementation-design.md`.
- Root source: `/workspace/worktrees/merge-queue-consumers`. The corrected
  canary and activation-boundary corrections are integrated at
  `3c51706f73bfe793068abccb8de3f92457d1d233`.
- Installation/fallback plan: `/workspace/evidence/merge-queue/install-plan.md`,
  especially the projection gate and preferred source-publication → F → A sequence
  (an initial dormant D runtime install is optional).
- Activation boundary audit: `activation-audit/report.json` and `report.md`;
  PASS for dormant source preparation, no P0/P1 findings. This is not native
  activation or installed-runtime acceptance.
- Projection proposal and prepared bodies: `projection-preparation/contract.md`;
  previous packet/plan hashes: `projection-preparation/prior-evidence.json`.
- Canary review: `canary-audit/report.md` and
  `canary-audit/correction-addendum.md`; both pass without P0/P1 findings.
  Integration validation reported 25 tests / 63 steps plus static checks.
- Orchestration source: `/workspace/worktrees/merge-queue-orchestration`; frozen
  file hashes: `orchestration-files.json` in this directory.
- Native boundary handoff: `native-guards/manifest.json` and
  `native-guards/report.json` in this directory.
- Consumer handoff:
  `/workspace/evidence/merge-queue-delivery-consumers/report.json`.
- Schema observation: `github-schema-event-descriptions.json` in this directory.
- Original packet source snapshot: `canary-source-observation.json` in this
  directory; corrected-source reconciliation:
  `canary-source-reconciliation.json`.
- Prepared canary handoff: `canary-runner/manifest.json`,
  `canary-runner/report.md`, and `canary-runner/owned.patch` in this directory.

These are local preparation inputs. Their independent checks do not constitute
combined source acceptance, installed runtime acceptance, or a successful live
canary. The primary integration owner alone updates `docs/build-status.md` and
assigns the final reviewed commit, tree, runtime, launcher, and fallback pins.

The corrected requirements take precedence over the original design's expired
17-minute marker, legacy-first proof, launcher-only activation, and automatic
retry suggestions. The user additionally requires owner approval for the App
grant, canary, and ruleset. No ruleset or branch protection may be added to
`ubiquity/sentinel`. No target PR is closed and no target branch is deleted by
this packet. No force-push or manual state edit is part of the procedure.

## App identity and credential boundary

No private key or token is requested from the owner. Tokens are minted by the
existing protected host machinery, remain in that job, and are never included in
an artifact, command line, model input, log, or this packet. The canary runner
must not use shell tracing or print authentication headers. `sentinel-release`
stays disabled for the entire rollout.

App identity is bound by the pinned mint action with hardcoded App ID 4682172
and the existing key, checked slug/installation outputs, the
installation-token-only repository scope endpoint, and the source-pinned native
Bot identity. The canary does not depend on public `/apps/ubiquity-sentinel`
metadata. A 404 observed with a different connector identity establishes neither
runtime App failure nor runtime permission; no live mint was performed for local
preparation.

## Readiness and explicit activation prerequisites

| Current preparation                                                                                                                                                                      | What must exist before production activation                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The corrected canary source and review addendum are accepted locally; source grants remain empty.                                                                                        | Healthy installed R81, accepted source publication preserving the installed runtime pointer, and owner-authorized exact canary grants/scenarios.                                                                             |
| Workflow hashes, actors, removal meanings and historical witness pins remain unmeasured or empty.                                                                                        | The complete accepted native packet below; no guessed reason strings, actor IDs or workflow/rule hashes.                                                                                                                     |
| Production workflow bytes and typed effective rules are checked continuously; mutation bypass is false. Active-workflow and App-specific bypass metadata remain owner canary assertions. | Retain complete current metadata, conditions and App no-bypass evidence. A disabled workflow cannot supply successful exact-M CI proof. Do not claim additional continuous metadata coverage.                                |
| The pure disabled-to-active projection compiler is locally reviewed; native capture wiring/profile and the production expectation are not yet accepted.                                                                               | Complete raw conditions/identity/default/inheritance/bypass evidence, a native-tested projection, and the source-reviewed expected **production active** digest, all before installing F/A and before enabling development.  |
| The initially dark runtime D has mode off, proof false and empty pins. It can hold custody but is not an accepted drain fallback.                                                        | Exact F with proof true, mode off, accepted pins, and its own healthy proof; A must retain that exact F as fallback.                                                                                                         |
| The lower-only selector and exact runtime-capability guards are implemented and independently audited at `3c51706f`; source remains off/false and capability/migration pins are empty. | After native acceptance, pin exact F/A revisions and the first owner-only migration tuple; retain all execution/pointer/rollback guards and prove installed F health. Local source acceptance is not activation. |

Earlier predecessor/exact-M workflow and combined custody/removal findings have
separate source corrections and review evidence. Use the final integrated
candidate receipts rather than stale observations from this packet. The
activation prerequisites above remain explicit; none is established by a local
canary test or by this document.

## Exact acceptance manifest

Keep restricted raw observations outside public Git. The accepted sanitized
manifest lists the SHA-256 and origin of each retained native response. Hash the
manifest with the reviewed canonical JSON implementation, excluding only its own
digest field. A digest asserts byte identity; it is not permission to trust an
otherwise unsupported fact.

The packet must identify:

| Evidence              | Required binding and completeness                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code/runtime identity | Reviewed Sentinel source SHA and tree; actual workflow SHA/ref; canary runner file hash; installed runtime generation/revision; launcher SHA; exact queue-aware fallback revision and proven controller behavior; accepted combined review and CI receipts.                                                                                                                                                               |
| App identity          | Runtime App ID and slug, actual installation ID, target repository ID and name, mint action SHA, and authenticated native actor tuple `{nodeId, login, type}`. Expected login is `ubiquity-sentinel[bot]`, expected type `Bot`; node ID must be observed, not constructed from the App ID. Retain mint provenance without its token.                                                                                      |
| Merging actors        | Exact native REST/GraphQL `merged_by` / `mergedBy` tuples for successful App enqueues, and the actors on corresponding merged-removal events. Accept only finite observed tuples; a familiar login alone is not authority.                                                                                                                                                                                                |
| Workflow              | Canonical Actions workflow numeric ID, exact path `.github/workflows/deno-deploy.yml`, active state, full Git blob bytes and SHA-256, blob object ID, exact source revisions at which read. Preserve the same accepted bytes at successful canary base/head and eventual production admission. Negative canary variants have separate hashes and are never substituted for this pin.                                      |
| Rules                 | Every effective repository and organization rule, exhausted pages, source and ruleset IDs, exact parameters, branch condition, full applicable rulesets, bypass actors and App-specific bypass result. Keep the raw readbacks and the typed, sorted canonical branch-rule array used by `effectiveRulesSha256`. Also retain bypass/conditions metadata that this array does not cover.                                    |
| Queue scan            | Complete repeated stable branch-tip/queue scans, pagination cursors, queue ID, every entry's ID/position/state, enqueuer tuple, timestamps, pull identity with `headRefOid`, and native `baseCommit`/`headCommit` separately. Never equate a queue-entry head with H or M without measuring it.                                                                                                                           |
| Admission             | Exact allowlisted PR and reviewed head H; request body, method/path, sanitized status/body, operation UUID when supplied, authenticated membership observation, and matching entry ID. A 200/202/409 response is only a submission hint; it is not membership or proof of a merge.                                                                                                                                        |
| Events                | Complete `AddedToMergeQueueEvent` and `RemovedFromMergeQueueEvent` connections for each PR; event node IDs, actor tuples, times, `beforeCommit.oid`, exact reason including null, and final PR/queue rereads. Persist the observed native entry before it disappears. An added event has no native entry ID and cannot replace that observation.                                                                          |
| Review/task           | Exact record, repository installation scope, source issue/task digest, current opt-out state, latest authorizing review request and receipt IDs, original receipt B/H, current target B/H, and the normal semantic acceptance result. A synthetic canary observation is not a production review receipt.                                                                                                                  |
| Merge/tree            | Native merged PR's exact M; full ordered parents `[P,H]`; native commit author tuple; B ancestor-or-equal to P; M reachable from the actual base branch; complete recursive trees, including symlink/submodule modes; `Δ(B,H) == Δ(P,M)` by path, old/new mode, and full old/new blob ID. No rename folding, truncated tree, or textual/patch-ID approximation. Carried receipts also require exact `Δ(B0,H0) == Δ(B,H)`. |
| Actions evidence      | Complete canonical workflow `event=merge_group`, exact `head_sha=M` run listing; latest `run_attempt` for every matching run, current metadata, exact attempt jobs, suite ID and check-run IDs; all four required checks complete with conclusion `success`, app ID 15368, suite and head identity matching M. Missing, cancelled, skipped, neutral, action-required, partial, or stale-attempt evidence is not success.  |
| Production custody    | Ordinary trusted CAS/write-readback receipt for the non-expiring hold and exact queue intent before enqueue; actual native entry observation before saving `resultId`; later branded queue proof, release request, retained ancestor provenance reference, and unchanged charges/reservations. This is observed from real runtime operations after activation, never hand-written into state.                             |

The four exact check names are `validate`, `verify-artifact`, `darwin-native`,
and `mac-containment`. The proposed compatibility workflow also runs real
`scope`, `docs` and `native` jobs for queue-canary PRs and merge groups; the
strict reader requires every returned check to succeed as well as the original
four. Skipped or neutral checks cannot satisfy it. Job admission retains
changed-path test selection, so identical check names do not imply identical
test-file coverage or a full-suite run. A successful push or PR run on the same SHA does not
substitute for a `merge_group` run. A run on a later group tip does not prove an
earlier M. Record observed frontend capacity and queue latency; historical
validate runs took about 21–22 minutes and supervisor passes were sometimes
32–66 minutes apart. Do not promise five-minute custody refresh or a 25-minute
delivery bound.

The reviewed source pins to populate only after accepted observations are:

```json
{
  "QUEUE_PROOF_POLICY": {
    "canaryDigest": null,
    "appActor": null,
    "mergedActors": [],
    "workflowId": null,
    "workflowSha256": null,
    "mergedRemovalReasons": [],
    "mergedRemovalBeforeCommit": null,
    "historicalDirectManifestDigest": null,
    "historicalDirectWitnesses": []
  },
  "QUEUE_AUTHORITY_PINS": {
    "effectiveRulesSha256": null,
    "removalBeforeCommit": null,
    "ciFailureRemovalReasons": [],
    "timeoutRemovalReasons": [],
    "otherRemovalReasons": [],
    "removalActors": []
  }
}
```

This is an incomplete manifest template, not a valid TypeScript policy value or
a deployable configuration. `mergedRemovalBeforeCommit` may become `pull_head`
or `merged_revision` only if the successful native canary establishes it. The
current failure-classification code only supports
`removalBeforeCommit:
"pull_head"`; another observed meaning is a
source-change/review gate. Failure reason sets must be finite, nonempty for CI
failure and timeout, disjoint, bounded, and exact. Null or an unknown string
means unavailable classification and retained custody. Never print raw reason
text in owner summary action lines.

## Canary runner contract and bounded operator commands

The published dormant source contains `.github/workflows/queue-canary.yml`
and `ops/queue-canary*.ts` implementing the following contract. Development
publication and local evidence do not establish trusted-ref publication or a
successful live canary:

- Use the existing pinned App-token mint action and verify App/install/target
  identity. Set target scope to `ai.ubq.fi` only; contain all credentials in the
  trusted job and keep model workers out of the canary.
- Check out an exact reviewed Sentinel SHA; a mutable branch name alone does not
  identify the canary. Authenticate the actual workflow SHA and code SHA.
- Accept only source-reviewed PR/node-ID/head grants for `queue-canary`.
  Scenario-specific workflow/rule hashes and expected rule presence are part of
  each grant. Refuse `development`, other repositories, unexpected heads, or
  non-allowlisted PRs before any effect. Reject fork credential execution.
- Provide a no-effect preflight that proves the allowlist, App identity,
  complete queue reads, rule/config identities, and workflow identity before
  submission.
- Send exactly `merge_action: "merge_queue"`, exact `sha: H`, and
  `bypass_rules: false`. Never use `default` or direct-merge fallback. Do not
  silently switch to GraphQL enqueue after an ambiguous REST result.
- Keep submission and read-only resume separate. Persist sanitized operation
  UUID/native observations in run artifacts; resume polls/reconciles them and
  never re-sends because a command timed out or a response was lost. This
  experimental artifact is separate from authoritative repair state.
- Bound every local command/process group at 300 seconds. The workflow child
  uses 290 seconds plus five seconds teardown; operator commands below use 295
  seconds plus five seconds teardown. End an observation slice while CI is
  pending and resume from its receipt in another bounded call. Do not hold a
  terminal `watch` or sleep loop open for the 20+ minute CI cycle.
- Produce sanitized raw and normalized evidence, explicit page completion and
  unavailable classifications, and an accepted/rejected/unresolved verdict.
  Capture GraphQL errors even when HTTP status is 200.
- Never close PRs, delete branches, modify production state, promote a runtime,
  or enable release. No unbounded Git fetch or reading/chdir under `/tmp` in
  local checks. Use `/workspace/evidence/merge-queue/` for local evidence.

### Publish the exact trusted canary launcher before dispatch

Development-only source publication does not make the canary runnable. The
workflow, host gate, first-dispatch evidence and accepted-prior evidence all
require refs/heads/sentinel-supervisor, with GITHUB_SHA, GITHUB_WORKFLOW_SHA and
expected_source_sha identical. Current L81 has no canary workflow. Keep every
one of these source/ref checks; do not dispatch from development or override a
SHA to bypass them.

After owner approval and native fixture/rule identities are available, prepare
a normal fast-forward descendant S containing the exact reviewed grants.
Preserve R81's runtime/install rungs and route allowlists, production mode off,
proof false, empty future capability/migration/witness pins, and disabled
sentinel-release. Review the exact grant/head/rule/workflow bindings and check
S's actual launcher-to-R81 compatibility. Publish S on development, obtain
its exact native CI, and accept its current-head audit before promoting it.
Re-read expected refs, installed R81 generation/health and production rules,
then fast-forward sentinel-supervisor to that same S and verify both readbacks.
Only then dispatch with expected_source_sha=S and confirm the native workflow
uses that exact trusted source. Publishing this trusted launcher source does
not install a queue runtime or grant production admission; R81 remains the
installed runtime. Source-only authorization or an empty grant list cannot
substitute for the required native fixture grant.

The App-dequeue grant depends on the earlier native enqueue run, source,
request, artifact and exact owned entry. Build and review successor S2 with
that actual prior, repeat the exact-source CI and trusted-ref publication
sequence, and recheck the entry/deadline before dispatch. If the entry is gone
or the prior cannot be reviewed in time, the App-dequeue assertion stays
unproved and owner reconciliation follows the approved phase plan. Never
fabricate prior metadata, retry the enqueue or extend a timer by assumption.

After that trusted publication, prepare the exact dispatch JSON. Its three fields
are `action` (`preflight`, `enqueue`, `observe`, or `dequeue`),
`binding_digest`, and `expected_source_sha`. Source grants bind the fixed
repository/branch, PR/node ID/H/reviewed base, App actor, canonical workflow ID
and hash, effective rule hash, expected rule presence, and any accepted prior
entry observation. The input cannot supply or raise those authorities.

```json
{
  "action": "preflight",
  "binding_digest": "<CANONICAL_REVIEWED_PR_HEAD_BINDING_SHA256>",
  "expected_source_sha": "<EXACT_REVIEWED_PUBLISHED_SENTINEL_SHA>"
}
```

```bash
# Owner/coordinator identity: dispatch only; the reviewed job mints the App token.
timeout -k 5 295 gh workflow run queue-canary.yml \
  --repo ubiquity/sentinel --ref sentinel-supervisor \
  --json < /workspace/evidence/merge-queue/accepted-canary-dispatch.json

# One bounded read, repeated only when new evidence is expected.
timeout -k 5 295 gh run view '<EXACT_CANARY_RUN_ID>' \
  --repo ubiquity/sentinel \
  --json databaseId,headSha,event,status,conclusion,url \
  > /workspace/evidence/merge-queue/canary-run-observation.json
```

The binding digest uses canonical JSON of
`{domain:"sentinel.queue-canary-binding.v1",repository:"ubiquity/ai.ubq.fi",pullRequest:N,head:H}`.
It excludes nonce, source SHA, and branch display name. The workflow binds exact
code and workflow SHA, uses a fixed concurrency group, rejects rerun attempts,
and authenticates complete workflow dispatch history before each effect. Any
prior dispatch with the same action and binding consumes that one-shot grant,
even if failed or cancelled before its API call. Incomplete history refuses the
effect. Do not delete history or retry a timed-out enqueue; use `observe`.

With empty source grants, a valid-shaped binding preflight may capture verified
App identity but ends `source_grant_missing` with no effect. To execute a later
scenario, review a different PR or exact head and its native history. An owned
`dequeue` also requires a source-reviewed prior enqueue run/source/request
digest, artifact identity/digest, and matching native App-owned entry. The
artifact is named `queue-canary-<run-id>-<attempt>-<request-digest>`. It states
`productionDeliveryProof: false`; source-reviewed prior observations are not
repair-state or production review receipts.

Incomplete `preflight` and `observe` results retain sanitized evidence with
`status: refused`, `reason: observation_unavailable`, and nonzero CLI exit. The
collector checks completion of all applicable native reads independently from
whether their results authorize enqueue: a fully observed red check can be a
complete observation, but it cannot pass the existing enqueue gate. An
`observed` artifact is never production delivery proof.

The following GET templates are suitable for the reviewed runner's evidence
collector, or for additional owner read-only corroboration. Owner-token results
alone do not prove App permission or App effects. Fill quoted placeholders from
authenticated observations, retain every response, and never paste a token.

```bash
timeout -k 5 295 gh api \
  repos/ubiquity/ai.ubq.fi/actions/workflows/deno-deploy.yml \
  > /workspace/evidence/merge-queue/canary-workflow.json

timeout -k 5 295 gh api --paginate \
  'repos/ubiquity/ai.ubq.fi/rules/branches/queue-canary?per_page=100' \
  > /workspace/evidence/merge-queue/canary-rules.pages.jsonstream

timeout -k 5 295 gh api --paginate \
  'repos/ubiquity/ai.ubq.fi/rulesets?includes_parents=true&per_page=100' \
  > /workspace/evidence/merge-queue/canary-rulesets.pages.jsonstream

timeout -k 5 295 gh api \
  'repos/ubiquity/ai.ubq.fi/rulesets/<OBSERVED_RULESET_ID>' \
  > /workspace/evidence/merge-queue/canary-ruleset-detail.json

timeout -k 5 295 gh api \
  'repos/ubiquity/ai.ubq.fi/pulls/<ALLOWLISTED_PR_NUMBER>' \
  > /workspace/evidence/merge-queue/canary-pull.json

timeout -k 5 295 gh api \
  'repos/ubiquity/ai.ubq.fi/git/commits/<EXACT_M>' \
  > /workspace/evidence/merge-queue/canary-merge-commit.json

timeout -k 5 295 gh api --paginate \
  'repos/ubiquity/ai.ubq.fi/actions/workflows/<WORKFLOW_ID>/runs?event=merge_group&head_sha=<EXACT_M>&per_page=100' \
  > /workspace/evidence/merge-queue/canary-group-runs.pages.jsonstream

timeout -k 5 295 gh api \
  'repos/ubiquity/ai.ubq.fi/actions/runs/<EXACT_RUN_ID>' \
  > /workspace/evidence/merge-queue/canary-group-run-latest.json

timeout -k 5 295 gh api --paginate \
  'repos/ubiquity/ai.ubq.fi/actions/runs/<EXACT_RUN_ID>/attempts/<LATEST_ATTEMPT>/jobs?per_page=100' \
  > /workspace/evidence/merge-queue/canary-group-jobs.pages.jsonstream

timeout -k 5 295 gh api --paginate \
  'repos/ubiquity/ai.ubq.fi/check-suites/<EXACT_SUITE_ID>/check-runs?filter=latest&per_page=100' \
  > /workspace/evidence/merge-queue/canary-group-checks.pages.jsonstream
```

`--paginate` emits a JSON value stream; it is not a single JSON array. A nonzero
exit, missing final page, inconsistent total, duplicate identity, changed
snapshot, or API list ceiling is incomplete evidence. The collector must parse
and validate the stream rather than hash a truncated terminal display. Read
organization-source rulesets with complete source-bound details. Repository
detail GET supports `includes_parents=true`; an appropriate organization
endpoint can corroborate its source. Do not infer inheritance from names. The
initial proposed compiler profile refuses parent sources rather than guessing
organization condition semantics.

For GraphQL, use the reviewed client's complete queue and timeline readers in
the App job. A minimal event projection for inspection is below; both timeline
and queue pagination must be exhausted independently and then reread stably. Do
not substitute nullable `enqueuer: User` for the polymorphic `actor`.

```graphql
query CanaryEvents($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    pullRequest(number: $number) {
      id
      number
      baseRefName
      headRefName
      headRefOid
      isInMergeQueue
      merged
      mergeCommit { oid }
      timelineItems(
        first: 100
        after: $cursor
        itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on AddedToMergeQueueEvent {
            id
            createdAt
            actor { __typename login ... on Bot { id } ... on User { id } }
          }
          ... on RemovedFromMergeQueueEvent {
            id
            createdAt
            actor { __typename login ... on Bot { id } ... on User { id } }
            beforeCommit { oid }
            reason
          }
        }
      }
    }
  }
}
```

Supply this query and variables in a reviewed JSON input file, then one page is
read with `timeout -k 5 295 gh api graphql --input '<INPUT_JSON>'`. The runner
rejects partial `errors`, null/malformed nodes, cursor loops, unexpected actor
types, missing parent identities, and resource exhaustion. The schema confirms
that `beforeCommit` exists; its description merely says “before commit SHA” and
does not establish H/M semantics or any removal reason value.

## Canary scenario matrix

Run the ordinary success cases with the exact accepted production workflow
bytes. Negative fixtures and any temporary rule/workflow changes are confined to
the canary branch, explicitly allowlisted, and separately hashed. Return to the
accepted canary configuration before the final success/reconciliation receipt.
Keep development rule-free until its activation step.

| Scenario                                         | Exact proving observation and acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. App permission and isolation                  | App-token GraphQL reads succeed; actual native enqueue identifies the expected Bot tuple; non-allowlisted repository/branch/PR/head requests are rejected before effects. The App is not a bypass actor. A coordinator/connector enqueue is recorded separately and cannot satisfy A.                                                                                                                                                                                                  |
| B. Three disjoint successful PRs                   | All three have CI green and reviewed source; submit exact H via App. Observe and retain all three native entry IDs before disappearance. For M1/M2/M3, obtain ordered parents and full trees; require P2 = M1 and P3 = M2, exact group M run and four successful checks for each, accepted author/merger/removal actors, and complete event correspondence. Retain and independently review native ordered parents, complete recursive trees, exact-M merge_group CI, actors and entry/event correspondence alongside the actual production consumer validation. Canary evidence remains productionDeliveryProof=false; do not relabel queue-canary as development, fabricate a WorkRecord, or claim a production delivery proof. |
| C. Exact failed CI removal                       | A controlled canary-only group failure ejects the exact observed entry. Retain failed native run/jobs, PR H, entry ID, removed event ID, `beforeCommit`, actor, reason, and complete absence. Classification is CI failure only when the pinned native evidence binds that admission.                                                                                                                                                                                                  |
| D. Timeout removal                               | A canary rule with a reviewed short timeout and deliberately non-reporting group creates an actual timeout. Capture distinct reason/actor/beforeCommit behavior and whether GitHub emits a run at all. Missing `merge_group` trigger must never merge. Restore the accepted workflow/rule configuration after this scenario.                                                                                                                                                           |
| E. Manual dequeue and head update                | Owner dequeues a canary PR; separately make a normal fast-forward canary-head update while queued. Record refusal or native removal, all actors/reasons, old/new H, and membership before/after. No force-push. If a queued branch accepts an update without an observable removal or invalidation, fail activation. A foreign entry remains protected; Sentinel never dequeues it.                                                                                                    |
| F. Rule removal/no-queue behavior                | On isolated canary fixtures, owner disables its rule with an observed entry present and records the exact resulting membership/events. A single App `merge_action: merge_queue` request with no rule must refuse, never merge directly. Never infer safe production release of custody from “rule absent.” Restore canary rules only after reconciliation.                                                                                                                             |
| G. Owner bypass/base drift                       | On the canary only, test disjoint then overlapping owner base updates while entries exist. Record rebuild/ejection/group identities and all extra runs. Any overlap must prevent trusted booking; complete tree proof still applies after GitHub merges. Production practice is no direct owner push while Sentinel entries remain queued.                                                                                                                                             |
| H. Workflow/rule drift                           | Prove disabled workflow, missing trigger, `.github/` predecessor, changed workflow bytes, HEADGREEN, non-MERGE, missing/wrong-App check, and new App bypass each prevent admission. For already owned entries, retain custody and use only authenticated own-entry dequeue; ambiguous dequeue does not release custody. Local injected-reader regressions cover changes between reads and effects; canary verifies the native surfaces.                                                |
| I. Loss/unavailable/restart                      | Use a reviewed transport fault in the canary harness to lose an enqueue response after submission, then resume observation. Exactly one external submission; no retry on elapsed time, 404 async receipt, GraphQL error, queue-read failure, or 24-hour result expiry. Queued/unavailable/ambiguous custody never becomes eligible by aging. Injected local clocks test the long intervals; do not wait hours merely to test a clock.                                                  |
| J. Refusal and failed-admission budgets          | Three definitive enqueue refusals for the same binding yield the named owner park. One proven CI/timeout ejection can authorize one fresh admission after all gates pass; the second proven queued failure yields the named owner park. Native tests corroborate classification; local production-state lifecycle tests prove durable counters and restart behavior. Do not use unclassified removals, poll errors, or other heads as failures.                                        |
| K. CI continuity and parked jobs                 | Observe three consecutive actual development push revisions and a canary burst of group runs without concurrency cancellation. Do not create production commits solely to manufacture this evidence. Group checks cannot be replaced by push checks. If `action_required` occurs, verify whether the App can approve that exact group run; an unsupported approval route remains a deployment blocker rather than an assumed retry.                                                    |
| L. Custody before effects and late owner enqueue | Local named lifecycle uses real Git-backed state and native mocked APIs to prove hold CAS/readback precedes enqueue; custody runs first even when ordinary passes would return; late membership prevents final publish/refresh/conflict/merge/review/booking effects; failed custody prevents prepare/plan/matrix/repair. Live canary records the same native identities without mutating production repair state.                                                                     |
| M. Proof rejection and consumers                 | Reject matching-H merges with wrong parents, overlapping tree drift, absent/stale group CI, skipped/neutral checks, wrong App/suite/workflow/attempt, non-App enqueue, missing observed entry, unknown reason, or missing history. Delivery, closure, follow-up, and adoption must all consume the same authenticated proof and refuse structural/copy-forged proof objects.                                                                                                           |
| N. Queue-aware fallback and drain                | Demonstrate the reviewed fallback retains custody and strict proof with enqueue mode off, runs native guards, and does not restore legacy booking. Old R80 is not an eligible fallback while queue use/custody remains. Test controller rollback with the exact installed pins before owner development activation.                                                                                                                                                                    |

Existing owner constraints remain independent of queue budgets: at most three
review rounds and three CI-fix rounds, only P0/P1 findings block, and CI
precedes review and merge. Exhausted review rounds with no P0/P1 left permit
merge plus P2/P3 follow-up issues. Enqueue neither charges nor refunds a model
reservation; ambiguous outcomes stay charged.

The six-hour unresolved-admission owner escalation in current policy is not a
hold expiry or a retry authorization. A PR can stay queued for longer than that
without a new admission. A named owner park retains the non-expiring hold;
unknown/foreign custody is not cleared merely because a summary reports it.

## Proposed owner ruleset body

The current isolated-canary proposal is the complete
[empty-bypass disabled body](projection-preparation/proposed-queue-canary-disabled-body.json):
MERGE, ALLGREEN, all four Actions checks, three build slots, a 60-minute response
timeout, minimum group size one, maximum group size five, and no pull_request
rule. These are proposed settings, not native accepted findings. No User,
OrganizationAdmin or App bypass is included in this approval. Optional owner
bypass/base-drift scenario G is excluded unless separately approved later.

Create this canary object disabled only after the owner approves this exact
body and branch scope. Collect its complete native baseline, then activate the
same canary object for the approved projection and queue phases. The separately
prepared dequeue-window and missing-trigger variants are the only additional
rule settings included in the nine-fixture plan. Retain actual native IDs,
parameters and hashes before reviewing effect grants. A different timeout or
capacity is a changed proposal requiring explicit disposition, not a guessed
accepted pin.

Use the reviewed body file for any authorized request. The canary runner never
administers rules. The earlier User-bypass body is preserved only in the
pre-audit packet snapshot as historical, unapproved material and must not be
submitted under the current scope.

Production is a later, separate staged object with a distinct name, exact
refs/heads/development include condition, empty bypass, no unexpected
exclusions, and enforcement disabled. Its creation and activation are outside
this isolated-canary approval. Never reuse canary IDs or hashes for production;
no active production POST or enable-then-pin interval is authorized.

## Canary scenario P: prove disabled-to-active rule projection

The concrete closed compiler proposal is `projection-preparation/contract.md`.
Its initial profile accepts only exact literal repository branch conditions and
four reviewed rule types, and refuses inherited/overlapping active policy.
Complete unapproved empty-bypass disabled bodies and synthetic refusal fixtures
are prepared there; they assign no native IDs, grants or active digest. The
earlier User-bypass proposal is historical and excluded; optional canary
scenario G would need a separate concrete owner approval.
Current connector reads found empty development rules and parent inventory;
these are not runtime App proof.

Run this configuration collection before canary enqueue scenarios. The owner
controls only the approved `queue-canary` ruleset; production has no active
merge-queue rule throughout. The canary runner performs App-authenticated reads
and source-authorized queue effects, never ruleset administration.

1. Record the exact canary branch tip, approved disabled creation body and its
   hash, native creation response, stable ruleset ID, owner actor, request/time
   identity, and complete applicable repository/organization ruleset listing.
   Capture raw details for each applicable source, including exact include and
   exclude conditions, source/source type, enforcement, rules, defaults, IDs,
   bypass actors and the runtime App's `current_user_can_bypass: never`.
2. While that object is disabled, capture complete effective branch-rule arrays
   for `queue-canary` and `development`, plus all inherited sources. Record page
   completion and repeated stable readbacks. The disabled canary object must not
   contribute an active queue rule; no development queue rule is expected.
3. With the approved canary-only conditions rechecked, the owner activates the
   **same ID** without changing any other intended field. Retain the exact
   activation request/response, all raw details and effective arrays again. Diff
   disabled versus active raw and parsed values field by field. Confirm
   development applicability is unchanged and the App still cannot bypass.
4. With no canary entry present, disable and reactivate that same object once
   more under the same canary authorization. Retain each readback and prove
   whether rule IDs, defaults, normalized parameters, source decoration,
   condition interpretation or inheritance change. Then leave the canary in the
   approved state for queue scenarios. Do not remove a queued entry merely to
   simplify this collection.
5. Feed the retained native fixtures into a source-reviewed projection that
   predicts the exact active `GitHubBranchRuleWireV1[]` from the disabled object
   plus complete applicable active sources. Compare its canonical bytes and hash
   to the **observed canary active** array. Test unknown fields/defaults,
   changed IDs/conditions, missing pages and inherited-source drift as refusals.
   Record the compiler source SHA and every input/output hash. The pure compiler
   is already accepted locally; the native projection profile and production
   expected active digest remain unaccepted until these observations pass.

The standard canary artifact's typed ruleset object **does not retain branch
conditions**. Its success alone cannot satisfy this scenario. Preserve separate
raw native condition/details responses using the bounded GET templates above;
record which identity obtained each response. Owner-authenticated conditions may
corroborate scope, but only the runtime App observation establishes its bypass
posture. If that required App metadata cannot be obtained, record it as
unavailable. Do not infer a missing condition or bypass field from an empty
list.

The projection evidence packet must include:

| Packet item                   | Exact binding                                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native transition series      | Same canary ruleset ID; every disabled/active request and raw response; branch tips, authenticated actors, times/request IDs, pagination completeness, stable repeated reads and unchanged development controls.                                          |
| Decoration map                | For every active rule: `id`, `name`, `rulesetSourceType`, `rulesetSource`, `rulesetId`, type and every parameter/default; explicit origin in native disabled details or the accepted transformation. Preserve omission-to-null behavior.                  |
| Conditions/inheritance/bypass | Complete raw include/exclude conditions and all applicable repository/organization sources, with evaluated branch applicability and owner/App bypass facts retained separately from the typed hash.                                                       |
| Accepted projection           | Compiler/source identity, native canary input fixtures, exact predicted/observed canonical arrays and matching hashes, plus mismatch/refusal fixtures. A screenshot or schema description is not transformation evidence.                                 |
| Production expectation        | Distinct disabled production object/ID and raw condition details, fresh complete active inherited sources, exact expected active array and digest, projection provenance, source pins in both F and A, and final actual-active readback after activation. |

`effectiveRulesSha256` hashes the **entire** parsed branch-rule array, sorted by
each element's `canonicalStringify(...).localeCompare(...)`, using the
production canonicalizer. It is not the creation body, `jq -S`, a UI display, or
the canary ruleset hash. No identities or inherited rules may be stripped to
make the hash predictable.

For production, the owner first creates the exact development object disabled.
Use its observed stable ID, full raw conditions/defaults/bypass details and all
current active inherited rules to derive the expected active representation
through the accepted transformation. Source-review that exact byte/hash fixture
and install the digest in **both F and A before activation**. Re-read staged
production details and inherited sources immediately before activation; any
change invalidates the prepared expectation.

**Stop with production disabled** if activation generates unknown IDs, defaults
or normalization; conditions/applicability are ambiguous; inherited sources or
pages are incomplete; App bypass is unknown; or canary evidence cannot establish
the exact projection. Current parser output alone cannot prove conditions. If
these facts cannot be derived, the current authority design cannot support this
cutover; revise its implementation within the existing source-review process. Do
not activate merely to discover the hash, change pins after enabling, or claim
that a predicted array is already observed active evidence.

Even with the preinstalled expectation, every real admission must read an actual
active merge-queue rule and match the complete expected digest, then repeat the
fresh gate before the effect. Disabled rules never admit. A mismatch after the
owner's activation remains closed; return the ruleset to disabled and reconcile
before another attempt.

## Historical direct inventory before strict activation

Inventory every outstanding Gateway record that may still consume an older
direct merge: undelivered/merged records, release-wait and pending issue
closure, pending P2/P3 follow-ups, spent/adoption candidates, and carried
receipts. Bind each witness to exact repository installation scope, PR, B/H,
review request and receipt, task digest, and M. Retain native merged PR/actor,
exact ordered parents, full tree proof, reachability, and authenticated
successful direct operation evidence when available. A GitHub actor name, commit
timestamp, lack of an indexed merge-group run, or digest with no exact entry is
not a witness.

The reviewed finite array has entries:

```json
{
  "binding": {
    "repository": {
      "owner": "ubiquity",
      "name": "ai.ubq.fi",
      "installationId": 155687488
    },
    "pullRequest": "<EXACT_NUMBER>",
    "base": "<EXACT_B>",
    "head": "<EXACT_H>",
    "reviewRequestId": "<EXACT_ID>",
    "reviewReceiptId": "<EXACT_ID>",
    "taskDigest": "<EXACT_DIGEST>"
  },
  "revision": "<EXACT_M>",
  "witnessDigest": "<ACCEPTED_EVIDENCE_SHA256>"
}
```

The manifest digest is exactly
`canonicalStringifySha256({domain:"sentinel.queue-historical-direct.v1", witnesses: entries})`
with the accepted array order. No duplicates or inferred entries; an empty
inventory is acceptable only after proving that no outstanding consumer needs
one. Record unsupported historical cases individually as owner-visible holds.
Keep original carried receipt identity; existing carried VPS acceptance cannot
be fabricated from a release request. Carried release/closure remains pending
until real acceptance exists, and `sentinel-release` remains disabled.

## Production sequence and fallback

Use D, F and A as labels until actual reviewed SHAs, generations, launchers and
health proofs exist. The exact implementation plan is `install-plan.md`.

1. Establish healthy R81 through L81 and actual supervisor runs; finish the
   target workflow prerequisite. Preserve the accepted R80 rollback for this R81
   stage. No queue activation is authorized by R81 acceptance alone.
2. Combine the accepted queue source with L81. If installing initially dormant
   D, keep ceiling off, proof false and pins empty; freeze/review/exact-R
   CI/depth-1/parser compatibility, then install through separate exact launcher
   pins and verify healthy dark runs. D is not the activated queue's drain
   fallback.
3. Publish accepted canary source as a fast-forward descendant of the accepted
   launcher, preserving healthy installed R81, its exact runtime constants and
   pointer, and source mode off/proof false. The App grant is already confirmed;
   after canary authorization, complete queue-canary evidence,
   including scenario P, without modifying development. Accept finite historical
   direct witnesses before the strict boundary.
4. Under the owner's production-ruleset step, create the exact development
   ruleset **disabled**. Collect its server IDs, conditions, defaults,
   inheritance and bypass facts. Use the accepted native projection to prepare
   and source-review the expected production active array/digest. Keep
   development disabled if any projection prerequisite is unresolved.
5. Build F with complete accepted pins, **proof activation true and source
   ceiling off**. Include the expected production active digest, exact workflow
   and actor/removal pins, and historical witnesses. Install F through an exact
   rung and obtain F's own healthy proof. Before any active production queue,
   all selected revisions and pointer/rollback paths must enforce the strict
   capability boundary. Its initial fallback is hold/fix-forward unless another
   strict fallback has its own accepted proof; D/R80/R81 cannot drain it.
6. Build A with the identical proof configuration and **source ceiling on**,
   with the correctly wired lower-only selector initially off. Install only over
   exact healthy F; retain F's exact health proof and revision as rollback
   authority. Verify the launcher and native runtime receive the same selector
   and accepted pins. Selector wiring and capability enforcement are audited
   source; exact future pins and live observations are still required.
7. While production remains disabled, set the wired selector on and verify A's
   installed effective mode and configuration. Admission stays closed because
   native effective rules lack the matching active queue. Recheck the staged
   object and inherited sources against the reviewed expectation. Only then may
   the owner activate that exact production object. No post-enable pinning or
   code publication is part of the normal path. First enqueue requires matching
   actual active rules and all ordinary CI/review/task/workflow/path gates.
8. If the active readback mismatches, keep admission closed and have the owner
   return that object to disabled; retain evidence and investigate. Otherwise
   observe probation: one enqueue per pass, hold/intent persistence before the
   effect, native entry identity, exact-M group proof and one booking. Confirm
   multiple bookings across actual supervisor runs without custody leakage.
   `sentinel-release` remains disabled; a booking is not VPS acceptance.

Prefer publishing dormant queue/canary **source** while keeping healthy R81
installed, then installing F → A: two future runtime installations, with exact
generations assigned only after the observed R81 outcome. Current source permits
this: dormant capability policy still allows R81 and the separate App canary
runner does not write repair state. Each grant-bearing canary launcher still
requires the explicit exact-CI/audit and fast-forward trusted-ref publication
above; development publication alone is insufficient. The first strict launcher must carry the
reviewed exact R81→F owner-install migration tuple without granting R81 execution
or rollback after activation. An optional D install adds D → F → A and its own
acceptance cost; D is not required to run the source-pinned canary. Publishing
an F commit is not F's healthy installed proof. Prepare source/CI ahead of the
strict F interval; it may pause new Gateway merges while historical evidence is
reconciled. This must not become an enable-first direct-merge 405 outage.

Rollback keeps the strict capability boundary:

1. Lower the wired selector to off. Retain proof activation, accepted pins,
   intent, holds and all charges.
2. Keep A or let the guarded controller select exact healthy F. F stops new
   admission but must drain/re-prove exact queue outcomes and retain uncertain
   custody. D/R80/R81 are ineligible during the activation era, even when the
   queue is temporarily empty.
3. Reconcile native membership, ambiguous admissions/removals, booking,
   release/closure/follow-up consumers and retained root provenance. Only then
   may the owner disable the production ruleset and verify the resulting native
   rules/membership. Staying on F remains preferred.
4. Running an old runtime again requires an explicit, accepted decommission
   boundary enforced by the trusted controller. Empty queue or disabled rule
   alone is insufficient; pending or replayable queue consumers and done
   provenance must be accounted for. No state rewrite, proof reset, refund,
   branch deletion or PR-closing action is permitted.

Retain canary PRs/branches and run history. The owner may disable the canary
ruleset after reconciliation. Bound each operator command at 300 seconds; tests
must not access or chdir under `/tmp`.

## Acceptance record to complete

Before owner production activation, show actual values rather than placeholders:
combined source/review/CI references; installed F/A/launcher identities and F's
healthy proof; A's exact fallback binding and wired selector observations;
runtime App/installation; canary run IDs/attempts and scenario results; actor
tuples; workflow ID/bytes; complete canary transition fixtures and production
disabled details, conditions/inheritance/bypass evidence; the accepted
projection and preinstalled expected production active digest; finite removal
mappings; historical witness manifest; and confirmation that `sentinel-release`
is disabled. Missing required evidence leaves development disabled.

After activation, append actual active effective-rule readback, first production
enqueue/native entry/proof/booking, and live supervisor run IDs. These outcomes
cannot exist beforehand and must not be fabricated as pre-activation proof.
Unresolved outcomes retain custody and pause further rollout; a rule mismatch
uses the disabled-state recovery described above.

</details>
