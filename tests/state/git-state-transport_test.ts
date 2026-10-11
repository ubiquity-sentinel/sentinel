// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  DenoGitRunner,
  GitStateStore,
  REPAIR_STATE_REF,
} from "../../src/state/mod.ts";
import {
  FailedPushRunner,
  FakeLsRemoteRunner,
  LostPushResponseRunner,
  sha256Hex,
  SHA3,
  T0,
  ThrowAfterRunner,
  ThrowingRunner,
  workRecord,
} from "./helpers.ts";
import {
  appliedHead,
  makeCtx,
  pushRawStateTree,
  rawManifestText,
  remoteHead,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";

Deno.test("state: successful push with lost response reconciles to applied", async () => {
  const ctx = await makeCtx("lost-response");
  try {
    const runner = new LostPushResponseRunner(
      new DenoGitRunner(`${ctx.tmp}/git-home`),
    );
    const store = storeAt(ctx, "a", "repair", runner);
    const result = await store.writeRepair(
      repairSnapshot({ work: [workRecord("w:1")] }),
      null,
    );
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.value.status, "applied");
      if (result.value.status === "applied") {
        assert.match(result.value.head, /^[0-9a-f]{40}$/);
      }
    }
    assert.equal(runner.pushAttempts, 1);
    // A fresh store's authoritative reread sees exactly the reconciled state.
    const read = await storeAt(ctx, "b", "repair").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.snapshot.work[0]?.id, "w:1");
      assert.equal(read.value.snapshot.stateHead, null);
      assert.equal(read.value.snapshot.sequence, 1);
    } else {
      assert.fail("expected a found snapshot");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: rejected push with an absent ref reports auth failure", async () => {
  const ctx = await makeCtx("rejected-push");
  try {
    const runner = new FailedPushRunner(
      new DenoGitRunner(`${ctx.tmp}/git-home`),
    );
    const store = storeAt(ctx, "a", "repair", runner);
    const result = await store.writeRepair(
      repairSnapshot({ work: [workRecord("w:rejected")] }),
      null,
    );
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.error.kind, "auth_failed");
      assert.equal(
        result.error.detail,
        "state push was not applied; the remote ref remains absent",
      );
    }
    assert.equal(runner.pushAttempts, 1);
    const read = await storeAt(ctx, "b", "repair").readRepair();
    assert.ok(read.ok && read.value.status === "absent");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: unavailable remote is never mistakenly empty", async () => {
  const ctx = await makeCtx("unavailable");
  try {
    const store = new GitStateStore({
      scratchDir: `${ctx.tmp}/scratch-x`,
      remoteUrl: `${ctx.tmp}/missing-remote.git`,
      role: "repair",
    });
    const read = await store.readRepair();
    assert.ok(
      !read.ok,
      "an unavailable remote must not look like an empty branch",
    );
    const write = await store.writeRepair(repairSnapshot(), null);
    assert.ok(
      !write.ok,
      "a write to an unavailable remote must not be applied",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: snapshot stateHead must equal the expected remote head", async () => {
  const ctx = await makeCtx("statehead");
  try {
    const store = storeAt(ctx, "a", "repair");
    const wrongHead = await store.writeRepair(
      repairSnapshot({
        stateHead: SHA3,
      }),
      null,
    );
    assert.ok(!wrongHead.ok);
    if (!wrongHead.ok) assert.equal(wrongHead.error.kind, "invalid");

    // A stale expected head conflicts with the actual ref and reads reconcile.
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ work: [workRecord("w:1")] }),
        null,
      ),
    );
    const stale = await store.writeRepair(
      repairSnapshot({
        stateHead: SHA3,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1")],
      }),
      SHA3,
    );
    assert.ok(stale.ok);
    if (stale.ok) {
      assert.equal(stale.value.status, "conflict");
      if (stale.value.status === "conflict") {
        assert.equal(stale.value.currentHead, head1);
      }
    }
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Raw-tree plumbing helper: pushes an exactly controlled state tree with real
// git (index + write-tree + commit-tree + non-force push), no checkout and no
// store involvement, so blob bytes and tree modes are exactly what the store
// must validate. Modes: 100644 regular, 100755 executable, 120000 symlink
// (for 120000 the text is the link target).
// ---------------------------------------------------------------------------

