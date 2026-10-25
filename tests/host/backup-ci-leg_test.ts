/**
 * The untrusted leg (docs/backup-ci-spec.md §10) end to end on one VM's
 * worth of temporary directories, with real git and tar and a fake act
 * service: `prepare` refuses a wrong tree or unit digest, a HEAD, tree,
 * parents or workflow blob mismatch, a dirty checkout, a workflow mode
 * change, act configuration in HOME, a non-fresh workspace and an unsafe
 * tar listing; the self-test must pass (a failing probe stops the leg before
 * any target code); `run` classifies act's records into `result.json`,
 * which carries no target string; `marker` prints the one bound line.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  backupCiUnitDigest,
  type BackupCiUnitV1,
  parseBackupCiResult,
} from "../../src/contracts/backup-ci.ts";
import {
  type BackupCiPinsV1,
  backupCiRunnerId,
  buildEventPayload,
} from "../../ops/backup-ci-act.ts";
import {
  type BackupCiLegDepsV1,
  backupCiLegLayout,
  legMarker,
  legPrepare,
  legRun,
  tarListingSafe,
} from "../../ops/backup-ci-leg.ts";
import {
  createBackupCiGit,
  fetchBackupCiBare,
  packBackupCiBare,
} from "../../ops/backup-ci-materialize.ts";
import { buildBackupCiUnit } from "../../ops/backup-ci-plan.ts";
import {
  planBackupCiJob,
  readBackupCiWorkflow,
} from "../../ops/backup-ci-workflow-map.ts";
import {
  fixtureGit,
  targetRepo,
  type TargetRepoV1,
} from "./backup-ci-test-repo.ts";

const PINS: BackupCiPinsV1 = {
  act: {
    version: "v0.2.82",
    releasedAt: "2026-09-01",
    asset: "act_Linux_x86_64.tar.gz",
    sha256: "c".repeat(64),
  },
  node: "24.19.0",
};
const RUNNER = backupCiRunnerId(PINS);
const WORKFLOW = `name: CI
on: [push, pull_request]
jobs:
  deno:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - run: deno task check
      - id: tests
        run: deno task test
`;
const PATH = ".github/workflows/ci.yml";
const T0 = Date.parse("2026-10-25T08:00:00Z");

type ActScript = (
  act: string[],
  selftest: boolean,
) => { lines: string[]; code: number };

/** act-style JSON records: every step `result`, then the job result. */
function actRecords(
  job: string,
  ids: string[],
  results: string[],
  jobResult: string,
): string[] {
  const lines = ids.flatMap((id, i) => [
    JSON.stringify({
      level: "info",
      jobID: job,
      matrix: {},
      stage: "Main",
      stepID: [id],
      msg: `::warning::step ${id} ##[group]x`,
      raw_output: true,
    }),
    ...(results[i] === undefined ? [] : [
      JSON.stringify({
        level: "info",
        jobID: job,
        matrix: {},
        stage: "Main",
        stepID: [id],
        stepResult: results[i],
        msg: "done",
      }),
    ]),
  ]);
  return [
    ...lines,
    JSON.stringify({
      level: "info",
      jobID: job,
      matrix: {},
      jobResult,
      msg: "🏁 Job",
    }),
  ];
}
const SELFTEST_IDS = [
  "checkout",
  "local",
  "env",
  "secret",
  "var",
  "exec",
  "head",
  "repository",
  "event",
];
const passingAct: ActScript = (_act, selftest) =>
  selftest
    ? {
      lines: actRecords(
        "selftest",
        SELFTEST_IDS,
        SELFTEST_IDS.map(() => "success"),
        "success",
      ),
      code: 0,
    }
    : {
      lines: actRecords("deno", ["0", "1", "tests"], [
        "success",
        "success",
        "success",
      ], "success"),
      code: 0,
    };

interface Rig {
  root: string;
  repo: TargetRepoV1;
  unit: BackupCiUnitV1;
  tarSha: string;
  printed: string[];
  services: string[][];
  deps(
    over?: { env?: Record<string, string | undefined>; act?: ActScript },
  ): BackupCiLegDepsV1;
  close(): Promise<void>;
}

