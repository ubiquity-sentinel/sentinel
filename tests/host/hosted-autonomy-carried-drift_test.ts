/**
 * The launcher's carried patch proof across base drift (sentinel PRs 304 and
 * 307): unequal change sets from GitHub's Git trees still prove when, over
 * the exact blobs (each checked against its id), every drifted text path's
 * refreshed content is the clean line merge of the reviewed change and the
 * base's change, exactly the runtime's own rule (`carried-drift.ts`). A
 * native queue target keeps the exact identity, a surface without a blob
 * reader carries no drift, and the merge evidence never claims equal sets.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import { gitBlobId } from "../../src/github/carried-drift.ts";
import {
  carriedMergeAction,
  carriedMergeEvidence,
  type CarriedMergeProofV1,
  carriedPatchRefusal,
} from "../../ops/hosted-autonomy-spent-delivery.ts";
import {
  type HostedTreeChangesV1,
  treeChangesDigest,
} from "../../ops/hosted-autonomy-github-trees.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyRecordV1,
} from "../../ops/hosted-autonomy-types.ts";
import { completedReceipt } from "../repair/loop-review-fixtures.ts";

const SELF: RepositoryIdentityV1 = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};
const GATEWAY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 7,
};
const B0 = "b0".repeat(20) as GitSha;
const H0 = "a0".repeat(20) as GitSha;
const TIP = "c0".repeat(20) as GitSha;
const H1 = "d0".repeat(20) as GitSha;

const encoder = new TextEncoder();
const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`);
const withLine = (lines: string[], at: number, line: string) =>
  encoder.encode([...lines.slice(0, at), line, ...lines.slice(at)].join(""));
const TIP_LINES = LINES.map((line, i) => i === 3 ? "line four (base)\n" : line);
/** Reviewed O -> A, the tip's T, the carried H and a relocated H. */
const FILES = {
  base: encoder.encode(LINES.join("")),
  reviewed: withLine(LINES, 6, "guard();\n"),
  tip: encoder.encode(TIP_LINES.join("")),
  carried: withLine(TIP_LINES, 6, "guard();\n"),
  moved: withLine(TIP_LINES, 9, "guard();\n"),
  added: encoder.encode("added\n"),
};
const IDS = Object.fromEntries(
  await Promise.all(
    Object.entries(FILES).map(async ([name, bytes]) =>
      [name, await gitBlobId(bytes)] as const
    ),
  ),
) as Record<keyof typeof FILES, string>;
const BLOBS = new Map(
  Object.entries(FILES).map(([name, bytes]) => [
    IDS[name as keyof typeof FILES],
    bytes,
  ]),
);

function changes(
  mergeBase: string,
  oldSha: string,
  newSha: string,
): HostedTreeChangesV1 {
  return {
    mergeBase,
    changes: [
      {
        path: "src/app.ts",
        oldMode: "100644",
        oldSha,
        newMode: "100644",
        newSha,
      },
      {
        path: "src/new.ts",
        oldMode: null,
        oldSha: null,
        newMode: "100644",
        newSha: IDS.added,
      },
    ],
  };
}

const REVIEWED = changes(B0, IDS.base, IDS.reviewed);

/** A launcher surface over two fixed change sets and an optional blob store. */
function surface(
  refreshed: HostedTreeChangesV1,
  readBlob?: (sha: string) => Promise<Uint8Array | null>,
) {
  const reads: string[] = [];
  const fake = {
    mergeBaseTreeChanges: (base: string, head: string) =>
      Promise.resolve(
        base === B0 && head === H0
          ? REVIEWED
          : base === TIP && head === H1
          ? refreshed
          : null,
      ),
    comparePatchDigest: () => Promise.resolve("e".repeat(64)),
    ...(readBlob === undefined ? {} : {
      readBlob: (sha: string) => {
        reads.push(sha);
        return readBlob(sha);
      },
    }),
  } as unknown as HostedAutonomyGitHubV1;
  return { fake, reads };
}

const fromStore = (sha: string) => Promise.resolve(BLOBS.get(sha) ?? null);

function receipt(repository: RepositoryIdentityV1) {
  return completedReceipt(1071, H0, B0, { repository });
}

