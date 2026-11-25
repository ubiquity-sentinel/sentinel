/** Deployment policy as expressed by GitHub Actions, which cannot import TypeScript. */

type WorkflowAdmission =
  | "public-only"
  | "private-only"
  | "both"
  | "role-dependent";
type WorkflowSwitch =
  | "agentJobs"
  | "backupCi"
  | "developmentPushCiOnly"
  | "gatewayMonitor"
  | "privateCadence"
  | "queueCanary"
  | "release";

interface WorkflowJob {
  readonly admission: WorkflowAdmission;
  readonly if?: string;
  /** A dependency carrying the role gate of this job. */
  readonly inheritsGateFrom?: string;
  readonly profileSwitch?: WorkflowSwitch;
  /** Workflow fields that name or use the current or other controller. */
  readonly repositoryFields?: Readonly<
    Record<string, string | readonly string[]>
  >;
}

const PUBLIC = "github.repository == '@public.repository@'";
const PRIVATE = "github.repository == '@private.repository@'";
const DEVELOPMENT = "github.ref == '@public.sourceRef@'";
const SUPERVISOR = "github.ref == '@public.supervisorRef@'";
const REPOSITORY = "${{ github.repository }}";
const HUMAN_DEVELOPMENT_PUSH = PUBLIC + " && " + DEVELOPMENT +
  " && github.event.sender.type == 'User' && " +
  "github.event.sender.login == github.actor && !endsWith(github.actor, '[bot]')";
const CI_ADMISSION = PUBLIC +
  " || (github.event_name == 'push' && github.ref == '@private.sourceRef@')";
const BACKUP_CI_ENABLED =
  "contains(fromJSON('[\"shadow\",\"on\"]'), vars.SENTINEL_BACKUP_CI || 'on')";
const GATEWAY_MONITOR_ADMISSION = PUBLIC + " && " + DEVELOPMENT +
  " && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')";

const SUPERVISOR_RUN =
  "!cancelled() && needs.maintenance.result == 'success' && " +
  "needs.prepare.result == 'success' && " + SUPERVISOR +
  " && needs.prepare.outputs.run == 'true'";
const SUPERVISOR_CELLS = SUPERVISOR_RUN +
  " && needs.matrix_plan.result == 'success'";
const SUPERVISOR_REPOSITORIES = {
  // This is the public target list's self exclusion on both deployments.
  "steps[targets].run": [
    "repositories=$(jq -r --arg self '@public.repository@' 'map(select(. != $self)) | join(\",\")' sentinel.targets.json)",
  ],
  "steps[self-token].with.owner": "${{ " + PRIVATE +
    " && '@private.selfTokenOwner@' || '@public.selfTokenOwner@' }}",
} as const;

/** Checked against all workflow jobs and controller repository references.
 * Facts surrounded by @ signs are supplied by the committed deployment profiles.
 */
export const HOSTED_CONTROLLER_WORKFLOW_TABLE: Readonly<
  Record<string, Readonly<Record<string, WorkflowJob>>>
