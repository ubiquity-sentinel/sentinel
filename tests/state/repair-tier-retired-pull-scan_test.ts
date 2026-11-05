// The once-per-generation retired-pull cold scan on a real Git remote: a cold
// record retired because its source issue closed, whose own pull request is
// still open, is promoted by the first tier pass of a generation; the scan is
// recorded in that same commit, so the next pass reads no cold blob; and the
// hosted retired-pull pass then closes Sentinel's own pull request.
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { RETIRED_PULL_COLD_SCAN_ID } from "../../src/contracts/repair-tier-scan.ts";
import { SOURCE_ISSUE_CLOSED_RETIREMENT } from "../../src/contracts/work-record-retired-pull.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { GitStateStore } from "../../src/state/mod.ts";
import type { RepairTierPolicyV1 } from "../../src/state/mod.ts";
import { REPAIR_COLD_LAYOUT_TEXT } from "../../src/state/state-repair-tier-layout.ts";
import { runHostedRetiredPullPass } from "../../ops/hosted-autonomy-retired-pulls.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
} from "../../ops/hosted-autonomy-types.ts";
import {
  type Ctx,
  makeCtx,
  pushRawStateTree,
  rawManifestText,
  remoteHead,
} from "./git-state-fixtures.ts";
import { REPO, sha256Hex, workRecord } from "./helpers.ts";
import { CountingRunner, type GitSha, NOW } from "./repair-tier-fixtures.ts";

const REF = "refs/heads/sentinel-state/repair";
const PR = 1331;

const pending = workRecord("issue-retired", {
  nextStep: "blocked",
  blocker: {
    kind: "other",
    message: SOURCE_ISSUE_CLOSED_RETIREMENT,
    since: NOW - 10,
  },
  target: {
    base: "aafb7ee0598699bb7fb8a72ea133693ed64462da",
    branch: "sentinel/repair/issue-retired",
    checkpoint: null,
    head: "6dc35d06e757107b91eb58232bd15e5f671d79b4",
    pr: PR,
  },
});
const settledCold = workRecord("issue-done", { nextStep: "done" });

const recordText = (record: WorkRecordV1) => `${canonicalStringify(record)}\n`;

function policy(
  generation: number,
  overrides: Partial<RepairTierPolicyV1> = {},
): RepairTierPolicyV1 {
  return {
    now: NOW,
    listedRepositories: [REPO],
    openIssueWorkIds: new Set(),
    demotionBudget: 100,
    retiredPullScanGeneration: generation,
    ...overrides,
  };
}

/**
 * A ref whose cold tier already holds the pending record (demoted by a runtime
 * from before the demotion rule) and one settled record.
 */
async function seedColdTier(ctx: Ctx) {
  const pendingSha = await sha256Hex(pending.id);
  const settledSha = await sha256Hex(settledCold.id);
  await pushRawStateTree(ctx, null, REF, [
    { path: "manifest.json", text: rawManifestText(1, NOW - 50, null) },
    { path: "repair-archive/LAYOUT", text: REPAIR_COLD_LAYOUT_TEXT },
    {
      path: `repair-archive/work/${pendingSha}.json`,
      text: recordText(pending),
    },
    {
      path: `repair-archive/work/${settledSha}.json`,
      text: recordText(settledCold),
    },
  ]);
  return await remoteHead(ctx, REF);
}

