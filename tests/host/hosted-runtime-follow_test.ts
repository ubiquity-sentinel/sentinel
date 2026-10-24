import assert from "node:assert/strict";
import {
  ciRun,
  D,
  FollowFake,
  installation,
  L,
  OLDER,
  P,
  response,
  supervisorRun,
} from "./hosted-runtime-follow-fixtures.ts";

Deno.test("follow selects the ancestry-maximal green SHA despite reversed CI ordering", async () => {
  const api = new FollowFake();
  api.ci.get(OLDER)!.unshift(ciRun(OLDER, 99));
  const result = await api.follow();
  assert.equal(result.journal.decision, "advanced");
  assert.equal(result.launcherSha, OLDER);
  assert.equal(api.launcher, OLDER);
  assert.equal(result.journal.ciRunId, 20);
  assert.equal(result.journal.ciAttempt, 1);
  assert.equal(result.journal.installedRevision, P);
  assert.equal(result.journal.observedDevelopmentSha, D);
  assert.equal(result.journal.previousLauncherSha, L);
  assert.equal(api.mutations, 1);
  assert.equal(result.safeToDispatch, true);
  assert.deepEqual(api.journals, [result.journal]);
});

Deno.test("follow exhausts CI run and attempt-job pagination", async () => {
  const api = new FollowFake();
  api.ci.set(
    D,
    Array.from({ length: 101 }, (_, index) =>
      ciRun(D, 1000 + index, {
        conclusion: index === 100 ? "success" : "failure",
      })),
  );
  api.jobs.set(
    1100,
    Array.from({ length: 101 }, (_, index) => ({
      id: 9000 + index,
      run_id: 1100,
      run_attempt: 1,
      head_sha: D,
      name: index === 100 ? "test-local" : `shard-${index}`,
      status: "completed",
      conclusion: "success",
    })),
  );
  const result = await api.follow();
  assert.equal(result.launcherSha, D);
  assert.equal(result.journal.ciRunId, 1100);
  assert.ok(
    api.requests.some((request) =>
      request.url.includes("head_sha=") && request.url.includes("page=2")
    ),
  );
  assert.ok(
    api.requests.some((request) =>
      request.url.includes("/jobs?") && request.url.includes("page=2")
    ),
  );
});

Deno.test("follow selects the newest green first-parent descendant when both revisions are green", async () => {
  const api = new FollowFake();
  api.ci.set(D, [ciRun(D, 5, { updated_at: "2020-01-01T00:00:00Z" })]);
  api.ci.set(OLDER, [
    ciRun(OLDER, 999, { updated_at: "2030-01-01T00:00:00Z" }),
  ]);
  const result = await api.follow();
  assert.equal(result.journal.candidateSha, D);
  assert.equal(api.launcher, D);
});

Deno.test("follow rechecks the latest CI attempt before its sole CAS", async () => {
  const api = new FollowFake();
  let reads = 0;
  api.intercept = (_request, url) =>
    url.pathname.endsWith("/actions/runs/20") && ++reads === 2
      ? response(
        ciRun(OLDER, 20, {
          run_attempt: 2,
          status: "in_progress",
          conclusion: null,
        }),
      )
      : undefined;
  assert.equal((await api.follow()).journal.reason, "ci_changed");
  assert.equal(api.mutations, 0);
});

Deno.test("follow CAS cannot overwrite a concurrent launcher advance after the fresh head reads", async () => {
  const api = new FollowFake();
  api.intercept = (request, url) => {
    if (request.method === "POST" && url.pathname === "/graphql") {
      api.launcher = D;
    }
    return undefined;
  };
  const result = await api.follow();
  assert.equal(result.journal.reason, "ref_conflict");
  assert.equal(result.safeToDispatch, false);
  assert.equal(api.launcher, D);
  assert.equal(api.mutations, 1);
});

Deno.test("follow defers when the captured launcher is outside the first-parent chain", async () => {
  const api = new FollowFake();
  api.parents.set(OLDER, [P]);
  const result = await api.follow();
  assert.equal(result.journal.reason, "launcher_diverged");
  assert.equal(api.launcher, L);
  assert.equal(api.mutations, 0);
});

