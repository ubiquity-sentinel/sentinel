/**
 * The merge port's carried path (owner decision 2026-10-16 (2), option (b)):
 * the request names the REVIEWED head H0 and base B0 its receipt binds; the
 * pull request is merged at the refreshed head H1 on the moved tip T only
 * after the review is re-observed as of H0, H1's own required checks are
 * green, T is an ancestor of H1 and git re-proves that H1 carries H0's exact
 * merge-base patch. The proof travels as merge commit evidence. Synthetic
 * fixtures only; no external service is contacted.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type CarriedPatchProofV1,
  type CarriedPatchRequestV1,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import {
  checkRunWire,
  checksPageWire,
  FakeGitExecutor,
  httpRespond,
  makePort,
  mergeResponseWire,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
  statusesPageWire,
} from "./helpers.ts";
import type { ScriptEntry } from "./helpers.ts";
import {
  blockedReason,
  CLEAN_COMPLETION,
  CLOCK,
  commentsRead,
  mergeRequest,
  pullEntry,
  putCount,
  reviewsRead,
  rulesRead,
  trustedService,
} from "./merge-helpers.ts";
import { reviewDecisionGraphqlWire } from "./helpers.ts";

/** H1 (refreshed head) on T (moved tip); the receipt binds SHA1 on SHA2. */
const H1 = SHA4;
const TIP = SHA3;
const EVIDENCE =
  "Sentinel carried review (owner decision 2026-10-16, option b)";

class ProvingGit extends FakeGitExecutor {
  readonly proofs: CarriedPatchRequestV1[] = [];
  refreshedPatch = "a".repeat(64);
  carriedPatchProof(
    request: CarriedPatchRequestV1,
  ): Promise<PortResultV1<CarriedPatchProofV1>> {
    this.proofs.push(request);
    return Promise.resolve(portOk({
      reviewedMergeBase: request.reviewedBase,
      reviewedPatch: "a".repeat(64),
      refreshedMergeBase: request.base,
      refreshedPatch: this.refreshedPatch,
    }));
  }
}

function h1Checks(): ScriptEntry[] {
  return [
    httpRespond(
      "GET",
      `/repos/ubiquity/sentinel/commits/${H1}/check-runs?per_page=100&page=1`,
      200,
      checksPageWire([checkRunWire({ head_sha: H1 })]),
    ),
    httpRespond(
      "GET",
      `/repos/ubiquity/sentinel/commits/${H1}/statuses?per_page=100&page=1`,
      200,
      statusesPageWire([]),
    ),
  ];
}

function carriedScript(extra: ScriptEntry[] = []): ScriptEntry[] {
  const refreshed = {
    head: { ref: "sentinel/fix-1", sha: H1 },
    base: { ref: "development", sha: TIP },
  };
  return [
    pullEntry(refreshed),
    pullEntry(refreshed),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    ...rulesRead(),
    ...h1Checks(),
    {
      ...httpRespond(
        "POST",
        "/graphql",
        200,
        reviewDecisionGraphqlWire("APPROVED"),
      ),
      repeat: true,
    },
    ...extra,
  ];
}

function carriedPort(git: FakeGitExecutor, script: ScriptEntry[]) {
  return makePort({ clock: CLOCK, script, review: trustedService(), git });
}

const CARRIED = { head: H1, base: TIP, evidence: EVIDENCE };

Deno.test("carried merge port: merges the refreshed head under the reviewed receipt, re-proven from git, with the proof as evidence", async () => {
  const git = new ProvingGit();
  const { port, transport } = carriedPort(
    git,
    carriedScript([
      httpRespond(
        "PUT",
        "/repos/ubiquity/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA2),
      ),
    ]),
  );
  const result = await port.mergePullRequest(
    mergeRequest(),
    undefined,
    CARRIED,
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value, {
    outcome: "merged",
    head: H1,
    mergeSha: SHA2,
  });
  assert.deepEqual(git.proofs, [{
    reviewedBase: SHA2,
    reviewedHead: SHA1,
    base: TIP,
    head: H1,
  }]);
  assert.deepEqual(git.ancestry.map((row) => [row.ancestor, row.descendant]), [
    [TIP, H1],
  ]);
  const put = transport.requests.find((request) => request.method === "PUT");
  assert.ok(put !== undefined);
  assert.deepEqual(JSON.parse(put.body ?? "{}"), {
    sha: H1,
    commit_message: EVIDENCE,
  });
});

Deno.test("carried merge port: a differing patch or no proof capability never merges", async () => {
  const differing = new ProvingGit();
  differing.refreshedPatch = "b".repeat(64);
  const changed = carriedPort(differing, carriedScript());
  const refused = await changed.port.mergePullRequest(
    mergeRequest(),
    undefined,
    CARRIED,
  );
  assert.equal(blockedReason(refused), "review_required");
  assert.equal(putCount(changed.transport), 0);

  const blind = carriedPort(new FakeGitExecutor(), carriedScript());
  const unproven = await blind.port.mergePullRequest(
    mergeRequest(),
    undefined,
    CARRIED,
  );
  assert.equal(blockedReason(unproven), "review_required");
  assert.equal(putCount(blind.transport), 0);
});

Deno.test("carried merge port: a carried head equal to the reviewed head, a malformed identity or a self merge is invalid", async () => {
  for (
    const carried of [
      { ...CARRIED, head: SHA1 },
      { ...CARRIED, head: "not-a-sha" as GitSha },
      { ...CARRIED, base: "not-a-sha" as GitSha },
    ]
  ) {
    const { port, transport } = carriedPort(new ProvingGit(), []);
    const result = await port.mergePullRequest(
      mergeRequest(),
      undefined,
      carried,
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.kind, "invalid");
    assert.equal(transport.requests.length, 0);
  }
});
