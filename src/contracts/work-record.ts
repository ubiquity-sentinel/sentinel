import {
  asIncidentFingerprint,
  asSourceSnapshotDigest,
  asWorkItemId,
} from "./brands.ts";
import type { WorkItemId } from "./brands.ts";
import {
  parseEvidenceRefs,
  parseRepositoryIdentity,
  parseSeverity,
} from "./shared.ts";
import {
  expectArray,
  expectBoolean,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectExactKeysWithOptional,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  expectVersion,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";
import type {
  SelectionUrgencyV1,
  WorkBlockerV1,
  WorkCountersV1,
  WorkRecordV1,
  WorkWaitV1,
} from "./work-record-types.ts";
import { parseTarget } from "./work-record-target.ts";
import { parseIntent } from "./work-record-intent.ts";

/**
 * WorkRecordV1: the durable per-work-item record owned by the repair state.
 * Source identity, controller SHA and the original failing revision are
 * immutable; target/checkpoint/head/PR and the lifecycle fields move forward.
 * Waiting is a reason on a next step, never a second conflicting lifecycle.
 */

/**
 * True when a record carries V1 candidate state: either a candidateState group
 * on the target or a candidate_preservation intent. This is the ONLY parking
 * predicate old readers may use. `preserved: null` is parked work, not missing
 * state, so the descriptor value itself is deliberately never inspected.
 */
export function hasCandidateState(record: WorkRecordV1): boolean {
  return record.target.candidateState !== undefined ||
    (record.intent !== null && record.intent.kind === "candidate_preservation");
}

const KEYS = [
  "version",
  "kind",
  "repository",
  "id",
  "source",
  "related",
  "fingerprint",
  "failingRevision",
  "sourceSnapshotDigest",
  "classification",
  "urgency",
  "dependencies",
  "controller",
  "target",
  "nextStep",
  "wait",
  "blocker",
  "counters",
  "evidence",
  "intent",
  "firstSeenAt",
  "createdAt",
  "updatedAt",
] as const;
const SOURCE_KEYS = ["kind", "id", "revision"] as const;
const RELATED_KEYS = ["incidentId", "issueNumber"] as const;
const CLASSIFICATION_KEYS = ["severity", "priority"] as const;
const URGENCY_KEYS = [
  "activeProduction",
  "reproducible5xx",
  "severeSecurityOrDataLoss",
] as const;
const CONTROLLER_KEYS = ["sha"] as const;
const WAIT_KEYS = ["reason", "since", "until"] as const;
const BLOCKER_KEYS = ["kind", "message", "since"] as const;
const COUNTERS_KEYS = ["attempts", "retries", "reviewRounds"] as const;
/** Additive counter keys absent from rows written before they existed. */
const COUNTERS_OPTIONAL_KEYS = ["stalled", "timeouts"] as const;

export function parseWorkRecordV1(input: unknown): WorkRecordV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["work"], "$.kind");

  const repository = parseRepositoryIdentity(obj.repository, "$.repository");

  const id = asWorkItemId(
    expectPattern(
      obj.id,
      "$.id",
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected deterministic work item id",
      MaxText.recordId,
    ),
  );

  const sourceObj = expectRecord(obj.source, "$.source");
  expectExactKeys(sourceObj, SOURCE_KEYS, "$.source");
  const sourceKind = expectEnum(
    sourceObj.kind,
    ["issue", "incident", "review_backlog"],
    "$.source.kind",
  );
  const sourceId = expectNonEmptyString(
    sourceObj.id,
    "$.source.id",
    MaxText.recordId,
  );
  const sourceRevision = expectNonEmptyString(
    sourceObj.revision,
    "$.source.revision",
    MaxText.recordId,
  );

  const relatedObj = expectRecord(obj.related, "$.related");
  expectExactKeys(relatedObj, RELATED_KEYS, "$.related");
  const incidentId = expectNullableString(
    relatedObj.incidentId,
    "$.related.incidentId",
    MaxText.recordId,
  );
  const issueNumber = expectNullable(
    relatedObj.issueNumber,
    "$.related.issueNumber",
    expectPositiveInt,
  );

  const fingerprint = expectNullable(
    obj.fingerprint,
    "$.fingerprint",
    (v, p) => asIncidentFingerprint(expectSha256Hex(v, p)),
  );
  const failingRevision = expectNullable(
    obj.failingRevision,
    "$.failingRevision",
    expectGitSha,
  );
  const sourceSnapshotDigest = expectNullable(
    obj.sourceSnapshotDigest,
    "$.sourceSnapshotDigest",
    (v, p) => asSourceSnapshotDigest(expectSha256Hex(v, p)),
  );

  const classificationObj = expectRecord(
    obj.classification,
    "$.classification",
  );
  expectExactKeys(classificationObj, CLASSIFICATION_KEYS, "$.classification");
  const classification = {
    severity: parseSeverity(
      classificationObj.severity,
      "$.classification.severity",
    ),
    priority: expectNullable(
      classificationObj.priority,
      "$.classification.priority",
      expectPriority,
    ),
  };

  const urgencyObj = expectRecord(obj.urgency, "$.urgency");
  expectExactKeys(urgencyObj, URGENCY_KEYS, "$.urgency");
  const urgency: SelectionUrgencyV1 = {
    activeProduction: expectBoolean(
      urgencyObj.activeProduction,
      "$.urgency.activeProduction",
    ),
    reproducible5xx: expectBoolean(
      urgencyObj.reproducible5xx,
      "$.urgency.reproducible5xx",
    ),
    severeSecurityOrDataLoss: expectBoolean(
      urgencyObj.severeSecurityOrDataLoss,
      "$.urgency.severeSecurityOrDataLoss",
    ),
  };

  const dependencies = parseDependencies(obj.dependencies, "$.dependencies");

  const controllerObj = expectRecord(obj.controller, "$.controller");
  expectExactKeys(controllerObj, CONTROLLER_KEYS, "$.controller");
  const controller = {
    sha: expectGitSha(controllerObj.sha, "$.controller.sha"),
  };

  const target = parseTarget(obj.target, "$.target");

  const nextStep = expectEnum(
    obj.nextStep,
    ["work", "review", "delivery", "blocked", "done"],
    "$.nextStep",
  );

  const wait = expectNullable(obj.wait, "$.wait", parseWait);
  const blocker = expectNullable(obj.blocker, "$.blocker", parseBlocker);
  const counters = parseCounters(obj.counters, "$.counters");
  const evidence = parseEvidenceRefs(obj.evidence, "$.evidence");
  const intent = expectNullable(obj.intent, "$.intent", parseIntent);
  for (const proof of [intent?.selfMerge, target.selfMerge]) {
    if (
      proof !== undefined &&
      (repository.owner !== "ubiquity-sentinel" ||
        repository.name !== "sentinel" ||
        repository.installationId !== 0 || proof.taskId !== id ||
        proof.issueNumber !== issueNumber)
    ) {
      fail(
        "$.intent",
        "invalid_lifecycle",
        "self merge durable owner binding mismatch",
      );
    }
  }

  if (intent?.kind === "already_satisfied_closure") {
    if (
      sourceKind !== "issue" ||
      (nextStep !== "delivery" && nextStep !== "blocked") ||
      intent.expectedHead !== target.head ||
      intent.observedBase !== target.base ||
      intent.pr !== target.pr || intent.branch !== target.branch
    ) {
      fail(
        "$.intent",
        "invalid_lifecycle",
        "already-satisfied closure must bind its issue delivery target",
      );
    }
  }

  const firstSeenAt = expectNullable(
    obj.firstSeenAt,
    "$.firstSeenAt",
    expectTimestamp,
  );
  const createdAt = expectTimestamp(obj.createdAt, "$.createdAt");
  const updatedAt = expectTimestamp(obj.updatedAt, "$.updatedAt");

  // Fail-closed lifecycle checks.
  if (createdAt > updatedAt) {
    fail(
      "$.createdAt",
      "invalid_lifecycle",
      "createdAt cannot be after updatedAt",
    );
  }
  if (firstSeenAt !== null && firstSeenAt > updatedAt) {
    fail(
      "$.firstSeenAt",
      "invalid_lifecycle",
      "firstSeenAt cannot be after updatedAt",
    );
  }
  if (counters.retries > counters.attempts) {
    fail(
      "$.counters.retries",
      "invalid_lifecycle",
      "retries cannot exceed attempts",
    );
  }
  if (nextStep === "blocked" && blocker === null) {
    fail(
      "$.blocker",
      "invalid_lifecycle",
      'nextStep "blocked" requires a blocker',
    );
  }
  if (nextStep !== "blocked" && blocker !== null) {
    fail(
      "$.blocker",
      "invalid_lifecycle",
      'blocker present only while nextStep is "blocked"',
    );
  }
  if (nextStep === "done") {
    if (intent !== null) {
      fail(
        "$.intent",
        "invalid_lifecycle",
        'nextStep "done" cannot have an open operation intent',
      );
    }
    if (wait !== null) {
      fail("$.wait", "invalid_lifecycle", 'nextStep "done" cannot be waiting');
    }
  }
  if (target.pr !== null && target.head === null) {
    fail(
      "$.target.pr",
      "invalid_lifecycle",
      "a published PR requires a target head",
    );
  }
  if (sourceKind === "incident" && fingerprint === null) {
    fail(
      "$.fingerprint",
      "invalid_lifecycle",
      "incident tasks require a fingerprint",
    );
  }
  if (sourceKind === "issue" && issueNumber === null) {
    fail(
      "$.related.issueNumber",
      "invalid_lifecycle",
      "issue tasks require an issue number",
    );
  }
  // A candidate-preservation intent is only coherent while the record is
  // parked with no preserved descriptor yet, and its expected head/observed
  // base bind exactly to the target it was persisted for. The intent branch is
  // the preservation ref, never target.branch, so it is not compared here.
  if (intent !== null && intent.kind === "candidate_preservation") {
    const candidateState = target.candidateState;
    if (candidateState === undefined) {
      fail(
        "$.target.candidateState",
        "invalid_lifecycle",
        "candidate_preservation requires candidateState",
      );
    }
    if (candidateState.preserved !== null) {
      fail(
        "$.target.candidateState.preserved",
        "invalid_lifecycle",
        "candidate_preservation requires preserved:null",
      );
    }
    if (intent.expectedHead !== target.head) {
      fail(
        "$.intent.expectedHead",
        "invalid_lifecycle",
        "candidate_preservation expectedHead must equal target.head",
      );
    }
    if (intent.observedBase !== target.base) {
      fail(
        "$.intent.observedBase",
        "invalid_lifecycle",
        "candidate_preservation observedBase must equal target.base",
      );
    }
  }

  return {
    version: "v1",
    kind: "work",
    repository,
    id,
    source: { kind: sourceKind, id: sourceId, revision: sourceRevision },
    related: { incidentId, issueNumber },
    fingerprint,
    failingRevision,
    sourceSnapshotDigest,
    classification,
    urgency,
    dependencies,
    controller,
    target,
    nextStep,
    wait,
    blocker,
    counters,
    evidence,
    intent,
    firstSeenAt,
    createdAt,
    updatedAt,
  };
}

