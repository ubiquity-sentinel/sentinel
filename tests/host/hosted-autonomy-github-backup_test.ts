/**
 * Backup CI in the launcher (docs/backup-ci-spec.md §11.4, §11.1 B6, §11.6):
 * the REAL repository surface over a stubbed `fetch` that models GitHub's
 * listings, with a fake receipt store. A verified receipt replaces exactly a
 * never-started raw run (name, head and check suite kept, so base coverage is
 * unchanged); a never-started run left over makes `hasAllChecksGreen` no
 * evidence (null), never red; `failedChecks` counts a substituted red; the
 * outage tracker still sees the target's own runs; and nothing extra is read
 * when no run never started. All synthetic.
 */
import { RED_BASE_CONCLUSIONS } from "../../src/repair/ci-rejection.ts";
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import { ciRerunRuns } from "../../ops/hosted-autonomy-ci-rerun.ts";
import type { BackupCiModeV1 } from "../../src/contracts/backup-ci.ts";
import type { BackupCiReadV1 } from "../../src/github/backup-ci-reader.ts";
import {
  B,
  CHECK,
  commitFile,
  H,
  key,
  result,
} from "../github/backup-ci-fixtures.ts";
import {
  consumer,
  EARLIER,
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
} from "../github/backup-ci-consumer-fixtures.ts";

const API = "https://api.github.com";
const BASE_RUN = RUN - 100;

interface Routes {
  latest: Record<string, Record<string, unknown>[]>;
  all?: Record<string, Record<string, unknown>[]>;
  jobs?: Record<number, unknown>;
  statuses?: Record<string, unknown>[];
}

function page(key: string, items: unknown[]) {
  return { total_count: items.length, [key]: items };
}

