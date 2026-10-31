/**
 * Part B of the checker: the live lifecycle of one issue record (J1 waits and
 * J2 cycles).
 *
 * The runtime's step functions need live ports, so their CONTROL FLOW is
 * modeled here, one transition per code path, each pinned by a source anchor
 * (`anchors.ts`). Every DECISION a transition takes is computed by the real
 * pure policy over a concretized record and ledger: CI fixes left
 * (`ciFixesLeft`), the CI gate
 * (`decideCiGate`), base attribution (`attributeFailedChecks` +
 * `decideCiDisposition`), the hosted fix/correction routes
 * (`preReviewCiFixRouteOpen`, `ciCorrectionRouteOpen`) and wait expiry
 * (`isWaiting`). Review rounds are accounting only (owner directive
 * 2026-10-30): a spent count never parks the model. A blocked state's way
 * back into the lifecycle is the census verdict of the REAL launcher pass for
 * that class (`census.ts`).
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
 * (`rerun`: the once-per-head flake re-run, replenished by a new head).
 * Durable reservations stay charged but impose no lifetime retry ranking. A strongly
 * connected component is safe when some ranking is spent inside it and never
 * replenished there; those edges are removed and the remainder re-checked
 * (lexicographic ranking by SCC decomposition). What remains is a cycle no
 * ranking bounds: J2.
 */
import {
  REPEAT_FAILURE_TRANSIENT_SPAN_MS,
  repeatFailureDue,
} from "../../ops/hosted-autonomy-repeat-failure.ts";
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
import { CARRIED_REFRESH_LIMIT } from "../../src/repair/loop-carried-delivery.ts";
import { MAX_BASE_REFRESH_FAILURES } from "../../src/repair/loop-base-refresh-failure.ts";
import { A } from "./pipeline-anchors.ts";
import { publicationOpens } from "./pr-continuity.ts";
import { REVIEW_INTENT, REVIEW_INTENT_ANCHOR } from "./review-intent.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  gatewayReleaseDeferred,
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
} from "./world.ts";

export { indefiniteWaits, initialStates, key } from "./pipeline-states.ts";

export type Fairness = "sys" | "coop" | "adv" | "base" | "human" | "infra";
export type Rank = "rerun";

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
  /** Last abstract failure signature and its consecutive occurrences. */
  lastFailure?: string | null;
  sameFailures?: number;
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

/**
 * The Gateway release wait, decided by the REAL `observeGatewayVpsDelivery`
 * over the live release-ref shape (no `vpsReleases` at all) for a merged,
 * reviewed Gateway delivery whose request binds it.
 */
export const VPS = { binds: false, absentWaits: false, deferred: false };

