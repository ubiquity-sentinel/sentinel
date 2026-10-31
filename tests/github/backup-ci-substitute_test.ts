/**
 * The shared stand-in rule (docs/backup-ci-spec.md §11.1, `selectBackupStandIns`):
 * a verified, calibrated, unsuspended receipt stands in for a check name only
 * when every attempt of it never started under one workflow path, no commit
 * status shares its name, the workflow's coverage is complete, and every
 * latest observation resolves; a red needs its confirmation; a resolved red
 * beats a success; shadow applies nothing; peers attach only to natively
 * started names. All synthetic.
 */
import assert from "node:assert/strict";
import type { GitHubCheckV1 } from "../../src/contracts/ports-github-requests.ts";
import {
  type BackupCiObservationV1,
  type BackupCiSelectInputV1,
  resolveBackupEntries,
  selectBackupStandIns,
  standInCheck,
  standInRawRun,
} from "../../src/github/backup-ci-substitute.ts";
import {
  calibration,
  CHECK,
  commitFile,
  coverage,
  H,
  key,
  OTHER,
  REPO,
  result,
  RUNNER,
  RUNNER2,
  suspension,
  T0,
  TARGET,
  WORKFLOW,
} from "./backup-ci-fixtures.ts";

const PUSH_SUITE = 11;
const PR_SUITE = 12;
const OTHER_PATH_SUITE = 13;
const SUITES = [
  { suiteId: PUSH_SUITE, workflowPath: WORKFLOW, event: "push" },
  { suiteId: PR_SUITE, workflowPath: WORKFLOW, event: "pull_request" },
  {
    suiteId: OTHER_PATH_SUITE,
    workflowPath: ".github/workflows/other.yml",
    event: "push",
  },
];
const PR = key({ context: "pull_request" });

function obs(
  checkRunId: number,
  over: Partial<BackupCiObservationV1> = {},
): BackupCiObservationV1 {
  return {
    checkRunId,
    name: CHECK,
    app: "github-actions",
    suiteId: PUSH_SUITE,
    status: "completed",
    conclusion: "failure",
    startedAt: T0 + checkRunId,
    completedAt: T0 + checkRunId + 1_000,
    notStarted: true,
    ...over,
  };
}

/** A never-started push observation, a success receipt, calibrated, `on`. */
function input(
  over: Partial<BackupCiSelectInputV1> = {},
): BackupCiSelectInputV1 {
  return {
    target: TARGET,
    commit: H,
    mode: "on",
    latest: [obs(102)],
    all: [obs(101), obs(102)],
    suites: SUITES,
    statusContexts: new Set(),
    file: commitFile([result()]),
    suspensions: [],
    calibration: calibration(),
    ...over,
  };
}

function conclusions(i: BackupCiSelectInputV1): [number, string][] {
  return [...selectBackupStandIns(i).standIns.values()].map((s) => [
    s.checkRunId,
    s.conclusion,
  ]);
}

Deno.test("a never-started name with a calibrated receipt gets a stand-in", () => {
  const selection = selectBackupStandIns(input());
  assert.deepEqual(selection.refusals, []);
  assert.deepEqual([...selection.standIns.keys()], [102]);
  assert.deepEqual(selection.standIns.get(102), {
    checkRunId: 102,
    name: CHECK,
    conclusion: "success",
    backup: {
      receipt:
        "bci1:ubiquity/passport.ubq.fi@aaaaaaaaaaaa:.github/workflows/ci.yml#deno:push:a1",
      context: "push",
      runnerId: RUNNER,
      legRunId: 5001,
      legJobId: 6001,
    },
  });
  assert.deepEqual(selection.shadow, []);
  assert.equal(selection.peers.size, 0);
});

Deno.test("an earlier started attempt hidden by the latest listing refuses", () => {
  const started = obs(100, { notStarted: false });
  const selection = selectBackupStandIns(input({
    all: [started, obs(101), obs(102)],
  }));
  assert.equal(selection.standIns.size, 0);
  assert.deepEqual(selection.refusals, ["started:deno"]);
  // An unknown start (null) is treated as started.
  assert.deepEqual(
    conclusions(input({ all: [obs(101, { notStarted: null }), obs(102)] })),
    [],
  );
  assert.deepEqual(
    conclusions(input({ latest: [obs(102, { notStarted: null })] })),
    [],
  );
});

Deno.test("a status context, another app or a second path refuses the name", () => {
  const status = selectBackupStandIns(
    input({ statusContexts: new Set([CHECK]) }),
  );
  assert.deepEqual([status.standIns.size, status.refusals], [0, [
    "status_context:deno",
  ]]);
  const app = selectBackupStandIns(input({
    all: [obs(101, { app: "circleci" }), obs(102)],
  }));
  assert.deepEqual([app.standIns.size, app.refusals], [0, ["other_app:deno"]]);
  const paths = selectBackupStandIns(input({
    all: [obs(101, { suiteId: OTHER_PATH_SUITE }), obs(102)],
  }));
  assert.deepEqual([paths.standIns.size, paths.refusals], [0, [
    "mixed_paths:deno",
  ]]);
  const unknown = selectBackupStandIns(input({
    all: [obs(101, { suiteId: 99 }), obs(102)],
  }));
  assert.deepEqual(unknown.refusals, ["unknown_suite:deno"]);
  // A latest observation the all-attempts listing does not hold.
  assert.deepEqual(conclusions(input({ all: [obs(101)] })), []);
});

