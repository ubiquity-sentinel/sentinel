/**
 * Delivery trains (sentinel #330): the launcher's durable train ledger and
 * the ports a train uses. Launcher-local: nothing here is read by the repair
 * snapshot parser, the step loop or generation 80, so it adds no state shape.
 *
 * One ledger per repository holds at most one open train (the members it
 * composed onto one tip, their per-member proofs, the operation-bound train
 * ref, its phase and the pending merge intent), the verified landings (the
 * closure's durable evidence for a member that landed on a moved base) and
 * the CI drops (a member's precise wait reason: run id and check name).
 * Every effect (train ref push, CI trigger, each merge call) is preceded by
 * an applied ledger write naming it, so a crash or a deadline never leaves
 * an unrecorded merge: the next pass adopts the pending one or stops.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";

/** Train ref namespace on the target repository (operation-bound). */
export const DELIVERY_TRAIN_REF_PREFIX = "refs/heads/sentinel-trains/";

/** A train whose CI gives no verdict this long is dissolved (unavailable). */
export const DELIVERY_TRAIN_CI_WAIT_MS = 2 * 60 * 60_000;

/** Bounds of the retained landing and drop rows (oldest pruned first). */
export const DELIVERY_TRAIN_MAX_LANDINGS = 256;
export const DELIVERY_TRAIN_MAX_DROPS = 64;
/** Members of one train; a larger ready set fills the next train. */
export const DELIVERY_TRAIN_MAX_MEMBERS = 16;

/** One member: its reviewed identity and its proof against the train. */
export interface DeliveryTrainMemberV1 {
  readonly recordId: string;
  readonly pullRequest: number;
  /** The reviewed head and base its current-head review binds. */
  readonly head: string;
  readonly base: string;
  readonly receiptId: string;
  /** The train commit after this member (tip ⊕ p1 ⊕ … ⊕ this member). */
  readonly commit: string;
  /** SHA-256 of the carried patch (reviewed side equals the train side). */
  readonly patch: string;
  /** Set once this member's merge is verified (null before). */
  readonly landedOn: string | null;
  readonly revision: string | null;
}

export type DeliveryTrainPhaseV1 = "publishing" | "published" | "merging";

export interface DeliveryTrainV1 {
  readonly operationId: string;
  readonly ref: string;
  /** The base tip the train was composed on. */
  readonly tip: string;
  /** 1, or 2 for the one same-pass retry after a red first train. */
  readonly attempt: 1 | 2;
  /** The train commit the CI runs on (the last member's commit). */
  readonly sha: string;
  readonly members: readonly DeliveryTrainMemberV1[];
  readonly phase: DeliveryTrainPhaseV1;
  /** Index of the member whose merge call intent is persisted, or null. */
  readonly pendingMerge: number | null;
  readonly createdAt: number;
}

/** A verified landing: the closure's durable train evidence. */
export interface DeliveryTrainLandingV1 {
  readonly operationId: string;
  readonly recordId: string;
  readonly pullRequest: number;
  readonly head: string;
  readonly base: string;
  /** The tip the merge landed on and the merge commit. */
  readonly landedOn: string;
  readonly revision: string;
  /** The landed tree: exactly the train commit's tree after this member. */
  readonly tree: string;
}

/** A member a red train dropped; it waits while head and tip are unchanged. */
export interface DeliveryTrainDropV1 {
  readonly recordId: string;
  readonly head: string;
  readonly tip: string;
  readonly runId: number | null;
  readonly check: string | null;
  readonly at: number;
}

export interface DeliveryTrainLedgerV1 {
  readonly version: "v1";
  readonly train: DeliveryTrainV1 | null;
  readonly landings: readonly DeliveryTrainLandingV1[];
  readonly drops: readonly DeliveryTrainDropV1[];
}

export const EMPTY_DELIVERY_TRAIN_LEDGER: DeliveryTrainLedgerV1 = {
  version: "v1",
  train: null,
  landings: [],
  drops: [],
};

/** The durable ledger store (one document per repository; CAS writes). */
export interface DeliveryTrainJournalV1 {
  /** The ledger and its head (null head: never written); null: unreadable. */
  read(
    repository: RepositoryIdentityV1,
  ): Promise<{ head: string | null; ledger: DeliveryTrainLedgerV1 } | null>;
  /** Non-force write against the exact expected head; null: unavailable. */
  write(input: {
    repository: RepositoryIdentityV1;
    expectedHead: string | null;
    ledger: DeliveryTrainLedgerV1;
  }): Promise<
    {
      status: "applied" | "conflict" | "ambiguous";
      head: string | null;
    } | null
  >;
}

/** One member's composition step onto the train so far. */
export type DeliveryTrainComposeStepV1 =
  | {
    readonly status: "joined";
    readonly commit: string;
    readonly patch: string;
  }
  | { readonly status: "conflict" | "patch_changed" | "unproven" };

/**
 * The deterministic train builder of one repository (production: the
 * `merge-tree --write-tree` executor, `hosted-autonomy-train-compose.ts`).
 * Composition only writes local objects; `publish` is the train ref push.
 */
