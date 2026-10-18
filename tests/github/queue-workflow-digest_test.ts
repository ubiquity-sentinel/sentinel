import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { response, SHA1, SHA2, T0 } from "./merge-queue-fixtures.ts";
import {
  BEFORE_TREE,
  blob,
  deliveryClient,
  treeWire,
  UNTIL,
} from "./queue-delivery-reader-fixtures.ts";

const PATH = ".github/workflows/deno-deploy.yml";
const CONTENT = new TextEncoder().encode(
  "name: CI\non: [pull_request, merge_group]\n# exact UTF-8 ✓\n",
);
const hex = (value: ArrayBuffer) =>
  Array.from(
    new Uint8Array(value),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
async function fixture() {
  const prefix = new TextEncoder().encode(`blob ${CONTENT.length}\0`);
  const raw = new Uint8Array(prefix.length + CONTENT.length);
  raw.set(prefix);
  raw.set(CONTENT, prefix.length);
  const sha = hex(await crypto.subtle.digest("SHA-1", raw)) as GitSha;
  return {
    commit: { sha: SHA1, tree: { sha: BEFORE_TREE } },
    tree: treeWire(BEFORE_TREE, [blob(PATH, sha)]),
    body: {
      sha,
      encoding: "base64",
      size: CONTENT.length,
      content: btoa(String.fromCharCode(...CONTENT)) + "\n",
    },
    sha256: hex(await crypto.subtle.digest("SHA-256", CONTENT)),
  };
}
Deno.test("queue workflow digest binds exact commit, full tree path and complete native blob bytes", async () => {
  const f = await fixture();
  const { client, requests } = deliveryClient([
    response(f.commit),
    response(f.tree),
    response(f.body),
  ]);
  assert.deepEqual(await client.readQueueWorkflowDigest(SHA1, UNTIL), {
    status: "complete",
    value: { revision: SHA1, path: PATH, sha256: f.sha256 },
  });
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.headers.has("authorization")));
  assert.ok(requests[0].url.endsWith(`/git/commits/${SHA1}`));
  assert.ok(requests[1].url.endsWith(`/git/trees/${BEFORE_TREE}?recursive=1`));
  assert.ok(requests[2].url.endsWith(`/git/blobs/${f.body.sha}`));
});
Deno.test("queue workflow digest refuses incomplete, redirected or contradictory content", async (t) => {
  const f = await fixture();
  for (
    const [name, rows] of [
      ["wrong revision", [{ ...f.commit, sha: SHA2 }]],
      ["truncated tree", [f.commit, { ...f.tree, truncated: true }]],
      ["wrong path", [
        f.commit,
        treeWire(BEFORE_TREE, [blob("workflow.yml", f.body.sha)]),
      ]],
      ["symlink", [
        f.commit,
        treeWire(BEFORE_TREE, [blob(PATH, f.body.sha, "120000")]),
      ]],
      ["duplicate path", [
        f.commit,
        treeWire(BEFORE_TREE, [blob(PATH, f.body.sha), blob(PATH, f.body.sha)]),
      ]],
      ["wrong blob", [f.commit, f.tree, { ...f.body, sha: SHA2 }]],
      ["truncated bytes", [f.commit, f.tree, {
        ...f.body,
        content: btoa("name: CI\n"),
      }]],
      ["foreign bytes same size", [f.commit, f.tree, {
        ...f.body,
        content: btoa("x".repeat(CONTENT.length)),
      }]],
      ["oversize", [f.commit, f.tree, { ...f.body, size: 256 * 1024 + 1 }]],
      ["malformed base64", [f.commit, f.tree, { ...f.body, content: "YWJj$" }]],
      ["wrong encoding", [f.commit, f.tree, { ...f.body, encoding: "utf-8" }]],
    ] as const
  ) {
    await t.step(name, async () => {
      const { client } = deliveryClient(rows.map((row) => response(row)));
      assert.notEqual(
        (await client.readQueueWorkflowDigest(SHA1, UNTIL)).status,
        "complete",
      );
    });
  }
  const denied = deliveryClient([response({ message: "private detail" }, 403)]);
  assert.notEqual(
    (await denied.client.readQueueWorkflowDigest(SHA1, UNTIL)).status,
    "complete",
  );
  const expired = deliveryClient([]);
  assert.deepEqual(await expired.client.readQueueWorkflowDigest(SHA1, T0), {
    status: "unavailable",
    reason: "deadline",
  });
  assert.equal(expired.requests.length, 0);
});
