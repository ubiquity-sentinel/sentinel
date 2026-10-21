/**
 * Authenticated hosted execution reader: REAL GitHubApiClient public methods
 * over a scripted in-memory transport, with the actual GitHub API wire shapes
 * (attempt/jobs/log redirect/log lines). No network, model, token or Git.
 */
import assert from "node:assert/strict";
import { MaxText, tryParse } from "../../src/contracts/validation.ts";
import { parseHostedRuntimeTerminalV1 } from "../../src/contracts/hosted-execution.ts";
import { parseHostedRunProofV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  API_BASE,
  attemptBody,
  intent,
  iso,
  JOB_FINISHED,
  JOB_ID,
  JOB_LOG_PATH,
  JOB_STARTED,
  jobBody,
  JOBS_PATH,
  jobsBody,
  LAUNCHER,
  logText,
  makeRig,
  OBSERVED,
  postStep,
  response,
  REVISION,
  type RigV1,
  RUN_ATTEMPT,
  RUN_ID,
  runtimeStep,
  scriptAttemptAndJobs,
  scriptLog,
  settlementProof,
  SIGNED_PATH,
  STEP_FINISHED,
  T0,
  TERM_AT,
  TERM_FINISHED,
  TERM_STARTED,
  terminalRecord,
} from "./hosted-execution-helpers.ts";

Deno.test("hosted execution: healthy finalizer settles while the attempt is in_progress", async () => {
  const rig = makeRig();
  scriptAttemptAndJobs(
    rig,
    attemptBody({ status: "in_progress", conclusion: null }),
    jobsBody([jobBody()]),
  );
  scriptLog(rig, logText([terminalRecord()]));
  const proof = settlementProof(await rig.client.readHostedExecution(intent()));
  assert.equal(proof.outcome, "healthy");
  assert.equal(proof.execution.id, intent().id);
  assert.equal(proof.jobId, JOB_ID);
  assert.equal(proof.startupReady, true);
  assert.equal(proof.baseSha, LAUNCHER);
  assert.equal(proof.terminalAt, TERM_AT);
  assert.equal(proof.startedAt, JOB_STARTED);
  assert.equal(proof.finishedAt, JOB_FINISHED);
  assert.equal(proof.logDigest.length, 64);
  // The signed blob read is token-free and never follows a redirect.
  const signed = rig.http.callsTo(SIGNED_PATH);
  assert.equal(signed.length, 1);
  assert.equal(signed[0].headers.size, 0);
  assert.equal(signed[0].redirect, "error");
  assert.ok(rig.gate.admissions.length >= 1);
});

Deno.test("hosted execution: real pinned post-action step names do not exceed the runtime step-name bound", async () => {
  const rig = makeRig();
  scriptAttemptAndJobs(
    rig,
    attemptBody({ status: "in_progress", conclusion: null }),
    jobsBody([
      jobBody({
        steps: [
          runtimeStep(),
          postStep(
            "Post Run actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
          ),
          postStep(
            "Post Run denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed",
          ),
        ],
      }),
    ]),
  );
  scriptLog(rig, logText([terminalRecord()]));
  const proof = settlementProof(await rig.client.readHostedExecution(intent()));
  assert.equal(proof.outcome, "healthy");
  assert.equal(proof.jobId, JOB_ID);
  assert.equal(proof.terminalAt, TERM_AT);

  // The bound is still enforced: one character over MaxText.path is refused.
  const over = makeRig();
  scriptAttemptAndJobs(
    over,
    attemptBody({ status: "in_progress", conclusion: null }),
    jobsBody([
      jobBody({
        steps: [runtimeStep(), postStep("x".repeat(MaxText.path + 1))],
      }),
    ]),
  );
  scriptLog(over, logText([terminalRecord()]));
  assert.equal((await over.client.readHostedExecution(intent())).ok, false);
});

