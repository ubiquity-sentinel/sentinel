import { guardQueueDelivery } from "./loop-queue-guard.ts";
/** Repair loop internals: release. */
import {
  hostedReceiptBindsRequest,
  type HostedReleaseRecordV1,
  parseHostedReleaseRecordV1,
} from "../contracts/hosted-supervisor.ts";
import {
  localReceiptBindsRequest,
  type LocalReleaseReceiptV1,
  parseLocalReleaseReceiptV1,
} from "../contracts/local-release.ts";
import type { PortResultV1, StateReadView } from "../contracts/ports.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import {
  parseReleaseStateSnapshotV1,
  type ReleaseStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { closureIntentKey } from "./keys.ts";
import { RELEASE_POLL_MS } from "./loop-bounds.ts";
import { retryClosure } from "./loop-closure.ts";
import { gateDeliveryOnChecks } from "./loop-checks.ts";
import { releaseRequestMatchesDelivery } from "./loop-records.ts";
import {
  gatewayReleaseDeferred,
  isGatewayVpsRepository,
  isReleaseDeferredWait,
  observeGatewayVpsDelivery,
} from "./vps-delivery.ts";
import { persistWork } from "./loop-state.ts";
import {
  type CarriedReleaseProverV1,
  gitCarriedReleaseProver,
  releaseDeliveryTaskRefusal,
} from "./carried-release.ts";
import {
  readDeliveryTaskContext,
  releaseRequestReceipt,
  semanticRefusalKind,
} from "./loop-task-context.ts";
import { ownerSuccessorAcceptanceBinds } from "../host/owner-successor-acceptance-proof.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  markBlocked,
  markDone,
  markTerminalBlocked,
  setIntent,
  setWait,
} from "./transitions.ts";

/**
 * The explicit local Sentinel scope: the no-App owner credential identity for
 * exactly `ubiquity-sentinel/sentinel` (`installationId` 0). Another repository that
 * happens to share scope 0 is NOT the local Sentinel scope, so it can never
 * read or consume the Sentinel local receipt. A local request never falls back
 * to the hosted Deno release path, even when the local receipt capability is
 * absent or broken.
 */
export function isLocalReleaseScope(request: ReleaseRequestV1): boolean {
  const repository = request.target.repository;
  return repository.installationId === 0 &&
    repository.owner === "ubiquity-sentinel" &&
    repository.name === "sentinel";
}

/** One explicit release wait; an unreadable or pending local receipt waits. */
export function waitRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  now: number,
): Promise<StepResultV1> {
  return persistWork(
    deps,
    context,
    setWait(
      record,
      { reason: "unavailable", since: now, until: now + RELEASE_POLL_MS },
      now,
    ),
  );
}

/**
 * Merged; release deferred while the release path is disabled (JAM B12). The
 * record stays at `delivery` beside its open request: it is never marked
 * done, because only this record consumes the release outcome (acceptance
 * reconciles the closure, a failed or rolled-back release blocks it) and a
 * done record never moves again. Written once; selection then skips it.
 */
export function deferRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  now: number,
): Promise<StepResultV1> {
  return persistWork(
    deps,
    context,
    setWait(record, { reason: "unavailable", since: now, until: null }, now),
  );
}

/** One positively read and reparsed release snapshot; anything else is null. */
export async function readReleaseSnapshot(
  state: Pick<StateReadView, "readRelease">,
): Promise<ReleaseStateSnapshotV1 | null> {
  try {
    const read = await state.readRelease();
    if (!read.ok || read.value.status !== "found") return null;
    return parseReleaseStateSnapshotV1(read.value.snapshot);
  } catch {
    return null;
  }
}

/** Run-local state of the deferred-release resume pass. */
export interface ReleaseResumeRunV1 {
  /** The release snapshot read once per run (undefined until needed). */
  release?: ReleaseStateSnapshotV1 | null;
  /** Deferred records already looked at in this run. */
  attempted: Set<string>;
}

