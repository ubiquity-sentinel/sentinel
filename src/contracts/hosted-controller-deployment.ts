/** Trusted controller placement. Change only in reviewed deployment source. */
import type { RepositoryIdentityV1 } from "./shared.ts";
import {
  expectNonEmptyString,
  expectRecord,
  fail,
  MaxText,
} from "./validation.ts";

// Native repository/workflow facts must match this committed binding. Neither
// environment variables nor target configuration may choose the controller.
export const HOSTED_CONTROLLER_DEPLOYMENT = Object.freeze(
  {
    owner: "ubiquity",
    name: "sentinel",
    sourceBranch: "development",
    supervisorBranch: "sentinel-supervisor",
    supervisorWorkflowPath: ".github/workflows/supervisor.yml",
    supervisorWorkflowId: 357012162,
    ciWorkflowPath: ".github/workflows/ci.yml",
    ciWorkflowId: 353613034,
  } as const,
);

export const HOSTED_CONTROLLER_REPOSITORY =
  `${HOSTED_CONTROLLER_DEPLOYMENT.owner}/${HOSTED_CONTROLLER_DEPLOYMENT.name}` as const;
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
