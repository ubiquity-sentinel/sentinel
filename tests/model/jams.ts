/**
 * The checker's verdicts as jams, and the documented expected-failure list.
 *
 * `KNOWN_JAMS` is EXACTLY the set of counterexamples the checker finds on the
 * current code (`decision-matrix_test.ts` asserts equality both ways): a fix
 * removes its entry, and any new jam fails the test until it is listed.
 */
import {
  censusJam,
  evaluateShape,
  type ParkVerdictV1,
  runCensus,
  visibleOwnerPark,
} from "./census.ts";
import { PARK_CLASSES } from "./census-classes.ts";
import {
  explore,
  type GraphV1,
  linkCensus,
  nonTerminating,
  shortestTrace,
  traceTo,
} from "./explore.ts";
import {
  indefiniteWaits,
  initialStates,
  key,
  type ModelOptionsV1,
  type Phase,
  primeRounds,
} from "./pipeline.ts";
import {
  closureSlotFairness,
  deliveryLineFairness,
  type FairnessV1,
  mergeSlotFairness,
  rerunFairness,
  retirementFairness,
  retirementFairnessLive,
  runtimePoison,
  spentWindowFairness,
} from "./fleet.ts";
import { planHostedRetirements } from "../../ops/hosted-autonomy-closures.ts";
import { decompositionVerdict } from "./decomposition.ts";
import { primeReviewIntent } from "./review-intent.ts";
import {
  prContinuity,
  type PrContinuityV1,
  primePrFacts,
} from "./pr-continuity.ts";
import { DEFAULT_SHAPE, HOUR, NOW, type RecordShapeV1 } from "./world.ts";

export interface JamV1 {
  id: string;
  kind: "J1" | "J2" | "J3";
  /** The jammed state, in words. */
  state: string;
  /** Minimal trace that reaches it (lifecycle path, then the checker's run). */
  trace: string;
  /** Source anchors of the code that decides it. */
  files: string;
}

export interface CheckerRunV1 {
  jams: JamV1[];
  census: ParkVerdictV1[];
  graph: GraphV1;
  /** Owner-gated absorbing parks the maintenance log names every pass. */
  visibleParks: ParkVerdictV1[];
  /** Owner-gated absorbing lifecycle states named every pass. */
  visibleLeaves: { phase: Phase; lines: string[] }[];
  fairness: FairnessV1[];
  /** Review back to publication: resumed PR, replacement or duplicate. */
  prContinuity: PrContinuityV1;
  stats: Record<string, number>;
}

/** The lifecycle's fresh issue record (no head, nothing spent). */
const FRESH_START = {
  phase: "work.fresh" as Phase,
  rounds: 0,
  fixes: 0,
  refreshFail: 0,
  carried: 0,
  aged: false,
  moved: false,
  repo: "gateway" as const,
  pr: "none" as const,
};

/** Shapes of the lifecycle's absorbing non-blocked states. */
const LEAF_SHAPES: Partial<Record<Phase, Partial<RecordShapeV1>>> = {
  "work.manual": {
    nextStep: "work",
    wait: { reason: "manual", since: NOW - HOUR, until: null },
    candidate: "fresh",
  },
  "delivery.review_pending_null": {
    nextStep: "delivery",
    wait: { reason: "review_pending", since: NOW - HOUR, until: null },
    candidate: "published",
    rounds: 1,
    review: "clean",
  },
  "review.intent_unbound": {
    nextStep: "review",
    wait: null,
    candidate: "published",
    rounds: 1,
    review: "none",
    intent: "review_ambiguous",
  },
  "delivery.poison": {
    nextStep: "delivery",
    wait: null,
    candidate: "published",
    rounds: 1,
    review: "clean",
    liveBody: "The owner edited this issue after the review.",
  },
};

/** What the real runtime does with an absorbing lifecycle state. */
const LEAF_NOTES: Partial<Record<Phase, string>> = {
  "review.intent_unbound":
    ' (the real repair loop reads the unbound journal and defers without a write on every run, past the review bound: "review intent has no exact bound journal")',
};

