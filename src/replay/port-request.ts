import {
  isCommandId,
  isFixtureDigest,
  isGitSha,
  isWorkItemId,
} from "../contracts/brands.ts";
import type { FixtureDigest } from "../contracts/brands.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { ReplayRunRequestV1 } from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import { expectRestrictedRef } from "../contracts/shared.ts";
import {
  gatewayCausalProofMatches,
  gatewayFixtureRefIdentity,
  validateGatewayCausalProof,
} from "./causal-proof.ts";
import {
  buildSentinelReplayInputMetadata,
  SENTINEL_REPLAY_INPUT_PATH,
} from "./causal-dispatch.ts";
import { checkResolvedFixture, computeReplayFixtureDigest } from "./fixture.ts";
import type { ReplayFixtureEntryV1, ResolvedFixtureV1 } from "./fixture.ts";
import type { ReplayPortOptions } from "./port-options.ts";

const MAX_TEST_IDS = 64;
const TEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/**
 * Reserved gateway dispatch namespace (mirrors the frozen grammar in
 * `causal-proof.ts`). A reference in this namespace belongs to the gateway
 * replay protocol: it must parse through `gatewayFixtureRefIdentity`, and a
 * malformed reserved reference is rejected here — it never silently falls
 * back to the non-gateway fixture protocol (which has no dispatch metadata).
 */
const GATEWAY_FIXTURE_REF_PREFIX = "fixture://gateway-replay/";
/** Fixed gateway fixture directory root (frozen composition layout). */
const GATEWAY_FIXTURE_ROOT = "tests/fixtures/gateway-replay";

export async function prepareReplayRequest(
  options: ReplayPortOptions,
  request: ReplayRunRequestV1,
) {
  const invalid = validateRequest(options.config, request);
  if (invalid !== null) return portError("invalid", invalid);

  // Own-property lookup only: an id like "constructor" or "toString" in a
  // registry that does not contain it must never resolve to an inherited
  // Object.prototype member and be mistaken for a configured command.
  const registry = options.config.commandRegistry.commands;
  if (!Object.hasOwn(registry, request.commandId)) {
    return portError(
      "invalid",
      `command ${request.commandId} is not in the trusted command registry`,
    );
  }
  const spec = registry[request.commandId];

  // Gateway dispatch identity: ONLY a valid frozen gateway fixture reference
  // selects the dispatch-metadata protocol. A reference in the reserved
  // gateway namespace that does not parse is rejected here instead of
  // silently falling back to the non-gateway fixture path (which would run
  // the target command without the fixed root dispatcher).
  const gatewayRef = gatewayFixtureRefIdentity(request.fixtureRef);
  if (
    gatewayRef === null &&
    (request.fixtureRef.startsWith(GATEWAY_FIXTURE_REF_PREFIX) ||
      request.fixtureRef === GATEWAY_FIXTURE_REF_PREFIX.slice(0, -1))
  ) {
    return portError(
      "invalid",
      "malformed gateway fixture reference is never treated as a " +
        "non-gateway fixture",
    );
  }

  const resolvedResult = await options.fixtures.resolveFixture(
    request.fixtureRef,
  );
  if (!resolvedResult.ok) return resolvedResult;
  const resolved = resolvedResult.value;

  // Digest the actual bytes BEFORE any command runs and compare exactly.
  const actualDigest = await computeReplayFixtureDigest(resolved.entries);
  if (actualDigest !== request.fixtureDigest) {
    return portError(
      "invalid",
      `fixture digest mismatch: bundle bytes do not match the request digest ` +
        `(expected ${request.fixtureDigest}, computed ${actualDigest})`,
    );
  }
  if (!sameTestIds(request.testIds, resolved.testIds)) {
    return portError(
      "invalid",
      "request test identity does not match the trusted fixture identity",
    );
  }
  const check = checkResolvedFixture(
    resolved,
    options.policy,
    options.config.protectedPaths,
  );
  if (!check.ok) {
    return portError("invalid", check.reason);
  }

  // Gateway dispatch metadata (OUTSIDE the digested two-entry bundle). It is
  // derived ONLY from the already parsed frozen gateway fixture identity and
  // the trusted resolved test identity — never from a scan or a model path.
  // The expected gateway bundle is EXACTLY the two fixed request/upstream
  // entries at the resolved incident/capture paths: a missing, ambiguous or
  // extra entry is rejected before any target command runs. A non-gateway
  // request keeps the unchanged protocol (no dispatch metadata).
  let dispatchEntry: ReplayFixtureEntryV1 | null = null;
  if (gatewayRef !== null) {
    const base =
      `${GATEWAY_FIXTURE_ROOT}/${gatewayRef.incidentId}/${gatewayRef.captureId}`;
    const requestPath = `${base}/request.json`;
    const upstreamPath = `${base}/upstream.json`;
    const paths = new Set(resolved.entries.map((entry) => entry.path));
    if (
      resolved.entries.length !== 2 || paths.size !== 2 ||
      !paths.has(requestPath) || !paths.has(upstreamPath)
    ) {
      return portError(
        "invalid",
        "gateway fixture bundle must contain exactly the fixed request and " +
          "upstream entries",
      );
    }
    const metadata = buildSentinelReplayInputMetadata(
      requestPath,
      upstreamPath,
      resolved.testIds,
    );
    if (metadata === null) {
      return portError(
        "invalid",
        "gateway dispatch metadata is outside its fixed bounds",
      );
    }
    dispatchEntry = { path: SENTINEL_REPLAY_INPUT_PATH, bytes: metadata };
  }

  // Trusted causal-proof boundary (BEFORE any target command runs): a
  // fully bound proof is the ONLY condition that may suppress the
  // `fixture_redacted` limitation. An absent, structurally invalid or
  // identity-mismatched proof keeps the ordinary redacted fixture and its
  // limitation; this never weakens provenance (still redacted) and never
  // clears any other limitation (output_truncated, unrelated failure,
  // unavailable, wrong revision/command/test identity).
  const proofValid = await proofValidFor(
    options.config,
    resolved,
    request,
    actualDigest,
  );

  return portOk({ resolved, proofValid, dispatchEntry, spec });
}

