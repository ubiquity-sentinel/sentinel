import assert from "node:assert/strict";
import { runHostedDeliveryPass } from "../../ops/hosted-autonomy-delivery-pass.ts";
import { createHostedQueueAuthority } from "../../ops/hosted-autonomy-queue-authority.ts";
import { protectQueueState } from "../../ops/hosted-autonomy-queue-state.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { buildHostedReleaseRequest } from "../../ops/hosted-autonomy-delivery.ts";
import { HOSTED_AUTONOMY_RETIRED } from "../../ops/hosted-autonomy-policy.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { makeRig } from "./hosted-autonomy-rig.ts";
import { authorityRig } from "./merge-queue-authority-fixtures.ts";
import { finding } from "./hosted-autonomy-fixtures.ts";
import { SHA1, SHA2, SHA3, SHA4, T0 } from "./merge-queue-proof-fixtures.ts";

async function fixture(options: {
  approval?: boolean;
  review?: "missing" | "dirty";
  acceptance?:
    | "missing"
    | "wrong-issue"
    | "not_fulfilled"
    | "uncertain"
    | "already_satisfied_at_base";
  duplicate?: "exact" | "wrong-base";
  change?: (record: WorkRecordV1) => WorkRecordV1;
} = {}) {
  const authority = await authorityRig(options.approval !== true);
  const record = options.change?.(authority.record) ?? authority.record;
  const clean = authority.facts.receipt;
  if (options.acceptance !== undefined) {
    assert.ok(clean.taskAcceptance);
    clean.taskAcceptance = options.acceptance === "missing" ? null : {
      ...clean.taskAcceptance,
      issueNumber: options.acceptance === "wrong-issue"
        ? record.related.issueNumber! + 1
        : clean.taskAcceptance.issueNumber,
      verdict: options.acceptance === "wrong-issue"
        ? "fulfilled"
        : options.acceptance,
    };
  }
  const dirty = {
    ...clean,
    id: `review-receipt:${"f".repeat(64)}`,
    completedAt: clean.completedAt! + 1,
    observedAt: clean.observedAt + 1,
    findings: [finding("P1")],
    unresolvedSeverities: ["P1"],
  };
  const reviews = options.review === "missing"
    ? []
    : options.review === "dirty"
    ? [clean, dirty]
    : [clean];
  const requests = [];
  if (options.duplicate !== undefined) {
    const request = await buildHostedReleaseRequest(
      record.repository,
      SHA4,
      SHA2,
      SHA1,
      7,
      clean,
      T0 + 4000,
    );
    assert.ok(request);
    requests.push(
      options.duplicate === "exact" ? request : {
        ...request,
        id: "different-base-request",
        source: { ...request.source, base: SHA3 },
      },
    );
  }
  const initial = parseRepairStateSnapshotV1({
    ...authority.snapshot,
    work: [record],
    reviews,
    releaseRequests: requests,
  });
  const { rig } = await makeRig("delivery-prefilter", { repair: initial });
  const calls = {
    scope: 0,
    pull: 0,
    resolve: 0,
    list: 0,
    approve: 0,
    merge: 0,
  };
  const github = {
    ...authority.github,
    readIssueTask: () =>
      Promise.resolve(
        authority.facts.task === "unavailable" ? null : authority.facts.task,
      ),
    readPull: async (...args: Parameters<typeof authority.github.readPull>) => {
      calls.pull++;
      return await authority.github.readPull(...args);
    },
    listParkedRuns: () => {
      calls.list++;
      return Promise.resolve([42]);
    },
    approveRun: () => {
      calls.approve++;
      return Promise.resolve(true);
    },
    merge: () => {
      calls.merge++;
      return Promise.reject(new Error("No direct merge in queue booking"));
    },
  };
  const state = { ...authority.state, ...rig.state };
  const root = createHostedQueueAuthority({
    ...authority.options,
    state,
    githubFor: () => github,
    configuration: authority.configuration,
  });
  const custody = {
    ready: true,
    proofActivated: true,
    protectedRecordIds: new Set(options.approval ? [] : [record.id]),
    resolveDelivery: async (
      ...args: Parameters<typeof root.resolveDelivery>
    ) => {
      calls.resolve++;
      return await root.resolveDelivery(...args);
    },
    verifyProtectedWrite: root.verifyProtectedWrite,
  };
  const deps: HostedAutonomyDepsV1 = {
    state: protectQueueState(state, custody),
    githubFor: () => github,
    clock: authority.clock,
    queueCustody: custody,
  };
  async function context(): Promise<HostedAutonomyPassContextV1> {
    const read = await state.readRepair();
    const release = await state.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    assert.ok(release.ok && release.value.status === "found");
    const scopes = createHostedAutonomyScopes(deps);
    return {
      deps,
      snapshot: read.value.snapshot,
      observedHead: read.value.head,
      initialHead: read.value.head,
      releaseSnapshot: release.value.snapshot,
      actions: [],
      revisions: [],
      closedIssues: new Set(),
      foreignMerged: new Map(),
      dedicatedReservations: new Set(),
      ...scopes,
      scopeFor: async (...args: Parameters<typeof scopes.scopeFor>) => {
        calls.scope++;
        return await scopes.scopeFor(...args);
      },
    };
  }
  async function saved() {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    return read.value;
  }
  return { rig, authority, state, calls, context, saved };
}

