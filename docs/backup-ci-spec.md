# Backup CI in the ubiquity-sentinel org: final implementation spec (revision 2)

This revision is read-only: nothing was edited, committed or pushed. It is grounded at HEAD `4dd3144b56`, a docs-only commit on top of `7ec6d91185`. The never-started package (WP0) has not landed yet: `grep notStarted src ops` finds only an unrelated use in `src/contracts/hosted-supervisor.ts`. HEAD now also contains `docs/redesign-2026-10-25.md`, whose C2 and C7 sections cover the same ground. §19 reconciles them. The act and GitHub runner behaviours I rely on are listed as hosted-only assertions in §15, and a self-test checks them on every leg. If one is false, the leg fails closed and reports no evidence. It never produces a green.

---

## 1. What changed from the reviewed design

1. **Untrusted legs leave the `sentinel-supervisor` ref (fixes A5).**
   - Every unit runs as its own `backup-ci-leg.yml` run, dispatched at the dedicated ref `refs/heads/sentinel-backup-legs`.
   - That run has no environment and `permissions: {contents: read, actions: read}`.
   - So its cache scope, artifacts and run identity are all separate from every job that holds the App key.
2. **bwrap is gone from the leg.**
   - The isolation boundary is now the leg VM, which holds nothing of value.
   - The sandbox's fidelity losses (no `sudo`, read-only `/usr`, a tmpfs home, cleared env, the DNS trap) were producing reds that only existed in backup. Those reds charged fixes and filed base repairs.
   - Once the VM carries no Sentinel authority, the sandbox's security benefit is gone. Target code decides its own verdict, exactly as it does natively (§13).
3. **act runs in host mode on the same hosted image the target job names.**
   - It runs from an empty working directory, with explicitly empty env, secret, var and input files.
   - It runs inside a clean `systemd-run` service with the private-runner size (2 CPU, 7 GiB) and kill-on-exit.
4. **Substitution rules.** Stand-ins are decided per (workflow path, check name), across **all attempts** (`filter=all`), all-or-nothing, per observation event. They also require the receipt's runner to be **calibrated** for the target.
5. **Pull-request units use the record's reviewed base B.**
   - B must be an ancestor of the head H. The trusted job builds the synthetic merge M = parents `[B, H]`, tree(H).
   - For every base contained in H that is exactly the pull request merge tree, and v1 refuses steps that read the base. GitHub's `refs/pull/N/merge` is no longer needed.
6. **The v1 job shape is narrower.** It refuses:
   - `needs` or a job-level `if` anywhere in the workflow;
   - any event, ref, actor, `ACT` or `github.event` reference, in expressions, in `run:` text, or in tracked source;
   - checkout inputs other than the defaults;
   - Docker actions.
   
   Success also requires a record of every planned step.
7. **Every red is confirmed by a second leg.** This is the backup equivalent of the native once-per-head flake re-run.
8. **Store transport and writer.**
   - Reads use anonymous git (`ls-remote` plus a shallow fetch of the store branch), not REST.
   - The only writer is the trusted `backup_ci` job, using its native `GITHUB_TOKEN`, the same token class as the `sentinel-state/*` writes.
9. **No `pending` entries at plan time.** `dispatched` entries carry the trusted unit. Each pass resolves them by looking up the leg run.
10. **The mode gates consumers too.** Shadow results are never final for `on`.
11. **Correction evidence comes from the receipt in v1,** not in a later stage.
12. **Concurrency.** At most 2 legs, admitted at dispatch time (1 while supervisor cells are active), plus one short trusted job per 5-minute dispatch.

## 2. Critique disposition

The first critique set is A1–A17. The second set is B1–B23, plus its P3 notes.

