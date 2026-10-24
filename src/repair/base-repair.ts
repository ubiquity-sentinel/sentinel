/**
 * Base-repair lane (2026-10-24 throughput redesign, stage 1).
 *
 * A target whose base branch is red wedges every repair in it: the CI-first
 * gate holds a head whose failing checks are also red on the base
 * (`base_red`) uncharged until "a later base move", and no merge can move a
 * red base. Live, all 39 Passport work records and, behind them, 22 reviewed
 * Passport merges waited on `main` for hours with nothing assigned to fix it.
 *
 * The launcher's base-repair pass (`ops/hosted-autonomy-base-repair.ts`)
 * files one issue per red target base, marked with `BASE_REPAIR_MARKER_PREFIX`
 * on its first body line and labelled P0, so intake selects it before
 * ordinary work. For that task alone a `base_red` failure is the candidate's
 * own: its head still fails the very checks it was asked to fix, so it is
 * routed to an ordinary charged CI fix instead of waiting for a base move
 * that only it can cause. Every other gate (current-head CI, native review,
 * P0, custody, accounting) is unchanged.
 */
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { CiDispositionV1 } from "./ci-rejection.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";

/** First body line prefix of a base-repair issue: `<prefix><branch> -->`. */
export const BASE_REPAIR_MARKER_PREFIX = "<!-- sentinel:base-repair:";

/** The App identity that files base-repair issues. */
export const BASE_REPAIR_AUTHOR = "ubiquity-sentinel[bot]";

/** The marker line of the base-repair issue for `branch`. */
export function baseRepairMarker(branch: string): string {
  return `${BASE_REPAIR_MARKER_PREFIX}${branch} -->`;
}

/** True when `body` is a base-repair issue body (marker on its first line). */
export function isBaseRepairBody(body: string): boolean {
  return body.split(/\r?\n/, 1)[0].startsWith(BASE_REPAIR_MARKER_PREFIX);
}

/**
 * True when `record` is the open base-repair task Sentinel filed. Only a P0
 * issue task is read (a base-repair issue is always filed P0), so ordinary
 * records pay nothing; an unreadable issue is not a base-repair task, which
 * keeps the ordinary `base_red` hold.
 */
export async function isBaseRepairTask(
  deps: Pick<RepairCycleDepsV1, "github">,
  record: WorkRecordV1,
): Promise<boolean> {
  const number = record.related.issueNumber;
  if (
    record.source.kind !== "issue" || number === null ||
    record.classification.severity !== "P0"
  ) return false;
  try {
    const read = await deps.github.readIssue(number);
    return read.ok && read.value !== null && read.value.state === "open" &&
      read.value.author === BASE_REPAIR_AUTHOR &&
      isBaseRepairBody(read.value.body);
  } catch {
    return false;
  }
}

/**
 * The base-repair task owns the red it was filed to fix: a `base_red`
 * disposition of its head is the candidate's own failure (`failed` are the
 * head's failed checks). Every other disposition, and every other record,
 * is returned unchanged.
 */
export async function ownBaseRed(
  deps: Pick<RepairCycleDepsV1, "github">,
  record: WorkRecordV1,
  disposition: CiDispositionV1,
  failed: readonly GitHubCheckV1[],
): Promise<CiDispositionV1> {
  if (disposition.kind !== "base_red") return disposition;
  return await isBaseRepairTask(deps, record)
    ? { kind: "candidate", checks: [...failed] }
    : disposition;
}