async function rig(options: {
  files?: Record<string, string | { text: string; mode: number }>;
  unit?: (u: BackupCiUnitV1) => BackupCiUnitV1;
} = {}): Promise<Rig> {
  const repo = await targetRepo("backup-ci-leg-");
  const root = repo.root;
  const base = await repo.commit({ "README.md": "base\n" });
  const head = await repo.commit({
    [PATH]: WORKFLOW,
    "src/a.ts": "export {};\n",
    ...(options.files ?? {}),
  });
  const git = createBackupCiGit(`${root}/home-trusted`);
  const bare = await fetchBackupCiBare({
    git,
    dir: `${root}/plan/bare`,
    remoteUrl: repo.url,
    token: null,
    commits: [head],
    protocols: ["file"],
  });
  assert(bare !== null);
  const tree = (await bare.treeOf(head))!;
  const entry = (await bare.entry(head, PATH))!;
  const workflow = readBackupCiWorkflow(
    PATH,
    "100644",
    (await bare.readBlob(entry.oid, 1 << 20))!,
  );
  const planned = planBackupCiJob(workflow, "deno");
  assert(planned.ok && workflow.ok);
  const repository = {
    owner: "ubiquity",
    name: "passport.ubq.fi",
    id: 1,
    defaultBranch: "main",
    private: true,
  };
  let unit = buildBackupCiUnit({
    purpose: "stand_in",
    key: {
      context: "push",
      workflowPath: PATH,
      checkName: "deno",
      base: null,
      attempt: 1,
    },
    repository,
    commit: head,
    exec: { commit: head, parents: [base], tree, synthetic: false },
    pullRequest: null,
    ref: "refs/heads/main",
    workflow: { path: PATH, blob: entry.oid, name: workflow.name },
    job: planned.plan.job,
    steps: planned.plan.steps,
    event: buildEventPayload({
      context: "push",
      repository,
      commit: head,
      ref: "refs/heads/main",
      before: base,
      pull: null,
    }),
    neverStarted: { checkRunIds: [11], runIds: [21], cause: "account_billing" },
    native: null,
  }, {
    runId: 9001,
    launcherSha: "e".repeat(40) as GitSha,
    plannedAt: T0,
    mode: "on",
    runnerId: RUNNER,
  });
  if (options.unit !== undefined) unit = options.unit(unit);
  assert(await bare.setExec(head));
  await bare.writeUnit(unit);
  const runTemp = `${root}/rt`;
  const layout = backupCiLegLayout(runTemp);
  await Deno.mkdir(layout.input, { recursive: true });
  const packed = await packBackupCiBare(bare, `${layout.input}/0.tar`, []);
  assert(packed.ok);
  // A launcher root: the self-test fixture and a filled pin.
  const launcher = `${root}/launcher`;
  await Deno.mkdir(`${launcher}/ops`, { recursive: true });
  await Deno.writeTextFile(
    `${launcher}/ops/backup-ci-pins.json`,
    JSON.stringify(PINS),
  );
  await new Deno.Command("cp", {
    args: ["-a", "tests/fixtures/backup-ci/selftest", `${launcher}/selftest`],
  }).output();
  await Deno.mkdir(`${launcher}/tests/fixtures/backup-ci`, { recursive: true });
  await Deno.rename(
    `${launcher}/selftest`,
    `${launcher}/tests/fixtures/backup-ci/selftest`,
  );
  await Deno.mkdir(`${root}/home`, { recursive: true });
  const printed: string[] = [];
  const services: string[][] = [];
  let clock = T0 + 60_000;
  return {
    root,
    repo,
    unit,
    tarSha: packed.sha256,
    printed,
    services,
    deps(over = {}) {
      const env: Record<string, string | undefined> = {
        BACKUP_UNIT: unit.unitId,
        BACKUP_UNIT_DIGEST: backupCiUnitDigest(unit),
        BACKUP_TREE_SHA256: packed.sha256,
        ImageOS: "ubuntu24",
        ImageVersion: "20261020.1.0",
        ...(over.env ?? {}),
      };
      return {
        env: (name) => env[name],
        runTemp,
        launcherRoot: launcher,
        home: `${root}/home`,
        now: () => (clock += 1000),
        print: (line) => printed.push(line),
        git: createBackupCiGit(`${root}/home-leg`),
        async tar(args) {
          const out = await new Deno.Command("tar", {
            args,
            stdout: "piped",
            stderr: "null",
          }).output();
          return {
            code: out.code,
            stdout: new TextDecoder().decode(out.stdout),
          };
        },
        async service(argv, onLine) {
          services.push(argv);
          assert.equal(argv[0], "systemd-run");
          const act = argv.slice(argv.indexOf("--") + 1);
          const selftest = act.includes("selftest");
          assert(!act.join(" ").includes("docker"));
          if (selftest) {
            const ws = act[act.indexOf("-C") + 1];
            for (
              const planted of [
                ".actrc",
                ".env",
                ".secrets",
                ".vars",
                ".input",
                "local-only.txt",
              ]
            ) {
              await Deno.stat(`${ws}/${planted}`);
            }
            assert.equal(
              (await Deno.stat(`${ws}/probe.sh`)).mode! & 0o111,
              0o111,
            );
            const wf = await Deno.readTextFile(
              `${ws}/.github/workflows/selftest.yml`,
            );
            assert(
              wf.includes("uses: actions/checkout@v6") &&
                wf.includes("runs-on: ubuntu-latest"),
            );
          }
          for (
            const flag of [
              "--env-file",
              "--secret-file",
              "--var-file",
              "--input-file",
            ]
          ) {
            assert.equal(
              await Deno.readTextFile(act[act.indexOf(flag) + 1]),
              "",
            );
          }
          const script = (over.act ?? passingAct)(act, selftest);
          for (const line of script.lines) onLine(line);
          return { code: script.code, elapsedMs: 5_000 };
        },
        etcEnvironment: () => Promise.resolve("PATH=/usr/bin:/bin\n"),
        nodeDir: () => Promise.resolve("/usr/bin"),
        actVersion: () => Promise.resolve("act version 0.2.82"),
      };
    },
    close: () => repo.close(),
  };
}

