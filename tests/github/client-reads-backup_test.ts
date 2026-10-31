/**
 * Backup CI in the runtime check read (docs/backup-ci-spec.md §11.2): the
 * real client over a scripted transport that models GitHub's listings (the
 * default listing shows only each name's latest attempt; `filter=all` shows
 * every attempt), a fake receipt store and synthetic values only. A verified,
 * calibrated receipt stands in for exactly a never-started run; everything
 * else, and every failure on the way, is the native list unchanged.
 */
import assert from "node:assert/strict";
import { backupCiReceiptId } from "../../src/contracts/backup-ci.ts";
import { decideCiGate } from "../../src/repair/loop-checks.ts";
import { failedChecks } from "../../src/repair/ci-rejection.ts";
import {
  checksPageWire,
  commitStatusWire,
  FakeClock,
  httpRespond,
  makePort,
  type ScriptEntry,
  statusesPageWire,
} from "./helpers.ts";
import {
  CHECK,
  commitFile,
  coverage,
  H,
  key,
  REPO,
  result,
  T0,
} from "./backup-ci-fixtures.ts";
import {
  consumer,
  EARLIER,
  FakeBackupCiReader,
  neverStartedJob,
  okRead,
  PR_SUITE,
  PUSH_SUITE,
  rawRun,
  REPOSITORY,
  RUN,
  SCOPE,
  startedJob,
  workflowRun,
} from "./backup-ci-consumer-fixtures.ts";
import type { BackupCiModeV1 } from "../../src/contracts/backup-ci.ts";
import type { BackupCiReadV1 } from "../../src/github/backup-ci-reader.ts";

const COMMIT = `${SCOPE}/commits/${H}`;
const RECEIPT = backupCiReceiptId(REPO, H, key());
const NOW = T0 + 3_600_000;

function repeat(entry: ScriptEntry): ScriptEntry {
  return { ...entry, repeat: true };
}

interface ScriptInput {
  latest: unknown[];
  all?: unknown[];
  jobs?: Record<number, unknown>;
  runs?: unknown[];
  statuses?: unknown[];
  allStatus?: number;
}

function script(input: ScriptInput): ScriptEntry[] {
  const all = input.all ?? input.latest;
  const runs = input.runs ?? [workflowRun(PUSH_SUITE, "push")];
  return [
    repeat(httpRespond(
      "GET",
      `${COMMIT}/check-runs?per_page=100&page=1`,
      200,
      checksPageWire(input.latest),
    )),
    repeat(httpRespond(
      "GET",
      `${COMMIT}/check-runs?filter=all&per_page=100&page=1`,
      input.allStatus ?? 200,
      checksPageWire(all),
    )),
    repeat(httpRespond(
      "GET",
      `${SCOPE}/actions/runs?head_sha=${H}&per_page=100&page=1`,
      200,
      { total_count: runs.length, workflow_runs: runs },
    )),
    repeat(httpRespond(
      "GET",
      `${COMMIT}/statuses?per_page=100&page=1`,
      200,
      statusesPageWire(input.statuses ?? []),
    )),
    ...Object.entries(input.jobs ?? { [RUN]: neverStartedJob(RUN) }).map((
      [id, body],
    ) => repeat(httpRespond("GET", `${SCOPE}/actions/jobs/${id}`, 200, body))),
  ];
}

function rig(
  input: ScriptInput,
  over: {
    mode?: BackupCiModeV1;
    read?: (sha: string) => BackupCiReadV1;
    listed?: boolean;
  } = {},
) {
  const reader = new FakeBackupCiReader(
    over.read ?? (() => okRead(commitFile([result(key())]))),
    over.listed === false ? [] : undefined,
  );
  const { backupCi, lines } = consumer(over.mode ?? "on", reader);
  const { port, transport } = makePort({
    repository: REPOSITORY,
    clock: new FakeClock(NOW),
    script: script(input),
    backupCi,
  });
  const urls = () =>
    transport.requests.map((request) =>
      request.url.replace(`https://api.github.com${SCOPE}`, "")
    );
  return { port, reader, lines, urls };
}

Deno.test("readChecks backup: a calibrated success receipt stands in for a never-started run", async () => {
  const { port, lines } = rig({ latest: [rawRun(RUN)] });
  const read = await port.readChecks(H);
  assert.ok(read.ok, JSON.stringify(read));
  const [check] = read.value.checks;
  assert.equal(check.status, "completed");
  assert.equal(check.conclusion, "success");
  assert.equal(check.neverStarted, undefined, "no longer never started");
  assert.deepEqual(check.backup, {
    receipt: RECEIPT,
    context: "push",
    runnerId: "0123456789abcdef",
    legRunId: 5001,
    legJobId: 6001,
  });
  // Name, head and timestamps are the original's (latestChecks order kept).
  assert.equal(check.name, CHECK);
  assert.equal(check.head, H);
  assert.equal(check.startedAt, Date.parse("2026-10-25T08:00:00Z"));
  assert.equal(check.completedAt, Date.parse("2026-10-25T08:00:01Z"));
  assert.equal(decideCiGate(read.value.checks), "proceed");
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{
    kind: "sentinel_backup_ci_standin",
    repo: REPO,
    commit12: H.slice(0, 12),
    check: CHECK,
    conclusion: "success",
    receipt: RECEIPT,
  }]);
  // One line per process and receipt: a second read logs nothing new.
  await port.readChecks(H);
  assert.equal(lines.length, 1);
});

