// Frozen parser from 1838df313105bab219d71602695a7f758a65125e; only import paths change.
import type { GitSha } from "../../../src/contracts/brands.ts";
import { parseReleaseRequestV1 } from "../../../src/contracts/release.ts";
import {
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
  MaxText,
} from "../../../src/contracts/validation.ts";
import type {
  HostedExecutionPurposeV1,
  HostedPointerActionV1,
  HostedPointerIntentV1,
  HostedReleaseRecordV1,
  HostedRunProofV1,
} from "../../../src/contracts/hosted-supervisor-types.ts";
import { parseHostedRunProofV1 } from "../../../src/contracts/hosted-supervisor-execution.ts";
import { parseHostedPointerIntentV1 } from "./hosted-supervisor-runtime.ts";

export const HOSTED_RELEASE_KEYS = [
  "version",
  "kind",
  "id",
  "request",
  "priorRevision",
  "phase",
  "priorProof",
  "candidateProof",
  "rollbackProof",
  "pointerIntent",
  "createdAt",
  "updatedAt",
] as const;

export function parseHostedReleaseRecordV1(
  input: unknown,
  path = "$",
): HostedReleaseRecordV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, HOSTED_RELEASE_KEYS, path);
  expectVersion(obj.version, `${path}.version`);
  expectEnum(obj.kind, ["hosted_release"], `${path}.kind`);

  const request = parseReleaseRequestV1(obj.request);
  const id = expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId);
  if (id !== request.id) {
    fail(
      `${path}.id`,
      "invalid_lifecycle",
      "hosted release id must equal the release request id",
    );
  }
  // Exact self scope-0 production open reviewed request: no other repository,
  // installation, environment, status or review-less request is representable.
  const repository = request.target.repository;
  if (
    (repository.owner !== "ubiquity" &&
      repository.owner !== "Ubiquity-Sentinel") ||
    repository.name !== "sentinel" || repository.installationId !== 0
  ) {
    fail(
      `${path}.request.target.repository`,
      "invalid_lifecycle",
      "hosted release request must target the self scope-0 repository",
    );
  }
  if (request.target.environment !== "production") {
    fail(
      `${path}.request.target.environment`,
      "invalid_lifecycle",
      "hosted release request must target production",
    );
  }
  if (request.status !== "open") {
    fail(
      `${path}.request.status`,
      "invalid_lifecycle",
      "hosted release request must be open",
    );
  }
  if (request.source.reviewReceiptId === null) {
    fail(
      `${path}.request.source.reviewReceiptId`,
      "invalid_lifecycle",
      "hosted release request must be a reviewed request",
    );
  }
  const priorRevision = expectGitSha(
    obj.priorRevision,
    `${path}.priorRevision`,
  );
  if (priorRevision === request.revision) {
    fail(
      `${path}.priorRevision`,
      "invalid_lifecycle",
      "hosted release priorRevision must differ from the request revision",
    );
  }
  const phase = expectEnum(
    obj.phase,
    [
      "requested",
      "promoting",
      "verifying",
      "accepted",
      "rollback_pending",
      "rollback_verifying",
      "rolled_back",
    ],
    `${path}.phase`,
  );
  const priorProof = expectNullable(
    obj.priorProof,
    `${path}.priorProof`,
    parseHostedRunProofV1,
  );
  const candidateProof = expectNullable(
    obj.candidateProof,
    `${path}.candidateProof`,
    parseHostedRunProofV1,
  );
  const rollbackProof = expectNullable(
    obj.rollbackProof,
    `${path}.rollbackProof`,
    parseHostedRunProofV1,
  );
  const pointerIntent = expectNullable(
    obj.pointerIntent,
    `${path}.pointerIntent`,
    parseHostedPointerIntentV1,
  );
  const createdAt = expectTimestamp(obj.createdAt, `${path}.createdAt`);
  const updatedAt = expectTimestamp(obj.updatedAt, `${path}.updatedAt`);

  expectProofBinding(
    priorProof,
    "prior",
    priorRevision,
    id,
    `${path}.priorProof`,
  );
  expectProofBinding(
    candidateProof,
    "candidate",
    request.revision,
    id,
    `${path}.candidateProof`,
  );
  expectProofBinding(
    rollbackProof,
    "rollback",
    priorRevision,
    id,
    `${path}.rollbackProof`,
  );
  if (priorProof !== null && priorProof.outcome !== "healthy") {
    fail(
      `${path}.priorProof`,
      "invalid_lifecycle",
      "the prior proof must be healthy",
    );
  }
  if (rollbackProof !== null && rollbackProof.outcome !== "healthy") {
    fail(
      `${path}.rollbackProof`,
      "invalid_lifecycle",
      "the rollback proof must be healthy",
    );
  }

  if (createdAt < request.createdAt) {
    fail(
      `${path}.createdAt`,
      "invalid_lifecycle",
      "hosted release createdAt cannot precede the release request",
    );
  }
  if (createdAt > updatedAt) {
    fail(
      `${path}.createdAt`,
      "invalid_lifecycle",
      "createdAt cannot be after updatedAt",
    );
  }
  for (
    const [index, proof] of [
      priorProof,
      candidateProof,
      rollbackProof,
    ].entries()
  ) {
    if (proof !== null && proof.execution.createdAt < createdAt) {
      fail(
        `${path}.proofs[${index}].execution.createdAt`,
        "invalid_lifecycle",
        "saved proof executions cannot precede the hosted receipt",
      );
    }
  }

  if (phase !== "requested") {
    // promoting and every later phase depend on an attested prior proof.
    if (priorProof === null) {
      fail(
        `${path}.priorProof`,
        "invalid_lifecycle",
        "promoting and later phases require the prior proof",
      );
    }
  }
  if (phase === "promoting") {
    expectPointerIntent(
      pointerIntent,
      "promote",
      priorRevision,
      request.revision,
      `${path}.pointerIntent`,
    );
  } else if (phase === "rollback_pending") {
    if (pointerIntent !== null) {
      expectPointerIntent(
        pointerIntent,
        "rollback",
        request.revision,
        priorRevision,
        `${path}.pointerIntent`,
      );
    }
  } else if (pointerIntent !== null) {
    fail(
      `${path}.pointerIntent`,
      "invalid_lifecycle",
      "a pointer intent exists only while promoting or rollback_pending",
    );
  }
  if (phase === "accepted") {
    if (candidateProof === null || candidateProof.outcome !== "healthy") {
      fail(
        `${path}.candidateProof`,
        "invalid_lifecycle",
        "accepted requires a healthy candidate proof",
      );
    }
  }
  if (
    phase === "rollback_pending" || phase === "rollback_verifying" ||
    phase === "rolled_back"
  ) {
    if (candidateProof === null || candidateProof.outcome !== "failed") {
      fail(
        `${path}.candidateProof`,
        "invalid_lifecycle",
        "rollback phases require the failed candidate proof",
      );
    }
  }
  if (phase === "rolled_back") {
    if (rollbackProof === null || rollbackProof.outcome !== "healthy") {
      fail(
        `${path}.rollbackProof`,
        "invalid_lifecycle",
        "rolled_back requires the healthy rollback proof",
      );
    }
  }

  return {
    version: "v1",
    kind: "hosted_release",
    id,
    request,
    priorRevision,
    phase,
    priorProof,
    candidateProof,
    rollbackProof,
    pointerIntent,
    createdAt,
    updatedAt,
  };
}

export function expectProofBinding(
  proof: HostedRunProofV1 | null,
  purpose: HostedExecutionPurposeV1,
  revision: GitSha,
  releaseId: string,
  path: string,
): void {
  if (proof === null) return;
  if (
    proof.execution.purpose !== purpose ||
    proof.execution.revision !== revision ||
    proof.execution.releaseId !== releaseId
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "hosted run proof does not bind the exact release, purpose and revision",
    );
  }
}

export function expectPointerIntent(
  intent: HostedPointerIntentV1 | null,
  action: HostedPointerActionV1,
  expectedRevision: GitSha,
  nextRevision: GitSha,
  path: string,
): void {
  if (
    intent === null || intent.action !== action ||
    intent.expectedRevision !== expectedRevision ||
    intent.nextRevision !== nextRevision
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "hosted pointer intent does not match the phase movement",
    );
  }
}
