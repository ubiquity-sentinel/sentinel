/** Shared deterministic inputs to implementation admission (no model effects). */
import { isGitSha, isWorkItemId } from "../contracts/brands.ts";
import type { ModelRunRequestV1 } from "../contracts/ports.ts";
import { isValidRef } from "../github/git-executor.ts";
import { normalizeProtectedPaths } from "../github/snapshot-git-wire.ts";
import { candidateBranch } from "./keys.ts";
import { buildPrompt } from "./model-port-prompt.ts";

/** Match the publication transport, including Git's reserved .lock suffix. */
export function validImplementationRef(ref: string): boolean {
  return isValidRef(ref) &&
    !ref.split("/").some((part) => part.endsWith(".lock"));
}

export function implementationInputRefusal(
  request: ModelRunRequestV1,
  protectedPaths: readonly string[],
): string | null {
  if (
    !Number.isSafeInteger(request.maxOutputChars) || request.maxOutputChars <= 0
  ) {
    return "maxOutputChars must be a positive safe integer";
  }
  if (
    !Number.isSafeInteger(request.maxDurationMs) || request.maxDurationMs <= 0
  ) {
    return "maxDurationMs must be a positive safe integer";
  }
  if (normalizeProtectedPaths(protectedPaths) === null) {
    return "protected paths are malformed or over bound";
  }
  if (
    !isWorkItemId(request.taskId) ||
    !validImplementationRef(`refs/heads/${candidateBranch(request.taskId)}`)
  ) {
    return "candidate branch name is invalid";
  }
  if (!isGitSha(request.base)) return "target base is not an exact commit SHA";
  if (request.checkoutBase !== undefined && !isGitSha(request.checkoutBase)) {
    return "checkout base is not an exact commit SHA";
  }
  if (
    request.mergeBase !== undefined &&
    (!isGitSha(request.mergeBase) || request.checkoutBase === undefined ||
      request.mergeBase === request.base ||
      request.mergeBase === request.checkoutBase)
  ) {
    return "merge base does not name a distinct exact continuation base";
  }
  try {
    // The complete trusted role must fit; source/evidence may be truncated,
    // but never the denylist or output bounds. No session is opened here.
    buildPrompt(request, false, undefined, protectedPaths);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return "implementation constraints exceed the prompt bound";
  }
  return null;
}
