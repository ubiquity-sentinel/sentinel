/**
 * J1 for decomposed issues (latent: no live parts). A repeatedly timed-out
 * issue is split into serial parts by the REAL `createDecompositionChildren`;
 * part k depends on part k-1 being `done`. When an earlier part parks in an
 * absorbing class, the REAL selector (`rankEligibleWork`) skips every later
 * part as `dependency` forever, the planner skips the decomposed parent
 * forever (anchored: children exist), and the REAL maintenance pass names
 * neither in any action line.
 */
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import { MATRIX_DECOMPOSE_AFTER_TIMEOUTS } from "../../src/contracts/matrix-identity.ts";
import { CONFLICT_PROTECTED_DETAIL } from "../../src/repair/conflict-resolution.ts";
import { rankEligibleWork } from "../../src/repair/selection.ts";
import { createDecompositionChildren } from "../../src/repair/transitions.ts";
import { isDecompositionEligible } from "../../src/host/matrix-planner.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import { anchor } from "./anchors.ts";
import { FAVORABLE, runLauncherPass } from "./launcher.ts";
import {
  concretize,
  DEFAULT_SHAPE,
  GATEWAY,
  HOUR,
  NOW,
  repairSnapshot,
} from "./world.ts";

export interface DecompositionVerdictV1 {
  /** Later parts the real selector skips as `dependency`. */
  dependencySkipped: string[];
  /** The parent is no longer decomposition-eligible (children exist). */
  parentSuperseded: boolean;
  /** Lines naming the parent or a skipped part in a real maintenance pass. */
  lines: string[];
  anchor: string;
}

export async function decompositionVerdict(): Promise<DecompositionVerdictV1> {
  const parentPart = await concretize({
    ...DEFAULT_SHAPE,
    issue: 900,
    nextStep: "work",
    blocker: null,
    wait: null,
    candidate: "fresh",
    intent: "none",
  });
  const parent = parseWorkRecordV1({
    ...parentPart.record,
    counters: {
      ...parentPart.record.counters,
      timeouts: MATRIX_DECOMPOSE_AFTER_TIMEOUTS,
    },
  });
  const children = createDecompositionChildren(parent, NOW - 2 * HOUR);
  // Part 1 parked in an owner-gated class (protected path: no launcher rule,
  // and none is ever meant to re-admit it).
  const first: WorkRecordV1 = parseWorkRecordV1({
    ...children[0]!,
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: CONFLICT_PROTECTED_DETAIL,
      since: NOW - HOUR,
    },
    updatedAt: NOW - HOUR,
  });
  const snapshot = repairSnapshot([
    { ...parentPart, record: parent },
    ...[first, ...children.slice(1)].map((record) => ({
      record,
      reservations: [],
      reviews: [],
      releaseRequests: [],
      task: parentPart.task,
    })),
  ]);
  const configs = [repositoryConfig(GATEWAY as never, {
    perHour: null,
    perSevenDays: null,
  } as never)];
  const ranked = rankEligibleWork(snapshot, configs, NOW);
  const dependencySkipped = Object.entries(ranked.skipped).filter((
    [, reason],
  ) => reason === "dependency").map(([id]) => id);
  const pass = await runLauncherPass(
    snapshot,
    FAVORABLE,
    new Map([[parentPart.task.issueNumber, parentPart.task]]),
    NOW,
  );
  const watched = [parent.id, ...children.slice(1).map((child) => child.id)];
  return {
    dependencySkipped,
    parentSuperseded: !isDecompositionEligible(parent, snapshot),
    lines: pass.actions.filter((action) =>
      watched.some((id) => action.includes(`:${id}:`))
    ),
    anchor: anchor(
      "d.parentSkipped",
      "src/host/matrix-planner.ts",
      "if (decompositionChildrenOf(context.snapshot, record.id).length > 0) {",
    ),
  };
}
