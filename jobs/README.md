# Run a Sentinel operator job

Use an operator job to send a coding task to a GitHub-hosted runner. Choose an existing target branch or use the target's default branch. The planner pins its starting commit. Jobs can target repositories outside the supervisor's issue list. [On-demand mode](../README.md#on-demand-mode)

## Submit a request

Save the request as `request.json` and run the installed Sentinel dispatch helper through a human GitHub account with write access to the selected Sentinel repository.

```sh
"$HOME/.codex/skills/sentinel-dispatch/scripts/dispatch.sh" request.json
```

The helper checks GitHub visibility before sending the request. Public targets go to `ubiquity-sentinel/sentinel`. Private targets go to `ubiquity-sentinel-private/sentinel`. Split mixed batches into two requests. A private target must be writable by the deployment's App installation. The helper returns the Actions run URL. Keep the request file and URL together for progress and result lookup.

The public run displays public inputs, agent messages, Git bundles, logs and result artifacts. Send private work through the helper to the private deployment. Its Actions run holds the request and artifacts, and an accepted change is published on the verified private target. A manual dispatch leaves both Sentinel Git branches available for fast-forward sync.

Both deployments accept on-demand work on `development` using the controller pinned from `sentinel-supervisor`. The same SHA governs planning, implementation, review and publication. On private Sentinel, admit the new launcher through private CI and a healthy, model-disabled bootstrap before submitting work.

For a public-only request, the same GitHub REST endpoint accepts the JSON file through standard input.

```sh
jq -n --rawfile jobs public-request.json '{ref: "development", inputs: {jobs: $jobs}}' |
  gh api -X POST repos/ubiquity-sentinel/sentinel/actions/workflows/agent-jobs.yml/dispatches --input -
```

On the public deployment a human writer can also push a fresh `jobs/inbox/<unique-name>.json` to `development`. Intake reads the net additions across the complete push. Track a retry by the original run ID. On the private deployment use workflow dispatch for requests so private job text stays out of Git history and the weekly sync can fast-forward the mirror.

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
| `repository`      | Required                      | Target as `owner/name` in the selected deployment's visibility class. The Sentinel App needs write access for publication.                                          |
| `prompt`          | Required                      | The exact task and acceptance criteria, limited to 16,384 UTF-16 code units. The first line supplies the commit and optional PR title.                    |
| `base`            | Target's default branch       | Existing target branch for the starting commit and optional draft PR.                                                                                     |
| `review`          | `true`                        | Native review. Use `false` only for an evidence-only job whose final Git tree is unchanged.                                                               |
| `pr`              | `false`                       | Set `true` to open a draft PR for the published branch.                                                                                                   |
| `setup`           | `[]`                          | Shell commands to run in the initial checkout before the implementation agent.                                                                            |
| `minutes`         | `350`                         | Wall-clock deadline, from 1 to 350 minutes after trusted admission. Queue, setup, implementation, review and correction share that budget.                |
| `model`           | Hosted implementation default | Override the implementation and correction gateway model for this job. The code default is `gpt-6.1-sol`. Native Codex review resolves its own reviewer.  |
| `reasoningEffort` | `max`                         | Effort for implementation and correction. Choose `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra` as supported by the model.         |
| `runner`          | Public `linux-x64`, private `linux-arm64` | `linux-x64` uses `ubuntu-latest`, `linux-arm64` uses `ubuntu-24.04-arm`, `linux-arm64-26` uses `ubuntu-26.04-arm`, and `macos-arm64` uses `macos-latest`. |

Give each job its own acceptance criteria, relevant test command and a nonoverlapping scope. The planner records the first trusted admission time. Runner queue and setup use that budget, and retries use the time left. Runner and model usage follow the hosted account and gateway's existing billing. Each agent starts in a fresh clone, receives its job prompt, and reads the target's `AGENTS.md` when present. Before the agent starts, the cell sets the checkout's repository-local Git identity to the same identity it uses for cell-created commits. Agents on a cell share runner resources and have separate checkouts.

The planner groups by repository owner and runner kind. GitHub's hosted job timeout is 360 minutes and its matrix limit is 256 cells. The defaults are four agents per cell and a 20-cell budget. Prefer more cells before stacking. Optional dispatch inputs `agents_per_cell` and `max_cells` tune the batch. Push-triggered jobs use the repository settings `SENTINEL_AGENT_JOBS_PER_CELL` and `SENTINEL_AGENT_JOBS_MAX_CELLS` when set. Hosted runner capacity is shared with the supervisor and CI. Public cells can reuse a best-effort build cache keyed by owner and runner kind, with `AGENT_JOBS_CACHE_DIR` and Linux `ccache` available for compilation. Private build output stays in its own run.

### Private minutes and scheduled work

Private Sentinel checks the request against the organisation's 2,000 included Actions minutes per UTC month. The dispatcher and on-demand planner share the estimate from this deployment's Actions runs. For a batch, the planner adds the longest job deadline in each concurrent runner cell, weighted for the runner. A refusal reports the estimate, minutes remaining and minutes requested. The estimate uses completed job durations and counts daily and sync runs. GitHub also bills setup, rounding and concurrent work, so admission cannot reserve that balance. After the billing owner enables paid overage at GitHub, setting the private repository variable `SENTINEL_PRIVATE_PAID_ACTIONS_OVERAGE` to `on` allows jobs past the included allowance. The default is off.

The private daily dispatcher serializes its checks in `sentinel-private-daily` and checks for queued or running supervisors before dispatch. Each supervisor cycle owns `sentinel-supervisor` and its repair phases use `sentinel-repair`. On-demand runs use their own run IDs and result branches. They share hosted runner capacity and the included minutes, and never acquire the supervisor's concurrency groups or reserve an issue. Leave the scheduled dispatcher enabled when submitting a batch.

## Results

Read the review and publish summaries and the publication result artifact on the same deployment that accepted the request. The installed helpers accept the original request and the URL returned by dispatch.

```sh
"$HOME/.codex/skills/sentinel-dispatch/scripts/progress.sh" request.json "$run_url"
"$HOME/.codex/skills/sentinel-dispatch/scripts/result.sh" request.json "$run_url"
```

Initial cell statuses such as `changed`, `timed_out`, and `agent_failed` describe execution. The review disposition determines what reaches the target.

| Disposition         | Result                                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted`          | The publisher pushes the exact reviewed commit to `agent-jobs/<id>-<run-id>-<attempt>` and records the Sentinel App's verdict comment URL for that SHA. With `pr:true`, the draft PR carries the verdict. |
| `already_satisfied` | Native review positively verified that the pinned base already fulfilled the task. The workflow result records the verdict.                                                                               |
| `skipped_no_diff`   | The trusted gate verified an empty Git diff for a job that requested `review:false`. The workflow result records the skip.                                                                                |
| `blocked`           | The job needs a qualifying result before publication. Other accepted jobs in the batch may still publish.                                                                                                 |

The publisher creates a result branch only for an accepted change. A changed job with `review:false` is blocked. With default review, an unchanged checkout must earn the already-satisfied verdict. A corrected candidate requires a fresh review of its exact SHA. [Shared review and delivery](../README.md#review-and-delivery)

When a native review result is unavailable, Sentinel can start a fresh native review of the same exact head. It allows up to three total attempts per head, with a brief backoff before each retry and within the original job deadline. Every review attempt appears in `rounds` and `modelStarts`.

Open the authenticated Sentinel App verdict comment from the publication result. Check that GitHub attaches it to the exact published SHA and that the base and head still match the verdict. Verify the target's CI and merge requirements yourself, mark a draft ready when appropriate, and merge manually. If the candidate changes, obtain review for the new head.

While implementation runs, the cell logs five-minute liveness lines with elapsed time, restarts, commits, uncommitted files and time since agent output. Progress artifacts, when available, include commit and model-request summaries. The cell's `<id>.telemetry.json` records attempt exit information and gateway trace metadata. The trusted review and publisher run separately from the initial cell. Only the publisher holds target write credentials for job delivery.

## Clean up result branches

On public Sentinel, push a fresh `jobs/cleanup/<unique-name>.json` file to `development` to start `sentinel-agent-jobs-cleanup`. Name only result branches of the form `agent-jobs/<id>-<run-id>-<attempt>`. An open draft or pull request protects the branch unless you explicitly request closure. The cleanup summary reports `deleted`, `missing`, `kept_open_pr` or `failed` for each entry.

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

On a fast-forward-only private mirror, remove a finished result branch on its private target after checking the open PR and the exact branch. A cleanup commit on the mirror would diverge from the public launcher used by private sync.

## Owner setup

1. Merge the reviewed controller change into public `development` and verify that commit's own `test-local` check.
2. When workflows change, advance public `sentinel-supervisor` by fast-forward to the exact approved CI-green commit. The private `private-sync.yml` then fast-forwards both private branches to that launcher in one push.
3. Verify private `development` push CI, the private launcher's healthy bootstrap receipt and the installed runtime SHA. The private daily dispatcher can advance the installation when its ordinary admission checks pass.
4. Use the protected environment's existing `development` admission on the public deployment. The private deployment uses its existing App key and model token. Submit a fresh dispatch and check the returned run, pinned controller and verdict.

The shared Sentinel authority policy protects `jobs/inbox/`, `jobs/cleanup/`, the operator workflow definitions and the privileged controller code. Issue-mode publication and merge use the existing owner-landing checks for these paths. The on-demand gate uses the same authority list when reviewing changes to Sentinel's own repository. [Protected paths](../src/host/hosted-authority-protected-paths.ts)

Public Sentinel stores `SENTINEL_SUPERVISOR_APP_PRIVATE_KEY` in its protected environment. Private Sentinel also uses its repository-scoped App key during trusted admission. Configure `UOS_AI_TOKEN` as a repository secret or an organization secret available to this repository. The caller forwards it only to implementation and review. Install the Sentinel App on each target with Contents access for checkout, result branch publication and the commit comment, and Pull requests write access for any requested draft PR. Keep credentials out of request files and Actions inputs.

Use `SENTINEL_AGENT_JOBS_CODEX_VERSION` to pin the initial implementation client's Codex version.
