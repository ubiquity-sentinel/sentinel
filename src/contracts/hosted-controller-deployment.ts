/** Trusted controller placement. Change only in reviewed deployment source. */
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
    binding: {
      ...entry,
      deployment: { ...entry.deployment, supervisorWorkflowId, ciWorkflowId },
    },
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

/** The selected entry's role; only the public entry works Sentinel itself. */
export const HOSTED_CONTROLLER_ROLE: HostedControllerRoleV1 =
  SELECTED.binding.role;
/**
 * Closed reason every public-only path (Sentinel's own tracker, backup CI,
 * owner install) reports on the private role instead of re-pointing itself.
 */
export const PRIVATE_DEPLOYMENT_REASON = "private_deployment";
/** Retired pre-migration names of the selected entry, for state reads only. */
export const HOSTED_CONTROLLER_RETIRED_REPOSITORY: string | null =
  SELECTED.binding.retiredRepository;
export const HOSTED_CONTROLLER_RETIRED_RUNTIME_ID: string | null =
  SELECTED.binding.retiredRuntimeId;
/** Committed App self installation of the selected entry, when committed. */
export const HOSTED_CONTROLLER_SELF_INSTALLATION_ID: number | null =
  SELECTED.binding.selfInstallationId;

/** Per-cycle cell ceilings of one deployment; null is the platform bound. */
export interface HostedControllerCycleCellsV1 {
  /** Implementation (matrix) cells one planner pass may grant. */
  readonly matrix: number;
  /** Repository repair cells one fan-out plan may hold. */
  readonly repair: number;
}

/**
 * GitHub Free (owner, 2026-11-22: "Private deploy if it isn't free then no
 * go"): the private role runs one supervisor cycle a day, and a cycle costs
 * about one billed minute per job minute, so its cells are bounded. One
 * implementation cell lets one issue start each day; two repair cells let the
 * records already in flight (review observation, CI read, merge) of two
 * repositories progress beside it, and every record a cell does not take
 * stays with the serial pass. The public role keeps the platform bounds (the
 * owner lifted artificial caps there).
 */
export const PRIVATE_CYCLE_CELLS: HostedControllerCycleCellsV1 = Object.freeze(
  { matrix: 1, repair: 2 },
);
export const HOSTED_CONTROLLER_CYCLE_CELLS:
  | HostedControllerCycleCellsV1
  | null = SELECTED.binding.role === "private" ? PRIVATE_CYCLE_CELLS : null;

export const HOSTED_CONTROLLER_DEPLOYMENT = Object.freeze(
  SELECTED.binding.deployment,
);

export const HOSTED_CONTROLLER_REPOSITORY =
  `${HOSTED_CONTROLLER_DEPLOYMENT.owner}/${HOSTED_CONTROLLER_DEPLOYMENT.name}`;
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
