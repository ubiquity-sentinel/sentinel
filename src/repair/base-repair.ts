/**
 * Base-repair lane (2026-10-24 throughput redesign, stage 1; reworked
 * 2026-10-25 after its review).
 *
 * A target whose base branch is red wedges every repair in it: the CI-first
 * gate holds a head whose failing checks are also red on the base
 * (`base_red`) uncharged until "a later base move", and no merge can move a
 * red base. Live, all 39 Passport work records and, behind them, 22 reviewed
 * Passport merges waited on `main` for hours with nothing assigned to fix it.
 *
 * The launcher's base-repair pass (`ops/hosted-autonomy-base-repair.ts`)
 * files one unlabelled issue per red tip that actually holds records, with
 * `baseRepairMarker(branch, tip)` as its first body line. For that task alone
 * (the App's issue with the marker on its first line, nothing else: no
 * label, no severity), a `base_red` failure on the current tip is the
 * candidate's own: its head still fails the very checks it was asked to fix,
 * so it is routed to an ordinary charged CI fix instead of waiting for a base
 * move that only it can cause. A record whose base is no longer the tip keeps
 * `base_red`, so the moved base refreshes it first, uncharged. Every other
 * gate (current-head CI, native review, P0, custody, accounting) is
 * unchanged, and a closed issue is still refused before any charge
 * (`readIssueForModel`).
 */
import type { RepairCycleDepsV1 } from "./loop-types.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  type CiAttributionV1,
  type CiDispositionV1,
  decideCiDisposition,
} from "./ci-rejection.ts";

/** First body line prefix of a base-repair issue (`baseRepairMarker`). */
export const BASE_REPAIR_MARKER_PREFIX = "<!-- sentinel:base-repair:";

const MARKER_SUFFIX = " -->";
const TIP = /^(.+)@([0-9a-f]{40})$/;

/** The App identity that files base-repair issues. */
export const BASE_REPAIR_AUTHOR = "ubiquity-sentinel[bot]";

/**
 * The marker line of the base-repair issue filed for `branch` at commit
 * `tip`: `<!-- sentinel:base-repair:<branch>@<tip> -->`.
 */
export function baseRepairMarker(branch: string, tip: string): string {
  return `${BASE_REPAIR_MARKER_PREFIX}${branch}@${tip}${MARKER_SUFFIX}`;
}

/**
 * The branch and tip a marker line names, or null for any other line. A
 * marker of the first, tip-less form (`<branch> -->`) names its branch with
 * a null tip.
 */
export function parseBaseRepairMarker(
  line: string,
): { branch: string; tip: string | null } | null {
  if (
    !line.startsWith(BASE_REPAIR_MARKER_PREFIX) || !line.endsWith(MARKER_SUFFIX)
  ) return null;
  const inner = line.slice(
    BASE_REPAIR_MARKER_PREFIX.length,
    line.length - MARKER_SUFFIX.length,
  );
  if (inner.length === 0) return null;
  const bound = TIP.exec(inner);
  return bound === null
    ? { branch: inner, tip: null }
    : { branch: bound[1], tip: bound[2] };
}

/** True when `body` is a base-repair issue body (marker on its first line). */
export function isBaseRepairBody(body: string): boolean {
  return body.split(/\r?\n/, 1)[0].startsWith(BASE_REPAIR_MARKER_PREFIX);
}

/** Verdicts one run keeps (an issue's author and first line are its own). */
const MEMO_MAX = 256;
const recognised = new WeakMap<object, Map<string, boolean>>();

/**
 * Whether `record` is a base-repair task: an issue task whose issue the App
 * authored with the marker on its first body line. Read only when a caller
 * needs it (a `base_red` disposition) and memoised per run (`deps`). Null
 * when the issue read is unavailable: the caller defers without a write.
 */
export async function isBaseRepairTask(
  deps: Pick<RepairCycleDepsV1, "github">,
  record: WorkRecordV1,
): Promise<boolean | null> {
  const number = record.related.issueNumber;
  if (record.source.kind !== "issue" || number === null) return false;
  const { owner, name, installationId } = record.repository;
  const key = `${installationId}/${owner}/${name}#${number}`;
  const known = recognised.get(deps)?.get(key);
  if (known !== undefined) return known;
  let verdict: boolean;
  try {
    const read = await deps.github.readIssue(number);
    if (!read.ok) return null;
    verdict = read.value !== null && read.value.number === number &&
      read.value.author === BASE_REPAIR_AUTHOR &&
      isBaseRepairBody(read.value.body);
  } catch {
    return null;
  }
  let memo = recognised.get(deps);
  if (memo === undefined) {
    memo = new Map();
    recognised.set(deps, memo);
  }
  if (memo.size < MEMO_MAX) memo.set(key, verdict);
  return verdict;
}

/**
 * The disposition of a head's failed checks (`attribution`, against its
 * base). A base-repair task owns the red it was filed to fix: its `base_red`
 * on the current tip is its own failure, exactly the checks red on both
 * (`attribution.baseRed`, never a secondary cancelled one), marked
 * `redBase` so its finding does not claim they passed on the base. On a base
 * that is no longer the tip it stays `base_red` (the moved base refreshes it
 * first, uncharged). Null when the issue or tip read is unavailable. Every
 * other disposition and record is returned unchanged, without a read.
 */
export async function ownBaseRed(
  deps: Pick<RepairCycleDepsV1, "github" | "configs">,
  record: WorkRecordV1,
  attribution: CiAttributionV1,
): Promise<CiDispositionV1 | null> {
  const disposition = decideCiDisposition(attribution);
  if (disposition.kind !== "base_red") return disposition;
  const task = await isBaseRepairTask(deps, record);
  if (task !== true) return task === null ? null : disposition;
  const { owner, name, installationId } = record.repository;
  const config = deps.configs.find((candidate) =>
    candidate.repository.owner === owner &&
    candidate.repository.name === name &&
    candidate.repository.installationId === installationId
  );
  if (config === undefined) return disposition;
  try {
    const tip = await deps.github.readRef(`refs/heads/${config.baseBranch}`);
    if (!tip.ok || tip.value === null) return null;
    if (tip.value.sha !== record.target.base) return disposition;
  } catch {
    return null;
  }
  return { kind: "candidate", checks: [...attribution.baseRed], redBase: true };
}
