/**
 * Bootstrap metrics on the launcher's advisory summary (issue #336): a
 * bootstrap execution's `hosted_runtime_summary` carries the launcher-observed
 * child duration and the bootstrap outcome; an ordinary summary is unchanged.
 */
import assert from "node:assert/strict";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { HostedRuntimeSummaryV1 } from "../../src/contracts/hosted-execution.ts";
import type { HostedRuntimeLauncherResultV1 } from "../../src/host/hosted-runtime-identity.ts";
import { MemoryState } from "../repair/helpers.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import {
  childLine,
  exited,
  launch,
  makeRig,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

const CHILD_MS = 42_000;

async function bootstrapLaunch(
  purpose: "bootstrap" | "ordinary",
  child: (execution: unknown) => string,
  exitCode = 0,
): Promise<
  HostedRuntimeLauncherResultV1 & { summary: HostedRuntimeSummaryV1 }
> {
  const rig = await makeRig();
  try {
    rig.execution = parseHostedExecutionIntentV1({
      ...rig.execution,
      purpose,
    });
    await seedRelease(rig);
    const state = new MemoryState();
    assert.ok((await state.writeRepair(seededSnapshot([]), null)).ok);
    const originalRun = rig.process.run.bind(rig.process);
    rig.process.run = (input) => {
      if (input.args.includes("src/host/actions.ts")) {
        rig.clock.advance(CHILD_MS);
        return Promise.resolve(exited(child(rig.execution), exitCode));
      }
      return originalRun(input);
    };
    // The production launcher always attaches its advisory summary.
    return await launch(rig, {
      state: {
        readRepair: () => state.readRepair(),
        readRelease: () => rig.release.readRelease(),
      },
    }) as HostedRuntimeLauncherResultV1 & { summary: HostedRuntimeSummaryV1 };
  } finally {
    await rig.cleanup();
  }
}

Deno.test("hosted runtime summary: bootstrap carries bootstrapDurationMs and bootstrapOutcome", async () => {
  const result = await bootstrapLaunch(
    "bootstrap",
    (execution) => childLine(execution as never),
  );
  assert.equal(result.status, "healthy", result.detail);
  assert.equal(result.summary.purpose, "bootstrap");
  assert.equal(result.summary.bootstrapDurationMs, CHILD_MS);
  assert.equal(result.summary.bootstrapOutcome, "healthy");
});

Deno.test("hosted runtime summary: a failed bootstrap child reports its failed outcome", async () => {
  const result = await bootstrapLaunch(
    "bootstrap",
    (execution) =>
      childLine(execution as never, {
        outcome: { status: "state_error", detail: "bootstrap health: x" },
      }),
    1,
  );
  assert.equal(result.status, "failed", result.detail);
  assert.equal(result.summary.bootstrapDurationMs, CHILD_MS);
  assert.equal(result.summary.bootstrapOutcome, "failed");
});

Deno.test("hosted runtime summary: an ordinary summary has no bootstrap fields", async () => {
  const result = await bootstrapLaunch(
    "ordinary",
    (execution) => childLine(execution as never),
  );
  assert.equal(result.summary.purpose, "ordinary");
  assert.equal("bootstrapDurationMs" in result.summary, false);
  assert.equal("bootstrapOutcome" in result.summary, false);
});
