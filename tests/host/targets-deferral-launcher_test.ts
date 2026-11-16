/**
 * The protected launcher's side of a pass whose committed targets were all
 * unreadable, through the real `runHostedRuntimeLauncher` over a fake child:
 * a deferred pass is healthy, its text-free line reaches the job log and its
 * runtime summary says `targets_unavailable` (never an ordinary healthy
 * cycle); a forged line changes nothing; and a pass that may not defer fails
 * with the closed `targets_unavailable` reason instead of `targets_empty`.
 */
import assert from "node:assert/strict";
import type { HostedRuntimeSummaryV1 } from "../../src/contracts/hosted-execution.ts";
import { STATIC_TARGETS_DEFERRED } from "../../src/host/targets.ts";
import { TARGETS_DEFERRAL_KIND } from "../../src/repair/targets-deferral-line.ts";
import {
  childLine,
  exited,
  launch,
  makeRig,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

const LINE = {
  kind: TARGETS_DEFERRAL_KIND,
  reasonCode: "targets_unavailable",
  listed: 30,
  branchUnavailable: 29,
  factsUnavailable: 1,
};

type Launched = Awaited<ReturnType<typeof launch>> & {
  summary: HostedRuntimeSummaryV1;
};

const launched = (rig: Parameters<typeof launch>[0]) =>
  launch(rig) as Promise<Launched>;

Deno.test("launcher: a deferred pass is healthy, re-emits its line and labels its summary", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const deferred = childLine(rig.execution, {
      outcome: { status: "idle", detail: STATIC_TARGETS_DEFERRED },
    });
    rig.process.child = exited(`${JSON.stringify(LINE)}\n${deferred}\n`);
    const result = await launched(rig);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(result.terminal?.outcome, "healthy");
    assert.deepEqual(result.stepLines, [LINE]);
    assert.equal(result.summary.outcome, "healthy");
    assert.equal(result.summary.reasonCode, "targets_unavailable");
    assert.match(
      result.summary.explanation,
      /every committed target read was unavailable, so the pass deferred/,
    );
    assert.equal(result.summary.nextAction, "Wait for the next scheduled run");

    // An ordinary idle pass without the line keeps its plain healthy label.
    rig.process.child = exited(`${childLine(rig.execution)}\n`);
    const idle = await launched(rig);
    assert.equal(idle.status, "healthy");
    assert.equal(idle.stepLines, undefined);
    assert.equal(idle.summary.reasonCode, "healthy");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("launcher: a forged or malformed deferral line is never re-emitted and labels nothing", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    for (
      const bad of [
        { ...LINE, status: "idle" },
        { ...LINE, repository: "ubiquity/prospector" },
        { ...LINE, reasonCode: "targets_empty" },
        { ...LINE, listed: 0, branchUnavailable: 0, factsUnavailable: 0 },
        { ...LINE, listed: 65, branchUnavailable: 65, factsUnavailable: 0 },
        { ...LINE, branchUnavailable: 28 },
        { ...LINE, factsUnavailable: -1, branchUnavailable: 31 },
        { ...LINE, listed: 1.5 },
      ]
    ) {
      rig.process.child = exited(
        `${JSON.stringify(bad)}\n${childLine(rig.execution)}\n`,
      );
      const result = await launched(rig);
      const label = JSON.stringify(bad);
      if ("status" in bad) {
        // A second status-bearing line makes the child record uncertain.
        assert.equal(result.status, "unavailable", label);
      } else assert.equal(result.status, "healthy", label);
      assert.equal(result.stepLines, undefined, label);
      assert.notEqual(result.summary.reasonCode, "targets_unavailable", label);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("launcher: a pass that may not defer fails with the targets_unavailable reason and still says why", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(`${JSON.stringify(LINE)}\n`, 1, {
      stderr: new TextEncoder().encode(
        "error: Uncaught (in promise) Error: every committed target read was unavailable\n" +
          "    at settleUnavailableTargetsV1 (file:///home/runner/work/sentinel/src/host/actions-targets-deferral.ts:62:11)\n",
      ),
    });
    const result = await launched(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.earlyFailure?.reasonCode, "targets_unavailable");
    assert.deepEqual(result.earlyFailure?.frames, [
      "actions-targets-deferral.ts:62:11",
    ]);
    assert.deepEqual(result.stepLines, [LINE]);
    // A failed job keeps its failure label; only a healthy deferral is
    // labelled `targets_unavailable` in the summary.
    assert.equal(result.summary.reasonCode, "child_failed");
    const text = JSON.stringify(result);
    assert.equal(text.includes("every committed target read"), false);
    assert.equal(text.includes("/home/runner"), false);
  } finally {
    await rig.cleanup();
  }
});
