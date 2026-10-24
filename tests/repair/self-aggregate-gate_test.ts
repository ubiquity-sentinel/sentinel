/**
 * The self scope's CI-first gate reads no base; its gate is `ci.yml`'s
 * `test-local`, a `needs: [quality, test-shards]` aggregate that GitHub
 * creates only once those jobs finish. A head whose own `ci.yml` jobs report
 * without the aggregate waits for it; a head without those jobs (another
 * suite, a fixture's generic check) keeps the old rule and adds no expectation.
 */
import assert from "node:assert/strict";
import type { RepairCycleDepsV1 } from "../../src/repair/loop-types.ts";
import { absentExpectedChecks } from "../../src/repair/loop-checks.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

type Check = Parameters<typeof absentExpectedChecks>[2][number];

const check = (name: string): Check => ({
  name,
  status: "completed",
  conclusion: "success",
  head: SHA2,
  startedAt: T0,
  completedAt: T0 + 1,
} as unknown as Check);

const SHARDS = [
  "quality",
  "test-shards (host-1)",
  "test-shards (host-2)",
  "test-shards (host-3)",
  "test-shards (modules)",
  "test-shards (integration)",
];

const self = workRecord("issue-self", {
  repository: {
    owner: "ubiquity-sentinel",
    name: "sentinel",
    installationId: 0,
  },
  target: { base: SHA1, branch: null, checkpoint: null, head: SHA2, pr: 7 },
});

const deps = {
  github: {
    readCheckSuites: () => {
      throw new Error("the self scope reads no base");
    },
  },
} as unknown as RepairCycleDepsV1;

Deno.test("self CI-first gate: ci.yml jobs without test-local await the aggregate, without a base read", async () => {
  assert.deepEqual(await absentExpectedChecks(deps, self, SHARDS.map(check)), [
    "test-local",
  ]);
  assert.deepEqual(
    await absentExpectedChecks(deps, self, [check("quality")]),
    ["test-local"],
  );
  assert.deepEqual(
    await absentExpectedChecks(deps, self, [
      ...SHARDS.map(check),
      check("test-local"),
    ]),
    [],
  );
});

Deno.test("self CI-first gate: a head without ci.yml's own jobs adds no expectation", async () => {
  assert.deepEqual(await absentExpectedChecks(deps, self, [check("ci")]), []);
  assert.deepEqual(
    await absentExpectedChecks(deps, self, [check("test-local")]),
    [],
  );
  assert.deepEqual(await absentExpectedChecks(deps, self, []), []);
});
