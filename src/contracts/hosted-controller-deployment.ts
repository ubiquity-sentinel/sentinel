/** Trusted controller placement. Change only in reviewed deployment source. */
import type { TargetVisibilityV1 } from "../repair/target-visibility.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import {
  expectNonEmptyString,
  expectRecord,
  fail,
  MaxText,
} from "./validation.ts";

// Native repository/workflow facts must match one committed binding of this
// closed list. GitHub's own GITHUB_REPOSITORY selects the entry a process runs
// as; neither environment variables nor target configuration may add, alter or
// otherwise choose an entry. Any other repository selects the first entry,
// whose native identity checks refuse it exactly as before the list existed.
// Both deployments run identical code (owner, 2026-11-18).
export const HOSTED_CONTROLLER_DEPLOYMENTS = Object.freeze(
  [
    Object.freeze({
      role: "public",
      retiredRepository: "ubiquity/sentinel",
      retiredRuntimeId: "ubiquity/sentinel:0:production",
      // Derived by the workflow's self-token mint; never committed here.
      selfInstallationId: null,
      deployment: Object.freeze({
        owner: "ubiquity-sentinel",
        name: "sentinel",
        sourceBranch: "development",
        supervisorBranch: "sentinel-supervisor",
        supervisorWorkflowPath: ".github/workflows/supervisor.yml",
        supervisorWorkflowId: 357012162,
        ciWorkflowPath: ".github/workflows/ci.yml",
        ciWorkflowId: 353613034,
      }),
    }),
    // Private mirror. Its ids are GitHub's numeric ids of its own supervisor.yml
    // and ci.yml (GET /repos/ubiquity-sentinel-private/sentinel/actions/workflows);
    // while either is null, selecting this entry refuses to start. The App's
    // installation on the ubiquity-sentinel-private org is its self scope.
    Object.freeze({
      role: "private",
      retiredRepository: null,
      retiredRuntimeId: null,
      selfInstallationId: 183425201,
      deployment: Object.freeze({
        owner: "ubiquity-sentinel-private",
        name: "sentinel",
        sourceBranch: "development",
        supervisorBranch: "sentinel-supervisor",
        supervisorWorkflowPath: ".github/workflows/supervisor.yml",
        supervisorWorkflowId: 428313602,
        ciWorkflowPath: ".github/workflows/ci.yml",
        ciWorkflowId: 428313556,
      }),
    }),
  ] as const,
);

export type HostedControllerRoleV1 = "public" | "private";

/** One committed entry; a null workflow id is not yet bound. */
export interface HostedControllerEntryV1 {
  readonly role: HostedControllerRoleV1;
  readonly retiredRepository: string | null;
  readonly retiredRuntimeId: string | null;
  readonly selfInstallationId: number | null;
  readonly deployment: Readonly<{
    owner: string;
    name: string;
    sourceBranch: string;
    supervisorBranch: string;
    supervisorWorkflowPath: string;
    supervisorWorkflowId: number | null;
    ciWorkflowPath: string;
    ciWorkflowId: number | null;
  }>;
}

/** A selected entry whose workflow ids are bound. */
export interface HostedControllerBindingV1 extends HostedControllerEntryV1 {
  readonly deployment: HostedControllerEntryV1["deployment"] & {
    readonly supervisorWorkflowId: number;
    readonly ciWorkflowId: number;
  };
}

export type HostedControllerSelectionV1 =
  | { ok: true; binding: HostedControllerBindingV1 }
  | {
    ok: false;
    reason: "workflow_ids_unfilled" | "private_role_unwired";
    repository: string;
  };

// The private role's gates are in place and proven through real consumers
// (tests/host/private-deployment-role_test.ts: own identity and remotes, no
// request naming the public repository, no backup CI, its self installation
// only, owner-install refusal, a reviewed target merged through its own
// surface, the closed reason for its own tracker;
// tests/host/private-deployment-lifecycle_test.ts: a private target's issue
// from intake through implementation, publication and native review request
// to a reviewed merge). A private selection still refuses to start while
// either workflow id above is null (`workflow_ids_unfilled`).
const PRIVATE_ROLE_WIRED = true;