async function withFetch<T>(
  routes: Routes,
  body: () => Promise<T>,
  requested: string[] = [],
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
      .replace(`${API}${SCOPE}`, "");
    requested.push(url);
    let answer: unknown = 404;
    for (const head of [H, B]) {
      if (url === `/commits/${head}/check-runs?per_page=100&page=1`) {
        answer = page("check_runs", routes.latest[head] ?? []);
      }
      if (
        url === `/commits/${head}/check-runs?filter=all&per_page=100&page=1`
      ) {
        answer = page(
          "check_runs",
          routes.all?.[head] ?? routes.latest[head] ?? [],
        );
      }
      if (url === `/actions/runs?head_sha=${head}&per_page=50&page=1`) {
        answer = page("workflow_runs", [
          workflowRun(PUSH_SUITE, "push", {}, head),
        ]);
      }
      if (url === `/commits/${head}/status?per_page=100&page=1`) {
        answer = page("statuses", routes.statuses ?? []);
      }
    }
    const job = /^\/actions\/jobs\/(\d+)$/.exec(url);
    if (job !== null) answer = routes.jobs?.[Number(job[1])] ?? 404;
    return Promise.resolve(
      typeof answer === "number"
        ? new Response("{}", { status: answer })
        : new Response(JSON.stringify(answer), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

function surface(
  mode: BackupCiModeV1 = "on",
  read: (sha: string) => BackupCiReadV1 = () =>
    okRead(commitFile([result(key())])),
) {
  const reader = new FakeBackupCiReader(read);
  const { backupCi, lines } = consumer(mode, reader);
  return {
    github: createHostedAutonomyGitHub("token", REPOSITORY, backupCi),
    reader,
    lines,
  };
}

/** H never started (one push run); B ran natively green in the same suite. */
const NEVER_STARTED: Routes = {
  latest: {
    [H]: [rawRun(RUN)],
    [B]: [rawRun(BASE_RUN, { conclusion: "success" }, B)],
  },
  jobs: { [RUN]: neverStartedJob(RUN) },
};

Deno.test("launcher backup: a stand-in success makes the head green against its base coverage", async () => {
  const { github, lines } = surface();
  const green = await withFetch(
    NEVER_STARTED,
    () => github.hasAllChecksGreen(H, B),
  );
  assert.equal(green, true);
  assert.equal(JSON.parse(lines[0]).kind, "sentinel_backup_ci_standin");
  assert.deepEqual(
    await withFetch(
      NEVER_STARTED,
      () => github.failedChecks!(H, RED_BASE_CONCLUSIONS),
    ),
    [],
  );
});

Deno.test("launcher backup: a never-started run left over is no evidence (null), not red", async () => {
  const cases: [string, BackupCiReadV1][] = [
    ["no receipt", okRead(null)],
    [
      "provisional red",
      okRead(commitFile([result(key(), { conclusion: "failure" })])),
    ],
    ["store outage", { kind: "unavailable", detail: "synthetic" }],
    [
      "uncalibrated",
      okRead(commitFile([result(key())]), { calibration: null }),
    ],
  ];
  for (const [label, read] of cases) {
    const { github } = surface("on", () => read);
    const green = await withFetch(
      NEVER_STARTED,
      () => github.hasAllChecksGreen(H, B),
    );
    assert.equal(green, null, label);
    const failed = await withFetch(
      NEVER_STARTED,
      () => github.failedChecks!(H, RED_BASE_CONCLUSIONS),
    );
    assert.deepEqual(failed, [], `${label}: never started is no failure`);
  }
  // Off (and an unconfigured surface) keep the native answers exactly.
  for (
    const github of [
      surface("off").github,
      createHostedAutonomyGitHub("token", REPOSITORY),
    ]
  ) {
    assert.equal(
      await withFetch(NEVER_STARTED, () => github.hasAllChecksGreen(H, B)),
      false,
    );
  }
});

Deno.test("launcher backup: failedChecks counts a confirmed backup red, keeps native reds", async () => {
  const red = okRead(commitFile([
    result(key(), { conclusion: "failure" }),
    result(key({ attempt: 2 }), { conclusion: "timed_out" }),
  ]));
  const { github } = surface("on", () => red);
  const routes: Routes = {
    ...NEVER_STARTED,
    latest: {
      ...NEVER_STARTED.latest,
      [H]: [rawRun(RUN), rawRun(RUN + 1, { name: "lint" })],
    },
    jobs: { [RUN]: neverStartedJob(RUN), [RUN + 1]: startedJob(RUN + 1) },
  };
  const failed = await withFetch(
    routes,
    () => github.failedChecks!(H, RED_BASE_CONCLUSIONS),
  );
  assert.deepEqual(failed?.sort(), [CHECK, "lint"]);
  assert.equal(
    await withFetch(routes, () => github.hasAllChecksGreen(H, B)),
    false,
  );
});

Deno.test("launcher backup: the substituted run keeps name, head and check suite", async () => {
  // The base itself never started and stands in green: its suite still
  // expects `deno` on the head, which the head reports.
  const routes: Routes = {
    latest: { [H]: [rawRun(RUN)], [B]: [rawRun(BASE_RUN, {}, B)] },
    jobs: {
      [RUN]: neverStartedJob(RUN),
      [BASE_RUN]: neverStartedJob(BASE_RUN, B),
    },
  };
  const read = surface(
    "on",
    (sha) =>
      okRead(commitFile([result(key(), { commit: sha as typeof H })], {
        commit: sha as typeof H,
      })),
  );
  assert.equal(
    await withFetch(routes, () => read.github.hasAllChecksGreen(H, B)),
    true,
  );
  // A base suite whose expected name the head lacks is still not green.
  const missing: Routes = {
    ...routes,
    latest: {
      ...routes.latest,
      [B]: [
        rawRun(BASE_RUN, {}, B),
        rawRun(BASE_RUN + 1, { name: "e2e", conclusion: "success" }, B),
      ],
    },
  };
  assert.equal(
    await withFetch(missing, () => read.github.hasAllChecksGreen(H, B)),
    false,
  );
});

Deno.test("launcher backup: no never-started run means no listing, status or store read", async () => {
  const { github, reader } = surface();
  const requested: string[] = [];
  const routes: Routes = {
    latest: { [H]: [rawRun(RUN, { conclusion: "success" })] },
  };
  assert.equal(
    await withFetch(routes, () => github.hasAllChecksGreen(H), requested),
    true,
  );
  assert.deepEqual(requested, [`/commits/${H}/check-runs?per_page=100&page=1`]);
  assert.deepEqual(reader.reads, []);
  // With a never-started run the statuses are read too, with the same token.
  const seen: string[] = [];
  await withFetch(NEVER_STARTED, () => github.hasAllChecksGreen(H), seen);
  assert.ok(seen.includes(`/commits/${H}/status?per_page=100&page=1`));
  assert.ok(
    seen.includes(`/commits/${H}/check-runs?filter=all&per_page=100&page=1`),
  );
});

Deno.test("launcher backup: an earlier natively started attempt refuses; shadow changes nothing", async () => {
  const hidden: Routes = {
    ...NEVER_STARTED,
    all: { [H]: [rawRun(EARLIER), rawRun(RUN)] },
    jobs: { [RUN]: neverStartedJob(RUN), [EARLIER]: startedJob(EARLIER) },
  };
  const { github } = surface();
  assert.equal(
    await withFetch(hidden, () => github.hasAllChecksGreen(H, B)),
    null,
  );
  const shadow = surface("shadow");
  assert.equal(
    await withFetch(NEVER_STARTED, () => shadow.github.hasAllChecksGreen(H, B)),
    false,
    "shadow keeps the native answer",
  );
  assert.equal(JSON.parse(shadow.lines[0]).kind, "sentinel_backup_ci_shadow");
  // Shadow without evidence (or with the store down) is the native answer
  // too: the invariant's no-evidence reading is `on` only.
  for (
    const read of [
      okRead(null),
      { kind: "unavailable", detail: "synthetic" } as BackupCiReadV1,
    ]
  ) {
    const quiet = surface("shadow", () => read);
    assert.equal(
      await withFetch(
        NEVER_STARTED,
        () => quiet.github.hasAllChecksGreen(H, B),
      ),
      false,
    );
  }
});

Deno.test("launcher backup: the outage tracker reads the target's own runs, not stand-ins", async () => {
  const { github } = surface();
  const start = await withFetch(
    NEVER_STARTED,
    () => github.classifyTipStart!(H),
  );
  assert.deepEqual(start, { neverStarted: 1, started: 0, unknown: 0 });
});

Deno.test("flake re-run interplay (§11.6): a head re-run past attempt 1 has nothing left to re-run", () => {
  const runs = [{
    id: 40031,
    headSha: H,
    status: "completed",
    conclusion: "failure",
    runAttempt: 2,
    createdAt: Date.parse("2026-10-25T08:00:00Z"),
  }];
  assert.deepEqual(
    ciRerunRuns(runs, H, Date.parse("2026-10-25T09:00:00Z")),
    [],
  );
});
