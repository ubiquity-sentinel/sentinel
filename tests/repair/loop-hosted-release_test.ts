/** Hosted-release persistence through the real repair entrypoint. */
import assert from "node:assert/strict";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { persistHostedReceipt } from "../host/hosted-receipt-fixture.ts";
import type { HostedReceiptPhaseV1 } from "../host/hosted-receipt-fixture.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { readHostedReleaseReceipt } from "../../src/host/actions-release.ts";
import {
  releaseRequest,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
} from "../state/helpers.ts";
import {
  LOCAL_SENTINEL_REPO,
  makeRig,
  type RigV1,
  seededSnapshot,
} from "./loop-rig.ts";
import {
  gatewayDeliveryRecord,
  LOCAL_DELIVERY_TASK_DIGEST,
  localAcceptedReceipt,
  localDeliveryRecord,
  localDeliveryRequest,
  referencedDeliveryReceipt,
} from "./loop-delivery-fixtures.ts";

/** Advance the ACTUAL supervisor core into the phase over the real store. */
async function seedHostedReceipt(
  rig: RigV1,
  request: ReleaseRequestV1,
  phase: HostedReceiptPhaseV1,
) {
  return await persistHostedReceipt({
    release: rig.releaseStore,
    clock: rig.clock,
    request,
    priorRevision: SHA2,
    phase,
  });
}

/** A found release snapshot without any hosted receipt (missing record). */
async function seedEmptyRelease(rig: RigV1): Promise<void> {
  const snapshot = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
  });
  const written = await rig.releaseStore.writeRelease(snapshot, null);
  assert.ok(
    written.ok && written.value.status === "applied",
    JSON.stringify(written),
  );
}

