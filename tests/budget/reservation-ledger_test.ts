// Capacity refusals are reported truthfully, and archived charges still refuse
// a duplicate admission / count in the rolling caps.
import assert from "node:assert/strict";
import {
  deriveReservationId,
  RollingStartBudget,
} from "../../src/budget/mod.ts";
import { MaxItems } from "../../src/contracts/validation.ts";
import { REPO, reservation, SHA1, T0 } from "../state/helpers.ts";
import { FakeClock, MemoryRepairState, repositoryConfig } from "./helpers.ts";
import { snapshot } from "./controller-fixtures.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function seeded(id: string, overrides: Record<string, unknown> = {}) {
  return reservation(id, {
    createdAt: T0 - DAY,
    outcome: "submitted" as const,
    settledAt: T0 - DAY + 1_000,
    ...overrides,
  });
}

Deno.test("budget: a capacity-refused admission is a distinct non-transient status", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  const rows = Array.from(
    { length: MaxItems.snapshotRecords },
    (_, index) => seeded(`r:${String(index).padStart(5, "0")}`),
  );
  state.seed(snapshot({ reservations: rows }));
  const controller = new RollingStartBudget({
    clock,
    state,
    configs: [
      repositoryConfig(REPO, { perHour: 1_000_000, perSevenDays: null }),
    ],
  });

  const result = await controller.reserveModelStart({
    repository: REPO,
    taskId: "task:overflow" as never,
    head: SHA1,
    attempt: 1,
    purpose: "implementation",
  });
  assert.equal(result.status, "rejected", JSON.stringify(result));
  if (result.status === "rejected") {
    assert.equal(result.reason, "state_snapshot_refused");
  }
  assert.equal(state.writes, 0, "a refused write records nothing");
});

Deno.test("budget: an archived reservation still refuses its exact duplicate", async () => {
  const clock = new FakeClock(T0);
  const request = {
    repository: REPO,
    taskId: "task:archived" as never,
    head: SHA1,
    attempt: 1,
    purpose: "implementation" as const,
  };
  const id = await deriveReservationId(request);
  const state = new MemoryRepairState();
  state.seed(snapshot({
    reservationArchive: [seeded(id, { taskId: "task:archived" })],
  }));
  const controller = new RollingStartBudget({
    clock,
    state,
    configs: [
      repositoryConfig(REPO, { perHour: 1_000_000, perSevenDays: null }),
    ],
  });

  const duplicate = await controller.reserveModelStart(request);
  assert.equal(duplicate.status, "duplicate", JSON.stringify(duplicate));

  // Idempotent settlement of the archived row is still recognized.
  const settled = await controller.settleModelStart({
    id,
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(settled.status, "idempotent", JSON.stringify(settled));

  // Archived rows are immutable retention records: a contradictory settlement
  // fails closed instead of claiming an unrecorded mutation.
  const contradictory = await controller.settleModelStart({
    id,
    outcome: "confirmed_not_submitted",
    proofRef: "artifact://proof/archived",
  });
  assert.equal(contradictory.status, "invalid", JSON.stringify(contradictory));
});

Deno.test("budget: archived charges still count in the rolling caps", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  state.seed(snapshot({
    reservationArchive: [
      seeded("r:archived", { createdAt: T0 - 1_000, settledAt: T0 }),
    ],
  }));
  const controller = new RollingStartBudget({
    clock,
    state,
    configs: [repositoryConfig(REPO, { perHour: 1, perSevenDays: null })],
  });

  const result = await controller.reserveModelStart({
    repository: REPO,
    taskId: "task:next" as never,
    head: SHA1,
    attempt: 1,
    purpose: "implementation",
  });
  assert.equal(result.status, "deferred", JSON.stringify(result));
  if (result.status === "deferred") {
    assert.equal(result.reason, "cap_limit");
    assert.equal(
      result.retryAt,
      T0 - 1_000 + HOUR,
      "the archived charge leaves the rolling window at its exact time",
    );
  }
  assert.equal(state.writes, 0);
});