Deno.test("retired pull scan: a cold pending record is promoted once per generation and then closed", async () => {
  const ctx = await makeCtx("retired-scan");
  try {
    const runner = new CountingRunner(`${ctx.tmp}/runner-home`);
    await Deno.mkdir(`${ctx.tmp}/runner-home`, { recursive: true });
    const store = new GitStateStore({
      scratchDir: `${ctx.tmp}/scratch`,
      remoteUrl: ctx.remoteUrl,
      role: "repair",
      runner,
    });
    const seeded = await seedColdTier(ctx);
    const blobOf = async (record: WorkRecordV1) => {
      const hashed = await new Deno.Command("git", {
        args: ["hash-object", "--stdin"],
        stdin: "piped",
        stdout: "piped",
      }).spawn();
      const writer = hashed.stdin.getWriter();
      await writer.write(new TextEncoder().encode(recordText(record)));
      await writer.close();
      const out = await hashed.output();
      return new TextDecoder().decode(out.stdout).trim();
    };
    const settledBlob = await blobOf(settledCold);

    // No generation: no scan, nothing moves, no cold blob is read.
    runner.reset();
    const none = await store.tierRepair({
      ...policy(1, { retiredPullScanGeneration: undefined }),
      expectedHead: seeded,
    });
    assert.ok(none.ok && none.value.status === "unchanged");
    assert.equal(runner.catFileShas.includes(settledBlob), false);

    // First pass of generation 7: the pending record returns hot, the
    // settled one stays cold, and the scan row is in the same commit.
    runner.reset();
    const first = await store.tierRepair({
      ...policy(7),
      expectedHead: seeded,
    });
    assert.ok(
      first.ok && first.value.status === "applied",
      JSON.stringify(first),
    );
    if (!first.ok || first.value.status !== "applied") throw new Error("x");
    assert.equal(first.value.promoted, 1);
    assert.equal(first.value.demoted, 0);
    assert.ok(runner.catFileShas.includes(settledBlob), "the scan read cold");
    const hot = await store.readRepair();
    assert.ok(hot.ok && hot.value.status === "found");
    if (!hot.ok || hot.value.status !== "found") throw new Error("x");
    assert.deepEqual(hot.value.snapshot.work.map((row) => row.id), [
      pending.id,
    ]);
    assert.deepEqual(
      hot.value.snapshot.tierScans?.map((row) => [row.id, row.generation]),
      [[RETIRED_PULL_COLD_SCAN_ID, 7]],
    );
    const tiered = await store.readRepairTiered();
    assert.ok(tiered.ok && tiered.value.status === "found");
    if (!tiered.ok || tiered.value.status !== "found") throw new Error("x");
    assert.deepEqual(tiered.value.view.cold.work.map((row) => row.id), [
      settledCold.id,
    ]);

    // Second pass of the same generation: no cold blob is read, nothing moves
    // and the unsettled hot record is not demoted again.
    runner.reset();
    const second = await store.tierRepair({
      ...policy(7),
      expectedHead: first.value.head,
    });
    assert.ok(second.ok && second.value.status === "unchanged");
    assert.equal(runner.catFileShas.includes(settledBlob), false);

    // The hosted retired-pull pass now closes Sentinel's own pull request.
    const calls: string[] = [];
    const surface = {
      listPullsByHeadRef: (branch: string) => {
        calls.push("list");
        return Promise.resolve([{
          number: PR,
          state: "open",
          merged: false,
          headSha: pending.target.head,
          headRef: branch,
          baseRef: "main",
          author: "ubiquity-sentinel[bot]",
        }]);
      },
      readIssueClosingCommit: () =>
        Promise.resolve({ open: false, closingCommit: null }),
      readIssueOpen: () => Promise.resolve(false),
      closePull: (number: number) => {
        calls.push(`close:${number}`);
        return Promise.resolve(true);
      },
      commentIssue: (number: number) => {
        calls.push(`comment:${number}`);
        return Promise.resolve(true);
      },
    } as unknown as HostedAutonomyGitHubV1;
    let now = NOW + 1000;
    const actions = await runHostedRetiredPullPass({
      state: store,
      clock: { now: () => now++ },
      githubFor: () => surface,
    } as unknown as HostedAutonomyDepsV1);
    assert.deepEqual(calls, ["list", `close:${PR}`, `comment:${PR}`]);
    assert.ok(actions.includes("retired-pull:recorded=1"), actions.join());
    const after = await store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    if (!after.ok || after.value.status !== "found") throw new Error("x");
    assert.equal(
      after.value.snapshot.work[0]!.retiredPullClosure?.outcome,
      "closed",
    );
    // The scan row survives the ordinary write.
    assert.equal(after.value.snapshot.tierScans?.[0]?.generation, 7);

    // A new generation scans once more: nothing pending, only its row moves.
    runner.reset();
    const next = await store.tierRepair({
      ...policy(8),
      expectedHead: after.value.head as GitSha,
    });
    assert.ok(next.ok && next.value.status === "applied", JSON.stringify(next));
    if (!next.ok || next.value.status !== "applied") throw new Error("x");
    assert.ok(runner.catFileShas.includes(settledBlob));
    const last = await store.readRepair();
    assert.ok(last.ok && last.value.status === "found");
    if (!last.ok || last.value.status !== "found") throw new Error("x");
    assert.equal(last.value.snapshot.tierScans?.[0]?.generation, 8);
  } finally {
    await ctx.cleanup();
  }
});
