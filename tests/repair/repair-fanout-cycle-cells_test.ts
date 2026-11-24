/**
 * The private role's free-tier cell ceiling (2026-11-24) in the repository
 * fan-out plan: a deployment's lower `maxCells` keeps the first cells of the
 * ordinary plan and leaves every other repository's records with the serial
 * pass; omitted (the public role) is exactly the platform bound.
 */
import assert from "node:assert/strict";
import {
  HOSTED_CONTROLLER_CYCLE_CELLS,
  PRIVATE_CYCLE_CELLS,
} from "../../src/contracts/hosted-controller-deployment.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  delegatedRecordsV1,
  planRepairFanoutV1,
} from "../../src/repair/repair-fanout-plan.ts";
import { repairConfigs } from "./helpers.ts";
import { OLD_STAMP } from "./repository-pass-rig.ts";
import { SHA1, workRecord } from "../state/helpers.ts";

const NAMES = ["alpha", "beta", "gamma", "delta", "epsilon"];

function input(maxCells?: number) {
  const base = repairConfigs()[0];
  const configs = NAMES.map((name) => ({
    ...base,
    repository: { ...base.repository, name },
  }));
  const work = configs.map((config, index) => ({
    ...workRecord(`issue-${config.repository.name}-${index + 1}`, {
      repository: config.repository,
      nextStep: "review",
    }),
    stepInputs: OLD_STAMP,
  }));
  return {
    snapshot: { work } as unknown as RepairStateSnapshotV1,
    head: SHA1,
    configs,
    runId: 41,
    runAttempt: 1,
    ...(maxCells === undefined ? {} : { maxCells }),
  };
}

Deno.test("fan-out ceiling: the public role keeps the platform bound and the private role delegates four cells", async () => {
  // This suite runs as the public deployment.
  assert.equal(HOSTED_CONTROLLER_CYCLE_CELLS, null);
  assert.deepEqual({ ...PRIVATE_CYCLE_CELLS }, { matrix: 6, repair: 4 });
  const full = await planRepairFanoutV1(input());
  assert.equal(full.cells.length, NAMES.length);
  // What the host passes on the public role (`undefined`) is the bound.
  assert.deepEqual(await planRepairFanoutV1(input(undefined)), full);
  const bounded = await planRepairFanoutV1(input(PRIVATE_CYCLE_CELLS.repair));
  assert.deepEqual(bounded.cells, full.cells.slice(0, 4));
  // The repository outside the plan stays with the trusted serial pass.
  const delegated = delegatedRecordsV1(bounded);
  assert.equal(delegated.size, 4);
  assert.equal(delegated.has(full.cells[4].records[0]), false);
  assert.equal(delegatedRecordsV1(full).size, 5);
});
