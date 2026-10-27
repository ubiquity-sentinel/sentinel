import assert from "node:assert/strict";
import {
  BACKUP_COMPLETION_REPOSITORY,
  type BackupCompletionApi,
  routeBackupCiCompletion,
  routeControllerCiCompletion,
  wakeBackupCiReceipt,
} from "../../src/host/backup-ci-completion.ts";
import {
  backupCiBytesDigest,
  type BackupCiDispatchedEntryV1,
} from "../../src/contracts/backup-ci.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { commitBackupCiPass } from "../../ops/backup-ci-dispatch.ts";
import type { BackupCiPassFileV1 } from "../../ops/backup-ci-pass.ts";
import type { BackupCiApiV1 } from "../../ops/backup-ci-plan-reads.ts";
import type { BackupCiStoreView } from "../../ops/backup-ci-store-writer.ts";
import { runSupervisorDispatch } from "../../src/host/supervisor-dispatch.ts";
import {
  dispatched,
  H,
  LAUNCHER,
  REPOSITORY,
  result,
  T0,
  unit,
} from "../github/backup-ci-fixtures.ts";
import {
  FollowFake,
  L,
  NOW,
  supervisorRun,
} from "./hosted-runtime-follow-fixtures.ts";

type Obj = Record<string, unknown>;
const ROOT = `/repos/${BACKUP_COMPLETION_REPOSITORY}`;
const repository = { id: 999, full_name: BACKUP_COMPLETION_REPOSITORY };

function scenario() {
  const u = unit();
  const native: Obj = {
    id: 5001,
    workflow_id: 81,
    run_attempt: 1,
    path: ".github/workflows/backup-ci-leg.yml",
    event: "workflow_dispatch",
    head_branch: "sentinel-backup-legs",
    head_sha: LAUNCHER,
    repository,
    head_repository: repository,
    triggering_actor: { login: "github-actions[bot]" },
    display_title: `sentinel-backup-ci-leg ${u.unitId}`,
    status: "completed",
    conclusion: "success",
  };
  const planner: Obj = {
    ...native,
    id: u.plan.runId,
    workflow_id: 82,
    path: ".github/workflows/backup-ci.yml",
    head_branch: "sentinel-supervisor",
  };
  const responses = new Map<string, unknown>([
    [ROOT, { ...repository, default_branch: "development" }],
    [`${ROOT}/actions/workflows/backup-ci-leg.yml`, {
      id: 81,
      path: native.path,
    }],
    [`${ROOT}/actions/workflows/backup-ci.yml`, { id: 82, path: planner.path }],
    [`${ROOT}/actions/runs/5001`, structuredClone(native)],
    [`${ROOT}/actions/runs/5001/attempts/1`, native],
    [`${ROOT}/actions/runs/${u.plan.runId}/attempts/1`, planner],
  ]);
  const posts: { path: string; body: Obj }[] = [];
  let entries: readonly BackupCiDispatchedEntryV1[] = [dispatched(u)];
  const api: BackupCompletionApi = {
    get: (path) => Promise.resolve(responses.get(path) ?? null),
    send: (_method, path, body) => {
      posts.push({ path, body });
      return Promise.resolve({ status: 204 });
    },
  };
  const event = {
    action: "completed",
    repository: structuredClone(repository),
    workflow_run: structuredClone(native),
  };
  const route = () =>
    routeBackupCiCompletion(event, {
      api,
      dispatched: () => Promise.resolve(entries),
    });
  return {
    api,
    native,
    planner,
    event,
    responses,
    posts,
    route,
    resolve: () => entries = [],
    duplicatePlan: () => entries = [dispatched(u), dispatched(u)],
  };
}

Deno.test("the exact planned native leg completion requests only protected ingestion", async () => {
  const s = scenario();
  assert.deepEqual(await s.route(), {
    decision: "requested",
    reason: "planned_leg_completed",
  });
  assert.deepEqual(s.posts, [{
    path: `${ROOT}/actions/workflows/backup-ci.yml/dispatches`,
    body: { ref: "sentinel-supervisor" },
  }]);
});

Deno.test("the official App dispatched leg requests protected ingestion with its exact actor identity", async () => {
  const s = scenario();
  s.native.triggering_actor = {
    login: "ubiquity-sentinel[bot]",
    id: 319834869,
    type: "Bot",
  };
  assert.equal((await s.route()).decision, "requested");
  assert.equal(s.posts.length, 1);
});

