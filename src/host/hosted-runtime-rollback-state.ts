/** Read projection for an exact installation rollback; never rewrites release state. */
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import {
  portError,
  portOk,
  type RepairStateWriter,
  type StateReadView,
} from "../contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
  type ReleaseStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import { RUNTIME_KEYS } from "../contracts/hosted-supervisor-runtime.ts";
import { HOSTED_RELEASE_KEYS } from "../contracts/hosted-supervisor-release.ts";
import { hostedOrdinaryAdmissionMode } from "../contracts/hosted-supervisor-verification.ts";

export function isHostedInstallationRollback(
  snapshot: ReleaseStateSnapshotV1,
  execution: HostedExecutionIntentV1,
): boolean {
  return execution.revision !== execution.launcherSha &&
    (snapshot.hostedInstallations ?? []).some((record) =>
      record.previousRevision === execution.revision &&
      record.previousGeneration + 2 === execution.generation &&
      record.candidateRevision === execution.launcherSha &&
      (record.phase === "rolled_back" ||
        record.phase === "rollback_verifying" &&
          execution.purpose === "bootstrap" &&
          record.rollbackExecutionId === execution.id)
    );
}

/** Exact custody is checked by both callers before this read-only projection. */
export function needsHostedLegacyStateView(
  snapshot: ReleaseStateSnapshotV1,
  execution: HostedExecutionIntentV1,
): boolean {
  const runtime = snapshot.hostedRuntimes[0];
  const admission = runtime?.ordinaryAdmission;
  return isHostedInstallationRollback(snapshot, execution) ||
    execution.purpose === "ordinary" &&
      execution.revision !== execution.launcherSha && runtime !== undefined &&
      hostedOrdinaryAdmissionMode(runtime) === "healthy" &&
      admission?.mode === "healthy" && admission.executionId === execution.id &&
      admission.revision === execution.revision &&
      admission.generation === execution.generation;
}

/** Legacy children need their exact pointer/proofs, not launcher scheduling journals. */
export function rollbackReleaseView(
  input: ReleaseStateSnapshotV1,
): ReleaseStateSnapshotV1 {
  const snapshot = parseReleaseStateSnapshotV1(input);
  const pick = (value: object, keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => [key, Reflect.get(value, key)]));
  return parseReleaseStateSnapshotV1({
    version: snapshot.version,
    kind: snapshot.kind,
    stateHead: snapshot.stateHead,
    sequence: snapshot.sequence,
    updatedAt: snapshot.updatedAt,
    releases: snapshot.releases,
    ...(snapshot.vpsReleases === undefined
      ? {}
      : { vpsReleases: snapshot.vpsReleases }),
    hostedRuntimes: snapshot.hostedRuntimes.map((r) => pick(r, RUNTIME_KEYS)),
    // A legacy reader cannot consume successor acceptance or abandonment.
    // Omitting those receipts makes delivery unavailable, never accepted.
    hostedReleases: snapshot.hostedReleases.filter((r) =>
      r.phase !== "abandoned" && r.phase !== "owner_superseded"
    ).map((r) => pick(r, HOSTED_RELEASE_KEYS)),
    githubCooldowns: snapshot.githubCooldowns,
  });
}

function repairView(snapshot: RepairStateSnapshotV1): RepairStateSnapshotV1 {
  const { ownerSuccessorReviews: _journal, ...legacy } = snapshot;
  return legacy;
}

/** Only the trusted repair capability crosses; hidden records survive every CAS. */
export function createHostedRollbackState(
  state: StateReadView & RepairStateWriter,
): StateReadView & RepairStateWriter {
  const projectRepair = async (
    read: ReturnType<StateReadView["readRepair"]>,
  ) => {
    const result = await read;
    return result.ok && result.value.status === "found"
      ? portOk({
        ...result.value,
        snapshot: repairView(parseRepairStateSnapshotV1(result.value.snapshot)),
      })
      : result;
  };
  const projectRelease = async (
    read: ReturnType<StateReadView["readRelease"]>,
  ) => {
    const result = await read;
    return result.ok && result.value.status === "found"
      ? portOk({
        ...result.value,
        snapshot: rollbackReleaseView(result.value.snapshot),
      })
      : result;
  };
  return {
    readRepair: () => projectRepair(state.readRepair()),
    readRelease: () => projectRelease(state.readRelease()),
    ...(state.readRepairAt === undefined ? {} : {
      readRepairAt: (input) => projectRepair(state.readRepairAt!(input)),
    }),
    ...(state.readReleaseAt === undefined ? {} : {
      readReleaseAt: (input) => projectRelease(state.readReleaseAt!(input)),
    }),
    writeRepair: async (next, expectedHead) => {
      if (Object.hasOwn(next, "ownerSuccessorReviews")) {
        return portError(
          "invalid",
          "rollback child cannot write successor reviews",
        );
      }
      const current = await state.readRepair();
      if (!current.ok) return current;
      const actual = current.value.status === "found"
        ? current.value.head
        : current.value.currentHead;
      if (actual !== expectedHead) {
        return portOk({ status: "conflict", currentHead: actual });
      }
      const journal = current.value.status === "found"
        ? current.value.snapshot.ownerSuccessorReviews
        : undefined;
      return state.writeRepair({
        ...next,
        ...(journal === undefined ? {} : { ownerSuccessorReviews: journal }),
      }, expectedHead);
    },
  };
}