Deno.test("hosted execution: an explicit failed terminal or failed job is a failed proof, never healthy", async () => {
  const failedTerminal = makeRig();
  scriptAttemptAndJobs(failedTerminal, attemptBody(), jobsBody([jobBody()]));
  scriptLog(
    failedTerminal,
    logText([
      terminalRecord(intent(), {
        outcome: "failed",
        startupReady: false,
        baseSha: null,
      }),
    ]),
  );
  const explicit = settlementProof(
    await failedTerminal.client.readHostedExecution(intent()),
  );
  assert.equal(explicit.outcome, "failed");
  assert.equal(explicit.startupReady, false);
  assert.equal(explicit.baseSha, null);

  const failedJob = makeRig();
  scriptAttemptAndJobs(
    failedJob,
    attemptBody(),
    jobsBody([
      jobBody({
        conclusion: "failure",
        steps: [runtimeStep({ conclusion: "failure" })],
      }),
    ]),
  );
  scriptLog(
    failedJob,
    logText([
      terminalRecord(intent(), {
        outcome: "failed",
        startupReady: false,
        baseSha: null,
      }),
    ]),
  );
  const jobFailed = settlementProof(
    await failedJob.client.readHostedExecution(intent()),
  );
  assert.equal(jobFailed.outcome, "failed");

  // A healthy terminal with a failed job is contradictory, never rewritten.
  const mixed = makeRig();
  scriptAttemptAndJobs(
    mixed,
    attemptBody(),
    jobsBody([jobBody({ conclusion: "failure" })]),
  );
  scriptLog(mixed, logText([terminalRecord()]));
  assert.equal(
    (await mixed.client.readHostedExecution(intent())).ok,
    false,
  );

  // The same contradiction with a failed runtime step and healthy terminal.
  const stepMixed = makeRig();
  scriptAttemptAndJobs(
    stepMixed,
    attemptBody(),
    jobsBody([jobBody({ steps: [runtimeStep({ conclusion: "failure" })] })]),
  );
  scriptLog(stepMixed, logText([terminalRecord()]));
  assert.equal(
    (await stepMixed.client.readHostedExecution(intent())).ok,
    false,
  );
});

Deno.test("hosted execution: a started runtime step that concluded failure with no terminal settles as failed, never stranded", async () => {
  // The real 2026-09-20 case: the gateway was unreachable, the child runtime
  // step started and then exited non-zero BEFORE it could publish a
  // `hosted_runtime_terminal` line. The attempt and job are completed, so no
  // later observation can ever produce a terminal. Returning unavailable here
  // strands the pointer's saved execution forever and the supervisor can never
  // advance; the honest, observable settlement is an explicit failure.
  const stranded = makeRig();
  scriptAttemptAndJobs(
    stranded,
    attemptBody(),
    jobsBody([
      jobBody({
        conclusion: "failure",
        steps: [runtimeStep({ conclusion: "failure" })],
      }),
    ]),
  );
  scriptLog(
    stranded,
    "2026-09-20T10:23:05.4041704Z hosted runtime result is unavailable\n",
  );
  const proof = settlementProof(
    await stranded.client.readHostedExecution(intent()),
  );
  assert.equal(proof.outcome, "failed");
  assert.equal(proof.startupReady, false);
  assert.equal(proof.baseSha, null);
  assert.equal(proof.settled, true);
  assert.equal(proof.jobId, JOB_ID);
  assert.equal(proof.logDigest.length, 64);

  // A successful runtime step with no terminal stays unavailable: nothing
  // observable failed, so there is no honest failed settlement to publish.
  const contradictory = makeRig();
  scriptAttemptAndJobs(
    contradictory,
    attemptBody(),
    jobsBody([jobBody({ steps: [runtimeStep()] })]),
  );
  scriptLog(contradictory, "2026-09-20T10:23:05.4041704Z nothing to see\n");
  assert.equal(
    (await contradictory.client.readHostedExecution(intent())).ok,
    false,
  );
});

