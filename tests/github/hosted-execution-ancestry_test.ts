// hosted execution ancestry_test.

import assert from "node:assert/strict";
import {
  API_BASE,
  attemptBody,
  COMMIT_PATH,
  COMPARE_PATH,
  compareBody,
  intent,
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
  PR_BASE,
  PR_HEAD,
  PR_NUMBER,
  PULL_PATH,
  REPO,
  requestFixture,
  response,
  REVISION,
  RUN_ATTEMPT,
  runtimeStep,
  scriptAttemptAndJobs,
  scriptLog,
  T0,
  TERM_FINISHED,
  terminalRecord,
} from "./hosted-execution-helpers.ts";

Deno.test("hosted execution: revision ancestry accepts ahead/identical only with the exact base and merge base", async () => {
  const ahead = makeRig();
  ahead.http.on("GET", COMPARE_PATH, () => response(200, compareBody()));
  const aheadResult = await ahead.client.verifyHostedRevision(REVISION);
  assert.ok(aheadResult.ok && aheadResult.value === true);

  const identical = makeRig();
  identical.http.on(
    "GET",
    COMPARE_PATH,
    () => response(200, compareBody({ status: "identical" })),
  );
  const identicalResult = await identical.client.verifyHostedRevision(
    REVISION,
  );
  assert.ok(identicalResult.ok && identicalResult.value === true);

  for (
    const body of [
      compareBody({ status: "behind" }),
      compareBody({ status: "diverged" }),
      compareBody({ base_commit: { sha: LAUNCHER } }),
      compareBody({ merge_base_commit: { sha: LAUNCHER } }),
    ]
  ) {
    const rig = makeRig();
    rig.http.on("GET", COMPARE_PATH, () => response(200, body));
    const result = await rig.client.verifyHostedRevision(REVISION);
    assert.ok(result.ok && result.value === false, JSON.stringify(result));
  }

  // Malformed counters or a missing counter field are unavailable.
  for (
    const body of [
      compareBody({ total_commits: 1 }),
      compareBody({ status: "identical", ahead_by: 1, total_commits: 1 }),
      { status: "ahead", base_commit: { sha: REVISION } },
    ]
  ) {
    const rig = makeRig();
    rig.http.on("GET", COMPARE_PATH, () => response(200, body));
    assert.equal(
      (await rig.client.verifyHostedRevision(REVISION)).ok,
      false,
      JSON.stringify(body),
    );
  }
});

Deno.test("hosted execution: release requests require the merged two-parent PR plus exact ancestry", async () => {
  const good = makeRig();
  good.http.on("GET", PULL_PATH, () =>
    response(200, {
      number: PR_NUMBER,
      state: "closed",
      merged: true,
      merge_commit_sha: REVISION,
      head: {
        sha: PR_HEAD,
        ref: "sentinel/repair/x",
        repo: { full_name: REPO },
      },
      base: { ref: "development", repo: { full_name: REPO } },
    }));
  good.http.on("GET", COMMIT_PATH, () =>
    response(200, {
      sha: REVISION,
      parents: [{ sha: PR_BASE }, { sha: PR_HEAD }],
    }));
  good.http.on("GET", COMPARE_PATH, () => response(200, compareBody()));
  const verified = await good.client.verifyHostedReleaseRequest(
    requestFixture(),
  );
  assert.ok(verified.ok && verified.value === true);

  const wrongParents = makeRig();
  wrongParents.http.on("GET", PULL_PATH, () =>
    response(200, {
      number: PR_NUMBER,
      state: "closed",
      merged: true,
      merge_commit_sha: REVISION,
      head: {
        sha: PR_HEAD,
        ref: "sentinel/repair/x",
        repo: { full_name: REPO },
      },
      base: { ref: "development", repo: { full_name: REPO } },
    }));
  wrongParents.http.on("GET", COMMIT_PATH, () =>
    response(200, {
      sha: REVISION,
      parents: [{ sha: PR_BASE }, { sha: LAUNCHER }],
    }));
  const mismatch = await wrongParents.client.verifyHostedReleaseRequest(
    requestFixture(),
  );
  assert.ok(mismatch.ok && mismatch.value === false);

  // Foreign scope, cancelled or review-less requests never reach the network.
  for (
    const request of [
      requestFixture({ status: "cancelled", failureReason: "cancelled" }),
      requestFixture({
        target: {
          repository: {
            owner: "ubiquity-sentinel",
            name: "sentinel",
            installationId: 7,
          },
          environment: "production",
        },
      }),
      requestFixture({
        source: {
          pullRequest: PR_NUMBER,
          reviewRequestId: "review-req-1",
          reviewReceiptId: null,
          head: PR_HEAD,
          base: PR_BASE,
        },
      }),
    ]
  ) {
    const rig = makeRig();
    const result = await rig.client.verifyHostedReleaseRequest(request);
    assert.ok(result.ok && result.value === false);
    assert.equal(rig.http.calls.length, 0);
  }
});

