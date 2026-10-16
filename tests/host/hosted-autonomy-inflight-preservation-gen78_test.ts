/**
 * Rollback proof for the in-flight preservation restore. Generation 79's
 * launcher writes exactly the record the parked-class restore writes, and the
 * installed generation-78 runtime (R78 474f87eb6), the rollback target, must
 * consume it with its own code: R78's parser accepts the snapshot, R78's
 * transition validator accepts the write, and R78's own repair loop publishes
 * from the preserved ref without asking for another preservation. The
 * contrast run reproduces the live loop under R78: over the pre-restore
 * record its own preservation finds nothing and waits `unavailable`, charge
 * untouched, intent kept.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { assertGen78Parses } from "../state/gen77-contracts.ts";
import { gen78Available, loadGen78Modules } from "./gen77-runtime-source.ts";
import {
  type InflightStateV1,
  modernRecoveryScenario,
} from "./hosted-autonomy-modern-scenario.ts";

const ignore = !await gen78Available();

// deno-lint-ignore no-explicit-any
type Module = any;

/** R78's own loop, transition validator, ports and fakes. */
async function gen78(): Promise<{
  m: Record<string, Module>;
  dispose(): Promise<void>;
}> {
  const loaded = await loadGen78Modules([
    "src/repair/loop.ts",
    "src/state/state-repair-transition.ts",
    "src/budget/mod.ts",
    "src/host/hosted-cooldown.ts",
    "tests/repair/helpers.ts",
    "tests/repair/loop-candidate-fixtures.ts",
  ]);
  const [loop, transition, budget, cooldown, helpers, fixtures] = loaded
    .modules as Module[];
  return {
    m: { loop, transition, budget, cooldown, helpers, fixtures },
    dispose: loaded.dispose,
  };
}

async function snapshotOf(input: InflightStateV1) {
  const read = await input.state.readRepair();
  assert(read.ok && read.value.status === "found");
  return read.value.snapshot;
}

/** One R78 repair cycle over the live rig state, with R78's own deps. */
async function runGen78(
  m: Record<string, Module>,
  input: InflightStateV1,
  github: Module,
) {
  return await m.loop.runRepairCycle({
    state: input.state,
    clock: input.clock,
    configs: [input.config],
    controllerSha: "4".repeat(40) as GitSha,
    githubCooldown: new m.cooldown.HostedRepairCooldownGate({
      state: input.state,
      clock: input.clock,
    }),
    github,
    incidents: new m.helpers.FakeIncidents(),
    replay: new m.helpers.FakeReplay(),
    model: new m.helpers.FakeModel(),
    budget: new m.budget.RollingStartBudget({
      state: input.state,
      clock: input.clock,
      configs: [input.config],
    }),
    externalImplementations: true,
  }, { deadline: input.clock.now() + 3600_000, stepLimit: 12 });
}

/**
 * R78's own repair loop over the restored state: it publishes from the
 * preserved ref without asking for another preservation, every write passes
 * R78's validator and parser, the charges survive and only the ordinary
 * review is newly charged.
 */
async function publishesUnderGen78(
  m: Record<string, Module>,
  input: InflightStateV1,
  restored: RepairStateSnapshotV1,
) {
  const record = restored.work.find((row) => row.id === input.taskId)!;
  const preserved = record.target.candidateState!.preserved!;
  const publishedHead = record.target.candidateState!.publishedHead;
  const github = new m.helpers.FakeGithub({
    baseSha: input.base,
    openIssues: [],
    candidateLifecycle: {
      prepareBaseRefresh: () => {
        throw new Error("the stable synthetic base must not refresh");
      },
      refs: {
        [preserved.ref]: input.candidate,
        ...(publishedHead === null ? {} : {
          ["refs/heads/" + record.target.branch]: publishedHead,
        }),
      },
      ...(publishedHead === null ? {} : {
        pullRequests: [
          m.fixtures.exactOpenPr(
            record.target.pr,
            publishedHead,
            record.target.branch,
            input.base,
          ),
        ],
      }),
    },
    reviewRequestedAt: input.clock.now(),
  });
  const cycled = await runGen78(m, input, github);
  assert.notEqual(cycled.status, "state_error", JSON.stringify(cycled));
  const after = await snapshotOf(input);
  assert.equal(m.transition.validateRepairTransition(restored, after), null);
  await assertGen78Parses(after);
  const ready = after.work.find((row) => row.id === input.taskId)!;
  assert.deepEqual(github.preservationRequests, []);
  assert.equal(
    ready.nextStep,
    "review",
    JSON.stringify({ ready, calls: github.calls }),
  );
  assert.equal(ready.target.head, input.candidate);
  assert.equal(ready.target.candidateState?.publishedHead, input.candidate);
  assert.equal(
    github.calls.filter((call: string) => call === "createPr").length,
    publishedHead === null ? 1 : 0,
  );
  // The original charge survives; only the ordinary review is new.
  const ids = new Set(restored.reservations.map((row) => row.id));
  assert.deepEqual(
    after.reservations.filter((row) => ids.has(row.id)),
    restored.reservations,
  );
  assert.deepEqual(
    after.reservations.filter((row) => !ids.has(row.id)).map((row) =>
      row.purpose
    ),
    ["review_request"],
  );
}

