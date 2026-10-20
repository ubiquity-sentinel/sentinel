import type {
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import { startExecution } from "./actions-supervisor-source.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  type HostedSupervisorInputV1,
  type HostedSupervisorOutcomeV1,
  idle,
  pending,
  readCursor,
  type SnapshotCursorV1,
  STATIC_CONFLICT,
} from "./actions-supervisor-state.ts";

/** Capability is read-only; admission still uses the original expected-head CAS. */
export async function planOrdinaryWork(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  recovery = false,
): Promise<HostedSupervisorOutcomeV1> {
  const verify = input.evidence.verifyMatrixOrdinaryRevision;
  if (!verify) {
    return pending("ordinary matrix capability proof is unavailable");
  }
  try {
    const proof = await verify.call(input.evidence, runtime.activeRevision);
    if (!proof.ok || typeof proof.value !== "boolean") {
      return pending("ordinary matrix capability proof is unavailable");
    }
    const current = await readCursor(input);
    if (
      current === null || current.head !== cursor.head ||
      canonicalStringify(current.snapshot) !==
        canonicalStringify(cursor.snapshot)
    ) return pending(STATIC_CONFLICT);
    if (!proof.value) {
      return idle("active runtime does not support ordinary matrix work");
    }
    return await startExecution(
      input,
      cursor,
      runtime,
      releases,
      recovery ? "bootstrap" : "ordinary",
      runtime.activeRevision,
      null,
      input.clock.now(),
    );
  } catch {
    return pending("ordinary matrix capability proof is unavailable");
  }
}