Deno.test("state: transport throws become sanitized typed failures; pushes reconcile", async () => {
  const ctx = await makeCtx("transport-throws");
  try {
    const real = new DenoGitRunner(`${ctx.tmp}/git-home`);

    // Throws before any read or write: sanitized typed unavailable, and the
    // synthetic exception text must never leak into the result.
    const blind = storeAt(
      ctx,
      "a",
      "repair",
      new ThrowingRunner(real, () => true),
    );
    const read = await blind.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) {
      assert.equal(read.error.kind, "unavailable");
      assert.ok(!read.error.detail.includes("synthetic"));
    }
    const write = await blind.writeRepair(
      repairSnapshot({ work: [workRecord("w:1")] }),
      null,
    );
    assert.ok(!write.ok);
    if (!write.ok) assert.equal(write.error.kind, "unavailable");

    // The push executes, then its response is thrown away: the authoritative
    // ref still proves the unique candidate was applied.
    const afterPush = new ThrowAfterRunner(real, (args) => args[0] === "push");
    const pushed = storeAt(ctx, "b", "repair", afterPush);
    const applied = await pushed.writeRepair(
      repairSnapshot({ work: [workRecord("w:p")] }),
      null,
    );
    assert.ok(applied.ok);
    if (applied.ok) assert.equal(applied.value.status, "applied");
    assert.equal(afterPush.throwCount, 1);
    const backRead = await storeAt(ctx, "c", "repair").readRepair();
    assert.ok(backRead.ok && backRead.value.status === "found");
    if (backRead.ok && backRead.value.status === "found") {
      assert.equal(backRead.value.snapshot.work[0]?.id, "w:p");
    }

    // The verification read throws after an attempted push: ambiguous, never
    // a false "not applied" error.
    const priorHead = backRead.ok && backRead.value.status === "found"
      ? backRead.value.head
      : null;
    assert.ok(priorHead);
    let lsRemoteCalls = 0;
    const afterVerify = new ThrowAfterRunner(real, (args) => {
      if (args[0] !== "ls-remote") return false;
      lsRemoteCalls++;
      return lsRemoteCalls === 2;
    });
    const verified = storeAt(ctx, "d", "repair", afterVerify);
    const ambiguous = await verified.writeRepair(
      repairSnapshot({
        stateHead: priorHead,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:p"), workRecord("w:v")],
      }),
      priorHead,
    );
    assert.ok(ambiguous.ok);
    if (ambiguous.ok) assert.equal(ambiguous.value.status, "ambiguous");
    assert.equal(afterVerify.throwCount, 1);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: strict ls-remote: malformed, nonmatching and duplicate responses are invalid", async () => {
  const ctx = await makeCtx("lsremote-strict");
  try {
    const real = new DenoGitRunner(`${ctx.tmp}/git-home`);
    const ref = REPAIR_STATE_REF;
    const canned = (stdout: string) =>
      storeAt(
        ctx,
        "x",
        "repair",
        new FakeLsRemoteRunner(real, { ok: true, stdout }),
      );

    // Zero output lines with a successful ls-remote: the ref truly is absent.
    const absent = await canned("").readRepair();
    assert.ok(absent.ok && absent.value.status === "absent");

    const cases: { name: string; stdout: string }[] = [
      { name: "malformed line", stdout: "not-a-valid-ls-remote-line\n" },
      {
        name: "malformed commit id",
        stdout: `${"z".repeat(40)}\t${ref}\n`,
      },
      {
        name: "nonmatching ref",
        stdout:
          `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/sentinel-state/other\n`,
      },
      {
        name: "duplicate matching records",
        stdout: `${SHA3}\t${ref}\n${"b".repeat(40)}\t${ref}\n`,
      },
    ];
    for (const item of cases) {
      const result = await canned(item.stdout).readRepair();
      assert.ok(!result.ok, `${item.name} must not look empty`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
    }
    // A failed lookup is typed unavailable, never empty.
    const failed = storeAt(
      ctx,
      "y",
      "repair",
      new FakeLsRemoteRunner(real, { ok: false, stdout: "" }),
    );
    const failedRead = await failed.readRepair();
    assert.ok(!failedRead.ok);
    if (!failedRead.ok) assert.equal(failedRead.error.kind, "unavailable");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: raw state trees require canonical bytes and regular blob modes", async () => {
  const ctx = await makeCtx("raw-tree-strict");
  try {
    const store = storeAt(ctx, "a", "repair");
    const record = workRecord("w:1");
    const recordPath = `work/${await sha256Hex("w:1")}.json`;
    const recordText = `${canonicalStringify(record)}\n`;
    const manifest = rawManifestText(1, T0 + 1000, null);
    const canonicalTree = [
      { path: "manifest.json", text: manifest },
      { path: recordPath, text: recordText },
    ];

    // Exactly the store's canonical bytes, pushed as a raw tree: valid.
    await pushRawStateTree(ctx, null, REPAIR_STATE_REF, canonicalTree);
    const okRead = await store.readRepair();
    assert.ok(okRead.ok && okRead.value.status === "found");
    if (okRead.ok && okRead.value.status === "found") {
      assert.equal(okRead.value.snapshot.work[0]?.id, "w:1");
    }
    let head = await remoteHead(ctx, REPAIR_STATE_REF);
    const headManifest = rawManifestText(2, T0 + 2000, head);

    const invalidTrees: {
      name: string;
      files: {
        path: string;
        text: string;
        mode?: "100644" | "100755" | "120000";
      }[];
    }[] = [
      {
        name: "executable manifest",
        files: [
          { path: "manifest.json", text: headManifest, mode: "100755" },
          { path: recordPath, text: recordText },
        ],
      },
      {
        name: "symlink record file",
        files: [
          { path: "manifest.json", text: headManifest },
          { path: recordPath, text: "../../etc/passwd", mode: "120000" },
        ],
      },
      {
        name: "non-canonical record bytes",
        files: [
          { path: "manifest.json", text: headManifest },
          { path: recordPath, text: recordText.replace(/\n$/, "") },
        ],
      },
      {
        name: "manifest with duplicate JSON key",
        files: [
          {
            path: "manifest.json",
            text: headManifest.replace(
              '"version":"v1"',
              '"version":"v1","version":"v1"',
            ),
          },
          { path: recordPath, text: recordText },
        ],
      },
      {
        name: "record with duplicate JSON key",
        files: [
          { path: "manifest.json", text: headManifest },
          {
            path: recordPath,
            text: recordText.replace(
              '"version":"v1"',
              '"version":"v1","version":"v1"',
            ),
          },
        ],
      },
    ];
    for (const item of invalidTrees) {
      await pushRawStateTree(ctx, head, REPAIR_STATE_REF, item.files);
      head = await remoteHead(ctx, REPAIR_STATE_REF);
      const result = await store.readRepair();
      assert.ok(!result.ok, `${item.name} must be rejected`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
      // Restore a canonical tree on top for the next case.
      await pushRawStateTree(ctx, head, REPAIR_STATE_REF, [{
        path: "manifest.json",
        text: rawManifestText(2, T0 + 2000, head),
      }, {
        path: recordPath,
        text: recordText,
      }]);
      head = await remoteHead(ctx, REPAIR_STATE_REF);
      const restored = await store.readRepair();
      assert.ok(restored.ok);
    }
  } finally {
    await ctx.cleanup();
  }
});

/**
 * An evidence record with a duplicate artifact ref can no longer be produced
 * by the frozen parser (the guard lives in parseIncidentEvidenceV1 now), so
 * this raw object is assembled by hand for the store-level rejection cases;
 * it is canonical JSON with exactly one semantic defect.
 */
