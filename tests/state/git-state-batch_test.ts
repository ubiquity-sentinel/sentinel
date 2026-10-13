import assert from "node:assert/strict";
import { DenoGitRunner } from "../../src/state/mod.ts";
import {
  appliedHead,
  makeCtx,
  releaseSnapshot,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";
import { releaseRecord, SHA1, workRecord } from "./helpers.ts";

Deno.test("state batch: one blob process reads a multi-record repair snapshot", async () => {
  const ctx = await makeCtx("batch-count");
  try {
    const snapshot = repairSnapshot({
      work: Array.from(
        { length: 5 },
        (_, index) => workRecord(`work:${index}`),
      ),
    });
    appliedHead(
      await storeAt(ctx, "writer", "repair").writeRepair(snapshot, null),
    );
    const calls: string[][] = [];
    const real = new DenoGitRunner(`${ctx.tmp}/git-home`);
    const reader = storeAt(ctx, "reader", "repair", {
      runGit: (args, options) => {
        if (args[0] === "cat-file") calls.push([...args]);
        return real.runGit(args, options);
      },
    });
    const read = await reader.readRepair();
    assert(read.ok && read.value.status === "found");
    assert.deepEqual(read.value.snapshot, snapshot);
    assert.equal(
      calls.length,
      1,
      "snapshot blob process count must not grow with records",
    );
    assert.deepEqual(calls[0], ["cat-file", "--batch"]);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state batch: multibyte repair and release snapshots roundtrip through forwarded byte options", async () => {
  const ctx = await makeCtx("batch-unicode");
  try {
    // 1,701 object ids exceed 64 KiB of stdin while the real Git output is
    // larger still, exercising simultaneous input/output pipe drainage.
    const repair = repairSnapshot({
      work: Array.from(
        { length: 1700 },
        (_, index) =>
          workRecord(`work:${String(index).padStart(4, "0")}`, {
            source: { kind: "issue", id: `任务:é:🚀:${index}`, revision: SHA1 },
          }),
      ),
    });
    const release = releaseSnapshot({
      releases: [releaseRecord("release:é:🚀"), releaseRecord("release:漢字")],
    });
    appliedHead(
      await storeAt(ctx, "repair-writer", "repair").writeRepair(repair, null),
    );
    appliedHead(
      await storeAt(ctx, "release-writer", "release").writeRelease(
        release,
        null,
      ),
    );
    const real = new DenoGitRunner(`${ctx.tmp}/git-home`);
    const inputs: number[] = [];
    const reader = storeAt(ctx, "unicode-reader", "repair", {
      runGit: (args, options) => {
        if (args[0] === "cat-file") {
          assert(options.stdin instanceof Uint8Array);
          assert.equal(options.rawOutput, true);
          inputs.push(options.stdin.length);
        }
        return real.runGit(args, options);
      },
    });
    const repairRead = await reader.readRepair();
    assert(repairRead.ok && repairRead.value.status === "found");
    assert.deepEqual(repairRead.value.snapshot, repair);
    const releaseRead = await reader.readRelease();
    assert(releaseRead.ok && releaseRead.value.status === "found");
    assert.deepEqual(releaseRead.value.snapshot, release);
    assert.equal(inputs.length, 2);
    assert(inputs[0] > 65536);
  } finally {
    await ctx.cleanup();
  }
});

function joinBytes(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Locate the first authentic Git-generated frame only to inject corruption. */
function firstFrame(bytes: Uint8Array) {
  const newline = bytes.indexOf(10);
  const [sha, , lengthText] = new TextDecoder().decode(
    bytes.subarray(0, newline),
  ).split(" ");
  const length = Number(lengthText);
  return { sha, length, start: newline + 1, end: newline + 1 + length };
}

function withHeader(bytes: Uint8Array, header: string): Uint8Array {
  return joinBytes(
    new TextEncoder().encode(`${header}\n`),
    bytes.subarray(firstFrame(bytes).start),
  );
}

Deno.test("state batch: malformed frames fail closed through the real repair consumer", async (t) => {
  const ctx = await makeCtx("batch-invalid");
  try {
    appliedHead(
      await storeAt(ctx, "writer", "repair").writeRepair(
        repairSnapshot({
          work: [workRecord("work:1"), workRecord("work:2")],
        }),
        null,
      ),
    );
    const real = new DenoGitRunner(`${ctx.tmp}/git-home`);
    const mutations: {
      name: string;
      expected?: "unavailable";
      mutate(bytes: Uint8Array): Uint8Array;
    }[] = [
      { name: "empty output", mutate: () => new Uint8Array() },
      {
        name: "missing object",
        expected: "unavailable",
        mutate: (bytes) =>
          new TextEncoder().encode(`${firstFrame(bytes).sha} missing\n`),
      },
      {
        name: "truncated header",
        mutate: (bytes) => bytes.subarray(0, firstFrame(bytes).start - 1),
      },
      {
        name: "malformed header",
        mutate: (bytes) => withHeader(bytes, "not a batch frame"),
      },
      {
        name: "wrong object id",
        mutate: (bytes) =>
          withHeader(
            bytes,
            `${"0".repeat(40)} blob ${firstFrame(bytes).length}`,
          ),
      },
      {
        name: "wrong object type",
        mutate: (bytes) =>
          withHeader(
            bytes,
            `${firstFrame(bytes).sha} tree ${firstFrame(bytes).length}`,
          ),
      },
      {
        name: "negative length",
        mutate: (bytes) =>
          withHeader(bytes, `${firstFrame(bytes).sha} blob -1`),
      },
      {
        name: "unsafe length",
        mutate: (bytes) =>
          withHeader(bytes, `${firstFrame(bytes).sha} blob 9007199254740992`),
      },
      {
        name: "noncanonical length",
        mutate: (bytes) =>
          withHeader(
            bytes,
            `${firstFrame(bytes).sha} blob 0${firstFrame(bytes).length}`,
          ),
      },
      {
        name: "short declared length",
        mutate: (bytes) =>
          withHeader(
            bytes,
            `${firstFrame(bytes).sha} blob ${firstFrame(bytes).length - 1}`,
          ),
      },
      {
        name: "long declared length",
        mutate: (bytes) =>
          withHeader(
            bytes,
            `${firstFrame(bytes).sha} blob ${firstFrame(bytes).length + 1}`,
          ),
      },
      {
        name: "truncated payload",
        mutate: (bytes) => bytes.subarray(0, firstFrame(bytes).end - 1),
      },
      {
        name: "missing separator",
        mutate: (bytes) => bytes.subarray(0, bytes.length - 1),
      },
      {
        name: "wrong separator",
        mutate: (bytes) => {
          const changed = bytes.slice();
          changed[firstFrame(bytes).end] = 32;
          return changed;
        },
      },
      {
        name: "wrong frame order",
        mutate: (bytes) => {
          const end = firstFrame(bytes).end + 1;
          return joinBytes(bytes.subarray(end), bytes.subarray(0, end));
        },
      },
      {
        name: "extra frame",
        mutate: (bytes) =>
          joinBytes(bytes, bytes.subarray(0, firstFrame(bytes).end + 1)),
      },
      {
        name: "trailing bytes",
        mutate: (bytes) => joinBytes(bytes, new Uint8Array([0])),
      },
      {
        name: "invalid header UTF-8",
        mutate: (bytes) => {
          const changed = bytes.slice();
          changed[0] = 255;
          return changed;
        },
      },
      {
        name: "invalid content UTF-8",
        mutate: (bytes) => {
          const changed = bytes.slice();
          changed[firstFrame(bytes).start] = 255;
          return changed;
        },
      },
      {
        name: "content BOM",
        mutate: (bytes) => {
          const frame = firstFrame(bytes);
          return joinBytes(
            new TextEncoder().encode(`${frame.sha} blob ${frame.length + 3}\n`),
            new Uint8Array([239, 187, 191]),
            bytes.subarray(frame.start),
          );
        },
      },
    ];
    for (const mutation of mutations) {
      await t.step(mutation.name, async () => {
        let intercepted = false;
        const read = await storeAt(ctx, "reader", "repair", {
          runGit: async (args, options) => {
            const result = await real.runGit(args, options);
            if (args[0] !== "cat-file") return result;
            assert(result.ok && result.stdoutBytes instanceof Uint8Array);
            intercepted = true;
            return {
              ...result,
              stdoutBytes: mutation.mutate(result.stdoutBytes),
            };
          },
        }).readRepair();
        assert(intercepted);
        assert(!read.ok, `${mutation.name} must not become found or absent`);
        assert.equal(read.error.kind, mutation.expected ?? "invalid");
        if (mutation.name === "invalid content UTF-8") {
          assert.match(read.error.detail ?? "", /not valid UTF-8/);
        }
      });
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state batch: failed, thrown and decoded-only transports refuse without leaking diagnostics", async (t) => {
  const ctx = await makeCtx("batch-transport");
  try {
    appliedHead(
      await storeAt(ctx, "writer", "repair").writeRepair(
        repairSnapshot(),
        null,
      ),
    );
    const real = new DenoGitRunner(`${ctx.tmp}/git-home`);
    for (const failure of ["failed", "thrown", "decoded-only"] as const) {
      await t.step(failure, async () => {
        const read = await storeAt(ctx, "reader", "repair", {
          runGit: async (args, options) => {
            if (args[0] !== "cat-file") return real.runGit(args, options);
            if (failure === "thrown") {
              throw new Error("private synthetic diagnostics");
            }
            if (failure === "failed") {
              return {
                ok: false,
                code: 128,
                stdout: "",
                stderr: "private synthetic diagnostics",
              };
            }
            const result = await real.runGit(args, options);
            return { ...result, stdoutBytes: undefined };
          },
        }).readRepair();
        assert(!read.ok);
        assert.equal(
          read.error.kind,
          failure === "decoded-only" ? "invalid" : "unavailable",
        );
        assert(!JSON.stringify(read).includes("private synthetic diagnostics"));
      });
    }
  } finally {
    await ctx.cleanup();
  }
});
