/**
 * Part C of the checker: fairness across former per-pass caps (J3).
 *
 * Each scenario runs a fleet larger than the former cap through REAL
 * passes (the full maintenance pass of `launcher.ts`, or the real repair
 * loop through the delivery-queue rig) and checks that every eligible record
 * is selected within a bounded number of passes. A record that keeps its slot
 * forever (refused on every pass) must not take the slot of the others.
 *
 * Retirement selection is pinned to the current uncapped closure pass. The
 * historical positive explicitly supplies its old five-row limit, so its
 * starvation witness is preserved without limiting the current planner.
 */
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReviewTaskStatementV1 } from "../../src/contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  applyHostedRetirements,
  type HostedClosurePlanV1,
} from "../../ops/hosted-autonomy-closures.ts";
import { hostedIssueKey } from "../../ops/hosted-autonomy-policy.ts";
import { spentReadWindow } from "../../ops/hosted-autonomy-spent-delivery.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import {
  DELIVERY_QUEUE_STALL_LIMIT,
  deliveryQueueAhead,
} from "../../src/repair/delivery-queue.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { queueRig } from "../repair/delivery-queue-rig.ts";
import { MINUTE } from "../repair/review-round-cap-rig.ts";
import { T0 } from "../state/helpers.ts";
import { anchor } from "./anchors.ts";
import {
  BASE,
  type ConcreteV1,
  concretize,
  DEFAULT_SHAPE,
  HOUR,
  NOW,
  type RecordShapeV1,
  repairSnapshot,
  RETIRED_MESSAGE,
} from "./world.ts";
import {
  FAVORABLE,
  type LauncherWorldV1,
  runLauncherPass,
} from "./launcher.ts";

export const PASS_MS = 5 * MINUTE;

/** A second foreign repository (the delivery cap is per repository). */
export const OTHER: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "other-target",
  installationId: 7,
};

export interface FairnessV1 {
  id: string;
  cap: string;
  fleet: number;
  passes: number;
  /** Records never selected within `passes`. */
  starved: string[];
  /** Records refused on every pass while holding a slot. */
  holders: string[];
  detail: string;
}

function headOf(index: number): GitSha {
  return `${index.toString(16).padStart(4, "0")}${"ab".repeat(18)}` as GitSha;
}

async function fleet(
  shapes: RecordShapeV1[],
): Promise<{ parts: ConcreteV1[]; tasks: Map<number, ReviewTaskStatementV1> }> {
  const parts: ConcreteV1[] = [];
  for (const shape of shapes) parts.push(await concretize(shape));
  return {
    parts,
    tasks: new Map(parts.map((part) => [part.task.issueNumber, part.task])),
  };
}

async function drive(
  snapshot: RepairStateSnapshotV1,
  world: LauncherWorldV1,
  tasks: Map<number, ReviewTaskStatementV1>,
  passes: number,
  start = NOW,
) {
  let current = snapshot;
  const log: { actions: string[]; merges: number[]; reruns: number[] }[] = [];
  for (let pass = 0; pass < passes; pass++) {
    const result = await runLauncherPass(
      current,
      world,
      tasks,
      start + pass * PASS_MS,
    );
    current = result.after;
    log.push({
      actions: result.actions,
      merges: result.merges,
      reruns: result.reruns,
    });
  }
  return { final: current, log };
}

// ---------------------------------------------------------- J3: retirements
/** The closure pass's inline retirement selection, pinned by an anchor. */
export const RETIREMENT_CAP = anchor(
  "f.retirementCap",
  "ops/hosted-autonomy-closure-pass.ts",
  ").filter((plan) => !settled(plan.id));",
);

export type RetirementPlanner = (
  snapshot: RepairStateSnapshotV1,
  closedIssues: ReadonlySet<string>,
  closedUnmerged?: ReadonlySet<string>,
) => HostedClosurePlanV1[];

/** Current selection, or the explicitly requested historical positive. */
export function selectRetirements(
  planner: RetirementPlanner,
  snapshot: RepairStateSnapshotV1,
  closedIssues: ReadonlySet<string>,
  closedUnmerged: ReadonlySet<string>,
  historicalLimit = Number.MAX_SAFE_INTEGER,
): HostedClosurePlanV1[] {
  return planner(snapshot, closedIssues, closedUnmerged).slice(
    0,
    historicalLimit,
  );
}

