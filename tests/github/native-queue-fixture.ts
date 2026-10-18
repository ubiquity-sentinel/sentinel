/** Explicit no-rule/no-custody test authority for prequeue lifecycle fixtures. */
import type { NativeQueueGuardV1 } from "../../src/github/native-queue-guard.ts";
export function inactiveNativeQueueFixture(): NativeQueueGuardV1 {
  return {
    inspect: () =>
      Promise.resolve({ status: "allow", basis: "inactive_no_rule" }),
    inspectEffect: () =>
      Promise.resolve({ status: "allow", basis: "inactive_no_rule" }),
    proveDelivery: ({ record, receipt, revision }) =>
      Promise.resolve({
        status: "legacy_direct",
        revision,
        binding: {
          repository: record.repository,
          pullRequest: record.target.pr!,
          base: record.target.base!,
          head: record.target.head!,
          reviewRequestId: receipt.requestId,
          reviewReceiptId: receipt.id,
          taskDigest: receipt.taskAcceptance?.taskDigest ?? "0".repeat(64),
        },
      }),
  };
}
