/**
 * The self scope's CI-first gate expects its one aggregate job: `ci.yml`'s
 * `test-local` is a `needs: [quality, test-shards]` job GitHub creates only
 * once those finish, so a green head listing without it waits like running
 * CI rather than admitting a review before the aggregate ran. No base read.
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

Deno.test("self CI-first gate: a green listing without test-local awaits the aggregate", async () => {
  const shards = [
    "quality",
    "test-shards (host-1)",
    "test-shards (host-2)",
    "test-shards (host-3)",
    "test-shards (modules)",
    "test-shards (integration)",
  ].map(check);
  assert.deepEqual(await absentExpectedChecks(deps, self, shards), [
    "test-local",
  ]);
  assert.deepEqual(
    await absentExpectedChecks(deps, self, [...shards, check("test-local")]),
    [],
  );
  assert.deepEqual(await absentExpectedChecks(deps, self, []), ["test-local"]);
});