export interface DeliveryTrainComposerV1 {
  /**
   * Fold each member onto the train in order; a member that does not join
   * is skipped and the next one composes on the last joined commit. Null when
   * the composition itself is unavailable (missing objects, bounds).
   */
  compose(input: {
    tip: string;
    members: readonly { head: string; base: string }[];
  }): Promise<readonly DeliveryTrainComposeStepV1[] | null>;
  /** Push `sha` to the absent `ref`; an existing equal ref is `applied`. */
  publish(input: {
    ref: string;
    sha: string;
  }): Promise<"applied" | "rejected" | "ambiguous">;
  /** Optional explicit CI request (workflow_dispatch) for a pushed ref. */
  triggerCi?(input: { ref: string; sha: string }): Promise<boolean>;
}

export interface HostedDeliveryTrainDepsV1 {
  journal: DeliveryTrainJournalV1;
  composerFor(repository: RepositoryIdentityV1): DeliveryTrainComposerV1 | null;
}

const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OP = /^[0-9a-f]{24}$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
const sha = (value: unknown): value is string =>
  typeof value === "string" && SHA.test(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function keys(row: Record<string, unknown>, names: readonly string[]): boolean {
  const own = Object.keys(row).sort();
  return own.length === names.length &&
    [...names].sort().every((name, index) => own[index] === name);
}

function parseMember(value: unknown): DeliveryTrainMemberV1 | null {
  const row = object(value);
  if (
    row === null ||
    !keys(row, [
      "recordId",
      "pullRequest",
      "head",
      "base",
      "receiptId",
      "commit",
      "patch",
      "landedOn",
      "revision",
    ]) || !id(row.recordId) || !count(row.pullRequest) || !sha(row.head) ||
    !sha(row.base) || !id(row.receiptId) || !sha(row.commit) ||
    typeof row.patch !== "string" || !HEX64.test(row.patch) ||
    (row.landedOn === null) !== (row.revision === null) ||
    (row.landedOn !== null && !sha(row.landedOn)) ||
    (row.revision !== null && !sha(row.revision))
  ) return null;
  return row as unknown as DeliveryTrainMemberV1;
}

function parseTrain(value: unknown): DeliveryTrainV1 | null {
  const row = object(value);
  if (
    row === null ||
    !keys(row, [
      "operationId",
      "ref",
      "tip",
      "attempt",
      "sha",
      "members",
      "phase",
      "pendingMerge",
      "createdAt",
    ]) || typeof row.operationId !== "string" || !OP.test(row.operationId) ||
    row.ref !== `${DELIVERY_TRAIN_REF_PREFIX}${row.operationId}` ||
    !sha(row.tip) || (row.attempt !== 1 && row.attempt !== 2) ||
    !sha(row.sha) || !Array.isArray(row.members) ||
    row.members.length === 0 ||
    row.members.length > DELIVERY_TRAIN_MAX_MEMBERS ||
    (row.phase !== "publishing" && row.phase !== "published" &&
      row.phase !== "merging") ||
    !time(row.createdAt) ||
    (row.pendingMerge !== null &&
      (!Number.isSafeInteger(row.pendingMerge) ||
        (row.pendingMerge as number) < 0 ||
        (row.pendingMerge as number) >= row.members.length))
  ) return null;
  const members = row.members.map(parseMember);
  if (members.some((member) => member === null)) return null;
  if (members.at(-1)!.commit !== row.sha) return null;
  return { ...row, members } as unknown as DeliveryTrainV1;
}

function parseLanding(value: unknown): DeliveryTrainLandingV1 | null {
  const row = object(value);
  return row !== null &&
      keys(row, [
        "operationId",
        "recordId",
        "pullRequest",
        "head",
        "base",
        "landedOn",
        "revision",
        "tree",
      ]) && typeof row.operationId === "string" &&
      OP.test(row.operationId) && id(row.recordId) &&
      count(row.pullRequest) && sha(row.head) && sha(row.base) &&
      sha(row.landedOn) && sha(row.revision) && sha(row.tree)
    ? row as unknown as DeliveryTrainLandingV1
    : null;
}

function parseDrop(value: unknown): DeliveryTrainDropV1 | null {
  const row = object(value);
  return row !== null &&
      keys(row, ["recordId", "head", "tip", "runId", "check", "at"]) &&
      id(row.recordId) && sha(row.head) && sha(row.tip) &&
      (row.runId === null || count(row.runId)) &&
      (row.check === null ||
        (typeof row.check === "string" &&
          /^[ -~]{1,200}$/.test(row.check))) &&
      time(row.at)
    ? row as unknown as DeliveryTrainDropV1
    : null;
}

/** Strict ledger parse; any other shape is null (fail closed). */
export function parseDeliveryTrainLedgerV1(
  value: unknown,
): DeliveryTrainLedgerV1 | null {
  const row = object(value);
  if (
    row === null || !keys(row, ["version", "train", "landings", "drops"]) ||
    row.version !== "v1" || !Array.isArray(row.landings) ||
    !Array.isArray(row.drops) ||
    row.landings.length > DELIVERY_TRAIN_MAX_LANDINGS ||
    row.drops.length > DELIVERY_TRAIN_MAX_DROPS
  ) return null;
  const train = row.train === null ? null : parseTrain(row.train);
  if (row.train !== null && train === null) return null;
  const landings = row.landings.map(parseLanding);
  const drops = row.drops.map(parseDrop);
  if (landings.some((x) => x === null) || drops.some((x) => x === null)) {
    return null;
  }
  return {
    version: "v1",
    train,
    landings: landings as DeliveryTrainLandingV1[],
    drops: drops as DeliveryTrainDropV1[],
  };
}
