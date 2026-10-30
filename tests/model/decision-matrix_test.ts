/**
 * Formal check that the Sentinel decision matrix never jams, or a precise
 * list of where it does.
 *
 * A record JAMS when, for an open issue (and open Sentinel PR):
 * - J1: it reaches an absorbing state that is not terminal by design and
 *   nothing tells the owner a human is needed (no per-pass maintenance line);
 * - J2: it changes forever in a cycle no ranking bounds (review rounds, CI
 *   fixes, refresh failures, carried refreshes, the reservation budget, the
 *   once-per-head re-run), in a cooperative world, an adversarial world
 *   (CI/base/merge outcomes chosen against it) or after an owner action;
 * - J3: it is eligible but a per-pass cap or ordering gives its slot to
 *   others forever.
 *
 * Part A (`census.ts`) drives every blocked class through the REAL
 * maintenance pass; Part B (`pipeline.ts`, `explore.ts`) explores the
 * lifecycle model whose decisions are the real pure policy; Part C
 * (`fleet.ts`) runs fleets larger than every cap through the real passes and
 * the real repair loop; Part D (`positives.ts`) proves the checker catches
 * the three jams already fixed, on their pre-fix code; Part E
 * (`pr-continuity.ts`) checks that review and delivery go back to the
 * record's OWN open pull request, never to a new one, except where listed.
 * Where a lifecycle step cannot be decided from pure code, its verdict comes
 * from the real repair loop (`review-intent.ts`: a lost review submission).
 *
 * `KNOWN_JAMS` (jams.ts) is the documented expected-failure list: the test
 * fails unless the checker finds exactly that set.
 */
import assert from "node:assert/strict";
import {
  BASE_REFRESH_CAPABILITY_DETAIL,
  failBaseRefresh,
  MAX_BASE_REFRESH_FAILURES,
} from "../../src/repair/loop-base-refresh-failure.ts";
import { baseRefreshIntentKey } from "../../src/repair/keys.ts";
import { loadRepairContext } from "../../src/repair/loop-state.ts";
import { isPassportWorkTrial } from "../../src/repair/passport-work-trial.ts";
import { queueRig } from "../repair/delivery-queue-rig.ts";
import { brokenAnchors } from "./anchors.ts";
import { PARK_CLASSES } from "./census-classes.ts";
import { explore, linkCensus, nonTerminating } from "./explore.ts";
import { retirementFairness } from "./fleet.ts";
import {
  type CheckerRunV1,
  KNOWN_JAMS,
  KNOWN_PR_REPLACEMENTS,
  runChecker,
} from "./jams.ts";
import { initialStates, VPS } from "./pipeline.ts";
import { outputBoundVerdict, preFixFixtureFaithful } from "./positives.ts";
import { reviewIntentVerdict } from "./review-intent.ts";
import { planHostedRetirements as preFixRetirements } from "./fixtures/closures-pre-01f482529.ts";
import {
  concretize,
  DEFAULT_SHAPE,
  GATEWAY,
  HOUR,
  NOW,
  SELF,
  TIP,
} from "./world.ts";

let checked: Promise<CheckerRunV1> | null = null;
function checker(): Promise<CheckerRunV1> {
  checked ??= runChecker();
  return checked;
}

