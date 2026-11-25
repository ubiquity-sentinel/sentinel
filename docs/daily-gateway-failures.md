# Daily gateway failure sweep

Sentinel owns [the workflow](../.github/workflows/daily-gateway-failures.yml). GitHub Actions runs it once daily at 00:37 UTC from `ubiquity-sentinel/sentinel` on its default `development` branch. Manual runs use the same branch and are serialized with scheduled runs.

The collector reads the trailing 48 hours of failure metadata from production `ai.ubq.fi`. It records scan counts and coverage in the run summary. Bounded or incomplete coverage is reported as partial. Authentication, fetch and schema failures fail the run. An empty qualifying set skips the publisher.

Two distinct delivered requests on the current release, route and provider qualify when both show an internal gateway HTTP 500 or both show a recognized premature upstream stream ending. The publisher groups those findings by failure class and route. The summary also counts client errors, cancellations, quota and provider failures. A separate current-release table shows upstream HTTP 429s, upstream HTTP 5xx responses, and in-band upstream failure terminals returned with HTTP 200. These totals describe observed error records within the window. The table provides operational context and leaves the repair-issue eligibility rules unchanged. The error history endpoint returns at most 500 rows, so a busy window can provide a lower bound on occurrences. A confirmed repeat within that sample still qualifies.

Only the allowlisted findings summary crosses the job boundary. The publisher uses the existing `sentinel-supervisor` environment to mint a short-lived Issues write token for `ubiquity/ai.ubq.fi`. It reconciles duplicate findings against existing issues and reports created issue numbers, existing matches and any deferred findings. The workflow handles failure metadata and issue summaries. Request bodies, response bodies, ciphertext and replay keys stay outside the workflow.

Each job uses a standard GitHub-hosted Ubuntu runner with a four-minute timeout and a two-minute script timeout plus five seconds of termination grace. The daily invocation is capped at eight runner minutes with both jobs or four when publication is skipped. Standard runners in the public repository are free. The sweep makes no model calls. The two supported failure classes and nine routes allow at most 18 distinct issues in one scan. Newly filed issues can enter the existing Sentinel repair queue and consume its normal implementation and review capacity.

## Operate

Run once from the published default branch for a first check or recovery.

```sh
gh workflow run daily-gateway-failures.yml --repo ubiquity-sentinel/sentinel --ref development
```

Disable the workflow to stop the recurring run.

```sh
gh workflow disable daily-gateway-failures.yml --repo ubiquity-sentinel/sentinel
```

For the first run, verify the workflow source revision, the collector's successful production read and its coverage. Check that publication skipped on empty findings or produced the expected App-authored issue receipts. A manual run verifies the workflow path. A run with the `schedule` event verifies the daily trigger. An issue receipt verifies handoff. Repair and deployment keep their existing acceptance gates.
