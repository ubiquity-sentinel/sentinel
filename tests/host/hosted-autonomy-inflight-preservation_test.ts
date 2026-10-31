/**
 * In-flight preservation: the consumer settled the exact candidate's
 * submitted admission and saved its pending `candidate_preservation` intent,
 * but no repair job holding the candidate's objects ran the work step (the
 * consumer crashed right after the write, or maintenance consumed the cell).
 * A native-carrier repair job reads only its own run's artifacts, so its own
 * preservation finds nothing and waits `unavailable` forever (live: ai.ubq.fi
 * 610/579). Maintenance reaches the exact producer and rehydrates the exact
 * objects; it must then finish the preservation under the parked class's
 * exact proof instead of discarding that work. A cell maintenance consumes
 * itself is preserved in that same pass, so it never leaves such a record.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { MATRIX_PRESERVATION_UNCERTAINTY_DETAIL } from "../../src/host/matrix-uncertainty-maintenance.ts";
import { CandidateProofPassV1 } from "../../src/host/actions-candidates-proof.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import {
  isInflightPreservation,
  isParkedPreservation,
  restorableParkedCandidate,
} from "../../ops/hosted-autonomy-blocked-candidate.ts";
import { workRecord } from "../state/helpers.ts";
import { modernRecoveryScenario } from "./hosted-autonomy-modern-scenario.ts";
import { preservationWalkRig } from "./hosted-autonomy-history-reach-fixtures.ts";

for (const published of [true, false]) {
  for (const wait of ["unavailable", null] as const) {
    Deno.test(
      `in-flight preservation: exact producer restores the candidate (${
        published ? "published" : "unpublished"
      }, wait=${wait})`,
      () =>
        modernRecoveryScenario(true, false, "valid", {
          wait,
          ...(published ? { published: "ancestor" as const } : {}),
        }),
    );
  }
}

Deno.test(
  "in-flight preservation: a cell this maintenance pass consumes is preserved in the same pass",
  () =>
    modernRecoveryScenario(true, false, "valid", {
      wait: null,
      consumed: true,
    }),
);

for (
  const [name, control, inflight] of [
    ["review_pending wait", "valid", { wait: "review_pending" }],
    ["published head not an ancestor", "valid", {
      wait: "unavailable",
      published: "unrelated",
    }],
    ["wrong candidate", "wrong-candidate", { wait: "unavailable" }],
    ["record changed before restore", "changed-record", {
      wait: "unavailable",
    }],
    ["compare-and-swap conflict", "cas-conflict", { wait: "unavailable" }],
    [
      "compare-and-swap conflict after this pass consumed the cell",
      "cas-conflict",
      {
        wait: null,
        consumed: true,
      },
    ],
    ["missing cell artifact", "missing-artifact", { wait: "unavailable" }],
    ["port gate", "wrong-task", { wait: "unavailable" }],
  ] as const
) {
  Deno.test(`in-flight preservation control: ${name} keeps custody`, () =>
    modernRecoveryScenario(true, false, control, inflight));
}

// Live: R78 repair jobs consume only the cells that finish early, and the
// next maintenance run consumes the late ones. Each such pass must finish its
// cell's preservation itself: left in flight, every late-cell group would
// cost a later applied run of its own (which returns before retry, delivery
// and closure), and older groups would starve behind newer ones.
Deno.test(
  "in-flight preservation walk: a cell maintenance consumes is preserved in that pass, so the older in-flight group is reached on the next run",
  async () => {
    const rig = await preservationWalkRig();
    const row = (taskId: string) =>
      rig.repair().snapshot.work.find((work) => work.id === taskId)!;
    const preserved = (side: typeof rig.older) => ({
      operationKey: implementationIntentKey(side.requestId),
      base: row(side.taskId).target.base,
      head: rig.candidates.get(side.requestId)!,
      ref: side.ref,
    });
    try {
      const charges = rig.repair().snapshot.reservations;
      const first = await rig.walk();
      assert.equal(first?.status, "applied", JSON.stringify(first));
      assert.deepEqual(first?.actions, ["current-matrix:ingested:1"]);
      // Only the newest producer applied, and its consumed cell left nothing
      // in flight behind it.
      assert.deepEqual(rig.calls.recovered, [rig.newer.runId]);
      assert.deepEqual(rig.calls.ingested, [rig.newer.taskId]);
      assert.deepEqual(rig.calls.preserved, [rig.newer.ref]);
      const newer = row(rig.newer.taskId);
      assert.equal(isInflightPreservation(newer), false);
      assert.equal(newer.nextStep, "work");
      assert.equal(newer.intent, null);
      assert.equal(newer.wait, null);
      assert.deepEqual(newer.target.candidateState, {
        preserved: preserved(rig.newer),
        publishedHead: null,
      });
      assert.equal(isInflightPreservation(row(rig.older.taskId)), true);

      // The next run passes over the newer producer (nothing of it is pending
      // any more) and reaches the older in-flight group.
      const second = await rig.walk();
      assert.equal(second?.status, "applied", JSON.stringify(second));
      assert.deepEqual(second?.actions, ["current-matrix:ingested:1"]);
      assert.deepEqual(rig.calls.recovered, [
        rig.newer.runId,
        rig.newer.runId,
        rig.older.runId,
      ]);
      assert.deepEqual(rig.calls.ingested, [rig.newer.taskId]);
      assert.deepEqual(rig.calls.preserved, [rig.newer.ref, rig.older.ref]);
      const older = row(rig.older.taskId);
      assert.equal(older.intent, null);
      assert.equal(older.wait, null);
      assert.deepEqual(older.target.candidateState, {
        preserved: preserved(rig.older),
        publishedHead: null,
      });
      // Both charges stay charged: one settled by its own consumption, none
      // refunded, none added.
      const after = rig.repair().snapshot.reservations;
      assert.equal(after.length, charges.length);
      for (const charge of after) {
        assert.equal(charge.outcome, "submitted", charge.id);
        assert.notEqual(charge.settledAt, null, charge.id);
      }
      assert.deepEqual(after[0], charges[0]);
      assert.deepEqual(
        { ...after[1], outcome: charges[1].outcome, settledAt: null },
        charges[1],
      );

      // Nothing is pending: the walk reads no producer again.
      assert.equal(await rig.walk(), null);
      assert.equal(rig.calls.recovered.length, 3);
    } finally {
      await rig.cleanup();
    }
  },
);

// #185: a producer pass builds its ingest cycle and every preservation of a
// target with ONE proof pass, so the candidates it preserves share one fresh
// store, and the pass closes it when it ends: no later pass reuses it.
Deno.test(
  "in-flight preservation walk: each producer pass preserves through its own proof pass, closed when that pass ends",
  async () => {
    const rig = await preservationWalkRig();
    try {
      const first = await rig.walk();
      assert.equal(first?.status, "applied", JSON.stringify(first));
      const passes = [...rig.calls.proofPasses];
      // The newer producer's ingest cycle and its consumed cell's preservation.
      assert.equal(passes.length, 2);
      assert.ok(passes[0] instanceof CandidateProofPassV1);
      assert.equal(passes[1], passes[0]);
      assert.equal(passes[0].closed, true);

      const second = await rig.walk();
      assert.equal(second?.status, "applied", JSON.stringify(second));
      const later = rig.calls.proofPasses.slice(passes.length);
      assert.equal(later.length, 2, "the older producer's pass");
      assert.ok(later[0] instanceof CandidateProofPassV1);
      assert.equal(later[1], later[0]);
      assert.notEqual(later[0], passes[0], "a new pass, never the earlier one");
      assert.equal(later[0].closed, true);
    } finally {
      await rig.cleanup();
    }
  },
);

const BASE = "8ea3def4b7a995086a8b92a80cc77bc781b00b85" as GitSha;
const HEAD = "7c04548b5189e0a184fa8d7c56b44f4d37e67ad8" as GitSha;
const REQUEST =
  "58e80ac6af509d4779705c7e4b67a79f8cd9fec0a089cb139d5b1b05895ccca7";
const REF =
  "refs/heads/sentinel-candidates/348b113cc5554e96e4621e8c4dbe82dafc57dd2c9b3f807ee437374ce96a8902";

/** The live 610 record as every repair job since 10:17Z left it. */
function live610(overrides: Record<string, unknown> = {}): WorkRecordV1 {
  return workRecord("issue-ubiquity-ai.ubq.fi-610", {
    related: { incidentId: null, issueNumber: 610 },
    counters: { attempts: 4, retries: 0, reviewRounds: 1, stalled: 21 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-ai.ubq.fi-610",
      candidateState: {
        preserved: null,
        publishedHead: "e8f40924a2bf6bad1c7cc61efb3d13d2133738f3",
      },
      checkpoint: null,
      head: HEAD,
      pr: 1106,
    },
    intent: {
      kind: "candidate_preservation",
      key: implementationIntentKey(REQUEST),
      startedAt: 1792144691920,
      branch: REF,
      expectedHead: HEAD,
      observedBase: BASE,
      pr: null,
      requestId: REQUEST,
      resultId: null,
    },
    wait: {
      reason: "unavailable",
      since: 1792166618195,
      until: 1792166918195,
    },
    updatedAt: 1792166618195,
    ...overrides,
  });
}