Deno.test("delivery prefilter: terminal and rejected-unpublished approval rows perform no reads", async (t) => {
  for (
    const [name, change] of [
      [
        "retired",
        (record: WorkRecordV1) => ({
          ...record,
          nextStep: "blocked" as const,
          blocker: {
            kind: "other" as const,
            message: HOSTED_AUTONOMY_RETIRED,
            since: T0,
          },
          intent: null,
        }),
      ],
      ["rejected unpublished", (record: WorkRecordV1) => ({
        ...record,
        nextStep: "blocked" as const,
        blocker: {
          kind: "other" as const,
          message: "candidate touches a protected path",
          since: T0,
        },
        intent: null,
        target: {
          ...record.target,
          candidateState: { preserved: null, publishedHead: SHA3 },
        },
      })],
    ] as const
  ) {
    await t.step(name, async () => {
      const f = await fixture({ approval: true, review: "missing", change });
      try {
        const before = await f.saved();
        await runHostedDeliveryPass(await f.context());
        assert.equal(
          f.calls.list,
          0,
          "terminal candidate must not list approval runs",
        );
        assert.equal(f.calls.scope, 0, "refusal must precede scope creation");
        assert.equal(f.calls.approve, 0);
        assert.deepEqual(await f.saved(), before);
      } finally {
        await Deno.remove(f.rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("delivery prefilter: exact booking no-ops avoid PR and authority reads", async (t) => {
  for (
    const [name, options] of [
      ["already booked", { duplicate: "exact" as const }],
      ["missing completed App review", { review: "missing" as const }],
      ["latest dirty after clean", { review: "dirty" as const }],
    ] as const
  ) {
    await t.step(name, async () => {
      const f = await fixture(options);
      try {
        const before = await f.saved();
        assert.equal(await runHostedDeliveryPass(await f.context()), null);
        assert.equal(f.calls.scope, 0);
        assert.equal(f.calls.pull, 0);
        assert.equal(f.calls.resolve, 0);
        assert.equal(f.calls.merge, 0);
        assert.deepEqual(await f.saved(), before);
      } finally {
        await Deno.remove(f.rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("delivery prefilter: impossible task acceptance avoids booking proof reads", async (t) => {
  for (
    const acceptance of [
      "missing",
      "wrong-issue",
      "not_fulfilled",
      "uncertain",
      "already_satisfied_at_base",
    ] as const
  ) {
    await t.step(acceptance, async () => {
      const f = await fixture({ acceptance });
      try {
        const before = await f.saved();
        const context = await f.context();
        assert.equal(await runHostedDeliveryPass(context), null);
        assert.equal(f.calls.scope, 0);
        assert.equal(f.calls.pull, 0);
        assert.equal(f.calls.resolve, 0);
        assert.equal(f.calls.merge, 0);
        assert.deepEqual(context.actions, [
          `delivery:${f.authority.record.id}:merge_proof_unavailable`,
        ]);
        assert.deepEqual(await f.saved(), before);
      } finally {
        await Deno.remove(f.rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("delivery prefilter: a clean refreshed context retains real authority and booking", async () => {
  const f = await fixture({ duplicate: "wrong-base" });
  try {
    const fresh = await f.context();
    const before = await f.saved();
    const stale: HostedAutonomyPassContextV1 = {
      ...fresh,
      snapshot: { ...fresh.snapshot, reviews: [] },
      actions: [],
    };
    assert.equal(await runHostedDeliveryPass(stale), null);
    assert.equal(f.calls.resolve, 0);
    assert.deepEqual(await f.saved(), before);
    const result = await runHostedDeliveryPass(await f.context());
    assert.equal(result?.status, "applied", JSON.stringify(result));
    assert.ok(
      f.calls.resolve > 0,
      "clean cache cannot replace real queue authority",
    );
    assert.equal(f.calls.merge, 0);
    const after = await f.saved();
    assert.equal(after.snapshot.releaseRequests.length, 2);
    assert.deepEqual(after.snapshot.reservations, before.snapshot.reservations);
    assert.deepEqual(
      after.snapshot.work[0].counters,
      before.snapshot.work[0].counters,
    );
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("delivery prefilter: current-head drift still refuses clean booking", async () => {
  const f = await fixture();
  try {
    const context = await f.context();
    const before = await f.saved();
    context.observedHead = SHA3;
    assert.equal(await runHostedDeliveryPass(context), null);
    assert.ok(f.calls.resolve > 0);
    assert.deepEqual(await f.saved(), before);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("delivery prefilter: publication and unresolved preservation keep approval admission", async (t) => {
  for (
    const name of [
      "published work",
      "head mismatch alone",
      "unresolved preservation",
    ]
  ) {
    await t.step(name, async () => {
      const f = await fixture({
        approval: true,
        review: "missing",
        change: (record) => ({
          ...record,
          nextStep: name === "published work" ? "work" : "blocked",
          blocker: name === "published work" ? null : {
            kind: "other",
            message: name === "unresolved preservation"
              ? "candidate touches a protected path"
              : "candidate requires reconciliation",
            since: T0,
          },
          target: {
            ...record.target,
            candidateState: {
              preserved: null,
              publishedHead: name === "published work"
                ? record.target.head
                : SHA3,
            },
          },
          intent: name === "unresolved preservation"
            ? {
              kind: "candidate_preservation",
              key: `impl:${"a".repeat(64)}`,
              requestId: "a".repeat(64),
              branch: `refs/heads/sentinel-candidates/${"b".repeat(64)}`,
              startedAt: T0,
              expectedHead: record.target.head,
              observedBase: record.target.base,
              pr: null,
              resultId: null,
            }
            : null,
        }),
      });
      try {
        await runHostedDeliveryPass(await f.context());
        assert.equal(f.calls.list, 1, name);
        assert.equal(f.calls.approve, 1, name);
      } finally {
        await Deno.remove(f.rig.tmp, { recursive: true });
      }
    });
  }
});
