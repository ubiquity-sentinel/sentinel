/** Hermetic wire regression: no network, credentials or third-party imports. */
import assert from "node:assert/strict";
import {
  buildLiveInputsChunks,
  mergeLiveInputs,
  parseLiveInputsChunk,
} from "../../src/github/client-live-inputs.ts";
import { RecordParseError } from "../../src/contracts/validation.ts";

const SHA = "a".repeat(40);
const RECORDS = 60;
const chunks = buildLiveInputsChunks({
  repository: { owner: "example", name: "target", installationId: 1 },
  issues: Array.from({ length: RECORDS }, (_, i) => i + 1),
  pulls: Array.from({ length: RECORDS }, (_, i) => i + 101),
  branches: ["main"],
})!;

function readInputs(reviewId: unknown) {
  return mergeLiveInputs(chunks.map((chunk) => {
    const repository: Record<string, unknown> = {};
    for (const item of chunk.items) {
      repository[item.alias] = item.kind === "issue"
        ? { number: item.number, state: "OPEN" }
        : item.kind === "branch"
        ? { target: { oid: SHA } }
        : {
          number: item.number,
          state: "OPEN",
          headRefOid: SHA,
          baseRefOid: SHA,
          baseRefName: "main",
          commits: {
            nodes: [{
              commit: { oid: SHA, statusCheckRollup: { state: "SUCCESS" } },
            }],
          },
          reviews: { nodes: [{ databaseId: null, fullDatabaseId: reviewId }] },
        };
    }
    return parseLiveInputsChunk({ data: { repository } }, chunk);
  }));
}

Deno.test("live input wire: full-width review IDs keep 60 records in the batch", () => {
  const reviewId = 2 ** 31 + 17;
  const inputs = readInputs(String(reviewId));
  assert.equal(chunks.length, 2);
  assert.equal(inputs.issues.length, RECORDS);
  assert.equal(inputs.pulls.length, RECORDS);
  assert.ok(inputs.pulls.every((row) => row.pull?.latestReview === reviewId));
  assert.deepEqual(inputs.branches, [{ branch: "main", tip: SHA }]);
  for (
    const chunk of chunks.filter((entry) =>
      entry.items.some((item) => item.kind === "pull")
    )
  ) {
    assert.match(chunk.query, /fullDatabaseId/);
    assert.doesNotMatch(chunk.query, /\bdatabaseId\b/);
  }
});

Deno.test("live input wire: review BigInts must be exact positive safe integers", () => {
  assert.equal(
    readInputs(String(Number.MAX_SAFE_INTEGER)).pulls[0].pull?.latestReview,
    Number.MAX_SAFE_INTEGER,
  );
  for (
    const invalid of [
      undefined,
      null,
      901,
      "",
      "0",
      "-1",
      "1.5",
      "1e3",
      " 901",
      "901 ",
      "0x10",
      "0901",
      "not-an-id",
      "9007199254740993",
      "9223372036854775807",
    ]
  ) {
    assert.throws(() => readInputs(invalid), RecordParseError, String(invalid));
  }
});
