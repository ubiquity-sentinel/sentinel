/** Private IPC preserves the transport's projected-output accounting verbatim. */
import {
  type CodexServerNotificationV1,
  isCodexOutputPathV1,
} from "../repair/codex-transport.ts";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("review custody notification unavailable");
  }
  return value as Record<string, unknown>;
}

export function parseReviewChannelNotification(
  value: unknown,
): CodexServerNotificationV1 {
  const event = object(value);
  const keys = Object.keys(event).sort().join(",");
  if (
    ![
      "method",
      "method,params",
      "method,outputVolume",
      "method,outputVolume,params",
    ].includes(keys) ||
    typeof event.method !== "string" || event.method.length === 0
  ) throw new Error("review custody notification unavailable");
  if (!Object.hasOwn(event, "outputVolume")) {
    return { method: event.method, params: event.params };
  }
  const volume = object(event.outputVolume);
  if (
    Object.keys(volume).sort().join(",") !==
      "observedParamsChars,truncatedOutputPaths" ||
    !Number.isSafeInteger(volume.observedParamsChars) ||
    (volume.observedParamsChars as number) < 0 ||
    !Array.isArray(volume.truncatedOutputPaths) ||
    !volume.truncatedOutputPaths.every(isCodexOutputPathV1) ||
    new Set(volume.truncatedOutputPaths).size !==
      volume.truncatedOutputPaths.length
  ) throw new Error("review custody output accounting unavailable");
  return {
    method: event.method,
    params: event.params,
    outputVolume: {
      observedParamsChars: volume.observedParamsChars as number,
      truncatedOutputPaths: [...volume.truncatedOutputPaths],
    },
  };
}
