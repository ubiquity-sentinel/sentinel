import assert from "node:assert/strict";
import { DenoGitRunner } from "../../src/state/mod.ts";
import type { GitRunnerV1 } from "../../src/state/mod.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  RepairHistoryCache,
  StateTreeMemo,
} from "../../src/state/state-repair-history-cache.ts";
import {
  appliedHead,
  makeCtx,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";
import { SHA3, T0, workRecord } from "./helpers.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("parallel read did not progress")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("repair history cache: both tree completion orders retain exact validated results", async (test) => {
  for (const held of ["current", "historical"] as const) {
    await test.step(held, async () => {
      const { ctx, parent, head: historical } = await fixture(
        "history-order-" + held,
      );
      const oldRead = StateTreeMemo.prototype.read;
      const oldPut = StateTreeMemo.prototype.put;
      const release = deferred(), entered = deferred(), otherDone = deferred();
      let operation:
        | ReturnType<ReturnType<typeof storeAt>["readRepairAt"]>
        | undefined;
      try {
        const writer = storeAt(ctx, "third-writer", "repair");
        const head = appliedHead(
          await writer.writeRepair(
            repairSnapshot({
              stateHead: historical,
              sequence: 3,
              updatedAt: T0 + 3000,
              work: [workRecord("preserve-me")],
            }),
            historical,
          ),
        );
        let armed = false, currentManifest = "";
        const real = new DenoGitRunner(ctx.tmp + "/git-home");
        const runner: GitRunnerV1 = {
          async runGit(args, options) {
            if (armed && args[0] === "cat-file") {
              const isCurrent = new TextDecoder().decode(options.stdin)
                .includes(currentManifest);
              if ((held === "current") === isCurrent) {
                entered.resolve();
                await release.promise;
              }
            }
            const result = await real.runGit(args, options);
            if (args[0] === "ls-tree" && args.at(-1) === head) {
              currentManifest = result.stdout.split("\n").find((l) =>
                l.endsWith("\tmanifest.json")
              )!.split(/\s+/)[2];
            }
            return result;
          },
        };
        const reader = storeAt(ctx, "reader", "repair", runner);
        assert(
          (await reader.readRepairAt({ commit: parent, expectedHead: head }))
            .ok,
        );
        const target = "repair:" + (held === "current" ? historical : head);
        StateTreeMemo.prototype.read = function (...args) {
          const result = oldRead.apply(this, args);
          if (armed && args[0] === target && result.status === "hit") {
            otherDone.resolve();
          }
          return result;
        };
        StateTreeMemo.prototype.put = function (...args) {
          oldPut.apply(this, args);
          if (armed && args[0] === target) otherDone.resolve();
        };
        armed = true;
        operation = reader.readRepairAt({
          commit: historical,
          expectedHead: head,
        });
        await bounded(entered.promise);
        await bounded(otherDone.promise);
        release.resolve();
        const result = await operation;
        assert(result.ok && result.value.status === "found");
        assert.equal(result.value.head, historical);
        assert.equal(result.value.snapshot.work[0].source.id, "preserve-me");
        await reader.readRepairAt({ commit: parent, expectedHead: SHA3 });
      } finally {
        release.resolve();
        await operation;
        StateTreeMemo.prototype.read = oldRead;
        StateTreeMemo.prototype.put = oldPut;
        await ctx.cleanup();
      }
    });
  }
});

Deno.test("repair history cache: concurrent failures settle before eviction in deterministic order", async (test) => {
  for (const precedence of ["current", "ancestry", "historical"] as const) {
    await test.step(precedence, async () => {
      const { ctx, parent, head } = await fixture(
        "history-failure-" + precedence,
      );
      const release = deferred(), entered = deferred();
      let operation:
        | ReturnType<ReturnType<typeof storeAt>["readRepairAt"]>
        | undefined;
      try {
        const real = new DenoGitRunner(ctx.tmp + "/git-home");
        let armed = false, currentManifest = "", directory = "";
        const runner: GitRunnerV1 = {
          async runGit(args, options) {
            directory = options.cwd;
            const result = await real.runGit(args, options);
            if (args[0] === "ls-tree" && args.at(-1) === head) {
              currentManifest = result.stdout.split("\n").find((l) =>
                l.endsWith("\tmanifest.json")
              )!.split(/\s+/)[2];
            }
            if (!armed) return result;
            if (args[0] === "merge-base" && precedence !== "historical") {
              return { ...result, ok: false, code: 1 };
            }
            if (args[0] === "cat-file") {
              const isCurrent = new TextDecoder().decode(options.stdin)
                .includes(currentManifest);
              if (isCurrent && precedence === "current") {
                return { ...result, stdoutBytes: new Uint8Array([0]) };
              }
              if (!isCurrent) {
                entered.resolve();
                await release.promise;
                return { ...result, ok: false, code: 1 };
              }
            }
            return result;
          },
        };
        const reader = storeAt(ctx, "reader", "repair", runner);
        assert(
          (await reader.readRepairAt({ commit: parent, expectedHead: head }))
            .ok,
        );
        armed = true;
        let settled = false;
        operation = reader.readRepairAt({ commit: parent, expectedHead: head });
        void operation.then(() => settled = true);
        await bounded(entered.promise);
        assert.equal(settled, false);
        assert((await Deno.stat(directory)).isDirectory);
        release.resolve();
        const result = await operation;
        assert(!result.ok);
        const expected = precedence === "current"
          ? "validated state tree bytes changed"
          : precedence === "ancestry"
          ? "historical repair commit is missing or not an ancestor"
          : "cat-file";
        assert(result.error.detail.includes(expected), result.error.detail);
        assert.equal(
          await Deno.stat(directory).then(() => true, () => false),
          false,
        );
      } finally {
        release.resolve();
        await operation;
        await ctx.cleanup();
      }
    });
  }
});

