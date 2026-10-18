/**
 * Part B of the checker: the live lifecycle of one issue record (J1 waits and
 * J2 cycles).
 *
 * The runtime's step functions need live ports, so their CONTROL FLOW is
 * modeled here, one transition per code path, each pinned by a source anchor
 * (`anchors.ts`). Every DECISION a transition takes is computed by the real
 * pure policy over a concretized record and ledger: review rounds left
 * (`reviewRoundsLeft`), CI fixes left (`ciFixesLeft`), the CI gate
 * (`decideCiGate`), base attribution (`attributeFailedChecks` +
 * `decideCiDisposition`), the hosted fix/correction routes
 * (`preReviewCiFixRouteOpen`, `ciCorrectionRouteOpen`), the ceiling's park
 * message (`ceilingParkMessage`) and wait expiry (`isWaiting`). A blocked
 * state's way back into the lifecycle is the census verdict of the REAL
 * launcher pass for that class (`census.ts`).
 *
 * Environment outcomes are edges labelled by who can repeat them forever:
 * `coop` (a cooperative world: CI and review eventually answer, GitHub works,
 * nothing actor-less is awaited forever), `adv` (an adversarial world: CI
 * pending or red base forever, refused merges, unreadable reads), `base` (the
 * base branch moves; assumed finitely often per record, else no system can
 * deliver) and `human` (an owner action: close a PR, edit an issue).
 *
 * Termination is checked by ranking: counters bounded by the owner rules live
 * in the state (review rounds, CI fixes, refresh failures, carried
 * refreshes), and edges carry the effect on the remaining ledger rankings
 * (`A`: the 200-reservation retry budget a model start spends; `rerun`: the
 * once-per-head flake re-run, replenished by a new head). A strongly
 * connected component is safe when some ranking is spent inside it and never
 * replenished there; those edges are removed and the remainder re-checked
 * (lexicographic ranking by SCC decomposition). What remains is a cycle no
 * ranking bounds: J2.
 */
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import {
  attributeFailedChecks,
  ciCorrectionRouteOpen,
  decideCiDisposition,
  failedChecks,
} from "../../src/repair/ci-rejection.ts";
import { decideCiGate } from "../../src/repair/loop-checks.ts";
import {
  ciFixesLeft,
  preReviewCiFixRouteOpen,
} from "../../src/repair/ci-first-policy.ts";
import {
  ceilingParkMessage,
  REVIEW_ROUND_CEILING_REJECTED,
  REVIEW_ROUND_CEILING_REVIEWED,
  REVIEW_ROUND_CEILING_UNACCEPTED,
  REVIEW_ROUND_CEILING_UNREVIEWED,
  reviewRoundsLeft,
} from "../../src/repair/review-round-cap.ts";
import { CARRIED_REFRESH_LIMIT } from "../../src/repair/loop-carried-delivery.ts";
import { MAX_BASE_REFRESH_FAILURES } from "../../src/repair/loop-base-refresh-failure.ts";
import { A } from "./pipeline-anchors.ts";
import { publicationOpens } from "./pr-continuity.ts";
import { REVIEW_INTENT, REVIEW_INTENT_ANCHOR } from "./review-intent.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  gatewayRequestBindsDelivery,
  observeGatewayVpsDelivery,
} from "../../src/repair/vps-delivery.ts";
import {
  concretize,
  DEFAULT_SHAPE,
  HEAD,
  NOW,
  releaseRequest,
  releaseSnapshot,
  repairSnapshot,
} from "./world.ts";

export { indefiniteWaits, initialStates, key } from "./pipeline-states.ts";

export type Fairness = "sys" | "coop" | "adv" | "base" | "human" | "infra";
export type Rank = "A" | "rerun";