Deno.test("decision matrix: the checker finds exactly KNOWN_JAMS on the current code", async () => {
  const started = performance.now();
  const run = await checker();
  const found = run.jams.map((jam) => jam.id).sort();
  console.log(
    JSON.stringify({
      ...run.stats,
      visibleOwnerParks: run.visibleParks.length,
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
  for (const jam of run.jams) {
    console.log(`${jam.id}\n  state: ${jam.state}\n  trace: ${jam.trace}`);
  }
  // Terminal by design: absorbing, but announced on every maintenance pass.
  for (const park of run.visibleParks) {
    console.log(
      `owner-visible park ${park.classId}@${park.variant} (${park.headCi}): ${
        park.lines.join(" ")
      }`,
    );
  }
  for (const leaf of run.visibleLeaves) {
    console.log(`owner-visible state ${leaf.phase}: ${leaf.lines.join(" ")}`);
  }
  for (const result of run.fairness) {
    console.log(`fairness ${result.id}: ${result.detail}`);
  }
  const known = [...KNOWN_JAMS].sort();
  assert.deepEqual(
    found.filter((id) => !known.includes(id)),
    [],
    "new jams: add them to KNOWN_JAMS (or fix them)",
  );
  assert.deepEqual(
    known.filter((id) => !found.includes(id)),
    [],
    "fixed jams: remove them from KNOWN_JAMS",
  );
});

Deno.test("decision matrix: every modeled fact still matches its source", async () => {
  await checker();
  await outputBoundVerdict("current");
  assert.deepEqual(await brokenAnchors(), []);
});

Deno.test("decision matrix: modeled repositories keep the real refresh-failure bound", async () => {
  const domain = [...new Set(initialStates().map((state) => state.repo))]
    .sort();
  assert.deepEqual(domain, ["gateway", "self"]);
  assert.equal(MAX_BASE_REFRESH_FAILURES, 3);
  // Passport is deliberately outside this bounded lifecycle model.
  for (const repo of domain) {
    const repository = repo === "self" ? SELF : GATEWAY;
    const part = await concretize({
      ...DEFAULT_SHAPE,
      repository,
      nextStep: "work",
      candidate: "published",
      blocker: null,
      wait: null,
    });
    const record = part.record;
    assert.equal(isPassportWorkTrial(record.repository), false);
    record.intent = {
      kind: "base_refresh",
      key: baseRefreshIntentKey(record.target.pr!, record.target.head!, TIP),
      startedAt: NOW,
      branch: record.target.branch,
      expectedHead: record.target.head,
      observedBase: TIP,
      pr: record.target.pr,
      requestId: null,
      resultId: null,
    };
    const rig = await queueRig(1, {
      repository,
      shape: () => [record],
      reservations: part.reservations,
    });
    rig.clock.advance(NOW - rig.clock.now());
    const context = await loadRepairContext(rig.deps, {
      runDeadline: NOW + HOUR,
      modelCutoff: NOW + HOUR,
    });
    assert.ok(context);
    for (let failures = 1; failures <= MAX_BASE_REFRESH_FAILURES; failures++) {
      const before: typeof record = context.snapshot.work[0];
      assert.ok(before.intent);
      assert.equal(
        (await failBaseRefresh(rig.deps, context, before, before.intent, {
          kind: "unavailable",
          detail: BASE_REFRESH_CAPABILITY_DETAIL,
        })).kind,
        "progress",
      );
      const after = (await rig.snapshot()).work[0];
      assert.deepEqual(after.target, record.target, repo);
      assert.deepEqual(after.counters, record.counters, repo);
      assert.deepEqual(context.snapshot.reservations, part.reservations, repo);
      if (failures < MAX_BASE_REFRESH_FAILURES) {
        assert.equal(after.nextStep, "work", repo);
        assert.equal(after.intent?.key, record.intent.key, repo);
        assert.equal(after.intent?.failure?.attempts, failures, repo);
        assert.equal(after.wait?.reason, "unavailable", repo);
        rig.clock.advance(after.wait!.until! - rig.clock.now());
      } else {
        assert.equal(after.nextStep, "blocked", repo);
        assert.equal(after.intent, null, repo);
        assert.match(
          after.blocker!.message,
          /^base refresh failed 3 consecutive times:/,
        );
      }
    }
    assert.equal(rig.writes.length, MAX_BASE_REFRESH_FAILURES, repo);
    assert.deepEqual(rig.github.reviewed, [], repo);
  }
});

Deno.test("decision matrix: every park the lifecycle reaches is in the census", async () => {
  const run = await checker();
  const parks = new Set(
    [...run.graph.states.values()].map((state) => state.phase).filter((
      phase,
    ) => phase.startsWith("blocked:")).map((phase) =>
      phase.slice("blocked:".length)
    ),
  );
  const census = new Set(PARK_CLASSES.map((row) => row.id));
  assert.deepEqual([...parks].filter((id) => !census.has(id)), []);
});

Deno.test("decision matrix: known positive (a) re-retiring every pass is caught on 01f482529^", async () => {
  assert.equal(await preFixFixtureFaithful(), true);
  const before = await retirementFairness(
    preFixRetirements,
    "pre-01f482529",
    5,
  );
  assert.ok(before.starved.length > 0, "pre-fix starves the records to retire");
  assert.ok(before.holders.length > 0, "pre-fix rewrites retired rows");
  const run = await checker();
  const after = run.fairness.find((row) => row.id === "retirements:current")!;
  assert.deepEqual(after.starved, []);
  assert.deepEqual(after.holders, []);
});

Deno.test("decision matrix: known positive (b) the base_moved merge loop is caught before 180769ef4", async () => {
  const run = await checker();
  const links = linkCensus(run.census);
  const loop = (graph: ReturnType<typeof explore>) =>
    nonTerminating(graph, "coop").filter((cycle) =>
      cycle.cycle.some((step) =>
        step.edge.event === "merge_refused_base_mismatch"
      )
    );
  const before = explore(initialStates(), links, {
    preFixMergeReconcile: true,
  });
  assert.ok(loop(before).length > 0, "pre-fix: an unbounded merge loop");
  assert.equal(loop(run.graph).length, 0, "current: refreshed instead");
});

Deno.test("decision matrix: known positive (c) the output-bound overrun is caught before 63143fb92", async () => {
  const before = await outputBoundVerdict("pre-63143fb92");
  assert.equal(before.overrun, true, "the live 1127 receipt is an overrun");
  assert.equal(before.stuck, "reserved", "pre-fix: every pass throws");
  assert.equal(before.passesToSettle, null);
  const after = await outputBoundVerdict("current");
  assert.equal(after.excluded, true, "the real classifier excludes it");
  assert.equal(after.stuck, null);
  assert.equal(after.passesToSettle, 1);
});

Deno.test("decision matrix: the Gateway release wait is the real verdict on the live release ref", async () => {
  await checker();
  // A merged, reviewed Gateway delivery whose request binds it waits for a
  // VPS release record the live release ref never holds.
  assert.equal(VPS.binds, true);
  assert.equal(VPS.absentWaits, true);
  assert.equal(
    VPS.deferred,
    true,
    "missing release proof holds one stable state",
  );
});

Deno.test("decision matrix: review resumes the record's open PR and never opens a second one", async () => {
  const run = await checker();
  const continuity = run.prContinuity;
  for (const route of continuity.routes) {
    console.log(
      `review/delivery -> publication via ${route.leaves}: ${route.outcome}\n  trace: ${route.trace}`,
    );
  }
  // Decided by the real code: a correction keeps target.pr, a terminal park
  // clears it but the port reuses the exact own open PR, a closed PR is
  // retired and the port then creates a new one.
  assert.deepEqual(continuity.facts, {
    correctionKeepsPr: true,
    terminalParkClearsPr: true,
    closedPrRetired: true,
    portReusesOpenOwnPr: true,
    portCreatesAfterClose: true,
  });
  assert.deepEqual(
    continuity.duplicates,
    [],
    "no second PR beside an open one",
  );
  // Every correction route resumes the open PR (push, review on the same PR).
  const resumed = continuity.routes.filter((route) =>
    route.outcome === "resumes_open_pr"
  ).map((route) => route.leaves);
  for (
    const exit of [
      "review_p0_p1",
      "ci_red_candidate:correction",
      "base_moved_head_red:correction",
      "refresh_published",
    ]
  ) {
    assert.ok(resumed.includes(exit), `${exit} resumes the open PR`);
  }
  // A new PR only after the PR was closed unmerged: exactly the documented
  // replacements, each the J2 owner-close loop's entry.
  const replaced = continuity.routes.filter((route) =>
    route.outcome !== "resumes_open_pr"
  );
  assert.deepEqual(
    replaced.map((route) => route.leaves).sort(),
    [...KNOWN_PR_REPLACEMENTS].sort(),
  );
  for (const route of replaced) {
    assert.ok(route.trace.includes("--pr_closed_by_owner["), route.trace);
  }
  assert.ok(KNOWN_JAMS.some((id) => id.includes("pr_closed_by_owner")));
});

Deno.test("decision matrix: a lost review submission expires without refunding its round", async () => {
  const lost = await reviewIntentVerdict(false);
  const landed = await reviewIntentVerdict(true);
  console.log(`lost: ${lost.outcomes.join(" | ")}`);
  assert.ok(
    lost.observed >= 1,
    "the saved journal was checked before recovery",
  );
  assert.equal(lost.recovered, true, "the expired intent is cleared");
  assert.equal(lost.charged, true, "the ambiguous admission stays charged");
  assert.equal(lost.moved, true);
  assert.ok(lost.rounds >= 2 && lost.rounds <= 3);
  assert.equal(landed.moved, true, "a bound journal counts the round");
  assert.equal(landed.charged, true);
  assert.ok(!KNOWN_JAMS.includes("J1:wait:review.intent_unbound"));
});

Deno.test("decision matrix: integrated recovery and acceptance routes retain the round ceiling", async () => {
  const { graph } = await checker();
  for (const [id, state] of graph.states) {
    assert.ok(state.rounds >= 0 && state.rounds <= 3, id);
    for (const edge of graph.edges.get(id) ?? []) {
      if (edge.event !== "review_not_fulfilled") continue;
      assert.equal(
        edge.to.phase,
        state.rounds === 3 ? "blocked:rev.acceptance_owner" : "work.fresh",
        id,
      );
      assert.equal(edge.to.pr, state.pr, "acceptance correction keeps its PR");
    }
  }
});

Deno.test("decision matrix: identical failures park while changing signatures remain an explicit residual", async () => {
  const { graph } = await checker();
  const parks = [...graph.edges.values()].flat().filter((edge) =>
    edge.event === "identical_failure_owner_park"
  );
  assert.ok(parks.length > 0, "the repeat-failure guard is modeled");
  for (const edge of parks) {
    assert.equal(edge.to.phase, "blocked:impl.repeat_failure");
    assert.equal(edge.to.sameFailures, 3);
  }
  const cycles = nonTerminating(graph, "adv").filter((cycle) =>
    cycle.cycle.some((step) => step.edge.event === "matrix_grant")
  );
  assert.ok(cycles.length > 0, "the changing-signature residual stays visible");
  assert.ok(
    cycles.every((cycle) =>
      cycle.cycle.some((step) => step.edge.event.endsWith("_changed_signature"))
    ),
  );
});
