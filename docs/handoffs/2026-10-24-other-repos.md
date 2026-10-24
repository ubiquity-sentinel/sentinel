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
- The owner also directed that Sentinel stop deferring to other people's PRs
  (the "existing PR hold"). That change is not live yet, see the Sentinel
  handoff. Once it is, Sentinel may also work an issue that has an open hand-fix
  PR. Merge or close hand-fix PRs promptly, or tell the Sentinel session which
  issues you are taking.
- Ten ai.ubq.fi PRs from forks (1284 to 1294) are open for issues 1281 to 1283.
  They are not Sentinel's.

## Limits

- Never add branch protection rules or rulesets on Sentinel's repository.
- Never commit credentials.
- ai.ubq.fi merges by Sentinel are blocked until `queue.proofActivated` is false
  in Sentinel. That change is prepared (see the Sentinel handoff) but not live
  yet. Hand-fix PRs merged by people are not affected.
