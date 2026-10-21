/**
 * The progressive matrix consumer of an App-token-bounded repair run still
 * leaves every serial target cycle a review start window.
 */
import assert from "node:assert/strict";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import {
  APP_TOKEN_SAFE_WINDOW_MS,
  deriveAppTokenNotAfterV1,
} from "../../src/host/hosted-app-token-window.ts";
import {
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import { matrixConsumerWindowV1 } from "../../src/host/matrix-aggregate.ts";
import { MATRIX_ARTIFACT_RECOVERY_MAX_MS } from "../../src/host/matrix-artifact-port.ts";
import {
  OPERATION_MARGIN_MS,
  REVIEW_BOUND_MS,
} from "../../src/repair/loop-bounds.ts";
import { gen76Available, loadGen76Parsers } from "../state/gen76-contracts.ts";
import { rig } from "./matrix-actions-fixtures.ts";

const MINUTE = 60_000;
/** Mint to child origin: the launcher's release read and the child's start. */
const MINT_TO_ORIGIN_MS = 3 * MINUTE;
/** Intake, base reads and publication a target needs before its review. */
const REVIEW_LEAD_MS = 5 * MINUTE;
/**
 * An earlier target's own review, which its cycle drains before the next
 * target's cycle can start. Live: 31 sentinel review receipts took 6.6
 * minutes from submission to completion at the median, about 10 at p75 and
 * 18.4 at most; this scenario drains the p75 review.
 */
const EARLIER_REVIEW_DRAIN_MS = 10 * MINUTE;

interface CycleCallV1 {
  slug: string;
  at: number;
  deadline: number;
  modelStartsEnabled: boolean;
}

/**
 * Plan live cells for both committed targets, then run the REAL repair host
 * and the REAL progressive consumer over them. Only external boundaries are
 * fake: the artifact transport never finds a completed cell (every producer
 * stays live), the poll wait advances the injected clock, and each target
 * cycle records when it starts, spends `REVIEW_LEAD_MS` before its review and,
 * for every target but the last, drains its own `EARLIER_REVIEW_DRAIN_MS`
 * review before the next target's cycle. A nonzero `scanMs` is the time one
 * authenticated artifact download takes: like the real transport, a scan
 * whose own deadline elapses first refuses the whole scan.
 */
async function runScenario(
  tokenWindow: boolean,
  mintLeadMs = MINT_TO_ORIGIN_MS,
  scanMs = 0,
) {
  const r = await rig();
  try {
    const planned = await runActionsMatrixHost({
      ...await r.job("window-plan", "matrix_plan"),
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("planner cannot infer")),
      },
    });
    assert.ok("plan" in planned);
    assert.deepEqual(
      [...new Set(planned.plan.cells.map((cell) => cell.repository.name))]
        .sort(),
      ["ai.ubq.fi", "sentinel"],
      "both targets have a live charged cell",
    );
    const before = await r.store.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    const origin = r.clock.now();
    const notAfter = deriveAppTokenNotAfterV1(
      String(origin - mintLeadMs),
      origin,
    );
    const deps = await r.job("window-aggregate", "repair");
    const scans: number[] = [];
    const scanDeadlines: (number | undefined)[] = [];
    const waits: number[] = [];
    const cycles: CycleCallV1[] = [];
    let supplied: number | null = null;
    const result = await runActionsRepairHost({
      ...deps,
      env: {
        ...deps.env,
        ...(tokenWindow && notAfter !== undefined
          ? { SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER: String(notAfter) }
          : {}),
      },
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("aggregate cannot infer")),
      },
      runTargetCycles: (input) => {
        supplied = input.deadline;
        return runActionsMatrixAggregateCycles(
          {
            ...input,
            runCycle: (cycleDeps, options) => {
              const repository = cycleDeps.configs[0]!.repository;
              cycles.push({
                slug: repository.owner + "/" + repository.name,
                at: r.clock.now(),
                deadline: options.deadline,
                modelStartsEnabled: options.modelStartsEnabled !== false,
              });
              r.clock.advance(REVIEW_LEAD_MS);
              if (cycles.length < input.configs.length) {
                r.clock.advance(EARLIER_REVIEW_DRAIN_MS);
              }
              return Promise.resolve({ status: "idle", detail: "fixture" });
            },
          },
          {
            recover: (request) => {
              const at = r.clock.now();
              scans.push(at);
              scanDeadlines.push(request.deadline);
              if (scanMs === 0) return Promise.resolve([]);
              const until = request.deadline ?? Number.POSITIVE_INFINITY;
              if (at + scanMs > until) {
                r.clock.advance(Math.max(0, until - at));
                return Promise.reject(
                  new Error(
                    "matrix artifact provenance unavailable or conflicting",
                  ),
                );
              }
              r.clock.advance(scanMs);
              return Promise.resolve([]);
            },
          },
          { planDigest: planned.planDigest },
          {
            pollWait: (ms) => {
              waits.push(ms);
              r.clock.advance(ms);
              return Promise.resolve();
            },
          },
        );
      },
    });
    assert.equal(result.status, "ran");
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    const release = await r.release.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    return {
      origin,
      notAfter,
      supplied: supplied as number | null,
      scans,
      scanDeadlines,
      waits,
      cycles,
      before: before.value.snapshot,
      after: after.value.snapshot,
      release: release.value.snapshot,
    };
  } finally {
    await r.cleanup();
  }
}