Deno.test("prepare verifies the unit and passes the self-test; run and marker report", async () => {
  const r = await rig();
  try {
    assert.equal(await legPrepare(r.deps()), 0, r.printed.join("\n"));
    assert.equal(r.services.length, 1);
    const layout = backupCiLegLayout(`${r.root}/rt`);
    const observed = JSON.parse(await Deno.readTextFile(layout.observed));
    assert.deepEqual(observed, {
      clean: true,
      head: r.unit.exec.commit,
      parents: r.unit.exec.parents,
      tree: r.unit.exec.tree,
      workflowBlob: r.unit.workflow.blob,
    });
    assert.equal(
      await fixtureGit(layout.ws, ["remote", "get-url", "origin"]),
      "https://github.com/ubiquity/passport.ubq.fi",
    );
    assert.equal(await legRun(r.deps()), 0, r.printed.join("\n"));
    assert.equal(r.services.length, 2);
    const bytes = await Deno.readFile(layout.result);
    const result = parseBackupCiResult(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    assert.equal(result.outcome, "success");
    assert.equal(result.runner.runnerId, RUNNER);
    assert.deepEqual(result.steps.map((s) => s.result), [
      "success",
      "success",
      "success",
    ]);
    // No target-derived string in the result.
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") {
        Object.values(v).forEach(walk);
      }
    };
    walk(JSON.parse(new TextDecoder().decode(bytes)));
    const allowed =
      /^(?:[0-9a-f]{16}|[0-9a-f]{24}|[0-9a-f]{40}|[0-9a-f]{64}|sentinel_backup_ci_result|passed|success|failure|skipped|missing|cancelled|ubuntu24|20261020\.1\.0)$/;
    assert.deepEqual(strings.filter((s) => !allowed.test(s)), []);
    // The target's log lines were neutralized and prefixed by step.
    const between = r.printed.filter((l) => l.startsWith("│ ["));
    assert(
      between.some((l) =>
        l.startsWith("│ [2] :\u200b:warning:\u200b:step tests #\u200b#[group]x")
      ),
    );
    assert(!between.some((l) => l.includes("::") || l.includes("##[")));
    r.printed.length = 0;
    assert.equal(
      await legMarker(r.deps({ env: { BACKUP_RESULT_ARTIFACT: "7001" } })),
      0,
    );
    assert.deepEqual(r.printed, [JSON.stringify({
      kind: "sentinel_backup_ci_leg_result",
      unitId: r.unit.unitId,
      unitDigest: backupCiUnitDigest(r.unit),
      resultDigest: createHash("sha256").update(bytes).digest("hex"),
      artifactId: 7001,
    })]);
    assert.equal(
      await legMarker(r.deps({ env: { BACKUP_RESULT_ARTIFACT: "x" } })),
      1,
    );
    assert.equal(
      await legMarker(
        r.deps({
          env: { BACKUP_UNIT: "f".repeat(24), BACKUP_RESULT_ARTIFACT: "1" },
        }),
      ),
      1,
    );
  } finally {
    await r.close();
  }
});

