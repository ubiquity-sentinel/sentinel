# Delegating coding work to Sentinel agent jobs

Status: experimental. It lives on the `claude/great-ride-tu5r70` branch of
`ubiquity-sentinel/sentinel` and is separate from the Sentinel supervisor.

You hand over a list of coding tasks. Each task runs as one Codex agent on a
GitHub-hosted runner (4 vCPU, 16 GB RAM), unsandboxed and with network access,
for up to about six hours. Whatever the agent changes is pushed to a new branch
of the target repository. Nothing is reviewed or merged for you.

## How to delegate

1. Check out the `claude/great-ride-tu5r70` branch of
   `ubiquity-sentinel/sentinel`.
2. Add a new file `jobs/inbox/<any-name>.json` (see the format below).
3. Commit and push. The push starts the `sentinel-agent-jobs` workflow.

Only request files that the pushed head commit adds or changes are run, so put
all files of one batch in one commit. To run a job again, change its file (or
add a new one) and push again.

Use **Re-run failed jobs** to retry failed cells; the successful plan is reused.
If a publish job fails after its cell succeeded, use **Re-run all jobs** to
regenerate bundles for the current attempt. This starts the agents again.

## Request format

```json
{
  "jobs": [
    {
      "id": "pay-fix-rounding",
      "repository": "ubiquity/pay.ubq.fi",
      "prompt": "Fix the rounding error in the payout total.\n\nDetails: ..."
    },
    {
      "id": "router-add-tests",
      "repository": "ubiquity/ubq.fi-router",
      "base": "development",
      "prompt": "Add unit tests for the route matcher.",
      "model": "gpt-6.2-astra",
      "reasoningEffort": "ultra",
      "pr": true
    }
  ]
}
```

| Field             | Required | Meaning                                                                                      |
| ----------------- | -------- | -------------------------------------------------------------------------------------------- |
| `id`              | yes      | Unique in the request; lowercase letters, digits and `-`, at most 40 characters.             |
| `repository`      | yes      | `owner/name`. The Sentinel GitHub App must be installed on it with write access.             |
| `prompt`          | yes      | The task. Its first line becomes the commit and pull request title.                          |
| `base`            | no       | Branch to start from. Defaults to the repository's default branch.                           |
| `pr`              | no       | `true` opens a draft pull request for the pushed branch. Default `false`.                    |
| `setup`           | no       | Shell commands to run in the checkout before the agent starts.                               |
| `minutes`         | no       | Agent deadline. Defaults to the maximum, 350. Work done before a deadline is still pushed.   |
| `model`           | no       | Gateway model id. Defaults to the workflow's implementation model.                           |
| `reasoningEffort` | no       | Codex reasoning effort for every attempt. Defaults to `max`.                                 |
| `runner`          | no       | Hosted runner kind: `linux-x64` (default), `linux-arm64`, `linux-arm64-26` or `macos-arm64`. |

