import type { GitSha } from "../src/contracts/brands.ts";
import {
  MISMATCH_DISPOSITION_BLOCKER_PREFIX,
  MISMATCH_DISPOSITION_MAX_PER_RUN,
  type MismatchDispositionObservationsV1,
  runMismatchDispositionPassV1,
} from "./runtime-mismatch-recovery-disposition.ts";
import {
  HOSTED_AUTONOMY_SELF_SCOPE,
  hostedRepositoryKey,
} from "./hosted-autonomy-policy.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import { failed, skipped } from "./hosted-autonomy-state.ts";
import type { HostedAutonomyResultV1 } from "./hosted-autonomy-types.ts";

/** Preserve upstream's charged mismatch disposition before ordinary retries. */
export async function runHostedMismatchDispositionPass(
  context: HostedAutonomyPassContextV1,
  releaseHead: string,
): Promise<HostedAutonomyResultV1 | null> {
  const {
    deps,
    snapshot,
    observedHead,
    initialHead,
    actions,
    revisions,
    scopeFor,
    releaseSnapshot,
  } = context;
  const mismatchObservations = new Map<
    string,
    MismatchDispositionObservationsV1 | null
  >();
  for (const record of snapshot.work) {
    if (record.nextStep !== "blocked") continue;
    if (
      record.blocker === null ||
      !record.blocker.message.startsWith(MISMATCH_DISPOSITION_BLOCKER_PREFIX)
    ) continue;
    const key = hostedRepositoryKey(record.repository);
    if (mismatchObservations.has(key)) continue;
    const scope = await scopeFor(record.repository);
    mismatchObservations.set(key, scope.surface?.mismatchDisposition ?? null);
  }
  const mismatchCapabilityPresent = [...mismatchObservations.values()].some(
    (value) => value !== null,
  );
  // No mismatch-blocked record with an observation capability means this pass
  // resolves no surface at all: ordinary foreign records keep their exact
  // routing and the sentinel scope is never consulted for them.
  if (!mismatchCapabilityPresent) return null;
  // Producer runs belong to the SELF repository, so the terminal read comes
  // from the self surface, never from the target record's surface.
  const mismatchProducer = await scopeFor(HOSTED_AUTONOMY_SELF_SCOPE);
  const producerTerminal =
    mismatchProducer.surface?.mismatchDisposition?.readRunTerminal ?? null;
  if (producerTerminal === null) return null;
  const disposition = await runMismatchDispositionPassV1({
    snapshot,
    head: observedHead as GitSha,
    release: releaseSnapshot,
    expectedReleaseHead: releaseHead as GitSha | null,
    observationsFor: (record) =>
      mismatchObservations.get(hostedRepositoryKey(record.repository)) ?? null,
    producerTerminal,
    now: deps.clock.now(),
    state: deps.state,
    limit: MISMATCH_DISPOSITION_MAX_PER_RUN,
  });
  if (disposition.kind === "applied") {
    for (const id of disposition.applied) {
      actions.push(`disposition:${id}:ambiguous+retryable`);
    }
    for (const row of disposition.retained) {
      actions.push(`disposition:${row.id}:retained:${row.reason}`);
    }
    return {
      kind: "hosted_autonomy",
      status: "applied",
      reason: "dispositioned",
      beforeHead: initialHead,
      appliedHead: disposition.head,
      actions,
      revisions,
    };
  }
  if (disposition.kind === "failed") {
    return failed(disposition.reason, observedHead, actions);
  }
  if (disposition.kind === "skipped") {
    return skipped(disposition.reason, observedHead, actions);
  }
  for (const row of disposition.retained) {
    actions.push(`disposition:${row.id}:retained:${row.reason}`);
  }
  return null;
}
