# Handoff: get the agent-job lane running on hosted runners

Date: 2026-11-17. Repository: `ubiquity-sentinel/sentinel`. Branch:
`claude/great-ride-tu5r70` (all work is pushed; nothing is on `development`).

## Goal

The owner's VPS is out of compute for coding agents. This branch adds a lane
that runs operator-supplied coding jobs as Codex agents on GitHub-hosted
runners and pushes each agent's work to a branch of its target repository.
Your task is to make the first hosted run succeed end to end, then leave it
usable. How to use the lane is in [`jobs/README.md`](../../jobs/README.md);
read that first.

## Current state

- Code, workflow, tests and README are complete and pass locally:
  `deno test --allow-read --allow-write --allow-run --allow-env=PATH tests/host/agent-jobs_test.ts`
  (4 tests, fake agent, temporary Git repositories).
- One hosted run exists:
  [run 44028455504](https://github.com/ubiquity-sentinel/sentinel/actions/runs/44028455504),
  started by pushing `jobs/inbox/smoke-001.json`.
  - `plan` passed.
  - `cell (c01)` and `publish (c01)` were refused before any step ran:
    `Branch "claude/great-ride-tu5r70" is not allowed to deploy to sentinel-supervisor due to environment protection rules.`
- Nothing past the plan job has ever run on a hosted runner. The unsandboxed
  Codex start, the gateway call and the publish push are untested there.

## Step 1: unblock the secrets (needs repository admin)

The `cell` and `publish` jobs read `SENTINEL_SUPERVISOR_APP_PRIVATE_KEY` and
`UOS_AI_TOKEN` from the environment named by the repository variable
`SENTINEL_AGENT_JOBS_ENVIRONMENT` (default `sentinel-supervisor`). That
environment only admits its protected branch. Do one of the following; ask the
owner which if they have not said.

**A. Allow this branch in the existing environment (quickest).**

```sh
gh api -X POST \
  repos/ubiquity-sentinel/sentinel/environments/sentinel-supervisor/deployment-branch-policies \
  -f name='claude/great-ride-tu5r70' -f type=branch
```

This lets this branch's workflows read the supervisor's secrets. Add only this
entry; do not loosen or remove the environment's existing rules.

**B. Separate environment (leaves the supervisor's key policy untouched).**

```sh
gh api -X PUT repos/ubiquity-sentinel/sentinel/environments/sentinel-agent-jobs
gh secret set SENTINEL_SUPERVISOR_APP_PRIVATE_KEY --env sentinel-agent-jobs --repo ubiquity-sentinel/sentinel < app-private-key.pem
gh secret set UOS_AI_TOKEN --env sentinel-agent-jobs --repo ubiquity-sentinel/sentinel
gh variable set SENTINEL_AGENT_JOBS_ENVIRONMENT --body sentinel-agent-jobs --repo ubiquity-sentinel/sentinel
```

Secret values cannot be read back from the other environment; the owner has to
supply them. Never print them, commit them or paste them into chat.

## Step 2: run the smoke job

```sh
gh run rerun 44028455504 --failed --repo ubiquity-sentinel/sentinel
```

or change `jobs/inbox/smoke-001.json` (for example the `id`) and push. The job
asks the agent to create `jobs/smoke/smoke-001.txt` holding `uname -sr`,
`codex --version` and the HTTP status of `https://registry.npmjs.org/`.

Success looks like this:

- `cell (c01)` summary shows `smoke-001 | ... | changed`.
- `publish (c01)` summary shows a branch `agent-jobs/smoke-001-<run id>-<attempt>`.
- That branch exists in `ubiquity-sentinel/sentinel`, is one commit ahead of
  `claude/great-ride-tu5r70`, and contains the three-line file (status `200`
  proves the agent has network access).

Delete the smoke branch afterwards.

## Step 3: fix what the first real run trips on

These have not run on a hosted runner. Check them in this order if the cell or
publish job fails.

| Step                         | What could fail                                                                                             | Where to fix                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Mint the read-only App token | The App (client id `Iv23liHUJNXds9mU3j7Q`) may not be mintable for owner `ubiquity-sentinel` with the stock action; the supervisor uses its own action (`.github/actions/sentinel-app-token`) for the self repository. | `.github/workflows/agent-jobs.yml`; or retarget the smoke job at a `ubiquity/*` repository |
| Codex start                  | The latest Codex may reject a flag or config key. Verified locally on 0.169.0 only.                          | `agentCommand` and `prepareClient` in `ops/agent-jobs-cell.ts`; or set the variable `SENTINEL_AGENT_JOBS_CODEX_VERSION=0.169.0` |
| Model call                   | Wrong base URL, model id or token. Defaults: `https://ai.ubq.fi/v1`, `gpt-6.1-sol`, reasoning `max`.         | Workflow `env` of the "Run the cell's agents" step                           |
| HTTP 429 from the gateway    | Codex retries 12 times by `Retry-After`; the cell then restarts the agent with 60–300 s backoff.             | `ops/agent-jobs-cell.ts`                                                     |
| Publish push                 | The App installation needs `contents: write` on the target. It may not push `.github/workflows` changes.      | App installation settings                                                    |

Agent output is deliberately not printed or uploaded (targets can be private
and this repository is public). On the runner it is in
`$RUNNER_TEMP/agent-jobs/<job id>/agent-<attempt>.log` and `.log.err`. To
debug a failing agent, temporarily add a workflow step that prints the tail of
the `.err` file, and remove it again before real jobs run.

Then run a second request with several jobs on a `ubiquity/*` repository, to
see stacking (four agents per runner by default) work under a real load.

## Also on this branch, not yet in production

`supervisor.yml` was changed to install `@openai/codex@latest` instead of
`0.154.0` (owner decision 2026-11-17; the variable `SENTINEL_CODEX_VERSION`
holds a version back). Reason: Codex 0.154.0 exits on the first HTTP 429 from
the gateway, while 0.169.0 retries by `Retry-After` (measured against a local
endpoint). It takes effect only once merged to `development` and advanced to
`sentinel-supervisor`; a workflow-file change needs a manual advance. Untested
risk: `src/github/native-review-envelope-repair.ts` and
`src/repair/model-port-diagnostics.ts` were written against 0.154.0 output.
Merging this is the owner's decision, not part of this task.

## Facts worth knowing

- Twenty hosted jobs run at once on this account, shared with the supervisor's
  own matrix (up to twenty cells) and CI. A large request delays those.
- All agents use the `ai.ubq.fi` gateway and its pool of Codex subscription
  accounts. More agents do not add model quota. The gateway returns 429 both
  for brief capacity refusals (`codex_capacity_unavailable`) and for an
  exhausted pool; only the first clears on its own within minutes.
- Agents run unsandboxed by owner direction and can read `UOS_AI_TOKEN` on
  their runner. The write token exists only in the `publish` job.
- A job on a private repository exposes its diff bundle as a public run
  artifact of this repository.
- How the supervisor treats `agent-jobs/*` branches and bot-opened draft pull
  requests in its targets was not checked. Jobs push a branch only unless they
  set `"pr": true`.

## Boundaries

- Follow `AGENTS.md`. Do not edit `docs/DECISIONS.md` or `docs/build-status.md`
  (integration owner only); report proposed entries instead.
- Do not add branch protection rules or rulesets.
- Do not work around the environment protection (for example by running the
  lane from `sentinel-supervisor`); change the setting as in step 1.
- Keep the write token out of the `cell` job.
- Do not open a pull request or merge to `development` unless the owner asks.

## Files

| Path                               | Purpose                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `.github/workflows/agent-jobs.yml` | Workflow: `plan` → `cell` (matrix) → `publish`       |
| `ops/agent-jobs-plan.ts`           | Validates a request and packs jobs into cells        |
| `ops/agent-jobs-cell.ts`           | Clones, runs the agents, commits and bundles         |
| `ops/agent-jobs-publish.ts`        | Verifies bundles, pushes branches, opens draft PRs   |
| `ops/agent-jobs-git.ts`            | Shared host Git helpers                              |
| `tests/host/agent-jobs_test.ts`    | Plan tests and one plan → cell → publish lifecycle   |
| `jobs/README.md`                   | How to delegate work to the lane                     |
| `jobs/inbox/smoke-001.json`        | The pending smoke job                                |
