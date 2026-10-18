# Sentinel handoff, 2026-10-18 ~02:55 UTC

The coordinator session ran out of quota. This directory holds every unfinished lane, as patches, and the research it relied on. The tracking issue on ubiquity/sentinel points here.

## Live state

- **Runtime:** generation 80 (R80 `e48e7e110`), installed and healthy. Six consecutive clean supervisor runs up to 39066869060; later runs on the new launcher were also clean.
- **Launcher:** `87e28fd4a` on `development` and `sentinel-supervisor`.
  - 12 CI corrections per pass (`3f041b46d`).
  - Retire-loop fix (`01f482529`).
  - Implementation model **gpt-6.1-sol**: `supervisor.yml` binds `SENTINEL_MODEL_ID: ${{ vars.SENTINEL_IMPLEMENTATION_MODEL_ID || 'gpt-6.1-sol' }}` in the plan, cell and repair jobs.
  - The old `SENTINEL_MODEL_ID` repository variable still holds `gpt-reserve` and is no longer read; the owner can delete it.
- **Sol vs luna** (`research/sol-vs-luna.md`): luna produced a candidate in 0 of 4 cells, and 3 of those were cut off at the 4M streamed-output bound. Sol produced a candidate in 11 of 15. Three of sol's 4 failures are the "no change against the base" shape (B10 below), which also hits luna.
- **ai.ubq.fi manual protected-path PRs:** 11 of 12 merged (#1150–#1153, #1155–#1158, #1160–#1162). Follow-ups filed: ai.ubq.fi #1164–#1166, #1176, #1178; sentinel #161.
  - #1159 (issue 1141) was mid-resolution of a `docs/DECISIONS.md` conflict, workflow `finish-1159`. If it is not merged: merge development into `claude/issue-1141`, keep both #1156's and #1159's G3 text, get CI green, check, then merge.
- **ai.ubq.fi CI fix PR** (workflow `aiubq-ci-trigger-fix`, branch `claude/ci-keep-base-runs`) may be open. It stops `deno-deploy.yml` from cancelling development push runs: 4 of 5 were cancelled, and a cancelled base run leaves Sentinel unable to attribute a PR's red CI. It also adds `merge_group: [checks_requested]`; merge_group runs must never deploy. Merge it once it has been reviewed and CI is green.
- **Superseded bot PRs:** #1057, #1060 and #1116 duplicate merged manual PRs. Sentinel never closes PRs; the owner may close them.

## Generation 81: lanes ready to integrate (`lanes/`)

Each lane directory holds `git format-patch` output from the lane's base, plus `uncommitted.patch` when the lane had work in progress.

| Lane | Base | Head | Status |
|---|---|---|---|
| `wt81-150` VPS bridge #1027 interface | d5cc84402 | 0cf90614c | Reviewed earlier. Needs ai.ubq.fi #1146 (PR #1162, merged). |
| `wt81-153` hosted pre-review CI-fix route + moved-base re-admission | 9a1b1d924 | 83dad8371 | Review PASS (P3s only). Releases about 18 live pre-review CI parks. |
| `wt81-154` every expected check present before CI is green | 9a1b1d924 | df1ba0860 | P1 fixed: lenient `readCheckSuites` for base coverage; self scope skips the read. No recheck yet. |
| `wt81-cievidence` CI failure evidence for corrections (any failure kind) | 3f041b46d | 01650f1ac | Two-lens review found a P2 at `src/repair/ci-evidence-excerpt.ts:371` (unrecognized-shape excerpt). The fix was in progress when stopped: check `uncommitted.patch` if present and re-run that review finding. The review findings live in the session workflow journal (not committed: it contained a credential-shaped test string). |
| `wt81-verify` exhaustive decision-matrix checker (test) | 3f041b46d | acfaa4d55 | Checker committed, plus uncommitted work. The adversarial verify phase was stopped mid-way; verdicts so far are in `reports/decision-matrix-verification-journal.jsonl`. The report was not written. |
| `wt82-review-expiry` B5: saved review request never expires | 3f041b46d | 0a1a59d99 | Done. Live 604, 630 and 647 move on the first R81 pass. |
| `wt82-acceptance` B6: task acceptance not fulfilled → correction while rounds remain, visible park when spent | 3f041b46d | 90d0ade00 | Done. |
| `wt82-repeat-failure` B10: identical failures park after 3 | 3f041b46d | 3a32b74ad | Done. See the follow-up below. |
| `wt82-refresh-detach` B11: refused base refresh keeps PR binding, visible park | 3f041b46d | 4c81f3f71 | Done. Sentinel 157 / PR #160. |
| `wt82-release-wait` B12: merged Gateway delivery held in one stable state, no per-pass rewrite | 3f041b46d | 6e98c69a2 | Done. |
| `wt82-delivery-line` J3: delivery line ordered by readiness | 3f041b46d | c3042c72d | Done. It left for later the one-merge-per-pass flag, five closure slots and state-error abort. |
| `wt82-output-bound` remove the streamed-output volume bound | 87e28fd4a | — | Not started (no diff). |

Full lane reports, with root causes, R80 compatibility arguments, files shared between lanes, tests and live records unblocked, are in `reports/jam-lanes.json` and `reports/gen81-153-154.json`.

### Integration plan (not started)

1. Integrate onto launcher `87e28fd4a`, not L80: every lane needs a rebase. Generation 81's rollback target is R80, so every state, plan, cell, receipt and stdout shape written must parse under R80.
2. `wt82-repeat-failure` edits `supervisor.yml` to pass the model variables to the maintenance step. It must use the same `SENTINEL_MODEL_ID` expression as the other jobs, `vars.SENTINEL_IMPLEMENTATION_MODEL_ID || 'gpt-6.1-sol'`, so the route identity matches.
3. **Improve B10:** a run that ends with no change against the base (`model_candidate_unchanged_base`) usually means the issue is already satisfied; issue 300 was fixed upstream on 2026-09-22. Route it to the existing "already satisfied at base" review and closure instead of an owner park.
4. **Output volume bound:** stop interrupting sessions on streamed volume. `model-port-settlement.ts` counts the JSON of every app-server event, deltas and completed items alike, against `maxOutputChars` = 4_000_000 (`src/host/local-config.ts`). Keep the 30-minute duration bound. Keep memory bounded by retaining only bounded slices. Set `maxOutputChars` to a never-reached positive safe integer so every comparison stays consistent and R80 still parses. Drop the "output allowance" sentence from `model-port-prompt.ts`. Keep `ops/hosted-autonomy-output-bound.ts` correct for R80-planned cells.
5. **Throughput caps** (owner: "these limits seem unnecessary"):
   - Keep: the owner pipeline rules (3 review rounds, 3 CI fixes) and storage/safety bounds.
   - Lift or remove the per-pass throttles that guard nothing: closures and retirements (5/pass), spent reads (8), CI reruns (3), conflict resolutions (4/pass and 4/wave in the runtime), and the silent 200-reservation skip, which is now named.
   - The one-merge-per-pass rule goes away with the merge queue.
6. **Owner visibility:** several lanes note that owner-gated parks appear only in state and in maintenance-log lines. Add them to the run summary.
7. Then: one combined adversarial review, R81 push, exact-R CI (whole-repo fmt including JSON, lint, size, check list, tests at CI permissions, shallow-clone run), L81 pin (gen-81 rung, R81 in the allowlists, `HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES`, runtime conflict per-wave cap), install, and verify on live runs.

## Merge queue on ai.ubq.fi (owner approved 2026-10-18)

`research/design.md` and `research/critique.md`. The critique says **do not ship as written**: 1 P0, 4 P1.

- **P0:** the 17-minute hold marker expires while a PR is still queued, because launcher passes run 32–66 minutes apart. Use `{reason: "backoff", until: null}` and run the queue check first in every pass.
- **P1:** the old verifier books queue merges before the new proof runs.

Rollout:

1. The owner grants the `ubiquity-sentinel` App "Merge queues: Read and write".
2. Ship Sentinel enqueue support dark: `PUT /pulls/{n}/merge-async` with `merge_action: merge_queue`, pinned to the reviewed head, plus a new queue-merge delivery proof (parents `[P, H]`, reviewed base is an ancestor of P, exact change set from P, all four required checks green on the merge group).
3. Merge the merge_group CI trigger (the ai.ubq.fi PR above).
4. Observe mode.
5. The owner runs a canary on a `queue-canary` branch.
6. The owner creates the `development` ruleset: ALLGREEN; all four checks required (`validate`, `mac-containment`, `darwin-native`, `verify-artifact`); owner bypass. Exact JSON is in the design.
7. Flag on.
8. Generation 82.

**Never enable the ruleset before Sentinel can enqueue:** direct merges then return 405 and deliveries stop.

## Decision matrix

- **Diagram:** `research/decision-matrix-diagram.html` (also published at https://claude.ai/artifact/3t4etLd8RJAYixE8RsJ9VK).
- **Map:** `research/decision-matrix-map.json`.
- **Live fleet at 20:36 UTC:** `research/fleet-rows-2026-10-17T2036Z.json`.

## Constraints to keep

- Never post `@codex review`.
- Never add rulesets or branch protection on ubiquity/sentinel.
- Never add code that closes PRs or deletes branches in a target repository.
- No force-push: fast-forward only to `development` and `sentinel-supervisor`.
- Keep `sentinel-release` disabled.
- Do not edit `src/github/codex-review-rubric.ts`.
- Reservations stay charged; ambiguous outcomes are never refunded.
- Only P0/P1 block merge.
- Bound local commands at 300 s.
- Tests must not read or chdir under /tmp, and must work in a shallow CI checkout.
