/**
 * CI correction evidence from a backup receipt (docs/backup-ci-spec.md
 * §11.7): when the failing check of a candidate head never started on the
 * target and a confirmed red backup result stands in for it, the evidence the
 * correction sees is the receipt (backup app, workflow path, job key, failing
 * step, sanitized excerpt) under one fixed notice; every other check's
 * evidence is the native one, unchanged. The real client over a fake GitHub
 * API and a fake store; synthetic values only.
 */
import assert from "node:assert/strict";
import { GitHubApiClient } from "../../src/github/client.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import type { BackupCiModeV1 } from "../../src/contracts/backup-ci.ts";
import type { BackupCiReadV1 } from "../../src/github/backup-ci-reader.ts";
import {
  BACKUP_CI_EVIDENCE_APP,
  BACKUP_CI_EVIDENCE_NOTICE,
} from "../../src/github/client-ci-evidence-backup.ts";
import { renderCiEvidence } from "../../src/repair/ci-evidence-render.ts";
import { FakeClock, FakeCooldownGate } from "./helpers.ts";
import {
  B,
  CHECK,
  commitFile,
  H,
  key,
  result,
  T0,
  WORKFLOW,
} from "./backup-ci-fixtures.ts";
import {
  consumer,
  FakeBackupCiReader,
  neverStartedJob,
  okRead,
  PUSH_SUITE,
  rawRun,
  REPOSITORY,
  RUN,
  SCOPE,
  startedJob,
  workflowRun,
} from "./backup-ci-consumer-fixtures.ts";

const RED = okRead(commitFile([
  result(key(), { conclusion: "failure" }),
  result(key({ attempt: 2 }), { conclusion: "failure" }),
]));

function json(status: number, body: unknown): HttpResponseV1 {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    bodyText: JSON.stringify(body),
  };
}

function fakeGitHub(runs: unknown[], jobs: Record<number, unknown>) {
  const requests: string[] = [];
  const http = (request: HttpRequestV1): Promise<HttpResponseV1> => {
    const url = new URL(request.url);
    requests.push(`${url.pathname}${url.search}`);
    const path = url.pathname.replace(SCOPE, "");
    if (path === `/commits/${H}/check-runs`) {
      return Promise.resolve(
        json(200, { total_count: runs.length, check_runs: runs }),
      );
    }
    if (path === `/commits/${H}/statuses`) {
      return Promise.resolve(json(200, []));
    }
    if (path === "/actions/runs") {
      const runsWire = [workflowRun(PUSH_SUITE, "push")];
      return Promise.resolve(
        json(200, { total_count: 1, workflow_runs: runsWire }),
      );
    }
    const job = /^\/actions\/jobs\/(\d+)$/.exec(path);
    if (job !== null && jobs[Number(job[1])] !== undefined) {
      return Promise.resolve(json(200, jobs[Number(job[1])]));
    }
    return Promise.resolve(json(404, { message: "Not Found" }));
  };
  return { http, requests };
}

function reader(
  mode: BackupCiModeV1 | null,
  read: BackupCiReadV1,
  runs: unknown[] = [rawRun(RUN)],
  jobs: Record<number, unknown> = { [RUN]: neverStartedJob(RUN) },
) {
  const github = fakeGitHub(runs, jobs);
  const store = new FakeBackupCiReader(() => read);
  const client = new GitHubApiClient({
    repository: REPOSITORY,
    apiBaseUrl: "https://api.github.com",
    http: github.http,
    auth: {
      authorizationHeader: () =>
        Promise.resolve({ ok: true as const, value: "Bearer synthetic" }),
    },
    cooldownGate: new FakeCooldownGate(),
    clock: new FakeClock(T0),
    ...(mode === null ? {} : { backupCi: consumer(mode, store).backupCi }),
  });
  return {
    store,
    requests: github.requests,
    read: () =>
      client.readCiFailureEvidence({ head: H, base: B, deadlineMs: 30_000 }),
  };
}

Deno.test("CI evidence backup: a red stand-in gives the receipt's evidence under the fixed notice", async () => {
  const evidence = await reader("on", RED).read();
  assert.equal(evidence.checks.length, 1);
  const [check] = evidence.checks;
  assert.equal(check.name, CHECK);
  assert.equal(check.conclusion, "failure");
  assert.equal(check.app, BACKUP_CI_EVIDENCE_APP);
  assert.deepEqual(check.workflow, { name: "backup CI", path: WORKFLOW });
  assert.deepEqual(check.job, { id: 6001, name: "deno" });
  assert.deepEqual(check.failingSteps, [{
    number: 1,
    name: "of the target's own job",
    conclusion: "failure",
  }]);
  assert.equal(check.excerpt, "error: test failed");
  assert.equal(check.classification, "candidate");
  assert.equal(check.classificationReason, BACKUP_CI_EVIDENCE_NOTICE);
  assert.equal(
    BACKUP_CI_EVIDENCE_NOTICE,
    "This check did not start on the target (account billing). Sentinel's " +
      "backup CI ran the target's own workflow job on the exact tree; the " +
      "excerpt is from that run.",
  );
  const rendered = renderCiEvidence(evidence, "n0nce");
  assert.ok(rendered.includes(BACKUP_CI_EVIDENCE_NOTICE));
  assert.ok(rendered.includes("error: test failed"));
});

Deno.test("CI evidence backup: native evidence is unchanged without a red stand-in", async () => {
  const native = await reader(null, RED).read();
  assert.equal(native.checks.length, 1);
  assert.equal(native.checks[0].app, "github-actions");
  for (
    const [label, rig] of [
      ["shadow", reader("shadow", RED)],
      ["off", reader("off", RED)],
      ["green stand-in", reader("on", okRead(commitFile([result(key())])))],
      [
        "provisional red",
        reader(
          "on",
          okRead(commitFile([result(key(), { conclusion: "failure" })])),
        ),
      ],
      [
        "store outage",
        reader("on", { kind: "unavailable", detail: "synthetic" }),
      ],
      ["started", reader("on", RED, [rawRun(RUN)], { [RUN]: startedJob(RUN) })],
    ] as const
  ) {
    const evidence = await rig.read();
    assert.deepEqual(evidence, native, label);
  }
  // Off and shadow read no store for evidence and list nothing extra.
  for (const mode of ["off", "shadow"] as const) {
    const quiet = reader(mode, RED);
    await quiet.read();
    assert.deepEqual(quiet.store.reads, [], mode);
    assert.ok(!quiet.requests.some((url) => url.includes("filter=all")));
  }
});
