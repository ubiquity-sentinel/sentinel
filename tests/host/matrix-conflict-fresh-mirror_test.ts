/**
 * A hosted conflict resolution's merge M survives the job that ingested it.
 *
 * Each hosted job has its own trusted mirror: the aggregate job that ingests a
 * conflict cell imports M's bundle into ITS mirror only, and a later job
 * starts from a fresh one. The hosted ingest therefore preserves M under the
 * deterministic refresh binding of (PR, H, B) on the remote BEFORE it
 * consumes the receipt (the one charge stays `reserved` until then); a
 * transient preservation failure keeps the receipt, its charge and the
 * in-flight intent exactly as they were, so a later scan of the retained
 * artifact retries in its own mirror. A later job then publishes M from an
 * EMPTY mirror: the preservation it reconciles imports M from the remote.
 *
 * The preservation model below keeps the production preserver's split: an
 * absent operation ref needs the candidate objects in THIS job's mirror and is
 * created from it; an existing ref holding the exact head is reconciled and
 * its graph imported into this job's mirror. The real preserver's binding of
 * the in-flight conflict resolution is pinned in
 * `actions-candidates-preserve-conflict_test.ts`.
 */
import assert from "node:assert/strict";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  CONFLICT_MERGE_PRESERVE_WINDOW_MS,
  conflictMarker,
  conflictMarkerBase,
  conflictResolutionInFlight,
  resolvedConflictResolution,
} from "../../src/repair/conflict-resolution.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { REPO } from "../state/helpers.ts";
import { PR, TASK } from "../repair/conflict-resolution-rig.ts";
import { MAX_BASE_REFRESH_FAILURES } from "../../src/repair/loop-base-refresh-failure.ts";
import { resolvedConflictCandidate } from "../../src/host/matrix-conflict-candidate.ts";
import { isMatrixRecoveryPending } from "../../src/host/matrix-blocked-candidate.ts";
import {
  chargedCell,
  composeMirrorPreservation,
  hostedConflictRig,
  type HostedConflictRigV1,
  ingestIn,
  jobMirror,
  type JobV1,
  present,
  remoteRef,
} from "./matrix-conflict-hosted-rig.ts";

async function snapshotOf(rig: HostedConflictRigV1): Promise<{
  head: string;
  snapshot: RepairStateSnapshotV1;
}> {
  const read = await rig.hosted.state.readRepair();
  if (!read.ok || read.value.status !== "found") throw new Error("no state");
  return { head: read.value.head, snapshot: read.value.snapshot };
}

async function refreshRef(rig: HostedConflictRigV1): Promise<string> {
  return await candidatePreservationRef(
    REPO,
    TASK,
    baseRefreshIntentKey(PR, rig.ctx.head, rig.ctx.base),
  );
}

