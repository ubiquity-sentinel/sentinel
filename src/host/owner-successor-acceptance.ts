/** Review-capable runtime producer. It has repair authority and no release-writing port. */
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { BudgetControllerV1 } from "../budget/mod.ts";
import type {
  Clock,
  PortResultV1,
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import type {
  HostedExecutionIntentV1,
  HostedReleaseRecordV1,
} from "../contracts/hosted-supervisor.ts";
import {
  type OwnerSuccessorReviewV1,
  parseOwnerSuccessorReviewV1,
} from "../contracts/owner-successor-review.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import {
  checkReviewTaskStatement,
  type ReviewTaskStatementV1,
} from "../contracts/review-task-acceptance.ts";
import {
  type ReviewSnapshotV1,
  verifyReviewSnapshotDigest,
} from "../github/review-snapshot.ts";
import type {
  CodexStructuredReviewer,
  PreparedStructuredReviewV1,
  StructuredReviewOutcomeV1,
} from "../github/codex-reviewer.ts";
import { reviewRoundsLeft } from "../repair/review-round-cap.ts";
import { ownerSuccessorBindingFor } from "./owner-successor-acceptance-binding.ts";
import type { OwnerSuccessorCustody } from "./owner-successor-acceptance-custody.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";

export interface OwnerSuccessorReviewPorts {
  capture(
    input: { base: GitSha; head: GitSha },
  ): Promise<PortResultV1<ReviewSnapshotV1>>;
  reviewer: Pick<CodexStructuredReviewer, "prepare">;
  task(issueNumber: number): Promise<ReviewTaskStatementV1 | undefined>;
  verify(revision: GitSha): Promise<boolean>;
  custody?: OwnerSuccessorCustody;
}
type State = StateReadView & RepairStateWriter;
const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
const digest = canonicalStringifySha256;
export type OwnerSuccessorProduction =
  | "none"
  | "pending"
  | "completed"
  | "failed";

/** Existing ordinary runtime admission and self-target preparation own this bounded operation. */
export async function runOwnerSuccessorReviewPhase(
  input: Omit<
    Parameters<typeof produceOwnerSuccessorAcceptance>[0],
    "ports" | "modelStartsEnabled"
  >,
  configs: readonly RepositoryConfigV1[],
  prepare: (config: RepositoryConfigV1) => Promise<void>,
  compose: (config: RepositoryConfigV1) => unknown,
  readPorts: () => OwnerSuccessorReviewPorts | undefined,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;
  const self = configs.find((c) =>
    c.repository.owner === "ubiquity-sentinel" &&
    c.repository.name === "sentinel" &&
    c.repository.installationId === 0
  );
  if (!self) return false;
  return await produceOwnerSuccessorAcceptance({
    ...input,
    ports: async () => {
      await prepare(self);
      compose(self);
      return readPorts();
    },
    modelStartsEnabled: true,
  }) !== "none";
}

