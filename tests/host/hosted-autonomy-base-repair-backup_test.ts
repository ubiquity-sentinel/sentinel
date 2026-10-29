/**
 * Base repair over backup CI evidence (docs/backup-ci-spec.md §11.5): the
 * REAL repository surface (stubbed `fetch`, fake receipt store) under the
 * REAL base-repair pass. A target tip whose never-started check has a
 * confirmed red backup result from a calibrated runner is a red base and
 * files its base-repair issue (a held head fails the same check); an uncalibrated runner, a provisional red and a tip
 * without any receipt file nothing (the never-started run is no failure).
 * All synthetic.
 */
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import { runHostedBaseRepairPass } from "../../ops/hosted-autonomy-base-repair.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BackupCiReadV1 } from "../../src/github/backup-ci-reader.ts";
import {
  calibration,
  commitFile,
  coverage,
  key,
  result,
} from "../github/backup-ci-fixtures.ts";
import {
  consumer,
  FakeBackupCiReader,
  neverStartedJob,
  okRead,
  PUSH_SUITE,
  rawRun,
  RUN,
  workflowRun,
} from "../github/backup-ci-consumer-fixtures.ts";
import {
  GATEWAY,
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  NOW,
  TIP,
} from "./hosted-autonomy-spent-fixtures.ts";

const SCOPE = `/repos/${GATEWAY.owner}/${GATEWAY.name}`;
const SLUG = `${GATEWAY.owner}/${GATEWAY.name}` as const;
const ID = 812345679;
const BOUND = { owner: GATEWAY.owner, name: GATEWAY.name, id: ID };
const HEAD = TIP as GitSha;

function file(entries: ReturnType<typeof result>[]) {
  return commitFile(entries, {
    repository: BOUND,
    commit: HEAD,
    workflows: [coverage()],
  });
}

const CONFIRMED_RED = [
  result(key(), { conclusion: "failure", commit: HEAD }),
  result(key({ attempt: 2 }), { conclusion: "failure", commit: HEAD }),
];
const CALIBRATED = { ...calibration(), repository: BOUND };

async function withFetch<T>(body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const runs = [rawRun(RUN, {}, HEAD)];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
      .replace(`https://api.github.com${SCOPE}`, "");
    let answer: unknown = 404;
    if (url.startsWith(`/commits/${HEAD}/check-runs?`)) {
      answer = { total_count: runs.length, check_runs: runs };
    }
    if (url.startsWith(`/actions/runs?head_sha=${HEAD}`)) {
      answer = {
        total_count: 1,
        workflow_runs: [workflowRun(PUSH_SUITE, "push", {}, HEAD)],
      };
    }
    if (url.startsWith(`/commits/${HEAD}/status?`)) {
      answer = { total_count: 0, statuses: [] };
    }
    if (url === `/actions/jobs/${RUN}`) answer = neverStartedJob(RUN, HEAD);
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

async function pass(label: string, read: BackupCiReadV1) {
  // Held on the tip by the red-base hold, with a head that fails the same
  // check (the reworked pass files only for checks a held head fails).
  const { candidateState: _dropped, ...target } = liveRecord(618).target;
  const record = liveRecord(618, {
    nextStep: "work",
    blocker: null,
    wait: { reason: "backoff", since: NOW - 60_000, until: NOW + 1_740_000 },
    target: { ...target, base: TIP, head: HEAD },
  });
  const filed: unknown[] = [];
  const { surface: base } = liveSurface({ tip: TIP });
  const reader = new FakeBackupCiReader(() => read, [{
    repository: SLUG,
    id: ID,
  }]);
  const real = createHostedAutonomyGitHub(
    "token",
    GATEWAY,
    consumer("on", reader).backupCi,
  );
  const combined: HostedAutonomyGitHubV1 = {
    ...base,
    failedChecks: real.failedChecks,
    baseRepairIssues: {
      listAppAuthored: () => Promise.resolve([]),
      create: (input) => {
        filed.push(input);
        return Promise.resolve(4242);
      },
    },
  };
  const rig = await liveRig(
    `backup-base-${label}`,
    liveSnapshot([record], []),
    combined,
  );
  try {
    const actions = await withFetch(() =>
      runHostedBaseRepairPass(
        {
          state: rig.state,
          githubFor: rig.githubFor,
          clock: { now: () => NOW },
        },
        undefined,
        { filing: true },
      )
    );
    return { actions, filed };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("base repair backup: a calibrated, confirmed backup red on the tip files its issue", async () => {
  const { actions, filed } = await pass(
    "red",
    okRead(file(CONFIRMED_RED), { calibration: CALIBRATED }),
  );
  assert.deepEqual(actions, ["base-repair:ubiquity/ai.ubq.fi:filed=#4242"]);
  assert.equal(filed.length, 1);
});

Deno.test("base repair backup: uncalibrated, provisional or missing backup evidence files nothing", async () => {
  const cases: [string, BackupCiReadV1][] = [
    ["uncal", okRead(file(CONFIRMED_RED), { calibration: null })],
    [
      "prov",
      okRead(file([CONFIRMED_RED[0]]), { calibration: CALIBRATED }),
    ],
    ["none", okRead(null, { calibration: CALIBRATED })],
    ["outage", { kind: "unavailable", detail: "synthetic" }],
  ];
  for (const [label, read] of cases) {
    const { actions, filed } = await pass(label, read);
    assert.deepEqual(actions, [], label);
    assert.deepEqual(filed, [], `${label}: a billing stop is no code fix`);
  }
});