/**
 * Pure selection over a closed list (the committed one in production). The
 * GitHub-provided repository picks an exact entry; anything else, or none,
 * picks the first entry. An entry whose ids are not committed refuses.
 */
export function selectHostedControllerDeploymentV1(
  repository: string | undefined,
  entries: readonly HostedControllerEntryV1[] = HOSTED_CONTROLLER_DEPLOYMENTS,
): HostedControllerSelectionV1 {
  const entry =
    entries.find((candidate) =>
      `${candidate.deployment.owner}/${candidate.deployment.name}` ===
        repository
    ) ?? entries[0];
  const { supervisorWorkflowId, ciWorkflowId } = entry.deployment;
  const selected = `${entry.deployment.owner}/${entry.deployment.name}`;
  if (supervisorWorkflowId === null || ciWorkflowId === null) {
    return { ok: false, reason: "workflow_ids_unfilled", repository: selected };
  }
  if (entry.role === "private" && !PRIVATE_ROLE_WIRED) {
    return { ok: false, reason: "private_role_unwired", repository: selected };
  }
  return {
    ok: true,
    binding: Object.freeze({
      ...entry,
      deployment: Object.freeze({
        ...entry.deployment,
        supervisorWorkflowId,
        ciWorkflowId,
      }),
    }),
  };
}

/** GitHub's own repository name, read only where the process may read it. */
function nativeRepository(): string | undefined {
  try {
    const grant = Deno.permissions.querySync({
      name: "env",
      variable: "GITHUB_REPOSITORY",
    });
    return grant.state === "granted"
      ? Deno.env.get("GITHUB_REPOSITORY")
      : undefined;
  } catch {
    return undefined;
  }
}

const SELECTED: HostedControllerSelectionV1 =
  selectHostedControllerDeploymentV1(nativeRepository());
if (!SELECTED.ok) {
  throw new Error(
    `hosted controller binding refused: ${SELECTED.reason} ${SELECTED.repository}`,
  );
}

/** Per-cycle cell ceilings of one deployment; null is the platform bound. */
export interface HostedControllerCycleCellsV1 {
  /** Implementation (matrix) cells one planner pass may grant. */
  readonly matrix: number;
  /** Repository repair cells one fan-out plan may hold. */
  readonly repair: number;
}

/**
 * Private cadence (2026-11-24): a measured one-cell cycle cost 17 billed
 * minutes (about 10 fixed and 7 for the implementation job); idle cost 5.
 * Batching up to six implementations shares the fixed cost. GitHub rounds
 * and bills every matrix job separately. Up to four repository repair cells
 * advance records already in flight while the serial pass keeps the rest.
 * The private dispatcher paces admission against the monthly free allowance.
 */
export const PRIVATE_CYCLE_CELLS: HostedControllerCycleCellsV1 = Object.freeze(
  { matrix: 6, repair: 4 },
);
/** All differences in behavior follow the committed binding. GitHub may confirm
 * its visibility or refuse a run, but cannot select a different set of targets. */
function hostedControllerProfileV1<T extends HostedControllerEntryV1>(
  binding: T,
) {
  const isPublic = binding.role === "public";
  return Object.freeze({
    deployment: binding.deployment as T["deployment"],
    retiredRepository: binding.retiredRepository,
    retiredRuntimeId: binding.retiredRuntimeId,
    role: binding.role,
    repository: `${binding.deployment.owner}/${binding.deployment.name}`,
    targetVisibility: binding.role,
    worksControllerTargets: isPublic,
    excludedTargetReason: isPublic
      ? "private_repository" as const
      : "public_repository" as const,
    cycleCells: isPublic ? null : PRIVATE_CYCLE_CELLS,
    selfObservation: isPublic,
    release: isPublic,
    backupCi: isPublic,
    agentJobs: isPublic,
    chaining: isPublic,
    privateCadence: !isPublic,
    developmentPushCiOnly: !isPublic,
    matrixCellTimeoutMinutes: isPublic ? 300 : 120,
    selfTokenOwner: binding.deployment.owner,
    selfInstallationId: binding.selfInstallationId,
    ownerDevelopmentInstall: isPublic,
    requireInstalledLauncher: !isPublic,
    queueCanary: isPublic,
    gatewayMonitor: isPublic,
    gatewaySourceVerify: isPublic,
    supervisorDispatcher: isPublic,
  });
}
export type HostedControllerProfileV1 = ReturnType<
  typeof hostedControllerProfileV1