Deno.test("readChecks backup: an earlier attempt the default listing hides decides (started → no stand-in)", async () => {
  const hidden = { latest: [rawRun(RUN)], all: [rawRun(EARLIER), rawRun(RUN)] };
  // The earlier attempt ran for real: N is ineligible, the run keeps waiting.
  const ran = rig({
    ...hidden,
    jobs: { [RUN]: neverStartedJob(RUN), [EARLIER]: startedJob(EARLIER) },
  });
  const refused = await ran.port.readChecks(H);
  assert.ok(refused.ok);
  assert.equal(refused.value.checks[0].neverStarted, true);
  assert.equal(refused.value.checks[0].backup, undefined);
  assert.equal(decideCiGate(refused.value.checks), "wait");
  assert.ok(ran.lines.some((line) => line.includes("started:deno")));
  // Both attempts never started: the receipt stands in.
  const both = rig({
    ...hidden,
    jobs: { [RUN]: neverStartedJob(RUN), [EARLIER]: neverStartedJob(EARLIER) },
  });
  const applied = await both.port.readChecks(H);
  assert.ok(applied.ok);
  assert.equal(applied.value.checks[0].conclusion, "success");
  assert.ok(both.urls().some((url) => url.includes("filter=all")));
});

Deno.test("readChecks backup: an attempt listing that cannot be bound to the commit refuses the whole commit", async () => {
  for (
    const earlier of [
      rawRun(EARLIER, { id: "x" }),
      rawRun(EARLIER, { head_sha: "9".repeat(40) }),
      rawRun(EARLIER, { name: "" }),
    ]
  ) {
    const { port } = rig({
      latest: [rawRun(RUN)],
      all: [earlier, rawRun(RUN)],
    });
    const read = await port.readChecks(H);
    assert.ok(read.ok);
    assert.equal(
      read.value.checks[0].neverStarted,
      true,
      JSON.stringify(earlier),
    );
    assert.equal(read.value.checks[0].backup, undefined);
  }
});

Deno.test("readChecks backup: a name-filtered read still sees the whole commit's coverage", async () => {
  const lint = rawRun(RUN + 1, { name: "lint" });
  const file = commitFile([result(key())], {
    workflows: [coverage({ expected: [CHECK, "lint"] })],
  });
  const input = {
    latest: [rawRun(RUN), lint],
    jobs: {
      [RUN]: neverStartedJob(RUN),
      [RUN + 1]: { ...neverStartedJob(RUN + 1), name: "lint" },
    },
  };
  const filtered = rig(input, { read: () => okRead(file) });
  const read = await filtered.port.readChecks(H, new Set([CHECK]));
  assert.ok(read.ok);
  assert.equal(read.value.checks.length, 1);
  assert.equal(read.value.checks[0].conclusion, "success");
  // The same file without `lint` on the commit: coverage is incomplete.
  const partial = rig({ latest: [rawRun(RUN)] }, { read: () => okRead(file) });
  const refused = await partial.port.readChecks(H, new Set([CHECK]));
  assert.ok(refused.ok);
  assert.equal(refused.value.checks[0].neverStarted, true);
});

Deno.test("readChecks backup: nothing never-started costs no extra request and no store read", async () => {
  const green = rawRun(RUN, { conclusion: "success" });
  const { port, reader, urls } = rig({ latest: [green], jobs: {} });
  const read = await port.readChecks(H);
  assert.ok(read.ok);
  assert.equal(read.value.checks[0].backup, undefined);
  assert.deepEqual(urls(), [
    `/commits/${H}/check-runs?per_page=100&page=1`,
    `/commits/${H}/statuses?per_page=100&page=1`,
  ]);
  assert.deepEqual(reader.reads, []);
});

Deno.test("readChecks backup: off, shadow and an unlisted repository apply nothing", async () => {
  for (const over of [{ mode: "off" as const }, { listed: false }]) {
    const { port, reader, urls } = rig({ latest: [rawRun(RUN)] }, over);
    const read = await port.readChecks(H);
    assert.ok(read.ok);
    assert.equal(read.value.checks[0].neverStarted, true);
    assert.deepEqual(reader.reads, [], JSON.stringify(over));
    assert.ok(!urls().some((url) => url.includes("filter=all")));
  }
  const shadow = rig({ latest: [rawRun(RUN)] }, { mode: "shadow" });
  const read = await shadow.port.readChecks(H);
  assert.ok(read.ok);
  assert.equal(read.value.checks[0].neverStarted, true, "shadow applies none");
  assert.equal(read.value.checks[0].backup, undefined);
  assert.equal(
    JSON.parse(shadow.lines[0]).kind,
    "sentinel_backup_ci_shadow",
  );
});

