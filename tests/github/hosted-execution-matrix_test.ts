// hosted execution matrix_test.

import assert from "node:assert/strict";
import {
  attemptBody,
  intent,
  JOB_ID,
  jobBody,
  jobsBody,
  LAUNCHER,
  logText,
  makeRig,
  MATRIX_COMMIT_PATH,
  MATRIX_HOST_SHA,
  MATRIX_ROOT_SHA,
  MATRIX_SRC_SHA,
  matrixTreePath,
  response,
  REVISION,
  scriptAttemptAndJobs,
  scriptLog,
  scriptMatrixCapability,
  settlementProof,
  terminalRecord,
} from "./hosted-execution-helpers.ts";

Deno.test("ordinary matrix source: authenticated complete immutable trees prove capability or definitive absence", async (t) => {
  for (const capable of [false, true]) {
    await t.step(String(capable), async () => {
      const rig = makeRig();
      scriptMatrixCapability(rig, capable);
      const result = await rig.client.verifyMatrixOrdinaryRevision(REVISION);
      assert.ok(result.ok, JSON.stringify(result));
      if (result.ok) assert.equal(result.value, capable);
      assert.equal(rig.http.calls.length, 4);
      assert.ok(
        rig.http.calls.every((call) =>
          call.method === "GET" && !call.url.includes("development") &&
          call.headers.get("authorization") === "Bearer test-token"
        ),
      );
    });
  }
});

Deno.test("ordinary matrix source: unknown commit tree path or type proof never becomes support or absence", async (t) => {
  for (
    const defect of [
      "commit404",
      "tree404",
      "wrong_commit",
      "missing_commit_tree",
      "wrong_root",
      "truncated",
      "malformed",
      "unknown_truncation",
      "duplicate_path",
      "recursive_path",
      "symlink",
      "directory",
      "submodule",
      "wrong_mode",
      "wrong_src",
      "malformed_other_entry",
    ]
  ) {
    await t.step(defect, async () => {
      const rig = makeRig();
      scriptMatrixCapability(rig);
      const entry = {
        path: "matrix-actions.ts",
        type: "blob",
        mode: "100644",
        sha: "8".repeat(40),
      };
      if (defect === "commit404") {
        rig.http.on("GET", MATRIX_COMMIT_PATH, () => response(404, {}));
      } else if (defect === "wrong_commit") {
        rig.http.on(
          "GET",
          MATRIX_COMMIT_PATH,
          () =>
            response(200, { sha: LAUNCHER, tree: { sha: MATRIX_ROOT_SHA } }),
        );
      } else if (defect === "missing_commit_tree") {
        rig.http.on(
          "GET",
          MATRIX_COMMIT_PATH,
          () => response(200, { sha: REVISION }),
        );
      } else if (defect === "tree404") {
        rig.http.on(
          "GET",
          matrixTreePath(MATRIX_ROOT_SHA),
          () => response(404, {}),
        );
      } else if (
        defect === "wrong_root" || defect === "truncated" ||
        defect === "unknown_truncation" || defect === "malformed"
      ) {
        rig.http.on(
          "GET",
          matrixTreePath(MATRIX_ROOT_SHA),
          () =>
            response(200, {
              sha: defect === "wrong_root" ? LAUNCHER : MATRIX_ROOT_SHA,
              truncated: defect === "truncated"
                ? true
                : defect === "unknown_truncation"
                ? "false"
                : false,
              tree: defect === "malformed" ? null : [{
                path: "src",
                type: "tree",
                mode: "040000",
                sha: MATRIX_SRC_SHA,
              }],
            }),
        );
      } else if (defect === "wrong_src") {
        rig.http.on(
          "GET",
          matrixTreePath(MATRIX_SRC_SHA),
          () =>
            response(200, { sha: MATRIX_HOST_SHA, truncated: false, tree: [] }),
        );
      } else {
        if (defect === "symlink") entry.mode = "120000";
        if (defect === "directory") {
          entry.type = "tree";
          entry.mode = "040000";
        }
        if (defect === "submodule") {
          entry.type = "commit";
          entry.mode = "160000";
        }
        if (defect === "wrong_mode") entry.mode = "999999";
        if (defect === "recursive_path") entry.path = "host/matrix-actions.ts";
        const tree = defect === "duplicate_path"
          ? [entry, entry]
          : defect === "malformed_other_entry"
          ? [entry, { ...entry, path: "other", sha: "bad" }]
          : [entry];
        rig.http.on(
          "GET",
          matrixTreePath(MATRIX_HOST_SHA),
          () => response(200, { sha: MATRIX_HOST_SHA, truncated: false, tree }),
        );
      }
      const result = await rig.client.verifyMatrixOrdinaryRevision(REVISION);
      assert.equal(result.ok, false, defect);
      assert.ok(rig.http.calls.every((call) => call.method === "GET"));
    });
  }
});

Deno.test("ordinary matrix source: existing scoped cooldown gate refuses later tree reads", async () => {
  const rig = makeRig();
  scriptMatrixCapability(rig);
  rig.http.on("GET", MATRIX_COMMIT_PATH, () => {
    rig.gate.deny = true;
    return response(200, { sha: REVISION, tree: { sha: MATRIX_ROOT_SHA } });
  });
  const result = await rig.client.verifyMatrixOrdinaryRevision(REVISION);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "rate_limited");
  assert.equal(rig.http.calls.length, 1);
  assert.ok(rig.gate.admissions.every((scope) => scope === 0));
});

Deno.test("hosted execution: a matrix cell job name (64-hex cell id) still settles the run", async () => {
  const rig = makeRig();
  const cellName = `matrix_cell (${"a".repeat(64)})`;
  assert.equal(cellName.length, 78);
  const cell = jobBody({ id: JOB_ID + 500, name: cellName, steps: [] });
  scriptAttemptAndJobs(rig, attemptBody(), jobsBody([cell, jobBody()]));
  scriptLog(rig, logText([terminalRecord()]));
  const proof = settlementProof(await rig.client.readHostedExecution(intent()));
  assert.equal(proof.outcome, "healthy");
  assert.equal(proof.jobId, JOB_ID);
});
