# Claude → VPS handoff, 2026-10-30 22:10 UTC

Written by the Mac session (Claude Fable 5.1, session `2690e6fc`) that held
Sentinel integration ownership from 19:05 UTC on the owner's instruction. The
receiving session runs on `codex@vps.pavlovcik.com` as the Claude Code CLI
(`claude --model claude-fable-5-1 --effort low`) and orchestrates confined codex
workers on `ubiquity/deepseek-flash` at max reasoning. Read `AGENTS.md`, then
`docs/build-status.md` in the production-throughput worktree on the Mac is the
historical ledger; from this handoff on, this file plus `docs/DECISIONS.md` are
the current record until the VPS session chooses its ledger location.

## Owner directives in force (2026-10-30, chat)

- Orchestrate codex with model `ubiquity/deepseek-flash`, `model_reasoning_effort="max"`.
  Native `codex exec review` for every candidate (no model override).
- Codex processes must be confined to their worktree. Run every worker and
  reviewer with `CODEX_HOME` pointing at a confined home whose `config.toml` has
  no `sandbox_mode` and a deny-root permission profile (template:
  `.codex-worktrees/.codex-home-confined/config.toml` on the Mac; the VPS copy is
  created by this handoff at `~/repos/ubiquity/sentinel/.codex-worktrees/.codex-home-confined/`).
  A reviewer that read `~/Documents` triggered this; never launch codex here without it.
- Remove every blocker the owner never approved. Keep only the five 10-20
  invariants (no credentials/state/promotion authority in model workers; exact
  SHAs; durable admission/settlement; CI green + completed native review with no
  P0 before autonomous merge; one promotion owner) and a small protected-path set.
  Remove: the protected-path list beyond credential/dispatch/merge-gate files,
  the review-round ceiling park, the CI-fix attempt ceiling park, the
  "merged outside the trusted review path" park (a human merge is `done`), the
  self-target merge "owner action required" park. Keep the task-acceptance
  verdict as part of the review result.
- Correct already-parked records by editing `sentinel-state/repair` directly
  (owner: "you can edit it directly if that's more efficient"). Phase 1 was
  applied at 21:51 UTC (commit `e10df80`, sequence 78116, 52 records: 35
  permanent `backoff/until:null` holds released, 17 human-merged PRs → `done`).
  Phase 2 (117 records: 91 protected-path parks → `work`, 24 ceiling/CI-fix parks
  → `review`/`work`, 2 self-merge parks → `delivery`) must be applied only after
  the rule removals below are installed, otherwise the installed runtime re-parks
  them. Script: `state-unblock.py` in the handoff bundle (`--phase=later --apply`),
  then commit with message `sentinel-state repair write\n\nnonce: <hex>` and a
  non-force push between supervisor runs; manifest `sequence` = prior + 1,
  `stateHead` = parent commit.
- `sentinel:skip` labels were stripped from issues 226–230, 166–168, 176, 81.
  Kept on 6, 10, 13, 164 (owner decisions / release wiring).
- Do not wipe the whole state branch unless the owner confirms it after seeing
  the phase-2 results.

## Live system at handoff

- Installed: `9cdc6ad3` at generation 133 (contains m22 follow fix, m21 #228,
  m25 #187). Ordinary cycles settle healthy; dispatcher auto-follow works.
- The install loop (finalize refusing on GitHub's lagging job-step metadata,
  dispatcher refusing `execution_in_flight`) is fixed on the dispatcher side
  (`5da00062`). The finalize side is the parked m23 lane.
- Throughput facts at 21:40 UTC: 432 work records; 288 blocked (122 "source issue
  closed", 91 protected path, 15 review ceiling, 9 CI-fix cap, 17 human merge,
  rest misc); 52 live. After phase 1, 33 ai.ubq.fi delivery records are live again
  but ai.ubq.fi merges still need CI evidence: the target's Gateway CI is disabled
  for Sentinel's dispatch (issue 181, owner action) or ai.ubq.fi must be added to
  `sentinel.backup-ci-targets.json`. Passport runs on backup CI (Actions billing,
  issue 216).

## Lanes (branches on origin, `codex/<lane>`; worktrees on the Mac under `.codex-worktrees/`)

| Lane | Branch tip | State |
| --- | --- | --- |
| claude-unblock-20261030-b1-protected-paths | `86b6eb28` wip(partial) | worker killed by the Mac reboot mid-task: PARTIAL, untested, unreviewed. Re-run `briefs/b1.md` on this tree (or reset to 9cdc6ad3). Log: `b1-exec-partial.log` in bundle. |
| claude-unblock-20261030-b2-review-ceiling | `654f8424` wip(partial) | same: PARTIAL, re-run `briefs/b2.md`. Log: `b2-exec-partial.log`. |
| claude-unblock-20261030-b3-human-merge | `0782e40c` complete candidate | worker finished (report `b3-report.md` in bundle: RED/GREEN recorded); native review NOT run yet. Review under the confined home, fix findings, then integrate. |
| claude-stability-20261030-m23-finalize-retry | wip commit | parked: round-3 P1 (vanished job → false `not_started`), P2 (null-timestamp step rejected before re-read) |
| claude-stability-20261030-m24-matrix-crash | wip commit | parked: containment needs a typed historical-vs-current refusal |
| claude-stability-20261030-m25-queue-guard | wip commit (`0c7ca343` integrated; the extra commit is the rejected hold-recovery) | the hold recovery is superseded by the direct state edit; drop it |
| claude-stability-20261030-m26-ci-event-scope | wip commit | parked: event mismatch is not configuration evidence; keep never-started classification + event enrichment |

Review receipts for every round are in the bundle under `reviews/`.

Mac session ended 2026-10-30 22:15 UTC (owner reboot). The first supervisor cycle after state phase 1 (run 41134130894) planned 7 matrix cells instead of 1.

## Next actions for the VPS session, in order

1. Fetch origin; create a worktree per lane from the branch tips. Finish b1–b3:
   run (or re-run) the briefs as confined deepseek workers, `codex exec review
   --uncommitted` under the same `CODEX_HOME`, correct P0/P1 findings, up to
   three rounds; integrate clean lanes onto development by cherry-pick, run
   `deno check` on changed files, `deno fmt --check`, `deno task size:check` and
   the lanes' focused tests, push to development, let CI and auto-follow install.
2. After the new revision is installed and one ordinary cycle is healthy, apply
   state phase 2 and verify the next cycles admit the re-admitted records.
3. Measure: per-cycle `hosted_runtime_summary` (`admittedWorkCount`, `modelStarts`,
   `prsTouched`) and the work-record distribution (`work-state-summary.py` in the
   bundle). Report admitted/merged per hour to the owner.
4. Then the parked lanes, in value order: m23 (settlement reliability), m26's safe
   subset (never-started → no charged retry), m24 typed refusal.
5. Owner-side asks to surface once: ai.ubq.fi CI access for Sentinel (issue 181),
   Passport deploy check not a merge gate, GitHub issue creation permission for
   the four backlog drafts (`backlog-issues.md` in the bundle).

Hosted intents go to `/tmp/sentinel-claude-20261030/intents.jsonl` on the Mac;
start an equivalent file on the VPS. `sentinel-release` stays disabled.
