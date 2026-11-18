/**
 * The push-time backstop of the 2026-11-17 workflow-trust gate. A pushed
 * branch that changes a workflow runs on `push` with the target's secrets
 * even before any pull request exists, so every push of model-written
 * content (a task branch, a `sentinel-candidates/*` preservation ref)
 * re-derives the paths it carries from the actual `base..head` tree diff in
 * the pusher's own object store (`git diff --no-renames --name-only -z`,
 * never a receipt's list) and applies the same decision as the
 * implementation result:
 * - no CI-executable path (`ciExecutablePath`, which also fails closed on a
 *   path it cannot classify): the push proceeds;
 * - on Sentinel's own repository: refused, `PROTECTED_PATH_PARK`;
 * - elsewhere: the source's trust (`recordCiTrust`) decides; untrusted is
 *   refused with `UNTRUSTED_WORKFLOW_PARK`, an unreadable path list or
 *   source is `unavailable` (the caller waits, never pushes).
 */
import type { GitSha } from "../contracts/brands.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError } from "../contracts/ports.ts";
import type { PushContentGuardV1 } from "../contracts/ports-github.ts";
import {
  ciExecutablePath,
  PROTECTED_PATH_PARK,
  UNTRUSTED_WORKFLOW_PARK,
  type WorkflowTrustV1,
} from "../repair/workflow-trust.ts";

export type { PushContentGuardV1 };

/** Static detail of an unreadable pushed path list. */
export const PUSH_PATHS_UNAVAILABLE = "pushed change set is unreadable";
/** Static detail of an unreadable source trust. */
export const PUSH_TRUST_UNAVAILABLE =
  "pushed workflow change trust unavailable";

/** The two refusals a push guard parks with (their own park messages). */
export const PUSH_GUARD_REFUSALS: readonly string[] = Object.freeze([
  PROTECTED_PATH_PARK,
  UNTRUSTED_WORKFLOW_PARK,
]);

/** Null when the push may proceed; otherwise its refusal. */
export async function pushGuardRefusal(
  changedPaths:
    | ((base: GitSha, head: GitSha) => Promise<
      PortResultV1<readonly string[]>
    >)
    | undefined,
  guard: PushContentGuardV1,
  head: GitSha,
): Promise<PortResultV1<never> | null> {
  if (changedPaths === undefined) {
    return portError("unavailable", PUSH_PATHS_UNAVAILABLE);
  }
  let paths: PortResultV1<readonly string[]>;
  try {
    paths = await changedPaths(guard.base, head);
  } catch {
    return portError("unavailable", PUSH_PATHS_UNAVAILABLE);
  }
  if (!paths.ok) return portError("unavailable", PUSH_PATHS_UNAVAILABLE);
  if (!paths.value.some(ciExecutablePath)) return null;
  if (guard.ownRepository) return portError("invalid", PROTECTED_PATH_PARK);
  let trust: WorkflowTrustV1;
  try {
    trust = await guard.trust();
  } catch {
    trust = "unavailable";
  }
  if (trust === "trusted") return null;
  return trust === "untrusted"
    ? portError("invalid", UNTRUSTED_WORKFLOW_PARK)
    : portError("unavailable", PUSH_TRUST_UNAVAILABLE);
}
