/**
 * C5.2 (2026-10-25 redesign): `runRepairCycle` prints one bounded advisory
 * `sentinel_step` line per selected step, a failed print changes nothing, and
 * the launcher re-emits only strictly re-parsed lines before the terminal.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { emitHostedRuntimeCliResult } from "../../src/host/hosted-runtime.ts";
import {
  createStepLog,
  parseStepLine,
  STEP_LINE_KIND,
  STEP_LINE_OUTCOMES,
} from "../../src/repair/step-line.ts";
import { SHA1 } from "../state/helpers.ts";
import {
  childLine,
  exited,
  launch,
  makeRig,
  seedRelease,
} from "../host/hosted-runtime-fixture.ts";
import { issueRecord, makeMemoryRig, RelationsFakeGithub } from "./loop-rig.ts";

function issueRig() {
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  github.listed = [issueRecord(1), issueRecord(2)];
  for (const issue of github.listed) github.latest.set(issue.number, issue);
  return makeMemoryRig(github);
}

async function runLogged(
  log: (line: string) => void,
): Promise<{ outcome: unknown; work: unknown }> {
  const rig = issueRig();
  const original = console.log;
  console.log = (...args: unknown[]) => log(args.map(String).join(" "));
  try {
    const outcome = await rig.run();
    return { outcome, work: (await rig.snapshot()).work };
  } finally {
    console.log = original;
  }
}

Deno.test("step line: every selected step prints one closed line for its record", async () => {
  const lines: string[] = [];
  const { work } = await runLogged((line) => lines.push(line));
  const steps = lines.filter((line) => line.includes(STEP_LINE_KIND)).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  assert.ok(steps.length > 0, lines.join("\n"));
  const ids = new Set((work as { id: string }[]).map((record) => record.id));
  for (const step of steps) {
    assert.deepEqual(parseStepLine(step), step, "exact closed shape");
    assert.ok(ids.has(step.recordId as string));
    assert.equal("status" in step, false, "never a child status record");
    assert.ok(Number.isSafeInteger(step.elapsedMs));
  }
  assert.ok(steps.some((step) => step.outcome === "progress"));
});

Deno.test("step line: a print that throws leaves the cycle's outcome and state unchanged", async () => {
  const logged = await runLogged(() => {});
  const throwing = await runLogged((line) => {
    if (line.includes(STEP_LINE_KIND)) throw new Error("stdout closed");
  });
  assert.deepEqual(throwing.outcome, logged.outcome);
  assert.deepEqual(throwing.work, logged.work);
});

Deno.test("step line: one cycle prints at most its bound, and junk is never printed", () => {
  const lines: string[] = [];
  const log = createStepLog((line) => lines.push(line), 2);
  const record = {
    id: asWorkItemId("issue-ubiquity-ai.ubq.fi-1"),
    nextStep: "work",
  } as const;
  log({ ...record, id: asWorkItemId("bad id with spaces") }, "progress", 1);
  log(record, "progress", Number.NaN);
  for (let index = 0; index < 5; index++) log(record, "deferred", index);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), {
    kind: STEP_LINE_KIND,
    recordId: record.id,
    step: "work",
    outcome: "deferred",
    elapsedMs: 0,
  });
  assert.deepEqual(STEP_LINE_OUTCOMES, [
    "progress",
    "idle",
    "margin",
    "state_error",
    "deferred",
  ]);
});

Deno.test("step line: the launcher re-emits valid child step lines before the terminal", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const step = (overrides: Record<string, unknown>) =>
      JSON.stringify({
        kind: STEP_LINE_KIND,
        recordId: "issue-ubiquity-passport.ubq.fi-13",
        step: "delivery",
        outcome: "deferred",
        elapsedMs: 12,
        ...overrides,
      });
    rig.process.child = exited(
      [
        step({}),
        step({ outcome: "exploded" }),
        step({ extra: true }),
        step({ recordId: "x".repeat(300) }),
        step({ step: "review", outcome: "progress", elapsedMs: 3400 }),
        childLine(rig.execution),
      ].join("\n") + "\n",
    );
    const result = await launch(rig);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.deepEqual(result.stepLines?.map((line) => line.outcome), [
      "deferred",
      "progress",
    ]);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) =>
      lines.push(args.map(String).join(" "));
    try {
      emitHostedRuntimeCliResult(result);
    } finally {
      console.log = original;
    }
    const kinds = lines.map((line) => JSON.parse(line).kind);
    assert.deepEqual(kinds.slice(0, 2), [STEP_LINE_KIND, STEP_LINE_KIND]);
    assert.ok(
      kinds.indexOf("hosted_runtime_terminal") > 1,
      "the terminal follows the advisory step lines",
    );
  } finally {
    await rig.cleanup();
  }
});
