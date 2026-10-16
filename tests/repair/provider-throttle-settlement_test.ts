/** The serial receipt consumer settles a pure 429 as transient throttling. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import {
  type ModelRunReceiptV1,
  type ModelRunRequestV1,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { SHA1, workRecord } from "../state/helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";

function failedReceipt(error: string): ModelRunReceiptV1 {
  return {
    invocationId: "codex-serial-1",
    outcome: "failed",
    actual: {
      evidenceKind: "request-runtime",
      provider: "sentinel-host",
      threadId: "thread-1",
      turnId: "turn-1",
      terminalOrigin: "runtime",
      observedTerminalStatus: "failed",
      observedModel: "gpt-6-luna",
      observedReasoning: "max",
      durationMs: 450,
      outputChars: 9_455,
    },
    candidate: null,
    error,
  };
}

async function settle(error: string) {
  const sourceIssue = issueRecord(43, {
    title: "throttled task",
    relations: { openBlockers: [], subIssueCount: 0 },
  });
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  github.listed = [sourceIssue];
  github.latest.set(43, sourceIssue);
  const rig = makeMemoryRig(github);
  const taskId = asWorkItemId("issue-43");
  const record = workRecord("issue-43", {
    source: { kind: "issue", id: "43", revision: SHA1 },
    related: { incidentId: null, issueNumber: 43 },
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
  const requests: ModelRunRequestV1[] = [];
  rig.model.runModel = (
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> => {
    requests.push(request);
    return Promise.resolve(portOk(failedReceipt(error)));
  };
  const outcome = await rig.run();
  assert.equal(outcome.status, "idle", JSON.stringify(outcome));
  const state = await rig.snapshot();
  return {
    requests,
    work: state.work.find((item) => item.id === taskId)!,
    reservations: state.reservations,
    entries: state.attemptMemory.flatMap((memory) => memory.entries),
  };
}

Deno.test("serial 429: a throttled failed receipt settles as transient throttling", async () => {
  const throttled = await settle(
    "exceeded retry limit, last status: 429 Too Many Requests",
  );
  assert.equal(throttled.requests.length, 1, "one model session");
  assert.equal(throttled.work.nextStep, "blocked");
  assert.equal(
    throttled.work.blocker?.message,
    "model run failed (unavailable)",
  );
  assert.equal(throttled.reservations.length, 1);
  assert.equal(throttled.reservations[0].outcome, "ambiguous", "charged");
  assert.equal(throttled.entries.length, 1);
  assert.equal(throttled.entries[0].stage, "model");
  assert.equal(throttled.entries[0].failureClass, "transient_infrastructure");
  assert.equal(throttled.work.counters.timeouts, undefined);
});

Deno.test("serial 429: any other failed receipt keeps its no-progress settlement", async () => {
  const other = await settle("synthetic failure");
  assert.equal(other.work.nextStep, "blocked");
  assert.equal(
    other.work.blocker?.message,
    "model run did not complete with a trusted candidate",
  );
  assert.equal(other.reservations[0].outcome, "ambiguous");
  assert.equal(other.entries[0].failureClass, "semantic_no_progress");
});
