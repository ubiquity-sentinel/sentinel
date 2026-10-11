import assert from "node:assert/strict";
import {
  createLocalRepositoryConfig,
  type LocalStatusInputV1,
  writeLocalStatus,
} from "../../src/host/local.ts";
import { HOUR_WINDOW_MS, SEVEN_DAY_WINDOW_MS } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import {
  portError,
  portOk,
  type PortResultV1,
  type RepairStateWriter,
  type StateReadResultV1,
  type StateReadView,
  type StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type ReleaseStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { reservation, SHA1, SHA2, workRecord } from "../state/helpers.ts";

export const NOW = Date.now();

export const FINISHED = NOW - 30_000;

export const STARTED = FINISHED - 60_000;

export const HOUR = HOUR_WINDOW_MS;

export const WEEK = SEVEN_DAY_WINDOW_MS;

export const MAX_TEXT = 50_000;

export const MAX_DISPATCH_BYTES = 65_535;

export const ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------
// Real parsed fixtures and injected state reads
// ---------------------------------------------------------------------------

export function repairSnapshot(
  work: readonly WorkRecordV1[] = [],
  reservations: readonly BudgetReservationV1[] = [],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: FINISHED,
    incidents: [],
    evidence: [],
    work: [...work],
    reservations: [...reservations],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

/**
 * Intentionally synthetic injected stress snapshot: the large-history case
 * exceeds the frozen 2048-record container cap, so every record is still
 * parsed individually by the frozen reservation parser while this helper
 * assembles the container without the container-level re-parse. It is not a
 * real serialized parsed state file; the serialized state test below covers
 * that read path.
 */
export function extendedRepairSnapshot(
  work: readonly WorkRecordV1[],
  reservations: readonly BudgetReservationV1[],
): RepairStateSnapshotV1 {
  return { ...repairSnapshot(work), reservations: [...reservations] };
}

export class StatusState implements StateReadView, RepairStateWriter {
  reads = 0;
  writes = 0;

  constructor(
    private readonly snapshot: RepairStateSnapshotV1 | null,
    private readonly failRead = false,
  ) {}

  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    this.reads++;
    if (this.failRead || this.snapshot === null) {
      return Promise.resolve(
        portError("unavailable", "private repair state is unreadable"),
      );
    }
    return Promise.resolve(portOk({
      status: "found",
      snapshot: this.snapshot,
      head: SHA1,
      ref: "refs/heads/sentinel-state/repair",
    }));
  }

  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    return Promise.resolve(
      portError("unavailable", "release state is not used by status reporting"),
    );
  }

  writeRepair(
    _next: RepairStateSnapshotV1,
    _expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    this.writes++;
    return Promise.resolve(
      portError("unavailable", "status reporting must not write state"),
    );
  }
}

/**
 * State view backed by a real serialized fixture file: every read parses the
 * file contents with the frozen snapshot parser instead of returning an
 * in-memory object. Used to prove the producer and renderer never rewrite the
 * state fixture bytes.
 */
export class FileStatusState implements StateReadView, RepairStateWriter {
  reads = 0;
  writes = 0;

  constructor(private readonly path: string) {}

  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    this.reads++;
    try {
      const text = Deno.readTextFileSync(this.path);
      const snapshot = parseRepairStateSnapshotV1(JSON.parse(text));
      return Promise.resolve(portOk({
        status: "found",
        snapshot,
        head: SHA1,
        ref: "refs/heads/sentinel-state/repair",
      }));
    } catch {
      return Promise.resolve(
        portError("unavailable", "fixture repair state is unreadable"),
      );
    }
  }

  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    return Promise.resolve(
      portError("unavailable", "release state is not used by status reporting"),
    );
  }

  writeRepair(
    _next: RepairStateSnapshotV1,
    _expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    this.writes++;
    return Promise.resolve(
      portError("unavailable", "status reporting must not write state"),
    );
  }
}

export function work(
  id: string,
  nextStep: WorkRecordV1["nextStep"] = "work",
  issueNumber = 1,
): WorkRecordV1 {
  return workRecord(id, {
    createdAt: FINISHED - 600_000,
    updatedAt: FINISHED - 300_000,
    related: { incidentId: null, issueNumber },
    nextStep,
    blocker: nextStep === "blocked"
      ? {
        kind: "dependency",
        message: "waiting on an upstream dependency",
        since: FINISHED - 500_000,
      }
      : null,
  });
}

export function blockedWork(id: string, issueNumber: number): WorkRecordV1 {
  return work(id, "blocked", issueNumber);
}

export function chargedReservation(
  id: string,
  createdAt: number,
  overrides: Record<string, unknown> = {},
): BudgetReservationV1 {
  return reservation(id, { createdAt, ...overrides });
}

