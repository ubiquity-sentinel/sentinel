import { canonicalStringify } from "./canonical.ts";
import {
  parseHostedExecutionSettlementV1,
  parseHostedRunProofV1,
} from "./hosted-supervisor-execution.ts";
import { parseHostedPointerIntentV1 } from "./hosted-supervisor-runtime.ts";
import type {
  HostedExecutionSettlementV1,
  HostedInstallationRecordV1,
  HostedRuntimeRecordV1,
} from "./hosted-supervisor-types.ts";
import {
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectPositiveInt,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
  MaxText,
} from "./validation.ts";

export function parseHostedInstallationRecordV1(
  input: unknown,
  path = "$",
): HostedInstallationRecordV1 {
  const obj = expectRecord(input, path);
  const retried = Object.hasOwn(obj, "retriedBootstrapProof");
  expectExactKeys(obj, [
    "version",
    "kind",
    "id",
    "candidateRevision",
    "previousRevision",
    "previousGeneration",
    "previousHealthyProof",
    "ci",
    "phase",
    "pointerIntent",
    "bootstrapExecutionId",
    "bootstrapProof",
    "rollbackExecutionId",
    "rollbackProof",
    "createdAt",
    "updatedAt",
    ...(retried ? ["retriedBootstrapProof"] : []),
  ], path);
  expectVersion(obj.version, `${path}.version`);
  expectEnum(obj.kind, ["hosted_installation"], `${path}.kind`);
  const ci = expectRecord(obj.ci, `${path}.ci`);
  expectExactKeys(ci, ["revision", "checkRunId"], `${path}.ci`);
  const r: HostedInstallationRecordV1 = {
    version: "v1",
    kind: "hosted_installation",
    id: expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId),
    candidateRevision: expectGitSha(
      obj.candidateRevision,
      `${path}.candidateRevision`,
    ),
    previousRevision: expectGitSha(
      obj.previousRevision,
      `${path}.previousRevision`,
    ),
    previousGeneration: expectPositiveInt(
      obj.previousGeneration,
      `${path}.previousGeneration`,
    ),
    previousHealthyProof: expectNullable(
      obj.previousHealthyProof,
      `${path}.previousHealthyProof`,
      parseHostedRunProofV1,
    ),
    ci: {
      revision: expectGitSha(ci.revision, `${path}.ci.revision`),
      checkRunId: expectPositiveInt(ci.checkRunId, `${path}.ci.checkRunId`),
    },
    phase: expectEnum(obj.phase, [
      "requested",
      "bootstrapping",
      "accepted",
      "rollback_pending",
      "rollback_verifying",
      "rolled_back",
      "rollback_failed",
    ], `${path}.phase`),
    pointerIntent: expectNullable(
      obj.pointerIntent,
      `${path}.pointerIntent`,
      parseHostedPointerIntentV1,
    ),
    bootstrapExecutionId: expectNullable(
      obj.bootstrapExecutionId,
      `${path}.bootstrapExecutionId`,
      (v, p) => expectNonEmptyString(v, p, MaxText.recordId),
    ),
    rollbackExecutionId: expectNullable(
      obj.rollbackExecutionId,
      `${path}.rollbackExecutionId`,
      (v, p) => expectNonEmptyString(v, p, MaxText.recordId),
    ),
    bootstrapProof: expectNullable(
      obj.bootstrapProof,
      `${path}.bootstrapProof`,
      parseHostedExecutionSettlementV1,
    ),
    rollbackProof: expectNullable(
      obj.rollbackProof,
      `${path}.rollbackProof`,
      parseHostedExecutionSettlementV1,
    ),
    createdAt: expectTimestamp(obj.createdAt, `${path}.createdAt`),
    updatedAt: expectTimestamp(obj.updatedAt, `${path}.updatedAt`),
    ...(retried
      ? {
        retriedBootstrapProof: parseHostedExecutionSettlementV1(
          obj.retriedBootstrapProof,
          `${path}.retriedBootstrapProof`,
        ),
      }
      : {}),
  };
  if (
    r.id !== `installation:${r.candidateRevision}` ||
    r.candidateRevision === r.previousRevision ||
    r.ci.revision !== r.candidateRevision || r.updatedAt < r.createdAt ||
    r.previousHealthyProof !== null &&
      (r.previousHealthyProof.outcome !== "healthy" ||
        r.previousHealthyProof.execution.revision !== r.previousRevision ||
        r.previousHealthyProof.execution.generation !== r.previousGeneration)
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "installation identity and prior health must be exact",
    );
  }
  const intent = r.pointerIntent;
  if (r.phase === "requested" || r.phase === "rollback_pending") {
    const install = r.phase === "requested";
    if (
      intent === null || intent.action !== (install ? "promote" : "rollback") ||
      intent.expectedRevision !==
        (install ? r.previousRevision : r.candidateRevision) ||
      intent.nextRevision !==
        (install ? r.candidateRevision : r.previousRevision) ||
      intent.expectedGeneration !== r.previousGeneration + (install ? 0 : 1)
    ) {
      fail(
        path,
        "invalid_lifecycle",
        "installation requires exact persisted movement intent",
      );
    }
  } else if (intent !== null) {
    fail(
      path,
      "invalid_lifecycle",
      "installation movement intent must clear atomically",
    );
  }
  for (
    const [proof, id, revision, generation] of [
      [
        r.bootstrapProof,
        r.bootstrapExecutionId,
        r.candidateRevision,
        r.previousGeneration + 1,
      ],
      [
        r.rollbackProof,
        r.rollbackExecutionId,
        r.previousRevision,
        r.previousGeneration + 2,
      ],
    ] as const
  ) {
    if (
      proof !== null &&
      (proof.execution.id !== id || proof.execution.revision !== revision ||
        proof.execution.generation !== generation ||
        proof.execution.purpose !== "bootstrap" ||
        proof.execution.releaseId !== null || proof.observedAt > r.updatedAt)
    ) {
      fail(
        path,
        "invalid_lifecycle",
        "installation proof must bind its exact model-disabled execution",
      );
    }
  }
  const first = r.retriedBootstrapProof;
  if (
    first !== undefined &&
    (!bootstrapNeverStarted(first) || r.phase === "requested" ||
      first.execution.purpose !== "bootstrap" ||
      first.execution.releaseId !== null ||
      first.execution.revision !== r.candidateRevision ||
      first.execution.generation !== r.previousGeneration + 1 ||
      first.observedAt > r.updatedAt ||
      // Until the retry starts, the first attempt still owns the binding.
      first.execution.id === r.bootstrapExecutionId &&
        (r.phase !== "bootstrapping" || r.bootstrapProof !== null))
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "a bootstrap retry requires one exact first attempt that never reached startup-ready",
    );
  }
  if (
    r.phase !== "requested" && r.bootstrapExecutionId === null ||
    r.phase === "accepted" && r.bootstrapProof?.outcome !== "healthy" ||
    ["rollback_pending", "rollback_verifying", "rolled_back", "rollback_failed"]
        .includes(r.phase) &&
      (r.bootstrapProof === null || r.bootstrapProof.outcome === "healthy") ||
    r.phase === "rolled_back" && r.rollbackProof?.outcome !== "healthy" ||
    r.phase === "rollback_failed" &&
      (r.rollbackProof === null || r.rollbackProof.outcome === "healthy")
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "installation phase requires its genuine settlement",
    );
  }
  return r;
}
const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
export function installationTerminal(r: HostedInstallationRecordV1): boolean {
  return ["accepted", "rolled_back", "rollback_failed"].includes(r.phase);
}
/**
 * #191: the settled bootstrap never reached its startup-ready marker (no run,
 * or a run whose child never attested startup readiness). A run that reached
 * startup-ready and then failed actually executed and is never retried.
 */
