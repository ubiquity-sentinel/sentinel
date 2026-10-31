/**
 * Rollback contract of JAM B6 against R80 (e48e7e110), the rollback target of
 * the generation that ships it. R80's own code (extracted read-only from the
 * local object store) consumes what generation 81 writes:
 *
 * - the B6a correction (`work`, the receipt carrying the acceptance P1):
 *   R80's parsers accept it and R80's own loop starts the same correction
 *   with the same first finding, never the merge-gate path that would refuse
 *   the acceptance with a state error on every run;
 * - the B6b owner-gated park when a full receipt cannot carry the acceptance
 *   finding: parsed, and idle under R80;
 * - the launcher's B6a re-admission (`review`, blocker cleared): R80
 *   re-observes the standing verdict and blocks it again, uncharged (the
 *   launcher therefore re-admits only under a proven correction runtime).
 *
 * Ignored in a checkout without R80 (CI checkouts are shallow).
 */
import assert from "node:assert/strict";
import { asFindingFingerprint } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type * as Snapshots from "../../src/contracts/state-snapshots.ts";
import { MaxItems } from "../../src/contracts/validation.ts";
import {
  TASK_ACCEPTANCE_FINDING_ID,
  TASK_ACCEPTANCE_OWNER_GATE_DETAIL,
} from "../../src/repair/acceptance-correction.ts";
import { reviewReceiptId } from "../../src/repair/keys.ts";
import type * as Eligibility from "../../src/repair/loop-eligibility.ts";
import type * as ReviewRecords from "../../src/repair/loop-review-records.ts";
import { TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL } from "../../src/repair/review-gate.ts";
import { SHA2 } from "../state/helpers.ts";
import { acceptanceRig, NOT_FULFILLED } from "./acceptance-fixtures.ts";
import { loadR80Modules, r80Available } from "./acceptance-r80-source.ts";
import { repairConfigs } from "./helpers.ts";
import type * as Candidates from "./loop-candidate-fixtures.ts";
import type * as Fixtures from "./loop-review-fixtures.ts";
import type * as Rig from "./loop-rig.ts";

const available = await r80Available();

/** R80's own modules the cases below run. */
async function loadR80() {
  const loaded = await loadR80Modules([
    "src/contracts/state-snapshots.ts",
    "src/repair/loop-review-records.ts",
    "src/repair/loop-eligibility.ts",
    "tests/repair/loop-rig.ts",
    "tests/repair/loop-review-fixtures.ts",
    "tests/repair/loop-candidate-fixtures.ts",
  ]);
  const [snapshots, records, eligibility, rig, fixtures, candidates] = loaded
    .modules as unknown as [
      typeof Snapshots,
      typeof ReviewRecords,
      typeof Eligibility,
      typeof Rig,
      typeof Fixtures,
      typeof Candidates,
    ];
  return {
    snapshots,
    records,
    eligibility,
    rig,
    fixtures,
    candidates,
    dispose: loaded.dispose,
  };
}

type R80 = Awaited<ReturnType<typeof loadR80>>;

/** One generation-81 hosted run over the live round shape; its snapshot. */
async function gen81State(
  name: string,
  rounds: number,
  fullReceipt = false,
) {
  const rig = await acceptanceRig(`b6-r80-${name}`, rounds, true);
  try {
    if (fullReceipt) {
      // Round counts no longer park a record. Exercise the remaining owner gate
      // through the real review consumer: there is no room for its acceptance
      // finding, so the receipt must be retained and the record parked.
      const observation = rig.github.reviewObservationsByKey.get(
        rig.operationKey,
      );
      assert.ok(observation);
      rig.github.reviewObservationsByKey.set(rig.operationKey, {
        ...observation,
        findings: Array.from({ length: MaxItems.findings }, (_, index) => ({
          id: `existing-finding-${index}`,
          severity: "P3" as const,
          path: null,
          message: "Existing review finding",
          fingerprint: asFindingFingerprint(
            index.toString(16).padStart(64, "0"),
          ),
          resolved: false,
          resolutionEvidence: null,
        })),
      });
    }
    await rig.run();
    return {
      snapshot: await rig.snapshot(),
      now: rig.clock.now(),
      receiptId: await reviewReceiptId(rig.operationKey, SHA2),
      operationKey: rig.operationKey,
    };
  } finally {
    await rig.ctx.cleanup();
  }
}

