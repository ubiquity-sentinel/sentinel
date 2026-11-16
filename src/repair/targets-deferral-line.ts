/**
 * The advisory line of a hosted pass whose committed targets were all
 * unreadable (src/host/actions-targets-deferral.ts): the setting listed
 * `listed` repositories and every one was skipped because a read could not
 * prove an answer, its default branch (`branchUnavailable`) or its tree facts
 * (`factsUnavailable`); `transient` of them failed in a way that looks
 * transient (src/host/target-read-observer.ts). Only a pass whose every
 * failure looked transient may defer; the line is printed either way.
 * Unavailability, never an empty setting: a setting that lists no repository
 * still refuses (`targets_empty`).
 *
 * Text-free: one closed reason code and four counts, never a slug, message,
 * status or response. It carries `reasonCode`, never `status` (the launcher's
 * child-status scan reads any line with its own `status` as a child record).
 * The launcher re-emits it into the job log (`scanStepLines`) only after this
 * strict re-parse. The job's runtime summary is labelled from the child's own
 * deferral outcome, never from this line. Advisory only.
 */
export const TARGETS_DEFERRAL_KIND = "sentinel_targets_deferral";

/** The closed reason code of a pass deferred on unreadable targets. */
export const TARGETS_UNAVAILABLE_REASON = "targets_unavailable";

/** The committed setting's own bound (`TARGETS_MAX` in src/host/targets.ts). */
export const MAX_TARGETS_DEFERRAL_LISTED = 64;

export interface TargetsDeferralLineV1 {
  kind: typeof TARGETS_DEFERRAL_KIND;
  reasonCode: typeof TARGETS_UNAVAILABLE_REASON;
  listed: number;
  branchUnavailable: number;
  factsUnavailable: number;
  transient: number;
}

const KEYS = [
  "branchUnavailable",
  "factsUnavailable",
  "kind",
  "listed",
  "reasonCode",
  "transient",
].join();

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  value <= MAX_TARGETS_DEFERRAL_LISTED;

/**
 * The line for one load that listed targets and configured none, or null when
 * the counts are not that shape (no listed target, skips that do not add up
 * to the listed targets, or more transient failures than targets).
 */
export function targetsDeferralLineV1(counts: {
  listed: number;
  branchUnavailable: number;
  factsUnavailable: number;
  transient: number;
}): TargetsDeferralLineV1 | null {
  const { listed, branchUnavailable, factsUnavailable, transient } = counts;
  if (
    !count(listed) || listed === 0 || !count(branchUnavailable) ||
    !count(factsUnavailable) ||
    branchUnavailable + factsUnavailable !== listed || !count(transient) ||
    transient > listed
  ) return null;
  return {
    kind: TARGETS_DEFERRAL_KIND,
    reasonCode: TARGETS_UNAVAILABLE_REASON,
    listed,
    branchUnavailable,
    factsUnavailable,
    transient,
  };
}

/** The strictly re-parsed deferral line, or null for anything else. */
export function parseTargetsDeferralLine(
  value: unknown,
): TargetsDeferralLineV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const line = value as Record<string, unknown>;
  if (
    Object.keys(line).sort().join() !== KEYS ||
    line.kind !== TARGETS_DEFERRAL_KIND ||
    line.reasonCode !== TARGETS_UNAVAILABLE_REASON
  ) return null;
  return targetsDeferralLineV1({
    listed: line.listed as number,
    branchUnavailable: line.branchUnavailable as number,
    factsUnavailable: line.factsUnavailable as number,
    transient: line.transient as number,
  });
}
