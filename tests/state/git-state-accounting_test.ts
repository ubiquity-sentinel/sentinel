// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { REPAIR_STATE_REF } from "../../src/state/mod.ts";
import {
  pushRawTree,
  reservation,
  sha256Hex,
  T0,
  workRecord,
} from "./helpers.ts";
import {
  appliedHead,
  attemptMemory,
  githubCooldown,
  gitRunAt,
  makeCtx,
  memoryLessonsFixture,
  rawManifestText,
  remoteHead,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";

Deno.test("state: reservations cannot disappear, change identity or revert settlement", async () => {
  const ctx = await makeCtx("reservations");
  try {
    const store = storeAt(ctx, "a", "repair");
    const r1 = reservation("r:1");
    const r2 = reservation("r:2", {
      outcome: "ambiguous",
      settledAt: T0 + 500,
      proofRef: null,
    });
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ reservations: [r1, r2] }),
        null,
      ),
    );

    // Deletion is never allowed.
    const dropped = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [r1],
      }),
      head1,
    );
    assert.ok(!dropped.ok);
    if (!dropped.ok) assert.equal(dropped.error.kind, "invalid");

    // Identity/time cannot change.
    const identityChanged = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [
          { ...r1, head: "9".repeat(40) as GitSha },
          r2,
        ],
      }),
      head1,
    );
    assert.ok(!identityChanged.ok);
    if (!identityChanged.ok) {
      assert.equal(identityChanged.error.kind, "invalid");
    }

    // A refund requires the parser's proof ref: without it the input itself
    // fails contract validation before any mutation.
    const refundWithoutProof = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [
          r1,
          { ...r2, outcome: "confirmed_not_submitted", settledAt: T0 + 900 },
        ],
      }),
      head1,
    );
    assert.ok(!refundWithoutProof.ok);
    if (!refundWithoutProof.ok) {
      assert.equal(refundWithoutProof.error.kind, "invalid");
    }

    // With the proof ref the ambiguous reservation may be refunded (the only
    // uncharged transition), and both reservations survive.
    const refunded = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [
          r1,
          {
            ...r2,
            outcome: "confirmed_not_submitted",
            settledAt: T0 + 900,
            proofRef: "artifact://proof/r2",
          },
        ],
      }),
      head1,
    );
    assert.ok(refunded.ok);
    if (refunded.ok) assert.equal(refunded.value.status, "applied");
    const refundHead = refunded.ok && refunded.value.status === "applied"
      ? refunded.value.head
      : null;
    assert.ok(refundHead);

    // Settled state cannot revert into a charged outcome or change time.
    const revert = await store.writeRepair(
      repairSnapshot({
        stateHead: refundHead,
        sequence: 3,
        updatedAt: T0 + 3000,
        reservations: [
          r1,
          { ...r2, outcome: "ambiguous", settledAt: T0 + 800, proofRef: null },
        ],
      }),
      refundHead,
    );
    assert.ok(!revert.ok);
    if (!revert.ok) assert.equal(revert.error.kind, "invalid");
    const resubmit = await store.writeRepair(
      repairSnapshot({
        stateHead: refundHead,
        sequence: 3,
        updatedAt: T0 + 3000,
        reservations: [
          r1,
          {
            ...r2,
            outcome: "submitted",
            settledAt: T0 + 999,
            proofRef: null,
          },
        ],
      }),
      refundHead,
    );
    assert.ok(!resubmit.ok);
    if (!resubmit.ok) assert.equal(resubmit.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: ambiguous reservations reconcile to submitted; settlement never moves backward", async () => {
  const ctx = await makeCtx("reservation-reconcile");
  try {
    const store = storeAt(ctx, "a", "repair");
    const r = reservation("r:1", {
      outcome: "ambiguous",
      settledAt: T0 + 500,
      proofRef: null,
    });
    const head1 = appliedHead(
      await store.writeRepair(repairSnapshot({ reservations: [r] }), null),
    );

    // A settled reservation cannot revert to reserved.
    const revert = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [{ ...r, outcome: "reserved", settledAt: null }],
      }),
      head1,
    );
    assert.ok(!revert.ok);
    if (!revert.ok) assert.equal(revert.error.kind, "invalid");

    // Settlement time may advance with the same ambiguous outcome.
    const advanced = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [{ ...r, settledAt: T0 + 900 }],
      }),
      head1,
    );
    assert.ok(advanced.ok);
    if (advanced.ok) assert.equal(advanced.value.status, "applied");
    const head2 = advanced.ok && advanced.value.status === "applied"
      ? advanced.value.head
      : null;
    assert.ok(head2);

    // Settlement time cannot move backward.
    const backward = await store.writeRepair(
      repairSnapshot({
        stateHead: head2,
        sequence: 3,
        updatedAt: T0 + 3000,
        reservations: [{ ...r, settledAt: T0 + 700 }],
      }),
      head2,
    );
    assert.ok(!backward.ok);
    if (!backward.ok) assert.equal(backward.error.kind, "invalid");

    // ambiguous -> submitted is valid reconciliation and stays charged.
    const submitted = await store.writeRepair(
      repairSnapshot({
        stateHead: head2,
        sequence: 3,
        updatedAt: T0 + 3000,
        reservations: [{
          ...r,
          outcome: "submitted",
          settledAt: T0 + 1000,
        }],
      }),
      head2,
    );
    assert.ok(submitted.ok);
    if (submitted.ok) assert.equal(submitted.value.status, "applied");
    const head3 = submitted.ok && submitted.value.status === "applied"
      ? submitted.value.head
      : null;
    assert.ok(head3);

    // submitted is immutable: neither a later settlement time nor a refund.
    const laterSettlement = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        reservations: [{
          ...r,
          outcome: "submitted",
          settledAt: T0 + 2000,
        }],
      }),
      head3,
    );
    assert.ok(!laterSettlement.ok);
    if (!laterSettlement.ok) {
      assert.equal(laterSettlement.error.kind, "invalid");
    }
    const refundFromSubmitted = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        reservations: [{
          ...r,
          outcome: "confirmed_not_submitted",
          settledAt: T0 + 2000,
          proofRef: "artifact://proof/r:1",
        }],
      }),
      head3,
    );
    assert.ok(!refundFromSubmitted.ok);
    if (!refundFromSubmitted.ok) {
      assert.equal(refundFromSubmitted.error.kind, "invalid");
    }

    // Equal repeated settlement stays idempotent.
    const idempotent = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        reservations: [{
          ...r,
          outcome: "submitted",
          settledAt: T0 + 1000,
        }],
      }),
      head3,
    );
    assert.ok(idempotent.ok);
    if (idempotent.ok) assert.equal(idempotent.value.status, "applied");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: github cooldowns roundtrip per installation and survive unrelated writes", async () => {
  const ctx = await makeCtx("cooldown-roundtrip");
  try {
    const store = storeAt(ctx, "a", "repair");
    // Two affected installations: one explicit manual fail-closed hold (null
    // deadline) and one bounded fallback deadline carrying the fallback index.
    const manual = githubCooldown(7);
    const fallback = githubCooldown(42, {
      retryNotBefore: T0 + 120_000,
      observationId: "b".repeat(64),
      secondaryBackoff: 2,
    });
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ githubCooldowns: [manual, fallback] }),
        null,
      ),
    );

    // Durable storage mapping: exactly one sha256(String(installationId))
    // json file per affected installation in the githubCooldowns collection.
    const tree = await gitRunAt(
      ctx,
      [
        "--git-dir",
        ctx.bare,
        "ls-tree",
        "-r",
        "--name-only",
        REPAIR_STATE_REF,
      ],
    );
    assert.ok(tree.ok);
    const paths = tree.stdout.split("\n").filter((line) => line.length > 0);
    assert.ok(paths.includes(`githubCooldowns/${await sha256Hex("7")}.json`));
    assert.ok(paths.includes(`githubCooldowns/${await sha256Hex("42")}.json`));

    // A fresh store reads the exact collection back, deterministic order by
    // installation id string ("42" before "7").
    const read = await storeAt(ctx, "b", "repair").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.deepEqual(read.value.snapshot.githubCooldowns, [fallback, manual]);
      assert.equal(
        read.value.snapshot.githubCooldowns[0].installationId,
        42,
      );
      assert.equal(read.value.snapshot.githubCooldowns[0].secondaryBackoff, 2);
      assert.equal(
        read.value.snapshot.githubCooldowns[1].retryNotBefore,
        null,
      );
    } else {
      assert.fail("expected a found snapshot");
    }

    // An unrelated repair write (a new work record) preserves both cooldowns.
    const head2 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          stateHead: head1,
          sequence: 2,
          updatedAt: T0 + 2000,
          work: [workRecord("w:1")],
          githubCooldowns: [manual, fallback],
        }),
        head1,
      ),
    );
    const read2 = await storeAt(ctx, "c", "repair").readRepair();
    assert.ok(read2.ok && read2.value.status === "found");
    if (read2.ok && read2.value.status === "found") {
      assert.equal(read2.value.snapshot.work[0]?.id, "w:1");
      assert.deepEqual(read2.value.snapshot.githubCooldowns, [
        fallback,
        manual,
      ]);
    } else {
      assert.fail("expected a found snapshot");
    }

    // A new observation may refresh the same installation's record (later
    // deadline, later observation, new backoff); the manual hold stays null.
    const refreshed = githubCooldown(42, {
      retryNotBefore: T0 + 240_000,
      observedAt: T0 + 5000,
      observationId: "c".repeat(64),
      secondaryBackoff: 3,
    });
    const head3 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          work: [workRecord("w:1")],
          githubCooldowns: [manual, refreshed],
        }),
        head2,
      ),
    );

    // Silently dropping a cooldown is invalid: the gate must never lose an
    // affected installation's hold.
    const dropped = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        work: [workRecord("w:1")],
        githubCooldowns: [manual],
      }),
      head3,
    );
    assert.ok(!dropped.ok);
    if (!dropped.ok) assert.equal(dropped.error.kind, "invalid");

    // A manual fail-closed hold can never become a retry deadline.
    const converted = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        work: [workRecord("w:1")],
        githubCooldowns: [
          githubCooldown(7, { retryNotBefore: T0 + 60_000 }),
          refreshed,
        ],
      }),
      head3,
    );
    assert.ok(!converted.ok);
    if (!converted.ok) assert.equal(converted.error.kind, "invalid");

    // observedAt cannot move backward on an existing cooldown.
    const backward = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        work: [workRecord("w:1")],
        githubCooldowns: [
          manual,
          githubCooldown(42, {
            retryNotBefore: T0 + 120_000,
            observedAt: T0 + 1000,
            observationId: "b".repeat(64),
            secondaryBackoff: 2,
          }),
        ],
      }),
      head3,
    );
    assert.ok(!backward.ok);
    if (!backward.ok) assert.equal(backward.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: malformed github cooldown records fail closed on read", async () => {
  const ctx = await makeCtx("cooldown-tamper");
  try {
    const store = storeAt(ctx, "a", "repair");
    const cooldown = githubCooldown(7);
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ githubCooldowns: [cooldown] }),
        null,
      ),
    );
    const file7 = `${await sha256Hex("7")}.json`;

    // A non-digest file name in the cooldown collection is rejected.
    await pushRawTree(ctx, head1, REPAIR_STATE_REF, {
      "manifest.json": rawManifestText(2, T0 + 2000, head1),
      "githubCooldowns/not-a-digest.json": `${canonicalStringify(cooldown)}\n`,
    }, ctx.env);
    let read = await store.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) assert.equal(read.error.kind, "invalid");
    let head = await remoteHead(ctx, REPAIR_STATE_REF);

    // The file name must hash to String(installationId): a record under the
    // sha256 of a different installation is misplaced state.
    await pushRawTree(ctx, head, REPAIR_STATE_REF, {
      "manifest.json": rawManifestText(2, T0 + 2000, head),
      [`githubCooldowns/${await sha256Hex("8")}.json`]: `${
        canonicalStringify(cooldown)
      }\n`,
    }, ctx.env);
    read = await store.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) assert.equal(read.error.kind, "invalid");
    head = await remoteHead(ctx, REPAIR_STATE_REF);

    // Reordered keys are not the canonical bytes and are rejected.
    await pushRawTree(ctx, head, REPAIR_STATE_REF, {
      "manifest.json": rawManifestText(2, T0 + 2000, head),
      [`githubCooldowns/${file7}`]: `${
        JSON.stringify({
          installationId: 7,
          retryNotBefore: null,
          observedAt: T0,
          observationId: "a".repeat(64),
          secondaryBackoff: 0,
        })
      }\n`,
    }, ctx.env);
    read = await store.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) assert.equal(read.error.kind, "invalid");
    head = await remoteHead(ctx, REPAIR_STATE_REF);

    // A record failing the frozen parser (invalid installation id) is
    // rejected instead of being admitted with a fabricated storage identity.
    await pushRawTree(ctx, head, REPAIR_STATE_REF, {
      "manifest.json": rawManifestText(2, T0 + 2000, head),
      [`githubCooldowns/${file7}`]: `${
        canonicalStringify({
          installationId: 0,
          retryNotBefore: null,
          observedAt: T0,
          observationId: "a".repeat(64),
          secondaryBackoff: 0,
        })
      }\n`,
    }, ctx.env);
    read = await store.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) assert.equal(read.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// M15 V1 candidate state: a fresh real-Git read view preserves mixed legacy and
// new-format work bytes, historical charges and terminal records across an
// unrelated allowed cooldown write. The store's own canonical-bytes check runs
// on every read, so these assertions prove the stored blobs, not just parsed
// JSON objects.
// ---------------------------------------------------------------------------

Deno.test("attempt memory: durable round-trip and append-only transition guards", async () => {
  const ctx = await makeCtx("attempt-memory");
  try {
    const writer = storeAt(ctx, "attempt-memory", "repair");
    const memory = attemptMemory();
    const lessons = await memoryLessonsFixture(memory);
    const head = appliedHead(
      await writer.writeRepair(
        repairSnapshot({ attemptMemory: [memory], lessons: [lessons] }),
        null,
      ),
    );
    const reader = storeAt(ctx, "attempt-memory-reader", "repair");
    const read = await reader.readRepair();
    assert(read.ok && read.value.status === "found");
    assert.deepEqual(read.value.snapshot.attemptMemory, [memory]);
    assert.deepEqual(read.value.snapshot.lessons, [lessons]);

    // Counts are append/merge-only: a decreasing fingerprint count is refused
    // and leaves the durable ref untouched.
    const decreased = await writer.writeRepair(
      repairSnapshot({
        stateHead: head,
        sequence: 2,
        updatedAt: T0 + 2000,
        attemptMemory: [attemptMemory(1)],
        lessons: [],
      }),
      head,
    );
    assert.equal(decreased.ok, false);
    if (!decreased.ok) {
      assert.equal(decreased.error.kind, "invalid");
      assert.match(decreased.error.detail, /counts? cannot decrease/);
    }
    assert.equal(await remoteHead(ctx, REPAIR_STATE_REF), head);

    // A record can never be dropped.
    const dropped = await writer.writeRepair(
      repairSnapshot({
        stateHead: head,
        sequence: 2,
        updatedAt: T0 + 2000,
        attemptMemory: [],
        lessons: [],
      }),
      head,
    );
    assert.equal(dropped.ok, false);
    if (!dropped.ok) {
      assert.match(dropped.error.detail, /cannot be dropped/);
    }
    assert.equal(await remoteHead(ctx, REPAIR_STATE_REF), head);

    // Extending the count is the normal append path.
    const grown = await writer.writeRepair(
      repairSnapshot({
        stateHead: head,
        sequence: 2,
        updatedAt: T0 + 3000,
        attemptMemory: [attemptMemory(3)],
        lessons: [],
      }),
      head,
    );
    assert.equal(grown.ok && grown.value.status, "applied");
  } finally {
    await ctx.cleanup();
  }
});
