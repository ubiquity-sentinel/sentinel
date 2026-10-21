/**
 * A producer pass that crosses the walk deadline (here inside the plan
 * listing) is the bounded deferral, never an untyped escape that would skip
 * the run's retry and delivery passes.
 */
import assert from "node:assert/strict";
import { runHostedMatrixMaintenance } from "../../ops/hosted-autonomy-maintenance.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "../state/helpers.ts";

Deno.test("current matrix: a producer pass past the walk deadline defers instead of escaping", async () => {
  const RUNTIME = "c".repeat(40), LAUNCHER = "d".repeat(40), RUN = 1001;
  const ARCHIVE = `sha256:${"2".repeat(64)}`;
  const execution = {
    id: `${RUN}:1:repair`,
    runId: RUN,
    runAttempt: 1,
    launcherSha: LAUNCHER,
    purpose: "ordinary",
    revision: RUNTIME,
    generation: 70,
    releaseId: null,
    createdAt: T0,
  };
  const proof = parseHostedRunProofV1({
    execution,
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "Ubiquity-Sentinel/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: RUN,
    startedAt: T0 + 100,
    finishedAt: T0 + 200,
    observedAt: T0 + 300,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: RUNTIME,
    terminalAt: T0 + 150,
    logDigest: "0".repeat(64),
  });
  const requestId = "b".repeat(64);
  const record = workRecord("blocked-1", {
    nextStep: "blocked",
    blocker: {
      kind: "other",
      since: T0,
      message:
        `authenticated historical matrix runtime mismatch; producer=${RUN}:1; runtime=${RUNTIME}; plan=${
          "1".repeat(64)
        }; artifact=7001; archive=${ARCHIVE}; planner=${RUN + 5}; result=${
          "3".repeat(64)
        }; original admission retained`,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    target: {
      base: SHA1,
      branch: "sentinel/repair/blocked-1",
      checkpoint: null,
      head: SHA2,
      pr: null,
      candidateState: { preserved: null, publishedHead: null },
    },
    intent: {
      kind: "candidate_preservation",
      key: implementationIntentKey(requestId),
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
    taskId: record.id,
    head: SHA1,
    outcome: "submitted",
    settledAt: T0 + 1,
  });
  const head = "e".repeat(40);
  const release = {
    status: "found",
    head,
    ref: null,
    snapshot: {
      sequence: 1,
      stateHead: null,
      hostedReleases: [],
      hostedRuntimes: [{
        id: HOSTED_RUNTIME_ID,
        kind: "hosted_runtime",
        version: "v1",
        activeRevision: RUNTIME,
        generation: 70,
        lastHealthyProof: null,
        lastExecutionProof: proof,
        nextOrdinaryAt: T0,
        execution: null,
        createdAt: T0,
        updatedAt: T0,
      }],
    },
  };
  let now = T0 + 10_000_000;
  const startedAt = now;
  const deps = {
    clock: { now: () => now },
    githubFor: () => ({ readBaseTip: () => Promise.resolve(null) }),
    state: {
      readRepair: () =>
        Promise.resolve(
          portOk({
            status: "found",
            head: "f".repeat(40),
            ref: null,
            snapshot: {
              work: [record],
              reservations: [charge],
              reviews: [],
              releaseRequests: [],
            },
          }),
        ),
      readRelease: () => Promise.resolve(portOk(structuredClone(release))),
      readReleaseAt: () => Promise.reject(new Error("not used")),
      writeRepair: () => Promise.reject(new Error("no write expected")),
    },
    closedMatrix: () =>
      Promise.resolve({
        configs: [{ repository: REPO }],
        binding: undefined,
        transportFor: () => ({
          confirmCompletedExecution: () => Promise.resolve(true),
          recover: () => Promise.reject(new Error("transport not reached")),
        }),
        readExecution: () => Promise.resolve(portOk(proof)),
        readPlanArtifact: (_run: unknown, deadlineAt: number) => {
          // The listing starts 100 ms before the walk deadline and its request
          // outlives it: the shared reader refuses (plain provenance refusal).
          now = deadlineAt + 1;
          return Promise.reject(
            new Error("matrix artifact provenance unavailable or conflicting"),
          );
        },
      }),
  };
  const actions: string[] = [];
  const result = await runHostedMatrixMaintenance(deps as never, actions);
  assert.equal(result, null);
  assert.deepEqual(actions, ["matrix-history:deferred"]);
  assert.ok(now > startedAt);
});
