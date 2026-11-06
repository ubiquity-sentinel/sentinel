/**
 * Sentinel #330: the delivery-train ledger git sidecar
 * (`refs/heads/sentinel-state/trains`): per-repository expected-head CAS,
 * non-force commits on the exact ref head, independent repositories and the
 * runtime's read-only holds view.
 */
import assert from "node:assert/strict";
import {
  type DeliveryTrainLedgerV1,
  EMPTY_DELIVERY_TRAIN_LEDGER,
} from "../../src/contracts/delivery-train-ledger.ts";
import {
  DELIVERY_TRAIN_REF,
  GitDeliveryTrainStore,
} from "../../src/state/delivery-train-store.ts";

const A = { owner: "ubiquity", name: "passport.ubq.fi", installationId: 9 };
const B = { owner: "ubiquity", name: "prospector", installationId: 9 };
const OP = "0123456789abcdef01234567";
const SHA = "a".repeat(40);

function open(recordId: string): DeliveryTrainLedgerV1 {
  return {
    ...EMPTY_DELIVERY_TRAIN_LEDGER,
    train: {
      operationId: OP,
      ref: `refs/heads/sentinel-trains/${OP}`,
      tip: "b".repeat(40),
      attempt: 1,
      sha: SHA,
      members: [{
        recordId,
        pullRequest: 5,
        head: SHA,
        base: "c".repeat(40),
        receiptId: `review-receipt:${"d".repeat(64)}`,
        commit: SHA,
        patch: "e".repeat(64),
        landedOn: null,
        revision: null,
      }],
      phase: "published",
      pendingMerge: null,
      createdAt: 1,
    },
  };
}

async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(out.stdout).trim();
}

async function withStore(
  body: (store: GitDeliveryTrainStore, remote: string) => Promise<void>,
) {
  const tmp = await Deno.makeTempDir({ prefix: "sentinel-train-store-" });
  try {
    const remote = `${tmp}/state.git`;
    await git(tmp, "init", "-q", "--bare", remote);
    await body(
      new GitDeliveryTrainStore({
        scratchDir: `${tmp}/scratch`,
        remoteUrl: remote,
      }),
      remote,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

Deno.test("train store: an unwritten ledger reads empty; a write applies on the exact head and reads back", async () => {
  await withStore(async (store, remote) => {
    const empty = await store.read(A);
    assert.deepEqual(empty, {
      head: null,
      ledger: EMPTY_DELIVERY_TRAIN_LEDGER,
    });
    const written = await store.write({
      repository: A,
      expectedHead: null,
      ledger: open("issue-a-1"),
    });
    assert.equal(written?.status, "applied");
    const read = await store.read(A);
    assert.equal(read?.head, written?.head);
    assert.deepEqual(read?.ledger, open("issue-a-1"));
    assert.match(
      await git(remote, "rev-parse", DELIVERY_TRAIN_REF),
      /^[0-9a-f]{40}$/,
    );
    // A stale expected head is a conflict and changes nothing.
    const stale = await store.write({
      repository: A,
      expectedHead: null,
      ledger: EMPTY_DELIVERY_TRAIN_LEDGER,
    });
    assert.equal(stale?.status, "conflict");
    assert.deepEqual((await store.read(A))?.ledger, open("issue-a-1"));
  });
});

Deno.test("train store: repositories are independent and the holds name each open train", async () => {
  await withStore(async (store) => {
    const a = await store.write({
      repository: A,
      expectedHead: null,
      ledger: open("issue-a-1"),
    });
    // B's write moves the shared ref but never conflicts with A's head.
    const b = await store.write({
      repository: B,
      expectedHead: null,
      ledger: open("issue-b-1"),
    });
    assert.equal(b?.status, "applied");
    const holds = await store.readHolds();
    assert.ok(holds.ok);
    assert.deepEqual(
      holds.value.map((hold) => [hold.repository.name, hold.members]),
      [["passport.ubq.fi", ["issue-a-1"]], ["prospector", ["issue-b-1"]]],
    );
    const closed = await store.write({
      repository: A,
      expectedHead: a!.head,
      ledger: EMPTY_DELIVERY_TRAIN_LEDGER,
    });
    assert.equal(closed?.status, "applied");
    const after = await store.readHolds();
    assert.ok(after.ok);
    assert.deepEqual(after.value.map((hold) => hold.repository.name), [
      "prospector",
    ]);
    assert.deepEqual((await store.read(B))?.ledger, open("issue-b-1"));
  });
});

Deno.test("train store: a malformed ledger is refused before any git work", async () => {
  await withStore(async (store) => {
    const refused = await store.write({
      repository: A,
      expectedHead: null,
      ledger: { ...EMPTY_DELIVERY_TRAIN_LEDGER, version: "v2" } as never,
    });
    assert.equal(refused, null);
    assert.deepEqual(await store.read(A), {
      head: null,
      ledger: EMPTY_DELIVERY_TRAIN_LEDGER,
    });
  });
});
