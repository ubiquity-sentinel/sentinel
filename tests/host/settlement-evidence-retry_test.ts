/**
 * The host settlement loop retries a metadata refusal that never spent the
 * reader's bounded re-read window; only a spent window suppresses its retries.
 */
import assert from "node:assert/strict";
import { hostedExecutionMetadataError } from "../../src/github/client-hosted-policy.ts";
import { readSettlement } from "../../src/host/actions-supervisor-state.ts";
import type {
  HostedSupervisorEvidencePortV1,
  HostedSupervisorInputV1,
} from "../../src/host/actions-supervisor-types.ts";
import {
  ATTEMPT_PATH,
  attemptBody,
  intent,
  iso,
  JOB_FINISHED,
  JOB_STARTED,
  jobBody,
  JOBS_PATH,
  jobsBody,
  logText,
  makeRig,
  OBSERVED,
  response,
  RUN_ATTEMPT,
  RUN_ID,
  runtimeStep,
  scriptLog,
  STEP_FINISHED,
  STEP_STARTED,
  terminalRecord,
} from "../github/hosted-execution-helpers.ts";

function supervisorInput(
  readExecution: HostedSupervisorEvidencePortV1["readExecution"],
  clock: HostedSupervisorInputV1["clock"] = { now: () => 1_000 },
): HostedSupervisorInputV1 {
  return {
    clock,
    state: {},
    run: {
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      launcherSha: intent().launcherSha,
    },
    evidence: { readExecution },
  } as unknown as HostedSupervisorInputV1;
}

Deno.test("hosted settlement: an incomplete jobs listing before the reader window is retried", async () => {
  const rig = makeRig();
  let jobsReads = 0;
  rig.http.on("GET", ATTEMPT_PATH, () => response(200, attemptBody()));
  rig.http.on("GET", JOBS_PATH, () => {
    jobsReads++;
    // The first page is transiently short: GitHub reports two jobs but has
    // published only one. The host's existing attempt re-reads and settles it.
    return response(
      200,
      jobsReads === 1 ? jobsBody([jobBody()], 2) : jobsBody([jobBody()]),
    );
  });
  scriptLog(rig, logText([terminalRecord()]));
  const input = supervisorInput(
    (saved) => rig.client.readHostedExecution(saved),
    rig.clock,
  );

  const result = await readSettlement(input, intent(), {
    retryPause: (ms) => {
      rig.clock.advance(ms);
      return Promise.resolve();
    },
  });
  assert.equal(result.ok, true);
  assert.equal(jobsReads, 2);
});

Deno.test("hosted settlement: a spent metadata window is not multiplied by the host retry loop", async () => {
  let reads = 0;
  const input = supervisorInput(() => {
    reads++;
    return Promise.resolve(hostedExecutionMetadataError(true));
  });

  const result = await readSettlement(input, intent());
  assert.equal(reads, 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome.status, "pending");
    if (result.outcome.status !== "pending") return;
    assert.match(result.outcome.detail, /hosted execution metadata is invalid/);
  }
});

Deno.test("hosted settlement: +3600s platform skew settles immediately on the unchanged runner clock", async () => {
  const skew = 3_600_000;
  const rig = makeRig();
  rig.http.on("GET", ATTEMPT_PATH, () =>
    response(200, {
      ...attemptBody({ updatedAt: OBSERVED + skew }),
      run_started_at: iso(JOB_STARTED + skew),
    }, { date: new Date(OBSERVED).toUTCString() }));
  rig.http.on("GET", JOBS_PATH, () =>
    response(
      200,
      jobsBody([jobBody({
        startedAt: JOB_STARTED + skew,
        completedAt: JOB_FINISHED + skew,
        steps: [runtimeStep({
          started_at: iso(STEP_STARTED + skew),
          completed_at: iso(STEP_FINISHED + skew),
        })],
      })]),
    ));
  scriptLog(rig, logText([terminalRecord()]));
  const input = supervisorInput(
    (saved) => rig.client.readHostedExecution(saved),
    rig.clock,
  );
  const result = await readSettlement(input, intent(), {
    retryPause: () => {
      throw new Error("clock skew must not require a retry");
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.settlement.outcome, "healthy");
  assert.equal(result.settlement.observedAt, OBSERVED);
  assert.equal(rig.clock.now(), OBSERVED);
  assert.equal(rig.http.callsTo(ATTEMPT_PATH).length, 1);
});