Deno.test("repair history cache: normal process exit removes its private directory", async () => {
  const { ctx } = await fixture("history-cache-exit");
  try {
    const script = ctx.tmp + "/exit.ts";
    const helper =
      new URL("../../src/state/state-repair-history-cache.ts", import.meta.url)
        .href;
    const ports = new URL("../../src/contracts/ports.ts", import.meta.url).href;
    await Deno.writeTextFile(
      script,
      "import { RepairHistoryCache } from " + JSON.stringify(helper) + ";\n" +
        "import { portOk } from " + JSON.stringify(ports) + ";\n" +
        "await new RepairHistoryCache(" + JSON.stringify(ctx.tmp) +
        ").use('head', () => Promise.resolve(portOk(null)), op => { console.log(op.directory); return Promise.resolve(portOk(null)); });\n",
    );
    const child = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--frozen",
        "--allow-read=.",
        "--allow-write=" + ctx.tmp,
        script,
      ],
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(child.code, 0, new TextDecoder().decode(child.stderr));
    const directory = new TextDecoder().decode(child.stdout).trim();
    assert(directory.startsWith(ctx.tmp + "/repair-history-"));
    assert.equal(
      await Deno.stat(directory).then(() => true, () => false),
      false,
    );
  } finally {
    await ctx.cleanup();
  }
});

async function fixture(name: string) {
  const ctx = await makeCtx(name);
  const writer = storeAt(ctx, "writer", "repair");
  const first = repairSnapshot({ work: [workRecord("preserve-me")] });
  const parent = appliedHead(await writer.writeRepair(first, null));
  const snapshot = repairSnapshot({
    ...first,
    stateHead: parent,
    sequence: 2,
    updatedAt: T0 + 2000,
  });
  const head = appliedHead(await writer.writeRepair(snapshot, parent));
  return { ctx, parent, head };
}

