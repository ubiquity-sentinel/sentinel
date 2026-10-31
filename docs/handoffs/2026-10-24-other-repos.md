# Handoff: hand-fix reserved-file issues in ubiquity/ai.ubq.fi and ubiquity/passport.ubq.fi

Owner directive (2026-10-24): hand-edit the files Sentinel's AI is not allowed
to touch, so these parked issues get fixed.

## Context

Sentinel (ubiquity-sentinel/sentinel) repairs issues in both repositories
autonomously. For each issue below, its AI produced a fix that edits a
_reserved_ file, so Sentinel parked the issue as "candidate touches a protected
path" and never published it.

The reserved lists are in `ubiquity-sentinel/sentinel`, file
`src/host/target-policy.ts`:

- **ai.ubq.fi** (`GATEWAY_PROTECTED_PATHS`):
  - `.github/workflows/`, `AGENTS.md`, `docs/DECISIONS.md`
  - `deno.json`, `deno.lock`, `package.json`, `bun.lock`, `bunfig.toml`
  - `tsconfig*.json`, `knip.json`, `ops/`, `tools/lint/`, `scripts/*`
  - `src/sentinel/`, `src/config.ts`, `src/runtime-config.ts`, `src/kv.ts`,
    `src/auth/`, `src/api-keys*.ts`
  - `src/codex/auth*.ts`, `src/codex/native-auth*.ts`,
    `src/codex/supervisor-secret.ts`, and similar.
- **passport.ubq.fi** (`PASSPORT_PROTECTED_PATHS`):
  - `.env`, `.npmrc`, `AGENTS.md`, `docs/DECISIONS.md`, `docs/CLOUDFLARE.md`
  - `.github/workflows/`, `package.json`, `bun.lock`, `bunfig.toml`,
    `deno.json`, `deno.lock`
  - `tsconfig*.json`, `wrangler.jsonc`, `worker-configuration.d.ts`, `scripts/`,
    `kv-service/`

## Issues parked on reserved files (from Sentinel state at 09:56 UTC)

- **ai.ubq.fi:** 116, 128, 139, 262, 427, 576, 603, 606, 607, 630, 634, 751,
  764, 785, 905, 906, 1018, 1019, 1020, 1021, 1022, 1023, 1041, 1125, 1126,
  1129, 1131, 1132, 1133, 1139, 1141, 1146, 1148, 1165, 1167, 1168, 1172, 1176,
  1178, 1182, 1210, 1211
- **passport.ubq.fi:** 8, 45, 48, 54, 56, 61, 132, 133

Many ai.ubq.fi numbers may already be **closed**: Sentinel's records outlive
closed issues until it revisits them. Check each issue's state first and skip
closed ones.

## What to do per open issue

1. Read the issue and the repository's own `AGENTS.md`/`CLAUDE.md` rules.
2. Make the fix by hand, including the reserved-file edits, on a branch. Follow
   that repository's normal PR, review and CI flow: these are not Sentinel PRs.
3. Mention `Resolves #N` so the issue closes on merge.

## Coordination with Sentinel

- Sentinel will not start a competing repair once the issue is closed. Its
  record then retires as "source issue is closed".
- Sentinel no longer defers to other people's PRs (the "existing PR hold"). The
  change (`f2db8fc948`) is live since the 12:44 UTC install of `62af807857`, so
  Sentinel may also work an issue that has an open hand-fix PR. Merge or close
  hand-fix PRs promptly, or tell the Sentinel session which issues you are
  taking.