Deno.test("partial coverage refuses the name", () => {
  // Another expected name of the workflow has no observation on the commit.
  const partial = commitFile([result()], {
    workflows: [coverage({ expected: [CHECK, "lint"] })],
  });
  assert.deepEqual(selectBackupStandIns(input({ file: partial })).refusals, [
    "coverage:deno",
  ]);
  // Completed by an observation of that name under the same path.
  const lint = obs(103, {
    name: "lint",
    notStarted: false,
    conclusion: "success",
  });
  assert.deepEqual(
    conclusions(input({ file: partial, all: [obs(101), obs(102), lint] })),
    [[102, "success"]],
  );
  // An unsupported or missing coverage row for an observed event.
  for (
    const workflows of [
      [coverage({ supported: false, reason: "needs_or_job_if" })],
      [coverage({ event: "pull_request" })],
    ]
  ) {
    assert.deepEqual(
      conclusions(input({ file: commitFile([result()], { workflows }) })),
      [],
    );
  }
  // A receipt for another workflow blob than the covered one.
  assert.deepEqual(
    conclusions(input({ file: commitFile([result(key(), { blob: OTHER })]) })),
    [],
  );
});

Deno.test("contexts bind: pull_request needs its own receipt, push takes either", () => {
  const prObs = obs(102, { suiteId: PR_SUITE });
  assert.deepEqual(
    conclusions(
      input({ latest: [prObs], all: [obs(101, { suiteId: PR_SUITE }), prObs] }),
    ),
    [],
  );
  const prFile = commitFile([result(PR)]);
  assert.deepEqual(
    conclusions(input({
      latest: [prObs],
      all: [obs(101, { suiteId: PR_SUITE }), prObs],
      file: prFile,
    })),
    [[102, "success"]],
  );
  const push = selectBackupStandIns(input({ file: prFile }));
  assert.equal(push.standIns.get(102)?.backup.context, "pull_request");
  assert.match(
    push.standIns.get(102)?.backup.receipt ?? "",
    /:pull_request:bbbbbbbbbbbb:a1$/,
  );
});

Deno.test("a red needs its confirmation, and attempt 2 decides", () => {
  const a1Red = result(key(), { conclusion: "failure" });
  assert.deepEqual(conclusions(input({ file: commitFile([a1Red]) })), []);
  assert.deepEqual(
    selectBackupStandIns(input({ file: commitFile([a1Red]) })).refusals,
    ["unresolved:deno"],
  );
  const a2Green = result(key({ attempt: 2 }), { resultDigest: "4".repeat(64) });
  assert.deepEqual(
    conclusions(input({ file: commitFile([a1Red, a2Green]) })),
    [[102, "success"]],
  );
  const a2Red = result(key({ attempt: 2 }), { conclusion: "timed_out" });
  assert.deepEqual(
    conclusions(input({ file: commitFile([a1Red, a2Red]) })),
    [[102, "timed_out"]],
  );
  // Attempt 2 alone decides nothing.
  assert.equal(resolveBackupEntries([a2Green]), null);
});

Deno.test("a resolved red beats a success across contexts", () => {
  const file = commitFile([
    result(),
    result(PR, { conclusion: "failure" }),
    result({ ...PR, attempt: 2 }, { conclusion: "failure" }),
  ]);
  assert.deepEqual(conclusions(input({ file })), [[102, "failure"]]);
  // An unconfirmed red in another context leaves the success standing.
  const provisional = commitFile([
    result(),
    result(PR, { conclusion: "failure" }),
  ]);
  assert.deepEqual(conclusions(input({ file: provisional })), [[
    102,
    "success",
  ]]);
  assert.equal(resolveBackupEntries(file.entries), "failure");
});

Deno.test("shadow computes stand-ins into the shadow list only", () => {
  const selection = selectBackupStandIns(input({ mode: "shadow" }));
  assert.equal(selection.standIns.size, 0);
  assert.deepEqual(selection.shadow.map((s) => [s.checkRunId, s.conclusion]), [
    [102, "success"],
  ]);
  const off = selectBackupStandIns(input({ mode: "off" }));
  assert.deepEqual([off.standIns.size, off.shadow.length], [0, 0]);
  // A shadow-mode result is never evidence for `on`.
  assert.deepEqual(
    conclusions(
      input({ file: commitFile([result(key(), { mode: "shadow" })]) }),
    ),
    [],
  );
});