export type Phase =
  | "work.fresh"
  | "work.impl"
  | "work.noted"
  | "work.published"
  | "work.ci_wait"
  | "work.base_red"
  | "work.refresh"
  | "work.manual"
  | "review.requested"
  | "review.ctx_wait"
  | "review.intent_unbound"
  | "delivery.gate"
  | "delivery.ci_wait"
  | "delivery.base_red"
  | "delivery.refresh"
  | "delivery.carried"
  | "delivery.merge"
  | "delivery.review_pending_null"
  | "delivery.poison"
  | "delivery.head_changed"
  | "delivery.released"
  | "delivery.closure"
  | "done"
  | `blocked:${string}`;

export interface PStateV1 {
  phase: Phase;
  /** Review rounds spent (0..3). */
  rounds: number;
  /** CI fixes spent (0..3). */
  fixes: number;
  /** Consecutive failures of the current refresh intent (0..2). */
  refreshFail: number;
  /** Mechanical refreshes a spent reviewed head was carried through. */
  carried: number;
  /** A bounded wait is past its bound. */
  aged: boolean;
  /** The base moved since the merge intent's reviewed base. */
  moved: boolean;
  repo: "self" | "gateway";
  /** The record's own pull request on GitHub (`pr-continuity.ts`). */
  pr: "none" | "open" | "closed";
}

export interface PEdgeV1 {
  to: PStateV1;
  event: string;
  fair: Fairness;
  consumes?: Rank[];
  replenishes?: Rank[];
  anchor?: string;
  /** A publication that opens a pull request (absent: resumes the open PR). */
  opensPr?: "first" | "replacement" | "duplicate";
}

/** Model switches: the live code, or a known-positive pre-fix variant. */
export interface ModelOptionsV1 {
  /**
   * `reconcileMergeIntent` before 180769ef4: an open, unmerged pull request
   * with a moved base is merged again (never refreshed).
   */
  preFixMergeReconcile?: boolean;
  /** No actor writes Gateway VPS release records (the live release ref). */
  vpsWriterAbsent?: boolean;
}

// ----------------------------------------------- real pure policy decisions
const roundsLeftCache = new Map<string, number>();
const parkCache = new Map<string, string>();

/**
 * The Gateway release wait, decided by the REAL `observeGatewayVpsDelivery`
 * over the live release-ref shape (no `vpsReleases` at all) for a merged,
 * reviewed Gateway delivery whose request binds it.
 */
export const VPS = { binds: false, absentWaits: false };

/** `reviewRoundsLeft` over a concretized record holding `rounds` charges. */
export async function primeRounds(): Promise<void> {
  const gateway = await concretize({
    ...DEFAULT_SHAPE,
    nextStep: "delivery",
    blocker: null,
    wait: null,
    candidate: "published",
    rounds: 1,
    review: "clean",
  });
  const request = await releaseRequest(gateway.record, gateway.reviews[0]!);
  VPS.binds = await gatewayRequestBindsDelivery(
    request,
    gateway.record,
    gateway.reviews[0]!,
  );
  const release = releaseSnapshot();
  VPS.absentWaits = (await observeGatewayVpsDelivery(
    {
      readRelease: () =>
        Promise.resolve(portOk({
          status: "found" as const,
          snapshot: release,
          head: "2".repeat(40) as never,
          ref: "refs/heads/sentinel-state/release",
        })),
    } as never,
    gateway.record,
    request,
    gateway.reviews[0]!,
  )).kind === "wait";
  for (const rounds of [0, 1, 2, 3]) {
    for (const review of ["none", "clean", "p1", "unaccepted"] as const) {
      const part = await concretize({
        ...DEFAULT_SHAPE,
        nextStep: "work",
        blocker: null,
        wait: null,
        candidate: "published",
        rounds,
        review,
      });
      const snapshot = repairSnapshot([part]);
      roundsLeftCache.set(
        `${rounds}`,
        reviewRoundsLeft(snapshot, part.record, null),
      );
      parkCache.set(
        `${review}`,
        ceilingParkMessage(snapshot, part.record),
      );
    }
  }
}

