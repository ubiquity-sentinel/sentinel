import assert from "node:assert/strict";
import { recordAttemptSuccessV1 } from "../../src/contracts/attempt-memory.ts";
import { repositoryRegressionFactsV1 } from "../../src/repair/attempt-policy.ts";
import { buildMemoryLessonsV1 } from "../../src/repair/memory-lessons.ts";
import { REPO, SHA1, SHA2, SHA3, T0 } from "./helpers.ts";
import {
  appliedHead,
  attemptMemory,
  makeCtx,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";

Deno.test("memory success history: real Git consumer preserves established success provenance", async (test) => {
  const ctx = await makeCtx("success-provenance");
  try {
    const store = storeAt(ctx, "writer", "repair");
    const remembered = {
      ...attemptMemory(),
      successes: 1,
      lastSuccessAtMs: T0 - 1000,
      lastSuccessRevision: SHA1,
    };
    const initial = repairSnapshot({ attemptMemory: [remembered] });
    initial.lessons = await buildMemoryLessonsV1(initial, T0 + 1000);
    const head = appliedHead(await store.writeRepair(initial, null));
    assert.equal(repositoryRegressionFactsV1(initial, REPO, SHA2).length, 1);
    assert.equal(initial.lessons[0].entries[0].regression, true);

    const mutations = [
      {
        name: "erase both pointers at unchanged success count",
        memory: {
          ...remembered,
          lastSuccessAtMs: null,
          lastSuccessRevision: null,
        },
      },
      {
        name: "erase only the recorded time",
        memory: { ...remembered, lastSuccessAtMs: null },
      },
      {
        name: "replace the recorded runtime revision without another success",
        memory: { ...remembered, lastSuccessRevision: SHA3 },
      },
      {
        name: "advance the recorded time without another success",
        memory: { ...remembered, lastSuccessAtMs: T0 + 2000 },
      },
      {
        name: "erase the runtime revision while increasing the success count",
        memory: {
          ...remembered,
          successes: 2,
          lastSuccessAtMs: T0 + 2000,
          lastSuccessRevision: null,
        },
      },
      {
        name: "erase the recorded time while increasing the success count",
        memory: {
          ...remembered,
          successes: 2,
          lastSuccessAtMs: null,
          lastSuccessRevision: SHA2,
        },
      },
      {
        name: "move the recorded time backward while increasing the count",
        memory: {
          ...remembered,
          successes: 2,
          lastSuccessAtMs: T0 - 2000,
          lastSuccessRevision: SHA2,
        },
      },
    ];
    for (const mutation of mutations) {
      await test.step(mutation.name, async () => {
        const next = repairSnapshot({
          stateHead: head,
          sequence: 2,
          updatedAt: T0 + 2000,
          attemptMemory: [mutation.memory],
        });
        next.lessons = await buildMemoryLessonsV1(next, T0 + 2000);
        const written = await store.writeRepair(next, head);
        assert.equal(
          written.ok,
          false,
          "success provenance must survive the production Git transition",
        );
        if (!written.ok) assert.equal(written.error.kind, "invalid");
        const read = await storeAt(ctx, "fresh-reader", "repair").readRepair();
        assert(read.ok && read.value.status === "found");
        assert.equal(read.value.head, head);
        assert.deepEqual(read.value.snapshot.attemptMemory, [remembered]);
        assert.equal(
          repositoryRegressionFactsV1(read.value.snapshot, REPO, SHA2).length,
          1,
        );
        assert.equal(
          read.value.snapshot.lessons[0].entries[0].regression,
          true,
        );
      });
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("memory success history: another success advances current provenance and preserves the historical witness", async () => {
  const ctx = await makeCtx("success-advance");
  try {
    const store = storeAt(ctx, "writer", "repair");
    const remembered = {
      ...attemptMemory(),
      successes: 1,
      lastSuccessAtMs: T0 - 1000,
      lastSuccessRevision: SHA1,
    };
    const head = appliedHead(
      await store.writeRepair(
        repairSnapshot({ attemptMemory: [remembered] }),
        null,
      ),
    );
    const nextSuccess = recordAttemptSuccessV1(remembered, T0 + 2000, SHA2);
    const next = repairSnapshot({
      stateHead: head,
      sequence: 2,
      updatedAt: T0 + 2000,
      attemptMemory: [nextSuccess],
    });
    next.lessons = await buildMemoryLessonsV1(next, T0 + 2000);
    const current = appliedHead(await store.writeRepair(next, head));
    const reader = storeAt(ctx, "fresh-reader", "repair");
    const read = await reader.readRepair();
    assert(read.ok && read.value.status === "found");
    assert.equal(read.value.head, current);
    assert.deepEqual(read.value.snapshot.attemptMemory, [nextSuccess]);
    assert.equal(nextSuccess.successes, 2);
    assert.equal(
      repositoryRegressionFactsV1(read.value.snapshot, REPO, SHA2).length,
      0,
    );
    const historical = await reader.readRepairAt({
      commit: head,
      expectedHead: current,
    });
    assert(historical.ok && historical.value.status === "found");
    assert.deepEqual(historical.value.snapshot.attemptMemory, [remembered]);
    assert.equal(
      repositoryRegressionFactsV1(historical.value.snapshot, REPO, SHA2).length,
      1,
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("memory success history: legacy optional and nullable provenance retain their migration paths", async (test) => {
  for (const counted of [false, true]) {
    await test.step(
      counted
        ? "fill unknown counted provenance"
        : "record first success from the exact legacy shape",
      async () => {
        const ctx = await makeCtx(`success-legacy-${counted}`);
        try {
          const store = storeAt(ctx, "writer", "repair");
          const legacy = counted
            ? {
              ...attemptMemory(),
              successes: 1,
              lastSuccessAtMs: null,
              lastSuccessRevision: null,
            }
            : attemptMemory();
          const head = appliedHead(
            await store.writeRepair(
              repairSnapshot({ attemptMemory: [legacy] }),
              null,
            ),
          );
          const unchanged = repairSnapshot({
            stateHead: head,
            sequence: 2,
            updatedAt: T0 + 2000,
            attemptMemory: [legacy],
          });
          const unchangedHead = appliedHead(
            await store.writeRepair(unchanged, head),
          );
          const read = await storeAt(ctx, "legacy-reader", "repair")
            .readRepair();
          assert(read.ok && read.value.status === "found");
          assert.deepEqual(read.value.snapshot.attemptMemory, [legacy]);
          if (!counted) {
            assert.equal(
              Object.hasOwn(read.value.snapshot.attemptMemory[0], "successes"),
              false,
            );
            assert.equal(
              Object.hasOwn(
                read.value.snapshot.attemptMemory[0],
                "lastSuccessAtMs",
              ),
              false,
            );
            assert.equal(
              Object.hasOwn(
                read.value.snapshot.attemptMemory[0],
                "lastSuccessRevision",
              ),
              false,
            );
          }
          const migrated = counted
            ? {
              ...legacy,
              lastSuccessAtMs: T0 - 1000,
              lastSuccessRevision: SHA1,
            }
            : recordAttemptSuccessV1(legacy, T0 + 3000, SHA1);
          const next = repairSnapshot({
            stateHead: unchangedHead,
            sequence: 3,
            updatedAt: T0 + 3000,
            attemptMemory: [migrated],
          });
          const migratedHead = appliedHead(
            await store.writeRepair(next, unchangedHead),
          );
          const after = await storeAt(ctx, "migrated-reader", "repair")
            .readRepair();
          assert(after.ok && after.value.status === "found");
          assert.equal(after.value.head, migratedHead);
          assert.deepEqual(after.value.snapshot.attemptMemory, [migrated]);
          assert.equal(after.value.snapshot.attemptMemory[0].successes, 1);
        } finally {
          await ctx.cleanup();
        }
      },
    );
  }
});