>;
export const HOSTED_CONTROLLER_PROFILES = Object.freeze(
  HOSTED_CONTROLLER_DEPLOYMENTS.map(hostedControllerProfileV1),
);
export const PUBLIC_CONTROLLER_PROFILE = HOSTED_CONTROLLER_PROFILES[0];
export const HOSTED_CONTROLLER_PROFILE = hostedControllerProfileV1(
  SELECTED.binding,
);
/** The selected entry's role; only the public entry works Sentinel itself. */
export const HOSTED_CONTROLLER_ROLE: HostedControllerRoleV1 =
  HOSTED_CONTROLLER_PROFILE.role;
/**
 * Closed reason every public-only path (Sentinel's own tracker, backup CI,
 * owner install) reports on the private role instead of re-pointing itself.
 */
export const PRIVATE_DEPLOYMENT_REASON = "private_deployment";
/** Retired pre-migration names of the selected entry, for state reads only. */
export const HOSTED_CONTROLLER_RETIRED_REPOSITORY: string | null =
  HOSTED_CONTROLLER_PROFILE.retiredRepository;
export const HOSTED_CONTROLLER_RETIRED_RUNTIME_ID: string | null =
  HOSTED_CONTROLLER_PROFILE.retiredRuntimeId;
/** Committed App self installation of the selected entry, when committed. */
export const HOSTED_CONTROLLER_SELF_INSTALLATION_ID: number | null =
  HOSTED_CONTROLLER_PROFILE.selfInstallationId;

export const HOSTED_CONTROLLER_CYCLE_CELLS =
  HOSTED_CONTROLLER_PROFILE.cycleCells;
export const HOSTED_CONTROLLER_DEPLOYMENT =
  HOSTED_CONTROLLER_PROFILE.deployment;
export const HOSTED_CONTROLLER_REPOSITORY =
  HOSTED_CONTROLLER_PROFILE.repository;

/** Fixed public artifacts and scope-zero repair contracts must never follow a mirror. */
export function isPublicControllerSlugV1(slug: unknown): boolean {
  return slug === PUBLIC_CONTROLLER_PROFILE.repository;
}
export function isPublicControllerNameV1(owner: string, name: string): boolean {
  return owner === HOSTED_CONTROLLER_DEPLOYMENTS[0].deployment.owner &&
    name === HOSTED_CONTROLLER_DEPLOYMENTS[0].deployment.name;
}
export function isPublicControllerScopeV1(
  repository: RepositoryIdentityV1,
): boolean {
  return repository.installationId === 0 &&
    isPublicControllerNameV1(repository.owner, repository.name);
}

/** Native proofs must identify an exact committed repository, including on an unknown fork. */
export function deploymentRunsServiceV1(
  repository: unknown,
  service:
    | "release"
    | "backupCi"
    | "agentJobs"
    | "ownerDevelopmentInstall"
    | "queueCanary"
    | "gatewayMonitor",
): boolean {
  return HOSTED_CONTROLLER_PROFILES.some((profile) =>
    profile.repository === repository && profile[service]
  );
}

export function isDeploymentSelfSlugV1(
  profile: HostedControllerProfileV1,
  slug: string,
): boolean {
  return profile.repository.toLowerCase() === slug.toLowerCase();
}

export class HostedControllerVisibilityRefusalV1 extends Error {
  constructor(
    readonly reason:
      | "deployment_visibility_mismatch"
      | "deployment_visibility_unavailable"
      | "private_controller_self_listed",
    readonly profile: HostedControllerProfileV1,
    readonly observed: TargetVisibilityV1,
  ) {
    super(
      `${reason}: ${profile.repository} expected ${profile.targetVisibility}, observed ${observed}`,
    );
  }
}

