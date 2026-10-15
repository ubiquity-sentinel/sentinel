/** A session cut off by its duration bound counts toward decomposition. */
import assert from "node:assert/strict";
import { SHA1 } from "../state/helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import { FakeModel } from "./helpers.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { workRecord } from "../state/helpers.ts";

async function runOnce(model: FakeModel) {
  const sourceIssue = issueRecord(41, {
    title: "large task",
    relations: { openBlockers: [], subIssueCount: 0 },
  });
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  github.listed = [sourceIssue];
  github.latest.set(41, sourceIssue);
  const rig = makeMemoryRig(github);
  const taskId = asWorkItemId("issue-41");
  const record = workRecord("issue-41", {
    source: { kind: "issue", id: "41", revision: SHA1 },
    related: { incidentId: null, issueNumber: 41 },
    target: {
      base: SHA1,
      branch: candidateBranch(taskId),
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "work",
  });
  const seeded = await rig.state.writeRepair(seededSnapshot([record]), null);
  assert.ok(seeded.ok && seeded.value.status === "applied");
  rig.model.runModel = model.runModel.bind(model);
  const outcome = await rig.run();
  assert.equal(outcome.status, "idle", JSON.stringify(outcome));
  const state = await rig.snapshot();
  const bound = rig.configs[0].sessionBound!.maxDurationMs;
  return {
    bound,
    model,
    work: state.work.find((item) => item.id === taskId)!,
    reservations: state.reservations,
  };
}

Deno.test("session exhaustion: an interrupt at the duration bound counts one timeout", async () => {
  const bound = 240_000;
  const exhausted = await runOnce(
    new FakeModel({ outcome: "interrupted", durationMs: bound }),
  );
  assert.equal(exhausted.bound, bound, "fixture session bound");
  assert.equal(exhausted.model.requests.length, 1);
  assert.equal(exhausted.work.nextStep, "blocked");
  assert.equal(
    exhausted.work.counters.timeouts,
    1,
    "the exhausted session counts toward decomposition",
  );
  assert.equal(exhausted.reservations[0].outcome, "ambiguous", "charged");

  // An early interrupt or an ordinary failure is not a time-bound exhaustion.
  for (
    const model of [
      new FakeModel({ outcome: "interrupted", durationMs: bound - 1 }),
      new FakeModel({ outcome: "failed", durationMs: bound }),
    ]
  ) {
    const other = await runOnce(model);
    assert.equal(other.work.nextStep, "blocked");
    assert.equal(other.work.counters.timeouts, undefined);
  }
});