/** Issue priority labels are ordered numbers; missing priority is explicit null. */
function expectPriority(value: unknown, path: string): number {
  return expectPositiveInt(value, path);
}

function parseWait(input: unknown, path: string): WorkWaitV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, WAIT_KEYS, path);
  const reason = expectEnum(
    obj.reason,
    [
      "budget_cap",
      "review_pending",
      "review_quota",
      "ci_pending",
      "backoff",
      "unavailable",
      "manual",
    ],
    `${path}.reason`,
  );
  const since = expectTimestamp(obj.since, `${path}.since`);
  const until = expectNullable(obj.until, `${path}.until`, expectTimestamp);
  if (until !== null && until < since) {
    fail(
      `${path}.until`,
      "invalid_lifecycle",
      "wait until cannot precede since",
    );
  }
  return { reason, since, until };
}

function parseBlocker(input: unknown, path: string): WorkBlockerV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, BLOCKER_KEYS, path);
  return {
    kind: expectEnum(
      obj.kind,
      [
        "stale_source",
        "missing_evidence",
        "evidence_expired",
        "dependency",
        "review_quota",
        "unavailable",
        "other",
      ],
      `${path}.kind`,
    ),
    message: expectNonEmptyString(
      obj.message,
      `${path}.message`,
      MaxText.message,
    ),
    since: expectTimestamp(obj.since, `${path}.since`),
  };
}