Deno.test("a completed failed leg requests reconciliation without becoming green evidence", async () => {
  const s = scenario();
  s.native.conclusion = "failure";
  assert.equal((await s.route()).decision, "requested");
  assert.equal(s.posts.length, 1);
  assert(!JSON.stringify(s.posts).includes("success"));
});

Deno.test("a late authorized leg keeps its stored old SHA after the launcher advances", async () => {
  const s = scenario();
  s.responses.set(`${ROOT}/git/ref/heads/sentinel-supervisor`, {
    object: { sha: "f".repeat(40) },
  });
  s.responses.set(`${ROOT}/git/ref/heads/sentinel-backup-legs`, {
    object: { sha: "f".repeat(40) },
  });
  assert.equal((await s.route()).decision, "requested");
});

Deno.test("foreign, stale, rerun and unplanned completions cannot request ingestion", async (t) => {
  const mutations: Record<string, (s: ReturnType<typeof scenario>) => void> = {
    "foreign event repository": (s) => s.event.repository.id = 1000,
    "foreign head repository": (s) =>
      s.event.workflow_run.head_repository = {
        id: 1000,
        full_name: "someone/fork",
      },
    "wrong workflow id": (s) => s.event.workflow_run.workflow_id = 99,
    "wrong ref": (s) => s.event.workflow_run.head_branch = "development",
    "wrong SHA": (s) => s.event.workflow_run.head_sha = "f".repeat(40),
    "event rerun": (s) => s.event.workflow_run.run_attempt = 2,
    "newer native attempt": (s) => {
      (s.responses.get(`${ROOT}/actions/runs/5001`) as Obj).run_attempt = 2;
    },
    "wrong native actor": (s) => s.native.triggering_actor = { login: "human" },
    "copied official login with wrong id": (s) =>
      s.native.triggering_actor = {
        login: "ubiquity-sentinel[bot]",
        id: 1,
        type: "Bot",
      },
    "official id with wrong login": (s) =>
      s.native.triggering_actor = {
        login: "foreign[bot]",
        id: 319834869,
        type: "Bot",
      },
    "official identity with wrong type": (s) =>
      s.native.triggering_actor = {
        login: "ubiquity-sentinel[bot]",
        id: 319834869,
        type: "User",
      },
    "wrong planner SHA": (s) => s.planner.head_sha = "f".repeat(40),
    "wrong planner ref": (s) => s.planner.head_branch = "development",
    "wrong planner attempt": (s) => s.planner.run_attempt = 2,
    "already ingested or late duplicate": (s) => s.resolve(),
    "ambiguous planned binding": (s) => s.duplicatePlan(),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.step(name, async () => {
      const s = scenario();
      mutate(s);
      assert.equal((await s.route()).decision, "ignored");
      assert.equal(s.posts.length, 0);
    });
  }
});

Deno.test("an out-of-order completion remains inert after its durable result was ingested", async () => {
  const s = scenario();
  assert.equal((await s.route()).decision, "requested");
  s.resolve();
  assert.equal((await s.route()).reason, "plan_not_pending");
  assert.equal((await s.route()).reason, "plan_not_pending");
  assert.equal(s.posts.length, 1);
});

Deno.test("planning, calibration, unchanged and failed commits never echo a receipt wake", async () => {
  const s = scenario();
  const cases: Record<string, number>[] = [
    {},
    { planned: 1, dispatched: 1 },
    { calibration: 1, "result:success": 1 },
    { receipt_advanced: 0 },
  ];
  for (const counts of cases) {
    assert.equal(
      (await wakeBackupCiReceipt({ code: 0, counts }, s.api)).decision,
      "ignored",
    );
  }
  assert.equal(
    (await wakeBackupCiReceipt(
      { code: 1, counts: { receipt_advanced: 1 } },
      s.api,
    ))
      .decision,
    "ignored",
  );
  assert.equal(s.posts.length, 0);
});