export function bootstrapNeverStarted(
  proof: HostedExecutionSettlementV1,
): boolean {
  return proof.outcome === "not_started" ||
    proof.outcome === "failed" && !proof.startupReady;
}
/** The single retry rebinds only the never-started first attempt, in place. */
function isBootstrapRetryStart(
  r: HostedInstallationRecordV1,
  n: HostedInstallationRecordV1,
  runtime: HostedRuntimeRecordV1 | undefined,
  next: HostedRuntimeRecordV1 | undefined,
): boolean {
  const first = r.retriedBootstrapProof, execution = next?.execution;
  const pointer = r.previousGeneration + 1;
  return first !== undefined && first.execution.id === r.bootstrapExecutionId &&
    r.phase === "bootstrapping" && n.phase === "bootstrapping" &&
    r.bootstrapProof === null && n.bootstrapProof === null &&
    runtime?.execution === null &&
    runtime.activeRevision === r.candidateRevision &&
    runtime.generation === pointer && next !== undefined &&
    next.activeRevision === r.candidateRevision &&
    next.generation === pointer &&
    execution !== undefined && execution !== null &&
    execution.id === n.bootstrapExecutionId &&
    execution.id !== first.execution.id && execution.purpose === "bootstrap" &&
    execution.releaseId === null &&
    execution.revision === r.candidateRevision &&
    execution.launcherSha === r.candidateRevision &&
    execution.generation === pointer;
}
export function matchesInstallationMovement(
  before: HostedRuntimeRecordV1,
  after: HostedRuntimeRecordV1,
  installations: readonly HostedInstallationRecordV1[],
  next: readonly HostedInstallationRecordV1[],
): boolean {
  return before.execution === null && installations.some((r) => {
    const n = next.find((n) => n.id === r.id),
      intent = r.pointerIntent,
      execution = after.execution;
    return intent !== null && n !== undefined && n.pointerIntent === null &&
      before.activeRevision === intent.expectedRevision &&
      before.generation === intent.expectedGeneration &&
      after.activeRevision === intent.nextRevision &&
      after.generation === intent.expectedGeneration + 1 &&
      execution?.purpose === "bootstrap" && execution.releaseId === null &&
      execution.launcherSha === r.candidateRevision &&
      (r.phase === "requested"
        ? n.phase === "bootstrapping" && n.bootstrapExecutionId === execution.id
        : r.phase === "rollback_pending" && n.phase === "rollback_verifying" &&
          n.rollbackExecutionId === execution.id);
  });
}
export function validateHostedInstallationTransition(
  before: readonly HostedInstallationRecordV1[],
  after: readonly HostedInstallationRecordV1[],
  runtime: HostedRuntimeRecordV1 | undefined,
  next: HostedRuntimeRecordV1 | undefined,
): string | null {
  if (after.filter((r) => !installationTerminal(r)).length > 1) {
    return "only one installation may be unresolved";
  }
  for (const r of before) {
    const n = after.find((n) => n.id === r.id);
    if (!n) return "installation history cannot disappear";
    if (installationTerminal(r)) {
      if (!same(r, n)) return "terminal installation is immutable";
      continue;
    }
    for (
      const key of [
        "id",
        "candidateRevision",
        "previousRevision",
        "previousGeneration",
        "previousHealthyProof",
        "ci",
        "createdAt",
      ] as const
    ) {
      if (!same(r[key], n[key])) return "installation identity is immutable";
    }
    if (n.updatedAt < r.updatedAt) {
      return "installation time cannot move backward";
    }
    const phases: Record<HostedInstallationRecordV1["phase"], string[]> = {
      requested: ["requested", "bootstrapping"],
      bootstrapping: ["bootstrapping", "accepted", "rollback_pending"],
      accepted: ["accepted"],
      rollback_pending: ["rollback_pending", "rollback_verifying"],
      rollback_verifying: [
        "rollback_verifying",
        "rolled_back",
        "rollback_failed",
      ],
      rolled_back: ["rolled_back"],
      rollback_failed: ["rollback_failed"],
    };
    if (!phases[r.phase].includes(n.phase)) {
      return "installation phase cannot reset";
    }
    const movement = r.phase === "requested" && n.phase === "bootstrapping" ||
      r.phase === "rollback_pending" && n.phase === "rollback_verifying";
    if (
      movement &&
      (!runtime || !next ||
        !matchesInstallationMovement(runtime, next, [r], [n]))
    ) return "installation must consume its exact persisted intent";
    if (
      !movement && !same(r.pointerIntent, n.pointerIntent) &&
      !(r.phase === "bootstrapping" && n.phase === "rollback_pending")
    ) return "installation pointer intent cannot be rewritten";
    // #191: the never-started first settlement is journaled exactly once, in
    // the write that clears that execution, and admits one in-place retry.
    if (r.retriedBootstrapProof !== undefined) {
      if (!same(r.retriedBootstrapProof, n.retriedBootstrapProof)) {
        return "installation retry proof is immutable";
      }
    } else if (
      n.retriedBootstrapProof !== undefined &&
      (r.phase !== "bootstrapping" || n.phase !== "bootstrapping" ||
        r.bootstrapProof !== null || n.bootstrapProof !== null ||
        n.bootstrapExecutionId !== r.bootstrapExecutionId ||
        runtime?.execution?.id !== r.bootstrapExecutionId ||
        next?.execution !== null ||
        !same(n.retriedBootstrapProof, next.lastExecutionProof))
    ) {
      return "installation retry must journal its exact settlement atomically";
    }
    const retryStart = isBootstrapRetryStart(r, n, runtime, next);
    for (
      const [key, idKey] of [["bootstrapProof", "bootstrapExecutionId"], [
        "rollbackProof",
        "rollbackExecutionId",
      ]] as const
    ) {
      if (r[key] !== null && !same(r[key], n[key])) {
        return "installation proof is immutable";
      }
      if (
        r[key] === null && n[key] !== null &&
        (runtime?.execution?.id !== n[idKey] || next?.execution !== null ||
          !same(n[key], next.lastExecutionProof))
      ) {
        return "installation settlement must clear the exact execution atomically";
      }
      if (
        r[idKey] !== null && r[idKey] !== n[idKey] &&
        !(idKey === "bootstrapExecutionId" && retryStart)
      ) {
        return "installation execution identity is immutable";
      }
      if (r[idKey] === null && n[idKey] !== null && !movement) {
        return "installation execution requires atomic pointer movement";
      }
    }
  }
  for (const n of after.filter((n) => !before.some((r) => r.id === n.id))) {
    if (
      n.phase !== "requested" || n.bootstrapProof !== null ||
      n.rollbackProof !== null || n.bootstrapExecutionId !== null ||
      n.rollbackExecutionId !== null ||
      runtime?.execution !== null ||
      runtime.activeRevision !== n.previousRevision ||
      runtime.generation !== n.previousGeneration ||
      !same(
        runtime.lastHealthyProof?.execution.revision === n.previousRevision &&
          runtime.lastHealthyProof.execution.generation === n.previousGeneration
          ? runtime.lastHealthyProof
          : null,
        n.previousHealthyProof,
      ) ||
      !next || !same(runtime, next)
    ) return "new installation requires an idle exact prior pointer";
  }
  return null;
}
