import assert from "node:assert/strict";
import { parseVpsReleaseRecordV1 } from "../../src/contracts/vps-release.ts";
import { makeGitCtx, storeAt } from "../release/helpers.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/vps/release-requested-v1.json", import.meta.url),
  ),
);
Deno.test("VPS state: real Git roundtrip, old canonical absence, CAS and immutable request preservation", async () => {
  const context = await makeGitCtx("vps-state");
  try {
    const store = storeAt(context, "vps", "release");
    const legacy = {
      version: "v1" as const,
      kind: "release_state_snapshot" as const,
      stateHead: null,
      sequence: 1,
      updatedAt: fixture.createdAt,
      releases: [],
      hostedRuntimes: [],
      hostedReleases: [],
      githubCooldowns: [],
    };
    const first = await store.writeRelease(legacy, null);
    assert.ok(first.ok && first.value.status === "applied");
    const old = await store.readRelease();
    assert.ok(old.ok && old.value.status === "found");
    assert.equal(Object.hasOwn(old.value.snapshot, "vpsReleases"), false);
    assert.equal(
      canonicalStringify(old.value.snapshot),
      canonicalStringify(legacy),
    );
    const record = parseVpsReleaseRecordV1(fixture);
    const next = {
      ...old.value.snapshot,
      stateHead: old.value.head,
      sequence: 2,
      updatedAt: fixture.updatedAt,
      vpsReleases: [record],
    };
    const write = await store.writeRelease(next, old.value.head);
    assert.ok(write.ok && write.value.status === "applied");
    const observed = await store.readRelease();
    assert.ok(observed.ok && observed.value.status === "found");
    assert.equal(
      observed.value.snapshot.vpsReleases?.[0].requestDigest,
      record.requestDigest,
    );
    assert.deepEqual(observed.value.snapshot.releases, []);
    const stale = await store.writeRelease(next, old.value.head);
    assert.ok(stale.ok && stale.value.status === "conflict");
    const dropped = await store.writeRelease({
      ...observed.value.snapshot,
      stateHead: observed.value.head,
      sequence: 3,
      vpsReleases: [],
    }, observed.value.head);
    assert.equal(
      dropped.ok,
      false,
      "a pending rollback owner cannot be erased",
    );
  } finally {
    await context.cleanup();
  }
});
