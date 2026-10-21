import assert from "node:assert/strict";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { deriveReservationId } from "../../src/budget/mod.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  createHostedAutonomyGitHub,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import { reservation, SHA1, T0 } from "../state/helpers.ts";
import { MISMATCH_DISPOSITION_RETRYABLE_BLOCKER } from "../../ops/runtime-mismatch-recovery-disposition.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  FOREIGN_REPO,
  HEAD,
  jsonResponse,
  SELF_REPO,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";

const REF_IDENTITY_BLOCKER = "candidate branch ref identity mismatch";

Deno.test("hosted autonomy: ref revalidation, mismatch disposition and retry preserve phase order", async () => {
  const revalidated = await refIdentityBlockerRecord();
  const mismatchId = "issue-ubiquity-sentinel-49" as WorkItemId;
  const mismatchBranch = candidateBranch(mismatchId);
  const reservationId = await deriveReservationId({
    repository: SELF_REPO,
    taskId: mismatchId,
    head: BASE,
    attempt: 1,
    purpose: "retry",
  });
  const mismatch = blockedRecord({
    id: mismatchId,
    source: { kind: "issue", id: "49", revision: SHA1 },
    related: { incidentId: null, issueNumber: 49 },
    target: {
      base: BASE,
      branch: mismatchBranch,
      checkpoint: null,
      head: null,
      pr: null,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    evidence: [],
    blocker: {
      kind: "other",
      message:
        "authenticated historical matrix runtime mismatch; producer=900:1; original admission retained",
      since: T0 + 3000,
    },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(reservationId),
      startedAt: T0 + 1000,
      branch: mismatchBranch,
      expectedHead: null,
      observedBase: BASE,
      pr: null,
      requestId: reservationId,
      resultId: null,
    },
  });
  const ordinary = blockedRecord({
    id: "issue-ubiquity-sentinel-50",
    source: { kind: "issue", id: "50", revision: SHA1 },
    related: { incidentId: null, issueNumber: 50 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-50",
      checkpoint: null,
      head: null,
      pr: null,
    },
    evidence: [],
  });
  const charge = reservation(reservationId, {
    repository: SELF_REPO,
    taskId: mismatchId,
    head: BASE,
    purpose: "retry",
  });
  const { rig, github } = await makeRig("mismatch-phase-order", {
    repair: repairSnapshot([revalidated, mismatch, ordinary], [], [], [charge]),
    branchTip: (branch) => branch === candidateBranch(TARGET) ? HEAD : BASE,
  });
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://api.github.com");
    requests.push(url.pathname);
    if (
      url.pathname ===
        `/repos/ubiquity-sentinel/sentinel/git/ref/heads/${mismatchBranch}`
    ) {
      return Promise.resolve(new Response("null", { status: 404 }));
    }
    if (url.pathname === "/repos/ubiquity-sentinel/sentinel/pulls") {
      assert.equal(url.searchParams.get("head"), `ubiquity:${mismatchBranch}`);
      return Promise.resolve(jsonResponse([]));
    }
    if (url.pathname === "/repos/ubiquity-sentinel/sentinel/actions/runs/900") {
      return Promise.resolve(jsonResponse({ status: "completed" }));
    }
    return Promise.reject(new Error("offline unexpected mismatch API path"));
  };
  github.mismatchDisposition = createHostedAutonomyGitHub(
    "offline-native-token",
    SELF_REPO,
  ).mismatchDisposition;
  const read = async () => {
    const result = await rig.state.readRepair();
    assert(result.ok && result.value.status === "found");
    return result.value;
  };
  try {
    const first = await run(rig, github);
    assert.equal(first.reason, "applied", JSON.stringify(first));
    assert.deepEqual(first.actions, [
      "queue:inactive_no_rule",
      `revalidate:${TARGET}:cleared`,
    ]);
    assert.deepEqual(
      requests,
      [],
      "revalidation must return before mismatch reads",
    );
    assert.equal(rig.writes, 1);
    const afterRevalidation = await read();
    assert.deepEqual(afterRevalidation.snapshot.work[1], mismatch);
    assert.deepEqual(afterRevalidation.snapshot.work[2], ordinary);
    assert.deepEqual(afterRevalidation.snapshot.reservations, [charge]);

    const second = await run(rig, github);
    assert.deepEqual(requests, [
      `/repos/ubiquity-sentinel/sentinel/git/ref/heads/${mismatchBranch}`,
      "/repos/ubiquity-sentinel/sentinel/pulls",
      "/repos/ubiquity-sentinel/sentinel/actions/runs/900",
    ]);
    assert.equal(second.reason, "dispositioned", JSON.stringify(second));
    assert.equal(second.beforeHead, afterRevalidation.head);
    assert.equal(rig.writes, 2);
    const afterDisposition = await read();
    assert.equal(second.appliedHead, afterDisposition.head);
    assert.equal(
      afterDisposition.snapshot.reservations[0].outcome,
      "ambiguous",
    );
    assert.equal(
      afterDisposition.snapshot.work[1].blocker?.message,
      MISMATCH_DISPOSITION_RETRYABLE_BLOCKER,
    );
    assert.deepEqual(afterDisposition.snapshot.work[1].intent, mismatch.intent);
    assert.deepEqual(
      afterDisposition.snapshot.work[2],
      ordinary,
      "disposition must return before retry effects",
    );

    const third = await run(rig, github);
    assert.equal(third.reason, "retried", JSON.stringify(third));
    assert.equal(rig.writes, 3);
    const afterRetry = await read();
    assert.equal(afterRetry.snapshot.work[2].nextStep, "work");
    assert.deepEqual(
      afterRetry.snapshot.reservations,
      afterDisposition.snapshot.reservations,
    );
    assert.equal(
      requests.length,
      3,
      "ordinary retry must not repeat mismatch observations",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

/** The saved candidate descriptor one eligible blocked record must carry. */
async function refIdentityCandidateState(
  overrides: {
    repository?: RepositoryIdentityV1;
    operationKey?: string;
    preservedHead?: GitSha;
    preservedBase?: GitSha;
    preservedRef?: string;
    publishedHead?: GitSha | null;
    preservedNull?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const operationKey = overrides.operationKey ??
    implementationIntentKey("a".repeat(64));
  const repository = overrides.repository ?? SELF_REPO;
  const preserved = overrides.preservedNull === true ? null : {
    operationKey,
    base: overrides.preservedBase ?? BASE,
    head: overrides.preservedHead ?? HEAD,
    ref: overrides.preservedRef ??
      await candidatePreservationRef(repository, TARGET, operationKey),
  };
  return {
    preserved,
    publishedHead: overrides.publishedHead === undefined
      ? HEAD
      : overrides.publishedHead,
  };
}

/** The managed-candidate target one revalidation-eligible record needs. */
function refIdentityTarget(
  candidateState: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const target: Record<string, unknown> = {
    base: BASE,
    branch: candidateBranch(TARGET),
    checkpoint: null,
    head: HEAD,
    pr: null,
    ...overrides,
  };
  if (candidateState !== undefined) target["candidateState"] = candidateState;
  return target;
}

/** One blocked record carrying the exact candidate ref-identity diagnosis. */
async function refIdentityBlockerRecord(
  overrides: Record<string, unknown> = {},
): Promise<WorkRecordV1> {
  return blockedRecord({
    blocker: {
      kind: "other",
      message: REF_IDENTITY_BLOCKER,
      since: T0 + 3000,
    },
    target: refIdentityTarget(await refIdentityCandidateState()),
    counters: { attempts: 3, retries: 1, reviewRounds: 2 },
    ...overrides,
  });
}

Deno.test(
  "hosted autonomy: the ref identity blocker revalidates the exact restored original head",
  async () => {
    const record = await refIdentityBlockerRecord();
    const restored = candidateBranch(TARGET);
    const reads: string[] = [];
    const { rig, github } = await makeRig("ref-identity-restored", {
      repair: repairSnapshot([record], [authorizingReceipt()]),
      branchTip: (branch) => {
        reads.push(branch);
        return branch === restored ? HEAD : BASE;
      },
    });
    try {
      const before = await rig.state.readRepair();
      assert.ok(before.ok && before.value.status === "found");
      if (!before.ok || before.value.status !== "found") {
        throw new Error("repair fixture unreadable");
      }
      const result = await run(rig, github);
      assert.equal(result.status, "applied", JSON.stringify(result));
      assert.equal(result.reason, "applied");
      assert.ok(result.actions.includes(`revalidate:${TARGET}:cleared`));
      // The maintenance pass reads ONLY the record's managed candidate branch
      // and returns immediately: no base, delivery or review read follows.
      assert.deepEqual(reads, [restored]);
      assert.equal(rig.writes, 1);
      const read = await rig.state.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("repair state unreadable");
      }
      const applied = read.value.snapshot.work[0];
      assert.equal(applied.nextStep, "work");
      assert.equal(applied.blocker, null);
      // The NULL intent stays NULL and the saved target, counters, receipt and
      // review authority are preserved byte for byte.
      assert.equal(applied.intent, null);
      assert.deepEqual(applied.target, record.target);
      assert.deepEqual(applied.counters, record.counters);
      assert.deepEqual(applied.evidence, record.evidence);
      assert.equal(applied.updatedAt, T0 + 5_000_000);
      assert.equal(
        read.value.snapshot.sequence,
        before.value.snapshot.sequence + 1,
      );
      assert.deepEqual(
        read.value.snapshot.reviews,
        before.value.snapshot.reviews,
      );
      assert.deepEqual(
        read.value.snapshot.reservations,
        before.value.snapshot.reservations,
      );
      // The same state run again is idempotent: the record is already back at
      // `work`, so no second write and no identity drift.
      const again = await run(rig, github);
      assert.equal(again.status, "skipped", JSON.stringify(again));
      assert.equal(rig.writes, 1);
      const reread = await rig.state.readRepair();
      assert.ok(reread.ok && reread.value.status === "found");
      if (!reread.ok || reread.value.status !== "found") {
        throw new Error("repair state unreadable");
      }
      assert.deepEqual(reread.value.snapshot.work[0], applied);
      assert.equal(reread.value.head, read.value.head);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

Deno.test(
  "hosted autonomy: the ref identity blocker revalidation preserves a non-null intent",
  async () => {
    const record = await refIdentityBlockerRecord({
      intent: {
        kind: "implementation",
        key: "implementation:revalidate-1",
        startedAt: T0 + 1000,
        branch: candidateBranch(TARGET),
        expectedHead: null,
        observedBase: BASE,
        pr: null,
        requestId: "revalidate-1",
        resultId: null,
      },
    });
    const { rig, github } = await makeRig("ref-identity-intent", {
      repair: repairSnapshot([record], [authorizingReceipt()]),
      branchTip: (branch) => branch === candidateBranch(TARGET) ? HEAD : BASE,
    });
    try {
      const result = await run(rig, github);
      assert.equal(result.status, "applied", JSON.stringify(result));
      const read = await rig.state.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("repair state unreadable");
      }
      const applied = read.value.snapshot.work[0];
      assert.equal(applied.nextStep, "work");
      assert.equal(applied.blocker, null);
      assert.deepEqual(applied.intent, record.intent);
      assert.deepEqual(applied.counters, record.counters);
      assert.deepEqual(applied.target, record.target);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

Deno.test(
  "hosted autonomy: the ref identity blocker revalidation refuses every other identity",
  async (t) => {
    const savedState = await refIdentityCandidateState();
    const recordWith = (
      target: unknown,
      extra: Record<string, unknown> = {},
    ) =>
      blockedRecord({
        blocker: {
          kind: "other",
          message: REF_IDENTITY_BLOCKER,
          since: T0 + 3000,
        },
        target,
        counters: { attempts: 3, retries: 1, reviewRounds: 2 },
        ...extra,
      });
    const cases: {
      name: string;
      record: WorkRecordV1;
      tip?: (branch: string) => string | null;
      reads: boolean;
    }[] = [
      {
        name: "a branch that is not the task's managed candidate branch",
        record: recordWith(refIdentityTarget(savedState, {
          branch: "sentinel/repair/issue-ubiquity-sentinel-49",
        })),
        reads: false,
      },
      {
        name: "a legacy record without saved candidate state",
        record: recordWith(refIdentityTarget(undefined)),
        reads: false,
      },
      {
        name: "a record without a preserved descriptor",
        record: recordWith(refIdentityTarget(
          await refIdentityCandidateState({ preservedNull: true }),
        )),
        reads: false,
      },
      {
        name: "a published head that is not the saved head",
        record: recordWith(refIdentityTarget(
          await refIdentityCandidateState({ publishedHead: SHA1 }),
        )),
        reads: false,
      },
      {
        name: "a preservation ref that binds another repository",
        record: recordWith(refIdentityTarget(
          await refIdentityCandidateState({ repository: FOREIGN_REPO }),
        )),
        reads: false,
      },
      {
        name: "a preservation ref that binds another operation",
        record: recordWith(refIdentityTarget(
          await refIdentityCandidateState({
            preservedRef: await candidatePreservationRef(
              SELF_REPO,
              TARGET,
              implementationIntentKey("b".repeat(64)),
            ),
          }),
        )),
        reads: false,
      },
      {
        name: "another blocker",
        record: blockedRecord({
          blocker: {
            kind: "other",
            message: "published candidate ref is missing",
            since: T0 + 3000,
          },
          target: refIdentityTarget(savedState),
          counters: { attempts: 3, retries: 1, reviewRounds: 2 },
        }),
        reads: false,
      },
      {
        name: "an incompatible wait",
        record: recordWith(refIdentityTarget(savedState), {
          wait: {
            reason: "review_pending",
            since: T0 + 3000,
            until: T0 + 9000,
          },
        }),
        reads: false,
      },
      {
        name: "a live ref at another head",
        record: recordWith(refIdentityTarget(savedState)),
        tip: () => SHA1,
        reads: true,
      },
      {
        name: "an unavailable ref read",
        record: recordWith(refIdentityTarget(savedState)),
        tip: () => null,
        reads: true,
      },
      {
        name: "a throwing ref read",
        record: recordWith(refIdentityTarget(savedState)),
        tip: () => {
          throw new Error("ref read unavailable");
        },
        reads: true,
      },
    ];
    // The frozen schema itself refuses a descriptor whose head/base disagree
    // with the target, so those raw shapes can never be persisted: prove the
    // rejection at the parser boundary instead of a consumer run.
    const movedDescriptorHead = await refIdentityCandidateState({
      preservedHead: SHA1,
    });
    const movedDescriptorBase = await refIdentityCandidateState({
      preservedBase: SHA1,
    });
    const descriptorRejection =
      /preserved candidate base\/head must equal target base\/head/;
    assert.throws(
      () => recordWith(refIdentityTarget(movedDescriptorHead)),
      descriptorRejection,
    );
    assert.throws(
      () => recordWith(refIdentityTarget(movedDescriptorBase)),
      descriptorRejection,
    );
    for (const testCase of cases) {
      await t.step(testCase.name, async () => {
        const reads: string[] = [];
        const { rig, github } = await makeRig("ref-identity-refused", {
          repair: repairSnapshot([testCase.record], [authorizingReceipt()]),
          branchTip: (branch) => {
            reads.push(branch);
            const tip = testCase.tip;
            return tip === undefined ? BASE : tip(branch);
          },
        });
        try {
          const result = await run(rig, github);
          assert.equal(result.status, "skipped", JSON.stringify(result));
          assert.equal(rig.writes, 0, "an unproven identity never writes");
          assert.equal(
            reads.includes(candidateBranch(TARGET)),
            testCase.reads,
            "the candidate branch is read only for a fully bound record",
          );
          const read = await rig.state.readRepair();
          assert.ok(read.ok && read.value.status === "found");
          if (!read.ok || read.value.status !== "found") {
            throw new Error("repair state unreadable");
          }
          const parked = read.value.snapshot.work[0];
          assert.deepEqual(parked, testCase.record);
          assert.equal(parked.nextStep, "blocked");
          assert.notEqual(parked.blocker, null);
        } finally {
          await Deno.remove(rig.tmp, { recursive: true });
        }
      });
    }
  },
);

Deno.test(
  "hosted autonomy: the ref identity blocker revalidation refuses a stale CAS",
  async () => {
    const record = await refIdentityBlockerRecord();
    const { rig, github } = await makeRig("ref-identity-stale", {
      repair: repairSnapshot([record], [authorizingReceipt()]),
      branchTip: (branch) => branch === candidateBranch(TARGET) ? HEAD : BASE,
    });
    try {
      const originalWrite = rig.state.writeRepair.bind(rig.state);
      let attempts = 0;
      const result = await runHostedAutonomy({
        state: {
          ...rig.state,
          writeRepair: async (
            next: RepairStateSnapshotV1,
            expectedHead: GitSha | null,
          ) => {
            attempts++;
            if (attempts === 1) {
              // A concurrent writer moves the state ref between this pass's
              // read and its expected-head write, exactly as a racing
              // maintenance run would.
              const current = await rig.state.readRepair();
              if (current.ok && current.value.status === "found") {
                await originalWrite({
                  ...current.value.snapshot,
                  stateHead: current.value.head as GitSha,
                  sequence: current.value.snapshot.sequence + 1,
                  updatedAt: current.value.snapshot.updatedAt + 1,
                }, current.value.head as GitSha);
              }
            }
            return await originalWrite(next, expectedHead);
          },
        },
        githubFor: () => github,
        clock: { now: () => T0 + 5_000_000 },
      });
      assert.equal(result.status, "skipped", JSON.stringify(result));
      assert.equal(result.reason, "write_conflict");
      assert.equal(attempts, 1);
      const read = await rig.state.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("repair state unreadable");
      }
      const parked = read.value.snapshot.work[0];
      assert.equal(parked.nextStep, "blocked");
      assert.equal(parked.blocker?.message, REF_IDENTITY_BLOCKER);
      assert.deepEqual(parked.counters, record.counters);
      assert.deepEqual(parked.target, record.target);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

Deno.test(
  "hosted autonomy: the candidate ref identity blocker reader refuses a foreign response ref",
  async () => {
    const branch = candidateBranch(TARGET);
    const cases: { name: string; payload: unknown; expected: string | null }[] =
      [
        {
          name: "exact response ref",
          payload: { ref: `refs/heads/${branch}`, object: { sha: HEAD } },
          expected: HEAD,
        },
        {
          name: "response ref for another branch",
          payload: { ref: "refs/heads/development", object: { sha: HEAD } },
          expected: null,
        },
        {
          name: "response without a ref identity",
          payload: { object: { sha: HEAD } },
          expected: null,
        },
      ];
    for (const testCase of cases) {
      const original = globalThis.fetch;
      globalThis.fetch = (() =>
        Promise.resolve(jsonResponse(testCase.payload))) as typeof fetch;
      try {
        const surface = createHostedAutonomyGitHub("fixture-token", SELF_REPO);
        assert.equal(
          await surface.readBaseTip(branch),
          testCase.expected,
          testCase.name,
        );
      } finally {
        globalThis.fetch = original;
      }
    }
  },
);
