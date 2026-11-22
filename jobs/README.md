# Run a Sentinel operator job

Use an operator job when you have a specific coding task to send to a GitHub-hosted runner. Submit jobs for any repository GitHub confirms is public and where the Sentinel App has the necessary access. This includes repositories outside the supervisor's target list. You can choose any existing branch in the target. The planner resolves the branch to an exact starting commit before work begins. [On-demand mode](../README.md#on-demand-mode)

## Submit a request

The reviewed operator workflow runs on `development` after the workflow lands there and the repository owner admits that exact ref to its protected environment. Request files, implementation bundles and result artifacts are on a public Actions surface. Use public task text and inputs.

Save the request as `request.json` and dispatch it with the GitHub CLI.

```sh
jq -n --rawfile jobs request.json '{jobs: $jobs}' |
  gh workflow run agent-jobs.yml --repo ubiquity-sentinel/sentinel \
    --ref development --json
```

The REST dispatch endpoint accepts the same request through standard input.

```sh
jq -n --rawfile jobs request.json '{ref: "development", inputs: {jobs: $jobs}}' |
  gh api --method POST \
    repos/ubiquity-sentinel/sentinel/actions/workflows/agent-jobs.yml/dispatches \
    --input -
```

You can also push fresh `jobs/inbox/<unique-name>.json` files to `development`. The workflow compares the event's before and after commits and reads the net additions across the entire push. Use a fresh filename for a new submission and the original run's ID to track a retry.

The existing `sentinel-dispatch` helper and other side-ref producers keep using `claude/great-ride-tu5r70` until you explicitly migrate them. After owner admission, set `B=development` in the helper's `scripts/dispatch.sh` and use a dedicated development clone with `SENTINEL_DISPATCH_CLONE`. The dispatch command above also submits directly to the development workflow. Move only new requests to the development inbox. [Historical side-ref handoff](../docs/handoffs/2026-11-17-agent-jobs.md)

## Request format

```json
{
  "jobs": [
    {
      "id": "router-add-tests",
      "repository": "ubiquity/ubq.fi-router",
      "base": "development",
      "prompt": "Add unit tests for the route matcher. Run the route matcher tests and cover both a matching and a nonmatching path.",
      "model": "gpt-6.2-astra",
      "reasoningEffort": "ultra",
      "pr": true
    },
    {
      "id": "router-inspect-tests",
      "repository": "ubiquity/ubq.fi-router",
      "prompt": "Inspect the route matcher tests and leave the checkout unchanged.",
      "review": false
    }
  ]
}
```

| Field             | Default                       | Meaning                                                                                                                                                   |
| ----------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | Required                      | Unique in the request. Start with a lowercase letter or digit and use at most 40 lowercase letters, digits or hyphens.                                    |
| `repository`      | Required                      | Public target as `owner/name`. The Sentinel App needs read access for checkout and write access for publication.                                          |
| `prompt`          | Required                      | The exact task and acceptance criteria. The first line supplies the commit and optional PR title.                                                         |
| `base`            | Target's default branch       | Existing target branch for the starting commit and optional draft PR.                                                                                     |
| `review`          | `true`                        | Native review. Use `false` only for an evidence-only job whose final Git tree is unchanged.                                                               |
| `pr`              | `false`                       | Set `true` to open a draft PR for the published branch.                                                                                                   |
| `setup`           | `[]`                          | Shell commands to run in the initial checkout before the implementation agent.                                                                            |
| `minutes`         | `350`                         | Job deadline, from 1 to 350 minutes. Implementation, review and correction share that deadline.                                                           |
| `model`           | Hosted implementation default | Override the implementation and correction gateway model for this job. The code default is `gpt-6.1-sol`. Native Codex review resolves its own reviewer.  |
| `reasoningEffort` | `max`                         | Effort for implementation and correction. Choose `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra` as supported by the model.         |
| `runner`          | `linux-x64`                   | `linux-x64` uses `ubuntu-latest`, `linux-arm64` uses `ubuntu-24.04-arm`, `linux-arm64-26` uses `ubuntu-26.04-arm`, and `macos-arm64` uses `macos-latest`. |

