/**
 * A malformed native review's text-free shape line reaches the hosted job log
 * the way the review terminal line does: the launcher strictly re-parses it
 * from the complete settled child capture, keeps only this run's lines and
 * the CLI printer re-validates each one. It is never a child result, and the
 * child-status scan still reads exactly the one result record beside it.
 */
import assert from "node:assert/strict";
import {
  NATIVE_REVIEW_CLOSE,
  NATIVE_REVIEW_OPEN,
} from "../../src/github/native-review-result.ts";
import { emitHostedRuntimeCliResult } from "../../src/host/hosted-runtime.ts";
import type { HostedRuntimeLauncherResultV1 } from "../../src/host/hosted-runtime.ts";
import { scanChildStatusRecords } from "../../src/host/hosted-runtime-status.ts";
import { nativeReview } from "../github/native-review-shape-rig.ts";
import {
  childLine,
  exited,
  launch,
  makeRig,
  OBSERVED_BASE,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

const EVENT = '"sentinel_review_result_shape"';
const PRIVATE = "SYNTHETIC_PRIVATE_SHAPE_SENTINEL";

/** The real reviewer's line for one unrecoverable envelope of `ownerRunId`. */
async function shapeLine(ownerRunId: string): Promise<string> {
  const { outcome, printed } = await nativeReview(
    (binding) =>
      NATIVE_REVIEW_OPEN + `{"binding":${JSON.stringify(binding)},` +
      `"result":{"verdict":"clean" "summary":"${PRIVATE}","findings":[]}}` +
      NATIVE_REVIEW_CLOSE,
    ownerRunId,
  );
  assert.equal(outcome.status, "unavailable");
  const lines = printed.filter((line) => line.includes(EVENT));
  assert.equal(lines.length, 1, printed.join("\n"));
  return lines[0];
}

/** Run the production CLI printer and capture what reaches the job log. */
function emitted(
  result: HostedRuntimeLauncherResultV1,
): { logged: string[]; exit: number } {
  const logged: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  let exit = -1;
  try {
    console.log = (...args: unknown[]) =>
      logged.push(args.map(String).join(" "));
    console.error = () => {};
    exit = emitHostedRuntimeCliResult(result);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { logged, exit };
}

const shapeLines = (logged: string[]) =>
  logged.filter((line) => line.includes(EVENT));

Deno.test("hosted runtime: a malformed review's shape line reaches the job log and is never a child result", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const line = await shapeLine(rig.execution.id);
    const healthy = childLine(rig.execution);
    const stdout = `${line}\n${healthy}\n`;
    assert.deepEqual(scanChildStatusRecords(stdout), {
      kind: "one",
      value: JSON.parse(healthy),
    });
    rig.process.child = exited(stdout, 0);
    const result = await launch(rig);
    assert.equal(result.status, "healthy");
    assert.equal(result.terminal?.outcome, "healthy");
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
    const output = emitted(result);
    assert.equal(output.exit, 0);
    assert.deepEqual(shapeLines(output.logged), [line]);
    assert.equal(output.logged.join("\n").includes(PRIVATE), false);
    // Another run's line is not this run's evidence.
    const foreign = await shapeLine("other-run");
    rig.process.child = exited(`${foreign}\n${healthy}\n`, 0);
    const other = await launch(rig);
    assert.equal(other.status, "healthy");
    assert.deepEqual(shapeLines(emitted(other).logged), []);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a forged, unsettled or excess shape line is never re-emitted", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const line = await shapeLine(rig.execution.id);
    const shape = JSON.parse(line) as Record<string, unknown>;
    const healthy = childLine(rig.execution);
    const { layer: _missing, ...missing } = shape;
    for (
      const invalid of [
        { ...shape, extra: PRIVATE },
        { ...shape, stage: PRIVATE },
        { ...shape, syntax: "expected comma" },
        { ...shape, messageBytes: -1 },
        { ...shape, bodyBytes: 1.5 },
        { ...shape, jsonCandidates: 1_000_001 },
        { ...shape, recovered: "false" },
        { ...shape, requestId: "x".repeat(257) },
        { ...shape, invocationId: "https://private.invalid/value" },
        { ...shape, ownerRunId: `${shape.ownerRunId}\n::add-mask::x` },
        missing,
      ]
    ) {
      rig.process.child = exited(`${JSON.stringify(invalid)}\n${healthy}\n`, 0);
      const rejected = await launch(rig);
      assert.equal(rejected.status, "healthy");
      const logged = emitted(rejected).logged;
      assert.deepEqual(shapeLines(logged), [], JSON.stringify(invalid));
      assert.equal(logged.join("\n").includes(PRIVATE), false);
    }
    // A status-bearing forgery is still a second child record.
    rig.process.child = exited(
      `${JSON.stringify({ ...shape, status: "idle" })}\n${healthy}\n`,
      0,
    );
    const forged = await launch(rig);
    assert.equal(forged.status, "unavailable");
    assert.equal(forged.terminal, null);
    // The line alone is never a child result.
    rig.process.child = exited(`${line}\n`, 0);
    assert.equal((await launch(rig)).status, "unavailable");
    // A truncated capture supplies nothing.
    rig.process.child = {
      ...exited(`${line}\n${healthy}\n`, 0),
      truncated: true,
    };
    assert.deepEqual(shapeLines(emitted(await launch(rig)).logged), []);
    // The printed volume is capped; the rest is only counted.
    rig.process.child = exited(
      `${Array(51).fill(line).join("\n")}\n${healthy}\n`,
      0,
    );
    const capped = emitted(await launch(rig)).logged;
    assert.equal(shapeLines(capped).length, 50);
    assert.deepEqual(
      capped.filter((entry) =>
        entry.includes('"sentinel_review_result_shapes_dropped"')
      ).map((entry) => JSON.parse(entry)),
      [{
        event: "sentinel_review_result_shapes_dropped",
        printed: 50,
        dropped: 1,
      }],
    );
  } finally {
    await rig.cleanup();
  }
});
