/** Failed implementation settlement stays pending until the same charge settles. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { reservation, SHA1, T0, workRecord } from "../state/helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import { FakeModel } from "./helpers.ts";

for (
  const consumer of [
    "saved-intent",
    "no-receipt",
    "incomplete-receipt",
  ] as const
) {
  for (
    const mode of [
      "healthy",
      "conflict",
      "ambiguous",
      "unavailable",
      "ambiguous-applied",
    ] as const
  ) {
    Deno.test(`accounting ${consumer}: ${mode} settlement preserves durable recovery`, async () => {
      const sourceIssue = issueRecord(31, {
        title: "uncertain implementation",
        relations: { openBlockers: [], subIssueCount: 0 },
      });
      const github = new RelationsFakeGithub({ baseSha: SHA1 });
      github.listed = [sourceIssue];
      github.latest.set(31, sourceIssue);
      const rig = makeMemoryRig(github);
      const reservationId = "res-uncertain";
      const taskId = asWorkItemId("issue-31");
      const branch = candidateBranch(taskId);
      const record = workRecord("issue-31", {
        source: { kind: "issue", id: "31", revision: SHA1 },
        related: { incidentId: null, issueNumber: 31 },
        target: { base: SHA1, branch, checkpoint: null, head: null, pr: null },
        nextStep: "work",
        counters: {
          attempts: consumer === "saved-intent" ? 1 : 0,
          retries: 0,
          reviewRounds: 0,
        },
        intent: consumer === "saved-intent"
          ? {
            kind: "implementation",
            key: implementationIntentKey(reservationId),
            startedAt: T0,
            branch,
            expectedHead: null,
            observedBase: SHA1,
            pr: null,
            requestId: reservationId,
            resultId: null,
          }
          : null,
      });
      const charge = reservation(reservationId, {
        taskId,
        attempt: 1,
        head: SHA1,
        purpose: "implementation",
        outcome: "reserved",
        settledAt: null,
      });
      const seeded = await rig.state.writeRepair(
        seededSnapshot([record], {
          reservations: consumer === "saved-intent" ? [charge] : [],
        }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");

      // Real RollingStartBudget sees a typed transient failure from its state
      // writer only at the reserved -> ambiguous settlement; every later read
      // and unrelated write remains healthy.
      let injected = mode !== "healthy";
      let rejectedSettlementWrites = 0;
      const originalWrite = rig.state.writeRepair.bind(rig.state);
      rig.state.writeRepair = (next, expectedHead) => {
        const settlement = next.reservations.some((item) =>
          item.outcome === "ambiguous" && rig.state.repair?.reservations.some(
            (prior) => prior.id === item.id && prior.outcome === "reserved",
          )
        );
        if (injected && settlement) {
          rejectedSettlementWrites++;
          if (mode === "ambiguous-applied") {
            // A lost response after an applied write is still ambiguous to
            // the consumer. Its next cycle must read back the existing charge
            // and settle idempotently, preserving its first settlement time.
            return originalWrite(next, expectedHead).then((applied) => {
              assert.ok(applied.ok && applied.value.status === "applied");
              return portOk({
                status: "ambiguous",
                currentHead: rig.state.repairHead,
              });
            });
          }
          if (mode === "unavailable") {
            return Promise.resolve(
              portError(
                "unavailable",
                "synthetic settlement write unavailable",
              ),
            );
          }
          return Promise.resolve(portOk({
            status: mode as "conflict" | "ambiguous",
            currentHead: rig.state.repairHead,
          }));
        }
        return originalWrite(next, expectedHead);
      };
      const model = new FakeModel(
        consumer === "no-receipt" ? { portError: true } : { outcome: "failed" },
      );
      rig.model.runModel = model.runModel.bind(model);
      const first = await rig.run();
      const firstState = await rig.snapshot();
      const firstStored = firstState.work.find((item) => item.id === taskId)!;
      const firstCharge = firstState.reservations.find((item) =>
        item.taskId === taskId
      )!;
      assert.equal(
        firstState.reservations.length,
        1,
        "one original admission only",
      );
      assert.ok(firstStored.intent !== null);
      assert.equal(firstStored.intent?.kind, "implementation");
      assert.equal(firstStored.intent.requestId, firstCharge.id);
      assert.equal(firstStored.counters.attempts, 1);
      if (consumer === "saved-intent") {
        assert.deepEqual(firstStored.intent, record.intent);
      }
      const beforeRetry = {
        first,
        nextStep: firstStored.nextStep,
        intent: firstStored.intent?.requestId,
        reservationOutcome: firstCharge.outcome,
        settledAt: firstCharge.settledAt,
        attemptMemoryCount: firstState.attemptMemory.length,
        modelCalls: model.requests.length,
      };
      // The fault is gone on the next run and time advances; the production
      // consumer must now reconcile the same reservation, never start again.
      injected = false;
      rig.clock.advance(60_000);
      const second = await rig.run();
      const afterRetry = await rig.snapshot();
      const afterCharge = afterRetry.reservations.find((item) =>
        item.id === firstCharge.id
      )!;
      assert.equal(
        afterRetry.reservations.length,
        1,
        "settlement retry never reserves again",
      );
      assert.equal(
        second.status,
        "idle",
        JSON.stringify({ consumer, mode, beforeRetry, second }),
      );
      assert.equal(
        afterRetry.work.find((item) => item.id === taskId)!.nextStep,
        "blocked",
      );
      // Only a settlement in the run that started the model carries an
      // authenticated producing runtime; reconciling a saved intent later
      // preserves the charge without fabricating a memory outcome.
      const authenticatedProducer = mode === "healthy" &&
        consumer !== "saved-intent";
      assert.equal(
        afterRetry.attemptMemory.length,
        authenticatedProducer ? 1 : 0,
        authenticatedProducer
          ? "one terminal memory follows verified settlement"
          : "saved-intent settlement never fabricates a memory outcome",
      );
      assert.equal(afterCharge.outcome, "ambiguous");
      assert.ok(afterCharge.settledAt !== null);
      assert.equal(afterCharge.proofRef, null, "uncertainty is never refunded");
      assert.deepEqual(afterCharge, {
        ...firstCharge,
        outcome: "ambiguous",
        settledAt: afterCharge.settledAt,
      });
      assert.equal(model.requests.length, consumer === "saved-intent" ? 0 : 1);
      if (mode === "healthy") {
        assert.equal(first.status, "idle");
        assert.equal(firstStored.nextStep, "blocked");
        assert.equal(firstCharge.outcome, "ambiguous");
        assert.ok(firstCharge.settledAt !== null);
      } else {
        assert.equal(
          rejectedSettlementWrites,
          1,
          "exactly one transient settlement failed",
        );
        assert.equal(
          first.status,
          "state_error",
          "failed settlement must remain visible and recoverable",
        );
        assert.equal(first.detail, "budget settlement failed");
        assert.equal(
          firstStored.nextStep,
          "work",
          "no terminal blocker before durable settlement",
        );
        assert.equal(firstStored.blocker, null);
        assert.ok(firstStored.intent !== null, "exact prior intent survives");
        assert.equal(
          firstCharge.outcome,
          mode === "ambiguous-applied" ? "ambiguous" : "reserved",
        );
        if (mode === "ambiguous-applied") {
          assert.ok(firstCharge.settledAt !== null);
          assert.deepEqual(
            afterCharge,
            firstCharge,
            "idempotent readback retains exact charge bytes and original settlement time",
          );
        } else {
          assert.equal(firstCharge.settledAt, null);
          assert.equal(
            afterCharge.settledAt,
            rig.clock.now(),
            "the retry settles at the injected later time",
          );
        }
        assert.equal(
          firstState.attemptMemory.length,
          0,
          "no fabricated terminal accounting",
        );
        assert.equal(
          afterCharge.outcome,
          "ambiguous",
          "next run settles same reservation after transient failure",
        );
        assert.ok(afterCharge.settledAt !== null);
      }
    });
  }
}
