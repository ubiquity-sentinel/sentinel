/**
 * Progress comments' state snapshots (idle-cycle attribution, 2026-11-15:
 * the planner read the whole repair state twice per target only to compare
 * progress, 60 full reads per idle run). One target's cycle changes only its
 * own target's records, so every target compares against ONE baseline read
 * before the first cycle (the serial aggregate already passes such a
 * baseline). When every cycle settled inside `advance` (the planner's runCycle
 * seam), no lifecycle work runs between the targets' progress comments, so
 * they also share ONE after-state read. The comments' inputs are unchanged.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { runActionsTargetCycles } from "../../src/host/actions.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import { SHA2, workRecord } from "../state/helpers.ts";
import {
  FOREIGN_REPO,
  makeTargetHostRig,
  targetCycleInput,
  THIRD_REPO,
} from "./actions-target-fixture.ts";

interface ProgressCallV1 {
  target: string;
  before: readonly string[];
  after: readonly string[];
}

function ids(records: readonly WorkRecordV1[]): string[] {
  return records.map((record) => record.id).sort();
}

/** A record no committed target owns, so no cycle ever steps it. */
const ELSEWHERE = {
  owner: "ubiquity",
  name: "not-a-committed-target",
  installationId: 7,
};

async function planned(withInvocations: boolean) {
  const rig = makeTargetHostRig(["sentinel", FOREIGN_REPO, THIRD_REPO]);
  rig.state.repair = seededSnapshot([
    workRecord("existing", { repository: ELSEWHERE }),
  ]);
  let reads = 0;
  const state = {
    readRepair: () => {
      reads++;
      return rig.state.readRepair();
    },
    readRelease: () => rig.state.readRelease(),
    writeRepair: (...args: Parameters<typeof rig.state.writeRepair>) =>
      rig.state.writeRepair(...args),
  };
  const calls: ProgressCallV1[] = [];
  const progressComments = (
    config: RepositoryConfigV1,
    before: readonly WorkRecordV1[],
    after: readonly WorkRecordV1[],
  ) => {
    calls.push({
      target: config.repository.name,
      before: ids(before),
      after: ids(after),
    });
    return Promise.resolve();
  };
  const input = targetCycleInput(rig, { state, progressComments });
  if (!withInvocations) {
    // The planner's intake seam: the foreign target's own cycle admits one
    // record of its own; every cycle settles inside `advance`.
    input.runCycle = (deps) => {
      if (deps.configs[0].repository.name === FOREIGN_REPO) {
        rig.state.repair = {
          ...rig.state.repair!,
          work: [
            ...rig.state.repair!.work,
            workRecord("foreign-new", {
              repository: deps.configs[0].repository,
            }),
          ],
        };
        rig.state.repairHead = SHA2;
      }
      return Promise.resolve({ status: "idle", detail: "intake prepared" });
    };
  }
  await runActionsTargetCycles(input);
  return { reads, calls };
}

Deno.test("progress snapshots: cycles settled inside advance share one baseline and one after-state", async () => {
  const { reads, calls } = await planned(false);
  assert.equal(reads, 2, "one baseline and one after-state read");
  assert.deepEqual(calls, [
    {
      target: "sentinel",
      before: ["existing"],
      after: ["existing", "foreign-new"],
    },
    {
      target: FOREIGN_REPO,
      // The foreign target's own admission is a change between its states.
      before: ["existing"],
      after: ["existing", "foreign-new"],
    },
    {
      target: THIRD_REPO,
      before: ["existing"],
      after: ["existing", "foreign-new"],
    },
  ]);
});

Deno.test("progress snapshots: real target invocations still read each after-state alone", async () => {
  const { reads, calls } = await planned(true);
  // One shared baseline, then one after-state per target: a settled
  // invocation's own continuation may write before the next target's
  // comments.
  assert.equal(calls.length, 3);
  assert.ok(reads >= 1 + calls.length, String(reads));
  for (const call of calls) assert.deepEqual(call.before, ["existing"]);
});