/** Prime the real policy constants the model consults (`VPS`). */
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
  VPS.deferred = gatewayReleaseDeferred(release, request);
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
  /** A persistent-red re-admission requires another base change. */
  baseMove: boolean;
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
  const fixesLeft = ciFixesLeft({
    counters: {
      attempts: 1 + state.fixes,
      retries: state.fixes,
      reviewRounds: 0,
    },
  });
  // The runtime's own red-head routing at the CI-first gate (hosted). The
  // CI-fix count is accounting only (owner directive 2026-10-30): a spent
  // count never selects the historical `ci.fix_exhausted` park.
  const preReviewRed = (from: PStateV1) =>
    preReviewCiFixRouteOpen(HOSTED)
      ? at(from, "work.fresh", { fixes: Math.min(from.fixes + 1, 3) })
      : park(from, "ci.pre_review_red");
  // The pre-review CI gate's verdict on a head whose CI finished.
  const ciFirstFinished = (from: PStateV1, baseMayBeRed: boolean) => {
    if (gate("green") === "proceed") {
      add(
        at(from, "review.requested", {
          rounds: Math.min(from.rounds + 1, 3),
        }),
        "ci_green:review_requested",
        "coop",
        { anchor: A.ciFirst },
      );
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
    add(park(from, "ref.refused"), "refresh_validation_refused", "human", {
      anchor: A.refreshRefused,
    });
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
      if (ciCorrectionRouteOpen(HOSTED) && fixesLeft) {
        add(
          at(from, "work.fresh", { fixes: Math.min(from.fixes + 1, 3) }),
          "ci_red_candidate:correction",
          "coop",
        );
      } else {
        add(park(from, "del.ci_failed"), "ci_red_candidate:park", "coop");
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
    const readmission = link?.unspent ?? link?.spent;
    if (readmission !== undefined && readmission !== null) {
      // A park re-admitted only for a head green again (a flake) spends the
      // head's one re-run; a new head replenishes it.
      add(
        at(state, readmission.to, { refreshFail: 0 }),
        "launcher_readmission",
        readmission.baseMove ? "base" : readmission.red ? "sys" : "adv",
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
      add(at(state, "work.impl"), "matrix_grant", "sys", {
        anchor: A.grant,
      });
      add(at(state, "work.manual"), "session_bound_absent", "human", {
        anchor: A.manual,
      });
      return edges;
    case "work.impl":
      add(
        at(state, "work.noted", { lastFailure: null, sameFailures: 0 }),
        "cell_completed",
        "coop",
        {
          replenishes: ["rerun"],
          anchor: A.ingest,
        },
      );
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
        const count = state.lastFailure === failure
          ? (state.sameFailures ?? 0) + 1
          : 1;
        // Collapse the finite six-hour transient span, which the real bound
        // tests advance explicitly. Beyond it, an identical streak must park;
        // changing the failure signature starts another streak, not a refund.
        const due = repeatFailureDue({
          signature: failure,
          count,
          failureClass: "transient_infrastructure",
          firstAtMs: NOW - REPEAT_FAILURE_TRANSIENT_SPAN_MS,
          lastAtMs: NOW,
        });
        add(
          park(
            {
              ...state,
              lastFailure: failure,
              sameFailures: Math.min(count, 3),
            },
            due ? "impl.repeat_failure" : failure,
          ),
          due ? "identical_failure_owner_park" : `cell_${failure}`,
          "adv",
          { anchor: A.ingest },
        );
        if (count > 1) {
          add(
            park({ ...state, lastFailure: failure, sameFailures: 1 }, failure),
            `cell_${failure}_changed_signature`,
            "adv",
            { anchor: A.ingest },
          );
        }
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
      // The re-observation goes through `requestReviewFor` again: the CI-first
      // gate only (a still-pending head is the bound transition above: `since`
      // is kept across re-arms).
      ciFirstFinished(at(state, "work.published"), true);
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
      add(at(state, "work.fresh"), "review_p0_p1", "coop", {
        anchor: A.correction,
      });
      add(at(state, "work.fresh"), "review_not_fulfilled", "coop", {
        anchor: A.acceptanceCorrection,
      });
      add(park(state, "rev.uncertain"), "review_uncertain", "adv");
      add(
        at(state, "review.requested", {
          rounds: Math.min(state.rounds + 1, 3),
        }),
        "review_acceptance_missing",
        "adv",
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
      // The real repair loop expires an unbound saved request without
      // refunding its charge. Re-enter the CI-first gate: it must still
      // respect the three-round ceiling before requesting another review.
      if (REVIEW_INTENT.unboundMoves === null) {
        throw new Error("primeReviewIntent() first");
      }
      if (REVIEW_INTENT.unboundMoves) {
        add(at(state, "work.published"), "expired_intent_recovered", "sys");
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
      // refreshed and reviewed again. Review rounds are accounting only
      // (owner directive 2026-10-30): a spent count never selects the
      // carried-delivery path or parks the head.
      add(at(state, "delivery.refresh"), "base_moved", "base");
      if (fixesLeft) {
        add(
          at(state, "work.fresh", { fixes: Math.min(state.fixes + 1, 3) }),
          "base_moved_head_red:correction",
          "base",
          { anchor: A.correctBeforeRefresh },
        );
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
        add(at(state, "delivery.refresh"), "stale_intent_refresh", "sys", {
          anchor: A.mergeStaleRefresh,
        });
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
        // The release controller is an external dependency. The new runtime
        // writes one stable deferred wait; it does not re-arm every pass.
        add(
          state,
          VPS.deferred ? "release_deferred" : "vps_release_record_absent",
          VPS.deferred ? "infra" : "coop",
          { anchor: VPS.deferred ? A.releaseDeferred : A.vpsWait },
        );
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