Deno.test("readChecks backup: a store outage or an unreadable listing leaves the list unchanged, never an error", async () => {
  const cases = [
    rig({ latest: [rawRun(RUN)] }, {
      read: () => ({ kind: "unavailable", detail: "synthetic" }),
    }),
    rig({ latest: [rawRun(RUN)] }, {
      read: () => ({ kind: "invalid", detail: "synthetic" }),
    }),
    rig({ latest: [rawRun(RUN)], allStatus: 502 }),
    rig({ latest: [rawRun(RUN)] }, { read: () => okRead(null) }),
  ];
  for (const { port } of cases) {
    const read = await port.readChecks(H);
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.value.checks[0].neverStarted, true);
    assert.equal(read.value.checks[0].conclusion, "failure");
    assert.deepEqual(failedChecks(read.value.checks), []);
    assert.equal(decideCiGate(read.value.checks), "wait");
  }
});

Deno.test("readChecks backup: a commit status of the same name refuses; the pending-status grace sees stand-ins", async () => {
  const same = rig({
    latest: [rawRun(RUN)],
    statuses: [commitStatusWire({ context: CHECK, state: "success" })],
  });
  const refused = await same.port.readChecks(H);
  assert.ok(refused.ok);
  assert.equal(refused.value.checks[0].neverStarted, true);
  // A stale pending third-party status past the grace is left out once the
  // runs (stand-in included) all completed long ago.
  const pending = rig({
    latest: [rawRun(RUN)],
    statuses: [commitStatusWire({ context: "preview", state: "pending" })],
  });
  const read = await pending.port.readChecks(H);
  assert.ok(read.ok);
  assert.deepEqual(read.value.checks.map((check) => check.name), [CHECK]);
  assert.equal(read.value.checks[0].conclusion, "success");
});

Deno.test("readChecks backup: a pull_request suite takes only a pull_request receipt; push takes both", async () => {
  const pr = rawRun(RUN, { check_suite: { id: PR_SUITE } });
  const runs = [workflowRun(PR_SUITE, "pull_request")];
  const pushOnly = rig({ latest: [pr], runs });
  const refused = await pushOnly.port.readChecks(H);
  assert.ok(refused.ok);
  assert.equal(refused.value.checks[0].neverStarted, true);
  const prReceipt = rig({ latest: [pr], runs }, {
    read: () => okRead(commitFile([result(key({ context: "pull_request" }))])),
  });
  const applied = await prReceipt.port.readChecks(H);
  assert.ok(applied.ok);
  assert.equal(applied.value.checks[0].backup?.context, "pull_request");
  const pushFromPr = rig({ latest: [rawRun(RUN)] }, {
    read: () => okRead(commitFile([result(key({ context: "pull_request" }))])),
  });
  const push = await pushFromPr.port.readChecks(H);
  assert.ok(push.ok);
  assert.equal(push.value.checks[0].conclusion, "success");
});

Deno.test("readChecks backup: a provisional red stays never started; a confirmed red stands in red", async () => {
  const red = result(key(), { conclusion: "failure" });
  const provisional = rig({ latest: [rawRun(RUN)] }, {
    read: () => okRead(commitFile([red])),
  });
  const waiting = await provisional.port.readChecks(H);
  assert.ok(waiting.ok);
  assert.equal(waiting.value.checks[0].neverStarted, true);
  assert.equal(decideCiGate(waiting.value.checks), "wait");
  const confirmed = rig({ latest: [rawRun(RUN)] }, {
    read: () =>
      okRead(commitFile([
        red,
        result(key({ attempt: 2 }), { conclusion: "failure" }),
      ])),
  });
  const read = await confirmed.port.readChecks(H);
  assert.ok(read.ok);
  assert.equal(read.value.checks[0].conclusion, "failure");
  assert.ok(read.value.checks[0].backup !== undefined);
  assert.deepEqual(failedChecks(read.value.checks).map((c) => c.name), [
    CHECK,
  ]);
});

Deno.test("readChecks backup: a natively started red name carries its backup peer for attribution only", async () => {
  const native = rawRun(RUN);
  const { port, urls } = rig({
    latest: [native],
    jobs: { [RUN]: startedJob(RUN) },
  }, { read: () => okRead(commitFile([result(key())])) });
  const read = await port.readChecks(H);
  assert.ok(read.ok);
  const [check] = read.value.checks;
  assert.equal(check.conclusion, "failure", "the native red is kept");
  assert.equal(check.backup, undefined);
  assert.equal(check.neverStarted, undefined);
  assert.deepEqual(check.backupPeer, {
    conclusion: "success",
    receipt: RECEIPT,
  });
  assert.ok(urls().some((url) => url.includes("filter=all")));
  // A peer candidate whose commit holds no receipt costs no GitHub request.
  const empty = rig({ latest: [native], jobs: { [RUN]: startedJob(RUN) } }, {
    read: () => okRead(commitFile([])),
  });
  const plain = await empty.port.readChecks(H);
  assert.ok(plain.ok);
  assert.equal(plain.value.checks[0].backupPeer, undefined);
  assert.ok(!empty.urls().some((url) => url.includes("filter=all")));
  assert.equal(empty.reader.reads.length, 1);
});
