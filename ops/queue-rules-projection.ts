/** Offline expectation only. No I/O, source grants, runtime pins or admission authority. */
import { isGitSha } from "../src/contracts/brands.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../src/contracts/canonical.ts";
import {
  type GitHubBranchRuleWireV1,
  parseBranchRuleWire,
} from "../src/github/wire.ts";
import {
  API_VERSION,
  captureCopy,
  exactRules,
  identity,
  integer,
  type JsonObject,
  keys,
  type ParsedProjectionCapture,
  parseProjectionCapture,
  ProjectionRefusal,
  requireProjection,
  same,
} from "./queue-rules-projection-input.ts";

const DIGEST = /^[a-f0-9]{64}$/;
const DOMAIN = "sentinel.queue-rules-projection.v1";

/**
 * Trusted construction input, supplied only after independent native capture acceptance.
 * Hashes alone cannot authenticate HTTP or approve a profile. This module has no default
 * accepted profile and no production caller. Synthetic fixtures must never supply pins.
 */
export interface AcceptedQueueRulesProjectionProfile {
  domain: "sentinel.queue-rules-profile.v1";
  compilerRevision: string;
  captureSourceRevision: string;
  identity: {
    repository: {
      owner: string;
      name: string;
      id: number;
      installationId: number;
    };
    app: { id: number; nodeId: string; login: string; type: "Bot" };
  };
  acceptedAt: number;
  /** Domain-separated canonical full capture hashes, in D→A→D→A order. */
  canaryCaptureSha256: readonly [string, string, string, string];
}

export interface QueueRulesProjectionExpectation {
  domain: "sentinel.queue-rules-expectation.v1";
  status: "expectation_only";
  compiler: typeof DOMAIN;
  compilerRevision: string;
  captureSourceRevision: string;
  apiVersion: typeof API_VERSION;
  identity: AcceptedQueueRulesProjectionProfile["identity"];
  branch: "development";
  stagedRulesetId: number;
  conditions: unknown;
  bypassActors: readonly [];
  appBypass: "never";
  acceptedProfileSha256: string;
  acceptedCanaryCaptureSha256: readonly string[];
  stagedCaptureSha256: readonly [string, string];
  /** Full raw inventory/details/effective data remains bound by these capture hashes. */
  observedInventory: readonly JsonObject[];
  observedDetails: readonly JsonObject[];
  expectedActiveRules: readonly GitHubBranchRuleWireV1[];
  canonicalRules: string;
  effectiveRulesSha256: string;
}
export type QueueRulesProjectionResult =
  | { status: "unavailable"; reason: string }
  | {
    status: "prepared";
    expectation: QueueRulesProjectionExpectation;
    expectationSha256: string;
  };

/** Hash the exact JSON capture, including response metadata; not an authentication API. */
export async function queueRulesCaptureSha256(
  capture: unknown,
): Promise<string> {
  const snapshot = captureCopy(capture);
  return await canonicalStringifySha256({
    domain: "sentinel.queue-rules-capture-hash.v1",
    capture: snapshot,
  });
}

function sorted(
  rules: readonly GitHubBranchRuleWireV1[],
): GitHubBranchRuleWireV1[] {
  return [...rules].sort((a, b) =>
    canonicalStringify(a).localeCompare(canonicalStringify(b))
  );
}
function projected(capture: ParsedProjectionCapture): GitHubBranchRuleWireV1[] {
  const staged = capture.staged;
  return sorted(
    exactRules(staged.rules).map((rule) =>
      parseBranchRuleWire({
        ...rule,
        ruleset_id: staged.id,
        ruleset_source_type: staged.source_type,
        ruleset_source: staged.source,
      }, "$projected")
    ),
  );
}

/** Only update time may change across activation; retain all other detail metadata. */
function policyOf(row: JsonObject): JsonObject {
  const policy = { ...row };
  delete policy.updated_at;
  return policy;
}
function stablePolicy(capture: ParsedProjectionCapture): unknown {
  return {
    identity: capture.identity,
    branch: capture.branch,
    stagedRulesetId: capture.staged.id,
    details: capture.details.map(policyOf).sort((a, b) =>
      Number(a.id) - Number(b.id)
    ),
    effective: sorted(capture.effective),
  };
}
function disabledPolicy(capture: ParsedProjectionCapture): unknown {
  const staged = policyOf(capture.staged);
  return { ...staged, enforcement: "disabled" };
}

