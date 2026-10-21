import assert from "node:assert/strict";
import { DenoGitRunner, type GitRunnerV1 } from "../../src/state/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  appliedHead,
  githubCooldown,
  gitRunAt,
  makeCtx,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";
import { SHA3, T0, workRecord } from "./helpers.ts";

async function fixture(name: string) {
  const ctx = await makeCtx("latest-" + name);
  const writer = storeAt(ctx, "writer", "repair");
  const snapshot = repairSnapshot({ work: [workRecord("retained")] });
  const head = appliedHead(await writer.writeRepair(snapshot, null));
  return { ctx, writer, snapshot, head };
}

Deno.test("latest repair cache: concurrent fresh reads reuse objects and clone results while cooldowns and CAS stay fresh", async () => {
  const { ctx, writer, snapshot, head } = await fixture("reuse");
  try {
    const real = new DenoGitRunner(ctx.tmp + "/git-home");
    let fetches = 0, lookups = 0, setups = 0;
    const reader = storeAt(ctx, "reader", "repair", {
      runGit: async (args, options) => {
        if (args[0] === "fetch") fetches++;
        if (args[0] === "ls-remote") lookups++;
        if (args[0] === "init" || args[0] === "remote") setups++;
        return await real.runGit(args, options);
      },
    });
    const [a, b] = await Promise.all([
      reader.readRepair(),
      reader.readRepair(),
    ]);
    assert(a.ok && a.value.status === "found");
    assert(b.ok && b.value.status === "found");
    assert.equal(fetches, 1);
    assert(
      lookups >= 4,
      "each call retains independent fresh ref observations",
    );
    a.value.snapshot.work[0].blocker = {
      kind: "other",
      message: "caller mutation",
      since: T0,
    };
    assert.equal(b.value.snapshot.work[0].blocker, null);
    const priorLookups = lookups, priorSetups = setups;
    const c = await reader.readRepair();
    assert(c.ok && c.value.status === "found");
    assert.equal(c.value.snapshot.work[0].blocker, null);
    assert.equal(
      lookups - priorLookups,
      2,
      "warm observations remain fresh at entry and exit",
    );
    assert.equal(
      setups,
      priorSetups,
      "warm reads retain their prepared private cwd",
    );
    const next = repairSnapshot({
      ...snapshot,
      stateHead: head,
      sequence: 2,
      updatedAt: T0 + 2000,
      githubCooldowns: [githubCooldown(7, { retryNotBefore: T0 + 10_000 })],
    });
    const moved = appliedHead(await writer.writeRepair(next, head));
    const gate = new DurableGitHubCooldownGate({
      state: reader,
      clock: { now: () => T0 + 3000 },
    });
    const denied = await gate.beforeRequest(7);
    assert(!denied.ok && denied.error.kind === "rate_limited");
    assert.equal(
      fetches,
      2,
      "new head cannot reuse an earlier cooldown observation",
    );
    const stale = await reader.writeRepair(next, head);
    assert(stale.ok && stale.value.status === "conflict");
    const current = await reader.readRepair();
    assert(current.ok && current.value.status === "found");
    assert.equal(current.value.head, moved);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("latest repair cache: moved missing malformed and corrupt observations evict rather than reuse stale state", async (t) => {
  for (
    const scenario of [
      "entry",
      "exit",
      "absent",
      "duplicate",
      "missing",
      "corrupt",
      "truncated",
      "mode",
    ] as const
  ) {
    await t.step(scenario, async () => {
      const { ctx } = await fixture(scenario);
      const real = new DenoGitRunner(ctx.tmp + "/git-home");
      let armed = false, remoteReads = 0, fetches = 0;
      const retained = new Set<string>();
      const runner: GitRunnerV1 = {
        runGit: async (args, options) => {
          if (args[0] === "fetch") {
            fetches++;
            retained.add(options.cwd);
          }
          const result = await real.runGit(args, options);
          if (!armed) return result;
          if (args[0] === "ls-remote") {
            remoteReads++;
            if (
              (scenario === "entry" && remoteReads === 1) ||
              (scenario === "exit" && remoteReads === 2)
            ) {
              return {
                ...result,
                stdout: `${SHA3}\trefs/heads/sentinel-state/repair\n`,
              };
            }
            if (scenario === "absent") return { ...result, stdout: "" };
            if (scenario === "duplicate") {
              return { ...result, stdout: result.stdout + result.stdout };
            }
          }
          if (args[0] === "ls-tree" && scenario === "mode") {
            return {
              ...result,
              stdout: result.stdout.replace("100644", "100755"),
            };
          }
          if (args[0] === "cat-file" && result.stdoutBytes) {
            const bytes = result.stdoutBytes.slice();
            if (scenario === "missing") {
              return {
                ...result,
                stdoutBytes: new TextEncoder().encode("missing\n"),
              };
            }
            if (scenario === "truncated") {
              return { ...result, stdoutBytes: bytes.slice(0, -2) };
            }
            if (scenario === "corrupt") {
              bytes[bytes.length - 2] ^= 1;
              return { ...result, stdoutBytes: bytes };
            }
          }
          return result;
        },
      };
      try {
        const reader = storeAt(ctx, "reader", "repair", runner);
        assert((await reader.readRepair()).ok);
        armed = true;
        const observed = await reader.readRepair();
        if (scenario === "absent") {
          assert(observed.ok && observed.value.status === "absent");
        } else assert(!observed.ok, scenario);
        for (const directory of retained) {
          assert.equal(
            await Deno.stat(directory).then(() => true, () => false),
            false,
            scenario,
          );
        }
        const beforeRecovery = fetches;
        armed = false;
        assert((await reader.readRepair()).ok);
        assert.equal(
          fetches,
          beforeRecovery + 1,
          "recovery initializes a new private repository after eviction",
        );
      } finally {
        await ctx.cleanup();
      }
    });
  }
});

Deno.test("latest repair cache: actual remote movement and deletion cannot preserve a cached head", async () => {
  const { ctx, writer, snapshot, head } = await fixture("movement");
  try {
    const reader = storeAt(ctx, "reader", "repair");
    assert((await reader.readRepair()).ok);
    const next = repairSnapshot({
      ...snapshot,
      stateHead: head,
      sequence: 2,
      updatedAt: T0 + 2000,
    });
    const moved = appliedHead(await writer.writeRepair(next, head));
    const fresh = await reader.readRepair();
    assert(fresh.ok && fresh.value.status === "found");
    assert.equal(fresh.value.head, moved);
    assert(
      (await gitRunAt(ctx, [
        "--git-dir",
        ctx.bare,
        "update-ref",
        "-d",
        "refs/heads/sentinel-state/repair",
      ])).ok,
    );
    const absent = await reader.readRepair();
    assert(absent.ok && absent.value.status === "absent");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("latest repair cache: failure expiry and bounded cleanup preserve unrelated scratch", async () => {
  const { ctx } = await fixture("lifetime");
  const savedNow = Date.now;
  let now = savedNow(), fail = true;
  const real = new DenoGitRunner(ctx.tmp + "/git-home");
  const retained: string[] = [];
  Date.now = () => now;
  try {
    const unrelated = ctx.tmp + "/keep.txt";
    await Deno.writeTextFile(unrelated, "keep");
    const reader = storeAt(ctx, "reader", "repair", {
      runGit: async (args, options) => {
        if (args[0] === "fetch") {
          retained.push(options.cwd);
          if (fail) return { ok: false, code: 1, stdout: "", stderr: "" };
        }
        return await real.runGit(args, options);
      },
    });
    assert(!(await reader.readRepair()).ok);
    assert.equal(
      await Deno.stat(retained[0]).then(() => true, () => false),
      false,
    );
    fail = false;
    assert((await reader.readRepair()).ok);
    now += 120_001;
    assert((await reader.readRepair()).ok);
    assert.equal(retained.length, 3);
    assert.equal(
      await Deno.stat(retained[1]).then(() => true, () => false),
      false,
    );
    assert.equal(await Deno.readTextFile(unrelated), "keep");
  } finally {
    Date.now = savedNow;
    await ctx.cleanup();
  }
});

Deno.test("latest repair cache: absent scratch-read permission preserves original uncached Git reads", async () => {
  const { ctx } = await fixture("permissions");
  try {
    // The subprocess has no filesystem read grant; its real Git child still
    // performs the original complete state reads, without asking for access.
    const module = new URL("../../src/state/mod.ts", import.meta.url).href;
    const source = `import { GitStateStore } from ${JSON.stringify(module)};
      const s=new GitStateStore({role:"repair",scratchDir:${
      JSON.stringify(ctx.tmp + "/restricted")
    },remoteUrl:${JSON.stringify(ctx.remoteUrl)}});
      const a=await s.readRepair(), b=await s.readRepair();
      if(!a.ok||a.value.status!=="found"||!b.ok||b.value.status!=="found"||a.value.head!==b.value.head)Deno.exit(1);`;
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-check",
        "--frozen",
        "--allow-write",
        "--allow-run",
        "--allow-env=PATH",
        "-",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const input = result.stdin.getWriter();
    await input.write(new TextEncoder().encode(source));
    await input.close();
    const output = await result.output();
    assert.equal(output.code, 0, new TextDecoder().decode(output.stderr));
  } finally {
    await ctx.cleanup();
  }
});