Allowed reasoning efforts are `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, and `ultra`. Choose an effort supported by the job's model.

One job is one agent. To put several agents on one repository, give each its own
job with a task that does not overlap the others; each gets its own clone and
its own branch.

Jobs that ask for different runner kinds never share a runner. `linux-arm64` is
`ubuntu-24.04-arm` (4 vCPU, 16 GB), `linux-arm64-26` is `ubuntu-26.04-arm` (same
size, newer packages) and `macos-arm64` is `macos-latest` (Apple Silicon, 3
vCPU, 7 GB, no `apt`; Homebrew is installed). Use them when the task must build
or run on that platform; macOS runners are the scarcest.

Every cell restores a build cache directory before its agents start and saves it
afterwards. Agents find it in `AGENT_JOBS_CACHE_DIR`; `CCACHE_DIR` points inside
it and `ccache` is installed on Linux runners, so a build that compiles through
`ccache` reuses objects from earlier jobs of the same repository owner on the
same runner kind. The cache is a convenience, never an input to trust: it is
written by earlier agents.

### Writing a good prompt

The agent starts with a fresh clone and only your prompt. It does not see this
conversation, other jobs or their results. Say what to change, where, and how to
tell it is done (which command must pass). The agent can install dependencies,
run the test suite and use the network itself. It reads the target repository's
`AGENTS.md` if there is one.

## Where the results are

- **Code:** branch `agent-jobs/<id>-<run id>-<attempt>` in the target
  repository, based on the base branch as it was when the job started. With
  `"pr": true` there is also a draft pull request whose body is the agent's
  final message.
- **Status:** the workflow run in the Actions tab of
  `ubiquity-sentinel/sentinel`. Each `cell` job's summary lists its jobs; each
  `publish` job's summary lists the pushed branch or pull request.

| Status         | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `changed`      | The agent finished and its work was pushed.                             |
| `no_changes`   | The agent finished without changing anything. Nothing is pushed.        |
| `timed_out`    | The deadline ended the agent. Whatever it had changed is still pushed.  |
| `agent_failed` | Codex exited with an error. Whatever it had changed is still pushed.    |
| `setup_failed` | A `setup` command failed. The agent never started.                      |
| `host_failed`  | Clone or commit failed, for example the App cannot read the repository. |

A job that ends `publish failed` could not be pushed; the usual cause is that
the App lacks write access to the repository. The publish token carries the
`workflows` permission, so a branch that changes `.github/workflows` files is
pushed like any other.

Each job's status is also printed in its `cell` job log as `<id>: <status>`.

While an agent runs, its `cell` job log gets one liveness line every five
minutes:
`<id>: alive <minutes>m, restarts <n>, commits <n> (last <sha> <age>
"<subject>"), uncommitted files <n>, agent output <size>, quiet <seconds>s`.
`quiet` is the time since the agent last wrote any output; a job that stays
quiet for many minutes with no new commits is stuck, not working. The log of a
running job is streamed on its page in the Actions tab.

Each job also leaves `<id>.telemetry.json` in the cell's artifact: one entry per
agent attempt (seconds, exit code, why it ended, and the client's distinct error
and reconnect lines with counts, long tokens redacted) and the liveness lines it
printed. When an attempt ends the cell log gets a one-line summary of it. Use
these to tell a model outage or dropped streams from a task that failed on its
own.

In a pull request body, links the agent made to files in its checkout point at
the pushed commit; other runner-local links are reduced to their text.

## Deleting result branches

Result branches are never deleted for you. To delete some, add a file
`jobs/cleanup/<any-name>.json` on this branch, commit and push. The push starts
the `sentinel-agent-jobs-cleanup` workflow.

```json
{
  "branches": [
    {
      "repository": "ubiquity/pay.ubq.fi",
      "branch": "agent-jobs/pay-fix-rounding-44195622667-1"
    },
    {
      "repository": "ubiquity/ubq.fi-router",
      "branch": "agent-jobs/router-add-tests-44195622667-1",
      "closePullRequest": true
    }
  ]
}
```

Only `agent-jobs/<id>-<run id>-<attempt>` branches are accepted; any other name
fails the whole request. As with jobs, only files the pushed head commit adds or
changes are read. Do not put a job file and a cleanup file for the same branch
in one commit.

| Status         | Meaning                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `deleted`      | The branch is gone.                                                                                |
| `missing`      | The branch did not exist, for example it was deleted after a merge.                                |
| `kept_open_pr` | An open pull request uses the branch. `closePullRequest` closes the pull request, then deletes it. |
| `failed`       | GitHub refused; the detail gives the HTTP status. The run fails.                                   |

## Capacity

- Twenty runners run at once on this account; they are shared with the Sentinel
  supervisor and CI. Extra cells wait in the queue.
- The first twenty jobs of a request get a runner each. More jobs are stacked,
  four agents per runner by default. Agents on one runner share its CPU and 14
  GB disk.
- The repository variables `SENTINEL_AGENT_JOBS_PER_CELL` and
  `SENTINEL_AGENT_JOBS_MAX_CELLS` (up to 256) change the stacking.
- All agents draw on the same model gateway (`ai.ubq.fi`) and its pool of Codex
  accounts. Agents wait out HTTP 429 responses and are restarted if Codex gives
  up, but an exhausted account pool stalls every agent until it resets.

## What an agent can and cannot do

- It has the runner to itself with no sandbox: full filesystem, `sudo`, Node,
  Bun, Deno and the network.
- It has no GitHub write credential. It cannot push, open issues or comment;
  only the separate `publish` job pushes, after the agent has exited.
- It can read the model gateway token on its runner. Do not point a job at
  untrusted repositories or content.
- Agent transcripts are not uploaded. The diff bundle and the agent's final
  message are uploaded as run artifacts of this public repository, so a job on a
  private repository exposes its diff there.

## One-time setup (repository owner)

The `cell` and `publish` jobs read `SENTINEL_SUPERVISOR_APP_PRIVATE_KEY` and
`UOS_AI_TOKEN` from the environment named by the repository variable
`SENTINEL_AGENT_JOBS_ENVIRONMENT` (default `sentinel-supervisor`). If that
environment restricts deployment branches, allow this branch there or point the
variable at another environment that holds the two secrets.

Codex is installed at its latest release; the repository variable
`SENTINEL_AGENT_JOBS_CODEX_VERSION` holds an exact version back.

## Code

`.github/workflows/agent-jobs.yml` runs `ops/agent-jobs-plan.ts` (validate and
pack), `ops/agent-jobs-cell.ts` (run the agents) and `ops/agent-jobs-publish.ts`
(push). `.github/workflows/agent-jobs-cleanup.yml` runs
`ops/agent-jobs-cleanup.ts`. Local check:

```sh
deno test --allow-read --allow-write --allow-run --allow-env=PATH tests/host/agent-jobs_test.ts tests/host/agent-jobs-cleanup_test.ts
```
