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
import type { PortResultV1 } from "../contracts/ports.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { closureIntentKey } from "./keys.ts";
import { RELEASE_POLL_MS } from "./loop-bounds.ts";
import { retryClosure } from "./loop-closure.ts";
import { persistWork } from "./loop-state.ts";
import {
  deliveryTaskRefusal,
  releaseRequestReceipt,
  semanticRefusalKind,
} from "./loop-task-context.ts";
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
 * exactly `ubiquity/sentinel` (`installationId` 0). Another repository that
 * happens to share scope 0 is NOT the local Sentinel scope, so it can never
 * read or consume the Sentinel local receipt. A local request never falls back
 * to the hosted Deno release path, even when the local receipt capability is
 * absent or broken.
 */
export function isLocalReleaseScope(request: ReleaseRequestV1): boolean {
  const repository = request.target.repository;
  return repository.installationId === 0 &&
    repository.owner === "ubiquity" &&
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
  if (receipt.phase === "accepted") {
    return await acceptRelease(deps, context, record, request, now);
  }
  if (receipt.phase === "rolled_back") {
    return blockRelease(deps, context, record, "rolled_back", now);
  }
  // requested/promoting/verifying/rollback_pending/rollback_verifying carry no
  // final delivery proof and always wait.
  return waitRelease(deps, context, record, now);
}

/** Existing accepted behavior: closure intent when an issue is attached. */
export async function acceptRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
  now: number,
): Promise<StepResultV1> {
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
  const semantic = await deliveryTaskRefusal(deps, record, referenced);
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
  return retryClosure(deps, context, withIntent);
}

/** Existing failed/rolled_back behavior: an ordinary blocked record. */
export function blockRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  phase: "failed" | "rolled_back",
  now: number,
): Promise<StepResultV1> {
  return persistWork(
    deps,
    context,
    markTerminalBlocked(record, "other", `release ${phase}`, now),
  );
}

export async function observeReleaseAcceptance(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
): Promise<StepResultV1> {
  // A request the trusted controller cancelled (or failed) is terminal
  // authorization evidence: no release entry can ever appear for it, so the
  // record is parked with the recorded reason instead of waiting forever.
  // The exact historical cancellation reason is preserved on the blocker.
  if (request.status === "cancelled" || request.status === "failed") {
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
