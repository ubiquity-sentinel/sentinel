import assert from "node:assert/strict";
import {
  attemptBody,
  intent,
  iso,
  jobBody,
  jobsBody,
  logText,
  makeRig,
  runtimeStep,
  scriptAttemptAndJobs,
  scriptLog,
  settlementProof,
  T0,
  TERM_FINISHED,
  terminalRecord,
} from "./hosted-execution-helpers.ts";

const STEP_FINISHED = T0 + 4_000;
const JOB_FINISHED = T0 + 5_000;
const OBSERVED = T0 + 6_000;

function delayedLogRig(
  logAt = TERM_FINISHED + 1_227,
  stepFinished = STEP_FINISHED,
  observed = OBSERVED,
) {
  const rig = makeRig(observed);
  scriptAttemptAndJobs(
    rig,
    attemptBody({ updatedAt: JOB_FINISHED }),
    jobsBody([
      jobBody({
        completedAt: JOB_FINISHED,
        steps: [runtimeStep({ completed_at: iso(stepFinished) })],
      }),
    ]),
  );
  scriptLog(rig, logText([terminalRecord()], logAt));
  return rig;
}

Deno.test("hosted execution: authenticated log emission 1227 ms after runtime finish settles", async () => {
  // The generation-83 bootstrap emitted at finish + 1227 ms. Emission delay
  // is independent of clock skew and remains inside the authenticated step.
  const rig = delayedLogRig();
  const proof = settlementProof(await rig.client.readHostedExecution(intent()));
  assert.equal(proof.outcome, "healthy");
  assert.deepEqual(proof.execution, intent());
  assert.equal(proof.terminalAt, TERM_FINISHED + 1_227);
  assert.equal(proof.finishedAt, JOB_FINISHED);
});

Deno.test("hosted execution: delayed emission retains native step job and observation bounds", async (t) => {
  await t.step(
    "native second precision admits the final millisecond",
    async () => {
      const rig = delayedLogRig(STEP_FINISHED + 999);
      assert.equal(
        settlementProof(await rig.client.readHostedExecution(intent())).outcome,
        "healthy",
      );
    },
  );
  const refused = [
    {
      name: "after the native step",
      rig: delayedLogRig(STEP_FINISHED + 1_000),
    },
    {
      name: "after the native job",
      rig: delayedLogRig(JOB_FINISHED + 1_000, JOB_FINISHED + 500),
    },
    {
      name: "after the observation",
      rig: delayedLogRig(JOB_FINISHED + 500, JOB_FINISHED, JOB_FINISHED - 500),
    },
    {
      name: "before runtime finish beyond clock tolerance",
      rig: delayedLogRig(TERM_FINISHED - 1_000),
    },
  ];
  for (const control of refused) {
    await t.step(control.name, async () => {
      const result = await control.rig.client.readHostedExecution(intent());
      assert.equal(result.ok, false);
    });
  }
});
