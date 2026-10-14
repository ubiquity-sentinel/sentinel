// Deterministic release promotion stage; state stays with the controller context.
import type { PortResultV1 } from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import {
  parseReleaseRecordV1,
  type ReleaseIntentV1,
  type ReleaseReceiptV1,
  type ReleaseRecordV1,
} from "../contracts/release.ts";
import type { DeploymentIdentityV1 } from "../contracts/shared.ts";
import {
  type LoadedContextV1,
  makeError,
  type ReleaseCycleResultV1,
  sameIdentity,
} from "./controller-common.ts";
import type { ReleaseControllerState } from "./controller-state.ts";

export async function promoteRecord(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const observed = await state.observeManaged();
  if (observed.status === "error" || observed.sample.identity === null) {
    return state.blocked(record.id, "current deployment is unobservable");
  }
  if (!sameIdentity(observed.sample.identity, record.prior.identity)) {
    return state.blocked(
      record.id,
      "current deployment conflicts with the recorded prior",
    );
  }
  if (record.intent !== null) {
    return reconcilePromotion(
      state,
      { ...record, phase: "promoting" },
      context,
    );
  }

  const intent: ReleaseIntentV1 = {
    action: "promote",
    key: `promote/${record.id}/${record.candidate.identity.revisionId}`,
    persistedAt: state.clock.now(),
  };
  const intentRecord = parseReleaseRecordV1({
    ...record,
    phase: "promoting",
    intent,
    updatedAt: state.clock.now(),
  });
  const intentWrite = await state.writeSnapshot(context, intentRecord);
  if (!intentWrite) {
    return portOk({ status: "conflict", recordId: record.id, warnings: [] });
  }

  const outcome = await state.deno.promote({
    projectId: state.target.projectId,
    identity: record.candidate.identity,
  });
  if (!outcome.ok) {
    return state.blocked(record.id, "promotion request failed");
  }
  if (outcome.value.outcome !== "promoted") {
    return persistPromoteReceipt(state, record, context, {
      action: "promote",
      ok: false,
      statusCode: outcome.value.statusCode,
      observedIdentity: null,
      observedDomain: state.target.acceptance.domain,
      at: state.clock.now(),
      detail: outcome.value.outcome === "rejected"
        ? "promotion was rejected"
        : "promotion outcome is ambiguous",
    });
  }

  // HTTP 204: post-effect identity proof on the managed domain.
  const proof = await state.proveManaged(record.candidate.identity);
  if (
    proof.status === "error" ||
    proof.sample.identity === null ||
    proof.sample.status !== "healthy"
  ) {
    return persistPromoteReceipt(state, record, context, {
      action: "promote",
      ok: false,
      statusCode: 204,
      observedIdentity: proof.status === "error" ? null : proof.sample.identity,
      observedDomain: state.target.acceptance.domain,
      at: state.clock.now(),
      detail: "post-effect identity proof not yet observed",
    });
  }

  // Verified: finalize promotion and open the monitor window.
  const finalized = parseReleaseRecordV1({
    ...record,
    phase: "monitoring",
    intent,
    observed: {
      identity: record.candidate.identity,
      domain: state.target.acceptance.domain,
      verified: true,
      at: proof.sample.at,
    },
    monitoring: {
      startedAt: proof.sample.at,
      samples: 0,
      continuous: true,
      lastSampleAt: null,
    },
    receipts: {
      promote: {
        action: "promote",
        ok: true,
        statusCode: 204,
        observedIdentity: record.candidate.identity,
        observedDomain: state.target.acceptance.domain,
        at: state.clock.now(),
        detail: null,
      },
      rollback: null,
      error: null,
    },
    updatedAt: state.clock.now(),
  });
  const write = await state.writeSnapshot(context, finalized);
  if (!write) {
    return portOk({ status: "conflict", recordId: record.id, warnings: [] });
  }
  return portOk({
    status: "advanced",
    recordId: record.id,
    phase: "monitoring",
    warnings: [],
  });
}

export async function reconcilePromotion(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const observed = await state.observeManaged();
  if (observed.status === "error" || observed.sample.identity === null) {
    return state.blocked(record.id, "promotion cannot be reconciled");
  }
  const identity = observed.sample.identity;
  if (sameIdentity(identity, record.candidate.identity)) {
    const finalized = parseReleaseRecordV1({
      ...record,
      phase: "monitoring",
      observed: {
        identity: record.candidate.identity,
        domain: state.target.acceptance.domain,
        verified: true,
        at: observed.sample.at,
      },
      monitoring: {
        startedAt: observed.sample.at,
        samples: 0,
        continuous: true,
        lastSampleAt: null,
      },
      receipts: {
        ...record.receipts,
        promote: {
          action: "promote",
          ok: true,
          statusCode: 204,
          observedIdentity: record.candidate.identity,
          observedDomain: state.target.acceptance.domain,
          at: state.clock.now(),
          detail: null,
        },
      },
      updatedAt: state.clock.now(),
    });
    const write = await state.writeSnapshot(context, finalized);
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
      phase: "monitoring",
      warnings: [],
    });
  }
  if (sameIdentity(identity, record.prior.identity)) {
    const priorObserved = record.receipts.promote !== null &&
      record.receipts.promote.observedIdentity !== null &&
      sameIdentity(
        record.receipts.promote.observedIdentity,
        record.prior.identity,
      );
    if (priorObserved) {
      // Second consecutive prior observation after a concluded attempt:
      // the promotion did not apply. Never a blind retry.
      return failRecord(
        state,
        record,
        context,
        identity,
        observed.sample.at,
        "promotion_not_applied",
      );
    }
    return persistPromoteReceipt(state, record, context, {
      action: "promote",
      ok: false,
      statusCode: record.receipts.promote?.statusCode ?? null,
      observedIdentity: identity,
      observedDomain: state.target.acceptance.domain,
      at: state.clock.now(),
      detail: "promotion not observed on the managed domain",
    });
  }
  // An unrelated identity is current: the promotion was never applied and
  // another writer deployed. Never clobber it.
  return failRecord(
    state,
    record,
    context,
    identity,
    observed.sample.at,
    "unrelated_newer_deployment",
  );
}

export function persistPromoteReceipt(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
  receipt: ReleaseReceiptV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const updated = parseReleaseRecordV1({
    ...record,
    phase: "promoting",
    intent: record.intent ?? {
      action: "promote",
      key: `promote/${record.id}/${record.candidate.identity.revisionId}`,
      persistedAt: state.clock.now(),
    },
    observed: receipt.observedIdentity === null ? record.observed : {
      identity: receipt.observedIdentity,
      domain: state.target.acceptance.domain,
      verified: false,
      at: state.clock.now(),
    },
    receipts: { ...record.receipts, promote: receipt },
    updatedAt: state.clock.now(),
  });
  return state.persistAndReport(updated, context, "promoting");
}

export async function failRecord(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
  identity: DeploymentIdentityV1,
  observedAt: number,
  kind: string,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const failed = parseReleaseRecordV1({
    ...record,
    phase: "failed",
    observed: {
      identity,
      domain: state.target.acceptance.domain,
      verified: true,
      at: observedAt,
    },
    receipts: {
      ...record.receipts,
      error: makeError(state.clock.now(), kind),
    },
    updatedAt: state.clock.now(),
  });
  const write = await state.writeSnapshot(context, failed);
  if (!write) {
    return portOk({ status: "conflict", recordId: record.id, warnings: [] });
  }
  return portOk({
    status: "advanced",
    recordId: record.id,
    phase: "failed",
    warnings: [],
  });
}