Deno.test("in-flight preservation: the closed class admits exactly the live parked shapes", () => {
  const blocked = (message: string) => ({
    nextStep: "blocked",
    wait: null,
    blocker: { kind: "other", message, since: 1792167319941 },
  });
  const runtimeMismatch =
    "authenticated historical matrix runtime mismatch; producer=37996641586:1; runtime=" +
    "3".repeat(40) + "; plan=" + "a".repeat(64) +
    "; artifact=1; archive=sha256:" + "b".repeat(64) + "; planner=2; result=" +
    "c".repeat(64) + "; original admission retained";
  const live = live610();
  // Shapes the parser itself refuses still never enter the class.
  const raw = (overrides: Partial<WorkRecordV1>) =>
    ({ ...live, ...overrides }) as WorkRecordV1;
  const rows: [string, WorkRecordV1, boolean][] = [
    ["live 610 (unavailable wait, published)", live, true],
    ["live 579 (fresh, no wait)", live610({ wait: null }), true],
    [
      "unpublished",
      live610({
        target: {
          ...live.target,
          pr: null,
          candidateState: { preserved: null, publishedHead: null },
        },
      }),
      true,
    ],
    [
      "review_pending wait",
      live610({
        wait: { reason: "review_pending", since: 1, until: 2 },
      }),
      false,
    ],
    [
      "backoff wait",
      live610({
        wait: { reason: "backoff", since: 1, until: 2 },
      }),
      false,
    ],
    [
      "runtime-mismatch blocked (587)",
      live610(blocked(runtimeMismatch)),
      false,
    ],
    [
      "uncertainty parked (884)",
      live610(blocked(MATRIX_PRESERVATION_UNCERTAINTY_DETAIL)),
      false,
    ],
    [
      "implementation intent",
      live610({
        intent: {
          ...live.intent!,
          kind: "implementation",
          branch: live.target.branch,
          expectedHead: null,
        },
        target: {
          base: BASE,
          branch: live.target.branch,
          checkpoint: null,
          head: null,
          pr: null,
        },
      }),
      false,
    ],
    [
      "already preserved",
      raw({
        target: {
          ...live.target,
          candidateState: {
            preserved: {
              operationKey: live.intent!.key,
              base: BASE,
              head: HEAD,
              ref: REF,
            },
            publishedHead: live.target.candidateState!.publishedHead,
          },
        },
      }),
      false,
    ],
    [
      "foreign key",
      raw({
        intent: {
          ...live.intent!,
          key: implementationIntentKey("d".repeat(64)),
        },
      }),
      false,
    ],
    [
      "moved head",
      raw({
        intent: { ...live.intent!, expectedHead: "e".repeat(40) as GitSha },
      }),
      false,
    ],
    [
      "intent bound to a PR",
      raw({
        intent: { ...live.intent!, pr: 1106 },
      }),
      false,
    ],
    ["done", raw({ nextStep: "done", wait: null }), false],
  ];
  for (const [name, record, expected] of rows) {
    assert.equal(isInflightPreservation(record), expected, name);
    // The two classes never overlap: a parked record keeps its own path.
    if (expected) assert.equal(restorableParkedCandidate(record), false, name);
  }
  assert.equal(
    restorableParkedCandidate(live610(blocked(runtimeMismatch))),
    true,
  );
  assert.equal(
    isParkedPreservation(
      live610(blocked(MATRIX_PRESERVATION_UNCERTAINTY_DETAIL)),
    ),
    true,
  );
});