> = {
  "agent-jobs-cleanup.yml": {
    plan: {
      admission: "public-only",
      profileSwitch: "agentJobs",
      if: HUMAN_DEVELOPMENT_PUSH,
    },
    delete: {
      admission: "public-only",
      profileSwitch: "agentJobs",
      if: PUBLIC +
        " && needs.plan.outputs.has-work == 'true' && needs.plan.outputs.control-sha != ''",
    },
  },
  "agent-jobs-delivery.yml": {
    cell: {
      admission: "public-only",
      profileSwitch: "agentJobs",
      if: PUBLIC + " && " + DEVELOPMENT +
        " && github.workflow_ref == '@public.repository@/.github/workflows/agent-jobs.yml@@public.sourceRef@'",
    },
    review: {
      admission: "public-only",
      profileSwitch: "agentJobs",
      inheritsGateFrom: "cell",
      if:
        "needs.cell.result == 'success' && needs.cell.outputs.artifact-id != ''",
    },
    publish: {
      admission: "public-only",
      profileSwitch: "agentJobs",
      inheritsGateFrom: "review",
      if:
        "needs.review.result == 'success' && needs.review.outputs.artifact-id != '' && " +
        "needs.review.outputs.run-tag != ''",
    },
  },
  "agent-jobs.yml": {
    plan: {
      admission: "public-only",
      profileSwitch: "agentJobs",
      if: HUMAN_DEVELOPMENT_PUSH,
    },
    delivery: {
      admission: "public-only",
      profileSwitch: "agentJobs",
      if: PUBLIC + " && !cancelled() && needs.plan.result == 'success' && " +
        "needs.plan.outputs.has-work == 'true' && needs.plan.outputs.control-sha != ''",
    },
  },
  "backup-ci-leg.yml": {
    leg: {
      admission: "public-only",
      profileSwitch: "backupCi",
      if: PUBLIC +
        " && github.ref == 'refs/heads/sentinel-backup-legs' && github.run_attempt == 1 && " +
        'contains(fromJSON(\'["ubuntu-latest","ubuntu-24.04","ubuntu-22.04"]\'), inputs.runs_on)',
    },
  },
  "backup-ci.yml": {
    backup_ci: {
      admission: "public-only",
      profileSwitch: "backupCi",
      if: PUBLIC + " && " + SUPERVISOR + " && github.run_attempt == 1 && (" +
        BACKUP_CI_ENABLED + ")",
      repositoryFields: {
        "steps[self-token].with.owner": "@public.selfTokenOwner@",
      },
    },
  },
  "ci.yml": {
    quality: {
      admission: "role-dependent",
      profileSwitch: "developmentPushCiOnly",
      if: CI_ADMISSION,
    },
    "test-shards": {
      admission: "role-dependent",
      profileSwitch: "developmentPushCiOnly",
      if: CI_ADMISSION,
    },
    "test-local": {
      admission: "role-dependent",
      profileSwitch: "developmentPushCiOnly",
      if: "${{ always() && (" + CI_ADMISSION + ") }}",
    },
  },
  "daily-gateway-failures.yml": {
    collect: {
      admission: "public-only",
      profileSwitch: "gatewayMonitor",
      if: GATEWAY_MONITOR_ADMISSION,
    },
    publish: {
      admission: "public-only",
      profileSwitch: "gatewayMonitor",
      if: GATEWAY_MONITOR_ADMISSION +
        " && needs.collect.result == 'success' && " +
        "needs.collect.outputs.qualifies == 'true' && needs.collect.outputs.findings_json != ''",
    },
  },
  "gateway-source-verify.yml": {
    verify: { admission: "public-only", if: PUBLIC },
  },
  "local-status.yml": {
    report: { admission: "both" },
  },
  "observe.yml": {
    observe: { admission: "both" },
  },
  "private-daily.yml": {
    daily: {
      admission: "private-only",
      profileSwitch: "privateCadence",
      if: PRIVATE,
      repositoryFields: {
        "steps[Start a supervisor cycle within the accrued allowance].env.GH_REPO":
          REPOSITORY,
        "steps[Start a supervisor cycle within the accrued allowance].run": [
          'active=$(gh api "repos/$GH_REPO/actions/workflows/supervisor.yml/runs?status=$status&per_page=1" ' +
          '--jq .total_count 2>/dev/null) || none "$status supervisor runs are unreadable"',
          'ci=$(gh api "repos/$GH_REPO/commits/$launcher/check-runs?check_name=test-local&filter=latest&per_page=100" ' +
          '--jq \'[.check_runs[] | select(.app.slug == "github-actions")] | if length > 0 and all(.status == ' +
          '"completed" and .conclusion == "success") then "green" else "not_green" end\' 2>/dev/null) || none ' +
          '"the launcher\'s checks are unreadable"',
          'ids=$(gh api --paginate "repos/$GH_REPO/actions/workflows/$workflow/runs?created=%3E%3D$month&per_page=100" ' +
          "--jq '.workflow_runs[].id' 2>/dev/null) || none \"this month's $workflow runs are unreadable\"",
          'durations=$(gh api --paginate "repos/$GH_REPO/actions/runs/$run/jobs?filter=all&per_page=100" ' +
          "--jq '.jobs[] | select(.started_at != null and .completed_at != null) | " +
          "(((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601) + 59) / 60 | floor)' " +
          '2>/dev/null) || none "the jobs of run $run are unreadable"',
          'runs=$(gh api "repos/$GH_REPO/actions/workflows/$workflow/runs?created=%3E%3D$month&per_page=1" ' +
          '--jq .total_count 2>/dev/null) || none "this month\'s $workflow runs are unreadable"',
          'gh workflow run supervisor.yml --repo "$GH_REPO" --ref sentinel-supervisor',
        ],
      },
    },
  },
  "private-sync.yml": {
    sync: {
      admission: "private-only",
      profileSwitch: "privateCadence",
      if: PRIVATE,
      repositoryFields: {
        "steps[self-token].with.owner": "@private.selfTokenOwner@",
        "steps[Fast-forward both branches to the public launcher].run": [
          "git fetch -q --no-tags https://github.com/@public.repository@.git @public.supervisorRef@",
          'private="https://github.com/${GITHUB_REPOSITORY}.git"',
        ],
      },
    },
  },
  "queue-canary.yml": {
    canary: {
      admission: "public-only",
      profileSwitch: "queueCanary",
      if: PUBLIC + " && " + SUPERVISOR +
        " && github.event_name == 'workflow_dispatch'",
    },
  },
  "release.yml": {
    release: { admission: "public-only", profileSwitch: "release", if: PUBLIC },
  },
  "repair.yml": {
    dispatch: {
      admission: "public-only",
      if: PUBLIC,
      repositoryFields: {
        "steps[Dispatch the exact protected supervisor ref].run": [
          "gh api --method POST repos/@public.repository@/actions/workflows/supervisor.yml/dispatches -f ref=sentinel-supervisor",
        ],
      },
    },
  },
  "sentinel-scheduler.yml": {
    tick: {
      admission: "public-only",
      if: PUBLIC,
      repositoryFields: {
        "steps[Dispatch the trusted supervisor dispatcher].env.GH_REPO":
          REPOSITORY,
      },
    },
  },
  "supervisor-dispatch.yml": {
    backup_completion: {
      admission: "public-only",
      profileSwitch: "backupCi",
      if: PUBLIC + " && github.event_name == 'workflow_run' && " +
        "(github.event.workflow_run.path == '.github/workflows/backup-ci-leg.yml' || " +
        "github.event.workflow_run.path == '.github/workflows/ci.yml') && " +
        "github.event.workflow_run.head_repository.full_name == github.repository",
    },
    dispatch: {
      admission: "public-only",
      if: PUBLIC + " && (github.event_name != 'workflow_run' || " +
        "(github.event.workflow_run.path == '.github/workflows/supervisor.yml' && " +
        "github.event.workflow_run.head_branch == 'sentinel-supervisor' && " +
        "github.event.workflow_run.head_repository.full_name == github.repository))",
      repositoryFields: {
        "steps[Wait for the completed parent supervisor].env.GH_REPO":
          REPOSITORY,
        "steps[Wait for the completed parent supervisor].run": [
          'status=$(gh run view "$PARENT_RUN_ID" --repo "$GH_REPO" --json status --jq .status)',
        ],
        "steps[Dispatch the backup CI pass].env.GH_REPO": REPOSITORY,
      },
    },
  },
  "supervisor.yml": {
    maintenance: {
      admission: "both",
      if: SUPERVISOR,
      repositoryFields: SUPERVISOR_REPOSITORIES,
    },
    prepare: {
      admission: "both",
      if: "always() && needs.maintenance.result == 'success' && " + SUPERVISOR,
      repositoryFields: SUPERVISOR_REPOSITORIES,
    },
    matrix_plan: {
      admission: "both",
      if: "${{ " + SUPERVISOR_RUN +
        " && needs.prepare.outputs.modelStartsEnabled == 'true' }}",
      repositoryFields: SUPERVISOR_REPOSITORIES,
    },
    matrix_cell: {
      admission: "both",
      if: "${{ " + SUPERVISOR_CELLS +
        " && needs.matrix_plan.outputs.hasCells == 'true' }}",
      repositoryFields: {
        ...SUPERVISOR_REPOSITORIES,
        "timeout-minutes": "${{ " + PRIVATE +
          " && @private.matrixCellTimeoutMinutes@ || @public.matrixCellTimeoutMinutes@ }}",
      },
    },
    repair_cell: {
      admission: "both",
      if: "${{ " + SUPERVISOR_CELLS +
        " && needs.matrix_plan.outputs.hasRepairCells == 'true' }}",
      repositoryFields: SUPERVISOR_REPOSITORIES,
    },
    repair: {
      admission: "both",
      if: "${{ " + SUPERVISOR_RUN +
        " && (needs.prepare.outputs.modelStartsEnabled != 'true' || needs.matrix_plan.result == 'success') }}",
      repositoryFields: SUPERVISOR_REPOSITORIES,
    },
    finalize: {
      admission: "both",
      if: "always() && " + SUPERVISOR,
      repositoryFields: {
        ...SUPERVISOR_REPOSITORIES,
        "steps[Chain the next dispatcher run].if": "always() && " + SUPERVISOR +
          " && " + PUBLIC,
        "steps[Chain the next dispatcher run].env.GH_REPO": REPOSITORY,
        "steps[Chain the next dispatcher run].run": [
          'gh workflow run supervisor-dispatch.yml --ref "${{ github.event.repository.default_branch }}" ' +
          '-f sentinel_parent_run_id="${{ github.run_id }}"',
        ],
      },
    },
  },
};
