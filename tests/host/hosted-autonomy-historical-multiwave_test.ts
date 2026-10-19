import assert from "node:assert/strict";
import { DORMANT_HOSTED_POLICIES } from "./actions-supervisor-fixture.ts";
import { runHistoricalMatrixQuarantine } from "../../src/host/matrix-actions.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { createHostedHistoricalMatrixQuarantine } from "../../ops/hosted-autonomy.ts";
import { type reservation, T0 } from "../state/helpers.ts";
import { historicalWithNewerCurrent } from "./hosted-autonomy-newer-current-fixtures.ts";
import { historicalMultiWaveRig } from "./hosted-autonomy-multiwave-fixtures.ts";

Deno.test("historical multiwave: first maintenance drains old seventeen and newer three before bootstrap", async () => {
  const f = await historicalMultiWaveRig(17, 3, false);
  const previousCwd = Deno.cwd();
  Deno.chdir(f.checkout);
  try {
    const releaseBefore = await f.release.readRelease();
    assert(releaseBefore.ok && releaseBefore.value.status === "found");
    const current = releaseBefore.value.snapshot.hostedRuntimes[0].execution!;
    assert.equal(current.runId, 73);
    assert.equal(
      releaseBefore.value.snapshot.hostedRuntimes[0].lastExecutionProof
        ?.execution.runId,
      71,
    );
    assert.equal(
      await f.historicalMatrix.transport.confirmCompletedExecution!(current),
      true,
    );
    const native = await f.evidence.readExecution(current);
    assert(
      native.ok && native.value !== null && native.value.outcome === "failed",
    );
    const before = await f.rig.state.readRepair();
    assert(before.ok && before.value.status === "found");
    assert.equal(
      before.value.snapshot.work.filter((row) =>
        row.intent?.kind === "implementation"
      ).length,
      20,
    );
    const result = await f.run();
    assert(
      result.actions.includes("historical-matrix:quarantined:20"),
      JSON.stringify(result.actions),
    );
    assert.deepEqual(await f.release.readRelease(), releaseBefore);
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.filter((row) => row.nextStep === "blocked")
        .length,
      20,
    );
    assert(
      after.value.snapshot.reservations.every((row) =>
        row.outcome === "ambiguous"
      ),
    );
    const successor = {
      runId: 74,
      runAttempt: 1,
      launcherSha: "5".repeat(40) as GitSha,
    };
    f.clock.now = () => T0 + 70_000;
    const prepared = await runHostedSupervisorPrepare({
      ...DORMANT_HOSTED_POLICIES,
      state: f.release,
      clock: f.clock,
      run: successor,
      evidence: f.evidence,
    });
    assert(prepared.status === "run", JSON.stringify(prepared));
    assert.equal(prepared.execution.purpose, "bootstrap");
    f.setBootstrap({ execution: prepared.execution, run: successor });
    assert.equal(
      (await runHostedSupervisorFinalize({
        ...DORMANT_HOSTED_POLICIES,
        state: f.release,
        clock: f.clock,
        run: successor,
        evidence: f.evidence,
      })).status,
      "idle",
    );
    // The first maintenance populated the read-through view; the successor
    // writes then moved the REAL release head. The product-visible read must
    // observe the moved head and never the cached snapshot.
    const afterSuccessor = await f.rig.state.readRelease();
    assert(afterSuccessor.ok && afterSuccessor.value.status === "found");
    const successorRuntime = afterSuccessor.value.snapshot.hostedRuntimes[0];
    assert.equal(
      successorRuntime.lastExecutionProof?.execution.runId ??
        successorRuntime.execution?.runId,
      74,
      "an externally moved release head is observed after a cached custody read",
    );
    assert(
      !((await f.run()).actions.some((action) =>
        action.startsWith("historical-matrix:quarantined:")
      )),
    );
    assert.deepEqual(await f.rig.state.readRepair(), after);
  } finally {
    Deno.chdir(previousCwd);
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical multiwave: missing newer manifest blocks prepare and retry preserves historical charges", async () => {
  const f = await historicalMultiWaveRig();
  try {
    f.setMissing(true);
    const releaseBefore = await f.release.readRelease();
    assert.equal(await f.runMain(), 1);
    assert.deepEqual(await f.release.readRelease(), releaseBefore);
    const partial = await f.rig.state.readRepair();
    assert(partial.ok && partial.value.status === "found");
    assert.equal(
      partial.value.snapshot.work.filter((row) => row.nextStep === "blocked")
        .length,
      17,
    );
    for (const charge of f.charges) {
      assert.equal(
        partial.value.snapshot.reservations.find((row) => row.id === charge.id)
          ?.outcome,
        "reserved",
      );
    }
    f.setMissing(false);
    const resumed = await f.run();
    assert(resumed.actions.includes("historical-matrix:quarantined:3"));
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.filter((row) => row.nextStep === "blocked")
        .length,
      20,
    );
    for (
      const charge of partial.value.snapshot.reservations.filter((row) =>
        row.outcome === "ambiguous"
      )
    ) {
      assert.deepEqual(
        after.value.snapshot.reservations.find((row) => row.id === charge.id),
        charge,
      );
    }
    assert.deepEqual(await f.release.readRelease(), releaseBefore);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical newer current: settled cancellation protects separately saved older wave before prepare", async () => {
  const f = await historicalWithNewerCurrent();
  try {
    const releaseBefore = await f.release.readRelease();
    const outcome = await f.run();
    assert(outcome.actions.includes("historical-matrix:quarantined:17"));
    assert.deepEqual(f.observed, [73, 71]);
    assert.deepEqual(await f.release.readRelease(), releaseBefore);
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    for (let i = 0; i < 17; i++) {
      const original = f.records[i];
      const work: WorkRecordV1 = after.value.snapshot.work.find((row) =>
        row.id === original.id
      )!;
      assert.equal(work.nextStep, "blocked");
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
      assert.deepEqual({
        ...charge,
        outcome: f.charges[i].outcome,
        settledAt: null,
      }, f.charges[i]);
    }
    const prepared = await runHostedSupervisorPrepare({
      ...DORMANT_HOSTED_POLICIES,
      state: f.release,
      clock: f.clock,
      run: { runId: 74, runAttempt: 1, launcherSha: f.current.launcherSha },
      evidence: {
        ...f.evidence,
        readExecution: f.reader.readHostedExecution.bind(f.reader),
      },
    });
    assert.equal(prepared.status, "run", JSON.stringify(prepared));
    const replaced = await f.release.readRelease();
    assert(replaced.ok && replaced.value.status === "found");
    assert.equal(
      replaced.value.snapshot.hostedRuntimes[0].lastExecutionProof?.execution
        .id,
      "73:1:repair",
    );
    assert.deepEqual(await f.rig.state.readRepair(), after);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical release witness: refusal and partial CAS retry preserve exact charged custody", async () => {
  for (
    const fault of [
      "active",
      "pin",
      "native",
      "missing",
      "outage",
      "drift",
      "cas",
    ]
  ) {
    const f = await historicalWithNewerCurrent(
      fault === "active" ? "pending" : "settled",
      true,
    );
    const previousCwd = Deno.cwd();
    Deno.chdir(f.checkout);
    try {
      if (fault === "missing" || fault === "outage") f.setFault(fault);
      const proof = f.witness.snapshot.hostedRuntimes[0].lastExecutionProof!;
      assert(proof.outcome !== "not_started");
      const deps = createHostedHistoricalMatrixQuarantine({
        state: f.rig.state,
        clock: f.clock,
        token: "offline-native-token",
        artifactRoot: `${f.rig.tmp}/refusal-artifacts`,
        http: f.currentHttp,
        artifactHttp: f.currentHttp,
        historicalReleaseWitnesses: [{
          commit: f.witness.head,
          executionId: proof.execution.id,
          logDigest: fault === "pin" ? "a".repeat(64) : proof.logDigest,
          reservationIds: f.charges.slice(0, 17).map((row) => row.id),
        }],
      });
      const originalWrite = f.rig.state.writeRepair;
      if (fault === "native") {
        const read = deps.readExecution;
        deps.readExecution = async (execution) => {
          const result = await read(execution);
          return execution.id === proof.execution.id && result.ok &&
              result.value !== null && result.value.outcome !== "not_started"
            ? portOk({ ...result.value, logDigest: "b".repeat(64) })
            : result;
        };
      }
      if (fault === "cas") {
        f.rig.state.writeRepair = (next, expected) =>
          next.work.some((row) => row.nextStep === "blocked")
            ? Promise.resolve(
              portOk({ status: "conflict", currentHead: expected }),
            )
            : originalWrite(next, expected);
      }
      if (fault === "drift") {
        const settle = deps.budget.settleModelStart.bind(deps.budget);
        deps.budget.settleModelStart = async (request) => {
          const result = await settle(request);
          const current = await f.release.readRelease();
          assert(current.ok && current.value.status === "found");
          const moved = await f.release.writeRelease({
            ...current.value.snapshot,
            stateHead: current.value.head,
            sequence: current.value.snapshot.sequence + 1,
            updatedAt: f.clock.now(),
            hostedRuntimes: current.value.snapshot.hostedRuntimes.map((
              row,
            ) => ({ ...row, nextOrdinaryAt: row.nextOrdinaryAt + 1 })),
          }, current.value.head);
          assert(moved.ok && moved.value.status === "applied");
          return result;
        };
      }
      const before = await f.rig.state.readRepair();
      await assert.rejects(
        () => runHistoricalMatrixQuarantine(deps),
        /historical matrix|matrix artifact/,
      );
      const after = await f.rig.state.readRepair();
      assert(after.ok && after.value.status === "found");
      assert(after.value.snapshot.work.every((row) => row.nextStep === "work"));
      if (fault === "cas" || fault === "drift") {
        assert.equal(after.value.snapshot.reservations[0].outcome, "ambiguous");
        if (fault === "cas") {
          f.rig.state.writeRepair = originalWrite;
          await assert.rejects(
            () => runHistoricalMatrixQuarantine(deps),
            /historical matrix native settlement unavailable/,
          );
          const retry = await f.rig.state.readRepair();
          assert(retry.ok && retry.value.status === "found");
          assert.equal(
            retry.value.snapshot.reservations[0].settledAt,
            after.value.snapshot.reservations[0].settledAt,
          );
        }
      } else assert.deepEqual(after, before);
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical newer current: unfinished foreign unavailable or drifting current cannot write", async () => {
  for (
    const mode of [
      "pending",
      "unavailable",
      "foreign",
      "wrong-job",
      "wrong-binding",
      "custody",
      "truncated",
      "duplicate",
      "old-proof-missing",
    ]
  ) {
    const f = await historicalWithNewerCurrent(mode);
    try {
      const before = await f.rig.state.readRepair();
      assert.equal(await f.runMain(), 1);
      assert.deepEqual(await f.rig.state.readRepair(), before);
      assert(!f.observed.includes(71));
      assert.equal(f.rig.merges, 0);
    } finally {
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

/** Parse one attempt-memory record for the self task at one base/revision. */
