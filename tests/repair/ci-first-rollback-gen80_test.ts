/**
 * Rollback contract of generation 81's CI-first gate against generation 80.
 * Generation 81 opens the hosted pre-review CI fix route and has R80
 * (e48e7e110) as its rollback target, so:
 *
 * - every state the gate writes in a hosted run parses under R80's own
 *   parser, and the one new hosted write (the CI fix marker on a red head no
 *   review has completed on, a never-reviewed candidate or a reviewed
 *   record's refreshed head) plans no model start under R80, whose hosted
 *   route is closed;
 * - R80's own repair loop consumes that marker as it would its own state: it
 *   gates the head's CI again and parks it `CI red before review; awaiting a
 *   CI fix: ...`, uncharged, with no review requested;
 * - R80's own loop consumes the launcher's moved-base return (the record back
 *   at `work` with its blocker and wait cleared, which the launcher writes
 *   under R80 as soon as it ships): a deterministic refresh with nothing
 *   charged, then the refreshed head's CI before any review.
 *
 * The cell itself is isolated by R80's consumer
 * (tests/host/matrix-ci-first-gen79_test.ts). The R80 cases are ignored in a
 * checkout without R80 (CI checkouts are shallow).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type * as Eligibility from "../../src/repair/loop-eligibility.ts";
import type * as ReviewRecords from "../../src/repair/loop-review-records.ts";
import type * as Policy from "../../src/repair/ci-first-policy.ts";
import type * as Rig from "./ci-first-rig.ts";
import { isCiFixMarker } from "../../src/repair/ci-first-policy.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { assertGen80Parses } from "../state/gen77-contracts.ts";
import {
  gen80Available,
  loadGen80Modules,
} from "../host/gen77-runtime-source.ts";
import { repairConfigs } from "./helpers.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import {
  check,
  ciFirstRig,
  type CiFirstRigOptions,
  HOUR,
  SHA4,
  taskRecord,
} from "./ci-first-rig.ts";

const available = await gen80Available();

const RED = {
  [SHA3]: [check("validate", SHA3, "failure")],
  [SHA1]: [check("validate", SHA1, "success")],
};
const RED_PARK = "CI red before review; awaiting a CI fix: validate(failure)";
/** A head of PR 7 reviewed clean on SHA1 before SHA3 replaced it. */
const EARLIER_HEAD = "9".repeat(40) as GitSha;

interface ScenarioV1 {
  name: string;
  options: CiFirstRigOptions;
  /** Clock advance and re-run after the first run (pending timeout). */
  later?: number;
  /** The record carries generation 81's new hosted write, the fix marker. */
  marker?: true;
  /** Runs (at most six, ten minutes apart) until this holds; default one. */
  until?: (record: WorkRecordV1) => boolean;
  expect(record: WorkRecordV1): void;
}

const SCENARIOS: ScenarioV1[] = [
  {
    name: "hosted red head",
    options: { hosted: true, checks: RED },
    marker: true,
    expect: (record) => {
      assert.equal(record.nextStep, "work");
      assert.ok(isCiFixMarker(record.wait));
      assert.equal(record.counters.retries, 0, "charged only at admission");
    },
  },
  {
    name: "hosted red refreshed head of a reviewed record",
    options: {
      hosted: true,
      reviewed: true,
      reviewRounds: 1,
      nextStep: "delivery",
      baseTip: SHA2,
      refreshTo: { [SHA3]: SHA4 },
      checks: {
        [SHA4]: [check("validate", SHA4, "failure")],
        [SHA2]: [check("validate", SHA2, "success")],
      },
    },
    marker: true,
    until: (record) => isCiFixMarker(record.wait),
    expect: (record) => {
      assert.equal(record.target.head, SHA4);
      assert.equal(record.nextStep, "work");
      assert.ok(isCiFixMarker(record.wait));
      assert.equal(record.counters.reviewRounds, 1);
    },
  },
  {
    name: "hosted pending CI past six hours",
    options: {
      hosted: true,
      checks: { [SHA3]: [check("validate", SHA3, null, "in_progress")] },
    },
    later: 6 * HOUR,
    expect: (record) => {
      assert.equal(record.nextStep, "blocked");
      assert.match(
        record.blocker?.message ?? "",
        /^CI did not finish before review within 6 hours: /,
      );
    },
  },
  {
    name: "hosted past the retired CI fix cap",
    options: { hosted: true, retries: 3, attempts: 4, checks: RED },
    expect: (record) => {
      // Owner directive 2026-10-30: the spent count no longer parks; the
      // hosted run carries the zero-length CI fix marker R80 consumes.
      assert.equal(record.nextStep, "work");
      assert.ok(isCiFixMarker(record.wait), JSON.stringify(record.wait));
    },
  },
];

async function loadR80() {
  const loaded = await loadGen80Modules([
    "src/repair/loop-eligibility.ts",
    "src/repair/loop-review-records.ts",
    "src/repair/ci-first-policy.ts",
    "tests/repair/ci-first-rig.ts",
  ]);
  const [eligibility, records, policy, rig] = loaded.modules as unknown as [
    typeof Eligibility,
    typeof ReviewRecords,
    typeof Policy,
    typeof Rig,
  ];
  return { eligibility, records, policy, rig, dispose: loaded.dispose };
}

/** R80, in a hosted run, plans no model start for `record`. */
function assertR80HostedInert(
  r80: Awaited<ReturnType<typeof loadR80>>,
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  now: number,
) {
  const route = r80.policy.preReviewCiFixRouteOpen({
    externalImplementations: true,
  });
  assert.equal(route, false, "R80 keeps the hosted route closed");
  const config = repairConfigs({
    repository: record.repository,
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  })[0];
  assert.equal(
    r80.records.headNeedsCorrection(snapshot, record, true, route),
    false,
  );
  assert.equal(
    r80.eligibility.isModelStartAction(snapshot, record, true, true, route),
    false,
  );
  assert.equal(
    r80.eligibility.isMatrixImplementationReadyV1(
      record,
      snapshot,
      config,
      now,
      true,
      true,
      route,
    ),
    false,
  );
}