Deno.test("a red target step is classified failure with its failing step", async () => {
  const r = await rig();
  try {
    const red: ActScript = (act, selftest) =>
      selftest ? passingAct(act, true) : {
        lines: actRecords("deno", ["0", "1", "tests"], [
          "success",
          "success",
          "failure",
        ], "failure"),
        code: 1,
      };
    assert.equal(await legPrepare(r.deps({ act: red })), 0);
    assert.equal(await legRun(r.deps({ act: red })), 0);
    const layout = backupCiLegLayout(`${r.root}/rt`);
    const result = parseBackupCiResult(
      JSON.parse(await Deno.readTextFile(layout.result)),
    );
    assert.equal(result.outcome, "failure");
    assert.equal(result.failingStep, 2);
    assert.equal(result.act.exitCode, 1);
  } finally {
    await r.close();
  }
});

Deno.test("a failing self-test stops the leg before the target job", async () => {
  const r = await rig();
  try {
    const leaky: ActScript = (_act, selftest) => ({
      lines: actRecords(
        selftest ? "selftest" : "deno",
        SELFTEST_IDS,
        SELFTEST_IDS.map((id) => id === "env" ? "failure" : "success"),
        "failure",
      ),
      code: 1,
    });
    assert.equal(await legPrepare(r.deps({ act: leaky })), 1);
    assert(r.printed.some((l) => l.includes("self-test failed")));
    assert.equal(r.services.length, 1);
  } finally {
    await r.close();
  }
});

const REFUSALS: [
  string,
  (r: Rig) => Promise<Record<string, string | undefined> | void>,
  string,
][] = [
  [
    "tree digest",
    () => Promise.resolve({ BACKUP_TREE_SHA256: "0".repeat(64) }),
    "tree digest mismatch",
  ],
  [
    "unit digest",
    () => Promise.resolve({ BACKUP_UNIT_DIGEST: "0".repeat(64) }),
    "unit digest mismatch",
  ],
  [
    "unit id",
    () => Promise.resolve({ BACKUP_UNIT: "0".repeat(24) }),
    "unit digest mismatch",
  ],
  [
    "HOME .actrc",
    async (r) =>
      await Deno.writeTextFile(`${r.root}/home/.actrc`, "--env X=1\n"),
    "act configuration in HOME",
  ],
  [
    "HOME act config",
    async (r) =>
      await Deno.mkdir(`${r.root}/home/.config/act`, { recursive: true }),
    "act configuration in HOME",
  ],
  [
    "XDG_CONFIG_HOME",
    () => Promise.resolve({ XDG_CONFIG_HOME: "/x" }),
    "act configuration in HOME",
  ],
  [
    "not fresh",
    async (r) =>
      await Deno.mkdir(`${r.root}/rt/backup-ci/ws`, { recursive: true }),
    "not fresh",
  ],
];

Deno.test("prepare refuses bad inputs, HOME configuration and a used workspace", async () => {
  for (const [name, setup, message] of REFUSALS) {
    const r = await rig();
    try {
      const env = await setup(r) ?? {};
      assert.equal(await legPrepare(r.deps({ env })), 1, name);
      assert(
        r.printed.some((l) => l.includes(message)),
        `${name}: ${r.printed.join("\n")}`,
      );
      assert.equal(r.services.length, 0, name);
    } finally {
      await r.close();
    }
  }
});