Deno.test("hosted execution: failed job with a started cancelled runtime step settles only without a terminal", async (t) => {
  const interruptedLog = `${
    iso(STEP_FINISHED)
  } ##[error]The runner has received a shutdown signal.\n`;
  const stranded = makeRig();
  scriptAttemptAndJobs(
    stranded,
    attemptBody({ conclusion: "failure" }),
    jobsBody([
      jobBody({
        conclusion: "failure",
        steps: [runtimeStep({ number: 10, conclusion: "cancelled" })],
      }),
    ]),
  );
  scriptLog(stranded, interruptedLog);
  const proof = settlementProof(
    await stranded.client.readHostedExecution(intent()),
  );
  assert.deepEqual(proof.execution, intent());
  assert.equal(proof.outcome, "failed");
  assert.equal(proof.startupReady, false);
  assert.equal(proof.baseSha, null);
  assert.equal(proof.settled, true);
  assert.equal(proof.jobId, JOB_ID);
  assert.equal(proof.startedAt, JOB_STARTED);
  assert.equal(proof.finishedAt, JOB_FINISHED);
  assert.equal(proof.terminalAt, STEP_FINISHED);
  assert.equal(
    proof.logDigest,
    [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(interruptedLog),
        ),
      ),
    ].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );

  const controls: Array<{
    name: string;
    attempt?: Parameters<typeof attemptBody>[0];
    job?: Parameters<typeof jobBody>[0];
    step?: Record<string, unknown>;
    sibling?: Parameters<typeof jobBody>[0];
    log?: string;
    location?: string;
  }> = [
    { name: "successful job", job: { conclusion: "success" } },
    {
      name: "unfinished attempt",
      attempt: { status: "in_progress", conclusion: null },
    },
    {
      name: "unfinished native cell",
      sibling: { status: "in_progress", conclusion: null },
    },
    { name: "foreign launcher", job: { headSha: REVISION } },
    { name: "foreign attempt", job: { attempt: RUN_ATTEMPT + 1 } },
    { name: "missing step start", step: { started_at: null } },
    { name: "inverted step", step: { started_at: iso(STEP_FINISHED + 1) } },
    { name: "future step", step: { completed_at: iso(OBSERVED + 60_000) } },
    { name: "healthy terminal", log: logText([terminalRecord()]) },
    {
      name: "failed terminal",
      log: logText([
        terminalRecord(intent(), {
          outcome: "failed",
          startupReady: false,
          baseSha: null,
        }),
      ]),
    },
    {
      name: "malformed terminal",
      log: `${iso(TERM_AT)} {"kind":"hosted_runtime_terminal","execution":\n`,
    },
    { name: "untrusted log", location: "https://evil.example/log" },
  ];
  for (const control of controls) {
    await t.step(control.name, async () => {
      const rig = makeRig();
      const jobs = [jobBody({
        conclusion: "failure",
        ...control.job,
        steps: [
          runtimeStep({ number: 10, conclusion: "cancelled", ...control.step }),
        ],
      })];
      if (control.sibling) {
        jobs.push(
          jobBody({
            id: JOB_ID + 1,
            name: "matrix_cell (fixture)",
            ...control.sibling,
          }),
        );
      }
      scriptAttemptAndJobs(
        rig,
        attemptBody({ conclusion: "failure", ...control.attempt }),
        jobsBody(jobs),
      );
      scriptLog(rig, control.log ?? interruptedLog, control.location);
      assert.equal(
        (await rig.client.readHostedExecution(intent())).ok,
        false,
        control.name,
      );
    });
  }
});

