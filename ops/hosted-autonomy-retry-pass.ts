import type {
  PortResultV1,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../src/contracts/hosted-supervisor.ts";
import { parseReleaseStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { failed, readRepairSafely, skipped } from "./hosted-autonomy-state.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import {
  applyHostedRetries,
  planHostedRetries,
  type RetryPlanV1,
} from "./hosted-autonomy-retries.ts";
import { hostedIssueKey, sameRepository } from "./hosted-autonomy-policy.ts";
import type { HostedAutonomyResultV1 } from "./hosted-autonomy-types.ts";
import { runHostedMismatchDispositionPass } from "./hosted-autonomy-mismatch-pass.ts";
import { runHostedPreservationDispositionPass } from "./hosted-autonomy-preservation-disposition.ts";
import { runHostedRefreshRearmPass } from "./hosted-autonomy-refresh-rearm.ts";
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

/** Read-only source facts shared by bookkeeping and the later retry grant. */
export async function readHostedClosedIssues(
  context: HostedAutonomyPassContextV1,
): Promise<void> {
  const { snapshot, scopeFor, actions } = context;
  const closedIssues = new Set<string>();
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    const issueNumber = record.related.issueNumber;
    if (issueNumber === null) continue;
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
  const { deps, actions, revisions, scopeFor, readTip, readPull } = context;
  let { snapshot, observedHead } = context;
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
  for (const record of snapshot.work) {
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
  try {
    installedRuntime = parseReleaseStateSnapshotV1(context.releaseSnapshot)
      .hostedRuntimes.find((runtime) => runtime.id === HOSTED_RUNTIME_ID) ??
      null;
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
    { ciRuntime: installedRuntime },
  );
  const plans: RetryPlanV1[] = [];
  for (const plan of planned) {
    const record = snapshot.work.find((item) =>
      item.id === plan.id && sameRepository(item.repository, plan.repository)
    );
    const pullRequest = record?.target.pr ?? null;
    if (record === undefined || pullRequest === null) {
      plans.push(plan);
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
      plans.push(plan);
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
    ),
    scopeFor,
    actions,
  );
  if (plans.length > 0 || readmissions.length > 0) {
    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return skipped("clock_invalid", observedHead, actions);
    }
    let next: RepairStateSnapshotV1;
    try {
      next = applyBaseRefreshReadmissions(
        applyHostedRetries(snapshot, observedHead as GitSha, plans, now),
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
    for (const plan of plans) {
      actions.push(`retry:${plan.id}:grant=${plan.grant}:${plan.detail}`);
    }
    for (const readmission of readmissions) {
      actions.push(`retry:${readmission.id}:readmit:${readmission.detail}`);
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
