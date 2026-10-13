// Restore the exact bounded-history scenario from fc98bb376146496f76281203bcdeca8961f6d859.
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  DenoGitRunner,
  RELEASE_STATE_REF,
  REPAIR_STATE_REF,
} from "../../src/state/mod.ts";
import type { GitRunnerV1 } from "../../src/state/mod.ts";
import { releaseRecord, SHA1, T0, workRecord } from "./helpers.ts";
import {
  appliedHead,
  githubCooldown,
  makeCtx,
  releaseSnapshot,
  remoteHead,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";

Deno.test("state scale: latest reads and CAS writes bound history and blob processes while historical witnesses remain complete", async () => {
  const ctx = await makeCtx("bounded-io");
  try {
    const cooldowns = Array.from(
      { length: 130 },
      (_, i) => githubCooldown(i + 1),
    );
    const writer = storeAt(ctx, "seed", "repair");
    const history: { head: GitSha; snapshot: RepairStateSnapshotV1 }[] = [];
    let head: GitSha | null = null;
    for (let sequence = 1; sequence <= 8; sequence++) {
      const snapshot = repairSnapshot({
        stateHead: head,
        sequence,
        updatedAt: T0 + sequence * 1000,
        githubCooldowns: cooldowns,
        work: [workRecord("bounded-io", {
          source: {
            kind: "issue",
            id: "bounded-io\nembedded newline",
            revision: SHA1,
          },
        })],
      });
      head = appliedHead(await writer.writeRepair(snapshot, head));
      history.push({ head, snapshot });
    }

    const real = new DenoGitRunner(`${ctx.tmp}/git-home`);
    const commands: string[][] = [];
    const fetchedCommitCounts: number[] = [];
    const runner: GitRunnerV1 = {
      async runGit(args, opts) {
        commands.push([...args]);
        const result = await real.runGit(args, opts);
        if (args[0] === "fetch" && result.ok) {
          const count = await real.runGit(
            ["rev-list", "--count", "FETCH_HEAD"],
            opts,
          );
          assert(count.ok);
          fetchedCommitCounts.push(Number(count.stdout.trim()));
        }
        return result;
      },
    };
    const reader = storeAt(ctx, "bounded-reader", "repair", runner);
    const current = history.at(-1)!;
    const latest = await reader.readRepair();
    assert(latest.ok && latest.value.status === "found");
    assert.equal(latest.value.head, current.head);
    assert.equal(latest.value.snapshot.stateHead, history.at(-2)!.head);
    assert.equal(latest.value.snapshot.githubCooldowns.length, 130);
    assert.deepEqual(
      fetchedCommitCounts,
      [2],
      "a fresh latest-state operation must not download the complete history",
    );
    const blobCommands = commands.filter((args) =>
      args[0] === "show" || args[0] === "cat-file"
    );
    assert(
      blobCommands.length <= 4,
      "a snapshot must not spawn one Git process per record",
    );
    for (const args of blobCommands.filter((args) => args[0] === "show")) {
      assert(args.includes("--no-ext-diff") && args.includes("--no-textconv"));
    }

    const historical = await reader.readRepairAt({
      commit: history[2]!.head,
      expectedHead: current.head,
    });
    assert(historical.ok && historical.value.status === "found");
    assert.equal(historical.value.snapshot.stateHead, history[1]!.head);
    assert.equal(historical.value.snapshot.sequence, 3);
    assert.deepEqual(
      fetchedCommitCounts,
      [2, 8],
      "an exact historical witness must retain complete ancestry",
    );

    const next = repairSnapshot({
      ...latest.value.snapshot,
      stateHead: current.head,
      sequence: 9,
      updatedAt: T0 + 9000,
    });
    const nextHead = appliedHead(await reader.writeRepair(next, current.head));
    assert.deepEqual(fetchedCommitCounts, [2, 8, 2]);
    assert.equal(await remoteHead(ctx, REPAIR_STATE_REF), nextHead);
    const stale = await reader.writeRepair(next, current.head);
    assert(stale.ok && stale.value.status === "conflict");
    assert.equal(stale.value.currentHead, nextHead);
    assert.equal(await remoteHead(ctx, REPAIR_STATE_REF), nextHead);
    for (const args of commands.filter((args) => args[0] === "push")) {
      assert(
        !args.some((arg) => arg.startsWith("--force") || arg.startsWith("+")),
      );
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state history: latest release reads retain the parent while historical witnesses fetch complete ancestry", async () => {
  const ctx = await makeCtx("release-depth");
  try {
    const writer = storeAt(ctx, "release-writer", "release");
    const history: GitSha[] = [];
    let head: GitSha | null = null;
    for (let sequence = 1; sequence <= 5; sequence++) {
      head = appliedHead(
        await writer.writeRelease(
          releaseSnapshot({
            stateHead: head,
            sequence,
            updatedAt: T0 + sequence * 1000,
            releases: [releaseRecord("release-depth")],
          }),
          head,
        ),
      );
      history.push(head);
    }
    const real = new DenoGitRunner(`${ctx.tmp}/git-home`);
    const fetchedCommitCounts: number[] = [];
    const runner: GitRunnerV1 = {
      async runGit(args, options) {
        const result = await real.runGit(args, options);
        if (args[0] === "fetch" && result.ok) {
          const count = await real.runGit(
            ["rev-list", "--count", "FETCH_HEAD"],
            options,
          );
          assert(count.ok);
          fetchedCommitCounts.push(Number(count.stdout.trim()));
        }
        return result;
      },
    };
    const reader = storeAt(ctx, "release-reader", "repair", runner);
    const latest = await reader.readRelease();
    assert(latest.ok && latest.value.status === "found");
    assert.equal(latest.value.head, head);
    assert.equal(latest.value.snapshot.stateHead, history[3]);
    assert.deepEqual(fetchedCommitCounts, [2]);
    const historical = await reader.readReleaseAt({
      commit: history[1],
      expectedHead: history[4],
    });
    assert(historical.ok && historical.value.status === "found");
    assert.equal(historical.value.snapshot.stateHead, history[0]);
    assert.equal(historical.value.snapshot.sequence, 2);
    assert.deepEqual(fetchedCommitCounts, [2, 5]);
    assert.equal(await remoteHead(ctx, RELEASE_STATE_REF), head);
  } finally {
    await ctx.cleanup();
  }
});
