/** Shared asynchronous principal check. No production principal is minted here. */
import type {
  ExistingPrTakeoverPort,
  TakeoverEffectAuthorization,
  TakeoverEffectBoundary,
  TakeoverPrincipalAuthority,
  TakeoverPrincipalBinding,
  TakeoverProofRequest,
} from "../contracts/existing-pr-takeover.ts";
import {
  portError,
  portOk,
  type PortResultV1,
  type StateReadView,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { hasTakeoverCustody } from "./existing-pr-takeover-provenance.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { candidateBranch, candidatePreservationRef } from "../repair/keys.ts";

export async function revalidateTakeoverPrincipal(
  principal: TakeoverPrincipalAuthority | undefined,
  binding: TakeoverPrincipalBinding,
): Promise<PortResultV1<void>> {
  try {
    if (principal !== undefined) {
      return await principal.revalidate(structuredClone(binding));
    }
  } catch { /* An unavailable issuer never becomes an ordinary actor grant. */ }
  return portError("unavailable", "existing PR App principal unavailable");
}

export function takeoverPrincipalBinding(
  request: TakeoverProofRequest,
): TakeoverPrincipalBinding | null {
  const { record } = request;
  if (record.target.pr === null || record.target.branch === null) return null;
  return {
    repository: record.repository,
    taskId: record.id,
    expectedStateHead: request.expectedStateHead,
    pullRequest: record.target.pr,
    branch: record.target.branch,
    head: request.expectedHead,
    base: request.observedBase ?? record.target.base,
    operation: request.operation,
    phase: request.operation === "refresh"
      ? request.phase ?? "prepare"
      : request.operation === "preserve_successor"
      ? "preserve"
      : request.operation === "publish"
      ? "publish"
      : "current",
    nextHead: request.nextHead ?? null,
    deadline: request.deadline,
  };
}

const same = (left: unknown, right: unknown) =>
  canonicalStringify(left) === canonicalStringify(right);
const unavailable = () =>
  portError("unavailable", "existing PR effect authorization unavailable");

function boundaryRecord(
  boundary: TakeoverEffectBoundary,
  record: WorkRecordV1,
): boolean {
  switch (boundary.kind) {
    case "review":
      return record.target.pr === boundary.request.prNumber;
    case "merge":
      return record.target.pr === boundary.request.pullRequestNumber;
    case "refresh":
      return record.target.pr === boundary.request.pullRequestNumber;
    case "preserve":
      return record.id === boundary.request.taskId;
    case "create":
      return record.target.branch === boundary.request.headRef ||
        hasTakeoverCustody(record) &&
          candidateBranch(record.id) === boundary.request.headRef;
    case "push": {
      const branch = boundary.ref.replace(/^refs\/heads\//, "");
      return record.target.branch === branch ||
        record.intent?.branch === boundary.ref ||
        record.intent?.branch === branch ||
        hasTakeoverCustody(record) && candidateBranch(record.id) === branch ||
        record.target.candidateState?.preserved?.ref === boundary.ref;
    }
  }
}

function boundaryMatches(
  boundary: TakeoverEffectBoundary,
  request: TakeoverProofRequest,
): boolean {
  const { record } = request;
  const intent = record.intent;
  if (
    !boundaryRecord(boundary, record) &&
    !(boundary.kind === "push" && boundary.ref === request.candidate?.ref)
  ) return false;
  switch (boundary.kind) {
    case "review":
      return request.operation === "review" &&
        boundary.request.expectedHead === request.expectedHead &&
        boundary.request.expectedBase === record.target.base &&
        typeof request.taskDigest === "string" &&
        boundary.request.task?.digest === request.taskDigest &&
        boundary.request.task.issueNumber === record.related.issueNumber &&
        intent?.kind === "review_request" &&
        intent.key === boundary.request.operationKey &&
        intent.pr === record.target.pr &&
        intent.branch === record.target.branch &&
        intent.expectedHead === request.expectedHead &&
        intent.observedBase === record.target.base &&
        request.snapshot.reservations.filter((row) =>
            row.id === intent.requestId && row.taskId === record.id &&
            same(row.repository, record.repository) &&
            row.purpose === "review_request" && row.outcome === "reserved" &&
            row.head === request.expectedHead
          ).length === 1;
    case "merge":
      return request.operation === "merge" &&
        boundary.request.expectedHead === request.expectedHead &&
        boundary.request.expectedBase === record.target.base &&
        intent?.kind === "merge" &&
        intent.key === `merge:${record.target.pr}:${request.expectedHead}` &&
        intent.expectedHead === request.expectedHead &&
        intent.observedBase === record.target.base &&
        intent.pr === record.target.pr &&
        intent.branch === record.target.branch &&
        intent.requestId === boundary.request.review.requestId &&
        intent.resultId === boundary.request.review.resultId;
    case "refresh":
      return request.operation === "refresh" &&
        intent?.kind === "base_refresh" &&
        (request.phase === undefined || request.phase === "prepare") &&
        boundary.request.expectedHead === record.target.head &&
        boundary.request.expectedBase === request.observedBase &&
        boundary.request.previousBase === record.target.base &&
        boundary.request.preparedHead === request.nextHead &&
        boundary.request.branch === record.target.branch;
    case "preserve":
      return (request.operation === "preserve_successor" ||
        request.operation === "refresh" && request.phase === "preserve") &&
        same(boundary.request.candidate, request.candidate) &&
        boundary.request.publishedHead ===
          record.target.candidateState?.publishedHead;
    case "push": {
      if (
        request.operation === "preserve_successor" ||
        request.operation === "refresh" && request.phase === "preserve"
      ) {
        return request.candidate !== undefined &&
          boundary.ref === request.candidate.ref &&
          boundary.head === request.candidate.head &&
          boundary.expectedRef === null;
      }
      return (request.operation === "publish" && intent?.kind === "push" &&
          intent.key === `push:${request.nextHead}` &&
          intent.expectedHead === request.nextHead ||
        request.operation === "refresh" && request.phase === "publish" &&
          intent?.kind === "base_refresh" &&
          intent.resultId === request.nextHead) &&
        boundary.ref === `refs/heads/${record.target.branch}` &&
        boundary.head === request.nextHead &&
        boundary.expectedRef === record.target.candidateState?.publishedHead;
    }
    case "create":
      return false; // Existing custody never creates a replacement PR.
  }
}

/** Same-factory state/proof gate. A caller-shaped authorization is never accepted. */
export function createTakeoverBoundaryGuard(input: {
  repository: RepositoryIdentityV1;
  state: Pick<StateReadView, "readRepair">;
  activated(): boolean;
  now(): number;
  port: Pick<ExistingPrTakeoverPort, "discover" | "authorizeEffect">;
  nativePush(
    boundary: TakeoverEffectBoundary,
    authorization: TakeoverEffectAuthorization,
  ): Promise<PortResultV1<void>>;
}): ExistingPrTakeoverPort["authorizeBoundary"] {
  return async (boundary, authorization) => {
    try {
      const current = await input.state.readRepair();
      if (!current.ok) return unavailable();
      if (current.value.status !== "found") {
        return current.value.status === "absent" &&
            authorization === undefined && !input.activated()
          ? portOk(undefined)
          : unavailable();
      }
      const matching: WorkRecordV1[] = [];
      for (const record of current.value.snapshot.work) {
        if (!same(record.repository, input.repository)) continue;
        if (
          boundaryRecord(boundary, record) || boundary.kind === "push" &&
            hasTakeoverCustody(record) && record.intent !== null &&
            boundary.ref ===
              await candidatePreservationRef(
                record.repository,
                record.id,
                record.intent.key,
              )
        ) matching.push(record);
      }
      if (matching.length > 1) return unavailable();
      const record = matching[0];
      if (authorization?.kind === "native_preservation") {
        return record !== undefined && hasTakeoverCustody(record)
          ? await input.nativePush(boundary, authorization)
          : unavailable();
      }
      if (record === undefined || !hasTakeoverCustody(record)) {
        if (authorization !== undefined) return unavailable();
        if (boundary.kind !== "create" || !input.activated()) {
          return portOk(undefined);
        }
        if (record === undefined || record.source.kind !== "issue") {
          return unavailable();
        }
        const observed = await input.port.discover({
          record,
          deadline: input.now() + 30_000,
        });
        const after = await input.state.readRepair();
        return observed.status === "none" && after.ok &&
            after.value.status === "found" &&
            after.value.head === current.value.head &&
            same(after.value.snapshot, current.value.snapshot)
          ? portOk(undefined)
          : unavailable();
      }
      if (
        authorization === undefined || !input.activated() ||
        !same(record, authorization.request.record) ||
        !same(current.value.snapshot, authorization.request.snapshot) ||
        current.value.head !== authorization.request.expectedStateHead ||
        !boundaryMatches(boundary, authorization.request)
      ) return unavailable();
      return await input.port.authorizeEffect(
        authorization.proof,
        authorization.request,
      );
    } catch {
      return unavailable();
    }
  };
}
