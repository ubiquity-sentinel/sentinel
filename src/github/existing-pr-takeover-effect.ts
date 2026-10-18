/** Shared asynchronous principal check. No production principal is minted here. */
import type {
  TakeoverPrincipalAuthority,
  TakeoverPrincipalBinding,
  TakeoverProofRequest,
} from "../contracts/existing-pr-takeover.ts";
import { portError, type PortResultV1 } from "../contracts/ports.ts";

export async function revalidateTakeoverPrincipal(
  principal: TakeoverPrincipalAuthority | undefined,
  binding: TakeoverPrincipalBinding,
): Promise<PortResultV1<void>> {
  try {
    if (principal !== undefined) {
      return await principal.revalidate(structuredClone(binding));
    }
  } catch { /* An unavailable issuer never becomes an ordinary actor grant. */ }
  return portError("unavailable", "existing PR App principal unavailable");
}

export function takeoverPrincipalBinding(
  request: TakeoverProofRequest,
): TakeoverPrincipalBinding | null {
  const { record } = request;
  if (record.target.pr === null || record.target.branch === null) return null;
  return {
    repository: record.repository,
    taskId: record.id,
    expectedStateHead: request.expectedStateHead,
    pullRequest: record.target.pr,
    branch: record.target.branch,
    head: request.expectedHead,
    base: request.observedBase ?? record.target.base,
    operation: request.operation,
    phase: request.operation === "refresh"
      ? "prepare"
      : request.operation === "publish"
      ? "publish"
      : "current",
    nextHead: request.nextHead ?? null,
    deadline: request.deadline,
  };
}
