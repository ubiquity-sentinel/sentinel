/** Public synthetic delivery identities; real consumers own every state transition. */
import assert from "node:assert/strict";
import { buildHostedReleaseRequest } from "../../ops/hosted-autonomy-delivery.ts";
import {
  gatewayDeliveryRecord,
  LOCAL_DELIVERY_TASK_DIGEST,
  localDeliveryRequest,
  referencedDeliveryReceipt,
} from "./loop-delivery-fixtures.ts";
import { REPO, SHA3 } from "../state/helpers.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  ReleaseStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseVpsReleaseRecordV1 } from "../../src/contracts/vps-release.ts";
import {
  parseVpsReceipt,
  vpsDigest,
  type VpsHealthProof,
  type VpsIdentity,
  type VpsMutation,
  type VpsOperation,
  type VpsPrepare,
  type VpsSettlement,
} from "../../src/contracts/vps-release-wire.ts";
import { VpsReleaseController } from "../../src/release/vps-controller.ts";
import {
  composeVpsReleasePort,
  type NativeVpsDriverV1,
} from "../../src/release/vps-port.ts";

const blueprint = parseVpsReleaseRecordV1(JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/vps/release-requested-v1.json", import.meta.url),
  ),
));

/** Fake external VPS boundary; actual adapter/controller/parsers/Git writes execute. */
class SyntheticNativeVpsDriver implements NativeVpsDriverV1 {
  receipt = structuredClone(blueprint.driver);
  activations = 0;
  restorations = 0;
  constructor(private readonly now: () => number) {}
  inspectPrior() {
    return Promise.resolve(this.receipt.prior);
  }
  async prepare(input: VpsPrepare) {
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      binding: input.binding,
      controllerSha: input.controllerSha,
      operationId: await vpsDigest(input.binding),
      driverSha256: input.expectedDriverSha256,
      candidate: {
        ...this.receipt.candidate,
        gitSha: input.binding.revision,
        deploymentId: `vps-${input.binding.revision}`,
      },
      createdAt: this.now(),
      updatedAt: this.now(),
    });
    return this.receipt;
  }
  sampleHealth(
    identity: VpsIdentity,
    surface: "loopback" | "public",
  ): Promise<VpsHealthProof> {
    return Promise.resolve({
      identity,
      surface,
      observedAt: this.now(),
      httpStatus: 200,
      bodyMatches: true,
      headersMatch: true,
      originMatches: true,
    });
  }
  observe(input: VpsOperation) {
    assert.equal(input.requestDigest, this.receipt.binding.requestDigest);
    assert.equal(input.operationId, this.receipt.operationId);
    return Promise.resolve(this.receipt);
  }
  async activate(input: VpsMutation) {
    assert.equal(input.expectedDigest, await vpsDigest(this.receipt));
    assert.equal(input.expectedSequence, this.receipt.sequence);
    this.activations++;
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      phase: "ingress_applied",
      sequence: this.receipt.sequence + 1,
      updatedAt: this.now(),
      intent: { action: "promote", persistedAt: this.now() },
      loopback: await this.sampleHealth(this.receipt.candidate, "loopback"),
      public: await this.sampleHealth(this.receipt.candidate, "public"),
    });
    return this.receipt;
  }
  async restore(input: VpsMutation) {
    assert.equal(input.expectedDigest, await vpsDigest(this.receipt));
    this.restorations++;
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      phase: "rolled_back",
      sequence: this.receipt.sequence + 1,
      updatedAt: this.now(),
      intent: { action: "rollback", persistedAt: this.now() },
      restoration: {
        loopback: await this.sampleHealth(
          this.receipt.prior.identity,
          "loopback",
        ),
        public: await this.sampleHealth(this.receipt.prior.identity, "public"),
      },
    });
    return this.receipt;
  }
  settle(input: VpsSettlement) {
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      phase: input.disposition,
      sequence: this.receipt.sequence + 1,
      updatedAt: this.now(),
      settlement: {
        stateRevision: input.stateRevision,
        disposition: input.disposition,
        digest: input.digest,
      },
      error: input.disposition === "failed" ? "acceptance_insufficient" : null,
    });
    return Promise.resolve(this.receipt);
  }
}

/** Build reachable accepted/rollback state; never seed a pre-authored terminal receipt. */
export async function persistVpsDelivery(
  state: StateReadView,
  writer: ReleaseStateWriter,
  clock: { now(): number; advance(ms: number): void },
  request: ReleaseRequestV1,
  phase: "accepted" | "rolled_back" | "monitoring" | "failed" = "accepted",
) {
  const driver = new SyntheticNativeVpsDriver(() => clock.now());
  const controller = new VpsReleaseController({
    stateRead: state,
    stateWrite: writer,
    repository: request.target.repository,
    environment: request.target.environment,
    controllerSha: blueprint.driver.controllerSha as GitSha,
    driverSha256: blueprint.driver.driverSha256,
    policy: blueprint.policy,
    logsLagMs: 0,
    clock,
    port: composeVpsReleasePort({
      driver,
      metrics: {
        sample: (input) =>
          Promise.resolve({
            ...input,
            sampledAt: clock.now(),
            requestCount: phase === "failed" ? 1 : 100,
            fiveXxCount: phase === "rolled_back" &&
                input.identity.gitSha === request.revision
              ? 10
              : 0,
            timeoutCount: 0,
            streamFailureCount: 0,
            upstreamWideFault: false,
            coverage: "complete",
            coverageDigest: "e".repeat(64),
          }),
      },
      readInferenceProof: (identity) =>
        Promise.resolve({
          revision: identity.gitSha,
          observedAt: clock.now(),
          origin: "mac-direct-vps",
          authenticated: true,
          succeeded: true,
          proofDigest: "f".repeat(64),
        }),
    }),
  });
  for (let slot = 0; slot < 70; slot++) {
    const result = await controller.run();
    assert.ok(
      result.ok && result.value.status !== "blocked" &&
        result.value.status !== "conflict",
      JSON.stringify(result),
    );
    const read = await state.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    const receipt = read.value.snapshot.vpsReleases?.find((item) =>
      item.request.id === request.id
    );
    assert.ok(receipt);
    if (receipt.phase === phase) {
      return { receipt, driver, release: read.value };
    }
    clock.advance(30_000);
  }
  throw new Error("synthetic VPS lifecycle did not reach the required phase");
}

export async function gatewayLoopDelivery() {
  const record = gatewayDeliveryRecord();
  const provisional = {
    ...localDeliveryRequest("vps-review", SHA3),
    target: { repository: REPO, environment: "production" as const },
  };
  const review = referencedDeliveryReceipt(
    provisional,
    record,
    LOCAL_DELIVERY_TASK_DIGEST,
  );
  const request = await buildHostedReleaseRequest(
    REPO,
    SHA3,
    record.target.head!,
    record.target.base!,
    record.target.pr!,
    review,
    provisional.createdAt,
  );
  assert.ok(request);
  return { record, request, review };
}
