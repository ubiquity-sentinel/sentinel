// readChangedPaths (2026-11-17 success rule): one exact base...head
// comparison names every changed path (a rename's previous path included);
// a list GitHub may have truncated, an unknown commit or a malformed answer
// never reads as "no CI-executable path". All fixtures are synthetic.
import assert from "node:assert/strict";
import { httpRespond, makePort, SHA1, SHA3 } from "./helpers.ts";

const PATH =
  `/repos/ubiquity-sentinel/sentinel/compare/${SHA1}...${SHA3}?per_page=1`;

Deno.test("readChangedPaths: the exact comparison's paths, renames included", async () => {
  const { port } = makePort({
    script: [
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
  });
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
  const { port: truncated } = makePort({
    script: [httpRespond("GET", PATH, 200, { files: full })],
  });
  const cut = await truncated.readChangedPaths(SHA1, SHA3);
  assert.ok(cut.ok);
  if (cut.ok) assert.equal(cut.value, null);

  const { port: missing } = makePort({
    script: [httpRespond("GET", PATH, 404, {})],
  });
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
    const { port: wrong } = makePort({
      script: [httpRespond("GET", PATH, 200, body)],
    });
    const bad = await wrong.readChangedPaths(SHA1, SHA3);
    assert.equal(bad.ok, false, JSON.stringify(body));
  }
  const { port: invalid } = makePort({ script: [] });
  const refused = await invalid.readChangedPaths("abc" as typeof SHA1, SHA3);
  assert.equal(refused.ok, false);
});
