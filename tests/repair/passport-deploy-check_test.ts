/**
 * Owner directive 2026-10-30: for `ubiquity/passport.ubq.fi` the deployment
 * checks its dispatch-only deploy workflows report (`deploy-production`,
 * `deploy-standby`; Cloudflare Pages/Workers deployment statuses) are
 * deployment signals, not correctness checks. They must not gate a merge while
 * the target's own CI jobs and their verified backup-CI stand-ins still do.
 *
 * These cases pin the runtime gate (`decideCiGate`, shared by the CI-first
 * review gate, delivery and carried delivery). The launcher's own read is
 * pinned separately in tests/host/passport-deploy-merge-gate_test.ts.
 */
import assert from "node:assert/strict";
import { type GitHubCheckV1, portOk } from "../../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  absentExpectedChecks,
  decideCiGate,
} from "../../src/repair/loop-checks.ts";
import type { RepairCycleDepsV1 } from "../../src/repair/loop-types.ts";
import { selectMergeGateChecksV1 } from "../../src/repair/merge-gate-checks.ts";

const PASSPORT: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 155687488,
};
const AI: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 1,
};

function check(
  name: string,
  conclusion: GitHubCheckV1["conclusion"] = "success",
  status: GitHubCheckV1["status"] = "completed",
): GitHubCheckV1 {
  return {
    name,
    status,
    conclusion,
    head: "a".repeat(40) as never,
    startedAt: 1,
    completedAt: status === "completed" ? 2 : null,
  };
}

function gate(
  checks: GitHubCheckV1[],
  repository: RepositoryIdentityV1,
): ReturnType<typeof decideCiGate> {
  return decideCiGate(checks, repository);
}

Deno.test("Passport deploy check: a failed deploy with green CI proceeds", () => {
  assert.equal(
    gate([
      check("deno", "success"),
      check("deploy-standby", "failure"),
    ], PASSPORT),
    "proceed",
  );
});

Deno.test("Passport deploy check: a pending deploy with green CI proceeds", () => {
  assert.equal(
    gate([
      check("deno", "success"),
      check("deploy-production", null, "in_progress"),
    ], PASSPORT),
    "proceed",
  );
});

Deno.test("Passport deploy check: a Cloudflare Pages status with green CI proceeds", () => {
  assert.equal(
    gate([
      check("deno", "success"),
      check("Cloudflare Pages", "failure"),
    ], PASSPORT),
    "proceed",
  );
});

Deno.test("Passport deploy check: the target's own failed CI job is still red", () => {
  assert.deepEqual(
    gate([
      check("deno", "failure"),
      check("deploy-standby", "success"),
    ], PASSPORT),
    { blocked: "CI checks failed: deno(failure)" },
  );
});

Deno.test("Passport deploy check: deploy checks alone are no CI evidence", () => {
  assert.equal(
    gate([
      check("deploy-standby", "success"),
      check("deploy-production", "failure"),
    ], PASSPORT),
    "wait",
  );
});

Deno.test("Passport deploy check: every other target still gates a failed deploy", () => {
  assert.deepEqual(
    gate([
      check("deno", "success"),
      check("deploy-standby", "failure"),
    ], AI),
    { blocked: "CI checks failed: deploy-standby(failure)" },
  );
});

Deno.test("Passport deploy check: deploy observations stay recorded as evidence", () => {
  const deploy = check("deploy-standby", "failure");
  const selection = selectMergeGateChecksV1(PASSPORT, [
    check("deno", "success"),
    deploy,
  ]);
  assert.deepEqual(selection.checks.map((row) => row.name), ["deno"]);
  assert.deepEqual(selection.deployChecks, [deploy]);
});

Deno.test("Passport deploy check: a base deploy suite never becomes expected CI", async () => {
  const base = "b".repeat(40);
  const deps = {
    github: {
      readCheckSuites: () =>
        Promise.resolve(portOk({
          head: base as never,
          checks: [
            { name: "deno", suite: 1 },
            { name: "deploy-standby", suite: 2 },
            { name: "deploy-production", suite: 2 },
          ],
        })),
    },
  } as unknown as RepairCycleDepsV1;
  const head = [check("deno"), check("deploy-standby")];
  const record = {
    repository: PASSPORT,
    target: { base },
  } as unknown as WorkRecordV1;
  assert.deepEqual(await absentExpectedChecks(deps, record, head), []);
  const other = {
    repository: AI,
    target: { base },
  } as unknown as WorkRecordV1;
  assert.deepEqual(
    await absentExpectedChecks(deps, other, head),
    ["deploy-production"],
    "another target still expects every job of a base suite it reports",
  );
});
