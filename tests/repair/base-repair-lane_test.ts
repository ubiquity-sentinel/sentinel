/**
 * Base-repair lane (2026-10-24 throughput redesign, stage 1). A red target
 * base wedged every repair in it: the CI-first gate holds a head whose
 * failing checks are red on the base too (`base_red`) for a base move only a
 * merge can cause. The launcher files one P0 base-repair issue per red base
 * (`ops/hosted-autonomy-base-repair.ts`), and for that task alone a
 * `base_red` failure is its own: it takes the ordinary charged CI fix route
 * instead of the uncharged hold. Every other record keeps the hold.
 */
import assert from "node:assert/strict";
import { type GitHubIssueV1, portOk } from "../../src/contracts/ports.ts";
import {
  BASE_REPAIR_AUTHOR,
  baseRepairMarker,
  isBaseRepairBody,
} from "../../src/repair/base-repair.ts";
import { isCiFixMarker } from "../../src/repair/ci-first-policy.ts";
import { SHA1, SHA3 } from "../state/helpers.ts";
import { check, ciFirstRig, taskRecord } from "./ci-first-rig.ts";

const RED = {
  [SHA3]: [check("deno", SHA3, "failure")],
  [SHA1]: [check("deno", SHA1, "failure")],
};

function issue(overrides: Partial<GitHubIssueV1> = {}): GitHubIssueV1 {
  return {
    number: 1,
    title: "CI is failing on main",
    body: `${baseRepairMarker("main")}\n\nCI is failing on \`main\`.`,
    state: "open",
    author: BASE_REPAIR_AUTHOR,
    labels: ["P0"],
    createdAt: 0,
    updatedAt: 0,
    closedAt: null,
    ...overrides,
  };
}

async function gateOutcome(
  severity: "P0" | "P2",
  read: GitHubIssueV1 | null,
) {
  const { rig, charges } = await ciFirstRig(`base-repair-${severity}`, {
    hosted: true,
    severity,
    checks: RED,
  });
  const reads: number[] = [];
  rig.github.readIssue = (number: number) => {
    reads.push(number);
    return Promise.resolve(portOk(read));
  };
  try {
    await rig.run();
    const after = await rig.snapshot();
    return { work: taskRecord(after), reads, charges, after, rig };
  } finally {
    await rig.ctx.cleanup();
  }
}

Deno.test("base repair: the marker is the first body line only", () => {
  assert.equal(isBaseRepairBody(baseRepairMarker("main")), true);
  assert.equal(isBaseRepairBody(`${baseRepairMarker("main")}\r\nbody`), true);
  assert.equal(isBaseRepairBody(`intro\n${baseRepairMarker("main")}`), false);
});

Deno.test("base repair: the base-repair task's red base is its own failure and takes the CI fix route", async () => {
  const { work, reads } = await gateOutcome("P0", issue());
  assert.deepEqual(reads, [1]);
  assert.equal(work.nextStep, "work");
  assert.equal(work.blocker, null);
  assert.ok(isCiFixMarker(work.wait), JSON.stringify(work.wait));
});

Deno.test("base repair: every other red-base record keeps the uncharged hold", async () => {
  for (
    const [severity, read] of [
      // An ordinary task is never read.
      ["P2", issue()],
      // A P0 task whose issue is not the launcher's base-repair issue.
      ["P0", issue({ author: "someone" })],
      ["P0", issue({ body: "CI is failing on main" })],
      ["P0", issue({ state: "closed" })],
      ["P0", null],
    ] as const
  ) {
    const { work, reads, charges, after } = await gateOutcome(severity, read);
    assert.equal(reads.length, severity === "P2" ? 0 : 1);
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.equal(work.wait?.reason, "backoff", JSON.stringify(work.wait));
    assert.equal(isCiFixMarker(work.wait), false);
    assert.deepEqual(after.reservations, charges, "nothing charged");
  }
});
