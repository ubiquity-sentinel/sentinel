/** Exact matrix repository, request and receipt identity checks. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  MatrixCellPlanV1,
  MatrixCellResultV1,
} from "../contracts/matrix.ts";
import type { ModelRunReceiptV1 } from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairCycleDepsV1 } from "../repair/loop.ts";

export function configForRepository(
  deps: RepairCycleDepsV1,
  repository: RepositoryIdentityV1,
): RepositoryConfigV1 | null {
  return deps.configs.find((config) =>
    config.repository.owner === repository.owner &&
    config.repository.name === repository.name &&
    config.repository.installationId === repository.installationId
  ) ?? null;
}

export function sameRepository(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

/**
 * Whether `observed` is a model the trusted route could have run for the
 * planned `requested` model: exactly the planned model, or the route's
 * configured HTTP 429 failover model. The port's failover is a separate
 * self-consistent attempt inside the same admission whose receipt truthfully
 * records the failover model, so it binds to the same planned request. The
 * failover id comes only from the trusted host's own route resolution, never
 * from the artifact; an absent or empty id accepts exactly the planned model.
 */
function routeModelMatches(
  observed: string,
  requested: string,
  failoverModel: string | undefined,
): boolean {
  if (observed === requested) return true;
  return typeof failoverModel === "string" && failoverModel.length > 0 &&
    observed === failoverModel;
}

/**
 * Re-verify a deserialized receipt projection against the exact planned
 * request and the host's trusted expected provider (and trusted route
 * failover model). The production model port verifies raw request/runtime
 * session evidence in-process; an artifact cannot inherit that trust, so the
 * projection is re-checked here and any mismatch refuses the result before a
 * state update.
 */
export function receiptIdentityMatches(
  receipt: ModelRunReceiptV1,
  request: { model: string; reasoning: string },
  expectedProvider: string | readonly string[],
  failoverModel?: string,
): boolean {
  const accepted = typeof expectedProvider === "string"
    ? [expectedProvider]
    : expectedProvider;
  return receipt.actual.evidenceKind === "request-runtime" &&
    routeModelMatches(
      receipt.actual.observedModel,
      request.model,
      failoverModel,
    ) &&
    receipt.actual.observedReasoning === request.reasoning &&
    accepted.includes(receipt.actual.provider);
}

export function verifyMatrixReceiptV1(
  receipt: ModelRunReceiptV1,
  request: {
    model: string;
    reasoning: string;
    maxDurationMs: number;
    maxOutputChars: number;
  },
  expectedProvider: string | readonly string[],
  failoverModel?: string,
): boolean {
  if (
    !receiptIdentityMatches(receipt, request, expectedProvider, failoverModel)
  ) return false;
  if (receipt.actual.durationMs > request.maxDurationMs) return false;
  if (receipt.actual.outputChars > request.maxOutputChars) return false;
  if (receipt.outcome === "completed") {
    return receipt.actual.terminalOrigin === "runtime" &&
      receipt.actual.observedTerminalStatus === "completed" &&
      receipt.candidate !== null &&
      receipt.candidate.head !== null;
  }
  return receipt.candidate === null;
}

/** A correlated terminal with no candidate can prove failure, never success. */
export function interruptedOutputFailure(
  result: MatrixCellResultV1,
  cell: MatrixCellPlanV1,
  expectedProvider: string | readonly string[],
  failoverModel?: string,
): boolean {
  const receipt = result.receipt;
  if (
    result.status !== "completed" || receipt === null ||
    receipt.outcome !== "interrupted" || receipt.candidate !== null ||
    result.bundle !== null ||
    !receiptIdentityMatches(
      receipt,
      cell.request,
      expectedProvider,
      failoverModel,
    )
  ) return false;
  const actual = receipt.actual;
  return actual.terminalOrigin === "runtime" &&
    actual.observedTerminalStatus === "interrupted" &&
    typeof receipt.invocationId === "string" &&
    receipt.invocationId.length > 0 &&
    typeof actual.threadId === "string" && actual.threadId.length > 0 &&
    typeof actual.turnId === "string" && actual.turnId.length > 0 &&
    Number.isSafeInteger(actual.durationMs) && actual.durationMs >= 0 &&
    Number.isSafeInteger(cell.request.maxDurationMs) &&
    cell.request.maxDurationMs > 0 &&
    actual.durationMs <= cell.request.maxDurationMs &&
    Number.isSafeInteger(actual.outputChars) &&
    Number.isSafeInteger(cell.request.maxOutputChars) &&
    cell.request.maxOutputChars > 0 &&
    actual.outputChars > cell.request.maxOutputChars;
}

/** Identical duplicate bytes for one cell are a replay; different bytes conflict. */
export function matrixResultsConflictV1(
  a: MatrixCellResultV1,
  b: MatrixCellResultV1,
): boolean {
  return canonicalStringify(a) !== canonicalStringify(b);
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------
