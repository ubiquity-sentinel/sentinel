/**
 * The launcher's route for the runtime's malformed-review shape lines
 * (`src/github/native-review-shape-line.ts`): the same route as the review
 * terminal advisory. Only a complete settled child capture is scanned, each
 * line is strictly re-parsed and kept only when it is bound to this run's
 * execution, the volume is capped, and the CLI printer re-validates every
 * record before printing it. Nothing here reads or changes the child record,
 * the terminal, health or the exit status.
 */
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import {
  parseReviewResultShape,
  REVIEW_RESULT_SHAPE_EVENT,
  type ReviewResultShapeV1,
} from "../github/native-review-shape-line.ts";
import type { ReplayCommandResultV1 } from "../replay/runtime.ts";
import {
  isNonNegativeSafeInteger,
  MAX_DIAGNOSTIC_LINE_CHARS,
} from "./hosted-runtime-identity.ts";

/** Log volume bound only; no model admission or review limit. */
export const MAX_REVIEW_RESULT_SHAPES = 50;

export interface ReviewResultShapesV1 {
  shapes: ReviewResultShapeV1[];
  /** Accepted lines beyond the cap; counted, never printed. */
  dropped: number;
}

/** This run's capped shape lines of one complete settled child capture. */
export function scanReviewResultShapes(
  run: ReplayCommandResultV1,
  execution: HostedExecutionIntentV1,
): ReviewResultShapesV1 | null {
  if (run.truncated || !run.settled) return null;
  if (run.outcome !== "exited" && run.outcome !== "timed_out") return null;
  const shapes: ReviewResultShapeV1[] = [];
  let dropped = 0;
  for (const line of new TextDecoder().decode(run.stdout).split("\n")) {
    if (
      line.length > MAX_DIAGNOSTIC_LINE_CHARS ||
      !line.includes(REVIEW_RESULT_SHAPE_EVENT)
    ) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const shape = parseReviewResultShape(value);
    if (shape === null || shape.ownerRunId !== execution.id) continue;
    if (shapes.length < MAX_REVIEW_RESULT_SHAPES) shapes.push(shape);
    else dropped += 1;
  }
  return shapes.length === 0 ? null : { shapes, dropped };
}

/** Every record re-validated at the final printer, then one dropped count. */
export function reviewResultShapeLines(
  advisories: ReviewResultShapesV1,
): string[] {
  const lines: string[] = [];
  let dropped = isNonNegativeSafeInteger(advisories.dropped)
    ? advisories.dropped
    : 0;
  for (const candidate of advisories.shapes) {
    const shape = parseReviewResultShape(candidate);
    if (shape === null) continue;
    if (lines.length < MAX_REVIEW_RESULT_SHAPES) {
      lines.push(JSON.stringify(shape));
    } else dropped += 1;
  }
  if (dropped > 0) {
    lines.push(JSON.stringify({
      event: "sentinel_review_result_shapes_dropped",
      printed: lines.length,
      dropped,
    }));
  }
  return lines;
}