/** R80's own local rig seeded with exactly `snapshot` at `now`. */
async function r80Rig(r80: R80, name: string, snapshot: unknown, now: number) {
  const rig = await r80.rig.makeRig(`b6-r80-own-${name}`, {
    summaries: false,
    github: {
      candidateLifecycle: {
        ...r80.candidates.positiveLifecycle(),
        refs: { "refs/heads/sentinel/repair/issue-1": SHA2 },
        pullRequests: [
          r80.candidates.exactOpenPr(7, SHA2, "sentinel/repair/issue-1"),
        ],
      },
    },
  });
  const seed = r80.snapshots.parseRepairStateSnapshotV1({
    ...JSON.parse(canonicalStringify(snapshot)),
    stateHead: null,
    sequence: 1,
  });
  const written = await rig.store.writeRepair(seed, null);
  assert.ok(written.ok && written.value.status === "applied");
  rig.clock.advance(now - rig.clock.now() + 60_000);
  return rig;
}

function parsesUnderR80(r80: R80, snapshot: RepairStateSnapshotV1) {
  const parsed = r80.snapshots.parseRepairStateSnapshotV1(
    JSON.parse(canonicalStringify(snapshot)),
  );
  assert.equal(canonicalStringify(parsed), canonicalStringify(snapshot));
}

