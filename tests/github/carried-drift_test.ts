/**
 * Base-drift carry of a reviewed change (`src/github/carried-drift.ts`;
 * sentinel PRs 304 and 307 parked although every added and removed line of
 * their reviewed patches was byte-identical). A drifted text path carries the
 * reviewed change only when the refreshed content is exactly the clean line
 * merge of the reviewed change and the base's change; everything else keeps
 * the exact identity. Pure: blobs come from an in-memory store keyed by their
 * real git object ids.
 */
import assert from "node:assert/strict";

import {
  CARRIED_DRIFT_MAX_PATHS,
  carriedAcrossDrift,
  type CarriedBlobReaderV1,
  carriedDriftAllowed,
  type CarriedPathChangeV1,
  cleanLineMerge,
  gitBlobId,
  lineHunks,
} from "../../src/github/carried-drift.ts";
import { isNativeQueueTarget } from "../../src/github/native-queue-guard.ts";

const encoder = new TextEncoder();
const bytes = (lines: readonly string[]) => encoder.encode(lines.join(""));
/** Twelve distinct lines: the reviewed merge base of one file. */
const BASE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`);

function edit(
  lines: readonly string[],
  at: number,
  remove: number,
  ...insert: string[]
): string[] {
  const next = [...lines];
  next.splice(at, remove, ...insert);
  return next;
}

/** An in-memory blob store keyed by real git object ids. */
async function store(...files: Uint8Array[]) {
  const blobs = new Map<string, Uint8Array>();
  const ids: string[] = [];
  for (const file of files) {
    const id = await gitBlobId(file);
    blobs.set(id, file);
    ids.push(id);
  }
  const reads: string[] = [];
  const read: CarriedBlobReaderV1 = (sha) => {
    reads.push(sha);
    return Promise.resolve(blobs.get(sha) ?? null);
  };
  return { ids, read, reads };
}

function change(
  path: string,
  oldSha: string | null,
  newSha: string | null,
  oldMode: string | null = "100644",
  newMode: string | null = oldMode,
): CarriedPathChangeV1 {
  return { path, oldMode, oldSha, newMode, newSha };
}

/** The verdict for one path: reviewed O -> A, refreshed T -> H. */
async function verdict(
  o: readonly string[] | Uint8Array,
  a: readonly string[] | Uint8Array,
  t: readonly string[] | Uint8Array,
  h: readonly string[] | Uint8Array,
  mode = "100644",
) {
  const file = (value: readonly string[] | Uint8Array) =>
    value instanceof Uint8Array ? value : bytes(value);
  const { ids, read } = await store(file(o), file(a), file(t), file(h));
  return carriedAcrossDrift(
    [change("src/a.ts", ids[0], ids[1], mode)],
    [change("src/a.ts", ids[2], ids[3], mode)],
    read,
  );
}

Deno.test("carried drift: blob ids are git's own object ids", async () => {
  assert.equal(
    await gitBlobId(new Uint8Array()),
    "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  );
  assert.equal(
    await gitBlobId(encoder.encode("hello\n")),
    "ce013625030ba8dba906f756967f9e9ca394464a",
  );
});

Deno.test("carried drift: a reviewed hunk carried across context-only base drift is carried (#304/#307)", async () => {
  const reviewed = edit(BASE, 5, 1, "line six (reviewed)\n");
  // The base edits a context line two lines above the hunk and the last line.
  const tip = edit(edit(BASE, 3, 1, "line four (base)\n"), 11, 1, "end\n");
  const refreshed = edit(tip, 5, 1, "line six (reviewed)\n");
  assert.deepEqual(await verdict(BASE, reviewed, tip, refreshed), {
    kind: "carried",
    drifted: 1,
  });
  // Lines the base inserted above the hunk only shift its line numbers.
  const shiftedTip = ["header\n", "header 2\n", ...BASE];
  const shifted = edit(shiftedTip, 7, 1, "line six (reviewed)\n");
  assert.deepEqual(await verdict(BASE, reviewed, shiftedTip, shifted), {
    kind: "carried",
    drifted: 1,
  });
});

Deno.test("carried drift: the same added lines anywhere else in the file are never carried", async () => {
  const reviewed = edit(BASE, 3, 0, "check(input);\n");
  const tip = edit(BASE, 10, 1, "line eleven (base)\n");
  const carried = edit(tip, 3, 0, "check(input);\n");
  assert.equal((await verdict(BASE, reviewed, tip, carried)).kind, "carried");
  // Same added line, same removed lines (none), another place.
  for (const at of [0, 2, 4, 8, 12]) {
    const moved = edit(tip, at, 0, "check(input);\n");
    assert.equal(
      (await verdict(BASE, reviewed, tip, moved)).kind,
      "changed",
      `inserted at ${at}`,
    );
  }
});

Deno.test("carried drift: a reordered, dropped or extra edit is never carried", async () => {
  const reviewed = edit(edit(BASE, 8, 0, "y\n"), 2, 0, "x\n");
  const tip = edit(BASE, 5, 1, "line six (base)\n");
  const carried = edit(edit(tip, 8, 0, "y\n"), 2, 0, "x\n");
  assert.equal((await verdict(BASE, reviewed, tip, carried)).kind, "carried");
  const reordered = edit(edit(tip, 8, 0, "x\n"), 2, 0, "y\n");
  const dropped = edit(tip, 2, 0, "x\n");
  const extra = edit(carried, 0, 0, "extra\n");
  const changedLine = edit(edit(tip, 8, 0, "Y\n"), 2, 0, "x\n");
  for (
    const [name, refreshed] of [
      ["reordered", reordered],
      ["dropped", dropped],
      ["extra", extra],
      ["changed added line", changedLine],
    ] as const
  ) {
    assert.equal(
      (await verdict(BASE, reviewed, tip, refreshed)).kind,
      "changed",
      name,
    );
  }
});

Deno.test("carried drift: a base edit touching or overlapping a reviewed hunk is a conflict, never carried", async () => {
  const reviewed = edit(BASE, 5, 1, "line six (reviewed)\n");
  for (const at of [4, 5, 6]) {
    const tip = edit(BASE, at, 1, `line ${at + 1} (base)\n`);
    // What a merge would give if it applied both anyway.
    const refreshed = edit(tip, 5, 1, "line six (reviewed)\n");
    assert.equal(
      (await verdict(BASE, reviewed, tip, refreshed)).kind,
      "changed",
      `base edit at line ${at + 1}`,
    );
  }
  // An insertion right beside the reviewed insertion point is ambiguous.
  const inserted = edit(BASE, 5, 0, "x\n");
  const beside = edit(BASE, 5, 0, "base\n");
  assert.equal(
    (await verdict(BASE, inserted, beside, edit(beside, 6, 0, "x\n"))).kind,
    "changed",
  );
});

Deno.test("carried drift: line terminators and a missing final newline are compared byte for byte", async () => {
  const unterminated = [...BASE.slice(0, 11), "line 12"];
  const reviewed = [...unterminated.slice(0, 11), "line 12\n", "tail\n"];
  const tip = edit(unterminated, 1, 1, "line two (base)\n");
  const refreshed = [...tip.slice(0, 11), "line 12\n", "tail\n"];
  assert.equal(
    (await verdict(unterminated, reviewed, tip, refreshed)).kind,
    "carried",
  );
  const crlf = [...tip.slice(0, 11), "line 12\r\n", "tail\n"];
  assert.equal(
    (await verdict(unterminated, reviewed, tip, crlf)).kind,
    "changed",
  );
});

Deno.test("carried drift: mode, binary, symlink, added, deleted and path-set changes keep the exact identity", async (t) => {
  const reviewed = edit(BASE, 5, 1, "line six (reviewed)\n");
  const tip = edit(BASE, 1, 1, "line two (base)\n");
  const refreshed = edit(tip, 5, 1, "line six (reviewed)\n");
  const { ids, read } = await store(
    bytes(BASE),
    bytes(reviewed),
    bytes(tip),
    bytes(refreshed),
  );
  const [o, a, b, h] = ids;
  const cases: [string, CarriedPathChangeV1[], CarriedPathChangeV1[]][] = [
    [
      "mode change (#156)",
      [change("s", o, a, "100644", "100755")],
      [change("s", b, h, "100644", "100755")],
    ],
    ["symlink", [change("s", o, a, "120000")], [change("s", b, h, "120000")]],
    ["submodule", [change("s", o, a, "160000")], [
      change("s", b, h, "160000"),
    ]],
    ["added path", [change("s", null, a, null, "100644")], [
      change("s", null, h, null, "100644"),
    ]],
    ["deleted path", [change("s", o, null, "100644", null)], [
      change("s", b, null, "100644", null),
    ]],
    ["another path", [change("s", o, a)], [change("t", b, h)]],
    ["an extra path", [change("s", o, a)], [
      change("s", b, h),
      change("t", o, a),
    ]],
    ["modes differ across sides", [change("s", o, a)], [
      change("s", b, h, "100755"),
    ]],
    ["old content unchanged by the base", [change("s", o, a)], [
      change("s", o, h),
    ]],
  ];
  for (const [name, before, after] of cases) {
    await t.step(name, async () => {
      assert.equal(
        (await carriedAcrossDrift(before, after, read)).kind,
        "changed",
      );
    });
  }
  await t.step("binary content", async () => {
    const binary = (text: string) => encoder.encode(`\0${text}`);
    assert.equal(
      (await verdict(
        binary("a\nb\n"),
        binary("a\nB\n"),
        binary("A\na\nb\n"),
        binary("A\na\nB\n"),
      )).kind,
      "changed",
    );
  });
  await t.step("equal blob ids are carried without a blob read", async () => {
    const paths = [change("s", o, a), change("t", null, h, null, "100755")];
    assert.deepEqual(
      await carriedAcrossDrift(paths, [...paths].reverse(), () => {
        throw new Error("no blob read for an exact path");
      }),
      { kind: "carried", drifted: 0 },
    );
  });
});

Deno.test("carried drift: an unreadable or mismatched blob is unavailable, an oversized one is changed", async () => {
  const reviewed = edit(BASE, 5, 1, "line six (reviewed)\n");
  const tip = edit(BASE, 1, 1, "line two (base)\n");
  const refreshed = edit(tip, 5, 1, "line six (reviewed)\n");
  const { ids, read } = await store(
    bytes(BASE),
    bytes(reviewed),
    bytes(tip),
    bytes(refreshed),
  );
  const before = [change("s", ids[0], ids[1])];
  const after = [change("s", ids[2], ids[3])];
  const answer =
    (value: Uint8Array | "too_large" | null): CarriedBlobReaderV1 => (sha) =>
      sha === ids[3] ? Promise.resolve(value) : read(sha);
  assert.deepEqual(await carriedAcrossDrift(before, after, answer(null)), {
    kind: "unavailable",
  });
  assert.deepEqual(
    await carriedAcrossDrift(before, after, answer(bytes(tip))),
    { kind: "unavailable" },
    "bytes that are not the named blob are no proof",
  );
  assert.deepEqual(
    await carriedAcrossDrift(before, after, () => {
      throw new Error("network");
    }),
    { kind: "unavailable" },
  );
  assert.deepEqual(
    await carriedAcrossDrift(before, after, answer("too_large")),
    { kind: "changed" },
  );
  const many = Array.from(
    { length: CARRIED_DRIFT_MAX_PATHS + 1 },
    (_, index) => `p${String(index).padStart(3, "0")}`,
  );
  assert.deepEqual(
    await carriedAcrossDrift(
      many.map((path) => change(path, ids[0], ids[1])),
      many.map((path) => change(path, ids[2], ids[3])),
      () => {
        throw new Error("no blob read past the path bound");
      },
    ),
    { kind: "changed" },
  );
});

/** Deterministic xorshift32 for the property cases. */
function random(seed: number) {
  let state = seed;
  return (bound: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % bound;
  };
}

/** Length of a longest common subsequence (the oracle of minimality). */
function lcs(a: Int32Array, b: Int32Array): number {
  const row = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1]
        ? diagonal + 1
        : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length];
}

Deno.test("carried drift: line hunks are a shortest edit script that rebuilds the target", () => {
  const next = random(0x5e17e1);
  for (let round = 0; round < 400; round++) {
    const a = Int32Array.from(
      { length: next(14) },
      () => next(4),
    );
    const b = Int32Array.from(
      { length: next(14) },
      () => next(4),
    );
    const hunks = lineHunks(a, b);
    assert.ok(hunks !== null);
    for (let index = 1; index < hunks.length; index++) {
      assert.ok(hunks[index - 1].end < hunks[index].start, "separated");
    }
    assert.deepEqual(
      Array.from(cleanLineMerge(a, hunks, [])!),
      Array.from(b),
      `${a} -> ${b}`,
    );
    const edits = hunks.reduce(
      (sum, hunk) => sum + (hunk.end - hunk.start) + hunk.lines.length,
      0,
    );
    assert.equal(edits, a.length + b.length - 2 * lcs(a, b), "shortest");
  }
});

Deno.test("carried drift: only a native queue target keeps the exact identity", () => {
  for (
    const repository of [
      { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
      { owner: "ubiquity", name: "passport.ubq.fi", installationId: 1 },
      { owner: "ubiquity-sentinel", name: "sentinel", installationId: 0 },
    ]
  ) {
    assert.equal(
      carriedDriftAllowed(repository),
      !isNativeQueueTarget(repository),
      repository.name,
    );
  }
  assert.equal(
    carriedDriftAllowed({
      owner: "ubiquity-sentinel",
      name: "sentinel",
      installationId: 0,
    }),
    true,
  );
});
