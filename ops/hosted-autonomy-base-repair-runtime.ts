/**
 * The base-repair pass's installed-runtime gate (2026-11-16).
 *
 * Filing runs in the launcher; the cap on a filed task's charged CI fixes
 * (`BASE_REPAIR_CI_FIX_CAP`, `src/repair/base-repair.ts`) runs in the
 * INSTALLED runtime. The two differ during an install and after a rollback,
 * whose target is the runtime installed before. The cap therefore landed
 * first, alone (`BASE_REPAIR_CAP_REVISION`), and as a second guard the
 * launcher files only while:
 *
 * - the release state names the installed runtime (the hosted runtime
 *   pointer every maintenance phase reads, never the launcher's checkout);
 * - no installation is in flight, since its bootstrap could still roll the
 *   pointer back to the runtime before it; and
 * - the installed revision is `BASE_REPAIR_CAP_REVISION` or a descendant of
 *   it, proven on the Sentinel repository by GitHub's compare through the
 *   corrected ancestry reading (`isAncestor`, `compareConfirmsAncestor`).
 *
 * Once all three hold, every runtime the pointer can reach by self-install
 * carries the cap: an install needs its candidate to descend from the
 * installed runtime, and a failed bootstrap rolls back to that runtime.
 * Anything unproven files nothing, with a fixed reason.
 */
import { HOSTED_RUNTIME_ID } from "../src/contracts/hosted-supervisor.ts";
import { installationTerminal } from "../src/contracts/hosted-supervisor-installation.ts";
import { HOSTED_AUTONOMY_SELF_SCOPE } from "./hosted-autonomy-policy.ts";
import { readReleaseSafely } from "./hosted-autonomy-state.ts";
import type { HostedAutonomyDepsV1 } from "./hosted-autonomy-types.ts";

/**
 * The commit that landed the runtime's CI-fix cap of a base-repair task, the
 * end of stage 1 of the base-repair split (landed and installed ahead of
 * filing). It is referenced, never derived: if that stage landed under
 * another commit id, this constant must name it, and until it does every
 * pass files nothing (`runtime_uncapped`).
 */
export const BASE_REPAIR_CAP_REVISION =
  "33789b2a90c821058de155c4860f2cf9f6eb8e2b";

/**
 * Why the installed runtime holds base-repair filing, as the pass's action
 * suffix, or null when it carries the cap: `runtime_unreadable` when the
 * release state, its runtime pointer or the ancestry cannot be read (a
 * transient fault), `runtime_installing` while an installation is in
 * flight, `runtime_uncapped` when GitHub answers that the installed revision
 * does not descend from `BASE_REPAIR_CAP_REVISION`.
 */
export async function baseRepairRuntimeHold(
  deps: Pick<HostedAutonomyDepsV1, "state" | "githubFor">,
): Promise<string | null> {
  const read = await readReleaseSafely(deps.state);
  if (read === null || !read.ok || read.value.status !== "found") {
    return "runtime_unreadable";
  }
  const release = read.value.snapshot;
  const runtime = release.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  if (runtime === undefined) return "runtime_unreadable";
  if (
    (release.hostedInstallations ?? []).some((row) =>
      !installationTerminal(row)
    )
  ) {
    return "runtime_installing";
  }
  if (runtime.activeRevision === BASE_REPAIR_CAP_REVISION) return null;
  let proven: boolean | null = null;
  try {
    proven = await deps.githubFor(HOSTED_AUTONOMY_SELF_SCOPE)?.isAncestor?.(
      BASE_REPAIR_CAP_REVISION,
      runtime.activeRevision,
    ) ?? null;
  } catch {
    proven = null;
  }
  if (proven === null) return "runtime_unreadable";
  return proven ? null : "runtime_uncapped";
}
