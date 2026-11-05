// Exercise the trusted maintenance consumer, not just the tier planner: a
// repository must remain discoverable after its last work record goes cold.
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { StateManifestV1 } from "../../src/state/state-records.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { runRepairTierMaintenance } from "../../src/host/repair-tier-maintenance.ts";
import { workItemIdForIssue } from "../../src/repair/keys.ts";
import { GitStateStore } from "../../src/state/mod.ts";
import {
  appliedHead,
  gitRunAt,
  makeCtx,
  remoteHead,
  repairSnapshot,
} from "./git-state-fixtures.ts";
import {
  releaseRequest,
  REPO,
  reservation,
  SHA1,
  SHA2,
  workRecord,
} from "./helpers.ts";
import { CountingRunner, NOW } from "./repair-tier-fixtures.ts";

Deno.test("repair tier maintenance: reopen in a wholly cold repository with release disabled", async () => {
  const ctx = await makeCtx("tier-maintenance");
  try {
    const home = `${ctx.tmp}/runner-home`;
    await Deno.mkdir(home);
    const runner = new CountingRunner(home);
    const store = new GitStateStore({
      scratchDir: `${ctx.tmp}/scratch`,
      remoteUrl: ctx.remoteUrl,
      role: "repair",
      runner,
    });
    const id = workItemIdForIssue(REPO, 324);
    const snapshot = repairSnapshot({
      work: [workRecord(id, {
        source: { kind: "issue", id: "324", revision: "a".repeat(40) },
        related: { incidentId: null, issueNumber: 324 },
        nextStep: "blocked",
        blocker: { kind: "other", message: "issue closed", since: NOW },
      })],
    });
    appliedHead(await store.writeRepair(snapshot, null));
    let open: number[] = [];
    const deps = {
      store,
      listOpenIssueNumbers: () => Promise.resolve(portOk(open)),
      releasePath: () => Promise.resolve(portOk("disabled" as const)),
      clock: { now: () => NOW },
      deadlineAt: NOW + 60_000,
      demotionBudget: 1200,
    };
    const demoted = await runRepairTierMaintenance(deps);
    assert.equal(demoted.status, "applied");
    assert.equal(demoted.demoted, 1);
    const cold = await store.readRepair();
    assert.ok(cold.ok && cold.value.status === "found");
    if (!cold.ok || cold.value.status !== "found") return;
    assert.equal(cold.value.snapshot.work.length, 0);
    // Ordinary hot writes preserve the trusted directory, even when callers
    // only have the hot snapshot. No archive walk is needed afterwards.
    appliedHead(
      await store.writeRepair({
        ...cold.value.snapshot,
        stateHead: cold.value.head,
        sequence: cold.value.snapshot.sequence + 1,
        updatedAt: NOW + 1,
      }, cold.value.head),
    );
    const coldBlob = await gitRunAt(ctx, [
      "--git-dir",
      ctx.bare,
      "ls-tree",
      "-r",
      cold.value.head,
      "--",
      "repair-archive/work",
    ]);
    assert.ok(coldBlob.ok);
    const coldSha = coldBlob.stdout.trim().split(/\s+/)[2];
    for (const release of ["disabled", "enabled"] as const) {
      runner.reset();
      const unchanged = await runRepairTierMaintenance({
        ...deps,
        releasePath: () => Promise.resolve(portOk(release)),
      });
      assert.equal(unchanged.status, "unchanged");
      assert.ok(
        !runner.listedPaths.some((path) => path.startsWith("repair-archive/")),
      );
      assert.ok(!runner.catFileShas.includes(coldSha));
    }
    open = [324];
    const promoted = await runRepairTierMaintenance(deps);
    assert.equal(promoted.status, "applied");
    assert.equal(promoted.promoted, 1);
    const hot = await store.readRepair();
    assert.ok(hot.ok && hot.value.status === "found");
    if (hot.ok && hot.value.status === "found") {
      assert.deepEqual(hot.value.snapshot.work, snapshot.work);
    }
  } finally {
    await ctx.cleanup();
  }
});

// Simulate an existing pre-directory writer and a malformed candidate without
// changing the records or bypassing the production expected-head write path.
class ManifestRunner extends CountingRunner {
  mode: "legacy" | "corrupt" | null = null;
  override runGit(
    args: string[],
    opts: Parameters<CountingRunner["runGit"]>[1],
  ): ReturnType<CountingRunner["runGit"]> {
    if (
      this.mode !== null && args[0] === "hash-object" &&
      opts.stdin !== undefined
    ) {
      const text = new TextDecoder().decode(opts.stdin);
      if (text.startsWith("{")) {
        const manifest: StateManifestV1 = JSON.parse(text);
        if (manifest.kind === "repair_state_manifest") {
          if (this.mode === "legacy") delete manifest.repairTier;
          else if (manifest.repairTier !== undefined) {
            manifest.repairTier.workIds = [];
          }
          opts = {
            ...opts,
            stdin: new TextEncoder().encode(
              `${canonicalStringify(manifest)}\n`,
            ),
          };
        }
      }
    }
    return super.runGit(args, opts);
  }
}

