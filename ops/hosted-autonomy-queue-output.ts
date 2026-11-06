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

/** The bounded upkeep deferral a maintenance result reports, if any. */
export function upkeepDeferralReason(
  result: { status: string; reason: string },
): UpkeepDeferralReasonV1 | null {
  if (result.status !== "skipped") return null;
  return isUpkeepDeferralReason(result.reason) ? result.reason : null;
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