Deno.test("launcher carried drift: a reviewed hunk carried across context-only base drift proves the carried merge (#304/#307)", async () => {
  const { fake, reads } = surface(
    changes(TIP, IDS.tip, IDS.carried),
    fromStore,
  );
  const proof = await carriedPatchRefusal(fake, receipt(SELF), H1, TIP);
  assert.deepEqual(proof, {
    refusal: null,
    reviewedMergeBase: B0,
    changes: await treeChangesDigest(REVIEWED.changes),
    paths: 2,
    drifted: 1,
    reviewedPatch: "e".repeat(64),
    refreshedPatch: "e".repeat(64),
  });
  // Only the drifted path's four blobs were read.
  assert.deepEqual(
    [...reads].sort(),
    [IDS.base, IDS.reviewed, IDS.tip, IDS.carried].sort(),
  );
});

Deno.test("launcher carried drift: anything but the carried hunks keeps refusing", async (t) => {
  await t.step("the same added line at another place", async () => {
    const { fake } = surface(changes(TIP, IDS.tip, IDS.moved), fromStore);
    assert.deepEqual(
      await carriedPatchRefusal(fake, receipt(SELF), H1, TIP),
      { refusal: "carried_patch_changed" },
    );
  });
  await t.step("a surface without a blob reader carries no drift", async () => {
    const { fake } = surface(changes(TIP, IDS.tip, IDS.carried));
    assert.deepEqual(
      await carriedPatchRefusal(fake, receipt(SELF), H1, TIP),
      { refusal: "carried_patch_changed" },
    );
  });
  await t.step("a native queue target keeps the exact identity", async () => {
    const { fake, reads } = surface(
      changes(TIP, IDS.tip, IDS.carried),
      fromStore,
    );
    assert.deepEqual(
      await carriedPatchRefusal(fake, receipt(GATEWAY), H1, TIP),
      { refusal: "carried_patch_changed" },
    );
    assert.deepEqual(reads, [], "no blob is read for an exact-only target");
  });
  await t.step("an unreadable blob is no proof yet", async () => {
    const { fake } = surface(
      changes(TIP, IDS.tip, IDS.carried),
      (sha) => sha === IDS.carried ? Promise.resolve(null) : fromStore(sha),
    );
    assert.deepEqual(
      await carriedPatchRefusal(fake, receipt(SELF), H1, TIP),
      { refusal: "carried_proof_unavailable" },
    );
  });
  await t.step("bytes that are not the named blob are no proof", async () => {
    const { fake } = surface(
      changes(TIP, IDS.tip, IDS.carried),
      (sha) => sha === IDS.carried ? fromStore(IDS.moved) : fromStore(sha),
    );
    assert.deepEqual(
      await carriedPatchRefusal(fake, receipt(SELF), H1, TIP),
      { refusal: "carried_proof_unavailable" },
    );
  });
});

Deno.test("launcher carried drift: the merge evidence names the drift and never claims equal change sets", () => {
  const proof: CarriedMergeProofV1 = {
    reviewedHead: H0,
    reviewedBase: B0,
    head: H1,
    base: TIP,
    receipt: "review-receipt:1071",
    reviewedMergeBase: B0,
    changes: "f".repeat(64),
    paths: 2,
    drifted: 1,
    reviewedPatch: null,
    refreshedPatch: "e".repeat(64),
    runs: [7001],
  };
  const record = {
    id: "issue-ubiquity-sentinel-sentinel-285",
    target: { pr: 1071 },
  } as unknown as HostedAutonomyRecordV1;
  assert.equal(
    carriedMergeAction(record, proof),
    `delivery:${record.id}:carried_merge:pr=1071:reviewed=${H0}@${B0}:receipt=review-receipt:1071:refreshed=${H1}@${TIP}:changes=${
      "f".repeat(64)
    }/2:drift=1:patch=unrendered/${"e".repeat(64)}:ci=7001`,
  );
  const evidence = carriedMergeEvidence(proof);
  assert.ok(
    evidence.includes(
      `change set sha256 ${
        "f".repeat(64)
      } (2 paths by path and mode; 1 text paths carried hunk for hunk across base drift, the rest by full blob id): ${B0}..${H0} carried to ${TIP}..${H1}`,
    ),
    evidence,
  );
  assert.ok(!evidence.includes("equals"), evidence);
  // An exact proof keeps its exact evidence and action line.
  const exact = { ...proof, drifted: 0 };
  assert.ok(
    carriedMergeEvidence(exact).includes(
      `exact change set sha256 ${
        "f".repeat(64)
      } (2 paths by path, mode and full blob id): ${B0}..${H0} equals ${TIP}..${H1}`,
    ),
  );
  assert.ok(!carriedMergeAction(record, exact).includes(":drift="));
});
