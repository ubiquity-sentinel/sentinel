import assert from "node:assert/strict";
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import { createHostedHistoricalMatrixQuarantine } from "../../ops/hosted-autonomy-matrix-adapters.ts";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  matrixCellIdV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  type MatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import {
  createActionsMatrixArtifactHttpTransport,
  createActionsMatrixArtifactTransport,
} from "../../src/host/matrix-artifacts.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import {
  HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE,
  type HistoricalMatrixQuarantineDepsV1,
} from "../../src/host/matrix-actions.ts";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  type HostedPolicyGraph,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import {
  gitRun,
  pushRawTree,
  reservation,
  sha256Hex,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  BASE,
  ENV,
  FOREIGN_REPO,
  SELF_REPO,
} from "./hosted-autonomy-fixtures.ts";
import {
  CopyingRepairState,
  makeRig,
  releaseSnapshot,
  repairSnapshot,
} from "./hosted-autonomy-rig.ts";

type HistoricalQuarantineInput = Parameters<
  typeof createHostedHistoricalMatrixQuarantine
>[0];
type HistoricalWitnesses = NonNullable<
  HistoricalMatrixQuarantineDepsV1["historicalReleaseWitnesses"]
>;
interface WitnessFactory {
  input: HistoricalQuarantineInput;
  rejects: HistoricalWitnesses[number]["reject"][];
  nativeQueueFor: HistoricalMatrixQuarantineDepsV1["nativeQueueFor"];
}
const witnessInputs = new WeakMap<HistoricalWitnesses, WitnessFactory>();

/** Retain genuine producer inputs for the graph's own artifact error classes. */
export function historicalMatrixQuarantineFixture(
  input: HistoricalQuarantineInput,
) {
  const result = createHostedHistoricalMatrixQuarantine(input);
  const witnesses = result.historicalReleaseWitnesses;
  if (witnesses !== undefined) {
    witnessInputs.set(witnesses, {
      input,
      rejects: witnesses.map((witness) => witness.reject),
      nativeQueueFor: result.nativeQueueFor,
    });
  }
  return result;
}