function acceptedProfile(value: unknown): AcceptedQueueRulesProjectionProfile {
  const row = keys(value, [
    "domain",
    "compilerRevision",
    "captureSourceRevision",
    "identity",
    "acceptedAt",
    "canaryCaptureSha256",
  ]);
  requireProjection(
    row.domain === "sentinel.queue-rules-profile.v1" &&
      isGitSha(row.compilerRevision) && isGitSha(row.captureSourceRevision) &&
      integer(row.acceptedAt),
    "profile_unaccepted",
  );
  identity(row.identity);
  requireProjection(
    Array.isArray(row.canaryCaptureSha256) &&
      row.canaryCaptureSha256.length === 4 &&
      row.canaryCaptureSha256.every((hash) =>
        typeof hash === "string" && DIGEST.test(hash)
      ) &&
      new Set(row.canaryCaptureSha256).size === 4,
    "profile_unaccepted",
  );
  return row as unknown as AcceptedQueueRulesProjectionProfile;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * `input` contains four pinned canary captures and two stable staged captures.
 * Accepted-profile provenance belongs to the trusted caller. The result itself
 * remains unaccepted preparation: it cannot attest to continuing active rules,
 * capture authenticity or an atomic GitHub snapshot. Real admission re-reads.
 */
export async function compileQueueRulesProjection(
  input: unknown,
  accepted: AcceptedQueueRulesProjectionProfile | null = null,
): Promise<QueueRulesProjectionResult> {
  try {
    if (accepted === null) {
      return { status: "unavailable", reason: "profile_unaccepted" };
    }
    // Both snapshots happen synchronously before any digest yields to the caller.
    const captured = keys(captureCopy(input), ["canary", "staged"]);
    const profile = acceptedProfile(captureCopy(accepted));
    requireProjection(
      Array.isArray(captured.canary) && captured.canary.length === 4 &&
        Array.isArray(captured.staged) && captured.staged.length === 2,
      "capture_sequence",
    );
    const canaryHashes = await Promise.all(
      captured.canary.map(queueRulesCaptureSha256),
    );
    requireProjection(
      same(canaryHashes, profile.canaryCaptureSha256),
      "capture_hash_mismatch",
    );
    const canary = captured.canary.map(parseProjectionCapture);
    for (const [index, capture] of canary.entries()) {
      requireProjection(
        same(capture.identity, profile.identity) &&
          capture.branch === "queue-canary" &&
          capture.details.length === 1 &&
          capture.staged.enforcement ===
            (index % 2 === 0 ? "disabled" : "active") &&
          capture.observedAt <= profile.acceptedAt &&
          (index === 0 || capture.observedAt > canary[index - 1]!.observedAt),
        "capture_sequence",
      );
      requireProjection(
        same(disabledPolicy(capture), disabledPolicy(canary[0]!)),
        "native_policy_drift",
      );
      requireProjection(
        same(
          sorted(capture.effective),
          index % 2 === 0 ? [] : projected(capture),
        ),
        "native_projection_unproved",
      );
    }
    const staged = captured.staged.map(parseProjectionCapture);
    const requestIds = [...canary, ...staged].flatMap((capture) =>
      capture.requestIds
    );
    requireProjection(
      new Set(requestIds).size === requestIds.length,
      "request_replayed",
    );
    requireProjection(
      staged[0]!.observedAt >= profile.acceptedAt &&
        staged[1]!.observedAt > staged[0]!.observedAt,
      "capture_sequence",
    );
    for (const capture of staged) {
      requireProjection(
        same(capture.identity, profile.identity) &&
          capture.branch === "development" &&
          capture.staged.enforcement === "disabled" &&
          capture.effective.length === 0 &&
          capture.staged.id !== canary[0]!.staged.id,
        "staged_not_disabled",
      );
      requireProjection(
        same(capture.staged.rules, canary[0]!.staged.rules),
        "unsupported_normalization",
      );
      // A disjoint canary can coexist, but it must be the accepted exact native object.
      for (
        const detail of capture.details.filter((row) => row !== capture.staged)
      ) {
        requireProjection(
          same(policyOf(detail), policyOf(canary[3]!.staged)),
          "inventory_drift",
        );
      }
    }
    requireProjection(
      same(stablePolicy(staged[0]!), stablePolicy(staged[1]!)),
      "staged_policy_drift",
    );
    const active = projected(staged[1]!);
    const expectation: QueueRulesProjectionExpectation = {
      domain: "sentinel.queue-rules-expectation.v1",
      status: "expectation_only",
      compiler: DOMAIN,
      compilerRevision: profile.compilerRevision,
      captureSourceRevision: profile.captureSourceRevision,
      apiVersion: API_VERSION,
      identity: profile.identity,
      branch: "development",
      stagedRulesetId: Number(staged[1]!.staged.id),
      conditions: staged[1]!.staged.conditions,
      bypassActors: [],
      appBypass: "never",
      acceptedProfileSha256: await canonicalStringifySha256({
        domain: "sentinel.queue-rules-profile-hash.v1",
        profile,
      }),
      acceptedCanaryCaptureSha256: canaryHashes,
      stagedCaptureSha256: await Promise.all(
        captured.staged.map(queueRulesCaptureSha256),
      ) as [string, string],
      observedInventory: staged[1]!.inventory,
      observedDetails: staged[1]!.details,
      expectedActiveRules: active,
      canonicalRules: canonicalStringify(active),
      effectiveRulesSha256: await canonicalStringifySha256(active),
    };
    const expectationSha256 = await canonicalStringifySha256({
      domain: DOMAIN,
      expectation,
    });
    return freeze({ status: "prepared", expectation, expectationSha256 });
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof ProjectionRefusal
        ? error.message
        : "invalid_capture",
    };
  }
}
