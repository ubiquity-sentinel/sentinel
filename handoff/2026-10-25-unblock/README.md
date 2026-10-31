# Handoff 2026-10-25 05:45 UTC: unblock Sentinel, backup CI live

Owner goals: "make sentinel stable in its intended runtime (github actions) to
simultaneously repair all outstanding issues in sentinel repo and ai.ubq.fi repo
... passport.ubq.fi is a bonus"; "Ok hurry up push and make it end to end
autonomous"; "Get them unstuck". The session was stopped at the owner's request
(out of tokens). The goal is not met yet; what remains is below.

## State (verified at handoff)

- Refs: `development` and `claude/friendly-mayer-pb4zy4` carry this handoff. The
  launcher `sentinel-supervisor`, the legs ref `sentinel-backup-legs` and the
  installed runtime are all at `e5a888244c`.
- Supervisor: 39 consecutive green runs (the latest completed at 05:16 on
  `e5a888244c`). The 04:05 run took 62 minutes (its repair job ran 54 minutes);
  it was green, but watch the duration.
- Backup CI (owner decision 2026-10-24; docs/backup-ci-spec.md) is live:
  - mode `on` by default (`vars.SENTINEL_BACKUP_CI` unset; `off` disables it);
  - act `v0.2.89` is pinned; legs take 1.5 to 2 minutes; at most 2 legs per pass
    (1 while matrix cells run); a pass runs about every 5 minutes (the
    dispatcher plus the `sentinel-scheduler` cron);
  - runner `916ad9eaff49fe9d` (leg revision 2). Calibration: 4 agreements, 1
    failure agreement, 0 false greens, 0 false reds; 5 agreements are needed, so
    one more pass calibrates it. Only then do backup results stand in for
    Passport's never-started checks.
  - Store: branch `sentinel-backup-ci`, file
    `v1/ubiquity/passport.ubq.fi/calibration.json`.
- Open issues:
  - **Sentinel (15):** 10 are `sentinel:skip` or owner actions.
    - #177 and #187 are protected-path parks of Sentinel's own authority code.
      PR 195 holds a queue-guard candidate for #187, but it flips a safety
      assertion and needs review before landing.
    - #164 waits.
  - **ai.ubq.fi (9):**
    - 6 protected-path parks: the candidates edit owner-protected files such as
      `docs/DECISIONS.md` and `scripts/`.
    - 1213 is parked after three model-route outages; edit the issue or change
      the route to re-arm it.
    - 1214 and 1283 wait on CI, because the **Gateway CI workflow
      (`deno-deploy.yml`) is `disabled_manually`**.
  - **Passport (71):**
    - 61 wait on CI that GitHub never starts (billing); backup CI covers them
      once calibrated.
    - 9 are protected-path parks.
    - 1 has uncertain task acceptance.

## Landed this session (on development, installed)

- `308b665dba`: #207, PR 211's diagnostic landed by hand. #214 was closed (one
  red CI run on a development push).
- `024d2c31c0`: stage-1 review fixes:
  - the prompt no longer sends `OWNER_LANDING_REQUIRED` runs into a dead-end
    lane;
  - the red-base delivery-line rule now applies only to heads with a review
    round left;
  - the CI resume pass has an attempt ceiling of 40, backs off by attempt and
    uses the base tip as a canary;
  - the outage notice is filed with `sentinel:skip`;
  - the notice's close now runs before its comment;
  - the follow-ups pass recognises the off-tip prefix;
  - the backup token gains `statuses: read`.
- `3116e210d0`: observed ai.ubq.fi merges are parent-checked unless the queue
  could have merged them.
- `eb26054f4c`, `2dc6e8038e`, `e5a888244c`: the leg's hosted fixes. The install
  no longer runs `chmod`; `act --version` gets a scratch HOME; prepare reads
  `in/backup-tree-<unit>/`; only real act config files refuse; `--gid=runner` is
  dropped; `BACKUP_CI_LEG_REVISION` is 2.
- Earlier (03:20 checkpoint in docs/build-status.md): stage 1 and the backup CI
  build.

## Next actions, in order

1. **Confirm calibration reaches 5, then confirm the stand-ins on live state.**
   Passport records should leave their CI waits for review and merge. The
   runtime's `sentinel_backup_ci_standin` lines are not re-emitted by the
   launcher, so observe the repair state instead. The tip `2cf5050f` needs its
   own stand-in.
2. **Check the consumers live.** The hosted audit lens for consumers (the
   runtime and launcher reading the store under each supervisor step's exact
   Deno flags) did not finish. If records stay waiting after calibration, look
   there first.
