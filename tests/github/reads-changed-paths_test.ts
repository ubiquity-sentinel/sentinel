// readChangedPaths (2026-11-17 success rule): the local mirror's own diff
// first (2026-11-18: no API read); a head the mirror lacks reads one exact
// base...head comparison, which names every changed path (a rename's
// previous path included); a list GitHub may have truncated, an unknown
// commit or a malformed answer never reads as "no CI-executable path". All
// fixtures are synthetic.
import assert from "node:assert/strict";
import {
  FakeGitExecutor,
  httpRespond,
  makePort,
  type ScriptEntry,
  SHA1,
  SHA3,
} from "./helpers.ts";

/** A port whose local mirror lacks the commits: the comparison decides. */
function comparisonPort(script: ScriptEntry[]) {
  const git = new FakeGitExecutor();
  git.changed = null;
  return makePort({ script, git });
}

Deno.test("readChangedPaths: the local mirror's diff answers first, with no request", async () => {
  const git = new FakeGitExecutor();
  git.changed = [".github/workflows/ci.yml", "src/app.ts"];
  const { port, transport } = makePort({ script: [], git });
  const read = await port.readChangedPaths(SHA1, SHA3);
  assert.ok(read.ok);
  if (read.ok) {
    assert.deepEqual(read.value, [".github/workflows/ci.yml", "src/app.ts"]);
  }
  assert.equal(transport.requests.length, 0);
});

const PATH =
  `/repos/ubiquity-sentinel/sentinel/compare/${SHA1}...${SHA3}?per_page=1`;

Deno.test("readChangedPaths: the exact comparison's paths, renames included", async () => {
  const { port } = comparisonPort(
    [
      httpRespond("GET", PATH, 200, {
        status: "ahead",
        files: [
          { filename: "src/app.ts", status: "modified" },
          {
            filename: ".github/workflows/ci.yml",
            previous_filename: ".github/workflows/old.yml",
            status: "renamed",
          },
        ],
      }),
    ],
  );
  const read = await port.readChangedPaths(SHA1, SHA3);
  assert.ok(read.ok, JSON.stringify(read));
  if (read.ok) {
    assert.deepEqual(read.value, [
      "src/app.ts",
      ".github/workflows/ci.yml",
      ".github/workflows/old.yml",
    ]);
  }
});

Deno.test("readChangedPaths: a possibly truncated list, an unknown commit or a malformed answer is never an empty change", async () => {
  const full = Array.from({ length: 300 }, (_, index) => ({
    filename: `src/f${index}.ts`,
  }));
  const { port: truncated } = comparisonPort(
    [httpRespond("GET", PATH, 200, { files: full })],
  );
  const cut = await truncated.readChangedPaths(SHA1, SHA3);
  assert.ok(cut.ok);
  if (cut.ok) assert.equal(cut.value, null);

  const { port: missing } = comparisonPort(
    [httpRespond("GET", PATH, 404, {})],
  );
  const absent = await missing.readChangedPaths(SHA1, SHA3);
  assert.ok(absent.ok);
  if (absent.ok) assert.equal(absent.value, null);

  for (
    const body of [
      { files: [{ filename: 7 }] },
      { files: [{ filename: "" }] },
      { files: "src/app.ts" },
      [],
    ]
  ) {
    const { port: wrong } = comparisonPort(
      [httpRespond("GET", PATH, 200, body)],
    );
    const bad = await wrong.readChangedPaths(SHA1, SHA3);
    assert.equal(bad.ok, false, JSON.stringify(body));
  }
  const { port: invalid } = makePort({ script: [] });
  const refused = await invalid.readChangedPaths("abc" as typeof SHA1, SHA3);
  assert.equal(refused.ok, false);
});
