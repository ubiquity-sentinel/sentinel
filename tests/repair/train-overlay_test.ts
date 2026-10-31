// Delivery-train overlay: inclusion, ejection and deferral of reviewed
// patches onto tip T, and the exact landing tree verification (C12 WP3.2).
import assert from "node:assert/strict";
import {
  computeTrainOverlayV1,
  trainBaseTreeFromEntries,
  type TrainBaseTreeV1,
  trainMemberDriftV1,
  type TrainOverlayCandidateV1,
  type TrainTreeChangeV1,
  type TrainTreeEntryV1,
  verifyTrainLandingTreeV1,
} from "../../src/repair/train-overlay.ts";
import {
  BASE,
  change,
  manifest,
  member,
  range,
  sha,
  shuffle,
} from "./train-fixtures.ts";

const F = "100644";
const X = "100755";
const L = "120000";
const S = "160000";

function tree(
  entries: Record<string, readonly [string, number]>,
): TrainBaseTreeV1 {
  return trainBaseTreeFromEntries(
    new Map<string, TrainTreeEntryV1>(
      Object.entries(entries).map(([path, [mode, blob]]) => [
        path,
        { mode, sha: sha(blob) },
      ]),
    ),
  );
}

const T = tree({
  "README.md": [F, 1],
  "src/a.ts": [F, 2],
  "src/b.ts": [F, 3],
  "src/util/c.ts": [F, 4],
  "bin/run": [X, 5],
  "link": [L, 6],
  "docs/guide.md": [F, 7],
  "lib": [F, 8],
  "vendor/mod": [S, 9],
  "ops/secret-policy.ts": [F, 10],
});

function candidate(
  pr: number,
  changes: readonly TrainTreeChangeV1[] | null,
): TrainOverlayCandidateV1 {
  return { member: member(pr), changes };
}

function overlay(
  candidates: readonly TrainOverlayCandidateV1[],
  base: TrainBaseTreeV1 | null = T,
) {
  return computeTrainOverlayV1({
    base: BASE,
    tree: base,
    protectedPaths: ["ops/", ".github/workflows"],
    candidates,
  });
}

function dispositions(result: ReturnType<typeof overlay>) {
  return result.results.map((
    r,
  ) => [r.member.pr, r.disposition, r.path, r.overlapsPr]);
}

Deno.test("train overlay: disjoint members are included in train order and their patches unioned by path", () => {
  const one = [change("src/a.ts", [F, 2], [F, 20])];
  const two = [
    change("README.md", [F, 1], [F, 21]),
    change("src/new.ts", null, [F, 22]),
  ];
  const result = overlay([candidate(7, two), candidate(3, one)]);
  assert.deepEqual(dispositions(result), [
    [3, "included", null, null],
    [7, "included", null, null],
  ]);
  assert.deepEqual(result.members.map((m) => m.pr), [3, 7]);
  assert.deepEqual(result.changes.map((c) => c.path), [
    "README.md",
    "src/a.ts",
    "src/new.ts",
  ]);
});

Deno.test("train overlay: drift on a changed path ejects the member", () => {
  const result = overlay([
    candidate(1, [change("src/a.ts", [F, 99], [F, 20])]),
    candidate(2, [
      change("src/b.ts", [F, 3], null),
      change("src/gone.ts", [F, 4], null),
    ]),
    candidate(3, [
      change("src/b.ts", [F, 3], [F, 30]),
      change("src/util/c.ts", null, [F, 31]),
    ]),
    candidate(4, [change("bin/run", [F, 5], [X, 5])]),
  ]);
  assert.deepEqual(dispositions(result), [
    [1, "ejected:drift", "src/a.ts", null],
    [2, "ejected:drift", "src/gone.ts", null],
    [3, "ejected:drift", "src/util/c.ts", null],
    [4, "ejected:drift", "bin/run", null],
  ]);
  assert.deepEqual(result.changes, []);
});

Deno.test("train overlay: a T file over an added path, or T files under an added file, is drift", () => {
  const result = overlay([
    // `lib` became a file on T after the member's merge base.
    candidate(1, [change("lib/index.ts", null, [F, 40])]),
    // `docs/` holds a file on T the member's patch does not delete.
    candidate(2, [change("docs", null, [F, 41])]),
    // A file -> directory transition that deletes the T file is a tree.
    candidate(3, [
      change("lib", [F, 8], null),
      change("lib/index.ts", null, [F, 42]),
    ]),
    // A directory -> file transition that deletes every T file under it.
    candidate(4, [
      change("src/util", null, [F, 43]),
      change("src/util/c.ts", [F, 4], null),
    ]),
  ]);
  assert.deepEqual(dispositions(result), [
    [1, "ejected:drift", "lib", null],
    [2, "ejected:drift", "docs", null],
    [3, "included", null, null],
    [4, "included", null, null],
  ]);
});

