/** Connected archive recovery, progressive ingestion and fresh aggregate assertions; no test registrations. */
import assert from "node:assert/strict";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  type MatrixAggregateOptionsV1,
  runActionsMatrixAggregateCycles,
} from "../../src/host/matrix-actions.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import { MATRIX_ARTIFACT_RECOVERY_MAX_MS } from "../../src/host/matrix-artifact-port.ts";
import { markBlocked } from "../../src/repair/transitions.ts";
import { gitRun, type workRecord } from "../state/helpers.ts";
import { rig } from "./matrix-actions-fixtures.ts";
import { runFreshMatrixCells } from "./matrix-actions-cell-fixtures.ts";
import { createFreshMatrixArchives } from "./matrix-actions-archive-fixtures.ts";

export async function freshMatrixArtifacts(
  noStart17 = false,
  nativeScopedOnly = false,
  progressive: "none" | "settle" | "missing" | "single" | "short" = "none",
  historicalRuntimeIsolation = false,
) {
  const r = await rig(true, "ordinary", noStart17);
  try {
    const cellRun = await runFreshMatrixCells(r, noStart17);
    const { initialPlanTime, expectedCells, planner, results, archive } =
      cellRun;
    const before = await r.store.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    // Bind the narrowed found snapshot once: TypeScript does not retain the
    // assertion narrowing inside the poll callback below.
    const beforeHead = before.value.head;
    const beforeWork: ReturnType<typeof workRecord>[] = before.value
      .snapshot.work;
    assert.equal(
      before.value.snapshot.reservations.filter((row) =>
        row.purpose === "implementation"
      ).length,
      expectedCells,
    );
    const {
      artifactCalls,
      encode,
      byteDigest,
      zip,
      archives,
      artifactRows,
      logs,
      artifactHttp,
      iso,
      plannerMarker,
    } = await createFreshMatrixArchives(
      r,
      planner,
      results,
      archive,
      noStart17,
      historicalRuntimeIsolation,
      nativeScopedOnly,
    );
    const originalPreservers = [...r.github.values()].map((port) =>
      port.preserveCandidate.bind(port)
    );
    for (const port of r.github.values()) {
      port.preserveCandidate = () =>
        Promise.resolve(
          portError("unavailable", "injected preservation outage"),
        );
    }
    let isolationWriteFailure: "conflict" | "ambiguous" | null = null;
    const aggregate = async function (
      name: string,
      available: boolean | (() => boolean),
      carrier?: { planDigest: string },
      options: MatrixAggregateOptionsV1 = { maxWaitMs: 0 },
      allow: (row: Record<string, unknown>) => boolean = () => true,
    ) {
      const deps = await r.job(name, "repair");
      if (name === "later-run") {
        deps.composeGithub = (config) => {
          const port = r.github.get(
            config.repository.owner + "/" + config.repository.name,
          )!;
          const source = deps.workDir + "/.sentinel-actions-state/" +
            (config.repository.name === "sentinel"
              ? "source"
              : "sources/ubiquity-ai.ubq.fi");
          const original =
            originalPreservers[config.repository.name === "sentinel" ? 0 : 1]!;
          port.preserveCandidate = async (request) => {
            assert.equal(
              (await gitRun(source, [
                "cat-file",
                "-e",
                request.candidate.head + "^{commit}",
              ], r.env)).ok,
              true,
              "real authenticated old-wave transport must hydrate before publication",
            );
            return original(request);
          };
          return port;
        };
      }
      const oldCwd = Deno.cwd();
      let result: { status: string } | null = null;
      Deno.chdir(deps.workDir);
      try {
        result = await runActionsRepairHost({
          ...deps,
          ...(noStart17 ? { state: r.store } : {}),
          artifactHttp: artifactHttp(
            typeof available === "function" ? available : () => available,
            allow,
          ),
          model: {
            modelId: "gpt-reserve",
            runModel: () => {
              throw Error("aggregate must not implement");
            },
          },
          runTargetCycles: (input) =>
            runActionsMatrixAggregateCycles(
              {
                ...input,
                modelStartsEnabled: false,
                ...(isolationWriteFailure === null ? {} : {
                  state: {
                    ...input.state,
                    readRepair: () => input.state.readRepair(),
                    readRelease: () => input.state.readRelease(),
                    writeRepair: () =>
                      Promise.resolve(
                        portOk({
                          status: isolationWriteFailure!,
                          currentHead: beforeHead,
                        }),
                      ),
                  },
                }),
              },
              undefined,
              carrier,
              options,
            ),
        });
      } finally {
        Deno.chdir(oldCwd);
      }
      return result;
    };
    if (historicalRuntimeIsolation) {
      const custody = structuredClone(before.value.snapshot);
      const oldWork = custody.work.find((row) =>
        row.repository.name === "ai.ubq.fi"
      )!;
      const oldCharge = custody.reservations.find((row) =>
        row.id === oldWork.intent!.requestId
      )!;
      assert.ok(oldCharge.createdAt <= planner.plan.plannedAt);
      const originalArchives = [...archives].map((
        [id, value],
      ) => [id, value.slice()]);
      [...r.github.values()].forEach((port, index) => {
        port.preserveCandidate = originalPreservers[index]!;
      });
      for (const failure of ["conflict", "ambiguous"] as const) {
        isolationWriteFailure = failure;
        await assert.rejects(
          aggregate("isolation-" + failure, true),
          /isolation CAS incomplete/,
        );
        assert.deepEqual(
          await r.store.readRepair(),
          before,
          "CAS failure cannot change either wave's custody or publish a sibling",
        );
      }
      isolationWriteFailure = null;
      const oldArtifact = artifactRows.find((row) => row.id === 504)!;
      const provenance = oldArtifact.workflow_run;
      oldArtifact.workflow_run = { id: 999 };
      await assert.rejects(
        aggregate("isolation-forged-native", true),
        /provenance unavailable or conflicting/,
      );
      assert.deepEqual(await r.store.readRepair(), before);
      oldArtifact.workflow_run = provenance;
      // The parser permits a blocked historical row to retain a stale request
      // ID. It is not the admitted work and its blocker must stay untouched.
      const unrelated = markBlocked(
        {
          ...structuredClone(oldWork),
          id: "unrelated-foreign-blocked" as WorkItemId,
          source: { ...oldWork.source, id: "999" },
          related: { ...oldWork.related, issueNumber: 999 },
        },
        "other",
        "merge_not_observed",
        r.clock.now(),
      );
      const seeded = await r.store.writeRepair(
        parseRepairStateSnapshotV1({
          ...before.value.snapshot,
          stateHead: beforeHead,
          sequence: before.value.snapshot.sequence + 1,
          work: [...before.value.snapshot.work, unrelated],
        }),
        beforeHead,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      await aggregate("historical-runtime-isolation", true);
      const after = await r.store.readRepair();
      assert.ok(after.ok && after.value.status === "found");
      const isolated = after.value.snapshot.work.find((row) =>
        row.id === oldWork.id
      )!;
      assert.deepEqual(
        after.value.snapshot.work.find((row) => row.id === unrelated.id),
        unrelated,
        "an unrelated blocked row sharing the stale request ID is byte-identical",
      );
      assert.equal(isolated.nextStep, "blocked");
      assert.match(isolated.blocker!.message, /historical.*runtime mismatch/);
      assert.deepEqual(isolated.intent, oldWork.intent);
      assert.deepEqual(isolated.target, oldWork.target);
      assert.deepEqual(isolated.evidence, oldWork.evidence);
      assert.deepEqual(isolated.counters, oldWork.counters);
      assert.deepEqual(
        after.value.snapshot.reservations.find((row) =>
          row.id === oldCharge.id
        ),
        oldCharge,
      );
      const sibling = after.value.snapshot.work.find((row) =>
        row.repository.name === "sentinel"
      )!;
      assert.ok(
        sibling.target.head !== null && sibling.target.pr !== null,
        "unrelated authenticated wave publishes through the real aggregate lifecycle",
      );
      assert.ok(
        r.github.get("ubiquity-sentinel/sentinel")!.calls.some((call) =>
          call.startsWith("push:")
        ),
      );
      assert.ok(
        !r.github.get("ubiquity/ai.ubq.fi")!.calls.some((call) =>
          call.startsWith("push:")
        ),
        "rejected result must never be imported or published",
      );
      assert.deepEqual(
        [...archives],
        originalArchives,
        "original forensic archives remain unchanged",
      );
      assert.equal(
        cellRun.modelCalls,
        2,
        "isolation adds no model start or refund",
      );
      return;
    }
    if (progressive !== "none") {
      const fast = results[0]!;
      const slow = results[1]!;
      // `short` is the single-scan contract again, with a consumer window
      // shorter than one whole scan budget instead of none at all.
      const single = progressive === "single" || progressive === "short";
      const fastName = "sentinel-matrix-cell-71-1-" + fast.cellId;
      const slowName = "sentinel-matrix-cell-71-1-" + slow.cellId;
      const observed: { fast: boolean; slow: boolean }[] = [];
      const waits: number[] = [];
      let listings = 0;
      // Availability advances on each authenticated artifact listing: the fast
      // sibling appears only after the first empty scan, the slow sibling only
      // after the consumer has already consumed the fast one. The single-scan
      // mode exposes the fast cell immediately and never the slow one.
      const available = () => {
        listings += 1;
        return true;
      };
      const allow = (row: Record<string, unknown>) => {
        const name = String(row["name"]);
        if (name === fastName) {
          return single ||
            (progressive === "settle" && listings >= 2);
        }
        if (name === slowName) return progressive === "settle" && listings >= 4;
        return true;
      };
      const options: MatrixAggregateOptionsV1 = single
        ? {
          maxWaitMs: progressive === "short"
            ? MATRIX_ARTIFACT_RECOVERY_MAX_MS - 1
            : 0,
          pollWait: (ms) => {
            waits.push(ms);
            r.clock.advance(ms);
            return Promise.resolve();
          },
        }
        : {
          // Scans start at 0, 60 and 120 s: a later scan starts only with its
          // whole scan budget still inside the window.
          maxWaitMs: 120_000 + MATRIX_ARTIFACT_RECOVERY_MAX_MS,
          pollWait: async (ms) => {
            waits.push(ms);
            r.clock.advance(ms);
            const mid = await r.store.readRepair();
            assert.ok(mid.ok && mid.value.status === "found");
            if (!mid.ok || mid.value.status !== "found") {
              throw new Error("repair state unreadable");
            }
            const state = mid.value.snapshot;
            const intentOf = (taskId: string) =>
              state.work.find((row) => row.id === taskId)?.intent?.kind ?? null;
            const reservationOf = (taskId: string) =>
              state.reservations.find((row) => row.taskId === taskId);
            // Ingestion itself preserves the charge/attempt/retry/review
            // accounting and adds no stalled execution: this snapshot is read
            // before the ordinary lifecycle runs.
            for (const record of state.work) {
              const prior = beforeWork.find((row) => row.id === record.id);
              assert.ok(prior);
              assert.equal(record.counters.attempts, prior.counters.attempts);
              assert.equal(record.counters.retries, prior.counters.retries);
              assert.equal(
                record.counters.reviewRounds,
                prior.counters.reviewRounds,
              );
              assert.equal(record.counters.stalled ?? 0, 0);
            }
            observed.push({
              fast: intentOf(fast.taskId) === "candidate_preservation",
              slow: intentOf(slow.taskId) === "candidate_preservation",
            });
            if (progressive === "missing") {
              // A live producer whose artifact has not arrived keeps its exact
              // implementation intent, charged reservation and no blocker.
              assert.equal(intentOf(fast.taskId), "implementation");
              assert.equal(intentOf(slow.taskId), "implementation");
              assert.equal(reservationOf(fast.taskId)?.outcome, "reserved");
              assert.equal(reservationOf(slow.taskId)?.outcome, "reserved");
              for (const record of state.work) {
                assert.equal(record.nextStep, "work");
                assert.equal(record.blocker, null);
                assert.equal(record.wait, null);
              }
            }
          },
        };
      const result = await aggregate(
        "progressive",
        available,
        { planDigest: planner.planDigest },
        options,
        allow,
      );
      assert.equal(result?.status, "ran");
      if (single) {
        // The documented maxWaitMs 0 contract is exactly one authenticated
        // recovery, even though that recovery consumed the fast cell. A window
        // shorter than one whole scan budget is the same: a later scan that
        // reached the window's end mid-download would refuse the whole run.
        assert.deepEqual(waits, [], "a window this short never waits");
        assert.equal(
          listings,
          1,
          "a window this short performs exactly one authenticated recovery",
        );
      } else {
        assert.deepEqual(waits, [60_000, 60_000]);
      }
      const final = await r.store.readRepair();
      assert.ok(final.ok && final.value.status === "found");
      if (!final.ok || final.value.status !== "found") {
        throw new Error("repair state unreadable");
      }
      // Bind the narrowed found snapshot once: the stalled lookup below runs
      // inside a closure where the assertion narrowing is not retained.
      const finalWork: ReturnType<typeof workRecord>[] = final.value
        .snapshot.work;
      assert.equal(cellRun.modelCalls, 2, "consumption never starts a model");
      assert.deepEqual(
        final.value.snapshot.reservations.map((row) => [
          row.id,
          row.attempt,
          row.purpose,
        ]),
        before.value.snapshot.reservations.map((row) => [
          row.id,
          row.attempt,
          row.purpose,
        ]),
        "no refund, duplicate reservation or extra admission",
      );
      // Ingestion never changes the charge/attempt/retry/review accounting.
      assert.deepEqual(
        final.value.snapshot.work.map((row) => ({
          attempts: row.counters.attempts,
          retries: row.counters.retries,
          reviewRounds: row.counters.reviewRounds,
        })),
        before.value.snapshot.work.map((row) => ({
          attempts: row.counters.attempts,
          retries: row.counters.retries,
          reviewRounds: row.counters.reviewRounds,
        })),
        "ingestion preserves attempt/retry/review accounting",
      );
      // The ordinary lifecycle that follows is deterministic
      // unavailable-publication bookkeeping: each ingested candidate whose
      // preservation read is unavailable re-arms its wait and is counted as
      // exactly one stalled execution, while a still-unconsumed live producer
      // is deferred without any persistence at all.
      const stalledOf = (taskId: string) =>
        finalWork.find((row) => row.id === taskId)?.counters.stalled ?? 0;
      if (progressive === "settle") {
        assert.equal(
          stalledOf(fast.taskId),
          1,
          "each ingested candidate re-armed one unavailable wait",
        );
        assert.equal(stalledOf(slow.taskId), 1);
      } else if (single) {
        assert.equal(
          stalledOf(fast.taskId),
          1,
          "the ingested candidate was stalled exactly once",
        );
        assert.equal(
          stalledOf(slow.taskId),
          0,
          "the unconsumed live producer was never persisted",
        );
      } else {
        assert.equal(stalledOf(fast.taskId), 0);
        assert.equal(stalledOf(slow.taskId), 0);
      }
      if (progressive === "settle") {
        // The first scan was empty and never completion; the fast cell was then
        // consumed while its slower sibling was still a live charged producer.
        assert.deepEqual(observed, [
          { fast: false, slow: false },
          { fast: true, slow: false },
        ]);
        for (const cell of [fast, slow]) {
          const record: ReturnType<typeof workRecord> | undefined = final.value
            .snapshot.work.find((row) => row.id === cell.taskId);
          assert.ok(record);
          assert.equal(record.intent?.kind, "candidate_preservation");
          assert.equal(record.blocker, null);
          assert.equal(record.nextStep, "work");
          assert.equal(
            record.target.head,
            cell.receipt?.candidate?.head ?? null,
            "the exact authenticated candidate head is preserved",
          );
        }
        assert.ok(
          final.value.snapshot.reservations.every((row) =>
            row.outcome === "submitted" && row.settledAt !== null
          ),
          "each cell is settled exactly once by real ingestion",
        );
      } else if (single) {
        // One recovery consumed the fast cell; the slower live producer keeps
        // its exact charge and intent because the window had already closed.
        const fastRecord: ReturnType<typeof workRecord> | undefined = final
          .value.snapshot.work.find((row) => row.id === fast.taskId);
        assert.ok(fastRecord);
        assert.equal(fastRecord.intent?.kind, "candidate_preservation");
        assert.equal(
          fastRecord.target.head,
          fast.receipt?.candidate?.head ?? null,
          "the exact authenticated candidate head is preserved",
        );
        const slowRecord: ReturnType<typeof workRecord> | undefined = final
          .value.snapshot.work.find((row) => row.id === slow.taskId);
        assert.ok(slowRecord);
        assert.equal(slowRecord.intent?.kind, "implementation");
        assert.equal(slowRecord.nextStep, "work");
        assert.equal(slowRecord.blocker, null);
        assert.equal(
          final.value.snapshot.reservations.find((row) =>
            row.taskId === slow.taskId
          )?.outcome,
          "reserved",
          "the slower live producer stays charged and unresolved",
        );
      } else {
        assert.ok(observed.every((entry) => !entry.fast && !entry.slow));
        assert.deepEqual(
          final.value.snapshot.reservations,
          before.value.snapshot.reservations,
          "a live producer without an artifact stays charged and unresolved",
        );
        for (const record of final.value.snapshot.work) {
          assert.equal(record.intent?.kind, "implementation");
          assert.equal(record.nextStep, "work");
          assert.equal(record.blocker, null);
        }
      }
      return;
    }
    const digestControl = await r.store.readRepair();
    assert.ok(digestControl.ok && digestControl.value.status === "found");
    if (nativeScopedOnly) {
      await aggregate("native-scoped", true, {
        planDigest: planner.planDigest,
      });
      assert.ok(
        artifactCalls.some((url) =>
          new URL(url).pathname ===
            "/repos/ubiquity-sentinel/sentinel/actions/runs/71/artifacts"
        ),
      );
      assert.ok(
        !artifactCalls.some((url) =>
          new URL(url).pathname ===
            "/repos/ubiquity-sentinel/sentinel/actions/artifacts"
        ),
      );
      const imported = await r.store.readRepair();
      assert.ok(imported.ok && imported.value.status === "found");
      assert.equal(
        imported.value.snapshot.work.filter((row) =>
          row.target.head !== null &&
          row.intent?.kind === "candidate_preservation"
        ).length,
        2,
      );
      assert.equal(
        cellRun.modelCalls,
        2,
        "only isolated fake model cells ran; aggregate never starts inference",
      );
      return;
    }
    if (noStart17) {
      const setPlan = async (plan: typeof planner.plan) => {
        const bytes = await zip([{ name: "plan.json", content: encode(plan) }]);
        archives.set(501, bytes);
        artifactRows[0].size_in_bytes = bytes.length;
        artifactRows[0].digest = "sha256:" + await byteDigest(bytes);
        logs.set(
          401,
          iso + " " +
            JSON.stringify({
              ...plannerMarker,
              planDigest: await matrixDigestV1(plan),
            }) + "\n",
        );
      };
      for (
        const [name, plannedAt] of [
          ["early-historical-plan", initialPlanTime],
          [
            "reservation-after-plan",
            Math.max(
              ...before.value.snapshot.reservations.map((row) => row.createdAt),
            ) - 1,
          ],
          ["future-plan", r.clock.now() + 2000],
        ] as const
      ) {
        await setPlan({ ...planner.plan, plannedAt });
        await assert.rejects(
          aggregate(name, true),
          /matrix artifact provenance/,
        );
        assert.deepEqual(
          await r.store.readRepair(),
          digestControl,
          "chronology refusal preserves every charge and intent",
        );
      }
      await setPlan(planner.plan);
      await assert.rejects(
        aggregate("no-start-digest-conflict", true, {
          planDigest: "f".repeat(64),
        }),
        /differs from native planner output/,
      );
      assert.deepEqual(await r.store.readRepair(), digestControl);
      await aggregate("aggregate", true, { planDigest: planner.planDigest });
      const ingested = await r.store.readRepair();
      assert.ok(ingested.ok && ingested.value.status === "found");
      assert.equal(ingested.value.snapshot.work.length, 17);
      assert.ok(
        ingested.value.snapshot.work.every((row) =>
          row.nextStep === "work" &&
          row.intent?.kind === "candidate_preservation" &&
          row.target.head !== null && row.target.pr === null
        ),
        "every completed cell is ingested as authenticated candidate preservation while the injected preservation outage holds",
      );
      assert.equal(ingested.value.snapshot.reservations.length, 17);
      assert.ok(
        ingested.value.snapshot.reservations.every((row) =>
          row.outcome === "submitted" && row.settledAt !== null
        ),
        "each authenticated cell settles its exact implementation charge once",
      );
      assert.equal(
        new Set(ingested.value.snapshot.reservations.map((row) => row.id)).size,
        17,
        "every durable admission keeps a unique reservation identity",
      );
      assert.equal(
        new Set(ingested.value.snapshot.work.map((row) => row.intent?.key))
          .size,
        17,
        "every durable admission keeps a unique implementation intent",
      );
      // Identity, source and evidence survive admission, execution and ingestion
      // (intent and target legitimately advance to the authenticated candidate
      // head while publication stays unavailable). Accounting is the exact
      // projection proven by the progressive fixture: attempts/retries/
      // reviewRounds unchanged and exactly one stalled execution per ingested
      // candidate from the deterministic unavailable-publication bookkeeping.
      assert.deepEqual(
        ingested.value.snapshot.work.map((row) => ({
          attempts: row.counters.attempts,
          retries: row.counters.retries,
          reviewRounds: row.counters.reviewRounds,
        })),
        before.value.snapshot.work.map((row) => ({
          attempts: row.counters.attempts,
          retries: row.counters.retries,
          reviewRounds: row.counters.reviewRounds,
        })),
        "ingestion preserves attempt/retry/review accounting",
      );
      for (const record of before.value.snapshot.work) {
        const settledRecord: ReturnType<typeof workRecord> = ingested.value
          .snapshot.work.find((row) => row.id === record.id)!;
        assert.deepEqual(settledRecord.source, record.source);
        assert.deepEqual(settledRecord.evidence, record.evidence);
        assert.equal(
          settledRecord.counters.stalled ?? 0,
          1,
          "each ingested candidate re-armed exactly one unavailable wait",
        );
      }
      assert.ok(
        before.value.snapshot.reservations.every((row) =>
          row.createdAt <= planner.plan.plannedAt
        ),
        "plannedAt freezes after every durable admission",
      );
      assert.equal(
        await matrixDigestV1(
          JSON.parse(
            await Deno.readTextFile(
              r.root + "/plan/.sentinel-matrix/plan.json",
            ),
          ),
        ),
        planner.planDigest,
      );
      await aggregate("idempotent", true);
      assert.deepEqual(await r.store.readRepair(), ingested);
      assert.equal(cellRun.modelCalls, expectedCells);
      return;
    }
    await assert.rejects(
      aggregate("native-digest-conflict", true, { planDigest: "f".repeat(64) }),
      /differs from native planner output/,
    );
    const afterDigestControl = await r.store.readRepair();
    assert.ok(
      afterDigestControl.ok && afterDigestControl.value.status === "found",
    );
    assert.equal(
      afterDigestControl.value.snapshot.sequence,
      digestControl.value.snapshot.sequence,
    );
    await aggregate("aggregate", true, { planDigest: planner.planDigest });
    const ingested = await r.store.readRepair();
    assert.ok(ingested.ok && ingested.value.status === "found");
    assert.ok(
      ingested.value.snapshot.work.every((row) =>
        row.intent?.kind === "candidate_preservation" &&
        row.target.head !== null && row.target.pr === null
      ),
    );
    const settledCharges = ingested.value.snapshot.reservations.filter((row) =>
      row.purpose === "implementation"
    );
    assert.ok(settledCharges.every((row) => row.outcome === "submitted"));
    await Deno.remove(r.root + "/aggregate", { recursive: true });
    r.clock.advance(300001);
    for (const port of r.github.values()) {
      port.preserveCandidate = () =>
        Promise.resolve(
          portError("not_found", "exact Git candidate object is absent"),
        );
    }
    await aggregate("missing-artifact", false, undefined, { maxWaitMs: 0 });
    const missing = await r.store.readRepair();
    assert.ok(missing.ok && missing.value.status === "found");
    assert.deepEqual(
      missing.value.snapshot.work.map((row) => row.target),
      ingested.value.snapshot.work.map((row) => row.target),
    );
    assert.ok(
      missing.value.snapshot.work.every((row) =>
        row.intent?.kind === "candidate_preservation"
      ),
    );
    assert.deepEqual(
      missing.value.snapshot.reservations,
      ingested.value.snapshot.reservations,
      "missing artifacts never refund, resettle or reserve another start",
    );
    await Deno.remove(r.root + "/missing-artifact", { recursive: true });
    r.clock.advance(300001);
    await r.advanceRun(72);
    [...r.github.values()].forEach((port, index) => {
      port.preserveCandidate = originalPreservers[index]!;
    });
    await aggregate("later-run", true, undefined, { maxWaitMs: 0 });
    assert.equal(
      cellRun.modelCalls,
      2,
      "later-wave hydration never starts another implementation",
    );
    assert.ok(
      artifactCalls.some((url) =>
        new URL(url).pathname ===
          "/repos/ubiquity-sentinel/sentinel/actions/artifacts"
      ),
      "actual consumer must enumerate authenticated prior waves",
    );
    assert.ok(artifactCalls.some((url) => url.includes("/runs/71/attempts/1")));
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.ok(
      after.value.snapshot.work.every((row) =>
        row.target.head !== null && row.target.pr !== null
      ),
    );
    assert.equal(
      after.value.snapshot.reservations.filter((row) =>
        row.purpose === "implementation"
      ).length,
      2,
    );
    assert.ok(
      [...r.github.values()].every((port) =>
        port.calls.some((call) => call.startsWith("push:"))
      ),
    );
    assert.equal(await matrixDigestV1(planner.plan), planner.planDigest);
  } finally {
    await r.cleanup();
  }
}