- Thirteen Passport candidates (PRs 143, 146, 158, 170, 173, 175–182) sit at
  `work` on an uncharged, re-armed `backoff` since about 08:44 UTC. That is the
  CI-first gate's shape for "the same check is red on the base", so Passport's
  own `development` CI most likely has a red check (inferred from state; this
  session cannot read Passport's check runs). If so, fixing that base check
  unblocks them all.
- The same red base also holds 23 reviewed Passport PRs (138–169, issues 6–68)
  at `delivery` since 05:06 UTC (checked 14:15 UTC with the shipped
  delivery-line code). Their bases moved, so each needs one refresh, and
  Sentinel refreshes one record at a time. Three of the red-base candidates (PRs
  143, 146 and 158) sit on the current tip waiting for their CI, so they stand
  ahead in that line and hold all 23. Each base recheck raises their stall count
  by one; they stop holding at 12, around 17:00 UTC. Refreshed heads would still
  meet the red base, so a green Passport base is the actual fix.
- Ten ai.ubq.fi PRs from forks (1284 to 1294) are open for issues 1281 to 1283.
  They are not Sentinel's.

## Update 19:40 UTC: ai.ubq.fi open issues and what blocks each

Ten ai.ubq.fi issues are open. #300 is closed: commit 0c120c11f6 fixed it on
2026-09-22, and Sentinel's runs found nothing to change.

| Issue      | State in Sentinel                                   | What it needs                                                                                                                                  |
| ---------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1283       | Sentinel PR 1295 at `ci_pending`                    | Base evidence, see below. Its `rust-native` failure is `cargo fmt --check` in `rust/crates/gateway-admin/src/audit.rs`, a file the PR changed. |
| 1214       | Sentinel PR 1256 at `ci_pending`                    | Base evidence, see below. `validate` and `portable` fail.                                                                                      |
| 1249       | Sentinel PR 1257 parked at the review-round ceiling | A hand fix, or the owner's decision on the parked PR.                                                                                          |
| 1281, 1282 | Parked: candidate edits `src/auth/` (reserved)      | Hand fix in `src/auth/passport.ts`.                                                                                                            |
| 1210, 1211 | Parked: candidate edits `ops/gpg-dsh.sh` (reserved) | Hand fix.                                                                                                                                      |
| 1182       | Parked: candidate edits `ops/gpg-dsh.sh` (reserved) | Hand fix, or a documented quiescence step.                                                                                                     |
| 1176       | Parked on reserved docs/scripts                     | Item 1 is owner-only; items 2 to 4 are a test and doc edits.                                                                                   |
| 1213       | Index of the four findings                          | Close it once 1210 and 1211 are closed; 1209 and 1212 are already closed.                                                                      |

**Root cause of the two `ci_pending` PRs.** Gateway CI runs only on
`pull_request: [closed]` and `workflow_dispatch`. A closed-PR run attaches its
check runs to the PR head, not to the merge commit, so the ai.ubq.fi
`development` tip (3393df1e78) has no check runs at all. Sentinel attributes a
red head by comparing it with the same checks on the base. With none, every red
ai.ubq.fi head is "unattributed", waits up to 6 hours and parks, and no CI fix
can start.

- Sentinel side (in progress in this session): the pre-merge dispatcher will
  also dispatch Gateway CI once on `development` when a red head's base has no
  run, so the base gets its own check runs.
- ai.ubq.fi side (owner action, Sentinel #181): `scripts/test-scope.ts` grants
  the complete check set to `pull_request`, `push` and `merge_group` events
  only. Opted-in `workflow_dispatch` runs get the scoped set, so a head and its
  base can run different jobs. Granting the complete set to dispatch runs with
  `base_ref=development` and `sentinel_pr_author=ubiquity-sentinel[bot]` makes
  the comparison like-for-like. The file is reserved for Sentinel, so this is a
  hand edit.
- Several contributors have open bounty PRs for 1281 to 1283 (1284 to 1298).
  They are not Sentinel's.

## Limits

- Never add branch protection rules or rulesets on Sentinel's repository.
- Never commit credentials.
- `queue.proofActivated` is false and live (#180 closed). Sentinel has merged
  ai.ubq.fi PRs 1254, 1255 and 1258; their issues stay open until a VPS release
  is accepted, because the release path is disabled.