Deno.test("hosted execution: completed/skipped repair with inverted provider timestamps still settles not_started", async () => {
  const rig = makeRig();
  scriptAttemptAndJobs(
    rig,
    attemptBody(),
    jobsBody([
      jobBody({
        conclusion: "skipped",
        startedAt: JOB_FINISHED + 1000,
        completedAt: JOB_FINISHED,
        steps: [],
      }),
    ]),
  );
  const result = await rig.client.readHostedExecution(intent());
  assert.ok(
    result.ok && result.value?.outcome === "not_started",
    JSON.stringify(result),
  );
  if (result.ok && result.value?.outcome === "not_started") {
    assert.equal(result.value.jobId, JOB_ID);
    assert.equal(result.value.finishedAt, JOB_FINISHED);
    assert.equal(result.value.execution.id, intent().id);
    assert.equal(result.value.evidenceDigest.length, 64);
  }

  const executedInverted = makeRig();
  scriptAttemptAndJobs(
    executedInverted,
    attemptBody(),
    jobsBody([
      jobBody({
        conclusion: "success",
        startedAt: JOB_FINISHED + 1000,
        completedAt: JOB_FINISHED,
        steps: [],
      }),
    ]),
  );
  const refused = await executedInverted.client.readHostedExecution(intent());
  assert.ok(!refused.ok, JSON.stringify(refused));
  if (!refused.ok) assert.equal(refused.error.kind, "invalid");

  const missingCompletion = makeRig();
  scriptAttemptAndJobs(
    missingCompletion,
    attemptBody(),
    jobsBody([{
      ...jobBody({ conclusion: "skipped", steps: [] }),
      completed_at: null,
    }]),
  );
  const missing = await missingCompletion.client.readHostedExecution(intent());
  assert.ok(!missing.ok, JSON.stringify(missing));
});

Deno.test("hosted execution: skipped, cancelled, timed-out or absent completed repair jobs are explicit not_started", async () => {
  const skipped = makeRig();
  scriptAttemptAndJobs(
    skipped,
    attemptBody(),
    jobsBody([jobBody({ conclusion: "skipped" })]),
  );
  const skippedResult = await skipped.client.readHostedExecution(intent());
  assert.ok(skippedResult.ok && skippedResult.value?.outcome === "not_started");
  if (skippedResult.ok && skippedResult.value?.outcome === "not_started") {
    assert.equal(skippedResult.value.jobId, JOB_ID);
    assert.equal(skippedResult.value.finishedAt, JOB_FINISHED);
    assert.equal(skippedResult.value.execution.id, intent().id);
    assert.equal(skippedResult.value.evidenceDigest.length, 64);
  }

  const cancelled = makeRig();
  scriptAttemptAndJobs(
    cancelled,
    attemptBody(),
    jobsBody([jobBody({ conclusion: "cancelled" })]),
  );
  const cancelledResult = await cancelled.client.readHostedExecution(intent());
  assert.ok(
    cancelledResult.ok && cancelledResult.value?.outcome === "not_started",
  );
  if (
    cancelledResult.ok && cancelledResult.value?.outcome === "not_started"
  ) {
    assert.equal(cancelledResult.value.jobId, JOB_ID);
    assert.equal(cancelledResult.value.finishedAt, JOB_FINISHED);
  }

  const timedOut = makeRig();
  scriptAttemptAndJobs(
    timedOut,
    attemptBody(),
    jobsBody([jobBody({ conclusion: "timed_out" })]),
  );
  const timedOutResult = await timedOut.client.readHostedExecution(intent());
  assert.ok(
    timedOutResult.ok && timedOutResult.value?.outcome === "not_started",
  );

  const absent = makeRig();
  scriptAttemptAndJobs(absent, attemptBody(), jobsBody([]));
  const absentResult = await absent.client.readHostedExecution(intent());
  assert.ok(absentResult.ok && absentResult.value?.outcome === "not_started");
  if (absentResult.ok && absentResult.value?.outcome === "not_started") {
    assert.equal(absentResult.value.jobId, null);
    assert.equal(absentResult.value.finishedAt, JOB_FINISHED);
  }

  const stepSkipped = makeRig();
  scriptAttemptAndJobs(
    stepSkipped,
    attemptBody(),
    jobsBody([
      jobBody({
        steps: [
          runtimeStep({
            conclusion: "skipped",
            started_at: null,
            completed_at: null,
          }),
        ],
      }),
    ]),
  );
  const stepSkippedResult = await stepSkipped.client.readHostedExecution(
    intent(),
  );
  assert.ok(
    stepSkippedResult.ok && stepSkippedResult.value?.outcome === "not_started",
  );
  if (
    stepSkippedResult.ok && stepSkippedResult.value?.outcome === "not_started"
  ) {
    assert.equal(stepSkippedResult.value.jobId, JOB_ID);
    assert.equal(stepSkippedResult.value.finishedAt, JOB_FINISHED);
  }
});

