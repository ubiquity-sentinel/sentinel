/** Hosted hosted-runtime-stream_test responsibility. */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { HostedModelDiagnosticV1 } from "../../src/host/hosted-runtime.ts";
import {
  diagnosticLine,
  launchWithSink,
  makeRig,
  OBSERVED_BASE,
  pathExists,
  pathExistsSync,
  SAFE_DIAGNOSTIC,
  seedRelease,
} from "./hosted-runtime-fixture.ts";
import {
  HOSTED_FIXTURE_ISSUE_BODY,
  HOSTED_FIXTURE_PROVIDER,
  HOSTED_FIXTURE_RAW_ERROR,
  streamingFixtureScript,
} from "./hosted-runtime-child-fixture.ts";

Deno.test("streams sanitized hosted diagnostics before runtime exit", async () => {
  const FIRST_TASK_KEY = "d".repeat(64);
  const AFTER_TASK_KEY = "e".repeat(64);
  const STDERR_TASK_KEY = "f".repeat(64);
  const OVERSIZED_TASK_KEY = "1".repeat(64);
  const firstLine = diagnosticLine({ taskKey: FIRST_TASK_KEY });
  const afterLine = diagnosticLine({ taskKey: AFTER_TASK_KEY });
  const stderrLine = diagnosticLine({ taskKey: STDERR_TASK_KEY });
  const oversizedSuffix = diagnosticLine({ taskKey: OVERSIZED_TASK_KEY });
  const invalidLine = '{"kind":"sentinel_model_diagnostic"}';
  const privateLine = diagnosticLine({
    taskKey: FIRST_TASK_KEY,
    provider: HOSTED_FIXTURE_PROVIDER,
  });
  const forgedLine = JSON.stringify({
    version: "v1",
    kind: "hosted_model_diagnostic",
    advisory: true,
    execution: null,
    diagnostic: JSON.parse(firstLine),
  });

  const rig = await makeRig({
    runtimeFiles: {
      "src/host/actions.ts": streamingFixtureScript({
        firstHalf: firstLine.slice(0, 20),
        secondHalf: firstLine.slice(20),
        ignoredLines: [invalidLine, privateLine, forgedLine],
        oversizedSuffix,
        afterLine,
        stderrLine,
      }),
      ".gitignore": ".sentinel/\n",
    },
  });
  try {
    await seedRelease(rig);
    const runtimeReal = await Deno.realPath(rig.runtimeDir);
    const releaseMarker = `${runtimeReal}/release-child.txt`;
    const finishedMarker = `${runtimeReal}/child-finished.txt`;
    const streamed: {
      diagnostic: HostedModelDiagnosticV1;
      runSettled: boolean;
      finishedMarkerPresent: boolean;
    }[] = [];
    let runSettled = false;
    rig.process.realChild = true;
    const result = await launchWithSink(rig, (diagnostic) => {
      streamed.push({
        diagnostic,
        runSettled,
        finishedMarkerPresent: pathExistsSync(finishedMarker),
      });
      if (streamed.length === 1) {
        Deno.writeTextFileSync(releaseMarker, "released\n");
      }
      if (streamed.length === 2) {
        // The advisory sink is never allowed to disturb capture or settlement.
        throw new Error("forced advisory sink failure");
      }
    });
    runSettled = true;

    // The valid line was split across pipe writes and still reached the sink
    // before the child finished and before the launcher promise settled.
    assert.equal(streamed.length, 2, JSON.stringify(streamed));
    const first = streamed[0];
    const second = streamed[1];
    assert.ok(first !== undefined && second !== undefined);
    if (first === undefined || second === undefined) {
      throw new Error("unreachable");
    }
    assert.equal(first.runSettled, false);
    assert.equal(first.finishedMarkerPresent, false);
    assert.deepEqual(Object.keys(first.diagnostic).sort(), [
      "advisory",
      "diagnostic",
      "execution",
      "kind",
      "version",
    ]);
    assert.equal(first.diagnostic.version, "v1");
    assert.equal(first.diagnostic.kind, "hosted_model_diagnostic");
    assert.equal(first.diagnostic.advisory, true);
    for (const entry of streamed) {
      assert.equal(entry.runSettled, false);
      assert.equal(
        canonicalStringify(entry.diagnostic.execution),
        canonicalStringify(rig.execution),
      );
    }
    assert.deepEqual(first.diagnostic.diagnostic, {
      ...SAFE_DIAGNOSTIC,
      taskKey: FIRST_TASK_KEY,
    });
    assert.deepEqual(second.diagnostic.diagnostic, {
      ...SAFE_DIAGNOSTIC,
      taskKey: AFTER_TASK_KEY,
    });

    // Invalid, private, forged, oversized and stderr inputs produced nothing,
    // while the valid line after the oversized one resumed streaming.
    const serialized = JSON.stringify(
      streamed.map((entry) => entry.diagnostic),
    );
    for (
      const marker of [
        HOSTED_FIXTURE_PROVIDER,
        HOSTED_FIXTURE_RAW_ERROR,
        HOSTED_FIXTURE_ISSUE_BODY,
      ]
    ) {
      assert.equal(serialized.includes(marker), false, marker);
    }
    assert.equal(
      streamed.some((entry) =>
        entry.diagnostic.diagnostic.taskKey === OVERSIZED_TASK_KEY
      ),
      false,
      "an oversized line is discarded through its newline, suffix included",
    );
    assert.equal(
      streamed.some((entry) =>
        entry.diagnostic.diagnostic.taskKey === STDERR_TASK_KEY
      ),
      false,
      "stderr is never forwarded to the sink",
    );

    // A throwing advisory sink changed nothing: the real child still settles
    // the one healthy trusted terminal, and the unchanged final capture and
    // parser see exactly the two advisory lines the stream saw.
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(result.terminal?.outcome, "healthy");
    assert.equal(result.terminal?.settled, true);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
    assert.deepEqual(
      result.diagnostics.map((entry) => entry.diagnostic.taskKey),
      [FIRST_TASK_KEY, AFTER_TASK_KEY],
    );
    assert.equal(
      await pathExists(finishedMarker),
      true,
      "the real fixture child must have executed",
    );
  } finally {
    await rig.cleanup();
  }
});