Give each job its own acceptance criteria, relevant test command and a nonoverlapping scope. Each agent starts in a fresh clone, receives its job prompt, and reads the target's `AGENTS.md` when present. Agents on a cell share runner resources and have separate checkouts.

The planner groups by repository owner and runner kind. GitHub's hosted job timeout is 360 minutes and its matrix limit is 256 cells. The defaults are four agents per cell and a 20-cell budget. Prefer more cells before stacking. Optional dispatch inputs `agents_per_cell` and `max_cells` tune the batch. Push-triggered jobs use the repository settings `SENTINEL_AGENT_JOBS_PER_CELL` and `SENTINEL_AGENT_JOBS_MAX_CELLS` when set. Hosted runner capacity is shared with the supervisor and CI. Each cell's best-effort build cache is keyed by owner and runner kind, with `AGENT_JOBS_CACHE_DIR` and Linux `ccache` available for compilation.

## Results

Read the review and publish summaries and publication result artifact on the workflow run. Initial cell statuses such as `changed`, `timed_out`, and `agent_failed` describe execution. The review disposition determines what reaches the target.

| Disposition         | Result                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accepted`          | The publisher pushes the exact reviewed commit to `agent-jobs/<id>-<run-id>-<attempt>` and sets `sentinel/agent-job-review` on that SHA. With `pr:true`, the draft PR carries the verdict. |
| `already_satisfied` | Native review positively verified that the pinned base already fulfilled the task. The workflow result records the verdict.                                                                |
| `skipped_no_diff`   | The trusted gate verified an empty Git diff for a job that requested `review:false`. The workflow result records the skip.                                                                 |
| `blocked`           | The job needs a qualifying result before publication. Other accepted jobs in the batch may still publish.                                                                                  |

The publisher creates a result branch only for an accepted change. A changed job with `review:false` is blocked. With default review, an unchanged checkout must earn the already-satisfied verdict. A retry can update the candidate only by reviewing its new exact SHA. [Shared review and delivery](../README.md#review-and-delivery)

Use the exact published SHA in the result to look up the commit status. Confirm that the head and base are still the ones covered by the verdict before using it. The review status is evidence of native review and task acceptance. Verify the target's CI and merge requirements yourself, mark a draft ready when appropriate, and merge manually. If the candidate changes, obtain review for the new head.

```sh
gh api "repos/OWNER/REPOSITORY/commits/HEAD_SHA/status" \
  --jq '.statuses[] | select(.context == "sentinel/agent-job-review")'
```

While implementation runs, the cell logs five-minute liveness lines with elapsed time, restarts, commits, uncommitted files and time since agent output. Progress artifacts, when available, include commit and model-request summaries. The cell's `<id>.telemetry.json` records attempt exit information and gateway trace metadata. The trusted review and publisher run separately from the initial cell. Only the publisher holds target write credentials for job delivery.

## Clean up result branches

Push a fresh `jobs/cleanup/<unique-name>.json` file to `development` to start `sentinel-agent-jobs-cleanup`. Name only result branches of the form `agent-jobs/<id>-<run-id>-<attempt>`. An open draft or pull request protects the branch unless you explicitly request closure. The cleanup summary reports `deleted`, `missing`, `kept_open_pr` or `failed` for each entry.

```json
{
  "branches": [
    {
      "repository": "ubiquity/ubq.fi-router",
      "branch": "agent-jobs/router-add-tests-44195622667-1",
      "closePullRequest": true
    }
  ]
}
```

## Owner setup

The protected jobs use the environment selected by `SENTINEL_AGENT_JOBS_ENVIRONMENT`, which defaults to `sentinel-supervisor`. Admit the exact `development` ref and retain the existing branch rules. The protected environment supplies `SENTINEL_SUPERVISOR_APP_PRIVATE_KEY` to the jobs that mint scoped App tokens and `UOS_AI_TOKEN` to the jobs that use the model gateway. Install the Sentinel App on each target with the permissions needed for checkout, publication, commit status and any requested draft PR. Keep credentials out of request files and Actions inputs.

Use `SENTINEL_AGENT_JOBS_CODEX_VERSION` to pin the initial implementation client's Codex version.