Deno.test("repair history cache: one concurrent fetch, fresh checks and independent returned snapshots", async () => {
  const { ctx, parent, head } = await fixture("history-cache");
  try {
    const real = new DenoGitRunner(ctx.tmp + "/git-home");
    const commands: string[][] = [];
    const directories = new Set<string>();
    const runner: GitRunnerV1 = {
      async runGit(args, options) {
        commands.push([...args]);
        directories.add(options.cwd);
        return await real.runGit(args, options);
      },
    };
    const reader = storeAt(ctx, "reader", "repair", runner);
    const input = { commit: parent, expectedHead: head };
    const results = await Promise.all([
      reader.readRepairAt(input),
      reader.readRepairAt(input),
    ]);
    for (const result of results) {
      assert(result.ok && result.value.status === "found");
    }
    const first = results[0];
    assert(first.ok && first.value.status === "found");
    first.value.snapshot.work[0].source.id = "caller mutation";
    const next = await reader.readRepairAt(input);
    assert(next.ok && next.value.status === "found");
    assert.equal(next.value.snapshot.work[0].source.id, "preserve-me");
    assert.equal(commands.filter((a) => a[0] === "fetch").length, 1);
    assert.equal(commands.filter((a) => a[0] === "ls-remote").length, 6);
    assert.equal(directories.size, 1);
    const directory = [...directories][0];
    assert.equal((await Deno.stat(directory)).mode! & 0o777, 0o700);
    const rejected = await reader.readRepairAt({
      commit: parent,
      expectedHead: SHA3,
    });
    assert(!rejected.ok && rejected.error.kind === "conflict");
    assert.equal(
      await Deno.stat(directory).then(() => true, () => false),
      false,
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("repair history cache: head movement and complete raw-object failures refuse and evict", async (test) => {
  for (
    const scenario of [
      "entry",
      "end",
      "malformed",
      "missing",
      "corrupt",
      "ancestry",
    ] as const
  ) {
    await test.step(scenario, async () => {
      const { ctx, parent, head } = await fixture("history-cache-" + scenario);
      try {
        const real = new DenoGitRunner(ctx.tmp + "/git-home");
        let armed = false;
        let remoteReads = 0;
        const directories = new Set<string>();
        const runner: GitRunnerV1 = {
          async runGit(args, options) {
            directories.add(options.cwd);
            const result = await real.runGit(args, options);
            if (!armed) return result;
            if (args[0] === "ls-remote") {
              remoteReads++;
              if (
                (scenario === "entry" && remoteReads === 1) ||
                (scenario === "end" && remoteReads === 2)
              ) {
                return {
                  ...result,
                  stdout: SHA3 + "\trefs/heads/sentinel-state/repair\n",
                };
              }
            }
            if (scenario === "ancestry" && args[0] === "merge-base") {
              return { ...result, ok: false, code: 1 };
            }
            if (
              args[0] === "cat-file" &&
              ["missing", "corrupt", "malformed"].includes(scenario)
            ) {
              const bytes = result.stdoutBytes!.slice();
              if (scenario === "missing") {
                return {
                  ...result,
                  stdoutBytes: new TextEncoder().encode("missing\n"),
                };
              }
              if (scenario === "malformed") {
                const text = new TextDecoder().decode(bytes).replace(
                  '"version":"v1"',
                  '"version":"x1"',
                );
                return {
                  ...result,
                  stdoutBytes: new TextEncoder().encode(text),
                };
              }
              bytes[bytes.length - 2] ^= 1;
              return { ...result, stdoutBytes: bytes };
            }
            return result;
          },
        };
        const reader = storeAt(ctx, "reader", "repair", runner);
        const input = { commit: parent, expectedHead: head };
        if (scenario !== "malformed") {
          const warm = await reader.readRepairAt(input);
          assert(warm.ok);
        }
        armed = true;
        const result = await reader.readRepairAt(input);
        assert(!result.ok, scenario);
        for (const directory of directories) {
          assert.equal(
            await Deno.stat(directory).then(() => true, () => false),
            false,
          );
        }
      } finally {
        await ctx.cleanup();
      }
    });
  }
});

Deno.test("repair history cache: failed initialization, absolute expiry and oversized retention remove only owned directories", async () => {
  const { ctx } = await fixture("history-cache-lifetime");
  const savedNow = Date.now;
  let now = savedNow();
  Date.now = () => now;
  try {
    const unrelated = ctx.tmp + "/keep.txt";
    await Deno.writeTextFile(unrelated, "user-owned");
    const cache = new RepairHistoryCache(ctx.tmp);
    const paths: string[] = [];
    let oversized = false;
    const initialize = async (op: { directory: string }) => {
      paths.push(op.directory);
      if (oversized) {
        const file = await Deno.open(op.directory + "/large", {
          create: true,
          write: true,
        });
        await file.truncate(256 * 1024 * 1024 + 1);
        file.close();
      }
      return portOk(null);
    };
    const read = () => Promise.resolve(portOk("value"));
    assert((await cache.use("a", initialize, read)).ok);
    now += 120001;
    assert((await cache.use("a", initialize, read)).ok);
    assert.equal(paths.length, 2);
    assert.equal(
      await Deno.stat(paths[0]).then(() => true, () => false),
      false,
    );
    oversized = true;
    assert((await cache.use("b", initialize, read)).ok);
    assert.equal(
      await Deno.stat(paths.at(-1)!).then(() => true, () => false),
      false,
    );
    const failed = await cache.use("c", (op) => {
      paths.push(op.directory);
      return Promise.reject(new Error("initialization failed"));
    }, read);
    assert(!failed.ok);
    assert.equal(
      await Deno.stat(paths.at(-1)!).then(() => true, () => false),
      false,
    );
    assert.equal(await Deno.readTextFile(unrelated), "user-owned");
  } finally {
    Date.now = savedNow;
    await ctx.cleanup();
  }
});

Deno.test("state tree memo: exact bytes, two-entry bound, oversized bypass and cloned storage", () => {
  const memo = new StateTreeMemo();
  const proof = {
    parents: "parents",
    tree: "tree",
    bytes: new Uint8Array([1, 2, 3]),
  };
  const snapshot = repairSnapshot({ work: [workRecord("memo")] });
  memo.put("repair:a", proof, snapshot);
  snapshot.work[0].source.id = "mutated input";
  const read = memo.read("repair:a", proof);
  assert(
    read.status === "hit" && read.snapshot.kind === "repair_state_snapshot",
  );
  read.snapshot.work[0].source.id = "mutated return";
  const again = memo.read("repair:a", proof);
  assert(
    again.status === "hit" && again.snapshot.kind === "repair_state_snapshot",
  );
  assert.equal(again.snapshot.work[0].source.id, "memo");
  assert.equal(
    memo.read("repair:a", { ...proof, tree: "changed" }).status,
    "mismatch",
  );
  memo.put("repair:b", proof, snapshot);
  memo.put("repair:c", proof, snapshot);
  assert.equal(memo.read("repair:a", proof).status, "miss");
  memo.put("repair:large", {
    ...proof,
    bytes: new Uint8Array(8 * 1024 * 1024 + 1),
  }, snapshot);
  assert.equal(memo.read("repair:large", proof).status, "miss");
});
