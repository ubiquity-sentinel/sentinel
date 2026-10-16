/**
 * Shared current-matrix history walk rig: raw authenticated release history
 * of ordinary producers, parked (blocked) and in-flight repair rows, and fake
 * matrix ports that record every plan listing, completion, native and
 * recovery read.
 */
import assert from "node:assert/strict";
import { recoverHostedCurrentMatrix } from "../../ops/hosted-autonomy-current-recovery.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
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
export const FIRST_RUN = 1001;
export const REFUSAL = "matrix artifact provenance unavailable or conflicting";
export const ARCHIVE = `sha256:${"2".repeat(64)}`;
const RELEASE_REF = "refs/heads/sentinel-state/release";
export const APPLIED = "a".repeat(40) as GitSha;

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

export function proof(runId: number) {
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

export function blocked(id: string, runId: number, artifact: number) {
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

export function working(id: string, requestId = "9".repeat(64)) {
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

export async function walkRig(input: {
  producers: number;
  rows: { record: WorkRecordV1; charge: BudgetReservationV1 }[];
  plans?: Map<number, PlanRow>;
  gitCost?: (args: string[]) => number;
  repairCost?: number;
  portsCost?: number;
  recoverCost?: (runId: number) => number;
  completed?: (runId: number) => boolean;
  /** The pass of this producer ingests its (empty) wave and moves the head. */
  applies?: (runId: number) => boolean;
  /** This producer's wave binds no requested cell: the pass settles nothing. */
  settlesNothing?: (runId: number) => boolean;
  /** The completion read invokes the pass's repair writer before deferring. */
  writesOnConfirm?: (runId: number) => boolean;
  /** The completion read of this producer refuses (provenance conflict). */
  confirmThrows?: (runId: number) => boolean;
  /** The native plan listing of this producer is refused. */
  listingFails?: (runId: number) => boolean;
  /** This producer's native settlement read, when not its saved proof. */
  nativeRead?: (runId: number) => unknown;
  /** The native read invokes the ports' repair writer, then reads pending. */
  writesOnNative?: (runId: number) => boolean;
  /** The applying wave carries results, and its consumer's state read fails. */
  ingestStateUnavailable?: boolean;
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
  const calls = {
    ports: 0,
    recovered: [] as number[],
    listed: [] as number[],
    confirmed: [] as number[],
    native: [] as number[],
  };
  const repair = {
    status: "found" as const,
    head: "e".repeat(40) as GitSha,
    ref: null,
    snapshot: {
      work: input.rows.map((row) => row.record),
      reservations: input.rows.map((row) => row.charge),
      reviews: [],
      releaseRequests: [],
    },
  };
  let repairUnavailable = false;
  const state: Record<PropertyKey, unknown> = new Proxy(store, {
    get(target, key) {
      if (key === "readRepair") {
        return () => {
          now += input.repairCost ?? 0;
          if (repairUnavailable) {
            repairUnavailable = false;
            return Promise.resolve(portError("unavailable", "repair read"));
          }
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
  let writer: {
    writeRepair: (...args: unknown[]) => Promise<unknown>;
    readRelease: () => Promise<
      {
        ok: boolean;
        value?: {
          status: string;
          head?: string;
          snapshot?: { hostedRuntimes: unknown[] };
        };
      }
    >;
  } | null = null;
  // The real transport's release read of the pass's state (its completion
  // custody): a missing or unreadable producer snapshot is refused.
  const passRelease = async () => {
    const read = await writer!.readRelease();
    if (!read.ok || read.value?.status !== "found") throw new Error(REFUSAL);
    return canonicalStringify({
      head: read.value.head,
      runtimes: read.value.snapshot!.hostedRuntimes,
    });
  };
  const transport = {
    confirmCompletedExecution: async (saved: { runId: number }) => {
      calls.confirmed.push(saved.runId);
      // Like the real completion read: release custody before the native
      // attempt and job reads, and the same custody again after them.
      const custody = await passRelease();
      if (input.confirmThrows?.(saved.runId)) throw new Error(REFUSAL);
      if (input.writesOnConfirm?.(saved.runId)) {
        // A cooldown hold recorded through the pass's own writer.
        await writer!.writeRepair(repair.snapshot, repair.head).catch(() => {});
        return false;
      }
      const completed = input.completed?.(saved.runId) ?? true;
      if (completed && await passRelease() !== custody) {
        throw new Error(REFUSAL);
      }
      return completed;
    },
    recover: async (request: {
      requests: readonly {
        taskId: string;
        repository: unknown;
        reservationId: string;
      }[];
      currentRun?: { runId: number };
    }) => {
      const runId = request.currentRun!.runId;
      calls.recovered.push(runId);
      // The real recovery reads the pass's release snapshot first too.
      await passRelease();
      now += input.recoverCost?.(runId) ?? 0;
      if (input.settlesNothing?.(runId)) {
        const run = { runId, runAttempt: 1, launcherSha: LAUNCHER };
        const plan = { waveId: execution(runId).id, run, cells: [] };
        return [{
          plan,
          provenance: { run },
          planDigest: await matrixDigestV1(plan),
          results: [],
          bundlesDir: `${root}/bundles`,
        }];
      }
      if (input.applies?.(runId)) {
        const run = { runId, runAttempt: 1, launcherSha: LAUNCHER };
        const plan = {
          waveId: execution(runId).id,
          run,
          cells: request.requests.map((row) => ({
            cellId: `cell-${row.taskId}`,
            taskId: row.taskId,
            repository: row.repository,
            reservationId: row.reservationId,
            runtimeSha: RUNTIME,
            generation: GENERATION,
          })),
        };
        return [{
          plan,
          provenance: { run },
          planDigest: await matrixDigestV1(plan),
          // A result bound to each cell: the consumer reads repair state.
          results: input.ingestStateUnavailable
            ? plan.cells.map((cell) => ({
              ...cell,
              waveId: plan.waveId,
              run,
              status: "failed",
            }))
            : [],
          bundlesDir: `${root}/bundles`,
        }];
      }
      const plan = plans.get(runId);
      if (plan === undefined) return [];
      if (plan.expired) throw new Error(REFUSAL);
      throw new Error(
        `REACHED ${runId} ${
          request.requests.map((row) => row.taskId).join(",")
        }`,
      );
    },
  };
  const refused = () => {
    throw new Error("no matrix effect is selected");
  };
  const deps = {
    clock,
    state,
    closedMatrix: (portsState: NonNullable<typeof writer>) => {
      calls.ports++;
      now += input.portsCost ?? 0;
      return Promise.resolve({
        state,
        clock,
        configs: [{ repository: REPO }],
        // Only an applying pass reaches its consumer: no result is ingested,
        // and the repair head moves as the consumer's write would move it.
        cycleFor: input.applies ? () => ({ clock }) : refused,
        prepareTarget: input.applies
          ? () => {
            if (input.ingestStateUnavailable) repairUnavailable = true;
            else repair.head = APPLIED;
            return Promise.resolve();
          }
          : refused,
        importerFor: input.applies ? () => ({}) : refused,
        transportFor: (passState: NonNullable<typeof writer>) => {
          writer = passState;
          return transport;
        },
        readExecution: async (saved: { runId: number }) => {
          calls.native.push(saved.runId);
          if (input.writesOnNative?.(saved.runId)) {
            // A cooldown hold recorded through the ports' own writer.
            await portsState.writeRepair(repair.snapshot, repair.head)
              .catch(() => {});
            return portOk(null);
          }
          return input.nativeRead?.(saved.runId) ?? portOk(proof(saved.runId));
        },
        readPlanArtifact: (run: { runId: number }) => {
          calls.listed.push(run.runId);
          if (input.listingFails?.(run.runId)) {
            return Promise.reject(new Error(REFUSAL));
          }
          return Promise.resolve(plans.get(run.runId) ?? null);
        },
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

export async function captured<T>(run: () => Promise<T>) {
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

export const network = (args: string[]) =>
  args[0] === "fetch" || args[0] === "ls-remote" ? 1000 : 0;

export const walkRows = (lines: string[]) =>
  lines.map((line) => JSON.parse(line)).filter((row) =>
    row.kind === "sentinel_current_matrix_walk"
  );
export const walkLines = (lines: string[]) =>
  walkRows(lines).map((row) => row.outcome);