/**
 * A fleet of already retired records ahead (in id order) of records that
 * still need retiring, all with closed issues and closed-unmerged pulls. Fair
 * when every record that needs it is retired within ceil(n/5) passes and no
 * retired row is rewritten afterwards.
 */
export async function retirementFairness(
  planner: RetirementPlanner,
  label: string,
  historicalLimit = Number.MAX_SAFE_INTEGER,
): Promise<FairnessV1> {
  const shapes: RecordShapeV1[] = [];
  for (let index = 0; index < 9; index++) {
    const retired = index < 6;
    shapes.push({
      ...DEFAULT_SHAPE,
      issue: 100 + index,
      head: headOf(index),
      nextStep: retired ? "blocked" : "delivery",
      blocker: retired
        ? { kind: "other", message: RETIRED_MESSAGE, since: NOW - 2 * HOUR }
        : null,
      wait: null,
      candidate: "published",
      rounds: 1,
      review: "clean",
    });
  }
  const { parts } = await fleet(shapes);
  let snapshot = repairSnapshot(parts);
  const closed = new Set(
    parts.map((part) =>
      hostedIssueKey(part.record.repository, part.task.issueNumber)
    ),
  );
  const unmerged = new Set(parts.map((part) => part.record.id));
  const needing: string[] = parts.slice(6).map((part) => part.record.id);
  const retiredAt = new Map<string, number>();
  let rewrites = 0;
  const passes = 6;
  for (let pass = 0; pass < passes; pass++) {
    const plans = selectRetirements(
      planner,
      snapshot,
      closed,
      unmerged,
      historicalLimit,
    );
    for (const plan of plans) {
      if (!needing.includes(plan.id) || retiredAt.has(plan.id)) rewrites++;
      if (!retiredAt.has(plan.id)) retiredAt.set(plan.id, pass);
    }
    if (plans.length === 0) continue;
    snapshot = applyHostedRetirements(
      snapshot,
      snapshot.stateHead ?? ("1".repeat(40) as GitSha),
      plans,
      NOW + pass * PASS_MS,
    );
  }
  const starved = needing.filter((id) => !retiredAt.has(id));
  return {
    id: `retirements:${label}`,
    cap: "closure pass: all eligible retirements in snapshot order",
    fleet: parts.length,
    passes,
    starved,
    holders: rewrites > 0
      ? [`${rewrites} rewrites of already retired rows`]
      : [],
    detail:
      `retired ${retiredAt.size} of ${needing.length} needing; ${rewrites} re-retirements`,
  };
}

/** The same fairness through the REAL full maintenance pass (current code). */
export async function retirementFairnessLive(): Promise<FairnessV1> {
  const shapes: RecordShapeV1[] = [];
  for (let index = 0; index < 9; index++) {
    const retired = index < 6;
    shapes.push({
      ...DEFAULT_SHAPE,
      issue: 100 + index,
      head: headOf(index),
      nextStep: retired ? "blocked" : "delivery",
      blocker: retired
        ? { kind: "other", message: RETIRED_MESSAGE, since: NOW - 2 * HOUR }
        : null,
      wait: null,
      candidate: "published",
      rounds: 1,
      review: "clean",
    });
  }
  const { parts, tasks } = await fleet(shapes);
  const { final, log } = await drive(
    repairSnapshot(parts),
    { ...FAVORABLE, issueOpen: false, pull: "closed_unmerged" },
    tasks,
    4,
  );
  const needing: string[] = parts.slice(6).map((part) => part.record.id);
  const starved = needing.filter((id) =>
    final.work.find((row) => row.id === id)?.blocker?.message !==
      RETIRED_MESSAGE
  );
  const rewrites = log.slice(1).flatMap((pass) =>
    pass.actions.filter((action) => action.startsWith("retire:"))
  );
  return {
    id: "retirements:live",
    cap: "closure pass: all eligible retirements in snapshot order",
    fleet: parts.length,
    passes: log.length,
    starved,
    holders: rewrites,
    detail: `retire actions per pass: ${
      log.map((pass) =>
        pass.actions.filter((action) => action.startsWith("retire:")).length
      ).join(",")
    }`,
  };
}

