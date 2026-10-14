/** Deterministic, release-role-only controller for the real bound VPS driver. */
import type { GitSha } from "../contracts/brands.ts";
import {
  type Clock,
  portOk,
  type PortResultV1,
  type ReleaseStateWriter,
  type StateReadView,
} from "../contracts/ports.ts";
import type { VpsReleasePortV1 } from "../contracts/ports-vps-release.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import {
  parseVpsReleaseRecordV1,
  vpsBindingForRequest,
  vpsRecordBindsRequest,
  type VpsReleaseRecordV1,
} from "../contracts/vps-release.ts";
import {
  canonicalVps,
  isHealthyVps,
  sameVps,
  vpsDigest,
  type VpsMutation,
  type VpsReceipt,
  type VpsSettlement,
} from "../contracts/vps-release-wire.ts";
import type { StabilityPolicyV1 } from "../contracts/repository-policy.ts";
import { validateStabilityPolicy } from "./config.ts";
import { evaluateVpsAcceptance } from "./vps-acceptance.ts";

export interface VpsControllerOptionsV1 {
  stateRead: StateReadView;
  stateWrite: ReleaseStateWriter;
  repository: RepositoryIdentityV1;
  environment: "production" | "isolated";
  controllerSha: GitSha;
  driverSha256: string;
  policy: StabilityPolicyV1;
  logsLagMs: number;
  port: VpsReleasePortV1;
  clock: Clock;
}
export type VpsCycleV1 = {
  status: "idle" | "waiting" | "advanced" | "blocked" | "conflict";
  id: string | null;
  phase: VpsReleaseRecordV1["phase"] | null;
  detail: string | null;
};
type Context = {
  snapshot: ReleaseStateSnapshotV1;
  head: GitSha | null;
  requests: ReleaseRequestV1[];
};
const terminal = (record: VpsReleaseRecordV1): boolean =>
  ["accepted", "rolled_back", "failed"].includes(record.phase);
export async function vpsMutation(receipt: VpsReceipt): Promise<VpsMutation> {
  return {
    operationId: receipt.operationId,
    requestDigest: receipt.binding.requestDigest,
    expectedSequence: receipt.sequence,
    expectedDigest: await vpsDigest(receipt),
  };
}
async function settlementFor(
  receipt: VpsReceipt,
  record: VpsReleaseRecordV1,
  stateRevision: GitSha,
): Promise<VpsSettlement> {
  return {
    ...await vpsMutation(receipt),
    ...(receipt.settlement ?? {
      stateRevision,
      disposition: record.intent?.action === "accept"
        ? "accepted"
        : record.phase as "rolled_back" | "failed",
      digest: await vpsDigest(record),
    }),
  };
}

