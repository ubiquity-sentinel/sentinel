// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  DenoGitRunner,
  RELEASE_STATE_REF,
  REPAIR_STATE_REF,
} from "../../src/state/mod.ts";
import {
  BarrierRunner,
  pushRawTree,
  releaseRecord,
  sha256Hex,
  SHA3,
  T0,
  workRecord,
} from "./helpers.ts";
import {
  appliedHead,
  gitRunAt,
  makeCtx,
  pushRawStateTree,
  rawManifestText,
  releaseSnapshot,
  remoteHead,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";

Deno.test("state: pre-migration controller identity reads as the current identity", async () => {
  const ctx = await makeCtx("legacy-controller-identity");
  try {
    const record = workRecord("legacy-controller-identity");
    const raw = {
      ...record,
      repository: {
        owner: "ubiquity",
        name: "sentinel",
        installationId: 0,
      },
    };
    await pushRawStateTree(ctx, null, REPAIR_STATE_REF, [
      { path: "manifest.json", text: rawManifestText(1, T0 + 1000, null) },
      {
        path: `work/${await sha256Hex(record.id)}.json`,
        text: `${canonicalStringify(raw)}\n`,
      },
    ]);
    const read = await storeAt(ctx, "legacy-reader", "repair").readRepair();
    assert(read.ok && read.value.status === "found");
    assert.equal(read.value.snapshot.sequence, 1);
    assert.equal(
      read.value.snapshot.work[0]?.repository.owner,
      "ubiquity-sentinel",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state history: strict fixed-ref ancestor read refuses stale missing foreign and malformed witnesses", async () => {
  const ctx = await makeCtx("release-history");
  try {
    const writer = storeAt(ctx, "release-history", "release");
    const first = appliedHead(
      await writer.writeRelease(releaseSnapshot(), null),
    );
    const current = appliedHead(
      await writer.writeRelease(
        releaseSnapshot({
          stateHead: first,
          sequence: 2,
          updatedAt: T0 + 2000,
        }),
        first,
      ),
    );
    const reader = storeAt(ctx, "history-reader", "repair");
    const read = await reader.readReleaseAt({
      commit: first,
      expectedHead: current,
    });
    assert(read.ok && read.value.status === "found");
    assert.equal(read.value.head, first);
    assert.equal(read.value.ref, RELEASE_STATE_REF);
    assert.deepEqual(read.value.snapshot, releaseSnapshot());
    for (
      const input of [
        { commit: first, expectedHead: first },
        { commit: SHA3, expectedHead: current },
        {
          commit: appliedHead(
            await storeAt(ctx, "foreign", "repair").writeRepair(
              repairSnapshot(),
              null,
            ),
          ),
          expectedHead: current,
        },
      ]
    ) assert.equal((await reader.readReleaseAt(input)).ok, false);
    assert(
      (await pushRawTree(ctx, current, RELEASE_STATE_REF, {
        "manifest.json": "{}\n",
      }, ctx.env)).ok,
    );
    const malformed = await remoteHead(ctx, RELEASE_STATE_REF);
    assert(
      (await pushRawTree(ctx, malformed, RELEASE_STATE_REF, {
        "manifest.json": `${
          canonicalStringify({
            version: "v1",
            kind: "release_state_manifest",
            sequence: 4,
            updatedAt: T0 + 4000,
            stateHead: malformed,
          })
        }\n`,
      }, ctx.env)).ok,
    );
    const head = await remoteHead(ctx, RELEASE_STATE_REF);
    assert.equal(
      (await reader.readReleaseAt({ commit: malformed, expectedHead: head }))
        .ok,
      false,
    );
    assert.equal(await remoteHead(ctx, RELEASE_STATE_REF), head);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state history: remote movement during historical read refuses without writes", async () => {
  const ctx = await makeCtx("release-history-drift");
  try {
    const writer = storeAt(ctx, "history-drift-writer", "release");
    const head = appliedHead(
      await writer.writeRelease(releaseSnapshot(), null),
    );
    const base = new DenoGitRunner(`${ctx.tmp}/git-home`);
    let moved = false;
    const reader = storeAt(ctx, "history-drift-reader", "repair", {
      runGit: async (args, options) => {
        const result = await base.runGit(args, options);
        if (args[0] === "merge-base" && !moved) {
          moved = true;
          appliedHead(
            await writer.writeRelease(
              releaseSnapshot({
                stateHead: head,
                sequence: 2,
                updatedAt: T0 + 2000,
              }),
              head,
            ),
          );
        }
        return result;
      },
    });
    const read = await reader.readReleaseAt({
      commit: head,
      expectedHead: head,
    });
    assert(!read.ok && read.error.kind === "conflict");
    assert(moved);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state history: repair ancestor authenticates fixed scope and refuses drift", async () => {
  const ctx = await makeCtx("repair-history");
  try {
    const writer = storeAt(ctx, "repair-history-writer", "repair");
    const first = appliedHead(await writer.writeRepair(repairSnapshot(), null));
    const current = appliedHead(
      await writer.writeRepair(
        repairSnapshot({ stateHead: first, sequence: 2, updatedAt: T0 + 2000 }),
        first,
      ),
    );
    const reader = storeAt(ctx, "repair-history-reader", "repair");
    const read = await reader.readRepairAt({
      commit: first,
      expectedHead: current,
    });
    assert(read.ok && read.value.status === "found");
    assert.equal(read.value.head, first);
    assert.equal(read.value.ref, REPAIR_STATE_REF);
    assert.deepEqual(read.value.snapshot, repairSnapshot());
    const foreign = appliedHead(
      await storeAt(ctx, "repair-history-foreign", "release").writeRelease(
        releaseSnapshot(),
        null,
      ),
    );
    for (
      const input of [{ commit: first, expectedHead: first }, {
        commit: SHA3,
        expectedHead: current,
      }, { commit: foreign, expectedHead: current }]
    ) assert.equal((await reader.readRepairAt(input)).ok, false);
    const base = new DenoGitRunner(`${ctx.tmp}/git-home`);
    let moved = false;
    const moving = storeAt(ctx, "repair-history-moving", "repair", {
      runGit: async (args, options) => {
        const result = await base.runGit(args, options);
        if (args[0] === "merge-base" && !moved) {
          moved = true;
          appliedHead(
            await writer.writeRepair(
              repairSnapshot({
                stateHead: current,
                sequence: 3,
                updatedAt: T0 + 3000,
              }),
              current,
            ),
          );
        }
        return result;
      },
    });
    const refused = await moving.readRepairAt({
      commit: first,
      expectedHead: current,
    });
    assert(!refused.ok && refused.error.kind === "conflict");
    assert(moved);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: branch creation, sequential writes, read and restart", async () => {
  const ctx = await makeCtx("lifecycle");
  try {
    const first = storeAt(ctx, "a", "repair");
    const absent = await first.readRepair();
    assert.ok(absent.ok);
    if (absent.ok) {
      assert.equal(absent.value.status, "absent");
      assert.equal(absent.value.currentHead, null);
      assert.equal(absent.value.ref, REPAIR_STATE_REF);
    }

    const s1 = repairSnapshot({ work: [workRecord("w:1")] });
    const created = await first.writeRepair(s1, null);
    const head1 = appliedHead(created);

    const s2 = repairSnapshot({
      stateHead: head1,
      sequence: 2,
      updatedAt: T0 + 2000,
      work: [workRecord("w:1"), workRecord("w:2")],
    });
    const extended = await first.writeRepair(s2, head1);
    const head2 = appliedHead(extended);

    // A restarted store (fresh scratch) reads the exact remote state; the
    // returned head is the state commit while the snapshot parent is separate.
    const restarted = storeAt(ctx, "b", "repair");
    const read = await restarted.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.head, head2);
      assert.equal(read.value.ref, REPAIR_STATE_REF);
      assert.equal(read.value.snapshot.stateHead, head1);
      assert.equal(read.value.snapshot.sequence, 2);
      assert.equal(read.value.snapshot.work.length, 2);
    } else {
      assert.fail("expected a found snapshot");
    }

    // Every write carries a unique trusted nonce in commit metadata.
    const log = await gitRunAt(
      ctx,
      ["--git-dir", ctx.bare, "log", REPAIR_STATE_REF, "--format=%B"],
    );
    assert.ok(log.ok);
    const nonces = log.stdout.match(/^nonce: [0-9a-f]{64}$/gm) ?? [];
    assert.equal(nonces.length, 2);
    assert.notEqual(nonces[0], nonces[1]);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: identical concurrent candidates grant exactly one applied", async () => {
  const ctx = await makeCtx("cas-identical");
  try {
    const runner = new BarrierRunner(new DenoGitRunner(`${ctx.tmp}/git-home`));
    const a = storeAt(ctx, "a", "repair", runner);
    const b = storeAt(ctx, "b", "repair", runner);
    const snapshot = repairSnapshot({ work: [workRecord("w:1")] });
    const [ra, rb] = await Promise.all([
      a.writeRepair(snapshot, null),
      b.writeRepair(snapshot, null),
    ]);
    assert.ok(ra.ok && rb.ok);
    if (!ra.ok || !rb.ok) throw new Error("unreachable");
    const outcomes = [ra.value, rb.value];
    const applied = outcomes.filter((o) => o.status === "applied");
    const conflicts = outcomes.filter((o) => o.status === "conflict");
    assert.equal(applied.length, 1, "exactly one fresh applied authorization");
    assert.equal(conflicts.length, 1, "the identical twin must conflict");
    const winner = applied[0] as { status: "applied"; head: GitSha };
    const loser = conflicts[0] as {
      status: "conflict";
      currentHead: GitSha | null;
    };
    assert.equal(loser.currentHead, winner.head);
    // The losing caller's same-second identical snapshot was NOT applied:
    // rereading the authoritative ref shows one state commit, not two.
    const read = await storeAt(ctx, "c", "repair").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.head, winner.head);
      assert.equal(read.value.snapshot.stateHead, null);
    } else {
      assert.fail("expected a found snapshot");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: different concurrent candidates: one applied, one conflict", async () => {
  const ctx = await makeCtx("cas-different");
  try {
    const runner = new BarrierRunner(new DenoGitRunner(`${ctx.tmp}/git-home`));
    const a = storeAt(ctx, "a", "repair", runner);
    const b = storeAt(ctx, "b", "repair", runner);
    const [ra, rb] = await Promise.all([
      a.writeRepair(repairSnapshot({ work: [workRecord("w:a")] }), null),
      b.writeRepair(repairSnapshot({ work: [workRecord("w:b")] }), null),
    ]);
    assert.ok(ra.ok && rb.ok);
    if (!ra.ok || !rb.ok) throw new Error("unreachable");
    const outcomes = [ra.value, rb.value];
    assert.equal(
      outcomes.filter((o) => o.status === "applied").length,
      1,
      "exactly one winner",
    );
    assert.equal(
      outcomes.filter((o) => o.status === "conflict").length,
      1,
      "the racing candidate must conflict and never overwrite",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: non-fast-forward is rejected; losing writer never overwrites", async () => {
  const ctx = await makeCtx("nff");
  try {
    const a = storeAt(ctx, "a", "repair");
    const head1 = appliedHead(
      await a.writeRepair(repairSnapshot({ work: [workRecord("w:1")] }), null),
    );
    const b = storeAt(ctx, "b", "repair");
    const head2b = appliedHead(
      await b.writeRepair(
        repairSnapshot({
          stateHead: head1,
          sequence: 2,
          updatedAt: T0 + 2000,
          work: [workRecord("w:1"), workRecord("w:2")],
        }),
        head1,
      ),
    );
    // Store A races its own child of head1 against B's already-applied child:
    // the push is non-fast-forward and must become a conflict, and the
    // remote must still hold B's exact state.
    const stale = await a.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1"), workRecord("w:3")],
      }),
      head1,
    );
    assert.ok(stale.ok);
    if (stale.ok) {
      assert.equal(stale.value.status, "conflict");
      if (stale.value.status === "conflict") {
        assert.equal(stale.value.currentHead, head2b);
      }
    }
    const read = await a.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.head, head2b);
      assert.deepEqual(
        read.value.snapshot.work.map((w) => w.id),
        ["w:1", "w:2"],
      );
    } else {
      assert.fail("expected a found snapshot");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: role separation; both roles read both fixed refs", async () => {
  const ctx = await makeCtx("roles");
  try {
    const repair = storeAt(ctx, "a", "repair");
    const release = storeAt(ctx, "b", "release");
    // Role mismatch fails before any mutation.
    const wrongRepair = await repair.writeRelease(
      releaseSnapshot({ releases: [releaseRecord("rel:1")] }),
      null,
    );
    assert.ok(!wrongRepair.ok);
    if (!wrongRepair.ok) assert.equal(wrongRepair.error.kind, "invalid");
    const releaseStillAbsent = await repair.readRelease();
    assert.ok(releaseStillAbsent.ok);
    if (releaseStillAbsent.ok) {
      assert.equal(releaseStillAbsent.value.status, "absent");
    }
    const wrongRelease = await release.writeRepair(
      repairSnapshot({ work: [workRecord("w:1")] }),
      null,
    );
    assert.ok(!wrongRelease.ok);
    if (!wrongRelease.ok) assert.equal(wrongRelease.error.kind, "invalid");
    const repairStillAbsent = await release.readRepair();
    assert.ok(repairStillAbsent.ok);
    if (repairStillAbsent.ok) {
      assert.equal(repairStillAbsent.value.status, "absent");
    }

    // Own rolls: repair writes repair, release writes release.
    const h1 = appliedHead(
      await repair.writeRepair(
        repairSnapshot({ work: [workRecord("w:1")] }),
        null,
      ),
    );
    const h2 = appliedHead(
      await release.writeRelease(
        releaseSnapshot({ releases: [releaseRecord("rel:1")] }),
        null,
      ),
    );
    // Both roles read both refs.
    const repairReadsRelease = await repair.readRelease();
    assert.ok(
      repairReadsRelease.ok && repairReadsRelease.value.status === "found",
    );
    if (repairReadsRelease.ok && repairReadsRelease.value.status === "found") {
      assert.equal(repairReadsRelease.value.head, h2);
    }
    const releaseReadsRepair = await release.readRepair();
    assert.ok(
      releaseReadsRepair.ok && releaseReadsRepair.value.status === "found",
    );
    if (releaseReadsRepair.ok && releaseReadsRepair.value.status === "found") {
      assert.equal(releaseReadsRepair.value.head, h1);
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: malformed remote record trees fail closed", async () => {
  const ctx = await makeCtx("malformed");
  try {
    const store = storeAt(ctx, "a", "repair");
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ work: [workRecord("w:1")] }),
        null,
      ),
    );

    // Missing manifest: the branch is corrupt, not empty.
    await pushRawTree(ctx, head1, REPAIR_STATE_REF, {
      "work/foo": "not even json",
    }, ctx.env);
    const missingManifest = await store.readRepair();
    assert.ok(!missingManifest.ok);
    if (!missingManifest.ok) {
      assert.equal(missingManifest.error.kind, "invalid");
    }

    // Embedded stateHead must equal the actual commit parent.
    const corruptHead = await remoteHead(ctx, REPAIR_STATE_REF);
    await pushRawTree(ctx, corruptHead, REPAIR_STATE_REF, {
      "manifest.json": JSON.stringify({
        version: "v1",
        kind: "repair_state_manifest",
        sequence: 2,
        updatedAt: T0 + 2000,
        stateHead: null,
      }),
    }, ctx.env);
    const wrongParent = await store.readRepair();
    assert.ok(!wrongParent.ok);
    if (!wrongParent.ok) assert.equal(wrongParent.error.kind, "invalid");

    // Unknown top-level entries and non-digest file names are invalid.
    const corruptHead2 = await remoteHead(ctx, REPAIR_STATE_REF);
    await pushRawTree(ctx, corruptHead2, REPAIR_STATE_REF, {
      "manifest.json": JSON.stringify({
        version: "v1",
        kind: "repair_state_manifest",
        sequence: 2,
        updatedAt: T0 + 2000,
        stateHead: corruptHead2,
      }),
      "junk.json": "{}",
      "work/zzzz.json": "{}",
    }, ctx.env);
    const junk = await store.readRepair();
    assert.ok(!junk.ok);
    if (!junk.ok) assert.equal(junk.error.kind, "invalid");

    // A digest-named file whose record id hashes to a different name is
    // misplaced state and must be rejected, not accepted.
    const corruptHead3 = await remoteHead(ctx, REPAIR_STATE_REF);
    const recordText = JSON.stringify(workRecord("w:1"));
    const otherFile = `${await sha256Hex("w:other")}.json`;
    await pushRawTree(ctx, corruptHead3, REPAIR_STATE_REF, {
      "manifest.json": JSON.stringify({
        version: "v1",
        kind: "repair_state_manifest",
        sequence: 2,
        updatedAt: T0 + 2000,
        stateHead: corruptHead3,
      }),
      [`work/${otherFile}`]: recordText,
    }, ctx.env);
    const misplaced = await store.readRepair();
    assert.ok(!misplaced.ok);
    if (!misplaced.ok) assert.equal(misplaced.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: work identity is immutable and done is terminal", async () => {
  const ctx = await makeCtx("work-immutable");
  try {
    const store = storeAt(ctx, "a", "repair");
    const done = workRecord("w:1", { nextStep: "done" });
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ work: [done] }),
        null,
      ),
    );

    const mutated = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1", { nextStep: "work", updatedAt: T0 + 5000 })],
      }),
      head1,
    );
    assert.ok(!mutated.ok);
    if (!mutated.ok) assert.equal(mutated.error.kind, "invalid");

    const dropped = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [],
      }),
      head1,
    );
    assert.ok(!dropped.ok);
    if (!dropped.ok) assert.equal(dropped.error.kind, "invalid");

    const failingChanged = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1", { failingRevision: "9".repeat(40) })],
      }),
      head1,
    );
    assert.ok(!failingChanged.ok);
    if (!failingChanged.ok) assert.equal(failingChanged.error.kind, "invalid");

    // Unchanged existing work plus a new record is the only allowed extension.
    const extended = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [done, workRecord("w:2")],
      }),
      head1,
    );
    assert.ok(extended.ok);
    if (extended.ok) assert.equal(extended.value.status, "applied");
  } finally {
    await ctx.cleanup();
  }
});
