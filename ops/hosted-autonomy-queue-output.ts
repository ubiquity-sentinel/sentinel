import {
  isUpkeepDeferralReason,
  type UpkeepDeferralReasonV1,
} from "../src/contracts/upkeep-deferral-streak.ts";

/** Native workflow gate, deliberately outside the R80 stdout protocol. */
export async function writeQueueCustodyOutput(
  path: string | null,
  ready: boolean,
): Promise<void> {
  if (path === null || path.length === 0) return;
  await Deno.writeTextFile(
    path,
    `queueCustodyReady=${ready === true ? "true" : "false"}\n`,
    { append: true },
  );
}

/**
 * The bounded upkeep deferral a maintenance result reports, if any. Independent
 * delivery can apply writes after upkeep deferred; its success must not hide
 * that deferral from finalize. Integrity failures never count as deferrals.
 */
export function upkeepDeferralReason(
  result: { status: string; reason: string; actions?: readonly string[] },
): UpkeepDeferralReasonV1 | null {
  if (result.status !== "skipped" && result.status !== "applied") return null;
  if (result.status === "skipped" && isUpkeepDeferralReason(result.reason)) {
    return result.reason;
  }
  if (result.actions?.includes("historical-matrix:deferred")) {
    return "deferred_historical_quarantine";
  }
  if (result.actions?.includes("matrix-history:deferred")) {
    return "deferred_matrix_history_budget";
  }
  return null;
}

/**
 * Native step output naming the closed deferral reason (or `none`), so the
 * trusted finalize stage can count consecutive deferred upkeep passes.
 */
export async function writeUpkeepDeferralOutput(
  path: string | null,
  reason: UpkeepDeferralReasonV1 | null,
): Promise<void> {
  if (path === null || path.length === 0) return;
  await Deno.writeTextFile(path, `upkeepDeferral=${reason ?? "none"}\n`, {
    append: true,
  });
}
