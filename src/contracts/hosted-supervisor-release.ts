import type { GitSha } from "./brands.ts";
import { parseReleaseRequestV1 } from "./release.ts";
import {
  expectArray,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  expectVersion,
  fail,
  MaxText,
} from "./validation.ts";
import type {
  HostedExecutionPurposeV1,
  HostedOwnerDispositionV1,
  HostedOwnerSuccessorBindingV1,
  HostedOwnerSuccessorTaskBindingV1,
  HostedOwnerSupersessionIntentV1,
  HostedPointerActionV1,
  HostedPointerIntentV1,
  HostedReleaseRecordV1,
  HostedRunProofV1,
} from "./hosted-supervisor-types.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedRunProofV1,
} from "./hosted-supervisor-execution.ts";
import { parseHostedPointerIntentV1 } from "./hosted-supervisor-runtime.ts";
import { parseOwnerSuccessorTaskAcceptanceV1 } from "./owner-successor-review.ts";
import { canonicalStringify } from "./canonical.ts";
import {
  parseHostedAbandonment,
  parseHostedVerification,
} from "./hosted-supervisor-verification.ts";

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
  expectExactKeys(obj, [
    ...HOSTED_RELEASE_KEYS,
    ...[
      "ownerDisposition",
      "ownerAcceptance",
      "ownerSuccessorBindings",
      "verification",
      "abandonment",
    ].filter(
      (key) => Object.hasOwn(obj, key),
    ),
  ], path);
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
    repository.owner !== "ubiquity" || repository.name !== "sentinel" ||
    repository.installationId !== 0
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
      "owner_superseded",
      "abandoned",
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

  const verification = Object.hasOwn(obj, "verification")
    ? parseHostedVerification(obj.verification, `${path}.verification`)
    : undefined;
  const abandonment = Object.hasOwn(obj, "abandonment")
    ? parseHostedAbandonment(obj.abandonment, `${path}.abandonment`)
    : undefined;
  for (const purpose of ["prior", "candidate"] as const) {
    const proof = verification?.[purpose].lastFailure?.proof;
    if (
      proof &&
      (proof.execution.releaseId !== id ||
        proof.execution.purpose !== purpose ||
        proof.execution.revision !==
          (purpose === "prior" ? priorRevision : request.revision))
    ) {
      fail(
        path,
        "invalid_lifecycle",
        "failure journal must bind its exact release and phase",
      );
    }
  }
  if (
    (phase === "abandoned") !== (abandonment !== undefined) ||
    abandonment &&
      (pointerIntent !== null || abandonment.recordedAt > updatedAt ||
        abandonment.recordedAt < createdAt)
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "abandonment requires a terminal receipt with no unresolved pointer intent",
    );
  }
  if (
    abandonment?.reason === "prior_verification_exhausted" &&
    (verification?.prior.failures !== 2 || priorProof !== null)
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "PRIOR abandonment requires two settled unsuccessful verifications",
    );
  }
  if (
    abandonment?.reason === "candidate_verification_failed" &&
    (candidateProof?.outcome !== "failed" ||
      rollbackProof?.outcome !== "healthy")
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "candidate failure abandonment requires verified restoration",
    );
  }
  if (
    abandonment?.reason === "candidate_verification_exhausted" &&
    (verification?.candidate.failures !== 2 ||
      rollbackProof?.outcome !== "healthy")
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "candidate exhaustion requires verified restoration",
    );
  }
  if (
    phase !== "requested" && phase !== "owner_superseded" &&
    phase !== "abandoned"
  ) {
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
    if (
      (candidateProof === null || candidateProof.outcome !== "failed") &&
      verification?.candidate.failures !== 2
    ) {
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

  const ownerDisposition = Object.hasOwn(obj, "ownerDisposition")
    ? parseHostedOwnerDispositionV1(
      obj.ownerDisposition,
      `${path}.ownerDisposition`,
    )
    : undefined;
  if (phase === "owner_superseded") {
    if (
      !ownerDisposition || priorProof !== null || candidateProof !== null ||
      rollbackProof !== null || pointerIntent !== null ||
      ownerDisposition.intent.releaseId !== id ||
      ownerDisposition.intent.fromRevision !== priorRevision ||
      ownerDisposition.failedPriorProof.execution.releaseId !== id ||
      ownerDisposition.failedPriorProof.execution.revision !== priorRevision ||
      ownerDisposition.intent.authorizedAt > updatedAt ||
      ownerDisposition.originalFailedPriorProof.observedAt > updatedAt
    ) {
      fail(
        path,
        "invalid_lifecycle",
        "owner supersession requires its exact distinct disposition and null release proof slots",
      );
    }
  } else if (ownerDisposition !== undefined) {
    fail(
      path,
      "invalid_lifecycle",
      "owner disposition belongs only to owner_superseded",
    );
  }
  const ownerSuccessorBindings = Object.hasOwn(obj, "ownerSuccessorBindings")
    ? expectArray(
      obj.ownerSuccessorBindings,
      `${path}.ownerSuccessorBindings`,
      32,
      parseHostedOwnerSuccessorBindingV1,
    )
    : undefined;
  if (
    ownerSuccessorBindings !== undefined &&
    (!ownerDisposition || phase !== "owner_superseded" ||
      ownerSuccessorBindings.length === 0 ||
      new Set(ownerSuccessorBindings.map((b) => b.id)).size !==
        ownerSuccessorBindings.length ||
      new Set(
          ownerSuccessorBindings.map((b) =>
            `${b.binding.successorRevision}:${b.binding.successorGeneration}`
          ),
        ).size !== ownerSuccessorBindings.length ||
      ownerSuccessorBindings.some((b) =>
        b.binding.releaseId !== id ||
        b.binding.requestSha256 !== ownerDisposition.intent.requestSha256 ||
        b.binding.intentSha256 !== ownerDisposition.intentSha256 ||
        b.binding.taskSha256 !== ownerDisposition.intent.taskSha256 ||
        b.binding.issueNumber !== ownerDisposition.intent.issueNumber ||
        b.binding.workId !== ownerDisposition.intent.workId
      ))
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "owner successor bindings must uniquely retain the original task identity",
    );
  }
  const ownerAcceptance = Object.hasOwn(obj, "ownerAcceptance")
    ? parseOwnerSuccessorTaskAcceptanceV1(
      obj.ownerAcceptance,
      `${path}.ownerAcceptance`,
    )
    : undefined;
  const acceptedBinding = ownerSuccessorBindings?.find((b) =>
    b.id === ownerAcceptance?.review.binding.ownerBindingId
  );
  const initialAcceptance = ownerAcceptance?.review.binding.ownerBindingId ===
    `disposition:${ownerDisposition?.intentSha256}`;
  if (
    ownerAcceptance !== undefined &&
    (ownerDisposition === undefined || phase !== "owner_superseded" ||
      ownerAcceptance.review.binding.releaseId !== id ||
      ownerAcceptance.review.binding.intentSha256 !==
        ownerDisposition.intentSha256 ||
      ownerAcceptance.review.binding.requestSha256 !==
        ownerDisposition.intent.requestSha256 ||
      (initialAcceptance
        ? ownerAcceptance.review.binding.successorRevision !==
            ownerDisposition.intent.toRevision ||
          ownerAcceptance.review.binding.successorGeneration !==
            ownerDisposition.intent.toGeneration ||
          ownerAcceptance.review.binding.ownerBindingSha256 !==
            ownerDisposition.intentSha256
        : !acceptedBinding ||
          ownerAcceptance.review.binding.successorRevision !==
            acceptedBinding.binding.successorRevision ||
          ownerAcceptance.review.binding.successorGeneration !==
            acceptedBinding.binding.successorGeneration ||
          ownerAcceptance.review.binding.ownerBindingSha256 !==
            acceptedBinding.bindingSha256) ||
      ownerAcceptance.review.binding.taskSha256 !==
        ownerDisposition.intent.taskSha256 ||
      ownerAcceptance.review.binding.snapshot.base !==
        (initialAcceptance
          ? ownerDisposition.intent.acceptanceBaseRevision
          : acceptedBinding?.binding.acceptanceBaseRevision))
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "owner acceptance must bind the exact supersession task and successor",
    );
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
    ...(verification === undefined ? {} : { verification }),
    ...(abandonment === undefined ? {} : { abandonment }),
    ...(ownerDisposition === undefined ? {} : { ownerDisposition }),
    ...(ownerAcceptance === undefined ? {} : { ownerAcceptance }),
    ...(ownerSuccessorBindings === undefined ? {} : { ownerSuccessorBindings }),
    createdAt,
    updatedAt,
  };
}