3. **Throughput.**
   - Backup legs: raise `BACKUP_CI_MAX_PARALLEL` and add tree-upload slots in
     `backup-ci.yml`. That is a workflow change, so advance both refs by hand.
   - The serial delivery line: one merge per repository per pass, and each merge
     forces every other record to refresh. The fix is the train (step 4).
4. **Delivery train (redesign C12).** Two unreviewed patches are in this
   directory:
   - `wp3.4-train-runtime-handoff.unreviewed.patch` (base `eb26054f4c`, 11
     files): the worker built it and its tests passed; its inertness and safety
     reviews were cut off.
   - `wp2.5-wp3.3-train-launcher.unreviewed.patch` (base `eb26054f4c`): the
     batch booking, train gates, build, CI, land and pass. The worker was
     stopped mid-build, and test status is unknown.

   Both must keep `deliveryTrainModeV1` at "off". Review them, test them with CI
   flags and integrate. Activation needs probes P1 to P5 and an audit
   (docs/redesign-2026-10-25.md §9).
5. **Base-repair lane.** Filing is off (`BASE_REPAIR_FILING_ENABLED = false`).
   Its re-review upheld 14 findings, none P0 or P1; fix them before enabling
   filing. The four P2s:
   - the listing is read oldest-first and is unusable for good at 2,000 App
     items;
   - an unreadable job read counts as red;
   - the hosted CI-fix text still says the checks passed on the base;
   - the same listing problem from a second lens.

   The P3s cover: protected paths for the jobs, never-started and resume files;
   status-only reds; a stale-tip issue that still costs an implementation; the
   relations read; and missing tests.
6. **Open P3s:**
   - an unreadable job read is counted as a real failure (stage-1 review);
   - a `status_only` step skipped on a green leg reads as `act_inconsistent`,
     because act logs skips only at Debug level. Passport has no such step.

## Saved patches in this directory

None of these is committed code, and none is reviewed. Apply each to a fresh
worktree at its base and review it first.

| Patch                                                  | Base         | What it is                                                                                                                                                         |
| ------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wp3.4-train-runtime-handoff.unreviewed.patch`         | `eb26054f4c` | Train runtime handoff (11 files). Built and tested by the worker; reviews cut off.                                                                                 |
| `wp2.5-wp3.3-train-launcher.unreviewed.patch`          | `eb26054f4c` | Batch booking and the launcher train (26 changes). The worker was stopped mid-build.                                                                               |
| `base-repair-fixes.partial.unreviewed.patch`           | `e5a888244c` | Fixes for the base-repair re-review findings (30 files). The worker was stopped before reporting, so test status is unknown. The findings are listed under step 5. |
| `issue-177-ci-configuration.wave1.unreviewed.patch`    | `8e23151516` | The Wave 1 worker's attempt at #177 (classify event-scoped CI aborts as `ci_configuration`). It was never integrated, and #177 is still open.                      |
| `review-ceiling-worker.wave2.superseded-in-part.patch` | `8e23151516` | A review-round-ceiling worker from the #155 era. Development already holds part of it (the #155 commit). Mine it, don't apply it.                                  |

## Owner actions (the session cannot do these)

- Set `SENTINEL_AUTO_FOLLOW` to `on` or delete it; while it is `off` the
  launcher does not advance after a push. The session's proxy refuses the
  Actions variables API.
- Re-enable ai.ubq.fi's Gateway CI (`deno-deploy.yml`), or the agent that owns
  ai.ubq.fi does it.
- Restore the `ubiquity` org's Actions billing or spending limit. Backup CI
  covers Passport meanwhile.
- Land the protected-path parks (6 on ai.ubq.fi, 9 on Passport, plus Sentinel
  #177 and #187), or give each issue a non-protected scope.

## Rules learned this session

- Run new tests under CI's exact flags:
  `--allow-read=.,/usr,/bin,<deno> --allow-env=PATH,NODE_V8_COVERAGE`. Keep test
  temp dirs under `.`, not `/tmp`.
- Deno refuses every write to a path granted in `--allow-run`.
- A workflow-file change needs both `sentinel-supervisor` and
  `sentinel-backup-legs` advanced by hand. Bump `BACKUP_CI_LEG_REVISION` when
  leg behaviour changes; that gives a new runner id, which calibrates afresh and
  inherits no backoff.
- Do not run `deno fmt` on `docs/backup-ci-spec.md`: it reflows the whole file.