Deno.test("hosted execution: future, inverted or early-terminal metadata is refused", async () => {
  const futureAttempt = makeRig();
  scriptAttemptAndJobs(
    futureAttempt,
    attemptBody({ updatedAt: OBSERVED + 5000 }),
    jobsBody([jobBody()]),
  );
  scriptLog(futureAttempt, logText([terminalRecord()]));
  assert.equal(
    (await futureAttempt.client.readHostedExecution(intent())).ok,
    false,
  );

  const futureJob = makeRig();
  scriptAttemptAndJobs(
    futureJob,
    attemptBody(),
    jobsBody([
      jobBody({
        completedAt: OBSERVED + 5000,
        steps: [runtimeStep({ completedAt: OBSERVED + 5000 })],
      }),
    ]),
  );
  scriptLog(futureJob, logText([terminalRecord()]));
  assert.equal(
    (await futureJob.client.readHostedExecution(intent())).ok,
    false,
  );

  const invertedAttempt = makeRig();
  scriptAttemptAndJobs(
    invertedAttempt,
    attemptBody({ updatedAt: T0 - 1000 }),
    jobsBody([jobBody()]),
  );
  scriptLog(invertedAttempt, logText([terminalRecord()]));
  assert.equal(
    (await invertedAttempt.client.readHostedExecution(intent())).ok,
    false,
  );

  const invertedJob = makeRig();
  scriptAttemptAndJobs(
    invertedJob,
    attemptBody(),
    jobsBody([jobBody({ startedAt: JOB_FINISHED, completedAt: JOB_STARTED })]),
  );
  scriptLog(invertedJob, logText([terminalRecord()]));
  assert.equal(
    (await invertedJob.client.readHostedExecution(intent())).ok,
    false,
  );

  // A terminal emitted before its own finish cannot be trusted.
  const earlyTerminal = makeRig();
  scriptAttemptAndJobs(earlyTerminal, attemptBody(), jobsBody([jobBody()]));
  scriptLog(earlyTerminal, logText([terminalRecord()], TERM_FINISHED - 3000));
  assert.equal(
    (await earlyTerminal.client.readHostedExecution(intent())).ok,
    false,
  );
});

Deno.test("hosted execution: paginated native jobs reject incomplete conflicting or foreign pages", async (t) => {
  for (
    const defect of [
      "duplicate_id",
      "duplicate_repair",
      "wrong_attempt",
      "wrong_head",
      "changing_total",
      "missing_next",
      "short_page",
      "cycle",
      "foreign_origin",
      "foreign_attempt",
      "userinfo",
      "repeated_query",
      "extra_next",
      "multiple_next",
      "missing_page",
      "native_ceiling",
      "page_cooldown",
    ]
  ) {
    await t.step(defect, async () => {
      const rig = makeRig();
      const cells = Array.from(
        { length: 100 },
        (_, index) =>
          jobBody({ id: 10000 + index, name: "matrix_cell (" + index + ")" }),
      );
      const repair = jobBody();
      if (defect === "duplicate_id") repair.id = cells[0].id;
      if (defect === "duplicate_repair") cells[0] = jobBody({ id: JOB_ID + 1 });
      if (defect === "wrong_attempt") cells[0].run_attempt = RUN_ATTEMPT + 1;
      if (defect === "wrong_head") cells[0].head_sha = "f".repeat(40);
      scriptAttemptAndJobs(rig, attemptBody(), {});
      rig.http.on("GET", JOBS_PATH, (request) => {
        const page = Number(
          new URL(request.url).searchParams.get("page") ?? "1",
        );
        if (defect === "page_cooldown" && page === 1) rig.gate.deny = true;
        if (defect === "missing_page" && page === 2) return response(404, {});
        let next = page === 1
          ? API_BASE + JOBS_PATH + "?per_page=100&page=2"
          : null;
        if (defect === "missing_next") next = null;
        if (defect === "cycle") {
          next = API_BASE + JOBS_PATH + "?per_page=100&page=1";
        }
        if (defect === "foreign_origin") {
          next = "https://evil.example" + JOBS_PATH + "?per_page=100&page=2";
        }
        if (defect === "foreign_attempt") {
          next = API_BASE +
            JOBS_PATH.replace(
              "/attempts/" + RUN_ATTEMPT,
              "/attempts/" + (RUN_ATTEMPT + 1),
            ) + "?per_page=100&page=2";
        }
        if (defect === "userinfo") {
          next = "https://user@api.github.com" + JOBS_PATH +
            "?per_page=100&page=2";
        }
        if (defect === "repeated_query") {
          next = API_BASE + JOBS_PATH + "?per_page=100&page=2&page=2";
        }
        if (defect === "extra_next" && page === 2) {
          next = API_BASE + JOBS_PATH + "?per_page=100&page=3";
        }
        const total = defect === "native_ceiling"
          ? 262
          : defect === "changing_total" && page === 2
          ? 102
          : 101;
        const jobs = page === 1
          ? defect === "short_page" ? cells.slice(0, 99) : cells
          : [repair];
        return response(
          200,
          jobsBody(jobs, total),
          next === null ? {} : {
            link: "<" + next + '>; rel="next"' +
              (defect === "multiple_next"
                ? ", <" + next + '>; rel="next"'
                : ""),
          },
        );
      });
      scriptLog(rig, logText([terminalRecord()]));
      const result = await rig.client.readHostedExecution(intent());
      assert.equal(result.ok, false, defect);
      assert.equal(
        rig.http.callsTo(JOB_LOG_PATH).length,
        0,
        "invalid listing cannot authenticate a terminal",
      );
      assert.ok(
        rig.http.calls.every((call) => new URL(call.url).origin === API_BASE),
        "no credential may follow a foreign page",
      );
      assert.ok(rig.gate.admissions.every((scope) => scope === 0));
      if (defect === "page_cooldown") {
        assert.equal(rig.http.callsTo(JOBS_PATH).length, 1);
        if (!result.ok) assert.equal(result.error.kind, "rate_limited");
      }
    });
  }
});
