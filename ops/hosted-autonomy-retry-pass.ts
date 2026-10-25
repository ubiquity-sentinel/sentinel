import type {
  PortResultV1,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../src/contracts/hosted-supervisor.ts";
import { parseReleaseStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  queueProtectedIds,
  queueRecordProtected,
} from "./hosted-autonomy-queue-context.ts";
import { failed, readRepairSafely, skipped } from "./hosted-autonomy-state.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import {
  applyHostedRetries,
  ciCorrectionPlan,
  conflictBaseAdvancePlan,
  planHostedRetries,
  type RetryPlanV1,
} from "./hosted-autonomy-retries.ts";
import {
  HOSTED_AUTONOMY_CI_UNATTRIBUTED_PREFIX,
  hostedIssueKey,
  hostedRepositoryKey,
  isHostedSelf,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import {
  ciCorrectionRuntimeProven,
  ciGreenHeadKey,
  ciGreenRedeliveryEligible,
  HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS,
} from "./hosted-autonomy-ci-retries.ts";
import { readCiRerunSettled } from "./hosted-autonomy-ci-rerun.ts";
import {
  legacyFinalRoundOpen,
  legacyReviewRoundClassDrift,
  legacyReviewRoundClassPin,
  ordinaryReviewRoundsSpent,
} from "../src/repair/review-round-cap.ts";
import { CI_BASE_RED_DETAIL } from "../src/repair/ci-rejection.ts";
import {
  ciFirstFixRuntimeProven,
  ciFirstFixSelfInstalledRuntimeProven,
  ciFirstRuntimeProven,
  ciFirstSelfInstalledRuntimeProven,
  launcherLegacyCutoff,
  preReviewGateParked,
} from "./hosted-autonomy-ci-first.ts";
import type { HostedAutonomyResultV1 } from "./hosted-autonomy-types.ts";
import { runHostedMismatchDispositionPass } from "./hosted-autonomy-mismatch-pass.ts";
import { runHostedPreservationDispositionPass } from "./hosted-autonomy-preservation-disposition.ts";
import { runHostedRefreshRearmPass } from "./hosted-autonomy-refresh-rearm.ts";
import { runHostedOriginalCandidateRecoveryPass } from "./hosted-autonomy-original-candidate-pass.ts";
import {
  applyCandidateRefRevalidations,
  candidateRefRevalidation,
  type CandidateRefRevalidationV1,
} from "./hosted-autonomy-candidate-refs.ts";
import {
  applyBaseRefreshReadmissions,
  planBaseRefreshReadmissions,
  verifyBaseRefreshReadmissions,
} from "./hosted-autonomy-base-refresh-retries.ts";
import {
  applyRepeatFailureParks,
  REPEAT_FAILURE_DEFAULT_ROUTE,
  repeatFailureLabel,
  repeatFailureNeedsIssue,
  type RepeatFailureParkPlanV1,
} from "./hosted-autonomy-repeat-failure.ts";
import {
  HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS,
  planConflictReadmissions,
  verifyConflictReadmissions,
} from "./hosted-autonomy-conflict-retries.ts";
import {
  acceptanceCorrectionRuntimeProven,
  planAcceptanceReadmissions,
} from "./hosted-autonomy-acceptance.ts";
import {
  retryGrantAction,
  retryParkAction,
  retryReadmitAction,
} from "./hosted-autonomy-retry-actions.ts";

/** Legacy class drift lines reported per pass (the rest are counted). */
export const LEGACY_DRIFT_REPORTS_PER_PASS = 12;

/**
 * The pass's legacy class report, state-free. The one-time legacy class is a
 * rule over the installed runtime's pinned cutoff: every record of the
 * owner's class shape (CI-red parked, three or more rounds) the rule leaves
 * without its final round is named (at most
 * `LEGACY_DRIFT_REPORTS_PER_PASS`, then a count), so a record it leaves out
 * is never silent. A proven CI-first runtime without a pinned cutoff (the
 * rule is off while the runtime that would grant the round runs) reports
 * only their count; under any other runtime no final round is granted to
 * anyone (`legacy_round_requires_ci_first`) and nothing is reported.
 */
export function legacyClassDriftActions(
  snapshot: RepairStateSnapshotV1,
  cutoff: number | null,
  ciFirst: boolean,
): string[] {
  const actions: string[] = [];
  if (cutoff === null) {
    if (!ciFirst) return actions;
    const shaped = snapshot.work.filter((record) =>
      legacyReviewRoundClassPin(snapshot, record) !== null
    ).length;
    if (shaped > 0) {
      actions.push(`retry:legacy_class:denied:cutoff_unpinned=${shaped}`);
    }
    return actions;
  }
  const drift = legacyReviewRoundClassDrift(snapshot, cutoff);
  for (const item of drift.slice(0, LEGACY_DRIFT_REPORTS_PER_PASS)) {
    actions.push(
      `retry:${item.id}:denied:legacy_class_${item.kind}:pin=${
        item.pin ?? "none"
      }:spent=${item.spent}`,
    );
  }
  if (drift.length > LEGACY_DRIFT_REPORTS_PER_PASS) {
    actions.push(
      `retry:legacy_class:denied:drift_more=${
        drift.length - LEGACY_DRIFT_REPORTS_PER_PASS
      }`,
    );
  }
  return actions;
}

/**
 * The pass's report of legacy heads held on a moved base (issue #155),
 * state-free. Each record whose final round is still open under the cutoff
 * and that the runtime parked because its red reviewed head is not its own
 * change's failure is listed. The two parks are the red reviewed base
 * (`legacy_base_red`) and no base evidence with its base no longer the tip
 * (`legacy_unattributed`), where the flake re-run and the green rule cannot
 * act. No rule re-admits either park and it waits for the owner, so it is
 * named on every pass (at most `LEGACY_DRIFT_REPORTS_PER_PASS`, then a
 * count). Nothing is reported without a cutoff.
 */
export function legacyHeldHeadActions(
  snapshot: RepairStateSnapshotV1,
  cutoff: number | null,
  tips: ReadonlyMap<string, string | null>,
): string[] {
  if (cutoff === null) return [];
  const held: string[] = [];
  for (const record of snapshot.work) {
    const blocker = record.blocker;
    if (
      record.nextStep !== "blocked" || blocker === null ||
      blocker.kind !== "other" ||
      !legacyFinalRoundOpen(snapshot, record, cutoff)
    ) continue;
    if (blocker.message.startsWith(`${CI_BASE_RED_DETAIL}: `)) {
      held.push(`retry:${record.id}:denied:legacy_base_red`);
      continue;
    }
    const tip = tips.get(hostedRepositoryKey(record.repository)) ?? null;
    if (
      blocker.message.startsWith(HOSTED_AUTONOMY_CI_UNATTRIBUTED_PREFIX) &&
      tip !== null && tip !== record.target.base
    ) held.push(`retry:${record.id}:denied:legacy_unattributed`);
  }
  const actions = held.slice(0, LEGACY_DRIFT_REPORTS_PER_PASS);
  if (held.length > LEGACY_DRIFT_REPORTS_PER_PASS) {
    actions.push(
      `retry:legacy_held:denied:held_more=${
        held.length - LEGACY_DRIFT_REPORTS_PER_PASS
      }`,
    );
  }
  return actions;
}

/**
 * Read-only source facts shared by bookkeeping and the later retry grant. A
 * pass that continues after a write passes the ids it already read (`seen`):
 * each record's issue is read once per pass, and the facts already held are
 * kept.
 */
export async function readHostedClosedIssues(
  context: HostedAutonomyPassContextV1,
  seen?: Set<string>,
): Promise<void> {
  const { snapshot, scopeFor, actions } = context;
  const closedIssues = new Set<string>(
    seen === undefined ? [] : context.closedIssues,
  );
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    if (queueRecordProtected(record, context.deps.queueCustody)) continue;
    const issueNumber = record.related.issueNumber;
    if (issueNumber === null || seen?.has(record.id)) continue;
    seen?.add(record.id);
    const scope = await scopeFor(record.repository);
    if (scope.surface === null) {
      actions.push(`record:${record.id}:surface_unreadable`);
      continue;
    }
    let open: boolean | null = null;
    try {
      open = await scope.surface.readIssueOpen(issueNumber);
    } catch {
      open = null;
    }
    if (open === false) {
      closedIssues.add(hostedIssueKey(record.repository, issueNumber));
    }
  }
  context.closedIssues = closedIssues;
}

