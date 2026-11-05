/** The sole trusted writer: verify all deltas, then publish ONE non-force CAS. */
import type { GitSha } from "../contracts/brands.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports-state.ts";
import {
  assertRepairDeltaScope,
  parseSignedRepairDelta,
  type RepairDeltaPlanV1,
  sameRepairRepository,
  verifyRepairDelta,
} from "../contracts/signed-repair-delta.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { MaxItems } from "../contracts/validation.ts";
import { OPERATION_MARGIN_MS } from "../repair/loop-bounds.ts";
import { validateSnapshotTransition } from "../state/state-transition.ts";

export interface RepairDeltaSubmissionV1 {
  /** All three fields come from trusted prepare/artifact transport, not the cell. */
  plan: RepairDeltaPlanV1;
  publicKey: CryptoKey;
  artifact: string | null;
}

type DeltaStatus =
  | "applied"
  | "noop"
  | "stale"
  | "invalid"
  | "deadline"
  | "unavailable"
  | "conflict"
  | "ambiguous";

export interface RepairPassResultV1 {
  head: GitSha | null;
  deltas: {
    repository: RepairDeltaPlanV1["repository"];
    status: DeltaStatus;
  }[];
  /** Returned to the trusted metrics recorder, never claimed as hosted proof. */
  metrics: {
    repositories: number;
    applied: number;
    rejected: number;
    maxRepositoryMs: number;
    finalizeMs: number;
    wallMs: number;
  };
}

export async function finalizeRepairDeltas(input: {
  state: Pick<StateReadView, "readRepair"> & RepairStateWriter;
  submissions: readonly RepairDeltaSubmissionV1[];
  clock: { now(): number };
  runId: string;
  runStartedAt: number;
  runDeadline: number;
}): Promise<RepairPassResultV1> {
  if (input.submissions.length > MaxItems.snapshotRecords) {
    throw new Error("repair delta count exceeds live state bound");
  }
  const startedAt = input.clock.now();
  // Freeze untrusted wire bytes and trusted bindings across verification awaits.
  const submissions = input.submissions.map((entry) => ({
    ...entry,
    plan: structuredClone(entry.plan),
  }));
  const deltas: RepairPassResultV1["deltas"] = submissions.map(({ plan }) => ({
    repository: plan.repository,
    status: "unavailable",
  }));
  let head: GitSha | null = null;
  let maxRepositoryMs = 0;
  const finish = (): RepairPassResultV1 => ({
    head,
    deltas,
    metrics: {
      repositories: deltas.length,
      applied: deltas.filter((entry) => entry.status === "applied").length,
      rejected:
        deltas.filter((entry) =>
          entry.status !== "applied" && entry.status !== "noop"
        ).length,
      maxRepositoryMs,
      finalizeMs: Math.max(0, input.clock.now() - startedAt),
      wallMs: Math.max(0, input.clock.now() - input.runStartedAt),
    },
  });
  const hasMargin = () =>
    input.clock.now() + OPERATION_MARGIN_MS < input.runDeadline;
  if (!hasMargin()) {
    deltas.forEach((entry) => entry.status = "deadline");
    return finish();
  }
  const read = await input.state.readRepair();
  if (!read.ok || read.value.status !== "found") return finish();
  head = read.value.head;
  const prior = read.value.snapshot;
  let next = structuredClone(prior);
  const accepted: number[] = [];
  for (const [index, submission] of submissions.entries()) {
    const { plan, publicKey, artifact } = submission;
    if (artifact === null) continue;
    try {
      const parsed = parseSignedRepairDelta(artifact);
      const delta = parsed.delta;
      if (
        plan.runId !== input.runId || plan.runDeadline !== input.runDeadline ||
        delta.runId !== plan.runId || delta.baseHead !== plan.baseHead ||
        delta.runDeadline !== plan.runDeadline ||
        delta.startedAt < input.runStartedAt ||
        delta.completedAt > startedAt ||
        delta.completedAt + OPERATION_MARGIN_MS >= input.runDeadline ||
        !sameRepairRepository(delta.repository, plan.repository) ||
        submissions.some((entry, other) =>
          other !== index &&
          sameRepairRepository(entry.plan.repository, plan.repository)
        ) ||
        !await verifyRepairDelta(parsed, publicKey)
      ) throw new Error("invalid repair delta binding");
      maxRepositoryMs = Math.max(
        maxRepositoryMs,
        delta.completedAt - delta.startedAt,
      );
      if (delta.baseHead !== head) {
        deltas[index].status = "stale";
        continue;
      }
      assertRepairDeltaScope(plan, delta.changes);
      // Scope checks use CURRENT records too: a plan is not state authority.
      assertRepairDeltaScope({ ...plan, records: prior.work }, delta.changes);
      const changes = new Map(
        delta.changes.map((record) => [record.id, record]),
      );
      const candidate = parseRepairStateSnapshotV1({
        ...next,
        stateHead: head,
        sequence: prior.sequence + 1,
        updatedAt: Math.max(prior.updatedAt, input.clock.now()),
        work: next.work.map((record) => changes.get(record.id) ?? record),
      });
      if (validateSnapshotTransition(prior, candidate, head) !== null) {
        throw new Error("invalid repair delta transition");
      }
      const changed = delta.changes.some((record) =>
        canonicalStringify(record) !==
          canonicalStringify(prior.work.find((entry) => entry.id === record.id))
      );
      if (!changed) {
        deltas[index].status = "noop";
        continue;
      }
      next = candidate;
      accepted.push(index);
    } catch {
      deltas[index].status = "invalid";
    }
  }
  if (accepted.length === 0) return finish();
  if (!hasMargin()) {
    accepted.forEach((index) => deltas[index].status = "deadline");
    return finish();
  }
  // Same-head deltas MUST share one write. Sequential writes would make every
  // sibling stale after the first. Never retry/rebase a conflict in this pass.
  const written = await input.state.writeRepair(next, head);
  const status = written.ok ? written.value.status : "unavailable";
  if (written.ok && written.value.status === "applied") {
    head = written.value.head;
  }
  accepted.forEach((index) => deltas[index].status = status);
  return finish();
}
