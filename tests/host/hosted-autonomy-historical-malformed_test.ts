import assert from "node:assert/strict";
import { assertSupervisorMaintenanceContract } from "./workflow-contract.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { isHardAutonomyFailure } from "../../ops/hosted-autonomy.ts";
import { type reservation, T0 } from "../state/helpers.ts";
import { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";

Deno.test("historical malformed wave: protected maintenance quarantines seventeen charged intents", async () => {
  const f = await historicalMalformedRig();
  try {
    const before = await f.rig.state.readRepair();
    assert(before.ok && before.value.status === "found");
    const result = await f.run();
    assert(result.actions.includes("historical-matrix:quarantined:17"));
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    for (let i = 0; i < 17; i++) {
      const original = f.records[i];
      const work: WorkRecordV1 = after.value.snapshot.work.find((row) =>
        row.id === original.id
      )!;
      assert.equal(work.nextStep, "blocked");
      assert.equal(
        work.blocker?.message,
        "authenticated historical matrix manifest rejected: reservation_after_manifest; model outcome uncertain",
      );
      assert.deepEqual({
        ...work,
        nextStep: original.nextStep,
        blocker: original.blocker,
        wait: original.wait,
        updatedAt: original.updatedAt,
      }, original);
      const charge: ReturnType<typeof reservation> = after.value.snapshot
        .reservations.find((row) => row.id === f.charges[i].id)!;
      assert.equal(charge.outcome, "ambiguous");
      assert.equal(charge.proofRef, null);
      assert.deepEqual({
        ...charge,
        outcome: f.charges[i].outcome,
        settledAt: f.charges[i].settledAt,
      }, f.charges[i]);
    }
    assert.deepEqual(
      after.value.snapshot.work.find((row) => row.id === f.records[17].id),
      f.records[17],
    );
    assert.deepEqual(
      after.value.snapshot.reservations.find((row) =>
        row.id === f.charges[17].id
      ),
      f.charges[17],
    );
    assert.equal(f.rig.merges, 0);
    assert.deepEqual(f.rig.closed, []);
    assert.equal(f.plan.plannedAt, T0);
    assert(
      f.charges.slice(0, 17).every((row) => row.createdAt > f.plan.plannedAt),
    );
    const repeat = await f.run();
    assert(
      !repeat.actions.some((action) =>
        action.startsWith("historical-matrix:quarantined:")
      ),
    );
    const repeated = await f.rig.state.readRepair();
    assert(repeated.ok && repeated.value.status === "found");
    assert.deepEqual(repeated.value.snapshot.work, after.value.snapshot.work);
    assert.deepEqual(
      repeated.value.snapshot.reservations,
      after.value.snapshot.reservations,
    );
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical malformed wave: authentication outage and future manifest refuse quarantine", async () => {
  for (const fault of ["auth", "outage", "future", "pending"] as const) {
    const f = await historicalMalformedRig();
    try {
      if (fault === "future") {
        f.plan.plannedAt = f.clock.now() + 2_000;
        await f.refreshPlan();
      } else f.setFault(fault);
      const before = await f.rig.state.readRepair();
      await assert.rejects(f.run);
      if (fault === "pending") assert.equal(await f.runMain(), 1);
      const after = await f.rig.state.readRepair();
      assert.deepEqual(after, before);
      assert.equal(f.rig.merges, 0);
    } finally {
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical malformed wave: settlement CAS and drift preserve charged identity", async () => {
  for (const mode of ["settlement", "cas", "drift", "custody"] as const) {
    const f = await historicalMalformedRig();
    try {
      const write = f.rig.state.writeRepair.bind(f.rig.state);
      const settle = f.historicalMatrix.budget.settleModelStart.bind(
        f.historicalMatrix.budget,
      );
      if (mode === "settlement") {
        f.historicalMatrix.budget.settleModelStart = () =>
          Promise.resolve({
            status: "unavailable",
            detail: "injected offline refusal",
          });
      } else if (mode === "cas") {
        f.rig.state.writeRepair = (next, expected) =>
          next.work.some((row) => row.nextStep === "blocked")
            ? Promise.resolve(
              portOk({ status: "conflict", currentHead: expected }),
            )
            : write(next, expected);
      } else if (mode === "custody") {
        f.historicalMatrix.budget.settleModelStart = async (request) => {
          const result = await settle(request);
          f.rig.state.readRelease = () =>
            Promise.resolve(
              portError("unavailable", "injected saved proof loss"),
            );
          return result;
        };
      } else {
        f.historicalMatrix.budget.settleModelStart = async (request) => {
          const result = await settle(request);
          const read = await f.rig.state.readRepair();
          assert(read.ok && read.value.status === "found");
          const snapshot = read.value.snapshot;
          const changed = await write({
            ...snapshot,
            stateHead: read.value.head,
            sequence: snapshot.sequence + 1,
            updatedAt: f.clock.now(),
            work: snapshot.work.map((row) =>
              row.id === f.records[0].id
                ? {
                  ...row,
                  counters: {
                    ...row.counters,
                    retries: row.counters.retries + 1,
                  },
                  updatedAt: f.clock.now(),
                }
                : row
            ),
          }, read.value.head);
          assert(changed.ok && changed.value.status === "applied");
          return result;
        };
      }
      const before = await f.rig.state.readRepair();
      await assert.rejects(f.run);
      const after = await f.rig.state.readRepair();
      assert(after.ok && after.value.status === "found");
      assert(after.value.snapshot.work.every((row) => row.nextStep === "work"));
      if (mode === "settlement") assert.deepEqual(after, before);
      else {
        assert.equal(after.value.snapshot.reservations[0].outcome, "ambiguous");
        assert.equal(
          after.value.snapshot.work[0].counters.retries,
          mode === "drift" ? 1 : 0,
        );
        assert.deepEqual(
          after.value.snapshot.work[0].intent,
          f.records[0].intent,
        );
      }
      if (mode === "cas") {
        f.rig.state.writeRepair = write;
        const retry = await f.run();
        assert(retry.actions.includes("historical-matrix:quarantined:17"));
        const recovered = await f.rig.state.readRepair();
        assert(recovered.ok && recovered.value.status === "found");
        assert.equal(
          recovered.value.snapshot.reservations[0].settledAt,
          after.value.snapshot.reservations[0].settledAt,
        );
        assert.equal(
          recovered.value.snapshot.work.filter((row) =>
            row.nextStep === "blocked"
          ).length,
          17,
        );
      }
    } finally {
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical malformed wave: actual maintenance entrypoint blocks prepare on incomplete quarantine", async () => {
  const f = await historicalMalformedRig();
  try {
    f.setFault("auth");
    const before = await f.rig.state.readRepair();
    assert.equal(await f.runMain(), 1);
    assert.deepEqual(await f.rig.state.readRepair(), before);
    const workflow = await Deno.readTextFile(
      new URL("../../.github/workflows/supervisor.yml", import.meta.url),
    );
    assertSupervisorMaintenanceContract(workflow);
    assert.equal(
      isHardAutonomyFailure("historical_quarantine_incomplete"),
      true,
    );
    f.setFault(null);
    assert.equal(await f.runMain(), 0);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical malformed wave: maintenance leaf diagnostic is secret-free and fail-closed", async () => {
  const f = await historicalMalformedRig(false, 1);
  const errors: string[] = [];
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  const readRepair = f.rig.state.readRepair;
  console.error = (value: unknown) => errors.push(String(value));
  console.log = (value: unknown) => logs.push(String(value));
  try {
    f.setFault("auth");
    const before = await f.rig.state.readRepair();
    const releaseBefore = await f.rig.state.readRelease();
    assert.equal(await f.runMain(), 1);
    const diagnostics = errors.map((value) => JSON.parse(value));
    const frames = diagnostics[0].frames;
    assert.ok(Array.isArray(frames) && frames.length > 0 && frames.length <= 3);
    for (const frame of frames) {
      assert.deepEqual(Object.keys(frame).sort(), ["column", "line"]);
      assert.ok(
        Number.isSafeInteger(frame.line) && frame.line > 0 &&
          frame.line <= 999999,
      );
      assert.ok(
        Number.isSafeInteger(frame.column) && frame.column > 0 &&
          frame.column <= 999999,
      );
    }
    assert.ok(errors[0].length <= 180);
    assert.doesNotMatch(
      errors[0],
      /private|token|https|file:|matrix-artifacts/,
    );
    assert.deepEqual(diagnostics, [{
      kind: "sentinel_matrix_artifact_error",
      frames,
    }, {
      kind: "sentinel_historical_quarantine_error",
      name: "Error",
      message: "matrix artifact provenance unavailable or conflicting",
    }]);
    assert.deepEqual(await f.rig.state.readRepair(), before);
    assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
    const privateError = new Error(
      "historical matrix state unavailable https://example.invalid/?token=private-token",
    );
    privateError.name = "Bearer private-token";
    let nameReads = 0;
    let messageReads = 0;
    const switchingError = Object.defineProperties(new Error(), {
      name: {
        get: () => nameReads++ === 0 ? "Error" : "Bearer private-token",
      },
      message: {
        get: () =>
          messageReads++ === 0
            ? "historical matrix state unavailable"
            : "https://example.invalid/?token=private-response-body",
      },
    });
    for (
      const [error, name, message] of [
        [switchingError, "Error", "historical matrix state unavailable"],
        [
          new Error("historical matrix not-started admission unproven"),
          "Error",
          "historical matrix not-started admission unproven",
        ],
        [
          new Error("historical matrix state unavailable"),
          "Error",
          "historical matrix state unavailable",
        ],
        [privateError, "UnknownError", "[redacted]"],
        [
          new TypeError("private-response-body".repeat(1000)),
          "TypeError",
          "[redacted]",
        ],
        [{ message: "private-response-body" }, "UnknownError", "[redacted]"],
      ] as const
    ) {
      errors.length = 0;
      f.rig.state.readRepair = () => Promise.reject(error);
      assert.equal(await f.runMain(), 1);
      assert.deepEqual(errors.map((value) => JSON.parse(value)), [{
        kind: "sentinel_historical_quarantine_error",
        name,
        message,
      }]);
    }
    assert.equal(nameReads, 1);
    assert.equal(messageReads, 1);
    // Both maintenance log sinks must emit only fixed taxonomy categories and
    // must never echo raw error text or payload content.
    const SAFE_CATEGORIES = [
      "historical_quarantine_incomplete",
      "historical_matrix_recovery",
      "current_matrix_ingestion",
      "closed_c_maintenance",
      "unexpected_error",
    ];
    const categoryLines = logs
      .map((value) => JSON.parse(value))
      .filter((line) =>
        line.kind === "sentinel_autonomy_failure_detail" ||
        line.kind === "sentinel_autonomy_deferred"
      );
    assert.ok(categoryLines.length >= 2);
    for (const line of categoryLines) {
      assert.ok(
        typeof line.category === "string" &&
          SAFE_CATEGORIES.includes(line.category),
      );
      assert.equal("detail" in line, false);
      assert.equal("message" in line, false);
    }
    assert.doesNotMatch(logs.join("\n"), /private-token|private-response-body/);
    f.rig.state.readRepair = readRepair;
    assert.deepEqual(await f.rig.state.readRepair(), before);
    assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
    f.setFault(null);
    errors.length = 0;
    assert.equal(await f.runMain(), 0);
    assert.deepEqual(errors, []);
  } finally {
    f.rig.state.readRepair = readRepair;
    console.error = originalError;
    console.log = originalLog;
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical malformed wave: missing archive and malformed parser never quarantine", async () => {
  for (
    const mode of [
      "missing",
      "parser",
      "missing-proof",
      "valid-applicable",
    ] as const
  ) {
    const f = await historicalMalformedRig();
    try {
      const before = await f.rig.state.readRepair();
      if (mode === "missing") {
        f.setFault("missing");
        assert.equal(await f.runMain(), 1);
        await assert.rejects(f.run);
      } else if (mode === "missing-proof") {
        f.historicalMatrix.state = {
          ...f.rig.state,
          readRelease: async () => {
            const read = await f.rig.state.readRelease();
            if (!read.ok || read.value.status !== "found") return read;
            return portOk({
              ...read.value,
              snapshot: { ...read.value.snapshot, hostedRuntimes: [] },
            });
          },
        };
        assert.equal(await f.runMain(), 1);
        await assert.rejects(f.run);
        assert.equal(f.calls.length, 0);
      } else if (mode === "valid-applicable") {
        f.plan.plannedAt = T0 + 1000;
        await f.refreshPlan();
        assert.equal(await f.runMain(), 0);
        await f.run();
      } else {
        Object.assign(f.plan, { kind: "invalid_fixture_kind" });
        await f.refreshPlan();
        await assert.rejects(f.run);
      }
      assert.deepEqual(await f.rig.state.readRepair(), before);
      const workflow = await Deno.readTextFile(
        new URL("../../.github/workflows/supervisor.yml", import.meta.url),
      );
      assertSupervisorMaintenanceContract(workflow);
    } finally {
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical malformed wave: executed non-malformed plan skips rejection instead of refusing", async () => {
  const f = await historicalMalformedRig();
  try {
    const before = await f.rig.state.readRepair();
    // A healthy prior run whose cells legitimately executed (completed with a
    // failed-outcome receipt) while its records remain in work for retry: the
    // plan is non-malformed, so the historical rejection must skip it before
    // verifying cell results. Refusing on the completed cells would deadlock
    // every subsequent maintenance on a plan the rejection skips anyway.
    f.plan.plannedAt = T0 + 1000;
    await f.refreshPlan("completed");
    assert.equal(await f.runMain(), 0);
    await f.run();
    assert.deepEqual(await f.rig.state.readRepair(), before);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});
