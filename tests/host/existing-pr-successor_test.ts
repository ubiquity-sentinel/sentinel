import assert from "node:assert/strict";
import { createPrepareBaseRefresh } from "../../src/host/local-base-refresh.ts";
import { routeExistingPr } from "../../src/repair/loop-existing-pr.ts";
import { ensureReviewFreshness } from "../../src/repair/loop-task-context.ts";
import { nativeLifecycleRig } from "../repair/existing-pr-lifecycle-fixtures.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { prepareImplementationStart } from "../../src/repair/loop-implementation.ts";
import { persistTransition } from "../../src/repair/loop-state.ts";
import { completedReceipt } from "../repair/loop-review-fixtures.ts";
import { isMatrixImplementationReadyV1 } from "../../src/repair/loop-eligibility.ts";
import { createCandidatePreserver } from "../../src/host/actions-candidates-preserve.ts";
import { FakeModel } from "../repair/helpers.ts";
import { commitIn, gitRun } from "./actions-candidates-fixture.ts";
import { handleModelReceipt } from "../../src/repair/loop-implementation-result.ts";
import { executeCandidatePreservation } from "../../src/repair/loop-preservation.ts";
import { executePublishStep } from "../../src/repair/loop-publication.ts";

type Rig = Awaited<ReturnType<typeof nativeLifecycleRig>>;

/** Adopt the native head through the real route: intent, anchor, adoption. */
async function adoptNative(r: Rig) {
  let context = await r.reload();
  for (let phase = 0; phase < 3; phase++) {
    const step = await routeExistingPr(
      r.deps,
      context,
      context.snapshot.work[0],
    );
    assert.ok(step.status === "step" && step.step.kind === "progress");
    context = await r.reload();
  }
  return context;
}

function runBounds(r: Rig) {
  return {
    runDeadline: r.clock.now() +
      r.deps.configs[0].sessionBound!.maxDurationMs + 7_200_000,
    modelCutoff: r.clock.now() + 5_400_000,
  };
}

function issueReader(r: Rig): Rig["host"]["port"]["readIssue"] {
  return () =>
    Promise.resolve(portOk({
      number: 1,
      title: "Repair source",
      body: r.nativeControls.body,
      state: "open",
      labels: [],
      assignees: [],
      author: "human-owner",
      createdAt: r.clock.now(),
      closedAt: null,
      updatedAt: r.clock.now(),
      relations: { subIssueCount: 0, openBlockers: [] },
    }));
}

/** The completed verdict on the native head with ONE unresolved finding. */
function nativeVerdict(r: Rig, severity: "P0" | "P1") {
  return completedReceipt(7, r.ctx.head, r.ctx.base, {
    repository: r.initial.work[0].repository,
    unresolvedSeverities: [severity],
    findings: [{
      id: `native-${severity.toLowerCase()}`,
      severity,
      path: "candidate.txt",
      message: "The submitted change does not cover the edge case",
      resolved: false,
      fingerprint: "b".repeat(64),
      resolutionEvidence: null,
    }],
  });
}

