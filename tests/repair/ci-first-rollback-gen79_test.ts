/**
 * Rollback contract of the CI-first gate against generation 79. Generation 80
 * has R79 (549c7a691) as its rollback target, so every state the gate writes
 * in a hosted run (and the in-process fix marker) must parse under R79's own
 * parser, and R79's own eligibility must plan no model start for it: R79
 * either leaves it parked or, once a wait expires, publishes and requests one
 * review exactly as it always did (one charged round, never a model start, a
 * refund or a merge without review). The R79 cases are ignored in a checkout
 * without R79.
 *
 * Generation 81 has R80 as its rollback target
 * (ci-first-rollback-gen80_test.ts) and writes the CI fix marker for a hosted
 * red head instead of the park; R79 still parses that marker and plans no
 * model start for it.
 */
import assert from "node:assert/strict";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type * as Eligibility from "../../src/repair/loop-eligibility.ts";
import type * as ReviewRecords from "../../src/repair/loop-review-records.ts";
import { isCiFixMarker } from "../../src/repair/ci-first-policy.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { assertGen79Parses } from "../state/gen77-contracts.ts";
import {
  gen79Available,
  loadGen79Modules,
} from "../host/gen77-runtime-source.ts";
import { repairConfigs } from "./helpers.ts";
import {
  check,
  ciFirstRig,
  type CiFirstRigOptions,
  HOUR,
  taskRecord,
} from "./ci-first-rig.ts";

const available = await gen79Available();

const RED = {
  [SHA3]: [check("validate", SHA3, "failure")],
  [SHA1]: [check("validate", SHA1, "success")],
};

interface ScenarioV1 {
  name: string;
  options: CiFirstRigOptions;
  /** Clock advance and re-run after the first run (pending timeout). */
  later?: number;
  expect(record: WorkRecordV1): void;
}

const AIUBQ = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;

const SCENARIOS: ScenarioV1[] = [
  {
    name: "hosted pending CI",
    options: {
      hosted: true,
      checks: { [SHA3]: [check("validate", SHA3, null, "in_progress")] },
    },
    expect: (record) => {
      assert.equal(record.nextStep, "work");
      assert.equal(record.wait?.reason, "ci_pending");
    },
  },
  {
    name: "hosted pending CI past six hours",
    options: {
      hosted: true,
      checks: { [SHA3]: [check("validate", SHA3, null, "in_progress")] },
    },
    later: 6 * HOUR + 1,
    expect: (record) => {
      assert.equal(record.nextStep, "blocked");
      assert.match(record.blocker?.message ?? "", /^CI did not finish/);
    },
  },
  {
    name: "hosted red head",
    options: { hosted: true, checks: RED },
    expect: (record) => {
      // Generation 81 opens the hosted pre-review fix route: the marker.
      assert.equal(record.nextStep, "work");
      assert.equal(record.wait?.reason, "backoff");
      assert.equal(record.wait?.since, record.wait?.until);
    },
  },
  {
    name: "hosted red base",
    options: {
      hosted: true,
      checks: {
        [SHA3]: [check("validate", SHA3, "failure")],
        [SHA1]: [check("validate", SHA1, "failure")],
      },
    },
    expect: (record) => {
      assert.equal(record.nextStep, "work");
      assert.equal(record.wait?.reason, "backoff");
    },
  },
  {
    name: "hosted failure without base evidence",
    options: {
      hosted: true,
      checks: {
        [SHA3]: [check("validate", SHA3, "failure")],
        [SHA1]: [check("validate", SHA1, "cancelled")],
      },
    },
    expect: (record) => {
      assert.equal(record.nextStep, "work");
      assert.equal(record.wait?.reason, "ci_pending");
    },
  },
  {
    name: "hosted failure without base evidence past six hours",
    options: {
      hosted: true,
      checks: {
        [SHA3]: [check("validate", SHA3, "failure")],
        [SHA1]: [check("validate", SHA1, "cancelled")],
      },
    },
    later: 6 * HOUR + 1,
    expect: (record) => {
      assert.equal(record.nextStep, "blocked");
      assert.match(
        record.blocker?.message ?? "",
        /^CI did not finish before review within 6 hours: .* without base evidence$/,
      );
    },
  },
  {
    name: "hosted past the retired CI fix cap",
    options: { hosted: true, retries: 3, attempts: 4, checks: RED },
    expect: (record) => {
      // Owner directive 2026-10-30: the spent count no longer parks; the
      // hosted run carries the existing zero-length CI fix marker, which R79
      // parses and plans no model start for.
      assert.equal(record.nextStep, "work");
      assert.ok(isCiFixMarker(record.wait), JSON.stringify(record.wait));
    },
  },
  {
    name: "hosted legacy record returned for its CI fix",
    options: {
      hosted: true,
      identity: {
        repository: AIUBQ,
        id: "issue-ubiquity-ai.ubq.fi-595",
        issue: 595,
      },
      reviewed: true,
      reviewRounds: 4,
      attempts: 3,
      nextStep: "delivery",
      baseTip: SHA2,
      checks: RED,
      // The launcher-pinned cutoff: all four rounds were charged before it.
      legacyReviewCutoff: T0,
    },
    expect: (record) => {
      assert.equal(record.nextStep, "work");
      assert.equal(record.counters.reviewRounds, 4);
      assert.equal(record.counters.retries, 0, "charged only at admission");
    },
  },
];

