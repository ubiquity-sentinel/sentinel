/**
 * Delivery-train members and the train's CI verdict (sentinel #330).
 *
 * A train member is a ready reviewed record of a foreign, non-Gateway
 * repository: at `delivery` with its reviewed head and base, a clean accepted
 * current-head review (the LATEST completed review of exactly that head and
 * base authorizes it against the live task statement), its open pull request
 * on exactly that head by a trusted author into the repository's base branch,
 * its own CI green on its reviewed base and no protected path. The patch
 * proof against the train is the composer's (`hosted-autonomy-train-compose.ts`).
 * The same gate is re-read before every merge.
 */
import { hasTakeoverCustody } from "../src/github/existing-pr-takeover-provenance.ts";
import type { ReviewReceiptV1 } from "../src/contracts/review-receipt.ts";
import { CANDIDATE_CONCLUSIONS } from "../src/repair/ci-rejection.ts";
import { isGatewayVpsRepository } from "../src/repair/vps-delivery.ts";
import {
  boundReviewReceipts,
  readTrustedTask,
} from "./hosted-autonomy-delivery.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  isHostedSelf,
} from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyPassContextV1,
  HostedAutonomyScopeV1,
} from "./hosted-autonomy-scopes.ts";
import {
  carriedDeliveryAction,
  headIsGreen,
  latestAuthorizingReceipt,
  parkedStep,
  protectedPathRefusal,
} from "./hosted-autonomy-spent-delivery.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
  HostedAutonomyRecordV1,
} from "./hosted-autonomy-types.ts";

/** The record shape a train may carry (pure; no read). */
export function trainShaped(
  context: Pick<HostedAutonomyPassContextV1, "snapshot">,
  record: HostedAutonomyRecordV1,
): boolean {
  const { pr, head, base } = record.target;
  return !isHostedSelf(record.repository) &&
    !isGatewayVpsRepository(record.repository) &&
    record.nextStep === "delivery" && !parkedStep(record) &&
    record.intent === null && record.source.kind === "issue" &&
    record.related.issueNumber !== null && pr !== null && head !== null &&
    base !== null && !hasTakeoverCustody(record) &&
    carriedDeliveryAction(context.snapshot, record) === null &&
    boundReviewReceipts(context.snapshot, record).length > 0;
}

export type TrainGateV1 =
  | { refusal: string }
  | { refusal: null; receipt: ReviewReceiptV1; pull: HostedAutonomyPullV1 };

/**
 * The per-member gate read before a train is built and again before each
 * merge: the latest current-head review authorizes the live task (and, before
 * a merge, is still the receipt the member was admitted with) and the pull is
 * open on exactly the reviewed head, trusted, into the base branch.
 */
export async function trainMemberGate(
  context: HostedAutonomyPassContextV1,
  scope: HostedAutonomyScopeV1,
  record: HostedAutonomyRecordV1,
  receiptId: string | null,
): Promise<TrainGateV1> {
  const surface = scope.surface;
  const { pr, head } = record.target;
  if (surface === null || pr === null || head === null) {
    return { refusal: "surface_unreadable" };
  }
  const verdict = latestAuthorizingReceipt(
    context.snapshot,
    record,
    await readTrustedTask(surface, record),
  );
  if (verdict.kind !== "authorized") {
    return {
      refusal: verdict.kind === "blocking"
        ? "latest_review_blocking"
        : "task_acceptance_refused",
    };
  }
  if (receiptId !== null && verdict.receipt.id !== receiptId) {
    return { refusal: "review_changed" };
  }
  const pull = await context.readPull(scope, pr);
  if (
    pull === null || pull.state !== "open" || pull.merged !== false ||
    pull.headSha !== head
  ) return { refusal: "pull_changed" };
  if (
    typeof pull.author !== "string" ||
    !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author)
  ) return { refusal: "foreign_author" };
  if (pull.baseRef !== scope.baseBranch) return { refusal: "base_mismatch" };
  return { refusal: null, receipt: verdict.receipt, pull };
}

/** The admission-only reads after the gate: own CI and protected paths. */
export async function trainAdmissionRefusal(
  scope: HostedAutonomyScopeV1,
  record: HostedAutonomyRecordV1,
): Promise<string | null> {
  const surface = scope.surface;
  const { pr, head, base } = record.target;
  if (surface === null || pr === null || head === null || base === null) {
    return "surface_unreadable";
  }
  if (surface.readCommitTree === undefined) return "train_unsupported";
  if (!await headIsGreen(surface, false, head, base)) return "checks_pending";
  return await protectedPathRefusal(surface, record.repository, pr);
}

export type TrainCiVerdictV1 =
  | { kind: "green" }
  | { kind: "red"; runId: number | null; check: string | null }
  | { kind: "pending" }
  | { kind: "unavailable"; cause?: "not_started" };

/**
 * The train commit's CI through the existing read path (backup stand-ins and
 * never-started runs included, exactly as every merge gate reads them): green
 * only when every check completed successfully with every check the tip's
 * suites expect present; red only when a check that ran failed (its name and
 * the failed workflow run's id are the members' wait reason); a readable
 * listing that is neither is pending; anything unreadable is unavailable,
 * never red.
 */
/** True when every failed completed run on `sha` never started a job. */
async function notStarted(
  surface: HostedAutonomyGitHubV1,
  sha: string,
): Promise<boolean> {
  if (surface.runNeverStarted === undefined) return false;
  try {
    const failed = (await surface.listHeadRuns?.(sha) ?? []).filter((run) =>
      run.headSha === sha && run.status === "completed" &&
      run.conclusion !== null && run.conclusion !== "success" &&
      run.conclusion !== "skipped" && run.conclusion !== "neutral"
    );
    if (failed.length === 0) return false;
    for (const run of failed) {
      if (await surface.runNeverStarted(run.id, sha) !== true) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function trainCiVerdict(
  surface: HostedAutonomyGitHubV1,
  sha: string,
  tip: string,
): Promise<TrainCiVerdictV1> {
  let green: boolean | null = null;
  try {
    green = await surface.hasAllChecksGreen(sha, tip);
  } catch {
    green = null;
  }
  if (green === true) return { kind: "green" };
  if (green === null || surface.failedChecks === undefined) {
    return { kind: "unavailable" };
  }
  let failed: string[] | null = null;
  try {
    failed = await surface.failedChecks(sha, CANDIDATE_CONCLUSIONS);
  } catch {
    failed = null;
  }
  if (failed === null) return { kind: "unavailable" };
  if (failed.length === 0) {
    // A run whose jobs never started (the target's billing or spending
    // stop) is no CI result: unavailable, never red and never pending.
    return await notStarted(surface, sha)
      ? { kind: "unavailable", cause: "not_started" }
      : { kind: "pending" };
  }
  let runId: number | null = null;
  try {
    const runs = await surface.listHeadRuns?.(sha) ?? null;
    runId = runs?.filter((run) =>
      run.headSha === sha && run.status === "completed" &&
      run.conclusion !== null && CANDIDATE_CONCLUSIONS.includes(run.conclusion)
    ).map((run) =>
      run.id
    ).sort((a, b) => a - b)[0] ?? null;
  } catch {
    runId = null;
  }
  const check = [...failed].sort()[0] ?? null;
  return {
    kind: "red",
    runId,
    check: check !== null && /^[ -~]{1,200}$/.test(check) ? check : null,
  };
}
