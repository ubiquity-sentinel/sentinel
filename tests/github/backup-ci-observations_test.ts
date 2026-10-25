/**
 * The backup CI observation adapter (docs/backup-ci-spec.md §6.3, §19): WP0's
 * never-started rule as `notStarted`, suite mapping, the bounded store read
 * and the listing reuse that can only refuse. All synthetic.
 */
import assert from "node:assert/strict";
import {
  BACKUP_CI_LISTING_TTL_MS,
  BackupCiListingCache,
  backupCiObservation,
  backupCiSuites,
  classifyNeverStarted,
  createBackupCiLog,
  readBackupCiStore,
} from "../../src/github/backup-ci-observations.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { H } from "./backup-ci-fixtures.ts";
import {
  EARLIER,
  FakeBackupCiReader,
  neverStartedJob,
  okRead,
  PR_SUITE,
  PUSH_SUITE,
  rawRun,
  REPOSITORY,
  RUN,
  startedJob,
  workflowRun,
} from "./backup-ci-consumer-fixtures.ts";
import { CHECK } from "./backup-ci-fixtures.ts";

Deno.test("adapter: only a failed Actions run is judged by its job; unknown stays null", async () => {
  const reads: number[] = [];
  const jobs: Record<number, unknown> = {
    [RUN]: neverStartedJob(RUN),
    [EARLIER]: startedJob(EARLIER),
  };
  const verdicts = await classifyNeverStarted(
    [
      rawRun(RUN),
      rawRun(EARLIER),
      rawRun(RUN + 1, { conclusion: "success" }),
      rawRun(RUN + 2, { status: "in_progress", conclusion: null }),
      rawRun(RUN + 3, { app: { slug: "ci-bot" } }),
      rawRun(RUN + 4),
      rawRun(RUN + 5, { name: "other" }),
    ],
    H,
    new Set([CHECK]),
    (id) => {
      reads.push(id);
      return Promise.resolve(jobs[id] ?? null);
    },
    new Map(),
  );
  assert.deepEqual(Object.fromEntries(verdicts), {
    [RUN]: true,
    [EARLIER]: false,
    [RUN + 1]: false,
    [RUN + 2]: false,
    [RUN + 3]: false,
    [RUN + 4]: null,
  });
  assert.deepEqual(reads, [RUN, EARLIER, RUN + 4]);
});

Deno.test("adapter: the job read bound leaves the rest unknown, and the cache spends no read", async () => {
  const cache = new Map<string, boolean>();
  const reads: number[] = [];
  const read = (id: number) => {
    reads.push(id);
    return Promise.resolve(neverStartedJob(id));
  };
  const runs = [rawRun(RUN), rawRun(RUN + 1), rawRun(RUN + 2)];
  const bounded = await classifyNeverStarted(
    runs,
    H,
    new Set([CHECK]),
    read,
    cache,
    2,
  );
  assert.deepEqual([...bounded.values()], [true, true, null]);
  const again = await classifyNeverStarted(
    runs,
    H,
    new Set([CHECK]),
    read,
    cache,
    1,
  );
  assert.deepEqual([...again.values()], [true, true, true]);
  assert.deepEqual(reads, [RUN, RUN + 1, RUN + 2]);
});

Deno.test("adapter: an observation of another commit or without an id is refused; suites map by id", () => {
  assert.equal(
    backupCiObservation(rawRun(RUN, {}, "b".repeat(40) as GitSha), H, true),
    null,
  );
  assert.equal(backupCiObservation(rawRun(0), H, true), null);
  assert.deepEqual(backupCiObservation(rawRun(RUN), H, true), {
    checkRunId: RUN,
    name: CHECK,
    app: "github-actions",
    suiteId: PUSH_SUITE,
    status: "completed",
    conclusion: "failure",
    startedAt: Date.parse("2026-10-25T08:00:00Z"),
    completedAt: Date.parse("2026-10-25T08:00:01Z"),
    notStarted: true,
  });
  assert.deepEqual(
    backupCiSuites([
      workflowRun(PUSH_SUITE, "push"),
      workflowRun(PUSH_SUITE, "push", { id: 9 }),
      workflowRun(PR_SUITE, "pull_request"),
      workflowRun(PR_SUITE, "push", { id: 10 }),
      workflowRun(77, "push", {}, "b".repeat(40) as GitSha),
    ], H),
    [{
      suiteId: PUSH_SUITE,
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
    }],
  );
});

Deno.test("adapter: a store read that does not settle in its budget is unavailable", async () => {
  const late = new FakeBackupCiReader(() => okRead(null));
  late.read = () => new Promise(() => {});
  assert.deepEqual(await readBackupCiStore(late, REPOSITORY, H, 5), {
    kind: "unavailable",
    detail: "backup CI store read late",
  });
  const thrown = new FakeBackupCiReader(() => {
    throw new Error("synthetic");
  });
  assert.equal(
    (await readBackupCiStore(thrown, REPOSITORY, H, 5_000)).kind,
    "unavailable",
  );
  const ok = new FakeBackupCiReader(() => okRead(null));
  assert.equal((await readBackupCiStore(ok, REPOSITORY, H, 5_000)).kind, "ok");
});

Deno.test("adapter: listings are reused only inside their TTL, and a failed listing is never kept", async () => {
  let now = 1_000;
  const cache = new BackupCiListingCache(() => now);
  let loads = 0;
  const load = (value: unknown[] | null) => () => {
    loads++;
    return Promise.resolve(value);
  };
  assert.equal(await cache.read("k", load(null)), null);
  assert.deepEqual(await cache.read("k", load([1])), [1]);
  now += BACKUP_CI_LISTING_TTL_MS - 1;
  assert.deepEqual(await cache.read("k", load([2])), [1]);
  now += 1;
  assert.deepEqual(await cache.read("k", load([3])), [3]);
  assert.equal(loads, 3);
  // A clock that went backwards is no reuse either.
  now -= 10;
  assert.deepEqual(await cache.read("k", load([4])), [4]);
});

Deno.test("adapter: each log line is printed once per log", () => {
  const lines: string[] = [];
  const log = createBackupCiLog((line) => lines.push(line));
  log.once("sentinel_backup_ci_shadow", "r1", { receipt: "r1" });
  log.once("sentinel_backup_ci_shadow", "r1", { receipt: "r1" });
  log.once("sentinel_backup_ci_standin", "r1", { receipt: "r1" });
  assert.equal(lines.length, 2);
  createBackupCiLog(() => {
    throw new Error("sink");
  }).once("sentinel_backup_ci_shadow", "r", {});
});
