// client ci wire.

import type { PortResultV1 } from "../contracts/ports.ts";
import { portError } from "../contracts/ports.ts";
import { isGitSha } from "../contracts/brands.ts";
import {
  expectArray,
  expectEnum,
  expectNonEmptyString,
  expectNullableString,
  expectPositiveInt,
  expectRecord,
  fail,
  MaxText,
} from "../contracts/validation.ts";
import type { ApproveExactCiRunInputV1 } from "./client-contracts.ts";

/**
 * Exact self-target CI approval identity. The approval endpoint is exercised
 * only for the scope-0 `Ubiquity-Sentinel/sentinel` repository (explicit no-App local
 * credential scope); every identity below is revalidated before any POST.
 */
export const CI_REPOSITORY_FULL_NAME = "Ubiquity-Sentinel/sentinel";

export const CI_REPOSITORY_API_URL =
  "https://api.github.com/repos/Ubiquity-Sentinel/sentinel";

export const CI_WORKFLOW_FILE = "ci.yml";

export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

export const CI_BASE_REF = "development";

/**
 * Bounded transition set for the pull-request author and run actor of an exact
 * self-target run: a runtime at an older installed revision acts as
 * `github-actions[bot]`, one after this migration as `ubiquity-sentinel[bot]`,
 * the login of the surviving `ubiquity-sentinel` App. This dual acceptance is a
 * scoped transition rule; remove the old login after the first app-authored
 * approval is observed.
 */
export const CI_APPROVER_LOGINS: readonly string[] = [
  "github-actions[bot]",
  "ubiquity-sentinel[bot]",
];

/** One page only: a longer or truncated list is never partially approved. */
export const CI_APPROVAL_MAX_RUNS = 100;

export const CI_APPROVAL_SCOPE =
  "CI approval is restricted to the scope-0 self-target repository";

export const CI_APPROVAL_AMBIGUOUS =
  "CI approval found more than one matching run";

export const CI_APPROVAL_BOUND = "CI approval run list exceeded its bound";

export const CI_APPROVAL_RECONCILE =
  "CI approval outcome could not be reconciled";

// ---------------------------------------------------------------------------
// Exact self-target CI approval wire validation
// ---------------------------------------------------------------------------

/** Selected run identity retained from the bounded list and revalidated. */
export interface ExactCiRunIdentityV1 {
  id: number;
  attempt: number;
}

export interface ExactCiRunV1 {
  id: number;
  attempt: number;
  actionRequired: boolean;
}

/** Raw PR repository identity bound into every run association. */
export interface ExactCiPullIdentityV1 {
  repositoryId: number;
}

export function validateCiApprovalInput(
  input: ApproveExactCiRunInputV1,
): PortResultV1<never> | null {
  if (!Number.isSafeInteger(input.number) || input.number < 1) {
    return portError("invalid", "invalid pull request number");
  }
  if (typeof input.head !== "string" || !isGitSha(input.head)) {
    return portError("invalid", "invalid candidate head");
  }
  if (
    typeof input.headRef !== "string" || input.headRef.length === 0 ||
    input.headRef.length > MaxText.branch || /[\r\n]/.test(input.headRef)
  ) {
    return portError("invalid", "invalid candidate head ref");
  }
  return null;
}

/**
 * Raw PR identity: open, trusted author, exact head/base ref and repository.
 * The authenticated self repository is bound by its real numeric id (never
 * hard-coded): head/base repository ids must agree.
 */
export function parseExactCiPull(
  value: unknown,
  input: ApproveExactCiRunInputV1,
): ExactCiPullIdentityV1 {
  const obj = expectRecord(value, "$");
  const number = expectPositiveInt(obj.number, "$.number");
  if (number !== input.number) {
    fail("$.number", "invalid_value", "pull request number mismatch");
  }
  expectEnum(obj.state, ["open"], "$.state");
  const user = expectRecord(obj.user, "$.user");
  if (
    !CI_APPROVER_LOGINS.includes(
      expectNonEmptyString(user.login, "$.user.login", MaxText.login),
    )
  ) {
    fail("$.user.login", "invalid_value", "unexpected pull request author");
  }
  const head = expectRecord(obj.head, "$.head");
  expectExactCiHead(head, input, "$.head");
  const headRepositoryId = parsePullRepository(head.repo, "$.head.repo");
  const base = expectRecord(obj.base, "$.base");
  if (
    expectNonEmptyString(base.ref, "$.base.ref", MaxText.branch) !== CI_BASE_REF
  ) {
    fail("$.base.ref", "invalid_value", "unexpected pull request base ref");
  }
  const baseRepositoryId = parsePullRepository(base.repo, "$.base.repo");
  if (headRepositoryId !== baseRepositoryId) {
    fail(
      "$.head.repo.id",
      "invalid_value",
      "pull request repository identity disagrees",
    );
  }
  return { repositoryId: headRepositoryId };
}

/**
 * Raw PR repository: full repository object, exact self full name plus the
 * numeric id the run associations are bound to.
 */