// Live maintenance consumes the cells that finish after their repair job.
// Generation 79 then writes in that one pass the unchanged consumption (its
// charge settlement, then the in-flight record R78 already writes and reads),
// and then the preservation. R78 must accept each write as its own
// transition, and publish from the result.
Deno.test({
  name:
    "in-flight preservation gen78 rollback: R78 validates every write of a pass that consumes and preserves a cell, then publishes",
  ignore,
  fn: async () => {
    const { m, dispose } = await gen78();
    const writes: {
      prior: RepairStateSnapshotV1;
      next: RepairStateSnapshotV1;
    }[] = [];
    try {
      await modernRecoveryScenario(true, false, "valid", {
        wait: null,
        consumed: true,
        beforeRestore: (input) => {
          const write = input.state.writeRepair;
          input.state.writeRepair = async (next, head) => {
            const read = await input.state.readRepair();
            const written = await write(next, head);
            if (
              read.ok && read.value.status === "found" &&
              read.value.head === head && written.ok &&
              written.value.status === "applied"
            ) writes.push({ prior: read.value.snapshot, next });
            return written;
          };
          return Promise.resolve();
        },
        afterRestore: async (input) => {
          // The consumer's own writes (its charge settlement, then the
          // in-flight record), then the preservation; the idempotent rerun
          // wrote nothing.
          assert.equal(writes.length, 3, JSON.stringify(writes.length));
          const [settlement, consumption, preservation] = writes.map((
            { prior, next },
          ) => ({
            prior: prior.work.find((row) => row.id === input.taskId)!,
            next: next.work.find((row) => row.id === input.taskId)!,
          }));
          assert.deepEqual(writes[0].next.work, writes[0].prior.work);
          assert.deepEqual(consumption.prior, settlement.next);
          assert.equal(consumption.prior.intent?.kind, "implementation");
          assert.equal(consumption.next.intent?.kind, "candidate_preservation");
          assert.equal(consumption.next.target.candidateState?.preserved, null);
          assert.deepEqual(preservation.prior, consumption.next);
          assert.equal(preservation.next.intent, null);
          assert.equal(
            preservation.next.target.candidateState?.preserved?.head,
            input.candidate,
          );
          for (const { prior, next } of writes) {
            await assertGen78Parses(next);
            assert.equal(
              m.transition.validateRepairTransition(prior, next),
              null,
            );
          }
          await publishesUnderGen78(m, input, await snapshotOf(input));
        },
      });
    } finally {
      await dispose();
    }
  },
});

for (const published of [false, true]) {
  Deno.test({
    name:
      `in-flight preservation gen78 rollback: R78 parses, validates and publishes the restored record (${
        published ? "published" : "unpublished"
      })`,
    ignore,
    fn: async () => {
      const { m, dispose } = await gen78();
      const seen: { prior: RepairStateSnapshotV1 | null } = { prior: null };
      try {
        await modernRecoveryScenario(true, false, "valid", {
          wait: null,
          ...(published ? { published: "ancestor" as const } : {}),
          beforeRestore: async (input) => {
            // The live loop under R78: its own preservation finds nothing.
            const start = await snapshotOf(input);
            const original = start.work.find((row) => row.id === input.taskId)!;
            const github = new m.helpers.FakeGithub({
              baseSha: input.base,
              openIssues: [],
              candidateLifecycle: {
                preserveCandidate: () =>
                  Promise.resolve(
                    portError("not_found", "candidate is not available"),
                  ),
              },
            });
            const cycled = await runGen78(m, input, github);
            assert.notEqual(cycled.status, "state_error");
            const prior = seen.prior = await snapshotOf(input);
            const waiting = prior.work.find((row) => row.id === input.taskId)!;
            assert.equal(github.preservationRequests.length, 1);
            assert.equal(waiting.nextStep, "work");
            assert.equal(waiting.wait?.reason, "unavailable");
            assert.equal(
              waiting.counters.stalled,
              (original.counters.stalled ?? 0) + 1,
            );
            assert.deepEqual(waiting.intent, original.intent);
            assert.deepEqual(waiting.target, original.target);
            assert.deepEqual(prior.reservations, start.reservations);
            assert.equal(
              m.transition.validateRepairTransition(start, prior),
              null,
            );
            await assertGen78Parses(prior);
          },
          afterRestore: async (input) => {
            const prior = seen.prior;
            assert(prior !== null);
            const restored = await snapshotOf(input);
            await assertGen78Parses(restored);
            assert.equal(
              m.transition.validateRepairTransition(prior, restored),
              null,
            );
            await publishesUnderGen78(m, input, restored);
          },
        });
      } finally {
        await dispose();
      }
    },
  });
}