| # | Disposition |
|---|---|
| A1 act config files | **Adopted.** act runs with cwd = an empty directory and `-C <ws>`. Env, secret, var and input files are explicit empty paths outside ws. `--use-gitignore=false`, `--actor ubiquity-sentinel[bot]`. The real HOME is asserted free of `.actrc` and `~/.config/act`. The planner refuses `.actrc`, `.env`, `.secrets`, `.vars` or `.input` at the tree root. Those names are added to Passport's protected paths. The self-test plants all five and asserts none applies. |
| A2 `filter=latest` hides attempts | **Adopted.** Eligibility reads `filter=all`. A stand-in is refused if any attempt of the name ever started, if a commit status has that context, if another app reports the name, or if the name comes from more than one path. Original timestamps are kept. |
| A3 dependents read green | **Adopted.** Any `needs`/job-level `if` in the workflow refuses the whole workflow. Per-commit coverage requires every expected rendered name. |
| A4 billing annotation | **Adopted, as substitution eligibility.** The planner requires the account-billing annotation on a never-started run of the group. WP0's shape-only "no evidence" classification is safe as is, because it is never green and never red. |
| A5 cache scope | **Adopted.** Dedicated legs ref and separate run. No cache restore anywhere at `sentinel-supervisor` or in legs (YAML test). `setup-bun no-cache: true`. |
| A6 sandbox gaps | **Moot (bwrap removed).** Log-command neutralization is **adopted**: `::stop-commands::<random>`, escaping of `::` and `##[`, a prefix, chunks of at most 4 KiB, a 4 MiB cap. |
| A7 trusted job and target content | **Adopted hardening:** bare-repo fetch only, then `git cat-file`/`git grep`/`ls-tree` with mode checks; size and alias bounds; token through `GIT_CONFIG_*` env; cleared child env; `core.hooksPath=/dev/null`, `core.fsmonitor=false`, https only, no submodules; token-value scan of the tar; only hex, enum and integer values to outputs or logs; checkout happens in the leg. **Rejected:** splitting the plan and the store write onto separate VMs. The trusted job never executes target code, and a split adds a slot and a trusted-data handoff for marginal gain. |
| A8 `off` and planted receipts | **Adopted:** consumers substitute only with mode `on`, a calibrated runner and a matching `repository.id`. **Rejected:** verifying every entry against its ingest run on each read. The store has the same trust root as `sentinel-state/*`, which already carries more authority, and per-read log fetches cost API budget. |
| A9 context binding | **Adopted.** A `pull_request` observation takes only a `pull_request` entry. A push observation takes push or `pull_request` (same tree, event-independent steps in v1). Entries are keyed by base, and any verified base contained in the head is accepted (§11.1). |
| A10 synthetic context | **Adopted.** Event, ref, actor and ACT references are refused. The payload comes from the real PR object. Success requires every planned main step. |
| A11 environment gaps | **Adopted.** Stand-ins (and so base repair) require per-runner calibration. Correction evidence is labelled as backup. Removing the sandbox removes most of the gaps. |
| A12 "unrun" over "red" | **Adopted.** Exit 127 is red. Only allowlisted setup actions give no evidence. A job act skipped is no evidence, but the candidate cannot cause it (job `if` refused). Masking is closed. |
| A13 side effects | **Adopted.** Event and ref conditionals are refused, and secrets are absent. |
| A14 ingest starvation | **Adopted.** Decompression bounded to 64 KiB, errors caught per unit, a time budget per target, `leg_missing` not counted. |
| A15 Docker stage | **Adopted** as the stage-5 entry conditions. |
| A16 ingest checks | **Adopted.** Hosted runner group, artifact `workflow_run` head SHA and repository id, resolution by id only. |
| A17 shadow finality | **Adopted.** Finality is per mode. |
| A concurrency | **Adopted.** p ≤ 2, admitted at dispatch, leg timeout = unit cap + 10 minutes. |
| A token table | **Adopted**, except that `actions: write` stays in the trusted job. It is needed to dispatch and cancel legs, and that job runs only launcher code. |
| B1 push for pull_request | **Adopted** (see A9). |
| B2 `needs` and coverage | **Adopted** (A3 plus the receipt's `expected` coverage). |
| B3 name collisions | **Adopted.** Keys are (path, name); a name under two paths is refused. |
| B4 act success without running | **Adopted.** Exactly one job result; every planned step recorded; act exit 0 must agree with the JSON; condition and checkout allowlists. |
| B5 tar modes | **Adopted.** A bare repo is shipped, `git clone`/`checkout` happens in the leg, `git status --porcelain` must be empty, and the observed binding is captured before target code runs. |
| B6 leftover never-started | **Adopted** as an invariant in both layers. |
| B7 flaky reds | **Adopted, as two-leg confirmation.** A red stays provisional (no evidence) until a second leg runs. With WP0's re-runs, `readCiRerunSettled` then needs no change (§11.6). |
| B8 correction evidence | **Adopted in v1.** |
| B9 sandbox-only reds | **Mostly moot.** Base repair is gated by calibration. **Rejected:** "same context only" attribution. Native attribution already compares a `pull_request` head against a push base, and v1 refuses event-dependent steps. |
| B10 shadow | **Adopted** (= A17). |
| B11 suspension | **Adopted:** false-green-only, scoped to the runner id, lifted automatically when a new runner id passes calibration, primary can clear it. **Rejected:** time-based expiry, which would re-enable a runner known to give a false green. **Rejected:** an uncached read before merge. The tip TTL is 10 s, and a suspension concerns a different commit, so a merge inside that window is equivalent to merging 10 s earlier. |
| B12 train strands heads | **Adopted.** B is the reviewed base and an ancestor of H; M is built locally. |
| B13 record set | **Adopted.** The candidate set is derived from exported launcher predicates (§9.3). |
| B14 native head red, backup-only base | **Adopted.** A head peer unit is planned. A never-started base without backup is unattributed, never `baseRed`. |
| B15 rollback divergence | **Rejected: gating on a runtime allowlist.** Verified backup evidence is valid evidence under the owner decision. If one layer lacks it, that layer sees never-started (no evidence) and waits. That fails closed and never causes a false merge. **Rejected: a required parameter**, which would touch 37 client and 11 launcher test call sites. **Adopted:** composition tests that fail if a production path omits the reader. |
| B16 pending contradiction | **Adopted.** The never-started set is read from GitHub every pass. |
| B17 attempt accounting | **Adopted.** Backoff of 15 min, 1 h, 4 h, 24 h; only legs that ran count. |
| B18 concurrency arithmetic | **Adopted.** **Rejected as out of scope:** capping cells, which is an owner throughput decision (§14). |
| B19 `GITHUB_TOKEN` budget | **Adopted.** git transport for reads. |
| B20 anonymous setup rate limits | **Adopted** as a hosted assertion plus `setup_action_failed` backoff. **Rejected for v1:** giving act a token. Target code would control a shared sentinel-repo or installation rate budget. |
| B21 kick cadence | **Adopted.** The dispatcher dispatches every 5 minutes. |
| B22 two failure classes | **Adopted.** 127 is red; only allowlisted setup actions give no evidence. |
| B23 hosted assertions | **Adopted** (§15), and checked continuously by the self-test. |
| P3 per-target cap | **Adopted** (cap = p). |
| P3 shared uid/pid | **Accepted residual:** verdict integrity is equal to native (§13). |
| P3 runner size | **Adopted** (2 CPU / 7 GiB service limits). |
| P3 `off` semantics | **Moot:** `off` now disables consumers. |
| P3 merge audit | **Adopted:** a `sentinel_backup_ci_standin` line naming the receipt. |

---

## 3. Architecture and trust boundaries

```
supervisor-dispatch.yml (default branch, every 5 min; native token, actions:write)
  └─ if vars.SENTINEL_BACKUP_CI ∈ {shadow,on}: dispatch backup-ci.yml @ sentinel-supervisor

backup-ci.yml @ sentinel-supervisor  [concurrency sentinel-backup-ci; ≤1 running + 1 pending]
  backup_ci  TRUSTED (env sentinel-supervisor; App key → target read token; native token contents:write, actions:write)
    pass:   identity → ingest finished legs → plan ≤ free units → materialize bare repos → .tar per slot
    upload: ≤ 2 tree artifacts (1-day)
    commit: fast-forward sentinel-backup-legs → one CAS store commit → dispatch one leg run per unit

backup-ci-leg.yml @ sentinel-backup-legs  [one run per unit; no environment; contents:read, actions:read]
  leg  UNTRUSTED  download tree (cross-run, by id) → verify → self-test → act (host mode, systemd service)
                  → result.json artifact → marker line

readers (no writes; anonymous git): runtime readChecks ◀── sentinel-backup-ci ──▶ launcher readCompleteCheckRuns
```

| Job | Credentials it holds | What it runs |
|---|---|---|
| `backup_ci` | App key (in memory) and target read token: `ubiquity` installation, enabled targets only, contents, pull_requests, checks and actions **read**. Native `GITHUB_TOKEN`: `contents: write`, `actions: write`. | Launcher code only. Target bytes are read as data through `git cat-file`/`git grep`/`ls-tree` on a bare repo, plus a bounded YAML parse. |
| `leg` | Native `GITHUB_TOKEN` (`contents: read`, `actions: read` on the **public** sentinel repo; nothing beyond what any signed-in user can read). Runtime token for its own run: cache scope is the legs ref, never restored by a trusted job; its artifacts are read only by the id named in the marker. | Target code via act. No target token, no App key, no environment. |
| Consumers (maintenance launcher, runtime in matrix_plan, matrix_cell and repair) | None for the store: reads are anonymous git. | Read the store only. |

---

## 4. Runner choice

**Chosen: nektos/act, pinned by version and sha256, in host mode (`-P <label>=-self-hosted`), on a dedicated leg VM that uses the target job's own hosted label.**

- **Fidelity.** The leg runs on the same runner image and toolcache, with `sudo`, Docker on the VM, the real HOME and `/etc/environment`, and the target's real action code. A false green can cause a bad merge, and real action code avoids most of the ways a hand-written runner would produce one.
- **Security.** The leg VM is the boundary (§13).

**Rejected alternatives:**
- **Minimal step runner.** Every shim for checkout and `setup-*` is a source of false greens.
- **act in Docker.** The catthehacker images differ from the hosted image, which gives false reds. Image pulls of several GB are an infrastructure failure mode. The Docker socket hands the target a further input surface. This is deferred to stage 5, for `services:` and `container:`, under the A15 entry conditions.
- **act in bwrap (revision 1).** See §1.2.
- **A mirror repository (redesign C7).** See §19.

**Pin.** `ops/backup-ci-pins.json` holds:
```json
{ "act": { "version": "vX.Y.Z", "releasedAt": "YYYY-MM-DD", "asset": "act_Linux_x86_64.tar.gz", "sha256": "<64 hex>" }, "node": "24.19.0" }
```
- The values come from the release's `checksums.txt` and are recorded at implementation time. Pick the newest release that is at least 14 days old.
- A test rejects placeholders and any release younger than 14 days.
- `runnerId = hex16(sha256(canonical({act, node, legRevision: BACKUP_CI_LEG_REVISION})))`.

---

## 5. v1 supported shape (planner, `ops/backup-ci-workflow-map.ts`)

A refusal is recorded as `no_evidence` `unsupported:<reason>` and is final per commit, since the workflow blob is fixed at a commit. All parsing works on `git cat-file` bytes.

**Workflow level**
- The path matches `^\.github/workflows/[A-Za-z0-9._-]{1,64}\.ya?ml$`, its `ls-tree` mode is 100644, it is at most 256 KiB, it parses with `@std/yaml`, and it has at most 20,000 nodes. Any object reached twice means an alias was used and is refused. Reason: `workflow_unreadable`.
- Top-level keys are a subset of {name, run-name, on, permissions, env, defaults, concurrency, jobs}. Workflow `env`/`defaults` must pass the expression rules.
- No job in the file has `needs` or a job-level `if` (`needs_or_job_if`), and none is a reusable job-level `uses:` (`reusable`).

**Target job**
- Keys are a subset of {name, runs-on, timeout-minutes, steps, strategy, env, defaults, permissions, concurrency, outputs, continue-on-error (false)}.
- No `services`, `container` or `environment`.
- `runs-on` is one literal label from {`ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`}.
- `strategy.matrix` has scalar axes only, no include/exclude, and at most 16 combinations.
- `name` is a literal, or contains only `${{ matrix.<axis> }}`.
- `timeout-minutes` is a literal integer of at most 360, or absent. The effective cap is `min(t ?? 360, 60)`.
- **Name rendering.** GitHub renders `name ?? key`, and appends ` (v1, v2, …)` in axis order when the name has no matrix expression. Exactly one (job, combination) in the file may render to the never-started name, and the name must match `CI_CHECK_NAME_PATTERN` (`name_unmapped`).

**Steps**
- Each step is exactly one of `run`, `uses: ./path`, or `uses: owner/repo[/path]@ref` (no `docker://`).
- Remote and local actions are resolved: `action.yml` (or `.yaml`) at that ref, fetched anonymously from `raw.githubusercontent.com` and cached per pass. `runs.using` must be `node20`, `node24` or `composite` (`docker_action`). Composite actions are resolved recursively to depth 3, at most 20 actions in total.
- `actions/checkout` `with:` keys are a subset of {persist-credentials, clean, show-progress, fetch-depth: 1}; `submodules` and `lfs` must be absent or false (`checkout_inputs`).
- A step `if:` must be absent or contain only status functions (`success()`, `failure()`, `always()`, `cancelled()`) with `!`, `&&` and `||` (`step_condition`).
- **Expression allowlist.** Every `${{ }}` in `run`, `with`, `env`, `name`, `working-directory` and `shell` may use only:
  - `matrix.*`;
  - `steps.<id>.{outputs.*, outcome, conclusion}`;
  - `env.<NAME>` with NAME ≠ `ACT`;
  - `runner.{os, arch, temp, tool_cache}`;
  - `github.{workspace, repository, repository_owner, server_url, api_url, run_id, run_number, run_attempt, job, action_path}`;
  - `strategy.{job-index, job-total}`, `job.status`;
  - the functions contains, startsWith, endsWith, format, join, toJSON, fromJSON and hashFiles, and literals.
  
  Everything else is refused, including `secrets.*`, `vars.*`, `github.token`, `github.event*`, `github.ref*`, `github.sha`, `github.base_ref`, `github.head_ref`, `github.actor`, `github.triggering_actor`, `needs` and `inputs` (`expression_context`, `secrets_or_vars`, `token`).
- **`run:` text** must not reference `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_REF`, `GITHUB_REF_NAME`, `GITHUB_BASE_REF`, `GITHUB_HEAD_REF`, `GITHUB_ACTOR`, `GITHUB_TRIGGERING_ACTOR`, `GITHUB_TOKEN` or `ACT` as a variable (`context_reference`).

**Tree**
- No `.actrc`, `.env`, `.secrets`, `.vars` or `.input` at the root (`act_config_file`).
- `git grep -I -E --max-count=1` over tracked files at the commit (bounded to 2,000 files of interest and 30 s) for env reads of `ACT`, `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_BASE_REF`, `GITHUB_HEAD_REF`, `GITHUB_REF`, `GITHUB_REF_NAME` or `GITHUB_ACTOR` (`process.env.X`, `Deno.env.get("X")`, `env.X`, `$X`, `${X`, `getenv("X")`). Any match is `context_reference`.

**Observations**
- Every observation of the group is app `github-actions` (`other_app`).
- There is no commit status with the same context (`status_context`).
- There is one path per name (`mixed_paths`).
- At least one never-started run of the group carries the account-billing annotation, from `GET /check-runs/{id}/annotations`. The message must match `/recent account payments have failed or your spending limit needs to be increased|account is locked due to a billing issue/` (`not_account_cause`).
- The target's live `repository.id` equals the id in `sentinel.backup-ci-targets.json` (`repository_id`).

---

## 6. Contracts

### 6.1 `src/contracts/backup-ci.ts` (WP1, new, at most 500 lines)

```ts
export const BACKUP_CI_STORE_REMOTE = "https://github.com/ubiquity-sentinel/sentinel.git";
export const BACKUP_CI_STORE_REF = "refs/heads/sentinel-backup-ci";
export const BACKUP_CI_LEGS_REF = "refs/heads/sentinel-backup-legs";
export const BACKUP_CI_RUN_REF = "refs/heads/sentinel-supervisor";
export const BACKUP_CI_WORKFLOW_PATH = ".github/workflows/backup-ci.yml";
export const BACKUP_CI_LEG_WORKFLOW_PATH = ".github/workflows/backup-ci-leg.yml";
export const BACKUP_CI_LEG_JOB = "leg";
export const BACKUP_CI_LEG_STEPS = ["Prepare and verify the unit", "Run the target job",
  "Upload the backup result", "Report the backup result"] as const;  // must appear in order
export const BACKUP_CI_LEG_REVISION = 1;            // bump when leg semantics change → new runnerId
export const BACKUP_CI_MAX_PARALLEL = 2;
export const BACKUP_CI_MAX_JOB_MINUTES = 60;
export const BACKUP_CI_LEG_SETUP_MINUTES = 10;
export const BACKUP_CI_MAX_COMMITS_READ_PER_TARGET = 12;
export const BACKUP_CI_MAX_INGEST_PER_PASS = 32;
export const BACKUP_CI_TARGET_BUDGET_MS = 60_000;
export const BACKUP_CI_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 4 * 3_600_000, 24 * 3_600_000];
export const BACKUP_CI_RETRY_MS = 10 * 60_000;      // planning/infra refusals that ran no leg
export const BACKUP_CI_LEG_MISSING_MS = 30 * 60_000;
export const BACKUP_CI_TIP_TTL_MS = 10_000;
export const BACKUP_CI_MAX_TREE_BYTES = 256 * 2 ** 20;
export const BACKUP_CI_MAX_FILE_BYTES = 256 * 1024;
export const BACKUP_CI_MAX_RESULT_BYTES = 64 * 1024;
export const BACKUP_CI_MAX_EXCERPT_BYTES = 8 * 1024;
export const BACKUP_CI_CALIBRATION = { agreements: 5, failureAgreements: 1, maxFalseReds: 1 } as const;
export const BACKUP_CI_RUNNER_LIMITS = { cpus: 2, memoryGiB: 7 } as const;
export const BACKUP_CI_SETUP_ACTIONS = ["actions/checkout", "actions/setup-node", "actions/setup-python",
  "actions/setup-go", "actions/setup-java", "actions/cache", "denoland/setup-deno",
  "oven-sh/setup-bun", "pnpm/action-setup"] as const;

export type BackupCiModeV1 = "off" | "shadow" | "on";
export function parseBackupCiMode(raw: string | undefined): BackupCiModeV1; // exact "on" | "shadow", else "off"
export type BackupCiContextV1 = "push" | "pull_request";
export type BackupCiRedV1 = "failure" | "timed_out";
export type BackupCiConclusionV1 = "success" | BackupCiRedV1;

export type BackupCiUnsupportedV1 = "runs_on" | "services" | "container" | "environment"
  | "needs_or_job_if" | "reusable" | "matrix_shape" | "job_name" | "secrets_or_vars" | "token"
  | "step_shape" | "step_condition" | "expression_context" | "checkout_inputs" | "docker_action"
  | "action_unresolved" | "timeout" | "name_unmapped" | "act_config_file" | "context_reference"
  | "coverage" | "workflow_unreadable" | "workflow_path" | "not_account_cause" | "other_app"
  | "status_context" | "mixed_paths" | "head_not_on_base" | "repository_id" | "tree_too_large";
export type BackupCiNoEvidenceReasonV1 =
  | `unsupported:${BackupCiUnsupportedV1}`
  // ran no leg (not counted; BACKUP_CI_RETRY_MS):
  | "pr_not_open" | "pr_moved" | "fetch_failed" | "dispatch_failed" | "legs_ref_behind"
  | "leg_missing" | "ingest_error"
  // a leg ran (counted; BACKUP_CI_BACKOFF_MS):
  | "leg_failed" | "leg_cancelled" | "leg_stuck" | "marker_missing" | "log_unserved"
  | "artifact_missing" | "artifact_invalid" | "digest_mismatch" | "binding_mismatch"
  | "result_invalid" | "selftest_failed" | "setup_action_failed" | "act_internal"
  | "act_inconsistent" | "skipped_in_backup" | "runner_timeout";
export function noEvidenceLegRan(reason: BackupCiNoEvidenceReasonV1): boolean;

export interface BackupCiTargetV1 { repository: `${string}/${string}`; id: number }  // sentinel.backup-ci-targets.json
export interface BackupCiEntryKeyV1 {
  context: BackupCiContextV1; workflowPath: string; checkName: string;
  base: GitSha | null;            // pull_request only
  attempt: 1 | 2;                 // 2 = confirmation of a red attempt 1
}
export interface BackupCiPlannedStepV1 {
  index: number; actStepId: string; kind: "run" | "uses_local" | "uses_remote";
  uses: string | null; condition: "none" | "status_only"; continueOnError: boolean;
}
export interface BackupCiUnitV1 {
  version: 1; kind: "sentinel_backup_ci_unit";
  unitId: string;                 // hex24(sha256(canonical(unit minus unitId/plan)))
  purpose: "stand_in" | "confirm" | "peer" | "calibration";
  key: BackupCiEntryKeyV1;
  repository: { owner: string; name: string; id: number; defaultBranch: string; private: boolean };
  commit: GitSha;                 // the commit the check is about (head or base)
  exec: { commit: GitSha; parents: GitSha[]; tree: GitSha; synthetic: boolean };  // M for pull_request
  pullRequest: { number: number; base: GitSha; baseRef: string; headRef: string } | null;
  ref: string;                    // refs/pull/N/merge | refs/heads/<branch>
  workflow: { path: string; blob: GitSha; name: string };
  job: { key: string; matrix: Record<string, string | number | boolean> | null; checkName: string;
         runsOn: "ubuntu-latest" | "ubuntu-24.04" | "ubuntu-22.04";
         capMinutes: number; targetTimeoutMinutes: number | null };
  steps: BackupCiPlannedStepV1[]; // ≤ 100, main stage only
  event: Record<string, unknown>; // ≤ 16 KiB, allowlisted keys (§9.4)
  neverStarted: { checkRunIds: number[]; runIds: number[]; cause: "account_billing" } | null;  // ≤ 16
  native: { checkRunId: number; conclusion: string } | null;   // peer/calibration
  plan: { runId: number; launcherSha: GitSha; plannedAt: number; mode: "shadow" | "on"; runnerId: string };
}
export function backupCiUnitDigest(unit: BackupCiUnitV1): string;   // sha256(canonicalStringify(unit))

/** UNTRUSTED leg output. It contains no target-derived text. */
export interface BackupCiResultV1 {
  version: 1; kind: "sentinel_backup_ci_result"; unitId: string; unitDigest: string;
  observed: { head: GitSha; tree: GitSha; parents: GitSha[]; workflowBlob: GitSha; clean: true };
  selftest: "passed";
  outcome: BackupCiConclusionV1 | "no_evidence"; reason: BackupCiNoEvidenceReasonV1 | null;
  act: { exitCode: number | null; jobResults: number };
  steps: { index: number; result: "success" | "failure" | "skipped" | "cancelled" | "missing" }[];
  failingStep: number | null;
  startedAt: number; completedAt: number;
  runner: { runnerId: string; imageOs: string; imageVersion: string };  // [A-Za-z0-9._-]{1,32}
}

export interface BackupCiWorkflowCoverageV1 {
  path: string; blob: GitSha; event: BackupCiContextV1; observedAt: number;
  supported: boolean; reason: BackupCiUnsupportedV1 | null;
  expected: string[];             // every rendered check name of the file for that event (≤ 64)
}
export type BackupCiEntryV1 =
  | { state: "dispatched"; key: BackupCiEntryKeyV1; mode: "shadow" | "on"; runnerId: string;
      unit: BackupCiUnitV1; unitDigest: string; tree: { artifactId: number; sha256: string };
      dispatchedAt: number }
  | { state: "result"; key: BackupCiEntryKeyV1; mode: "shadow" | "evidence"; runnerId: string;
      purpose: BackupCiUnitV1["purpose"]; conclusion: BackupCiConclusionV1;
      unitDigest: string; resultDigest: string; startedAt: number; completedAt: number;
      binding: { execCommit: GitSha; parents: GitSha[]; tree: GitSha; workflowBlob: GitSha;
                 jobKey: string; matrix: BackupCiUnitV1["job"]["matrix"] };
      leg: { runId: number; jobId: number; artifactId: number; launcherSha: GitSha };
      native: { checkRunId: number; conclusion: string } | null;
      failure: { stepIndex: number; excerpt: string } | null;   // sanitized, ≤ 8 KiB
      ingestedAt: number }
  | { state: "no_evidence"; key: BackupCiEntryKeyV1; mode: "shadow" | "evidence"; runnerId: string;
      reason: BackupCiNoEvidenceReasonV1; legRuns: number; firstAt: number; lastAt: number;
      nextAt: number | null; final: boolean };
/** v1/<owner>/<repo>/<sha[0:2]>/<sha>.json */
export interface BackupCiCommitFileV1 {
  version: 1; kind: "sentinel_backup_ci_commit";
  repository: { owner: string; name: string; id: number }; commit: GitSha;
  workflows: BackupCiWorkflowCoverageV1[];   // ≤ 16
  entries: BackupCiEntryV1[];                // ≤ 128, sorted by canonical key
  updatedAt: number;
}
/** v1/suspended.json (scope "all") or v1/<owner>/<repo>/suspended.json */
export interface BackupCiSuspensionV1 {
  version: 1; kind: "sentinel_backup_ci_suspension"; scope: "all" | `${string}/${string}`;
  runnerIds: string[] | "all"; reason: "false_green" | "false_red" | "operator"; since: number;
  evidence: { commit: GitSha; checkName: string; nativeCheckRunId: number; receipt: string } | null;
}
/** v1/<owner>/<repo>/calibration.json */
export interface BackupCiCalibrationV1 {
  version: 1; kind: "sentinel_backup_ci_calibration"; repository: { owner: string; name: string; id: number };
  runners: { runnerId: string; agreements: number; failureAgreements: number;
             falseGreens: number; falseReds: number;
             samples: { commit: GitSha; checkName: string; native: string; backup: BackupCiConclusionV1 }[] }[];
  updatedAt: number;
}
export function isBackupCiCalibrated(c: BackupCiCalibrationV1 | null, runnerId: string): boolean;
  // agreements ≥ 5 && failureAgreements ≥ 1 && falseGreens === 0 && falseReds ≤ 1
export function backupCiCommitPath(owner: string, repo: string, sha: GitSha): string;
export function backupCiReceiptId(repo: string, commit: GitSha, key: BackupCiEntryKeyV1): string;
  // "bci1:<owner>/<repo>@<sha12>:<path>#<checkName>:<context>[:<base12>]:a<attempt>"
export function parseBackupCiUnit / parseBackupCiResult / parseBackupCiCommitFile /
  parseBackupCiSuspension / parseBackupCiCalibration / parseBackupCiTargets(input: unknown): ...;  // closed keys, bounded
```

### 6.2 `src/contracts/ports-github-requests.ts:74-89` (WP1; optional fields only, never persisted)

```ts
export interface GitHubCheckBackupV1 {
  receipt: string; context: BackupCiContextV1; runnerId: string; legRunId: number; legJobId: number;
}
export interface GitHubCheckV1 {
  /* existing fields */
  notStarted?: true;                                                   // WP0
  backup?: GitHubCheckBackupV1;                                        // stand-in for a never-started observation
  backupPeer?: { conclusion: BackupCiConclusionV1; receipt: string };  // attribution only
}
```

### 6.3 Pure substitution input (`src/github/backup-ci-substitute.ts`, WP1)

```ts
export interface BackupCiObservationV1 {
  checkRunId: number; name: string; app: string | null; suiteId: number | null;
  status: string; conclusion: string | null; startedAt: number | null; completedAt: number | null;
  notStarted: boolean | null;          // null = unknown → treated as started (fail closed)
}
export interface BackupCiSuiteV1 { suiteId: number; workflowPath: string; event: string }
export interface BackupCiSelectInputV1 {
  target: BackupCiTargetV1; commit: GitSha; mode: BackupCiModeV1;
  latest: BackupCiObservationV1[];     // the listing the caller will return (default filter)
  all: BackupCiObservationV1[];        // filter=all, every attempt
  suites: BackupCiSuiteV1[];           // GET /actions/runs?head_sha
  statusContexts: ReadonlySet<string>;
  file: BackupCiCommitFileV1 | null; suspensions: BackupCiSuspensionV1[];
  calibration: BackupCiCalibrationV1 | null;
}
export interface BackupCiStandInV1 {
  checkRunId: number; name: string; conclusion: BackupCiConclusionV1; backup: GitHubCheckBackupV1;
}
export interface BackupCiSelectionV1 {
  standIns: Map<number, BackupCiStandInV1>;    // keyed by latest checkRunId
  peers: Map<string, { conclusion: BackupCiConclusionV1; receipt: string }>;  // by name
  shadow: BackupCiStandInV1[];                 // computed but not applied (mode shadow)
  refusals: string[];                          // "<reason>:<trusted name>" for logs
}
export function selectBackupStandIns(input: BackupCiSelectInputV1): BackupCiSelectionV1;
export function resolveBackupEntries(entries: readonly BackupCiEntryV1[], ...): BackupCiConclusionV1 | null;
export function standInCheck(original: GitHubCheckV1, s: BackupCiStandInV1): GitHubCheckV1;
export function standInRawRun(raw: Record<string, unknown>, s: BackupCiStandInV1): Record<string, unknown>;
```

---

## 7. Receipt store

**Location.** Branch `refs/heads/sentinel-backup-ci` in `ubiquity-sentinel/sentinel`.
- It stays outside the `sentinel-state/` snapshot namespace (state-git.ts:22-23).
- No workflow triggers on it: ci.yml pushes only on master, development and `codex/**`; gateway-source-verify only on its own branch.
- Pushes made with the native token trigger nothing in any case.

**Layout:**
- `README.md`
- `v1/suspended.json` (optional, global)
- `v1/<o>/<r>/suspended.json` (optional, per target)
- `v1/<o>/<r>/calibration.json`
- `v1/<o>/<r>/<aa>/<sha>.json` (one per target commit)

**Writer (`ops/backup-ci-store-writer.ts`, WP3; trusted job only)**
- `writeBackupCiStore(git, tokenEnv, mutate: (read) => Changes)`:
  1. `git fetch --depth=1 --no-tags --no-auto-gc` the branch into a scratch repo; an absent branch means an orphan first commit.
  2. Apply `mergeBackupCiFile` / `mergeCalibration` / `mergeSuspension` (WP1, pure) to each touched file.
  3. Write blobs and a tree on the tip tree, and one commit whose parent is the tip, with message `sentinel-backup-ci: run <runId> attempt 1`.
  4. `git push origin <new>:refs/heads/sentinel-backup-ci`, not forced, so the push is fast-forward-only. A rejection means another writer moved the tip: re-read and retry up to 5 times.
- After success it prints `{"kind":"sentinel_backup_ci_store_commit","commit":"<sha>","parent":"<sha>"}`.

**Merge rules (`src/github/backup-ci-store.ts`, WP1, pure)**
- A `result` is final per (key, mode, runnerId). A later, different result for the same triple is dropped and logged as `sentinel_backup_ci_conflict`.
- A `result` replaces `dispatched` and non-final `no_evidence` entries for the same key and mode.
- `no_evidence`:
  - `legRuns += noEvidenceLegRan(reason)`;
  - `nextAt = lastAt + (legRan ? BACKOFF_MS[min(legRuns − 1, 3)] : RETRY_MS)`;
  - `unsupported:*` is final, with `nextAt: null`.
- `dispatched` is replaced by the result or `no_evidence` of the same unit digest.
- Mode `evidence` entries are never satisfied by `shadow` entries.
- Bounds are enforced. When over the bound, the oldest `no_evidence` entries are evicted first, and results never.

**Reader (`src/github/backup-ci-reader.ts`, WP1)**
```ts
export interface BackupCiReaderV1 {
  readonly targets: readonly BackupCiTargetV1[];
  target(repo: RepositoryIdentityV1): BackupCiTargetV1 | null;   // only listed repos are ever looked up
  read(repo: RepositoryIdentityV1, sha: GitSha): Promise<
    | { kind: "ok"; file: BackupCiCommitFileV1 | null; suspensions: BackupCiSuspensionV1[];
        calibration: BackupCiCalibrationV1 | null; tip: GitSha }
    | { kind: "unavailable" | "invalid"; detail: string }>;
}
export function createBackupCiReader(input: { git: GitRunnerV1; scratchRoot: string; clock: Clock;
  targets: readonly BackupCiTargetV1[]; remoteUrl?: string }): BackupCiReaderV1;
```
- The tip comes from `git ls-remote --refs <remote> refs/heads/sentinel-backup-ci`. This is anonymous over https on a public repo, run with `GIT_TERMINAL_PROMPT=0` and `-c credential.helper=`. It is cached for 10 s, and uses no REST budget (fixes B19).
- Files are read from one shallow fetch of the tip per process per tip, then `git cat-file -s` (at most 256 KiB) and `git cat-file blob <tip>:<path>`.
- A missing branch or file returns `file: null`.
- A parse error, or a mismatch in path, commit, repository owner, name or **id** against the committed targets file, returns `invalid`. Any git failure returns `unavailable`.
- Callers substitute nothing unless the result is `ok`, so missing evidence never passes.

`sentinel.backup-ci-targets.json`: `[{"repository":"ubiquity/passport.ubq.fi","id":<id>}]`. The primary records the id at stage 2. A test asserts the file is a subset of `sentinel.targets.json` with the self scope excluded.

---

## 8. Workflows

Pin every action by full commit SHA. The worker resolves SHAs with `git ls-remote` on the tag. `download-artifact` must be ≥ v4.3 for `artifact-ids`, and `upload-artifact` ≥ v4.4 for the `artifact-id` output. No `run:` script interpolates `inputs.*` or step outputs; they pass through `env:`.

### 8.1 New: `.github/workflows/backup-ci.yml`

```yaml
name: sentinel-backup-ci
on:
  workflow_dispatch: {}
permissions: {}
concurrency:
  group: sentinel-backup-ci
  cancel-in-progress: false
jobs:
  backup_ci:
    if: >-
      github.ref == 'refs/heads/sentinel-supervisor' && github.run_attempt == 1 &&
      (vars.SENTINEL_BACKUP_CI == 'shadow' || vars.SENTINEL_BACKUP_CI == 'on')
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment:
      name: sentinel-supervisor
    permissions:
      contents: write   # store branch and legs ref, native token (like sentinel-state writes)
      actions: write    # dispatch/cancel legs; read leg runs, jobs, logs, artifacts
    steps:
      - name: Check out the launcher
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with: { ref: "${{ github.sha }}", fetch-depth: 1, persist-credentials: false }
      - uses: denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5
        with: { deno-version: v2.9.7 }
      - name: Read the backup targets
        id: targets
        run: echo "repositories=$(jq -r '[.[].repository|select(startswith("ubiquity/"))|split("/")[1]]|join(",")' sentinel.backup-ci-targets.json)" >> "$GITHUB_OUTPUT"
      - name: Mint the target read token
        id: target-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: Iv23liHUJNXds9mU3j7Q
          private-key: ${{ secrets.SENTINEL_SUPERVISOR_APP_PRIVATE_KEY }}
          owner: ubiquity
          repositories: ${{ steps.targets.outputs.repositories }}
          permission-contents: read
          permission-pull-requests: read
          permission-checks: read
          permission-actions: read
      - name: Ingest finished legs and plan new units
        id: pass
        env:
          GITHUB_TOKEN: ${{ github.token }}
          SENTINEL_TARGET_READ_TOKEN: ${{ steps.target-token.outputs.token }}
          SENTINEL_BACKUP_CI: ${{ vars.SENTINEL_BACKUP_CI }}
        run: >-
          deno run --no-lock --allow-read --allow-write --allow-run=git,tar
          --allow-net="api.github.com,github.com,raw.githubusercontent.com,*.blob.core.windows.net"
          --allow-env=HOME,PATH,RUNNER_TEMP,GITHUB_OUTPUT,GITHUB_STEP_SUMMARY,GITHUB_TOKEN,GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT,GITHUB_REPOSITORY,GITHUB_REF,GITHUB_SHA,GITHUB_WORKFLOW_REF,GITHUB_JOB,SENTINEL_TARGET_READ_TOKEN,SENTINEL_BACKUP_CI
          ops/backup-ci-main.ts pass
      - name: Upload unit tree 0
        id: tree0
        if: steps.pass.outputs.slot0 == 'true'
        uses: actions/upload-artifact@<sha> # v4.x
        with: { name: "backup-tree-${{ steps.pass.outputs.unit0 }}", path: "${{ runner.temp }}/backup-ci/trees/0.tar",
                retention-days: 1, compression-level: 0, if-no-files-found: error }
      - name: Upload unit tree 1
        id: tree1
        if: steps.pass.outputs.slot1 == 'true'
        uses: actions/upload-artifact@<sha> # v4.x
        with: { name: "backup-tree-${{ steps.pass.outputs.unit1 }}", path: "${{ runner.temp }}/backup-ci/trees/1.tar",
                retention-days: 1, compression-level: 0, if-no-files-found: error }
      - name: Record results and dispatch legs
        if: steps.pass.outputs.hasWork == 'true'
        env:
          GITHUB_TOKEN: ${{ github.token }}
          SENTINEL_BACKUP_CI: ${{ vars.SENTINEL_BACKUP_CI }}
          SENTINEL_BACKUP_PASS_DIGEST: ${{ steps.pass.outputs.passDigest }}
          SENTINEL_BACKUP_TREE0: ${{ steps.tree0.outputs.artifact-id }}
          SENTINEL_BACKUP_TREE1: ${{ steps.tree1.outputs.artifact-id }}
        run: >-
          deno run --no-lock --allow-read --allow-write --allow-run=git
          --allow-net=api.github.com,github.com
          --allow-env=HOME,PATH,RUNNER_TEMP,GITHUB_STEP_SUMMARY,GITHUB_TOKEN,GITHUB_RUN_ID,GITHUB_REPOSITORY,GITHUB_SHA,SENTINEL_BACKUP_CI,SENTINEL_BACKUP_PASS_DIGEST,SENTINEL_BACKUP_TREE0,SENTINEL_BACKUP_TREE1
          ops/backup-ci-main.ts commit
```

### 8.2 New: `.github/workflows/backup-ci-leg.yml`

```yaml
name: sentinel-backup-ci-leg
run-name: sentinel-backup-ci-leg ${{ inputs.unit }}
on:
  workflow_dispatch:
    inputs:
      unit:          { type: string, required: true }
      unit_digest:   { type: string, required: true }
      plan_run:      { type: string, required: true }
      tree_artifact: { type: string, required: true }
      tree_sha256:   { type: string, required: true }
      runs_on:       { type: choice, required: true, options: [ubuntu-latest, ubuntu-24.04, ubuntu-22.04] }
      job_minutes:   { type: number, required: true }
permissions: {}
jobs:
  leg:
    if: >-
      github.ref == 'refs/heads/sentinel-backup-legs' && github.run_attempt == 1 &&
      contains(fromJSON('["ubuntu-latest","ubuntu-24.04","ubuntu-22.04"]'), inputs.runs_on)
    runs-on: ${{ inputs.runs_on }}
    timeout-minutes: ${{ fromJSON(inputs.job_minutes) }}   # unit cap + 10 (≤ 70); fallback literal 70 (§15)
    permissions: { contents: read, actions: read }          # NO environment, NO secrets.*
    env:
      BACKUP_UNIT: ${{ inputs.unit }}
      BACKUP_UNIT_DIGEST: ${{ inputs.unit_digest }}
      BACKUP_TREE_SHA256: ${{ inputs.tree_sha256 }}
    steps:
      - name: Check out the launcher
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with: { ref: "${{ github.sha }}", path: launcher, fetch-depth: 1, persist-credentials: false }
      - uses: denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5
        with: { deno-version: v2.9.7 }
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0 (act JS-action runtime only)
        with: { node-version: 24.19.0 }
      - name: Install the pinned act
        working-directory: launcher
        run: deno run --no-lock --allow-read --allow-write="$RUNNER_TEMP" --allow-net=github.com,objects.githubusercontent.com,release-assets.githubusercontent.com --allow-run=tar --allow-env=RUNNER_TEMP ops/backup-ci-leg.ts install
      - name: Download the unit tree
        uses: actions/download-artifact@<sha> # v4.3+
        with: { artifact-ids: "${{ inputs.tree_artifact }}", run-id: "${{ inputs.plan_run }}",
                github-token: "${{ github.token }}", path: "${{ runner.temp }}/backup-ci/in" }
      - name: Prepare and verify the unit
        working-directory: launcher
        run: deno run --no-lock --allow-read --allow-write="$RUNNER_TEMP" --allow-run=git,tar,sudo --allow-env ops/backup-ci-leg.ts prepare
      - name: Run the target job
        working-directory: launcher
        run: deno run --no-lock --allow-read --allow-write="$RUNNER_TEMP" --allow-run=sudo,git --allow-env ops/backup-ci-leg.ts run
      - name: Upload the backup result
        id: result
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@<sha> # v4.x
        with: { name: "backup-result-${{ inputs.unit }}", path: "${{ runner.temp }}/backup-ci/out/result.json",
                retention-days: 7, if-no-files-found: error }
      - name: Report the backup result
        if: ${{ !cancelled() }}
        working-directory: launcher
        env: { BACKUP_RESULT_ARTIFACT: "${{ steps.result.outputs.artifact-id }}" }
        run: deno run --no-lock --allow-read="$RUNNER_TEMP" --allow-env ops/backup-ci-leg.ts marker
```

### 8.3 Changes to `.github/workflows/supervisor.yml` (manual launcher advance by the primary)

1. Add `SENTINEL_BACKUP_CI: ${{ vars.SENTINEL_BACKUP_CI }}` to `env` and `--allow-env` in four places:
   - maintenance "Run hosted autonomy" (:136-157);
   - the matrix_plan runtime step (around :286-377);
   - the matrix_cell runtime step (around :464-572);
   - the repair runtime step (:766-772).
2. Add `no-cache: true` under `with:` of both `oven-sh/setup-bun` steps (:437, :636).

Nothing else changes.

### 8.4 Change to `.github/workflows/supervisor-dispatch.yml` (default branch, pushed by the primary)

Add after the existing dispatch step:
```yaml
      - name: Dispatch the backup CI pass
        if: vars.SENTINEL_BACKUP_CI == 'shadow' || vars.SENTINEL_BACKUP_CI == 'on'
        continue-on-error: true
        env: { GH_TOKEN: "${{ github.token }}", GH_REPO: "${{ github.repository }}" }
        run: gh workflow run backup-ci.yml --ref sentinel-supervisor
```

Both new workflow files also live on `development` (the default branch), so GitHub registers them for dispatch. Their `if:` ref guards make a dispatch at any other ref a no-op.

**Legs ref.**
- The primary creates `sentinel-backup-legs` at the launcher SHA in stage 2.
- After that, `backup_ci` fast-forwards it to its own `GITHUB_SHA` (§9.5).
- A range that changes workflow files is refused for the native token. In that case the pass reports `backup-ci:legs_ref_needs_manual_advance` and dispatches nothing. The primary's manual launcher advance then moves both refs in the same step.

---

## 9. Trusted pass (`ops/backup-ci-main.ts`, WP3)

### 9.1 Identity and inputs
- `GET /actions/runs/{GITHUB_RUN_ID}/attempts/1` must show path `BACKUP_CI_WORKFLOW_PATH`, event `workflow_dispatch`, head_branch `sentinel-supervisor`, `head_sha == GITHUB_SHA`, and repository and head repository both `ubiquity-sentinel/sentinel`. Otherwise the job exits with no writes.
- **State.** One `readRepairSafely` (ops/hosted-autonomy-state.ts:36) through `createRepairStateStore` with the native token, read-only.
- **Mode.** `parseBackupCiMode(SENTINEL_BACKUP_CI)`. With `off` the job exits.

### 9.2 Ingest (`ops/backup-ci-ingest.ts` and `ops/backup-ci-ingest-reads.ts`)

Go through every `dispatched` entry of every enabled target, oldest first, at most 32 per pass, each in its own try/catch, within 60 s per target.

1. **Find the leg run.**
   - `GET /actions/workflows/backup-ci-leg.yml/runs?event=workflow_dispatch&branch=sentinel-backup-legs&created=>=<dispatchedAt−60s>`, then filter on `display_title == "sentinel-backup-ci-leg <unitId>"`.
   - There must be exactly one match, with `path == BACKUP_CI_LEG_WORKFLOW_PATH`, `head_sha == unit.plan.launcherSha`, head repository `ubiquity-sentinel/sentinel`, and `triggering_actor.login == "github-actions[bot]"`. Read it through `attempts/1`.
   - 0 matches after `LEG_MISSING_MS` → `leg_missing`.
   - More than 1 match → `binding_mismatch`, logged as a security event.
   - Still queued or in progress after `job_minutes + 30 min` → cancel it, then `leg_stuck`.
2. **Job.**
   - Exactly one job `leg` in attempt 1, completed, conclusion `success` (otherwise `leg_failed` or `leg_cancelled`).
   - `runner_group_name == "GitHub Actions"` and `labels == [unit.job.runsOn]`.
   - The `BACKUP_CI_LEG_STEPS` steps appear in order, completed `success`, with ordered timestamps inside the job window.
3. **Log.**
   - Fetch through the signed redirect checked by `trustedActionsLogUrl` (client-hosted-log-wire.ts:116). Not served yet → bounded retry, then `log_unserved`.
   - It must contain exactly one line `^<ts> {"kind":"sentinel_backup_ci_leg_result",…}` with the exact key set {kind, unitId, unitDigest, resultDigest, artifactId}, `ts` inside the "Report the backup result" step window, and `unitId`/`unitDigest` equal to the stored unit (otherwise `marker_missing` or `digest_mismatch`).
4. **Artifact, by marker id only.**
   - `GET /actions/artifacts/{id}`: `workflow_run.id == legRunId`, `workflow_run.head_sha == launcherSha`, `workflow_run.repository_id == sentinel id`, `name == backup-result-<unitId>`, not expired, `size_in_bytes ≤ 64 KiB`.
   - Unzip with the lazy zip.js loader (matrix-artifact-archive.ts:46-48). There must be exactly one entry, `result.json`. Refuse if the declared or streamed uncompressed size exceeds 64 KiB. `sha256 == resultDigest` (otherwise `artifact_invalid` or `digest_mismatch`).
5. **Result.**
   - Strict closed-key parse (`result_invalid`).
   - `observed` must equal the unit's exec binding (`binding_mismatch`), and `runner.runnerId == unit.plan.runnerId`.
   - `startedAt` and `completedAt` lie inside the "Run the target job" window.
   - `outcome` must be consistent with `steps` and `act` under the §10.4 rules (otherwise `act_inconsistent`).
6. **Excerpt.** For a red result, take the job-log lines of the Run step window prefixed `│ [<failingStep>] `, pass them through `excerptFromLog` (ci-evidence-excerpt.ts:672) and the §10.5 sanitizer, and keep at most 8 KiB.
7. **Native comparison.**
   - Read the commit's check runs with `filter=all` (target token).
   - If the group has a native, started, completed run, record `native` and update calibration for (target, runnerId): an agreement within the same success or red class; a **false green** (backup success, native red); a **false red** (backup red, native success).
   - A false green writes `v1/<o>/<r>/suspended.json` (`runnerIds += [runnerId]`, reason `false_green`). More than `maxFalseReds` false reds writes the same file with reason `false_red`.
   - Log `sentinel_backup_ci_disagreement`.
8. **Entry.** `result` in mode `evidence` (pass mode `on`) or `shadow`, or `no_evidence` with its reason.

### 9.3 Planner (`ops/backup-ci-plan.ts` pure, `ops/backup-ci-plan-reads.ts` reads)

**Record set** per enabled target. A record qualifies when it has a published head (`record.target.head !== null`) and either:
- `nextStep ∈ {work, review, delivery}`; or
- it is blocked and one of the exported launcher re-admission predicates holds: `preReviewGateParked` (ops/hosted-autonomy-ci-first.ts:254), `ciRedeliveryEligible` / `ciGreenRedeliveryEligible` (ops/hosted-autonomy-ci-retries.ts:118/:139), plus the retry-pass, closure-pass (:623) and original-candidate-pass (:98) predicates.

The last three are exported unchanged into a new `ops/hosted-autonomy-green-readmission.ts`, which defines `greenReadmissionCandidate(snapshot, record)` as their union. A predicate added later is added there once.

**Candidate commits, in priority order** (lower first):

| p | Commit | Context and purpose |
|---|---|---|
| 0 | Any key whose attempt 1 is a red result without attempt 2 | Same context and base; `confirm`, attempt 2 |
| 1 | Calibration commits from `ops/backup-ci-calibration.json`, only while `!isBackupCiCalibrated(current runnerId)`; at most 2 per pass | Push; `calibration` |
| 2 | Live base tip T (`readBaseTip`) | Push; `stand_in` |
| 3 | Distinct `record.target.base` ≠ T that a live head needs for attribution (head never-started or backup-red) | Push; `stand_in` |
| 4 | Peers. **Base peer:** head has a final backup red for (P,N), base has native started N and no peer result. **Head peer:** head has native started red N, base has only a backup stand-in for (P,N). | Base: the base observation's event. Head: `pull_request` if a PR is open, else push. Purpose `peer`. |
| 5–8 | Heads at delivery (5), review (6), work (7), blocked re-admission candidates (8); ties by `wait.since` ascending, then record id | `pull_request` when the PR is open (one unit covers its push observations too); otherwise push |

**Per commit** (stop scanning a target after `MAX_COMMITS_READ_PER_TARGET`, with a cursor rotated by `GITHUB_RUN_ID`, or once 2×free units are found):
1. List check runs (`filter=latest`). If nothing is never-started (WP0 classifier) and the purpose is not peer or calibration, skip.
2. List check runs with `filter=all`, then `GET /actions/runs?head_sha=` (suite → path, event, head_branch). Group by (path, name), and apply the §5 observation rules and the annotation check.
3. **Pull-request context:**
   - `GET /pulls/N` must be open, with `head.sha == H` and `base.ref == record base branch` (otherwise `pr_not_open` or `pr_moved`).
   - `GET /compare/B...H` must be `ahead` or `identical` with `behind_by == 0` (otherwise `unsupported:head_not_on_base`).
   - If GitHub's `refs/pull/N/merge` exists with parents `[B, H]`, its tree must equal tree(H). This is a cross-check only; the absence of the ref is not a refusal.
4. **Workflow.** Read `ls-tree` and `cat-file` of the path at the commit after materialization (§9.4), then apply the §5 rules. Record `BackupCiWorkflowCoverageV1` with `expected` (every rendered name for that event) for every (path, event) seen.
5. **Dedupe.** Skip a key that has:
   - a final result for the current mode (in `on`, shadow results count as absent);
   - a `dispatched` entry whose leg is queued or in progress, or which is younger than 30 min;
   - a `no_evidence` entry with `nextAt > now`;
   - a final `unsupported` entry.

**Free slots.**
- `inflight` = leg runs queued plus in progress (`GET /actions/workflows/backup-ci-leg.yml/runs?status=queued` and `?status=in_progress`).
- `p = 1` if any in-progress `supervisor.yml` run has a `matrix_cell` job queued or in progress (its jobs listing); otherwise `p = 2`.
- `free = max(0, p − inflight)`.

**Fairness.** Targets are sorted by `owner/name`, starting at index `GITHUB_RUN_ID mod n`. One unit per target per round, in priority order. At most `p` units per target.

**Outputs.** `passDigest`, `hasWork`, `slotK`, `unitK` (hex24), and `pass.json` in `$RUNNER_TEMP/backup-ci`. Planning and leg outcomes are logged as hex, enum and integer values only.

### 9.4 Materialize (`ops/backup-ci-materialize.ts`)

1. `git init --bare`. Spawn every child process with `env: {}` plus `PATH`, `HOME`, `GIT_TERMINAL_PROMPT=0` and the auth header passed as `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.https://github.com/.extraheader`, `GIT_CONFIG_VALUE_0=AUTHORIZATION: basic …`. The token is never written to argv or `config`.
2. Pass `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.allow=never -c protocol.https.allow=always -c submodule.recurse=false`.
3. `git fetch --depth=1 --no-tags --no-recurse-submodules --no-auto-gc https://github.com/<o>/<r> <H> [<B>]`, by SHA.
4. Check `cat-file -t` for each SHA. Check that `tree(H)` and the workflow blob mode match.
5. For pull_request units:
   ```
   M = git commit-tree <tree(H)> -p B -p H -m "Merge <H> into <B>"
   ```
   with `GIT_AUTHOR/COMMITTER_{NAME,EMAIL,DATE} = GitHub / noreply@github.com / @plannedAt`. Verify the raw `cat-file -p M` parent lines equal `[B, H]`. Set the bare `HEAD` to `refs/heads/backup-exec` at the exec commit.
6. Check that the size is at most 256 MiB (`unsupported:tree_too_large`). Write `unit.json` (canonical) into the bare directory.
7. Scan `config`, `FETCH_HEAD`, `packed-refs` and `logs/` for the exact token values and for `extraheader`; refuse on any hit.
8. Create a deterministic tar (`--sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner`) without following symlinks, then compute its sha256.

**Event payload** (`buildEventPayload`, in `ops/backup-ci-act.ts`):
- **pull_request.** `{action:"synchronize", number, pull_request:{number, state:"open", draft, head:{sha:H, ref, repo:{full_name,name,owner:{login}}}, base:{sha:B, ref, repo:{…}}, user:{login}}, repository:{full_name,name,owner:{login},default_branch,private}, sender:{login:"ubiquity-sentinel[bot]"}}`. Fields come from the PR API object; nothing else is copied.
- **push.** `{ref, before:<first parent or 0⁴⁰>, after:<commit>, repository:{…}, pusher:{name:"ubiquity-sentinel[bot]"}, sender:{…}, head_commit:{id}}`.

### 9.5 Commit and dispatch (`ops/backup-ci-dispatch.ts`)

1. Re-read `pass.json` and check `sha256 == SENTINEL_BACKUP_PASS_DIGEST`.
2. **Fast-forward the legs ref.**
   - If `sentinel-backup-legs == GITHUB_SHA`, there is nothing to do.
   - If the current legs SHA is an ancestor, run `git push origin GITHUB_SHA:refs/heads/sentinel-backup-legs` with the native token.
   - A refusal or a diverged ref gives `legs_ref_behind` for every new unit; nothing is dispatched.
3. **One store CAS commit** holding the ingest results, coverage, calibration and suspensions, plus `dispatched` entries that carry the tree artifact ids.
4. **Dispatch.** `POST /actions/workflows/backup-ci-leg.yml/dispatches` with `{ref:"sentinel-backup-legs", inputs:{unit, unit_digest, plan_run: GITHUB_RUN_ID, tree_artifact, tree_sha256, runs_on, job_minutes: capMinutes + 10}}`. A failed dispatch shows up in the next pass as `leg_missing`.
5. Write a step summary with counts by reason. Target strings appear only as trusted check names.

---

## 10. Leg (`ops/backup-ci-leg.ts` I/O shell, `ops/backup-ci-act.ts` and `ops/backup-ci-log-sanitize.ts` pure)

### 10.1 `install`
Download the pinned asset, check its sha256 against `ops/backup-ci-pins.json`, and extract it to `$RUNNER_TEMP/backup-ci/bin/act`. Then `act --version` must equal the pinned version.

### 10.2 `prepare` (runs before any target code)
1. The input values match their patterns.
2. The tar's sha256 equals `BACKUP_TREE_SHA256`. Extract it into a fresh `$RUNNER_TEMP/backup-ci/bare`.
3. `unit.json` parses, and `sha256(canonical)` equals `BACKUP_UNIT_DIGEST`.
4. `git clone --depth 1 --branch backup-exec file://…/bare ws`. Set `remote.origin.url=https://github.com/<o>/<r>` (no credential), `core.fileMode=true` and `core.autocrlf=false`.
5. Assert:
   - `rev-parse HEAD == exec.commit`;
   - `HEAD^{tree} == exec.tree`;
   - the raw parent lines equal `exec.parents`;
   - `ls-tree HEAD -- <path>` equals the workflow blob;
   - `git status --porcelain=v1 --untracked-files=all` is empty.
   
   Write the result to `observed.json`.
6. Assert that no act configuration file exists: `$HOME/.actrc`, `$HOME/.config/act/actrc`, and `$XDG_CONFIG_HOME/act/actrc` when `XDG_CONFIG_HOME` is absolute. (Corrected 2026-10-25: the hosted image always sets `XDG_CONFIG_HOME=$HOME/.config`, and act creates its config directory on every run, so the directory and the variable alone are not configuration.) Create the empty files `$RUNNER_TEMP/backup-ci/empty/{env,secrets,vars,input}`, an empty cwd, the event file, and fresh action, cache and artifact directories.
7. **Self-test.** Copy `launcher/tests/fixtures/backup-ci/selftest/` into a temporary git repository with remote `https://github.com/ubiquity-sentinel/backup-ci-selftest`.
   - The fixture plants `.actrc` (`--env PROBE=planted`), `.env`, `.secrets`, `.vars` and `.input`.
   - It uses the same `actions/checkout` major version as the unit.
   - Its steps check: `test -z "${PROBE:-}"`, `test -z "${{ secrets.PROBE }}"`, an executable-bit script, `git rev-parse HEAD`, `$GITHUB_REPOSITORY`, `$GITHUB_EVENT_NAME == pull_request`, and that checkout short-circuited.
   - Run it with the **same** argv builder, then classify it. Anything other than success gives `selftest_failed`, and the target job does not run.

### 10.3 `run`

act runs as a clean systemd service:
```
sudo systemd-run --unit=sentinel-backup-act-<slot> --pipe --wait --collect --quiet
  --uid=runner --working-directory=<emptyCwd>
  -p MemoryMax=7G -p CPUQuota=200% -p TasksMax=8192 -p KillMode=control-group
  -p RuntimeMaxSec=<capMinutes*60> -p TimeoutStopSec=30
  --setenv=HOME=/home/runner --setenv=PATH=<node24 shim dir>:<PATH from /etc/environment>
  --setenv=ImageOS=… --setenv=ImageVersion=… --setenv=RUNNER_TOOL_CACHE=/opt/hostedtoolcache
  --setenv=AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache --setenv=CI=true  [+ every /etc/environment key]
  -- <act> <pull_request|push> -C <ws> -W <ws>/<path> -j <jobKey> [--matrix k:v …]
     -e <event.json> -P <runsOn>=-self-hosted --actor 'ubiquity-sentinel[bot]'
     --defaultbranch <default> --remote-name origin --use-gitignore=false
     --env-file <empty/env> --secret-file <empty/secrets> --var-file <empty/vars> --input-file <empty/input>
     --container-daemon-socket - --action-cache-path <dir> --cache-server-path <dir>
     --artifact-server-path <dir> --json
```
- The service starts with a clean environment, so no `GITHUB_*`, `ACTIONS_*` or `RUNNER_*` value of the leg leaks into it, apart from the explicit `RUNNER_TOOL_CACHE`.
- `KillMode=control-group` kills leftover processes when act exits.
- `RuntimeMaxSec` enforces the cap.
- No Docker flags are ever passed, and nothing from the target reaches the argv except the parsed job key, matrix values and event file.

### 10.4 Classification (`classifyActRun(unit, actJsonLines, exit)`, pure)

Classification uses only act's structured JSON records (`jobID`, `matrix`, `stage`, `stepID`, `stepResult`, `jobResult`; field names are a §15 assertion) and the service's exit status.

| Observation | Outcome |
|---|---|
| Exit 0; exactly one `jobResult: success` for (jobKey, matrix); every planned main step recorded `success`, or `skipped` only with a `status_only` condition, or `failure` only with `continue-on-error` | `success` |
| `jobResult: failure`; the failing step is `run`, `uses_local`, or a remote action **not** in `BACKUP_CI_SETUP_ACTIONS` (exit 127 included) | `failure` |
| `RuntimeMaxSec` hit and `targetTimeoutMinutes == capMinutes` | `timed_out` |
| `RuntimeMaxSec` hit and the target's own timeout is longer (or absent) | `no_evidence: runner_timeout` |
| The failing step is a remote action in `BACKUP_CI_SETUP_ACTIONS` | `no_evidence: setup_action_failed` |
| No job record, act error before the job started | `no_evidence: act_internal` |
| The job was skipped, or 0 or more than 1 job results | `no_evidence: skipped_in_backup` |
| Exit and JSON disagree, a planned step is missing, or a success alongside a failing non-continue step | `no_evidence: act_inconsistent` |

The wrapper exits 0 once `result.json` is written. A failed leg job therefore always means an infrastructure failure.

### 10.5 Output sanitization (`sanitizeActStream`)
- **Stop commands.** Emit `::stop-commands::<128-bit random hex>` before the stream and `::<token>::` after it.
- **Line format.** Each rendered line is `│ [<stepIndex>] <msg>`.
- **Escaping.** Every `::` becomes `:\u200b:` and every `##[` becomes `#\u200b#[`.
- **Character stripping.** Remove ANSI escapes other than SGR, and other C0/C1 control characters.
- **Line length.** Split lines into chunks of at most 4 KiB, each chunk with the prefix.
- **Volume cap.** Cap the stream at 4 MiB, followed by one truncation notice. The raw act JSON stays in `$RUNNER_TEMP` and is never uploaded.

### 10.6 `marker`
Print exactly one line:
```
{"kind":"sentinel_backup_ci_leg_result","unitId":"…","unitDigest":"…","resultDigest":"…","artifactId":N}
```

---

## 11. Consumers

### 11.1 Shared rule (`selectBackupStandIns`, WP1)

For each group G = (path P, name N) on commit C:

1. Mode is `on` (with `shadow`, compute the stand-ins, put them in `shadow`, apply nothing). The reader read is `ok`, the file binds (owner, name, id, commit), no suspension covers `all` or the target for the entry's runner id, and `isBackupCiCalibrated(calibration, entry.runnerId)`.
2. Across **every attempt** (`all`), every observation of N is app `github-actions`, maps to P through its suite, and has `notStarted === true`. Any other observation of N (another app, another path, an unknown suite, or a `notStarted` that is not true) makes N ineligible under every path.
3. No commit status has context N.
4. **Coverage.** For each event e among G's observations, the file has `workflows[P, e]` with `supported: true`, and every name in `expected` has at least one observation on C under P.
5. **Each latest observation o** of G with event e. The candidate entries are `result`, mode `evidence`, key (P, N), with `context == e`, or `e == push` and `context == pull_request`. Resolution for each (context, base):
   - attempt 1 `success` → success;
   - attempt 1 red with an attempt 2 result → attempt 2's conclusion;
   - otherwise unresolved.
   
   Any resolved red → red; otherwise any success → success; otherwise unresolved.
6. **All or nothing.** If any latest observation of G is unresolved, there is no stand-in for G.
7. **Stand-in.** Take the original observation and set `status: "completed"`, the conclusion and `backup`. Name, head, `startedAt` and `completedAt` are kept, so `latestChecks` ordering is unchanged.

**Peers.** For a name whose observations all started natively, under a unique path P: resolved backup entries for (P, N) of any context, calibrated and not suspended, give `backupPeer`. It is attached on every read and is inert outside attribution.

**Invariant (fixes B6).** A never-started observation left over after substitution stays `notStarted`. Runtime gates read it as no evidence, so they wait. The launcher's `hasAllChecksGreen` returns `null` whenever any `notStarted` raw run remains. The launcher hook asserts this itself instead of relying on WP0.

### 11.2 Runtime: one point, `GitHubClientReads.readChecks` (src/github/client-reads.ts:202-269)

**New `src/github/client-backup-ci.ts` (WP2):**
```ts
export async function applyBackupCiToChecks(ctx: {
  reader: BackupCiReaderV1; mode: BackupCiModeV1; repository: RepositoryIdentityV1;
  listAll(sha: GitSha): Promise<PortResultV1<unknown[]>>;    // check-runs?filter=all
  listRuns(sha: GitSha): Promise<PortResultV1<unknown[]>>;   // actions/runs?head_sha
  classify: WP0ClassifierV1; log(line: string): void;
}, sha: GitSha, pairs: { raw: unknown; parsed: GitHubCheckV1 }[], rawAll: unknown[],
   statuses: GitHubCheckV1[]): Promise<GitHubCheckV1[]>;
```
- Insert one call after the statuses are collected and parsed (:258) and before `headStatuses` folds them in (:263-267). `rawAll` is the unfiltered `collected.value`, so name-filtered reads still see full coverage.
- It does nothing, and makes no extra request, when the repository is not a backup target or no observation is `notStarted`.
- Any read failure returns the parsed list unchanged. A store outage therefore never makes CI unreadable.
- Each applied stand-in logs one `sentinel_backup_ci_standin {"repo","commit12","check","conclusion","receipt"}` per process and receipt. Shadow logs `sentinel_backup_ci_shadow`.

**Wiring:**
- Add `backupCi?: { reader: BackupCiReaderV1; mode: BackupCiModeV1 }` to `GitHubApiClientOptionsV1` (client-contracts.ts:19-49).
- Thread it through `GitHubPortOptionsV1` (port-contracts.ts:14), port-base.ts:102, `GitHubHostOptionsV1` and `composeGitHubHost` (src/host/github.ts:68/:173), `composeHostedAppGitHub` (hosted-app-principal.ts:435) and local-github.ts:188.
- Build it once in `composeProductionGithub`'s `common` (actions-repair-host.ts:511), from `SENTINEL_BACKUP_CI` (read beside `SENTINEL_MERGE_QUEUE` at :184) and `sentinel.backup-ci-targets.json`. Its scratch root is under the job's temp directory.

**Every gate inherits it:** CI-first (loop-ci-first.ts:237/:265), CI correction (loop-ci-correction.ts:70-104), delivery (loop-checks.ts), carried delivery (:213/:374/:527), queue delivery reader (:233), and the merge port (:180/:327/:383). `readCheckSuites` (coverage) is unchanged, because never-started runs still carry names and suites.

### 11.3 Attribution (`attributeFailedChecks`, src/repair/ci-rejection.ts:176-206, WP1)

| Head failed check h (failure / timed_out) | Base latest b | Result |
|---|---|---|
| `h.backup` | `bc = b.backup ? b.conclusion : b.backupPeer?.conclusion`; success | candidate |
| `h.backup` | bc ∈ {failure, timed_out, action_required} | baseRed |
| `h.backup` | anything else, b absent, or bc undefined | unattributed (the planner schedules a base unit or base peer) |
| native h | `b.backup`: `h.backupPeer?.conclusion` is red, and `b.conclusion == success` | candidate |
| native h | `b.backup`: `h.backupPeer?.conclusion` is red, and b is red | baseRed |
| native h | `b.backup`: no peer, or the peer is green | unattributed (the planner schedules a head peer) |
| native h | `b.notStarted` (no backup) | unattributed, never baseRed (WP0 invariant, restated here and tested) |
| native h | native b | unchanged |

`ownBaseRed` (src/repair/base-repair.ts:71) is unchanged. A base-repair issue can only exist on calibrated backup evidence (§11.5).

### 11.4 Launcher: one point, `readCompleteCheckRuns` (ops/hosted-autonomy-github.ts:180-202)

- New `ops/hosted-autonomy-backup-ci-read.ts` (WP2) exports `substituteBackupRuns(ctx, head, runs)`.
- `createHostedAutonomyGitHub(token, repository, backupCi?)` (:97) calls it once after the validation loop (:190-200).
- When it applies, it also lists `filter=all`, the head runs (`readHeadRuns`, :203) and statuses, all with the same token.
- It replaces raw runs by `standInRawRun`, which sets `status: "completed"`, the conclusion and `sentinel_backup: {receipt, runnerId}`, and keeps `name`, `head_sha` and `check_suite`. `suitedChecks` and coverage are therefore unchanged.
- Callers: hosted-autonomy-main.ts:243 (reader built from the targets file and `SENTINEL_BACKUP_CI`; anonymous git) and src/host/actions-queue-custody.ts:95.
- `hasSuccessfulCheck` is self-only, so it is untouched.
- `hasAllChecksGreen`, `failedChecks`, delivery `headIsGreen` (including the base tip), closure, the retry pass, the CI re-run pass's `baseGreen`, base repair and the original-candidate pass all see the runtime's evidence.

### 11.5 Base repair

`failedChecks` (:283) counts a substituted red. Stand-ins already require calibration, so an uncalibrated runner can never file a P0. A never-started tip without a receipt files nothing; that is WP0's started-only rule.

### 11.6 Flake re-run interplay
- A backup red stays provisional (no evidence) until its attempt 2 exists. The record keeps waiting (`ci_pending`, uncharged) and is never parked red.
- When it becomes final, WP0's re-runs have already pushed the target's `run_attempt` above 1, so `ciRerunRuns` (ops/hosted-autonomy-ci-rerun.ts:92) returns nothing and `readCiRerunSettled` reports settled. That is correct, because the flake re-run equivalent already ran.
- No change to ci-rerun.ts.

### 11.7 CI correction evidence (v1, WP2)

- New `src/github/client-ci-evidence-backup.ts` exports `backupEvidenceFor(failingRun, selection)`.
- It is called from `collectCiEvidence` (client-ci-evidence.ts:122-150), which is at 500 lines, so only a one-line hook goes there.
- For a failing never-started run that has a red stand-in, the evidence is replaced by:
  - app `sentinel-backup-ci`;
  - the workflow path;
  - the job key;
  - failing step `#<stepIndex>`;
  - the receipt excerpt;
  - this fixed notice: "This check did not start on the target (account billing). Sentinel's backup CI ran the target's own workflow job on the exact tree; the excerpt is from that run."
- The reader is wired into `cellCiEvidenceReader` (src/host/matrix-cell-ci-evidence.ts:65) and the runtime evidence reader.

### 11.8 Mode plumbing (WP2)

Add `SENTINEL_BACKUP_CI` to the launcher input allowlists (hosted-runtime-main.ts:54, hosted-runtime-identity.ts:80) and to the child passthrough beside `SENTINEL_MERGE_QUEUE` (hosted-runtime-child.ts:138). Semantics are lower-only: an invalid value means `off`.

---

## 12. Failure handling

| Event | Store | Consumer effect |
|---|---|---|
| Backup success, calibrated runner | `result: success` | Stand-in success; review and merge may proceed |
| Backup red, attempt 1 | `result: failure/timed_out` (a1) | Provisional: no evidence, uncharged wait; attempt 2 planned at p0 |
| Backup red confirmed, or attempt 2 green | `result` (a2) | a2's conclusion is final. Red is attributed per §11.3 |
| Infra or leg failure (setup action, act internal or inconsistent, skipped, runner cap, self-test, leg failed or cancelled or stuck, marker, log, artifact, digest, binding, result) | `no_evidence`, `legRuns++`, backoff 15 min / 1 h / 4 h / 24 h | No evidence: the existing `ci_pending` wait, then the 6-hour park (loop-ci-first.ts:130-158). Re-admission comes through the green predicates |
| Planning refusal with no leg (`pr_not_open`, `pr_moved`, fetch, dispatch, `legs_ref_behind`, `leg_missing`) | `no_evidence`, retry after 10 min, not counted | Same |
| Unsupported shape | `no_evidence`, final | Same; reported once as `backup-ci:<repo>@<sha12>:<check>:unsupported:<reason>` |
| Trusted job crash | `dispatched` entries stay | The next pass resolves them by leg lookup |
| A native run starts later (billing restored) | Unchanged | Rule 2 fails, so the native run decides; the next ingest records the comparison |
| False green | `suspended.json` (target, runnerId) | That runner's evidence for the target stops on the next read (≤ 10 s TTL). A new runner id must calibrate, or the primary clears the file |
| False reds above the limit | `suspended.json` (false_red) | Same |

---

## 13. Security

**The leg VM holds nothing of value.** It has no environment, no `secrets.*` (structural test) and no target token.
- Its native token has `contents: read` and `actions: read` on a public repository.
- Its runtime token can write caches only in the `sentinel-backup-legs` scope. Neither legs nor any `sentinel-supervisor` job restores a cache (structural test; `setup-bun no-cache: true`).
- Its artifacts land in its own run and are read only by the id named in the marker.
- The App key exists only in `environment: sentinel-supervisor` jobs, whose only branch policy is `sentinel-supervisor` (build-status.md:3213).

**Verdict integrity equals native CI.**
- After act starts, target code with passwordless `sudo` can influence its own leg's result, as it can on its own runner natively, for example by making a test vacuous.
- It cannot affect other units, which run on separate VMs and runs, and it cannot affect the store, which only the trusted job writes.
- The binding (leg-run identity with a trusted display title, plan-stored unit digest, an observed binding captured before target code ran, runner id) guarantees that the result is for that unit and that tree.
- Merges still require native review with no unresolved P0.

**Residual risks:**
- Target code can burn the sentinel repository's `GITHUB_TOKEN` budget (1,000 requests per hour per repository) for up to an hour. That is a denial of service, not a credential exposure, and it would be visible in the diff.
- An act mis-implementation that skips work is caught by the step-record rule and by calibration.

**Untrusted artifacts.** Leg results pass the full §9.2 checks: run, job and runner group; trusted step windows; marker; artifact id, run, SHA and repository id; bounded decompression; strict parse; binding.

**The trusted job never executes target code.** Target bytes are read only through git plumbing on a bare repository and a bounded YAML parse with alias refusal. Child environments are cleared and the token travels only in `GIT_CONFIG_*`. Hook, fsmonitor, protocol and submodule controls are set. The tar is deterministic, never follows symlinks, and is scanned for token values. Only hex, enum and integer values go to `GITHUB_OUTPUT` and logs.

**Target secrets.** None are needed or exposed. Jobs that reference secrets, vars or the token are unsupported.

**Store trust root.** Anyone with `contents: write` on sentinel can write the store, which is the same trust root as `sentinel-state/*`. Model workers never hold that permission. Consumers additionally require mode `on`, a calibrated runner and the target id.

**Visibility.** The Passport tree (1-day artifact), act logs and receipts are public. That falls within the 2026-10-23 three-target acceptance (DECISIONS.md:110-118), and matrix cell bundles already carry Passport source.

**Protected paths.** Add `.actrc`, `.secrets`, `.vars` and `.input` to `PASSPORT_PROTECTED_PATHS` (src/host/target-policy.ts:64).

**Stage 5 (Docker mode) entry conditions (A15).** These already hold: legs on their own ref, `--container-daemon-socket` under the trusted wrapper. Refuse `container.options`, `services.*.options`, volumes, credentials and ports, `docker://` and Docker actions, and container flags from any config file.

---

## 14. Concurrency (GitHub Free: 20 concurrent standard jobs across the ubiquity-sentinel org)

**Existing load during a cell burst:**
- `repair`: 1;
- `matrix_cell`: N (up to 256 planned, the excess queued by GitHub);
- the dispatcher: at most 1, for about 1 minute every 5 minutes;
- sentinel-ci: 0 to 7 on a development push.

**Backup footprint:**
- `backup_ci`: one at a time, about 1.5 to 3 minutes per 5-minute dispatch;
- legs: at most p, with p = 2, or 1 while any supervisor `matrix_cell` job is queued or in progress.
- Admission counts queued plus in-progress leg runs at dispatch time, so the backup never holds more than p + 1 slots.
- A leg holds its slot only for its own unit: at most the cap + 10 minutes, so at most 70 minutes.

**What cells keep:** 20 − 1 (repair) − 1 (leg) − at most 1 (dispatcher, transient) − at most 1 (`backup_ci`, transient) = 16 at worst, 17 to 18 normally. During a sentinel-ci push every workflow queues equally.

**What a "matrix" of backup jobs means here.** It is not one `strategy.matrix` run. Each target matrix combination is its own unit and leg run, dispatched as slots free. A 4-combination target job therefore uses 4 units over successive passes and never more than p slots at once.

**No guaranteed slot.**
- GitHub starts queued jobs roughly in creation order across the org, so a leg dispatched behind a large cell plan waits for those cells.
- A guaranteed backup slot needs a `max-parallel` on `matrix_cell`. That is an owner throughput decision this spec does not take.

**Throughput.**
- A Passport leg takes about 5 to 8 minutes (about 1 minute of setup plus the job).
- That is about 15 to 24 units per hour at p = 2, and 8 to 12 at p = 1.
- Each merge needs about 2 units: the new tip and the next delivery head, plus a confirmation leg for any red.

---

## 15. Hosted-only assertions

Each assertion is checked in the stage-3 shadow run, and the self-test re-checks most of them on every leg. If one fails, the result is no evidence, never green.

1. act's `.actrc` is read only from the cwd and HOME; with `-C` and the explicit empty files, planted `.actrc`, `.env`, `.secrets`, `.vars` and `.input` do not apply.
2. act short-circuits `actions/checkout@v6` locally in host mode for a private-repository remote, with no token and no network fetch.
3. act supports `node24` actions, using the PATH `node` 24.19.0.
4. `--json` emits `jobID`, `matrix`, `stage`, `stepID`, `stepResult` and `jobResult`.
5. `-j` plus `--matrix` select exactly one job.
6. The copied workspace keeps executable bits and `git status` stays clean.
7. `systemd-run --uid --pipe --wait`, the service limits and `KillMode` work on the hosted image.
8. Leg `timeout-minutes` accepts `fromJSON(inputs.job_minutes)`; otherwise use the literal 70.
9. `download-artifact` `artifact-ids` with `run-id` works across runs while the trusted run is still in progress.
10. `upload-artifact` exposes `artifact-id`.
11. Never-started matrix jobs produce expanded check names, and every job of a never-started workflow gets a check run (coverage).
12. Anonymous `setup-node`, `setup-deno` and `setup-bun` inside act are not routinely rate-limited. Measure the `setup_action_failed` rate.
13. A hosted leg job reports `runner_group_name == "GitHub Actions"`.
14. A native-token push to `sentinel-backup-legs` succeeds for ranges that do not touch workflow files.
15. The Passport ci.yml blob passes §5. If it does not, the reason is reported and the primary decides.

---

## 16. Tests

All tests are local, with fake APIs, temporary git and injected clocks. Each command is bounded to 300 s and registered through the existing evidence tool. Named tests only, never a whole-repository sweep.

**WP1**
- `tests/contracts/backup-ci_test.ts`: closed keys and bounds for every parser; canonical digest stability; `backupCiCommitPath`; receipt id format; `parseBackupCiMode` accepts only the exact `on` and `shadow`; the targets file id is required.
- `tests/github/backup-ci-substitute_test.ts`:
  - all never-started across attempts, calibrated, `on` → stand-in;
  - an earlier started attempt hidden by `latest` → none;
  - a status with the same context, another app, or the name under two paths → none;
  - partial coverage → none;
  - a `pull_request` observation with only a push entry → none;
  - a push observation with a `pull_request` entry → stand-in;
  - provisional red → none;
  - a2 overrides a1;
  - a resolved red beats a success;
  - shadow → shadow list only;
  - an uncalibrated runner, a suspension (all, target, runner id), or a wrong repository id or commit → none;
  - `notStarted: null` → none;
  - all-or-nothing within a group;
  - peers only on started names;
  - timestamps preserved.
- `tests/github/backup-ci-store_test.ts`: finality per (key, mode, runnerId); a conflicting result is dropped; result replaces dispatched and no_evidence; backoff schedule; `legRan` counting; unsupported is final; eviction order; calibration math; suspension merge.
- `tests/github/backup-ci-reader_test.ts`: a temporary bare "remote" through a file URL; tip TTL with an injected clock; absent branch or file → null; malformed, wrong path, commit or id → invalid; git failure → unavailable; size bound; only listed targets are read.
- `tests/repair/ci-rejection-backup_test.ts`: every row of §11.3.

**WP2**
- `tests/github/client-reads-backup_test.ts`:
  - a fake HTTP that models `latest` hiding attempts;
  - unfiltered and name-filtered reads;
  - zero extra requests when nothing is never-started;
  - a store outage leaves the list unchanged and is not an error;
  - `headStatuses` grace works with stand-ins;
  - the log line;
  - `backupPeer` attached.
- `tests/repair/ci-first-backup_test.ts`, through the real `gateReviewOnCi`:
  - green stand-in → review;
  - red stand-in on head and green on base → CI fix marker;
  - red on both → `base_red` backoff;
  - no base receipt → unattributed wait;
  - provisional red → wait, uncharged;
  - native head red against a backup-only base: no peer → unattributed, red peer → candidate.
- `tests/github/port-merge-backup_test.ts`: merge with stand-ins; a native started failure in attempt 1 under a never-started attempt 2 → refused; a suspension written between reads → refused after the TTL.
- `tests/host/hosted-autonomy-github-backup_test.ts`: `hasAllChecksGreen` with substituted runs and base coverage; a remaining never-started run → null; `failedChecks` counts final reds; suite ids kept; statuses read only when substitution applies.
- `tests/host/hosted-autonomy-base-repair-backup_test.ts`: a calibrated backup-red tip files the P0; an uncalibrated tip, or a never-started tip without a receipt, files nothing.
- `tests/github/client-ci-evidence-backup_test.ts`: a red stand-in gives receipt evidence with the fixed notice; native evidence is unchanged.
- `tests/host/backup-ci-composition_test.ts`: `composeProductionGithub`, the hosted-autonomy `githubFor`, queue custody and the cell evidence reader each pass a reader for listed targets; child env passthrough and the identity allowlist include `SENTINEL_BACKUP_CI`.

**WP3**
- `tests/host/backup-ci-workflow-map_test.ts`: a synthetic, sanitized Passport-shaped workflow gives exactly one unit; one case per `unsupported:*` reason; matrix name rendering and uniqueness; alias and size refusal; expression allowlist; checkout inputs; event conditionals; root config files; the `git grep` context scan, against a temporary repo.
- `tests/host/backup-ci-actions_test.ts`: fake raw fetch; node24 and composite accepted; Docker refused; recursion depth and count bounds; unresolvable action refused.
- `tests/host/backup-ci-plan_test.ts`: priority classes p0–p8; round-robin and rotation; `free = p − inflight`; p selection from supervisor jobs; dedupe (final, in flight, backoff, unsupported); shadow results treated as absent in `on`; confirm, calibration and peer units; PR versus push context; `head_not_on_base`; the commit-read bound; annotation required; record set through `greenReadmissionCandidate`.
- `tests/host/backup-ci-materialize_test.ts`: real git against a temporary target remote; fetch by SHA; M has parents [B, H] and tree(H); a non-ancestor B is refused; a workflow with symlink mode is refused; the token never appears in argv or `.git/config`; child env is cleared; deterministic tar digest; token-value scan.
- `tests/host/backup-ci-act_test.ts`: exact act and `systemd-run` argv (no Docker, privileged or host-env flags; empty files; actor; cwd); event payloads; the sanitizer (`::`, `##[`, marker-shaped lines, ANSI, chunking, cap, stop-commands token); every row of the classification table, including 127 → failure, setup allowlist, `continue-on-error`, status-only skips, `timed_out` versus `runner_timeout`, exit and JSON disagreement.
- `tests/host/backup-ci-leg_test.ts`: prepare refusals (digest; HEAD, tree, parents or blob; dirty porcelain; mode; HOME `.actrc`); the self-test harness with a fake act; marker format; the result contains no target strings.
- `tests/host/backup-ci-ingest_test.ts`:
  - own-identity refusals;
  - leg lookup with 0 or 2 matches, wrong ref, SHA, attempt or actor;
  - job checks (group, labels, step order and windows);
  - marker missing, duplicated, outside its window, or for the wrong unit;
  - artifact from another run, wrong name, oversized, two entries, decompression bomb, digest mismatch;
  - result binding or runner id mismatch;
  - excerpt cut and sanitization;
  - calibration counting; a false green writes a suspension; false reds above the limit;
  - per-unit isolation; per-target budget; stuck-leg cancel.
- `tests/host/backup-ci-store-writer_test.ts`: fast-forward-only push conflicts with retry; first orphan commit; batching.
- `tests/host/backup-ci-workflow-yaml_test.ts`:
  - the leg has no `environment`, no `secrets.`, and `permissions` exactly {contents: read, actions: read};
  - `backup_ci` and the leg are guarded by ref and attempt;
  - every action pinned by SHA;
  - no cache restore at `sentinel-supervisor` (`setup-bun no-cache: true`, no `actions/cache`, no `cache:` inputs);
  - no `inputs.*` or step outputs interpolated into `run:`;
  - the dispatcher step exists;
  - the env lines exist in the four supervisor steps;
  - the targets file is a subset of `sentinel.targets.json` with ids.

**Named lifecycle scenario:** `tests/integration/backup-ci-lifecycle_test.ts` (WP3, after WP2 is integrated).
1. A temporary target remote with fake never-started runs (billing annotation, an earlier hidden attempt in one variant).
2. Plan, then materialize with real git.
3. The leg's prepare and run with a fake `act` that emits act-style JSON.
4. Ingest against a fake Actions API, then a store commit to a temporary remote.
5. Runtime `readChecks` stand-in, the CI-first gate proceeds, and the merge port merges.
6. The red path goes a1 → a2 → CI fix marker with receipt evidence. A red base backup gives `base_red` plus a base-repair issue only when calibrated.

---

## 17. Work packages

The never-started package lands first. Then WP1. Then WP2 and WP3 run in parallel. The primary integrates and does the manual advance. Workers do not commit or push, and they do not edit `docs/build-status.md`.

### WP0 (in flight, parallel worker): never-started detection

Obligations this spec relies on:
1. **An exported pure classifier.** `classifyCheckRunStart(rawCheckRun, job | null): "started" | "not_started" | "unknown"` (not_started = github-actions, completed failure, zero steps, no runner). Also a per-SHA memoized job reader, usable from both the runtime client and the launcher.
2. **The runtime representation.** `GitHubCheckV1.notStarted?: true`, or C2's `queued` plus `unstarted`; either is adapted in `src/github/backup-ci-observations.ts`. A never-started check never passes, is never red and is never charged. A never-started base observation attributes `unattributed`.
3. **Launcher.** `failedChecks` excludes never-started runs, and `hasAllChecksGreen` returns `null` while any remain.
4. **Re-runs.** The 30-minute re-runs of never-started runs must not consume the native flake re-run once billing returns (the `ciRerunRuns` attempt-1 guard).
5. **Hook seams left open.** In `readChecks`, after marking and before `headStatuses`. In `readCompleteCheckRuns`, after validation.

### WP1: contracts and pure core (after WP0)

**Owns:**
- `src/contracts/backup-ci.ts`
- `src/contracts/ports-github-requests.ts` (the §6.2 fields only)
- `src/github/backup-ci-substitute.ts`
- `src/github/backup-ci-store.ts`
- `src/github/backup-ci-reader.ts`
- `src/repair/ci-rejection.ts` (attribution only)
- the WP1 tests in §16

**Delivers:** §6, the §7 pure rules and reader, §11.1 and §11.3.

**Validation:** the five WP1 tests; `deno check` on the touched modules; `size:check`.

### WP2: runtime and launcher consumers (after WP1, parallel with WP3)

**Owns:**
- `src/github/backup-ci-observations.ts`
- `src/github/client-backup-ci.ts`
- `src/github/client-reads.ts` (one call)
- `src/github/client-contracts.ts`, `src/github/port-contracts.ts`, `src/github/port-base.ts`
- `src/host/github.ts`, `src/host/hosted-app-principal.ts`, `src/host/local-github.ts`, `src/host/actions-repair-host.ts`
- `src/github/client-ci-evidence-backup.ts`, `src/github/client-ci-evidence.ts` (one call)
- `src/host/matrix-cell-ci-evidence.ts`
- `src/host/hosted-runtime-child.ts`, `src/host/hosted-runtime-identity.ts`, `src/host/hosted-runtime-main.ts`
- `ops/hosted-autonomy-backup-ci-read.ts`, `ops/hosted-autonomy-github.ts` (parameter and one call), `ops/hosted-autonomy-main.ts`
- `src/host/actions-queue-custody.ts`
- the WP2 tests in §16

**Delivers:** §11.2 and §11.4–§11.8.

**Validation:** the WP2 tests, then the affected consumers: `tests/repair/` CI-first and correction files, the port-merge tests, the hosted-autonomy-github tests.

### WP3: backup pipeline and workflows (after WP1, parallel with WP2; the lifecycle test after WP2)

**Owns:**
- `ops/backup-ci-main.ts`, `ops/backup-ci-plan.ts`, `ops/backup-ci-plan-reads.ts`
- `ops/backup-ci-workflow-map.ts`, `ops/backup-ci-expressions.ts`, `ops/backup-ci-actions.ts`
- `ops/backup-ci-materialize.ts`
- `ops/backup-ci-ingest.ts`, `ops/backup-ci-ingest-reads.ts`
- `ops/backup-ci-store-writer.ts`, `ops/backup-ci-dispatch.ts`
- `ops/backup-ci-leg.ts`, `ops/backup-ci-act.ts`, `ops/backup-ci-log-sanitize.ts`
- `ops/hosted-autonomy-green-readmission.ts` (exports only)
- `ops/backup-ci-pins.json`, `ops/backup-ci-calibration.json` (the primary fills SHAs and the pin)
- `sentinel.backup-ci-targets.json`
- `tests/fixtures/backup-ci/selftest/**`
- `.github/workflows/backup-ci.yml`, `.github/workflows/backup-ci-leg.yml`, `.github/workflows/supervisor.yml` (§8.3), `.github/workflows/supervisor-dispatch.yml` (§8.4)
- `src/host/target-policy.ts` (protected paths)
- `deno.json` and `deno.lock` (an exact `jsr:@std/yaml` 1.x pin, at least 14 days old)
- the WP3 tests and the lifecycle test in §16

**Delivers:** §5, §8–§10, §9.2 and §13.

**Validation:** the WP3 tests, then the lifecycle scenario on the integrated candidate.

**File sizes.** Every new source file targets at most 500 lines and every test file at most 800. `client-reads.ts` (461), `client-ci-evidence.ts` (500), `hosted-autonomy-github.ts` (684) and `ci-rejection.ts` (419) receive only hook calls or local rules.

---

## 18. Rollout, kill switches and rollback

0. **WP0 lands.** Never-started stops reading as red. Passport waits uncharged.
1. **WP1, WP2 and WP3 code** (an ordinary development push; auto-follow installs it). The code is inert: the mode is unset (`off`), the store branch does not exist, and consumers substitute nothing.
2. **Workflow advance (primary, manual).**
   - Push `backup-ci.yml`, `backup-ci-leg.yml`, the `supervisor.yml` env and `no-cache` changes, and the `supervisor-dispatch.yml` step.
   - Create `sentinel-backup-legs` at the launcher SHA.
   - Record the Passport id in the targets file and the act pin in the pins file.
   - The mode is still `off`.
3. **Shadow.**
   - Set `vars.SENTINEL_BACKUP_CI=shadow`. Commit `ops/backup-ci-calibration.json`: exact Passport SHAs whose `deno` check ran natively before 2026-10-24 06:40 UTC, including at least one native failure.
   - Before the hosted attempt, record: workflow `backup-ci.yml` at `sentinel-supervisor` and `backup-ci-leg.yml` at `sentinel-backup-legs`, the exact launcher SHA, an expected 30–60 min, and the §15 assertions.
   - **Pass bar:**
     - the runner is calibrated (at least 5 agreements, at least 1 failure agreement, 0 false greens, at most 1 false red);
     - every artifact verified;
     - every self-test passed;
     - the leg logs contain no workflow commands or tokens;
     - consumers log `sentinel_backup_ci_shadow` stand-ins for live Passport heads;
     - supervisor runs are unaffected.
4. **On.** Set `SENTINEL_BACKUP_CI=on`. Acceptance:
   - one Passport issue goes PR → CI-first pass on a backup stand-in (`sentinel_backup_ci_standin` line) → native review → merge through the port → closure through `hasAllChecksGreen`;
   - no base-repair issue is filed from uncalibrated or provisional evidence;
   - local, hosted, installed and live evidence are kept separate.
5. **Later.**
   - Docker mode (services, container) under the A15 conditions.
   - A mirror runner feeding the same receipts, if the owner provisions one (§19).
   - Opting in further targets.
   - A store audit tool.

**Kill switches:**
- `SENTINEL_BACKUP_CI=off` stops dispatch, planning **and** consumption on the next job start.
- `v1/suspended.json` (`runnerIds: "all"`) or the per-target file stops substitution in both layers within 10 s. The primary writes it under the state-branch grant, and the ingest writes it on a disagreement.
- **Rollback** to a pre-backup runtime ignores receipts. Never-started checks then wait (WP0), so the direction is safe and never produces a false merge.

**Docs.** The primary records a DECISIONS entry (runner choice, legs ref, calibration gate) and the ledger update.

---

## 19. Relation to `docs/redesign-2026-10-25.md` (C2, C7)

- **C7's mirror repository** (`ubiquity-sentinel/passport-ci-mirror`) has the best fidelity. This spec still replaces it for v1, for these reasons:
  - it needs owner prerequisites O1/O1b: create the repo, install the App, and either grant workflows permission or have the owner re-seed whenever Passport's workflows change;
  - a private mirror uses the org's included minutes and fails under the same spending-limit condition, while a public mirror permanently publishes the private target;
  - one mirror `main` allows only one PR base at a time under `pull_request` branch filters.
  
  The receipt contract, the reader, substitution, attribution and the consumers here are runner-agnostic. A mirror runner would only add its own ingest verifier producing the same `result` entries, so it remains a stage-5 option if the owner provisions it.
- **C2's representation** (`status: queued`, `conclusion: null` plus `unstarted`) versus the `notStarted` flag: this spec consumes whichever WP0 lands, through the one adapter `src/github/backup-ci-observations.ts`. Both satisfy the §11.1 invariant.
- **C7's capacity rule** ("free slots from the Actions API minus a reserve") is implemented here as dispatch-time admission with p ≤ 2. C13.5's `src/host/actions-capacity.ts` can replace `chooseParallel` later without a contract change.