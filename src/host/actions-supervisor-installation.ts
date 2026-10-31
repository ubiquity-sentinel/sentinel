/** Launcher-only installation and exact rollback, with persisted-before-effect intent. */
import {
  type HostedInstallationRecordV1,
  type HostedReleaseRecordV1,
  type HostedRuntimeRecordV1,
  parseHostedExecutionIntentV1,
} from "../contracts/hosted-supervisor.ts";
import { installationTerminal } from "../contracts/hosted-supervisor-installation.ts";
import {
  commitHosted,
  executionIdOfRun,
  type HostedSupervisorInputV1,
  type HostedSupervisorOutcomeV1,
  isTerminalPhase,
  pending,
  type SnapshotCursorV1,
  STATIC_CONFLICT,
} from "./actions-supervisor-state.ts";

export async function planLauncherInstallation(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
): Promise<"written" | HostedSupervisorOutcomeV1 | null> {
  const records = cursor.snapshot?.hostedInstallations ?? [];
  if (
    records.some((r) =>
      r.phase === "rollback_failed" &&
      runtime.activeRevision === r.previousRevision &&
      runtime.generation === r.previousGeneration + 2
    )
  ) {
    return pending(
      "launcher installation rollback verification failed; model starts remain stopped",
    );
  }
  const saved = records.find((r) => !installationTerminal(r));
  if (saved) {
    return await moveInstallation(
      input,
      cursor,
      runtime,
      releases,
      records,
      saved,
    );
  }
  const target = input.run.launcherSha;
  if (
    runtime.activeRevision === target ||
    records.some((r) => r.candidateRevision === target)
  ) return null;
  // A release-local refusal never suppresses ordinary work on the installed pointer.
  if (
    runtime.execution !== null ||
    releases.some((r) =>
      r.pointerIntent !== null || r.phase === "rollback_pending" ||
      r.phase === "rollback_verifying"
    ) ||
    !input.evidence.verifyAncestor || !input.evidence.verifyLauncherCi
  ) return null;
  try {
    const ancestor = await input.evidence.verifyAncestor(
      runtime.activeRevision,
      target,
    );
    if (!ancestor.ok || !ancestor.value) return null;
    const ci = await input.evidence.verifyLauncherCi(target);
    if (!ci.ok || ci.value === null || ci.value.revision !== target) {
      return null;
    }
    const now = input.clock.now(), healthy = runtime.lastHealthyProof;
    const record: HostedInstallationRecordV1 = {
      version: "v1",
      kind: "hosted_installation",
      id: `installation:${target}`,
      candidateRevision: target,
      previousRevision: runtime.activeRevision,
      previousGeneration: runtime.generation,
      previousHealthyProof:
        healthy?.execution.revision === runtime.activeRevision &&
          healthy.execution.generation === runtime.generation
          ? healthy
          : null,
      ci: ci.value,
      phase: "requested",
      pointerIntent: {
        action: "promote",
        expectedRevision: runtime.activeRevision,
        nextRevision: target,
        expectedGeneration: runtime.generation,
        createdAt: now,
      },
      bootstrapExecutionId: null,
      bootstrapProof: null,
      rollbackExecutionId: null,
      rollbackProof: null,
      createdAt: now,
      updatedAt: now,
    };
    return await commitHosted(input, cursor, runtime, releases, [
        ...records,
        record,
      ]) === "applied"
      ? "written"
      : pending(STATIC_CONFLICT);
  } catch {
    return null;
  }
}

