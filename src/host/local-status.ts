import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type { RepairStateWriter, StateReadView } from "../contracts/ports.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { MaxText } from "../contracts/validation.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  earliestRetryAt,
  HOUR_WINDOW_MS,
  isCharged,
  SEVEN_DAY_WINDOW_MS,
} from "../budget/mod.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import {
  DEFAULT_IMPLEMENTATION_MODEL,
  IMPLEMENTATION_REASONING,
  MAX_MODEL_CHARS,
} from "./local-policy.ts";
import { writePrivateFile } from "./local-io.ts";

// ---------------------------------------------------------------------------
// Status and log
// ---------------------------------------------------------------------------

/**
 * Fixed local-report bounds. These are local repository limits, not claimed
 * GitHub limits, and the same number bounds JS code units and UTF-8 bytes.
 * The detail lists are display-only: the complete counts live in aggregates.
 */
const STATUS_MAX_TEXT_CHARS = 50_000;

const STATUS_MAX_TEXT_BYTES = 50_000;

const STATUS_MAX_DETAIL_ITEMS = 200;

/** Conservative workflow-dispatch transport bound (GitHub documents 65,535). */
const STATUS_MAX_DISPATCH_BYTES = 65_535;

/** Fixed report admission semantics: both rolling caps explicitly uncapped. */
const STATUS_POLICY_LIMITS = { perHour: null, perSevenDays: null } as const;

const STATUS_KNOWN_STEPS = [
  "work",
  "review",
  "delivery",
  "blocked",
  "done",
] as const;

type StatusKnownStepV1 = (typeof STATUS_KNOWN_STEPS)[number];

/** Detail priority: blocked first, other nonterminal, then terminal history. */
const STATUS_STEP_PRIORITY: Record<StatusKnownStepV1 | "unknown", number> = {
  blocked: 0,
  work: 1,
  review: 1,
  delivery: 1,
  unknown: 1,
  done: 2,
};

const STATUS_TEXT_ENCODER = new TextEncoder();

export interface LocalStatusInputV1 {
  state: StateReadView & RepairStateWriter;
  statusPath: string;
  invocationId: string;
  /** Exact controller revision this run was started with. */
  controllerSha: GitSha;
  /** Refreshed remote development tip used as the target base. */
  targetBaseSha: string | null;
  /** Authenticated owner login, already shape-validated before this point. */
  login: string | null;
  /** Applied trusted repository configuration. */
  config: RepositoryConfigV1;
  /**
   * Exact route-selected implementation model this run was configured with.
   * Absent callers keep the frozen gateway default; the envelope reports the
   * value the implementation port actually submits.
   */
  modelId?: string;
  startedAt: number;
  finishedAt: number;
  outcome: RepairCycleOutcomeV1;
}

/** Bounded envelope shared by the available and unavailable report shapes. */
interface LocalStatusIdentityV1 {
  envelope: Record<string, unknown>;
  /** Observation time; null when the reported lifecycle is unusable. */
  finishedAt: number | null;
  /** True only when every envelope field is present and bounded. */
  usable: boolean;
}

function isStatusCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedStatusText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Known outcome object: status only, plus steps for step_limit. No detail. */
function statusOutcome(
  outcome: RepairCycleOutcomeV1,
): Record<string, unknown> {
  const record = typeof outcome === "object" && outcome !== null
    ? outcome as unknown as Record<string, unknown>
    : {};
  if (record.status === "step_limit") {
    return isStatusCount(record.steps)
      ? { status: "step_limit", steps: record.steps }
      : { status: "state_error" };
  }
  if (
    record.status === "idle" || record.status === "margin" ||
    record.status === "state_error" || record.status === "source_error"
  ) {
    return { status: record.status };
  }
  return { status: "state_error" };
}

/**
 * Bounded, truthful v1 envelope. The top-level version stays v1 because the
 * retained local receipt consumer parses this shape; `reportVersion: "v2"` is
 * the report-shape cutover and has no legacy fallback. Fields that cannot be
 * bounded are replaced with explicit nulls/"unavailable", never echoed.
 */