/** The loop's own latest review start for a cycle given `deadline`. */
function latestReviewStart(deadline: number): number {
  // `runRepairEntrypoint` hands the loop `deadline - OPERATION_MARGIN_MS`, and
  // a review request must then fit its full bound before one more margin.
  return deadline - 2 * OPERATION_MARGIN_MS - REVIEW_BOUND_MS;
}

Deno.test("matrix consumer: live cells in an App-token-bounded run still leave the second target a review start window", async () => {
  // Live: the repair job's ONE App token bounds the run to under an hour of
  // GitHub work, while the consumer waited up to 20 minutes for live cells and
  // the targets then ran serially (sentinel first), so ai.ubq.fi reached its
  // cycle after its last review start had already passed.
  const run = await runScenario(true);
  assert.ok(run.notAfter !== undefined);
  assert.equal(run.supplied, run.notAfter, "the token window is the deadline");
  assert.deepEqual(run.cycles.map((cycle) => cycle.slug), [
    "ubiquity-sentinel/sentinel",
    "ubiquity/ai.ubq.fi",
  ]);
  for (const cycle of run.cycles) {
    assert.equal(cycle.deadline, run.notAfter);
    assert.equal(cycle.modelStartsEnabled, true, "reviews may start");
  }
  // The consumer still polled the live producers (about three minutes here),
  // each later scan starting with its whole scan budget before the cutoff.
  assert.ok(run.waits.length >= 3, JSON.stringify(run.waits));
  assert.ok(run.scans.length === run.waits.length + 1);
  // Live: sentinel's own review drain (median 6.6 minutes, p75 about 10)
  // pushed ai.ubq.fi past its last review start; it still requests one.
  const first = run.cycles[0]!;
  const second = run.cycles[1]!;
  assert.equal(
    second.at - first.at,
    REVIEW_LEAD_MS + EARLIER_REVIEW_DRAIN_MS,
    "the earlier target drained its own review first",
  );
  const latest = latestReviewStart(second.deadline);
  assert.ok(
    second.at + REVIEW_LEAD_MS < latest,
    `second target starts at +${(second.at - run.origin) / MINUTE}m with ` +
      `its last review start at +${(latest - run.origin) / MINUTE}m`,
  );
  // Live cells the consumer stopped waiting for stay charged and unresolved
  // for a later recovery: nothing is refunded or terminalized.
  assert.deepEqual(run.after.reservations, run.before.reservations);
  assert.deepEqual(run.after.work, run.before.work);
});

Deno.test("matrix consumer: a run without a token window keeps the full consumer window", async () => {
  const run = await runScenario(false);
  assert.ok(run.supplied !== null && run.supplied >= run.origin + 110 * MINUTE);
  // The unchanged 20-minute window: the last scan starts with its whole
  // scan budget before it ends.
  assert.equal(
    run.scans.at(-1),
    run.origin + 20 * MINUTE - MATRIX_ARTIFACT_RECOVERY_MAX_MS,
  );
  assert.equal(run.cycles.length, 2);
  assert.ok(
    run.cycles[1]!.at + REVIEW_LEAD_MS <
      latestReviewStart(run.cycles[1]!.deadline),
  );
  assert.deepEqual(run.after.reservations, run.before.reservations);
});

Deno.test("matrix consumer: a spent review reserve never stretches the initial scan past the consumer window", async () => {
  // Setup ran long: six minutes of the token window remain, so no target can
  // start a review and the consumer does not poll. Its one mandatory initial
  // scan keeps the consumer's own window (the lifecycle margin before the
  // deadline, one minute away), exactly as before the review reserve existed,
  // instead of the whole remaining run deadline. The transport also applies
  // its own two-minute scan budget, so only this tight case can tell them
  // apart.
  const run = await runScenario(true, 52 * MINUTE);
  assert.equal(run.supplied, run.origin + 6 * MINUTE);
  assert.deepEqual(run.waits, [], "no polling once the reserve is spent");
  assert.deepEqual(run.scanDeadlines, [run.origin + MINUTE]);
  assert.deepEqual(run.after.reservations, run.before.reservations);
});

