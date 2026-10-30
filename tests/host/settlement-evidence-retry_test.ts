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
  jobBody,
  JOBS_PATH,
  jobsBody,
  logText,
  makeRig,
  response,
  RUN_ATTEMPT,
  RUN_ID,
  scriptLog,
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
