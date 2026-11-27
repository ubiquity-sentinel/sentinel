#!/usr/bin/env bash
# Usage estimate shared by private supervisor pacing and on-demand admission.
set -euo pipefail

unavailable() {
  printf '%s\n' "$1" >&2
  exit 1
}
number() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]] || unavailable "unreadable $2"
}

month=${1:-}
[[ "$month" =~ ^[0-9]{4}-(0[1-9]|1[0-2])-01$ ]] || unavailable "the UTC month is unreadable"
used=0
for workflow in supervisor.yml ci.yml agent-jobs.yml agent-jobs-cleanup.yml; do
  ids=$(gh api --paginate "repos/$GH_REPO/actions/workflows/$workflow/runs?created=%3E%3D$month&per_page=100" --jq '.workflow_runs[].id' 2>/dev/null) || unavailable "this month's $workflow runs are unreadable"
  for run in $ids; do
    number "$run" "$workflow run id"
    durations=$(gh api --paginate "repos/$GH_REPO/actions/runs/$run/jobs?filter=all&per_page=100" --jq '
      .jobs[] |
      select(.started_at != null and .completed_at != null and .conclusion != "skipped") |
      (if any(.labels[]; startswith("macos-")) then 10
       elif any(.labels[]; startswith("windows-")) then 2
       elif any(.labels[]; startswith("ubuntu-")) then 1
       else error("unknown hosted runner") end) as $multiplier |
      (((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601) + 59) / 60 | floor) * $multiplier
    ' 2>/dev/null) || unavailable "the jobs of run $run are unreadable"
    for minutes in $durations; do
      number "$minutes" "job minutes of run $run"
      used=$((used + minutes))
    done
  done
done
for workflow in private-daily.yml private-sync.yml; do
  runs=$(gh api "repos/$GH_REPO/actions/workflows/$workflow/runs?created=%3E%3D$month&per_page=1" --jq .total_count 2>/dev/null) || unavailable "this month's $workflow runs are unreadable"
  number "$runs" "$workflow run count"
  used=$((used + runs))
done
printf '%s\n' "$used"
