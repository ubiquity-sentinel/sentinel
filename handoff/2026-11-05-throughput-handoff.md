# Handoff: throughput plan #340 and self-improvement loop (2026-11-05)

Read `AGENTS.md`, then the top four sections of `docs/build-status.md` and the
2026-11-05 entries at the tail of `docs/DECISIONS.md`. They are the authority;
this file only says what is left and where to look.

## State at handoff

- `development` and the installed launcher `sentinel-supervisor` carry the
  sixteen #340 children, the throughput watchdog (self-improvement loop with
  the second guardrail set) and the fan-out corrections. Last observed cycle
  with fan-out: supervisor run 42027706441, green end to end.
- The upkeep-deferral notice as an owner issue and the widened repository
  cells are both on `development`. No worktree deliveries are pending.
- Two integration lanes push to `development` (this throughput lane and the
  "hanging-PR" lane). Rule: merge `development` first, validate, push
  fast-forward only; last green installs. Never force-move the launcher.

## Open items, in priority order

1. Passport Actions billing (owner/GitHub admin). `ubiquity/passport.ubq.fi`
   CI job `deno` is red on its last six `main` commits with zero steps and no
   log (run 42059138235): the runner never starts. Every Passport merge relies
   on Sentinel backup CI. Fix the Actions spending limit or billing for the
   `ubiquity` org, then confirm one green `deno` run on `main`.
2. Router delivery check, live confirmation. `src/host/target-delivery-checks.ts`
   names `deploy` (CI workflow job, cloudflare/wrangler-action) for
   `ubiquity/ubq.fi-router`, read from the workflow file at `486b9cb`. Confirm
   on one real merge commit that the check-run name is exactly `deploy`
   (`gh api repos/ubiquity/ubq.fi-router/commits/<sha>/check-runs`). If it
   differs, correct the table entry; a wrong name parks every router delivery
   at its two-hour deadline.
3. Watchdog issues not admitted (open defect, 2026-11-05 20:30 UTC). The
   watchdog filed #359 and #360 (label `priority:2`, marker on body line 2).
   Supervisor run 42097043887 reports for the self target `openIssues 26,
   admitted 0, skippedIssues []`: intake saw them, admitted neither and
   recorded no skip reason. A worker was assigned to find the cause in
   `src/repair/loop-intake.ts` and its filters (App-authored issues? label
   convention? marker rules?) and to make every non-admission produce a skip
   row. If that fix is not on `development`, this is the first thing to do:
   until it lands, the self-improvement loop files issues nobody works on.
   Related: records for the closed children #324..#339 kept stepping in that
   run and their candidate PRs #341..#358 were not retired (the
   `retired_pulls` phase ran in 0 ms); same worker, same question for the
   closed-issue retirement path. Kill switch for filing: repository variable
   `SENTINEL_SELF_IMPROVE=off`.
4. Trains on targets whose CI does not run on `sentinel-trains/**` pushes: add
   a push trigger for that ref pattern in the target's CI workflow, or trains
   wait two hours and fall back to per-record delivery (see #330 entry).
5. Serial repair wall time. Measured: 82% of the serial pass's stepped time
   in run 42027706441 is 14 records (13 prospector-chrome-extension, one
   Sentinel) retrying a failing `candidate_preservation` push every two
   minutes and ending the run unchanged. Find why that push fails on
   prospector (ledger entry "Repository cells widened; serial-pass time
   measured") and bound the re-arm; this is the single biggest remaining
   wall-time item. Measure with the `sentinel_repair_fanout` line
   (`stepKinds`, `recordsDelegated`, `recordsSerialOwned`).
6. `refresh_per_merge` threshold stays `insufficient_data` until a producer
   records `refreshCommits` on the metrics collector (the refresh path in
   `src/repair/loop-carried-delivery.ts` / launcher base-advance).

## How to validate anything here

Deno 2.9.x; `deno task check`, `deno check tests/<dir>/*.ts`, the named test
file with the permission flags in `deno.json`'s `test` task, `deno fmt
--check`, `deno lint`, `deno task size:check`; every command under 300 s.
Hosted: push to `development`, CI must be green on the exact SHA; a workflow
file change needs a manual fast-forward of `sentinel-supervisor`, otherwise
dispatcher auto-follow installs it; the model-disabled bootstrap at
generation+1 is a health pass; read the finalize job log for
`throughput_metrics_write`, `sentinel_throughput_watchdog`,
`sentinel_repair_fanout`.
