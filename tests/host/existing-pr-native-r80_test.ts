/** Parse compatibility only: historical R80 execution remains forbidden after custody activation. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  nativeTakeoverIntentKey,
  TAKEOVER_NATIVE_PRESERVED,
  TAKEOVER_NATIVE_PRESERVING,
  takeoverAnchorRef,
  takeoverProvenanceRef,
} from "../../src/github/existing-pr-takeover-provenance.ts";
import { createCandidatePreserver } from "../../src/host/actions-candidates-preserve.ts";
import { createPrepareBaseRefresh } from "../../src/host/local-base-refresh.ts";
import {
  ensureBaseRefreshIntent,
  executeBaseRefreshIntent,
} from "../../src/repair/loop-base-refresh.ts";
import { routeExistingPr } from "../../src/repair/loop-existing-pr.ts";
import { prepareImplementationStart } from "../../src/repair/loop-implementation.ts";
import { handleModelReceipt } from "../../src/repair/loop-implementation-result.ts";
import { executeCandidatePreservation } from "../../src/repair/loop-preservation.ts";
import { executePublishStep } from "../../src/repair/loop-publication.ts";
import { persistTransition } from "../../src/repair/loop-state.ts";
import { nativeLifecycleRig } from "../repair/existing-pr-lifecycle-fixtures.ts";
import { FakeModel } from "../repair/helpers.ts";
import { completedReceipt } from "../repair/loop-review-fixtures.ts";
import { commitIn, gitRun } from "./actions-candidates-fixture.ts";
import { R80_RUNTIME, r80Available, withR80Parsers } from "./r80-contracts.ts";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481";
assert.equal(
  R80_RUNTIME,
  R80,
  "compatibility proof must keep its exact R80 source pin",
);
const available = await r80Available();
if (!available) {
  const shallow = await new Deno.Command("git", {
    args: ["-C", ROOT, "rev-parse", "--is-shallow-repository"],
    clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    stdout: "piped",
    stderr: "null",
  }).output();
  assert.ok(
    shallow.success,
    "could not establish historical-source availability",
  );
  assert.equal(
    new TextDecoder().decode(shallow.stdout).trim(),
    "true",
    "full history must contain R80",
  );
}

type Rig = Awaited<ReturnType<typeof nativeLifecycleRig>>;
interface SavedWrite {
  phase: string;
  expectedHead: GitSha | null;
  head: GitSha;
  snapshot: RepairStateSnapshotV1;
}

/** Capture fresh Git-backed readbacks, never a constructed replacement snapshot. */
function collectWrites(r: Rig) {
  const capture = { phase: "", writes: [] as SavedWrite[] };
  const writeRepair = r.state.writeRepair.bind(r.state);
  r.state.writeRepair = async (next, expectedHead) => {
    const written = await writeRepair(next, expectedHead);
    if (written.ok && written.value.status === "applied") {
      const read = await r.state.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      assert.equal(read.value.head, written.value.head);
      capture.writes.push({
        phase: capture.phase,
        expectedHead,
        head: read.value.head,
        snapshot: structuredClone(read.value.snapshot),
      });
    }
    return written;
  };
  return capture;
}

async function adoptNative(r: Rig, capture: ReturnType<typeof collectWrites>) {
  let context = await r.reload();
  for (const phase of ["native-intent", "native-anchor", "native-adoption"]) {
    capture.phase = phase;
    const count = capture.writes.length;
    const routed = await routeExistingPr(
      r.deps,
      context,
      context.snapshot.work[0],
    );
    assert.ok(routed.status === "step" && routed.step.kind === "progress");
    assert.equal(capture.writes.length, count + 1);
    context = await r.reload();
  }
  const [intent, anchor, adopted] = capture.writes;
  assert.equal(intent.snapshot.work[0].intent?.kind, "push");
  assert.equal(
    intent.snapshot.work[0].intent?.key,
    nativeTakeoverIntentKey(r.request),
  );
  assert.equal(
    intent.snapshot.work[0].blocker?.message,
    TAKEOVER_NATIVE_PRESERVING,
  );
  assert.equal(
    anchor.snapshot.work[0].blocker?.message,
    TAKEOVER_NATIVE_PRESERVED,
  );
  assert.equal(anchor.snapshot.work[0].intent, null);
  for (const written of [intent, anchor, adopted]) {
    assert.deepEqual(written.snapshot.work[0].target.candidateState, {
      preserved: null,
      publishedHead: r.ctx.head,
    });
    assert.deepEqual(written.snapshot.reservations, r.initial.reservations);
    assert.equal(written.snapshot.work[0].target.branch, "human/issue-1");
    assert.equal(written.snapshot.work[0].target.pr, 7);
  }
  assert.deepEqual(intent.snapshot.work[0].evidence, [
    takeoverAnchorRef(r.request.bindingDigest),
  ]);
  assert.deepEqual(
    anchor.snapshot.work[0].evidence,
    intent.snapshot.work[0].evidence,
  );
  assert.deepEqual(adopted.snapshot.work[0].evidence, [
    takeoverProvenanceRef(r.request.bindingDigest, anchor.head),
  ]);
  assert.equal(adopted.snapshot.work[0].nextStep, "work");
  assert.equal(adopted.snapshot.work[0].blocker, null);
  assert.equal(
    r.pushes.length,
    1,
    "only the original native immutable head was pushed",
  );
  assert.equal(await r.readHead(r.request.ref), r.ctx.head);
  return context;
}

