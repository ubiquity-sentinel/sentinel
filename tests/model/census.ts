/**
 * Part A of the checker: the census of every blocked class (J1).
 *
 * A `blocked` record is moved only by (a) the protected launcher's
 * maintenance pass (retry table, base-refresh/conflict re-admissions,
 * candidate-ref revalidation, preservation disposition, refresh re-arm,
 * spent-round delivery, retirement, closure) and (b) four exact runtime
 * recoveries. For every blocker class the runtime (or an older generation)
 * writes, each of its record shapes is concretized and run through the REAL
 * launcher pass (`launcher.ts`) in every non-human world (base tip unmoved or
 * moved, required CI on the head green or deterministically red, CI on the
 * base tip green or red) at every later pass time (+0, +25h, +9d, +31d: past
 * every pacing, evidence-expiry and re-run window). The runtime recoveries
 * are modeled from their exact predicates (anchored).
 *
 * A shape is ABSORBING for a head-CI verdict when, in the world it can sit in
 * forever (the base tip only moves forward, so: once the tip has moved), no
 * pass with the base CI green or red at any later time changes its decision
 * fields, and no runtime recovery takes it. It is VISIBLE when every one of
 * those passes names it in the maintenance log or production run summary
 * (the blocker in the state ref alone is passive). J1 is an absorbing shape, not terminal by design, with an open
 * issue (and an open pull request where the shape has one) that is not
 * visible. The parks that are absorbing AND visible are the owner-gated
 * terminal-by-design ones, reported separately.
 */
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
  TASK_ACCEPTANCE_MISSING_DETAIL,
} from "../../src/contracts/review-task-acceptance.ts";
import { MATRIX_PRESERVATION_UNCERTAINTY_DETAIL } from "../../src/host/matrix-uncertainty-maintenance.ts";
import { LEGACY_LOSS_DETAIL } from "../../src/repair/loop-legacy-loss.ts";
import { anchor } from "./anchors.ts";
import {
  concretize,
  DAY,
  DEFAULT_SHAPE,
  HOUR,
  NOW,
  type RecordShapeV1,
  repairSnapshot,
} from "./world.ts";
import {
  decisionView,
  FAVORABLE,
  type LauncherWorldV1,
  runLauncherPass,
} from "./launcher.ts";
import {
  PARK_CLASSES,
  type ParkClassV1,
  type TriggerV1,
  type VariantV1,
} from "./census-classes.ts";

export { PARK_CLASSES };
export type { ParkClassV1, TriggerV1, VariantV1 };

// ------------------------------------------------- modeled runtime recoveries
/**
 * The runtime's once-per-run recoveries of exact blocked shapes
 * (`loop-cycle.ts`), transcribed predicate by predicate. Each returns the
 * recovery's anchor id when it takes the record, else null.
 */
