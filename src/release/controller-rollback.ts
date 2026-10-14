// Deterministic release rollback stage; state stays with the controller context.
import type { PortResultV1 } from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import {
  parseReleaseRecordV1,
  type ReleaseIntentV1,
  type ReleaseReceiptV1,
  type ReleaseRecordV1,
} from "../contracts/release.ts";
import {
  type LoadedContextV1,
  makeError,
  type ReleaseCycleResultV1,
  sameIdentity,
} from "./controller-common.ts";
import type { ReleaseControllerState } from "./controller-state.ts";

export async function persistRollbackIntent(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
  warnings: string[],
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const intent: ReleaseIntentV1 = {
    action: "rollback",
    key: `rollback/${record.id}/${record.prior.identity.revisionId}`,
    persistedAt: state.clock.now(),
  };
  const updated = parseReleaseRecordV1({
    ...record,
    intent,
    updatedAt: state.clock.now(),
  });
  const write = await state.writeSnapshot(context, updated);
  if (!write) {
    return portOk({ status: "conflict", recordId: record.id, warnings: [] });
  }
  void warnings;
  return rollbackRecord(state, updated, context);
}

export async function rollbackRecord(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  // Reobserve actual candidate ownership before every rollback attempt.
  const observed = await state.observeManaged();
  if (observed.status === "error" || observed.sample.identity === null) {
    return state.blocked(record.id, "rollback ownership cannot be observed");
  }
  const identity = observed.sample.identity;
  if (sameIdentity(identity, record.prior.identity)) {
    return finalizeRolledBack(state, record, context, {
      action: "rollback",
      ok: true,
      statusCode: null,
      observedIdentity: record.prior.identity,
      observedDomain: state.target.acceptance.domain,
      at: state.clock.now(),
      detail: "deployment already served the prior identity",
    });
  }
  if (!sameIdentity(identity, record.candidate.identity)) {
    // An unrelated newer deployment is current: block, never roll it back.
    const failed = parseReleaseRecordV1({
      ...record,
      phase: "failed",
      receipts: {
        ...record.receipts,
        error: makeError(state.clock.now(), "unrelated_newer_deployment"),
      },
      updatedAt: state.clock.now(),
    });
    const write = await state.writeSnapshot(context, failed);
    if (!write) {
      return portOk({
        status: "conflict",
        recordId: record.id,
        warnings: [],
      });
    }
    return portOk({
      status: "advanced",
      recordId: record.id,
      phase: "failed",
      warnings: [],
    });
  }

  const outcome = await state.deno.promote({
    projectId: state.target.projectId,
    identity: record.prior.identity,
  });
  if (!outcome.ok) {
    return state.blocked(record.id, "rollback request failed");
  }
  if (outcome.value.outcome !== "promoted") {
    return persistRollbackReceipt(state, record, context, {
      action: "rollback",
      ok: false,
      statusCode: outcome.value.statusCode,
      observedIdentity: identity,
      observedDomain: state.target.acceptance.domain,
      at: state.clock.now(),
      detail: outcome.value.outcome === "rejected"
        ? "rollback was rejected"
        : "rollback outcome is ambiguous",
    });
  }
  // 204: prove restoration on the managed domain.
  const proof = await state.proveManaged(record.prior.identity);
  if (
    proof.status === "error" ||
    proof.sample.identity === null ||
    proof.sample.status !== "healthy"
  ) {
    return persistRollbackReceipt(state, record, context, {
      action: "rollback",
      ok: false,
      statusCode: 204,
      observedIdentity: proof.status === "error" ? null : proof.sample.identity,
      observedDomain: state.target.acceptance.domain,
      at: state.clock.now(),
      detail: "restoration proof not yet observed",
    });
  }
  return finalizeRolledBack(state, record, context, {
    action: "rollback",
    ok: true,
    statusCode: 204,
    observedIdentity: record.prior.identity,
    observedDomain: state.target.acceptance.domain,
    at: state.clock.now(),
    detail: null,
  });
}

export function persistRollbackReceipt(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
  receipt: ReleaseReceiptV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const updated = parseReleaseRecordV1({
    ...record,
    receipts: { ...record.receipts, rollback: receipt },
    updatedAt: state.clock.now(),
  });
  return state.persistAndReport(updated, context, "monitoring");
}

export async function finalizeRolledBack(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
  receipt: ReleaseReceiptV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const restored = parseReleaseRecordV1({
    ...record,
    phase: "rolled_back",
    observed: {
      identity: record.prior.identity,
      domain: state.target.acceptance.domain,
      verified: true,
      at: state.clock.now(),
    },
    receipts: { ...record.receipts, rollback: receipt },
    updatedAt: state.clock.now(),
  });
  const write = await state.writeSnapshot(context, restored);
  if (!write) {
    return portOk({ status: "conflict", recordId: record.id, warnings: [] });
  }
  return portOk({
    status: "advanced",
    recordId: record.id,
    phase: "rolled_back",
    warnings: [],
  });
}
