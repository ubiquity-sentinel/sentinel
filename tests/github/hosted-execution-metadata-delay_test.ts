/**
 * A completed workflow run can expose its repair job before GitHub attaches the
 * runtime step and terminal metadata. The reader must re-read that exact jobs
 * page for a bounded window, then keep refusing exactly as before.
 */
import assert from "node:assert/strict";
import {
  HOSTED_EXECUTION_METADATA,
  HOSTED_EXECUTION_READ_DEADLINE_MS,
  hostedExecutionMetadataWindowExhausted,
} from "../../src/github/client-hosted-policy.ts";
import {
  ATTEMPT_PATH,
  attemptBody,
  intent,
  jobBody,
  JOBS_PATH,
  jobsBody,
  logText,
  makeRig,
  OBSERVED,
  postStep,
  response,
  runtimeStep,
  scriptAttemptAndJobs,
  scriptLog,
  settlementProof,
  terminalRecord,
} from "./hosted-execution-helpers.ts";

/** 10 waits of 10 s, then the unchanged refusal. */
const REREADS = 10;
const WAIT_MS = 10_000;

Deno.test("hosted execution: completed runtime metadata is re-read until the steps appear", async () => {
  const rig = makeRig();
  let jobsReads = 0;
  rig.http.on("GET", ATTEMPT_PATH, () => response(200, attemptBody()));
  rig.http.on("GET", JOBS_PATH, () => {
    jobsReads++;
    return response(
      200,
      jobsBody([
        jobBody({ steps: jobsReads === 1 ? [] : [runtimeStep()] }),
      ]),
    );
  });
  scriptLog(rig, logText([terminalRecord()]));

  const proof = settlementProof(await rig.client.readHostedExecution(intent()));
  assert.equal(proof.outcome, "healthy");
  assert.equal(jobsReads, 2);
  assert.equal(rig.http.callsTo(JOBS_PATH).length, 2);
  assert.equal(rig.clock.now(), OBSERVED + WAIT_MS);
  assert.equal(proof.observedAt, rig.clock.now());
});

Deno.test("hosted execution: a missing runtime step is re-read until it appears", async () => {
  const rig = makeRig();
  let jobsReads = 0;
  rig.http.on("GET", ATTEMPT_PATH, () => response(200, attemptBody()));
  rig.http.on("GET", JOBS_PATH, () => {
    jobsReads++;
    return response(
      200,
      jobsBody([
        jobBody({
          steps: jobsReads === 1 ? [postStep("Checkout")] : [
            postStep("Checkout"),
            runtimeStep(),
          ],
        }),
      ]),
    );
  });
  scriptLog(rig, logText([terminalRecord()]));

  const proof = settlementProof(await rig.client.readHostedExecution(intent()));
  assert.equal(proof.outcome, "healthy");
  assert.equal(jobsReads, 2);
  assert.equal(rig.clock.now(), OBSERVED + WAIT_MS);
});

Deno.test("hosted execution: empty runtime metadata still refuses after the re-read budget", async () => {
  const rig = makeRig();
  scriptAttemptAndJobs(rig, attemptBody(), jobsBody([jobBody({ steps: [] })]));

  const result = await rig.client.readHostedExecution(intent());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "unavailable");
    assert.equal(result.error.detail, HOSTED_EXECUTION_METADATA);
    // The budget itself ran out, so the host must not repeat this window.
    assert.equal(hostedExecutionMetadataWindowExhausted(result.error), true);
  }
  assert.equal(rig.http.callsTo(JOBS_PATH).length, REREADS + 1);
  assert.equal(rig.http.callsTo(ATTEMPT_PATH).length, 1);
  assert.equal(rig.clock.now(), OBSERVED + REREADS * WAIT_MS);
});

Deno.test("hosted execution: contradictory runtime metadata refuses without a re-read", async () => {
  const rig = makeRig();
  scriptAttemptAndJobs(
    rig,
    attemptBody(),
    jobsBody([jobBody({ headSha: "9".repeat(40), steps: [] })]),
  );

  const result = await rig.client.readHostedExecution(intent());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid");
  assert.equal(rig.http.callsTo(JOBS_PATH).length, 1);
  assert.equal(rig.clock.now(), OBSERVED);
});