async function proofValidFor(
  config: RepositoryConfigV1,
  resolved: ResolvedFixtureV1,
  request: ReplayRunRequestV1,
  actualDigest: FixtureDigest,
): Promise<boolean> {
  if (resolved.causalProof === undefined) return false;
  const parsed = await validateGatewayCausalProof(resolved.causalProof);
  if (parsed === null) return false;
  const refIdentity = gatewayFixtureRefIdentity(request.fixtureRef);
  if (refIdentity === null) return false;
  if (
    request.commandId !== parsed.replayCommandId &&
    request.commandId !== parsed.testCommandId
  ) {
    return false;
  }
  return gatewayCausalProofMatches(parsed, {
    repository: request.repository,
    incidentId: refIdentity.incidentId,
    captureId: refIdentity.captureId,
    fixtureRef: request.fixtureRef,
    bundleDigest: actualDigest,
    replayCommandId: config.commands.replay,
    testCommandId: config.commands.test,
    testIds: resolved.testIds,
    expectedFailure: resolved.expectedFailure,
  });
}

function validateRequest(
  config: RepositoryConfigV1,
  request: ReplayRunRequestV1,
): string | null {
  if (!isWorkItemId(request.taskId)) {
    return "invalid work item id";
  }
  const repo = request.repository;
  const configRepo = config.repository;
  if (
    repo.owner !== configRepo.owner || repo.name !== configRepo.name ||
    repo.installationId !== configRepo.installationId
  ) {
    return "replay request repository does not match the configured repository";
  }
  if (!isGitSha(request.revision)) {
    return "invalid revision (expected an exact 40-hex Git SHA)";
  }
  if (!isCommandId(request.commandId)) {
    return "invalid command id";
  }
  if (
    typeof request.fixtureRef !== "string" ||
    request.fixtureRef.length === 0
  ) {
    return "invalid fixture reference";
  }
  try {
    expectRestrictedRef(request.fixtureRef, "$.fixtureRef");
  } catch {
    return "fixture reference must be an opaque restricted storage reference";
  }
  if (!isFixtureDigest(request.fixtureDigest)) {
    return "invalid fixture digest";
  }
  if (
    !Array.isArray(request.testIds) || request.testIds.length === 0 ||
    request.testIds.length > MAX_TEST_IDS
  ) {
    return "invalid test identity";
  }
  const seen = new Set<string>();
  for (const id of request.testIds) {
    if (typeof id !== "string" || !TEST_ID_RE.test(id)) {
      return `invalid test id: ${testIdForMessage(id)}`;
    }
    if (seen.has(id)) return "duplicate test id in request";
    seen.add(id);
  }
  if (
    typeof request.outputLimitBytes !== "number" ||
    !Number.isSafeInteger(request.outputLimitBytes) ||
    request.outputLimitBytes <= 0
  ) {
    return "invalid output limit";
  }
  return null;
}
function sameTestIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function testIdForMessage(value: unknown): string {
  if (typeof value !== "string") return "non-string";
  if (value.length > 40) return `${value.slice(0, 40)}…`;
  return value;
}