Deno.test({
  name:
    "rollback to R80: B6 corrections, parks and re-admissions parse and stay safe under R80's own loop",
  ignore: !available,
  async fn(t) {
    const r80 = await loadR80();
    try {
      await t.step("B6a correction: R80 corrects it like a P0/P1", async () => {
        const state = await gen81State("correct", 1);
        parsesUnderR80(r80, state.snapshot);
        const record = state.snapshot.work[0]!;
        assert.equal(record.nextStep, "work");
        const receipt = state.snapshot.reviews.find((review) =>
          review.id === state.receiptId
        )!;
        assert.equal(receipt.findings[0]!.id, TASK_ACCEPTANCE_FINDING_ID);
        // R80's own predicates read the correction, not a CI wait.
        assert.equal(
          r80.records.headNeedsCorrection(state.snapshot, record, true, false),
          true,
        );
        assert.equal(
          r80.records.headAwaitsCiCorrection(state.snapshot, record, true),
          false,
          "never the green-exit path to R80's merge gate",
        );
        assert.deepEqual(
          r80.records.correctionFindings(state.snapshot, record)?.[0],
          { severity: "P1", path: null, message: receipt.findings[0]!.message },
        );
        const config = repairConfigs({
          sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
        })[0];
        assert.equal(
          r80.eligibility.isMatrixImplementationReadyV1(
            record,
            state.snapshot,
            config,
            state.now,
            true,
            true,
          ),
          true,
          "R80's planner admits the same correction cell",
        );
        const rig = await r80Rig(r80, "correct", state.snapshot, state.now);
        try {
          const outcome = await rig.run();
          assert.notEqual(
            outcome.status,
            "state_error",
            JSON.stringify(outcome),
          );
          assert.equal(rig.model.requests.length, 1);
          assert.equal(rig.model.requests[0]!.checkoutBase, SHA2);
          assert.equal(
            rig.model.requests[0]!.reviewFindings?.[0]?.message,
            receipt.findings[0]!.message,
          );
          assert.equal(rig.github.calls.includes("merge"), false);
        } finally {
          await rig.ctx.cleanup();
        }
      });

      await t.step(
        "control: the same verdict stored without the P1 would jam R80",
        async () => {
          // Why the receipt carries the acceptance as a P1: a clean-findings
          // receipt at `work` reads as a reviewed head awaiting a CI
          // correction under R80, whose green exit hands it to R80's merge
          // gate, which refuses the acceptance with a run-level state error.
          const state = await gen81State("control", 1);
          const clean: RepairStateSnapshotV1 = {
            ...state.snapshot,
            reviews: state.snapshot.reviews.map((review) =>
              review.id === state.receiptId
                ? {
                  ...review,
                  findings: review.findings.slice(1),
                  unresolvedSeverities: [],
                }
                : review
            ),
          };
          const record = clean.work[0]!;
          assert.equal(
            r80.records.headAwaitsCiCorrection(clean, record, true),
            true,
          );
          const rig = await r80Rig(r80, "control", clean, state.now);
          try {
            const outcome = await rig.run();
            assert.equal(
              outcome.status,
              "state_error",
              JSON.stringify(outcome),
            );
            assert.equal(outcome.detail, TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL);
          } finally {
            await rig.ctx.cleanup();
          }
        },
      );

      await t.step(
        "B6a after a change-only receipt of the same head: R80 blocks it, never a state error",
        async () => {
          // The missing-acceptance recovery re-reviews the same head: R80 reads
          // the first-listed change-only receipt, returns the head to review
          // and blocks the re-observed verdict (generation 81 corrects it).
          const state = await gen81State("dual", 2);
          const record = state.snapshot.work[0]!;
          const dual: RepairStateSnapshotV1 = {
            ...state.snapshot,
            reviews: [
              {
                ...state.snapshot.reviews[0]!,
                id: "review-receipt:0",
                requestId: "review-req-0",
                resultId: "result-0",
                findings: [],
                unresolvedSeverities: [],
                taskAcceptance: null,
              },
              ...state.snapshot.reviews,
            ],
          };
          parsesUnderR80(r80, dual);
          assert.equal(
            r80.records.headTaskAcceptanceMissing(dual, record),
            true,
          );
          const rig = await r80Rig(r80, "dual", dual, state.now);
          try {
            rig.github.reviewObservationsByKey.set(
              state.operationKey,
              r80.fixtures.acceptedObservation(
                SHA2,
                NOT_FULFILLED,
                state.now + 1000,
              ),
            );
            const outcome = await rig.run();
            assert.notEqual(
              outcome.status,
              "state_error",
              JSON.stringify(outcome),
            );
            const after = await rig.snapshot();
            assert.equal(after.work[0]!.nextStep, "blocked");
            assert.equal(
              after.work[0]!.blocker?.message,
              TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
            );
            assert.equal(rig.model.requests.length, 0);
            assert.equal(rig.github.reviewRequestIdentities.length, 0);
            assert.deepEqual(after.reservations, dual.reservations);
          } finally {
            await rig.ctx.cleanup();
          }
        },
      );

      await t.step("B6b owner-gated park: parsed and idle", async () => {
        const state = await gen81State("park", 3, true);
        assert.equal(
          state.snapshot.reviews[0]!.findings.length,
          MaxItems.findings,
        );
        parsesUnderR80(r80, state.snapshot);
        const record = state.snapshot.work[0]!;
        assert.equal(
          record.blocker?.message,
          TASK_ACCEPTANCE_OWNER_GATE_DETAIL,
        );
        const rig = await r80Rig(r80, "park", state.snapshot, state.now);
        try {
          const outcome = await rig.run();
          assert.equal(outcome.status, "idle", JSON.stringify(outcome));
          const after = await rig.snapshot();
          assert.deepEqual(after.work[0], record);
          assert.deepEqual(after.reservations, state.snapshot.reservations);
          assert.equal(rig.model.requests.length, 0);
          assert.equal(rig.github.reviewRequestIdentities.length, 0);
        } finally {
          await rig.ctx.cleanup();
        }
      });

      await t.step(
        "launcher re-admission: R80 blocks the same verdict again, uncharged",
        async () => {
          // The launcher's write: the R80 refusal with its blocker cleared and
          // the record back at `review` (counters, charges and identity kept).
          const rig = await r80.rig.makeRig("b6-r80-readmit", {
            summaries: false,
            github: {
              candidateLifecycle: {
                ...r80.candidates.positiveLifecycle(),
                refs: { "refs/heads/sentinel/repair/issue-1": SHA2 },
                pullRequests: [
                  r80.candidates.exactOpenPr(
                    7,
                    SHA2,
                    "sentinel/repair/issue-1",
                  ),
                ],
              },
            },
          });
          try {
            const gen81 = await acceptanceRig("b6-r80-readmit-seed", 2);
            let seed: RepairStateSnapshotV1;
            try {
              seed = await gen81.snapshot();
            } finally {
              await gen81.ctx.cleanup();
            }
            const readmitted = r80.snapshots.parseRepairStateSnapshotV1({
              ...JSON.parse(canonicalStringify(seed)),
              work: seed.work.map((row) => ({
                ...row,
                nextStep: "review",
                wait: null,
                blocker: null,
              })),
            });
            const written = await rig.store.writeRepair(readmitted, null);
            assert.ok(written.ok && written.value.status === "applied");
            rig.clock.advance(3600_000 + 1);
            const key = gen81.operationKey;
            rig.github.reviewObservationsByKey.set(
              key,
              r80.fixtures.acceptedObservation(
                SHA2,
                NOT_FULFILLED,
                rig.clock.now() + 1000,
              ),
            );
            await rig.run();
            const after = await rig.snapshot();
            assert.equal(after.work[0]!.nextStep, "blocked");
            assert.equal(
              after.work[0]!.blocker?.message,
              TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
            );
            assert.deepEqual(after.reservations, readmitted.reservations);
            assert.equal(rig.model.requests.length, 0);
            assert.equal(rig.github.reviewRequestIdentities.length, 0);
          } finally {
            await rig.ctx.cleanup();
          }
        },
      );
    } finally {
      await r80.dispose();
    }
  },
});
