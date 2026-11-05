// The maintenance tier step observes complete listings only, respects the
// pass deadline and never fails the pass; the production lister never
// returns a prefix.
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { runRepairTierMaintenance } from "../../src/host/repair-tier-maintenance.ts";
import { workItemIdForIssue } from "../../src/repair/keys.ts";
import type { RepairTierPolicyV1 } from "../../src/state/mod.ts";
import { listHostedOpenIssueNumbers } from "../../ops/hosted-autonomy-open-issues.ts";
import { repairSnapshot } from "../state/git-state-fixtures.ts";
import { workRecord } from "../state/helpers.ts";

const HEAD = "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha;
const AI = { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 };
const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 7,
};

Deno.test("repair tier maintenance: only complete listings bound demotion and failures defer", async () => {
  const snapshot = repairSnapshot({
    work: [
      workRecord("a-1", { repository: AI }),
      workRecord("p-1", { repository: PASSPORT }),
    ],
  });
  const seen: (RepairTierPolicyV1 & { expectedHead: GitSha })[] = [];
  let outcome: "applied" | "conflict" | "throw" = "applied";
  let now = 42;
  const deps = {
    store: {
      readRepair: () =>
        Promise.resolve(portOk({
          status: "found" as const,
          head: HEAD,
          ref: null,
          snapshot,
        })),
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
          promotedOpenReleaseRequestIds: ["release-1"],
          releaseRequestsSuperseded: 1,
        }));
      },
    },
    listOpenIssueNumbers: (repository: typeof AI) =>
      Promise.resolve(
        repository.name === AI.name
          ? portOk([4])
          : portError("unavailable", "listing failed"),
      ),
    clock: { now: () => now },
    deadlineAt: 1_000,
    protect: () => ({
      workIds: new Set(["a-1"]),
      reservationIds: new Set(["r-1"]),
    }),
    demotionBudget: 64,
  };
  const applied = await runRepairTierMaintenance(deps);
  assert.equal(
    applied.action,
    "repair-tier:promoted:3:demoted:12:deferred:40:read:2",
  );
  assert.equal(applied.releaseRequestsMovedToCold, null, "release unobserved");
  assert.equal(seen[0].releasePath, undefined);
  assert.equal(applied.recordsRead, 2);
  assert.equal(applied.appliedHead, HEAD);
  assert.equal(seen[0].expectedHead, HEAD);
  assert.equal(seen[0].now, 42);
  assert.equal(seen[0].demotionBudget, 64);
  assert.deepEqual(seen[0].listedRepositories, [AI]);
  assert.deepEqual([...seen[0].openIssueWorkIds], [workItemIdForIssue(AI, 4)]);
  assert.deepEqual([...seen[0].protectedWorkIds!], ["a-1"]);
  assert.deepEqual([...seen[0].protectedReservationIds!], ["r-1"]);

  // Release enabled: tips are read per listed repository and handed to the
  // tier writer, which records supersessions in its own commit.
  const tip = "6dc35d06e757107b91eb58232bd15e5f671d79b4" as GitSha;
  const enabled = await runRepairTierMaintenance({
    ...deps,
    releasePath: () => Promise.resolve(portOk("enabled" as const)),
    readTargetTip: (repository: typeof AI) =>
      Promise.resolve(portOk(repository.name === AI.name ? tip : null)),
  });
  assert.equal(
    enabled.action,
    "repair-tier:promoted:3:demoted:12:deferred:40:read:2" +
      ":release-enabled:moved-cold:0:superseded:1",
  );
  assert.equal(enabled.releaseRequestsSuperseded, 1);
  assert.equal(seen.at(-1)!.releasePath, "enabled");
  assert.deepEqual([...seen.at(-1)!.releaseTargetTips!.values()], [tip]);

  outcome = "conflict";
  assert.equal(
    (await runRepairTierMaintenance(deps)).action,
    "repair-tier:deferred:conflict",
  );
  outcome = "throw";
  assert.equal(
    (await runRepairTierMaintenance(deps)).action,
    "repair-tier:deferred:exception",
  );
  now = 1_000;
  const calls = seen.length;
  assert.equal(
    (await runRepairTierMaintenance(deps)).action,
    "repair-tier:deferred:deadline",
  );
  assert.equal(seen.length, calls, "no tier write after the deadline");
});

Deno.test("hosted open-issue lister: pages to completion, skips pull requests, never returns a prefix", async () => {
  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      number: from + index,
      state: "open",
      ...(index === 0 ? { pull_request: {} } : {}),
    }));
  const paths: string[] = [];
  const complete = await listHostedOpenIssueNumbers((_method, path) => {
    paths.push(path);
    return Promise.resolve(
      path.endsWith("page=1") ? page(1, 100) : page(101, 3),
    );
  }, AI);
  assert.ok(complete.ok);
  if (!complete.ok) return;
  assert.equal(complete.value.length, 99 + 2);
  assert.ok(!complete.value.includes(1) && !complete.value.includes(101));
  assert.equal(paths.length, 2);
  const broken = await listHostedOpenIssueNumbers(
    (_method, path) =>
      Promise.resolve(path.endsWith("page=1") ? page(1, 100) : null),
    AI,
  );
  assert.ok(!broken.ok, "a failed later page refuses the whole listing");
});