/**
 * The resume pass for deferred releases: once per run, and only when a
 * deferred record exists, the release ref is read ONCE; a deferred record
 * whose request the release ref now records (or that is no longer an open,
 * intent-free deferral) has its wait released, so the ordinary delivery step
 * observes the release outcome on this same run. A still-deferred record is
 * not touched, an unreadable release ref changes nothing, and each record is
 * looked at once per run, so the pass never loops or rewrites.
 */
export async function resumeDeferredRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  run: ReleaseResumeRunV1,
): Promise<StepResultV1 | null> {
  for (const record of context.snapshot.work) {
    if (!isReleaseDeferredWait(record) || run.attempted.has(record.id)) {
      continue;
    }
    if (run.release === undefined) {
      run.release = await readReleaseSnapshot(deps.state);
    }
    if (run.release === null) return null;
    run.attempted.add(record.id);
    const queueGuard = await guardQueueDelivery(deps, context, record);
    if (queueGuard !== null) return queueGuard;
    const request = context.snapshot.releaseRequests.find((item) =>
      releaseRequestMatchesDelivery(item, record)
    );
    if (
      record.intent === null && request !== undefined &&
      gatewayReleaseDeferred(run.release, request)
    ) continue;
    const now = deps.clock.now();
    const since = record.wait!.since;
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since, until: Math.max(now, since) },
        now,
      ),
    );
  }
  return null;
}

/**
 * Local acceptance only ever reads the private local activation receipt. An
 * absent capability is unavailable (never a Deno fallback), a missing/error
 * receipt waits, an accepted receipt uses the existing closure intent logic,
 * and a failed or rolled-back receipt uses the existing blocked behavior. The
 * complete receipt is parsed again here and its request binding is enforced,
 * so an injected reader cannot accept, close or block on a malformed,
 * unproven or differently-bound value.
 */
export async function observeLocalReleaseAcceptance(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const readLocalRelease = deps.state.readLocalRelease;
  const readHostedRelease = deps.state.readHostedRelease;
  // Two distinct receipt authorities for the same self scope cannot both
  // attest one release: never guess which one is authoritative, wait for an
  // unambiguous host wiring instead.
  if (readLocalRelease !== undefined && readHostedRelease !== undefined) {
    return waitRelease(deps, context, record, now);
  }
  if (readHostedRelease !== undefined) {
    return await observeHostedReleaseAcceptance(
      deps,
      context,
      record,
      request,
      now,
    );
  }
  if (readLocalRelease === undefined) {
    return waitRelease(deps, context, record, now);
  }
  let observed: PortResultV1<LocalReleaseReceiptV1 | null>;
  try {
    observed = await readLocalRelease.call(deps.state, request);
  } catch {
    return waitRelease(deps, context, record, now);
  }
  if (!observed.ok || observed.value === null) {
    return waitRelease(deps, context, record, now);
  }
  let receipt: LocalReleaseReceiptV1;
  try {
    receipt = parseLocalReleaseReceiptV1(observed.value);
  } catch {
    return waitRelease(deps, context, record, now);
  }
  if (!localReceiptBindsRequest(receipt, request)) {
    return waitRelease(deps, context, record, now);
  }
  if (receipt.phase === "accepted") {
    return await acceptRelease(deps, context, record, request, now);
  }
  if (receipt.phase === "failed" || receipt.phase === "rolled_back") {
    return blockRelease(deps, context, record, receipt.phase, now);
  }
  return waitRelease(deps, context, record, now);
}

/**
 * Hosted acceptance reads only the protected supervisor's PERSISTED receipt
 * for the exact self production request. A missing, thrown, error, malformed,
 * foreign or differently-bound record waits; an accepted record uses the
 * existing durable closure intent and a rolled_back record uses the existing
 * blocked behavior. There is never a raw workflow-green, local or Deno
 * fallback for the self scope, and no hosted proof exists for another scope.
 */