/** `count` simultaneous charged reservations with distinct bounded ids. */
export function chargedReservations(
  prefix: string,
  count: number,
  createdAt: number,
): BudgetReservationV1[] {
  return Array.from(
    { length: count },
    (_value, index) =>
      chargedReservation(
        `${prefix}-${String(index).padStart(3, "0")}`,
        createdAt,
      ),
  );
}

// ---------------------------------------------------------------------------
// Real producer invocation
// ---------------------------------------------------------------------------

export interface ProducedStatusV1 {
  status: Record<string, unknown>;
  fileText: string;
  logLine: string;
}

interface WorkAggregatesV1 {
  total: number;
  byNextStep: Record<string, number>;
  unknownSteps: number;
  blocked: number;
  omitted: number;
  omittedBlocked: number;
}

interface ReservationAggregatesV1 {
  total: number;
  open: number;
  settled: number;
  chargedHour: number;
  chargedSevenDays: number;
  omitted: number;
}

export function workAggregates(
  status: Record<string, unknown>,
): WorkAggregatesV1 {
  const aggregates = status.aggregates as { work: WorkAggregatesV1 } | null;
  assert.ok(aggregates !== null, "available status carries aggregates");
  return aggregates!.work;
}

export function reservationAggregates(
  status: Record<string, unknown>,
): ReservationAggregatesV1 {
  const aggregates = status.aggregates as
    | { reservations: ReservationAggregatesV1 }
    | null;
  assert.ok(aggregates !== null, "available status carries aggregates");
  return aggregates!.reservations;
}

export function detail(status: Record<string, unknown>, key: string) {
  const list = status[key];
  assert.ok(Array.isArray(list), `${key} is an array`);
  return list as Array<Record<string, unknown>>;
}

export async function makeRoot(prefix: string): Promise<string> {
  return await Deno.makeTempDir({ dir: ".", prefix });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function produce(
  state: StateReadView & RepairStateWriter,
  root: string,
  overrides: Partial<LocalStatusInputV1> = {},
): Promise<ProducedStatusV1> {
  const statusPath = `${root}/status.json`;
  const input: LocalStatusInputV1 = {
    state,
    statusPath,
    invocationId: "invocation-0001",
    controllerSha: SHA1,
    targetBaseSha: SHA2,
    login: "owner",
    config: createLocalRepositoryConfig(),
    startedAt: STARTED,
    finishedAt: FINISHED,
    outcome: { status: "idle", detail: "no eligible work" },
    ...overrides,
  };
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...data: unknown[]) => {
    logged.push(data.map((value) => String(value)).join(" "));
  };
  try {
    await writeLocalStatus(input);
  } finally {
    console.log = originalLog;
  }
  assert.equal(logged.length, 1, "exactly one status log line");
  assert.ok(!logged[0].includes("\n"), "the log line is a single line");
  const fileText = await Deno.readTextFile(statusPath);
  const status = JSON.parse(fileText) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(logged[0]), status);
  assert.equal(
    logged[0],
    JSON.stringify(status),
    "compact single-line JSON log",
  );
  const info = await Deno.stat(statusPath);
  assert.equal((info.mode ?? 0) & 0o777, 0o600, "status file stays private");

  // Every produced shape must stay inside the documented bounds.
  assert.equal(status.kind, "sentinel_local_status");
  assert.equal(status.version, "v1");
  assert.equal(status.reportVersion, "v2");
  assert.ok(fileText.length <= MAX_TEXT, `file code units ${fileText.length}`);
  assert.ok(
    ENCODER.encode(fileText).length <= MAX_TEXT,
    `file UTF-8 bytes ${ENCODER.encode(fileText).length}`,
  );
  const envelope = ENCODER.encode(
    JSON.stringify({ inputs: { status: fileText } }),
  ).length;
  assert.ok(envelope <= MAX_DISPATCH_BYTES, `dispatch envelope ${envelope}`);
  assert.ok(detail(status, "work").length <= 200);
  assert.ok(detail(status, "reservations").length <= 200);
  return { status, fileText, logLine: logged[0] };
}

export async function produceSnapshot(
  snapshot: RepairStateSnapshotV1,
  root: string,
  overrides: Partial<LocalStatusInputV1> = {},
): Promise<ProducedStatusV1> {
  return await produce(new StatusState(snapshot), root, overrides);
}

export function assertUnavailable(produced: ProducedStatusV1): void {
  const status = produced.status;
  assert.equal(status.state, "unavailable");
  assert.equal(status.aggregates, null);
  assert.equal(status.summary, "unavailable");
  assert.deepEqual(status.work, []);
  assert.deepEqual(status.reservations, []);
  assert.equal(status.nextEligibleStartAt, null);
}
