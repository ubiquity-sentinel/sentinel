/** Platform metadata may lead the observer/runner clock during a DST change. */
import assert from "node:assert/strict";
import { parseHostedRunProofV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  attemptBody,
  intent,
  iso,
  JOB_FINISHED,
  JOB_STARTED,
  jobBody,
  jobsBody,
  logText,
  makeRig,
  OBSERVED,
  runtimeStep,
  scriptAttemptAndJobs,
  scriptLog,
  settlementProof,
  STEP_FINISHED,
  STEP_STARTED,
  terminalRecord,
} from "./hosted-execution-helpers.ts";

const DST_SKEW_MS = 3_600_000;

function platformJob(overrides: Parameters<typeof jobBody>[0] = {}) {
  return jobBody({
    startedAt: JOB_STARTED + DST_SKEW_MS,
    completedAt: JOB_FINISHED + DST_SKEW_MS,
    steps: [runtimeStep({
      started_at: iso(STEP_STARTED + DST_SKEW_MS),
      completed_at: iso(STEP_FINISHED + DST_SKEW_MS),
    })],
    ...overrides,
  });
}

Deno.test("hosted execution: +3600s platform skew settles without advancing the local clock", async (t) => {
  for (const shiftedJobs of [false, true]) {
    await t.step(
      shiftedJobs ? "platform timeline" : "attempt update only",
      async () => {
        const rig = makeRig();
        scriptAttemptAndJobs(
          rig,
          {
            ...attemptBody({
              status: "in_progress",
              conclusion: null,
              updatedAt: OBSERVED + DST_SKEW_MS,
            }),
            run_started_at: iso(JOB_STARTED + (shiftedJobs ? DST_SKEW_MS : 0)),
          },
          jobsBody([shiftedJobs ? platformJob() : jobBody()]),
          { date: new Date(OBSERVED).toUTCString() },
        );
        // Runtime JSON and authenticated log timestamps use the runner clock,
        // not the platform's ahead-of-clock run/job/step metadata.
        scriptLog(rig, logText([terminalRecord()]));
        const proof = settlementProof(
          await rig.client.readHostedExecution(intent()),
        );
        assert.equal(proof.outcome, "healthy");
        assert.equal(
          proof.startedAt,
          JOB_STARTED + (shiftedJobs ? DST_SKEW_MS : 0),
        );
        assert.equal(
          proof.finishedAt,
          JOB_FINISHED + (shiftedJobs ? DST_SKEW_MS : 0),
        );
        assert.equal(proof.observedAt, OBSERVED);
        assert.deepEqual(parseHostedRunProofV1(proof), proof);
        assert.equal(rig.clock.now(), OBSERVED);
      },
    );
  }
});

Deno.test("hosted execution: +3600s platform skew preserves failed and not-started settlement", async (t) => {
  for (const conclusion of ["failure", "skipped"] as const) {
    await t.step(conclusion, async () => {
      const rig = makeRig();
      scriptAttemptAndJobs(
        rig,
        attemptBody({ updatedAt: OBSERVED + DST_SKEW_MS }),
        jobsBody([platformJob({
          conclusion,
          steps: [runtimeStep({
            conclusion,
            started_at: iso(STEP_STARTED + DST_SKEW_MS),
            completed_at: iso(STEP_FINISHED + DST_SKEW_MS),
          })],
        })]),
      );
      if (conclusion === "failure") {
        scriptLog(rig, "runtime exited without a terminal\n");
      }
      const result = await rig.client.readHostedExecution(intent());
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) return;
      assert.equal(
        result.value?.outcome,
        conclusion === "failure" ? "failed" : "not_started",
      );
      assert.equal(result.value?.observedAt, OBSERVED);
      assert.equal(rig.clock.now(), OBSERVED);
    });
  }
});

Deno.test("hosted execution: platform skew remains bounded and cannot excuse contradictory evidence", async (t) => {
  const controls = [
    {
      name: "attempt exceeds one hour plus timestamp precision",
      attempt: attemptBody({ updatedAt: OBSERVED + DST_SKEW_MS + 1_000 }),
    },
    {
      name: "job exceeds one hour plus timestamp precision",
      job: platformJob({ completedAt: OBSERVED + DST_SKEW_MS + 1_000 }),
    },
    {
      name: "inverted job remains invalid",
      job: platformJob({ completedAt: JOB_STARTED + DST_SKEW_MS - 1 }),
    },
    {
      name: "inverted step remains invalid",
      job: platformJob({
        steps: [runtimeStep({
          started_at: iso(STEP_FINISHED + DST_SKEW_MS + 1),
          completed_at: iso(STEP_FINISHED + DST_SKEW_MS),
        })],
      }),
    },
    {
      name: "foreign attempt remains invalid",
      attempt: attemptBody({ attempt: intent().runAttempt + 1 }),
    },
    {
      name: "runtime finish still cannot be ahead of the observer",
      log: logText([terminalRecord(intent(), {
        finishedAt: OBSERVED + 1_000,
      })], OBSERVED + 1),
    },
    {
      name: "runtime log still cannot be ahead of the observer",
      log: logText([terminalRecord()], OBSERVED + 1_000),
    },
  ];
  for (const control of controls) {
    await t.step(control.name, async () => {
      const rig = makeRig();
      scriptAttemptAndJobs(
        rig,
        control.attempt ?? attemptBody({ updatedAt: OBSERVED + DST_SKEW_MS }),
        jobsBody([control.job ?? platformJob()]),
      );
      scriptLog(rig, control.log ?? logText([terminalRecord()]));
      const result = await rig.client.readHostedExecution(intent());
      assert.equal(result.ok, false, control.name);
      assert.equal(rig.clock.now(), OBSERVED);
    });
  }
});