export function parseHostedOwnerSuccessorTaskBindingV1(
  input: unknown,
  path = "$",
): HostedOwnerSuccessorTaskBindingV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, [
    "releaseId",
    "requestSha256",
    "intentSha256",
    "successorRevision",
    "successorGeneration",
    "taskSha256",
    "issueNumber",
    "workId",
    "acceptanceBaseRevision",
    "controllerSourceRevision",
    "controllerCodeSha256",
    "ciRevision",
  ], path);
  const result = {
    releaseId: expectNonEmptyString(
      obj.releaseId,
      `${path}.releaseId`,
      MaxText.recordId,
    ),
    requestSha256: expectSha256Hex(obj.requestSha256, `${path}.requestSha256`),
    intentSha256: expectSha256Hex(obj.intentSha256, `${path}.intentSha256`),
    successorRevision: expectGitSha(
      obj.successorRevision,
      `${path}.successorRevision`,
    ),
    successorGeneration: expectPositiveInt(
      obj.successorGeneration,
      `${path}.successorGeneration`,
    ),
    taskSha256: expectSha256Hex(obj.taskSha256, `${path}.taskSha256`),
    issueNumber: expectPositiveInt(obj.issueNumber, `${path}.issueNumber`),
    workId: expectNonEmptyString(
      obj.workId,
      `${path}.workId`,
      MaxText.recordId,
    ),
    acceptanceBaseRevision: expectGitSha(
      obj.acceptanceBaseRevision,
      `${path}.acceptanceBaseRevision`,
    ),
    controllerSourceRevision: expectGitSha(
      obj.controllerSourceRevision,
      `${path}.controllerSourceRevision`,
    ),
    controllerCodeSha256: expectSha256Hex(
      obj.controllerCodeSha256,
      `${path}.controllerCodeSha256`,
    ),
    ciRevision: expectGitSha(obj.ciRevision, `${path}.ciRevision`),
  };
  if (result.ciRevision !== result.successorRevision) {
    fail(
      path,
      "invalid_lifecycle",
      "owner successor task CI must bind its exact successor",
    );
  }
  return Object.freeze(result);
}
export function parseHostedOwnerSuccessorBindingV1(
  input: unknown,
  path = "$",
): HostedOwnerSuccessorBindingV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, [
    "id",
    "binding",
    "bindingSha256",
    "controllerRevision",
    "recoveryFromRevision",
    "recoveryFromGeneration",
    "movement",
    "movementProof",
    "movementProofSha256",
  ], path);
  const result = {
    id: expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId),
    binding: parseHostedOwnerSuccessorTaskBindingV1(
      obj.binding,
      `${path}.binding`,
    ),
    bindingSha256: expectSha256Hex(obj.bindingSha256, `${path}.bindingSha256`),
    controllerRevision: expectGitSha(
      obj.controllerRevision,
      `${path}.controllerRevision`,
    ),
    recoveryFromRevision: expectGitSha(
      obj.recoveryFromRevision,
      `${path}.recoveryFromRevision`,
    ),
    recoveryFromGeneration: expectPositiveInt(
      obj.recoveryFromGeneration,
      `${path}.recoveryFromGeneration`,
    ),
    movement: expectEnum(
      obj.movement,
      ["recovery", "install", "rollback"],
      `${path}.movement`,
    ),
    movementProof: parseHostedRunProofV1(
      obj.movementProof,
      `${path}.movementProof`,
    ),
    movementProofSha256: expectSha256Hex(
      obj.movementProofSha256,
      `${path}.movementProofSha256`,
    ),
  };
  if (
    result.binding.successorGeneration !== result.recoveryFromGeneration + 1 ||
    result.binding.successorRevision === result.recoveryFromRevision ||
    result.movementProof.execution.revision !== result.recoveryFromRevision ||
    result.movementProof.execution.generation !==
      result.recoveryFromGeneration ||
    result.movement === "install" &&
      result.movementProof.outcome !== "healthy" ||
    result.movement !== "install" && result.movementProof.outcome !== "failed"
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "owner successor binding preserves its genuine movement proof classification",
    );
  }
  return result;
}