export async function observeHostedReleaseAcceptance(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
  now: number,
): Promise<StepResultV1> {
  const readHostedRelease = deps.state.readHostedRelease;
  if (readHostedRelease === undefined) {
    return waitRelease(deps, context, record, now);
  }
  let observed: PortResultV1<HostedReleaseRecordV1 | null>;
  try {
    observed = await readHostedRelease.call(deps.state, request);
  } catch {
    return waitRelease(deps, context, record, now);
  }
  if (!observed.ok || observed.value === null) {
    return waitRelease(deps, context, record, now);
  }
  let receipt: HostedReleaseRecordV1;
  try {
    receipt = parseHostedReleaseRecordV1(observed.value);
  } catch {
    return waitRelease(deps, context, record, now);
  }
  if (!hostedReceiptBindsRequest(receipt, request)) {
    return waitRelease(deps, context, record, now);
  }
  if (receipt.phase === "owner_superseded") {
    const acceptance = receipt.ownerAcceptance;
    if (
      acceptance !== undefined &&
      await ownerSuccessorAcceptanceBinds(receipt) &&
      acceptance.review.binding.workId === record.id &&
      acceptance.review.binding.issueNumber === record.related.issueNumber
    ) {
      const [current, task] = await Promise.all([
        deps.state.readRelease(),
        readDeliveryTaskContext(deps, record),
      ]);
      const pointer = current.ok && current.value.status === "found"
        ? current.value.snapshot.hostedRuntimes[0]
        : undefined;
      if (
        pointer?.activeRevision ===
          acceptance.review.binding.successorRevision &&
        pointer.generation === acceptance.review.binding.successorGeneration &&
        task !== null && task !== "unavailable" &&
        task.digest === acceptance.review.binding.taskSha256
      ) return acceptRelease(deps, context, record, request, now);
    }
    return waitRelease(deps, context, record, now);
  }
  if (receipt.phase === "accepted") {
    return await acceptRelease(deps, context, record, request, now);
  }
  if (receipt.phase === "rolled_back" || receipt.phase === "abandoned") {
    return blockRelease(deps, context, record, receipt.phase, now);
  }
  // requested/promoting/verifying/rollback_pending/rollback_verifying carry no
  // final delivery proof and always wait.
  return waitRelease(deps, context, record, now);
}

/**
 * Existing accepted behavior: closure intent when an issue is attached. A
 * carried delivery (Sentinel #152) is authorized as of its reviewed identity
 * while its git patch proof holds (`releaseDeliveryTaskRefusal`); `carried`
 * is the step's one prover.
 */
export async function acceptRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
  now: number,
  carried: CarriedReleaseProverV1 | undefined = gitCarriedReleaseProver(deps),
): Promise<StepResultV1> {
  const queueGuard = await guardQueueDelivery(
    deps,
    context,
    record,
    releaseRequestReceipt(context.snapshot.reviews, request),
    request.revision,
  );
  if (queueGuard !== null) return queueGuard;
  if (record.related.issueNumber === null) {
    return persistWork(deps, context, markDone(record, now));
  }
  // The release controller accepted the deployment, but the issue is closed
  // only while the RECORDED acceptance still binds the trusted live task
  // context. GitHub may have auto-closed the issue already through the
  // published "Resolves #N" link; the read-only reader returns that exact
  // canonical title/body digest, so a real delivery stays closable. Changed
  // text, a missing acceptance or an already-satisfied base never closes as a
  // newly delivered repair.
  //
  // Issue-backed acceptance is UNCONDITIONAL: the exact receipt the release
  // request references must still be the one full authorization for this
  // delivery (exact repository/base/reviewer/cleanliness AND the positive task
  // acceptance bound to the trusted live text). Release bookkeeping alone — a
  // durable intent, a completed PR or a missing receipt — never proves
  // delivery, so a missing or non-authorizing reference fails closed instead
  // of persisting a closure intent.
  const referenced = releaseRequestReceipt(context.snapshot.reviews, request);
  const semantic = await releaseDeliveryTaskRefusal(
    deps,
    record,
    request,
    referenced,
    carried,
  );
  if (semantic === "wait") return waitRelease(deps, context, record, now);
  if (semantic !== null) {
    return persistWork(
      deps,
      context,
      markBlocked(record, semanticRefusalKind(semantic), semantic, now),
    );
  }
  const intent = {
    kind: "issue_closure" as const,
    key: closureIntentKey(record.related.issueNumber),
    startedAt: now,
    branch: null,
    expectedHead: record.target.head,
    observedBase: record.target.base,
    pr: record.target.pr,
    requestId: request.id,
    resultId: null,
  };
  const withIntent = setIntent(record, intent, now);
  const persisted = await persistWork(deps, context, withIntent);
  if (persisted.kind !== "progress") return persisted;
  return retryClosure(deps, context, withIntent, carried);
}

