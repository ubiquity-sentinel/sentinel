import assert from "node:assert/strict";
import { DenoGitRunner } from "../../src/state/mod.ts";
import type { GitRunnerV1 } from "../../src/state/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  appliedHead,
  makeCtx,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";
import { SHA3, T0, workRecord } from "./helpers.ts";

async function fixture(name: string) {
  const ctx = await makeCtx(name);
  const writer = storeAt(ctx, "writer", "repair");
  const first = repairSnapshot({
    work: [workRecord("target"), workRecord("unrelated")],
  });
  const parent = appliedHead(await writer.writeRepair(first, null));
  const current = repairSnapshot({
    ...first,
    stateHead: parent,
    sequence: 2,
    updatedAt: T0 + 2000,
  });
  const head = appliedHead(await writer.writeRepair(current, parent));
  return { ctx, writer, first, current, parent, head };
}

Deno.test("repair view: one complete fetch, local strict ancestors, clones and owned cleanup", async () => {
  const f = await fixture("repair-view");
  try {
    const real = new DenoGitRunner(f.ctx.tmp + "/git-home");
    const commands: string[][] = [];
    let directory = "", orphan = SHA3;
    const runner: GitRunnerV1 = {
      async runGit(args, options) {
        commands.push([...args]);
        directory = options.cwd;
        const result = await real.runGit(args, options);
        if (args[0] === "fetch" && result.ok) {
          const tree = await real.runGit([
            "hash-object",
            "-t",
            "tree",
            "--stdin",
            "-w",
          ], { ...options, stdin: new Uint8Array() });
          assert(tree.ok);
          const raw = "tree " + tree.stdout.trim() +
            "\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\norphan\n";
          const commit = await real.runGit([
            "hash-object",
            "-t",
            "commit",
            "--stdin",
            "-w",
          ], { ...options, stdin: new TextEncoder().encode(raw) });
          assert(commit.ok);
          orphan = commit.stdout.trim() as GitSha;
        }
        return result;
      },
    };
    const reader = storeAt(f.ctx, "reader", "repair", runner);
    const opened = await reader.openRepairHistory({ expectedHead: f.head });
    assert(opened.ok);
    const view = opened.value;
    try {
      const one = await view.readAt(f.parent);
      assert(one.ok && one.value.status === "found");
      one.value.snapshot.work[0].source.id = "caller mutation";
      const again = await view.readAt(f.parent);
      assert(again.ok && again.value.status === "found");
      assert.deepEqual(again.value.snapshot, f.first);
      assert(
        !(await view.readAt(orphan)).ok,
        "real local nonancestor commit is refused",
      );
      assert(!(await view.readAt(SHA3)).ok, "missing commit is refused");
      assert.equal(commands.filter((a) => a[0] === "fetch").length, 1);
      assert.equal(commands.filter((a) => a[0] === "ls-remote").length, 1);
      assert.equal((await Deno.stat(directory)).mode! & 0o777, 0o700);
    } finally {
      await view.close();
    }
    await view.close();
    assert(!(await view.readAt(f.parent)).ok);
    assert.equal(
      await Deno.stat(directory).then(() => true, () => false),
      false,
    );
  } finally {
    await f.ctx.cleanup();
  }
});

Deno.test("repair view: initial movement and unrelated current/historical corruption refuse", async (test) => {
  for (
    const scenario of [
      "moved",
      "initial-corrupt",
      "historical-corrupt",
      "initialize-error",
    ] as const
  ) {
    await test.step(scenario, async () => {
      const f = await fixture("repair-view-" + scenario);
      let directory = "", corrupt = scenario === "initial-corrupt";
      try {
        if (scenario === "moved") {
          await f.writer.writeRepair({
            ...f.current,
            stateHead: f.head,
            sequence: 3,
            updatedAt: T0 + 3000,
          }, f.head);
        }
        const real = new DenoGitRunner(f.ctx.tmp + "/git-home");
        const runner: GitRunnerV1 = {
          async runGit(args, options) {
            directory = options.cwd;
            if (scenario === "initialize-error" && args[0] === "fetch") {
              throw new Error("fixture transport failure");
            }
            const result = await real.runGit(args, options);
            if (corrupt && args[0] === "cat-file") {
              const raw = new TextDecoder().decode(result.stdoutBytes);
              const changed = raw.replace(
                '"source":{"id":"unrelated","kind":"issue"',
                '"source":{"id":"unrelated","kind":"wrong"',
              );
              assert.notEqual(changed, raw);
              return {
                ...result,
                stdoutBytes: new TextEncoder().encode(changed),
              };
            }
            return result;
          },
        };
        const opened = await storeAt(f.ctx, "reader", "repair", runner)
          .openRepairHistory({ expectedHead: f.head });
        if (scenario === "historical-corrupt") {
          assert(opened.ok);
          corrupt = true;
          try {
            assert(!(await opened.value.readAt(f.parent)).ok);
          } finally {
            await opened.value.close();
          }
        } else assert(!opened.ok);
        assert.equal(
          await Deno.stat(directory).then(() => true, () => false),
          false,
        );
      } finally {
        await f.ctx.cleanup();
      }
    });
  }
});

Deno.test("repair view: close settles active reads and preserves unrelated scratch", async () => {
  const f = await fixture("repair-view-close");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((done) => release = done);
  const started = new Promise<void>((done) => entered = done);
  try {
    const keep = f.ctx.tmp + "/keep";
    await Deno.writeTextFile(keep, "owned elsewhere");
    const real = new DenoGitRunner(f.ctx.tmp + "/git-home");
    let armed = false, directory = "";
    const runner: GitRunnerV1 = {
      async runGit(args, options) {
        directory = options.cwd;
        if (armed && args[0] === "merge-base") {
          entered();
          await gate;
        }
        return await real.runGit(args, options);
      },
    };
    const opened = await storeAt(f.ctx, "reader", "repair", runner)
      .openRepairHistory({ expectedHead: f.head });
    assert(opened.ok);
    armed = true;
    const reading = opened.value.readAt(f.parent);
    await started;
    let closed = false;
    const closing = opened.value.close().then(() => closed = true);
    assert(!(await opened.value.readAt(f.parent)).ok);
    assert.equal(closed, false);
    assert((await Deno.stat(directory)).isDirectory);
    release();
    const result = await reading;
    await closing;
    assert(result.ok);
    assert.equal(
      await Deno.stat(directory).then(() => true, () => false),
      false,
    );
    assert.equal(await Deno.readTextFile(keep), "owned elsewhere");
  } finally {
    release();
    await f.ctx.cleanup();
  }
});