// ----------------------------------------------- J3: one merge per pass
/**
 * Three reviewed, green, exact-base delivery records in two repositories; the
 * first in id order is refused by GitHub on every merge. The delivery pass
 * stops merging in a repository for the rest of the pass once `merge` was
 * called there, so the other repository's record merges, while the refused
 * record's sibling starves behind the one merge slot of their repository.
 */
export async function mergeSlotFairness(): Promise<FairnessV1> {
  const shapes: RecordShapeV1[] = [0, 1, 2].map((index) => ({
    ...DEFAULT_SHAPE,
    repository: index === 2 ? { ...OTHER, name: "other-target-2" } : OTHER,
    issue: 300 + index,
    head: headOf(10 + index),
    nextStep: "delivery",
    blocker: null,
    wait: null,
    candidate: "published",
    rounds: 1,
    review: "clean",
  }));
  const { parts, tasks } = await fleet(shapes);
  const refused = parts[0]!.record.target.pr!;
  const passes = 12;
  const { log } = await drive(
    repairSnapshot(parts),
    { ...FAVORABLE, refuseMerge: new Set([refused]) },
    tasks,
    passes,
  );
  const merged = new Set(log.flatMap((pass) => pass.merges));
  const starved = parts.slice(1).filter((part) =>
    !merged.has(part.record.target.pr!)
  ).map((part) => part.record.id);
  const holders = log.every((pass) => pass.merges[0] === refused)
    ? [parts[0]!.record.id]
    : [];
  const deferred = log.at(-1)!.actions.filter((action) =>
    action.endsWith(":merge_deferred")
  );
  return {
    id: "delivery:one-merge-per-pass",
    cap: anchor(
      "f.mergedRepositories",
      "ops/hosted-autonomy-delivery-pass.ts",
      "      mergedRepositories.add(scope.key);",
    ),
    fleet: parts.length,
    passes,
    starved,
    holders,
    detail: `merge calls per pass: ${
      log.map((pass) => pass.merges.join("/")).join(",")
    }; last pass: ${deferred.join(" ")}`,
  };
}

// ---------------------------------------------------- J3: closure slots
/**
 * Six delivered (merged) foreign records whose issues are still open; the
 * first five (id order) have a red head check, so their closure is refused on
 * every pass while they keep the five closure slots.
 */
export async function closureSlotFairness(): Promise<FairnessV1> {
  const shapes: RecordShapeV1[] = [0, 1, 2, 3, 4, 5].map((index) => ({
    ...DEFAULT_SHAPE,
    repository: OTHER,
    issue: 400 + index,
    head: headOf(20 + index),
    nextStep: "delivery",
    blocker: null,
    wait: null,
    candidate: "published",
    rounds: 1,
    review: "clean",
  }));
  const { parts, tasks } = await fleet(shapes);
  const red = new Set(
    parts.slice(0, 5).map((part) => part.record.target.head!),
  );
  const passes = 6;
  const { final, log } = await drive(
    repairSnapshot(parts),
    { ...FAVORABLE, pull: "merged", redHeads: red },
    tasks,
    passes,
  );
  const last = parts[5]!.record.id;
  const starved = final.work.find((row) => row.id === last)?.nextStep === "done"
    ? []
    : [last];
  const refusals = log.at(-1)!.actions.filter((action) =>
    action.startsWith("close:") && action.endsWith(":refused")
  );
  return {
    id: "closures:five-slots",
    cap: anchor(
      "f.closureCap",
      "ops/hosted-autonomy-closure-pass.ts",
      "const closures = closureCandidates.filter((plan) => !settled(plan.id)).filter(",
    ),
    fleet: parts.length,
    passes,
    starved,
    holders: parts.slice(0, 5).map((part) => part.record.id).filter((id) =>
      refusals.some((line) => line.startsWith(`close:${id}:`))
    ),
    detail:
      `closure refusals in the last pass: ${refusals.length}; record 6 step: ${
        final.work.find((row) => row.id === last)?.nextStep
      }`,
  };
}