Deno.test("hosted conflict resolution: a consumed result rehydrates its exact bundle after restart before ordinary publication", async () => {
  const rig = await hostedConflictRig();
  try {
    const first = await jobMirror(rig, "first");
    const later = await jobMirror(rig, "later");
    const job = { current: { dir: first, fail: "not_found" } as JobV1 };
    const calls = composeMirrorPreservation(rig, job);
    const cell = await chargedCell(rig);
    assert.equal((await ingestIn(rig, first, cell)).ingested, 1);
    const before = await snapshotOf(rig);
    assert.equal(before.snapshot.work[0].intent?.resultId, cell.merge);
    assert.equal(before.snapshot.reservations[0].outcome, "submitted");
    job.current = { dir: later };
    assert.equal(await present(rig, later, cell.merge), false);

    for (let replay = 0; replay < 2; replay++) {
      const report = await ingestIn(rig, later, cell);
      assert.equal(report.ingested, 0);
      assert.equal(report.entries[0].disposition, "duplicate");
      assert.equal(await present(rig, later, cell.merge), true);
      assert.deepEqual(await snapshotOf(rig), before);
      assert.equal(calls.length, 1, "rehydration never publishes or preserves");
    }

    const published = await rig.runLoop();
    assert.notEqual(published.status, "state_error", JSON.stringify(published));
    const after = (await snapshotOf(rig)).snapshot;
    assert.equal(after.work[0].target.head, cell.merge);
    assert.equal(after.work[0].target.base, rig.ctx.base);
    assert.equal(after.work[0].target.pr, PR);
    assert.equal(
      after.work[0].target.candidateState?.publishedHead,
      cell.merge,
    );
    assert.equal(await remoteRef(rig, await refreshRef(rig)), cell.merge);
    assert.deepEqual(
      after.reservations.filter((row) => row.purpose !== "review_request"),
      before.snapshot.reservations,
      "ordinary publication buys no new implementation and never refunds",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted conflict resolution: consumed-result hydration refuses stale bindings and unavailable bundles without effects", async (t) => {
  const rig = await hostedConflictRig();
  try {
    const first = await jobMirror(rig, "first");
    const calls = composeMirrorPreservation(rig, {
      current: { dir: first, fail: "not_found" },
    });
    const original = await chargedCell(rig);
    assert.equal((await ingestIn(rig, first, original)).ingested, 1);
    const baseline = (await snapshotOf(rig)).snapshot;
    type Input = {
      state: RepairStateSnapshotV1;
      cell: typeof original;
    };
    const controls: [string, (input: Input) => void, string][] = [
      ["terminal record", ({ state }) => {
        state.work[0].nextStep = "blocked";
        state.work[0].blocker = {
          kind: "other",
          message:
            "base refresh failed 3 consecutive times: not_found candidate could not be preserved",
          since: rig.hosted.clock.now(),
        };
        state.work[0].intent = null;
      }, "duplicate"],
      ["wrong operation", ({ cell }) => {
        const key = implementationIntentKey("f".repeat(64));
        cell.plan.cells[0].intentKey = key;
        cell.result.intentKey = key;
      }, "binding_mismatch"],
      ["wrong refresh PR", ({ state }) => {
        state.work[0].intent!.pr = PR + 1;
      }, "binding_mismatch"],
      ["wrong refresh base", ({ state }) => {
        state.work[0].intent!.observedBase = rig.ctx.head;
        state.work[0].intent!.failure = conflictMarker(
          rig.ctx.head,
          rig.hosted.clock.now(),
        );
      }, "binding_mismatch"],
      ["moved published head", ({ state }) => {
        state.work[0].target.head = rig.ctx.base;
      }, "binding_mismatch"],
      ["wrong result head", ({ cell }) => {
        cell.result.receipt!.candidate!.head = rig.ctx.head;
      }, "binding_mismatch"],
      ["unproven original ref", ({ state }) => {
        state.work[0].target.candidateState!.preserved!.ref =
          `refs/heads/sentinel-candidates/${"f".repeat(64)}`;
      }, "binding_mismatch"],
      ["ambiguous charge", ({ state }) => {
        state.reservations[0].outcome = "ambiguous";
      }, "binding_mismatch"],
      ["duplicate current charge", ({ state }) => {
        state.reservations.push({
          ...state.reservations[0],
          id: "e".repeat(64),
        });
      }, "binding_mismatch"],
      ["unsettled submitted charge", ({ state }) => {
        state.reservations[0].settledAt = null;
      }, "binding_mismatch"],
      ["wrong charge source", ({ state }) => {
        state.reservations[0].head = rig.ctx.base;
      }, "binding_mismatch"],
      ["charge after resolved operation", ({ state }) => {
        state.reservations[0].createdAt = state.work[0].intent!.startedAt + 1;
        state.reservations[0].settledAt = state.reservations[0].createdAt;
      }, "binding_mismatch"],
      ["spent failure budget", ({ state }) => {
        state.work[0].intent!.failure!.attempts = MAX_BASE_REFRESH_FAILURES + 1;
      }, "binding_mismatch"],
      ["newer attempt", ({ state }) => {
        state.work[0].counters.attempts++;
      }, "binding_mismatch"],
      ["foreign result", ({ cell }) => {
        cell.result.repository = { ...REPO, name: "other" };
      }, "binding_mismatch"],
      ["missing bundle", ({ cell }) => {
        cell.result.bundle = null;
      }, "candidate_unavailable"],
      ["corrupt bundle digest", ({ cell }) => {
        cell.result.bundle!.digest = "f".repeat(64);
      }, "candidate_unavailable"],
    ];
    const exact = await resolvedConflictCandidate(
      baseline.work[0],
      baseline.reservations,
    );
    assert(exact !== null);
    assert.equal(isMatrixRecoveryPending(baseline.work[0], exact), true);
    const stale = structuredClone(baseline.work[0]);
    stale.intent!.resultId = rig.ctx.head;
    assert.equal(
      isMatrixRecoveryPending(stale, exact),
      false,
      "a typed hint must bind this exact row",
    );
    assert.equal(
      isMatrixRecoveryPending(baseline.work[0], {
        ...exact,
        candidate: { ...exact.candidate, head: rig.ctx.head },
      }),
      false,
      "a typed hint cannot substitute its tuple",
    );
    for (const [name, mutate, expected] of controls) {
      await t.step(name, async () => {
        const input = {
          state: structuredClone(baseline),
          cell: structuredClone(original),
        };
        mutate(input);
        rig.hosted.state.repair = input.state;
        const before = await snapshotOf(rig);
        const mirror = await jobMirror(
          rig,
          `control-${name.replaceAll(" ", "-")}`,
        );
        const report = await ingestIn(rig, mirror, input.cell);
        assert.equal(report.ingested, 0);
        assert.equal(report.entries[0].disposition, expected);
        assert.equal(await present(rig, mirror, original.merge), false);
        assert.deepEqual(await snapshotOf(rig), before);
        assert.equal(calls.length, 1, "no publication or preservation effect");
      });
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted conflict resolution: the ingest preserves M before consuming the receipt; a later job publishes M from an empty mirror", async () => {
  const rig = await hostedConflictRig();
  try {
    const ingestJob = await jobMirror(rig, "mirror-ingest");
    const laterJob = await jobMirror(rig, "mirror-later");
    const job = { current: { dir: ingestJob } as JobV1 };
    const calls = composeMirrorPreservation(rig, job);
    const cell = await chargedCell(rig);
    const ref = await refreshRef(rig);
    assert.equal(await remoteRef(rig, ref), null);

    const report = await ingestIn(rig, ingestJob, cell);
    assert.equal(report.ingested, 1, JSON.stringify(report));
    assert.equal(
      await remoteRef(rig, ref),
      cell.merge,
      "M is durable on the remote",
    );
    assert.deepEqual(calls[0], {
      taskId: TASK,
      candidate: {
        operationKey: baseRefreshIntentKey(PR, rig.ctx.head, rig.ctx.base),
        base: rig.ctx.base,
        head: cell.merge,
        ref,
      },
      publishedHead: rig.ctx.head,
    }, "the exact refresh binding the publication reconciles");
    const resolved = (await snapshotOf(rig)).snapshot;
    assert.equal(
      resolvedConflictResolution(resolved.work[0].intent),
      cell.merge,
    );
    assert.equal(resolved.reservations[0].outcome, "submitted");

    // A later job: a fresh mirror that never saw M or its bundle.
    assert.equal(await present(rig, laterJob, cell.merge), false);
    job.current = { dir: laterJob };
    const published = await rig.runLoop();
    assert.notEqual(published.status, "state_error", JSON.stringify(published));
    const after = (await snapshotOf(rig)).snapshot.work[0];
    assert.equal(
      after.target.head,
      cell.merge,
      "M published from an empty mirror",
    );
    assert.equal(after.target.base, rig.ctx.base);
    assert.equal(after.target.pr, PR);
    assert.equal(after.target.candidateState?.publishedHead, cell.merge);
    assert.equal(after.intent?.kind === "base_refresh", false);
    assert.ok(
      await present(rig, laterJob, cell.merge),
      "imported from the remote",
    );
    assert.ok(
      rig.github.pushes.some((push) =>
        push.ref.endsWith(after.target.branch!) && push.sha === cell.merge &&
        push.expected === rig.ctx.head
      ),
      "lease-pushed over H",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted conflict resolution: a transient preservation failure keeps the receipt and its charge; a later job re-ingests the retained artifact and publishes", async () => {
  for (const kind of ["unavailable", "auth_failed", "rate_limited"] as const) {
    const rig = await hostedConflictRig();
    try {
      const ingestJob = await jobMirror(rig, "mirror-ingest");
      const laterJob = await jobMirror(rig, "mirror-later");
      const job = { current: { dir: ingestJob, fail: kind } as JobV1 };
      composeMirrorPreservation(rig, job);
      const cell = await chargedCell(rig);
      const before = await snapshotOf(rig);
      const kept = await ingestIn(rig, ingestJob, cell);
      assert.equal(kept.entries[0]?.disposition, "deferred", kind);
      assert.equal(kept.ingested, 0);
      const unchanged = await snapshotOf(rig);
      assert.deepEqual(unchanged, before, `${kind}: nothing is written`);
      const record = unchanged.snapshot.work[0];
      assert.equal(conflictResolutionInFlight(record.intent), rig.ctx.base);
      assert.equal(unchanged.snapshot.reservations[0].outcome, "reserved");

      // The next job's first scan re-ingests the SAME retained artifact into
      // its own mirror and preserves M there.
      job.current = { dir: laterJob };
      const consumed = await ingestIn(rig, laterJob, cell);
      assert.equal(consumed.ingested, 1, kind);
      assert.equal(await remoteRef(rig, await refreshRef(rig)), cell.merge);
      const published = await rig.runLoop();
      assert.notEqual(
        published.status,
        "state_error",
        JSON.stringify(published),
      );
      const after = (await snapshotOf(rig)).snapshot;
      assert.equal(after.work[0].target.head, cell.merge, kind);
      const charged = after.reservations.filter((row) =>
        row.purpose === "implementation" || row.purpose === "retry"
      );
      assert.equal(charged.length, 1, "one charge, never a second");
      assert.equal(charged[0].outcome, "submitted");
    } finally {
      await rig.cleanup();
    }
  }
});

Deno.test("hosted conflict resolution: a refused preservation, or a transient one past the window, consumes the receipt as before", async () => {
  for (
    const [name, kind, late] of [
      ["refused", "invalid", false],
      ["conflicting ref", "conflict", false],
      ["transient past the window", "unavailable", true],
    ] as const
  ) {
    const rig = await hostedConflictRig();
    try {
      const ingestJob = await jobMirror(rig, "mirror-ingest");
      composeMirrorPreservation(rig, {
        current: { dir: ingestJob, fail: kind },
      });
      const cell = await chargedCell(rig);
      if (late) rig.hosted.clock.advance(CONFLICT_MERGE_PRESERVE_WINDOW_MS);
      const report = await ingestIn(rig, ingestJob, cell);
      assert.equal(report.ingested, 1, name);
      const after = (await snapshotOf(rig)).snapshot;
      assert.equal(
        resolvedConflictResolution(after.work[0].intent),
        cell.merge,
        name,
      );
      assert.equal(conflictMarkerBase(after.work[0].intent), rig.ctx.base);
      assert.equal(after.reservations[0].outcome, "submitted", name);
    } finally {
      await rig.cleanup();
    }
  }
});

Deno.test("hosted conflict resolution: a protected-path merge is never preserved and blocks charged as before", async () => {
  const rig = await hostedConflictRig();
  try {
    const ingestJob = await jobMirror(rig, "mirror-ingest");
    const calls = composeMirrorPreservation(rig, {
      current: { dir: ingestJob },
    });
    const first = await rig.runLoop();
    assert.notEqual(first.status, "state_error");
    const planned = await rig.plan();
    const { result } = await rig.runCell(planned.plan, planned.plan.cells[0], {
      extra: { "src/handler.ts": "export const handled = true;\n" },
    });
    const report = await ingestIn(rig, ingestJob, {
      plan: planned.plan,
      result,
    });
    assert.equal(report.ingested, 1);
    assert.deepEqual(calls, [], "never preserved");
    assert.equal(await remoteRef(rig, await refreshRef(rig)), null);
    const after = (await snapshotOf(rig)).snapshot;
    assert.equal(after.work[0].nextStep, "blocked");
    assert.equal(after.reservations[0].outcome, "submitted");
  } finally {
    await rig.cleanup();
  }
});