export const DEPLOYMENT_REFUSAL_KIND = "sentinel_deployment_refused";
interface DeploymentRefusalLineV1 {
  kind: typeof DEPLOYMENT_REFUSAL_KIND;
  reason: HostedControllerVisibilityRefusalV1["reason"];
  repository: string;
  expected: HostedControllerRoleV1;
  observed: TargetVisibilityV1;
}

/** Only committed identifiers and closed codes may leave a captured child log. */
export function parseDeploymentRefusalLineV1(
  value: unknown,
): DeploymentRefusalLineV1 | null {
  if (!value || typeof value !== "object") return null;
  const line = value as Record<string, unknown>;
  const profile = HOSTED_CONTROLLER_PROFILES.find((p) =>
    p.repository === line.repository
  );
  if (
    line.kind !== DEPLOYMENT_REFUSAL_KIND || !profile ||
    line.expected !== profile.targetVisibility ||
    Object.keys(line).sort().join() !==
      "expected,kind,observed,reason,repository"
  ) return null;
  const { reason, observed } = line;
  if (
    reason !== "deployment_visibility_mismatch" &&
    reason !== "deployment_visibility_unavailable" &&
    reason !== "private_controller_self_listed"
  ) return null;
  if (
    observed !== "public" && observed !== "private" && observed !== "unknown"
  ) return null;
  return {
    kind: DEPLOYMENT_REFUSAL_KIND,
    reason,
    repository: profile.repository,
    expected: profile.targetVisibility,
    observed,
  };
}

export async function verifyDeploymentTargetScopeV1(
  profile: HostedControllerProfileV1,
  selfListed: boolean,
  readVisibility: () => Promise<TargetVisibilityV1>,
): Promise<HostedControllerProfileV1> {
  const refuse = (
    reason: HostedControllerVisibilityRefusalV1["reason"],
    observed: TargetVisibilityV1,
  ): never => {
    const error = new HostedControllerVisibilityRefusalV1(
      reason,
      profile,
      observed,
    );
    console.log(
      JSON.stringify({
        kind: DEPLOYMENT_REFUSAL_KIND,
        reason,
        repository: profile.repository,
        expected: profile.targetVisibility,
        observed,
      }),
    );
    throw error;
  };
  if (selfListed && !profile.worksControllerTargets) {
    refuse("private_controller_self_listed", "unknown");
  }
  let observed: TargetVisibilityV1;
  try {
    observed = await readVisibility();
  } catch {
    observed = "unknown";
  }
  if (observed === "unknown") {
    // Losing a read cannot widen the public allowlist. The private deployment
    // needs affirmative evidence before handling any private material.
    if (profile.targetVisibility === "private") {
      refuse("deployment_visibility_unavailable", observed);
    }
  } else if (observed !== profile.targetVisibility) {
    refuse("deployment_visibility_mismatch", observed);
  }
  return profile;
}

export function deploymentWorksTargetV1(
  profile: HostedControllerProfileV1,
  visibility: TargetVisibilityV1,
): boolean {
  return visibility === profile.targetVisibility;
}

export const HOSTED_CONTROLLER_SELF: Readonly<RepositoryIdentityV1> = Object
  .freeze({
    owner: HOSTED_CONTROLLER_DEPLOYMENT.owner,
    name: HOSTED_CONTROLLER_DEPLOYMENT.name,
    installationId: 0,
  });
export const HOSTED_CONTROLLER_API_PATH =
  `/repos/${HOSTED_CONTROLLER_REPOSITORY}`;
export const HOSTED_CONTROLLER_REMOTE =
  `https://github.com/${HOSTED_CONTROLLER_REPOSITORY}.git`;
export const HOSTED_CONTROLLER_SOURCE_REF =
  `refs/heads/${HOSTED_CONTROLLER_DEPLOYMENT.sourceBranch}`;
export const HOSTED_CONTROLLER_SUPERVISOR_REF =
  `refs/heads/${HOSTED_CONTROLLER_DEPLOYMENT.supervisorBranch}`;
