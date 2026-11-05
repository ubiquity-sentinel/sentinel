/**
 * Post-merge delivery reads for the hosted GitHub surface (sentinel #337):
 * the check runs and commit statuses on one exact merge commit, and the one
 * trusted progress comment a delivery park posts. Every listing must be
 * complete and bound to the commit; anything else reads as null.
 */
import type { HostedDeliveryCheckV1 } from "./hosted-autonomy-types.ts";
import {
  type createHostedAutonomyRequest,
  LISTING_PAGE_SIZE,
  readHostedCompleteListing,
} from "./hosted-autonomy-github-listing.ts";

const COMMIT_SHA = /^[0-9a-f]{40}$/;

function epoch(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isSafeInteger(at) ? at : null;
}

/** Map one check run; null when it is malformed or bound to another commit. */
export function parseDeliveryCheckRun(
  run: Record<string, unknown>,
  commit: string,
): HostedDeliveryCheckV1 | null {
  const { name, status, conclusion, id } = run;
  if (run["head_sha"] !== commit) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof status !== "string" || status.length === 0) return null;
  if (conclusion !== null && typeof conclusion !== "string") return null;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  return {
    name,
    status,
    conclusion,
    id,
    startedAt: epoch(run["started_at"]),
  };
}

/** Map one commit status (`pending`/`success`/`failure`/`error`). */
export function parseDeliveryCommitStatus(
  status: Record<string, unknown>,
): HostedDeliveryCheckV1 | null {
  const { context, state, id } = status;
  if (typeof context !== "string" || context.length === 0) return null;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  if (state === "pending") {
    return {
      name: context,
      status: "in_progress",
      conclusion: null,
      id,
      startedAt: epoch(status["created_at"]),
    };
  }
  if (state !== "success" && state !== "failure" && state !== "error") {
    return null;
  }
  return {
    name: context,
    status: "completed",
    conclusion: state === "success" ? "success" : "failure",
    id,
    startedAt: epoch(status["created_at"]),
  };
}

export function createHostedDeliveryReads(
  request: ReturnType<typeof createHostedAutonomyRequest>,
  scope: string,
) {
  return {
    async readDeliveryChecks(
      commit: string,
    ): Promise<readonly HostedDeliveryCheckV1[] | null> {
      if (!COMMIT_SHA.test(commit)) return null;
      const runs = await readHostedCompleteListing(
        request,
        (page) =>
          `/repos/${scope}/commits/${commit}/check-runs?filter=all&per_page=${LISTING_PAGE_SIZE}&page=${page}`,
        "check_runs",
        LISTING_PAGE_SIZE,
      );
      if (runs === null) return null;
      const statuses = await readHostedCompleteListing(
        request,
        (page) =>
          `/repos/${scope}/commits/${commit}/status?per_page=${LISTING_PAGE_SIZE}&page=${page}`,
        "statuses",
        LISTING_PAGE_SIZE,
      );
      if (statuses === null) return null;
      const checks: HostedDeliveryCheckV1[] = [];
      for (const run of runs) {
        const parsed = parseDeliveryCheckRun(run, commit);
        if (parsed === null) return null;
        checks.push(parsed);
      }
      for (const status of statuses) {
        const parsed = parseDeliveryCommitStatus(status);
        if (parsed === null) return null;
        checks.push(parsed);
      }
      return checks;
    },
    async commentIssue(number: number, body: string): Promise<boolean> {
      if (!Number.isSafeInteger(number) || number <= 0) return false;
      const created = await request(
        "POST",
        `/repos/${scope}/issues/${number}/comments`,
        { body },
      );
      return created !== null && typeof created === "object" &&
        typeof (created as Record<string, unknown>)["id"] === "number";
    },
  };
}