async function loadR79() {
  const loaded = await loadGen79Modules([
    "src/repair/loop-eligibility.ts",
    "src/repair/loop-review-records.ts",
  ]);
  const [eligibility, records] = loaded.modules as unknown as [
    typeof Eligibility,
    typeof ReviewRecords,
  ];
  return { eligibility, records, dispose: loaded.dispose };
}

/** R79 plans no model start (no cell, no in-process session) for `record`. */
function assertR79Inert(
  r79: Awaited<ReturnType<typeof loadR79>>,
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  now: number,
) {
  const config = repairConfigs({
    repository: record.repository,
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  })[0];
  assert.equal(r79.records.headNeedsCorrection(snapshot, record), false);
  assert.equal(
    r79.eligibility.isModelStartAction(snapshot, record, true, true),
    false,
  );
  assert.equal(
    r79.eligibility.isMatrixImplementationReadyV1(
      record,
      snapshot,
      config,
      now,
      true,
      true,
    ),
    false,
  );
}

Deno.test({
  name:
    "rollback to generation 79: every CI-first state parses under R79 and R79 plans no model start for it",
  ignore: !available,
  async fn(t) {
    const r79 = await loadR79();
    try {
      for (const scenario of SCENARIOS) {
        await t.step(scenario.name, async () => {
          const { rig, writes } = await ciFirstRig(
            `cf-r79-${scenario.name.replaceAll(" ", "-")}`,
            scenario.options,
          );
          try {
            await rig.run();
            if (scenario.later !== undefined) {
              rig.clock.advance(scenario.later);
              await rig.run();
            }
            const after = await rig.snapshot();
            const id = scenario.options.identity?.id;
            const record = taskRecord(after, id);
            scenario.expect(record);
            assert.equal(rig.github.calls.includes("requestReview"), false);
            assert.ok(writes.length > 0);
            for (const written of writes) await assertGen79Parses(written);
            assertR79Inert(r79, after, record, rig.clock.now());
          } finally {
            await rig.ctx.cleanup();
          }
        });
      }
      await t.step("the in-process CI fix marker", async () => {
        const { rig, writes } = await ciFirstRig("cf-r79-marker", {
          checks: RED,
        });
        try {
          await rig.run();
          const marked = writes.find((snapshot) =>
            taskRecord(snapshot).wait?.reason === "backoff"
          );
          assert.ok(marked !== undefined);
          await assertGen79Parses(marked);
          const record = taskRecord(marked);
          assertR79Inert(r79, marked, record, record.updatedAt);
          for (const written of writes) await assertGen79Parses(written);
        } finally {
          await rig.ctx.cleanup();
        }
      });
    } finally {
      await r79.dispose();
    }
  },
});