async function moveInstallation(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  records: readonly HostedInstallationRecordV1[],
  saved: HostedInstallationRecordV1,
): Promise<"written" | HostedSupervisorOutcomeV1> {
  if (
    saved.phase === "bootstrapping" && saved.bootstrapProof === null &&
    saved.retriedBootstrapProof?.execution.id === saved.bootstrapExecutionId
  ) {
    return await retryBootstrap(
      input,
      cursor,
      runtime,
      releases,
      records,
      saved,
    );
  }
  const intent = saved.pointerIntent;
  if (
    runtime.execution !== null || intent === null ||
    releases.some((r) => r.pointerIntent !== null) ||
    runtime.activeRevision !== intent.expectedRevision ||
    runtime.generation !== intent.expectedGeneration
  ) {
    return pending(
      "launcher installation is waiting for its exact pointer or settlement",
    );
  }
  const install = saved.phase === "requested";
  if (!install && saved.phase !== "rollback_pending") {
    return pending("launcher installation phase is unavailable");
  }
  const included = new Set<string>();
  if (install) {
    if (
      input.run.launcherSha !== saved.candidateRevision ||
      !input.evidence.verifyAncestor || !input.evidence.verifyLauncherCi
    ) return pending("launcher installation evidence is unavailable");
    try {
      const ancestor = await input.evidence.verifyAncestor(
        saved.previousRevision,
        saved.candidateRevision,
      );
      // Revalidate current CI; the immutable journal records request-time evidence.
      const ci = await input.evidence.verifyLauncherCi(saved.candidateRevision);
      if (
        !ancestor.ok || !ancestor.value || !ci.ok ||
        ci.value?.revision !== saved.candidateRevision
      ) return pending("launcher installation evidence changed");
      for (const r of releases.filter((r) => !isTerminalPhase(r.phase))) {
        const comparison = await input.evidence.verifyAncestor(
          r.request.revision,
          saved.candidateRevision,
        );
        if (!comparison.ok) {
          return pending("release successor ancestry is unavailable");
        }
        if (comparison.value) included.add(r.id);
      }
    } catch {
      return pending("launcher installation evidence is unavailable");
    }
  }
  const now = input.clock.now();
  const execution = parseHostedExecutionIntentV1({
    id: executionIdOfRun(input.run),
    runId: input.run.runId,
    runAttempt: input.run.runAttempt,
    launcherSha: input.run.launcherSha,
    purpose: "bootstrap",
    revision: intent.nextRevision,
    generation: runtime.generation + 1,
    releaseId: null,
    createdAt: now,
  });
  const next: HostedInstallationRecordV1 = {
    ...saved,
    phase: install ? "bootstrapping" : "rollback_verifying",
    pointerIntent: null,
    ...(install
      ? { bootstrapExecutionId: execution.id }
      : { rollbackExecutionId: execution.id }),
    updatedAt: now,
  };
  const releasesNext = releases.map((r) =>
    included.has(r.id)
      ? {
        ...r,
        phase: "abandoned" as const,
        abandonment: {
          reason: "included_in_successor" as const,
          fromPhase: r.phase,
          executionIds: [
            ...(r.verification?.prior.executionIds ?? []),
            ...(r.verification?.candidate.executionIds ?? []),
          ],
          successorRevision: saved.candidateRevision,
          recordedAt: now,
        },
        updatedAt: now,
      }
      : r
  );
  const applied = await commitHosted(
    input,
    cursor,
    {
      ...runtime,
      activeRevision: intent.nextRevision,
      generation: runtime.generation + 1,
      execution,
      lastTurn: "verification",
      verificationBlocked: true,
      verificationFailures: 0,
      failedVerificationIds: [],
      lastVerificationId: null,
      updatedAt: now,
    },
    releasesNext,
    records.map((r) => r.id === next.id ? next : r),
  );
  return applied === "applied" ? "written" : pending(STATIC_CONFLICT);
}

/**
 * #191: the single model-disabled retry of a first bootstrap that never
 * reached startup-ready. It reruns the same candidate at its exact installed
 * pointer (a revision never changes generation), so the recorded prior
 * rollback keeps its exact previousGeneration + 2 identity.
 */
async function retryBootstrap(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  records: readonly HostedInstallationRecordV1[],
  saved: HostedInstallationRecordV1,
): Promise<"written" | HostedSupervisorOutcomeV1> {
  if (
    runtime.execution !== null ||
    releases.some((r) => r.pointerIntent !== null) ||
    runtime.activeRevision !== saved.candidateRevision ||
    runtime.generation !== saved.previousGeneration + 1 ||
    input.run.launcherSha !== saved.candidateRevision
  ) {
    return pending(
      "launcher installation retry is waiting for its exact pointer",
    );
  }
  const now = input.clock.now();
  const execution = parseHostedExecutionIntentV1({
    id: executionIdOfRun(input.run),
    runId: input.run.runId,
    runAttempt: input.run.runAttempt,
    launcherSha: input.run.launcherSha,
    purpose: "bootstrap",
    revision: saved.candidateRevision,
    generation: runtime.generation,
    releaseId: null,
    createdAt: now,
  });
  // A settled attempt is never rebound to the run that settled it.
  if (execution.id === saved.bootstrapExecutionId) {
    return pending("launcher installation retry needs a new run");
  }
  const next: HostedInstallationRecordV1 = {
    ...saved,
    bootstrapExecutionId: execution.id,
    updatedAt: now,
  };
  const applied = await commitHosted(
    input,
    cursor,
    { ...runtime, execution, lastTurn: "verification", updatedAt: now },
    releases,
    records.map((r) => r.id === next.id ? next : r),
  );
  return applied === "applied" ? "written" : pending(STATIC_CONFLICT);
}