function statusIdentity(input: LocalStatusInputV1): LocalStatusIdentityV1 {
  const invocationId = isBoundedStatusText(input.invocationId, MaxText.recordId)
    ? input.invocationId
    : "unavailable";
  const controllerSha = isGitSha(input.controllerSha)
    ? input.controllerSha
    : null;
  const targetBaseSha = isGitSha(input.targetBaseSha)
    ? input.targetBaseSha
    : null;
  const login = isBoundedStatusText(input.login, MaxText.login)
    ? input.login
    : null;
  const startedAt = isStatusCount(input.startedAt) ? input.startedAt : null;
  const finishedAt = isStatusCount(input.finishedAt) ? input.finishedAt : null;
  const lifecycleOrdered = startedAt !== null && finishedAt !== null &&
    finishedAt >= startedAt;
  return {
    envelope: {
      version: "v1",
      kind: "sentinel_local_status",
      reportVersion: "v2",
      invocationId,
      controllerSha,
      targetBaseSha,
      login,
      model: isBoundedStatusText(input.modelId, MAX_MODEL_CHARS)
        ? input.modelId
        : DEFAULT_IMPLEMENTATION_MODEL,
      reasoning: IMPLEMENTATION_REASONING,
      limits: {
        perHour: STATUS_POLICY_LIMITS.perHour,
        perSevenDays: STATUS_POLICY_LIMITS.perSevenDays,
      },
      startedAt: lifecycleOrdered ? startedAt : null,
      finishedAt: lifecycleOrdered ? finishedAt : null,
      outcome: statusOutcome(input.outcome),
    },
    finishedAt: lifecycleOrdered ? finishedAt : null,
    usable: invocationId !== "unavailable" && controllerSha !== null &&
      lifecycleOrdered,
  };
}

/** Truthful failure shape: no counts, no permission statement, empty arrays. */
function unavailableStatus(
  identity: LocalStatusIdentityV1,
): Record<string, unknown> {
  return {
    ...identity.envelope,
    state: "unavailable",
    aggregates: null,
    summary: "unavailable",
    work: [],
    reservations: [],
    nextEligibleStartAt: null,
  };
}

/**
 * Sanitized status: bounded identities, counts and times only; no bodies,
 * blocker text, model output, provider request or artifact reference.
 */
export async function writeLocalStatus(
  input: LocalStatusInputV1,
): Promise<void> {
  const status = await projectLocalStatus(input);
  const text = JSON.stringify(status, null, 2) + "\n";
  await writePrivateFile(input.statusPath, text);
  console.log(JSON.stringify(status));
}

async function projectLocalStatus(
  input: LocalStatusInputV1,
): Promise<Record<string, unknown>> {
  const identity = statusIdentity(input);
  const finishedAt = identity.finishedAt;
  if (
    !identity.usable || finishedAt === null ||
    !hasStatusPolicyLimits(input.config)
  ) {
    return unavailableStatus(identity);
  }
  let snapshot: RepairStateSnapshotV1;
  try {
    const read = await input.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      return unavailableStatus(identity);
    }
    snapshot = read.value.snapshot;
  } catch {
    return unavailableStatus(identity);
  }
  try {
    return projectStatusSnapshot(snapshot, finishedAt, identity);
  } catch {
    return unavailableStatus(identity);
  }
}

function hasStatusPolicyLimits(config: RepositoryConfigV1): boolean {
  return config.liveStartLimits?.perHour === STATUS_POLICY_LIMITS.perHour &&
    config.liveStartLimits?.perSevenDays === STATUS_POLICY_LIMITS.perSevenDays;
}

function statusWorkStep(nextStep: unknown): StatusKnownStepV1 | "unknown" {
  return (STATUS_KNOWN_STEPS as readonly unknown[]).includes(nextStep)
    ? nextStep as StatusKnownStepV1
    : "unknown";
}

