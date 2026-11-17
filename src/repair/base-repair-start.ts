/**
 * What a base-repair task's fresh implementation start carries (2026-11-17,
 * ai.ubq.fi 1370). Its first start had only the issue body: the red base
 * and its failing check names, but none of the failure output a CI fix
 * receives, in a sandbox without network to reproduce the checks; it made
 * no change. Now the start carries the checks its base fails as the
 * base-repair CI finding (`ciCorrectionFinding` with `redBase`, trusted check
 * names only), and a matrix cell keys its existing CI failure evidence read
 * on that opening (`ciCorrectionHead`), for the red base itself: the same
 * reader, fence, size bounds and sanitising as a CI fix. No new text source:
 * the finding is built from check names and conclusions, and the evidence is
 * read only in the cell, never persisted or put in the request.
 */
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { isBaseRepairBody, isBaseRepairTask } from "./base-repair.ts";
import {
  CANDIDATE_CONCLUSIONS,
  checkPending,
  ciCorrectionFinding,
  failedChecks,
  latestChecks,
  readCiChecks,
} from "./ci-rejection.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";
import { selectMergeGateChecksV1 } from "./merge-gate-checks.ts";

/** Deferral of a base-repair start whose issue or base checks are unread. */
export const BASE_REPAIR_START_UNAVAILABLE =
  "base-repair start waits for its issue and base checks";

/** Deferral of a base-repair start whose base has no completed red check yet. */
export const BASE_REPAIR_START_PENDING =
  "base-repair start waits for its base checks to complete";

/**
 * A base's merge-gate checks as read: `red` with its completed
 * `failure`/`timed_out` checks; else `pending` while one is still running or
 * none is reported yet (no evidence is never settled); else `settled`.
 */
export function baseCheckState(
  repository: RepositoryIdentityV1,
  checks: readonly GitHubCheckV1[],
):
  | { kind: "red"; checks: GitHubCheckV1[] }
  | { kind: "pending" }
  | { kind: "settled" } {
  const gate = selectMergeGateChecksV1(repository, checks).checks;
  const red = failedChecks(gate).filter((check) =>
    CANDIDATE_CONCLUSIONS.includes(check.conclusion ?? "")
  );
  if (red.length > 0) return { kind: "red", checks: red };
  const latest = latestChecks(gate);
  return latest.length === 0 || latest.some(checkPending)
    ? { kind: "pending" }
    : { kind: "settled" };
}

export type BaseRepairStartV1 =
  | { kind: "none" }
  | {
    kind: "finding";
    finding: { severity: string; path: string | null; message: string };
  }
  | { kind: "unavailable"; detail: string };

/**
 * The CI finding of a fresh start of `record` from `issue`: `none` for a
 * body without the base-repair marker (nothing is read), for an issue that
 * is not the App's (`isBaseRepairTask`), and for a base whose checks all
 * completed without a red one; `unavailable` when the issue or the base's
 * checks cannot be read, or none is red yet while one is pending or none is
 * reported, so the caller defers, uncharged, instead of starting blind.
 */
export async function baseRepairStartFinding(
  deps: Pick<RepairCycleDepsV1, "github">,
  record: WorkRecordV1,
  issue: { body: string } | null,
): Promise<BaseRepairStartV1> {
  if (issue === null || !isBaseRepairBody(issue.body)) return { kind: "none" };
  const unavailable = {
    kind: "unavailable",
    detail: BASE_REPAIR_START_UNAVAILABLE,
  } as const;
  const task = await isBaseRepairTask(deps, record);
  if (task === null) return unavailable;
  if (!task) return { kind: "none" };
  const base = record.target.base;
  try {
    const read = await readCiChecks(deps.github, base);
    if (!read.ok || read.value.head !== base) return unavailable;
    const state = baseCheckState(record.repository, read.value.checks);
    return state.kind === "red"
      ? {
        kind: "finding",
        finding: ciCorrectionFinding(base, state.checks, true),
      }
      : state.kind === "pending"
      ? { kind: "unavailable", detail: BASE_REPAIR_START_PENDING }
      : { kind: "none" };
  } catch {
    return unavailable;
  }
}