export function parsePullRepository(value: unknown, path: string): number {
  const repo = expectRecord(value, path);
  if (
    expectNonEmptyString(
      repo.full_name,
      `${path}.full_name`,
      MaxText.owner + 1 + MaxText.name,
    ) !== CI_REPOSITORY_FULL_NAME
  ) {
    fail(`${path}.full_name`, "invalid_value", "unexpected repository");
  }
  return expectPositiveInt(repo.id, `${path}.id`);
}

/** One workflow run: exact identity plus whether it still needs approval. */
export function parseExactCiRun(
  value: unknown,
  input: ApproveExactCiRunInputV1,
  repositoryId: number,
): ExactCiRunV1 {
  const obj = expectRecord(value, "$");
  const id = expectPositiveInt(obj.id, "$.id");
  const attempt = expectPositiveInt(obj.run_attempt, "$.run_attempt");
  expectEnum(obj.event, ["pull_request"], "$.event");
  if (
    expectNonEmptyString(obj.path, "$.path", MaxText.path) !== CI_WORKFLOW_PATH
  ) {
    fail("$.path", "invalid_value", "unexpected workflow path");
  }
  expectExactCiHead(
    { sha: obj.head_sha, ref: obj.head_branch },
    input,
    "$",
  );
  expectSelfRepository(obj.head_repository, "$.head_repository");
  expectCiActor(obj.actor, "$.actor");
  expectCiActor(obj.triggering_actor, "$.triggering_actor");
  const status = expectEnum(
    obj.status,
    ["queued", "in_progress", "completed", "requested", "waiting", "pending"],
    "$.status",
  );
  const conclusion = expectNullableString(
    obj.conclusion,
    "$.conclusion",
    MaxText.token,
  );
  const actionRequired = status === "completed" &&
    conclusion === "action_required";
  const pulls = expectArray(
    obj.pull_requests,
    "$.pull_requests",
    1,
    (item) => item,
  );
  if (pulls.length !== 1) {
    fail(
      "$.pull_requests",
      "invalid_value",
      "expected exactly one associated pull request",
    );
  }
  const pullPath = "$.pull_requests[0]";
  const pull = expectRecord(pulls[0], pullPath);
  const number = expectPositiveInt(pull.number, `${pullPath}.number`);
  if (number !== input.number) {
    fail(`${pullPath}.number`, "invalid_value", "run PR association mismatch");
  }
  const head = expectRecord(pull.head, `${pullPath}.head`);
  expectExactCiHead(head, input, `${pullPath}.head`);
  expectAssociationRepository(
    head.repo,
    `${pullPath}.head.repo`,
    repositoryId,
  );
  const base = expectRecord(pull.base, `${pullPath}.base`);
  if (
    expectNonEmptyString(base.ref, `${pullPath}.base.ref`, MaxText.branch) !==
      CI_BASE_REF
  ) {
    fail(`${pullPath}.base.ref`, "invalid_value", "unexpected run base ref");
  }
  expectAssociationRepository(
    base.repo,
    `${pullPath}.base.repo`,
    repositoryId,
  );
  return { id, attempt, actionRequired };
}

export function expectExactCiHead(
  value: Record<string, unknown>,
  input: ApproveExactCiRunInputV1,
  path: string,
): void {
  const sha = expectNonEmptyString(value.sha, `${path}.sha`, 40);
  if (!isGitSha(sha) || sha !== input.head) {
    fail(`${path}.sha`, "invalid_value", "head SHA mismatch");
  }
  if (
    expectNonEmptyString(value.ref, `${path}.ref`, MaxText.branch) !==
      input.headRef
  ) {
    fail(`${path}.ref`, "invalid_value", "head ref mismatch");
  }
}

export function expectSelfRepository(value: unknown, path: string): void {
  const repo = expectRecord(value, path);
  if (
    expectNonEmptyString(
      repo.full_name,
      `${path}.full_name`,
      MaxText.owner + 1 + MaxText.name,
    ) !== CI_REPOSITORY_FULL_NAME
  ) {
    fail(`${path}.full_name`, "invalid_value", "unexpected repository");
  }
}

/**
 * Workflow-run PR association repository: the real minimal API shape
 * (`{ id, name, url }`), bound to the raw PR's authenticated repository id.
 */
export function expectAssociationRepository(
  value: unknown,
  path: string,
  repositoryId: number,
): void {
  const repo = expectRecord(value, path);
  const id = expectPositiveInt(repo.id, `${path}.id`);
  if (id !== repositoryId) {
    fail(`${path}.id`, "invalid_value", "repository ID mismatch");
  }
  if (
    expectNonEmptyString(repo.name, `${path}.name`, MaxText.name) !== "sentinel"
  ) {
    fail(`${path}.name`, "invalid_value", "unexpected repository name");
  }
  if (
    expectNonEmptyString(repo.url, `${path}.url`, MaxText.url) !==
      CI_REPOSITORY_API_URL
  ) {
    fail(`${path}.url`, "invalid_value", "unexpected repository URL");
  }
}

export function expectCiActor(value: unknown, path: string): void {
  const actor = expectRecord(value, path);
  if (
    !CI_APPROVER_LOGINS.includes(
      expectNonEmptyString(actor.login, `${path}.login`, MaxText.login),
    )
  ) {
    fail(`${path}.login`, "invalid_value", "unexpected run actor");
  }
}
