/**
 * An owner install moves the active runtime pointer forward while keeping the
 * previous ordinary execution proof. The current-matrix history walk must read
 * past that install snapshot to the proof's own custody snapshot instead of
 * failing every later maintenance pass on it.
 */
import assert from "node:assert/strict";
import { recoverHostedCurrentMatrix } from "../../ops/hosted-autonomy-current-recovery.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "../../ops/hosted-autonomy-producer-recovery.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import { reservation, SHA1, workRecord } from "../state/helpers.ts";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const LAUNCHER = "c".repeat(40);
const HEADS = ["1", "2", "3", "4"].map((digit) => digit.repeat(40));
const REACHED = "closed matrix reached at the custody snapshot";

function proof(purpose: string, revision: string, generation: number) {
  return {
    baseSha: null,
    finishedAt: 1,
    jobId: 1,
    logDigest: "0".repeat(64),
    observedAt: 1,
    outcome: "healthy",
    ref: "refs/heads/sentinel-supervisor",
    repository: "Ubiquity-Sentinel/sentinel",
    settled: true,
    startedAt: 1,
    startupReady: true,
    terminalAt: 1,
    workflowId: 1,
    workflowPath: ".github/workflows/supervisor.yml",
    execution: {
      createdAt: 1,
      generation,
      id: `${generation}:1:repair`,
      launcherSha: LAUNCHER,
      purpose,
      releaseId: null,
      revision,
      runAttempt: 1,
      runId: generation,
    },
  };
}

function runtime(over: Record<string, unknown>) {
  return {
    id: HOSTED_RUNTIME_ID,
    kind: "hosted_runtime",
    version: "v1",
    createdAt: 1,
    updatedAt: 1,
    nextOrdinaryAt: 1,
    lastHealthyProof: null,
    ...over,
  };
}

/**
 * Newest first: a bootstrap proof after the install, the bootstrap execution,
 * the install snapshot itself (`install`) and the proof's own snapshot.
 */
function history(install: Record<string, unknown>) {
  const ordinary = proof("ordinary", OLD, 75);
  const bootstrap = proof("bootstrap", NEW, 76);
  const rows = [
    {
      activeRevision: NEW,
      generation: 76,
      execution: null,
      lastExecutionProof: bootstrap,
    },
    {
      activeRevision: NEW,
      generation: 76,
      execution: bootstrap.execution,
      lastExecutionProof: ordinary,
    },
    { execution: null, lastExecutionProof: ordinary, ...install },
    {
      activeRevision: OLD,
      generation: 75,
      execution: null,
      lastExecutionProof: ordinary,
    },
  ];
  const snapshots: Record<string, unknown> = {};
  rows.forEach((row, index) => {
    snapshots[HEADS[index]] = {
      stateHead: HEADS[index + 1] ?? null,
      sequence: 100 - index,
      hostedReleases: [],
      hostedRuntimes: [runtime(row)],
    };
  });
  return snapshots;
}

function walk(snapshots: Record<string, unknown>) {
  // One in-flight implementation with its exact charge is enough to start the
  // history walk; the producer binds that charge before any matrix port.
  const charge = reservation("pending-charge", { taskId: "issue-1" });
  const pending = workRecord("issue-1", {
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    intent: {
      kind: "implementation",
      key: implementationIntentKey("pending-charge"),
      startedAt: 1,
      branch: null,
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      requestId: "pending-charge",
      resultId: null,
    },
  });
  const found = (head: string) =>
    Promise.resolve({
      ok: true,
      value: { status: "found", head, snapshot: snapshots[head] },
    });
  const deps = {
    clock: { now: () => 0 },
    state: {
      readRepair: () =>
        Promise.resolve({
          ok: true,
          value: {
            status: "found",
            head: "f".repeat(40),
            snapshot: { work: [pending], reservations: [charge] },
          },
        }),
      readRelease: () => found(HEADS[0]),
      readReleaseAt: ({ commit }: { commit: string }) => found(commit),
      writeRepair: () => {
        throw new Error("the walk must not write");
      },
    },
    closedMatrix: () => {
      throw new Error(REACHED);
    },
  };
  return recoverHostedCurrentMatrix(
    deps as never,
    CLOSED_C_WAVE as never,
    () => {},
  );
}

Deno.test("current matrix walk reads past an owner-install snapshot to the proof's custody", async () => {
  const error = await walk(history({ activeRevision: NEW, generation: 76 }))
    .then(() => null, (thrown) => thrown);
  // Reaching the producer recovery for the older consistent snapshot proves
  // the install snapshot was skipped rather than treated as custody.
  assert.ok(error instanceof Error);
  assert.equal(error instanceof CurrentMatrixRecoveryIntegrityFailure, false);
  assert.equal(error.message, REACHED);
});

Deno.test("current matrix walk still refuses an inconsistent same-generation pointer", async () => {
  const error = await walk(history({ activeRevision: NEW, generation: 75 }))
    .then(() => null, (thrown) => thrown);
  assert.ok(error instanceof CurrentMatrixRecoveryIntegrityFailure);
});