/** Existing failed/rolled_back behavior: an ordinary blocked record. */
export function blockRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  phase: "failed" | "rolled_back" | "abandoned",
  now: number,
): Promise<StepResultV1> {
  const blocked = markTerminalBlocked(record, "other", `release ${phase}`, now);
  // An abandoned hosted release was superseded or exhausted its bounded
  // verification after its PR already merged: park the record but keep its
  // exact target (PR, head, base) for provenance instead of clearing the PR.
  return persistWork(
    deps,
    context,
    phase === "abandoned" ? { ...blocked, target: record.target } : blocked,
  );
}

export async function observeReleaseAcceptance(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueDelivery(
    deps,
    context,
    record,
    releaseRequestReceipt(context.snapshot.reviews, request),
    request.revision,
  );
  if (queueGuard !== null) return queueGuard;
  // A request the trusted controller cancelled (or failed) is terminal
  // authorization evidence: no release entry can ever appear for it, so the
  // record is parked with the recorded reason instead of waiting forever.
  // The exact historical cancellation reason is preserved on the blocker.
  if (
    !isGatewayVpsRepository(record.repository) &&
    (request.status === "cancelled" || request.status === "failed")
  ) {
    return persistWork(
      deps,
      context,
      markTerminalBlocked(
        record,
        "other",
        request.failureReason ?? `release request ${request.status}`,
        deps.clock.now(),
      ),
    );
  }
  if (isLocalReleaseScope(request)) {
    return await observeLocalReleaseAcceptance(deps, context, record, request);
  }
  const now = deps.clock.now();
  if (isGatewayVpsRepository(record.repository)) {
    // Merged, release deferred while the release path is disabled: no release
    // record can be observed for this request, so the record waits in its one
    // stable shape instead of re-arming a poll every cycle (JAM B12).
    if (record.intent === null && request.status === "open") {
      const release = await readReleaseSnapshot(deps.state);
      if (release !== null && gatewayReleaseDeferred(release, request)) {
        return deferRelease(deps, context, record, now);
      }
    }
    // A carried request binds only while its git patch proof holds (Sentinel
    // #152); one prover serves this whole step.
    const carried = gitCarriedReleaseProver(deps);
    const observed = await observeGatewayVpsDelivery(
      deps.state,
      record,
      request,
      releaseRequestReceipt(context.snapshot.reviews, request),
      carried,
    );
    if (observed.kind === "blocked") {
      return persistWork(
        deps,
        context,
        markBlocked(record, "other", observed.reason, now),
      );
    }
    if (observed.kind !== "accepted") {
      return waitRelease(deps, context, record, now);
    }
    const checks = await gateDeliveryOnChecks(deps, context, record, now);
    if (checks !== null) return checks;
    return acceptRelease(deps, context, record, request, now, carried);
  }
  const release = await deps.state.readRelease();
  if (!release.ok || release.value.status !== "found") {
    return waitRelease(deps, context, record, now);
  }
  const observed = release.value.snapshot.releases.find(
    (item) => item.requestId === request.id,
  );
  if (observed === undefined) {
    return waitRelease(deps, context, record, now);
  }
  if (observed.phase === "accepted") {
    return await acceptRelease(deps, context, record, request, now);
  }
  if (observed.phase === "failed" || observed.phase === "rolled_back") {
    return blockRelease(deps, context, record, observed.phase, now);
  }
  return waitRelease(deps, context, record, now);
}
