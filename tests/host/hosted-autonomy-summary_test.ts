import assert from "node:assert/strict";
import {
  emitHostedParkSummary,
  renderHostedParkSummary,
} from "../../ops/hosted-autonomy-summary.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";

const messages = [
  "task acceptance not fulfilled and no correction can follow: owner decision required",
  "repeated identical failure; owner action required (close or edit the issue, or change the model route): 3x unavailable",
  "base refresh refused by trusted validation; owner action required: candidate touches a protected path",
  "candidate touches a protected path",
  "review round ceiling reached: the current head has no completed review",
  "CI fix attempts exhausted (3 of 3): validate",
  "candidate preservation unrecoverable",
  "new future park unknown to the summary classifier",
];

function parked(index: number, message: string) {
  return workRecord(`park-${index}`, {
    source: { kind: "issue", id: String(1000 + index), revision: SHA1 },
    related: { incidentId: null, issueNumber: 1000 + index },
    nextStep: "blocked",
    blocker: { kind: "other", message, since: T0 },
  });
}

Deno.test("park summary names every blocked task including new and unknown owner parks", () => {
  const snapshot = repairSnapshot([
    ...messages.map((message, i) => parked(i, message)),
    workRecord("active", { nextStep: "work" }),
  ]);
  const summary = renderHostedParkSummary(snapshot);
  assert.match(summary, /Blocked tasks: 8\./);
  for (let i = 0; i < messages.length; i++) {
    assert.ok(summary.includes(`#${1000 + i} |`), `park ${i} is named`);
  }
  assert.ok(!summary.includes("active"));
  assert.ok(!summary.includes(messages[7]), "raw diagnostics are not emitted");
  assert.match(summary, /task acceptance needs a decision/);
  assert.match(summary, /repeated identical implementation failures/);
  assert.match(summary, /trusted validation refused the base refresh/);
  assert.match(summary, /Legacy review-round park/);
  assert.match(summary, /Legacy CI fix-exhausted park/);
});

Deno.test("park summary fits every allowed row without a silent detail-count cap", () => {
  const rows = Array.from({ length: 2048 }, (_, i) => ({
    ...parked(i, messages[0]),
    repository: {
      owner: "o".repeat(100),
      name: "n".repeat(100),
      installationId: 1,
    },
    id: (`task-${i}-` + "x".repeat(256)).slice(0, 256),
    related: { incidentId: null, issueNumber: null },
  }));
  // Exercise the renderer's worst-case identity widths independently of the
  // stricter GitHub identity parser. Every row still appears once.
  const summary = renderHostedParkSummary(
    { ...repairSnapshot([]), work: rows } as never,
  );
  assert.equal(
    summary.split("\n").filter((line) => line.startsWith("| task-")).length,
    2048,
  );
  assert.ok(new TextEncoder().encode(summary).length < 1024 * 1024);
});

Deno.test("park summary reads final state, appends to the native summary and reports unavailable reads", async () => {
  const dir = await Deno.makeTempDir({
    dir: ".",
    prefix: ".park-summary-test-",
  });
  const path = `${dir}/summary.md`;
  const snapshot = repairSnapshot([parked(0, messages[0])]);
  try {
    await Deno.writeTextFile(path, "Existing summary\n");
    await emitHostedParkSummary({
      readRepair: () =>
        Promise.resolve(
          portOk({ status: "found", head: SHA1, snapshot, ref: null }),
        ),
    }, path);
    const rendered = await Deno.readTextFile(path);
    assert.ok(rendered.startsWith("Existing summary\n"));
    assert.ok(rendered.includes("#1000 |"));
    await emitHostedParkSummary({
      readRepair: () =>
        Promise.resolve(portError("unavailable", "private diagnostic")),
    }, path);
    const unavailable = await Deno.readTextFile(path);
    assert.match(
      unavailable,
      /State unavailable; parked tasks could not be listed/,
    );
    assert.ok(!unavailable.includes("private diagnostic"));
    await emitHostedParkSummary({
      readRepair: () => Promise.reject(new Error("unreadable")),
    }, `${dir}/missing/file`);
    await emitHostedParkSummary({
      readRepair: () => Promise.reject(new Error("must not read")),
    }, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("maintenance permits the native GitHub run summary path", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../../.github/workflows/supervisor.yml", import.meta.url),
  );
  const maintenance = workflow.slice(
    workflow.indexOf("\n  maintenance:"),
    workflow.indexOf("\n  prepare:"),
  );
  assert.match(maintenance, /--allow-env=[^\n]*\bGITHUB_STEP_SUMMARY\b/);
});
