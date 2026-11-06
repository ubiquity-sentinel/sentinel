/**
 * Launcher re-admission of authenticated historical matrix runtime-mismatch
 * parks (the 2026-11-01 wave: a runtime advance after planning, before the
 * next maintenance run could ingest the finished cells).
 *
 * The parked record still owns its original charged reservation and its
 * implementation intent; only the blocker stopped ordinary recovery. When the
 * plan artifact named by the blocker is still readable, this pass clears the
 * blocker and returns the record to `work` with the SAME intent, counters and
 * reservation, so the existing producer recovery re-ingests the bound wave
 * without a new charge. Nothing else is granted, settled or lowered here.
 *
 * Fail closed: an unreadable or non-matching artifact re-admits nothing; the
 * record, its charge and its counters stay exactly as they were.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  allReservationsV1,
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { implementationIntentKey } from "../src/repair/keys.ts";
import type { HostedPlanArtifactV1 } from "./hosted-autonomy-producer-requests.ts";
import { failed, readRepairSafely, skipped } from "./hosted-autonomy-state.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import type { HostedAutonomyResultV1 } from "./hosted-autonomy-types.ts";

export const MATRIX_RUNTIME_READMISSION_PREFIX =
  "authenticated historical matrix runtime mismatch";

const MATRIX_RUNTIME_BINDING =
  /^authenticated historical matrix runtime mismatch; producer=([1-9][0-9]*):([1-9][0-9]*); runtime=([0-9a-f]{40}); plan=([0-9a-f]{64}); artifact=([1-9][0-9]*); archive=sha256:([0-9a-f]{64}); planner=([1-9][0-9]*); result=([0-9a-f]{64}); original admission retained$/;

export const MATRIX_RUNTIME_READMISSIONS_MAX_PER_PASS = 36;

export interface MatrixRuntimeBindingV1 {
  runId: number;
  runAttempt: number;
  runtimeSha: GitSha;
  planDigest: string;
  artifactId: number;
  archiveDigest: string;
  plannerJobId: number;
  resultDigest: string;
}

export interface MatrixRuntimeReadmissionV1 {
  id: string;
  repository: RepositoryIdentityV1;
  binding: MatrixRuntimeBindingV1;
}

function bindingOf(message: string): MatrixRuntimeBindingV1 | null {
  const match = MATRIX_RUNTIME_BINDING.exec(message);
  if (!match) return null;
  const [runId, runAttempt, artifactId, plannerJobId] = [
    match[1],
    match[2],
    match[5],
    match[7],
  ].map(Number);
  if (
    ![runId, runAttempt, artifactId, plannerJobId].every(Number.isSafeInteger)
  ) return null;
  return {
    runId,
    runAttempt,
    runtimeSha: match[3] as GitSha,
    planDigest: match[4],
    artifactId,
    archiveDigest: "sha256:" + match[6],
    plannerJobId,
    resultDigest: match[8],
  };
}

/**
 * The exact fresh park shape: a blocked implementation with no candidate,
 * its original reserved admission still bound by the same intent key.
 */
function parkedShape(
  record: WorkRecordV1,
  reservation: RepairStateSnapshotV1["reservations"][number],
): MatrixRuntimeBindingV1 | null {
  const intent = record.intent;
  if (
    record.nextStep !== "blocked" || record.blocker?.kind !== "other" ||
    record.wait !== null || record.source.kind !== "issue" ||
    intent?.kind !== "implementation" || intent.requestId === null ||
    intent.key !== implementationIntentKey(intent.requestId) ||
    intent.expectedHead !== null || intent.resultId !== null ||
    intent.pr !== null || intent.observedBase !== record.target.base ||
    intent.branch !== record.target.branch ||
    record.target.head !== null || record.target.pr !== null ||
    record.target.base === null || record.target.branch === null ||
    record.target.candidateState !== undefined ||
    reservation.outcome !== "reserved" || reservation.settledAt !== null ||
    reservation.proofRef !== null ||
    reservation.id !== intent.requestId ||
    reservation.taskId !== record.id ||
    reservation.head !== record.target.base ||
    reservation.attempt !== record.counters.attempts ||
    !["implementation", "retry"].includes(reservation.purpose) ||
    canonicalStringify(reservation.repository) !==
      canonicalStringify(record.repository)
  ) return null;
  return bindingOf(record.blocker.message);
}

/** All locally bound candidates; no remote read happens here. */
export function planMatrixRuntimeReadmissions(
  snapshot: RepairStateSnapshotV1,
  exclude: ReadonlySet<string> = new Set(),
): MatrixRuntimeReadmissionV1[] {
  const reservations = new Map(
    allReservationsV1(snapshot).map((row) => [row.id, row]),
  );
  const planned: MatrixRuntimeReadmissionV1[] = [];
  for (const record of snapshot.work) {
    if (planned.length >= MATRIX_RUNTIME_READMISSIONS_MAX_PER_PASS) break;
    if (exclude.has(record.id)) continue;
    const intent = record.intent;
    if (intent?.requestId === null || intent?.requestId === undefined) continue;
    const reservation = reservations.get(intent.requestId);
    if (reservation === undefined) continue;
    const binding = parkedShape(record, reservation);
    if (binding === null) continue;
    planned.push({
      id: record.id,
      repository: record.repository,
      binding,
    });
  }
  return planned;
}