Deno.test("existing PR successor: real correction admission retains native branch and charges one implementation", async () => {
  const r = await nativeLifecycleRig();
  try {
    let context = await adoptNative(r);
    const native = context.snapshot.work[0];
    // Only an unresolved P0 rejects the native head and admits ONE charged
    // correction (owner directive 2026-10-24); the non-blocking P1 verdict is
    // proved on its own rig below.
    assert.deepEqual(
      await persistTransition(r.deps, context, (draft) => {
        draft.reviews.push(nativeVerdict(r, "P0"));
      }),
      { kind: "progress" },
    );
    context = await r.reload();
    context.bounds = runBounds(r);
    r.host.port.readIssue = issueReader(r);
    const record = context.snapshot.work[0];
    const prepared = await prepareImplementationStart(
      r.deps,
      context,
      record,
      r.deps.configs[0],
    );
    assert.equal(prepared.kind, "prepared", JSON.stringify(prepared));
    assert.ok(prepared.kind === "prepared");
    assert.equal(prepared.request.checkoutBase, r.ctx.head);
    assert.equal(prepared.record.target.branch, "human/issue-1");
    assert.equal(prepared.record.intent?.branch, "human/issue-1");
    assert.equal(prepared.record.target.pr, 7);
    assert.equal(prepared.record.target.candidateState?.preserved, null);
    assert.equal(
      prepared.record.counters.attempts,
      native.counters.attempts + 1,
    );
    assert.equal(
      prepared.context.snapshot.reservations.length,
      r.initial.reservations.length + 1,
    );
    assert.equal(
      isMatrixImplementationReadyV1(
        record,
        context.snapshot,
        r.deps.configs[0],
        r.clock.now(),
      ),
      true,
    );
    const successor = await commitIn(
      `${r.ctx.tmp}/work`,
      r.ctx.env,
      "correction",
    );
    r.host.port.preserveCandidate = createCandidatePreserver({
      ...r.factoryInput,
      state: r.state,
      http: r.http,
      async ensureLocalCandidate(_id, head) {
        const fetched = await gitRun(r.sourcePath, [
          "fetch",
          "--no-tags",
          `file://${r.ctx.tmp}/work`,
          head,
        ], r.ctx.env);
        assert.ok(fetched.ok);
        return portOk(undefined);
      },
    });
    const model = new FakeModel({
      head: successor,
      changedPaths: ["correction.txt"],
    });
    const receipt = await model.runModel(prepared.request);
    assert.ok(receipt.ok);
    assert.equal(
      (await handleModelReceipt(
        r.deps,
        prepared.context,
        prepared.record,
        prepared.reservationId,
        receipt.value,
        r.deps.configs[0],
      )).kind,
      "progress",
    );
    context = await r.reload();
    assert.equal(
      context.snapshot.work[0].intent?.kind,
      "candidate_preservation",
    );
    assert.deepEqual(
      await executeCandidatePreservation(
        r.deps,
        context,
        context.snapshot.work[0],
      ),
      { kind: "progress" },
    );
    context = await r.reload();
    assert.equal(
      context.snapshot.work[0].target.candidateState?.preserved?.head,
      successor,
    );
    const published = await executePublishStep(
      r.deps,
      context,
      context.snapshot.work[0],
      r.deps.configs[0],
    );
    assert.notEqual(published.kind, "state_error", JSON.stringify(published));
    context = await r.reload();
    assert.equal(
      context.snapshot.work[0].target.candidateState?.publishedHead,
      successor,
    );
    assert.equal(context.snapshot.work[0].target.pr, 7);
    assert.equal(await r.readHead("refs/heads/human/issue-1"), successor);
    assert.equal(
      await r.readHead("refs/heads/sentinel/repair/issue-1"),
      r.ctx.head,
    );
    assert.equal(model.requests.length, 1);
    assert.equal(
      context.snapshot.reservations.find((row) =>
        row.id === prepared.reservationId
      )?.outcome,
      "submitted",
    );
    r.nativeControls.merged = true;
    r.nativeControls.mergeSha = successor;
    r.nativeControls.issueClosed = true;
    r.controls.principal = false;
    r.nativeControls.policy.activated = false;
    const readonly = r.restartTakeover();
    const publication = await readonly.resolvePublication({
      record: context.snapshot.work[0],
      snapshot: context.snapshot,
      expectedStateHead: context.head!,
      revision: successor,
      deadline: r.clock.now() + 30_000,
    });
    assert.ok(publication.ok, JSON.stringify(publication));
    assert.ok(r.state.readRepairAt);
    const readAt = r.state.readRepairAt.bind(r.state);
    r.state.readRepairAt = ({ expectedHead }) =>
      Promise.resolve(
        portOk({ status: "absent", currentHead: expectedHead, ref: null }),
      );
    assert.equal(
      (await readonly.resolvePublication({
        record: context.snapshot.work[0],
        snapshot: context.snapshot,
        expectedStateHead: context.head!,
        revision: successor,
        deadline: r.clock.now() + 30_000,
      })).ok,
      false,
      "missing immutable producer history cannot become inferred custody",
    );
    r.state.readRepairAt = readAt;
  } finally {
    await r.ctx.cleanup();
  }
});

Deno.test("existing PR successor: an unresolved P1 verdict admits no correction and charges nothing", async () => {
  const r = await nativeLifecycleRig();
  try {
    let context = await adoptNative(r);
    assert.deepEqual(
      await persistTransition(r.deps, context, (draft) => {
        draft.reviews.push(nativeVerdict(r, "P1"));
      }),
      { kind: "progress" },
    );
    context = await r.reload();
    const before = structuredClone(context);
    context.bounds = runBounds(r);
    r.host.port.readIssue = issueReader(r);
    const record = context.snapshot.work[0];
    // Owner directive 2026-10-24: only an unresolved P0 blocks. A completed
    // P1 verdict on the native head authorizes NO correction: the real
    // admission defers with zero reservation, zero model start and no state
    // write, and the matrix plans no correction cell for it.
    assert.deepEqual(
      await prepareImplementationStart(
        r.deps,
        context,
        record,
        r.deps.configs[0],
      ),
      { kind: "deferred", detail: "existing PR has no authorized correction" },
    );
    assert.equal(
      isMatrixImplementationReadyV1(
        record,
        context.snapshot,
        r.deps.configs[0],
        r.clock.now(),
      ),
      false,
      "an unresolved P1 never spends a correction round",
    );
    assert.deepEqual(
      await r.reload(),
      before,
      "a non-blocking P1 verdict neither writes state nor charges a producer",
    );
    assert.deepEqual(context.snapshot.reservations, r.initial.reservations);
    assert.equal(
      r.pushes.length,
      1,
      "only native immutable preservation occurred",
    );
  } finally {
    await r.ctx.cleanup();
  }
});

Deno.test("existing PR native lifecycle: honest preserved-null head reaches the real pre-review freshness gate", async () => {
  const r = await nativeLifecycleRig();
  try {
    r.host.port.prepareBaseRefresh = createPrepareBaseRefresh({
      clock: r.clock,
      git: r.host.git,
      repository: r.initial.work[0].repository,
      observer: r.host.port,
      baseBranch: "development",
      trustedPrAuthor: "sentinel[bot]",
    });
    let context = await r.reload();
    for (let phase = 0; phase < 3; phase++) {
      const routed = await routeExistingPr(
        r.deps,
        context,
        context.snapshot.work[0],
      );
      assert.ok(routed.status === "step" && routed.step.kind === "progress");
      context = await r.reload();
    }
    const record = context.snapshot.work[0];
    const before = structuredClone(context);
    assert.equal(record.target.candidateState?.preserved, null);
    assert.equal(await ensureReviewFreshness(r.deps, context, record, 7), null);
    assert.deepEqual(
      await r.reload(),
      before,
      "freshness neither invents nor charges an implementation producer",
    );
    assert.deepEqual(context.snapshot.reservations, r.initial.reservations);
    assert.equal(
      r.pushes.length,
      1,
      "only native immutable preservation occurred",
    );
  } finally {
    await r.ctx.cleanup();
  }
});
