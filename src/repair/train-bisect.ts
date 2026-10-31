/**
 * Red-train bisection (redesign 2026-10-25 C12, WP3.2). Pure and
 * level-triggered: each pass recomputes one decision for the active train
 * A = M on tip T from the CI facts of its prefix trains `M[:j]` (each its
 * own digest-named train on T) and T's own red checks. No state is kept;
 * the search replays deterministically from the persisted refs and checks.
 *
 * - A red train gets one rerun of its failed jobs (a flaky green lands).
 * - Base attribution comes first: a confirmed red whose failed checks are
 *   red on T too waits and evicts nobody.
 * - Otherwise the boundary between the longest green prefix and the
 *   shortest red one is searched with at most 3 evenly spread prefix probes
 *   per round. At the boundary the longest green prefix lands (every landed
 *   tree is itself tested) and the next member is named as the suspect; a
 *   red singleton `(T, [m])` ejects m.
 * - CI pending for 6 hours is re-requested on the same train, without blame.
 */
import {
  type DeliveryTrainId,
  deliveryTrainIdV1,
  type DeliveryTrainManifestV1,
  type DeliveryTrainMemberV1,
  deliveryTrainPrefixV1,
} from "../contracts/delivery-train.ts";

export const TRAIN_CI_REREQUEST_MS = 6 * 60 * 60 * 1000;
export const TRAIN_MAX_PROBES_PER_ROUND = 3;

/** The CI facts of one train commit's complete required checks. */
export type TrainCiFactV1 =
  /** The train ref exists but no CI is bound to its commit yet. */
  | { readonly state: "missing" }
  /** Requested or running (never-started jobs count here, not as red). */
  | { readonly state: "pending"; readonly since: number }
  | { readonly state: "green" }
  /** `rerun`: this result is from the rerun of the failed jobs. */
  | {
    readonly state: "red";
    readonly failed: readonly string[];
    readonly rerun: boolean;
  };

export interface TrainBisectInputV1 {
  readonly now: number;
  /** The active train's members, in train order (k = length). */
  readonly members: readonly DeliveryTrainMemberV1[];
  /** Facts of the prefix trains on T by length j (1..k); absent: no ref. */
  readonly ci: ReadonlyMap<number, TrainCiFactV1>;
  /** Required checks red on T itself; null when T's CI is unknown. */
  readonly baseRed: readonly string[] | null;
}

export interface TrainSearchV1 {
  /** Longest prefix length known green (0: none). */
  readonly lo: number;
  /** Shortest prefix length known red above `lo`. */
  readonly hi: number;
  /** Completed probe rounds. */
  readonly round: number;
}

export type TrainBisectDecisionV1 =
  /** Land `M[:prefix]`; `suspect` is `M[prefix]` when it bounded a red. */
  | {
    readonly kind: "land";
    readonly prefix: number;
    readonly suspect: DeliveryTrainMemberV1 | null;
    readonly search: TrainSearchV1;
  }
  /** `(T, [member])` is red on checks green on T. */
  | {
    readonly kind: "eject";
    readonly member: DeliveryTrainMemberV1;
    readonly search: TrainSearchV1;
  }
  /** The same checks are red on T: wait, evict nobody. */
  | {
    readonly kind: "wait_base_red";
    readonly prefix: number;
    readonly checks: readonly string[];
  }
  /** CI work on prefix lengths: build the probe, request, rerun, wait. */
  | {
    readonly kind: "ci";
    readonly build: readonly number[];
    readonly request: readonly number[];
    readonly rerequest: readonly number[];
    readonly rerun: readonly number[];
    readonly waiting: readonly number[];
    readonly search: TrainSearchV1;
  }
  | {
    readonly kind: "wait_facts";
    readonly prefix: number;
    readonly reason: "base_ci_unknown" | "red_without_checks";
  };

type Status =
  | { readonly kind: "green" | "red" }
  | {
    readonly kind: "todo";
    readonly todo: "build" | "request" | "rerequest" | "rerun" | "waiting";
  }
  | { readonly kind: "base_red"; readonly checks: readonly string[] }
  | {
    readonly kind: "facts";
    readonly reason: "base_ci_unknown" | "red_without_checks";
  };

function classify(
  input: TrainBisectInputV1,
  prefix: number,
): Status {
  const fact = input.ci.get(prefix);
  if (fact === undefined) {
    // The active train exists by its ref; only a probe can be unbuilt.
    return {
      kind: "todo",
      todo: prefix === input.members.length ? "request" : "build",
    };
  }
  switch (fact.state) {
    case "missing":
      return { kind: "todo", todo: "request" };
    case "pending":
      return {
        kind: "todo",
        todo: input.now - fact.since >= TRAIN_CI_REREQUEST_MS
          ? "rerequest"
          : "waiting",
      };
    case "green":
      return { kind: "green" };
    case "red": {
      if (fact.failed.length === 0) {
        return { kind: "facts", reason: "red_without_checks" };
      }
      if (!fact.rerun) return { kind: "todo", todo: "rerun" };
      if (input.baseRed === null) {
        return { kind: "facts", reason: "base_ci_unknown" };
      }
      const baseRed = new Set(input.baseRed);
      const shared = [...new Set(fact.failed)].filter((check) =>
        baseRed.has(check)
      ).sort();
      return shared.length > 0
        ? { kind: "base_red", checks: shared }
        : { kind: "red" };
    }
  }
}