export class VpsReleaseController {
  constructor(private readonly options: VpsControllerOptionsV1) {
    if (
      options.repository.owner !== "ubiquity" ||
      options.repository.name !== "ai.ubq.fi" ||
      options.repository.installationId < 1 ||
      !["production", "isolated"].includes(options.environment) ||
      !validateStabilityPolicy(options.policy).ok ||
      !Number.isSafeInteger(options.logsLagMs) || options.logsLagMs < 0
    ) throw new TypeError("VPS controller configuration is invalid");
  }
  private result(
    status: VpsCycleV1["status"],
    record: VpsReleaseRecordV1 | null,
    detail: string | null = null,
  ): PortResultV1<VpsCycleV1> {
    return portOk({
      status,
      id: record?.id ?? null,
      phase: record?.phase ?? null,
      detail,
    });
  }
  private async context(): Promise<Context | null> {
    const [repair, release] = await Promise.all([
      this.options.stateRead.readRepair(),
      this.options.stateRead.readRelease(),
    ]);
    if (!repair.ok || !release.ok) return null;
    const snapshot: ReleaseStateSnapshotV1 = release.value.status === "found"
      ? release.value.snapshot
      : {
        version: "v1",
        kind: "release_state_snapshot",
        stateHead: null,
        sequence: 0,
        updatedAt: 0,
        releases: [],
        hostedRuntimes: [],
        hostedReleases: [],
        githubCooldowns: [],
      };
    const requests = repair.value.status !== "found"
      ? []
      : repair.value.snapshot.releaseRequests.filter((request) =>
        request.status === "open" &&
        request.target.repository.owner === this.options.repository.owner &&
        request.target.repository.name === this.options.repository.name &&
        request.target.repository.installationId ===
          this.options.repository.installationId &&
        request.target.environment === this.options.environment
      ).sort((left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
      );
    return {
      snapshot,
      head: release.value.status === "found" ? release.value.head : null,
      requests,
    };
  }
  private async write(
    context: Context,
    record: VpsReleaseRecordV1,
  ): Promise<PortResultV1<VpsCycleV1>> {
    const parsed = parseVpsReleaseRecordV1(record),
      current = context.snapshot.vpsReleases ?? [];
    const next = {
      ...context.snapshot,
      stateHead: context.head,
      sequence: context.snapshot.sequence + 1,
      updatedAt: this.options.clock.now(),
      vpsReleases: [...current.filter((item) => item.id !== parsed.id), parsed],
    };
    const result = await this.options.stateWrite.writeRelease(
      next,
      context.head,
    );
    if (!result.ok || result.value.status !== "applied") {
      return this.result("conflict", record);
    }
    return this.result("advanced", record);
  }
  private patch(
    record: VpsReleaseRecordV1,
    patch: Partial<VpsReleaseRecordV1>,
  ): VpsReleaseRecordV1 {
    return parseVpsReleaseRecordV1({
      ...record,
      ...patch,
      updatedAt: this.options.clock.now(),
    });
  }
  private async begin(
    context: Context,
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<VpsCycleV1>> {
    const binding = await vpsBindingForRequest(request),
      prior = await this.options.port.inspectPrior();
    if (!prior.ok) return this.result("waiting", null, "prior_unavailable");
    const loopback = await this.options.port.sampleHealth(
        prior.value.identity,
        "loopback",
        prior.value.listenerPort,
      ),
      publicHealth = await this.options.port.sampleHealth(
        prior.value.identity,
        "public",
      );
    if (
      !loopback.ok || !publicHealth.ok || !isHealthyVps(loopback.value) ||
      !isHealthyVps(publicHealth.value)
    ) return this.result("waiting", null, "prior_health_unavailable");
    const prepared = await this.options.port.prepare({
      binding,
      controllerSha: this.options.controllerSha,
      expectedDriverSha256: this.options.driverSha256,
      expectedPrior: prior.value,
      priorHealth: { loopback: loopback.value, public: publicHealth.value },
    });
    if (
      !prepared.ok || prepared.value.phase !== "prepared" ||
      canonicalVps(prepared.value.binding) !== canonicalVps(binding)
    ) return this.result("waiting", null, "prepared_receipt_unavailable");
    const now = this.options.clock.now();
    return this.write(
      context,
      parseVpsReleaseRecordV1({
        version: "v1",
        kind: "vps_release_record",
        id: `vps-${prepared.value.operationId}`,
        request,
        requestDigest: binding.requestDigest,
        driver: prepared.value,
        phase: "requested",
        intent: null,
        policy: this.options.policy,
        monitoring: {
          startedAt: null,
          lastObservedAt: null,
          continuous: false,
          baseline: [],
          samples: [],
        },
        acceptance: null,
        inference: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  async run(): Promise<PortResultV1<VpsCycleV1>> {
    const context = await this.context();
    if (!context) return this.result("blocked", null, "state_unavailable");
    const records = (context.snapshot.vpsReleases ?? []).filter((record) =>
      record.request.target.repository.installationId ===
        this.options.repository.installationId &&
      record.request.target.environment === this.options.environment
    );
    const active = records.filter((record) => !terminal(record));
    if (active.length > 1) {
      return this.result("blocked", null, "multiple_promotion_owners");
    }
    if (!active.length) {
      // Terminal Git records remain immutable; reconcile only the private pin settlement.
      for (const record of records.filter(terminal)) {
        const observed = await this.options.port.observe({
          operationId: record.driver.operationId,
          requestDigest: record.requestDigest,
        });
        if (
          !observed.ok ||
          observed.value.operationId !== record.driver.operationId ||
          observed.value.binding.requestDigest !== record.requestDigest ||
          canonicalVps(observed.value.binding) !==
            canonicalVps(record.driver.binding) ||
          canonicalVps(observed.value.prior) !==
            canonicalVps(record.driver.prior) ||
          !sameVps(observed.value.candidate, record.driver.candidate) ||
          observed.value.controllerSha !== record.driver.controllerSha ||
          observed.value.driverSha256 !== record.driver.driverSha256
        ) {
          return this.result("waiting", record, "terminal_driver_unavailable");
        }
        if (context.head === null) {
          return this.result(
            "waiting",
            record,
            "terminal_settlement_unavailable",
          );
        }
        const settled = await this.options.port.settle(
          await settlementFor(observed.value, record, context.head),
        );
        if (!settled.ok || settled.value.phase !== record.phase) {
          return this.result(
            "waiting",
            record,
            "terminal_settlement_unavailable",
          );
        }
      }
      const request = context.requests.find((item) =>
        !records.some((record) => record.request.id === item.id)
      );
      return request ? this.begin(context, request) : this.result("idle", null);
    }
    const record = active[0];
    if (!await vpsRecordBindsRequest(record, record.request)) {
      return this.result("blocked", record, "request_binding_invalid");
    }
    if (
      !context.requests.some((request) =>
        canonicalVps(request) === canonicalVps(record.request)
      )
    ) return this.result("blocked", record, "request_revoked_or_changed");
    if (record.phase === "requested") {
      return this.write(
        context,
        this.patch(record, {
          phase: "promoting",
          intent: { action: "promote", persistedAt: this.options.clock.now() },
        }),
      );
    }
    const observed = await this.options.port.observe({
      operationId: record.driver.operationId,
      requestDigest: record.requestDigest,
    });
    if (
      !observed.ok ||
      !sameVps(observed.value.candidate, record.driver.candidate) ||
      canonicalVps(observed.value.prior) !==
        canonicalVps(record.driver.prior) ||
      canonicalVps(observed.value.binding) !==
        canonicalVps(record.driver.binding)
    ) return this.result("blocked", record, "driver_receipt_unavailable");
    const current = this.patch(record, { driver: observed.value });
    if (record.phase === "rollback_pending") {
      const restored = observed.value.phase === "rolled_back"
        ? observed
        : await this.options.port.restore(await vpsMutation(observed.value));
      if (!restored.ok || restored.value.phase !== "rolled_back") {
        return this.result("waiting", current, "restoration_pending");
      }
      return this.write(
        context,
        this.patch(current, { driver: restored.value, phase: "rolled_back" }),
      );
    }
    if (record.phase === "promoting") {
      const promoted = observed.value.phase === "ingress_applied"
        ? observed
        : await this.options.port.activate(await vpsMutation(observed.value));
      if (!promoted.ok) {
        return this.result("waiting", current, "promotion_pending");
      }
      if (promoted.value.phase === "rolled_back") {
        return this.write(
          context,
          this.patch(current, { driver: promoted.value, phase: "rolled_back" }),
        );
      }
      if (
        promoted.value.phase !== "ingress_applied" ||
        !promoted.value.loopback || !promoted.value.public ||
        !isHealthyVps(promoted.value.loopback) ||
        !isHealthyVps(promoted.value.public)
      ) return this.result("waiting", current, "promotion_identity_pending");
      const now = this.options.clock.now();
      return this.write(
        context,
        this.patch(current, {
          driver: promoted.value,
          phase: "monitoring",
          monitoring: {
            startedAt: now,
            lastObservedAt: now,
            continuous: true,
            baseline: [],
            samples: [],
          },
        }),
      );
    }
    if (record.intent?.action === "accept") {
      if (
        context.head === null || !record.acceptance?.passed || !record.inference
      ) return this.result("blocked", current, "acceptance_intent_invalid");
      const settled = await this.options.port.settle(
        await settlementFor(observed.value, record, context.head),
      );
      if (!settled.ok || settled.value.phase !== "accepted") {
        return this.result("waiting", current, "acceptance_settlement_pending");
      }
      return this.write(
        context,
        this.patch(current, { driver: settled.value, phase: "accepted" }),
      );
    }
    return this.monitor(context, current);
  }
  private async monitor(
    context: Context,
    record: VpsReleaseRecordV1,
  ): Promise<PortResultV1<VpsCycleV1>> {
    const now = this.options.clock.now(), monitor = record.monitoring;
    if (monitor.startedAt === null) {
      return this.result("blocked", record, "monitor_start_missing");
    }
    const [loopback, publicHealth] = await Promise.all([
      this.options.port.sampleHealth(record.driver.candidate, "loopback"),
      this.options.port.sampleHealth(record.driver.candidate, "public"),
    ]);
    if (
      !loopback.ok || !publicHealth.ok || !isHealthyVps(loopback.value) ||
      !isHealthyVps(publicHealth.value) || monitor.lastObservedAt === null ||
      now > monitor.lastObservedAt + 30_000
    ) {
      return this.write(
        context,
        this.patch(record, {
          monitoring: {
            startedAt: now,
            lastObservedAt: now,
            continuous: false,
            baseline: monitor.baseline,
            samples: [],
          },
          acceptance: null,
          inference: null,
        }),
      );
    }
    const samples = [...monitor.samples], baseline = [...monitor.baseline];
    const due = Math.min(
      60,
      Math.floor(
        (now - monitor.startedAt - 30_000 - this.options.logsLagMs) / 30_000,
      ),
    );
    if (due - samples.length > 1) {
      return this.write(
        context,
        this.patch(record, {
          monitoring: {
            startedAt: now,
            lastObservedAt: now,
            continuous: false,
            baseline,
            samples: [],
          },
          acceptance: null,
          inference: null,
        }),
      );
    }
    if (due > samples.length) {
      const windowStart = monitor.startedAt + samples.length * 30_000;
      const sample = await this.options.port.sampleMetrics({
        identity: record.driver.candidate,
        windowStart,
        windowEnd: windowStart + 30_000,
      });
      if (
        !sample.ok || sample.value.coverage !== "complete" ||
        !sameVps(sample.value.identity, record.driver.candidate)
      ) {
        return this.write(
          context,
          this.patch(record, {
            monitoring: {
              startedAt: now,
              lastObservedAt: now,
              continuous: false,
              baseline,
              samples: [],
            },
            acceptance: null,
            inference: null,
          }),
        );
      }
      samples.push(sample.value);
      const baselineEnd = Math.floor(record.driver.createdAt / 30_000) * 30_000,
        baselineStart = baselineEnd - record.policy.baselineWindowMs;
      let baselineThisRun = 0;
      while (
        baseline.length < record.policy.baselineWindowMs / 30_000 &&
        baselineThisRun < 64
      ) {
        const start = baselineStart + baseline.length * 30_000;
        const sample = await this.options.port.sampleMetrics({
          identity: record.driver.prior.identity,
          windowStart: start,
          windowEnd: start + 30_000,
        });
        if (
          !sample.ok || sample.value.coverage !== "complete" ||
          !sameVps(sample.value.identity, record.driver.prior.identity)
        ) break;
        baseline.push(sample.value);
        baselineThisRun++;
      }
    }
    const next = this.patch(record, {
      monitoring: {
        startedAt: monitor.startedAt,
        lastObservedAt: now,
        continuous: true,
        baseline,
        samples,
      },
    });
    if (samples.length < 60) return this.write(context, next);
    const acceptance = evaluateVpsAcceptance(record.policy, baseline, samples);
    if (acceptance.objectiveFailure) {
      return this.write(
        context,
        this.patch(next, {
          phase: "rollback_pending",
          acceptance,
          intent: { action: "rollback", persistedAt: now },
          error: "objective_threshold_failure",
        }),
      );
    }
    if (!acceptance.passed) {
      return this.write(
        context,
        this.patch(next, {
          phase: "failed",
          acceptance,
          intent: { action: "fail", persistedAt: now },
          error: "acceptance_insufficient",
        }),
      );
    }
    const inference = await this.options.port.readInferenceProof(
      record.driver.candidate,
    );
    if (
      !inference.ok || inference.value === null ||
      inference.value.revision !== record.request.revision ||
      inference.value.observedAt < record.createdAt ||
      inference.value.observedAt > now
    ) return this.write(context, this.patch(next, { acceptance }));
    return this.write(
      context,
      this.patch(next, {
        acceptance,
        inference: inference.value,
        intent: { action: "accept", persistedAt: now },
      }),
    );
  }
}

/** Deterministic local runner; callers supply the existing trusted bounded waiter. */
export async function runVpsReleaseController(
  controller: VpsReleaseController,
  clock: Clock,
  wait: (ms: number) => Promise<void>,
  deadline: number,
): Promise<PortResultV1<VpsCycleV1>> {
  let result = await controller.run();
  for (
    let count = 0;
    count < 128 && result.ok && result.value.status !== "idle" &&
    result.value.status !== "blocked" && result.value.status !== "conflict";
    count++
  ) {
    if (
      result.value.phase === "accepted" ||
      result.value.phase === "rolled_back" || result.value.phase === "failed"
    ) return result;
    const before = clock.now();
    if (before + 30_000 > deadline) return result;
    await wait(30_000);
    if (clock.now() <= before) return result;
    result = await controller.run();
  }
  return result;
}