const RECOVERIES: {
  id: string;
  takes: (record: WorkRecordV1) => boolean;
}[] = [
  {
    // Re-observes the standing review and re-requests the task-bound one
    // (or parks at the ceiling): it always moves the exact shape.
    id: anchor(
      "r.recoverBlockedMissingTaskReview",
      "src/repair/loop-review-recovery.ts",
      "record.blocker?.message !== TASK_ACCEPTANCE_MISSING_DETAIL ||",
    ),
    takes: (record) =>
      record.blocker?.message === TASK_ACCEPTANCE_MISSING_DETAIL &&
      record.source.kind === "issue" && record.intent === null &&
      record.wait === null && record.target.pr !== null &&
      record.target.head !== null && record.counters.reviewRounds >= 1,
  },
  {
    id: anchor(
      "r.recoverBlockedAlreadySatisfied",
      "src/repair/loop-review-recovery.ts",
      "record.blocker.message !== TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL ||",
    ),
    takes: (record) =>
      record.blocker?.kind === "other" &&
      record.blocker.message === TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL &&
      record.source.kind === "issue" && record.intent === null &&
      record.wait === null && record.target.pr !== null &&
      record.target.head !== null && record.target.branch !== null &&
      record.counters.reviewRounds >= 1,
  },
  {
    // The legacy loss bridge restores a proven lost candidate (its own
    // historical proof); the checker grants it whenever the class matches.
    id: anchor(
      "r.bridgeLegacyLoss",
      "src/repair/loop-legacy-loss.ts",
      `record.blocker?.kind === "missing_evidence"`,
    ),
    takes: (record) =>
      record.blocker?.message === LEGACY_LOSS_DETAIL &&
      record.blocker.kind === "missing_evidence",
  },
  {
    // A parked preservation whose exact preservation ref still exists is
    // restored by the matrix maintenance pre-pass (not driven here).
    id: anchor(
      "r.restoreExistingCandidateRefs",
      "ops/hosted-autonomy-maintenance.ts",
      `restored = await restoreExistingCandidateRefs({
        deps,
        ports: closed,
        dedicated,
        actions,
      });`,
    ),
    takes: (record) =>
      record.blocker?.message === MATRIX_PRESERVATION_UNCERTAINTY_DETAIL &&
      record.intent?.kind === "candidate_preservation",
  },
];

// ------------------------------------------------------------------ verdicts
/** Where a move left the record. */
export interface Destination {
  nextStep: WorkRecordV1["nextStep"];
  head: boolean;
  fixMarker: boolean;
  merged: boolean;
  blocker: string | null;
}

function destinationOf(
  record: WorkRecordV1 | undefined,
  merged: boolean,
): Destination | null {
  if (record === undefined) return null;
  return {
    nextStep: record.nextStep,
    head: record.target.head !== null,
    fixMarker: record.wait?.reason === "backoff" &&
      record.wait.since === record.wait.until,
    merged,
    blocker: record.blocker?.message ?? null,
  };
}
export interface ParkVerdictV1 {
  classId: string;
  variant: string;
  headCi: "green" | "red";
  trigger: TriggerV1;
  terminal: ParkClassV1["terminal"] | null;
  /**
   * Nothing moves it once the base tip has moved (the world it can sit in
   * forever), however the head's CI and the base's CI read.
   */
  absorbing: boolean;
  /** Every pass named the record in an action line or rendered summary row. */
  visible: boolean;
  /** First move observed in any world (authority/action, world). */
  movedBy: string | null;
  /** The record's decision fields after that first move. */
  destination: Destination | null;
  /** Distinct per-pass lines naming the record (record id elided). */
  lines: string[];
  /** The same, only in the world it can sit in forever (tip moved). */
  eventualLines: string[];
  passes: number;
}

const TIMES = [0, 25 * HOUR, 9 * DAY, 31 * DAY];

/** Options of one shape evaluation (a class's own world overrides). */
export interface EvaluationV1 {
  tips?: ("base" | "moved")[];
  world?: Partial<LauncherWorldV1>;
  refsAbsentWorlds?: boolean;
}

/**
 * Run one concretized shape through the REAL launcher pass in every world
 * and at every later time; report whether anything moved it and whether
 * every pass named it.
 */
export async function evaluateShape(
  shape: RecordShapeV1,
  headCi: "green" | "red",
  options: EvaluationV1 = {},
): Promise<
  Pick<
    ParkVerdictV1,
    | "absorbing"
    | "visible"
    | "movedBy"
    | "destination"
    | "lines"
    | "eventualLines"
    | "passes"
  >
