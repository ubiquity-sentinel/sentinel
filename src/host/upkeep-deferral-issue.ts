/**
 * The owner-issue notice adapter for the upkeep deferral streak (#327, owner
 * decision 2026-11-05): one owner issue on Sentinel's own repository, found
 * again by its second-line marker, opened on the third consecutive deferral
 * and edited only when a later claim (the streak grew by three more) or a new
 * streak reaches it. It never comments, labels or closes; the owner closes
 * the issue. The body carries only counts, closed reason codes, run ids, the
 * streak start and a DECISIONS pointer: no URL, credential or foreign body.
 *
 * The composite port prefers the issue and falls back to the log adapter
 * under its own bound, so an unavailable issue port never affects the run.
 */
import { createDeadline } from "../github/http.ts";
import { SENTINEL_SKIP_MARKER } from "../repair/target-capability.ts";
import type {
  UpkeepDeferralNoticeV1,
  UpkeepNoticeDeliveryV1,
  UpkeepNoticePortV1,
} from "../contracts/upkeep-deferral-streak.ts";

export const UPKEEP_DEFERRAL_ISSUE_MARKER = "<!-- sentinel:upkeep-deferral -->";
export const UPKEEP_DEFERRAL_DECISIONS_POINTER =
  'docs/DECISIONS.md, "#327 deferred upkeep never fails the run"';
/** The issue attempt's own bound inside the finalize upkeep budget. */
export const UPKEEP_ISSUE_BUDGET_MS = 15_000;

/** The trusted App issue capability on the self repository. */
export interface UpkeepDeferralIssuesV1 {
  /**
   * True when the issue is open, App-authored and carries the marker on its
   * second line; false when it is proven otherwise; null when unproven.
   */
  isOpenMarked(number: number): Promise<boolean | null>;
  /** The lowest open App-authored marker issue; null when unproven. */
  findOpenMarked(): Promise<{ number: number | null } | null>;
  create(input: { title: string; body: string }): Promise<number | null>;
  update(
    number: number,
    input: { title: string; body: string },
  ): Promise<boolean>;
}

/** The exact owner issue body: marker lines first, then the bounded facts. */
export function renderUpkeepDeferralIssueBody(
  notice: UpkeepDeferralNoticeV1,
): string {
  const reasons = (notice.reasons.length > 0 ? notice.reasons : [
    notice.reason,
  ]).map((reason) => `\`${reason}\``).join(", ");
  const started = notice.startedAtMs === null
    ? "not recorded (the streak began before this was recorded)"
    : new Date(notice.startedAtMs).toISOString();
  const shown = notice.runIds.length < notice.count
    ? ` (${notice.runIds.length} of ${notice.count} recorded)`
    : "";
  return [
    SENTINEL_SKIP_MARKER,
    UPKEEP_DEFERRAL_ISSUE_MARKER,
    `Sentinel's self-upkeep pass deferred for ${notice.count} consecutive supervisor cycles.`,
    "",
    `- Reason codes: ${reasons}`,
    `- Streak started: ${started}`,
    `- Supervisor run ids${shown}: ${notice.runIds.join(", ")}`,
    "",
    `What a deferral means: ${UPKEEP_DEFERRAL_DECISIONS_POINTER}.`,
    "Sentinel edits this issue at most once per three further deferrals and never closes it; the owner closes it.",
    "",
  ].join("\n");
}

/** Deliver one claimed notice to the owner issue; null when undelivered. */
export function issueUpkeepNoticePort(
  issues: UpkeepDeferralIssuesV1,
): UpkeepNoticePortV1 {
  return {
    async publish(notice) {
      const text = {
        title: notice.title,
        body: renderUpkeepDeferralIssueBody(notice),
      };
      let target: number | null = null;
      if (notice.issueNumber !== null) {
        // A failed re-check (for example a deleted issue) is only unproven;
        // the marker listing below decides.
        const open = await issues.isOpenMarked(notice.issueNumber).catch(() =>
          null
        );
        if (open === true) target = notice.issueNumber;
      }
      if (target === null) {
        // An unproven listing never creates: a duplicate is worse than a
        // log-only notice, and the marker finds the issue next time.
        const found = await issues.findOpenMarked();
        if (found === null) return null;
        target = found.number;
      }
      if (target !== null) {
        return await issues.update(target, text)
          ? { adapter: "issue", issueNumber: target }
          : null;
      }
      const created = await issues.create(text);
      return created === null
        ? null
        : { adapter: "issue", issueNumber: created };
    },
  };
}

/** Log-only notice port: one bounded JSON line and one step-summary line. */
export function logUpkeepNoticePort(deps: {
  log?: (line: string) => void;
  appendSummary?: (line: string) => Promise<void>;
}): UpkeepNoticePortV1 {
  const log = deps.log ?? ((line: string) => console.log(line));
  return {
    async publish(notice: UpkeepDeferralNoticeV1) {
      log(JSON.stringify({
        kind: "sentinel_upkeep_deferral_notice",
        title: notice.title,
        reason: notice.reason,
        runId: notice.runId,
      }));
      try {
        await deps.appendSummary?.(
          `- ${notice.title}: \`${notice.reason}\` (run ${notice.runId}; delivered by the log adapter)\n`,
        );
      } catch {
        // The summary is a convenience; the log line is the notice.
      }
      return { adapter: "log", issueNumber: null };
    },
  };
}

/**
 * The issue adapter under its own bound, then the log adapter when the issue
 * was not delivered (unavailable, unproven, refused, thrown or timed out).
 */
export function fallbackUpkeepNoticePort(deps: {
  issue: UpkeepNoticePortV1 | null;
  log: UpkeepNoticePortV1;
  appendSummary?: (line: string) => Promise<void>;
  budgetMs?: number;
}): UpkeepNoticePortV1 {
  return {
    async publish(notice) {
      let delivered: UpkeepNoticeDeliveryV1 | null = null;
      if (deps.issue !== null) {
        const deadline = createDeadline(
          deps.budgetMs ?? UPKEEP_ISSUE_BUDGET_MS,
        );
        try {
          delivered = await deadline.race(deps.issue.publish(notice));
        } catch {
          delivered = null;
        } finally {
          deadline.dispose();
        }
      }
      if (delivered === null) return await deps.log.publish(notice);
      try {
        await deps.appendSummary?.(
          `- ${notice.title}: delivered by the issue adapter to owner issue #${delivered.issueNumber}\n`,
        );
      } catch {
        // The summary is a convenience; the issue is the notice.
      }
      return delivered;
    },
  };
}
