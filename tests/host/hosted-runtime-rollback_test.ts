import assert from "node:assert/strict";
import seed from "../fixtures/hosted-runtime-live-seed.json" with {
  type: "json",
};
import { parseHostedReleaseRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import { emptyHostedVerification } from "../../src/contracts/hosted-supervisor-verification.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseHostedReleaseRecordV1 as parseLegacyRecord } from "../fixtures/runtime-1838df31/hosted-supervisor-release.ts";
import {
  parseReleaseStateSnapshotV1 as parseLegacyRelease,
  parseRepairStateSnapshotV1 as parseLegacyRepair,
} from "../fixtures/runtime-1838df31/state-snapshots.ts";
import {
  createHostedRollbackState,
  rollbackReleaseView,
} from "../../src/host/hosted-runtime-rollback-state.ts";
import {
  clock,
  installedSupersession,
  runHostedSupervisorPrepare,
  settle,
  supervisor,
} from "./owner-install-supersession-fixtures.ts";
import { nativeOwnerReviewPorts } from "./owner-install-supersession-native-fixtures.ts";
import { produceOwnerSuccessorAcceptance } from "../../src/host/owner-successor-acceptance.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";

Deno.test("hosted rollback: frozen 1838df31 reader rejects new verification and accepts its read-only projection", () => {
  parseLegacyRecord(seed.release);
  const modern = parseHostedReleaseRecordV1({
    ...seed.release,
    verification: {
      prior: emptyHostedVerification(),
      candidate: emptyHostedVerification(),
    },
  });
  assert.throws(() => parseLegacyRecord(modern));
  const snapshot = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: seed.runtime.updatedAt,
    hostedRuntimes: [{ ...seed.runtime, lastTurn: "verification" }],
    hostedReleases: [modern],
    releases: [],
    githubCooldowns: [],
    hostedInstallations: [],
  });
  assert.throws(() => parseLegacyRelease(snapshot));
  const projected = parseLegacyRelease(rollbackReleaseView(snapshot));
  assert.deepEqual(projected.hostedReleases[0], seed.release);
  assert.deepEqual(projected.hostedRuntimes[0], seed.runtime);
  assert.equal(Object.hasOwn(snapshot, "hostedInstallations"), true);
  assert.equal(Object.hasOwn(snapshot.hostedReleases[0], "verification"), true);
});

Deno.test("hosted rollback: legacy repair writes preserve newer journals and charged reservations through real Git CAS", async () => {
  const rig = await installedSupersession();
  try {
    await settle(rig, "healthy");
    rig.nextRun();
    const ordinary = await runHostedSupervisorPrepare(supervisor(rig));
    assert.ok(
      ordinary.status === "run" && ordinary.execution.purpose === "ordinary",
    );
    const native = await nativeOwnerReviewPorts(rig, ordinary.execution);
    try {
      const custody = new Proxy(native.ports.custody!, {
        get(target, key, receiver) {
          if (key === "registerOwnerSuccessor") {
            return () =>
              Promise.reject(new Error("injected registration refusal"));
          }
          return Reflect.get(target, key, receiver);
        },
      });
      const result = await produceOwnerSuccessorAcceptance({
        state: rig.repair,
        clock,
        budget: new RollingStartBudget({
          state: rig.repair,
          clock,
          configs: [createLocalRepositoryConfig()],
        }),
        ports: { ...native.ports, custody },
        nativeOwner: ordinary.execution,
        latestStartAt: Date.now() + 60_000,
        settleBy: Date.now() + 120_000,
        modelStartsEnabled: true,
      });
      assert.equal(result, "failed");
      assert.equal(
        native.session.turnStarts(),
        0,
        "registration refusal starts no model",
      );
    } finally {
      await native.dispose();
    }
    const initial = await rig.repair.readRepair();
    assert.ok(initial.ok && initial.value.status === "found");
    const journaledSnapshot = initial.value.snapshot;
    assert.ok(journaledSnapshot.ownerSuccessorReviews?.length);
    assert.throws(() => parseLegacyRepair(journaledSnapshot));
    const view = createHostedRollbackState(rig.repair);
    const legacy = await view.readRepair();
    assert.ok(legacy.ok && legacy.value.status === "found");
    parseLegacyRepair(legacy.value.snapshot);
    assert.equal(
      Object.hasOwn(legacy.value.snapshot, "ownerSuccessorReviews"),
      false,
    );
    assert.equal(Object.hasOwn(view, "writeRelease"), false);
    const next = {
      ...legacy.value.snapshot,
      stateHead: legacy.value.head,
      sequence: legacy.value.snapshot.sequence + 1,
      updatedAt: Math.max(Date.now(), legacy.value.snapshot.updatedAt),
    };
    const applied = await view.writeRepair(next, legacy.value.head);
    assert.ok(applied.ok && applied.value.status === "applied");
    const after = await rig.repair.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.deepEqual(
      after.value.snapshot.ownerSuccessorReviews,
      journaledSnapshot.ownerSuccessorReviews,
    );
    assert.deepEqual(
      after.value.snapshot.reservations,
      initial.value.snapshot.reservations,
    );
    const stale = await view.writeRepair(next, legacy.value.head);
    assert.ok(stale.ok && stale.value.status === "conflict");
    assert.deepEqual(await rig.repair.readRepair(), after);
    const forged = await view.writeRepair({
      ...next,
      ownerSuccessorReviews: [],
    }, after.value.head);
    assert.equal(forged.ok, false);
    assert.deepEqual(await rig.repair.readRepair(), after);
  } finally {
    await rig.close();
  }
});