async function parseEveryWrite(writes: readonly SavedWrite[]) {
  await withR80Parsers(({ parseRepairStateSnapshotV1 }) => {
    for (const written of writes) {
      assert.deepEqual(
        parseRepairStateSnapshotV1(written.snapshot),
        written.snapshot,
        written.phase,
      );
      // Retain the actual synthetic Git readback and its CAS provenance in bounded test evidence.
      console.log(
        "r80_native_snapshot " +
          JSON.stringify({ parserSource: R80, ...written }),
      );
    }
  });
}

Deno.test({
  name:
    "R80 parses every actual native preserve/adopt and charged correction successor write",
  ignore: !available,
  async fn() {
    const r = await nativeLifecycleRig();
    const capture = collectWrites(r);
    try {
      let context = await adoptNative(r, capture);
      const native = context.snapshot.work[0];
      capture.phase = "native-review-receipt";
      // Only an unresolved P0 rejects the native head and admits a charged
      // correction (owner directive 2026-10-24; P1/P2/P3 never block).
      assert.deepEqual(
        await persistTransition(r.deps, context, (draft) => {
          draft.reviews.push(completedReceipt(7, r.ctx.head, r.ctx.base, {
            repository: native.repository,
            unresolvedSeverities: ["P0"],
            findings: [{
              id: "native-p0",
              severity: "P0",
              path: "candidate.txt",
              message: "The submitted change does not cover the edge case",
              resolved: false,
              fingerprint: "b".repeat(64),
              resolutionEvidence: null,
            }],
          }));
        }),
        { kind: "progress" },
      );
      context = await r.reload();
      context.bounds = {
        runDeadline: r.clock.now() +
          r.deps.configs[0].sessionBound!.maxDurationMs + 7_200_000,
        modelCutoff: r.clock.now() + 5_400_000,
      };
      r.host.port.readIssue = () =>
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
      capture.phase = "correction-admission";
      const prepared = await prepareImplementationStart(
        r.deps,
        context,
        context.snapshot.work[0],
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
        prepared.context.snapshot.reservations.length,
        r.initial.reservations.length + 1,
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
          assert.ok(
            (await gitRun(r.sourcePath, [
              "fetch",
              "--no-tags",
              `file://${r.ctx.tmp}/work`,
              head,
            ], r.ctx.env)).ok,
          );
          return portOk(undefined);
        },
      });
      const model = new FakeModel({
        head: successor,
        changedPaths: ["correction.txt"],
      });
      const receipt = await model.runModel(prepared.request);
      assert.ok(receipt.ok);
      capture.phase = "correction-produced";
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
      capture.phase = "correction-preserved";
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
      capture.phase = "correction-published";
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
      assert.deepEqual(
        context.snapshot.reservations.filter((row) =>
          row.id !== prepared.reservationId
        ),
        r.initial.reservations,
      );
      assert.ok(
        capture.writes.some((row) => row.phase === "correction-preserved"),
      );
      assert.ok(
        capture.writes.some((row) => row.phase === "correction-published"),
      );
      await parseEveryWrite(capture.writes);
    } finally {
      await r.ctx.cleanup();
    }
  },
});

Deno.test({
  name:
    "R80 parses every actual native custody and uncharged base refresh successor write",
  ignore: !available,
  async fn() {
    const r = await nativeLifecycleRig();
    const capture = collectWrites(r);
    try {
      let context = await adoptNative(r, capture);
      const original = context.snapshot.work[0];
      r.host.port.prepareBaseRefresh = createPrepareBaseRefresh({
        clock: r.clock,
        git: r.host.git,
        repository: original.repository,
        observer: r.host.port,
        baseBranch: "development",
        trustedPrAuthor: "sentinel[bot]",
      });
      r.host.port.preserveCandidate = createCandidatePreserver({
        ...r.factoryInput,
        state: r.state,
        http: r.http,
        ensureLocalCandidate: () => Promise.resolve(portOk(undefined)),
      });
      const work = `${r.ctx.tmp}/work`;
      assert.ok(
        (await gitRun(work, ["checkout", "development"], r.ctx.env)).ok,
      );
      const nextBase = await commitIn(work, r.ctx.env, "new-base");
      assert.ok(
        (await gitRun(work, ["push", "origin", "development"], r.ctx.env)).ok,
      );
      assert.ok(
        (await gitRun(
          r.sourcePath,
          ["fetch", "origin", "development"],
          r.ctx.env,
        )).ok,
      );
      r.nativeControls.base = nextBase;
      capture.phase = "base-refresh-intent";
      assert.deepEqual(
        await ensureBaseRefreshIntent(r.deps, context, original),
        { kind: "progress" },
      );
      context = await r.reload();
      capture.phase = "base-refresh-successor";
      assert.deepEqual(
        await executeBaseRefreshIntent(
          r.deps,
          context,
          context.snapshot.work[0],
        ),
        { kind: "progress" },
      );
      context = await r.reload();
      const refreshed = context.snapshot.work[0];
      assert.equal(refreshed.intent, null);
      assert.equal(refreshed.target.pr, 7);
      assert.equal(refreshed.target.branch, "human/issue-1");
      assert.equal(refreshed.target.base, nextBase);
      assert.notEqual(refreshed.target.head, original.target.head);
      assert.equal(
        refreshed.target.candidateState?.preserved?.head,
        refreshed.target.head,
      );
      assert.equal(
        await r.readHead("refs/heads/human/issue-1"),
        refreshed.target.head,
      );
      assert.deepEqual(refreshed.counters, original.counters);
      assert.deepEqual(context.snapshot.reservations, r.initial.reservations);
      assert.ok(
        capture.writes.some((row) => row.phase === "base-refresh-intent"),
      );
      assert.ok(
        capture.writes.some((row) => row.phase === "base-refresh-successor"),
      );
      await parseEveryWrite(capture.writes);
    } finally {
      await r.ctx.cleanup();
    }
  },
});