// --------------------------------------------------- J3: CI re-run budget
/**
 * Four CI-parked heads (clean review, red CI, base green) whose failed runs
 * are still at attempt 1 and whose re-run GitHub refuses. The re-run budget
 * (3 per pass, id order) is spent on the first three on every pass; the
 * fourth is neither re-run nor settled (so never corrected) until its run is
 * past the 30-day re-run window. Bounded, so not a jam; the bound is reported.
 */
export async function rerunFairness(): Promise<FairnessV1> {
  const shapes: RecordShapeV1[] = [0, 1, 2, 3].map((index) => ({
    ...DEFAULT_SHAPE,
    issue: 500 + index,
    head: headOf(30 + index),
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: "CI checks failed: validate(failure)",
      since: NOW - HOUR,
    },
    wait: null,
    candidate: "published",
    rounds: 1,
    review: "clean",
  }));
  const { parts, tasks } = await fleet(shapes);
  const world: LauncherWorldV1 = {
    ...FAVORABLE,
    headCi: "red",
    rerunRefused: true,
    rerunCreatedAt: NOW - HOUR,
  };
  const passes = 6;
  const { final, log } = await drive(
    repairSnapshot(parts),
    world,
    tasks,
    passes,
  );
  const fourth = parts[3]!.record.id;
  const stillParked = final.work.find((row) => row.id === fourth)?.nextStep ===
    "blocked";
  // Past the re-run window the fourth head settles and is re-admitted.
  const late = await drive(final, world, tasks, 1, NOW + 30 * 24 * HOUR);
  const settledLate = late.final.work.find((row) => row.id === fourth)
    ?.nextStep !== "blocked";
  return {
    id: "ci-rerun:three-per-pass",
    cap: anchor(
      "f.rerunCap",
      "ops/hosted-autonomy-ci-rerun.ts",
      "export const HOSTED_AUTONOMY_CI_RERUNS_PER_PASS = Number.MAX_SAFE_INTEGER;",
    ),
    fleet: parts.length,
    passes,
    starved: stillParked && !settledLate ? [fourth] : [],
    holders: [],
    detail: `re-run requests per pass: ${
      log.map((pass) => pass.reruns.length).join(",")
    }; fourth parked through ${passes} passes: ${stillParked}; re-admitted after the 30-day window: ${settledLate}`,
  };
}

// --------------------------------------------- J3: spent read window
/**
 * Every admissible spent record is read in one pass, including fleets larger
 * than the former eight-row window. Real function, no model.
 */
export async function spentWindowFairness(
  cadenceMs = PASS_MS,
  records = 20,
): Promise<FairnessV1> {
  const shapes: RecordShapeV1[] = [];
  for (let index = 0; index < records; index++) {
    shapes.push({
      ...DEFAULT_SHAPE,
      issue: 600 + index,
      head: headOf(40 + index),
      nextStep: "blocked",
      blocker: {
        kind: "other",
        message: "CI checks failed: validate(failure)",
        since: NOW - HOUR,
      },
      wait: null,
      candidate: "published",
      rounds: 3,
      review: "clean",
    });
  }
  const { parts } = await fleet(shapes);
  const snapshot = repairSnapshot(parts);
  const seen = new Set<string>();
  const passes = 1;
  for (let pass = 0; pass < passes; pass++) {
    for (const id of spentReadWindow(snapshot, NOW + pass * cadenceMs)) {
      seen.add(id);
    }
  }
  const starved = parts.map((part) => part.record.id).filter((id) =>
    !seen.has(id)
  );
  return {
    id: `spent-window:cadence-${cadenceMs / MINUTE}min:n${records}`,
    cap: "delivery pass: every eligible spent record",
    fleet: records,
    passes,
    starved,
    holders: [],
    detail: `read ${seen.size} of ${records} within ${passes} passes`,
  };
}

// ------------------------------------------------ J3: the delivery line
/**
 * The repository's delivery line (one refresh at a time): a record behind a
 * contender that never progresses waits only until the contender's stalled
 * counter reaches the line's stall limit (every non-advancing execution
 * counts one), so the wait is bounded. Real `deliveryQueueAhead`.
 */
