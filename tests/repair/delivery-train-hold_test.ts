/**
 * Runtime hold for an open delivery train (sentinel #330): while the
 * launcher's train of a repository is open (read through the state view's
 * `readDeliveryTrainHolds`), the runtime's head-of-line refresh refreshes no
 * member and no other record of that repository, so the train's members keep
 * the exact reviewed heads it composed. Once the train is gone the line
 * resumes. Drives the REAL repair loop over one fake repository.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { DeliveryTrainHoldV1 } from "../../src/contracts/delivery-train-ledger.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { deliveryTrainHold } from "../../src/repair/delivery-queue.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { REPO, reservation, SHA1, T0, workRecord } from "../state/helpers.ts";
import { APP, queueRig } from "./delivery-queue-rig.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { MINUTE, sha } from "./review-round-cap-rig.ts";

const RECORDS = 3;
const OP = "0123456789abcdef01234567";

async function reviewedLine() {
  const seed = await queueRig(RECORDS);
  const reservations: BudgetReservationV1[] = [];
  const reviews: ReviewReceiptV1[] = [];
  const shaped = seed.records.map((record) =>
    workRecord(record.id, {
      ...record,
      nextStep: "delivery",
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    })
  );
  for (const record of shaped) {
    reservations.push(reservation(`${record.id}-review-1`, {
      repository: REPO,
      taskId: record.id,
      attempt: 1,
      head: record.target.head!,
      purpose: "review_request",
      outcome: "submitted",
      createdAt: T0 - 30 * MINUTE,
      settledAt: T0 - 30 * MINUTE + 1,
    }));
    const issueNumber = record.related.issueNumber!;
    reviews.push(
      completedReceipt(record.target.pr!, record.target.head! as GitSha, SHA1, {
        id: `review-receipt:${record.id}:reviewed`,
        repository: REPO,
        resultId: `result-${record.id}`,
        expectedReviewer: APP,
        observedReviewer: APP,
        taskAcceptance: {
          issueNumber,
          taskDigest: await reviewTaskStatementDigest({
            issueNumber,
            title: `issue ${issueNumber}`,
            body: "",
          }),
          verdict: "fulfilled",
          evidence: ["the exact reviewed change implements the source issue"],
        },
      }),
    );
  }
  const rig = await queueRig(RECORDS, {
    shape: () => shaped,
    reservations,
    reviews,
    reviewer: APP,
  });
  rig.github.remoteBase = sha(0x7001);
  return rig;
}

async function cycles(rig: Awaited<ReturnType<typeof reviewedLine>>, n = 3) {
  for (let run = 0; run < n; run++) {
    await runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 60 * MINUTE,
      stepLimit: 16,
    });
    rig.clock.advance(16 * MINUTE);
  }
}

Deno.test("train hold: an open train holds every record of its repository; none is refreshed", async () => {
  const rig = await reviewedLine();
  const members = rig.records.slice(0, 2).map((record) => record.id);
  let holds: DeliveryTrainHoldV1[] = [{
    repository: REPO,
    operationId: OP,
    members,
  }];
  Object.assign(rig.deps.state, {
    readDeliveryTrainHolds: () => Promise.resolve(portOk(holds)),
  });
  await cycles(rig);
  assert.equal(rig.github.preparedKeys.length, 0, "no refresh under a train");
  const snapshot = await rig.snapshot();
  for (const seeded of rig.records) {
    const now = snapshot.work.find((record) => record.id === seeded.id)!;
    assert.equal(now.target.head, seeded.target.head, `${seeded.id} head kept`);
    assert.equal(now.intent, null, `${seeded.id} holds no refresh intent`);
  }
  assert.equal(rig.github.pushes.length, 0);
  // The train closed: the head of the line refreshes again.
  holds = [];
  await cycles(rig, 1);
  assert.ok(
    rig.github.preparedKeys.some((key) => key.startsWith("101:")),
    JSON.stringify(rig.github.preparedKeys),
  );
});

Deno.test("train hold: an unreadable train ledger holds nothing (fail open)", async () => {
  const rig = await reviewedLine();
  Object.assign(rig.deps.state, {
    readDeliveryTrainHolds: () =>
      Promise.resolve(portError("unavailable", "train ledger lookup")),
  });
  await cycles(rig, 1);
  assert.ok(rig.github.preparedKeys.some((key) => key.startsWith("101:")));
});

Deno.test("train hold: a hold binds its own repository only", () => {
  const hold: DeliveryTrainHoldV1 = {
    repository: REPO,
    operationId: OP,
    members: ["issue-1"],
  };
  const record = (repository: WorkRecordV1["repository"]) => ({
    id: "issue-9" as WorkRecordV1["id"],
    repository,
  });
  assert.equal(deliveryTrainHold([hold], record(REPO)), hold);
  assert.equal(
    deliveryTrainHold([hold], record({ ...REPO, name: "elsewhere" })),
    null,
  );
  assert.equal(deliveryTrainHold([], record(REPO)), null);
});
