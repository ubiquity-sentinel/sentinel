// Deterministic release request stage; state stays with the controller context.
import type { PortResultV1 } from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import {
  parseReleaseRecordV1,
  type ReleaseRecordV1,
} from "../contracts/release.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { DeploymentIdentityV1 } from "../contracts/shared.ts";
import {
  type LoadedContextV1,
  type ReleaseCycleResultV1,
  sameIdentity,
} from "./controller-common.ts";
import type { ReleaseControllerState } from "./controller-state.ts";
import { promoteRecord, reconcilePromotion } from "./controller-promotion.ts";
import { monitorRecord } from "./controller-monitoring.ts";

export function firstEligibleRequest(
  context: LoadedContextV1,
): ReleaseRequestV1 | null {
  const taken = new Set(
    context.terminal.map((record) => record.requestId).concat(
      context.active.map((record) => record.requestId),
    ),
  );
  for (const request of context.requests) {
    if (!taken.has(request.id)) return request;
  }
  return null;
}

export async function beginRequest(
  state: ReleaseControllerState,
  request: ReleaseRequestV1,
  context: LoadedContextV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const resolution = await state.resolver.resolve(request);
  if (!resolution.ok) {
    return portOk({
      status: "waiting",
      detail: "build receipt is unavailable",
      warnings: [],
    });
  }
  if (resolution.value.status !== "found") {
    return portOk({
      status: "waiting",
      detail: resolution.value.status === "absent"
        ? "build receipt is absent"
        : "build receipt is ambiguous",
      warnings: [],
    });
  }
  const receipt = resolution.value.receipt;
  if (receipt.identity.gitSha !== request.revision) {
    return portOk({
      status: "blocked",
      recordId: null,
      detail: "build receipt identity does not match the request revision",
      warnings: [],
    });
  }

  const candidate = await state.deno.findBuiltCandidate(
    state.target.projectId,
    request.revision,
    receipt.buildTransactionId,
    receipt.identity.revisionId,
  );
  if (!candidate.ok) {
    return portOk({
      status: "blocked",
      recordId: null,
      detail: "candidate build could not be verified",
      warnings: [],
    });
  }
  if (candidate.value.status === "none") {
    return portOk({
      status: "waiting",
      detail: "candidate build is not visible yet",
      warnings: [],
    });
  }
  if (candidate.value.status === "ambiguous") {
    return portOk({
      status: "waiting",
      detail: "candidate build binding is ambiguous",
      warnings: [],
    });
  }
  const build = candidate.value.build;
  if (!sameIdentity(build.identity, receipt.identity)) {
    return portOk({
      status: "blocked",
      recordId: null,
      detail: "platform build identity does not match the receipt",
      warnings: [],
    });
  }

  const prior = await attestPrior(state);
  if (prior.status !== "ok") return prior.result;

  const now = state.clock.now();
  const record = parseReleaseRecordV1({
    version: "v1",
    kind: "release_record",
    repository: state.repository,
    environment: state.environment,
    id: `release-${request.id}`,
    requestId: request.id,
    requestRevision: request.revision,
    candidate: {
      identity: build.identity,
      buildTransactionId: receipt.buildTransactionId,
    },
    prior: {
      identity: prior.identity,
      verifiedHealthyAt: prior.verifiedAt,
    },
    phase: "requested",
    intent: null,
    observed: {
      identity: null,
      domain: state.target.acceptance.domain,
      verified: false,
      at: null,
    },
    monitoring: {
      startedAt: null,
      samples: 0,
      continuous: false,
      lastSampleAt: null,
    },
    acceptance: null,
    receipts: { promote: null, rollback: null, error: null },
    createdAt: now,
    updatedAt: now,
  });

  const written = await state.writeSnapshot(context, record);
  if (!written) {
    return portOk({ status: "conflict", recordId: null, warnings: [] });
  }
  return portOk({
    status: "advanced",
    recordId: record.id,
    phase: "requested",
    warnings: [],
  });
}

export async function attestPrior(state: ReleaseControllerState): Promise<
  | { status: "ok"; identity: DeploymentIdentityV1; verifiedAt: number }
  | { status: "result"; result: PortResultV1<ReleaseCycleResultV1> }
> {
  const health = await state.deno.sampleHealth(state.identityHealthConfig());
  if (!health.ok) {
    return {
      status: "result",
      result: state.blocked(null, "managed health check is unavailable"),
    };
  }
  if (health.value.identity === null) {
    return {
      status: "result",
      result: portOk({
        warnings: [],

        status: "waiting",
        detail: "current deployment identity is not observable",
      }),
    };
  }
  if (
    health.value.status !== "healthy" ||
    health.value.httpStatus !== 200 ||
    health.value.bodyMarkerPresent !== true ||
    health.value.headersMatch !== true
  ) {
    return {
      status: "result",
      result: state.blocked(
        null,
        "current deployment is not verified healthy",
      ),
    };
  }
  const platform = await state.deno.readCurrentDeployment(
    state.target.projectId,
  );
  if (!platform.ok) {
    return {
      status: "result",
      result: state.blocked(
        null,
        "current platform deployment is unavailable",
      ),
    };
  }
  if (platform.value.status === "not_deployed") {
    return {
      status: "result",
      result: state.blocked(
        null,
        "platform reports no deployment for the managed domain",
      ),
    };
  }
  if (
    platform.value.status === "live" &&
    platform.value.identity !== null &&
    !sameIdentity(platform.value.identity, health.value.identity)
  ) {
    return {
      status: "result",
      result: state.blocked(
        null,
        "platform identity conflicts with the observed deployment",
      ),
    };
  }
  return {
    status: "ok",
    identity: health.value.identity,
    verifiedAt: health.value.at,
  };
}

export async function continueRecord(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  switch (record.phase) {
    case "requested":
      return await promoteRecord(state, record, context);
    case "promoting":
      return await reconcilePromotion(state, record, context);
    case "monitoring":
      return await monitorRecord(state, record, context);
    default:
      return state.blocked(
        record.id,
        "release record is in an unexpected phase",
      );
  }
}
