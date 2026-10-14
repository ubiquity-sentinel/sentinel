/** Decode the private trusted publisher descriptor separately from matrix selection. */
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { ReviewOwnerChannelDescriptorV1 } from "./review-owner-channel.ts";

export function reviewOwnerChildInput(
  text: string | undefined,
  execution: HostedExecutionIntentV1,
): {
  matrix: string | undefined;
  reviewCustody?: ReviewOwnerChannelDescriptorV1;
} {
  if (text === undefined) return { matrix: undefined };
  const value = JSON.parse(text) as Record<string, unknown>;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("trusted review owner input invalid");
  }
  if (!Object.hasOwn(value, "reviewCustody")) return { matrix: text };
  const descriptor = value.reviewCustody as Record<string, unknown>;
  if (
    descriptor === null || typeof descriptor !== "object" ||
    Object.keys(descriptor).sort().join(",") !==
      "directory,ownerRunId,version" ||
    descriptor.version !== "v1" || descriptor.ownerRunId !== execution.id ||
    typeof descriptor.directory !== "string" ||
    !descriptor.directory.startsWith("/") ||
    !/\/review-custody-[A-Za-z0-9_-]+$/.test(descriptor.directory)
  ) throw new Error("trusted review owner descriptor invalid");
  const { reviewCustody: _privateDescriptor, ...matrix } = value;
  if (
    Object.keys(matrix).some((key) => key !== "planDigest" && key !== "cellId")
  ) throw new Error("trusted review owner matrix input invalid");
  return {
    matrix: Object.keys(matrix).length === 0
      ? undefined
      : JSON.stringify(matrix),
    reviewCustody: descriptor as unknown as ReviewOwnerChannelDescriptorV1,
  };
}
