/** Full-statement review eligibility must be proved before implementation spend. */
import assert from "node:assert/strict";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { ISSUE_PREREQUISITE_RETRY_MS } from "../../src/repair/loop-bounds.ts";
import { portError } from "../../src/contracts/ports.ts";
import { reservation, SHA1, T0 } from "../state/helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import { freshIssue } from "../host/matrix-runtime-fixtures.ts";
import { r80Available, withR80Parsers } from "../host/r80-contracts.ts";

Deno.test("issue body admission: ordinary loop retains an oversized statement and its existing charge", async (t) => {
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  const body = "u".repeat(16_385);
  const large = issueRecord(1, {
    body,
    relations: { openBlockers: [], subIssueCount: 0 },
  });
  github.listed = [large];
  github.latest.set(1, large);
  const rig = makeMemoryRig(github);
  const initial = {
    ...freshIssue(1, SHA1),
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
  };
  const priorCharge = reservation("prior-charge", {
    taskId: initial.id,
    outcome: "ambiguous",
    settledAt: T0,
  });
  const seeded = await rig.state.writeRepair(
    seededSnapshot([initial], { reservations: [priorCharge] }),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  await rig.run();
  const state = parseRepairStateSnapshotV1(
    JSON.parse(JSON.stringify(await rig.snapshot())),
  );
  const record = state.work[0];
  assert.equal(record.nextStep, "work");
  assert.equal(record.intent, null);
  assert.deepEqual(record.source, initial.source);
  assert.equal(record.counters.attempts, initial.counters.attempts);
  assert.equal(record.counters.retries, initial.counters.retries);
  assert.equal(record.counters.reviewRounds, initial.counters.reviewRounds);
  assert.deepEqual(record.wait, {
    reason: "unavailable",
    since: rig.clock.now(),
    until: rig.clock.now() + ISSUE_PREREQUISITE_RETRY_MS,
  });
  assert.deepEqual(
    state.reservations,
    [priorCharge],
    "historical charges are retained, no unsupported start is reserved",
  );
  assert.equal(rig.model.requests.length, 0);
  const reads = github.calls.filter((call) => call === "readIssue:1").length;
  const sequence = state.sequence;
  rig.clock.advance(ISSUE_PREREQUISITE_RETRY_MS - 1);
  await rig.run();
  assert.equal(
    (await rig.snapshot()).sequence,
    sequence,
    "the bounded wait is not rewritten while active",
  );
  assert.equal(
    github.calls.filter((call) => call === "readIssue:1").length,
    reads,
  );
  rig.clock.advance(1);
  await rig.run();
  const retried = await rig.snapshot();
  assert.equal(
    retried.work[0].wait?.until,
    rig.clock.now() + ISSUE_PREREQUISITE_RETRY_MS,
  );
  assert.deepEqual(retried.reservations, [priorCharge]);
  assert.equal(rig.model.requests.length, 0);
  // A source edit can recover normally after the next wait; it is never dropped.
  github.latest.set(1, { ...large, body: "x".repeat(16_384) });
  rig.clock.advance(ISSUE_PREREQUISITE_RETRY_MS);
  rig.model.runModel = (request) => {
    rig.model.requests.push(request);
    return Promise.resolve(
      portError("unavailable", "synthetic model terminal"),
    );
  };
  await rig.run();
  const recovered = await rig.snapshot();
  assert.equal(
    rig.model.requests.length,
    1,
    "the exact review boundary remains eligible",
  );
  assert.equal(rig.model.requests[0].issue?.body.length, 16_384);
  assert.equal(recovered.reservations.length, 2);
  assert.deepEqual(recovered.reservations[0], priorCharge);
  await t.step({
    name: "frozen R80 parser accepts all emitted ordinary states",
    ignore: !await r80Available(),
    fn: async () => {
      await withR80Parsers((parsers) => {
        for (const emitted of [state, retried, recovered]) {
          assert.deepEqual(
            parsers.parseRepairStateSnapshotV1(emitted),
            emitted,
          );
        }
      });
    },
  });
});

Deno.test("issue body admission: unsupported ordinary work cannot starve a normal issue", async () => {
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  for (const [number, length] of [[1, 23_807], [2, 16_384]]) {
    const row = issueRecord(number, {
      body: "x".repeat(length),
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    github.listed.push(row);
    github.latest.set(number, row);
  }
  const rig = makeMemoryRig(github);
  rig.model.runModel = (request) => {
    rig.model.requests.push(request);
    return Promise.resolve(
      portError("unavailable", "synthetic model terminal"),
    );
  };
  await rig.run();
  const state = await rig.snapshot();
  const unsupported = state.work.find((row) => row.related.issueNumber === 1)!;
  assert.equal(unsupported.wait?.reason, "unavailable");
  assert.equal(unsupported.counters.attempts, 0);
  assert.equal(unsupported.intent, null);
  assert.equal(rig.model.requests.length, 1);
  assert.equal(rig.model.requests[0].issue?.number, 2);
  assert.equal(state.reservations.length, 1);
  assert.ok(
    state.reservations.every((charge) => charge.taskId !== unsupported.id),
  );
  assert.deepEqual(
    parseRepairStateSnapshotV1(JSON.parse(JSON.stringify(state))),
    state,
  );
});