/**
 * The bound plan artifact must still be the one the blocker names. One
 * producer read serves every candidate it binds; an expired, unlisted or
 * different artifact re-admits none of its records.
 */
export async function verifyMatrixRuntimeReadmissions(
  candidates: readonly MatrixRuntimeReadmissionV1[],
  readPlanArtifact: NonNullable<
    import("./hosted-autonomy-types.ts").HostedClosedMatrixDepsV1[
      "readPlanArtifact"
    ]
  >,
  deadline: number,
  actions: string[],
): Promise<MatrixRuntimeReadmissionV1[]> {
  const cache = new Map<string, HostedPlanArtifactV1 | null>();
  const verified: MatrixRuntimeReadmissionV1[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.binding.runId}:${candidate.binding.runAttempt}`;
    if (!cache.has(key)) {
      let plan: HostedPlanArtifactV1 | null = null;
      try {
        plan = await readPlanArtifact({
          runId: candidate.binding.runId,
          runAttempt: candidate.binding.runAttempt,
        }, deadline);
      } catch {
        plan = null;
      }
      cache.set(key, plan);
    }
    const plan = cache.get(key) ?? null;
    if (
      plan === null || plan.expired !== false ||
      plan.id !== candidate.binding.artifactId ||
      (plan.digest !== null && plan.digest !== candidate.binding.archiveDigest)
    ) {
      actions.push(
        `matrix-runtime:${candidate.id}:skipped:artifact_unreadable`,
      );
      continue;
    }
    verified.push(candidate);
  }
  return verified;
}

/** Return each verified record to work; intent, counters and charge stay. */
export function applyMatrixRuntimeReadmissions(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  readmissions: readonly MatrixRuntimeReadmissionV1[],
  now: number,
): RepairStateSnapshotV1 {
  if (readmissions.length === 0) return snapshot;
  const byId = new Map(readmissions.map((row) => [row.id, row]));
  return parseRepairStateSnapshotV1({
    ...snapshot,
    // A snapshot read from the state branch records the commit's parent;
    // the store requires the transition to name the exact expected head.
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) => {
      const readmission = byId.get(record.id);
      if (readmission === undefined) return record;
      const reservation = allReservationsV1(snapshot).find((row) =>
        row.id === record.intent?.requestId
      );
      if (
        canonicalStringify(readmission.repository) !==
          canonicalStringify(record.repository) ||
        reservation === undefined ||
        parkedShape(record, reservation) === null
      ) throw new TypeError("matrix runtime re-admission lost its park shape");
      return parseWorkRecordV1({
        ...record,
        nextStep: "work",
        wait: null,
        blocker: null,
        updatedAt: now,
      });
    }),
  });
}

/** Protected maintenance: one CAS write; artifact-reader absence writes none. */
export async function runHostedMatrixRuntimeReadmissionPass(
  context: HostedAutonomyPassContextV1,
): Promise<HostedAutonomyResultV1 | null> {
  const { deps, actions, revisions, observedHead } = context;
  const candidates = planMatrixRuntimeReadmissions(
    context.snapshot,
    context.settled,
  );
  if (candidates.length === 0) return null;
  if (deps.closedMatrix === undefined) return null;
  let readPlanArtifact:
    | import("./hosted-autonomy-types.ts").HostedClosedMatrixDepsV1[
      "readPlanArtifact"
    ]
    | undefined;
  try {
    readPlanArtifact = (await deps.closedMatrix()).readPlanArtifact;
  } catch {
    readPlanArtifact = undefined;
  }
  if (readPlanArtifact === undefined) {
    actions.push("matrix-runtime:skipped:artifact_reader_unavailable");
    return null;
  }
  const now = deps.clock.now();
  if (!Number.isSafeInteger(now) || now < context.snapshot.updatedAt) {
    return skipped("clock_invalid", observedHead, actions);
  }
  const readmissions = await verifyMatrixRuntimeReadmissions(
    candidates,
    readPlanArtifact,
    Math.min(now + 60_000, context.deadlineAt ?? now + 60_000),
    actions,
  );
  if (readmissions.length === 0) return null;
  let next: RepairStateSnapshotV1;
  try {
    next = applyMatrixRuntimeReadmissions(
      context.snapshot,
      observedHead as GitSha,
      readmissions,
      now,
    );
  } catch {
    return skipped("snapshot_invalid", observedHead, actions);
  }
  let write;
  try {
    write = await deps.state.writeRepair(next, observedHead as GitSha);
  } catch {
    return failed("write_unavailable", observedHead, actions);
  }
  if (write === null || !write.ok) {
    return failed("write_unavailable", observedHead, actions);
  }
  if (write.value.status === "conflict") {
    return skipped("write_conflict", observedHead, actions);
  }
  if (write.value.status === "ambiguous") {
    return failed("write_ambiguous", observedHead, actions);
  }
  const readback = await readRepairSafely(deps.state);
  if (
    readback === null || !readback.ok ||
    readback.value.status !== "found" ||
    readback.value.head !== write.value.head ||
    canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
  ) {
    return failed("readback_unverified", observedHead, actions);
  }
  for (const readmission of readmissions) {
    actions.push(
      `retry:${readmission.id}:readmit:matrix_runtime_bound_history`,
    );
  }
  return {
    kind: "hosted_autonomy",
    status: "applied",
    reason: "applied",
    beforeHead: observedHead,
    appliedHead: write.value.head,
    actions,
    revisions,
  };
}