Deno.test("follow rejects green commits that do not descend from the installed revision", async () => {
  const api = new FollowFake();
  api.installed = "9".repeat(40);
  const result = await api.follow();
  assert.equal(result.journal.decision, "deferred");
  assert.equal(result.journal.reason, "no_eligible_candidate");
  assert.equal(api.mutations, 0);
});

Deno.test("follow reports an atomic expected-old-SHA CAS conflict without retry", async () => {
  const api = new FollowFake();
  api.mutation = "conflict";
  const result = await api.follow();
  assert.equal(result.journal.decision, "deferred");
  assert.equal(result.journal.reason, "ref_conflict");
  assert.equal(api.mutations, 1);
  assert.equal(api.launcher, L);
  assert.equal(result.safeToDispatch, true);
});

Deno.test("follow readback mismatch fails closed", async () => {
  const api = new FollowFake();
  api.mutation = "mismatch";
  const result = await api.follow();
  assert.equal(result.journal.decision, "failed");
  assert.equal(result.journal.reason, "readback_mismatch");
  assert.equal(result.exitCode, 1);
  assert.equal(result.safeToDispatch, false);
});

Deno.test("follow never retries an ambiguous ref mutation", async () => {
  const api = new FollowFake();
  api.mutation = "lost";
  const result = await api.follow();
  assert.equal(result.journal.decision, "failed");
  assert.equal(result.safeToDispatch, false);
  assert.equal(api.launcher, OLDER);
  assert.equal(api.mutations, 1);
  assert.ok(!JSON.stringify(result).includes("private material"));
});

Deno.test("follow defaults off and only exact on enables the native-token ref write", async () => {
  for (const flag of ["off", "", "true", "ON"]) {
    const api = new FollowFake();
    const result = await api.follow(flag);
    assert.equal(result.journal.decision, "dry_run");
    assert.equal(result.journal.candidateSha, OLDER);
    assert.equal(result.launcherSha, L);
    assert.equal(api.mutations, 0);
  }
});

Deno.test("follow excludes failed bootstrap SHAs, including retained failures after restoration", async () => {
  for (const phase of ["rolled_back", "rollback_failed"]) {
    const api = new FollowFake();
    api.ci.set(D, [ciRun(D, 30)]);
    api.installations = [installation(D, phase)];
    const result = await api.follow();
    assert.equal(result.journal.candidateSha, OLDER);
    assert.equal(api.launcher, OLDER);
  }
});

Deno.test("follow defers when every successor has a failed bootstrap journal", async () => {
  const api = new FollowFake();
  api.installations = [installation(OLDER)];
  const result = await api.follow();
  assert.equal(result.journal.decision, "deferred");
  assert.equal(api.mutations, 0);
});

Deno.test("follow defers while a persisted installation or rollback intent is unresolved", async () => {
  for (
    const phase of [
      "requested",
      "bootstrapping",
      "rollback_pending",
      "rollback_verifying",
    ]
  ) {
    const api = new FollowFake();
    api.installations = [installation(OLDER, phase)];
    assert.equal(
      (await api.follow()).journal.reason,
      "installation_unresolved",
    );
    assert.equal(api.mutations, 0);
  }
});

Deno.test("follow rejects malformed installation history rather than skipping its failed-bootstrap guard", async () => {
  const api = new FollowFake();
  api.installations = [installation(D)];
  api.installations[0].bootstrapProof = { outcome: "failed" };
  assert.equal(
    (await api.follow()).journal.reason,
    "invalid_installation_journal",
  );
  assert.equal(api.mutations, 0);
});

Deno.test("follow never treats incomplete CI pagination as an older-candidate fallback", async () => {
  const api = new FollowFake();
  api.intercept = (_request, url) =>
    url.pathname.endsWith("/353613034/runs")
      ? response({ total_count: 2, workflow_runs: [ciRun(D, 30)] })
      : undefined;
  const result = await api.follow();
  assert.equal(result.journal.reason, "incomplete_pagination");
  assert.equal(api.mutations, 0);
});

Deno.test("follow page bound and truncated state tree defer rather than accepting partial reads", async () => {
  const api = new FollowFake();
  api.ci.set(
    D,
    Array.from({ length: 101 }, (_, index) => ciRun(D, index + 100)),
  );
  assert.equal(
    (await api.follow("on", { maxPages: 1 })).journal.reason,
    "pagination_limit",
  );
  api.treeTruncated = true;
  assert.equal((await api.follow()).journal.reason, "incomplete_state_tree");
  assert.equal(api.mutations, 0);
});