Deno.test("only a fresh exact bot-owned controller pull head requests a native CI wake", async () => {
  const s = scenario();
  const run: Obj = {
    ...s.event.workflow_run,
    id: 6001,
    workflow_id: 83,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_branch: "sentinel/repair/issue-7",
    pull_requests: [{ number: 7 }],
  };
  s.responses.set(`${ROOT}/actions/workflows/ci.yml`, {
    id: 83,
    path: run.path,
  });
  s.responses.set(`${ROOT}/actions/runs/6001`, run);
  s.responses.set(`${ROOT}/actions/runs/6001/attempts/1`, run);
  const pull = {
    number: 7,
    state: "open",
    user: { login: "ubiquity-sentinel[bot]" },
    head: { sha: LAUNCHER, ref: run.head_branch, repo: repository },
    base: { ref: "development", repo: repository },
  };
  s.responses.set(`${ROOT}/pulls/7`, pull);
  const event = { ...s.event, workflow_run: structuredClone(run) };
  assert.equal(
    (await routeControllerCiCompletion(event, s.api)).decision,
    "requested",
  );
  assert.equal(s.posts.length, 1);
  pull.head.sha = "f".repeat(40) as typeof LAUNCHER;
  assert.equal(
    (await routeControllerCiCompletion(event, s.api)).reason,
    "pull_binding",
  );
  pull.head.sha = LAUNCHER;
  pull.state = "closed";
  assert.equal(
    (await routeControllerCiCompletion(event, s.api)).reason,
    "pull_binding",
  );
  pull.state = "open";
  pull.user.login = "outside-contributor";
  assert.equal(
    (await routeControllerCiCompletion(event, s.api)).reason,
    "pull_binding",
  );
  pull.user.login = "ubiquity-sentinel[bot]";
  run.run_attempt = 2;
  assert.equal(
    (await routeControllerCiCompletion(event, s.api)).reason,
    "attempt_binding",
  );
  assert.equal(s.posts.length, 1);
});

Deno.test("a real receipt commit wakes once; active coalescing preserves it for the idle handoff", async () => {
  const s = scenario(), store = new Map<string, unknown>();
  const pass: BackupCiPassFileV1 = {
    version: 1,
    kind: "sentinel_backup_ci_pass",
    runId: 9001,
    launcherSha: LAUNCHER,
    mode: "on",
    runnerId: unit().plan.runnerId,
    createdAt: T0,
    files: [{
      repository: REPOSITORY,
      commit: H,
      coverage: [],
      results: [result()],
      noEvidence: [],
    }],
    comparisons: [],
    units: [],
  };
  const bytes = new TextEncoder().encode(canonicalStringify(pass));
  const commit = () =>
    commitBackupCiPass({
      passBytes: bytes,
      expectedDigest: backupCiBytesDigest(bytes),
      githubSha: LAUNCHER,
      runId: 9001,
      trees: [],
      now: () => T0 + 1000,
      repository: BACKUP_COMPLETION_REPOSITORY,
      api: {
        ...s.api,
        redirected: () => Promise.resolve(null),
      } as BackupCiApiV1,
      legDispatcher: null,
      async writeStore(mutate) {
        const changes = await mutate({
          read: (path: string) => Promise.resolve(store.get(path) ?? null),
        } as BackupCiStoreView);
        if (changes.size === 0) return { kind: "unchanged", tip: null };
        for (const [path, value] of changes) store.set(path, value);
        return { kind: "committed", commit: H, parent: null, attempts: 1 };
      },
      log: () => {},
    });
  const committed = await commit();
  assert.equal(committed.counts.receipt_advanced, 1);
  assert.equal(
    (await wakeBackupCiReceipt(committed, s.api)).decision,
    "requested",
  );
  const persisted = canonicalStringify([...store]);
  const duplicate = await commit();
  assert.equal(duplicate.counts.receipt_advanced, 0);
  assert.equal(
    (await wakeBackupCiReceipt(duplicate, s.api)).decision,
    "ignored",
  );
  assert.equal(s.posts.length, 1);

  const native = new FollowFake();
  native.supervisorRuns = [supervisorRun(L, 700, {
    status: "in_progress",
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
  })];
  const reconcile = () =>
    runSupervisorDispatch({
      http: native.http,
      token: "fake-token",
      clock: { now: () => NOW },
      follow: { expectedSha: L, ready: true, pause: () => Promise.resolve() },
      log: () => {},
    });
  assert.equal((await reconcile()).dispatched, false);
  assert.equal(canonicalStringify([...store]), persisted);
  native.supervisorRuns[0].status = "completed";
  assert.equal((await reconcile()).dispatched, true);
  assert.equal(native.dispatches, 1);
  assert.equal(canonicalStringify([...store]), persisted);
});
