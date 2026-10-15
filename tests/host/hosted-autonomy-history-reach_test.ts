/**
 * The current-matrix history walk must reach an old producer inside its 60 s
 * budget: one complete release fetch per walk, local parent reads under the
 * same ancestry/head/sequence/cycle refusals, and no producer custody reads
 * for snapshots no pending record can bind to. An expired or unlisted plan
 * artifact of one producer is a typed per-producer skip, never an escaping
 * error, while a conflicting artifact identity stays fatal.
 */
import assert from "node:assert/strict";
import { recoverHostedCurrentMatrix } from "../../ops/hosted-autonomy-current-recovery.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "../../ops/hosted-autonomy-producer-recovery.ts";
import { isDeferredCurrentMatrixHistoryBudget } from "../../ops/hosted-autonomy-policy.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import {
  createReleaseStateStore,
  DenoGitRunner,
  type GitRunnerV1,
} from "../../src/state/mod.ts";
import {
  gitRun,
  REPO,
  reservation,
  SHA1,
  SHA2,
  sha256Hex,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";

const RUNTIME = "c".repeat(40) as GitSha;
const LAUNCHER = "d".repeat(40) as GitSha;
const GENERATION = 70;
const FIRST_RUN = 1001;
const REFUSAL = "matrix artifact provenance unavailable or conflicting";
const ARCHIVE = `sha256:${"2".repeat(64)}`;
const RELEASE_REF = "refs/heads/sentinel-state/release";

function execution(runId: number) {
  return {
    id: `${runId}:1:repair`,
    runId,
    runAttempt: 1,
    launcherSha: LAUNCHER,
    purpose: "ordinary" as const,
    revision: RUNTIME,
    generation: GENERATION,
    releaseId: null,
    createdAt: T0 + runId * 1000,
  };
}

function proof(runId: number) {
  const intent = execution(runId);
  return parseHostedRunProofV1({
    execution: intent,
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: runId,
    startedAt: intent.createdAt + 100,
    finishedAt: intent.createdAt + 200,
    observedAt: intent.createdAt + 300,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: RUNTIME,
    terminalAt: intent.createdAt + 150,
    logDigest: "0".repeat(64),
  });
}

async function checked(
  cwd: string,
  args: string[],
  env: Record<string, string>,
) {
  const result = await gitRun(cwd, args, env);
  assert(result.ok, result.stderr);
  return result.stdout.trim();
}

/**
 * Raw authenticated release history: a root snapshot, then one snapshot per
 * ordinary producer (oldest first, run ids from FIRST_RUN), each with its own
 * settled proof under a consistent runtime pointer.
 */
async function releaseHistory(root: string, producers: number) {
  const env = testGitEnv(`${root}/home`);
  const remote = `${root}/remote.git`;
  const work = `${root}/history-work`;
  await Deno.mkdir(`${root}/home`, { recursive: true });
  await Deno.mkdir(work, { recursive: true });
  await checked(root, ["init", "-q", "--bare", remote], env);
  await checked(work, ["init", "-q"], env);
  const runtimeFile = `hostedRuntimes/${await sha256Hex(
    HOSTED_RUNTIME_ID,
  )}.json`;
  await Deno.mkdir(`${work}/hostedRuntimes`, { recursive: true });
  let parent: string | null = null;
  for (let sequence = 1; sequence <= producers + 1; sequence++) {
    const runId = FIRST_RUN + sequence - 2;
    const runtime = {
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: RUNTIME,
      generation: GENERATION,
      lastHealthyProof: null,
      lastExecutionProof: sequence === 1 ? null : proof(runId),
      nextOrdinaryAt: T0,
      execution: null,
      createdAt: T0,
      updatedAt: T0 + sequence,
    };
    await Deno.writeTextFile(
      `${work}/manifest.json`,
      canonicalStringify({
        version: "v1",
        kind: "release_state_manifest",
        sequence,
        updatedAt: T0 + sequence,
        stateHead: parent,
      }) + "\n",
    );
    await Deno.writeTextFile(
      `${work}/${runtimeFile}`,
      canonicalStringify(runtime) + "\n",
    );
    await checked(work, ["add", "-A"], env);
    await checked(work, ["commit", "-q", "-m", `release ${sequence}`], env);
    parent = await checked(work, ["rev-parse", "HEAD"], env);
  }
  await checked(work, ["push", "-q", remote, `HEAD:${RELEASE_REF}`], env);
  return remote;
}

function blocked(id: string, runId: number, artifact: number) {
  const requestId = runId.toString(16).padStart(64, "b");
  const key = implementationIntentKey(requestId);
  const record = workRecord(id, {
    nextStep: "blocked",
    blocker: {
      kind: "other",
      since: T0,
      message:
        `authenticated historical matrix runtime mismatch; producer=${runId}:1; runtime=${RUNTIME}; plan=${
          "1".repeat(64)
        }; artifact=${artifact}; archive=${ARCHIVE}; planner=${
          runId + 5
        }; result=${"3".repeat(64)}; original admission retained`,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    target: {
      base: SHA1,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: SHA2,
      pr: null,
      candidateState: { preserved: null, publishedHead: null },
    },
    intent: {
      kind: "candidate_preservation",
      key,
      startedAt: T0,
      branch: `refs/heads/sentinel-candidates/${"f".repeat(64)}`,
      expectedHead: SHA2,
      observedBase: SHA1,
      pr: null,
      requestId,
      resultId: null,
    },
  });
  const charge = reservation(requestId, {
    taskId: id,
    head: SHA1,
    outcome: "submitted",
    settledAt: T0 + 1,
  });
  return { record, charge };
}

function working(id: string) {
  const requestId = "9".repeat(64);
  const record = workRecord(id, {
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(requestId),
      startedAt: T0,
      branch: null,
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      requestId,
      resultId: null,
    },
  });
  const charge = reservation(requestId, { taskId: id, head: SHA1 });
  return { record, charge };
}

type PlanRow = { id: number; digest: string; expired: boolean };

/** Network-cost transport wrapper: the injected clock advances per remote op. */
class CostRunner implements GitRunnerV1 {
  complete = 0;
  constructor(
    private readonly inner: GitRunnerV1,
    private readonly cost: (args: string[]) => void,
  ) {}
  runGit(args: string[], opts: Parameters<GitRunnerV1["runGit"]>[1]) {
    if (args[0] === "fetch" && !args.includes("--depth=2")) this.complete++;
    this.cost(args);
    return this.inner.runGit(args, opts);
  }
}

async function walkRig(input: {
  producers: number;
  rows: { record: WorkRecordV1; charge: BudgetReservationV1 }[];
  plans?: Map<number, PlanRow>;
  gitCost?: (args: string[]) => number;
  repairCost?: number;
  portsCost?: number;
  wrapState?: (state: Record<PropertyKey, unknown>) => void;
}) {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-history-reach-",
    dir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
  });
  const remote = await releaseHistory(root, input.producers);
  let now = T0 + 10_000_000;
  const clock = { now: () => now };
  const runner = new CostRunner(
    new DenoGitRunner(`${root}/git-home`),
    (args) => {
      now += input.gitCost?.(args) ?? 0;
    },
  );
  const store = createReleaseStateStore({
    scratchDir: `${root}/release`,
    remoteUrl: remote,
    runner,
  });
  const calls = { ports: 0, recovered: [] as number[] };
  const repair = {
    status: "found" as const,
    head: "e".repeat(40) as GitSha,
    ref: null,
    snapshot: {
      work: input.rows.map((row) => row.record),
      reservations: input.rows.map((row) => row.charge),
    },
  };
  const state: Record<PropertyKey, unknown> = new Proxy(store, {
    get(target, key) {
      if (key === "readRepair") {
        return () => {
          now += input.repairCost ?? 0;
          return Promise.resolve(portOk(structuredClone(repair)));
        };
      }
      if (key === "writeRepair") {
        return () => Promise.reject(new Error("the walk must not write"));
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Record<PropertyKey, unknown>;
  input.wrapState?.(state);
  const plans = input.plans ?? new Map<number, PlanRow>();
  const transport = {
    confirmCompletedExecution: () => Promise.resolve(true),
    recover: (request: {
      requests: readonly { taskId: string }[];
      currentRun?: { runId: number };
    }) => {
      const runId = request.currentRun!.runId;
      calls.recovered.push(runId);
      const plan = plans.get(runId);
      if (plan === undefined) return Promise.resolve([]);
      if (plan.expired) return Promise.reject(new Error(REFUSAL));
      return Promise.reject(
        new Error(
          `REACHED ${runId} ${
            request.requests.map((row) => row.taskId).join(",")
          }`,
        ),
      );
    },
  };
  const refused = () => {
    throw new Error("no matrix effect is selected");
  };
  const deps = {
    clock,
    state,
    closedMatrix: () => {
      calls.ports++;
      now += input.portsCost ?? 0;
      return Promise.resolve({
        state,
        clock,
        configs: [{ repository: REPO }],
        cycleFor: refused,
        prepareTarget: refused,
        importerFor: refused,
        transportFor: () => transport,
        readExecution: (saved: { runId: number }) =>
          Promise.resolve(portOk(proof(saved.runId))),
        readPlanArtifact: (run: { runId: number }) =>
          Promise.resolve(plans.get(run.runId) ?? null),
      });
    },
  };
  const unrecoverable: string[] = [];
  const walk = () =>
    (recoverHostedCurrentMatrix as (...args: unknown[]) => Promise<unknown>)(
      deps,
      CLOSED_C_WAVE,
      () => {},
      (kind: string) => unrecoverable.push(kind),
    );
  return {
    root,
    store,
    runner,
    calls,
    unrecoverable,
    walk,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

async function captured<T>(run: () => Promise<T>) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const outcome = await run().then(
      (value) => ({ value, error: null as unknown }),
      (error: unknown) => ({ value: null, error }),
    );
    return { ...outcome, lines };
  } finally {
    console.log = original;
  }
}

const network = (args: string[]) =>
  args[0] === "fetch" || args[0] === "ls-remote" ? 1000 : 0;

Deno.test("current matrix walk reaches a producer 120 release snapshots back within its budget", async () => {
  const rig = await walkRig({
    producers: 120,
    rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
    plans: new Map([[FIRST_RUN, {
      id: 7001,
      digest: ARCHIVE,
      expired: false,
    }]]),
    gitCost: network,
    repairCost: 1000,
    portsCost: 2000,
  });
  try {
    await assert.rejects(rig.walk, /^Error: REACHED 1001 blocked-oldest$/);
    // One complete history fetch for the walk, one for the producer custody.
    assert(rig.runner.complete <= 2, String(rig.runner.complete));
    assert.equal(rig.calls.ports, 1);
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN]);
    const left = [];
    for await (const entry of Deno.readDir(`${rig.root}/release`)) {
      if (/^state-(?:history|op)-/.test(entry.name)) left.push(entry.name);
    }
    assert.deepEqual(left, [], "the history view must be closed");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a budget-deferred current matrix walk logs a bounded step diagnostic", async () => {
  // Each local ancestry proof costs one second: the walk defers mid-history.
  const rig = await walkRig({
    producers: 120,
    rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
    gitCost: (args) => args[0] === "merge-base" ? 1000 : 0,
  });
  try {
    const outcome = await captured(rig.walk);
    assert(isDeferredCurrentMatrixHistoryBudget(outcome.error));
    const diagnostics = outcome.lines.map((line) => JSON.parse(line)).filter((
      row,
    ) => row.kind === "sentinel_current_matrix_walk");
    assert.equal(diagnostics.length, 1, outcome.lines.join("\n"));
    const [row] = diagnostics;
    assert.deepEqual(Object.keys(row).sort(), [
      "kind",
      "outcome",
      "producers",
      "sequence",
      "steps",
    ]);
    assert.equal(row.outcome, "deferred_budget");
    assert(Number.isSafeInteger(row.steps) && row.steps >= 50, row.steps);
    assert(row.steps < 121, row.steps);
    assert.equal(row.producers, 0);
    assert(Number.isSafeInteger(row.sequence));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("an expired bound plan artifact is a typed per-producer skip and the walk recovers the older producer", async () => {
  const newer = blocked("blocked-newer", FIRST_RUN + 2, 7003);
  const older = blocked("blocked-older", FIRST_RUN, 7001);
  const rig = await walkRig({
    producers: 3,
    rows: [newer, older],
    plans: new Map([
      [FIRST_RUN + 2, { id: 7003, digest: ARCHIVE, expired: true }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: false }],
    ]),
  });
  try {
    const outcome = await captured(rig.walk);
    assert(outcome.error instanceof Error, String(outcome.error));
    assert.equal(outcome.error.message, "REACHED 1001 blocked-older");
    assert.deepEqual(rig.unrecoverable, ["expired"]);
    // The expired archive is never downloaded.
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN]);
    const skipped = outcome.lines.map((line) => JSON.parse(line)).filter((
      row,
    ) => row.kind === "sentinel_current_matrix_producer_unrecoverable");
    assert.deepEqual(skipped, [{
      kind: "sentinel_current_matrix_producer_unrecoverable",
      runId: FIRST_RUN + 2,
      runAttempt: 1,
      artifact: "expired",
      requests: 1,
    }]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("an unlisted plan artifact skips its producer and its requests never reach an older producer", async () => {
  const inFlight = working("work-in-flight");
  const newest = blocked("blocked-newest", FIRST_RUN + 2, 7003);
  const older = blocked("blocked-older", FIRST_RUN, 7001);
  const rig = await walkRig({
    producers: 3,
    rows: [inFlight, newest, older],
    plans: new Map([
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: false }],
    ]),
  });
  try {
    const outcome = await captured(rig.walk);
    assert(outcome.error instanceof Error, String(outcome.error));
    // The newest bound producer is unlisted: its in-flight request is
    // withheld from every older producer instead of being settled by an
    // older wave, and the older bound producer is still recovered.
    assert.equal(outcome.error.message, "REACHED 1001 blocked-older");
    assert.deepEqual(rig.unrecoverable, ["unlisted"]);
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("an unlisted plan requested only by in-flight work keeps the transport refusal", async () => {
  const rig = await walkRig({
    producers: 2,
    rows: [working("work-in-flight")],
  });
  try {
    await assert.rejects(rig.walk, /^Error: current matrix wave unavailable$/);
    assert.deepEqual(rig.unrecoverable, []);
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN + 1]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a listed bound plan artifact with a conflicting identity stays fatal", async () => {
  const rig = await walkRig({
    producers: 2,
    rows: [blocked("blocked-conflict", FIRST_RUN + 1, 7002)],
    plans: new Map([
      [FIRST_RUN + 1, { id: 9999, digest: ARCHIVE, expired: true }],
    ]),
  });
  try {
    await assert.rejects(rig.walk, new RegExp(`^Error: ${REFUSAL}$`));
    assert.deepEqual(rig.unrecoverable, []);
  } finally {
    await rig.cleanup();
  }
});

for (
  const fault of [
    "wrong-head",
    "wrong-sequence",
    "cycle",
    "unavailable",
  ] as const
) {
  Deno.test(`current matrix walk refuses a ${fault} local history read`, async () => {
    const rig = await walkRig({
      producers: 4,
      rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
      plans: new Map([[FIRST_RUN, {
        id: 7001,
        digest: ARCHIVE,
        expired: false,
      }]]),
      wrapState: (state) => {
        const open = state.openReleaseHistory as (
          input: { expectedHead: GitSha },
        ) => Promise<
          {
            ok: boolean;
            value: {
              readAt(commit: GitSha): Promise<
                {
                  ok: boolean;
                  value: {
                    head: GitSha;
                    snapshot: { sequence: number; stateHead: GitSha | null };
                  };
                }
              >;
              close(): Promise<void>;
            };
          }
        >;
        let first: GitSha | null = null;
        state.openReleaseHistory = async (input: { expectedHead: GitSha }) => {
          first = input.expectedHead;
          const opened = await open(input);
          if (!opened.ok) return opened;
          const view = opened.value;
          return portOk({
            close: () => view.close(),
            readAt: async (commit: GitSha) => {
              if (fault === "unavailable") {
                return portError("unavailable", "offline view unavailable");
              }
              const read = await view.readAt(commit);
              assert(read.ok);
              if (fault === "wrong-head") {
                return portOk({ ...read.value, head: first });
              }
              if (fault === "wrong-sequence") {
                return portOk({
                  ...read.value,
                  snapshot: {
                    ...read.value.snapshot,
                    sequence: read.value.snapshot.sequence + 2,
                  },
                });
              }
              return portOk({
                ...read.value,
                snapshot: { ...read.value.snapshot, stateHead: first },
              });
            },
          });
        };
      },
    });
    try {
      await assert.rejects(
        rig.walk,
        (error: unknown) =>
          error instanceof CurrentMatrixRecoveryIntegrityFailure,
      );
      assert.deepEqual(rig.calls.recovered, []);
    } finally {
      await rig.cleanup();
    }
  });
}

Deno.test("an unavailable history view falls back to exact per-step history reads", async () => {
  const rig = await walkRig({
    producers: 4,
    rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
    plans: new Map([[FIRST_RUN, {
      id: 7001,
      digest: ARCHIVE,
      expired: false,
    }]]),
    wrapState: (state) => {
      state.openReleaseHistory = () =>
        Promise.resolve(portError("unavailable", "offline view unavailable"));
    },
  });
  try {
    await assert.rejects(rig.walk, /^Error: REACHED 1001 blocked-oldest$/);
    assert(rig.runner.complete >= 4, String(rig.runner.complete));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("release history view proves ancestry locally and refuses a moved head", async () => {
  const rig = await walkRig({ producers: 3, rows: [] });
  try {
    const open = Reflect.get(rig.store, "openReleaseHistory") as (
      input: { expectedHead: GitSha },
    ) => Promise<
      {
        ok: boolean;
        value: {
          readAt(commit: string): Promise<
            {
              ok: boolean;
              value?: {
                head: string;
                snapshot: { sequence: number; stateHead: string | null };
              };
              error?: { kind: string };
            }
          >;
          close(): Promise<void>;
        };
        error?: { kind: string };
      }
    >;
    assert.equal(typeof open, "function");
    const latest = await rig.store.readRelease();
    assert(latest.ok && latest.value.status === "found");
    const moved = await open.call(rig.store, { expectedHead: SHA1 });
    assert.equal(moved.ok, false);
    assert.equal(moved.error?.kind, "conflict");
    const before = rig.runner.complete;
    const opened = await open.call(rig.store, {
      expectedHead: latest.value.head,
    });
    assert(opened.ok);
    let head: string | null = latest.value.snapshot.stateHead;
    let sequence = latest.value.snapshot.sequence;
    while (head !== null) {
      const read = await opened.value.readAt(head);
      assert(read.ok && read.value, JSON.stringify(read));
      assert.equal(read.value.head, head);
      assert.equal(read.value.snapshot.sequence, --sequence);
      head = read.value.snapshot.stateHead;
    }
    assert.equal(sequence, 1);
    assert.equal(rig.runner.complete, before + 1);
    const foreign = await opened.value.readAt(SHA2);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.error?.kind, "invalid");
    const malformed = await opened.value.readAt("not-a-commit");
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error?.kind, "invalid");
    await opened.value.close();
    const closed = await opened.value.readAt(latest.value.head);
    assert.equal(closed.ok, false);
    for await (const entry of Deno.readDir(`${rig.root}/release`)) {
      assert(!entry.name.startsWith("state-history-"), entry.name);
    }
  } finally {
    await rig.cleanup();
  }
});
