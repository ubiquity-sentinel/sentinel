/** Post-merge delivery policy only: never used by review or merge gates. */
import type { DeliveryCheckV1 } from "../contracts/delivery-checks.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { parseWorkRecordV1 } from "../contracts/work-record.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { clearWait, markBlocked, setWait } from "./transitions.ts";

/** Trusted producer names; neither issue text nor target code supplies policy. */
const POLICIES: Readonly<
  Record<string, { required_for_delivery: readonly string[] }>
> = {
  "ubiquity/passport.ubq.fi": { required_for_delivery: ["deploy-standby"] },
  "ubiquity/ubq.fi-router": { required_for_delivery: ["deploy"] },
};

export function requiredDeliveryChecks(
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
): readonly string[] {
  return POLICIES[`${repository.owner}/${repository.name}`.toLowerCase()]
    ?.required_for_delivery ?? [];
}

export const DEPLOYMENT_WAIT_MS = 6 * 60 * 60_000;
export const DEPLOYMENT_POLL_MS = 2 * 60_000;

/** Latest run id wins, including a pending rerun over an older green result. */
export function deliveryCheckTransition(
  record: WorkRecordV1,
  checks: readonly DeliveryCheckV1[] | null,
  now: number,
): { record: WorkRecordV1; outcome: "passed" | "wait" | "failed" } {
  const names = requiredDeliveryChecks(record.repository);
  if (names.length === 0) return { record, outcome: "passed" };
  const selected = names.map((name) =>
    checks?.filter((check) =>
      check.name === name && check.head === record.target.head &&
      Number.isSafeInteger(check.runId) && check.runId > 0
    ).sort((a, b) => b.runId - a.runId)[0]
  );
  const failed = selected.find((check) =>
    check?.status === "completed" && check.conclusion !== null &&
    check.conclusion !== "success"
  );
  if (failed !== undefined) {
    return {
      outcome: "failed",
      record: markBlocked(
        record,
        "other",
        `delivery check ${failed.name} run ${failed.runId}: ${failed.conclusion}`,
        now,
      ),
    };
  }
  if (
    selected.some((check) =>
      check?.status !== "completed" || check.conclusion !== "success"
    )
  ) {
    const since = record.wait?.reason === "deployment"
      ? record.wait.since
      : now;
    if (now - since >= DEPLOYMENT_WAIT_MS) {
      const pending = names.map((name, i) => {
        const check = selected[i];
        return check === undefined
          ? `${name} (missing)`
          : `${name} run ${check.runId} (${check.status}/${
            check.conclusion ?? "pending"
          })`;
      }).join(", ");
      return {
        outcome: "failed",
        record: markBlocked(
          record,
          "other",
          `delivery checks timed out: ${pending}`,
          now,
        ),
      };
    }
    return {
      outcome: "wait",
      record: setWait(record, {
        reason: "deployment",
        since,
        until: Math.min(now + DEPLOYMENT_POLL_MS, since + DEPLOYMENT_WAIT_MS),
      }, now),
    };
  }
  const receipt = {
    head: record.target.head!,
    observedAt: now,
    checks: selected.map((check) => ({
      name: check!.name,
      runId: check!.runId,
      conclusion: "success" as const,
    })),
  };
  const cleared = record.wait?.reason === "deployment"
    ? clearWait(record, now)
    : record;
  if (
    record.deliveryReceipt?.head === receipt.head &&
    JSON.stringify(record.deliveryReceipt.checks) ===
      JSON.stringify(receipt.checks)
  ) return { record: cleared, outcome: "passed" };
  return {
    outcome: "passed",
    record: parseWorkRecordV1({
      ...cleared,
      deliveryReceipt: receipt,
      updatedAt: now,
    }),
  };
}
