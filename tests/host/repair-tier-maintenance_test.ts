// The maintenance tier step observes complete listings only and never fails
// the pass.
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { GitHubIssueV1 } from "../../src/contracts/ports-github-requests.ts";
import { runRepairTierMaintenance } from "../../src/host/repair-tier-maintenance.ts";
import { workItemIdForIssue } from "../../src/repair/keys.ts";
import type { RepairTierPolicyV1 } from "../../src/state/mod.ts";

const HEAD = "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha;
const AI = { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 };
const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 7,
};

function issue(number: number, state: "open" | "closed" = "open") {
  return { number, state } as GitHubIssueV1;
}

Deno.test("repair tier maintenance: only complete listings bound demotion and failures defer", async () => {
  const seen: (RepairTierPolicyV1 & { expectedHead: GitSha })[] = [];
  let outcome: "applied" | "conflict" | "throw" = "applied";
  const store = {
    readRepair: () =>
      Promise.resolve(portOk({ status: "found" as const, head: HEAD })),
    readRepairTiered: () => Promise.reject(new Error("unused")),
    tierRepair: (input: RepairTierPolicyV1 & { expectedHead: GitSha }) => {
      seen.push(input);
      if (outcome === "throw") return Promise.reject(new Error("boom"));
      if (outcome === "conflict") {
        return Promise.resolve(
          portOk({ status: "conflict" as const, currentHead: null }),
        );
      }
      return Promise.resolve(portOk({
        status: "applied" as const,
        head: HEAD,
        demoted: 12,
        promoted: 3,
        deferred: 40,
        releaseRequestsMovedToCold: 0,
        promotedOpenReleaseRequestIds: [],
      }));
    },
  };
  const deps = {
    store,
    repositories: [
      {
        repository: AI,
        listOpenIssues: () =>
          Promise.resolve(portOk([issue(4), issue(9, "closed")])),
      },
      {
        repository: PASSPORT,
        listOpenIssues: () =>
          Promise.resolve(portError("unavailable", "listing failed")),
      },
    ],
    clock: { now: () => 42 },
    demotionBudget: 64,
  };
  assert.equal(
    await runRepairTierMaintenance(deps),
    "repair-tier:promoted:3:demoted:12:deferred:40",
  );
  assert.equal(seen[0].expectedHead, HEAD);
  assert.equal(seen[0].now, 42);
  assert.equal(seen[0].demotionBudget, 64);
  assert.deepEqual(seen[0].listedRepositories, [AI]);
  assert.deepEqual([...seen[0].openIssueWorkIds], [workItemIdForIssue(AI, 4)]);

  outcome = "conflict";
  assert.equal(
    await runRepairTierMaintenance(deps),
    "repair-tier:deferred:conflict",
  );
  outcome = "throw";
  assert.equal(
    await runRepairTierMaintenance(deps),
    "repair-tier:deferred:exception",
  );
});