Deno.test("train overlay: a path or directory prefix an earlier member claims defers the later one", () => {
  const result = overlay([
    candidate(1, [
      change("pkg/x.ts", null, [F, 51]),
      change("src/a.ts", [F, 2], [F, 50]),
    ]),
    candidate(2, [change("src/a.ts", [F, 2], [F, 52])]),
    candidate(3, [change("pkg", null, [F, 53])]),
    candidate(4, [change("new", null, [F, 54])]),
    candidate(5, [change("new/inner.ts", null, [F, 55])]),
    candidate(6, [
      change("pkg/y.ts", null, [F, 56]),
      change("src/b.ts", [F, 3], [F, 57]),
    ]),
  ]);
  assert.deepEqual(dispositions(result), [
    [1, "included", null, null],
    [2, "deferred:overlap", "src/a.ts", 1],
    [3, "deferred:overlap", "pkg", 1],
    [4, "included", null, null],
    [5, "deferred:overlap", "new/inner.ts", 4],
    [6, "included", null, null],
  ]);
  assert.deepEqual(result.changes.map((c) => c.path), [
    "new",
    "pkg/x.ts",
    "pkg/y.ts",
    "src/a.ts",
    "src/b.ts",
  ]);
});

Deno.test("train overlay: drift is decided before overlap, and deferred members claim nothing", () => {
  const result = overlay([
    candidate(1, [change("src/a.ts", [F, 2], [F, 60])]),
    candidate(2, [change("src/a.ts", [F, 77], [F, 61])]),
    candidate(3, [
      change("src/a.ts", [F, 2], [F, 63]),
      change("src/b.ts", [F, 3], [F, 62]),
    ]),
    candidate(4, [change("src/b.ts", [F, 3], [F, 64])]),
  ]);
  assert.deepEqual(dispositions(result), [
    [1, "included", null, null],
    [2, "ejected:drift", "src/a.ts", null],
    [3, "deferred:overlap", "src/a.ts", 1],
    [4, "included", null, null],
  ]);
});

Deno.test("train overlay: deletion, mode-only, symlink and binary changes are ordinary tuples", () => {
  const result = overlay([
    candidate(1, [change("README.md", [F, 1], null)]),
    candidate(2, [change("bin/run", [X, 5], [F, 5])]),
    candidate(3, [change("link", [L, 6], [L, 70])]),
    candidate(4, [change("assets/logo.png", null, [F, 0xabcdef1234])]),
  ]);
  assert.deepEqual(result.results.map((r) => r.disposition), [
    "included",
    "included",
    "included",
    "included",
  ]);
  assert.deepEqual(result.changes, [
    change("README.md", [F, 1], null),
    change("assets/logo.png", null, [F, 0xabcdef1234]),
    change("bin/run", [X, 5], [F, 5]),
    change("link", [L, 6], [L, 70]),
  ]);
});

Deno.test("train overlay: protected paths and submodules eject; protected wins and deletions count", () => {
  const result = overlay([
    candidate(1, [change("ops/secret-policy.ts", [F, 10], null)]),
    candidate(2, [change(".github/workflows/ci.yml", null, [F, 80])]),
    candidate(3, [change("vendor/mod", [S, 9], [S, 81])]),
    candidate(4, [
      change("vendor/mod", [S, 9], null),
      change("vendor/mod/file", null, [F, 82]),
    ]),
    candidate(5, [change("ops/new.ts", null, [S, 83])]),
    candidate(6, [change("deps/sub", null, [S, 84])]),
  ]);
  assert.deepEqual(dispositions(result), [
    [1, "ejected:protected", "ops/secret-policy.ts", null],
    [2, "ejected:protected", ".github/workflows/ci.yml", null],
    [3, "ejected:submodule", "vendor/mod", null],
    [4, "ejected:submodule", "vendor/mod", null],
    [5, "ejected:protected", "ops/new.ts", null],
    [6, "ejected:submodule", "deps/sub", null],
  ]);
});

