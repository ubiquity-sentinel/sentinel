/**
 * Owner directive 2026-10-24: other people's pull requests never hold or
 * divert Sentinel's own repair. With existing-PR discovery off, the parks it
 * wrote earlier return to `work` in one checked transition; takeover custody
 * parks and records bound to a PR are left exactly as they are.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  reconcileExistingPrs,
  releasableExistingPrHold,
} from "../../src/repair/loop-existing-pr.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import { FakeClock, FakeGithub, MemoryState } from "./helpers.ts";
import { seededSnapshot } from "./loop-rig.ts";

const blocked = (
  id: string,
  message: string,
  extra: Record<string, unknown> = {},
): WorkRecordV1 =>
  workRecord(id, {
    nextStep: "blocked",
    blocker: { kind: "other", message, since: T0 },
    ...extra,
  });

/** The four live shapes from the 09:45 UTC repair state. */
const LIVE = [
  blocked("passport-87", "existing PR hold: foreign_repository"),
  blocked("ai-1281", "existing PR hold: ambiguous (1285,1289,1290,1294)"),
  blocked("ai-1283", "existing PR hold: ambiguous (1286,1287,1291,1293)"),
  blocked("ai-300", "existing PR hold: fork_head (1274)"),
];
const PREFLIGHT = blocked(
  "ai-preflight",
  "existing PR preflight: native queue observation unavailable",
  { wait: { reason: "backoff", until: null, since: T0 } },
);
/** Takeover custody, owner-action and PR-bound parks stay as they are. */
const KEPT = [
  blocked("kept-closed", "existing PR hold: closed_publication"),
  blocked("kept-owner", "existing PR hold: self_merge_requires_owner"),
  blocked("kept-custody", "existing PR hold: ambiguous (7,8)", {
    evidence: [{
      kind: "review_receipt",
      ref: "artifact:review-receipt/pr-takeover-v1/kept-custody",
    }],
  }),
  blocked("kept-bound", "existing PR hold: fork_head (9)", {
    target: { base: SHA1, branch: "x", checkpoint: null, head: SHA2, pr: 9 },
  }),
  blocked("kept-other", "candidate touches a protected path"),
  blocked("kept-suffix", "existing PR hold: fork_head (9) extra"),
];

function rig(work: WorkRecordV1[], activated?: boolean) {
  const clock = new FakeClock(T0 + 60_000);
  const state = new MemoryState();
  state.repair = seededSnapshot(work);
  state.repairHead = SHA1;
  const github = new FakeGithub();
  if (activated !== undefined) {
    Object.assign(github, {
      existingPrTakeover: { coordinationActivated: activated },
    });
  }
  const deps = {
    clock,
    state,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
  } as unknown as RepairCycleDepsV1;
  const context = async (): Promise<LoopContextV1> => {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    return {
      head: read.value.head,
      snapshot: read.value.snapshot,
      bounds: { runDeadline: T0 + 3_600_000, modelCutoff: T0 + 3_600_000 },
      executionBaseline: null,
    };
  };
  return { clock, state, deps, context };
}

Deno.test("existing PR hold release: the matcher takes discovery parks only", () => {
  for (const record of [...LIVE, PREFLIGHT]) {
    assert.equal(releasableExistingPrHold(record), true, record.id);
  }
  for (const record of KEPT) {
    assert.equal(releasableExistingPrHold(record), false, record.id);
  }
});

Deno.test("existing PR hold release: discovery off re-admits every live park in one write", async () => {
  const r = rig([...LIVE, PREFLIGHT, ...KEPT]);
  const before = await r.context();
  const step = await reconcileExistingPrs(r.deps, before, new Set(), new Set());
  assert.deepEqual(step, { kind: "progress" });
  assert.equal(r.state.repairWrites, 1, "one checked transition");
  const after = await r.context();
  for (const original of [...LIVE, PREFLIGHT]) {
    const row = after.snapshot.work.find((work) => work.id === original.id)!;
    assert.equal(row.nextStep, "work", original.id);
    assert.equal(row.blocker, null, original.id);
    assert.equal(row.wait, null, original.id);
    assert.equal(row.updatedAt, T0 + 60_000, original.id);
    assert.deepEqual(row.intent, original.intent, original.id);
    assert.deepEqual(row.target, original.target, original.id);
    assert.deepEqual(row.counters, original.counters, original.id);
    assert.deepEqual(row.evidence, original.evidence, original.id);
  }
  for (const original of KEPT) {
    assert.deepEqual(
      after.snapshot.work.find((work) => work.id === original.id),
      original,
      original.id,
    );
  }
  assert.deepEqual(after.snapshot.reservations, before.snapshot.reservations);

  // A second pass releases nothing and writes nothing; only the retained
  // takeover custody record still defers, as before the directive.
  const again = await reconcileExistingPrs(
    r.deps,
    after,
    new Set(),
    new Set(),
  );
  assert.deepEqual(again, {
    kind: "deferred",
    detail: "existing PR custody capability unavailable",
  });
  assert.equal(r.state.repairWrites, 1, "the second pass is a no-op");
});

Deno.test("existing PR hold release: an inactive port releases and an activated one does not", async () => {
  const inactive = rig([...LIVE], false);
  assert.deepEqual(
    await reconcileExistingPrs(
      inactive.deps,
      await inactive.context(),
      new Set(),
      new Set(),
    ),
    { kind: "progress" },
  );
  const activated = rig([LIVE[0]], true);
  const before = await activated.context();
  const released = await reconcileExistingPrs(
    activated.deps,
    before,
    new Set([LIVE[0].id]),
    new Set(),
  );
  assert.equal(released, null);
  assert.equal(activated.state.repairWrites, 0);
});
