/** Bounded diagnostic retention; none of these helpers settle a model turn. */
import type { CodexServerNotificationV1 } from "../repair/codex-transport.ts";
import { MAX_JOURNAL_BYTES } from "./review-journal.ts";
import { COMMENTARY_PHASES } from "./reviewer-policy.ts";
import { asRecord } from "./reviewer-support.ts";

/** Counters retain the existing safe-integer wire shape after arbitrarily much output. */
export function addObserved(current: number, count: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + count);
}

/** Read only transport-owned metadata, never a similarly named params field. */
export function observedParamsChars(event: CodexServerNotificationV1): number {
  const volume = asRecord(asRecord(event)?.outputVolume);
  const observed = volume?.observedParamsChars;
  return typeof observed === "number" && Number.isSafeInteger(observed) &&
      observed >= 0
    ? observed
    : JSON.stringify(event.params ?? {}).length;
}

export function finalTextTruncated(event: CodexServerNotificationV1): boolean {
  const volume = asRecord(asRecord(event)?.outputVolume);
  return Array.isArray(volume?.truncatedOutputPaths) &&
    (volume.truncatedOutputPaths.includes("item.text") ||
      volume.truncatedOutputPaths.includes("item.review"));
}

/**
 * Keep only policy-relevant early events. Text that is never result evidence
 * need not be replayed; exact identity/control fields are kept untouched.
 * Excess final text is explicitly marked so a valid-looking prefix cannot pass.
 */
export function retainEarlyEvent(
  event: CodexServerNotificationV1,
): CodexServerNotificationV1 | null {
  if (
    event.method !== "item/started" && event.method !== "item/completed" &&
    event.method !== "item/commandExecution/outputDelta" &&
    event.method !== "turn/completed" && event.method !== "model/rerouted"
  ) return null;
  const params = asRecord(event.params);
  if (params === null) return event;
  if (event.method === "item/commandExecution/outputDelta") {
    return { ...event, params: { ...params, delta: "" } };
  }
  const item = asRecord(params.item);
  if (item === null) return event;
  if (item.type === "reasoning") return null;
  let retained = item;
  if (
    (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") &&
    typeof item.review === "string" && item.review.length > MAX_JOURNAL_BYTES
  ) {
    return {
      ...event,
      params: { ...params, item: { ...item, review: "" } },
      outputVolume: {
        observedParamsChars: observedParamsChars(event),
        truncatedOutputPaths: ["item.review"],
      },
    };
  }
  if (item.type === "commandExecution") {
    retained = { ...item, aggregatedOutput: "" };
  } else if (item.type === "agentMessage" && typeof item.text === "string") {
    if (typeof item.phase === "string" && COMMENTARY_PHASES.has(item.phase)) {
      // Reception validates commentary identity/type/phase before discarding it.
      return null;
    } else if (item.text.length > MAX_JOURNAL_BYTES) {
      const projected = {
        ...event,
        params: { ...params, item: { ...item, text: "" } },
        outputVolume: {
          observedParamsChars: observedParamsChars(event),
          truncatedOutputPaths: ["item.text"] as const,
        },
      };
      return projected;
    }
  }
  return { ...event, params: { ...params, item: retained } };
}