Deno.test("train overlay: unreadable, malformed or colliding facts defer instead of guessing", () => {
  const ok = (blob: number) => [change(`f${blob}`, null, [F, blob])];
  const malformed: TrainTreeChangeV1[][] = [
    [change("b", null, [F, 1]), change("a", null, [F, 2])],
    [change("a", null, [F, 1]), change("a", null, [F, 2])],
    [change("a", null, null)],
    [change("a", [F, 1], [F, 1])],
    [{ ...change("a", null, [F, 1]), newMode: "040000" }],
    [{ ...change("a", null, [F, 1]), newSha: "abc" }],
    [{ ...change("a", null, [F, 1]), oldMode: F }],
    [change("/a", null, [F, 1])],
    [change("a/../b", null, [F, 1])],
    [change("a/", null, [F, 1])],
    [change("x", null, [F, 1]), change("x/y", null, [F, 2])],
  ];
  const result = overlay([
    candidate(1, null),
    ...malformed.map((patch, i) => candidate(10 + i, patch)),
    { member: member(30), changes: ok(300) },
    { member: member(30, { recordId: member(31).recordId }), changes: ok(301) },
    { member: member(40, { head: BASE }), changes: ok(400) },
    { member: member(41, { head: member(42).head }), changes: ok(410) },
    { member: member(42), changes: ok(420) },
    {
      member: member(43, { issueNumber: member(44).issueNumber }),
      changes: ok(430),
    },
    { member: member(44), changes: ok(440) },
    candidate(50, ok(500)),
  ]);
  const facts = result.results.filter((r) =>
    r.disposition === "deferred:facts"
  );
  assert.equal(facts.length, 1 + malformed.length + 7);
  assert.deepEqual(result.members.map((m) => m.pr), [50]);
  assert.deepEqual(
    overlay([candidate(1, ok(1))], null).results.map((r) => r.disposition),
    ["deferred:facts"],
  );
});

Deno.test("train overlay: unknown T facts defer, but a known drift still ejects", () => {
  const partial: TrainBaseTreeV1 = {
    entry: (path) => path === "known.ts" ? { mode: F, sha: sha(1) } : undefined,
    pathsUnder: () => [],
  };
  const result = overlay([
    candidate(1, [change("other.ts", [F, 2], [F, 3])]),
    candidate(2, [
      change("known.ts", [F, 9], [F, 3]),
      change("other.ts", [F, 2], [F, 4]),
    ]),
    candidate(3, [change("known.ts", [F, 1], [F, 5])]),
  ], partial);
  assert.deepEqual(result.results.map((r) => r.disposition), [
    "deferred:facts",
    "ejected:drift",
    "included",
  ]);
  const noListing: TrainBaseTreeV1 = {
    entry: (path) => path === "a" ? { mode: F, sha: sha(1) } : null,
    pathsUnder: () => undefined,
  };
  assert.equal(
    trainMemberDriftV1(noListing, [change("b", null, [F, 1])]),
    "unknown",
  );
  assert.equal(
    trainMemberDriftV1(noListing, [change("a", [F, 1], null)]),
    null,
  );
  assert.deepEqual(trainMemberDriftV1(noListing, [change("a", [F, 2], null)]), {
    path: "a",
  });
});

Deno.test("train overlay: at most 63 members are included; the rest wait for capacity", () => {
  const candidates = range(1, 65).map((pr) =>
    candidate(pr, [change(`f/${pr}`, null, [F, pr])])
  );
  const result = overlay(candidates);
  assert.equal(result.members.length, 63);
  assert.deepEqual(
    result.results.slice(63).map((r) => [r.member.pr, r.disposition]),
    [
      [64, "deferred:capacity"],
      [65, "deferred:capacity"],
    ],
  );
});

Deno.test("train overlay: the outcome never depends on candidate list order", () => {
  const candidates = [
    candidate(1, [change("src/a.ts", [F, 2], [F, 90])]),
    candidate(2, [change("src/a.ts", [F, 2], [F, 91])]),
    candidate(3, [change("src/a.ts", [F, 99], [F, 92])]),
    candidate(4, [change("pkg", null, [F, 93])]),
    candidate(5, [change("pkg/x", null, [F, 94])]),
    candidate(6, null),
    { member: member(7), changes: [change("q", null, [F, 95])] },
    { member: member(7), changes: [change("r", null, [F, 96])] },
  ];
  const expected = overlay(candidates);
  for (
    const order of [
      shuffle(candidates),
      [...candidates].reverse(),
      shuffle(shuffle(candidates)),
    ]
  ) {
    assert.deepEqual(overlay(order), expected);
  }
  assert.deepEqual(dispositions(expected).map((d) => d[1]), [
    "included",
    "deferred:overlap",
    "ejected:drift",
    "included",
    "deferred:overlap",
    "deferred:facts",
    "deferred:facts",
    "deferred:facts",
  ]);
});

