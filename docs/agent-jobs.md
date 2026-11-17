# Manual agent jobs (experimental)

Status: experimental, unproven on hosted runners. It lives on an experimental
branch, is not part of the supervisor, and is not recorded in
`docs/DECISIONS.md` or `docs/build-status.md`.

`sentinel-agent-jobs` (`.github/workflows/agent-jobs.yml`) runs operator-supplied
coding jobs on GitHub-hosted runners so that agent work does not consume VPS
compute. One job is one Codex agent on one repository from
`sentinel.targets.json`. Each agent's work is pushed to a new branch
`agent-jobs/<job id>-<run id>-<attempt>` in its target.

## Request

```json
{
  "jobs": [
    {
      "id": "pay-fix-rounding",
      "repository": "ubiquity/pay.ubq.fi",
      "prompt": "Fix the rounding error in ...",
      "base": "development",
      "setup": ["bun install --frozen-lockfile"],
      "minutes": 120,
      "pr": false
    }
  ]
}
```

| Field        | Required | Meaning                                                                                  |
| ------------ | -------- | ---------------------------------------------------------------------------------------- |
| `id`         | yes      | Unique, `[a-z0-9-]`, at most 40 characters; part of the pushed branch name.              |
| `repository` | yes      | Must be listed in `sentinel.targets.json`.                                               |
| `prompt`     | yes      | The task, up to 20,000 characters. Its first line becomes the commit and PR title.       |
| `base`       | no       | Base branch; the repository default branch when omitted.                                 |
| `setup`      | no       | Up to 8 host commands run in the checkout before the model starts, with network access.  |
| `minutes`    | no       | Agent deadline, 5–300, default 120. Work done before a deadline is still pushed.         |
| `model`      | no       | Gateway model id; defaults to the workflow's implementation model.                       |
| `pr`         | no       | Open a draft pull request for the pushed branch. Default `false`.                        |

## Starting a run

- **From the experimental branch:** commit a request file under
  `jobs/inbox/<name>.json` and push. The workflow plans the request files that
  the pushed head commit added or changed. `jobs/example.json` is a template.
- **`workflow_dispatch`:** pass the request as the `jobs` input, with optional
  `agents_per_cell` (1–8, default 2) and `max_cells` (1–20, default 20). GitHub
  only offers manual dispatch for workflow files that exist on the default
  branch.

## Packing

Jobs are spread one per runner until `max_cells` is used, then stacked up to
`agents_per_cell` on each runner. Twenty cells at four agents is 80 agents.
Agent starts are staggered six seconds per cell and two minutes per slot,
because the gateway answers simultaneous session starts with HTTP 429.

The cells count against the same account-wide concurrent-job limit as the
supervisor's own matrix and CI. A full request delays those jobs while it runs;
lower `max_cells` to leave room.

## Boundaries

- The agent runs under the supervisor's sandboxed Codex client configuration:
  writable checkout, read-only `.git`, no network, empty shell environment.
  Dependencies must therefore be installed by `setup` commands.
- The cell job holds a read-only App token and the model token. The write token
  exists only in the separate `publish` job, which starts no model, verifies
  each bundle against the recorded base and tip, and pushes without force.
- The lane writes no Sentinel state, reserves and settles no model start,
  requests no review and merges nothing. Reviewing and merging pushed branches
  is the operator's decision.
- Agent transcripts are not uploaded or printed. The Git bundle and the agent's
  final message are uploaded as run artifacts of this public repository, so a
  job on a private target exposes its diff there.

## One-time setup

Both jobs use the environment named by the repository variable
`SENTINEL_AGENT_JOBS_ENVIRONMENT` (default `sentinel-supervisor`) and read
`SENTINEL_SUPERVISOR_APP_PRIVATE_KEY` and `UOS_AI_TOKEN` from it. If that
environment restricts deployment branches, either allow the experimental branch
there or point the variable at a separate environment holding those two
secrets. The App installation must grant `contents: write` on each target.

## Local check

```sh
deno test --allow-read --allow-write --allow-run --allow-env=PATH tests/host/agent-jobs_test.ts
```
