import assert from "node:assert/strict";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import { runActionsMatrixAggregateCycles } from "../../src/host/matrix-actions.ts";
import { rig } from "./matrix-actions-fixtures.ts";
import { runFreshMatrixCells } from "./matrix-actions-cell-fixtures.ts";

Deno.test("matrix readiness: a verified fast target publishes and reviews before its sibling cell arrives", async () => {
  const r = await rig();
  try {
    const { planner, results, archive } = await runFreshMatrixCells(r, false);
    const self = r.github.get("ubiquity-sentinel/sentinel")!;
    const foreign = r.github.get("ubiquity/ai.ubq.fi")!;
    for (const port of [self, foreign]) {
      port.prepareBaseRefresh = () =>
        Promise.reject(new Error("unchanged fixture base must not refresh"));
    }
    self.reviewStatus = "pending";
    foreign.reviewStatus = "pending";
    let notify: (key: string) => void = () => {};
    Object.assign(self, {
      onReviewCompletion: (listener: (key: string) => void) => {
        notify = listener;
        return () => {
          notify = () => {};
        };
      },
    });
    const submit = self.requestReview.bind(self);
    self.requestReview = async (request) => {
      const result = await submit(request);
      const key = (request as { operationKey: string }).operationKey;
      // The event arrives before the request's final state acknowledgement:
      // it must survive the next progress yield and only prompt a fresh read.
      notify(key);
      return result;
    };
    let siblingReady = false;
    let polls = 0;
    let activeWrites = 0;
    let peakWrites = 0;
    let casConflicts = 0;
    let writes = 0;
    const before = await r.store.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    const originalCharges = before.value.snapshot.reservations.map((row) =>
      row.id
    );
    const deps = await r.job("ready-aggregate", "repair");
    const result = await runActionsRepairHost({
      ...deps,
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("aggregate cannot infer")),
      },
      runTargetCycles: (input) => {
        const read = input.state.readRepair.bind(input.state);
        const write = input.state.writeRepair.bind(input.state);
        input.state.writeRepair = async (next, expected) => {
          activeWrites++;
          peakWrites = Math.max(peakWrites, activeWrites);
          try {
            const current = await read();
            assert.ok(current.ok && current.value.status === "found");
            assert.equal(
              expected,
              current.value.head,
              "each resumed operation revalidates the current shared head",
            );
            for (const id of originalCharges) {
              assert.ok(
                next.reservations.some((row) => row.id === id),
                "another target's reservation survives the resumed write",
              );
            }
            const saved = await write(next, expected);
            if (saved.ok && saved.value.status === "conflict") casConflicts++;
            writes++;
            return saved;
          } finally {
            activeWrites--;
          }
        };
        return runActionsMatrixAggregateCycles(
          // Explicit trusted start capability; every external model port is fake.
          { ...input, modelStartsEnabled: true },
          {
            recover: () =>
              Promise.resolve([{
                plan: planner.plan,
                planDigest: planner.planDigest,
                results: results.filter((row) =>
                  siblingReady || row.repository.name === "sentinel"
                ),
                bundlesDir: archive,
                provenance: {
                  run: planner.plan.run,
                  plannerJobId: 101,
                  cellJobIds: [102, 103],
                },
              }]),
          },
          { planDigest: planner.planDigest },
          {
            pollWait: async (ms) => {
              polls++;
              const observed = await input.state.readRepair();
              assert.ok(
                self.calls.includes("requestReview"),
                "the fast target reaches native-review admission before waiting for its sibling: " +
                  JSON.stringify({
                    calls: self.calls.slice(-20),
                    work: observed.ok && observed.value.status === "found"
                      ? observed.value.snapshot.work.filter((row) =>
                        row.repository.name === "sentinel"
                      )
                      : null,
                  }),
              );
              assert.ok(
                self.calls.includes("observeReview"),
                "a matching completion received at a progress yield wakes observation before the wait expires",
              );
              assert.ok(
                self.candidatePullRequests.size > 0,
                "the real lifecycle publishes the fast candidate first",
              );
              assert.equal(
                self.reviewStatus,
                "pending",
                "another target may progress while the first review is owned",
              );
              siblingReady = true;
              r.clock.advance(ms);
              return Promise.resolve();
            },
          },
        );
      },
    });
    assert.equal(result.status, "ran");
    assert.equal(polls, 1);
    assert.ok(
      foreign.calls.includes("requestReview"),
      "the later verified target publishes and starts review while the first remains pending",
    );
    assert.equal(peakWrites, 1);
    assert.equal(casConflicts, 0);
    assert.ok(
      writes >= 4,
      "both target lifecycles commit meaningful transitions",
    );
    assert.equal(self.drains.length, 1);
    assert.equal(foreign.drains.length, 1);
    assert.equal(
      self.drains[0].deadline,
      foreign.drains[0].deadline,
      "every target retains the original shared deadline",
    );
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.reservations.filter((row) =>
        row.purpose === "review_request"
      ).length,
      2,
    );
    assert.ok(
      after.value.snapshot.reservations.every((row) =>
        row.outcome === "submitted"
      ),
    );
  } finally {
    await r.cleanup();
  }
});
