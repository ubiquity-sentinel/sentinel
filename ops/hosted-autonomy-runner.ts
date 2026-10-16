import { runSelfObservationPass } from "./hosted-autonomy-observation.ts";
import {
  readReleaseSafely,
  readRepairSafely,
  skipped,
} from "./hosted-autonomy-state.ts";
import {
  readHostedClosedIssues,
  runHostedRetryPass,
} from "./hosted-autonomy-retry-pass.ts";
import { runHostedClosurePass } from "./hosted-autonomy-closure-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "./hosted-autonomy-scopes.ts";
import { HOSTED_AUTONOMY_SELF_SCOPE } from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyReasonV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";
import { runHostedDeliveryPass } from "./hosted-autonomy-delivery-pass.ts";
import { runHostedMatrixMaintenance } from "./hosted-autonomy-maintenance.ts";

/** Preserve the maintenance order and each phase's immediate write return. */
export async function runHostedAutonomy(
  deps: HostedAutonomyDepsV1,
): Promise<HostedAutonomyResultV1> {
  const actions: string[] = [];
  const dedicatedReservations = new Set<string>();
  const maintenance = await runHostedMatrixMaintenance(
    deps,
    actions,
    dedicatedReservations,
  );
  if (maintenance !== null) return maintenance;
  const revisions: string[] = [];
  const initial = await readRepairSafely(deps.state);
  if (initial === null || !initial.ok || initial.value.status !== "found") {
    return skipped("no_change", null, actions);
  }
  const snapshot = initial.value.snapshot;
  const observedHead = initial.value.head;

  const releaseRead = await readReleaseSafely(deps.state);
  if (
    releaseRead === null || !releaseRead.ok ||
    releaseRead.value.status !== "found"
  ) {
    return skipped("release_not_terminal", observedHead, actions);
  }
  if (
    releaseRead.value.snapshot.hostedReleases.some((release) =>
      release.phase !== "accepted" && release.phase !== "rolled_back"
    )
  ) {
    return skipped("release_not_terminal", observedHead, actions);
  }

  const scopes = createHostedAutonomyScopes(deps);
  const context: HostedAutonomyPassContextV1 = {
    deps,
    actions,
    revisions,
    snapshot,
    observedHead,
    initialHead: initial.value.head,
    releaseSnapshot: releaseRead.value.snapshot,
    closedIssues: new Set(),
    foreignMerged: new Map(),
    dedicatedReservations,
    ...scopes,
  };
  // Ready delivery bookkeeping precedes unrelated retry grants. Restrict this
  // early pass to delivery records so blocked candidate-ref and recovery
  // transitions retain their own reconciliation boundary.
  await readHostedClosedIssues(context);
  const reconciled = await runHostedClosurePass(context, true);
  if (reconciled !== null) return reconciled;
  const retried = await runHostedRetryPass(context, releaseRead.value.head);
  if (retried !== null) return retried;
  const delivered = await runHostedDeliveryPass(context);
  if (delivered !== null) return delivered;
  const closed = await runHostedClosurePass(context);
  if (closed !== null) return closed;
  const { scopeFor } = scopes;
  // ---- self-observation pass ---------------------------------------------
  // Runs LAST and is fully optional: every read is bounded and state-free, its
  // only write is one deduplicated issue in this deployment's own tracker, and
  // any refusal inside it is reported as an action rather than a failure. The
  // normal repair loop then works those issues like any other.
  let selfSurface: HostedAutonomyGitHubV1 | null = null;
  try {
    selfSurface = (await scopeFor(HOSTED_AUTONOMY_SELF_SCOPE)).surface;
  } catch {
    selfSurface = null;
  }
  actions.push(
    ...await runSelfObservationPass({
      github: selfSurface,
      now: deps.clock.now(),
    }),
  );

  const suffix = (value: string) =>
    actions.some((action) => action.endsWith(value));
  const reason: HostedAutonomyReasonV1 =
    actions.some((action) => action.startsWith("retry:"))
      ? "retried"
      : suffix(":already_recorded")
      ? "already_recorded"
      : suffix(":base_moved")
      ? "base_moved"
      : suffix(":checks_pending")
      ? "checks_pending"
      : suffix(":merge_refused")
      ? "merge_refused"
      : suffix(":merge_not_observed")
      ? "merge_not_observed"
      : suffix(":foreign_author")
      ? "foreign_author"
      : actions.length > 0
      ? "no_authorizing_review"
      : "no_change";
  return skipped(reason, observedHead, actions);
}
