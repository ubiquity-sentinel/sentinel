/**
 * The self scope's CI-first gate reads its base like every other target:
 * `ci.yml`'s `test-local` is a `needs: [quality, test-shards]` aggregate that
 * GitHub creates only once those jobs finish, so a head whose shards reported
 * waits for the aggregate instead of admitting a review before it ran. The
 * supervisor and dispatcher runs on the tip share no name with a head and add
 * no expectation; an unreadable base proves nothing.
 */
import assert from "node:assert/strict";
import { portError, portOk } from "../../src/contracts/ports.ts";
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

function depsFor(
  base: ReturnType<typeof portOk> | ReturnType<typeof portError>,
) {
  const reads: string[] = [];
  return {
    reads,
    deps: {
      github: {
        readCheckSuites: (sha: string) => {
          reads.push(sha);
          return Promise.resolve(base);
        },
      },
    } as unknown as RepairCycleDepsV1,
  };
}

const TIP = portOk({
  head: SHA1,
  checks: [
    ...SHARDS.map((name) => ({ name, suite: 1 })),
    { name: "test-local", suite: 1 },
    ...["maintenance", "prepare", "matrix_plan", "repair", "finalize"].map((
      name,
    ) => ({ name, suite: 2 })),
    { name: "dispatch", suite: 3 },
  ],
});

Deno.test("self CI-first gate: shards without test-local await the aggregate from the base's suite", async () => {
  const { deps, reads } = depsFor(TIP);
  assert.deepEqual(
    await absentExpectedChecks(deps, self, SHARDS.map(check)),
    ["test-local"],
  );
  assert.deepEqual(reads, [SHA1], "the base tip is read once");
  assert.deepEqual(
    await absentExpectedChecks(deps, self, [
      ...SHARDS.map(check),
      check("test-local"),
    ]),
    [],
  );
});

Deno.test("self CI-first gate: supervisor and dispatcher suites on the tip add no expectation", async () => {
  const { deps } = depsFor(TIP);
  assert.deepEqual(
    await absentExpectedChecks(deps, self, [
      ...SHARDS.map(check),
      check("test-local"),
    ]),
    [],
  );
});

Deno.test("self CI-first gate: an unreadable base proves nothing", async () => {
  const { deps } = depsFor(portError("unavailable", "rate limited"));
  assert.equal(await absentExpectedChecks(deps, self, SHARDS.map(check)), null);
});
