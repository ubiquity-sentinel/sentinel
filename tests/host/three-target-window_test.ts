import assert from "node:assert/strict";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReviewSubmissionV1 } from "../../src/contracts/ports.ts";
import { runActionsTargetCycles } from "../../src/host/actions.ts";
import {
  MATRIX_TARGET_REVIEW_LEAD_MS,
  matrixConsumerWindowV1,
} from "../../src/host/matrix-aggregate.ts";
import {
  OPERATION_MARGIN_MS,
  REVIEW_BOUND_MS,
} from "../../src/repair/loop-bounds.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { FakeGithub } from "../repair/helpers.ts";
import { SHA1, SHA3, workRecord } from "../state/helpers.ts";
import {
  makeTargetHostRig,
  targetCycleInput,
} from "./actions-target-fixture.ts";

Deno.test("target window: three production targets admit reviews inside one original 55-minute token window", async () => {
  const rig = makeTargetHostRig(["sentinel", "ai.ubq.fi", "passport.ubq.fi"]);
  await runActionsTargetCycles(targetCycleInput(rig));
  const origin = rig.clock.now();
  const deadline = origin + 55 * 60_000;
  const window = matrixConsumerWindowV1({
    now: origin,
    deadline,
    maxWaitMs: 20 * 60_000,
    targets: 3,
    reviewsMayStart: true,
  });
  assert.equal(window.until, origin + 10 * 60_000);
  assert.equal(
    window.until + 3 * MATRIX_TARGET_REVIEW_LEAD_MS + 2 * OPERATION_MARGIN_MS +
      REVIEW_BOUND_MS,
    deadline,
  );
  const ports = new Map<string, FakeGithub>();
  const submissions: ReviewSubmissionV1[] = [];
  const work = rig.configs.map((config) => {
    const id = `issue-${config.repository.owner}-${config.repository.name}-1`;
    const branch = candidateBranch(workRecord(id).id);
    const port = new FakeGithub({
      baseSha: SHA1,
      issues: [{ number: 1, title: "issue 1", body: "" }],
      reviewRequestedAt: origin,
      candidateLifecycle: {
        prepareBaseRefresh: () =>
          Promise.reject(new Error("unchanged base must not refresh")),
        refs: {
          [`refs/heads/${branch}`]: SHA3,
          [`refs/heads/${config.baseBranch}`]: SHA1,
        },
        pullRequests: [{
          number: 7,
          title: "repair",
          body: "Resolves #1",
          state: "open",
          head: SHA3,
          base: SHA1,
          mergeSha: null,
          headRef: branch,
          baseRef: config.baseBranch,
          author: "ubiquity-sentinel[bot]",
          createdAt: origin,
          updatedAt: origin,
          mergedAt: null,
          reviewDecision: "none",
        }],
      },
    });
    port.reviewStatus = "pending";
    const submit = port.requestReview.bind(port);
    port.requestReview = (request) => {
      submissions.push(request as ReviewSubmissionV1);
      return submit(request);
    };
    ports.set(config.repository.name, port);
    return workRecord(id, {
      repository: config.repository,
      source: { kind: "issue", id: "1", revision: SHA1 },
      target: { base: SHA1, head: SHA3, branch, checkpoint: null, pr: 7 },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    });
  });
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  const seeded = await rig.state.writeRepair(
    parseRepairStateSnapshotV1({
      ...read.value.snapshot,
      stateHead: read.value.head,
      sequence: read.value.snapshot.sequence + 1,
      updatedAt: origin,
      work,
    }),
    read.value.head,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  await runActionsTargetCycles(targetCycleInput(rig, {
    runOrigin: origin,
    deadline,
    modelStartsEnabled: true,
    prepareTarget: () => {
      rig.clock.advance(MATRIX_TARGET_REVIEW_LEAD_MS);
      return Promise.resolve();
    },
    composeGithub: (config) => ports.get(config.repository.name)!,
  }));
  assert.equal(submissions.length, 3);
  for (const request of submissions) {
    assert.equal(
      request.latestStartAt,
      deadline - 2 * OPERATION_MARGIN_MS - REVIEW_BOUND_MS,
    );
    assert.equal(request.settleBy, request.latestStartAt + REVIEW_BOUND_MS);
  }
  for (const port of ports.values()) {
    assert.equal(port.drains.length, 1);
    assert.equal(port.drains[0].deadline, deadline);
  }
  const after = await rig.state.readRepair();
  assert.ok(after.ok && after.value.status === "found");
  assert.equal(after.value.snapshot.reservations.length, 3);
  assert.equal(
    new Set(after.value.snapshot.reservations.map((row) => row.repository.name))
      .size,
    3,
  );
});
