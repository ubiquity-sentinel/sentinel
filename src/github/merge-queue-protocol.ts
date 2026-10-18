/** Queue-only async protocol. A transport outcome is never delivery proof. */
import type { HttpResponseV1 } from "./http.ts";
import type {
  QueueAdmission,
  QueueOperation,
  QueuePullIdentity,
  QueueRead,
} from "./merge-queue-types.ts";
import {
  decodeQueueWire,
  invalidQueueWire,
  queueObject,
  queueSha,
  queueString,
} from "./merge-queue-wire.ts";

export function isQueueRequestId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
}
export function queueMutationAllowed(pull: QueuePullIdentity): boolean {
  return pull.repository.owner === "ubiquity" &&
    pull.repository.name === "ai.ubq.fi" &&
    pull.baseRef === "development" && Number.isSafeInteger(pull.number) &&
    pull.number > 0;
}
export function queueEnqueueBody(
  pull: QueuePullIdentity,
): Record<string, unknown> {
  return { sha: pull.head, merge_action: "merge_queue", bypass_rules: false };
}
function parseOperation(
  body: unknown,
  pull: QueuePullIdentity,
  expectedId?: string,
): QueueRead<QueueOperation> {
  return decodeQueueWire(() => {
    const row = queueObject(body);
    const details = queueObject(row.details);
    queueString(details.message, 4096);
    if (row.status === "pending") {
      if (!isQueueRequestId(details.uuid)) return invalidQueueWire("malformed");
      if (expectedId !== undefined && expectedId !== details.uuid) {
        return invalidQueueWire("identity_mismatch");
      }
      if (
        details.expected_head_sha !== pull.head ||
        details.merge_action !== "merge_queue" ||
        (details.bypass_rules !== undefined &&
          details.bypass_rules !== false) ||
        (details.merge_method !== "merge" && details.merge_method !== "default")
      ) {
        return invalidQueueWire("identity_mismatch");
      }
      return { status: "pending", requestId: details.uuid };
    }
    if (row.status === "merged") queueSha(details.sha);
    if (
      row.status !== "enqueued" && row.status !== "merged" &&
      row.status !== "failed"
    ) return invalidQueueWire("malformed");
    if (expectedId === undefined) return invalidQueueWire("malformed");
    return row.status === "failed"
      ? { status: "failed", requestId: expectedId, reason: "not_mergeable" }
      : { status: row.status, requestId: expectedId };
  });
}
function body(response: HttpResponseV1): unknown {
  return JSON.parse(response.bodyText);
}
export function parseQueueAdmission(
  response: HttpResponseV1,
  pull: QueuePullIdentity,
): QueueAdmission {
  if (response.status >= 500) return { status: "ambiguous", requestId: null };
  if (response.status === 401) {
    return { status: "not_submitted", reason: "auth" };
  }
  if (response.status === 403) {
    return { status: "not_submitted", reason: "permission" };
  }
  if (response.status === 404) {
    return { status: "not_submitted", reason: "not_found" };
  }
  if (response.status === 429) {
    return { status: "not_submitted", reason: "rate_limited" };
  }
  if (response.status === 405) {
    return { status: "refused", reason: "queue_required" };
  }
  if (response.status === 422) {
    return { status: "refused", reason: "invalid_request" };
  }
  try {
    if (response.status === 202 || response.status === 409) {
      const parsed = parseOperation(body(response), pull);
      return parsed.status === "complete" && parsed.value.status === "pending"
        ? { status: "pending", requestId: parsed.value.requestId }
        : { status: "ambiguous", requestId: null };
    }
    if (response.status === 200 || response.status === 400) {
      const row = queueObject(body(response));
      queueString(queueObject(row.details).message, 4096);
      if (response.status === 400 && row.status === "failed") {
        return { status: "refused", reason: "not_mergeable" };
      }
      if (response.status === 200 && row.status === "enqueued") {
        return { status: "hint_enqueued", requestId: null };
      }
      if (response.status === 200 && row.status === "merged") {
        queueSha(queueObject(row.details).sha);
        return { status: "hint_merged", requestId: null };
      }
    }
  } catch { /* A malformed mutation response may still have applied. */ }
  return { status: "ambiguous", requestId: null };
}
export function parseQueueOperation(
  response: HttpResponseV1,
  pull: QueuePullIdentity,
  requestId: string,
): QueueRead<QueueOperation> {
  if (response.status !== 200) {
    const reason = response.status === 404
      ? "not_found"
      : response.status === 403
      ? "permission"
      : response.status === 401
      ? "auth"
      : response.status === 429
      ? "rate_limited"
      : "http";
    return { status: "unavailable", reason };
  }
  try {
    return parseOperation(body(response), pull, requestId);
  } catch {
    return { status: "invalid", reason: "malformed" };
  }
}
