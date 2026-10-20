import assert from "node:assert/strict";
import {
  ORIGINAL,
  originalCandidateRig,
  REJECTED,
} from "./hosted-autonomy-original-candidate-fixtures.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { check } from "../repair/ci-first-rig.ts";
import { SHA1, SHA2 } from "../state/helpers.ts";
import { SHA4 } from "../repair/loop-rig.ts";
import { readProtectedOriginalCandidates } from "../../ops/hosted-autonomy-original-candidate.ts";
import { isMatrixRecoveryPending } from "../../src/host/matrix-blocked-candidate.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";

Deno.test("original candidate: trusted maintenance restores the published candidate without retrying its forbidden correction", async () => {
  const f = await originalCandidateRig();
  try {
    const before = await f.rig.snapshot();
    const result = await f.runMaintenance();
    assert.equal(result.status, "applied", JSON.stringify(result));
    const after = await f.rig.snapshot();
    const record = after.work[0];
    assert.equal(record.nextStep, "work");
    assert.equal(record.target.head, ORIGINAL);
    assert.notEqual(record.target.head, REJECTED);
    assert.deepEqual(record.target.candidateState?.preserved, f.descriptor);
    assert.deepEqual(after.reservations, before.reservations);
    assert.deepEqual(record.counters, before.work[0].counters);
    assert.deepEqual(after.reviews, before.reviews);
    assert.equal(record.intent, null);
    assert.equal(record.wait, null);
    assert.equal(
      isMatrixRecoveryPending(record),
      false,
      "late rejected cell no longer has an importable admission intent",
    );
    assert.equal(f.rig.model.requests.length, 0);
    assert.equal(f.rig.github.pushes.length, 0);
    const again = await f.runMaintenance();
    assert.equal(again.status, "skipped", JSON.stringify(again));
    assert.deepEqual((await f.rig.snapshot()).work[0], record);
  } finally {
    await f.rig.ctx.cleanup();
  }
});

Deno.test("original candidate: unproven remote identity, policy and CI leave custody unchanged", async (t) => {
  const f = await originalCandidateRig();
  try {
    const before = await f.rig.snapshot();
    const controls = [
      ["unrelated branch head", () => {
        f.observations.liveHead = SHA2;
      }],
      ["missing exact preservation", () => {
        f.observations.preserved = SHA2;
      }],
      ["closed PR", () => {
        f.observations.prOpen = false;
      }],
      ["unreadable issue", () => {
        f.observations.issueOpen = null;
      }],
      ["red unchanged-base CI", () => {
        f.observations.originalGreen = false;
      }],
      ["unreadable unchanged-base CI", () => {
        f.observations.originalGreen = null;
      }],
      ["protected original bytes", () => {
        f.observations.paths = [".github/workflows/ci.yml"];
      }],
      ["unproven base movement", () => {
        f.observations.base = SHA2;
        f.observations.ancestry = false;
      }],
    ] as const;
    for (const [name, control] of controls) {
      await t.step(name, async () => {
        Object.assign(f.observations, {
          base: SHA1,
          originalGreen: true,
          liveHead: ORIGINAL,
          preserved: ORIGINAL,
          issueOpen: true,
          paths: ["src/app.ts"],
          ancestry: true,
          prOpen: true,
        });
        control();
        await f.runMaintenance();
        assert.deepEqual(await f.rig.snapshot(), before);
      });
    }
  } finally {
    await f.rig.ctx.cleanup();
  }
});

Deno.test("original candidate: missing or conflicting ancestry is never replaced by a PR head", async () => {
  const f = await originalCandidateRig();
  try {
    const before = await f.rig.store.readRepair();
    assert(before.ok && before.value.status === "found");
    const input = {
      snapshot: before.value.snapshot,
      expectedHead: before.value.head,
      records: [f.blocked],
      clock: f.rig.clock,
      deadlineAt: f.rig.clock.now() + 120_000,
    };
    assert.deepEqual(
      await readProtectedOriginalCandidates({ ...input, state: {} }),
      [],
    );
    assert.deepEqual(
      await readProtectedOriginalCandidates({
        ...input,
        state: {
          readRepairAt: () =>
            Promise.resolve(portError("unavailable", "offline")),
        },
      }),
      [],
    );
    assert.deepEqual(
      await readProtectedOriginalCandidates({
        ...input,
        state: { readRepairAt: () => Promise.resolve(portOk(before.value)) },
      }),
      [],
    );
    assert.deepEqual(
      await readProtectedOriginalCandidates({
        ...input,
        deadlineAt: f.rig.clock.now(),
        state: f.rig.store,
      }),
      [],
    );
    assert.deepEqual(await f.rig.snapshot(), before.value.snapshot);
  } finally {
    await f.rig.ctx.cleanup();
  }
});

Deno.test("original candidate: a state race cannot overwrite the other writer", async () => {
  const f = await originalCandidateRig();
  try {
    const actual = f.rig.store.writeRepair.bind(f.rig.store);
    let raced = false;
    f.rig.store.writeRepair = async (next, expected) => {
      if (!raced) {
        raced = true;
        const current = await f.rig.store.readRepair();
        assert(current.ok && current.value.status === "found");
        await actual({
          ...current.value.snapshot,
          stateHead: current.value.head,
          sequence: current.value.snapshot.sequence + 1,
          updatedAt: next.updatedAt,
        }, current.value.head);
      }
      return actual(next, expected);
    };
    const result = await f.runMaintenance();
    assert.equal(result.reason, "write_conflict", JSON.stringify(result));
    assert.deepEqual((await f.rig.snapshot()).work[0], f.blocked);
    assert.deepEqual((await f.rig.snapshot()).reservations, f.charges);
  } finally {
    await f.rig.ctx.cleanup();
  }
});

Deno.test("original candidate: moved-base recovery refreshes before green CI and internal review", async () => {
  const f = await originalCandidateRig(true);
  try {
    f.observations.originalGreen = false;
    assert.equal((await f.runMaintenance()).status, "applied");
    f.rig.github.readChecks = (head) =>
      Promise.resolve(
        portOk({
          head,
          checks: [
            head === SHA4
              ? check("ci", head, null, "in_progress")
              : check("ci", head, "success"),
          ],
        }),
      );
    await f.rig.run();
    assert.equal(
      f.refreshes.length,
      1,
      "the existing trusted refresh prepares the current-base candidate",
    );
    assert.equal(
      f.rig.github.calls.includes("requestReview"),
      false,
      "pending resulting CI cannot start review",
    );
    assert.equal(
      f.rig.model.requests.length,
      0,
      "bookkeeping/refresh never starts a replacement implementation",
    );
    assert(!f.rig.github.pushes.some((push) => push.sha === REJECTED));
    f.rig.github.readChecks = (head) =>
      Promise.resolve(portOk({ head, checks: [check("ci", head, "success")] }));
    f.rig.clock.advance(CHECK_POLL_MS);
    await f.rig.run();
    assert(
      f.rig.github.calls.includes("requestReview"),
      "current green head gets normal internal review",
    );
    const after = await f.rig.snapshot();
    assert.deepEqual(
      after.reservations.filter((r) => r.purpose !== "review_request"),
      f.charges,
    );
    assert.notEqual(after.work[0].target.head, REJECTED);
  } finally {
    await f.rig.ctx.cleanup();
  }
});