/**
 * Parks that are owner gates BY DESIGN (the owner rules or the code's own
 * comments say a person must act): their only defect is that nothing tells
 * the owner. Every other J1 park is one the owner rules expect to progress
 * on its own.
 */
const OWNER_GATES: ReadonlySet<string> = new Set([
  "impl.protected_path",
  "impl.admission_disabled",
  "impl.no_receipt@cap200",
  "rev.admission_refused",
  "rev.acceptance_mismatch",
  "rev.acceptance_owner",
  "ref.refused",
  "impl.repeat_failure",
  "ci.fix_exhausted",
  "ceil.unreviewed",
  "ceil.rejected",
  "ceil.unaccepted",
  "carried.reviewed_ci_pending",
  "carried.patch_changed",
  "carried.ci_failed",
  "carried.ci_pending",
  "carried.stalled",
  "carried.refresh_limit",
  "carried.off_tip",
  "rel.failed",
  "rel.cancelled",
  "merge.head_mismatch",
  "merge.release_identity",
  "misc.unconfigured",
  "ref.failed_permission",
  "pub.pr_base_mismatch",
  "pub.pr_head_mismatch",
  "pub.pr_identity_mismatch",
  "pres.ref_missing",
  "cell.runtime_mismatch",
  "cell.base_not_current",
  "work.manual",
]);

/**
 * Absorbing states announced on every pass whose progress the owner pipeline
 * rules REQUIRE. The per-pass line names the record but reports a status
 * (`base_moved`, `spent_not_admissible`), not that a human is needed, so
 * these are J1 (`J1:logged:`); every other announced absorbing state is an
 * owner gate the owner sees in the maintenance log (terminal by design).
 */
const MUST_PROGRESS: ReadonlyMap<string, string> = new Map([
  ["ceil.reviewed@spent", "rounds spent, no P0/P1 left: the PR merges"],
  ["ci.pre_review_red@legacy", "legacy records get CI fixes and one review"],
  ["delivery.review_pending_null", "a clean, green review merges"],
]);

function gateNote(id: string): string {
  const classId = id.split("@")[0]!;
  return OWNER_GATES.has(id) || OWNER_GATES.has(classId)
    ? "owner gate by design, but silent"
    : "the owner rules expect it to progress";
}

function writerOf(classId: string): string {
  return PARK_CLASSES.find((row) => row.id === classId)?.writer ?? classId;
}

