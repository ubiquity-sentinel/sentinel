/**
 * Types and shape helpers of the blocked-class census rows
 * (`census-classes.ts`, `census-classes-late.ts`).
 */
import type { BlockerKindV1 } from "../../src/contracts/work-record-types.ts";
import { anchor } from "./anchors.ts";
import type { RecordShapeV1 } from "./world.ts";
import type { LauncherWorldV1 } from "./launcher.ts";

/** One shape variant of a class, merged over the class defaults. */
export interface VariantV1 extends Partial<RecordShapeV1> {
  tag: string;
}

/** How a class is reached under the installed generation. */
export type TriggerV1 =
  /** Written by R80 on an ordinary pipeline path. */
  | "pipeline"
  /** Written by R80 only after a human action (edit, close, reopen, push). */
  | "human"
  /** Written by R80 only on a state/identity contradiction. */
  | "contradiction"
  /** Written only by an older generation; live rows may still hold it. */
  | "legacy";

export interface ParkClassV1 {
  id: string;
  message: string;
  kind: BlockerKindV1;
  /** Anchor id of the writer. */
  writer: string;
  trigger: TriggerV1;
  variants: VariantV1[];
  /** Base tips the shape can observe (a moved tip never returns). */
  tips?: ("base" | "moved")[];
  /** World override for every pass of this class. */
  world?: Partial<LauncherWorldV1>;
  /** Also evaluate with the candidate objects proven gone. */
  refsAbsentWorlds?: boolean;
  /** Terminal by design (the task's terminal list). */
  terminal?: "retired" | "merged_outside" | "pr_closed";
}

export const W = (file: string, needle: string, id: string) =>
  anchor(id, file, needle);

// ---------------------------------------------------------------- variants
export const FRESH: VariantV1 = {
  tag: "fresh",
  candidate: "fresh",
  intent: "impl_ambiguous",
};
export const CORRECTION: VariantV1 = {
  tag: "correction",
  candidate: "published",
  intent: "impl_ambiguous",
  rounds: 1,
  review: "p1",
};
export const CAP: VariantV1 = { ...FRESH, tag: "cap200", reservations: 200 };
export const NO_INTENT: VariantV1 = {
  tag: "fresh",
  candidate: "fresh",
  intent: "none",
};
export const pub = (
  tag: string,
  rounds: number,
  review: RecordShapeV1["review"],
  extra: Partial<RecordShapeV1> = {},
): VariantV1 => ({
  tag,
  candidate: "published",
  intent: "none",
  rounds,
  review,
  ...extra,
});
export const cleared = (
  tag: string,
  rounds: number,
  review: RecordShapeV1["review"],
): VariantV1 => ({
  tag,
  candidate: "pr_cleared",
  intent: "none",
  rounds,
  review,
});
export const LEGACY_FIX: Partial<RecordShapeV1> = { legacy: true, ciFixes: 1 };