export async function runHostedRetryPass(
  context: HostedAutonomyPassContextV1,
  releaseHead: string,
): Promise<HostedAutonomyResultV1 | null> {
  context = {
    ...context,
    settled: new Set([
      ...context.settled ?? [],
      ...queueProtectedIds(
        context.snapshot,
        context.deps.queueCustody?.protectedRecordIds,
      ),
    ]),
  };
  const { deps, actions, revisions, scopeFor, readTip, readPull } = context;
  let { snapshot, observedHead } = context;
  const originalCandidate = await runHostedOriginalCandidateRecoveryPass(
    context,
  );
  if (originalCandidate !== null) return originalCandidate;
  // ---- candidate-ref revalidation pass ------------------------------------
  // The runtime parks a record when its managed candidate branch ref matched
  // neither the saved candidate head nor the head that record had published.
  // That ONE diagnosis is revalidated here, before any blocked work is
  // selected for a retry grant: every saved identity must bind exactly to this
  // record's own repository, task and producing operation, and the branch's
  // live ref must report exactly the original saved head. A record that proves
  // it returns to `work` with only that blocker cleared, through the same
  // expected-head CAS and readback as every other maintenance write, and the
  // pass then returns immediately so no delivery or review decision is made in
  // the same run from a state the runtime has not yet reconciled. An
  // unavailable surface or ref, a mismatched identity and every other blocker
  // leave the snapshot exactly as it was.
  const revalidated: CandidateRefRevalidationV1[] = [];
  // A record an earlier write of this pass touched waits for the next pass in
  // every rule below.
  const settled = (id: string) => context.settled?.has(id) === true;
  for (const record of snapshot.work) {
    if (settled(record.id)) continue;
    const candidate = await candidateRefRevalidation(record);
    if (candidate === null) continue;
    const surface = (await scopeFor(record.repository)).surface;
    if (surface === null) continue;
    let observed: string | null;
    try {
      observed = await surface.readBaseTip(candidate.branch);
    } catch {
      observed = null;
    }
    if (observed !== candidate.head) continue;
    revalidated.push(candidate);
  }
  if (revalidated.length > 0) {
    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return skipped("clock_invalid", observedHead, actions);
    }
    let next: RepairStateSnapshotV1;
    try {
      next = applyCandidateRefRevalidations(
        snapshot,
        observedHead as GitSha,
        revalidated,
        now,
      );
    } catch {
      return skipped("snapshot_invalid", observedHead, actions);
    }
    let write: PortResultV1<StateWriteResultV1> | null;
    try {
      write = await deps.state.writeRepair(next, observedHead as GitSha);
    } catch {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write === null || !write.ok) {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write.value.status === "conflict") {
      return skipped("write_conflict", observedHead, actions);
    }
    if (write.value.status === "ambiguous") {
      return failed("write_ambiguous", observedHead, actions);
    }
    const readback = await readRepairSafely(deps.state);
    if (
      readback === null || !readback.ok ||
      readback.value.status !== "found" ||
      readback.value.head !== write.value.head ||
      canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
    ) {
      return failed("readback_unverified", observedHead, actions);
    }
    for (const record of revalidated) {
      actions.push(`revalidate:${record.id}:cleared`);
    }
    return {
      kind: "hosted_autonomy",
      status: "applied",
      reason: "applied",
      beforeHead: observedHead,
      appliedHead: write.value.head,
      actions,
      revisions,
    };
  }

  const disposition = await runHostedMismatchDispositionPass(
    context,
    releaseHead,
  );
  if (disposition !== null) return disposition;

  // A parked candidate proven unrecoverable is handed to the retry authority
  // below in a later run, through its own write and readback.
  const preservation = await runHostedPreservationDispositionPass(context);
  if (preservation !== null) return preservation;

  // An intact preserved candidate whose refresh the old validator refused
  // returns to its own delivery once the corrected runtime is installed.
  const rearmed = await runHostedRefreshRearmPass(context);
  if (rearmed !== null) return rearmed;

  // Maintenance runs from the protected launcher, which need not be the
  // installed runtime. Only the authenticated release pointer supplies it.
  let runtimeSha: GitSha | null = null;
  let installedRuntime: HostedRuntimeRecordV1 | null = null;
  let release: ReleaseStateSnapshotV1 | null = null;
  try {
    release = parseReleaseStateSnapshotV1(context.releaseSnapshot);
    const installed = release.hostedRuntimes.find((runtime) =>
      runtime.id === HOSTED_RUNTIME_ID
    );
    installedRuntime = installed ?? null;
    runtimeSha = installedRuntime?.activeRevision ?? null;
  } catch {
    // Invalid/missing runtime custody never falls back to checkout or origin.
  }
  if (runtimeSha === null) {
    return skipped("release_not_terminal", observedHead, actions);
  }

  // ---- retry pass ---------------------------------------------------------
  // A task whose pull request is already merged or closed is delivered or
  // abandoned: retrying it would only spend model starts on a branch that can
  // no longer be published, so those plans are dropped before any write. A
  // pull that cannot be read is also not retried, but it is recorded as a read
  // failure rather than as the definitive not-open verdict it never was.
  const retryTips = new Map<string, string | null>();
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    const scope = await scopeFor(record.repository);
    if (retryTips.has(scope.key)) continue;
    retryTips.set(scope.key, await readTip(scope));
  }
  // The closed-issue fact is collected for every record that is not done, not
  // only for blocked ones: the retirement pass needs it for a live record whose
  // source issue is already gone. The retry pass keeps consuming it for blocked
  // records exactly as before, and the identity is always the pair
  // (repository, issue number).
  const closedIssues = context.closedIssues;
  // A head parked on its merge-gate CI failure (or by the CI-first gate
  // before its review, its exhausted park included) whose base tip is still
  // the record's base is read for green CI on its OWN repository surface (a
  // re-run flake, or CI that finished late); only a head proven all green
  // there can re-admit. A pre-review park on a moved base needs no read: under
  // a proven CI-first runtime it returns for the runtime's refresh. A
  // merge-gate park whose ordinary rounds are spent is read only under a
  // proven CI-first runtime (every eligible head, at any base): green at
  // its exact base it is the spent-round rule's, green on a moved base it
  // returns for the carried refresh, and only a read red one may be planned
  // as a (legacy) CI correction, never a green one.
  const ciFirst = ciFirstRuntimeProven(installedRuntime) ||
    ciFirstSelfInstalledRuntimeProven(installedRuntime);
  const legacyCutoff = deps.legacyReviewCutoff !== undefined
    ? deps.legacyReviewCutoff
    : launcherLegacyCutoff(installedRuntime, ciFirst, release);
  const ciGreenHeads = new Set<string>();
  const ciReadHeads = new Set<string>();
  const ciUnreadHeads = new Set<string>();
  const spentReads = new Set(
    snapshot.work.filter((record) =>
      ciFirst && record.nextStep === "blocked" &&
      record.target.head !== null &&
      ciGreenRedeliveryEligible(snapshot, record) &&
      ordinaryReviewRoundsSpent(snapshot, record)
    ).map((record) => record.id),
  );
  for (const record of snapshot.work) {
    const head = record.target.head;
    const spentRead = spentReads.has(record.id);
    if (
      record.nextStep !== "blocked" || head === null ||
      !((ciGreenRedeliveryEligible(snapshot, record) &&
        !ordinaryReviewRoundsSpent(snapshot, record)) ||
        preReviewGateParked(snapshot, record) || spentRead) ||
      closedIssues.has(
        hostedIssueKey(record.repository, record.related.issueNumber!),
      )
    ) continue;
    const scope = await scopeFor(record.repository);
    if (
      scope.surface === null ||
      (!spentRead && retryTips.get(scope.key) !== record.target.base)
    ) continue;
    // Tri-state, and for a foreign head against the base it was tested on
    // (every check that base's suites expect must exist; the self gate is
    // its one named `test-local` job, whose base also holds a `dispatch` run
    // per five-minute schedule). Only a successful, non-empty listing is a
    // read: an unreadable one (rate limited, failing, incomplete, empty) is
    // no evidence, so the head is neither green nor read red, and it plans
    // nothing this pass (sentinel issue #154: it took a correction slot).
    let green: boolean | null = null;
    try {
      green = await scope.surface.hasAllChecksGreen(
        head,
        isHostedSelf(record.repository) ? undefined : record.target.base,
      );
    } catch {
      green = null;
    }
    const key = ciGreenHeadKey(record.repository, head);
    if (green === null) {
      ciUnreadHeads.add(key);
      continue;
    }
    ciReadHeads.add(key);
    if (green) ciGreenHeads.add(key);
  }
  // Flake first: a CI-parked head is re-admitted for a correction only once
  // its single re-run (run by the delivery pass) can no longer act. Read only
  // under a proven CI-correction runtime, the only one the rule activates for.
  // A pre-review CI fix is re-admitted only under a fix runtime (generation
  // 81+, pinned by its own launcher commit), so only that runtime reads those
  // heads' re-runs.
  const ciFixRuntime = ciFirstFixRuntimeProven(installedRuntime) ||
    ciFirstFixSelfInstalledRuntimeProven(installedRuntime);
  const ciRerunSettled = ciCorrectionRuntimeProven(installedRuntime)
    ? await readCiRerunSettled(
      { ...context, snapshot },
      retryTips,
      ciFixRuntime,
      legacyCutoff,
    )
    : new Set<string>();
  // The repeat-failure bound reads each due or parked record's live source
  // task digest (an edited issue re-arms a park) over its OWN repository
  // surface; an unreadable digest withholds the grant without parking.
  const issueDigests = new Map<string, string | null>();
  for (const record of snapshot.work) {
    if (
      !repeatFailureNeedsIssue(snapshot, record) ||
      closedIssues.has(
        hostedIssueKey(record.repository, record.related.issueNumber!),
      )
    ) continue;
    const surface = (await scopeFor(record.repository)).surface;
    let digest: string | null = null;
    try {
      digest = (await surface?.readIssueTask?.(record.related.issueNumber!))
        ?.digest ?? null;
    } catch {
      digest = null;
    }
    issueDigests.set(record.id, digest);
  }
  const parks: RepeatFailureParkPlanV1[] = [];
  const planned = planHostedRetries(
    snapshot,
    deps.clock.now(),
    runtimeSha,
    retryTips,
    closedIssues,
    (denial) => {
      actions.push(`retry:${denial.id}:denied:${denial.reason}`);
    },
    // The same authenticated record carries the healthy proof the CI
    // re-admission requires; nothing else can activate that rule.
    {
      ciRuntime: installedRuntime,
      ciRerunSettled,
      ciGreenHeads,
      ciReadHeads,
      ciUnreadHeads,
      legacyReviewCutoff: legacyCutoff,
      repeatFailure: {
        route: deps.modelRoute ?? REPEAT_FAILURE_DEFAULT_ROUTE,
        issueDigests,
      },
      onRepeatFailurePark: (park) => {
        if (!settled(park.id)) parks.push(park);
      },
    },
  );
  // JAM B6a: an R80-written not-fulfilled acceptance with an ordinary round
  // left returns to `review` under a proven acceptance-correction runtime,
  // whose re-observation of the standing review starts its correction; its
  // pull request is verified open below like every other plan's.
  planned.push(...planAcceptanceReadmissions(
    snapshot,
    closedIssues,
    acceptanceCorrectionRuntimeProven(
      installedRuntime,
      deps.acceptanceCorrectionRuntimes,
    ),
    (denial) => {
      actions.push(`retry:${denial.id}:denied:${denial.reason}`);
    },
  ));
  actions.push(...legacyClassDriftActions(snapshot, legacyCutoff, ciFirst));
  actions.push(...legacyHeldHeadActions(snapshot, legacyCutoff, retryTips));
  const plans: RetryPlanV1[] = [];
  // The per-pass CI correction cap counts only corrections this pass admits
  // after the pull request checks below. A plan dropped there (closed,
  // merged or unreadable) holds no slot, so such records ordered first never
  // starve the rest; one past the cap is not read and waits for a later pass.
  // The conflict-resolution cap is counted the same way over the moved-tip
  // re-pends here and the conflict re-admissions below, which share it.
  let ciCorrections = 0;
  let conflictResolutions = 0;
  const admit = (plan: RetryPlanV1) => {
    plans.push(plan);
    if (ciCorrectionPlan(plan)) ciCorrections++;
    if (conflictBaseAdvancePlan(plan)) conflictResolutions++;
  };
  for (const plan of planned) {
    if (settled(plan.id)) continue;
    if (
      ciCorrectionPlan(plan) &&
      ciCorrections >= HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS
    ) {
      actions.push(`retry:${plan.id}:skipped:ci_correction_cap`);
      continue;
    }
    if (
      conflictBaseAdvancePlan(plan) &&
      conflictResolutions >= HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS
    ) {
      actions.push(`retry:${plan.id}:skipped:conflict_resolution_cap`);
      continue;
    }
    const record = snapshot.work.find((item) =>
      item.id === plan.id && sameRepository(item.repository, plan.repository)
    );
    const pullRequest = record?.target.pr ?? null;
    if (record === undefined || pullRequest === null) {
      admit(plan);
      continue;
    }
    const scope = await scopeFor(record.repository);
    if (scope.surface === null) {
      actions.push(`retry:${plan.id}:skipped:surface_unreadable`);
      continue;
    }
    const pull = await readPull(scope, pullRequest);
    if (pull === null) {
      // A read that threw or returned nothing is transient: it is no evidence
      // that the pull is closed, so it must not be reported as not open.
      actions.push(`retry:${plan.id}:skipped:pr_read_failed`);
    } else if (pull.state === "open" && pull.merged === false) {
      admit(plan);
    } else {
      actions.push(`retry:${plan.id}:skipped:pr_not_open`);
    }
  }
  // The base-refresh credential-expiry block has its own exact rule (see
  // hosted-autonomy-base-refresh-retries.ts): local gates first, then the
  // owned open PR on the exact branch and the branch's published head are
  // verified through each record's OWN repository surface. Its blocker
  // messages match no prefix above, so the two sets are disjoint and share
  // this one write.
  const readmissions = await verifyBaseRefreshReadmissions(
    planBaseRefreshReadmissions(
      snapshot,
      runtimeSha,
      closedIssues,
      (denial) => {
        actions.push(`retry:${denial.id}:denied:${denial.reason}`);
      },
      ciFirst,
      legacyCutoff,
    ).filter((plan) => !settled(plan.id)),
    scopeFor,
    actions,
  );
  // The refresh-conflict block has its own exact rule (see
  // hosted-autonomy-conflict-retries.ts), inert unless the installed runtime
  // is a proven conflict-resolution runtime; its blocker matches neither set
  // above, and its re-admission shares this one write and the slots of the
  // conflict-resolution cap the moved-tip re-pends above left.
  readmissions.push(
    ...await verifyConflictReadmissions(
      snapshot,
      planConflictReadmissions(
        snapshot,
        release,
        closedIssues,
        (denial) => {
          actions.push(`retry:${denial.id}:denied:${denial.reason}`);
        },
        deps.conflictResolutionRuntimes,
        legacyCutoff,
      ).filter((plan) => !settled(plan.id)),
      scopeFor,
      actions,
      HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS - conflictResolutions,
      legacyCutoff,
    ),
  );
  if (plans.length > 0 || readmissions.length > 0 || parks.length > 0) {
    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return skipped("clock_invalid", observedHead, actions);
    }
    let next: RepairStateSnapshotV1;
    try {
      next = applyBaseRefreshReadmissions(
        applyRepeatFailureParks(
          applyHostedRetries(snapshot, observedHead as GitSha, plans, now),
          parks,
          now,
        ),
        readmissions,
        now,
      );
    } catch {
      return skipped("snapshot_invalid", observedHead, actions);
    }
    let write: PortResultV1<StateWriteResultV1> | null;
    try {
      write = await deps.state.writeRepair(next, observedHead as GitSha);
    } catch {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write === null || !write.ok) {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write.value.status === "conflict") {
      return skipped("write_conflict", observedHead, actions);
    }
    if (write.value.status === "ambiguous") {
      return failed("write_ambiguous", observedHead, actions);
    }
    const readback = await readRepairSafely(deps.state);
    if (
      readback === null || !readback.ok ||
      readback.value.status !== "found" ||
      readback.value.head !== write.value.head ||
      canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
    ) {
      return failed("readback_unverified", observedHead, actions);
    }
    snapshot = readback.value.snapshot;
    observedHead = readback.value.head;
    // Only these three lines report the write (`retryWritten`); they are
    // pushed after its verified readback.
    for (const plan of plans) {
      actions.push(retryGrantAction(plan.id, plan.grant, plan.detail));
    }
    for (const readmission of readmissions) {
      actions.push(retryReadmitAction(readmission.id, readmission.detail));
    }
    for (const park of parks) {
      actions.push(retryParkAction(park.id, repeatFailureLabel(park.park)));
    }
    return {
      kind: "hosted_autonomy",
      status: "applied",
      reason: "retried",
      beforeHead: context.initialHead,
      appliedHead: write.value.head,
      actions,
      revisions,
    };
  }

  context.closedIssues = closedIssues;
  return null;
}