export const HOSTED_CONTROLLER_WORKFLOW_REF =
  `${HOSTED_CONTROLLER_REPOSITORY}/${HOSTED_CONTROLLER_DEPLOYMENT.supervisorWorkflowPath}@${HOSTED_CONTROLLER_SUPERVISOR_REF}`;
export const HOSTED_CONTROLLER_RUNTIME_ID =
  `${HOSTED_CONTROLLER_REPOSITORY}:0:production`;

/** True for the repository of any committed deployment, either role. */
export function isHostedControllerDeploymentSlugV1(slug: string): boolean {
  const wanted = slug.toLowerCase();
  return HOSTED_CONTROLLER_DEPLOYMENTS.some((entry) =>
    `${entry.deployment.owner}/${entry.deployment.name}`.toLowerCase() ===
      wanted
  );
}

/** Scope0 identifies this controller, independently of App-backed targets. */
export function isHostedControllerRepository(
  repository: RepositoryIdentityV1,
): boolean {
  return repository.installationId === HOSTED_CONTROLLER_SELF.installationId &&
    repository.owner === HOSTED_CONTROLLER_SELF.owner &&
    repository.name === HOSTED_CONTROLLER_SELF.name;
}

/** Raw native repository shape; fixed repair-target CI has a separate scope. */
export function expectHostedControllerRepository(
  value: unknown,
  path: string,
): void {
  const repository = expectRecord(value, path);
  if (
    expectNonEmptyString(
      repository.full_name,
      `${path}.full_name`,
      MaxText.owner + 1 + MaxText.name,
    ) !== HOSTED_CONTROLLER_REPOSITORY
  ) {
    fail(
      `${path}.full_name`,
      "invalid_value",
      "unexpected controller repository",
    );
  }
}

export interface HostedControllerMaintenanceIdentity {
  repository: string | null;
  ref: string | null;
  job: string | null;
  runId: string | null;
  runAttempt: string | null;
  workflowRef: string | null;
  sha: string | null;
  workflowSha: string | null;
  checkoutHead: string | null;
  checkoutClean: boolean;
}

/** Current maintenance uses its own native identity, never historical pins. */
export function isHostedControllerMaintenanceIdentity(
  input: HostedControllerMaintenanceIdentity,
): boolean {
  const positive = (value: string | null) =>
    value !== null && /^[1-9][0-9]*$/.test(value) &&
    Number.isSafeInteger(Number(value));
  return input.repository === HOSTED_CONTROLLER_REPOSITORY &&
    input.ref === HOSTED_CONTROLLER_SUPERVISOR_REF &&
    input.job === "maintenance" && positive(input.runId) &&
    positive(input.runAttempt) &&
    input.workflowRef === HOSTED_CONTROLLER_WORKFLOW_REF &&
    input.sha !== null && /^[0-9a-f]{40}$/.test(input.sha) &&
    input.workflowSha === input.sha && input.checkoutHead === input.sha &&
    input.checkoutClean;
}

/** Deployment policy as expressed by GitHub Actions, which cannot import TypeScript. */

type WorkflowSwitch =
  | "agentJobs"
  | "backupCi"
  | "developmentPushCiOnly"
  | "supervisorDispatcher"
  | "gatewaySourceVerify"
  | "gatewayMonitor"
  | "privateCadence"
  | "queueCanary"
  | "release";

type WorkflowJob =
  & (
    | { readonly admission: "both"; readonly profileSwitch?: never }
    | {
      readonly admission: "public-only" | "private-only" | "role-dependent";
      readonly profileSwitch: WorkflowSwitch;
    }
  )
  & {
    readonly if?: string;
    /** A dependency carrying the role gate of this job. */
    readonly inheritsGateFrom?: string;
    /** Workflow fields that name or use the current or other controller. */
    readonly repositoryFields?: Readonly<
      Record<string, string | readonly string[]>
    >;
  };

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
    verify: {
      admission: "public-only",
      profileSwitch: "gatewaySourceVerify",
      if: PUBLIC,
    },
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
      profileSwitch: "supervisorDispatcher",
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
      profileSwitch: "supervisorDispatcher",
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
      profileSwitch: "supervisorDispatcher",
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