/** Run every part of the checker over the current code. */
export async function runChecker(
  options: ModelOptionsV1 = {},
): Promise<CheckerRunV1> {
  await primeRounds();
  await primePrFacts();
  await primeReviewIntent();
  const census = await runCensus();
  const links = linkCensus(census);
  const graph = explore(initialStates(), links, options);
  const jams: JamV1[] = [];
  const freshKey = key(FRESH_START);

  // J1: absorbing, silent parks (census), with the lifecycle path to them.
  const byClass = new Map<string, ParkVerdictV1[]>();
  for (const verdict of census.filter(censusJam)) {
    const id = `${verdict.classId}@${verdict.variant}`;
    byClass.set(id, [...(byClass.get(id) ?? []), verdict]);
  }
  for (const [id, verdicts] of byClass) {
    const classId = id.split("@")[0]!;
    const path = shortestTrace(
      graph,
      freshKey,
      (state) => state.phase === `blocked:${classId}`,
    );
    const ci = verdicts.map((verdict) => verdict.headCi).join("+");
    jams.push({
      id: `J1:park:${id}`,
      kind: "J1",
      state: `blocked "${
        PARK_CLASSES.find((row) => row.id === classId)!.message
      }" (${verdicts[0]!.trigger}; head CI ${ci}; ${
        gateNote(id)
      }), issue open, PR open where the shape has one`,
      trace: `${
        path === null
          ? `written by ${writerOf(classId)} (not on the modeled lifecycle)`
          : path.join(" ")
      } ; then ${
        verdicts[0]!.passes
      } real maintenance passes (base tip moved, base CI green/red, +0h..+31d): no move, no action line naming the record`,
      files: writerOf(classId),
    });
  }

  // J1: absorbing parks the owner rules require to progress, announced only
  // by a status line.
  const logged = new Map<string, ParkVerdictV1[]>();
  for (const verdict of census.filter(visibleOwnerPark)) {
    const id = `${verdict.classId}@${verdict.variant}`;
    if (MUST_PROGRESS.has(id)) {
      logged.set(id, [...(logged.get(id) ?? []), verdict]);
    }
  }
  for (const [id, verdicts] of logged) {
    const classId = id.split("@")[0]!;
    const path = shortestTrace(
      graph,
      freshKey,
      (state) => state.phase === `blocked:${classId}`,
    );
    jams.push({
      id: `J1:logged:${id}`,
      kind: "J1",
      state: `blocked "${
        PARK_CLASSES.find((row) => row.id === classId)!.message
      }" (head CI ${
        verdicts.map((verdict) => verdict.headCi).join("+")
      }; owner rule: ${MUST_PROGRESS.get(id)}), issue open, PR open`,
      trace: `${
        path === null
          ? `written by ${writerOf(classId)} (not on the modeled lifecycle)`
          : path.join(" ")
      } ; then ${
        verdicts[0]!.passes
      } real maintenance passes (base tip moved, base CI green/red, +0h..+31d): no move; once the tip moved, every pass logs only: ${
        [...new Set(verdicts.flatMap((verdict) => verdict.eventualLines))]
          .join(" ")
      }`,
      files: writerOf(classId),
    });
  }

  // J1: indefinite waits and other absorbing non-blocked lifecycle states.
  const leaves = new Set<Phase>();
  for (const state of graph.states.values()) {
    if (state.phase === "done" || state.phase.startsWith("blocked:")) continue;
    const moves = (graph.edges.get(key(state)) ?? []).filter((edge) =>
      edge.fair !== "human" && edge.fair !== "base" && edge.fair !== "infra"
    );
    if (moves.length === 0) leaves.add(state.phase);
  }
  const waits = new Set(indefiniteWaits().map((wait) => wait.phase));
  const visibleLeaves: { phase: Phase; lines: string[] }[] = [];
  for (const phase of [...leaves].sort()) {
    const shape = LEAF_SHAPES[phase];
    if (shape === undefined) {
      throw new Error(`absorbing lifecycle state without a shape: ${phase}`);
    }
    const verdict = await evaluateShape(
      {
        ...DEFAULT_SHAPE,
        blocker: null,
        nextStep: "work",
        wait: null,
        candidate: "fresh",
        ...shape,
      },
      "green",
    );
    if (!verdict.absorbing) continue;
    const path = shortestTrace(
      graph,
      freshKey,
      (state) => state.phase === phase,
    );
    if (verdict.visible && MUST_PROGRESS.has(phase)) {
      jams.push({
        id: `J1:logged:${phase}`,
        kind: "J1",
        state: `${phase}${
          waits.has(phase) ? " (wait.until === null: isWaiting forever)" : ""
        } (owner rule: ${MUST_PROGRESS.get(phase)}), issue open, PR open`,
        trace: `${
          path?.join(" ") ?? phase
        } ; then ${verdict.passes} real maintenance passes: no move; once the tip moved, every pass logs only: ${
          verdict.eventualLines.join(" ")
        }`,
        files: [...graph.edges.values()].flat().filter((edge) =>
          edge.to.phase === phase && edge.anchor !== undefined
        ).map((edge) => edge.anchor!).filter((anchor, index, all) =>
          all.indexOf(anchor) === index
        ).join(", "),
      });
      continue;
    }
    if (verdict.visible) {
      visibleLeaves.push({ phase, lines: verdict.lines });
      continue;
    }
    jams.push({
      id: `J1:wait:${phase}`,
      kind: "J1",
      state: `${phase}${
        waits.has(phase) ? " (wait.until === null: isWaiting forever)" : ""
      }${LEAF_NOTES[phase] ?? ""} (${gateNote(phase)}), issue open`,
      trace: `${
        path?.join(" ") ?? phase
      } ; then ${verdict.passes} real maintenance passes: no move, no action line naming the record`,
      files: [...graph.edges.values()].flat().filter((edge) =>
        edge.to.phase === phase && edge.anchor !== undefined
      ).map((edge) => edge.anchor!).filter((anchor, index, all) =>
        all.indexOf(anchor) === index
      ).join(", "),
    });
  }

  // J1: a decomposed issue whose earlier part parks (latent: no live parts).
  const decomposition = await decompositionVerdict();
  if (
    decomposition.dependencySkipped.length > 0 &&
    decomposition.parentSuperseded && decomposition.lines.length === 0
  ) {
    jams.push({
      id: "J1:decomposition:part-parked",
      kind: "J1",
      state: `later parts skipped as dependency forever (${
        decomposition.dependencySkipped.join(", ")
      }); the decomposed parent stays at work, superseded`,
      trace:
        "parent timed out -> createDecompositionChildren -> part 1 parks (absorbing class) ; rankEligibleWork skips the later parts as `dependency`, the planner skips the parent (children exist), a real maintenance pass names none of them",
      files: decomposition.anchor,
    });
  }

  // J2: cycles no ranking bounds (cooperative, adversarial, owner-driven).
  const seen = new Set<string>();
  for (const fairness of ["coop", "adv", "human"] as const) {
    for (const cycle of nonTerminating(graph, fairness)) {
      const mechanism = cycle.id.replace(/^J2:\w+:/, "");
      if (seen.has(mechanism)) continue;
      seen.add(mechanism);
      const first = cycle.cycle[0];
      jams.push({
        id: cycle.id,
        kind: "J2",
        state: `cycle over ${
          [...new Set(cycle.cycle.map((step) => step.from.split("|")[0]))].join(
            ", ",
          )
        } that no ranking bounds (${fairness} world)`,
        trace: `${
          (shortestTrace(
            graph,
            freshKey,
            (state) => key(state) === (first?.from ?? cycle.states[0]),
          ) ?? traceTo(graph, first?.from ?? cycle.states[0]!)).join(" ")
        } ; cycle: ${
          cycle.cycle.map((step) =>
            `${step.from} --${step.edge.event}[${step.edge.fair}]-->`
          ).join(" ")
        }`,
        files: [
          ...new Set(
            cycle.cycle.map((step) => step.edge.anchor).filter((anchor) =>
              anchor !== undefined
            ),
          ),
        ].join(", "),
      });
    }
  }

  // J3: per-pass caps under a fleet larger than the cap.
  const fairness = [
    await retirementFairness(planHostedRetirements, "current"),
    await retirementFairnessLive(),
    await mergeSlotFairness(),
    await closureSlotFairness(),
    await rerunFairness(),
    await spentWindowFairness(),
    await deliveryLineFairness(),
    await runtimePoison(true),
    await runtimePoison(false),
  ];
  for (const result of fairness) {
    if (result.starved.length === 0) continue;
    jams.push({
      id: `J3:${result.id}`,
      kind: "J3",
      state: `${
        result.starved.join(", ")
      } never selected in ${result.passes} passes; slot held by ${
        result.holders.join(", ") || "records ahead in id order"
      } (${result.cap})`,
      trace: result.detail,
      files: result.cap,
    });
  }

  const continuity = await prContinuity(graph);
  const stats = {
    censusClasses: PARK_CLASSES.length,
    censusVerdicts: census.length,
    launcherPasses: census.reduce((sum, verdict) => sum + verdict.passes, 0),
    lifecycleStates: graph.states.size,
    lifecycleEdges: [...graph.edges.values()].reduce(
      (sum, edges) => sum + edges.length,
      0,
    ),
    fairnessScenarios: fairness.length,
    reviewToPublicationRoutes: continuity.routes.length,
    jams: jams.length,
  };
  return {
    jams,
    census,
    graph,
    visibleParks: census.filter((verdict) =>
      visibleOwnerPark(verdict) &&
      !MUST_PROGRESS.has(`${verdict.classId}@${verdict.variant}`)
    ),
    visibleLeaves,
    fairness,
    prContinuity: continuity,
    stats,
  };
}

