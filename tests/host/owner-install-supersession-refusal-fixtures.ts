import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-install-plan.ts";
import { buildOwnerDevelopmentInstallSnapshot } from "../../src/host/owner-install-snapshot.ts";
import { readOwnerSupersessionAuthority } from "../../src/host/owner-install-supersession.ts";
import { originalPriorNativeFingerprint } from "../../src/host/owner-install-supersession-original.ts";
import { futureRecoveryFixture } from "./owner-install-future-recovery-fixtures.ts";
import type { ReadInput } from "../../src/host/owner-install-future-recovery.ts";

export async function driveSupersessionRefusals(t: Deno.TestContext) {
  const rig = await futureRecoveryFixture({
    legacyFirst: true,
    ownerSupersession: true,
  });
  try {
    const input = await rig.readerInput(), before = await rig.current();
    const authority = await readOwnerSupersessionAuthority(input);
    assert.ok(authority);
    const altered = structuredClone(input.current.snapshot);
    altered.sequence++;
    const absentWitness = {
      readRelease: () => input.state.readRelease(),
      readRepair: () => input.state.readRepair(),
      readReleaseAt: () =>
        Promise.resolve(
          portOk({ status: "absent" as const, currentHead: null, ref: null }),
        ),
    };
    const cases: [string, ReadInput][] = [
      ["changed release head", {
        ...input,
        current: { ...input.current, head: "0".repeat(40) as GitSha },
      }],
      ["changed snapshot", {
        ...input,
        current: { ...input.current, snapshot: altered },
      }],
      ["foreign controller source", {
        ...input,
        run: { ...input.run, launcherSha: "0".repeat(40) as GitSha },
      }],
      ["inactive queue floor", {
        ...input,
        queue: { ...input.queue, proofActivated: false },
      }],
      ["inactive custody floor", {
        ...input,
        custody: { ...input.custody, custodyActivated: false },
      }],
      ["old runtime reaccepted", {
        ...input,
        queue: {
          ...input.queue,
          revisions: [
            ...input.queue.revisions,
            input.current.snapshot.hostedRuntimes[0].activeRevision,
          ],
        },
      }],
      ["missing migration grant", {
        ...input,
        queue: { ...input.queue, ownerInstallMigrations: [] },
      }],
      ["missing healthy witness", { ...input, state: absentWitness }],
      ["unavailable repair state", {
        ...input,
        state: {
          ...absentWitness,
          readRepair: () =>
            Promise.resolve(portError("unavailable", "fixture unavailable")),
        },
      }],
    ];
    for (const [name, value] of cases) {
      await t.step(
        name,
        async () =>
          assert.equal(await readOwnerSupersessionAuthority(value), undefined),
      );
    }
    const plan = planOwnerDevelopmentInstall(
      input.current.snapshot,
      Date.now(),
      undefined,
      undefined,
      rig.queue,
      rig.custody,
      rig.rollout,
      undefined,
      authority,
    );
    assert.ok(plan.status === "install");
    assert.throws(() =>
      buildOwnerDevelopmentInstallSnapshot(
        input.current.snapshot,
        "0".repeat(40) as GitSha,
        plan.move,
        Date.now(),
        undefined,
        undefined,
        rig.queue,
        rig.custody,
        undefined,
        rig.rollout,
        authority,
      )
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        altered,
        Date.now(),
        undefined,
        undefined,
        rig.queue,
        rig.custody,
        rig.rollout,
        undefined,
        authority,
      ).status,
      "waiting",
    );
    const proof = rig.originalHistorical,
      native = await originalPriorNativeFingerprint(proof);
    assert.equal(
      await originalPriorNativeFingerprint({
        ...proof,
        observedAt: proof.observedAt + 1,
      }),
      native,
    );
    for (
      const changed of [
        { ...proof, logDigest: "0".repeat(64) },
        { ...proof, jobId: proof.jobId + 1 },
        {
          ...proof,
          execution: {
            ...proof.execution,
            launcherSha: "0".repeat(40) as GitSha,
          },
        },
        {
          ...proof,
          execution: {
            ...proof.execution,
            purpose: "ordinary" as const,
            releaseId: null,
          },
        },
      ]
    ) {
      assert.notEqual(
        await originalPriorNativeFingerprint(changed),
        native,
        "only observedAt may be normalized",
      );
    }
    assert.deepEqual(await rig.current(), before);
    assert.equal(rig.patches(), 0);
    assert.equal(rig.requests.some((r) => r.method !== "GET"), false);
  } finally {
    await rig.close();
  }
  for (
    const fault of [
      "source_ci",
      "target_ci",
      "profile",
      "proof",
      "log",
      "actor_source",
      "active_writer",
      "rate_limit",
      "cooldown",
    ] as const
  ) {
    await t.step(`native ${fault} stays pending`, async () => {
      const rejected = await futureRecoveryFixture({
        legacyFirst: true,
        ownerSupersession: true,
        fault,
      });
      try {
        const before = await rejected.current();
        assert.equal(
          await readOwnerSupersessionAuthority(await rejected.readerInput()),
          undefined,
        );
        assert.equal(rejected.patches(), 0);
        assert.deepEqual(await rejected.current(), before);
      } finally {
        await rejected.close();
      }
    });
  }
}
