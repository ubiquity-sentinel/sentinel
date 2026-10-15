import { modernRecoveryScenario } from "./hosted-autonomy-modern-scenario.ts";

Deno.test("blocked candidate recovery: exact historical producer preserves candidate without another admission", () =>
  modernRecoveryScenario(true, false, "valid"));

for (
  const control of [
    "wrong-run",
    "wrong-runtime",
    "wrong-artifact",
    "wrong-archive",
    "wrong-candidate",
    "wrong-task",
    "cas-conflict",
    "changed-record",
    "post-write-readback-drift",
    "wrong-preservation-readback",
    "unsupported-reason",
    "missing-artifact",
  ] as const
) {
  Deno.test(`blocked candidate recovery: ${control} leaves custody unchanged`, () =>
    modernRecoveryScenario(true, false, control));
}