export function parseHostedOwnerSupersessionIntentV1(
  input: unknown,
  path = "$",
): HostedOwnerSupersessionIntentV1 {
  const obj = expectRecord(input, path);
  const strings = ["releaseId", "workId"] as const;
  const digests = [
    "requestSha256",
    "sourceSha256",
    "taskSha256",
    "workSha256",
    "repairSnapshotSha256",
    "releaseSnapshotSha256",
    "controllerCodeSha256",
    "failedProofSha256",
    "retainedHealthyProofSha256",
    "originalFailedPriorNativeSha256",
  ] as const;
  const revisions = [
    "repairHead",
    "releaseHead",
    "fromRevision",
    "toRevision",
    "controllerSourceRevision",
    "ciRevision",
    "healthyWitnessHead",
    "acceptanceBaseRevision",
  ] as const;
  expectExactKeys(obj, [
    ...strings,
    ...digests,
    ...revisions,
    "issueNumber",
    "fromGeneration",
    "toGeneration",
    "authorizedAt",
    "requiredAncestors",
    "originalFailedPriorExecution",
    "originalFailedPriorJobId",
  ], path);
  const result = { ...obj } as unknown as HostedOwnerSupersessionIntentV1;
  for (const key of strings) {
    result[key] = expectNonEmptyString(
      obj[key],
      `${path}.${key}`,
      MaxText.recordId,
    );
  }
  for (const key of digests) {
    result[key] = expectSha256Hex(obj[key], `${path}.${key}`);
  }
  for (const key of revisions) {
    result[key] = expectGitSha(obj[key], `${path}.${key}`);
  }
  result.issueNumber = expectPositiveInt(
    obj.issueNumber,
    `${path}.issueNumber`,
  );
  result.fromGeneration = expectPositiveInt(
    obj.fromGeneration,
    `${path}.fromGeneration`,
  );
  result.toGeneration = expectPositiveInt(
    obj.toGeneration,
    `${path}.toGeneration`,
  );
  result.authorizedAt = expectTimestamp(
    obj.authorizedAt,
    `${path}.authorizedAt`,
  );
  result.originalFailedPriorExecution = Object.freeze(
    parseHostedExecutionIntentV1(
      obj.originalFailedPriorExecution,
      `${path}.originalFailedPriorExecution`,
    ),
  );
  result.originalFailedPriorJobId = expectPositiveInt(
    obj.originalFailedPriorJobId,
    `${path}.originalFailedPriorJobId`,
  );
  result.requiredAncestors = Object.freeze(
    expectArray(
      obj.requiredAncestors,
      `${path}.requiredAncestors`,
      32,
      expectGitSha,
    ),
  );
  if (
    result.toGeneration !== result.fromGeneration + 1 ||
    result.toRevision === result.fromRevision ||
    result.ciRevision !== result.toRevision ||
    result.requiredAncestors.length < 2 ||
    new Set(result.requiredAncestors).size !==
      result.requiredAncestors.length ||
    !result.requiredAncestors.includes(
      "1838df313105bab219d71602695a7f758a65125e" as GitSha,
    )
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "owner intent must bind one monotonic capable successor and required ancestry",
    );
  }
  return Object.freeze(result);
}