Deno.test("hosted execution: an absent repair job in an in_progress attempt is pending", async () => {
  const rig = makeRig();
  scriptAttemptAndJobs(
    rig,
    attemptBody({ status: "in_progress", conclusion: null }),
    jobsBody([]),
  );
  const result = await rig.client.readHostedExecution(intent());
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value, null);
});

Deno.test("hosted execution: foreign attempt, launcher, terminal execution or controller are unavailable", async () => {
  const cases: Array<(rig: RigV1) => void> = [
    (rig) =>
      scriptAttemptAndJobs(
        rig,
        attemptBody({ workflowId: 1 }),
        jobsBody([jobBody()]),
      ),
    (rig) =>
      scriptAttemptAndJobs(
        rig,
        attemptBody({ branch: "development" }),
        jobsBody([jobBody()]),
      ),
    (rig) =>
      scriptAttemptAndJobs(
        rig,
        attemptBody({ repo: "ubiquity/other" }),
        jobsBody([jobBody()]),
      ),
    (rig) => {
      scriptAttemptAndJobs(rig, attemptBody(), jobsBody([jobBody()]));
      scriptLog(
        rig,
        logText([
          terminalRecord(intent({ runAttempt: 3, id: `${RUN_ID}:3:repair` })),
        ]),
      );
    },
    (rig) => {
      scriptAttemptAndJobs(rig, attemptBody(), jobsBody([jobBody()]));
      scriptLog(
        rig,
        logText([
          terminalRecord(intent(), { controllerSha: LAUNCHER }),
        ]),
      );
    },
  ];
  for (const script of cases) {
    const rig = makeRig();
    script(rig);
    const result = await rig.client.readHostedExecution(intent());
    assert.equal(result.ok, false, JSON.stringify(result));
  }
});

Deno.test("hosted execution: duplicate, malformed or key-extended terminals are never trusted", async () => {
  const duplicate = makeRig();
  scriptAttemptAndJobs(duplicate, attemptBody(), jobsBody([jobBody()]));
  scriptLog(duplicate, logText([terminalRecord(), terminalRecord()]));
  assert.equal(
    (await duplicate.client.readHostedExecution(intent())).ok,
    false,
  );

  const malformed = makeRig();
  scriptAttemptAndJobs(malformed, attemptBody(), jobsBody([jobBody()]));
  const truncated =
    `2026-09-12T22:00:01.0000000Z {"kind":"hosted_runtime_terminal","execution":`;
  scriptLog(malformed, `${truncated}\n${logText([terminalRecord()])}`);
  assert.equal(
    (await malformed.client.readHostedExecution(intent())).ok,
    false,
  );

  // Version-first truncated text still names the trusted kind.
  const versionFirst = makeRig();
  scriptAttemptAndJobs(versionFirst, attemptBody(), jobsBody([jobBody()]));
  const versionTruncated =
    `2026-09-12T22:00:01.0000000Z {"version":"v1","kind":"hosted_runtime_terminal","execution":`;
  scriptLog(
    versionFirst,
    `${versionTruncated}\n${logText([terminalRecord()])}`,
  );
  assert.equal(
    (await versionFirst.client.readHostedExecution(intent())).ok,
    false,
  );

  const unknownKey = makeRig();
  scriptAttemptAndJobs(unknownKey, attemptBody(), jobsBody([jobBody()]));
  scriptLog(unknownKey, logText([terminalRecord(intent(), { extra: true })]));
  assert.equal(
    (await unknownKey.client.readHostedExecution(intent())).ok,
    false,
  );

  // Parse boundary: a healthy terminal without startup/base is rejected.
  assert.throws(() =>
    parseHostedRuntimeTerminalV1(
      terminalRecord(intent(), { baseSha: null }),
    )
  );
  assert.ok(
    tryParse(parseHostedRunProofV1, {
      execution: intent(),
      workflowId: 357012162,
      workflowPath: ".github/workflows/supervisor.yml",
      repository: "Ubiquity-Sentinel/sentinel",
      ref: "refs/heads/sentinel-supervisor",
      jobId: 1,
      startedAt: TERM_STARTED,
      finishedAt: TERM_FINISHED,
      observedAt: OBSERVED,
      outcome: "healthy",
      startupReady: true,
      settled: true,
      baseSha: null,
      terminalAt: TERM_AT,
      logDigest: "a".repeat(64),
    }).ok === false,
  );
});