function parseCounters(input: unknown, path: string): WorkCountersV1 {
  const obj = expectRecord(input, path);
  expectExactKeysWithOptional(obj, COUNTERS_KEYS, COUNTERS_OPTIONAL_KEYS, path);
  return {
    attempts: expectCount(obj.attempts, `${path}.attempts`),
    retries: expectCount(obj.retries, `${path}.retries`),
    reviewRounds: expectCount(obj.reviewRounds, `${path}.reviewRounds`),
    ...(obj.stalled === undefined
      ? {}
      : { stalled: expectCount(obj.stalled, `${path}.stalled`) }),
    ...(obj.timeouts === undefined
      ? {}
      : { timeouts: expectCount(obj.timeouts, `${path}.timeouts`) }),
  };
}

function parseDependencies(input: unknown, path: string): WorkItemId[] {
  return expectArray(
    input,
    path,
    MaxItems.dependencies,
    (item, itemPath) =>
      asWorkItemId(
        expectPattern(
          item,
          itemPath,
          /^[A-Za-z0-9._:-]{1,256}$/,
          "invalid_pattern",
          "expected deterministic work item id",
          MaxText.recordId,
        ),
      ),
  );
}

export type {
  BlockerKindV1,
  CandidatePreservationV1,
  CandidateStateV1,
  IncompleteOperationV1,
  IncompleteOpKindV1,
  NextStepV1,
  OperationFailureV1,
  SelectionUrgencyV1,
  TaskSourceKindV1,
  WorkBlockerV1,
  WorkCountersV1,
  WorkRecordV1,
  WorkTargetV1,
  WorkWaitReasonV1,
  WorkWaitV1,
} from "./work-record-types.ts";