export function parseHostedOwnerDispositionV1(
  input: unknown,
  path = "$",
): HostedOwnerDispositionV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, [
    "version",
    "kind",
    "intent",
    "intentSha256",
    "controllerRevision",
    "controllerCiRevision",
    "failedPriorProof",
    "originalFailedPriorProof",
    "retainedHealthyProof",
  ], path);
  expectVersion(obj.version, `${path}.version`);
  expectEnum(obj.kind, ["owner_supersession"], `${path}.kind`);
  const intent = parseHostedOwnerSupersessionIntentV1(
    obj.intent,
    `${path}.intent`,
  );
  const failedPriorProof = parseHostedRunProofV1(
    obj.failedPriorProof,
    `${path}.failedPriorProof`,
  );
  const retainedHealthyProof = parseHostedRunProofV1(
    obj.retainedHealthyProof,
    `${path}.retainedHealthyProof`,
  );
  const originalFailedPriorProof = parseHostedRunProofV1(
    obj.originalFailedPriorProof,
    `${path}.originalFailedPriorProof`,
  );
  const controllerRevision = expectGitSha(
    obj.controllerRevision,
    `${path}.controllerRevision`,
  );
  const controllerCiRevision = expectGitSha(
    obj.controllerCiRevision,
    `${path}.controllerCiRevision`,
  );
  if (
    failedPriorProof.outcome !== "failed" ||
    failedPriorProof.execution.purpose !== "prior" ||
    failedPriorProof.execution.releaseId !== intent.releaseId ||
    failedPriorProof.execution.revision !== intent.fromRevision ||
    failedPriorProof.execution.generation !== intent.fromGeneration ||
    retainedHealthyProof.outcome !== "healthy" ||
    retainedHealthyProof.execution.revision !== intent.fromRevision ||
    retainedHealthyProof.execution.generation !== intent.fromGeneration ||
    retainedHealthyProof.finishedAt > failedPriorProof.startedAt ||
    failedPriorProof.observedAt > intent.authorizedAt ||
    controllerCiRevision !== controllerRevision ||
    originalFailedPriorProof.outcome !== "failed" ||
    originalFailedPriorProof.execution.purpose !== "prior" ||
    originalFailedPriorProof.execution.releaseId !== intent.releaseId ||
    originalFailedPriorProof.execution.revision !== intent.fromRevision ||
    originalFailedPriorProof.execution.generation !== intent.fromGeneration ||
    originalFailedPriorProof.finishedAt > failedPriorProof.finishedAt ||
    originalFailedPriorProof.jobId !== intent.originalFailedPriorJobId ||
    canonicalStringify(originalFailedPriorProof.execution) !==
      canonicalStringify(intent.originalFailedPriorExecution)
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "owner disposition cannot reclassify failed PRIOR or invent prior health",
    );
  }
  return {
    version: "v1",
    kind: "owner_supersession",
    intent,
    intentSha256: expectSha256Hex(obj.intentSha256, `${path}.intentSha256`),
    controllerRevision,
    controllerCiRevision,
    failedPriorProof,
    originalFailedPriorProof,
    retainedHealthyProof,
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