Deno.test("matrix consumer: a review cutoff seconds after the mandatory initial scan starts never cuts that scan short", async () => {
  // The review reserve the consumer keeps before the run deadline for two
  // targets, read off a deadline far beyond any polling window.
  const far = 10_000 * MINUTE;
  const reserve = far - matrixConsumerWindowV1({
    now: 0,
    deadline: far,
    maxWaitMs: far,
    targets: 2,
    reviewsMayStart: true,
  }).until;
  // Setup ran long enough that the consumer's review cutoff lies only five
  // seconds after its start, while one authenticated download of the charged
  // cells takes thirty. Bounded by that cutoff, the mandatory initial scan
  // timed out, the transport refused it ("matrix artifact provenance
  // unavailable or conflicting") and the repair run failed with no target
  // cycle: in a runtime's first trial, a rollback.
  const cutoffAfterStart = 5_000;
  const run = await runScenario(
    true,
    APP_TOKEN_SAFE_WINDOW_MS - reserve - cutoffAfterStart,
    30_000,
  );
  assert.ok(run.notAfter !== undefined);
  const cutoff = run.notAfter - reserve;
  assert.equal(run.scans.length, 1, "the consumer does not poll past it");
  const [started] = run.scans;
  assert.ok(started! < cutoff && cutoff - started! <= cutoffAfterStart);
  // The initial scan keeps the consumer's own window, so only the
  // transport's own two-minute scan budget bounds it.
  assert.deepEqual(run.scanDeadlines, [
    started! + MATRIX_ARTIFACT_RECOVERY_MAX_MS,
  ]);
  assert.deepEqual(run.cycles.map((cycle) => cycle.slug), [
    "ubiquity-sentinel/sentinel",
    "ubiquity/ai.ubq.fi",
  ]);
  // Its live cells stay charged and unresolved for a later recovery.
  assert.deepEqual(run.after.reservations, run.before.reservations);
  assert.deepEqual(run.after.work, run.before.work);
});

Deno.test("matrix consumer: a later scan starts only with its whole scan budget before the review cutoff", async () => {
  const far = 10_000 * MINUTE;
  const reserve = far - matrixConsumerWindowV1({
    now: 0,
    deadline: far,
    maxWaitMs: far,
    targets: 2,
    reviewsMayStart: true,
  }).until;
  // Every authenticated download of the live cells takes 2.5 s and finds no
  // completed artifact, so the consumer polls once. In the tight case the
  // scan after that poll would start 1.5 s before the review cutoff: its
  // download reached the cutoff, the transport refused it ("matrix artifact
  // provenance unavailable or conflicting") and the repair run failed with
  // no target cycle (in a runtime's first trial, a rollback). With exactly
  // one whole scan budget left after the poll, that later scan still runs.
  const scanMs = 2_500;
  for (
    const [leftAtLaterScan, scans] of [
      [1_500, 1],
      [MATRIX_ARTIFACT_RECOVERY_MAX_MS, 2],
    ] as const
  ) {
    const cutoffAfterStart = scanMs + 60_000 + leftAtLaterScan;
    const run = await runScenario(
      true,
      APP_TOKEN_SAFE_WINDOW_MS - reserve - cutoffAfterStart,
      scanMs,
    );
    assert.ok(run.notAfter !== undefined);
    const cutoff = run.notAfter - reserve;
    assert.equal(run.scans[0], cutoff - cutoffAfterStart);
    assert.equal(run.scans.length, scans, `${leftAtLaterScan} ms left`);
    assert.equal(run.waits.length, scans - 1);
    for (const [index, started] of run.scans.entries()) {
      if (index === 0) continue;
      assert.ok(started + MATRIX_ARTIFACT_RECOVERY_MAX_MS <= cutoff);
      assert.equal(run.scanDeadlines[index], cutoff);
    }
    assert.deepEqual(run.cycles.map((cycle) => cycle.slug), [
      "ubiquity-sentinel/sentinel",
      "ubiquity/ai.ubq.fi",
    ]);
    // The live cells stay charged and unresolved for a later recovery.
    assert.deepEqual(run.after.reservations, run.before.reservations);
    assert.deepEqual(run.after.work, run.before.work);
  }
});

Deno.test({
  name:
    "matrix consumer: every snapshot a token-bounded consumer run leaves parses under the rollback generation",
  ignore: !await gen76Available(),
  fn: async () => {
    const run = await runScenario(true);
    const gen76 = await loadGen76Parsers();
    // The strict generation-76 parsers reject unknown keys and enum values:
    // the exact JSON this run leaves must round-trip through them unchanged.
    const repair = JSON.parse(JSON.stringify(run.after));
    assert.deepEqual(gen76.parseRepairStateSnapshotV1(repair), repair);
    const release = JSON.parse(JSON.stringify(run.release));
    assert.deepEqual(gen76.parseReleaseStateSnapshotV1(release), release);
  },
});
