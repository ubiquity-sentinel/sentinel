# Throughput readback

```sh
sentinel report --since 2026-10-29
sentinel report --since 2026-10-29 --until 2026-11-05 --metrics week.jsonl
```

The report is read-only. It reads `.sentinel/pass-metrics.jsonl` by default;
`--metrics` selects another local export. It does not dispatch workflows, query
GitHub, start models or write state. Missing/empty metrics and malformed or
conflicting records fail rather than imply zero throughput. Dates must be
`YYYY-MM-DD` (midnight UTC) or ISO UTC timestamps ending in `Z`. `--until`
defaults to now and is exclusive. `n/a` means a ratio has a zero denominator.

## Input and interpretation

The versioned input contract is
[`PassMetricsV1`](../src/contracts/pass-metrics.ts). Supply one JSON object per
line, or a JSON array. A sanitized example covering two repositories is in
[`tests/fixtures/metrics/pass-metrics.jsonl`](../tests/fixtures/metrics/pass-metrics.jsonl).

- Each globally unique pass `id` includes its controller run attempt. Identical
  repeated exports are deduplicated; conflicting repeats fail. Records need not
  be ordered. Do not mix overlapping exports of cumulative counters.
- `startedAt` and `finishedAt` bound a controller pass. The report selects
  passes whose finish is in `[since, until)`. Controller minutes are the sum of
  their complete durations. `cellMinutes` is a per-pass delta summed across
  model cells, including concurrent cells; duty cycle may exceed 100%. These are
  model cell minutes, not tokens, CPU utilization or billing charges.
- Repository `merges` contain PR `number` and actual `mergedAt`. They are unique
  by repository/PR and filtered by merge timestamp as well as pass finish time.
  Daily rows use UTC days, including zero-merge days. `Merges/day` uses the
  exact window duration, including partial days.
- `refreshCommits`, `targetCiRuns` and `plannerRefusals` are **per-pass
  deltas**. They are summed, not subtracted from cumulative snapshots. The first
  two are divided by that repository's window merges, not by controller runs.
- `deliveryQueueDepth`, `blockedCauses` and `liveRecords` are **complete
  snapshots** per repository, including explicit zero/empty values. Only the
  latest supplied snapshot is used; absence from a later pass does not erase an
  earlier sample. Snapshot times are printed so old observations are visible.
  Conflicting snapshots with equal times fail. Live records exclude terminal
  work; `waitingSince` is the start of the current wait, not issue creation. The
  ten longest waits are ranked at the window end, with repository/id tie-breaks.

The per-pass producer is a separate prerequisite and is not present in this base
revision. This command defines/consumes its local export; it does not fabricate
metrics from workflow success or claim that snapshots are current live state.
Incomplete exports cannot establish complete window coverage. A pass straddling
an edge may contribute full pass deltas, or not yet have completed; retain this
window noise when independently comparing GitHub counts.

## Hosted acceptance (separate from fixture tests)

Retain a real week's complete pass export, its provenance and exact UTC bounds.
Run the second command above with those bounds. Independently count merged PRs,
refresh commits and target CI runs in GitHub for the same repositories and
window; reconcile controller-pass edge noise and any missing metrics. A local
fixture pass is not evidence that this hosted comparison succeeded.
