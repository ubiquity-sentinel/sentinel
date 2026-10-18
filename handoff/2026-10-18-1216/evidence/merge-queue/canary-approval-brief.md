# Isolated queue-canary approval

The original task reserves the canary and rulesets for the owner. Runtime App permission is already granted and accepted. This request is only for the isolated canary on `ubiquity/ai.ubq.fi:queue-canary`; production queue activation remains a later owner step.

Current Sentinel development is [9b7c3e5c](https://github.com/ubiquity/sentinel/commit/9b7c3e5cec4d45c4e0985ab28bd524b4bb69237b), tree `52168e7686dd1a07dcefd8cb354e8a1b3e4d150d`, after merging the existing PR160. Its exact reviewed PR input passed [CI39117497198](https://github.com/ubiquity/sentinel/actions/runs/39117497198): 3,225 tests / 1,305 steps. The queue base [2b32bdbd](https://github.com/ubiquity/sentinel/commit/2b32bdbd449cbc615c239af40474941cefcb0c55) separately passed exact [push CI39117211579](https://github.com/ubiquity/sentinel/actions/runs/39117211579): 3,218 tests / 1,298 steps. No postmerge-push CI acceptance is claimed for `9b7c3e5c`. The live launcher remains L81; installed R81/81 has accepted ordinary [run39114941481](https://github.com/ubiquity/sentinel/actions/runs/39114941481) with 21 successful jobs. Production queue policy remains off, grants/pins empty and release disabled.

The AI workflow repair merged as `730218b0c89d479b141c4a2fa17ad5ee363f161a`; its PR and exact development-push CI both passed all seven real jobs. The proposed canary starting point is current development `984aa8a63183d60a15036321d2dc7aefd8e5d1b3`, tree `7218790ddaf4837c5cdc40243883a72402c49f11`. Its later catalog-only repair preserves identical workflow and selector/runner bytes. All nine fixture patches apply individually and together while retaining all 1,071 original entries; the missing-trigger variant restores exactly. The passing base-CI receipt is bound to `730218b0`, not the newer fixture baseline; no newer passing-CI claim is made. Fresh native reads found no canary refs/PRs or AI rulesets, and confirmed 0x4007 still owns open assigned #164. See the [current fixture plan](canary-final-preparation/final-fixture-plan.json) and [full evidence](canary-final-preparation/README.md).

The prepared scope is nine isolated fixture PRs, reusing matching open PRs if present, plus one canary-only ruleset created disabled and then exercised through reviewed phases. Before each effect phase, publish the exact grant-bearing launcher source on development after its scoped review and R81 compatibility checks; pass its exact native CI and current-head audit, then fast-forward sentinel-supervisor to the same source. The trusted workflow cannot run from development alone. These launcher updates retain installed R81 and disabled production queue policy; they are not queue-runtime installation. Queue effects run as the `ubiquity-sentinel` App in trusted Actions. The authenticated operator `0x4007` owns tracking issue #164 and performs the explicitly planned owner probes. No new tracking issue is needed.

The scenarios cover three successful queued merges; exact group-run cancellation; App dequeue; head change and foreign entry; rule removal; no-rule refusal; missing merge-group trigger; and a single SHA-pinned direct-merge refusal probe. Native entry/run/actor/tree evidence is required. The nine fixtures are a plan, not fabricated native PR identities or grants.

- [Concrete sequencing and bounded phase plan](canary-fixture-preparation/sequencing-addendum/README.md)
- [Nine fixture definitions](canary-fixture-preparation/sequencing-addendum/fixture-plan-corrected.json)
- [Full owner packet](canary-owner-packet.md)
- [Baseline disabled canary ruleset](projection-preparation/proposed-queue-canary-disabled-body.json)
- [App-dequeue phase body](canary-fixture-preparation/sequencing-addendum/proposed-bodies/queue-canary-dequeue-window-disabled.json)
- [Ownership safeguards](canary-fixture-preparation/sequencing-addendum/ownership-preparation/proposal.md)

The dequeue phase has exactly one entry under min2/wait360, with a native deadline and bounded reads; it is not an indefinite wait. The missing-trigger phase changes only canary workflow bytes, retains PR checks, and restores the exact original bytes before the successful burst. Each source grant is reviewed against actual native IDs before dispatch. Ambiguous effects are observed, never replayed or refunded.

No production ruleset is created or activated by this approval. No Sentinel ruleset/branch protection, release enablement, target-PR closure or branch deletion is included. Optional owner-bypass/drift and extra contingency fixtures require separate approval if needed.

Prepared only; owner authorization has not been requested or recorded yet.
