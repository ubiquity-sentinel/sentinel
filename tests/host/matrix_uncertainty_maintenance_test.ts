import { SHA1 as ATTEMPT_RUNTIME } from "../state/helpers.ts";
/** Actual maintenance consumer and charged state transitions over disposable Git. */
import assert from "node:assert/strict";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import {
  entryWire,
  pullWire,
  response,
} from "../github/merge-queue-fixtures.ts";
import { pullFactsWire } from "../github/queue-delivery-reader-fixtures.ts";
import { darkQueueCoordinatorFixture } from "./hosted-autonomy-dark-queue-fixture.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_RUNTIME_ID,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../../src/contracts/hosted-supervisor.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { RepairStateWriter } from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
  DenoGitRunner,
} from "../../src/state/mod.ts";
import {
  hostedIssueKey,
  planHostedRetirements,
  planHostedRetries,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import { markBlocked } from "../../src/repair/transitions.ts";
import { QUEUE_PROOF_ACTIVATED } from "../../src/github/queue-runtime-policy.ts";
import {
  createMatrixUncertaintyMaintenance,
  MATRIX_UNCERTAINTY_DETAIL,
  runMatrixUncertaintyMaintenance,
} from "../../src/host/matrix-uncertainty-maintenance.ts";
import type { MatrixUncertaintyMaintenanceDepsV1 } from "../../src/host/matrix-uncertainty-maintenance.ts";
import {
  makeRemoteCtx,
  releaseRequest,
  reservation,
  SHA1,
  SHA2,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const NOW = T0 + 60_000;
const clock = { now: () => NOW };
const REPO = { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 };
const PRESERVATION_IDS = [
  "c0d668a23d4c5230f6349d8368d964ea566509bd2e23a9476279108bc74dbc8b",
  "536ffe5515e1bcee3105412af0f419566b76ae422095ac54039f7a6789e1f02b",
  "739b0d9b59604f1fa163f5f90bf9fb37fd33d93ae8eee8d606e0fa174016671d",
  "11acb1590ed849db9e3fa8c4fe071ed169142c74c122deb8b40bc4ad55d7c6b3",
  "971b6ea4516e09c84a94083705353228a5d2ef31d652ddc9346fd5cae34081d9",
];
async function fixture(submittedPreservation = false) {
  const root = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-uncertainty-",
  });
  await Deno.mkdir(root + "/home");
  const env = testGitEnv(root + "/home");
  const remote = await makeRemoteCtx(root, env);
  const runner = new DenoGitRunner(root + "/home", env);
  const repair = createRepairStateStore({
    scratchDir: root + "/repair",
    remoteUrl: remote.remoteUrl,
    runner,
  });
  const release = createReleaseStateStore({
    scratchDir: root + "/release",
    remoteUrl: remote.remoteUrl,
    runner,
  });
  const records = Array.from({ length: 13 }, (_, index) => {
    const id = ("issue-ubiquity-ai.ubq.fi-" + (index + 1)) as WorkItemId;
    const requestId = (index + 1).toString(16).padStart(64, "0");
    return workRecord(id, {
      repository: REPO,
      related: { incidentId: null, issueNumber: index + 1 },
      target: {
        base: SHA1,
        branch: candidateBranch(id),
        head: null,
        checkpoint: null,
        pr: null,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      intent: {
        kind: "implementation",
        key: implementationIntentKey(requestId),
        requestId,
        startedAt: T0 + 2000,
        branch: candidateBranch(id),
        expectedHead: null,
        observedBase: SHA1,
        resultId: null,
        pr: null,
      },
    });
  });
  const preservation = await Promise.all(Array.from(
    { length: 5 },
    async (_, index) => {
      const number = [884, 880, 730, 754, 879][index];
      const id = submittedPreservation
        ? ("issue-ubiquity-ai.ubq.fi-" + number) as WorkItemId
        : ("preservation-" + index) as WorkItemId;
      const requestId = submittedPreservation
        ? PRESERVATION_IDS[index]
        : (index + 14).toString(16).padStart(64, "0");
      return workRecord(id, {
        repository: REPO,
        related: { incidentId: null, issueNumber: number },
        target: {
          base: SHA1,
          branch: candidateBranch(id),
          head: SHA2,
          checkpoint: null,
          pr: submittedPreservation && number === 730 ? 893 : null,
          candidateState: {
            preserved: null,
            publishedHead: submittedPreservation && number === 730
              ? SHA1
              : null,
          },
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
        intent: {
          kind: "candidate_preservation",
          key: implementationIntentKey(requestId),
          requestId,
          startedAt: T0 + 3000,
          branch: await candidatePreservationRef(
            REPO,
            id,
            implementationIntentKey(requestId),
          ),
          expectedHead: SHA2,
          observedBase: SHA1,
          resultId: null,
          pr: null,
        },
      });
    },
  ));
  const charges = records.map((row) =>
    reservation(row.intent!.requestId!, {
      repository: REPO,
      taskId: row.id,
      attempt: 1,
      head: SHA1,
      createdAt: T0 + 1000,
    })
  );
  const submitted = submittedPreservation
    ? preservation.map((row) =>
      reservation(row.intent!.requestId!, {
        repository: REPO,
        taskId: row.id,
        attempt: 1,
        head: SHA1,
        outcome: "submitted",
        createdAt: T0 + 1000,
        settledAt: T0 + 3000,
      })
    )
    : [];
  const sibling = workRecord("unrelated");
  const seed = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 3000,
    incidents: [],
    evidence: [],
    work: [...records, ...preservation, sibling],
    reservations: [...charges, ...submitted],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  const saved = await repair.writeRepair(seed, null);
  assert.ok(saved.ok && saved.value.status === "applied");
  const request = releaseRequest("release:uncertainty", {
    target: {
      repository: {
        owner: "ubiquity-sentinel",
        name: "sentinel",
        installationId: 0,
      },
      environment: "production",
    },
    revision: SHA2,
    source: {
      pullRequest: 111,
      reviewRequestId: "review-111",
      reviewReceiptId: "review-111",
      head: SHA2,
      base: SHA1,
    },
  });
  const execution = {
    id: "71:1:repair",
    runId: 71,
    runAttempt: 1,
    launcherSha: SHA1,
    purpose: "prior",
    revision: SHA1,
    generation: 1,
    releaseId: request.id,
    createdAt: T0 + 4000,
  };
  const proof = {
    execution,
    workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
    workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
    repository: "ubiquity-sentinel/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 101,
    startedAt: T0 + 5000,
    finishedAt: T0 + 6000,
    observedAt: T0 + 7000,
    outcome: "failed",
    startupReady: false,
    settled: true,
    baseSha: null,
    terminalAt: T0 + 6000,
    logDigest: "c".repeat(64),
  };
  const releaseSeed = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 7000,
    releases: [],
    githubCooldowns: [],
    hostedRuntimes: [{
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: SHA1,
      generation: 1,
      lastHealthyProof: null,
      lastExecutionProof: proof,
      nextOrdinaryAt: T0,
      execution: null,
      createdAt: T0,
      updatedAt: T0 + 7000,
    }],
    hostedReleases: [{
      version: "v1",
      kind: "hosted_release",
      id: request.id,
      request,
      priorRevision: SHA1,
      phase: "requested",
      priorProof: null,
      candidateProof: null,
      rollbackProof: null,
      pointerIntent: null,
      createdAt: T0 + 4000,
      updatedAt: T0 + 4000,
    }],
  });
  const initialRelease = parseReleaseStateSnapshotV1({
    ...releaseSeed,
    updatedAt: T0 + 4000,
    hostedRuntimes: releaseSeed.hostedRuntimes.map((row) => ({
      ...row,
      lastExecutionProof: null,
      updatedAt: T0 + 4000,
    })),
  });
  const initialized = await release.writeRelease(initialRelease, null);
  assert.ok(
    initialized.ok && initialized.value.status === "applied",
    JSON.stringify(initialized),
  );
  const running = await release.writeRelease(
    parseReleaseStateSnapshotV1({
      ...initialRelease,
      sequence: 2,
      stateHead: initialized.value.head,
      hostedRuntimes: initialRelease.hostedRuntimes.map((row) => ({
        ...row,
        execution,
      })),
    }),
    initialized.value.head,
  );
  assert.ok(
    running.ok && running.value.status === "applied",
    JSON.stringify(running),
  );
  const savedRelease = await release.writeRelease(
    parseReleaseStateSnapshotV1({
      ...releaseSeed,
      sequence: 3,
      stateHead: running.value.head,
    }),
    running.value.head,
  );
  assert.ok(
    savedRelease.ok && savedRelease.value.status === "applied",
    JSON.stringify(savedRelease),
  );
  const state = {
    readRepair: () => repair.readRepair(),
    readRepairAt: (input: { commit: GitSha; expectedHead: GitSha }) =>
      repair.readRepairAt!(input),
    readRelease: () => release.readRelease(),
    writeRepair: repair.writeRepair.bind(repair),
  };
  const deps: MatrixUncertaintyMaintenanceDepsV1 = {
    state,
    clock,
    nativeQueueFor: () => inactiveNativeQueueFixture(),
    binding: {
      repairCommit: saved.value.head,
      runtimeSha: SHA1,
      generation: 1,
      reservationIds: charges.map((row) => row.id),
    },
    confirmCompletedExecution: () => Promise.resolve(true),
    readExecution: () =>
      Promise.resolve(portOk(releaseSeed.hostedRuntimes[0].lastExecutionProof)),
  };
  if (submittedPreservation) {
    const parked = await repair.writeRepair(
      parseRepairStateSnapshotV1({
        ...seed,
        sequence: seed.sequence + 1,
        stateHead: saved.value.head,
        updatedAt: NOW,
        work: seed.work.map((row) =>
          records.some((held) => held.id === row.id)
            ? markBlocked(row, "other", MATRIX_UNCERTAINTY_DETAIL, NOW)
            : row
        ),
        reservations: seed.reservations.map((row) =>
          charges.some((held) => held.id === row.id)
            ? { ...row, outcome: "ambiguous", settledAt: NOW }
            : row
        ),
      }),
      saved.value.head,
    );
    assert.ok(parked.ok && parked.value.status === "applied");
  }
  return {
    root,
    repair,
    release,
    state,
    deps,
    seed,
    releaseSeed,
    records,
    preservation,
    sibling,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

Deno.test("uncertainty maintenance retains thirteen charged admissions and requested release", async () => {
  const f = await fixture();
  try {
    const beforeRelease = await f.release.readRelease();
    const deps = {
      state: f.state,
      clock,
      githubFor: () => {
        throw Error("ordinary publication refused");
      },
      uncertainMatrix: () => runMatrixUncertaintyMaintenance(f.deps),
    };
    const result = await runDarkAutonomy(deps);
    const after = await f.repair.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.filter((row) =>
        row.blocker?.message === MATRIX_UNCERTAINTY_DETAIL
      ).length,
      13,
    );
    for (const row of f.records) {
      const current: WorkRecordV1 = after.value.snapshot.work.find((work) =>
        work.id === row.id
      )!;
      assert.equal(current.nextStep, "blocked");
      assert.deepEqual(current.intent, row.intent);
      assert.deepEqual(current.target, row.target);
      assert.deepEqual(current.counters, row.counters);
    }
    assert.ok(
      after.value.snapshot.reservations.every((row) =>
        row.outcome === "ambiguous" && row.settledAt !== null
      ),
    );
    assert.deepEqual(after.value.snapshot.work.slice(13), [
      ...f.preservation,
      f.sibling,
    ]);
    assert.deepEqual(await f.release.readRelease(), beforeRelease);
    assert.equal(result.reason, "release_not_terminal");
    const head = after.value.head;
    await runDarkAutonomy(deps);
    const replay = await f.repair.readRepair();
    assert.ok(replay.ok && replay.value.status === "found");
    assert.equal(replay.value.head, head);
    assert.equal(
      canonicalStringify(await f.release.readRelease()),
      canonicalStringify(beforeRelease),
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("uncertainty maintenance retains thirteen admissions with an advancing clock", async () => {
  const f = await fixture();
  try {
    let tick = NOW;
    const advancingClock = { now: () => ++tick };
    let failure: unknown;
    try {
      await runDarkAutonomy({
        state: f.state,
        clock: advancingClock,
        githubFor: () => {
          throw Error("ordinary publication refused");
        },
        uncertainMatrix: () =>
          runMatrixUncertaintyMaintenance({ ...f.deps, clock: advancingClock }),
      });
    } catch (error) {
      failure = error;
    }
    const after = await f.repair.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.filter((row) =>
        row.blocker?.message === MATRIX_UNCERTAINTY_DETAIL
      ).length,
      13,
      String(failure),
    );
    assert.ok(
      after.value.snapshot.reservations.every((row) =>
        row.outcome === "ambiguous" && row.settledAt !== null
      ),
    );
    for (const original of f.records) {
      const current: WorkRecordV1 = after.value.snapshot.work.find((row) =>
        row.id === original.id
      )!;
      assert.deepEqual(current.target, original.target);
      assert.deepEqual(current.intent, original.intent);
    }
    assert.deepEqual(after.value.snapshot.work.slice(13), [
      ...f.preservation,
      f.sibling,
    ]);
  } finally {
    await f.cleanup();
  }
});

Deno.test("uncertainty maintenance parks five submitted preservation admissions without losing PR893", async (t) => {
  const f = await fixture(true);
  try {
    const before = await f.repair.readRepair();
    const beforeRelease = await f.release.readRelease();
    assert.ok(before.ok && before.value.status === "found");
    const result = await runDarkAutonomy({
      state: f.state,
      clock,
      githubFor: () => {
        throw Error("ordinary publication refused");
      },
      uncertainMatrix: () => runMatrixUncertaintyMaintenance(f.deps),
    });
    const after = await f.repair.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.filter((row) =>
        PRESERVATION_IDS.includes(row.intent?.requestId ?? "") &&
        row.nextStep === "blocked"
      ).length,
      5,
    );
    for (const original of f.preservation) {
      const current: WorkRecordV1 = after.value.snapshot.work.find((row) =>
        row.id === original.id
      )!;
      assert.equal(current.nextStep, "blocked");
      assert.deepEqual(current.target, original.target);
      assert.deepEqual(current.intent, original.intent);
      assert.deepEqual(current.evidence, original.evidence);
      assert.deepEqual(current.counters, original.counters);
    }
    const published = after.value.snapshot.work.find((row) =>
      row.related.issueNumber === 730
    )!;
    assert.equal(published.target.pr, 893);
    assert.equal(published.target.candidateState?.publishedHead, SHA1);
    assert.deepEqual(
      after.value.snapshot.reservations,
      before.value.snapshot.reservations,
    );
    assert.deepEqual(
      after.value.snapshot.work.filter((row) =>
        f.records.some((held) => held.id === row.id)
      ),
      before.value.snapshot.work.filter((row) =>
        f.records.some((held) => held.id === row.id)
      ),
    );
    assert.deepEqual(
      after.value.snapshot.work.find((row) => row.id === f.sibling.id),
      f.sibling,
    );
    assert.deepEqual(await f.release.readRelease(), beforeRelease);
    assert.equal(result.reason, "release_not_terminal");
    assert.deepEqual(
      planHostedRetries(after.value.snapshot, NOW, ATTEMPT_RUNTIME),
      [],
    );
    assert.deepEqual(
      planHostedRetirements(
        after.value.snapshot,
        new Set([hostedIssueKey(published.repository, 730)]),
        new Set([published.id]),
      ),
      [],
    );
    await runMatrixUncertaintyMaintenance(f.deps);
    assert.deepEqual(await f.repair.readRepair(), after);
    await t.step(
      "all eighteen parked admissions leave successor runtime untouched without native custody",
      async () => {
        assert.ok(beforeRelease.ok && beforeRelease.value.status === "found");
        const successor = {
          ...beforeRelease.value,
          snapshot: parseReleaseStateSnapshotV1({
            ...beforeRelease.value.snapshot,
            hostedRuntimes: beforeRelease.value.snapshot.hostedRuntimes.map((
              row,
            ) => ({
              ...row,
              activeRevision: SHA2,
              generation: 2,
            })),
          }),
        };
        let confirmations = 0;
        const state = {
          ...f.state,
          readRelease: () => Promise.resolve(portOk(successor)),
        };
        const result = await runDarkAutonomy({
          state,
          clock,
          githubFor: () => {
            throw Error("ordinary publication refused");
          },
          uncertainMatrix: () =>
            runMatrixUncertaintyMaintenance({
              ...f.deps,
              state,
              confirmCompletedExecution: () => {
                confirmations++;
                throw Error("parked work needs no native custody");
              },
            }),
        });
        assert.equal(result.reason, "release_not_terminal");
        assert.equal(confirmations, 0);
        assert.deepEqual(await f.repair.readRepair(), after);
        assert.deepEqual(await f.release.readRelease(), beforeRelease);
      },
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("uncertainty maintenance refuses active foreign candidate and custody conflicts", async () => {
  const f = await fixture();
  try {
    const before = await f.repair.readRepair();
    const release = await f.release.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    const releaseValue = release.value;
    const variants: MatrixUncertaintyMaintenanceDepsV1[] = [
      { ...f.deps, confirmCompletedExecution: () => Promise.resolve(false) },
      { ...f.deps, readExecution: () => Promise.resolve(portOk(null)) },
      {
        ...f.deps,
        state: {
          ...f.state,
          readRepair: async () => {
            const current = await f.state.readRepair();
            assert.ok(current.ok && current.value.status === "found");
            return portOk({
              ...current.value,
              snapshot: parseRepairStateSnapshotV1({
                ...current.value.snapshot,
                work: current.value.snapshot.work.map((row, index) =>
                  index === 0
                    ? {
                      ...row,
                      repository: { ...row.repository, name: "foreign" },
                    }
                    : row
                ),
              }),
            });
          },
        },
      },
      {
        ...f.deps,
        state: {
          ...f.state,
          readRepair: async () => {
            const current = await f.state.readRepair();
            assert.ok(current.ok && current.value.status === "found");
            return portOk({
              ...current.value,
              snapshot: parseRepairStateSnapshotV1({
                ...current.value.snapshot,
                work: current.value.snapshot.work.map((row, index) =>
                  index === 0
                    ? { ...row, target: { ...row.target, head: SHA2 } }
                    : row
                ),
              }),
            });
          },
        },
      },
      {
        ...f.deps,
        state: {
          ...f.state,
          writeRepair: () =>
            Promise.resolve(portError("conflict", "injected CAS conflict")),
        },
      },
    ];
    for (const deps of variants) {
      await assert.rejects(
        () => runMatrixUncertaintyMaintenance(deps),
        /custody/,
      );
      assert.deepEqual(await f.repair.readRepair(), before);
      assert.deepEqual(await f.release.readRelease(), release);
    }
    let reads = 0;
    const drift = {
      ...f.deps,
      state: {
        ...f.state,
        readRelease: () => {
          reads++;
          // The maintenance now reads release once up front for the
          // execution-yield check; drift the third read onward.
          return Promise.resolve(
            reads <= 2 ? release : portOk({ ...releaseValue, head: SHA2 }),
          );
        },
      },
    };
    await assert.rejects(
      () => runMatrixUncertaintyMaintenance(drift),
      /custody/,
    );
    assert.deepEqual(await f.repair.readRepair(), before);
  } finally {
    await f.cleanup();
  }
});

Deno.test("uncertainty maintenance yields gracefully when an execution is recorded", async () => {
  const f = await fixture();
  try {
    const before = await f.repair.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    const release = await f.release.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    const releaseValue = release.value;
    const deps: MatrixUncertaintyMaintenanceDepsV1 = {
      ...f.deps,
      state: {
        ...f.state,
        readRelease: () =>
          Promise.resolve(
            portOk({
              ...releaseValue,
              snapshot: parseReleaseStateSnapshotV1({
                ...releaseValue.snapshot,
                hostedRuntimes: releaseValue.snapshot.hostedRuntimes.map(
                  (runtime) => ({
                    ...runtime,
                    execution: {
                      ...runtime.lastExecutionProof!.execution,
                      id: "72:1:repair",
                      runId: 72,
                      createdAt: NOW,
                    },
                  }),
                ),
              }),
            }),
          ),
      },
    };
    // A recorded execution (active or stale) must not fail the maintenance run.
    // The historical quarantine yields; the main hosted flow owns settlement.
    const result = await runMatrixUncertaintyMaintenance(deps);
    assert.deepEqual(result, {
      beforeHead: before.value.head,
      appliedHead: before.value.head,
      quarantined: 0,
    });
    assert.deepEqual(await f.repair.readRepair(), before);
    assert.deepEqual(await f.release.readRelease(), release);
  } finally {
    await f.cleanup();
  }
});

Deno.test("uncertainty maintenance authenticates native completion with fake HTTP", async () => {
  const f = await fixture();
  const previous = Deno.cwd();
  try {
    await Deno.mkdir(f.root + "/runner");
    Deno.chdir(f.root + "/runner");
    const proof = f.releaseSeed.hostedRuntimes[0].lastExecutionProof!;
    assert.ok(proof.outcome !== "not_started");
    const iso = (at: number) => new Date(at).toISOString();
    const terminal = {
      version: "v1",
      kind: "hosted_runtime_terminal",
      execution: proof.execution,
      controllerSha: SHA1,
      startedAt: proof.startedAt,
      finishedAt: proof.finishedAt,
      outcome: "failed",
      startupReady: false,
      settled: true,
      baseSha: null,
    };
    const log = iso(proof.finishedAt) + " " + JSON.stringify(terminal) + "\n";
    let calls = 0;
    let active = false;
    const native = createMatrixUncertaintyMaintenance({
      state: f.state,
      clock,
      token: "test-only",
      artifactRoot: f.root + "/artifacts",
      http: (request) => {
        calls++;
        assert.equal(request.method, "GET");
        let body: unknown;
        if (request.url.includes("/jobs/101/logs")) {
          return Promise.resolve({
            status: 302,
            headers: new Headers({
              location:
                "https://productionresultssa1.blob.core.windows.net/log",
            }),
            bodyText: "",
          });
        }
        if (request.url.includes("blob.core.windows.net")) {
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: log,
          });
        }
        if (request.url.includes("/jobs")) {
          body = {
            total_count: 1,
            jobs: [{
              id: 101,
              name: "repair",
              run_id: 71,
              run_attempt: 1,
              head_sha: SHA1,
              status: active ? "in_progress" : "completed",
              conclusion: active ? null : "failure",
              started_at: iso(proof.startedAt),
              completed_at: iso(proof.finishedAt),
              runner_id: 1,
              runner_name: "fixture",
              steps: [{
                name: "Run selected Sentinel runtime",
                number: 1,
                status: "completed",
                conclusion: "failure",
                started_at: iso(proof.startedAt),
                completed_at: iso(proof.finishedAt),
              }],
            }],
          };
        } else {body = {
            id: 71,
            run_attempt: 1,
            workflow_id: HOSTED_SUPERVISOR_WORKFLOW_ID,
            path: HOSTED_SUPERVISOR_WORKFLOW_PATH,
            event: "workflow_dispatch",
            head_branch: "sentinel-supervisor",
            head_sha: SHA1,
            status: "completed",
            conclusion: "failure",
            created_at: iso(proof.execution.createdAt),
            run_started_at: iso(proof.startedAt),
            updated_at: iso(proof.finishedAt),
            repository: { id: 9, full_name: "ubiquity-sentinel/sentinel" },
            head_repository: { id: 9, full_name: "ubiquity-sentinel/sentinel" },
          };}
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: JSON.stringify(body),
        });
      },
    });
    assert.equal(await native.confirmCompletedExecution(proof.execution), true);
    const settled = await native.readExecution(proof.execution);
    assert.ok(
      settled.ok && settled.value?.outcome === "failed",
      JSON.stringify(settled),
    );
    assert.deepEqual(settled.value.execution, proof.execution);
    active = true;
    await assert.rejects(
      () => native.confirmCompletedExecution(proof.execution),
      /provenance/,
    );
    assert.ok(calls >= 4);
  } finally {
    Deno.chdir(previous);
    await f.cleanup();
  }
});

Deno.test("uncertainty maintenance resumes an ambiguous settlement before its block", async () => {
  const f = await fixture();
  try {
    let writes = 0;
    const stopAfterCharge: RepairStateWriter["writeRepair"] = (next, head) => {
      writes++;
      return writes === 2
        ? Promise.resolve(portError("conflict", "injected block CAS failure"))
        : f.state.writeRepair(next, head);
    };
    await assert.rejects(
      () =>
        runMatrixUncertaintyMaintenance({
          ...f.deps,
          state: { ...f.state, writeRepair: stopAfterCharge },
        }),
      /custody/,
    );
    const partial = await f.repair.readRepair();
    assert.ok(partial.ok && partial.value.status === "found");
    assert.equal(partial.value.snapshot.reservations[0].outcome, "ambiguous");
    const settledAt = partial.value.snapshot.reservations[0].settledAt;
    assert.ok(settledAt !== null);
    assert.equal(partial.value.snapshot.work[0].nextStep, "work");
    const outcome = await runMatrixUncertaintyMaintenance(f.deps);
    assert.equal(outcome.quarantined, 13);
    const completed = await f.repair.readRepair();
    assert.ok(completed.ok && completed.value.status === "found");
    assert.equal(completed.value.snapshot.reservations[0].settledAt, settledAt);
    assert.deepEqual(completed.value.snapshot.work.slice(13), [
      ...f.preservation,
      f.sibling,
    ]);
  } finally {
    await f.cleanup();
  }
});

/** Explicit authenticated no-rule fixture; unexpected native custody still refuses. */
async function runDarkAutonomy(deps: HostedAutonomyDepsV1) {
  return await runHostedAutonomy({
    ...deps,
    queue: await darkQueueCoordinatorFixture(deps),
  });
}

Deno.test("uncertainty maintenance defers missing, unknown, queued and drifting native custody without writes", async (t) => {
  for (
    const mode of [
      "missing",
      "unavailable",
      "queued",
      "state_drift",
      "observation_lost",
      "no_rule",
    ] as const
  ) {
    await t.step(mode, async () => {
      const f = await fixture();
      try {
        const before = await f.state.readRepair();
        const release = await f.state.readRelease();
        let ruleReads = 0;
        let queueReads = 0;
        let branch = "";
        const native = createMatrixUncertaintyMaintenance({
          state: f.state,
          clock,
          token: "fixture-state-token",
          apiToken: "fixture-target-token",
          artifactRoot: f.root + "/queue-artifacts",
          http: (request) => {
            assert.equal(
              request.headers.get("authorization"),
              "Bearer fixture-target-token",
            );
            const url = new URL(request.url);
            if (url.pathname.endsWith("/rules/branches/development")) {
              assert.equal(request.method, "GET");
              ruleReads++;
              if (
                mode === "unavailable" ||
                (mode === "observation_lost" && ruleReads > 1)
              ) {
                return Promise.resolve(response({}, 503));
              }
              return Promise.resolve(
                response(mode === "queued" ? [{ type: "merge_queue" }] : []),
              );
            }
            if (url.pathname.endsWith("/pulls")) {
              assert.equal(request.method, "GET");
              branch = url.searchParams.get("head")!.slice("ubiquity:".length);
              return Promise.resolve(response([{
                number: 7,
                title: "existing candidate",
                body: "",
                state: "open",
                head: { ref: branch, sha: SHA2 },
                base: { ref: "development", sha: SHA1 },
                user: { login: "ubiquity-sentinel[bot]" },
                created_at: new Date(T0).toISOString(),
                updated_at: new Date(T0).toISOString(),
                merged_at: null,
                merge_commit_sha: null,
                review_decision: null,
              }]));
            }
            assert.equal(url.pathname, "/graphql");
            assert.equal(request.method, "POST");
            assert.ok(!request.body?.includes("mutation"));
            const query = JSON.parse(request.body ?? "{}");
            assert.match(query.query, /^query\(/);
            assert.deepEqual(query.variables, {
              owner: REPO.owner,
              name: REPO.name,
              number: 7,
            });
            queueReads++;
            return Promise.resolve(response(pullFactsWire({
              baseRefOid: SHA1,
              headRefName: branch,
              headRefOid: SHA2,
              merged: false,
              mergedBy: null,
              mergeCommit: null,
              isInMergeQueue: mode === "queued",
              mergeQueueEntry: mode === "queued"
                ? entryWire({
                  baseCommit: { oid: SHA1 },
                  pullRequest: pullWire({
                    headRefName: branch,
                    headRefOid: SHA2,
                  }),
                })
                : null,
            })));
          },
        });
        const outcome = await runMatrixUncertaintyMaintenance({
          ...f.deps,
          nativeQueueFor: mode === "missing"
            ? undefined
            : (repository, state) => {
              let reads = 0;
              return native.nativeQueueFor!(
                repository,
                mode !== "state_drift" ? state : {
                  ...state,
                  readRepair: async () => {
                    const read = await state.readRepair();
                    return ++reads > 1 && read.ok &&
                        read.value.status === "found"
                      ? portOk({ ...read.value, head: SHA2 })
                      : read;
                  },
                },
              );
            },
        });
        assert.equal(outcome.quarantined, mode === "no_rule" ? 13 : 0);
        const after = await f.state.readRepair();
        if (mode === "no_rule") {
          assert(after.ok && after.value.status === "found");
          for (const original of f.records) {
            const row: WorkRecordV1 = after.value.snapshot.work.find((entry) =>
              entry.id === original.id
            )!;
            assert.equal(row.nextStep, "blocked");
            assert.deepEqual(row.intent, original.intent);
            const charge: BudgetReservationV1 = after.value.snapshot
              .reservations.find((entry) =>
                entry.id === original.intent!.requestId
              )!;
            assert.equal(charge.outcome, "ambiguous");
            assert.equal(charge.proofRef, null);
          }
        } else {
          assert.deepEqual(after, before, "no charge, intent or wait changes");
        }
        assert.deepEqual(await f.state.readRelease(), release);
        // With the shipped queue proof dormant (owner directive 2026-10-24,
        // #180), admission off and an authenticated negative rule read, the
        // guard allows through a fresh state read and never reads pulls or
        // GraphQL. A live merge_queue rule still forces the strict path.
        assert.equal(
          queueReads,
          (QUEUE_PROOF_ACTIVATED
            ? {
              missing: 0,
              unavailable: 0,
              queued: 13,
              state_drift: 13,
              observation_lost: 1,
              no_rule: 39,
            }
            : {
              missing: 0,
              unavailable: 0,
              queued: 13,
              state_drift: 0,
              observation_lost: 0,
              no_rule: 0,
            })[mode],
        );
        assert.equal(ruleReads > 0, mode !== "missing");
      } finally {
        await f.cleanup();
      }
    });
  }
});

Deno.test("uncertainty maintenance retains a charged partial settlement when native custody becomes unavailable", async () => {
  const f = await fixture();
  try {
    const before = await f.state.readRepair();
    assert(before.ok && before.value.status === "found");
    const chargeId = f.records[0].intent!.requestId;
    let charged = false;
    let outageReads = 0;
    const state: typeof f.state = {
      ...f.state,
      async writeRepair(next, expectedHead) {
        const written = await f.state.writeRepair(next, expectedHead);
        const charge = next.reservations.find((row) => row.id === chargeId);
        if (
          written.ok && written.value.status === "applied" &&
          charge?.outcome === "ambiguous" && charge.settledAt !== null
        ) {
          assert.equal(charged, false, "the charge transition is applied once");
          charged = true;
        }
        return written;
      },
    };
    const native = createMatrixUncertaintyMaintenance({
      state,
      clock,
      token: "fixture-state-token",
      apiToken: "fixture-target-token",
      artifactRoot: f.root + "/queue-artifacts",
      http: (request) => {
        assert.equal(request.method, "GET");
        const path = new URL(request.url).pathname;
        if (path === "/repos/ubiquity/ai.ubq.fi/rules/branches/development") {
          // The outage follows the successful charge CAS, independently of how
          // many authenticated observations preflight and entry require.
          if (charged) {
            outageReads++;
            return Promise.resolve(response({}, 503));
          }
          return Promise.resolve(response([]));
        }
        // These unpublished branches have no PR. Complete empty discovery
        // proves native absence before charging the ambiguous admission.
        assert.equal(path, "/repos/ubiquity/ai.ubq.fi/pulls");
        assert.ok(new URL(request.url).searchParams.get("head"));
        return Promise.resolve(response([]));
      },
    });
    const held = await runMatrixUncertaintyMaintenance({
      ...f.deps,
      state,
      nativeQueueFor: native.nativeQueueFor,
    });
    assert.equal(held.quarantined, 0);
    assert.equal(charged, true);
    assert.ok(outageReads > 0, "native custody is lost after the charge CAS");
    const after = await f.state.readRepair();
    assert(after.ok && after.value.status === "found");
    assert.notEqual(after.value.head, before.value.head);
    assert.equal(held.appliedHead, after.value.head);
    assert.deepEqual(after.value.snapshot.work, before.value.snapshot.work);
    assert.deepEqual(
      after.value.snapshot.reservations,
      before.value.snapshot.reservations.map((charge) =>
        charge.id === chargeId
          ? { ...charge, outcome: "ambiguous", settledAt: NOW }
          : charge
      ),
    );
    assert.deepEqual(
      after.value.snapshot.attemptMemory,
      before.value.snapshot.attemptMemory,
    );
    const resumed = await runMatrixUncertaintyMaintenance(f.deps);
    assert.equal(resumed.quarantined, 13);
    const complete = await f.state.readRepair();
    assert(complete.ok && complete.value.status === "found");
    assert.deepEqual(
      complete.value.snapshot.reservations.find((charge) =>
        charge.id === chargeId
      ),
      after.value.snapshot.reservations.find((charge) =>
        charge.id === chargeId
      ),
      "the original ambiguous charge is never refunded or charged again",
    );
  } finally {
    await f.cleanup();
  }
});