Deno.test("train landing tree: parents and the exact union of member patches verify", () => {
  const train = manifest([2, 5]);
  const r2 = [
    change("src/a.ts", [F, 2], [F, 20]),
    change("src/z.ts", null, [F, 21]),
  ];
  const r5 = [change("README.md", [F, 1], null)];
  const parents = [BASE, member(2).head, member(5).head];
  const landed = [r5[0], r2[0], r2[1]];
  assert.deepEqual(
    verifyTrainLandingTreeV1({
      manifest: train,
      parents,
      landed,
      members: [r2, r5],
    }),
    { ok: true },
  );
  const verdict = (
    patch: Partial<Parameters<typeof verifyTrainLandingTreeV1>[0]>,
  ) =>
    verifyTrainLandingTreeV1({
      manifest: train,
      parents,
      landed,
      members: [r2, r5],
      ...patch,
    });
  assert.deepEqual(
    verdict({ parents: [BASE, member(5).head, member(2).head] }),
    { ok: false, reason: "parents" },
  );
  assert.deepEqual(verdict({ parents: [member(2).head, member(5).head] }), {
    ok: false,
    reason: "parents",
  });
  assert.deepEqual(verdict({ parents: [BASE, member(2).head] }), {
    ok: false,
    reason: "parents",
  });
  assert.deepEqual(verdict({ members: [r2] }), {
    ok: false,
    reason: "members",
  });
  assert.deepEqual(verdict({ landed: [r5[0], r2[0]] }), {
    ok: false,
    reason: "tree",
  });
  assert.deepEqual(
    verdict({ landed: [...landed, change("zz", null, [F, 1])] }),
    { ok: false, reason: "tree" },
  );
  assert.deepEqual(
    verdict({ landed: [r5[0], { ...r2[0], newMode: X }, r2[1]] }),
    { ok: false, reason: "tree" },
  );
  assert.deepEqual(
    verdict({ members: [r2, [change("src/a.ts", [F, 2], null)]] }),
    { ok: false, reason: "overlap" },
  );
  assert.deepEqual(
    verdict({ members: [r2, [change("src/z.ts/q", null, [F, 3])]] }),
    { ok: false, reason: "overlap" },
  );
  assert.deepEqual(verdict({ landed: [r2[0], r5[0], r2[1]] }), {
    ok: false,
    reason: "malformed",
  });
});

Deno.test("train landing tree: a binary blob differing past an abbreviated id is a different tree", () => {
  const train = manifest([1]);
  const blob = "1234567890" + "a".repeat(30);
  const forged = "1234567890" + "b".repeat(30);
  const reviewed = [{
    path: "img.png",
    oldMode: null,
    oldSha: null,
    newMode: F,
    newSha: blob,
  }];
  const parents = [BASE, member(1).head];
  assert.deepEqual(
    verifyTrainLandingTreeV1({
      manifest: train,
      parents,
      landed: reviewed,
      members: [reviewed],
    }),
    { ok: true },
  );
  assert.deepEqual(
    verifyTrainLandingTreeV1({
      manifest: train,
      parents,
      landed: [{ ...reviewed[0], newSha: forged }],
      members: [reviewed],
    }),
    { ok: false, reason: "tree" },
  );
});

Deno.test("train base tree: a whole tree read answers entries and the paths under a directory", () => {
  assert.deepEqual(T.entry("src/a.ts"), { mode: F, sha: sha(2) });
  assert.equal(T.entry("src"), null);
  assert.deepEqual(T.pathsUnder("src"), [
    "src/a.ts",
    "src/b.ts",
    "src/util/c.ts",
  ]);
  assert.deepEqual(T.pathsUnder("src/util"), ["src/util/c.ts"]);
  assert.deepEqual(T.pathsUnder("sr"), []);
  assert.deepEqual(T.pathsUnder("README.md"), []);
});