/** Complete aggregates, bounded detail; omissions are recomputed per shape. */
function projectStatusSnapshot(
  snapshot: RepairStateSnapshotV1,
  finishedAt: number,
  identity: LocalStatusIdentityV1,
): Record<string, unknown> {
  const work = snapshot.work;
  const reservations = snapshot.reservations;
  if (!Array.isArray(work) || !Array.isArray(reservations)) {
    return unavailableStatus(identity);
  }
  if (!statusReservationsValid(reservations, finishedAt)) {
    return unavailableStatus(identity);
  }
  let retryAt: number;
  try {
    retryAt = earliestRetryAt(reservations, finishedAt, STATUS_POLICY_LIMITS);
  } catch {
    return unavailableStatus(identity);
  }

  const byNextStep: Record<StatusKnownStepV1, number> = {
    work: 0,
    review: 0,
    delivery: 0,
    blocked: 0,
    done: 0,
  };
  let unknownSteps = 0;
  for (const record of work) {
    const step = statusWorkStep(record?.nextStep);
    if (step === "unknown") unknownSteps++;
    else byNextStep[step]++;
  }
  const blocked = byNextStep.blocked;
  const charged = reservations.filter(isCharged);
  const chargedHour =
    charged.filter((entry) =>
      entry.createdAt > finishedAt - HOUR_WINDOW_MS &&
      entry.createdAt <= finishedAt
    ).length;
  const chargedSevenDays =
    charged.filter((entry) =>
      entry.createdAt > finishedAt - SEVEN_DAY_WINDOW_MS &&
      entry.createdAt <= finishedAt
    ).length;
  const open = reservations.filter((entry) => entry.settledAt === null).length;
  const totalWork = work.length;
  const totalReservations = reservations.length;

  let workDetail = selectStatusWorkDetail(work);
  let reservationDetail = selectStatusReservationDetail(reservations);
  for (;;) {
    const aggregates = {
      work: {
        total: totalWork,
        byNextStep: { ...byNextStep },
        unknownSteps,
        blocked,
        omitted: totalWork - workDetail.length,
        omittedBlocked: blocked - countStatusStep(workDetail, "blocked"),
      },
      reservations: {
        total: totalReservations,
        open,
        settled: totalReservations - open,
        chargedHour,
        chargedSevenDays,
        omitted: totalReservations - reservationDetail.length,
      },
    };
    const status = {
      ...identity.envelope,
      aggregates,
      summary: aggregates.work.omitted === 0 &&
          aggregates.reservations.omitted === 0
        ? "complete"
        : "truncated",
      work: workDetail,
      reservations: reservationDetail,
      nextEligibleStartAt: retryAt > finishedAt ? retryAt : null,
    };
    const text = JSON.stringify(status, null, 2) + "\n";
    if (statusTextWithinBounds(text)) return status;
    // Reduce only optional detail, deterministically, until every bound holds.
    // Reservation history is optional display detail and is dropped first so
    // blocked work detail survives byte pressure; the work ordering below then
    // removes done/nonterminal history before blocked work.
    if (reservationDetail.length > 0) {
      reservationDetail = reservationDetail.slice(0, -1);
    } else if (workDetail.length > 0) {
      workDetail = workDetail.slice(0, -1);
    } else return unavailableStatus(identity);
  }
}

/** Invalid or future reservation chronology must never look permissive. */
function statusReservationsValid(
  reservations: readonly BudgetReservationV1[],
  finishedAt: number,
): boolean {
  for (const entry of reservations) {
    if (typeof entry !== "object" || entry === null) return false;
    if (!isStatusCount(entry.createdAt) || entry.createdAt > finishedAt) {
      return false;
    }
    if (entry.settledAt === null) continue;
    if (
      !isStatusCount(entry.settledAt) || entry.settledAt < entry.createdAt ||
      entry.settledAt > finishedAt
    ) {
      return false;
    }
  }
  return true;
}

function selectStatusWorkDetail(
  work: readonly WorkRecordV1[],
): Array<Record<string, unknown>> {
  const ordered = work.map((record, index) => ({ record, index }));
  ordered.sort((left, right) => {
    const leftPriority =
      STATUS_STEP_PRIORITY[statusWorkStep(left.record?.nextStep)];
    const rightPriority =
      STATUS_STEP_PRIORITY[statusWorkStep(right.record?.nextStep)];
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftId = typeof left.record?.id === "string" ? left.record.id : "";
    const rightId = typeof right.record?.id === "string" ? right.record.id : "";
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return left.index - right.index;
  });
  return ordered.slice(0, STATUS_MAX_DETAIL_ITEMS).map(({ record }) => ({
    id: record.id,
    sourceKind: record.source?.kind,
    issueNumber: record.related?.issueNumber ?? null,
    nextStep: statusWorkStep(record.nextStep),
    head: record.target?.head ?? null,
    pr: record.target?.pr ?? null,
    updatedAt: record.updatedAt,
  }));
}

function selectStatusReservationDetail(
  reservations: readonly BudgetReservationV1[],
): Array<Record<string, unknown>> {
  const ordered = reservations.map((entry, index) => ({ entry, index }));
  ordered.sort((left, right) => {
    const leftId = typeof left.entry?.id === "string" ? left.entry.id : "";
    const rightId = typeof right.entry?.id === "string" ? right.entry.id : "";
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return left.index - right.index;
  });
  return ordered.slice(0, STATUS_MAX_DETAIL_ITEMS).map(({ entry }) => ({
    taskId: entry.taskId,
    purpose: entry.purpose,
    createdAt: entry.createdAt,
    settledAt: entry.settledAt,
    outcome: entry.outcome,
  }));
}

function countStatusStep(
  detail: readonly Record<string, unknown>[],
  step: string,
): number {
  let count = 0;
  for (const entry of detail) if (entry.nextStep === step) count++;
  return count;
}

/** Every bound on the actual status file and its dispatch transport. */
function statusTextWithinBounds(text: string): boolean {
  if (text.length > STATUS_MAX_TEXT_CHARS) return false;
  if (STATUS_TEXT_ENCODER.encode(text).length > STATUS_MAX_TEXT_BYTES) {
    return false;
  }
  const envelope = JSON.stringify({ inputs: { status: text } });
  return STATUS_TEXT_ENCODER.encode(envelope).length <=
    STATUS_MAX_DISPATCH_BYTES;
}