Deno.test("hosted execution: duplicate jobs, incomplete listings and next links are unavailable", async () => {
  const duplicate = makeRig();
  scriptAttemptAndJobs(
    duplicate,
    attemptBody(),
    jobsBody([jobBody(), jobBody({ id: JOB_ID + 1 })]),
  );
  assert.equal(
    (await duplicate.client.readHostedExecution(intent())).ok,
    false,
  );

  const incomplete = makeRig();
  scriptAttemptAndJobs(
    incomplete,
    attemptBody(),
    jobsBody([jobBody()], 2),
  );
  assert.equal(
    (await incomplete.client.readHostedExecution(intent())).ok,
    false,
  );

  const next = makeRig();
  scriptAttemptAndJobs(
    next,
    attemptBody(),
    jobsBody([jobBody()]),
    { link: `<${API_BASE}${JOBS_PATH}?page=2>; rel="next"` },
  );
  assert.equal((await next.client.readHostedExecution(intent())).ok, false);
});

Deno.test("hosted execution: untrusted log redirects and non-302 log responses fail closed", async () => {
  const untrusted = makeRig();
  scriptAttemptAndJobs(untrusted, attemptBody(), jobsBody([jobBody()]));
  scriptLog(untrusted, logText([terminalRecord()]), "https://evil.example/log");
  const untrustedResult = await untrusted.client.readHostedExecution(intent());
  assert.equal(untrustedResult.ok, false);
  assert.equal(untrusted.http.callsTo(SIGNED_PATH).length, 0);

  const notRedirect = makeRig();
  scriptAttemptAndJobs(notRedirect, attemptBody(), jobsBody([jobBody()]));
  notRedirect.http.on("GET", JOB_LOG_PATH, () => response(200, "raw log"));
  assert.equal(
    (await notRedirect.client.readHostedExecution(intent())).ok,
    false,
  );
});

Deno.test("hosted execution: the durable gate denies before HTTP and rate limits are recorded", async () => {
  const denied = makeRig();
  denied.gate.deny = true;
  const deniedResult = await denied.client.readHostedExecution(intent());
  assert.equal(deniedResult.ok, false);
  if (!deniedResult.ok) {
    assert.equal(deniedResult.error.kind, "rate_limited");
  }
  assert.equal(denied.http.calls.length, 0);

  const limited = makeRig();
  scriptAttemptAndJobs(
    limited,
    attemptBody(),
    jobsBody([jobBody()]),
  );
  limited.http.on(
    "GET",
    JOBS_PATH,
    () =>
      response(403, {}, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": String(Math.floor((T0 + 60_000) / 1000)),
      }),
  );
  const limitedResult = await limited.client.readHostedExecution(intent());
  assert.equal(limitedResult.ok, false);
  if (!limitedResult.ok) {
    assert.equal(limitedResult.error.kind, "rate_limited");
  }
  assert.equal(limited.gate.recorded.length, 1);
});
