/**
 * The advisory line of a hosted pass that skipped committed targets because
 * GitHub answered that their repository is private (owner decision
 * 2026-11-18, `src/repair/target-visibility.ts`): `skipped` of the `listed`
 * repositories were private and `configured` targets were loaded.
 *
 * Text-free: one closed reason code and three counts, never a slug, message,
 * status or response. It carries `reason`, never `status` (the launcher's
 * child-status scan reads any line with its own `status` as a child record).
 * The launcher re-emits it into the job log (`scanStepLines`) only after this
 * strict re-parse. Advisory only.
 */
import { PRIVATE_TARGET_REASON } from "./target-visibility.ts";

export const PRIVATE_TARGETS_KIND = "sentinel_private_targets";

/** The committed setting's own bound (`TARGETS_MAX` in src/host/targets.ts). */
const MAX_LISTED = 64;

export interface PrivateTargetsLineV1 {
  kind: typeof PRIVATE_TARGETS_KIND;
  reason: typeof PRIVATE_TARGET_REASON;
  skipped: number;
  listed: number;
  configured: number;
}

const KEYS = ["configured", "kind", "listed", "reason", "skipped"].join();

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  value <= MAX_LISTED;

/**
 * The line for one load that skipped at least one private target, or null
 * when the counts are not that shape (none skipped, or more skipped and
 * configured targets than listed).
 */
export function privateTargetsLineV1(counts: {
  skipped: number;
  listed: number;
  configured: number;
}): PrivateTargetsLineV1 | null {
  const { skipped, listed, configured } = counts;
  if (
    !count(skipped) || skipped === 0 || !count(listed) || !count(configured) ||
    skipped + configured > listed
  ) return null;
  return {
    kind: PRIVATE_TARGETS_KIND,
    reason: PRIVATE_TARGET_REASON,
    skipped,
    listed,
    configured,
  };
}

/** The strictly re-parsed line, or null for anything else. */
export function parsePrivateTargetsLine(
  value: unknown,
): PrivateTargetsLineV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const line = value as Record<string, unknown>;
  if (
    Object.keys(line).sort().join() !== KEYS ||
    line.kind !== PRIVATE_TARGETS_KIND || line.reason !== PRIVATE_TARGET_REASON
  ) return null;
  return privateTargetsLineV1({
    skipped: line.skipped as number,
    listed: line.listed as number,
    configured: line.configured as number,
  });
}
