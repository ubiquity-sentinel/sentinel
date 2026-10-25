/**
 * Active delivery-train selection (redesign 2026-10-25 C12, WP3.2). Pure and
 * level-triggered: each pass re-derives the decision from the existing
 * `sentinel-train/*` refs, the tip T and the members admissible now. A train
 * is chosen by member count and then by the smallest train id, never by
 * time or list order.
 */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  compareDeliveryTrainMembersV1,
  type DeliveryTrainId,
  type DeliveryTrainMemberV1,
  deliveryTrainRefV1,
  type DeliveryTrainRepositoryV1,
  type DeliveryTrainV1,
  parseDeliveryTrainRefV1,
  sameDeliveryTrainMemberV1,
} from "../contracts/delivery-train.ts";

/** One `sentinel-train/*` ref whose commit message parsed to `train`. */
export interface ExistingTrainV1 {
  readonly ref: string;
  readonly train: DeliveryTrainV1;
}

export interface SelectActiveTrainInputV1 {
  readonly repository: DeliveryTrainRepositoryV1;
  readonly branch: string;
  /** The tip T, read uncached this pass. */
  readonly base: GitSha;
  readonly trains: readonly ExistingTrainV1[];
  /** Exact member tuples that pass the train member gate now. */
  readonly admissible: readonly DeliveryTrainMemberV1[];
  /** Exact member tuples ejected at T by a red singleton train. */
  readonly ejected: readonly DeliveryTrainMemberV1[];
}

export interface ActiveTrainSelectionV1 {
  /** The train in flight at T, or null when a new one must be built. */
  readonly active: ExistingTrainV1 | null;
  /** Other valid trains at T (bisection probes), by train id. */
  readonly probes: readonly DeliveryTrainId[];
  /** Red singleton trains at T kept as the ejection evidence. */
  readonly evidence: readonly DeliveryTrainId[];
  /** Trains at T with a member no longer admissible (or ejected): delete. */
  readonly void: readonly DeliveryTrainId[];
  /** Trains on another base than T (or foreign): delete after booking. */
  readonly obsolete: readonly DeliveryTrainId[];
  /** Refs whose name does not name their manifest's digest: delete. */
  readonly invalid: readonly string[];
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function contains(
  members: readonly DeliveryTrainMemberV1[],
  member: DeliveryTrainMemberV1,
): boolean {
  return members.some((other) => sameDeliveryTrainMemberV1(other, member));
}

/**
 * Classifies every existing train and selects the active one: among the
 * trains on base T whose members are all admissible and none ejected, the
 * one with the most members, ties broken by the smallest train id. A
 * singleton whose admissible member is ejected is evidence, not void, so
 * the ejection fact survives until T moves or the head changes.
 */
export function selectActiveTrainV1(
  input: SelectActiveTrainInputV1,
): ActiveTrainSelectionV1 {
  const byId = new Map<DeliveryTrainId, ExistingTrainV1>();
  const invalid = new Set<string>();
  const conflicting = new Set<DeliveryTrainId>();
  for (const entry of input.trains) {
    const id = parseDeliveryTrainRefV1(entry.ref);
    if (id === null || id !== entry.train.trainId) {
      invalid.add(entry.ref);
      continue;
    }
    const seen = byId.get(id);
    if (
      seen !== undefined &&
      canonicalStringify(seen.train.manifest) !==
        canonicalStringify(entry.train.manifest)
    ) conflicting.add(id);
    if (seen === undefined) byId.set(id, entry);
  }
  for (const id of conflicting) {
    byId.delete(id);
    invalid.add(deliveryTrainRefV1(id));
  }
  const valid: ExistingTrainV1[] = [];
  const evidence: DeliveryTrainId[] = [];
  const voided: DeliveryTrainId[] = [];
  const obsolete: DeliveryTrainId[] = [];
  for (const entry of byId.values()) {
    const { trainId, manifest } = entry.train;
    if (
      manifest.repository.owner !== input.repository.owner ||
      manifest.repository.name !== input.repository.name ||
      manifest.branch !== input.branch || manifest.base !== input.base
    ) {
      obsolete.push(trainId);
      continue;
    }
    const admissible = manifest.members.every((member) =>
      contains(input.admissible, member)
    );
    const ejected = manifest.members.some((member) =>
      contains(input.ejected, member)
    );
    if (admissible && !ejected) valid.push(entry);
    else if (admissible && manifest.members.length === 1) {
      evidence.push(trainId);
    } else voided.push(trainId);
  }
  valid.sort((a, b) =>
    b.train.manifest.members.length - a.train.manifest.members.length ||
    byText(a.train.trainId, b.train.trainId)
  );
  return {
    active: valid[0] ?? null,
    probes: valid.slice(1).map((entry) => entry.train.trainId).sort(byText),
    evidence: evidence.sort(byText),
    void: voided.sort(byText),
    obsolete: obsolete.sort(byText),
    invalid: [...invalid].sort(byText),
  };
}

/**
 * The members a new train may be built from at T: admissible and not
 * ejected, in train order. The overlay then decides inclusion.
 */
export function trainBuildCandidatesV1(
  admissible: readonly DeliveryTrainMemberV1[],
  ejected: readonly DeliveryTrainMemberV1[],
): DeliveryTrainMemberV1[] {
  return admissible.filter((member) => !contains(ejected, member)).sort(
    compareDeliveryTrainMembersV1,
  );
}
