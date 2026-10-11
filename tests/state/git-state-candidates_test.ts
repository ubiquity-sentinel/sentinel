// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  releaseRequest,
  reservation,
  reviewReceipt,
  SHA1,
  sha256Hex,
  T0,
  workRecord,
} from "./helpers.ts";
import {
  appliedHead,
  githubCooldown,
  gitRunAt,
  makeCtx,
  parkedCandidateRecord,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";

Deno.test("state: mixed legacy and candidate-state work survive an unrelated write", async () => {
  const ctx = await makeCtx("candidate-mixed");
  try {
    const legacy = workRecord("w:legacy");
    const parked = parkedCandidateRecord("w:parked");
    const nullPreserved = workRecord("w:null", {
      nextStep: "work",
      target: {
        base: SHA1,
        branch: "sentinel/repair/w:null",
        checkpoint: null,
        head: null,
        pr: null,
        candidateState: { preserved: null, publishedHead: null },
      },
    });
    const charge = reservation("res-1", {
      outcome: "submitted",
      settledAt: T0 + 5000,
    });
    const receipt = reviewReceipt("rev-1", {
      outcome: "completed",
      resultId: "result-1",
      observedReviewer: "chatgpt-codex-connector[bot]",
      completedAt: T0 + 1500,
      observedAt: T0 + 2000,
    });
    const request = releaseRequest("rr-1");
    const records = [legacy, parked, nullPreserved, charge, receipt, request];

    const seed = repairSnapshot({
      work: [legacy, parked, nullPreserved],
      reservations: [charge],
      reviews: [receipt],
      releaseRequests: [request],
    });
    const created = await storeAt(ctx, "mixed-write", "repair").writeRepair(
      seed,
      null,
    );
    const head1 = appliedHead(created);

    // Fresh instance read: every record is byte-exact, the legacy target has no
    // candidateState key, and the new-format groups survive unchanged.
    const reader = storeAt(ctx, "mixed-read-1", "repair");
    const read = await reader.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    const first = read.value.snapshot;
    const byId = (id: string) => first.work.find((work) => work.id === id);
    assert.equal(byId("w:legacy")?.target.candidateState, undefined);
    assert.equal(
      canonicalStringify(byId("w:legacy")),
      canonicalStringify(legacy),
    );
    assert.equal(
      canonicalStringify(byId("w:parked")),
      canonicalStringify(parked),
    );
    assert.equal(
      canonicalStringify(byId("w:null")),
      canonicalStringify(nullPreserved),
      "null-preserved parked work survives exactly",
    );
    assert.equal(
      canonicalStringify(first.reservations[0]),
      canonicalStringify(charge),
    );
    assert.equal(
      canonicalStringify(first.reviews[0]),
      canonicalStringify(receipt),
    );
    assert.equal(
      canonicalStringify(first.releaseRequests[0]),
      canonicalStringify(request),
    );

    // The release-role store reads the same repair ref with the same bytes.
    const releaseReader = storeAt(ctx, "mixed-read-release", "release");
    const releaseRead = await releaseReader.readRepair();
    assert.ok(releaseRead.ok && releaseRead.value.status === "found");
    if (!releaseRead.ok || releaseRead.value.status !== "found") {
      throw new Error("no repair state for the release read view");
    }
    assert.equal(
      canonicalStringify(releaseRead.value.snapshot.work),
      canonicalStringify(first.work),
    );

    // Unrelated allowed transition: one durable cooldown observation only.
    const next = repairSnapshot({
      stateHead: head1,
      sequence: 2,
      updatedAt: T0 + 2000,
      work: [legacy, parked, nullPreserved],
      reservations: [charge],
      reviews: [receipt],
      releaseRequests: [request],
      githubCooldowns: [githubCooldown(7)],
      attemptMemory: [],
      lessons: [],
    });
    const applied = await storeAt(ctx, "mixed-write-2", "repair").writeRepair(
      next,
      head1,
    );
    const head2 = appliedHead(applied);

    const reader2 = storeAt(ctx, "mixed-read-2", "repair");
    const read2 = await reader2.readRepair();
    assert.ok(read2.ok && read2.value.status === "found");
    if (!read2.ok || read2.value.status !== "found") {
      throw new Error("no repair state after the unrelated write");
    }
    const second = read2.value.snapshot;
    assert.equal(second.sequence, 2);
    assert.deepEqual(
      second.githubCooldowns.map((cooldown) => cooldown.installationId),
      [7],
    );
    const secondById = (id: string) =>
      second.work.find((work) => work.id === id);
    for (
      const [found, expected] of [
        [secondById("w:legacy"), legacy],
        [secondById("w:parked"), parked],
        [secondById("w:null"), nullPreserved],
        [second.reservations[0], charge],
        [second.reviews[0], receipt],
        [second.releaseRequests[0], request],
      ] as const
    ) {
      assert.equal(canonicalStringify(found), canonicalStringify(expected));
    }

    // Byte-level proof against the disposable bare store: every work/charge/
    // review/request blob at head2 is exactly the canonical record bytes.
    const tree = await gitRunAt(ctx, [
      "--git-dir",
      ctx.bare,
      "ls-tree",
      "-r",
      head2,
    ]);
    assert.ok(tree.ok, `ls-tree failed: ${tree.stderr}`);
    const blobs = new Map<string, string>();
    for (const line of tree.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const meta = line.slice(0, tab).split(/\s+/);
      blobs.set(line.slice(tab + 1), meta[2] ?? "");
    }
    const blobTextById = new Map<string, string>();
    for (const record of records) {
      const fileName = `${await sha256Hex(record.id)}.json`;
      const entry = [...blobs.entries()].find(([path]) =>
        path.endsWith(`/${fileName}`)
      );
      assert.ok(entry, `stored blob for ${record.id}`);
      if (entry === undefined) continue;
      const blob = await gitRunAt(ctx, [
        "--git-dir",
        ctx.bare,
        "cat-file",
        "blob",
        entry[1],
      ]);
      assert.ok(blob.ok, `cat-file failed: ${blob.stderr}`);
      blobTextById.set(record.id, blob.stdout);
      assert.equal(blob.stdout, `${canonicalStringify(record)}\n`, record.id);
    }
    assert.equal(
      blobTextById.get("w:legacy")?.includes('"candidateState"'),
      false,
      "the legacy blob is the exact old shape",
    );
    assert.equal(
      blobTextById.get("w:parked")?.includes('"candidateState"'),
      true,
      "the new-format blob preserves its candidateState group",
    );
  } finally {
    await ctx.cleanup();
  }
});

/** Deterministic lessons view for the same family record. */