function roundsLeft(state: PStateV1): number {
  const left = roundsLeftCache.get(`${state.rounds}`);
  if (left === undefined) throw new Error("primeRounds() first");
  return left;
}

const PARK_CLASS: Record<string, string> = {
  [REVIEW_ROUND_CEILING_UNREVIEWED]: "ceil.unreviewed",
  [REVIEW_ROUND_CEILING_REJECTED]: "ceil.rejected",
  [REVIEW_ROUND_CEILING_UNACCEPTED]: "ceil.unaccepted",
  [REVIEW_ROUND_CEILING_REVIEWED]: "ceil.reviewed",
};

/** The ceiling park class `ceilingParkMessage` picks for the latest review. */
function ceilingClass(review: "none" | "clean" | "p1" | "unaccepted"): string {
  return PARK_CLASS[parkCache.get(review)!]!;
}

function check(conclusion: string | null, status = "completed") {
  return {
    name: "validate",
    status,
    conclusion,
    head: HEAD,
    startedAt: NOW - 1000,
    completedAt: status === "completed" ? NOW : null,
  } as unknown as GitHubCheckV1;
}

/** The real CI gate verdict for one abstract head outcome. */
function gate(ci: "green" | "pending" | "red"): string {
  const decision = decideCiGate([
    ci === "green"
      ? check("success")
      : ci === "pending"
      ? check(null, "in_progress")
      : check("failure"),
  ]);
  return typeof decision === "string" ? decision : "blocked";
}

/** The real base attribution of a red head against one base observation. */
function attribution(base: "green" | "red" | "pending" | "absent"): string {
  const failed = failedChecks([check("failure")]);
  const baseChecks = base === "absent" ? [] : [
    base === "green"
      ? check("success")
      : base === "red"
      ? check("failure")
      : check(null, "in_progress"),
  ];
  return decideCiDisposition(attributeFailedChecks(failed, baseChecks)).kind;
}

const HOSTED = { externalImplementations: true };

// --------------------------------------------------------------- transitions
const at = (state: PStateV1, phase: Phase, patch: Partial<PStateV1> = {}) => ({
  ...state,
  phase,
  aged: false,
  moved: false,
  ...patch,
});
const park = (state: PStateV1, classId: string) =>
  at(state, `blocked:${classId}` as Phase);

/** Census re-admission of one blocked class (filled by `linkCensus`). */
export interface ReadmissionV1 {
  /** The phase the launcher returns the record to. */
  to: Phase;
  /** Re-admitted for a deterministically red head too (else: flake only). */
  red: boolean;
}

/** A class's re-admission with rounds left and with every round spent. */
export interface ReadmissionLinkV1 {
  unspent: ReadmissionV1 | null;
  spent: ReadmissionV1 | null;
}