> {
  const part = await concretize(shape);
  const snapshot = repairSnapshot([part]);
  const tasks = new Map([[part.task.issueNumber, part.task]]);
  const before = decisionView(part.record);
  const id = part.record.id;
  let movedBy: string | null = null;
  let destination: Destination | null = null;
  for (const recovery of RECOVERIES) {
    if (part.record.nextStep === "blocked" && recovery.takes(part.record)) {
      movedBy = `runtime:${recovery.id}`;
      destination = {
        ...destinationOf(part.record, false)!,
        nextStep: "review",
      };
      break;
    }
  }
  // The base tip only ever moves forward: the world a shape can sit in
  // forever is the last tip it can observe (a moved tip never returns).
  const tips = options.tips ?? ["base", "moved"] as const;
  const eventual = tips[tips.length - 1]!;
  let eventualMoved = movedBy !== null;
  let visible = true;
  let passes = 0;
  const lines = new Set<string>();
  const eventualLines = new Set<string>();
  for (const tip of tips) {
    for (const tipCi of ["green", "red"] as const) {
      for (
        const refsAbsent of options.refsAbsentWorlds ? [false, true] : [false]
      ) {
        const world: LauncherWorldV1 = {
          ...FAVORABLE,
          pull: "open",
          ...options.world,
          tip,
          tipCi,
          headCi,
          refsAbsent,
        };
        for (const offset of TIMES) {
          const pass = await runLauncherPass(
            snapshot,
            world,
            tasks,
            NOW + offset,
          );
          passes++;
          const named = pass.actions.filter((action) => action.includes(id));
          for (const line of named) {
            lines.add(line.replaceAll(id, "<id>"));
            if (tip === eventual) {
              eventualLines.add(line.replaceAll(id, "<id>"));
            }
          }
          if (tip === eventual && named.length === 0) visible = false;
          const after = pass.after.work.find((row) => row.id === id);
          if (decisionView(after) === before) continue;
          if (tip === eventual) eventualMoved = true;
          if (movedBy === null) {
            destination = destinationOf(after, pass.merges.length > 0);
            movedBy = `launcher:${named[0] ?? pass.result.reason}` +
              ` [tip=${tip} tipCi=${tipCi}${
                refsAbsent ? " refsAbsent" : ""
              } t+${offset / HOUR}h]`;
          }
        }
      }
    }
  }
  return {
    absorbing: !eventualMoved,
    visible,
    movedBy,
    destination,
    lines: [...lines].sort(),
    eventualLines: [...eventualLines].sort(),
    passes,
  };
}

async function evaluate(
  park: ParkClassV1,
  variant: VariantV1,
  headCi: "green" | "red",
): Promise<ParkVerdictV1> {
  const shape: RecordShapeV1 = {
    ...DEFAULT_SHAPE,
    nextStep: "blocked",
    wait: null,
    candidate: "fresh",
    ...variant,
    blocker: { kind: park.kind, message: park.message, since: NOW - HOUR },
  };
  return {
    classId: park.id,
    variant: variant.tag,
    headCi,
    trigger: park.trigger,
    terminal: park.terminal ?? null,
    ...await evaluateShape(shape, headCi, park),
  };
}

/** The whole census: every class, variant and head-CI verdict. */
export async function runCensus(
  classes: readonly ParkClassV1[] = PARK_CLASSES,
): Promise<ParkVerdictV1[]> {
  const verdicts: ParkVerdictV1[] = [];
  for (const park of classes) {
    for (const variant of park.variants) {
      // A shape without a head has no CI of its own.
      const verdicts_ci: ("green" | "red")[] =
        (variant.candidate ?? "fresh") === "fresh" ? ["green"] : [
          "green",
          "red",
        ];
      for (const headCi of verdicts_ci) {
        verdicts.push(await evaluate(park, variant, headCi));
      }
    }
  }
  return verdicts;
}

/** A J1 census jam: absorbing, not terminal by design, and silent. */
export function censusJam(verdict: ParkVerdictV1): boolean {
  return verdict.absorbing && verdict.terminal === null && !verdict.visible;
}

/** Absorbing but announced every pass: an owner-gated park the owner sees. */
export function visibleOwnerPark(verdict: ParkVerdictV1): boolean {
  return verdict.absorbing && verdict.terminal === null && verdict.visible;
}