Deno.test("repair tier directory: invalid candidates cannot push; legacy refs migrate once without rewriting records", async () => {
  const ctx = await makeCtx("tier-directory-migration");
  try {
    const home = `${ctx.tmp}/runner-home`;
    await Deno.mkdir(home);
    const runner = new ManifestRunner(home);
    const store = new GitStateStore({
      scratchDir: `${ctx.tmp}/scratch`,
      remoteUrl: ctx.remoteUrl,
      role: "repair",
      runner,
    });
    const id = workItemIdForIssue(REPO, 324);
    const fixture = repairSnapshot({
      work: [workRecord(id, {
        source: { kind: "issue", id: "324", revision: "a".repeat(40) },
        related: { incidentId: null, issueNumber: 324 },
        nextStep: "done",
      })],
    });
    const head = appliedHead(await store.writeRepair(fixture, null));
    const deps = {
      store,
      listOpenIssueNumbers: () => Promise.resolve(portOk([])),
      clock: { now: () => NOW },
      deadlineAt: NOW + 60_000,
      demotionBudget: 1200,
    };
    runner.mode = "corrupt";
    const invalid = await runRepairTierMaintenance(deps);
    assert.equal(invalid.status, "deferred");
    assert.equal(invalid.reason, "invalid");
    assert.equal(
      await remoteHead(ctx, "refs/heads/sentinel-state/repair"),
      head,
    );

    runner.mode = "legacy";
    const demoted = await runRepairTierMaintenance(deps);
    assert.equal(demoted.status, "applied");
    assert.equal(demoted.demoted, 1);
    runner.mode = null;
    const migrated = await runRepairTierMaintenance(deps);
    assert.equal(migrated.status, "applied");
    assert.equal(migrated.demoted, 0);
    assert.equal(migrated.promoted, 0);
    const stale = await store.tierRepair({
      expectedHead: demoted.appliedHead!,
      now: NOW,
      listedRepositories: [REPO],
      openIssueWorkIds: new Set(),
      demotionBudget: 1200,
    });
    assert.ok(stale.ok && stale.value.status === "conflict");
    const ledger = await store.readRepairTiered();
    assert.ok(ledger.ok && ledger.value.status === "found");
    if (ledger.ok && ledger.value.status === "found") {
      assert.deepEqual(ledger.value.view.cold.work, fixture.work);
    }
    runner.reset();
    assert.equal((await runRepairTierMaintenance(deps)).status, "unchanged");
    assert.ok(
      !runner.listedPaths.some((path) => path.startsWith("repair-archive/")),
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("repair tier maintenance: a release re-enabled in a wholly cold repository promotes the exact family", async () => {
  const ctx = await makeCtx("tier-release-directory");
  try {
    const home = `${ctx.tmp}/runner-home`;
    await Deno.mkdir(home);
    const runner = new CountingRunner(home);
    const store = new GitStateStore({
      scratchDir: `${ctx.tmp}/scratch`,
      remoteUrl: ctx.remoteUrl,
      role: "repair",
      runner,
    });
    const id = workItemIdForIssue(REPO, 325);
    const charge = reservation("tier-release-reservation", {
      taskId: id,
      outcome: "submitted",
      createdAt: NOW - 11 * 86_400_000,
      settledAt: NOW - 10 * 86_400_000,
    });
    const request = releaseRequest("tier-release-request", {
      revision: SHA2,
      source: {
        pullRequest: 9,
        reviewRequestId: charge.id,
        reviewReceiptId: null,
        head: SHA2,
        base: SHA1,
      },
    });
    const fixture = repairSnapshot({
      work: [
        workRecord(id, {
          nextStep: "done",
          target: {
            base: SHA1,
            branch: null,
            checkpoint: null,
            head: SHA2,
            pr: 9,
          },
        }),
      ],
      reservations: [charge],
      releaseRequests: [request],
    });
    appliedHead(await store.writeRepair(fixture, null));
    let enabled = false;
    const deps = {
      store,
      listOpenIssueNumbers: () => Promise.resolve(portOk([])),
      releasePath: () =>
        Promise.resolve(
          portOk(enabled ? "enabled" as const : "disabled" as const),
        ),
      readTargetTip: () => Promise.resolve(portOk(SHA2)),
      clock: { now: () => NOW },
      deadlineAt: NOW + 60_000,
      demotionBudget: 1200,
    };
    const demoted = await runRepairTierMaintenance(deps);
    assert.equal(demoted.status, "applied");
    assert.equal(demoted.demoted, 3);
    assert.equal(demoted.releaseRequestsMovedToCold, 1);
    runner.reset();
    assert.equal((await runRepairTierMaintenance(deps)).status, "unchanged");
    assert.ok(
      !runner.listedPaths.some((path) => path.startsWith("repair-archive/")),
    );
    enabled = true;
    const promoted = await runRepairTierMaintenance(deps);
    assert.equal(promoted.status, "applied");
    assert.equal(promoted.promoted, 3);
    assert.equal(promoted.releaseRequestsSuperseded, 0);
    const read = await store.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.deepEqual(read.value.snapshot.work, fixture.work);
      assert.deepEqual(read.value.snapshot.reservations, fixture.reservations);
      assert.deepEqual(
        read.value.snapshot.releaseRequests,
        fixture.releaseRequests,
      );
    }
  } finally {
    await ctx.cleanup();
  }
});