Deno.test("prepare refuses a HEAD, tree, parents or blob mismatch", async () => {
  const other = "1".repeat(40) as GitSha;
  const cases: [string, (u: BackupCiUnitV1) => BackupCiUnitV1, string][] = [
    [
      "head",
      (u) => ({ ...u, commit: other, exec: { ...u.exec, commit: other } }),
      "HEAD is not the exec commit",
    ],
    [
      "tree",
      (u) => ({ ...u, exec: { ...u.exec, tree: other } }),
      "tree mismatch",
    ],
    [
      "parents",
      (u) => ({ ...u, exec: { ...u.exec, parents: [other] } }),
      "parents mismatch",
    ],
    [
      "blob",
      (u) => ({ ...u, workflow: { ...u.workflow, blob: other } }),
      "workflow blob mismatch",
    ],
  ];
  for (const [name, change, message] of cases) {
    // The unit stays self-consistent (its id and digest match), so only the
    // checkout's observed binding can refuse it.
    const r = await rig({
      unit: (u) => {
        const { unitId: _id, plan, ...body } = change(u);
        const { version: _v, kind: _k, ...rest } = body;
        return buildBackupCiUnit(rest, plan);
      },
    });
    try {
      assert.equal(await legPrepare(r.deps()), 1, name);
      assert(
        r.printed.some((l) => l.includes(message)),
        `${name}: ${r.printed.join("\n")}`,
      );
      assert.equal(r.services.length, 0);
    } finally {
      await r.close();
    }
  }
});

Deno.test("prepare refuses a dirty checkout and a workflow mode change", async () => {
  const dirty = await rig();
  try {
    // Anything in the workspace the commit does not hold (a checkout filter,
    // a stray file) must be seen before target code runs.
    const deps = dirty.deps();
    const inner = deps.git;
    deps.git = {
      async runGit(args, opts) {
        const out = await inner.runGit(args, opts);
        if (args.includes("clone") && out.ok) {
          await Deno.writeTextFile(
            `${dirty.root}/rt/backup-ci/ws/stray.txt`,
            "x",
          );
        }
        return out;
      },
    };
    assert.equal(await legPrepare(deps), 1);
    assert(
      dirty.printed.some((l) => l.includes("workspace is not clean")),
      dirty.printed.join("\n"),
    );
  } finally {
    await dirty.close();
  }
  const exec = await rig({
    files: { [PATH]: { text: WORKFLOW, mode: 0o755 } },
  });
  try {
    assert.equal(await legPrepare(exec.deps()), 1);
    assert(
      exec.printed.some((l) => l.includes("workflow blob mismatch")),
      exec.printed.join("\n"),
    );
  } finally {
    await exec.close();
  }
});

Deno.test("the tar listing must hold only regular files and directories under bare/", () => {
  const ok =
    "drwxr-xr-x 0/0               0 1970-01-01 00:00 bare/\n-rw-r--r-- 0/0              10 1970-01-01 00:00 bare/unit.json\n";
  assert.equal(tarListingSafe(ok), true);
  assert.equal(
    tarListingSafe(ok + "lrwxrwxrwx 0/0 0 1970-01-01 00:00 bare/x -> /etc\n"),
    false,
  );
  assert.equal(
    tarListingSafe("-rw-r--r-- 0/0 1 1970-01-01 00:00 other/file\n"),
    false,
  );
  assert.equal(
    tarListingSafe("-rw-r--r-- 0/0 1 1970-01-01 00:00 bare/../x\n"),
    false,
  );
  assert.equal(tarListingSafe(""), false);
});

Deno.test("run refuses an unfilled act pin", async () => {
  const r = await rig();
  try {
    assert.equal(await legPrepare(r.deps()), 0);
    const committed = JSON.parse(
      await Deno.readTextFile("ops/backup-ci-pins.json"),
    );
    await Deno.writeTextFile(
      `${r.root}/launcher/ops/backup-ci-pins.json`,
      JSON.stringify({
        ...committed,
        act: {
          ...committed.act,
          version: "UNFILLED-primary-records-the-act-release-tag",
          sha256: "UNFILLED-sha256-of-the-asset",
        },
      }),
    );
    assert.equal(await legRun(r.deps()), 1);
    assert(r.printed.some((l) => l.includes("act pin is not filled")));
    assert.equal(r.services.length, 1);
  } finally {
    await r.close();
  }
});