Deno.test("an uncalibrated or suspended runner, or a wrong binding, gives none", () => {
  assert.deepEqual(conclusions(input({ calibration: null })), []);
  assert.deepEqual(
    conclusions(input({ calibration: calibration([{ runnerId: RUNNER2 }]) })),
    [],
  );
  assert.deepEqual(
    conclusions(
      input({
        calibration: calibration([{ runnerId: RUNNER, falseGreens: 1 }]),
      }),
    ),
    [],
  );
  assert.deepEqual(
    conclusions(input({
      calibration: {
        ...calibration(),
        repository: { ...calibration().repository, id: 1 },
      },
    })),
    [],
  );
  for (
    const s of [
      suspension({ scope: "all" }),
      suspension(),
      suspension({ runnerIds: "all" }),
    ]
  ) {
    assert.deepEqual(conclusions(input({ suspensions: [s] })), [], s.scope);
  }
  // Another runner's suspension, or another target's, does not apply.
  assert.deepEqual(
    conclusions(input({
      suspensions: [
        suspension({ runnerIds: [RUNNER2] }),
        suspension({ scope: "ubiquity/ai.ubq.fi" }),
      ],
    })),
    [[102, "success"]],
  );
  // A file of another repository id, even with that id's calibration.
  const otherId = input({
    target: { repository: REPO, id: 7 },
    calibration: {
      ...calibration(),
      repository: { ...calibration().repository, id: 7 },
    },
  });
  assert.deepEqual(conclusions(otherId), []);
  assert.deepEqual(selectBackupStandIns(otherId).refusals, ["binding:file"]);
  assert.deepEqual(conclusions(input({ commit: OTHER })), []);
  assert.deepEqual(
    selectBackupStandIns(input({ commit: OTHER })).refusals,
    ["binding:file"],
  );
  assert.deepEqual(conclusions(input({ file: null })), []);
});

Deno.test("all or nothing within a group", () => {
  // A push and a pull_request observation; only the push one resolves.
  const latest = [obs(102), obs(104, { suiteId: PR_SUITE })];
  const all = [obs(101), obs(102), obs(103, { suiteId: PR_SUITE }), latest[1]];
  assert.deepEqual(conclusions(input({ latest, all })), []);
  // A pull_request receipt resolves both (push takes pull_request too).
  assert.deepEqual(
    conclusions(input({ latest, all, file: commitFile([result(PR)]) })),
    [[102, "success"], [104, "success"]],
  );
});

Deno.test("peers attach only to natively started names", () => {
  const native = (id: number) =>
    obs(id, { notStarted: false, conclusion: "failure" });
  const peer = selectBackupStandIns(input({
    latest: [native(102)],
    all: [native(101), native(102)],
    file: commitFile([result(key(), { conclusion: "success" })]),
  }));
  assert.equal(peer.standIns.size, 0);
  assert.deepEqual(peer.peers.get(CHECK), {
    conclusion: "success",
    receipt:
      "bci1:ubiquity/passport.ubq.fi@aaaaaaaaaaaa:.github/workflows/ci.yml#deno:push:a1",
  });
  // Never-started names, unknown starts, shadow and uncalibrated runners
  // give no peer.
  assert.equal(selectBackupStandIns(input()).peers.size, 0);
  const unknown = selectBackupStandIns(input({
    latest: [native(102)],
    all: [native(101), obs(102, { notStarted: null })],
  }));
  assert.equal(unknown.peers.size, 0);
  const shadow = selectBackupStandIns(input({
    mode: "shadow",
    latest: [native(102)],
    all: [native(102)],
  }));
  assert.equal(shadow.peers.size, 0);
  const uncalibrated = selectBackupStandIns(input({
    latest: [native(102)],
    all: [native(102)],
    calibration: null,
  }));
  assert.equal(uncalibrated.peers.size, 0);
});

Deno.test("a stand-in keeps the original's name, head and timestamps", () => {
  const original: GitHubCheckV1 = {
    name: CHECK,
    status: "completed",
    conclusion: "failure",
    head: H,
    startedAt: T0,
    completedAt: T0 + 1_000,
    neverStarted: true,
  };
  const s = selectBackupStandIns(input()).standIns.get(102)!;
  const check = standInCheck(original, s);
  assert.deepEqual(check, {
    name: CHECK,
    status: "completed",
    conclusion: "success",
    head: H,
    startedAt: T0,
    completedAt: T0 + 1_000,
    backup: s.backup,
  });
  assert.equal("neverStarted" in check, false);
  const raw = {
    id: 102,
    name: CHECK,
    head_sha: H,
    status: "completed",
    conclusion: "failure",
    started_at: "2026-10-25T08:00:00Z",
    check_suite: { id: PUSH_SUITE },
    app: { slug: "github-actions" },
  };
  assert.deepEqual(standInRawRun(raw, s), {
    ...raw,
    conclusion: "success",
    sentinel_backup: { receipt: s.backup.receipt, runnerId: RUNNER },
  });
});