Deno.test("hosted execution: the finalize job's metadata is re-read while its run is still in progress", async () => {
  const rig = makeRig();
  let jobsReads = 0;
  rig.http.on("GET", ATTEMPT_PATH, () =>
    response(
      200,
      attemptBody({ status: "in_progress", conclusion: null }),
    ));
  rig.http.on("GET", JOBS_PATH, () => {
    jobsReads++;
    return response(
      200,
      jobsBody([
        jobBody({ steps: jobsReads === 1 ? [] : [runtimeStep()] }),
      ]),
    );
  });
  scriptLog(rig, logText([terminalRecord()]));

  const proof = settlementProof(await rig.client.readHostedExecution(intent()));
  assert.equal(proof.outcome, "healthy");
  assert.equal(jobsReads, 2);
  assert.equal(rig.clock.now(), OBSERVED + WAIT_MS);
});

Deno.test("hosted execution: an incomplete first listing is not a spent metadata window", async () => {
  const rig = makeRig();
  let jobsReads = 0;
  rig.http.on("GET", ATTEMPT_PATH, () => response(200, attemptBody()));
  rig.http.on("GET", JOBS_PATH, () => {
    jobsReads++;
    // The listing itself is transiently short; the re-read loop was never
    // entered, so the host must still be allowed to retry this refusal.
    return response(200, jobsBody([jobBody()], 2));
  });

  const result = await rig.client.readHostedExecution(intent());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.detail, HOSTED_EXECUTION_METADATA);
    assert.equal(hostedExecutionMetadataWindowExhausted(result.error), false);
  }
  assert.equal(jobsReads, 1);
  assert.equal(rig.clock.now(), OBSERVED);
});

Deno.test("hosted execution: metadata waits stop at the shared read deadline", async () => {
  const rig = makeRig();
  let jobsReads = 0;
  rig.http.on("GET", ATTEMPT_PATH, () => {
    rig.clock.advance(29_000);
    return response(200, attemptBody());
  });
  rig.http.on("GET", JOBS_PATH, () => {
    jobsReads++;
    // The first listing is the second 29 s request; the following re-reads
    // are cheap, so only the waits can overrun the 120 s operation window.
    if (jobsReads === 1) rig.clock.advance(29_000);
    return response(200, jobsBody([jobBody({ steps: [] })]));
  });

  const result = await rig.client.readHostedExecution(intent());
  assert.ok(
    rig.clock.now() - OBSERVED <= HOSTED_EXECUTION_READ_DEADLINE_MS,
    `reader returned at ${rig.clock.now() - OBSERVED} ms`,
  );
  assert.equal(jobsReads, 7);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "unavailable");
    assert.equal(result.error.detail, HOSTED_EXECUTION_METADATA);
    assert.equal(hostedExecutionMetadataWindowExhausted(result.error), true);
  }
});

Deno.test("hosted execution: a completed step with lagging timestamps is re-read, not rejected", async () => {
  const rig = makeRig();
  let jobsReads = 0;
  rig.http.on("GET", ATTEMPT_PATH, () => response(200, attemptBody()));
  rig.http.on("GET", JOBS_PATH, () => {
    jobsReads++;
    // GitHub can finish a step before attaching its instants; that is lagging
    // metadata to re-read, not a contradictory record to reject outright.
    return response(
      200,
      jobsBody([
        jobBody({
          steps: [
            jobsReads === 1
              ? runtimeStep({ started_at: null, completed_at: null })
              : runtimeStep(),
          ],
        }),
      ]),
    );
  });
  scriptLog(rig, logText([terminalRecord()]));

  const proof = settlementProof(await rig.client.readHostedExecution(intent()));
  assert.equal(proof.outcome, "healthy");
  assert.equal(jobsReads, 2);
  assert.equal(rig.clock.now(), OBSERVED + WAIT_MS);
});

Deno.test("hosted execution: a repair job that vanishes from a later listing is never not_started", async () => {
  const rig = makeRig();
  let jobsReads = 0;
  rig.http.on("GET", ATTEMPT_PATH, () => response(200, attemptBody()));
  rig.http.on("GET", JOBS_PATH, () => {
    jobsReads++;
    return response(
      200,
      jobsReads === 1 ? jobsBody([jobBody({ steps: [] })]) : jobsBody([]),
    );
  });

  const result = await rig.client.readHostedExecution(intent());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "unavailable");
    assert.equal(result.error.detail, HOSTED_EXECUTION_METADATA);
    // Never rewritten as an absence proof; the host may re-read this refusal.
    assert.equal(hostedExecutionMetadataWindowExhausted(result.error), false);
  }
  assert.equal(jobsReads, 2);
  assert.equal(rig.clock.now(), OBSERVED + WAIT_MS);
});