Deno.test("follow rejects non-push, foreign repository, pending and unsuccessful required jobs", async () => {
  for (
    const changes of [{ event: "pull_request" }, { head_branch: "other" }, {
      status: "in_progress",
    }, { head_repository: { id: 999, full_name: "fork/sentinel" } }]
  ) {
    const api = new FollowFake();
    api.ci.set(D, [ciRun(D, 30, changes)]);
    assert.equal((await api.follow()).journal.candidateSha, OLDER);
  }
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    const api = new FollowFake();
    api.jobs.set(20, [{
      id: 2000,
      run_id: 20,
      run_attempt: 1,
      head_sha: OLDER,
      name: "test-local",
      status: "completed",
      conclusion,
    }]);
    assert.equal((await api.follow()).journal.decision, "deferred");
  }
});

Deno.test("follow binds required jobs to the latest explicit run attempt", async () => {
  const api = new FollowFake();
  api.ci.set(OLDER, [ciRun(OLDER, 20, { run_attempt: 2 })]);
  api.jobs.set(20, [{
    id: 2000,
    run_id: 20,
    run_attempt: 1,
    head_sha: OLDER,
    name: "test-local",
    status: "completed",
    conclusion: "success",
  }]);
  assert.equal((await api.follow()).journal.reason, "ci_job_identity_mismatch");
  assert.equal(api.mutations, 0);
});

Deno.test("follow refuses branch and release-state drift immediately before CAS", async () => {
  for (const moved of ["development", "release", "launcher"]) {
    const api = new FollowFake();
    let jobReads = 0;
    api.intercept = (_request, url) => {
      if (url.pathname.endsWith("/20/attempts/1/jobs") && ++jobReads === 2) {
        if (moved === "development") api.development = "d".repeat(40);
        if (moved === "release") api.stateHead = "e".repeat(40);
        if (moved === "launcher") api.launcher = "f".repeat(40);
      }
      return undefined;
    };
    assert.equal((await api.follow()).journal.reason, "heads_changed");
    assert.equal(api.mutations, 0);
  }
});

Deno.test("follow refuses an active supervisor and bounded first-parent scans", async () => {
  const api = new FollowFake();
  api.supervisorRuns = [supervisorRun(L, 88)];
  assert.equal((await api.follow()).journal.reason, "supervisor_in_flight");
  api.supervisorRuns = [];
  assert.equal(
    (await api.follow("on", { maxDepth: 1 })).journal.reason,
    "first_parent_depth_limit",
  );
  assert.equal(api.mutations, 0);
});

Deno.test("follow skips a candidate whose workflow files differ from the launcher and advances to an older one", async () => {
  // The native dispatcher token cannot move a ref onto changed workflow
  // files: the newest green D changes them, so the follow takes OLDER.
  const api = new FollowFake();
  api.ci.set(D, [ciRun(D, 5)]);
  api.ci.set(OLDER, [ciRun(OLDER, 6)]);
  api.workflowTrees.set(D, "d".repeat(40));
  const result = await api.follow();
  assert.equal(result.journal.decision, "advanced");
  assert.equal(result.journal.candidateSha, OLDER);
  assert.equal(api.launcher, OLDER);
  assert.equal(api.mutations, 1);
});

Deno.test("follow defers without a ref write when every candidate changes workflow files", async () => {
  const api = new FollowFake();
  api.ci.set(D, [ciRun(D, 5)]);
  api.ci.set(OLDER, [ciRun(OLDER, 6)]);
  api.workflowTrees.set(D, "d".repeat(40));
  api.workflowTrees.set(OLDER, "d".repeat(40));
  const result = await api.follow();
  assert.equal(result.journal.decision, "deferred");
  assert.equal(result.journal.reason, "workflow_change_needs_owner_advance");
  assert.equal(api.mutations, 0);
  assert.equal(api.launcher, L);
  assert.equal(result.exitCode, 0, "a deferral never fails the dispatcher");
  assert.equal(result.safeToDispatch, true, "the current launcher still runs");
});
