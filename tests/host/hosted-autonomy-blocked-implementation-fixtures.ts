/** Historical retry artifacts over fake authenticated HTTP and real local Git. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseHostedRunProofV1 } from "../../src/contracts/hosted-supervisor.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import {
  portError,
  portOk,
  type RepairStateWriter,
  type StateReadView,
} from "../../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import {
  createGitBundleExporter,
  createGitBundleImporter,
} from "../../src/host/matrix-git.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { CI_CORRECTION_FINDING_PREFIX } from "../../src/repair/ci-rejection.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { recoverHostedCurrentMatrix } from "../../ops/hosted-autonomy-current-recovery.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import { FakeGithub, FakeIncidents, FakeReplay } from "../repair/helpers.ts";
import { REPO, SHA1, SHA2, T0, testGitEnv } from "../state/helpers.ts";
import { checked, checkout } from "./matrix-actions-fixtures.ts";
import {
  bytes,
  fixture,
  ISO,
  LAUNCHER,
  RUN,
  RUNTIME,
  zip,
} from "./matrix-artifact-fixtures.ts";
import { TransitionState } from "./hosted-autonomy-preservation-fixtures.ts";

export async function blockedRetryRig() {
  const f = await fixture();
  const env = testGitEnv(f.tmp + "/home");
  await Deno.mkdir(f.tmp + "/home");
  const target = f.tmp + "/target";
  const base = await checkout(target, env, { "base.txt": "base" });
  await Deno.writeTextFile(target + "/fix.ts", "export const fixed = true;\n");
  await checked(target, ["add", "."], env);
  await checked(target, ["commit", "-qm", "original repair"], env);
  const published = await checked(target, ["rev-parse", "HEAD"], env) as GitSha;
  const mirror = f.tmp + "/mirror";
  await checked(f.tmp, ["clone", "-q", target, mirror], env);
  await Deno.mkdir(target + "/.github/workflows", { recursive: true });
  await Deno.writeTextFile(target + "/.github/workflows/ci.yml", "jobs: {}\n");
  await checked(target, ["add", "."], env);
  await checked(target, ["commit", "-qm", "protected CI correction"], env);
  const candidate = await checked(target, ["rev-parse", "HEAD"], env) as GitSha;
  const cell = f.plan.cells[0];
  cell.expectedBase = base;
  cell.request.base = base;
  cell.request.checkoutBase = published;
  cell.request.reviewFindings = [{
    severity: "P1",
    path: null,
    message: CI_CORRECTION_FINDING_PREFIX + base.slice(0, 12) +
      ": validate (failure).",
  }];
  cell.requestDigest = await matrixDigestV1(cell.request);
  f.result.requestDigest = cell.requestDigest;
  f.result.receipt!.actual.provider = "uos";
  f.result.receipt!.candidate = {
    head: candidate,
    checkpointSha: null,
    changedPaths: [".github/workflows/ci.yml"],
  };
  const file = cell.cellId + ".bundle";
  const bundle = await createGitBundleExporter({
    repositoryDir: target,
    outputDir: f.tmp + "/export",
  }).create({ base, head: candidate, checkpointSha: null, file });
  assert(bundle);
  f.result.bundle = { ...bundle, head: candidate, checkpointSha: null, file };
  const oldKey = implementationIntentKey("b".repeat(64));
  const original = {
    operationKey: oldKey,
    base,
    head: published,
    ref: await candidatePreservationRef(REPO, cell.taskId, oldKey),
  };
  const work = f.repair.work[0];
  work.nextStep = "blocked";
  work.counters = { attempts: 2, retries: 1, reviewRounds: 0 };
  work.target = {
    base,
    branch: candidateBranch(work.id),
    head: published,
    pr: 12,
    checkpoint: null,
    candidateState: { preserved: original, publishedHead: published },
  };
  work.intent = {
    ...work.intent!,
    branch: work.target.branch,
    observedBase: base,
  };
  f.repair.reservations[0] = {
    ...f.repair.reservations[0],
    head: base,
    attempt: 2,
    purpose: "retry",
  };
  await f.setArchive(
    501,
    f.planName,
    await zip([{ name: "plan.json", content: bytes(f.plan) }]),
  );
  await f.setArchive(
    502,
    f.cellName,
    await zip([
      { name: "result.json", content: bytes(f.result) },
      { name: file, content: await Deno.readFile(f.tmp + "/export/" + file) },
    ]),
  );
  f.plannerMarker.planDigest = await matrixDigestV1(f.plan);
  f.cellMarker.resultDigest = await matrixDigestV1(f.result);
  f.cellMarker.bundleDigest = bundle.digest;
  f.logs.set(401, ISO + " " + JSON.stringify(f.plannerMarker) + "\n");
  f.logs.set(402, ISO + " " + JSON.stringify(f.cellMarker) + "\n");
  work.blocker = {
    kind: "other",
    since: T0,
    message: "authenticated historical matrix runtime mismatch; producer=" +
      RUN.runId + ":" + RUN.runAttempt +
      "; runtime=" + RUNTIME + "; plan=" + f.plannerMarker.planDigest +
      "; artifact=501; archive=" +
      f.artifacts.find((a) => a.id === 501)!.digest +
      "; planner=401; result=" + f.cellMarker.resultDigest +
      "; original admission retained",
  };
  f.attempt.status = "completed";
  const execution = {
    id: f.plan.waveId,
    ...RUN,
    revision: RUNTIME,
    purpose: "ordinary" as const,
    releaseId: null,
    generation: 3,
    createdAt: T0,
  };
  const proof = parseHostedRunProofV1({
    execution,
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 403,
    startedAt: T0,
    finishedAt: T0,
    observedAt: T0 + 1000,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: base,
    terminalAt: T0,
    logDigest: "c".repeat(64),
  });
  const producer = parseReleaseStateSnapshotV1({
    ...f.release,
    hostedRuntimes: f.release.hostedRuntimes.map((r) => ({
      ...r,
      execution: null,
      lastHealthyProof: proof,
      lastExecutionProof: proof,
    })),
  });
  const current = parseReleaseStateSnapshotV1({
    ...producer,
    stateHead: SHA2,
    sequence: 2,
    hostedRuntimes: producer.hostedRuntimes.map((r) => ({
      ...r,
      activeRevision: SHA1,
      generation: 4,
    })),
  });
  const state = new TransitionState(structuredClone(f.repair), current);
  const history = [structuredClone(state.snapshot)];
  let moved = false;
  let releaseReads = 0;
  let interruptCandidate = false;
  const shared = {
    readRepair: state.readRepair.bind(state),
    readRelease: () =>
      Promise.resolve(portOk({
        status: "found" as const,
        snapshot: structuredClone(current),
        head: moved && releaseReads++ > 0 ? LAUNCHER : SHA1,
        ref: null,
      })),
    writeRepair: async (
      ...args: Parameters<TransitionState["writeRepair"]>
    ) => {
      if (
        interruptCandidate &&
        args[0].work.some((row) =>
          row.id === work.id && row.target.head === candidate
        )
      ) {
        return portError("unavailable", "fixture interrupted candidate write");
      }
      const result = await state.writeRepair(...args);
      history.push(structuredClone(state.snapshot));
      return result;
    },
    readReleaseAt: ({ commit }: { commit: GitSha }) => {
      assert.equal(commit, SHA2);
      return Promise.resolve(portOk({
        status: "found" as const,
        snapshot: structuredClone(producer),
        head: SHA2,
        ref: null,
      }));
    },
  };
  const github = new FakeGithub();
  const config = repositoryConfig(REPO, { perHour: 100, perSevenDays: null }, {
    protectedPaths: [".github/workflows"],
  });
  let now = T0 + 10_000;
  const clock = { now: () => now };
  let imports = 0;
  const deps: HostedAutonomyDepsV1 = {
    state: shared,
    clock,
    githubFor: () => null,
    closedMatrix: (passState = shared) =>
      Promise.resolve({
        state: passState,
        clock,
        configs: [config],
        cycleFor: () => ({
          state: passState,
          clock,
          configs: [config],
          controllerSha: SHA1,
          github,
          githubCooldown: new DurableGitHubCooldownGate({
            state: passState,
            clock,
          }),
          incidents: new FakeIncidents(),
          replay: new FakeReplay(),
          model: {
            runModel: () => {
              throw new Error("unexpected model start");
            },
          },
          budget: new RollingStartBudget({
            state: passState,
            clock,
            configs: [config],
          }),
        }),
        prepareTarget: () => Promise.resolve(),
        importerFor: (_config, bundlesDir) => ({
          import: async (request) => {
            imports++;
            return await createGitBundleImporter({
              repositoryDir: mirror,
              bundlesDir,
            }).import(request);
          },
        }),
        transportFor: (producerState: StateReadView & RepairStateWriter) =>
          createActionsMatrixArtifactTransport({
            state: producerState,
            clock,
            http: f.http,
            token: "fake-local-token",
            artifactRoot: f.tmp + "/recovered",
          }),
        readExecution: () => Promise.resolve(portOk(proof)),
      }),
  };
  return {
    f,
    state,
    history,
    shared,
    producer,
    current,
    execution,
    proof,
    published,
    candidate,
    original,
    github,
    imports: () => imports,
    advanceClock: (ms: number) => {
      now += ms;
    },
    interruptCandidateWrites: () => {
      interruptCandidate = true;
    },
    resumeCandidateWrites: () => {
      interruptCandidate = false;
    },
    moveCustody: () => {
      moved = true;
    },
    run: async () => {
      const cwd = Deno.cwd();
      Deno.chdir(f.tmp + "/checkout");
      try {
        return await recoverHostedCurrentMatrix(deps, CLOSED_C_WAVE, () => {});
      } finally {
        Deno.chdir(cwd);
      }
    },
    cleanup: () => Deno.remove(f.tmp, { recursive: true }),
  };
}
