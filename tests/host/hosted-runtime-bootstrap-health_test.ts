/** Full launcher bootstrap metrics bind settled results and avoid work ledgers. */
import assert from "node:assert/strict";
import {
  childLine,
  exited,
  launch,
  makeRig,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

for (const scenario of ["healthy", "startup failed", "unsettled"] as const) {
  Deno.test(`bootstrap launcher: ${scenario} has duration/outcome metrics without record reads`, async () => {
    const rig = await makeRig();
    const lines: string[] = [];
    const original = console.log;
    try {
      rig.execution = { ...rig.execution, purpose: "bootstrap" };
      await seedRelease(rig);
      rig.process.child = exited(
        childLine(rig.execution, {
          startupReady: scenario !== "startup failed",
        }),
        0,
        scenario === "unsettled" ? { settled: false } : {},
      );
      let repairReads = 0;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      const result = await launch(rig, {
        state: {
          readRelease: () => rig.release.readRelease(),
          readRepair: () => {
            repairReads++;
            throw new Error("bootstrap summaries must not read work ledgers");
          },
        },
        process: {
          run: (command) => {
            if (command.args.includes("src/host/actions.ts")) {
              rig.clock.advance(1250);
            }
            return rig.process.run(command);
          },
        },
      });
      const status = scenario === "healthy"
        ? "healthy"
        : scenario === "startup failed"
        ? "failed"
        : "unavailable";
      assert.equal(result.status, status, JSON.stringify(result));
      assert.equal(rig.process.childCalls().length, 1);
      assert.equal(repairReads, 0);
      const metrics = lines.map((line) => JSON.parse(line)).filter(
        (line) => line.kind === "sentinel_pass_metrics",
      );
      assert.deepEqual(metrics, [{
        kind: "sentinel_pass_metrics",
        pass: "bootstrap",
        executionId: rig.execution.id,
        revision: rig.execution.revision,
        generation: rig.execution.generation,
        durationMs: 1250,
        outcome: status,
      }]);
    } finally {
      console.log = original;
      await rig.cleanup();
    }
  });
}
