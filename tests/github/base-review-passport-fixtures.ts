/** Synthetic exact-base Passport Actions and the existing trusted backup store. */
import { GitHubApiClient } from "../../src/github/client.ts";
import type { BackupCiModeV1 } from "../../src/contracts/backup-ci.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BackupCiReadV1 } from "../../src/github/backup-ci-reader.ts";
import type { HttpResponseV1 } from "../../src/github/http.ts";
import { FakeAuthProvider, FakeClock, FakeCooldownGate } from "./helpers.ts";
import {
  ACTIONS,
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
import {
  B,
  BLOB,
  commitFile,
  H,
  key,
  result,
  T0,
  TREE,
  WORKFLOW,
} from "./backup-ci-fixtures.ts";

export { REPOSITORY as PASSPORT } from "./backup-ci-consumer-fixtures.ts";

export function passportCiFixture(
  head: GitSha = H,
  native = false,
  mode: BackupCiModeV1 | null = "on",
) {
  const run = workflowRun(PUSH_SUITE, "push", {
    repository: { full_name: "ubiquity/passport.ubq.fi" },
    head_repository: { full_name: "ubiquity/passport.ubq.fi" },
    head_commit: { id: head, tree_id: TREE },
    conclusion: native ? "success" : "failure",
  }, head);
  const job = native ? startedJob(RUN, head) : neverStartedJob(RUN, head);
  job.run_id = Number(run.id);
  job.conclusion = native ? "success" : "failure";
  const data = {
    checks: [rawRun(RUN, {
      app: ACTIONS,
      conclusion: native ? "success" : "failure",
    }, head)],
    all: null as unknown[] | null,
    runs: [run],
    jobs: [job],
    statuses: [] as unknown[],
    historicalJobs: new Map<number, unknown>(),
    commit: { sha: head, tree: { sha: TREE }, parents: [{ sha: B }] },
    tree: {
      sha: TREE,
      truncated: false,
      tree: [{ path: WORKFLOW, type: "blob", mode: "100644", sha: BLOB }],
    },
    store: okRead(commitFile([result(key(), { commit: head })], {
      commit: head,
    })) as BackupCiReadV1,
    missing: new Set<string>(),
  };
  const reader = new FakeBackupCiReader(() => data.store);
  const requests: string[] = [];
  const json = (body: unknown, status = 200): HttpResponseV1 => ({
    status,
    headers: new Headers(),
    bodyText: JSON.stringify(body),
  });
  const client = new GitHubApiClient({
    repository: REPOSITORY,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    clock: new FakeClock(T0),
    ...(mode === null
      ? {}
      : { backupCi: { mode, reader, log: { once() {} } } }),
    http(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(SCOPE, "");
      requests.push(`${path}${url.search}`);
      if (data.missing.has(path)) return Promise.resolve(json({}, 404));
      let body: unknown;
      if (path === `/commits/${head}/check-runs`) {
        const checks = url.searchParams.get("filter") === "all"
          ? data.all ?? data.checks
          : data.checks;
        body = { total_count: checks.length, check_runs: checks };
      } else if (path === `/git/commits/${head}`) body = data.commit;
      else if (path === `/git/trees/${TREE}`) body = data.tree;
      else if (path === `/commits/${head}/statuses`) body = data.statuses;
      else if (path === "/actions/runs") {
        body = { total_count: data.runs.length, workflow_runs: data.runs };
      } else if (/^\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(path)) {
        body = { total_count: data.jobs.length, jobs: data.jobs };
      } else if (/^\/actions\/jobs\/\d+$/.test(path)) {
        const jobId = Number(path.split("/").at(-1));
        body = data.jobs.find((item) => item.id === jobId) ??
          data.historicalJobs.get(jobId);
      }
      return Promise.resolve(body === undefined ? json({}, 404) : json(body));
    },
  });
  return { client, data, reader, requests };
}