/** Seed one delivery record + matching open request through the entry. */
async function seedActionsDelivery(
  rig: RigV1,
  request: ReleaseRequestV1,
  record: WorkRecordV1 = localDeliveryRecord(),
  reviews: ReviewReceiptV1[] = [],
): Promise<void> {
  const seeded = await rig.store.writeRepair(
    seededSnapshot([record], { releaseRequests: [request], reviews }),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
}

/** Production wiring: the real reader over the repair store's release view. */
function wireHostedReader(rig: RigV1): void {
  Object.assign(rig.store, {
    readHostedRelease: (request: ReleaseRequestV1) =>
      readHostedReleaseReceipt({ state: rig.store }, request),
  });
}

Deno.test(
  "hosted release: an accepted persisted receipt closes the delivery record once",
  async () => {
    const rig = await makeRig("hostedaccept", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-hosted-1", SHA3);
      const record = localDeliveryRecord();
      await seedActionsDelivery(rig, request, record, [
        // The hosted receipt is acceptance of the DEPLOYMENT only; closing the
        // issue still requires the exact referenced review proof bound to the
        // live task text.
        referencedDeliveryReceipt(request, record, LOCAL_DELIVERY_TASK_DIGEST),
      ]);
      await seedHostedReceipt(rig, request, "accepted");
      wireHostedReader(rig);
      const run = await rig.entry();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "done");
      assert.equal(state.work[0].intent, null, "closure intent settled");
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        1,
        "exactly one closure for the accepted hosted receipt",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "hosted release: an abandoned persisted receipt blocks without closure",
  async () => {
    const rig = await makeRig("hostedrollback", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-hosted-1", SHA3);
      await seedActionsDelivery(rig, request);
      const before = await rig.snapshot();
      const receipt = await seedHostedReceipt(rig, request, "abandoned");
      assert.equal(
        receipt.abandonment?.reason,
        "candidate_verification_failed",
      );
      assert.equal(receipt.rollbackProof?.outcome, "healthy");
      wireHostedReader(rig);
      const run = await rig.entry();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        0,
        "no closure for an abandoned hosted receipt",
      );
      assert.deepEqual(state.reservations, before.reservations);
      assert.deepEqual(state.releaseRequests, before.releaseRequests);
      assert.deepEqual(state.work[0].target, before.work[0].target);
      assert.equal(state.work[0].nextStep, "blocked");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "hosted release: requested and verifying persisted receipts wait",
  async () => {
    for (const phase of ["requested", "verifying"] as const) {
      const rig = await makeRig(`hosted-${phase}`, {
        summaries: false,
        localScope: true,
      });
      try {
        const request = localDeliveryRequest("release-hosted-1", SHA3);
        await seedActionsDelivery(rig, request);
        await seedHostedReceipt(rig, request, phase);
        wireHostedReader(rig);
        const run = await rig.entry();
        assert.ok(
          run.status === "idle" || run.status === "margin",
          `${phase}: ${JSON.stringify(run)}`,
        );
        const state = await rig.snapshot();
        assert.equal(state.work[0].nextStep, "delivery", phase);
        assert.equal(state.work[0].wait?.reason, "unavailable", phase);
        assert.equal(
          rig.github.calls.filter((call) => call.startsWith("closeIssue"))
            .length,
          0,
          phase,
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test(
  "hosted release: missing, error, throwing, malformed, wrong-id and wrong-request receipts wait",
  async () => {
    const request = localDeliveryRequest("release-hosted-1", SHA3);
    const other = localDeliveryRequest("release-hosted-2", SHA3);
    // Same deterministic id as the loop request, different canonical request.
    const mismatched = releaseRequest("release-hosted-1", {
      target: { repository: LOCAL_SENTINEL_REPO, environment: "production" },
      revision: SHA3,
      source: {
        pullRequest: 13,
        reviewRequestId: "review-req-release-hosted-1",
        reviewReceiptId: "review-receipt-release-hosted-1",
        head: SHA1,
        base: SHA2,
      },
      createdAt: T0,
    });
    const cases: Array<{
      name: string;
      seed: "absent" | "empty" | "none";
      wire: (rig: RigV1) => Promise<void> | void;
    }> = [
      {
        name: "absent-state",
        seed: "absent",
        wire: (rig) => wireHostedReader(rig),
      },
      {
        name: "missing-record",
        seed: "empty",
        wire: (rig) => wireHostedReader(rig),
      },
      {
        name: "error",
        seed: "none",
        wire: (rig) => {
          Object.assign(rig.store, {
            readHostedRelease: () =>
              Promise.resolve(portError("unavailable", "down")),
          });
        },
      },
      {
        name: "throwing",
        seed: "none",
        wire: (rig) => {
          Object.assign(rig.store, {
            readHostedRelease: () => Promise.reject(new Error("boom")),
          });
        },
      },
      {
        name: "malformed",
        seed: "none",
        wire: (rig) => {
          Object.assign(rig.store, {
            readHostedRelease: () =>
              Promise.resolve(
                portOk({ version: "v1", kind: "hosted_release" }),
              ),
          });
        },
      },
      {
        name: "wrong-id",
        seed: "none",
        wire: async (rig) => {
          const record = await persistHostedReceipt({
            release: rig.releaseStore,
            clock: rig.clock,
            request: other,
            priorRevision: SHA2,
            phase: "accepted",
          });
          Object.assign(rig.store, {
            readHostedRelease: () => Promise.resolve(portOk(record)),
          });
        },
      },
      {
        name: "wrong-request",
        seed: "none",
        wire: async (rig) => {
          const record = await persistHostedReceipt({
            release: rig.releaseStore,
            clock: rig.clock,
            request: mismatched,
            priorRevision: SHA2,
            phase: "accepted",
          });
          Object.assign(rig.store, {
            readHostedRelease: () => Promise.resolve(portOk(record)),
          });
        },
      },
    ];
    for (const testCase of cases) {
      const rig = await makeRig(`hosted-${testCase.name}`, {
        summaries: false,
        localScope: true,
      });
      try {
        await seedActionsDelivery(rig, request);
        if (testCase.seed === "empty") await seedEmptyRelease(rig);
        await testCase.wire(rig);
        const run = await rig.entry();
        assert.ok(
          run.status === "idle" || run.status === "margin",
          `${testCase.name}: ${JSON.stringify(run)}`,
        );
        const state = await rig.snapshot();
        assert.equal(state.work[0].nextStep, "delivery", testCase.name);
        assert.equal(state.work[0].wait?.reason, "unavailable", testCase.name);
        assert.equal(
          rig.github.calls.filter((call) => call.startsWith("closeIssue"))
            .length,
          0,
          testCase.name,
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test(
  "hosted release: two self receipt authorities wait without consulting either",
  async () => {
    const rig = await makeRig("hosted-dual", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-hosted-1", SHA3);
      await seedActionsDelivery(rig, request);
      const persisted = await seedHostedReceipt(rig, request, "accepted");
      let localReads = 0;
      let hostedReads = 0;
      Object.assign(rig.store, {
        readLocalRelease: () => {
          localReads++;
          return Promise.resolve(portOk(localAcceptedReceipt(request)));
        },
        readHostedRelease: () => {
          hostedReads++;
          return Promise.resolve(portOk(persisted));
        },
      });
      const run = await rig.entry();
      assert.ok(run.status === "idle" || run.status === "margin");
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      assert.equal(localReads, 0, "no receipt authority is guessed");
      assert.equal(hostedReads, 0, "no receipt authority is guessed");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "hosted release: a foreign scope never reaches the hosted capability",
  async (t) => {
    for (const exactReview of [false, true]) {
      await t.step(
        exactReview ? "bound delivery" : "missing delivery proof",
        async () => {
          const rig = await makeRig(`hosted-foreign-${exactReview}`, {
            summaries: false,
            localScope: true,
          });
          try {
            const request = releaseRequest("release-gateway-1", {
              target: { repository: REPO, environment: "production" },
              revision: SHA3,
              source: {
                pullRequest: 12,
                reviewRequestId: "review-req-gateway-1",
                reviewReceiptId: "review-receipt-gateway-1",
                head: SHA1,
                base: SHA2,
              },
              createdAt: T0,
            });
            // Foreign scope never gains hosted authority. With its exact review
            // the no-rule fixture reaches the Deno release wait; without one,
            // the earlier queue delivery guard retains a non-expiring hold.
            const record = gatewayDeliveryRecord();
            await seedActionsDelivery(
              rig,
              request,
              record,
              exactReview
                ? [
                  referencedDeliveryReceipt(
                    request,
                    record,
                    LOCAL_DELIVERY_TASK_DIGEST,
                  ),
                ]
                : [],
            );
            let hostedReads = 0;
            Object.assign(rig.store, {
              readHostedRelease: () => {
                hostedReads++;
                return Promise.resolve(portOk(null));
              },
            });
            const run = await rig.entry();
            assert.equal(run.status, "idle", JSON.stringify(run));
            const state = await rig.snapshot();
            assert.equal(state.work[0].nextStep, "delivery");
            assert.equal(
              state.work[0].wait?.reason,
              exactReview ? "unavailable" : "backoff",
            );
            if (exactReview) {
              assert.ok(state.work[0].wait!.until! > rig.clock.now());
            } else {
              assert.equal(state.work[0].wait?.until, null);
            }
            assert.equal(
              hostedReads,
              0,
              "the hosted capability never attests another scope",
            );
            assert.equal(
              rig.github.calls.filter((call) => call.startsWith("closeIssue"))
                .length,
              0,
              "no closure for a foreign scope",
            );
          } finally {
            await rig.ctx.cleanup();
          }
        },
      );
    }
  },
);
// ---------------------------------------------------------------------------
// Exact candidate lifecycle fixtures shared by the bounded production-loop
// recovery cases. Preservation success is always an explicit per-test opt-in.
// ---------------------------------------------------------------------------