/**
 * Every counterexample on the integrated generation-81 source. Launcher
 * scenarios keep the installed R80 pin until the separate launcher rollout. Documented expected failures: the test asserts the checker finds
 * exactly these. Fixing one means removing it here.
 */
export const KNOWN_JAMS: readonly string[] = [
  // Every blocked census row is now named by the production run summary.
  // These waits are not blocked records, so visibility alone cannot fix them.
  "J1:wait:work.manual",
  "J1:logged:ceil.reviewed@spent",
  "J1:logged:delivery.review_pending_null",
  // An adversarial environment can keep CI or merge gates unavailable.
  "J2:adv:delivery.merge:merge_refused_again",
  "J2:adv:delivery.ci_wait:ci_still_pending",
  "J2:adv:delivery.base_red:base_still_red",
  "J2:adv:work.base_red:base_still_red",
  // Repeated identical outcomes park after their bound. A different normalized
  // signature resets that streak; without the retired lifetime quota, a model
  // that keeps producing different failures can continue indefinitely. This is
  // an explicit residual, not evidence for reinstating a reservation throttle.
  "J2:adv:blocked:impl.failed+work.fresh+work.impl:cell_impl.failed_changed_signature+launcher_readmission+matrix_grant",
  "J2:human:delivery.head_changed:merge_refused_head_mismatch",
  "J2:human:review.ctx_wait:task_context_still_unavailable",
  "J2:human:work.noted+work.published:pr_closed_by_owner+preserved_published",
  // The per-pass per-repository merge count is retired: a refused or merged
  // record no longer keeps its repository's next candidate out of the pass.
  // Review rounds and CI-fix attempts are accounting only (owner directive
  // 2026-10-30): with no permanent cap, an adversarial world that keeps
  // returning unattributable CI, missing task acceptance, a lost review
  // submission or a candidate-caused failure lets the record keep iterating.
  // These are the documented unbounded-retry residuals, not reason to
  // reinstate a park.
  "J2:adv:blocked:del.ci_unattributed+delivery.gate:ci_red_unattributed+launcher_readmission",
  "J2:adv:delivery.base_red+delivery.gate+review.requested+work.fresh+work.impl+work.noted+work.published:cell_completed+ci_green:review_requested+ci_red_base_red+ci_red_candidate:correction+matrix_grant+preserved_published+review_clean",
  "J2:adv:review.intent_unbound+review.requested+work.published:ci_green:review_requested+expired_intent_recovered+review_submission_lost",
  "J2:adv:review.requested:review_acceptance_missing",
  "J2:adv:work.base_red+work.fresh+work.impl+work.noted+work.published:cell_completed+ci_red_base_red+ci_red_candidate+matrix_grant+preserved_published",
  "J3:runtime:state-error-abort",
];

/**
 * Every way from review or delivery back to opening a NEW pull request on
 * the current code (Part E). Review and delivery resume the record's open PR
 * on every other route; these exits open a replacement, the root of the
 * `J2:human:...pr_closed_by_owner...` loop. A fix removes its entry.
 */
export const KNOWN_PR_REPLACEMENTS: readonly string[] = [
  "pr_closed_by_owner", // retireClosedPublication, then a new PR is created
  "expired_intent_recovered", // only after a later owner close on that path
];