/** Outgoing edges of one abstract state. */
export function successors(
  state: PStateV1,
  readmit: ReadonlyMap<string, ReadmissionLinkV1>,
  options: ModelOptionsV1 = {},
): PEdgeV1[] {
  const edges: PEdgeV1[] = [];
  const add = (
    to: PStateV1,
    event: string,
    fair: Fairness,
    extra: Partial<PEdgeV1> = {},
  ) => edges.push({ to, event, fair, ...extra });
  const left = roundsLeft(state);
  const fixesLeft = ciFixesLeft({
    counters: {
      attempts: 1 + state.fixes,
      retries: state.fixes,
      reviewRounds: 0,
    },
  });
  // The runtime's own red-head routing at the CI-first gate (hosted).
  const preReviewRed = (from: PStateV1) => {
    if (!fixesLeft) return park(from, "ci.fix_exhausted");
    return preReviewCiFixRouteOpen(HOSTED)
      ? at(from, "work.fresh", { fixes: from.fixes + 1 })
      : park(from, "ci.pre_review_red");
  };
  // The pre-review CI gate's verdict on a head whose CI finished.
  const ciFirstFinished = (from: PStateV1, baseMayBeRed: boolean) => {
    if (gate("green") === "proceed") {
      // `requestReviewFor` checks the ceiling before the CI-first gate.
      if (left === 0) {
        add(park(from, ceilingClass("none")), "ceiling_park", "sys", {
          anchor: A.ceilingWork,
        });
      } else {
        add(
          at(from, "review.requested", { rounds: from.rounds + 1 }),
          "ci_green:review_requested",
          "coop",
          { consumes: ["A"], anchor: A.ciFirst },
        );
      }
    }
    if (gate("red") === "blocked" && attribution("green") === "candidate") {
      add(preReviewRed(from), "ci_red_candidate", "coop", {
        anchor: A.ciFirst,
      });
    }
    if (baseMayBeRed && attribution("red") === "base_red") {
      add(at(from, "work.base_red"), "ci_red_base_red", "adv", {
        anchor: A.preReviewBaseRed,
      });
    }
  };
  // The pre-review CI gate of a published, unreviewed head: a pending or
  // unattributed head waits (bounded, its `since` kept), else the verdict.
  const ciFirstOutcomes = (from: PStateV1) => {
    if (gate("pending") === "wait") {
      add(at(from, "work.ci_wait"), "ci_pending", "adv", {
        anchor: A.preReviewBound,
      });
    }
    if (attribution("absent") === "unattributed") {
      add(at(from, "work.ci_wait"), "ci_red_unattributed", "adv", {
        anchor: A.preReviewBound,
      });
    }
    ciFirstFinished(from, true);
  };
  const refreshOutcomes = (from: PStateV1, reviewed: boolean) => {
    add(at(from, "work.published"), "refresh_published", "sys");
    add(park(from, "ref.conflict"), "refresh_conflict", "coop");
    if (from.refreshFail + 1 >= MAX_BASE_REFRESH_FAILURES) {
      add(park(from, "ref.failed_unavailable"), "refresh_failed_3x", "adv", {
        anchor: A.refreshFail,
      });
    } else {
      add(
        {
          ...from,
          refreshFail: from.refreshFail + 1,
          phase: reviewed ? "delivery.refresh" : "work.refresh",
        },
        "refresh_failed",
        "adv",
        { anchor: A.refreshFail },
      );
    }
  };
  // The delivery gate's verdict on a head whose CI finished (green or red),
  // attributed against the reviewed base (`routeFailedDeliveryChecks`).
  const deliveryFinished = (from: PStateV1, baseMayBeRed: boolean) => {
    if (gate("green") === "proceed") {
      add(at(from, "delivery.released"), "ci_green:merged", "coop");
      add(
        at(from, "delivery.merge", { moved: false }),
        "ci_green:merge_refused",
        "adv",
        { anchor: A.mergeRefusedBackoff },
      );
    }
    if (attribution("green") === "candidate") {
      if (ciCorrectionRouteOpen(HOSTED) && fixesLeft && left > 0) {
        add(
          at(from, "work.fresh", { fixes: from.fixes + 1 }),
          "ci_red_candidate:correction",
          "coop",
        );
      } else {
        add(
          park(from, fixesLeft ? "del.ci_failed" : "ci.fix_exhausted"),
          "ci_red_candidate:park",
          "coop",
        );
      }
    }
    if (baseMayBeRed && attribution("red") === "base_red") {
      add(at(from, "delivery.base_red"), "ci_red_base_red", "adv", {
        anchor: A.deliveryBaseRed,
      });
    }
    if (attribution("absent") === "unattributed") {
      add(park(from, "del.ci_unattributed"), "ci_red_unattributed", "adv");
    }
  };
  const p = state.phase;
  if (p.startsWith("blocked:")) {
    const link = readmit.get(p.slice("blocked:".length));
    const readmission = state.rounds >= 3 ? link?.spent : link?.unspent;
    if (readmission !== undefined && readmission !== null) {
      // A park re-admitted only for a head green again (a flake) spends the
      // head's one re-run; a new head replenishes it.
      add(
        at(state, readmission.to, { refreshFail: 0 }),
        "launcher_readmission",
        readmission.red ? "sys" : "adv",
        readmission.red ? {} : { consumes: ["rerun"] },
      );
    }
    return edges;
  }
  switch (p) {
    case "done":
    case "work.manual":
    case "delivery.review_pending_null":
      return edges;
    case "delivery.poison":
      // executeMerge returns state_error on every run and writes nothing:
      // absorbing for the record (the J3 check covers the cycle it aborts).
      return edges;
    case "work.fresh":
      if (left === 0) {
        add(park(state, ceilingClass("none")), "ceiling_park", "sys", {
          anchor: A.ceilingWork,
        });
        return edges;
      }
      add(at(state, "work.impl"), "matrix_grant", "sys", {
        consumes: ["A"],
        anchor: A.grant,
      });
      add(at(state, "work.manual"), "session_bound_absent", "human", {
        anchor: A.manual,
      });
      return edges;
    case "work.impl":
      add(at(state, "work.noted"), "cell_completed", "coop", {
        replenishes: ["rerun"],
        anchor: A.ingest,
      });
      add(park(state, "impl.protected_path"), "cell_protected_path", "coop");
      for (
        const failure of [
          "impl.no_receipt",
          "impl.failed",
          "impl.incomplete",
          "impl.interrupted_bound",
          "impl.uncertain",
          "impl.loop_stop",
          "impl.artifact_only",
          "cell.source_read_unavailable",
          "cell.state_unavailable",
          "cell.bundle_failed",
        ]
      ) {
        add(park(state, failure), `cell_${failure}`, "adv", {
          anchor: A.ingest,
        });
      }
      add(
        park(state, "cell.source_changed"),
        "cell_source_changed",
        "human",
        { anchor: A.ingest },
      );
      return edges;
    case "work.noted": {
      const opensPr = publicationOpens(state.pr);
      add(
        at(state, "work.published", { pr: "open" }),
        "preserved_published",
        "coop",
        {
          anchor: A.preserve,
          ...(opensPr === undefined ? {} : { opensPr }),
        },
      );
      add(
        park(state, "pres.validation_refused"),
        "preservation_refused",
        "adv",
      );
      return edges;
    }
    case "work.published":
      if (left === 0) {
        add(park(state, ceilingClass("none")), "ceiling_park", "sys", {
          anchor: A.ceilingWork,
        });
        return edges;
      }
      ciFirstOutcomes(state);
      add(at(state, "work.refresh"), "base_moved", "base");
      add(
        at(state, "work.noted", { pr: "closed" }),
        "pr_closed_by_owner",
        "human",
        {
          anchor: A.closedRepublish,
        },
      );
      add(park(state, "rev.task_shape"), "issue_over_bound", "human");
      return edges;
    case "work.ci_wait":
      if (!state.aged) {
        add({ ...state, aged: true }, "pre_review_bound_elapsed", "adv", {
          anchor: A.preReviewBound,
        });
      } else {
        add(
          park(state, "ci.pre_review_pending"),
          "pre_review_bound_park",
          "sys",
          { anchor: A.preReviewBound },
        );
      }
      // The re-observation goes through `requestReviewFor` again: the
      // ceiling gate first, then the CI-first gate (a still-pending head is
      // the bound transition above: `since` is kept across re-arms).
      if (left === 0) {
        add(park(state, ceilingClass("none")), "ceiling_park", "sys", {
          anchor: A.ceilingWork,
        });
      } else {
        ciFirstFinished(at(state, "work.published"), true);
      }
      return edges;
    case "work.base_red":
      // Unbounded: the red-base backoff is re-armed while the base stays red.
      add(state, "base_still_red", "adv", { anchor: A.preReviewBaseRed });
      ciFirstFinished(at(state, "work.published"), false);
      add(at(state, "work.refresh"), "base_moved", "base");
      return edges;
    case "work.refresh":
      refreshOutcomes(state, false);
      return edges;
    case "review.requested":
      add(at(state, "delivery.gate"), "review_clean", "coop");
      add(at(state, "delivery.gate"), "review_p2_p3", "coop");
      add(
        left === 0 ? park(state, "ceil.rejected") : at(state, "work.fresh"),
        "review_p0_p1",
        "coop",
        { anchor: left === 0 ? A.rejectedPark : A.correction },
      );
      add(park(state, "rev.not_fulfilled"), "review_not_fulfilled", "coop");
      add(park(state, "rev.uncertain"), "review_uncertain", "adv");
      add(
        left === 0
          ? park(state, ceilingClass("unaccepted"))
          : at(state, "review.requested", { rounds: state.rounds + 1 }),
        "review_acceptance_missing",
        "adv",
        { consumes: ["A"] },
      );
      add(
        at(state, "review.ctx_wait"),
        "review_clean_issue_malformed",
        "human",
        { anchor: A.ctxWait },
      );
      add(
        at(state, "work.noted", { pr: "closed" }),
        "pr_closed_by_owner",
        "human",
        {
          anchor: A.closedRepublish,
        },
      );
      add(park(state, "rev.digest_drift"), "issue_edited", "human");
      // The next round's admission settled ambiguous and the submission
      // never landed: the saved intent's journal stays unbound.
      add(
        at(state, "review.intent_unbound"),
        "review_submission_lost",
        "adv",
        { anchor: REVIEW_INTENT_ANCHOR },
      );
      return edges;
    case "review.intent_unbound":
      // The REAL repair loop's verdict (`review-intent.ts`): it defers the
      // record without a write on every run, past the review bound.
      if (REVIEW_INTENT.unboundMoves === null) {
        throw new Error("primeReviewIntent() first");
      }
      if (REVIEW_INTENT.unboundMoves) {
        add(
          at(state, "review.requested", { rounds: state.rounds + 1 }),
          "expired_intent_recovered",
          "sys",
          { consumes: ["A"] },
        );
      }
      return edges;
    case "review.ctx_wait":
      // Re-armed every run while the issue text stays malformed or gone.
      add(state, "task_context_still_unavailable", "human", {
        anchor: A.ctxWait,
      });
      add(at(state, "delivery.gate"), "task_context_read", "coop");
      return edges;
    case "delivery.gate":
      // A moved base: corrected first when the head broke its own CI, else
      // refreshed (rounds left) or carried (rounds spent).
      if (left > 0) {
        add(at(state, "delivery.refresh"), "base_moved", "base");
        if (fixesLeft) {
          add(
            at(state, "work.fresh", { fixes: state.fixes + 1 }),
            "base_moved_head_red:correction",
            "base",
            { anchor: A.correctBeforeRefresh },
          );
        }
      } else {
        add(
          at(state, "delivery.carried", { carried: 0 }),
          "base_moved_spent_green",
          "base",
          { anchor: A.carried },
        );
        add(park(state, "del.ci_failed"), "base_moved_spent_red", "base", {
          anchor: A.spentRed,
        });
      }
      if (gate("pending") === "wait") {
        add(at(state, "delivery.ci_wait"), "ci_pending", "adv", {
          anchor: A.deliveryCiPending,
        });
      }
      deliveryFinished(state, true);
      add(
        at(state, "delivery.review_pending_null"),
        "receipt_no_longer_parses",
        "adv",
        { anchor: A.receiptUnparsable },
      );
      add(at(state, "delivery.poison"), "issue_edited_after_review", "human", {
        anchor: A.poison,
      });
      add(at(state, "delivery.head_changed"), "pr_head_force_pushed", "human", {
        anchor: A.headMismatch,
      });
      return edges;
    case "delivery.head_changed":
      // The merge port refuses the moved head (`head_mismatch`) and the
      // record backs off for a poll, forever; the launcher's delivery pass
      // skips a pull whose head is not the record's without a line.
      add(state, "merge_refused_head_mismatch", "sys", {
        anchor: `${A.headMismatch}, ${A.launcherHeadSkip}`,
      });
      return edges;
    case "delivery.ci_wait":
      // Unbounded: `gateDeliveryOnChecks` re-arms `ci_pending` every poll.
      add(state, "ci_still_pending", "adv", { anchor: A.deliveryCiPending });
      deliveryFinished(state, true);
      return edges;
    case "delivery.base_red":
      // Unbounded: the red-base backoff is re-armed while the base stays red.
      add(state, "base_still_red", "adv", { anchor: A.deliveryBaseRed });
      // Base green again: the head's own failure is now attributed to it.
      deliveryFinished(state, false);
      return edges;
    case "delivery.refresh":
      refreshOutcomes(state, true);
      return edges;
    case "delivery.carried":
      add(at(state, "delivery.released"), "carried_merge", "coop");
      if (state.carried + 1 >= CARRIED_REFRESH_LIMIT) {
        add(park(state, "carried.refresh_limit"), "base_moved_again", "base");
      } else {
        add(
          { ...state, carried: state.carried + 1 },
          "base_moved_again",
          "base",
        );
      }
      add(park(state, "carried.ci_failed"), "refreshed_head_red", "coop");
      add(park(state, "carried.ci_pending"), "refreshed_ci_pending_6h", "adv");
      add(park(state, "carried.patch_changed"), "patch_changed", "adv");
      return edges;
    case "delivery.merge": {
      // reconcileMergeIntent: the pull request is read first. Merged by the
      // launcher's delivery pass only at the exact reviewed base; on a moved
      // base only a person could have merged it.
      add(
        at(state, "delivery.released"),
        "pr_merged",
        state.moved ? "human" : "coop",
      );
      add(
        { ...park(state, "merge.pr_closed"), pr: "closed" },
        "pr_closed_by_owner",
        "human",
      );
      add(state, "pr_unreadable", "infra", { anchor: A.mergeUnreadable });
      if (state.moved && !options.preFixMergeReconcile) {
        // Open and unmerged on a moved base, intent one poll old: refresh.
        add(
          at(state, left > 0 ? "delivery.refresh" : "delivery.carried"),
          "stale_intent_refresh",
          "sys",
          { anchor: A.mergeStaleRefresh },
        );
        return edges;
      }
      if (state.moved) {
        // Pre-fix: the merge is retried against the moved base and the port
        // refuses it deterministically, then backs off.
        add(state, "merge_refused_base_mismatch", "sys", {
          anchor: A.mergeBaseGuard,
        });
        return edges;
      }
      add(at(state, "delivery.released"), "merge_accepted", "coop");
      add(state, "merge_refused_again", "adv", {
        anchor: A.mergeRefusedBackoff,
      });
      add({ ...state, moved: true }, "base_moved", "base");
      return edges;
    }
    case "delivery.released":
      if (
        state.repo === "gateway" && options.vpsWriterAbsent !== false &&
        VPS.binds && VPS.absentWaits
      ) {
        add(state, "vps_release_record_absent", "coop", { anchor: A.vpsWait });
      } else {
        add(at(state, "delivery.closure"), "release_accepted", "coop");
      }
      add(state, "release_pending", "infra", { anchor: A.releaseWait });
      add(park(state, "rel.failed"), "release_failed", "adv");
      return edges;
    case "delivery.closure":
      add(at(state, "done"), "issue_closed", "coop");
      add(state, "closure_unavailable", "infra");
      return edges;
  }
  return edges;
}
