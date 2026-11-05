/**
 * Shared Sentinel v1 contracts: strict record types, fail-closed runtime
 * parsers, deterministic canonical JSON serialization, distinct identity
 * brands and the typed operational ports. Frozen before parallel module work;
 * consumers never invent their own status/digest variants.
 */

// Identity brands.
export * from "./brands.ts";
// Fail-closed validation core.
export * from "./validation.ts";
// Canonical serialization + determinism.
export * from "./canonical.ts";
// Shared fragments.
export * from "./shared.ts";
// Records.
export * from "./repository-config.ts";
export * from "./command-registry.ts";
export * from "./work-record.ts";
export * from "./incident.ts";
export * from "./review-receipt.ts";
export * from "./budget-reservation.ts";
export * from "./replay-result.ts";
export * from "./release.ts";
export * from "./vps-release.ts";
export * from "./ports-vps-release.ts";
export * from "./github-cooldown.ts";
export * from "./state-snapshots.ts";
// Hosted supervisor records (separate from Deno release records).
export * from "./hosted-supervisor.ts";
// Merge authorization parser (type with the ports below).
export * from "./merge-request.ts";
// Ports.
export * from "./ports.ts";
// Repository repair fan-out deltas (#328).
export * from "./repair-delta.ts";
// Signed planning artifacts use a separate wire format and byte bound.
export {
  assertRepairDeltaScope,
  MAX_REPAIR_DELTA_BYTES as MAX_SIGNED_REPAIR_DELTA_BYTES,
  parseSignedRepairDelta,
  type RepairDeltaPlanV1,
  type RepairDeltaV1 as SignedRepairDeltaBodyV1,
  sameRepairRepository,
  type SignedRepairDeltaV1,
  signRepairDelta,
  verifyRepairDelta,
} from "./signed-repair-delta.ts";
