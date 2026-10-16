/**
 * Rollback safety of the CI correction route: if generation 77 fails its
 * first trial, the installer restores generation 76 once, and generation 76's
 * strict parsers must read every state the route wrote. Each scenario runs the
 * real loop, captures every snapshot it wrote, and parses each one with the
 * generation-76 `parseRepairStateSnapshotV1` materialized from the exact
 * src/contracts tree of 41bb853a1. The frozen-shape check in the scenario
 * suite runs everywhere; this byte-exact check needs that commit locally and
 * is reported as ignored in a shallow checkout that lacks it.
 */
import assert from "node:assert/strict";
import { SHA1, SHA2, SHA3 } from "../state/helpers.ts";
import {
  assertGeneration76Shapes,
  check,
  ciRig,
  type CiRigOptions,
  loadGeneration76Parser,
} from "./ci-correction-rig.ts";

const parseGeneration76 = await loadGeneration76Parser();

const SCENARIOS: [string, CiRigOptions][] = [
  ["correction", {
    checks: {
      [SHA3]: [
        check("validate", SHA3, "failure"),
        check("verify-artifact", SHA3, "skipped"),
      ],
      [SHA1]: [
        check("validate", SHA1, "success"),
        check("verify-artifact", SHA1, "success"),
      ],
    },
  }],
  ["moved-base", {
    baseTip: SHA2,
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  }],
  ["red-base", {
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "action_required")],
    },
  }],
  ["unattributed", {
    checks: {
      [SHA3]: [check("validate", SHA3, "cancelled")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  }],
  ["base-pending", {
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, null, "queued")],
    },
  }],
  ["rederived", {
    nextStep: "work",
    checks: {
      [SHA3]: [check("validate", SHA3, "success")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  }],
  ["exhausted", {
    reviewRounds: 3,
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  }],
  ["exhausted-red-base", {
    reviewRounds: 3,
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "failure")],
    },
  }],
  ["undescribed-pending-base", {
    candidateState: { preserved: null, publishedHead: SHA3 },
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, null, "in_progress")],
    },
  }],
];

Deno.test({
  name:
    "rollback safety: every snapshot the CI routes write parses under the generation-76 contracts",
  ignore: parseGeneration76 === null,
  fn: async () => {
    let parsed = 0;
    for (const [name, options] of SCENARIOS) {
      const { rig, writes } = await ciRig(`ci-gen76-${name}`, options);
      try {
        const outcome = await rig.run();
        assert.equal(outcome.status, "idle", `${name}: ${outcome.status}`);
        assertGeneration76Shapes(writes);
        for (const snapshot of writes) {
          const reread = parseGeneration76!(structuredClone(snapshot));
          assert.deepEqual(reread.work, snapshot.work, `${name}: work rows`);
          parsed++;
        }
      } finally {
        await rig.ctx.cleanup();
      }
    }
    assert.ok(parsed >= SCENARIOS.length, "every scenario wrote state");
  },
});

Deno.test({
  name:
    "rollback safety: the generation-76 parser refuses the rejected persisted CI evidence shape",
  ignore: parseGeneration76 === null,
  fn: async () => {
    // Negative control: the loaded parser is genuinely the strict generation
    // 76 one, so the previous `target.ciRejection` design could never roll
    // back, while the same record without it parses.
    const { rig, writes } = await ciRig("ci-gen76-control", SCENARIOS[0][1]);
    try {
      await rig.run();
      const snapshot = structuredClone(writes[0]);
      parseGeneration76!(structuredClone(snapshot));
      (snapshot.work[0].target as unknown as Record<string, unknown>)
        .ciRejection = {
          head: SHA3,
          base: SHA1,
          checks: [{ name: "validate", conclusion: "failure" }],
          observedAt: snapshot.updatedAt,
        };
      assert.throws(() => parseGeneration76!(snapshot), /ciRejection/);
    } finally {
      await rig.ctx.cleanup();
    }
  },
});