Deno.test({
  name:
    "rollback to generation 80: every hosted CI-first state parses under R80 and R80 plans no model start for the CI fix marker",
  ignore: !available,
  async fn(t) {
    const r80 = await loadR80();
    try {
      for (const scenario of SCENARIOS) {
        await t.step(scenario.name, async () => {
          const { rig, writes } = await ciFirstRig(
            `cf-r80-${scenario.name.replaceAll(" ", "-")}`,
            structuredClone(scenario.options),
          );
          try {
            const until = scenario.until ?? (() => true);
            for (let run = 0; run < 6; run++) {
              await rig.run();
              if (until(taskRecord(await rig.snapshot()))) break;
              rig.clock.advance(10 * 60_000);
            }
            if (scenario.later !== undefined) {
              rig.clock.advance(scenario.later);
              await rig.run();
            }
            const after = await rig.snapshot();
            const record = taskRecord(after);
            scenario.expect(record);
            assert.equal(rig.github.calls.includes("requestReview"), false);
            assert.ok(writes.length > 0);
            for (const written of writes) await assertGen80Parses(written);
            if (scenario.marker === true) {
              assertR80HostedInert(r80, after, record, rig.clock.now());
            }
          } finally {
            await rig.ctx.cleanup();
          }
        });
      }
    } finally {
      await r80.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 80: R80's own loop parks generation 81's CI fix marker precisely, uncharged",
  ignore: !available,
  async fn(t) {
    const r80 = await loadR80();
    try {
      const cases: [string, Partial<Rig.CiFirstRigOptions>][] = [
        ["never-reviewed head", {}],
        // A reviewed record's refreshed head: an earlier head was reviewed
        // clean, none of SHA3.
        ["reviewed record's refreshed head", {
          reviewRounds: 1,
          reviews: [completedReceipt(7, EARLIER_HEAD, SHA1)] as never,
        }],
      ];
      for (const [name, extra] of cases) {
        await t.step(name, async () => {
          const { rig, charges } = await r80.rig.ciFirstRig(
            `cf-r80-marker-${name.replaceAll(" ", "-")}`,
            {
              hosted: true,
              checks: structuredClone(RED),
              wait: { reason: "backoff", since: T0, until: T0 },
              ...extra,
            },
          );
          try {
            await rig.run();
            const after = await rig.snapshot();
            const record = r80.rig.taskRecord(after);
            assert.equal(record.nextStep, "blocked");
            assert.equal(record.blocker?.message, RED_PARK);
            assert.equal(record.target.head, SHA3);
            assert.equal(record.counters.retries, 0, "no fix charged");
            assert.deepEqual(after.reservations, charges, "nothing charged");
            assert.equal(rig.model.requests.length, 0);
            assert.equal(rig.github.calls.includes("requestReview"), false);
          } finally {
            await rig.ctx.cleanup();
          }
        });
      }
    } finally {
      await r80.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 80: R80's own loop refreshes the launcher's moved-base return uncharged and gates its CI before review",
  ignore: !available,
  async fn(t) {
    const r80 = await loadR80();
    try {
      for (const green of [false, true]) {
        await t.step(green ? "green refreshed head" : "red", async () => {
          // The launcher's write: the parked record back at `work` with its
          // blocker and wait cleared and its target unchanged, on SHA1 while
          // development moved to SHA2. Its head SHA3 is a refreshed head no
          // review completed on (an earlier head was reviewed clean).
          const { rig, charges, refreshes } = await r80.rig.ciFirstRig(
            `cf-r80-moved-${green}`,
            {
              hosted: true,
              reviews: [completedReceipt(7, EARLIER_HEAD, SHA1)] as never,
              reviewRounds: 1,
              baseTip: SHA2,
              refreshTo: { [SHA3]: SHA4 },
              checks: {
                [SHA3]: [check("validate", SHA3, "failure")],
                [SHA1]: [check("validate", SHA1, "success")],
                [SHA2]: [check("validate", SHA2, "success")],
                [SHA4]: [
                  check("validate", SHA4, green ? "success" : "failure"),
                ],
              },
            },
          );
          try {
            for (let run = 0; run < 6; run++) {
              await rig.run();
              const step = r80.rig.taskRecord(await rig.snapshot()).nextStep;
              if (step === "blocked" || step === "review") break;
              rig.clock.advance(10 * 60_000);
            }
            const after = await rig.snapshot();
            const record = r80.rig.taskRecord(after);
            assert.equal(refreshes.length, 1, "one deterministic refresh");
            assert.equal(record.target.head, SHA4);
            assert.equal(record.target.base, SHA2);
            assert.equal(rig.model.requests.length, 0, "no model start");
            const reviews = rig.github.reviewRequestIdentities;
            if (green) {
              assert.equal(record.nextStep, "review");
              assert.deepEqual(
                reviews.map((request) => request.expectedHead),
                [SHA4],
                "one review, of the green refreshed head",
              );
            } else {
              assert.equal(record.nextStep, "blocked");
              assert.equal(record.blocker?.message, RED_PARK);
              assert.equal(reviews.length, 0, "a red head is never reviewed");
              assert.deepEqual(after.reservations, charges, "nothing charged");
              assert.equal(record.counters.reviewRounds, 1);
            }
          } finally {
            await rig.ctx.cleanup();
          }
        });
      }
    } finally {
      await r80.dispose();
    }
  },
});