export async function historicalMalformedRig(
  includeSibling = true,
  historicalCount = 17,
  realRepair = false,
  cacheRelease = false,
  c63 = false,
  c63MissingQuarantined = true,
  baseOverride: GitSha | null = null,
) {
  const launcher =
    (c63
      ? "b261c3672b29c29cfe6858fe96beb05687018c8f"
      : "1".repeat(40)) as GitSha;
  const revision =
    (c63
      ? "e4cef46332cf124a8c283d798a963cf5f66e45c2"
      : "2".repeat(40)) as GitSha;
  const generation = c63 ? 63 : 1;
  const repository = c63
    ? { ...FOREIGN_REPO, name: "ai.ubq.fi", installationId: 155687488 }
    : SELF_REPO;
  const base = baseOverride ??
    (c63 ? "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" : BASE) as GitSha;
  const run = {
    runId: c63 ? 37354374590 : 71,
    runAttempt: c63 ? 1 : 2,
    launcherSha: launcher,
  };
  const issues = [
    576,
    616,
    618,
    398,
    420,
    421,
    427,
    541,
    570,
    575,
    577,
    583,
    587,
    589,
    592,
    608,
    610,
    611,
    617,
    300,
    578,
    579,
    609,
    615,
  ];
  const authenticReservations = [
    "ffc3337e27e0e05a641908db08825ad63bc6d6868cfabcd5af667b2ede4d4677",
    "7d9d1b7949b3d5dc3c9917cf24263324f23674ce891f9f269b73a9e787d8bad4",
    "2956b4efb0ba8181e3e0c15f6ce7bd024640706c293cdb34a7dfd322e3d4ae86",
    "8da7cfad2230c22de6955d53a2b6923ce1734dd825a2440c43d6a74440c99a09",
    "3cb86e0f76b76aadaaac176c172e43effb5c8533c7d1b3ca1339f548da534af5",
    "fb79ebbb9552de0df004fdf8d19ec2bd2be7dc8ac36b94efb98dddce72d0804e",
    "1bc96d7012496ae85316abdd6e68914fa9944288c71a5fade3f8005533d08ebc",
    "d53181817d837b13f62ab7ee92fd7e540d576312c90239cebc4c0d7268a4e0d0",
    "487ed315f82ff0bd132fbe8fa97b6fd736f1fdc2701497367cb981f8ced0161d",
    "128b0db9b4f8c157f953b9ecfb18544ee04f019fb78eeec7ddf7e649a031d522",
    "8f4f55cb4af1c3e543e36556da8890c1a9c11b913415d4cfb0c3e35c5118241a",
    "63988226e9739da266ce14de1cce5746d662220e39a8ddcb99337ab40b405d69",
    "0d8da09d774019c738f09dfdd6a249993a7bd49ffeb03b21b4629132e739cd44",
    "53437275fa4adaa9788d2ca51b971cc0a3744611c5cf281d84b95c4d8d73fed7",
    "73535d9286a092a3f7b2d96c22a8ef6a0f935b975d09006cd7e418fc867d91cd",
    "c97ba108b7c9e9aaa01bc0ac765ed962292f20514b66ec99913320d42e26eb2d",
    "99255d8f4e420dc7947a6bc5fc6acfb47d33e2acbb9b4234264bf2ac735d3437",
    "6ca9fd2eb1ad7e38d7c5676fd15e1f80dfa0fa3339064a7711e60d53a9bd5fcc",
    "097cf4dcf51d6b671e0014bda5db042fe0f61b7823d978fa71bddf7560c9baae",
    "1fbca2e4577ff78d6143fa1ee651d00edd3d6f13fe141d753a1c92dc478a4217",
    "a038ab3e24ba9e57b6b9da96e742b57156007f014c412b274fcd6cd5b689e267",
    "398ddbe2f437ce81fbab2f3e089775a7d34b688f35cc648e00ab6a881ff1f5db",
    "a598b889f41e039430129a03d3482e0813183c0707a2b613d3800353522a8086",
    "d8ea73b059f17fa1f8c1c5fa40bb1fc488848277c60e62e7b8fcfdbdaf16a91b",
  ];
  const execution = {
    id: `${run.runId}:${run.runAttempt}:repair`,
    ...run,
    purpose: "ordinary" as const,
    revision,
    generation,
    releaseId: null,
    createdAt: T0,
  };
  const clock = { now: () => T0 + 60_000 };
  const records = Array.from({
    length: historicalCount + (includeSibling ? 1 : 0),
  }, (_, i) => {
    const id = (c63 && i < 24
      ? `issue-ubiquity-ai.ubq.fi-${issues[i]}`
      : `historical-${i}`) as WorkItemId;
    const requestId = c63 && i < 24
      ? authenticReservations[i]
      : (i + 1).toString(16).padStart(64, "0");
    return workRecord(id, {
      repository,
      related: {
        incidentId: null,
        issueNumber: c63 && i < 24 ? issues[i] : i + 1,
      },
      counters: { attempts: c63 ? 2 : 1, retries: 0, reviewRounds: 0 },
      ...(c63 && i >= 3 && (i >= 19 || c63MissingQuarantined)
        ? {
          nextStep: "blocked",
          blocker: {
            kind: "other",
            since: T0 + i + 1,
            message: i < 19
              ? HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE
              : i < 24
              ? "sanitized no start"
              : "unrelated charged history",
          },
        }
        : {}),
      target: {
        base,
        head: null,
        pr: null,
        branch: candidateBranch(id),
        checkpoint: null,
      },
      intent: {
        kind: "implementation",
        key: implementationIntentKey(requestId),
        startedAt: T0 + i + 1,
        branch: candidateBranch(id),
        expectedHead: null,
        observedBase: base,
        pr: null,
        requestId,
        resultId: null,
      },
      updatedAt: T0 + i + 1,
    });
  });
  const charges = records.map((record, i) =>
    reservation(record.intent!.requestId!, {
      repository,
      taskId: record.id,
      head: base,
      attempt: c63 ? 2 : 1,
      purpose: c63 ? "retry" : "implementation",
      ...(c63 && i >= 19 && i < 24
        ? { outcome: "ambiguous", settledAt: T0 + 40_000 }
        : {}),
      createdAt: T0 + i + 1,
    })
  );
  const release = releaseSnapshot();
  release.hostedRuntimes = [{
    version: "v1",
    kind: "hosted_runtime",
    id: "ubiquity-sentinel/sentinel:0:production",
    activeRevision: revision,
    generation,
    lastHealthyProof: null,
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution,
    createdAt: T0,
    updatedAt: T0,
  }];
  const { rig, github } = await makeRig("historical-malformed", {
    fixtureDir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
    repair: repairSnapshot(records, [], [], charges),
    // The legacy guard cases persist only their repair half in memory (real
    // CAS rules) so they fit the bounded window; the small real-Git recovery
    // proof passes realRepair to keep the real state transport.
    repairState: realRepair ? undefined : new CopyingRepairState(),
    repairReadThrough: realRepair && cacheRelease,
    release: c63 ? { ...release, hostedRuntimes: [] } : release,
    pull: null,
    issueOpen: null,
    baseTip: BASE,
    // Multiwave rigs only: every custody read still proves the actual current
    // remote release head before any cached snapshot may be reused. The view is
    // composed by the constructor so the rig value itself stays immutable.
    releaseReadThrough: cacheRelease,
  });
  if (c63) {
    // Restore a captured historical tree in disposable Git, using the same
    // seam as seedCapturedRelease. New-runtime generation checks stay intact.
    const seed = await rig.state.readRelease();
    assert(seed.ok && seed.value.status === "found");
    const files: Record<string, string> = {
      "manifest.json": canonicalStringify({
        version: "v1",
        kind: "release_state_manifest",
        sequence: seed.value.snapshot.sequence + 1,
        updatedAt: release.updatedAt,
        stateHead: seed.value.head,
      }) + "\n",
    };
    for (const row of release.hostedRuntimes) {
      files[`hostedRuntimes/${await sha256Hex(row.id)}.json`] =
        canonicalStringify(row) + "\n";
    }
    const restored = await pushRawTree(
      { bare: `${rig.tmp}/remote.git`, work: `${rig.tmp}/work` },
      seed.value.head,
      "refs/heads/sentinel-state/release",
      files,
      ENV,
    );
    assert(restored.ok, restored.stderr);
    const readback = await rig.state.readRelease();
    assert(readback.ok && readback.value.status === "found");
    assert.deepEqual(
      readback.value.snapshot.hostedRuntimes,
      release.hostedRuntimes,
    );
  }
  const checkout = `${rig.tmp}/checkout`;
  const cloned = await gitRun(rig.tmp, [
    "clone",
    "-q",
    // Fetch the object graph instead of racing loose-object copies in local Git.
    "--no-local",
    "--branch",
    "sentinel-state/repair",
    `${rig.tmp}/remote.git`,
    checkout,
  ], ENV);
  assert(cloned.ok, cloned.stderr);
  const artifacts: Record<string, unknown>[] = [];
  const archives = new Map<number, Uint8Array>();
  const logs = new Map<number, string>();
  const iso = (at: number) => new Date(at).toISOString();
  async function archived(id: number, name: string, value: unknown) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
    });
    await writer.add(
      name.startsWith("sentinel-matrix-plan") ? "plan.json" : "result.json",
      new Uint8ArrayReader(new TextEncoder().encode(canonicalStringify(value))),
      { unixMode: 0o100600 },
    );
    const bytes = await writer.close();
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
    )
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    archives.set(id, bytes);
    artifacts.push({
      id,
      name,
      size_in_bytes: bytes.length,
      expired: false,
      digest: `sha256:${digest}`,
      workflow_run: {
        id: run.runId,
        repository_id: 123,
        head_repository_id: 123,
        head_branch: "sentinel-supervisor",
        head_sha: launcher,
      },
    });
  }
  const cells = await Promise.all(
    records.slice(0, historicalCount).map(async (record) => {
      const request = {
        taskId: record.id,
        repository,
        base,
        issue: {
          number: record.related.issueNumber!,
          title: "sanitized",
          body: "sanitized",
        },
        evidence: [],
        model: "gpt-reserve",
        reasoning: "max" as const,
        maxDurationMs: 10_000,
        maxOutputChars: 10_000,
      };
      return {
        cellId: await matrixCellIdV1(
          execution.id,
          record.id,
          record.intent!.requestId!,
        ),
        taskId: record.id,
        repository,
        reservationId: record.intent!.requestId!,
        intentKey: record.intent!.key,
        expectedBase: base,
        runtimeSha: revision,
        generation,
        requestDigest: await matrixDigestV1(request),
        request,
      };
    }),
  );
  const plan: MatrixPlanV1 = {
    version: "v1",
    kind: "matrix_plan",
    waveId: execution.id,
    run,
    plannedAt: c63 ? T0 + 24 : T0,
    cells,
  };
  const job = (id: number, name: string, step: string, failed = false) => ({
    id,
    name,
    run_id: run.runId,
    run_attempt: run.runAttempt,
    head_sha: launcher,
    status: "completed",
    conclusion: failed ? "failure" : "success",
    started_at: iso(T0),
    completed_at: iso(T0 + 30_000),
    steps: [{
      name: step,
      number: 1,
      status: "completed",
      conclusion: failed ? "failure" : "success",
      started_at: iso(T0),
      completed_at: iso(T0 + 30_000),
    }],
  });
  const jobs = [
    job(401, "matrix_plan", "Plan isolated issue matrix"),
    job(499, "repair", "Run selected Sentinel runtime", true),
  ];
  logs.set(499, `${iso(T0 + 30_000)} child exited before terminal\n`);
  async function refreshPlan(
    cellStatus: "not_started" | "completed" = "not_started",
  ) {
    artifacts.splice(0, artifacts.length);
    await archived(
      501,
      `sentinel-matrix-plan-${run.runId}-${run.runAttempt}`,
      plan,
    );
    logs.set(
      401,
      `${iso(T0 + 25_000)} ${
        JSON.stringify({
          kind: "sentinel_matrix_plan",
          waveId: execution.id,
          run,
          runtimeSha: revision,
          generation,
          planDigest: await matrixDigestV1(plan),
          prepared: cells.length,
        })
      }\n`,
    );
    for (const [i, cell] of cells.entries()) {
      if (c63 && i >= 3) continue;
      const result: MatrixCellResultV1 = {
        version: "v1",
        kind: "matrix_cell_result",
        waveId: execution.id,
        run,
        runtimeSha: revision,
        generation,
        cellId: cell.cellId,
        taskId: cell.taskId,
        repository,
        reservationId: cell.reservationId,
        intentKey: cell.intentKey,
        requestDigest: cell.requestDigest,
        status: cellStatus,
        receipt: cellStatus === "completed"
          ? {
            invocationId: `invocation-${cell.cellId}`,
            outcome: "failed",
            actual: {
              evidenceKind: "request-runtime",
              provider: "uos",
              threadId: `thread-${cell.cellId}`,
              turnId: `turn-${cell.cellId}`,
              terminalOrigin: "runtime",
              observedTerminalStatus: "failed",
              observedModel: "gpt-reserve",
              observedReasoning: "max",
              durationMs: 1,
              outputChars: 1,
            },
            candidate: null,
            error: "runtime_error",
          }
          : null,
        bundle: null,
        detail: cellStatus === "completed" ? null : "sanitized no start",
        completedAt: T0 + 29_000,
      };
      await archived(
        502 + i,
        `sentinel-matrix-cell-${run.runId}-${run.runAttempt}-${cell.cellId}`,
        result,
      );
      logs.set(
        402 + i,
        `${iso(T0 + 29_000)} ${
          JSON.stringify({
            kind: "sentinel_matrix_cell",
            run,
            runtimeSha: revision,
            generation,
            cellId: cell.cellId,
            reservationId: cell.reservationId,
            resultDigest: await matrixDigestV1(result),
            bundleDigest: null,
            status: cellStatus,
          })
        }\n`,
      );
    }
  }
  jobs.push(
    ...cells.map((cell, i) =>
      job(402 + i, `matrix_cell (${cell.cellId})`, "Run isolated issue cell")
    ),
  );
  await refreshPlan();
  let fault: "auth" | "outage" | "missing" | "pending" | null = null;
  const calls: { url: string; authorization: string | undefined }[] = [];
  const http = createActionsMatrixArtifactHttpTransport((url, init) => {
    calls.push({ url, authorization: init?.headers?.authorization });
    const parsed = new URL(url);
    if (fault === "outage") {
      return Promise.resolve(new Response("", { status: 503 }));
    }
    const reply = (value: unknown) =>
      Promise.resolve(new Response(JSON.stringify(value)));
    if (parsed.hostname.endsWith("blob.core.windows.net")) {
      assert.equal(init?.headers?.authorization, undefined);
      assert.equal(init?.redirect, "error");
      const id = Number(parsed.pathname.split("/").at(-1));
      return Promise.resolve(
        new Response(
          parsed.pathname.startsWith("/archive/")
            ? archives.get(id)!.slice()
            : logs.get(id)!,
        ),
      );
    }
    assert.equal(init?.headers?.authorization, "Bearer offline-native-token");
    assert(["manual", "error"].includes(init?.redirect ?? ""));
    if (parsed.pathname.endsWith(`/attempts/${run.runAttempt}`)) {
      return reply({
        id: run.runId,
        run_attempt: run.runAttempt,
        workflow_id: 357012162,
        path: ".github/workflows/supervisor.yml",
        event: "workflow_dispatch",
        head_branch: "sentinel-supervisor",
        head_sha: fault === "auth" ? BASE : launcher,
        repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
        head_repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
        status: "completed",
        conclusion: "failure",
        run_started_at: iso(T0),
        updated_at: iso(T0 + 30_000),
      });
    }
    if (parsed.pathname.endsWith("/jobs")) {
      return reply({
        total_count: jobs.length,
        jobs: fault === "pending"
          ? jobs.map((row) =>
            row.name === "repair"
              ? {
                ...row,
                status: "in_progress",
                conclusion: null,
                completed_at: null,
              }
              : row
          )
          : jobs,
      });
    }
    if (parsed.pathname.endsWith("/artifacts")) {
      return reply({
        total_count: fault === "missing" ? 0 : artifacts.length,
        artifacts: fault === "missing" ? [] : artifacts,
      });
    }
    const archive = parsed.pathname.match(/\/artifacts\/(\d+)\/zip$/);
    const log = parsed.pathname.match(/\/jobs\/(\d+)\/logs$/);
    if (archive || log) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: `https://productionresultssa1.blob.core.windows.net/${
              archive ? "archive" : "log"
            }/${(archive ?? log)![1]}`,
          },
        }),
      );
    }
    throw new Error("unscripted offline route");
  });
  const client = new GitHubApiClient({
    repository: SELF_REPO,
    apiBaseUrl: "https://api.github.com",
    clock,
    http,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk("Bearer offline-native-token")),
    },
    cooldownGate: new HostedRepairCooldownGate({ state: rig.state, clock }),
  });
  const artifactOptions = {
    state: rig.state,
    clock,
    token: "offline-native-token",
    artifactRoot: `${rig.tmp}/artifacts`,
    http,
  };
  // The concrete controller stays visible (the aggregate fixture call uses its
  // full interface) while the quarantine capability keeps the declared
  // mutable revalidation flag.
  const historicalMatrix: HistoricalMatrixQuarantineDepsV1 & {
    budget: RollingStartBudget;
  } = {
    state: rig.state,
    clock,
    nativeQueueFor: () => inactiveNativeQueueFixture(),
    // Default closed: only a test (or the trusted production route) that
    // explicitly enables authenticated not-started revalidation reconciles
    // already-quarantined records.
    revalidateNotStarted: false,
    budget: new RollingStartBudget({ state: rig.state, clock, configs: [] }),
    readExecution: (saved: typeof execution) =>
      client.readHostedExecution(saved),
    transport: createActionsMatrixArtifactTransport(artifactOptions),
  };
  const deps = {
    state: rig.state,
    githubFor: rig.githubFor,
    clock,
    historicalMatrix,
  };
  const transportDefaults = { ...historicalMatrix.transport };
  async function historicalDeps(graph: HostedPolicyGraph) {
    const { createActionsMatrixArtifactTransport } = await graph
      .matrixArtifacts();
    const transport = createActionsMatrixArtifactTransport(artifactOptions);
    // Artifact error classes must share the quarantine consumer's graph; keep
    // explicit fault-injection methods exactly as the scenario installed them.
    for (const method of Object.keys(transport)) {
      const current = Reflect.get(historicalMatrix.transport, method);
      if (current !== Reflect.get(transportDefaults, method)) {
        Reflect.set(transport, method, current);
      }
    }
    let nativeQueueFor = historicalMatrix.nativeQueueFor;
    let witnesses = historicalMatrix.historicalReleaseWitnesses;
    const factory = witnesses === undefined
      ? undefined
      : witnessInputs.get(witnesses);
    if (factory !== undefined && witnesses !== undefined) {
      const { createHostedHistoricalMatrixQuarantine } = await graph
        .matrixAdapters();
      const rebuilt = createHostedHistoricalMatrixQuarantine(factory.input);
      const produced = rebuilt.historicalReleaseWitnesses;
      assert(produced);
      if (nativeQueueFor === factory.nativeQueueFor) {
        nativeQueueFor = rebuilt.nativeQueueFor;
      }
      assert.equal(produced.length, witnesses.length);
      witnesses = produced.map((actual, index) => {
        const original = witnesses![index];
        const reject = original.reject === factory.rejects[index]
          ? actual.reject
          : original.reject;
        return Object.assign(actual, original, { reject });
      });
    }
    return await withDarkQueueAuthority({
      ...deps,
      historicalMatrix: {
        ...historicalMatrix,
        transport,
        nativeQueueFor,
        ...(witnesses === undefined
          ? {}
          : { historicalReleaseWitnesses: witnesses }),
      },
    });
  }
  const checkoutHead = await gitRun(checkout, ["rev-parse", "HEAD"], ENV);
  assert(checkoutHead.ok);
  const mainEnv = {
    GITHUB_REPOSITORY: "ubiquity-sentinel/sentinel",
    GITHUB_REF: "refs/heads/sentinel-supervisor",
    GITHUB_JOB: "maintenance",
    GITHUB_RUN_ID: "900",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF:
      "ubiquity-sentinel/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
    GITHUB_SHA: checkoutHead.stdout.trim(),
    GITHUB_WORKFLOW_SHA: checkoutHead.stdout.trim(),
    GITHUB_TOKEN: "offline-native-token",
  };
  return {
    rig,
    github,
    clock,
    records,
    charges,
    historicalMatrix,
    plan,
    cells,
    refreshPlan,
    http,
    client,
    execution,
    nativeRun: run,
    artifacts,
    archives,
    logs,
    jobs,
    checkout,
    setFault: (next: typeof fault) => {
      fault = next;
    },
    calls,
    withHistoricalGraph: <T>(
      consume: (
        graph: HostedPolicyGraph,
        deps: Awaited<ReturnType<typeof historicalDeps>>,
      ) => Promise<T>,
    ): Promise<T> =>
      withHostedProductionPolicy(
        DORMANT_HOSTED_SUPERVISOR_POLICY,
        async (graph) => await consume(graph, await historicalDeps(graph)),
      ),
    runMain: async () => {
      const prior = Deno.cwd();
      Deno.chdir(checkout);
      try {
        return await withHostedProductionPolicy(
          DORMANT_HOSTED_SUPERVISOR_POLICY,
          async (graph) => {
            const { runHostedAutonomyMain } = await graph.maintenanceMain();
            return await runHostedAutonomyMain({
              env: mainEnv,
              deps: await historicalDeps(graph),
            });
          },
        );
      } finally {
        Deno.chdir(prior);
      }
    },
    run: async () => {
      const prior = Deno.cwd();
      Deno.chdir(checkout);
      try {
        return await withHostedProductionPolicy(
          DORMANT_HOSTED_SUPERVISOR_POLICY,
          async (graph) => {
            const { runHostedAutonomy } = await graph.runner();
            return await runHostedAutonomy(await historicalDeps(graph));
          },
        );
      } finally {
        Deno.chdir(prior);
      }
    },
  };
}
