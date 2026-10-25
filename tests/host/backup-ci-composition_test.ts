/**
 * Backup CI composition and mode plumbing (docs/backup-ci-spec.md §11.2,
 * §11.4, §11.8, B15): the consumer exists only for mode `on`/`shadow` and a
 * listed target; the mode is lower-only and survives a step that does not
 * grant it; every production path that reads CI is handed the one reader
 * (the runtime port, its queue custody facts and the matrix cell's evidence
 * reader; the maintenance launcher's surfaces); and the protected launcher
 * forwards the selector to the runtime child, never to a model client.
 * All synthetic.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  BACKUP_CI_MODE_ENV,
  BACKUP_CI_TARGETS_FILE_NAME,
  BoundedAnonymousGitRunner,
  composeBackupCi,
  hostBackupCi,
  readBackupCiMode,
  readBackupCiTargets,
} from "../../src/host/backup-ci-compose.ts";
import { composeGitHubHost } from "../../src/host/github.ts";
import { cellCiEvidenceReader } from "../../src/host/matrix-cell-ci-evidence.ts";
import { buildChildEnvironment } from "../../src/host/hosted-runtime-child.ts";
import { HOSTED_RUNTIME_CHILD_ENV_KEYS } from "../../src/host/hosted-runtime-identity.ts";
import {
  HOSTED_RUNTIME_OPTIONAL_LAUNCHER_INPUT_KEYS,
  readHostedLauncherInputs,
} from "../../src/host/hosted-runtime-main.ts";
import { codexChildEnv } from "../../src/host/local-client.ts";
import { BACKUP_CI_EVIDENCE_APP } from "../../src/github/client-ci-evidence-backup.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import {
  checksPageWire,
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  FakeReviewService,
  httpRespond,
  ScriptedHttpTransport,
  type ScriptEntry,
  statusesPageWire,
} from "../github/helpers.ts";
import {
  B,
  commitFile,
  H,
  key,
  REPO,
  REPO_ID,
  result,
  T0,
} from "../github/backup-ci-fixtures.ts";
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
  tempStore,
  workflowRun,
} from "../github/backup-ci-consumer-fixtures.ts";

const SOURCE = (path: string) =>
  Deno.readTextFileSync(new URL(`../../${path}`, import.meta.url));

const TARGETS_JSON = JSON.stringify([
  { repository: REPO, id: REPO_ID },
  { repository: "ubiquity-sentinel/sentinel", id: 1 },
]);

function files(text: string | null) {
  const reads: string[] = [];
  return {
    reads,
    readFile: (path: string) => {
      reads.push(path);
      return text === null
        ? Promise.reject(new Deno.errors.NotFound("absent"))
        : Promise.resolve(text);
    },
  };
}

Deno.test("backup CI mode: exactly on or shadow, anything else (or an ungranted read) is off", () => {
  const cases: [string | undefined, string][] = [
    ["on", "on"],
    ["shadow", "shadow"],
    ["off", "off"],
    ["ON", "off"],
    [" on", "off"],
    ["", "off"],
    [undefined, "off"],
  ];
  for (const [raw, mode] of cases) {
    assert.equal(
      readBackupCiMode((name) => name === BACKUP_CI_MODE_ENV ? raw : "on"),
      mode,
      String(raw),
    );
  }
  assert.equal(
    readBackupCiMode(() => {
      throw new Deno.errors.NotCapable("synthetic ungranted variable");
    }),
    "off",
  );
});

Deno.test("backup CI composition: off composes nothing and reads no file; on lists only committed non-self targets", async () => {
  const clock = new FakeClock(T0);
  const off = files(TARGETS_JSON);
  assert.equal(
    await composeBackupCi({
      mode: "off",
      root: "/r",
      scratch: "/s",
      clock,
      readFile: off.readFile,
    }),
    undefined,
  );
  assert.deepEqual(off.reads, []);
  const on = files(TARGETS_JSON);
  const composed = await composeBackupCi({
    mode: "on",
    root: "/r",
    scratch: "/s",
    clock,
    readFile: on.readFile,
  });
  assert.deepEqual(on.reads, [`/r/${BACKUP_CI_TARGETS_FILE_NAME}`]);
  assert.equal(composed?.mode, "on");
  assert.deepEqual(composed?.reader.targets, [{
    repository: REPO,
    id: REPO_ID,
  }]);
  assert.ok(composed?.listings !== undefined);
  for (
    const text of [null, "{", "[]", JSON.stringify([{ repository: REPO }])]
  ) {
    const absent = files(text);
    assert.equal(
      await composeBackupCi({
        mode: "shadow",
        root: "/r",
        scratch: "/s",
        clock,
        readFile: absent.readFile,
      }),
      undefined,
      String(text),
    );
  }
  assert.deepEqual(await readBackupCiTargets("/nonexistent-root"), []);
});

Deno.test("backup CI composition: the runtime host's consumer reads its mode through the host reader", async () => {
  // Under the checkout: the suite's read grant is the checkout itself.
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".backup-ci-host-",
  });
  try {
    await Deno.writeTextFile(
      `${root}/${BACKUP_CI_TARGETS_FILE_NAME}`,
      TARGETS_JSON,
    );
    const clock = new FakeClock(T0);
    assert.equal(
      await hostBackupCi(() => undefined, root, `${root}/state`, clock),
      undefined,
    );
    const host = await hostBackupCi(
      (name) => name === BACKUP_CI_MODE_ENV ? "shadow" : undefined,
      root,
      `${root}/state`,
      clock,
    );
    assert.equal(host?.mode, "shadow");
    assert.equal(host?.reader.target(REPOSITORY)?.id, REPO_ID);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("backup CI composition: the anonymous git runner never takes stdin and bounds each command", async () => {
  const runner = new BoundedAnonymousGitRunner("/nonexistent-home", 20_000);
  const refused = await runner.runGit(["version"], {
    cwd: "/",
    stdin: new Uint8Array(1),
  });
  assert.equal(refused.ok, false);
  const version = await runner.runGit(["version"], { cwd: "/" });
  assert.equal(version.ok, true);
  assert.match(version.stdout, /^git version/);
  const store = await tempStore();
  try {
    await store.publish({ "README.json": "store" });
    // An https-only runner refuses any other transport; a file-allowed one
    // (the tests' own) reads the same remote.
    const https = await runner.runGit(["ls-remote", store.url], { cwd: "/" });
    assert.equal(https.ok, false);
    const file = new BoundedAnonymousGitRunner(
      "/nonexistent-home",
      20_000,
      "file",
    );
    const listed = await file.runGit(["ls-remote", store.url], { cwd: "/" });
    assert.equal(listed.ok, true);
    assert.match(listed.stdout, /\trefs\/heads\/sentinel-backup-ci\n/);
    // No repository discovery above the command's own directory: a directory
    // inside a work tree is not that work tree for the reader's git.
    const inside = `${store.root}/work/inside`;
    await Deno.mkdir(inside);
    const discovered = await file.runGit(["rev-parse", "--git-dir"], {
      cwd: inside,
    });
    assert.equal(discovered.ok, false);
    // A command past its deadline is stopped and fails.
    const slow = new BoundedAnonymousGitRunner("/nonexistent-home", 1, "file");
    const stopped = await slow.runGit(["ls-remote", store.url], { cwd: "/" });
    assert.equal(stopped.ok, false);
  } finally {
    await store.close();
  }
});

function readScript(): ScriptEntry[] {
  const repeat = (entry: ScriptEntry): ScriptEntry => ({
    ...entry,
    repeat: true,
  });
  const commit = `${SCOPE}/commits/${H}`;
  return [
    repeat(httpRespond(
      "GET",
      `${commit}/check-runs?per_page=100&page=1`,
      200,
      checksPageWire([rawRun(RUN)]),
    )),
    repeat(httpRespond(
      "GET",
      `${commit}/check-runs?filter=all&per_page=100&page=1`,
      200,
      checksPageWire([rawRun(RUN)]),
    )),
    repeat(httpRespond(
      "GET",
      `${SCOPE}/actions/runs?head_sha=${H}&per_page=100&page=1`,
      200,
      { total_count: 1, workflow_runs: [workflowRun(PUSH_SUITE, "push")] },
    )),
    repeat(
      httpRespond(
        "GET",
        `${commit}/statuses?per_page=100&page=1`,
        200,
        statusesPageWire([]),
      ),
    ),
    repeat(
      httpRespond(
        "GET",
        `${SCOPE}/actions/jobs/${RUN}`,
        200,
        neverStartedJob(RUN),
      ),
    ),
  ];
}

Deno.test("backup CI composition: the composed host port reads CI through the consumer", async () => {
  const transport = new ScriptedHttpTransport(readScript());
  const reader = new FakeBackupCiReader(() =>
    okRead(commitFile([result(key())]))
  );
  const host = composeGitHubHost({
    repository: REPOSITORY,
    http: transport.fetch.bind(transport) as HttpTransportV1,
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    clock: new FakeClock(T0),
    reviewService: new FakeReviewService(),
    trustedPrAuthor: "ubiquity-sentinel[bot]",
    trustedReviewer: "ubiquity-sentinel[bot]",
    trustedResolutionAuthors: [],
    git: { localDir: "/synthetic/work", remoteUrl: "/synthetic/remote.git" },
    backupCi: consumer("on", reader).backupCi,
  });
  const read = await host.port.readChecks(H);
  assert.ok(read.ok);
  assert.equal(read.value.checks[0].conclusion, "success");
  assert.ok(read.value.checks[0].backup !== undefined);
  assert.equal(reader.reads.length, 1);
});

Deno.test("backup CI composition: the matrix cell's evidence reader carries the consumer", async () => {
  const transport = new ScriptedHttpTransport(readScript());
  const reader = new FakeBackupCiReader(() =>
    okRead(commitFile([
      result(key(), { conclusion: "failure" }),
      result(key({ attempt: 2 }), { conclusion: "failure" }),
    ]))
  );
  const evidence = await cellCiEvidenceReader({
    repository: REPOSITORY,
    http: transport.fetch.bind(transport) as HttpTransportV1,
    clock: new FakeClock(T0),
    token: "synthetic",
    gate: new FakeCooldownGate(),
    backupCi: consumer("on", reader).backupCi,
  }).readCiFailureEvidence({ head: H, base: B as GitSha, deadlineMs: 30_000 });
  assert.equal(evidence.checks[0]?.app, BACKUP_CI_EVIDENCE_APP);
});

Deno.test("backup CI composition: every production CI path is handed the one consumer", () => {
  const host = SOURCE("src/host/actions-repair-host.ts");
  assert.match(
    host,
    /const backupCi = await hostBackupCi\(readEnv, sourceDir, stateRoot, clock\);/,
  );
  // The port (and so every runtime gate), the queue custody fact surfaces and
  // the matrix cell's evidence reader.
  assert.match(
    host,
    /const common: HostedAppGitHubInput = \{\n\s+queueMode,\n\s+backupCi,/,
  );
  assert.match(host, /prepareActionsQueueCustody\(\{[^}]*\n\s+backupCi,\n/);
  assert.match(host, /cellCiEvidenceReader\(\{[^}]*\n\s+backupCi,\n/);
  const custody = SOURCE("src/host/actions-queue-custody.ts");
  assert.match(
    custody,
    /createHostedAutonomyGitHub\(\s*input\.token,\s*repository,\s*input\.backupCi,\s*\)/,
  );
  const local = SOURCE("src/host/local-github.ts");
  assert.equal(
    (local.match(/backupCi: input\.backupCi/g) ?? []).length,
    2,
    "the queue/review client and the composed port",
  );
  const maintenance = SOURCE("ops/hosted-autonomy-main.ts");
  assert.match(maintenance, /mode: readBackupCiMode\(env\),/);
  assert.match(
    maintenance,
    /createHostedAutonomyGitHub\(\s*isHostedSelf\(repository\) \? selfToken : apiToken,\s*repository,\s*backupCi,\s*\)/,
  );
  assert.match(
    SOURCE("src/github/port-base.ts"),
    /backupCi: options\.backupCi,/,
  );
});

Deno.test("backup CI mode plumbing: the launcher reads it tolerantly and forwards it to every runtime child only", () => {
  assert.ok(
    (HOSTED_RUNTIME_CHILD_ENV_KEYS as readonly string[]).includes(
      BACKUP_CI_MODE_ENV,
    ),
  );
  assert.ok(
    (HOSTED_RUNTIME_OPTIONAL_LAUNCHER_INPUT_KEYS as readonly string[]).includes(
      BACKUP_CI_MODE_ENV,
    ),
  );
  // A step that does not grant the variable reads it as unset; every other
  // input is read exactly as before.
  const ungranted = readHostedLauncherInputs((name) => {
    if (name === BACKUP_CI_MODE_ENV) {
      throw new Deno.errors.NotCapable("synthetic ungranted variable");
    }
    return name === "PATH" ? "/usr/bin" : undefined;
  });
  assert.equal(ungranted[BACKUP_CI_MODE_ENV], undefined);
  assert.equal(ungranted.PATH, "/usr/bin");
  for (const selector of ["on", "shadow", "off", "invalid", ""]) {
    const inputs = readHostedLauncherInputs((name) =>
      ({
        PATH: "/usr/bin",
        GITHUB_TOKEN: "synthetic",
        UOS_AI_TOKEN: "synthetic",
        [BACKUP_CI_MODE_ENV]: selector,
      } as Record<string, string | undefined>)[name]
    );
    for (const job of ["repair", "matrix_plan", "matrix_cell"] as const) {
      const child = buildChildEnvironment(
        { ...inputs, GITHUB_OUTPUT: "/owned-output" },
        { runId: 1, runAttempt: 1, launcherSha: "a".repeat(40) as GitSha, job },
        { home: "/h", tmp: "/t", denoDir: "/d" },
        T0,
      );
      assert.equal(child[BACKUP_CI_MODE_ENV], selector, `${job} ${selector}`);
    }
  }
  const unset = buildChildEnvironment(
    readHostedLauncherInputs((name) =>
      ({
        PATH: "/usr/bin",
        GITHUB_TOKEN: "synthetic",
        UOS_AI_TOKEN: "synthetic",
      } as Record<string, string | undefined>)[name]
    ),
    {
      runId: 1,
      runAttempt: 1,
      launcherSha: "a".repeat(40) as GitSha,
      job: "repair",
    },
    { home: "/h", tmp: "/t", denoDir: "/d" },
    T0,
  );
  assert.equal(Object.hasOwn(unset, BACKUP_CI_MODE_ENV), false);
  const worker = codexChildEnv("/m", "/mt", "/mc", "/usr/bin");
  assert.equal(Object.hasOwn(worker, BACKUP_CI_MODE_ENV), false);
});
