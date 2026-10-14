/** Repair loop internals: replay evidence. */
import type { FixtureDigest } from "../contracts/brands.ts";
import type { IncidentEvidenceV1 } from "../contracts/incident.ts";
import type { PortResultV1, ReplayPort } from "../contracts/ports.ts";
import type { ReplayResultV1 } from "../contracts/replay-result.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { isCausalReplayResult } from "./loop-evidence.ts";
import type {
  CarryV1,
  RepairCycleDepsV1,
  ReplayFixtureIdentitySourceV1,
} from "./loop-types.ts";

export type SavedReplayValidationV1 =
  | { kind: "ok"; testIds: readonly string[] }
  | { kind: "invalid" }
  | { kind: "wait" };

/**
 * Validate one saved replay result against the CURRENT evidence and
 * configuration identities before it may supply proof again: causal shape
 * (with exact repository identity), fixture ref/digest against the current
 * evidence replay metadata, replay command against the evidence command,
 * test command against the repository config, and a usable test-id set that
 * matches the trusted ids resolved for the exact fixture. Fixture resolution
 * unavailable is a wait; every other mismatch is invalid.
 */
export async function validateSavedReplay(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  evidence: IncidentEvidenceV1,
  config: RepositoryConfigV1,
  result: ReplayResultV1,
): Promise<SavedReplayValidationV1> {
  if (!isCausalReplayResult(result, record)) return { kind: "invalid" };
  const replay = evidence.replay;
  if (replay === null) return { kind: "invalid" };
  if (
    result.fixture.ref !== replay.fixtureRef ||
    result.fixture.digest !== replay.fixtureDigest ||
    result.commands.replay !== replay.commandId ||
    result.commands.test !== config.commands.test
  ) {
    return { kind: "invalid" };
  }
  const resolved = await resolveFixtureTestIds(
    deps,
    result.fixture.ref,
    result.fixture.digest,
  );
  if (resolved.kind === "wait") return { kind: "wait" };
  if (resolved.kind === "invalid") return { kind: "invalid" };
  const saved = usableTestIds(result.fixture.testIds);
  if (saved === null || !sameStringArray(saved, resolved.value)) {
    return { kind: "invalid" };
  }
  return { kind: "ok", testIds: resolved.value };
}

/**
 * Carry the trusted saved-original proof for a later candidate validation:
 * the reconstructed before-run copies the ACTUAL recorded limitations (never
 * a fabricated empty array) and keeps the recorded failure identity.
 */
export function carryFromSavedReplay(
  carry: CarryV1,
  result: ReplayResultV1,
  testIds: readonly string[],
): void {
  carry.beforeRun = {
    outcome: result.original.outcome,
    exitCode: result.original.exitCode,
    output: result.original.output,
    failure: result.original.failure === null ? null : {
      intended: result.original.failure.intended,
      reason: result.original.failure.reason,
    },
    limitations: [...result.limitations],
    startedAt: 0,
    endedAt: 0,
  };
  carry.fixtureRef = result.fixture.ref;
  carry.fixtureDigest = result.fixture.digest;
  carry.testIds = [...testIds];
  carry.replayCommandId = result.commands.replay;
  carry.beforeReason = result.expected.beforeReason;
}

// ---------------------------------------------------------------------------
// Helpers (deterministic; no product logic in fakes).
// ---------------------------------------------------------------------------

export type FixtureTestIdsResultV1 =
  | { kind: "ok"; value: string[] }
  | { kind: "invalid" }
  | { kind: "wait" };

/**
 * Resolve fixture identities only through a trusted host capability. The
 * ReplayPort contract deliberately does not expose its internal resolver, so
 * an absent capability is missing evidence rather than permission to invent a
 * test id. A replay object may implement the same read-only capability when
 * the host uses one object for both execution and fixture resolution.
 */
export async function resolveFixtureTestIds(
  deps: RepairCycleDepsV1,
  fixtureRef: string,
  fixtureDigest: FixtureDigest,
): Promise<FixtureTestIdsResultV1> {
  const replayWithIdentity = deps.replay as
    & ReplayPort
    & Partial<ReplayFixtureIdentitySourceV1>;
  const resolveTestIds = deps.fixtureIdentities !== undefined
    ? deps.fixtureIdentities.resolveTestIds.bind(deps.fixtureIdentities)
    : (typeof replayWithIdentity.resolveTestIds === "function"
      ? replayWithIdentity.resolveTestIds.bind(replayWithIdentity)
      : null);
  if (resolveTestIds === null) return { kind: "invalid" };
  let resolved: PortResultV1<readonly string[]>;
  try {
    resolved = await resolveTestIds(fixtureRef, fixtureDigest);
  } catch {
    return { kind: "wait" };
  }
  if (!resolved.ok) return { kind: "wait" };
  const value = usableTestIds(resolved.value);
  return value === null ? { kind: "invalid" } : { kind: "ok", value };
}

/** Validate the small identity shape before handing it to ReplayPort. */
export function usableTestIds(value: readonly string[]): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return null;
  }
  const seen = new Set<string>();
  for (const id of value) {
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(id) ||
      seen.has(id)
    ) {
      return null;
    }
    seen.add(id);
  }
  return [...value];
}

/** Deterministic order-sensitive identity equality for test-id sets. */
export function sameStringArray(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