export async function deliveryLineFairness(): Promise<FairnessV1> {
  const [ahead, behind] = [0, 1].map((index): RecordShapeV1 => ({
    ...DEFAULT_SHAPE,
    issue: 700 + index,
    head: headOf(60 + index),
    nextStep: "delivery",
    blocker: null,
    wait: null,
    candidate: "published",
    rounds: 1,
    review: "clean",
  }));
  const { parts } = await fleet([ahead!, behind!]);
  let releasedAt: number | null = null;
  for (let stalled = 0; stalled <= DELIVERY_QUEUE_STALL_LIMIT; stalled++) {
    const front = {
      ...parts[0]!.record,
      counters: { ...parts[0]!.record.counters, stalled },
      updatedAt: NOW - MINUTE,
    };
    const snapshot = repairSnapshot([
      { ...parts[0]!, record: front },
      parts[1]!,
    ]);
    const blocking = deliveryQueueAhead(
      snapshot,
      parts[1]!.record,
      BASE,
      NOW,
    );
    if (blocking === null) {
      releasedAt = stalled;
      break;
    }
  }
  return {
    id: "delivery-line:stall-limit",
    cap: anchor(
      "f.deliveryLine",
      "src/repair/delivery-queue.ts",
      "(other.counters.stalled ?? 0) >= DELIVERY_QUEUE_STALL_LIMIT ||",
    ),
    fleet: 2,
    passes: DELIVERY_QUEUE_STALL_LIMIT + 1,
    starved: releasedAt === null ? [parts[1]!.record.id] : [],
    holders: [],
    detail:
      `the line opens after ${releasedAt} non-advancing executions of the front record`,
  };
}

// ---------------------------------------- J3: runtime per-repository abort
/**
 * The REAL repair loop over one repository: issue 1 is reviewed clean and
 * waits at delivery; issues 2 and 3 are published and wait their turn. Then
 * the owner edits issue 1's text. `executeMerge` refuses the drifted task
 * acceptance with a `state_error` (no write), which ends the whole cycle;
 * issue 1 stays first in rank order (delivery bucket, oldest update), so no
 * later record of that repository ever gets a step. The control run without
 * the edit reviews issues 2 and 3.
 */
export async function runtimePoison(
  edit: boolean,
): Promise<FairnessV1 & { outcomes: string[] }> {
  const holdUntil = T0 + 3 * 16 * MINUTE;
  const rig = await queueRig(3, {
    reviewer: "ubiquity-sentinel[bot]",
    livePolicy: true,
    shape: (records) =>
      records.map((record) =>
        record.id === "issue-1" ? record : {
          ...record,
          wait: { reason: "backoff", since: T0, until: holdUntil },
        }
      ),
  });
  const read = rig.github.readIssue.bind(rig.github);
  let edited = false;
  rig.github.readIssue = async (number: number) => {
    const issue = await read(number);
    if (!edited || number !== 1 || !issue.ok || issue.value === null) {
      return issue;
    }
    return portOk({ ...issue.value, body: "The owner edited this issue." });
  };
  const outcomes: string[] = [];
  const run = async () => {
    const outcome = await runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 60 * MINUTE,
      // The hosted target cycles run without a step limit.
      stepLimit: Number.POSITIVE_INFINITY,
    });
    rig.clock.advance(16 * MINUTE);
    outcomes.push(
      `${outcome.status}${"detail" in outcome ? `:${outcome.detail}` : ""}`,
    );
  };
  // Issue 1 is reviewed and reaches delivery while 2 and 3 are held.
  for (let index = 0; index < 3; index++) await run();
  edited = edit;
  for (let index = 0; index < 6; index++) await run();
  const reviewed = new Set(rig.github.reviewed.map((row) => row.pr));
  const starved = [102, 103].filter((pr) => !reviewed.has(pr)).map((pr) =>
    `issue-${pr - 100}`
  );
  return {
    id: `runtime:state-error-abort${edit ? "" : ":control"}`,
    cap: anchor(
      "f.cycleStateError",
      "src/repair/loop-cycle.ts",
      `    if (result.kind === "state_error") {
      return { status: "state_error", detail: result.detail };
    }`,
    ),
    fleet: 3,
    passes: outcomes.length,
    starved,
    holders: edit ? ["issue-1"] : [],
    detail: `cycle outcomes after the edit: ${outcomes.slice(3).join(" | ")}`,
    outcomes,
  };
}
