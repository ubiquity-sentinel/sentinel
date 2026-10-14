/** Shared credential-free hosted test fixtures; this module registers no tests. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type {
  CandidateHandoffObservationV1,
  CandidateHandoffScenarioV1,
} from "./candidate-handoff-worker.ts";
import {
  ROOT,
  TRUSTED_PATH,
  WORKER_PATH,
} from "./candidate-handoff-fixture.ts";

/** Start the fresh-process worker exactly like the original fixture does. */
export async function runHandoffWorker(
  scenario: CandidateHandoffScenarioV1,
): Promise<CandidateHandoffObservationV1> {
  const childProcess = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env=HOME,PATH,NODE_V8_COVERAGE",
      WORKER_PATH,
    ],
    cwd: ROOT,
    clearEnv: true,
    env: {
      PATH: TRUSTED_PATH,
      HOME: scenario.childScratch,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stdin = childProcess.stdin.getWriter();
  await stdin.write(new TextEncoder().encode(JSON.stringify(scenario)));
  await stdin.close();
  const childResult = await childProcess.output();
  const stderr = new TextDecoder().decode(childResult.stderr);
  const stdout = new TextDecoder().decode(childResult.stdout);
  const observationText = await Deno.readTextFile(scenario.observationPath)
    .catch(
      () => null,
    );
  if (observationText === null) {
    assert.fail(
      `candidate-handoff worker produced no observation ` +
        `(code=${childResult.code}, stderr=${stderr}, stdout=${stdout})`,
    );
  }
  const observation = JSON.parse(
    observationText,
  ) as CandidateHandoffObservationV1;
  if (observation.workerError !== null) {
    assert.fail(
      `candidate-handoff worker failed before observing production: ` +
        `${observation.workerError}; stderr=${stderr}`,
    );
  }
  return observation;
}

/** The full fresh-child endpoint: H1 published, B1 integrated, reviewed. */
export function assertFreshChildCompletion(input: {
  observation: CandidateHandoffObservationV1;
  h1: GitSha;
  h0: GitSha;
  b1: GitSha;
  reservationsBefore: readonly BudgetReservationV1[];
  workId: string;
  context: string;
}): void {
  const { observation, h1, h0, b1, reservationsBefore, workId, context } =
    input;
  assert.equal(
    observation.baseFetchOk,
    true,
    `the fresh child must load the moved base B1 before recovery; ${context}`,
  );
  assert.equal(
    observation.fetchedBase,
    b1,
    `the fetched base ref must be exactly B1; ${context}`,
  );
  assert.equal(
    observation.h1AbsentBeforeRestore,
    true,
    `H1 must be absent before the real restorer runs; ${context}`,
  );
  assert.equal(
    observation.restore.ok,
    true,
    `H1 must be restorable in the fresh object store; ${context}`,
  );
  assert.equal(
    observation.h1ObjectPresent,
    true,
    `H1 objects must be present in the fresh object store; ${context}`,
  );
  assert.equal(
    observation.modelCalls,
    0,
    `zero new implementation calls are allowed; ${context}`,
  );
  assert.equal(
    observation.staleReviewAttempts,
    0,
    `no review attempt may target an unpublished head; ${context}`,
  );
  assert.notEqual(
    observation.publishedHead,
    h0,
    `H1 must be published to the owned branch; ${context}`,
  );
  assert.notEqual(
    observation.publishedHead,
    null,
    `a published head is required; ${context}`,
  );
  assert.equal(
    observation.reviewedHead,
    observation.publishedHead,
    `the reviewed head must be the published head; ${context}`,
  );
  assert.equal(
    observation.reviewedHeadH1Ancestor,
    true,
    `H1 must be an ancestor of the reviewed head (${h1}); ${context}`,
  );
  assert.equal(
    observation.reviewedHeadB1Ancestor,
    true,
    `B1 must be an ancestor of the reviewed head; ${context}`,
  );
  assert.equal(
    observation.targetBase,
    b1,
    `the durable target base must advance to B1; ${context}`,
  );
  assert.equal(
    observation.targetHead,
    observation.publishedHead,
    `the durable target head must be the published head; ${context}`,
  );
  assert.equal(
    observation.targetNextStep,
    "review",
    `the endpoint is fresh-review admission on the refreshed head; ${context}`,
  );
  assert.equal(
    observation.reservations.length,
    reservationsBefore.length + 1,
    `exactly one new reservation is permitted; ${context}`,
  );
  for (const parentReservation of reservationsBefore) {
    const unchanged = observation.reservations.find((entry) =>
      entry.id === parentReservation.id
    );
    assert.ok(
      unchanged !== undefined,
      `reservation ${parentReservation.id} must survive; ${context}`,
    );
    assert.deepEqual(
      unchanged,
      parentReservation,
      `reservation ${parentReservation.id} must remain byte-identical; ` +
        context,
    );
  }
  const addedReservations = observation.reservations.filter((entry) =>
    !reservationsBefore.some((parentReservation) =>
      parentReservation.id === entry.id
    )
  );
  assert.equal(
    addedReservations.length,
    1,
    `exactly one additional reservation is permitted; ${context}`,
  );
  assert.equal(
    addedReservations[0]!.taskId,
    workId,
    `the additional reservation must belong to this task; ${context}`,
  );
  assert.equal(
    addedReservations[0]!.purpose,
    "review_request",
    `no new implementation reservation is permitted; ${context}`,
  );
  assert.equal(
    addedReservations[0]!.head,
    observation.reviewedHead,
    `the review reservation must bind the reviewed head; ${context}`,
  );
  assert.equal(
    addedReservations[0]!.outcome,
    "submitted",
    `the additional reservation must be submitted; ${context}`,
  );
  assert.equal(
    observation.reviewSubmissions.length,
    1,
    `exactly one actual review submission is required; ${context}`,
  );
  const submission = observation.reviewSubmissions[0]!;
  assert.equal(
    submission.expectedHead,
    observation.publishedHead,
    `the review request must bind the published head; ${context}`,
  );
  assert.equal(
    submission.expectedBase,
    b1,
    `the review request must bind B1; ${context}`,
  );
  assert.equal(
    submission.accepted,
    true,
    `the only review submission must be accepted; ${context}`,
  );
}
