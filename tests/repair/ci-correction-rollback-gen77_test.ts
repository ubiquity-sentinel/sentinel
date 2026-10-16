/**
 * Rollback safety of the open hosted CI correction route against generation
 * 77 (R77 ab3613e02). A failed generation 78 restores R77, which keeps the
 * route closed in hosted runs, and R77's own repair loop then runs over every
 * record generation 78 left behind. These cases run R77's own loop rig
 * (`ciRig`, extracted from the pinned commit) as a hosted run:
 *
 * - a reviewed head sent back to `work` to await its CI correction is the one
 *   state R77 does not leave inert: it re-publishes the same head and asks for
 *   one more review, a bounded charged cost (one `review_request`, one review
 *   round, never a model start, a refund or a merge without review);
 * - an expired red-base or pending-base wait ends in R77's own legacy CI block
 *   without a base read, and the unattributed block is left alone;
 * - every snapshot this tree's open hosted route writes parses under R77's
 *   strict contracts.
 *
 * The cases are ignored in a checkout without the pinned commit.
 */
import assert from "node:assert/strict";
import type {
  parseRepairStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { ciCorrectionShape } from "../../src/repair/ci-rejection.ts";
import { SHA1, SHA2, SHA3 } from "../state/helpers.ts";
import type * as CiRig from "./ci-correction-rig.ts";
import { check, ciRig, type CiRigOptions } from "./ci-correction-rig.ts";
import type { candidateStateFor } from "./loop-candidate-fixtures.ts";
import {
  gen77Available,
  loadGen77Modules,
} from "../host/gen77-runtime-source.ts";

const available = await gen77Available();

const FAILED_HEAD = {
  [SHA3]: [
    check("validate", SHA3, "failure"),
    check("verify-artifact", SHA3, "skipped"),
  ],
  [SHA1]: [
    check("validate", SHA1, "success"),
    check("verify-artifact", SHA1, "success"),
  ],
};

/** R77's own CI rig and closed-route flag. */
async function loadRig77() {
  const loaded = await loadGen77Modules([
    "tests/repair/ci-correction-rig.ts",
    "tests/repair/loop-candidate-fixtures.ts",
    "src/repair/ci-rejection.ts",
  ]);
  return {
    ciRig: loaded.modules[0].ciRig as typeof CiRig.ciRig,
    check: loaded.modules[0].check as typeof CiRig.check,
    candidateStateFor: loaded.modules[1]
      .candidateStateFor as typeof candidateStateFor,
    hostedCiCorrections: loaded.modules[2].HOSTED_CI_CORRECTIONS as boolean,
    dispose: loaded.dispose,
  };
}

type Rig77 = Awaited<ReturnType<typeof loadRig77>>;

function reviewRequests(rig: { github: unknown }): number {
  return (rig.github as { reviewRequestIdentities: unknown[] })
    .reviewRequestIdentities.length;
}

function preserved(gen77: Rig77) {
  return gen77.candidateStateFor(SHA1, SHA3) as unknown as NonNullable<
    CiRigOptions["candidateState"]
  >;
}

Deno.test({
  name:
    "rollback to generation 77: a head awaiting its CI correction costs R77 at most one charged review",
  ignore: !available,
  async fn(t) {
    const gen77 = await loadRig77();
    try {
      assert.equal(gen77.hostedCiCorrections, false, "R77 keeps it closed");
      for (const kind of ["legacy", "preserved"] as const) {
        for (const rounds of [1, 2]) {
          await t.step(`${kind} candidate, ${rounds} rounds`, async () => {
            const { rig, charges, checkReads, refreshes } = await gen77.ciRig(
              `ci-gen77-await-${kind}-${rounds}`,
              {
                hosted: true,
                nextStep: "work",
                reviewRounds: rounds,
                ...(kind === "preserved"
                  ? { candidateState: preserved(gen77) }
                  : {}),
                checks: FAILED_HEAD,
              },
            );
            try {
              const outcome = await rig.run();
              assert.equal(outcome.status, "idle", JSON.stringify(outcome));
              const after = await rig.snapshot();
              const work = after.work[0];
              assert.equal(rig.model.requests.length, 0, "no model start");
              assert.equal(reviewRequests(rig), 1, "one more review request");
              assert.equal(work.nextStep, "review");
              assert.equal(work.blocker, null);
              assert.equal(work.target.head, SHA3, "the same head");
              assert.equal(work.target.pr, 7);
              assert.equal(work.counters.attempts, 1);
              assert.equal(work.counters.reviewRounds, rounds + 1);
              // Every prior charge is untouched (never refunded); exactly one
              // review admission is added.
              for (const charge of charges) {
                assert.deepEqual(
                  after.reservations.find((row) => row.id === charge.id),
                  charge,
                );
              }
              const added = after.reservations.filter((row) =>
                !charges.some((charge) => charge.id === row.id)
              );
              assert.equal(added.length, 1);
              assert.equal(added[0].purpose, "review_request");
              assert.equal(added[0].head, SHA3);
              assert.ok(!checkReads.includes(SHA1), "no base attribution");
              assert.equal(refreshes.length, 0, "no base refresh");
              // A record at two rounds spends its last correctable round here.
              assert.equal(ciCorrectionShape(work), rounds + 1 < 3);
            } finally {
              await rig.ctx.cleanup();
            }
          });
        }
      }
    } finally {
      await gen77.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 77: expired CI waits end in R77's legacy block without a base read; the unattributed block is left alone",
  ignore: !available,
  async fn(t) {
    const gen77 = await loadRig77();
    try {
      for (const reason of ["ci_pending", "backoff"] as const) {
        await t.step(`an expired ${reason} wait`, async () => {
          const { rig, charges, checkReads, refreshes } = await gen77.ciRig(
            `ci-gen77-wait-${reason}`,
            {
              hosted: true,
              candidateState: preserved(gen77),
              checks: {
                [SHA3]: FAILED_HEAD[SHA3],
                [SHA1]: [
                  gen77.check(
                    "validate",
                    SHA1,
                    reason === "backoff" ? "failure" : null,
                    reason === "backoff" ? "completed" : "in_progress",
                  ),
                ],
              },
            },
          );
          try {
            await seedWait(rig, reason);
            const outcome = await rig.run();
            assert.equal(outcome.status, "idle", JSON.stringify(outcome));
            const after = await rig.snapshot();
            const work = after.work[0];
            assert.equal(work.nextStep, "blocked");
            assert.equal(
              work.blocker?.message,
              "CI checks failed: validate(failure), verify-artifact(skipped)",
            );
            assert.equal(work.counters.reviewRounds, 1);
            assert.deepEqual(after.reservations, charges, "nothing charged");
            assert.equal(rig.model.requests.length, 0);
            assert.equal(reviewRequests(rig), 0);
            assert.ok(!checkReads.includes(SHA1), "no base read");
            assert.equal(refreshes.length, 0);
          } finally {
            await rig.ctx.cleanup();
          }
        });
      }
      await t.step(
        "an expired red-base wait on a moved base takes R77's native refresh",
        async () => {
          const { rig, charges, refreshes } = await gen77.ciRig(
            "ci-gen77-wait-moved",
            {
              hosted: true,
              baseTip: SHA2,
              candidateState: preserved(gen77),
              checks: {
                [SHA3]: FAILED_HEAD[SHA3],
                [SHA1]: [gen77.check("validate", SHA1, "failure")],
              },
            },
          );
          try {
            await seedWait(rig, "backoff");
            await rig.run();
            const after = await rig.snapshot();
            assert.ok(
              refreshes.some((request) => request.expectedHead === SHA3),
              "the ordinary base refresh",
            );
            assert.deepEqual(after.reservations, charges, "nothing charged");
            assert.equal(rig.model.requests.length, 0);
            assert.equal(reviewRequests(rig), 0);
          } finally {
            await rig.ctx.cleanup();
          }
        },
      );
      await t.step("the unattributed block is left alone", async () => {
        const { rig, charges, checkReads } = await gen77.ciRig(
          "ci-gen77-unattributed",
          {
            hosted: true,
            candidateState: preserved(gen77),
            blocker:
              "CI checks failed without base evidence: validate(failure)",
            checks: FAILED_HEAD,
          },
        );
        try {
          const before = (await rig.snapshot()).work[0];
          await rig.run();
          const after = await rig.snapshot();
          assert.deepEqual(after.work[0], before);
          assert.deepEqual(after.reservations, charges);
          assert.equal(rig.model.requests.length, 0);
          assert.equal(reviewRequests(rig), 0);
          assert.deepEqual(checkReads, []);
        } finally {
          await rig.ctx.cleanup();
        }
      });
    } finally {
      await gen77.dispose();
    }
  },
});

/** Put the rig's reviewed head into an expired delivery wait. */
async function seedWait(
  rig: Awaited<ReturnType<typeof ciRig>>["rig"],
  reason: "ci_pending" | "backoff",
): Promise<void> {
  const read = await rig.store.readRepair();
  if (!read.ok || read.value.status !== "found") throw new Error("no state");
  const now = rig.clock.now();
  const next = structuredClone(read.value.snapshot);
  next.work[0] = {
    ...next.work[0],
    wait: { reason, since: now - 60_000, until: now - 1 },
  };
  next.stateHead = read.value.head;
  next.sequence += 1;
  next.updatedAt = now;
  const written = await rig.store.writeRepair(next, read.value.head);
  assert.ok(written.ok && written.value.status === "applied");
}

/** This tree's hosted scenarios: every route outcome the open lane writes. */
const HOSTED_SCENARIOS: [string, CiRigOptions][] = [
  ["correction", { checks: FAILED_HEAD }],
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
  ["exhausted", {
    reviewRounds: 3,
    checks: FAILED_HEAD,
  }],
];

Deno.test({
  name:
    "rollback to generation 77: every snapshot the open hosted CI route writes parses under R77's contracts",
  ignore: !available,
  async fn() {
    const loaded = await loadGen77Modules(["src/contracts/state-snapshots.ts"]);
    const parse77 = loaded.modules[0]
      .parseRepairStateSnapshotV1 as typeof parseRepairStateSnapshotV1;
    try {
      let parsed = 0;
      for (const [name, options] of HOSTED_SCENARIOS) {
        const { rig, writes } = await ciRig(`ci-gen78-hosted-${name}`, {
          ...options,
          hosted: true,
        });
        try {
          const outcome = await rig.run();
          // An awaiting correction is the matrix's model start: the serial
          // hosted run ends at its bound ("margin") instead of starting it.
          assert.ok(
            ["idle", "margin"].includes(outcome.status),
            `${name}: ${JSON.stringify(outcome)}`,
          );
          assert.ok(writes.length > 0, `${name} wrote state`);
          if (name === "correction" || name === "moved-base") {
            // The open route persists the awaiting record itself.
            assert.ok(
              writes.some((snapshot) =>
                snapshot.work[0].nextStep === "work" &&
                snapshot.work[0].target.head === SHA3
              ),
              `${name}: the reviewed head awaits its correction`,
            );
          }
          for (const snapshot of writes) {
            const reread: RepairStateSnapshotV1 = parse77(
              structuredClone(snapshot),
            );
            assert.deepEqual(reread.work, snapshot.work, `${name}: work rows`);
            parsed++;
          }
        } finally {
          await rig.ctx.cleanup();
        }
      }
      assert.ok(parsed >= HOSTED_SCENARIOS.length);
    } finally {
      await loaded.dispose();
    }
  },
});
