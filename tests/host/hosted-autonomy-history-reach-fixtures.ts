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
import type { MatrixPlanV1 } from "../../src/contracts/matrix-identity.ts";
import {
  portError,
  portOk,
  type RepairStateWriter,
  type StateReadView,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { CandidateProofPassV1 } from "../../src/host/actions-candidates-proof.ts";
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

export const RUNTIME = "c".repeat(40) as GitSha;
export const LAUNCHER = "d".repeat(40) as GitSha;
export const GENERATION = 70;
export const FIRST_RUN = 1001;
export const REFUSAL = "matrix artifact provenance unavailable or conflicting";
export const ARCHIVE = `sha256:${"2".repeat(64)}`;
const RELEASE_REF = "refs/heads/sentinel-state/release";
export const APPLIED = "a".repeat(40) as GitSha;

export function execution(runId: number) {
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
    repository: "ubiquity-sentinel/sentinel",
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
export async function releaseHistory(root: string, producers: number) {
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
  /**
   * The applying wave's consumer defers every cell on an unavailable
   * observation its receipt needs (`deferred`): nothing is consumed.
   */
  consumerDefers?: boolean;
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
            else if (!input.consumerDefers) repair.head = APPLIED;
            return Promise.resolve();
          }
          : refused,
        ...(input.consumerDefers
          ? {
            ingest: (_: unknown, plan: MatrixPlanV1) =>
              Promise.resolve({
                waveId: plan.waveId,
                entries: plan.cells.map((cell) => ({
                  cellId: cell.cellId,
                  disposition: "deferred" as const,
                  detail: "predecessor observation unavailable",
                })),
                ingested: 0,
              }),
          }
          : {}),
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

/**
 * The live late-cell cadence over two ordinary producers. The older producer
 * (FIRST_RUN) holds an in-flight record its own repair job never preserved;
 * the newer one (FIRST_RUN + 1) holds an unconsumed cell that this
 * maintenance pass consumes. Each wave plans only its own producer's cell.
 * Repair state is an in-memory compare-and-swap store, the consumer is the
 * ingest port seam with the real consumer's dispositions, and the trusted
 * preserver records each preservation and serves the ref it created. The
 * walk, the producer pass and the preservation tail are the real ones.
 */
export async function preservationWalkRig() {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-preservation-walk-",
    dir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
  });
  const remote = await releaseHistory(root, 2);
  let now = T0 + 10_000_000;
  const clock = { now: () => ++now };
  const store = createReleaseStateStore({
    scratchDir: `${root}/release`,
    remoteUrl: remote,
    runner: new DenoGitRunner(`${root}/git-home`),
  });
  const older = { runId: FIRST_RUN, requestId: "0".repeat(63) + "1" };
  const newer = { runId: FIRST_RUN + 1, requestId: "0".repeat(63) + "2" };
  const candidates = new Map([
    [older.requestId, "4".repeat(40) as GitSha],
    [newer.requestId, "5".repeat(40) as GitSha],
  ]);
  const ref = (requestId: string) =>
    `refs/heads/sentinel-candidates/${
      requestId.replace(/^0+/, "").padStart(
        64,
        "f",
      )
    }`;
  // The older record as the live loop leaves it: the consumer settled its
  // charge and saved the pending preservation, its own job waits unavailable.
  const inflight = workRecord("inflight-older", {
    counters: { attempts: 1, retries: 0, reviewRounds: 0, stalled: 2 },
    target: {
      base: SHA1,
      branch: "sentinel/repair/inflight-older",
      checkpoint: null,
      head: candidates.get(older.requestId)!,
      pr: null,
      candidateState: { preserved: null, publishedHead: null },
    },
    intent: {
      kind: "candidate_preservation",
      key: implementationIntentKey(older.requestId),
      startedAt: T0,
      branch: ref(older.requestId),
      expectedHead: candidates.get(older.requestId)!,
      observedBase: SHA1,
      pr: null,
      requestId: older.requestId,
      resultId: null,
    },
    wait: { reason: "unavailable", since: T0 + 1, until: T0 + 300_001 },
  });
  const fresh = working("unconsumed-newer", newer.requestId);
  let writes = 0;
  const repair = {
    status: "found" as const,
    head: "e".repeat(40) as GitSha,
    ref: null,
    snapshot: {
      version: "v1",
      kind: "repair_state",
      sequence: 1,
      stateHead: null as GitSha | null,
      updatedAt: T0,
      work: [inflight, fresh.record],
      reservations: [
        reservation(older.requestId, {
          taskId: inflight.id,
          head: SHA1,
          outcome: "submitted",
          settledAt: T0 + 1,
        }),
        fresh.charge,
      ],
      reviews: [],
      releaseRequests: [],
    } as unknown as RepairStateSnapshotV1,
  };
  const calls = {
    recovered: [] as number[],
    preserved: [] as string[],
    // The proof pass every cycle of a producer pass was built with (#185).
    proofPasses: [] as (CandidateProofPassV1 | undefined)[],
    ingested: [] as string[],
  };
  const refs = new Map<string, GitSha>();
  const state: Record<PropertyKey, unknown> = new Proxy(store, {
    get(target, key) {
      if (key === "readRepair") {
        return () => Promise.resolve(portOk(structuredClone(repair)));
      }
      if (key === "writeRepair") {
        return (next: RepairStateSnapshotV1, expectedHead: GitSha) => {
          if (expectedHead !== repair.head) {
            return Promise.resolve(
              portOk({ status: "conflict" as const, currentHead: repair.head }),
            );
          }
          repair.head = (++writes).toString(16).padStart(40, "a") as GitSha;
          repair.snapshot = structuredClone(next);
          return Promise.resolve(
            portOk({ status: "applied" as const, head: repair.head }),
          );
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Record<PropertyKey, unknown>;
  const bindings = [
    { ...older, taskId: inflight.id },
    { ...newer, taskId: fresh.record.id },
  ];
  const wave = async (runId: number) => {
    const run = { runId, runAttempt: 1, launcherSha: LAUNCHER };
    const own = bindings.filter((row) => row.runId === runId);
    const plan = {
      waveId: execution(runId).id,
      run,
      cells: own.map((row) => ({
        cellId: `cell-${row.taskId}`,
        taskId: row.taskId,
        repository: REPO,
        reservationId: row.requestId,
        intentKey: implementationIntentKey(row.requestId),
        expectedBase: SHA1,
        runtimeSha: RUNTIME,
        generation: GENERATION,
      })),
    };
    return {
      plan,
      provenance: { run },
      planDigest: await matrixDigestV1(plan),
      results: own.map((row) => ({
        cellId: `cell-${row.taskId}`,
        taskId: row.taskId,
        reservationId: row.requestId,
        receipt: { candidate: { head: candidates.get(row.requestId)! } },
        bundle: { head: candidates.get(row.requestId)! },
      })),
      bundlesDir: `${root}/bundles`,
    };
  };
  // The real consumer's dispositions: an unconsumed implementation intent is
  // settled into the pending preservation (`ingested`); an already consumed
  // one rehydrates its exact saved objects (`duplicate`).
  const ingest = async (
    cycle: { state: RepairStateWriter & StateReadView },
    plan: MatrixPlanV1,
  ) => {
    const entries = [];
    let ingested = 0;
    for (const cell of plan.cells) {
      const read = await cycle.state.readRepair();
      assert(read.ok && read.value.status === "found");
      const record = read.value.snapshot.work.find((row) =>
        row.id === cell.taskId
      )!;
      if (record.intent?.kind === "candidate_preservation") {
        entries.push({
          cellId: cell.cellId,
          disposition: "duplicate" as const,
          detail:
            "receipt already consumed; exact saved candidate objects rehydrated",
        });
        continue;
      }
      assert.equal(record.intent?.kind, "implementation");
      const at = clock.now();
      const head = candidates.get(cell.reservationId)!;
      const written = await cycle.state.writeRepair({
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: read.value.snapshot.sequence + 1,
        updatedAt: at,
        work: read.value.snapshot.work.map((row) =>
          row.id === record.id
            ? {
              ...row,
              intent: {
                ...row.intent!,
                kind: "candidate_preservation" as const,
                startedAt: at,
                branch: ref(cell.reservationId),
                expectedHead: head,
              },
              target: {
                ...row.target,
                branch: `sentinel/repair/${row.id}`,
                head,
                candidateState: { preserved: null, publishedHead: null },
              },
              updatedAt: at,
            }
            : row
        ),
        reservations: read.value.snapshot.reservations.map((row) =>
          row.id === cell.reservationId
            ? { ...row, outcome: "submitted" as const, settledAt: at }
            : row
        ),
      }, read.value.head);
      assert(written.ok && written.value.status === "applied");
      calls.ingested.push(record.id);
      ingested++;
      entries.push({
        cellId: cell.cellId,
        disposition: "ingested" as const,
        detail: null,
      });
    }
    return { waveId: plan.waveId, entries, ingested };
  };
  const github = {
    preserveCandidate: (
      request: { candidate: { ref: string; head: GitSha } },
    ) => {
      calls.preserved.push(request.candidate.ref);
      refs.set(request.candidate.ref, request.candidate.head);
      return Promise.resolve(portOk(undefined));
    },
    readRef: (name: string) =>
      Promise.resolve(
        portOk(refs.has(name) ? { ref: name, sha: refs.get(name)! } : null),
      ),
  };
  const transport = {
    confirmCompletedExecution: () => Promise.resolve(true),
    recover: async (request: { currentRun?: { runId: number } }) => {
      const runId = request.currentRun!.runId;
      calls.recovered.push(runId);
      return [await wave(runId)];
    },
  };
  const deps = {
    clock,
    state,
    closedMatrix: () =>
      Promise.resolve({
        state,
        clock,
        configs: [{ repository: REPO }],
        cycleFor: (_config: unknown, proofPass?: CandidateProofPassV1) => {
          calls.proofPasses.push(proofPass);
          return { clock, github };
        },
        prepareTarget: () => Promise.resolve(),
        ingest,
        importerFor: () => ({}),
        transportFor: () => transport,
        readExecution: (saved: { runId: number }) =>
          Promise.resolve(portOk(proof(saved.runId))),
      }),
  };
  const walk = () =>
    (recoverHostedCurrentMatrix as (...args: unknown[]) => Promise<unknown>)(
      deps,
      CLOSED_C_WAVE,
      () => {},
    ) as Promise<{ status: string; actions: string[] } | null>;
  return {
    calls,
    older: { taskId: inflight.id, ref: ref(older.requestId), ...older },
    newer: { taskId: fresh.record.id, ref: ref(newer.requestId), ...newer },
    candidates,
    repair: () => structuredClone(repair),
    walk,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}