/** One pending source-intent operation precedes unrelated work; replay never starts it again. */
export async function produceOwnerSuccessorAcceptance(input: {
  clock: Clock;
  state: State;
  budget: BudgetControllerV1;
  ports:
    | OwnerSuccessorReviewPorts
    | (() => Promise<OwnerSuccessorReviewPorts | undefined>);
  nativeOwner: HostedExecutionIntentV1;
  latestStartAt: number;
  settleBy: number;
  modelStartsEnabled: boolean;
}): Promise<OwnerSuccessorProduction> {
  const { state, clock, nativeOwner } = input;
  if (
    !input.modelStartsEnabled || nativeOwner.purpose !== "ordinary" ||
    clock.now() >= input.latestStartAt || clock.now() >= input.settleBy
  ) return "none";
  const release = await state.readRelease(), repair = await state.readRepair();
  if (
    !release.ok || release.value.status !== "found" || !repair.ok ||
    repair.value.status !== "found"
  ) return "pending";
  const releaseHead = release.value.head,
    releaseSnapshot = release.value.snapshot;
  const runtime = release.value.snapshot.hostedRuntimes[0];
  const candidates = [];
  for (const r of release.value.snapshot.hostedReleases) {
    const selected = await ownerSuccessorBindingFor(
      r,
      nativeOwner.revision,
      nativeOwner.generation,
    );
    if (selected && r.ownerAcceptance === undefined) {
      candidates.push({ receipt: r, selected });
    }
  }
  if (candidates.length !== 1) {
    return candidates.length === 0 ? "none" : "pending";
  }
  const { receipt, selected } = candidates[0];
  if (!receipt?.ownerDisposition) return "none";
  const intent = selected.binding;
  const work = repair.value.snapshot.work.find((w) => w.id === intent.workId);
  const healthy = runtime?.lastHealthyProof;
  if (
    !runtime || runtime.activeRevision !== nativeOwner.revision ||
    runtime.generation !== nativeOwner.generation ||
    !same(runtime.execution, nativeOwner) ||
    !healthy || healthy.execution.revision !== nativeOwner.revision ||
    healthy.execution.generation !== nativeOwner.generation ||
    !work || work.nextStep !== "delivery" ||
    work.related.issueNumber !== intent.issueNumber ||
    !same(
      repair.value.snapshot.releaseRequests.find((r) => r.id === receipt.id),
      receipt.request,
    ) || await digest(receipt.request) !== intent.requestSha256 ||
    await digest(receipt.ownerDisposition.intent) !==
      receipt.ownerDisposition.intentSha256 ||
    [
      ...release.value.snapshot.githubCooldowns,
      ...repair.value.snapshot.githubCooldowns,
    ].some((c) => c.retryNotBefore === null || clock.now() < c.retryNotBefore)
  ) return "pending";
  const existing = repair.value.snapshot.ownerSuccessorReviews?.find((r) =>
    r.binding.releaseId === receipt.id &&
    r.binding.intentSha256 === receipt.ownerDisposition!.intentSha256 &&
    r.binding.successorRevision === nativeOwner.revision &&
    r.binding.successorGeneration === nativeOwner.generation
  );
  if (existing) {
    if (existing.phase === "completed") {
      return existing.readyExecution?.nativeReview?.mode === "review/start" &&
          existing.readyExecution.actual.evidenceKind === "native-review"
        ? "completed"
        : "pending";
    }
    return existing.phase === "failed" ? "failed" : "pending";
  }
  if (reviewRoundsLeft(repair.value.snapshot, work) < 1) return "pending";
  if (typeof input.ports === "function") {
    const ports = await input.ports();
    // Preparation may take time; admit only against freshly read state.
    return ports === undefined
      ? "pending"
      : produceOwnerSuccessorAcceptance({ ...input, ports });
  }
  const ports = input.ports;
  if (ports.custody === undefined) return "pending";
  const task = await ports.task(intent.issueNumber);
  if (
    !task || !(await checkReviewTaskStatement(task)).ok ||
    task.digest !== intent.taskSha256 ||
    !await ports.verify(nativeOwner.revision)
  ) return "pending";
  const captured = await ports.capture({
    base: intent.acceptanceBaseRevision,
    head: nativeOwner.revision,
  });
  if (
    !captured.ok || captured.value.base !== intent.acceptanceBaseRevision ||
    captured.value.head !== nativeOwner.revision ||
    captured.value.mergeBase !== intent.acceptanceBaseRevision ||
    !await verifyReviewSnapshotDigest(captured.value)
  ) return "pending";
  const operationKey = await digest({
    domain: "sentinel-owner-successor-review-v1",
    releaseId: receipt.id,
    requestSha256: intent.requestSha256,
    intentSha256: receipt.ownerDisposition.intentSha256,
    ownerBindingId: selected.id,
    ownerBindingSha256: selected.sha256,
    successorRevision: nativeOwner.revision,
    successorGeneration: nativeOwner.generation,
    taskSha256: task.digest,
    snapshotSha256: captured.value.digest,
  });
  const operationId = `owner-successor:${operationKey}`;
  const requestId = `owner-successor-request:${operationKey}`,
    invocationId = `owner-successor-invocation:${operationKey}`;
  const attempt = Math.max(
    0,
    ...repair.value.snapshot.reservations.filter((r) => r.taskId === work.id)
      .map((r) => r.attempt),
  ) + 1;
  const admitted = await input.budget.reserveModelStart({
    repository: work.repository,
    taskId: work.id,
    head: nativeOwner.revision,
    attempt,
    purpose: "review_request",
  });
  if (admitted.status !== "admitted") return "pending";
  const initial = await state.readRepair();
  if (
    !initial.ok || initial.value.status !== "found" ||
    initial.value.head !== admitted.stateHead ||
    !same(
      initial.value.snapshot.reservations.find((r) =>
        r.id === admitted.reservation.id
      ),
      admitted.reservation,
    )
  ) return "pending";
  let operation = parseOwnerSuccessorReviewV1({
    version: "v1",
    kind: "owner_successor_review",
    id: operationId,
    phase: "intent",
    binding: {
      releaseId: receipt.id,
      requestSha256: intent.requestSha256,
      intentSha256: receipt.ownerDisposition.intentSha256,
      ownerBindingId: selected.id,
      ownerBindingSha256: selected.sha256,
      workId: work.id,
      issueNumber: intent.issueNumber,
      taskSha256: task.digest,
      successorRevision: nativeOwner.revision,
      successorGeneration: nativeOwner.generation,
      snapshot: captured.value,
      nativeOwner,
      health: healthy,
      expectedReleaseHead: release.value.head,
      expectedRepairHead: initial.value.head,
      requestId,
      invocationId,
    },
    reservation: admitted.reservation,
    execution: null,
    readyExecution: null,
    result: null,
    resultSha256: null,
    close: null,
    nativeCustody: "pending",
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  const save = async (next: OwnerSuccessorReviewV1): Promise<boolean> => {
    const read = await state.readRepair();
    if (!read.ok || read.value.status !== "found") return false;
    const old = read.value.snapshot.ownerSuccessorReviews?.find((r) =>
      r.id === operationId
    );
    if (old && !same(old, operation)) return false;
    const records = old
      ? read.value.snapshot.ownerSuccessorReviews!.map((r) =>
        r.id === operationId ? next : r
      )
      : [...read.value.snapshot.ownerSuccessorReviews ?? [], next];
    const planned = parseRepairStateSnapshotV1({
      ...read.value.snapshot,
      ownerSuccessorReviews: records.sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      ),
      stateHead: read.value.head,
      sequence: read.value.snapshot.sequence + 1,
      updatedAt: clock.now(),
    });
    const written = await state.writeRepair(planned, read.value.head);
    if (!written.ok || written.value.status !== "applied") return false;
    const confirmed = await state.readRepair();
    if (
      !confirmed.ok || confirmed.value.status !== "found" ||
      confirmed.value.head !== written.value.head ||
      !same(confirmed.value.snapshot, planned)
    ) return false;
    operation = next;
    return true;
  };
  const unchanged = async () => {
    const read = await state.readRelease(),
      currentTask = await ports.task(intent.issueNumber);
    return clock.now() < input.latestStartAt && clock.now() < input.settleBy &&
      read.ok && read.value.status === "found" &&
      read.value.head === releaseHead &&
      same(read.value.snapshot, releaseSnapshot) &&
      currentTask?.digest === task.digest &&
      await ports.verify(nativeOwner.revision);
  };
  if (!await save(operation)) return "pending";
  let prepared: PreparedStructuredReviewV1 | undefined,
    outcome: PortResultV1<StructuredReviewOutcomeV1> | undefined;
  let close: OwnerSuccessorReviewV1["close"] = null;
  try {
    if (!await unchanged()) throw new Error("owner acceptance source changed");
    await ports.custody.registerOwnerSuccessor({
      kind: "owner_successor",
      review: operation,
    });
    const opened = await ports.reviewer.prepare({
      snapshot: captured.value,
      task,
      requestId,
      invocationId,
      ownerRunId: nativeOwner.id,
      latestStartAt: input.latestStartAt,
      settleBy: input.settleBy,
    });
    if (!opened.ok) throw new Error("owner acceptance prepare unavailable");
    prepared = opened.value;
    if (
      !await save(
        parseOwnerSuccessorReviewV1({
          ...operation,
          phase: "running",
          execution: prepared.execution,
          updatedAt: clock.now(),
        }),
      ) || !await unchanged()
    ) throw new Error("owner acceptance running custody unavailable");
    await ports.custody.armOwnerSuccessor({
      requestId,
      execution: prepared.execution,
    });
    outcome = await prepared.start();
  } catch {
    /* Failed and uncertain operations stay charged and never authorize acceptance. */
  } finally {
    if (prepared) close = await prepared.close();
  }
  let custodySettled = false;
  if (
    prepared && close?.settled === true && !close.timedOut &&
    close.failure === null
  ) {
    try {
      await ports.custody.settledOwnerSuccessor({ requestId });
      custodySettled = true;
    } catch { /* Native custody remains pending. */ }
  }
  const settled = await input.budget.settleModelStart({
    id: admitted.reservation.id,
    outcome: prepared?.startAttempted() ? "submitted" : "ambiguous",
    proofRef: null,
  });
  if (settled.status !== "settled" && settled.status !== "idempotent") {
    return "pending";
  }
  const result = outcome?.ok ? outcome.value.result : null;
  const readyExecution = outcome?.ok ? outcome.value.execution : null;
  const accepted = custodySettled && result !== null &&
    readyExecution !== null && close?.settled === true && !close.timedOut &&
    readyExecution.nativeReview?.mode === "review/start" &&
    readyExecution.actual.evidenceKind === "native-review" &&
    close.failure === null &&
    result.taskAcceptance?.verdict === "fulfilled" &&
    result.taskAcceptance.issueNumber === intent.issueNumber &&
    result.taskAcceptance.taskDigest === task.digest &&
    result.verdict !== "unavailable" &&
    !result.findings.some((f) => f.priority <= 1) && await unchanged();
  const next = parseOwnerSuccessorReviewV1({
    ...operation,
    phase: accepted ? "completed" : "failed",
    reservation: settled.reservation,
    readyExecution,
    result,
    resultSha256: result === null ? null : await digest(result),
    close,
    nativeCustody: custodySettled ? "settled" : "pending",
    updatedAt: clock.now(),
  });
  return await save(next) ? accepted ? "completed" : "failed" : "pending";
}

export function ownerReviewRequestBinds(
  receipt: HostedReleaseRecordV1,
  repair: RepairStateSnapshotV1,
): boolean {
  return receipt.phase === "owner_superseded" &&
    receipt.ownerDisposition !== undefined &&
    same(
      repair.releaseRequests.find((r) => r.id === receipt.id),
      receipt.request,
    );
}