/** At most 3 prefix lengths evenly spread strictly inside (lo, hi). */
export function trainProbePointsV1(lo: number, hi: number): number[] {
  const span = hi - lo;
  if (span <= TRAIN_MAX_PROBES_PER_ROUND + 1) {
    return Array.from({ length: Math.max(0, span - 1) }, (_, i) => lo + i + 1);
  }
  const parts = TRAIN_MAX_PROBES_PER_ROUND + 1;
  return Array.from(
    { length: TRAIN_MAX_PROBES_PER_ROUND },
    (_, i) => lo + Math.floor(span * (i + 1) / parts),
  );
}

function ciWork(
  pending: readonly { prefix: number; todo: string }[],
  search: TrainSearchV1,
): TrainBisectDecisionV1 {
  const pick = (todo: string) =>
    pending.filter((item) => item.todo === todo).map((item) => item.prefix);
  return {
    kind: "ci",
    build: pick("build"),
    request: pick("request"),
    rerequest: pick("rerequest"),
    rerun: pick("rerun"),
    waiting: pick("waiting"),
    search,
  };
}

/** The one decision for the active train at T this pass. */
export function decideTrainBisectV1(
  input: TrainBisectInputV1,
): TrainBisectDecisionV1 {
  const k = input.members.length;
  if (k < 1) throw new RangeError("a train has at least one member");
  let search: TrainSearchV1 = { lo: 0, hi: k, round: 0 };
  const full = classify(input, k);
  if (full.kind === "green") {
    return { kind: "land", prefix: k, suspect: null, search };
  }
  if (full.kind === "todo") {
    return ciWork([{ prefix: k, todo: full.todo }], search);
  }
  if (full.kind === "facts") {
    return { kind: "wait_facts", prefix: k, reason: full.reason };
  }
  if (full.kind === "base_red") {
    return { kind: "wait_base_red", prefix: k, checks: full.checks };
  }
  for (;;) {
    const { lo, hi } = search;
    if (hi - lo === 1) {
      return lo === 0
        ? { kind: "eject", member: input.members[0], search }
        : { kind: "land", prefix: lo, suspect: input.members[lo], search };
    }
    const points = trainProbePointsV1(lo, hi);
    const statuses = points.map((prefix) => ({
      prefix,
      status: classify(input, prefix),
    }));
    for (const { prefix, status } of statuses) {
      if (status.kind === "base_red") {
        return { kind: "wait_base_red", prefix, checks: status.checks };
      }
      if (status.kind === "facts") {
        return { kind: "wait_facts", prefix, reason: status.reason };
      }
    }
    const todo = statuses.flatMap(({ prefix, status }) =>
      status.kind === "todo" ? [{ prefix, todo: status.todo }] : []
    );
    if (todo.length > 0) return ciWork(todo, search);
    const greens = statuses.filter(({ status }) => status.kind === "green")
      .map(({ prefix }) => prefix);
    const nextLo = Math.max(lo, ...greens);
    const reds = statuses.filter(({ status, prefix }) =>
      status.kind === "red" && prefix > nextLo
    ).map(({ prefix }) => prefix);
    search = {
      lo: nextLo,
      hi: Math.min(hi, ...reds),
      round: search.round + 1,
    };
  }
}

/**
 * Members ejected at T: each one whose singleton train `(T, [m])` is red
 * after its rerun on checks that are green on T. Unknown T CI ejects none.
 */
export function trainEjectedMembersV1(
  singletons: readonly {
    readonly member: DeliveryTrainMemberV1;
    readonly ci: TrainCiFactV1 | null;
  }[],
  baseRed: readonly string[] | null,
): DeliveryTrainMemberV1[] {
  return singletons.filter(({ member, ci }) =>
    ci !== null &&
    classify({
        now: 0,
        members: [member],
        ci: new Map([[1, ci]]),
        baseRed,
      }, 1).kind === "red"
  ).map(({ member }) => member);
}

/** The train ids of `M[:1]..M[:k]` (index j-1 names the prefix of length j). */
export async function trainPrefixIdsV1(
  manifest: DeliveryTrainManifestV1,
): Promise<DeliveryTrainId[]> {
  const ids: DeliveryTrainId[] = [];
  for (let length = 1; length <= manifest.members.length; length++) {
    ids.push(await deliveryTrainIdV1(deliveryTrainPrefixV1(manifest, length)));
  }
  return ids;
}
